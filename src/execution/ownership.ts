import type { Store, Revision } from "../storage/store.js";
import type { MachinePlan, CompiledTask } from "../compiler/model.js";
import type { ExecutionRoot } from "../runtime/environment.js";
import { Owners } from "../ownership/owners.js";
import { requireCondition } from "../errors.js";
import { canonical } from "../canonical.js";
import { reference, uniqueRefs } from "../pipeline/contracts.js";
import type { TaskRun } from "./model.js";

export function executionOwnership(store: Store, plan: Revision<MachinePlan>, task: CompiledTask, root: ExecutionRoot) {
  if (plan.value.version === 1) return { grants: [], guards: [] };
  requireCondition(task.ownership, "ownership_contract_missing", "The plan must bind every write grant");
  const owners = new Owners(store, plan.value.projectId, { root: root.path, head: root.head });
  const grants = task.ownership.map(grant => {
    const proof = owners.latest(grant.path);
    if (grant.from === null) requireCondition(!proof, "ownership_changed", "A new writer appeared after this grant was compiled");
    else {
      const from = plan.value.graphSnapshot.nodes.find(node => node.id === grant.from);
      requireCondition(proof && from && proof.node === grant.from && canonical(proof.boundary) === canonical(from.boundary),
        "ownership_changed", "The declared predecessor no longer owns this write path");
      if (grant.producerTask) {
        const run = store.get<TaskRun>(proof.ref.id, proof.ref.revision)!;
        requireCondition(run.value.taskId === grant.producerTask && canonical(run.value.plan) === canonical(reference(plan)),
          "ownership_foreign", "A future write grant must come from this exact predecessor task");
      } else requireCondition(canonical(proof.ref) === canonical(grant.receipt), "ownership_changed", "The exact previous write grant changed");
    }
    return { ...grant, proof };
  });
  return { grants, guards: uniqueRefs(grants.flatMap(grant => grant.proof ? [grant.proof.ref] : [])) };
}
