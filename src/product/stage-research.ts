import type { ProductEngine, StageContent } from "./engine.js";
import type { DiscoveryDraft } from "../discovery/discovery.js";
import { UPSTREAM_STAGES, type UpstreamStage, RESEARCH_CONTRACT_VERSION } from "../discovery/requirements.js";
import { rejectResearch } from "../discovery/consumer-feedback.js";
import { EngineError, requireCondition } from "../errors.js";
import { reference, stageId, type Finding, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import type { ResearchRun } from "../discovery/research-model.js";
import type { Revision } from "../storage/store.js";

export interface StageResearchResult {
  status: "accepted" | "paused" | "needs_owner" | "blocked";
  stage: Ref | null; research: Ref | null; feedback: Ref | null; findings: Finding[];
}

const DESIGN_ERRORS = new Set(["graph_invalid", "map_design_missing", "derived_field_conflict", "l1_detail_leak",
  "outcome_uncovered", "journey_uncovered", "graph_semantic_drift"]);

export class StageResearch {
  constructor(private readonly engine: ProductEngine) {}
  async run(project: string, draftId: string, maxTurns: number): Promise<StageResearchResult> {
    requireCondition(Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 100, "research_budget_invalid", "Stage research needs a bounded turn allowance");
    const { store, pipeline, researcher } = this.engine;
    let draft = store.get<DiscoveryDraft>(draftId);
    requireCondition(draft?.kind === "discovery-draft" && draft.value.projectId === project
      && UPSTREAM_STAGES.includes(draft.value.stage as UpstreamStage), "discovery_foreign", "Stage research needs this project's upstream draft");
    requireCondition(draft.value.contractVersion === RESEARCH_CONTRACT_VERSION, "research_contract_upgrade_required", "New stage research requires the current contract");
    const stage = draft.value.stage as UpstreamStage;
    let artifact = store.get<StageArtifact>(stageId(project, stage));
    if (artifact?.value.status === "accepted") {
      requireCondition((artifact.value.content as unknown as StageContent).draft?.id === draftId,
        "stage_already_accepted", "Accepted research must be explicitly revised before replacing it");
      const checked = pipeline.inspect(project, stage);
      return { status: checked.state === "accepted" ? "accepted" : "blocked", stage: reference(artifact), research: null, feedback: null, findings: checked.findings };
    }
    let remaining = maxTurns;
    let run: Revision<ResearchRun> | null = null;
    let feedback: Ref | null = null;
    let findings: Finding[] = [];
    while (remaining > 0) {
      // Capture before the model call; a competing stage edit must never be overwritten.
      const expected = artifact?.revision ?? 0;
      const graphExpected = store.get(`graph:${project}`)?.revision ?? 0;
      const previousTurns = store.list<ResearchRun>("research-run").find(item => item.value.draftId === draftId)?.value.turns ?? 0;
      run = await researcher.run(project, draftId, remaining);
      remaining -= Math.max(1, run.value.turns - previousTurns);
      if (run.value.status !== "completed") return { status: run.value.status === "needs_owner" ? "needs_owner" : "paused",
        stage: artifact ? reference(artifact) : null, research: reference(run), feedback, findings };
      requireCondition((store.get(stageId(project, stage))?.revision ?? 0) === expected,
        "revision_conflict", "Stage changed while research was running");
      draft = store.get<DiscoveryDraft>(draftId)!;
      let guards: Ref[] = [];
      findings = [];
      if (stage === "operation-map") {
        try { this.engine.execute({ type: "build-map", project, draftId, expected: graphExpected }); }
        catch (error) {
          if (!(error instanceof EngineError) || !DESIGN_ERRORS.has(error.code)) throw error;
          findings = error.code === "graph_invalid" && Array.isArray(error.details)
            ? error.details.map(item => ({ ...item, field: "mapDesign" }))
            : [{ code: error.code, target: draftId, message: error.message, field: "mapDesign" }];
        }
      }
      if (!findings.length) {
        artifact = this.engine.draft(project, stage, draftId, expected);
        const checked = pipeline.inspect(project, stage);
        if (!checked.findings.length) {
          artifact = pipeline.accept(project, stage, artifact.revision);
          return { status: "accepted", stage: reference(artifact), research: reference(run), feedback, findings: [] };
        }
        findings = checked.findings; guards = checked.guards;
      }
      if (findings.some(finding => !finding.field)) return { status: "blocked", stage: artifact ? reference(artifact) : null,
        research: reference(run), feedback, findings };
      feedback = reference(rejectResearch(store, draft, findings, guards));
    }
    return { status: "paused", stage: artifact ? reference(artifact) : null, research: run ? reference(run) : null, feedback, findings };
  }
}
