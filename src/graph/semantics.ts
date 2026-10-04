import type { Graph } from "./model.js";
import { LEVEL } from "./model.js";
import type { Finding } from "../pipeline/contracts.js";
import { safeRelativePath, topologicalOrder } from "./topology.js";
import { dependencyEdges } from "./dependencies.js";
import { hashJson, canonical } from "../canonical.js";

export function semanticFindings(graph: Graph): Finding[] {
  if (graph.version !== 2) return [];
  const findings: Finding[] = [];
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const actors = new Map(graph.actors!.map(actor => [actor.id, actor]));
  const requirements = new Map(graph.requirements!.map(requirement => [requirement.id, requirement]));
  const edges = graph.edges!;
  const ids = new Set<string>();
  for (const item of [...graph.nodes, ...graph.artifacts, ...graph.connectors, ...graph.contracts, ...graph.anchors, ...graph.joins, ...graph.tests,
    ...graph.actors!, ...graph.requirements!, ...edges, ...graph.journeys!, ...graph.transfers!, ...graph.packets!]) {
    if (ids.has(item.id)) fail("semantic_id_duplicate", item.id, "Graph identities must be unique across semantic entities");
    ids.add(item.id);
  }
  for (const node of graph.nodes) {
    if (!actors.has(node.beneficiary!)) fail("node_beneficiary_missing", node.id, "Node must identify the beneficiary of its useful result");
    for (const ref of node.implements!) if (!requirements.has(ref)) fail("node_requirement_missing", node.id, ref);
    for (const requirement of graph.requirements!.filter(item => item.outcome === node.outcome)) {
      if (requirement.beneficiary !== node.beneficiary) fail("node_beneficiary_foreign", node.id, "The node must preserve the recipient of its declared product outcome independently of implements");
      if (node.kind !== "product" && !node.implements!.includes(requirement.id)) fail("node_outcome_requirement_missing", node.id, "A producer must cover the requirements of its declared product outcome");
    }
    if (node.kind !== "product" && !node.implements!.length) fail("node_benefit_unbound", node.id, "A node needs traceability to a product requirement");
  }
  for (const requirement of graph.requirements!) {
    if (!actors.has(requirement.beneficiary) || !graph.artifacts.some(artifact => artifact.id === requirement.outcome)) fail("requirement_binding_missing", requirement.id, "Requirement needs a known beneficiary and outcome");
    if (!graph.nodes.some(node => node.kind === "block" && node.implements!.includes(requirement.id))) fail("concept_requirement_uncovered", requirement.id, "Every requirement must be covered at L1");
  }
  for (const connector of graph.connectors) for (const binding of connector.bindings) if (binding.level === 3) {
    for (const endpoint of [binding.producer, ...binding.consumers]) {
      if (graph.horizon.includes(endpoint.node) && !endpoint.codeRef) fail("endpoint_code_missing", connector.id, "An active L3 endpoint requires an exact code binding");
      if (endpoint.codeRef && !nodes.get(endpoint.node)?.code.some(ref => canonical(ref) === canonical(endpoint.codeRef)))
        fail("endpoint_code_foreign", connector.id, "Endpoint code binding must match a declared code reference of its node");
    }
  }
  for (const edge of edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) fail("control_endpoint_missing", edge.id, "Control edge endpoints must exist");
    else if (edge.relation === "realizes") {
      const source = nodes.get(edge.source)!, target = nodes.get(edge.target)!;
      if (LEVEL[source.kind] !== LEVEL[target.kind] + 1) fail("realization_level_mismatch", edge.id, "Realization must refine the immediately preceding level");
      if (source.kind === "work" && canonical(source.boundary) !== canonical(target.boundary)) fail("realization_boundary_conflict", edge.id, "One atomic unit cannot realize roles with conflicting boundaries");
      if (target.implements!.some(ref => !source.implements!.includes(ref))) fail("realization_requirement_missing", edge.id, "An explicitly realized role's requirements must be present on its implementation unit");
    } else if (LEVEL[nodes.get(edge.source)!.kind] !== LEVEL[nodes.get(edge.target)!.kind]) fail("control_level_mismatch", edge.id, "Control endpoints must be at the same refinement level");
  }
  const dependencies = ([1, 2, 3] as const).flatMap(level => dependencyEdges(graph, level));
  try { topologicalOrder([...nodes.keys()], dependencies); } catch { fail("control_dependency_cycle", graph.id, "The combined artifact and required-work graph has a cycle"); }
  const connected = (from: string, to: string) => from === to || edges.some(edge => edge.source === from && edge.target === to && ["on_success", "on_failure", "returns_to"].includes(edge.relation))
    || graph.connectors.some(connector => connector.bindings.some(binding => binding.anchor === null && binding.producer.node === from && binding.consumers.some(consumer => consumer.node === to)));
  for (const journey of graph.journeys!) {
    if (!actors.has(journey.actor) || journey.path[0] !== journey.entry || !graph.artifacts.some(artifact => artifact.id === journey.outcome)) fail("journey_binding_missing", journey.id, "Journey entry, actor and outcome must resolve");
    if (journey.path.some(id => !nodes.has(id))) fail("journey_node_missing", journey.id, "Journey contains a nonexistent node");
    if (journey.path.some(id => nodes.get(id)?.kind === "product")) fail("journey_abstract_entry", journey.id, "The product container cannot substitute for a real workflow block");
    for (let i = 1; i < journey.path.length; i++) if (!connected(journey.path[i - 1]!, journey.path[i]!)) fail("journey_disconnected", journey.id, "Journey steps must follow real connectors or control transitions");
    if (nodes.get(journey.path.at(-1)!)?.outcome !== journey.outcome) fail("journey_outcome_unobserved", journey.id, "The terminal node must produce the stated journey outcome");
  }
  for (const actor of graph.actors!) if (!graph.journeys!.some(journey => journey.actor === actor.id)) fail("actor_journey_missing", actor.id, "Actor has no product journey");
  for (const artifact of graph.artifacts.filter(item => item.terminal)) if (!graph.journeys!.some(journey => journey.outcome === artifact.id)) fail("terminal_outcome_unobserved", artifact.id, "A terminal artifact needs an observable product journey");
  for (const join of graph.joins) {
    if (!nodes.has(join.failures!.returnsTo)) fail("join_return_missing", join.id, "Join failure route must resolve");
    const outcomes = [join.failures!.missing, join.failures!.extra, join.failures!.foreign, join.failures!.stale, join.failures!.duplicate];
    if (new Set(outcomes).size !== outcomes.length) fail("join_failure_ambiguous", join.id, "Missing, extra, foreign, stale and duplicate inputs need distinct outcomes");
  }
  for (const test of graph.tests) {
    const contract = test.contract!;
    if (!safeRelativePath(contract.entrypoint.path)) fail("test_entrypoint_invalid", test.id, "Product entrypoint path is invalid");
    if (graph.horizon.includes(test.node) && !nodes.get(test.node)?.code.some(ref => ref.path === contract.entrypoint.path
      && ref.status === contract.entrypoint.status && (contract.entrypoint.symbol === null || ref.symbol === contract.entrypoint.symbol)))
      fail("test_entrypoint_unbound", test.id, "An active product test must bind its entrypoint to the unit's declared code scope");
    if (contract.resourceClass === "exclusive" && !contract.resources.length) fail("test_resource_missing", test.id, "An exclusive test must identify its shared resource");
    for (const pair of contract.counterfactuals) if (!graph.connectors.some(connector => connector.id === pair.connector) || !test.covers.includes(pair.connector)) fail("counterfactual_unbound", test.id, "Counterfactual must exercise a connector covered by this test");
    if (graph.horizon.includes(test.node) && test.covers.length && !contract.counterfactuals.length) fail("counterfactual_missing", test.id, "Active connector tests require a negative mutation and expected refusal");
  }
  for (const transfer of graph.transfers!) {
    const from = nodes.get(transfer.from), to = nodes.get(transfer.to);
    if (from?.kind !== "work" || to?.kind !== "work" || from.id === to.id
      || !from.code.some(ref => ref.path === transfer.path && ref.access === "write") || !to.code.some(ref => ref.path === transfer.path && ref.access === "write")) fail("ownership_transfer_invalid", transfer.id, "Transfer must connect two distinct declared writers of the same path");
  }
  const writers = new Map<string, Set<string>>();
  for (const node of graph.nodes.filter(node => node.kind === "work")) for (const code of node.code.filter(ref => ref.access === "write")) {
    const owners = writers.get(code.path) ?? new Set<string>(); owners.add(node.id); writers.set(code.path, owners);
  }
  for (const [path, owners] of writers) if (owners.size > 1) {
    const transfers = graph.transfers!.filter(transfer => transfer.path === path);
    if (transfers.length !== owners.size - 1 || new Set(transfers.map(transfer => transfer.from)).size !== transfers.length
      || new Set(transfers.map(transfer => transfer.to)).size !== transfers.length)
      fail("ownership_transfer_missing", path, "Shared writes need one exclusive ordered chain of producer-commit transfers");
    try { topologicalOrder([...owners], transfers.map(transfer => [transfer.from, transfer.to])); }
    catch { fail("ownership_transfer_cycle", path, "Write ownership transfers contain a cycle"); }
  }
  for (const packet of graph.packets!) {
    const unit = nodes.get(packet.unit);
    if (unit?.kind !== "work" || packet.writePaths.some(path => !unit.code.some(ref => ref.path === path && ref.access === "write"))) fail("work_packet_boundary", packet.id, "An internal packet must stay inside one atomic unit's declared writes");
  }
  return findings;
}

export function continuityFindings(previous: Graph, current: Graph): Finding[] {
  if (previous.version !== 2 || current.version !== 2) return [];
  const findings: Finding[] = [];
  const schema = (graph: Graph, artifact: string) => graph.contracts.find(contract => contract.id === graph.artifacts.find(item => item.id === artifact)?.contract)?.schema ?? null;
  for (const connector of previous.connectors) {
    const next = current.connectors.find(item => item.id === connector.id);
    if (next && (connector.artifact !== next.artifact || hashJson(schema(previous, connector.artifact)) !== hashJson(schema(current, next.artifact))))
      findings.push({ code: "connector_identity_fork", target: connector.id, message: "A changed artifact meaning or contract needs a new connector identity" });
  }
  for (const anchor of previous.anchors) {
    const next = current.anchors.find(item => item.id === anchor.id);
    if (next && (anchor.owner !== next.owner || anchor.outcome !== next.outcome || hashJson(schema(previous, anchor.outcome)) !== hashJson(schema(current, next.outcome))))
      findings.push({ code: "anchor_semantic_drift", target: anchor.id, message: "A stable anchor cannot be reused for a different owner or outcome contract" });
  }
  return findings;
}

/** Codes emitted by this module; kept complete by the brief catalogue regression. */
export const GRAPH_SEMANTIC_CODES = Object.freeze([
  'actor_journey_missing',
  'anchor_semantic_drift',
  'concept_requirement_uncovered',
  'connector_identity_fork',
  'control_dependency_cycle',
  'control_endpoint_missing',
  'control_level_mismatch',
  'counterfactual_missing',
  'counterfactual_unbound',
  'endpoint_code_foreign',
  'endpoint_code_missing',
  'join_failure_ambiguous',
  'join_return_missing',
  'journey_abstract_entry',
  'journey_binding_missing',
  'journey_disconnected',
  'journey_node_missing',
  'journey_outcome_unobserved',
  'node_beneficiary_foreign',
  'node_beneficiary_missing',
  'node_benefit_unbound',
  'node_outcome_requirement_missing',
  'node_requirement_missing',
  'ownership_transfer_cycle',
  'ownership_transfer_invalid',
  'ownership_transfer_missing',
  'realization_boundary_conflict',
  'realization_level_mismatch',
  'realization_requirement_missing',
  'requirement_binding_missing',
  'semantic_id_duplicate',
  'terminal_outcome_unobserved',
  'test_entrypoint_invalid',
  'test_entrypoint_unbound',
  'test_resource_missing',
  'work_packet_boundary',
] as const);
