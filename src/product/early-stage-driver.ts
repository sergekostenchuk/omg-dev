import { hasDiscoveryHandoff, requireDiscoveryHandoff, prepareDiscoveryHandoff, withDiscoveryHandoffAt } from '../discovery/discovery-handoff.js';
import { readPartialDossier } from "../discovery/dossier-manifest.js";
import { readSelectedResearchPause, SELECTED_DOSSIER_PENDING, SELECTED_DOSSIER_PAUSE, type BudgetReentry } from "../discovery/research-runner.js";
import { readVariantHandoff, discoveryInspection } from '../discovery/discovery-outcome.js';
import { canonical, digest, type Json } from "../canonical.js";
import { Discovery } from "../discovery/discovery.js";
import {
  executionAdmission, isCurrentEra, listDrafts, orderedQuestions, readAnswer, readDraft,
  researchBeforeStageResult, snapshotExecutionPolicy, type DiscoveryExecutionPolicy,
  readQuestion, readStageArtifact, readResearchRun, type Decision, type DiscoveryDraft, type Fact, type ResearchRun,
  type UpstreamStage, UPSTREAM_STAGES,
} from "../discovery/projection-reader.js";
import { withInvocationAllowanceReport } from "../discovery/invocation-progress.js";
import { EngineError, requireCondition } from "../errors.js";
import type { Selector, Source } from "../evidence/evidence.js";
import { isRef, predecessor, reference, stageId, STAGES, uniqueRefs, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import type { Revision, TransactionGuard, Write } from "../storage/store.js";
import { storeView } from "../storage/store-view.js";
import { continuePass, startPass, type PassOutcome } from "../om/run-driver.js";
import { integrityGate } from "../om/integrity.js";
import { readRun, runId, type RunRecord } from "../om/run.js";
import { readOmInput, readAcceptedUpstreamStageAt, type OmInputRecord } from "../om/input.js";
import { acquireRunExecution, admitRunControl, releaseRunExecution, readRunControl, RunControlGate, RunControlLost, type RunExecution } from "../om/run-control.js";
import type { Refusal } from "../om/refusal.js";
import type { Project, StageContent, ProductEngine } from "./engine.js";
import type { StageResearchResult } from "./stage-research.js";
import type { AssessmentRefusalDoor } from "../discovery/assessment-session.js";

export type EarlyStageEnd = "stage_paused" | "needs_owner" | "conditional" | "no_go" | "insufficient_evidence"
  | "blocked" | "select_draft" | "stopped" | "busy" | "om_ready" | "om_complete" | "om_unable"
  | "om_waiting" | "om_stopped" | "om_busy" | "om_refused";

/** DRY6-01: a stage paused on a refused original assessment carries its exact machine door (reopen of the assessed question). */
export interface EarlyStageReason { code: string; target: string; message: string; field?: string; door?: AssessmentRefusalDoor; handoff?: Ref; selected?: Ref; dossier?: Ref; completeness?: 'partial' | 'complete'; next?: 'deep' | 'dossier' | 'dossier-assessment' }
export interface EarlyStageBudget {
  maxTurns: number; turnsUsed: number; turnsRemaining: number;
  maxCalls: number; callsMade: number; callsRemaining: number;
}
export interface EarlyStageRequest {
  project: string; maxTurns: number; maxCalls: number; draftId?: string; outcomes?: string[];
  instruction?: EarlyStageInstruction;
}
export interface EarlyStageInstruction {
  title: string; id: string; text: string; media: "text/plain" | "application/json";
  brief: Selector; objective?: Selector;
}
export interface EarlyStageOutcome {
  end: EarlyStageEnd; project: string; stage: UpstreamStage | null; draft: Ref | null; candidates: Ref[];
  stageResult: StageResearchResult | null; reason: EarlyStageReason | null; budget: EarlyStageBudget;
  om: PassOutcome | null;
}
export interface EarlyStageInputRevision { binding: Ref; discovery: Ref | null }

interface EarlyResult extends Omit<EarlyStageOutcome, "budget"> { turnsUsed: number; handoff: boolean }
type Selection = { draft: Revision<DiscoveryDraft> } | { outcome: EarlyResult };

const EARLY_INPUT_CONTRACT = "early-stage-input/v1" as const;
const EARLY_INPUT_KIND = "early-stage-input";
const DRIVER_ACTOR = "driver:verbatim" as const;
interface EarlyStageInput {
  contract: typeof EARLY_INPUT_CONTRACT; projectId: string; project: Ref; source: Ref; brief: Selector;
  objective: { kind: "brief" } | { kind: "source"; selector: Selector }; actor: typeof DRIVER_ACTOR;
}
interface ResolvedInput {
  binding: Revision<EarlyStageInput>; project: Revision<Project>; source: Revision<Source>;
  brief: string; objective: string; refs: Ref[];
}
interface PreparedInstruction { instruction: EarlyStageInstruction; brief: string; objective: string }

const inputId = (project: string): string => `early-stage-input:${project}`;

const reason = (code: string, target: string, message: string, field?: string): EarlyStageReason =>
  ({ code, target, message, ...(field ? { field } : {}) });
const refusalReason = (value: Refusal): EarlyStageReason =>
  reason(value.code, value.at.target, value.message, value.at.field);

export class EarlyStageDriver {
  readonly #producerPolicy: DiscoveryExecutionPolicy | undefined;
  constructor(private readonly engine: ProductEngine, private readonly budgetReentry?: BudgetReentry,
    producerPolicy?: DiscoveryExecutionPolicy) {
    this.#producerPolicy = snapshotExecutionPolicy(producerPolicy);
  }

  reviseInput(project: string, expected: number, instruction: EarlyStageInstruction): EarlyStageInputRevision {
    this.#prepareInstruction(project, instruction);
    const store = this.engine.store;
    const binding = this.#savedBinding(project);
    requireCondition(binding, "instruction_missing", "The project has no saved early-stage input to revise");
    const projectRecord = store.get<Project>(binding.value.project.id, binding.value.project.revision);
    const currentProject = store.get<Project>(binding.value.project.id);
    requireCondition(projectRecord?.kind === "project" && currentProject
      && canonical(reference(projectRecord)) === canonical(binding.value.project)
      && canonical(reference(currentProject)) === canonical(binding.value.project)
      && projectRecord.value.id === project && projectRecord.value.title === instruction.title,
    "instruction_stale", "The saved project identity changed and needs its own explicit review");
    const sourceValue: Source = { projectId: project,
      origin: { kind: "owner-document", location: instruction.id }, content: instruction.text,
      mediaType: instruction.media, sha256: digest(instruction.text) };
    const source = store.get<Source>(`source:${project}:${instruction.id}`);
    requireCondition(source?.kind === "source" && canonical(source.value) === canonical(sourceValue),
      "instruction_stale", "The revised input must name the exact current owner Source bytes");
    const objective = instruction.objective !== undefined
      ? { kind: "source" as const, selector: instruction.objective } : { kind: "brief" as const };
    const value: EarlyStageInput = { contract: EARLY_INPUT_CONTRACT, projectId: project,
      project: reference(currentProject), source: reference(source), brief: instruction.brief, objective, actor: DRIVER_ACTOR };
    const discoveryId = stageId(project, "discovery"), discovery = store.get<StageArtifact>(discoveryId);
    if (discovery) requireCondition(discovery.kind === "stage" && discovery.value.projectId === project
      && discovery.value.stage === "discovery", "artifact_invalid", "The saved Discovery stage is foreign or malformed");
    if (canonical(binding.value) === canonical(value))
      return { binding: reference(binding), discovery: discovery ? reference(discovery) : null };
    requireCondition(binding.revision === expected, "revision_conflict", "Reload the early-stage input before revising it");
    const writes: Write[] = [{ id: binding.id, kind: EARLY_INPUT_KIND, expected: binding.revision, value }];
    if (discovery?.value.status === "accepted") writes.push({ id: discovery.id, kind: "stage", expected: discovery.revision,
      value: { ...discovery.value, status: "draft", proofs: [] } });
    const guards: TransactionGuard[] = [reference(binding), reference(currentProject), reference(source),
      discovery ? reference(discovery) : { id: discoveryId, absent: true }];
    const saved = store.writeMany(writes, guards);
    const revised = saved.find(row => row.id === binding.id)!;
    const reopened = saved.find(row => row.id === discoveryId) ?? discovery;
    return { binding: reference(revised), discovery: reopened ? reference(reopened) : null };
  }

  async run(request: EarlyStageRequest): Promise<EarlyStageOutcome> {
    const { project, maxTurns, maxCalls } = request;
    // PROOF-SPEED (owner rule 08.10): every entry of a Discovery pass is its start or continue, so om-fsck runs here as at
    // om-start/om-continue; damage found stops the entry for the owner. Saved history is not proved again on the way.
    if (typeof project === "string" && project.length > 0) {
      const damaged = integrityGate(this.engine.store, project);
      if (damaged && !damaged.ok) return this.#result(project, "blocked", null, null, [], null,
        refusalReason(damaged.refusal), 0, maxTurns, maxCalls, 0, null);
    }
    let inspected: ResolvedInput | PreparedInstruction | null;
    try {
      inspected = this.#inspectInput(request);
      if (inspected && !("binding" in inspected)) this.#ensureProject(project, inspected);
      // An addressed dossier result is a read, not a new execution lease.
      // Prove its saved outputs before acquiring control so malformed addresses and
      // hot/cold fixed points leave even control history unchanged.
      // A consumer already pins its own accepted source; later Discovery heads do not select a replacement.
      const pinnedConcept = listDrafts(this.engine.store, project, 'concept').some(row => hasDiscoveryHandoff(this.engine.store, row.value));
      const current = !pinnedConcept && (!inspected || 'binding' in inspected) ? this.#currentStage(project) : null;
      const draft = current?.stage === 'discovery' && !current.blocked
        ? this.#savedDraft(project, current.stage, current.artifact, request.draftId,
          inspected && 'binding' in inspected ? inspected.refs : []).draft : null;
      const run = draft ? readResearchRun(this.engine.store, project, draft.id) : null;
      if (draft && run?.value.finalization && !run.value.researchReturn) {
        const { readRunnerFinalizationAt, nextRunnerFinalReturn } = await import('../discovery/discovery-finalization-runner.js');
        const { provenAcceptanceMode } = await import('../discovery/discovery-acceptance.js');
        const restored = await this.engine.researcher.run(project, draft.id, 1, undefined, { restoreOnly: true });
        const proof = await readRunnerFinalizationAt(this.engine.store, project, reference(restored));
        const returned = await nextRunnerFinalReturn(this.engine.store, project, proof);
        const newReturn = canonical(returned) !== canonical(proof.record.value.return)
          && maxTurns > 0 && maxCalls > 0
          && executionAdmission(this.engine.store, draft, 'new-research', this.#producerPolicy).admitted;
        if (!newReturn && !(proof.status === 'accepted' && proof.view.next === 'concept' && maxTurns > 0 && maxCalls > 0)
          && (['accepted','declined','returned'].includes(proof.status)
          || proof.status === 'needs_owner' && provenAcceptanceMode(this.engine.store, project).mode === 'questions')) {
          const reason = { code: `discovery_finalization_${proof.status}`, target: proof.view.record.id,
            message: proof.correction?.reason ?? `Discovery continuation: ${proof.view.next ?? proof.outcome}` };
          const early = await this.#stageOutcome(project, 'discovery', reference(draft), {
            status: proof.status === 'needs_owner' ? 'needs_owner' : 'paused', stage: current?.artifact ? reference(current.artifact) : null,
            research: reference(restored), feedback: null, findings: [reason], reason, turnsUsed: 0, finalization: proof.view });
          return this.#result(project, early.end, early.stage, early.draft, early.candidates, early.stageResult,
            early.reason, 0, maxTurns, maxCalls, 0, null);
        }
      }
      if (draft?.value.projectId === project && draft.value.stage === 'discovery' && isCurrentEra('discovery', draft.value.contractVersion, { discovery: 7 })
        && (run?.value.pauseCode === 'research_dossier_assessment_unavailable' || run?.value.pauseCode === 'research_partial_dossier_pending'
          || run?.value.pauseCode === SELECTED_DOSSIER_PAUSE || run?.value.pauseCode === SELECTED_DOSSIER_PENDING)) {
        const control = readRunControl(this.engine.store, { project });
        const artifact = current!.artifact;
        if (control.ok && !control.value.stopped && artifact?.value.status !== 'accepted') {
          const restored = run.value.pauseCode === 'research_partial_dossier_pending' || run.value.pauseCode === SELECTED_DOSSIER_PENDING
            ? await this.engine.researcher.run(project, draft.id, 1, undefined, { restoreOnly: true }) : run;
          const early = await this.#stageOutcome(project, 'discovery', reference(draft), {
            status: 'paused', stage: artifact ? reference(artifact) : null, research: reference(restored),
            feedback: null, findings: [], turnsUsed: 0 });
          // Prove the historical result above before considering new work. The
          // same read-only budget check is used by Researcher; only normal driver
          // control/admission and transport reservation may perform the re-entry.
          const reenter = restored.value.pauseCode === 'research_dossier_assessment_unavailable'
            && this.budgetReentry && maxTurns > 0 && maxCalls > 0
            && await this.budgetReentry.eligible(this.engine.store, project, draft, restored);
          const assess = maxTurns > 0 && maxCalls > 0
            && executionAdmission(this.engine.store, draft, 'new-research', this.#producerPolicy).admitted;
          if (!reenter && !assess) return this.#result(project, early.end, early.stage, early.draft, early.candidates, early.stageResult,
            early.reason, 0, maxTurns, maxCalls, 0, null);
        }
      }
    }
    catch (error) {
      const early = this.#entryFailure(project, error, 0);
      return this.#result(project, early.end, early.stage, early.draft, early.candidates, early.stageResult,
        early.reason, 0, maxTurns, maxCalls, 0, null);
    }
    const execution = acquireRunExecution(this.engine.store, { project });
    if (!execution.ok) {
      if (execution.refusal.code === "run_stopped") return this.#restoreStopped(request, execution.refusal);
      return this.#result(project, execution.refusal.code === "run_busy" ? "busy" : "stopped", null, null,
        [], null, refusalReason(execution.refusal), 0, maxTurns, maxCalls, 0, null);
    }

    let early: EarlyResult;
    let callsMade = 0, callsRemaining = maxCalls;
    try {
      const input = this.#initializeInput(request, execution.value as RunExecution, inspected);
      const measured = await withInvocationAllowanceReport(maxCalls,
        () => this.#driveEarly(request, execution.value as RunExecution, input));
      early = measured.value; callsMade = measured.used; callsRemaining = measured.remaining;
    } catch (error) {
      early = this.#entryFailure(project, error, 0);
    } finally {
      releaseRunExecution(this.engine.store, execution.value as RunExecution);
    }

    const turnsRemaining = Math.max(0, maxTurns - early.turnsUsed);
    if (!early.handoff || turnsRemaining === 0 || callsRemaining === 0) {
      const end = early.handoff ? "om_ready" : early.end;
      return this.#result(project, end, early.stage, early.draft, early.candidates, early.stageResult,
        early.reason, early.turnsUsed, maxTurns, maxCalls, callsMade, early.om);
    }

    try {
      return await this.#withOmHandoff(project, async () => {
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
      });
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return this.#result(project, "om_refused", null, early.draft, [], early.stageResult,
        reason(error.code, runId(project), error.message), early.turnsUsed, maxTurns, maxCalls, callsMade, null);
    }
  }

  /** Select only the address here; the shared OM readers still prove the input and run. */
  async #withOmHandoff<T>(project: string, work: () => Promise<T>): Promise<T> {
    const store = this.engine.store, saved = store.get<RunRecord>(runId(project));
    let features: Revision<StageArtifact> | null;
    let manifest: Ref | undefined;
    if (saved) {
      requireCondition(saved.value && isRef(saved.value.input), 'discovery_handoff_invalid',
        'The saved OM run lost its exact input address');
      const input = store.get<OmInputRecord>(saved.value.input.id, saved.value.input.revision);
      requireCondition(input && canonical(reference(input)) === canonical(saved.value.input)
        && input.value?.projectId === project && Array.isArray(input.value.input?.sources),
      'discovery_handoff_invalid', 'The saved OM input is missing or belongs to another project');
      const sources = input.value.input.sources.filter(row => row?.stage === 'features');
      requireCondition(sources.length === 1 && isRef(sources[0]), 'discovery_handoff_invalid',
        'The saved OM input must name its exact features artifact');
      const source = sources[0]!;
      features = store.get<StageArtifact>(source.id, source.revision);
      requireCondition(features && features.hash === source.hash, 'discovery_handoff_invalid',
        'The saved features artifact is missing or substituted');
      manifest = input.value.input.discovery?.manifest;
    } else features = readStageArtifact<StageArtifact>(store, stageId(project, 'features'));
    const content = features?.value?.content as unknown as Partial<StageContent> | undefined;
    const draft = isRef(content?.draft) ? store.get<DiscoveryDraft>(content.draft.id, content.draft.revision) : null;
    requireCondition(!draft || (draft.value !== null && typeof draft.value === 'object' && !Array.isArray(draft.value)),
      'discovery_handoff_invalid', 'The OM features draft lost its record value');
    const bound = draft && hasDiscoveryHandoff(store, draft.value);
    if (!bound) {
      requireCondition(!manifest && !content?.discoveryHandoff, 'discovery_handoff_invalid',
        'The OM features source lost its Discovery handoff');
      return work();
    }
    requireCondition(features?.value?.projectId === project && features.value.stage === 'features'
      && canonical(reference(draft)) === canonical(content!.draft), 'discovery_handoff_invalid',
    'The OM features draft is foreign or substituted');
    return withDiscoveryHandoffAt(store, project, reference(draft), () => {
      const handoff = requireDiscoveryHandoff(store, draft.value);
      requireCondition(handoff.binding.stage === 'features'
        && (!saved || (isRef(manifest) && canonical(manifest) === canonical(handoff.source.manifest))),
      'discovery_handoff_invalid', 'The saved OM input and features name different Discovery roots');
      if (saved) {
        const input = readOmInput(store, project, saved.value.input);
        if (!input.ok) throw new EngineError(input.refusal.code, input.refusal.message, input.refusal.at);
        readAcceptedUpstreamStageAt(store, project, 'features', reference(features!));
      }
      return work();
    });
  }

  async #restoreStopped(request: EarlyStageRequest, refusal: Refusal): Promise<EarlyStageOutcome> {
    const stopped = refusalReason(refusal);
    const restore = async (manifest?: Ref) => {
      const current = this.#currentStage(request.project, manifest);
      if (!current || current.blocked)
        return this.#result(request.project, "stopped", current?.stage ?? null, current?.draft ?? null, [], null,
          stopped, 0, request.maxTurns, request.maxCalls, 0, null);
      const explicit = request.draftId ? readDraft(this.engine.store, request.draftId) : null;
      const selected = this.#savedDraft(request.project, current.stage, current.artifact,
        manifest && explicit?.value.stage === 'discovery' ? undefined : request.draftId, this.#inputRefs(request.project));
      if (!selected.draft)
        return this.#result(request.project, "stopped", current.stage, null, selected.candidates, null,
          stopped, 0, request.maxTurns, request.maxCalls, 0, null);
      const restored = await this.engine.stageResearch.run(request.project, selected.draft.id,
        Math.max(1, request.maxTurns), { restoreOnly: true });
      return this.#result(request.project, "stopped", current.stage, reference(selected.draft), [], restored,
        stopped, 0, request.maxTurns, request.maxCalls, 0, null);
    };
    try {
      const selected = this.#conceptRoot(request);
      if (selected.candidates.length) return this.#result(request.project, 'stopped', 'concept', null,
        selected.candidates, null, stopped, 0, request.maxTurns, request.maxCalls, 0, null);
      if (!selected.draft) return await restore();
      return await withDiscoveryHandoffAt(this.engine.store, request.project, reference(selected.draft), () =>
        restore(requireDiscoveryHandoff(this.engine.store, selected.draft!.value).source.manifest));
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return this.#result(request.project, 'stopped', 'concept', null, [], null,
        reason(error.code, request.draftId ?? 'concept', error.message), 0, request.maxTurns, request.maxCalls, 0, null);
    }
  }

  #selection(text: string, media: Source["mediaType"], selector: unknown): Json {
    requireCondition(selector !== null && typeof selector === "object" && !Array.isArray(selector),
      "selector_invalid", "The instruction needs an exact brief or objective selector");
    const shape = selector as Record<string, unknown>;
    if (shape['kind'] === "text-range") {
      const start = shape['start'], end = shape['end'];
      requireCondition(media === "text/plain" && Number.isSafeInteger(start) && Number.isSafeInteger(end)
        && (start as number) >= 0 && (end as number) > (start as number) && (end as number) <= text.length,
      "selector_invalid", "The instruction selector must name a nonempty exact text range");
      return text.slice(start as number, end as number);
    }
    requireCondition(shape['kind'] === "json-pointer" && media === "application/json" && typeof shape['pointer'] === "string"
      && (shape['pointer'] === "" || shape['pointer'].startsWith("/")),
    "selector_invalid", "The instruction selector must be a valid JSON pointer for a JSON source");
    const pointer = shape['pointer'] as string;
    let value: unknown;
    try { value = JSON.parse(text); canonical(value); }
    catch { throw new EngineError("source_invalid", "The instruction JSON source is invalid", { target: "instruction", field: "text" }); }
    if (pointer) for (const encoded of pointer.slice(1).split("/")) {
      requireCondition(!/~(?![01])/.test(encoded), "selector_invalid", "The instruction JSON pointer has an invalid escape");
      const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      requireCondition(value !== null && typeof value === "object" && Object.hasOwn(value, key),
        "selector_invalid", "The instruction selector does not identify a source value");
      value = (value as Record<string, unknown>)[key];
    }
    return JSON.parse(canonical(value)) as Json;
  }

  #prepareInstruction(project: string, instruction: EarlyStageInstruction): PreparedInstruction {
    requireCondition(instruction && typeof instruction === "object" && typeof instruction.title === "string"
      && instruction.title.trim().length > 0 && typeof instruction.id === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(instruction.id) && typeof instruction.text === "string"
      && instruction.text.trim().length > 0 && Buffer.byteLength(instruction.text) <= 5_000_000
      && ["text/plain", "application/json"].includes(instruction.media),
    "instruction_missing", "The early-stage driver needs a verbatim bounded instruction and its source identity");
    if (instruction.media === "application/json") {
      try { canonical(JSON.parse(instruction.text)); }
      catch { throw new EngineError("source_invalid", "The instruction JSON source is invalid", { target: project, field: "instruction.text" }); }
    }
    const brief = this.#selection(instruction.text, instruction.media, instruction.brief);
    const objective = instruction.objective !== undefined
      ? this.#selection(instruction.text, instruction.media, instruction.objective) : brief;
    requireCondition(typeof brief === "string" && brief.length > 0 && typeof objective === "string" && objective.length > 0,
      "selector_invalid", "The brief and objective selectors must each identify verbatim nonempty text");
    return { instruction, brief, objective };
  }

  #legacyDiscovery(project: string): boolean {
    return readStageArtifact(this.engine.store, `stage:${project}:discovery`) !== null
      || listDrafts(this.engine.store, project, "discovery").length > 0;
  }

  #inputRefs(project: string): Ref[] {
    const binding = this.engine.store.get<EarlyStageInput>(inputId(project));
    if (binding?.kind !== EARLY_INPUT_KIND || binding.value?.contract !== EARLY_INPUT_CONTRACT
      || binding.value.projectId !== project || !isRef(binding.value.project) || !isRef(binding.value.source)) return [];
    return uniqueRefs([binding.value.project, binding.value.source, reference(binding)]);
  }

  #savedBinding(project: string): Revision<EarlyStageInput> | null {
    const binding = this.engine.store.get<EarlyStageInput>(inputId(project));
    if (!binding) return null;
    requireCondition(binding.kind === EARLY_INPUT_KIND && binding.value?.contract === EARLY_INPUT_CONTRACT
      && binding.value.projectId === project && binding.value.actor === DRIVER_ACTOR
      && isRef(binding.value.project) && isRef(binding.value.source)
      && binding.value.objective && ["brief", "source"].includes(binding.value.objective.kind),
    "instruction_binding_invalid", "The saved early-stage input binding is incomplete or foreign");
    return binding;
  }

  #readInput(project: string): ResolvedInput | null {
    const store = this.engine.store, binding = this.#savedBinding(project);
    if (!binding) return null;
    const projectRecord = store.get<Project>(binding.value.project.id, binding.value.project.revision);
    const currentProject = store.get<Project>(binding.value.project.id);
    requireCondition(projectRecord?.kind === "project" && canonical(reference(projectRecord)) === canonical(binding.value.project)
      && currentProject && canonical(reference(currentProject)) === canonical(binding.value.project)
      && projectRecord.value.id === project,
    "instruction_stale", "The project named by the saved instruction changed and needs explicit review");
    const source = store.get<Source>(binding.value.source.id, binding.value.source.revision);
    const currentSource = store.get<Source>(binding.value.source.id);
    requireCondition(source?.kind === "source" && canonical(reference(source)) === canonical(binding.value.source)
      && currentSource && canonical(reference(currentSource)) === canonical(binding.value.source)
      && source.value.projectId === project && source.value.origin.kind === "owner-document",
    "instruction_stale", "The instruction Source changed and needs explicit review before research continues");
    let brief: Json, objective: Json;
    try {
      const evidence = new Discovery(store).evidence;
      brief = evidence.observe(project, binding.value.source, binding.value.brief).value;
      objective = binding.value.objective.kind === "brief" ? brief
        : evidence.observe(project, binding.value.source, binding.value.objective.selector).value;
    } catch (error) {
      if (error instanceof EngineError && ["source_missing", "source_stale"].includes(error.code))
        throw new EngineError("instruction_stale", "The saved instruction basis changed and needs explicit review",
          { target: binding.value.source.id, field: "source" });
      throw new EngineError("instruction_binding_invalid", "The saved instruction selectors cannot be reproduced",
        { target: binding.id, field: "selector" });
    }
    requireCondition(typeof brief === "string" && brief.length > 0 && typeof objective === "string" && objective.length > 0,
      "instruction_binding_invalid", "The saved instruction no longer derives textual brief and objective values");
    return { binding, project: projectRecord, source, brief, objective,
      refs: uniqueRefs([binding.value.project, binding.value.source, reference(binding)]) };
  }

  #sameInstruction(project: string, prepared: PreparedInstruction, saved: ResolvedInput): void {
    const source: Source = { projectId: project,
      origin: { kind: "owner-document", location: prepared.instruction.id }, content: prepared.instruction.text,
      mediaType: prepared.instruction.media, sha256: digest(prepared.instruction.text) };
    const objective = prepared.instruction.objective !== undefined
      ? { kind: "source" as const, selector: prepared.instruction.objective } : { kind: "brief" as const };
    requireCondition(saved.project.value.title === prepared.instruction.title
      && canonical(saved.source.value) === canonical(source)
      && canonical(saved.binding.value.brief) === canonical(prepared.instruction.brief)
      && canonical(saved.binding.value.objective) === canonical(objective),
    "instruction_stale", "This run names another instruction; revise the saved input and dependent research explicitly");
  }

  #inspectInput(request: EarlyStageRequest): ResolvedInput | PreparedInstruction | null {
    const saved = this.#readInput(request.project);
    if (saved) {
      if (request.instruction) this.#sameInstruction(request.project,
        this.#prepareInstruction(request.project, request.instruction), saved);
      return saved;
    }
    const project = this.engine.store.get<Project>(`project:${request.project}`);
    // Previous-era drafts and accepted stages keep their producer's rules. IN1
    // never attaches present-day authorship to an already started history.
    if (project && this.#legacyDiscovery(request.project)) return null;
    requireCondition(request.instruction, "instruction_missing",
      "A verbatim instruction is required before the driver creates its first Discovery draft");
    const prepared = this.#prepareInstruction(request.project, request.instruction);
    if (project) requireCondition(project.kind === "project" && project.value.id === request.project
      && project.value.title === prepared.instruction.title,
    "instruction_stale", "The existing project title differs from this instruction and needs explicit review");
    return prepared;
  }

  #ensureProject(projectId: string, prepared: PreparedInstruction): Revision<Project> {
    let project = this.engine.store.get<Project>(`project:${projectId}`);
    if (!project) {
      try { project = this.engine.store.write<Project>({ id: `project:${projectId}`, kind: "project", expected: 0,
        value: { id: projectId, title: prepared.instruction.title } }); }
      catch (error) {
        if (!(error instanceof EngineError && error.code === "revision_conflict")) throw error;
        project = this.engine.store.get<Project>(`project:${projectId}`);
      }
    }
    requireCondition(project?.kind === "project" && project.value.id === projectId
      && project.value.title === prepared.instruction.title,
    "instruction_stale", "The project address already names another assignment title");
    return project;
  }

  #initializeInput(request: EarlyStageRequest, execution: RunExecution,
    inspected: ResolvedInput | PreparedInstruction | null): ResolvedInput | null {
    if (!inspected) return null;
    if ("binding" in inspected) {
      const refreshed = this.#inspectInput(request);
      requireCondition(refreshed && "binding" in refreshed, "instruction_stale",
        "The saved instruction changed before the driver acquired execution");
      return refreshed;
    }
    const { instruction } = inspected, gate = new RunControlGate(this.engine.store, request.project, execution.hold);
    const controlled = gate.view();
    let project = this.engine.store.get<Project>(`project:${request.project}`);
    requireCondition(project?.kind === "project" && project.value.id === request.project
      && project.value.title === instruction.title,
    "instruction_stale", "The project changed before its instruction could be saved");
    const sourceValue: Source = { projectId: request.project,
      origin: { kind: "owner-document", location: instruction.id }, content: instruction.text,
      mediaType: instruction.media, sha256: digest(instruction.text) };
    const sourceId = `source:${request.project}:${instruction.id}`;
    let source = this.engine.store.get<Source>(sourceId);
    if (!source) {
      const sourceStore = storeView(controlled, { write: (writes, guards) =>
        controlled.writeMany(writes, [...guards, reference(project!)]) });
      try { source = new Discovery(sourceStore).evidence.document(request.project, instruction.id,
        instruction.text, instruction.media, 0); }
      catch (error) {
        if (!(error instanceof EngineError && error.code === "revision_conflict")) throw error;
        source = this.engine.store.get<Source>(sourceId);
      }
    }
    requireCondition(source?.kind === "source" && canonical(source.value) === canonical(sourceValue),
      "instruction_stale", "The instruction Source address already names different bytes");
    const objective = instruction.objective !== undefined
      ? { kind: "source" as const, selector: instruction.objective } : { kind: "brief" as const };
    const value: EarlyStageInput = { contract: EARLY_INPUT_CONTRACT, projectId: request.project,
      project: reference(project), source: reference(source), brief: instruction.brief, objective, actor: DRIVER_ACTOR };
    let binding = this.engine.store.get<EarlyStageInput>(inputId(request.project));
    if (!binding) {
      try { binding = controlled.writeMany<EarlyStageInput>([{ id: inputId(request.project), kind: EARLY_INPUT_KIND,
        expected: 0, value }], [reference(project), reference(source)])[0]!; }
      catch (error) {
        if (!(error instanceof EngineError && error.code === "revision_conflict")) throw error;
        binding = this.engine.store.get<EarlyStageInput>(inputId(request.project));
      }
    }
    requireCondition(binding?.kind === EARLY_INPUT_KIND && canonical(binding.value) === canonical(value),
      "instruction_stale", "Another instruction won before this input could be saved");
    const resolved = this.#readInput(request.project);
    requireCondition(resolved, "instruction_binding_invalid", "The saved instruction cannot be read back");
    this.#sameInstruction(request.project, inspected, resolved);
    return resolved;
  }

  #savedDraft(project: string, stage: UpstreamStage, artifact: Revision<StageArtifact> | null,
    explicit: string | undefined, entryRefs: Ref[]): { draft: Revision<DiscoveryDraft> | null; candidates: Ref[] } {
    const boundDraft = this.#activeStageDraft(project, stage, artifact, entryRefs);
    if (explicit && boundDraft && explicit !== boundDraft.id) return { draft: null, candidates: [] };
    const named = explicit ?? boundDraft?.id;
    if (named) {
      const draft = readDraft(this.engine.store, named);
      return !this.#draftRefusal(project, stage, draft, entryRefs) ? { draft: draft!, candidates: [] }
        : { draft: null, candidates: [] };
    }
    const valid = listDrafts(this.engine.store, project, stage)
      .filter(draft => draft.value.level === "R0"
        && !this.#draftRefusal(project, stage, draft, entryRefs));
    return valid.length === 1 ? { draft: valid[0]!, candidates: [] }
      : { draft: null, candidates: valid.map(reference) };
  }

  async #driveEarly(request: EarlyStageRequest, execution: RunExecution, input: ResolvedInput | null,
    turnsUsed = 0, root?: Ref): Promise<EarlyResult> {
    if (!root) {
      const continued = await this.#continueConcept(request, execution, input, turnsUsed);
      if (continued) return continued;
    }
    let explicit = request.draftId;
    for (;;) {
      try { admitRunControl(this.engine.store, request.project, execution.hold); }
      catch (error) { return this.#controlOutcome(request.project, error, turnsUsed); }

      const current = this.#currentStage(request.project, root);
      if (!current) return { ...this.#base(request.project, "om_ready", null, null, [], null, null), turnsUsed, handoff: true };
      if (current.blocked) return { ...this.#base(request.project, "blocked", current.stage, current.draft, [], null,
        current.reason), turnsUsed, handoff: false };
      if (turnsUsed >= request.maxTurns) return { ...this.#base(request.project, "stage_paused", current.stage, current.draft,
        [], null, reason("research_turns_exhausted", current.stage, "The shared early research turn allowance is exhausted")),
        turnsUsed, handoff: false };

      const selected = this.#selectDraft(request.project, current.stage, current.artifact, explicit, execution, input);
      explicit = undefined;
      if ("outcome" in selected) return { ...selected.outcome, turnsUsed, handoff: false };
      let draft = selected.draft;
      if (current.stage === "discovery" && input) {
        try { draft = this.#ensureInputAnswers(draft, input, execution); }
        catch (error) { return this.#entryFailure(request.project, error, turnsUsed); }
      }
      let stageResult: StageResearchResult;
      try {
        // Discovery owns the optional configuration and proves the stopped
        // route again under this execution's original hold.
        const prior = readResearchRun(this.engine.store, request.project, draft.id);
        if (this.budgetReentry && request.maxCalls > 0 && current.stage === 'discovery' && prior) {
          let restored: Revision<ResearchRun> | null = null;
          let unpaidPause: { code: string; target: string; message: string } | null = null;
          try {
            restored = await this.budgetReentry.resume(this.engine.researcher, request.project, draft.id,
              request.maxTurns - turnsUsed, execution.hold);
          } catch (error) {
            // The transport reports a typed refusal if control moved at its
            // reservation. Preserve the driver's original control outcome.
            admitRunControl(this.engine.store, request.project, execution.hold);
            if (!(error instanceof EngineError) || !['budget_estimate_missing', 'discovery_budget_reserve',
              'discovery_budget_overrun', 'research_call_allowance'].includes(error.code)) throw error;
            const paused = readResearchRun(this.engine.store, request.project, draft.id);
            requireCondition(paused?.value.status === 'paused', 'research_consumer_intent_invalid',
              'An unpaid budget or allowance refusal must preserve its research pause');
            restored = paused;
            unpaidPause = { code: error.code, target: draft.id, message: error.message };
          } finally {
            const latest = readResearchRun(this.engine.store, request.project, draft.id);
            turnsUsed += Math.max(0, (latest?.value.turns ?? prior.value.turns) - prior.value.turns);
          }
          admitRunControl(this.engine.store, request.project, execution.hold);
          if (restored) {
            const pause = unpaidPause ?? (restored.value.pauseCode ? { code: restored.value.pauseCode, target: draft.id,
              message: restored.value.error ?? 'Research is paused' } : null);
            const outcome = await this.#stageOutcome(request.project, 'discovery', reference(draft), {
              status: restored.value.status === 'needs_owner' ? 'needs_owner' : 'paused',
              stage: current.artifact ? reference(current.artifact) : null, research: reference(restored),
              feedback: null, findings: pause ? [pause] : [], reason: pause, turnsUsed });
            admitRunControl(this.engine.store, request.project, execution.hold);
            return { ...outcome, turnsUsed, handoff: false };
          }
        }
        const restoreOnly = researchBeforeStageResult(draft.value)
          && !executionAdmission(this.engine.store, draft, 'new-research', this.#producerPolicy).admitted;
        stageResult = await this.engine.stageResearch.run(request.project, draft.id, request.maxTurns - turnsUsed,
          { ...(restoreOnly ? { restoreOnly: true } : {}),
            ...(this.#producerPolicy ? { producerPolicy: this.#producerPolicy } : {}) });
        if (restoreOnly) {
          admitRunControl(this.engine.store, request.project, execution.hold);
          const restored = readResearchRun(this.engine.store, request.project, draft.id);
          const pause = restored?.value.pauseCode
            ? { code: restored.value.pauseCode, target: draft.id, message: restored.value.error ?? 'Saved v7 research is paused' }
            : { code: 'research_contract_upgrade_required', target: draft.id, message: 'New v7 work requires its explicit producer policy' };
          stageResult = { ...stageResult, status: 'paused', findings: [pause], reason: pause };
        }
      } catch (error) {
        if (error instanceof RunControlLost) return this.#controlOutcome(request.project, error, turnsUsed);
        if (error instanceof EngineError) return { ...this.#base(request.project, "blocked", current.stage, reference(draft), [], null,
          reason(error.code, current.stage, error.message)), turnsUsed, handoff: false };
        throw error;
      }
      turnsUsed += stageResult.turnsUsed ?? 0;
      if (current.stage === 'discovery' && stageResult.finalization?.next === 'concept') {
        const continued = await this.#continueConcept(request, execution, input, turnsUsed);
        if (continued) return continued;
      }
      if (stageResult.status === "accepted") continue;
      const outcome = await this.#stageOutcome(request.project, current.stage, reference(draft), stageResult);
      if (turnsUsed >= request.maxTurns && outcome.end === "stage_paused" && stageResult.feedback && !outcome.reason?.handoff)
        outcome.reason = reason("research_turns_exhausted", current.stage,
          "The shared early research turn allowance is exhausted; consumer feedback is preserved");
      return { ...outcome, turnsUsed, handoff: false };
    }
  }

  #ensureInputAnswers(selected: Revision<DiscoveryDraft>, input: ResolvedInput, execution: RunExecution): Revision<DiscoveryDraft> {
    const store = this.engine.store, gate = new RunControlGate(store, selected.value.projectId, execution.hold);
    const discovery = new Discovery(gate.view());
    const answer = (field: "brief" | "objective"): Revision<DiscoveryDraft> => {
      const draft = readDraft(store, selected.id);
      requireCondition(draft?.kind === "discovery-draft" && draft.value.projectId === input.binding.value.projectId
        && canonical(draft.value.inputs) === canonical(input.refs),
      "instruction_stale", "The Discovery draft moved away from its exact instruction basis");
      const matches = orderedQuestions(store, draft.value)
        .filter(question => question?.kind === "question" && question.value.spec.field === field);
      requireCondition(matches.length === 1, "instruction_binding_invalid",
        `The Discovery input needs exactly one ${field} question`);
      const question = matches[0]!;
      if (question.value.status === "open") {
        if (field === "brief") discovery.fact(question.id, question.revision, reference(input.source), input.binding.value.brief);
        else discovery.decision(question.id, question.revision, DRIVER_ACTOR, input.objective);
      } else requireCondition(question.value.status === "answered", "instruction_answer_stale",
        `The ${field} question is not open or answered`);
      const currentDraft = readDraft(store, draft.id)!, currentQuestion = readQuestion(store, question.id)!;
      requireCondition(currentQuestion.value.status === "answered" && isRef(currentQuestion.value.answer),
        "instruction_answer_stale", `The ${field} answer was not saved`);
      const saved = readAnswer<Decision | Fact>(store, currentQuestion.value.answer);
      requireCondition(saved && canonical(reference(saved)) === canonical(currentQuestion.value.answer)
        && saved.value.projectId === input.binding.value.projectId && saved.value.question === currentQuestion.id,
      "instruction_answer_stale", `The ${field} answer belongs to another input`);
      if (field === "brief") {
        const expected = new Discovery(store).evidence.observe(input.binding.value.projectId,
          reference(input.source), input.binding.value.brief);
        requireCondition(saved.kind === "fact" && canonical((saved.value as Fact).observation) === canonical(expected),
          "instruction_answer_stale", "The brief is not the exact selected instruction text");
      } else requireCondition(saved.kind === "decision" && (saved.value as Decision).actor === DRIVER_ACTOR
        && canonical((saved.value as Decision).value) === canonical(input.objective),
      "instruction_answer_stale", "The objective was not copied verbatim by the driver");
      requireCondition(canonical(currentDraft.value.fields[field]) === canonical(field === "brief" ? input.brief : input.objective),
        "instruction_answer_stale", `The ${field} answer differs from its draft field`);
      return currentDraft;
    };
    answer("brief");
    return answer("objective");
  }

  #entryFailure(project: string, error: unknown, turnsUsed: number): EarlyResult {
    if (error instanceof RunControlLost || error instanceof EngineError
      && ["run_stopped", "run_control_changed", "run_busy"].includes(error.code))
      return this.#controlOutcome(project, error, turnsUsed);
    if (error instanceof EngineError) {
      const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : null;
      const target = typeof details?.['target'] === "string" ? details['target'] : project;
      const field = typeof details?.['field'] === "string" ? details['field'] : undefined;
      return { ...this.#base(project, "blocked", null, null, [], null,
        reason(error.code, target, error.message, field)), turnsUsed, handoff: false };
    }
    throw error;
  }

  #conceptRoot(request: EarlyStageRequest): { draft: Revision<DiscoveryDraft> | null; candidates: Ref[] } {
    const store = this.engine.store, project = request.project;
    const artifact = readStageArtifact<StageArtifact>(store, stageId(project, 'concept'));
    const content = artifact?.value.content as unknown as Partial<StageContent> | undefined;
    const candidates = listDrafts(store, project, 'concept').filter(row => hasDiscoveryHandoff(store, row.value));
    const explicit = request.draftId ? readDraft(store, request.draftId) : null;
    const named = explicit?.value.stage === 'concept' ? explicit.id
      : isRef(content?.draft) ? content.draft.id : undefined;
    if (named && isRef(content?.draft)) requireCondition(named === content.draft.id, 'early_draft_conflict',
      'The concept artifact already pins another draft');
    if (!named && candidates.length > 1) return { draft: null, candidates: candidates.map(reference) };
    const draft = named ? readDraft(store, named) : candidates[0] ?? null;
    if (draft && hasDiscoveryHandoff(store, draft.value)) return { draft, candidates: [] };
    requireCondition(!content?.discoveryHandoff, 'discovery_handoff_invalid', 'The concept lost its pinned draft');
    return { draft: null, candidates: [] };
  }

  /** The pinned consumer draft, not a later Discovery head, selects a resumed root. */
  async #continueConcept(request: EarlyStageRequest, execution: RunExecution, input: ResolvedInput | null,
    turnsUsed: number): Promise<EarlyResult | null> {
    const store = this.engine.store, project = request.project;
    const selected = this.#conceptRoot(request);
    if (selected.candidates.length)
      return { ...this.#base(project, 'select_draft', 'concept', null, selected.candidates, null,
        reason('early_draft_ambiguous', 'concept', 'Several pinned concepts require an explicit draftId', 'draftId')),
        turnsUsed, handoff: false };
    let draft = selected.draft;
    if (!draft) {
      const current = this.#currentStage(project);
      if (current?.stage !== 'discovery' || current.blocked) return null;
      const discovery = this.#savedDraft(project, 'discovery', current.artifact, request.draftId, input?.refs ?? []).draft;
      const run = discovery ? readResearchRun(store, project, discovery.id) : null;
      if (!run?.value.finalization) return null;
      const { readRunnerFinalizationAt } = await import('../discovery/discovery-finalization-runner.js');
      const proof = await readRunnerFinalizationAt(store, project, reference(run));
      if (proof.status !== 'accepted' || proof.view.next !== 'concept' || !proof.view.manifest
        || turnsUsed >= request.maxTurns || request.maxCalls === 0) return null;
      // C1 is re-proved by the shared producer; every write carries the acquired hold.
      draft = await prepareDiscoveryHandoff(store,
        { project, stage: 'concept', manifest: proof.view.manifest, inputs: [proof.view.manifest] }, execution.hold);
    }
    const at = reference(draft);
    return withDiscoveryHandoffAt(store, project, at, () => {
      const bound = requireDiscoveryHandoff(store, draft!.value);
      const current = this.#currentStage(project, bound.source.manifest);
      const explicit = request.draftId ? readDraft(store, request.draftId) : null;
      const draftId = current?.stage === 'concept'
        ? !request.draftId || explicit?.value.stage === 'discovery' ? draft!.id : request.draftId
        : explicit?.value.stage === 'discovery' || explicit?.value.stage === 'concept' ? undefined : request.draftId;
      const { draftId: _selected, ...rest } = request;
      return this.#driveEarly({ ...rest, ...(draftId ? { draftId } : {}) }, execution, input, turnsUsed, bound.source.manifest);
    });
  }

  #currentStage(project: string, manifest?: Ref): { stage: UpstreamStage; artifact: Revision<StageArtifact> | null; draft: Ref | null;
    blocked: boolean; reason: EarlyStageReason | null } | null {
    for (const stage of UPSTREAM_STAGES) {
      if (stage === 'discovery' && manifest) continue;
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
    explicit: string | undefined, execution: RunExecution, input: ResolvedInput | null): Selection {
    const entryRefs = input?.refs ?? [];
    const boundDraft = this.#activeStageDraft(project, stage, artifact, entryRefs);
    if (explicit && boundDraft && explicit !== boundDraft.id)
      return { outcome: { ...this.#base(project, "blocked", stage, boundDraft, [], null,
        reason("early_draft_conflict", explicit, "The stage already names another saved draft", "draftId")), turnsUsed: 0, handoff: false } };
    const named = explicit ?? boundDraft?.id;
    if (named) {
      const draft = readDraft(this.engine.store, named);
      const invalid = this.#draftRefusal(project, stage, draft, entryRefs);
      return invalid
        ? { outcome: { ...this.#base(project, "blocked", stage, draft ? reference(draft) : null, [], null, invalid), turnsUsed: 0, handoff: false } }
        : { draft: draft! };
    }

    const rows = listDrafts(this.engine.store, project, stage)
      .filter(row => row.value.level === "R0");
    const valid: Revision<DiscoveryDraft>[] = [], invalid: EarlyStageReason[] = [];
    for (const draft of rows) {
      const refusal = this.#draftRefusal(project, stage, draft, entryRefs);
      if (refusal && !(refusal.code === "early_draft_stale"
        && this.#supersededInputDraft(project, entryRefs, draft))) invalid.push(refusal);
      else if (!refusal) valid.push(draft);
    }
    if (valid.length > 1) return { outcome: { ...this.#base(project, "select_draft", stage, null, valid.map(reference), null,
      reason("early_draft_ambiguous", stage, "Several compatible drafts require an explicit draftId", "draftId")), turnsUsed: 0, handoff: false } };
    if (valid.length === 1) return { draft: valid[0]! };
    if (invalid.length) return { outcome: { ...this.#base(project, "blocked", stage, null, valid.map(reference), null, invalid[0]!), turnsUsed: 0, handoff: false } };
    try { return { draft: this.engine.prepareEarlyStage(project, stage, execution.hold,
      stage === "discovery" ? entryRefs : []) }; }
    catch (error) {
      if (error instanceof RunControlLost) return { outcome: this.#controlOutcome(project, error, 0) };
      if (error instanceof EngineError) return { outcome: { ...this.#base(project, "blocked", stage, null, [], null,
        reason(error.code, stage, error.message)), turnsUsed: 0, handoff: false } };
      throw error;
    }
  }

  #activeStageDraft(project: string, stage: UpstreamStage, artifact: Revision<StageArtifact> | null,
    entryRefs: Ref[]): Ref | null {
    const content = artifact?.value.content as unknown as Partial<StageContent> | undefined;
    const recorded = isRef(content?.draft) ? content.draft : null;
    if (!recorded || stage !== "discovery") return recorded;
    const draft = readDraft(this.engine.store, recorded.id);
    return draft && this.#supersededInputDraft(project, entryRefs, draft) ? null : recorded;
  }

  #supersededInputDraft(project: string, entryRefs: Ref[], draft: Revision<DiscoveryDraft>): boolean {
    if (draft.value.stage !== "discovery") return false;
    const currentRef = entryRefs.find(ref => ref.id === inputId(project));
    if (!currentRef || currentRef.revision <= 1) return false;
    const current = this.engine.store.get<EarlyStageInput>(currentRef.id, currentRef.revision);
    if (!current || current.kind !== EARLY_INPUT_KIND || canonical(reference(current)) !== canonical(currentRef)
      || current.value.contract !== EARLY_INPUT_CONTRACT || current.value.projectId !== project
      || current.value.actor !== DRIVER_ACTOR || !isRef(current.value.project) || !isRef(current.value.source)) return false;
    const priorRef = draft.value.inputs.find(ref => ref.id === current.id);
    if (!priorRef || priorRef.revision >= current.revision) return false;
    const prior = this.engine.store.get<EarlyStageInput>(priorRef.id, priorRef.revision);
    if (!prior || prior.kind !== EARLY_INPUT_KIND || canonical(reference(prior)) !== canonical(priorRef)
      || prior.value.contract !== EARLY_INPUT_CONTRACT || prior.value.projectId !== project
      || prior.value.actor !== DRIVER_ACTOR || !isRef(prior.value.project) || !isRef(prior.value.source)
      || canonical(prior.value.project) !== canonical(current.value.project)) return false;
    return canonical(draft.value.inputs) === canonical(uniqueRefs([prior.value.project, prior.value.source, reference(prior)]));
  }

  #draftRefusal(project: string, stage: UpstreamStage, draft: Revision<DiscoveryDraft> | null,
    entryRefs: Ref[]): EarlyStageReason | null {
    if (!draft || draft.kind !== "discovery-draft" || draft.value.projectId !== project || draft.value.stage !== stage
      || draft.value.level !== "R0" || draft.value.consumer !== STAGES[STAGES.indexOf(stage) + 1])
      return reason("early_draft_foreign", draft?.id ?? stage, "The selected draft does not belong to this project stage", "draftId");
    const prior = predecessor(stage);
    const bound = hasDiscoveryHandoff(this.engine.store, draft.value) ? requireDiscoveryHandoff(this.engine.store, draft.value) : null;
    const required = stage === 'concept' && bound ? [bound.source.manifest]
      : prior ? this.engine.pipeline.inspect(project, prior).guards : entryRefs;
    if (canonical(draft.value.inputs) !== canonical(required))
      return reason("early_draft_stale", draft.id, "The saved draft does not name the current prerequisite basis", "inputs");
    const admission = executionAdmission(this.engine.store, draft, 'early-drive', this.#producerPolicy);
    // Let a started v7 history reach StageResearch's free restore path. Its own admission
    // still forbids a new v7 purchase under the default producer policy.
    if (!admission.admitted && stage === 'discovery' && isCurrentEra('discovery', draft.value.contractVersion, { discovery: 7 })
      && readResearchRun(this.engine.store, project, draft.id)) return null;
    if (!admission.admitted)
      return reason("research_contract_upgrade_required", draft.id, "This unfinished draft has no supported research contract", "contractVersion");
    if (admission.form === "lost")
      return reason("early_draft_invalid", draft.id, "The saved draft lost its complete question set", "questions");
    if (admission.form === "mismatch")
      return reason("early_draft_invalid", draft.id, "The saved draft questions do not match their stage contract", "questions");
    return null;
  }

  async #stageOutcome(project: string, stage: UpstreamStage, draft: Ref, result: StageResearchResult): Promise<EarlyResult> {
    if (stage === 'discovery' && result.finalization && result.research) {
      const { readRunnerFinalizationAt } = await import('../discovery/discovery-finalization-runner.js');
      const proof = await readRunnerFinalizationAt(this.engine.store, project, result.research);
      requireCondition(canonical(proof.view) === canonical(result.finalization), 'discovery_finalization_invalid',
        'The driver result differs from its proven finalization');
      const end: EarlyStageEnd = result.status === 'stopped' ? 'stopped' : proof.status === 'needs_owner' ? 'needs_owner'
        : proof.status !== 'accepted' ? 'stage_paused' : proof.outcome === 'no_go' ? 'no_go'
        : proof.outcome === 'insufficient_evidence' ? 'insufficient_evidence'
        : proof.accepted!.conditions.open.length ? 'conditional' : 'stage_paused';
      const { readDiscoveryFinalSummaryAt } = await import('../discovery/discovery-final-summary.js');
      const value = proof.record.value;
      const summaryRequest = value.accepted ? { manifest: value.accepted } : value.assessment ? { assessment: value.assessment }
        : value.final ? { paid: value.final } : null;
      const finalSummary = summaryRequest ? await readDiscoveryFinalSummaryAt(this.engine.store, project, summaryRequest) : null;
      return { ...this.#base(project, end, stage, draft, [], { ...result, finalSummary }, result.reason ?? null),
        turnsUsed: result.turnsUsed ?? 0, handoff: false };
    }
    const state = result.discovery?.state;
    const end: EarlyStageEnd = result.status === "stopped" ? "stopped"
      : state === "no_go" ? "no_go"
      : state === "insufficient_evidence" ? "insufficient_evidence"
      : state === "conditional" ? result.discovery!.ownerChoices.length ? "needs_owner" : "conditional"
      : result.status === "needs_owner" ? "needs_owner"
      : result.status === "blocked" ? "blocked" : "stage_paused";
    const finding = result.reason;
    if (stage === 'discovery' && result.status === 'paused' && result.research) {
      const run = this.engine.store.get<import('../discovery/research-model.js').ResearchRun>(result.research.id, result.research.revision);
      if (run && [SELECTED_DOSSIER_PENDING,SELECTED_DOSSIER_PAUSE].includes(run.value.pauseCode ?? '')) {
        const proof = await readSelectedResearchPause(this.engine.store,project,draft.id,run);
        requireCondition(run.value.pauseCode === SELECTED_DOSSIER_PAUSE && proof.selected,
          'discovery_selected_pause_invalid', 'The selected dossier publication is not complete');
        const { guards: _guards, findings: _findings, ...discovery } = discoveryInspection(this.engine.store,
          this.engine.store.get<DiscoveryDraft>(proof.handoff.value.draft.id,proof.handoff.value.draft.revision)!).outcome;
        return { ...this.#base(project,'stage_paused',stage,proof.handoff.value.draft,[],{...result,discovery},
          { code: SELECTED_DOSSIER_PAUSE, target: 'dossier-assessment', message: 'The complete selected dossier awaits assessment',
            handoff: reference(proof.handoff), selected: reference(proof.selected.record), dossier: reference(proof.selected.manifest),
            completeness: 'complete', next: 'dossier-assessment' }), turnsUsed: result.turnsUsed ?? 0, handoff: false };
      }
      let saved: any;
      try { saved = JSON.parse(run?.value.error ?? 'null'); } catch { /* A diagnostic pause carries no authority. */ }
      const address: unknown = saved?.handoff;
      const partial = run?.value.pauseCode === 'research_dossier_assessment_unavailable';
      // A current budget/forecast refusal takes precedence over a historical
      // deep-frontier pause. Otherwise expose only the proved exact handoff.
      const pending = run?.value.pauseCode === 'research_deep_frontier_pending'
        && (!finding || finding.code === 'research_deep_frontier_pending');
      const handoffPause = partial || pending || run?.value.pauseCode === 'research_partial_dossier_pending'
        || run?.value.pauseCode === 'research_variant_handoff_unavailable';
      if (handoffPause)
        requireCondition(isRef(address), 'discovery_variant_handoff_invalid', 'The saved handoff pause lost its exact address');
      if (handoffPause && isRef(address)) {
        const handoff = (await readVariantHandoff(this.engine.store, project, address)).record;
        requireCondition(partial ? handoff.value.draft.id === draft.id : canonical(handoff.value.draft) === canonical(draft),
          'discovery_variant_handoff_invalid', 'The stage paused on another draft handoff');
        let partialReason: EarlyStageReason | null = null;
        if (partial) {
          requireCondition(!Object.hasOwn(saved,'selected'), 'discovery_selected_pause_invalid', 'A partial pause cannot carry a selected carrier');
          requireCondition(isRef(saved?.dossier), 'discovery_dossier_invalid', 'The saved partial result lost its exact dossier');
          const dossier = await readPartialDossier(this.engine.store, project, saved.dossier);
          requireCondition(canonical(reference(dossier.handoff)) === canonical(address)
            && canonical(dossier.record.value.draft) === canonical(handoff.value.draft),
            'discovery_dossier_invalid', 'The partial dossier belongs to another handoff or draft');
          if (handoff.value.next === 'deep') requireCondition(isRef(saved.stop) && dossier.stop
            && canonical(reference(dossier.stop)) === canonical(saved.stop),
            'discovery_deep_stop_invalid', 'The partial pause lost its exact deep stop');
          partialReason = { code: 'research_dossier_assessment_unavailable', target: 'dossier-assessment',
            message: 'The saved partial dossier awaits assessment', handoff: reference(handoff),
            dossier: reference(dossier.record), completeness: 'partial', next: 'dossier-assessment' };
        } else requireCondition(run?.value.pauseCode !== 'research_partial_dossier_pending',
          'discovery_dossier_invalid', 'The partial dossier publication is not complete');
        const { guards: _guards, findings: _findings, ...discovery } = discoveryInspection(this.engine.store,
          this.engine.store.get<DiscoveryDraft>(draft.id, draft.revision)!).outcome;
        return { ...this.#base(project, 'stage_paused', stage, partial ? handoff.value.draft : draft, [], { ...result, discovery },
          partialReason ?? { code: 'research_variant_handoff_unavailable', target: handoff.value.next,
            message: `The saved Discovery handoff awaits ${handoff.value.next}`, handoff: reference(handoff), next: handoff.value.next }),
          turnsUsed: result.turnsUsed ?? 0, handoff: false };
      }
    }
    return { ...this.#base(project, end, stage, draft, [], result, finding
      ? { ...reason(finding.code, finding.target, finding.message, finding.field), ...(finding.door ? { door: finding.door } : {}) } : null),
      turnsUsed: result.turnsUsed ?? 0, handoff: false };
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
