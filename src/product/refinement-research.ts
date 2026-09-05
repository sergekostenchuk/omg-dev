import type { ProductEngine } from "./engine.js";
import type { DiscoveryDraft } from "../discovery/discovery.js";
import { researchForConsumer, designFindings, type ConsumerResult } from "../discovery/consumer-research.js";
import { EngineError, requireCondition } from "../errors.js";
import { reference, type Ref, type Finding } from "../pipeline/contracts.js";
import { REFINEMENT_CONTRACT_VERSION } from "../graph/research-contracts.js";
import { LAYER_DESIGN_VERSION } from "../graph/layer-design.js";

export type ResearchPhase = "R1" | "R2" | "L2" | "L3";
const DESIGN_ERRORS = new Set(["graph_invalid", "graph_semantic_drift", "layer_design_missing", "derived_field_conflict",
  "layer_detail_invalid", "horizon_empty", "upper_layer_drift", "layer_outcome_uncovered", "layer_connector_uncovered", "layer_port_unbound"]);

export class RefinementResearch {
  constructor(private readonly engine: ProductEngine, private readonly actor: string) {}
  async run(project: string, phase: ResearchPhase, draftId: string, maxTurns: number): Promise<ConsumerResult> {
    requireCondition(["R1", "R2", "L2", "L3"].includes(phase), "phase_invalid", "Select R1/R2 research or an L2/L3 design");
    requireCondition(Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 100, "research_budget_invalid", "Refinement research needs a bounded allowance");
    const { store, researcher, refinement } = this.engine;
    const draft = store.get<DiscoveryDraft>(draftId);
    const layer = phase === "L2" ? 2 : phase === "L3" ? 3 : null;
    const level = phase === "L2" ? "R1" : phase === "L3" ? "R2" : phase;
    requireCondition(draft?.kind === "discovery-draft" && draft.value.projectId === project
      && draft.value.stage === "om-g2" && draft.value.level === level
      && (layer ? draft.value.consumer !== "compilation" : draft.value.consumer === "compilation"),
    "research_foreign", "Research must belong to the requested phase and project");
    requireCondition(draft.value.contractVersion === (layer ? LAYER_DESIGN_VERSION : REFINEMENT_CONTRACT_VERSION),
      "research_contract_upgrade_required", "Refinement research requires its current contract");
    const id = `phase:${project}:${phase}`;
    const prior = store.get<{ draft: Ref | null; layer: Ref | null }>(id);
    if (prior && (layer ? prior.value.layer && store.get(prior.value.layer.id)?.hash === prior.value.layer.hash
      && store.get<{ inputs: Ref[] }>(prior.value.layer.id)?.value.inputs.some(ref => ref.id === draftId)
      : prior.value.draft?.id === draftId)) {
      const checked = refinement.gate(project, phase);
      return { status: checked.findings.length ? "blocked" : "accepted", artifact: reference(prior), research: null, feedback: null, findings: checked.findings };
    }
    // A rejected proposal does not advance a phase or graph. Never adopt another
    // writer's revision as permission to replace its result on the next retry.
    const expected = prior?.revision ?? 0;
    const graphExpected = store.get(`graph:${project}`)?.revision ?? 0;
    return researchForConsumer(store, researcher, project, draftId, maxTurns, () => {
      return current => {
        requireCondition((store.get(id)?.revision ?? 0) === expected, "revision_conflict", "Refinement phase changed while research was running");
        requireCondition((store.get(`graph:${project}`)?.revision ?? 0) === graphExpected, "graph_stale", "Graph changed while research was running");
        if (layer) {
          let built: Ref;
          try { built = reference(refinement.buildLayer(project, layer, reference(current), graphExpected, this.actor)); }
          catch (error) {
            return { artifact: null, findings: designFindings(error, "layerDesign", draftId, DESIGN_ERRORS), guards: [] };
          }
          const milestone = refinement.sealLayer(project, layer, expected, built);
          return { artifact: reference(milestone), findings: [], guards: [] };
        }
        try {
          const milestone = refinement.finishResearch(project, level as "R1" | "R2", reference(current), expected);
          return { artifact: reference(milestone), findings: [], guards: [] };
        } catch (error) {
          if (!(error instanceof EngineError) || error.code !== "technical_research_incomplete" || !Array.isArray(error.details)) throw error;
          return { artifact: null, findings: error.details as Finding[], guards: [] };
        }
      };
    }, prior ? reference(prior) : null);
  }
}
