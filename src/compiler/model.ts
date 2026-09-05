import type { Graph, Node, Boundary, Obligation } from "../graph/model.js";
import type { Ref } from "../pipeline/contracts.js";
import type { Feasibility } from "../graph/refinement.js";
import { hashJson } from "../canonical.js";
import type { Requirement, WorkPacket } from "../graph/semantics-model.js";
import { nodeContext } from "../graph/node-context.js";

export interface ArtifactReceipt {
  projectId: string; artifact: string; node: string; signature: string; contractHash: string;
  commit: string; tree: string; value: { files: { path: string; hash: string }[] };
}
export interface TaskInput { connector: string; artifact: string; producerTask: string | null; receipt: Ref | null; source: Ref | null }
export interface CompiledTask {
  id: string; node: string; title: string; outcome: string; signature: string;
  boundary: Boundary; writePaths: string[]; readPaths: string[]; tests: Graph['tests'];
  dependencies: string[]; inputs: TaskInput[]; produces: string[];
  obligations: { name: Obligation; status: "required" | "not_applicable"; reason: string }[];
  purpose?: string; benefit?: string; beneficiary?: string; requirements?: Requirement[]; packets?: WorkPacket[];
}
export interface MachinePlan {
  version: 1; projectId: string; graph: Ref; environment: Ref; stage: Ref; feasibility: Ref;
  base: NonNullable<Feasibility['repository']>; guards: Ref[]; tasks: CompiledTask[];
  graphSnapshot: Graph; hash: string;
}
export const receiptId = (project: string, artifact: string): string => `artifact:${hashJson([project, artifact])}`;
export function nodeSignature(graph: Graph, node: Node): string {
  return hashJson({ graphId: graph.id, node, tests: graph.tests.filter(test => node.tests.includes(test.id)),
    inputs: graph.connectors.filter(connector => connector.bindings.some(binding => binding.level === 3 && binding.consumers.some(consumer => consumer.node === node.id))),
    outcome: graph.contracts.find(contract => contract.id === graph.artifacts.find(artifact => artifact.id === node.outcome)?.contract),
    ...(graph.version === 2 ? { context: nodeContext(graph, node) } : {}) });
}
