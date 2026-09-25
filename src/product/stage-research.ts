import type { ProductEngine, StageContent } from "./engine.js";
import type { DiscoveryDraft } from "../discovery/discovery.js";
import { UPSTREAM_STAGES, type UpstreamStage, RESEARCH_CONTRACT_VERSION } from "../discovery/requirements.js";
import { researchForConsumer, designFindings } from "../discovery/consumer-research.js";
import { requireCondition } from "../errors.js";
import { reference, stageId, type Finding, type Ref, type StageArtifact } from "../pipeline/contracts.js";

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
    const draft = store.get<DiscoveryDraft>(draftId);
    requireCondition(draft?.kind === "discovery-draft" && draft.value.projectId === project
      && UPSTREAM_STAGES.includes(draft.value.stage as UpstreamStage), "discovery_foreign", "Stage research needs this project's upstream draft");
    const stage = draft.value.stage as UpstreamStage;
    let artifact = store.get<StageArtifact>(stageId(project, stage));
    if (artifact?.value.status === "accepted") {
      requireCondition((artifact.value.content as unknown as StageContent).draft?.id === draftId,
        "stage_already_accepted", "Accepted research must be explicitly revised before replacing it");
      const checked = pipeline.inspect(project, stage);
      return { status: checked.state === "accepted" ? "accepted" : "blocked", stage: reference(artifact), research: null, feedback: null, findings: checked.findings };
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
    return { ...rest, stage: accepted };
  }
}
