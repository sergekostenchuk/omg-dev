import { Ajv } from "ajv";
import { canonical, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import type { Finding } from "../pipeline/contracts.js";
import { graphSchema } from "./schema.js";
import { LEVEL, type Graph, type Endpoint } from "./model.js";
import { safeRelativePath, topologicalOrder } from "./topology.js";

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const shape = ajv.compile<Graph>(graphSchema);
export interface Validation { graph: Graph | null; hash: string | null; findings: Finding[] }

export function validateGraph(input: unknown): Validation {
  if (!shape(input)) return { graph: null, hash: null, findings: (shape.errors ?? []).map(error => ({
    code: "graph_shape", target: error.instancePath, message: `${error.keyword}: ${error.message ?? "invalid"}`,
  })).sort((a, b) => canonical(a).localeCompare(canonical(b))) };
  const graph = structuredClone(input);
  const findings: Finding[] = [];
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
  const allIds = new Set<string>();
  for (const list of [graph.nodes, graph.artifacts, graph.connectors, graph.anchors, graph.tests, graph.joins, graph.contracts]) {
    for (const item of list) { if (allIds.has(item.id)) fail("duplicate_id", item.id, "IDs must be unique across graph objects"); allIds.add(item.id); }
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const artifacts = new Map(graph.artifacts.map(artifact => [artifact.id, artifact]));
  const contracts = new Map(graph.contracts.map(contract => [contract.id, contract]));
  const connectors = new Map(graph.connectors.map(connector => [connector.id, connector]));
  const tests = new Map(graph.tests.map(test => [test.id, test]));
  const anchors = new Map(graph.anchors.map(anchor => [anchor.id, anchor]));
  const roots = graph.nodes.filter(node => node.kind === "product");
  if (roots.length !== 1 || roots[0]?.parent !== null) fail("product_root", graph.id, "Exactly one root product is required");
  const descendant = (child: string, ancestor: string): boolean => {
    const seen = new Set<string>();
    let node = nodes.get(child);
    while (node && !seen.has(node.id)) {
      if (node.id === ancestor) return true;
      seen.add(node.id); node = node.parent === null ? undefined : nodes.get(node.parent);
    }
    return false;
  };
  for (const contract of graph.contracts) {
    try { new Ajv({ strict: true }).compile(contract.schema as object); }
    catch { fail("contract_invalid", contract.id, "Contract must be a valid self-contained JSON Schema"); }
  }
  for (const artifact of graph.artifacts) if (!contracts.has(artifact.contract)) fail("contract_missing", artifact.id, artifact.contract);
  for (const node of graph.nodes) {
    if (!artifacts.has(node.outcome)) fail("outcome_missing", node.id, node.outcome);
    if (node.kind !== "product") {
      const parent = node.parent ? nodes.get(node.parent) : undefined;
      if (!parent || LEVEL[parent.kind] + 1 !== LEVEL[node.kind]) fail("hierarchy_invalid", node.id, "Node must refine the preceding level");
      if (!roots[0] || !descendant(node.id, roots[0].id)) fail("hierarchy_disconnected", node.id, "Node does not belong to the product root");
    }
    if (new Set(node.ports.map(port => port.id)).size !== node.ports.length) fail("port_duplicate", node.id, "Port IDs must be unique per node");
    for (const port of node.ports) if (!contracts.has(port.contract)) fail("contract_missing", node.id, port.contract);
    for (const ref of node.code) if (!safeRelativePath(ref.path)) fail("code_path_invalid", node.id, ref.path);
    for (const ref of node.tests) if (!tests.has(ref) || tests.get(ref)!.node !== node.id) fail("test_missing", node.id, ref);
  }
  for (const test of graph.tests) {
    if (!nodes.has(test.node)) fail("test_owner_missing", test.id, test.node);
    for (const ref of test.covers) if (!connectors.has(ref)) fail("test_connector_missing", test.id, ref);
  }
  for (const anchor of graph.anchors) {
    if (!nodes.has(anchor.owner) || !artifacts.has(anchor.outcome) || nodes.get(anchor.owner)!.outcome !== anchor.outcome) fail("anchor_outcome_missing", anchor.id, "Anchor owner and outcome must resolve and agree");
    if (!tests.has(anchor.test)) fail("wake_test_missing", anchor.id, anchor.test);
  }
  const endpoint = (ref: Endpoint, direction: "in" | "out", contract: string | undefined, target: string, level: number) => {
    const node = nodes.get(ref.node); const port = node?.ports.find(candidate => candidate.id === ref.port);
    if (!node || !port || port.direction !== direction || port.contract !== contract || LEVEL[node.kind] !== level) fail("endpoint_invalid", target, `${ref.node}/${ref.port}`);
  };
  const incoming = new Map<string, Set<string>>();
  const byLevel = new Map<number, [string, string][]>();
  const producerByArtifact = new Map<string, string>();
  for (const connector of graph.connectors) {
    const artifact = artifacts.get(connector.artifact);
    if (!artifact) fail("artifact_missing", connector.id, connector.artifact);
    if (!nodes.has(connector.returnsTo)) fail("return_missing", connector.id, connector.returnsTo);
    for (const binding of connector.bindings) {
      endpoint(binding.producer, "out", artifact?.contract, connector.id, binding.level);
      const producerKey = `${connector.artifact}:${binding.level}`;
      const previous = producerByArtifact.get(producerKey);
      if (previous && previous !== binding.producer.node) fail("multiple_producers", connector.id, "An artifact must have one producer at each level");
      producerByArtifact.set(producerKey, binding.producer.node);
      if (binding.anchor !== null) {
        const anchor = anchors.get(binding.anchor);
        if (!anchor || anchor.outcome !== connector.artifact || !connector.wakeTest || !tests.has(connector.wakeTest)) fail("sleeping_contract_incomplete", connector.id, "Sleeping connector needs an exact anchor, outcome and wake test");
      }
      for (const consumer of binding.consumers) {
        endpoint(consumer, "in", artifact?.contract, connector.id, binding.level);
        if (binding.anchor === null && binding.producer.node !== consumer.node) {
          const edges = byLevel.get(binding.level) ?? []; edges.push([binding.producer.node, consumer.node]); byLevel.set(binding.level, edges);
          const refs = incoming.get(consumer.node) ?? new Set<string>(); refs.add(connector.id); incoming.set(consumer.node, refs);
        }
      }
      if (binding.level > 1 && !connector.bindings.some(upper => upper.level === binding.level - 1
        && descendant(binding.producer.node, upper.producer.node)
        && binding.consumers.every(consumer => upper.consumers.some(parent => descendant(consumer.node, parent.node))))) {
        fail("refinement_gap", connector.id, "Lower-level endpoints must refine the same upper connector");
      }
    }
  }
  for (const artifact of graph.artifacts) if (!artifact.external && !artifact.terminal
    && !graph.connectors.some(connector => connector.artifact === artifact.id)) fail("orphan_artifact", artifact.id, "Intermediate artifact needs a producer and consumer connector");
  for (const [level, edges] of byLevel) {
    try { topologicalOrder(graph.nodes.filter(node => LEVEL[node.kind] === level).map(node => node.id), edges); }
    catch (error) { fail("dependency_cycle", String(level), error instanceof Error ? error.message : "Cycle"); }
  }
  for (const [consumer, inputs] of incoming) if (inputs.size >= 3 && !graph.joins.some(join => join.consumer === consumer)) {
    fail("join_missing", consumer, "Three or more direct inputs require an explicit join");
  }
  const joinConsumers = new Set<string>();
  for (const join of graph.joins) {
    if (joinConsumers.has(join.consumer)) fail("join_duplicate", join.id, "A consumer has more than one join");
    joinConsumers.add(join.consumer);
    const actual = [...(incoming.get(join.consumer) ?? [])].sort();
    if (!nodes.has(join.consumer) || canonical(actual) !== canonical([...join.connectors].sort())) fail("join_inputs_invalid", join.id, "Join must name exactly the consumer's incoming connectors");
  }
  const horizon = new Set(graph.horizon);
  const l3Edges = byLevel.get(3) ?? [];
  const reaches = (from: string, to: string): boolean => {
    const queue = [from]; const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!; if (current === to) return true;
      if (seen.has(current)) continue; seen.add(current);
      for (const [source, target] of l3Edges) if (source === current) queue.push(target);
    }
    return false;
  };
  const writers = new Map<string, string[]>();
  for (const id of horizon) {
    const node = nodes.get(id);
    if (!node || node.kind !== "work") { fail("horizon_invalid", id, "Only L3 work nodes can enter the execution horizon"); continue; }
    if (!node.code.length || !node.tests.length) fail("l3_evidence_missing", id, "Active L3 needs code references and product tests");
    if (node.parent && nodes.has(node.parent) && canonical(node.boundary) !== canonical(nodes.get(node.parent)!.boundary)) fail("boundary_mismatch", id, "Work must preserve its operation's authority, state, writer and rollback boundary");
    if (artifacts.get(node.outcome)?.external) fail("external_outcome", id, "An implementation cannot claim an external input as its own produced outcome");
    for (const ref of node.code.filter(ref => ref.access === "write")) {
      const prior = writers.get(ref.path) ?? [];
      for (const other of prior) if (!reaches(other, id) && !reaches(id, other)) fail("write_ownership_overlap", ref.path, "Shared writes need an ordered connector dependency");
      writers.set(ref.path, [...prior, id]);
    }
    for (const connector of graph.connectors) for (const binding of connector.bindings) if (binding.level === 3 && binding.producer.node === id && binding.anchor === null) {
      if (binding.consumers.some(consumer => !horizon.has(consumer.node))) fail("future_dependency_unanchored", connector.id, "A consumer outside the horizon needs a sleeping contract");
      if (!node.tests.some(testId => tests.get(testId)?.covers.includes(connector.id))) fail("connector_test_missing", connector.id, "Active producer needs a test covering this connector");
    }
  }
  const unique = [...new Map(findings.map(item => [canonical(item), item])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { graph: unique.length ? null : graph, hash: unique.length ? null : hashJson(graph), findings: unique };
}

export function requireGraph(input: unknown): Graph {
  const result = validateGraph(input);
  if (!result.graph) throw new EngineError("graph_invalid", "Operation map failed validation", result.findings);
  return result.graph;
}
