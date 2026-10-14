import { hashJson } from '../canonical.js';
import type { ResearchRun } from '../discovery/research-model.js';
import { discoveryOutcome, type DiscoveryOutcome } from '../discovery/discovery-outcome.js';
import type { ProductEngine, StageContent } from "./engine.js";
import type { DiscoveryDraft } from "../discovery/discovery.js";
import { UPSTREAM_STAGES, type UpstreamStage, RESEARCH_CONTRACT_VERSION } from "../discovery/requirements.js";
import { researchForConsumer, designFindings } from "../discovery/consumer-research.js";
import { requireCondition, EngineError } from "../errors.js";
import { reference, stageId, type Finding, type Ref, type StageArtifact } from "../pipeline/contracts.js";

export interface StageResearchResult {
  status: "accepted" | "paused" | "needs_owner" | "blocked";
  discovery?: Omit<DiscoveryOutcome, "guards" | "findings">;
  stage: Ref | null; research: Ref | null; feedback: Ref | null; findings: Finding[];
}

const DESIGN_ERRORS = new Set(["graph_invalid", "map_design_missing", "derived_field_conflict", "l1_detail_leak",
  "outcome_uncovered", "journey_uncovered", "graph_semantic_drift"]);

export class StageResearch {
  constructor(private readonly engine: ProductEngine) {}
  async run(project: string, draftId: string, maxTurns: number): Promise<StageResearchResult> {
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
      return { status: checked.state === "accepted" ? "accepted" : "blocked", stage: reference(artifact), research: null, feedback: null,
        findings: checked.findings, ...(discovery ? { discovery } : {}) };
    }
    if (draft.value.contractVersion===4) {
      let restored: Awaited<ReturnType<typeof researcher.run>> | null = null;
      try { restored = await researcher.run(project,draftId,1,undefined,{restoreOnly:true}); }
      catch(error) { if(!(error instanceof EngineError && error.code==='research_contract_upgrade_required')) throw error; }
      const run=store.get<ResearchRun>(`research-run:${hashJson([project,draftId])}`);
      if (restored?.value.pauseCode && restored.value.pauseCode !== 'research_contract_upgrade_required')
        return {status:'paused',stage:artifact?reference(artifact):null,research:reference(restored),feedback:null,
          findings:[{code:restored.value.pauseCode,target:draftId,message:restored.value.error ?? 'The saved paid turn could not be restored'}]};
      return {status:'paused',stage:artifact?reference(artifact):null,research:run?reference(run):null,feedback:null,
        findings:[{code:'research_contract_upgrade_required',target:draftId,message:'Paid v4 work is retained; prepare Discovery v5 before new research or acceptance'}]};
    }
    requireCondition(draft.value.contractVersion === RESEARCH_CONTRACT_VERSION, "research_contract_upgrade_required", "New stage research requires the current contract");
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
    const outcome = discoveryOutcome(store, store.get<DiscoveryDraft>(draftId)!);
    if (outcome.state === 'legacy') return { ...rest, stage: accepted };
    const { guards: _guards, findings, ...discovery } = outcome;
    return { ...rest, stage: accepted, discovery,
      ...(findings.length ? { status: outcome.ownerChoices.length ? 'needs_owner' as const : 'paused' as const, findings } : {}) };
  }
}
