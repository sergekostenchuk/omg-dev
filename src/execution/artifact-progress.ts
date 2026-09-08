import type { Store, Revision } from "../storage/store.js";
import type { MachinePlan, ArtifactReceipt } from "../compiler/model.js";
import { receiptId } from "../compiler/model.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { canonical } from "../canonical.js";
import { git, type ExecutionRoot, type Environment } from "../runtime/environment.js";
import { resolveArtifact } from "../compiler/inputs.js";
import { requireGates } from "./commit.js";
import { runId, type TaskRun } from "./model.js";

/** Retire a consumed input head only for a successor actually accepted by this plan. */
export function artifactProgress(store: Store, plan: Revision<MachinePlan>, root: ExecutionRoot, original: Ref, current: Revision): Ref[] | null {
  if (plan.value.version !== 2 || current.kind !== "artifact") return null;
  const receipt = current.value as unknown as ArtifactReceipt;
  if (current.id !== receiptId(plan.value.projectId, receipt.artifact)) return null;
  if (!isRef(receipt.plan) || canonical(receipt.plan) !== canonical(reference(plan)) || !isRef(receipt.run)) return null;
  const producer = plan.value.tasks.find(task => task.node === receipt.node && task.produces.includes(receipt.artifact));
  const run = store.get<TaskRun>(receipt.run.id, receipt.run.revision);
  if (!producer || run?.hash !== receipt.run.hash || run.value.state !== "committed" || run.value.taskId !== producer.id) return null;
  const environment = store.get<Environment>(plan.value.environment.id, plan.value.environment.revision);
  if (environment?.hash !== plan.value.environment.hash) return null;
  const consumers = plan.value.tasks.filter(task => task.inputs.some(input => input.receipt && canonical(input.receipt) === canonical(original)));
  if (!consumers.length) return null;
  const guards = [reference(current), receipt.run];
  try {
    requireGates(run.value, producer, environment.value, store);
    resolveArtifact(store, plan.value.projectId, plan.value.graphSnapshot,
      { root: root.path, head: root.head, tree: git(root.path, ["rev-parse", `${root.head}^{tree}`]), files: [] }, receipt.node, receipt.artifact);
    for (const task of consumers) {
      const consumed = store.get<TaskRun>(runId(plan.value.hash, task.id));
      if (consumed?.value.state !== "committed" || canonical(consumed.value.plan) !== canonical(reference(plan))
        || !consumed.value.inputs.some(input => canonical(input) === canonical(original)) || !consumed.value.commit) return null;
      requireGates(consumed.value, task, environment.value, store);
      git(root.path, ["merge-base", "--is-ancestor", consumed.value.commit, root.head]);
      guards.push(reference(consumed));
    }
  } catch { return null; }
  return guards;
}
