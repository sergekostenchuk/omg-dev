import { LEVEL, type Graph } from "./model.js";

export function projectGraph(graph: Graph, level: 1 | 2 | 3) {
  const nodes = graph.nodes.filter(node => LEVEL[node.kind] <= level);
  const nodeIds = new Set(nodes.map(node => node.id));
  const connectors = graph.connectors.map(connector => ({ ...connector,
    bindings: connector.bindings.filter(binding => binding.level <= level),
    ...(graph.version === 2 ? { wakeTest: graph.tests.some(test => test.id === connector.wakeTest && nodeIds.has(test.node)) ? connector.wakeTest : null } : {}),
  })).filter(connector => connector.bindings.length);
  const artifactIds = new Set([...nodes.map(node => node.outcome), ...connectors.map(connector => connector.artifact)]);
  const artifacts = graph.artifacts.filter(artifact => artifactIds.has(artifact.id));
  const contractIds = new Set([...artifacts.map(artifact => artifact.contract), ...nodes.flatMap(node => node.ports.map(port => port.contract))]);
  return { id: graph.id, title: graph.title, level, nodes, artifacts, connectors,
    contracts: graph.contracts.filter(contract => contractIds.has(contract.id)),
    anchors: graph.anchors.filter(anchor => nodeIds.has(anchor.owner)),
    joins: graph.joins.filter(join => nodeIds.has(join.consumer)),
    tests: graph.tests.filter(test => nodeIds.has(test.node)), horizon: level === 3 ? graph.horizon : [],
    ...(graph.version === 2 ? { version: 2 as const, actors: graph.actors!, requirements: graph.requirements!,
      edges: graph.edges!.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
      journeys: graph.journeys!.filter(journey => journey.path.every(node => nodeIds.has(node))),
      transfers: graph.transfers!.filter(transfer => nodeIds.has(transfer.from) && nodeIds.has(transfer.to)),
      packets: graph.packets!.filter(packet => nodeIds.has(packet.unit)) } : {}),
  };
}
