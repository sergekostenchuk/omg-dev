import { LEVEL, type Graph } from "./model.js";

export function projectGraph(graph: Graph, level: 1 | 2 | 3) {
  const nodes = graph.nodes.filter(node => LEVEL[node.kind] <= level);
  const nodeIds = new Set(nodes.map(node => node.id));
  const connectors = graph.connectors.map(connector => ({ ...connector,
    bindings: connector.bindings.filter(binding => binding.level <= level),
  })).filter(connector => connector.bindings.length);
  const artifactIds = new Set([...nodes.map(node => node.outcome), ...connectors.map(connector => connector.artifact)]);
  const artifacts = graph.artifacts.filter(artifact => artifactIds.has(artifact.id));
  const contractIds = new Set([...artifacts.map(artifact => artifact.contract), ...nodes.flatMap(node => node.ports.map(port => port.contract))]);
  return { id: graph.id, title: graph.title, level, nodes, artifacts, connectors,
    contracts: graph.contracts.filter(contract => contractIds.has(contract.id)),
    anchors: graph.anchors.filter(anchor => nodeIds.has(anchor.owner)),
    joins: graph.joins.filter(join => nodeIds.has(join.consumer)),
    tests: graph.tests.filter(test => nodeIds.has(test.node)), horizon: level === 3 ? graph.horizon : [],
  };
}
