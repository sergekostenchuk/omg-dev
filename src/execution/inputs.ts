import type { Store, Revision } from "../storage/store.js";
import type { MachinePlan, CompiledTask, ArtifactReceipt } from "../compiler/model.js";
import { resolveArtifact } from "../compiler/inputs.js";
import { reference, uniqueRefs } from "../pipeline/contracts.js";
import { canonical } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { git, type ExecutionRoot } from "../runtime/environment.js";
import type { TaskRun } from "./model.js";

export function executionInputs(store: Store, plan: Revision<MachinePlan>, task: CompiledTask, root: ExecutionRoot) {
  const graph = plan.value.graphSnapshot;
  const repository = { root: root.path, head: root.head, tree: git(root.path, ["rev-parse", `${root.head}^{tree}`]), files: [] };
  const inputs = task.inputs.map(input => {
    const producer = input.producerTask ? plan.value.tasks.find(task => task.id === input.producerTask)?.node
      : input.receipt ? store.get<ArtifactReceipt>(input.receipt.id, input.receipt.revision)?.value.node
        : graph.connectors.find(connector => connector.id === input.connector)?.bindings.find(binding => binding.level === 3)?.producer.node;
    requireCondition(producer, "execution_input_missing", "The input's producer is missing from its exact basis");
    const resolved = resolveArtifact(store, plan.value.projectId, graph, repository, producer, input.artifact,
      input.producerTask ? undefined : [input.receipt, input.source].filter(item => item !== null));
    const ref = resolved.receipt ?? resolved.source!;
    const record = store.get(ref.id, ref.revision)!;
    if (input.producerTask) {
      const receipt = record.value as unknown as ArtifactReceipt;
      const run = receipt.run ? store.get<TaskRun>(receipt.run.id, receipt.run.revision) : null;
      requireCondition(run && run.hash === receipt.run?.hash && run.value.taskId === input.producerTask
        && canonical(run.value.plan) === canonical(reference(plan)), "execution_input_foreign", "The predecessor result must belong to this exact plan task");
    }
    return { connector: input.connector, artifact: input.artifact, ref, kind: record.kind, value: record.value };
  });
  return { inputs, guards: uniqueRefs(inputs.map(input => input.ref)) };
}
