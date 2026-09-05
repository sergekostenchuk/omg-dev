import type { Graph } from "./model.js";
import { LEVEL } from "./model.js";

export function controlPredecessors(graph: Graph, node: string): { id: string; producer: string }[] {
  if (graph.version !== 2) return [];
  return [...graph.edges!.filter(edge => edge.relation === "requires" && edge.source === node).map(edge => ({ id: edge.id, producer: edge.target })),
    ...graph.transfers!.filter(transfer => transfer.to === node).map(transfer => ({ id: transfer.id, producer: transfer.from }))];
}
export function dependencyEdges(graph: Graph, level: 1 | 2 | 3): [string, string][] {
  const edges: [string, string][] = [];
  for (const connector of graph.connectors) for (const binding of connector.bindings) if (binding.level === level && binding.anchor === null)
    for (const consumer of binding.consumers) if (consumer.node !== binding.producer.node) edges.push([binding.producer.node, consumer.node]);
  for (const node of graph.nodes.filter(node => LEVEL[node.kind] === level)) for (const predecessor of controlPredecessors(graph, node.id)) edges.push([predecessor.producer, node.id]);
  return [...new Map(edges.map(edge => [JSON.stringify(edge), edge])).values()];
}
