import type { Graph, Node } from "./model.js";
import { RefinementRelations } from "./relations.js";

export function nodeContext(graph: Graph, node: Node) {
  const ancestry = new RefinementRelations(graph).ancestry(node.id).filter(role => role.kind !== "product");
  const seen = new Set(ancestry.map(role => role.id));
  const produced = new Set([node.outcome, ...graph.connectors.filter(connector => connector.bindings.some(binding => binding.level === 3 && binding.producer.node === node.id)).map(connector => connector.artifact)]);
  const requirements = new Set(ancestry.flatMap(role => role.implements ?? []));
  return { ancestry, requirements: graph.requirements!.filter(requirement => requirements.has(requirement.id)),
    controls: graph.edges!.filter(edge => seen.has(edge.source)),
    transfers: graph.transfers!.filter(transfer => transfer.to === node.id),
    outputs: graph.artifacts.filter(artifact => produced.has(artifact.id)).map(artifact => ({ artifact,
      schema: graph.contracts.find(contract => contract.id === artifact.contract)!.schema })) };
}
