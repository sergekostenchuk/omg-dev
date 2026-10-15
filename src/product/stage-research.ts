import { hashJson } from '../canonical.js';
import type { ResearchRun } from '../discovery/research-model.js';
import { discoveryOutcome, type DiscoveryOutcome } from '../discovery/discovery-outcome.js';
import type { ProductEngine, StageContent } from "./engine.js";
import type { DiscoveryDraft } from "../discovery/discovery.js";
import { UPSTREAM_STAGES, type UpstreamStage, RESEARCH_CONTRACT_VERSION } from "../discovery/requirements.js";
import { researchForConsumer, designFindings } from "../discovery/consumer-research.js";
import { requireCondition, EngineError } from "../errors.js";
import { reference, stageId, type Finding, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { readRunControl, runControlId } from "../om/run-control.js";
import { runAssessmentRefusalDoor, type AssessmentRefusalDoor } from "../discovery/assessment-session.js";
import type { Revision } from "../storage/store.js";

export interface StageResearchResult {
  status: "accepted" | "paused" | "needs_owner" | "blocked" | "stopped";
  discovery?: Omit<DiscoveryOutcome, "guards" | "findings">;
  stage: Ref | null; research: Ref | null; feedback: Ref | null; findings: Finding[];
  // Accepted stages from contracts before v5 replay the public result shape of
  // their producer. Current runs always report both fields.
  turnsUsed?: number; reason?: StageReason | null;
}
/** DRY6-01: a pause on a refused original assessment names the assessed question and its exact recovery door. */
export type StageReason = Finding & { door?: AssessmentRefusalDoor };

export interface StageResearchOptions { restoreOnly?: boolean }

const DESIGN_ERRORS = new Set(["graph_invalid", "map_design_missing", "derived_field_conflict", "l1_detail_leak",
  "outcome_uncovered", "journey_uncovered", "graph_semantic_drift"]);

export class StageResearch {
  constructor(private readonly engine: ProductEngine) {}
  async run(project: string, draftId: string, maxTurns: number,
    options: StageResearchOptions = {}): Promise<StageResearchResult> {
    requireCondition(Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 100, "research_budget_invalid", "Stage research needs a bounded turn allowance");
    const { store, pipeline, researcher } = this.engine;
    const draft = store.get<DiscoveryDraft>(draftId);
    requireCondition(draft?.kind === "discovery-draft" && draft.value.projectId === project
      && UPSTREAM_STAGES.includes(draft.value.stage as UpstreamStage), "discovery_foreign", "Stage research needs this project's upstream draft");
    const stage = draft.value.stage as UpstreamStage;
    let artifact = store.get<StageArtifact>(stageId(project, stage));
    if (artifact?.value.status === "accepted") {
      requireCondition((artifact.value.content as unknown as StageContent).draft?.id === draftId,
        "stage_already_accepted", "Accepted research must be explicitly revised before replacing it");
      const checked = pipeline.inspect(project, stage);
      const outcome = checked.state === 'accepted' ? discoveryOutcome(store, draft) : null;
      const discovery = outcome && outcome.state !== 'legacy'
        ? { state: outcome.state, verdict: outcome.verdict, report: outcome.report, conditions: outcome.conditions, ownerChoices: outcome.ownerChoices, reason: outcome.reason } : undefined;
      const replay = { status: checked.state === "accepted" ? "accepted" as const : "blocked" as const,
        stage: reference(artifact), research: null, feedback: null, findings: checked.findings,
        ...(discovery ? { discovery } : {}) };
      return (draft.value.contractVersion ?? 1) < 5 ? replay
        : { ...replay, turnsUsed: 0, reason: checked.findings[0] ?? null };
    }
    const stoppedFinding = { code: 'run_stopped', target: runControlId(project),
      message: 'The project is stopped; resume the exact stop before new research' };
    const restorePaid = async (): Promise<Revision<ResearchRun> | null> => {
      const runId = `research-run:${hashJson([project,draftId])}`;
      let restored = store.get<ResearchRun>(runId);
      if (draft.value.contractVersion === 4 || restored) {
        try { restored = await researcher.run(project,draftId,1,undefined,{restoreOnly:true}); }
        catch(error) { if(!(error instanceof EngineError)) throw error; restored = store.get<ResearchRun>(runId); }
      }
      return restored;
    };
    if (options.restoreOnly) {
      const restored = await restorePaid();
      return { status: 'stopped', stage: artifact ? reference(artifact) : null,
        research: restored ? reference(restored) : null, feedback: null,
        findings: [stoppedFinding], turnsUsed: 0, reason: stoppedFinding };
    }
    const control = readRunControl(store, { project });
    if (!control.ok) throw new EngineError(control.refusal.code, control.refusal.message, control.refusal.at);
    if ([4, 5, 6].includes(draft.value.contractVersion ?? 1)
      && draft.value.contractVersion! < RESEARCH_CONTRACT_VERSION) {
      const restored = await restorePaid(), run=store.get<ResearchRun>(`research-run:${hashJson([project,draftId])}`);
      if (control.value.stopped) return {status:'stopped',stage:artifact?reference(artifact):null,
        research:restored?reference(restored):run?reference(run):null,feedback:null,findings:[stoppedFinding],turnsUsed:0,reason:stoppedFinding};
      if (restored?.value.pauseCode && !['research_contract_upgrade_required', 'research_restore_complete'].includes(restored.value.pauseCode))
        return {status:'paused',stage:artifact?reference(artifact):null,research:reference(restored),feedback:null,
          findings:[{code:restored.value.pauseCode,target:draftId,message:restored.value.error ?? 'The saved paid turn could not be restored'}],
          turnsUsed:0,reason:{code:restored.value.pauseCode,target:draftId,message:restored.value.error ?? 'The saved paid turn could not be restored'}};
      const message = draft.value.contractVersion === 4
        ? 'Paid v4 work is retained; prepare Discovery v5 before new research or acceptance'
        : `Paid v${draft.value.contractVersion} work is retained; prepare Discovery v${RESEARCH_CONTRACT_VERSION} before new research or acceptance`;
      const reason = {code:'research_contract_upgrade_required',target:draftId,message};
      return {status:'paused',stage:artifact?reference(artifact):null,research:run?reference(run):null,feedback:null,
        findings:[reason],turnsUsed:0,reason};
    }
    requireCondition(draft.value.contractVersion === RESEARCH_CONTRACT_VERSION, "research_contract_upgrade_required", "New stage research requires the current contract");
    if (control.value.stopped) {
      const restored = await restorePaid();
      return { status: 'stopped', stage: artifact ? reference(artifact) : null,
        research: restored ? reference(restored) : null, feedback: null,
        findings: [stoppedFinding], turnsUsed: 0, reason: stoppedFinding };
    }
    let graphExpected = store.get(`graph:${project}`)?.revision ?? 0;
    const result = await researchForConsumer(store, researcher, project, draftId, maxTurns, () => {
      // Capture before the model call; a competing stage edit must never be overwritten.
      const expected = artifact?.revision ?? 0;
      return () => {
        requireCondition((store.get(stageId(project, stage))?.revision ?? 0) === expected,
          "revision_conflict", "Stage changed while research was running");
        let guards: Ref[] = [];
        let findings: Finding[] = [];
        if (stage === "operation-map") {
          try {
            const built = this.engine.execute({ type: "build-map", project, draftId, expected: graphExpected }) as { revision: number };
            graphExpected = built.revision;
          }
          catch (error) {
            findings = designFindings(error, "mapDesign", draftId, DESIGN_ERRORS);
          }
        }
        if (!findings.length) {
          artifact = this.engine.draft(project, stage, draftId, expected);
          const checked = pipeline.inspect(project, stage);
          if (!checked.findings.length) {
            artifact = pipeline.accept(project, stage, artifact.revision);
            return { artifact: reference(artifact), findings: [], guards: [] };
          }
          findings = checked.findings; guards = checked.guards;
        }
        return { artifact: artifact ? reference(artifact) : null, findings, guards };
      };
    }, artifact ? reference(artifact) : null);
    const { artifact: accepted, ...rest } = result;
    const research = rest.research ? store.get<ResearchRun>(rest.research.id, rest.research.revision) : null;
    const door = research && !rest.findings.length ? runAssessmentRefusalDoor(store, project, research) : null;
    const paused: StageReason | null = rest.findings.length || !research?.value.pauseCode ? null : door
      ? { code: research.value.pauseCode, target: door.question.id, message: research.value.error ?? 'Research paused', door }
      : { code: research.value.pauseCode, target: draftId, message: research.value.error ?? 'Research paused' };
    const findings: Finding[] = paused ? [paused] : rest.findings;
    const currentControl = readRunControl(store, { project });
    if (!currentControl.ok) throw new EngineError(currentControl.refusal.code, currentControl.refusal.message, currentControl.refusal.at);
    const status = rest.status !== 'accepted' && currentControl.value.stopped ? 'stopped' as const : rest.status;
    const outcome = discoveryOutcome(store, store.get<DiscoveryDraft>(draftId)!);
    if (outcome.state === 'legacy') {
      const reported = status === 'stopped' ? [stoppedFinding, ...findings] : findings;
      return { ...rest, status, findings: reported, turnsUsed: rest.turnsUsed ?? 0,
        stage: accepted, reason: reported[0] ?? null };
    }
    const { guards: _guards, findings: outcomeFindings, ...discovery } = outcome;
    const finalFindings = outcomeFindings.length ? outcomeFindings : findings;
    const outcomeStatus = outcomeFindings.length
      ? outcome.ownerChoices.length ? 'needs_owner' as const : 'paused' as const : status;
    const finalStatus = outcomeStatus === 'accepted' || !currentControl.value.stopped ? outcomeStatus : 'stopped';
    const reported = finalStatus === 'stopped' ? [stoppedFinding, ...finalFindings] : finalFindings;
    return { ...rest, status: finalStatus, findings: reported, turnsUsed: rest.turnsUsed ?? 0,
      stage: accepted, discovery, reason: reported[0] ?? null };
  }
}
