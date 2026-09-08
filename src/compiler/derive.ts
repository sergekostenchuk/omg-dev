import type { Graph } from "../graph/model.js";
import { hashJson } from "../canonical.js";
import { requireCondition } from "../errors.js";
import type { Ref } from "../pipeline/contracts.js";
import { topologicalOrder } from "../graph/topology.js";
import { requiredTests } from "../graph/obligations.js";
import { nodeSignature, type CompiledTask, type TaskInput } from "./model.js";
import { controlPredecessors } from "../graph/dependencies.js";
import { writeGrants } from "./ownership.js";
import type { WriterProof } from "../ownership/owners.js";
import type { BoundTaskObligation } from '../graph/task-obligation-model.js';

export function deriveTasks(project: string, graphHash: string, graph: Graph,
  resolveInput: (producer: string, artifact: string) => Pick<TaskInput, "receipt" | "source">,
  rules: { version: 1 | 2; owner: (path: string) => WriterProof | null; researchObligations?: Map<string, BoundTaskObligation[]> } = { version: 1, owner: () => null }) {
    const nodes = graph.nodes.filter(node => graph.horizon.includes(node.id));
    requireCondition(nodes.length > 0, "horizon_empty", "There are no current work nodes to compile");
    const ids = new Map(nodes.map(node => [node.id, `task:${hashJson([project, graphHash, node.id]).slice(0,40)}`]));
    const edges: [string, string][] = [];
    const inputGuards: Ref[] = [];
    const tasks = nodes.map(node => {
      const required = requiredTests(node); const tests = graph.tests.filter(test => node.tests.includes(test.id));
      const covered = new Set(tests.flatMap(test => test.obligations ?? ["outcome"]));
      requireCondition(required.filter(item => item.status === "required").every(item => covered.has(item.name)),
        "test_obligation_missing", `Tests do not cover all obligations of ${node.title}`);
      const inputs: TaskInput[] = [];
      for (const connector of graph.connectors) for (const binding of connector.bindings.filter(binding => binding.level === 3
        && binding.consumers.some(consumer => consumer.node === node.id) && binding.producer.node !== node.id)) {
        const producerTask = ids.get(binding.producer.node) ?? null;
        if (producerTask && binding.anchor === null) {
          edges.push([producerTask, ids.get(node.id)!]);
          inputs.push({ connector: connector.id, artifact: connector.artifact, producerTask, receipt: null, source: null });
        } else {
          const resolved = resolveInput(binding.producer.node, connector.artifact);
          if (resolved.source) inputGuards.push(resolved.source);
          if (resolved.receipt) inputGuards.push(resolved.receipt);
          inputs.push({ connector: connector.id, artifact: connector.artifact, producerTask: null, ...resolved });
        }
      }
      for (const predecessor of controlPredecessors(graph, node.id)) {
        if (rules.version === 2 && graph.transfers?.some(transfer => transfer.id === predecessor.id)) continue;
        const producer = graph.nodes.find(item => item.id === predecessor.producer)!;
        const producerTask = ids.get(producer.id) ?? null;
        if (producerTask) {
          edges.push([producerTask, ids.get(node.id)!]);
          inputs.push({ connector: predecessor.id, artifact: producer.outcome, producerTask, receipt: null, source: null });
        } else {
          const resolved = resolveInput(producer.id, producer.outcome);
          if (resolved.source) inputGuards.push(resolved.source); if (resolved.receipt) inputGuards.push(resolved.receipt);
          inputs.push({ connector: predecessor.id, artifact: producer.outcome, producerTask: null, ...resolved });
        }
      }
      const ownership = rules.version === 2 ? writeGrants(graph, node, ids, rules.owner) : null;
      for (const grant of ownership ?? []) {
        if (grant.receipt) inputGuards.push(grant.receipt);
        if (grant.producerTask) edges.push([grant.producerTask, ids.get(node.id)!]);
      }
      return { id: ids.get(node.id)!, node: node.id, title: node.title, outcome: node.outcome, signature: nodeSignature(graph, node),
        ...(rules.researchObligations ? { researchObligations: rules.researchObligations.get(node.id) ?? [] } : {}),
        boundary: node.boundary, writePaths: [...new Set(node.code.filter(ref => ref.access === "write").map(ref => ref.path))].sort(),
        readPaths: [...new Set(node.code.filter(ref => ref.access === "read").map(ref => ref.path))].sort(), tests, inputs,
        produces: [...new Set([node.outcome, ...graph.connectors.filter(connector => connector.bindings.some(binding => binding.level === 3 && binding.producer.node === node.id)).map(connector => connector.artifact)])].sort(),
        dependencies: [...new Set([...inputs.flatMap(input => input.producerTask ? [input.producerTask] : []),
          ...(ownership ?? []).flatMap(grant => grant.producerTask ? [grant.producerTask] : [])])].sort(), obligations: required,
        ...(ownership ? { ownership } : {}),
        ...(graph.version === 2 ? { purpose: node.purpose!, benefit: node.benefit!, beneficiary: node.beneficiary!,
          requirements: graph.requirements!.filter(requirement => node.implements!.includes(requirement.id)),
          packets: graph.packets!.filter(packet => packet.unit === node.id) } : {}) } satisfies CompiledTask;
    });
    const order = topologicalOrder(tasks.map(task => task.id), edges);
    return { tasks: order.map(id => tasks.find(task => task.id === id)!), guards: inputGuards };
}
