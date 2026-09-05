import { Store } from "../storage/store.js";
import type { MachinePlan } from "./model.js";
import type { Feasibility } from "../graph/refinement.js";
import type { StageArtifact } from "../pipeline/contracts.js";
import { isRef } from "../pipeline/contracts.js";
import { hashJson } from "../canonical.js";
import { requireCondition } from "../errors.js";

export function requireBasis(store: Store, plan: MachinePlan): void {
  requireCondition(plan && [1, 2].includes(plan.version) && [plan.graph, plan.environment, plan.stage, plan.feasibility].every(isRef)
    && Array.isArray(plan.guards) && plan.guards.every(isRef) && Array.isArray(plan.tasks), "plan_invalid", "Plan requires its versioned compilation basis");
  const stage = store.get<StageArtifact>(plan.stage.id, plan.stage.revision);
  const feasibility = store.get<Feasibility>(plan.feasibility.id, plan.feasibility.revision);
  requireCondition(stage?.kind === "stage" && stage.hash === plan.stage.hash && stage.value.projectId === plan.projectId
    && stage.value.stage === "om-g2" && stage.value.status === "accepted"
    && hashJson(stage.value.content) === hashJson({ feasibility: plan.feasibility }), "plan_basis_foreign", "Plan must bind the accepted OM-G2 stage");
  requireCondition(feasibility?.kind === "feasibility" && feasibility.hash === plan.feasibility.hash
    && feasibility.value.projectId === plan.projectId && feasibility.value.ready && feasibility.value.repository
    && hashJson(feasibility.value.graph) === hashJson(plan.graph) && hashJson(feasibility.value.environment) === hashJson(plan.environment)
    && hashJson(feasibility.value.repository) === hashJson(plan.base), "plan_basis_foreign", "Repository, graph and environment must match the sealed R3 basis");
  const required = [plan.stage, plan.feasibility, plan.graph, plan.environment, ...stage.value.proofs, ...feasibility.value.inputs];
  requireCondition(required.every(ref => plan.guards.some(guard => guard.id === ref.id && guard.revision === ref.revision && guard.hash === ref.hash)),
    "plan_basis_incomplete", "Plan cannot omit evidence from its accepted compilation basis");
}
