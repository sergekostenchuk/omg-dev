import { canonical } from "../canonical.js";
import type { DiscoveryDraft, Question } from "../discovery/discovery.js";
import { withInvocationAllowanceReport } from "../discovery/invocation-progress.js";
import { REQUIREMENTS, RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES, VERSION4_REQUIREMENTS, type UpstreamStage } from "../discovery/requirements.js";
import { EngineError } from "../errors.js";
import { isRef, predecessor, reference, STAGES, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import type { Revision } from "../storage/store.js";
import { continuePass, startPass, type PassOutcome } from "../om/run-driver.js";
import { readRun } from "../om/run.js";
import { acquireRunExecution, admitRunControl, releaseRunExecution, RunControlLost, type RunExecution } from "../om/run-control.js";
import type { Refusal } from "../om/refusal.js";
import type { StageContent, ProductEngine } from "./engine.js";
import type { StageResearchResult } from "./stage-research.js";

export type EarlyStageEnd = "stage_paused" | "needs_owner" | "conditional" | "no_go" | "insufficient_evidence"
  | "blocked" | "select_draft" | "stopped" | "busy" | "om_ready" | "om_complete" | "om_unable"
  | "om_waiting" | "om_stopped" | "om_busy" | "om_refused";

export interface EarlyStageReason { code: string; target: string; message: string; field?: string }
export interface EarlyStageBudget {
  maxTurns: number; turnsUsed: number; turnsRemaining: number;
  maxCalls: number; callsMade: number; callsRemaining: number;
}
export interface EarlyStageRequest {
  project: string; maxTurns: number; maxCalls: number; draftId?: string; outcomes?: string[];
}
export interface EarlyStageOutcome {
  end: EarlyStageEnd; project: string; stage: UpstreamStage | null; draft: Ref | null; candidates: Ref[];
  stageResult: StageResearchResult | null; reason: EarlyStageReason | null; budget: EarlyStageBudget;
  om: PassOutcome | null;
}

interface EarlyResult extends Omit<EarlyStageOutcome, "budget"> { turnsUsed: number; handoff: boolean }
type Selection = { draft: Revision<DiscoveryDraft> } | { outcome: EarlyResult };

const reason = (code: string, target: string, message: string, field?: string): EarlyStageReason =>
  ({ code, target, message, ...(field ? { field } : {}) });
const refusalReason = (value: Refusal): EarlyStageReason =>
  reason(value.code, value.at.target, value.message, value.at.field);

export class EarlyStageDriver {
  constructor(private readonly engine: ProductEngine) {}

  async run(request: EarlyStageRequest): Promise<EarlyStageOutcome> {
    const { project, maxTurns, maxCalls } = request;
    const execution = acquireRunExecution(this.engine.store, { project });
    if (!execution.ok) {
      if (execution.refusal.code === "run_stopped") return this.#restoreStopped(request, execution.refusal);
      return this.#result(project, execution.refusal.code === "run_busy" ? "busy" : "stopped", null, null,
        [], null, refusalReason(execution.refusal), 0, maxTurns, maxCalls, 0, null);
    }

    let early: EarlyResult;
    let callsMade = 0, callsRemaining = maxCalls;
    try {
      const measured = await withInvocationAllowanceReport(maxCalls,
        () => this.#driveEarly(request, execution.value as RunExecution));
      early = measured.value; callsMade = measured.used; callsRemaining = measured.remaining;
    } finally {
      releaseRunExecution(this.engine.store, execution.value as RunExecution);
    }

    const turnsRemaining = Math.max(0, maxTurns - early.turnsUsed);
    if (!early.handoff || turnsRemaining === 0 || callsRemaining === 0) {
      const end = early.handoff ? "om_ready" : early.end;
      return this.#result(project, end, early.stage, early.draft, early.candidates, early.stageResult,
        early.reason, early.turnsUsed, maxTurns, maxCalls, callsMade, early.om);
    }

    const saved = readRun(this.engine.store, { project });
    if (!saved.ok) return this.#result(project, "om_refused", null, early.draft, [], early.stageResult,
      refusalReason(saved.refusal), early.turnsUsed, maxTurns, maxCalls, callsMade, null);
    const driven = saved.value
      ? await continuePass(this.engine.store, { project })
      : await startPass(this.engine.store, { project, ...(request.outcomes ? { outcomes: request.outcomes } : {}) });
    if (!driven.ok) return this.#result(project, "om_refused", null, early.draft, [], early.stageResult,
      refusalReason(driven.refusal), early.turnsUsed, maxTurns, maxCalls, callsMade, null);
    return this.#result(project, `om_${driven.value.end}` as EarlyStageEnd, null, early.draft, [], early.stageResult,
      driven.value.refusal ? refusalReason(driven.value.refusal) : null, early.turnsUsed, maxTurns, maxCalls, callsMade,
      driven.value as PassOutcome);
  }

  async #restoreStopped(request: EarlyStageRequest, refusal: Refusal): Promise<EarlyStageOutcome> {
    const current = this.#currentStage(request.project), stopped = refusalReason(refusal);
    if (!current || current.blocked)
      return this.#result(request.project, "stopped", current?.stage ?? null, current?.draft ?? null, [], null,
        stopped, 0, request.maxTurns, request.maxCalls, 0, null);
    const selected = this.#savedDraft(request.project, current.stage, current.artifact, request.draftId);
    if (!selected.draft)
      return this.#result(request.project, "stopped", current.stage, null, selected.candidates, null,
        stopped, 0, request.maxTurns, request.maxCalls, 0, null);
    const restored = await this.engine.stageResearch.run(request.project, selected.draft.id,
      Math.max(1, request.maxTurns), { restoreOnly: true });
    return this.#result(request.project, "stopped", current.stage, reference(selected.draft), [], restored,
      stopped, 0, request.maxTurns, request.maxCalls, 0, null);
  }

  #savedDraft(project: string, stage: UpstreamStage, artifact: Revision<StageArtifact> | null,
    explicit: string | undefined): { draft: Revision<DiscoveryDraft> | null; candidates: Ref[] } {
    const bound = artifact?.value.content as unknown as Partial<StageContent> | undefined;
    const boundDraft = isRef(bound?.draft) ? bound.draft : null;
    if (explicit && boundDraft && explicit !== boundDraft.id) return { draft: null, candidates: [] };
    const named = explicit ?? boundDraft?.id;
    if (named) {
      const draft = this.engine.store.get<DiscoveryDraft>(named);
      return !this.#draftRefusal(project, stage, draft) ? { draft: draft!, candidates: [] }
        : { draft: null, candidates: [] };
    }
    const valid = this.engine.store.list<DiscoveryDraft>("discovery-draft")
      .filter(draft => draft.value.projectId === project && draft.value.stage === stage && draft.value.level === "R0"
        && !this.#draftRefusal(project, stage, draft));
    return valid.length === 1 ? { draft: valid[0]!, candidates: [] }
      : { draft: null, candidates: valid.map(reference) };
  }

  async #driveEarly(request: EarlyStageRequest, execution: RunExecution): Promise<EarlyResult> {
    let turnsUsed = 0, explicit = request.draftId;
    for (;;) {
      try { admitRunControl(this.engine.store, request.project, execution.hold); }
      catch (error) { return this.#controlOutcome(request.project, error, turnsUsed); }

      const current = this.#currentStage(request.project);
      if (!current) return { ...this.#base(request.project, "om_ready", null, null, [], null, null), turnsUsed, handoff: true };
      if (current.blocked) return { ...this.#base(request.project, "blocked", current.stage, current.draft, [], null,
        current.reason), turnsUsed, handoff: false };
      if (turnsUsed >= request.maxTurns) return { ...this.#base(request.project, "stage_paused", current.stage, current.draft,
        [], null, reason("research_turns_exhausted", current.stage, "The shared early research turn allowance is exhausted")),
        turnsUsed, handoff: false };

      const selected = this.#selectDraft(request.project, current.stage, current.artifact, explicit, execution);
      explicit = undefined;
      if ("outcome" in selected) return { ...selected.outcome, turnsUsed, handoff: false };
      const draft = selected.draft;
      let stageResult: StageResearchResult;
      try {
        stageResult = await this.engine.stageResearch.run(request.project, draft.id, request.maxTurns - turnsUsed);
      } catch (error) {
        if (error instanceof RunControlLost) return this.#controlOutcome(request.project, error, turnsUsed);
        if (error instanceof EngineError) return { ...this.#base(request.project, "blocked", current.stage, reference(draft), [], null,
          reason(error.code, current.stage, error.message)), turnsUsed, handoff: false };
        throw error;
      }
      turnsUsed += stageResult.turnsUsed ?? 0;
      if (stageResult.status === "accepted") continue;
      const outcome = this.#stageOutcome(request.project, current.stage, reference(draft), stageResult);
      if (turnsUsed >= request.maxTurns && outcome.end === "stage_paused" && stageResult.feedback)
        outcome.reason = reason("research_turns_exhausted", current.stage,
          "The shared early research turn allowance is exhausted; consumer feedback is preserved");
      return { ...outcome, turnsUsed, handoff: false };
    }
  }

  #currentStage(project: string): { stage: UpstreamStage; artifact: Revision<StageArtifact> | null; draft: Ref | null;
    blocked: boolean; reason: EarlyStageReason | null } | null {
    for (const stage of UPSTREAM_STAGES) {
      const projection = this.engine.pipeline.inspect(project, stage);
      if (projection.state === "accepted") continue;
      const content = projection.artifact?.value.content as unknown as Partial<StageContent> | undefined;
      const draft = isRef(content?.draft) ? content.draft : null;
      if (projection.state === "stale" || projection.artifact?.value.status === "accepted") {
        const finding = projection.findings[0];
        return { stage, artifact: projection.artifact, draft, blocked: true,
          reason: finding ? reason(finding.code, finding.target, finding.message, finding.field)
            : reason("early_stage_stale", projection.artifact?.id ?? stage, "The accepted stage basis changed and needs explicit revision") };
      }
      return { stage, artifact: projection.artifact, draft, blocked: false, reason: null };
    }
    return null;
  }

  #selectDraft(project: string, stage: UpstreamStage, artifact: Revision<StageArtifact> | null,
    explicit: string | undefined, execution: RunExecution): Selection {
    const bound = artifact?.value.content as unknown as Partial<StageContent> | undefined;
    const boundDraft = isRef(bound?.draft) ? bound.draft : null;
    const boundId = boundDraft?.id ?? null;
    if (explicit && boundId && explicit !== boundId)
      return { outcome: { ...this.#base(project, "blocked", stage, boundDraft, [], null,
        reason("early_draft_conflict", explicit, "The stage already names another saved draft", "draftId")), turnsUsed: 0, handoff: false } };
    const named = explicit ?? boundId;
    if (named) {
      const draft = this.engine.store.get<DiscoveryDraft>(named);
      const invalid = this.#draftRefusal(project, stage, draft);
      return invalid
        ? { outcome: { ...this.#base(project, "blocked", stage, draft ? reference(draft) : null, [], null, invalid), turnsUsed: 0, handoff: false } }
        : { draft: draft! };
    }

    const rows = this.engine.store.list<DiscoveryDraft>("discovery-draft")
      .filter(row => row.value.projectId === project && row.value.stage === stage && row.value.level === "R0");
    const valid: Revision<DiscoveryDraft>[] = [], invalid: EarlyStageReason[] = [];
    for (const draft of rows) {
      const refusal = this.#draftRefusal(project, stage, draft);
      if (refusal) invalid.push(refusal); else valid.push(draft);
    }
    if (valid.length > 1) return { outcome: { ...this.#base(project, "select_draft", stage, null, valid.map(reference), null,
      reason("early_draft_ambiguous", stage, "Several compatible drafts require an explicit draftId", "draftId")), turnsUsed: 0, handoff: false } };
    if (valid.length === 1) return { draft: valid[0]! };
    if (invalid.length) return { outcome: { ...this.#base(project, "blocked", stage, null, valid.map(reference), null, invalid[0]!), turnsUsed: 0, handoff: false } };
    try { return { draft: this.engine.prepareEarlyStage(project, stage, execution.hold) }; }
    catch (error) {
      if (error instanceof RunControlLost) return { outcome: this.#controlOutcome(project, error, 0) };
      if (error instanceof EngineError) return { outcome: { ...this.#base(project, "blocked", stage, null, [], null,
        reason(error.code, stage, error.message)), turnsUsed: 0, handoff: false } };
      throw error;
    }
  }

  #draftRefusal(project: string, stage: UpstreamStage, draft: Revision<DiscoveryDraft> | null): EarlyStageReason | null {
    if (!draft || draft.kind !== "discovery-draft" || draft.value.projectId !== project || draft.value.stage !== stage
      || draft.value.level !== "R0" || draft.value.consumer !== STAGES[STAGES.indexOf(stage) + 1])
      return reason("early_draft_foreign", draft?.id ?? stage, "The selected draft does not belong to this project stage", "draftId");
    const prior = predecessor(stage);
    const required = prior ? this.engine.pipeline.inspect(project, prior).guards : [];
    if (canonical(draft.value.inputs) !== canonical(required))
      return reason("early_draft_stale", draft.id, "The saved draft does not name the current prerequisite basis", "inputs");
    const specs = draft.value.contractVersion === 4 ? VERSION4_REQUIREMENTS[stage]
      : draft.value.contractVersion === RESEARCH_CONTRACT_VERSION ? REQUIREMENTS[stage] : null;
    if (!specs) return reason("research_contract_upgrade_required", draft.id, "This unfinished draft has no supported research contract", "contractVersion");
    if (!Array.isArray(draft.value.questions) || draft.value.questions.length !== specs.length)
      return reason("early_draft_invalid", draft.id, "The saved draft lost its complete question set", "questions");
    const questions = draft.value.questions.map(id => this.engine.store.get<Question>(id));
    if (!questions.every((question, index) => question?.kind === "question" && question.value.projectId === project
      && question.value.draftId === draft.id && question.value.stage === stage && question.value.level === "R0"
      && question.value.consumer === draft.value.consumer && canonical(question.value.spec) === canonical(specs[index])))
      return reason("early_draft_invalid", draft.id, "The saved draft questions do not match their stage contract", "questions");
    return null;
  }

  #stageOutcome(project: string, stage: UpstreamStage, draft: Ref, result: StageResearchResult): EarlyResult {
    const state = result.discovery?.state;
    const end: EarlyStageEnd = result.status === "stopped" ? "stopped"
      : state === "no_go" ? "no_go"
      : state === "insufficient_evidence" ? "insufficient_evidence"
      : state === "conditional" ? result.discovery!.ownerChoices.length ? "needs_owner" : "conditional"
      : result.status === "needs_owner" ? "needs_owner"
      : result.status === "blocked" ? "blocked" : "stage_paused";
    const finding = result.reason;
    return { ...this.#base(project, end, stage, draft, [], result, finding
      ? reason(finding.code, finding.target, finding.message, finding.field) : null), turnsUsed: result.turnsUsed ?? 0, handoff: false };
  }

  #controlOutcome(project: string, error: unknown, turnsUsed: number): EarlyResult {
    if (error instanceof RunControlLost) return { ...this.#base(project,
      error.refusal.code === "run_busy" ? "busy" : "stopped", null, null, [], null, refusalReason(error.refusal)), turnsUsed, handoff: false };
    if (error instanceof EngineError) return { ...this.#base(project, error.code === "run_busy" ? "busy" : "stopped",
      null, null, [], null, reason(error.code, project, error.message)), turnsUsed, handoff: false };
    throw error;
  }

  #base(project: string, end: EarlyStageEnd, stage: UpstreamStage | null, draft: Ref | null, candidates: Ref[],
    stageResult: StageResearchResult | null, why: EarlyStageReason | null): Omit<EarlyStageOutcome, "budget"> {
    return { end, project, stage, draft, candidates, stageResult, reason: why, om: null };
  }

  #result(project: string, end: EarlyStageEnd, stage: UpstreamStage | null, draft: Ref | null, candidates: Ref[],
    stageResult: StageResearchResult | null, why: EarlyStageReason | null, turnsUsed: number, maxTurns: number,
    maxCalls: number, callsMade: number, om: PassOutcome | null): EarlyStageOutcome {
    return { end, project, stage, draft, candidates, stageResult, reason: why, om,
      budget: { maxTurns, turnsUsed, turnsRemaining: Math.max(0, maxTurns - turnsUsed), maxCalls, callsMade,
        callsRemaining: Math.max(0, maxCalls - callsMade) } };
  }
}
