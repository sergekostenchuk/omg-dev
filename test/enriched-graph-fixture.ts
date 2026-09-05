import type { Graph } from "../src/graph/model.js";
import type { Json } from "../src/canonical.js";
import { preparationValue, preparedField } from "./preparation-fixture.js";

export function enrichedGraph(source: Graph, project: string, initial: Json = preparationValue(project), sections: Json = preparedField(project, "conceptSections")): Graph {
  if (source.version === 2) return structuredClone(source);
  const graph = structuredClone(source); graph.version = 2;
  const preparation = initial as any;
  graph.actors = preparation.actors.map(({ id, role, channels }: any) => ({ id, role, channels }));
  graph.requirements = (sections as any[]).flatMap(section => section.requirements.map(({ id, outcome, beneficiary, statement }: any) => ({ id, section: section.id, outcome, beneficiary, statement })));
  const recipient = graph.requirements[0]!.beneficiary;
  for (const node of graph.nodes) Object.assign(node, { purpose: `Own the ${node.title} part of the transformation`,
    benefit: "Deliver validated local output", beneficiary: recipient, implements: graph.requirements.map(requirement => requirement.id) });
  for (const artifact of graph.artifacts) Object.assign(artifact, { kind: artifact.terminal ? "result" : "intermediate", purpose: `Carry ${artifact.id}`,
    durability: graph.nodes.some(node => node.outcome === artifact.id && node.boundary.state === "durable") ? "durable_source" : "reconstructible", sensitivity: "project_internal" });
  const root = graph.nodes.find(node => node.kind === "product")!;
  const refusal = `${project}-refusal`;
  const refusalNode = `${project}-refusal-block`;
  graph.artifacts.push({ id: refusal, contract: graph.contracts[0]!.id, external: false, terminal: true,
    kind: "error", purpose: "Return a safe refusal without publishing invalid output", durability: "reconstructible", sensitivity: "project_internal" });
  graph.nodes.push({ id: refusalNode, parent: root.id, kind: "block", title: "Reject invalid input", outcome: refusal,
    boundary: { ...root.boundary }, code: [], tests: [], ports: [], purpose: "Handle invalid requests safely", benefit: "Avoid an incorrect result",
    beneficiary: recipient, implements: graph.requirements.map(requirement => requirement.id) });
  graph.edges = [{ id: `${project}-invalid-transition`, relation: "on_failure", source: `${project}-produce-block`, target: refusalNode, condition: "Input validation fails" }];
  graph.journeys = [];
  for (const [variant, coverage] of Object.entries(preparation.journeys) as [string, any][]) if (coverage.applicability === "applicable") {
    for (const [index, scenario] of coverage.scenarios.entries()) {
      const failed = ["invalid_incomplete_input", "safe_failure"].includes(variant);
      graph.journeys.push({ id: `${project}-journey-${variant}-${index}`, actor: scenario.actor, variant, entry: `${project}-produce-block`,
        path: [`${project}-produce-block`, failed ? refusalNode : `${project}-consume-block`], outcome: failed ? refusal : scenario.outcome, terminal: failed ? "safe_failure" : "success" });
    }
  }
  graph.transfers = []; graph.packets = [];
  for (const connector of graph.connectors) for (const binding of connector.bindings) if (binding.level === 3)
    for (const endpoint of [binding.producer, ...binding.consumers]) {
      const code = graph.nodes.find(node => node.id === endpoint.node)?.code[0];
      if (code) endpoint.codeRef = structuredClone(code);
    }
  for (const join of graph.joins) join.failures = { missing: "input_missing", extra: "input_extra", foreign: "input_foreign", stale: "input_stale", duplicate: "input_duplicate", returnsTo: join.consumer };
  for (const test of graph.tests) {
    test.contract = { given: ["Local input supplied by the caller"], when: "Invoke the transformation", then: ["Return validated output"], forbiddenEffects: ["Publish invalid output"],
      entrypoint: { kind: "cli", path: graph.nodes.find(node => node.id === test.node)!.code[0]?.path ?? "README.md", symbol: null, status: "planned" },
      counterfactuals: test.covers.map(connector => ({ connector, mutation: "remove", expectedFailure: "input_missing", command: { executable: "node", args: ["--version"] } })),
      resourceClass: "pure", resources: [] };
  }
  return graph;
}
