import { Ajv } from "ajv";
import { canonical, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import type { Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store } from "../storage/store.js";
import { readAcceptedFrame, type AcceptedFrameRequest } from "./frame-accept.js";
import { readCandidate } from "./frame-candidate.js";
import { readFrame, type FrameFill, type FrameObligation, type FrameRead } from "./frame-obligations.js";
import type { ProposalReplacement } from "./frame-proposals.js";
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from "./refusal.js";

export const RESULT_SLICE_REFUSAL_CODES = Object.freeze([
  "result_slice_invalid", "result_slice_level_unsupported", "result_slice_unfilled",
  "result_dependency_missing", "result_dependency_ambiguous",
] as const);
export const RESULT_IDENTITY_REFUSAL_CODES = Object.freeze([
  "result_identity_invalid", "result_identity_unfilled", "result_identity_ambiguous",
] as const);

const parts = ["nodes", "contracts", "artifacts", "connectors", "anchors", "joins", "tests",
  "actors", "requirements", "edges", "journeys", "transfers", "packets"] as const;
type Part = typeof parts[number];
export type ResultDependencyGraph = Pick<Graph, "version" | Part>;
export interface ResultDependencySlice {
  version: 1;
  level: 2;
  obligation: FrameObligation;
  fills: FrameFill[];
  graph: ResultDependencyGraph;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((left, right) => {
  const a = canonical(left), b = canonical(right); return a < b ? -1 : a > b ? 1 : 0;
});
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
const graphShapes = [ajv.compile(sealed(graphSchema)), ajv.compile(sealed(graphV2Schema))];
class SliceFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function reject(code: typeof RESULT_SLICE_REFUSAL_CODES[number] | typeof RESULT_IDENTITY_REFUSAL_CODES[number], target: string, field: string, message: string): never {
  const result = refused(code, message, { unit: "F5.2", target, field }, "producer");
  if (!result.ok) throw new SliceFailure(result.refusal);
  throw new EngineError("result_slice_internal", "Refusal unexpectedly produced a value");
}
function invalid(field: string): never {
  return reject("result_slice_invalid", "result-slice", field,
    "Result dependencies need explicit, well-formed graph, obligation and complete fills");
}

function requireInputs(graph: unknown, obligation: unknown, fills: unknown): asserts graph is Graph {
  if (!object(graph) || !graphShapes[graph["version"] === 2 ? 1 : 0]!(graph)) invalid("graph");
  if (!object(obligation) || !text(obligation["id"]) || !object(obligation["upper"])
    || !text(obligation["upper"]["node"]) || !keys(obligation["upper"], ["node", "port"])
    || !text(obligation["artifact"]) || !["horizon", "outside"].includes(obligation["zone"] as string)
    || !keys(obligation, ["id", "level", "kind", "upper", "artifact", "zone", "connector", "role", "flow"])) invalid("obligation");
  if (obligation["level"] !== 2) reject("result_slice_level_unsupported", obligation["id"], "level", "Result dependency extraction is defined for N=2");
  if (obligation["kind"] === "connection-end") {
    if (!text(obligation["upper"]["port"]) || !text(obligation["connector"]) || !text(obligation["flow"])
      || !["producer", "consumer"].includes(obligation["role"] as string)) invalid("obligation.connection");
  } else if (obligation["kind"] !== "block-outcome" || ["connector", "role", "flow"].some(key => Object.hasOwn(obligation, key))
    || Object.hasOwn(obligation["upper"], "port")) invalid("obligation.outcome");
  if (!Array.isArray(fills) || !fills.every(fill => object(fill) && text(fill["obligation"]) && text(fill["node"])
    && (!Object.hasOwn(fill, "port") || text(fill["port"])) && ["accepted", "identity"].includes(fill["source"] as string)
    && isRef(fill["basis"]) && keys(fill, ["obligation", "node", "port", "source", "basis"]))) invalid("fills");
  if (!fills.length || fills.some(fill => fill.obligation !== obligation["id"] || fill.source !== "accepted"))
    reject("result_slice_unfilled", obligation["id"], "fills", "Only the complete real fills of this obligation supply result dependencies");
  if (fills.some(fill => obligation["kind"] === "connection-end" ? !text(fill.port) : Object.hasOwn(fill, "port"))) invalid("fills.port");
}

// Only explicitly unordered collections are sorted. Schema arrays, command arguments,
// journey paths and the assertion sequences inside ProductTestContract retain their order.
function normalize(graph: ResultDependencyGraph): ResultDependencyGraph {
  return {
    ...graph,
    nodes: sorted(graph.nodes.map(node => ({ ...node, ports: sorted(node.ports), code: sorted(node.code), tests: sorted(node.tests),
      ...(node.implements === undefined ? {} : { implements: sorted(node.implements) }) }))),
    contracts: sorted(graph.contracts), artifacts: sorted(graph.artifacts),
    connectors: sorted(graph.connectors.map(connector => ({ ...connector,
      bindings: sorted(connector.bindings.map(binding => ({ ...binding, consumers: sorted(binding.consumers) }))) }))),
    anchors: sorted(graph.anchors),
    joins: sorted(graph.joins.map(join => ({ ...join, connectors: sorted(join.connectors),
      ...(join.required === undefined ? {} : { required: sorted(join.required) }),
      ...(join.optional === undefined ? {} : { optional: sorted(join.optional) }) }))),
    tests: sorted(graph.tests.map(test => ({ ...test, covers: sorted(test.covers),
      ...(test.obligations === undefined ? {} : { obligations: sorted(test.obligations) }),
      ...(test.contract === undefined ? {} : { contract: { ...test.contract,
        counterfactuals: sorted(test.contract.counterfactuals), resources: sorted(test.contract.resources) } }) }))),
    ...(graph.actors === undefined ? {} : { actors: sorted(graph.actors.map(actor => ({ ...actor, channels: sorted(actor.channels) }))) }),
    ...(graph.requirements === undefined ? {} : { requirements: sorted(graph.requirements) }),
    ...(graph.edges === undefined ? {} : { edges: sorted(graph.edges) }),
    ...(graph.journeys === undefined ? {} : { journeys: sorted(graph.journeys) }),
    ...(graph.transfers === undefined ? {} : { transfers: sorted(graph.transfers) }),
    ...(graph.packets === undefined ? {} : { packets: sorted(graph.packets) }),
  };
}

function dependencies(graph: Graph, obligation: FrameObligation, fills: readonly FrameFill[], descriptions = true): ResultDependencyGraph {
  type Definition = { id: string };
  const indexes = new Map<Part, Map<string, Definition[]>>(), selected = new Map<Part, Map<string, Definition>>();
  for (const part of parts) {
    const index = new Map<string, Definition[]>();
    for (const row of graph[part] ?? []) index.set(row.id, [...(index.get(row.id) ?? []), row]);
    indexes.set(part, index); selected.set(part, new Map());
  }
  const pending: { part: Part; value: Definition }[] = [];
  const add = (part: Part, id: string, target: string, field: string): Definition => {
    const values = indexes.get(part)!.get(id);
    if (!values?.length) reject("result_dependency_missing", target, field, `The ${part} dependency ${id} is absent`);
    if (values.length !== 1) reject("result_dependency_ambiguous", target, field, `The ${part} dependency ${id} is ambiguous`);
    const value = values[0]!;
    if (!selected.get(part)!.has(id)) { selected.get(part)!.set(id, value); pending.push({ part, value }); }
    return value;
  };
  const endpoint = (nodeId: string, portId: string, target: string, field: string) => {
    const node = add("nodes", nodeId, target, `${field}.node`) as Graph["nodes"][number];
    const ports = node.ports.filter(port => port.id === portId);
    if (!ports.length) reject("result_dependency_missing", target, `${field}.port`, `Node ${nodeId} has no port ${portId}`);
    if (ports.length !== 1) reject("result_dependency_ambiguous", target, `${field}.port`, `Port ${nodeId}/${portId} is ambiguous`);
  };
  const seeds = new Set([obligation.upper.node, ...fills.map(fill => fill.node)]);
  add("nodes", obligation.upper.node, obligation.id, "upper.node");
  if (obligation.upper.port !== undefined) endpoint(obligation.upper.node, obligation.upper.port, obligation.id, "upper");
  add("artifacts", obligation.artifact, obligation.id, "artifact");
  if (obligation.connector !== undefined) add("connectors", obligation.connector, obligation.id, "connector");
  for (const fill of fills) {
    const node = add("nodes", fill.node, obligation.id, "fills.node") as Graph["nodes"][number];
    if (node.kind !== "operation") invalid("fills.node");
    if (fill.port !== undefined) endpoint(fill.node, fill.port, obligation.id, "fills");
  }
  // Reverse associations are rooted in this fill and its upper obligation, not every
  // ancestor reached later. A shared product parent does not drag in sibling results.
  for (const connector of graph.connectors) if (connector.bindings.some(binding =>
    seeds.has(binding.producer.node) || binding.consumers.some(consumer => seeds.has(consumer.node))))
    add("connectors", connector.id, obligation.id, "connections");
  for (const anchor of graph.anchors) if (seeds.has(anchor.owner)) add("anchors", anchor.id, obligation.id, "anchors");
  for (const join of graph.joins) if (seeds.has(join.consumer)) add("joins", join.id, obligation.id, "joins");
  for (const test of graph.tests) if (seeds.has(test.node)) add("tests", test.id, obligation.id, "tests");
  for (const edge of graph.edges ?? []) if (seeds.has(edge.source) || seeds.has(edge.target)) add("edges", edge.id, obligation.id, "edges");
  for (const journey of graph.journeys ?? []) if (seeds.has(journey.entry) || journey.path.some(node => seeds.has(node)))
    add("journeys", journey.id, obligation.id, "journeys");
  for (const transfer of graph.transfers ?? []) if (seeds.has(transfer.from) || seeds.has(transfer.to))
    add("transfers", transfer.id, obligation.id, "transfers");
  for (const packet of graph.packets ?? []) if (seeds.has(packet.unit)) add("packets", packet.id, obligation.id, "packets");

  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { part, value } = pending[cursor]!;
    const ref = (dependency: Part, id: string, field: string) => add(dependency, id, value.id, field);
    switch (part) {
      case "nodes": {
        const node = value as Graph["nodes"][number];
        if (node.parent !== null) ref("nodes", node.parent, "parent");
        ref("artifacts", node.outcome, "outcome");
        for (const port of node.ports) ref("contracts", port.contract, "ports.contract");
        for (const test of node.tests) ref("tests", test, "tests");
        for (const requirement of node.implements ?? []) ref("requirements", requirement, "implements");
        if (descriptions && node.beneficiary !== undefined) ref("actors", node.beneficiary, "beneficiary");
        break;
      }
      case "artifacts": ref("contracts", (value as Graph["artifacts"][number]).contract, "contract"); break;
      case "connectors": {
        const connector = value as Graph["connectors"][number];
        ref("artifacts", connector.artifact, "artifact"); ref("nodes", connector.returnsTo, "returnsTo");
        if (connector.wakeTest !== null) ref("tests", connector.wakeTest, "wakeTest");
        for (const join of graph.joins) if (join.connectors.includes(connector.id)) ref("joins", join.id, "joins");
        for (const binding of connector.bindings) {
          endpoint(binding.producer.node, binding.producer.port, connector.id, "bindings.producer");
          for (const consumer of binding.consumers) endpoint(consumer.node, consumer.port, connector.id, "bindings.consumers");
          if (binding.anchor !== null) ref("anchors", binding.anchor, "bindings.anchor");
        }
        break;
      }
      case "anchors": {
        const anchor = value as Graph["anchors"][number];
        ref("nodes", anchor.owner, "owner"); ref("artifacts", anchor.outcome, "outcome"); ref("tests", anchor.test, "test"); break;
      }
      case "joins": {
        const join = value as Graph["joins"][number]; ref("nodes", join.consumer, "consumer");
        for (const field of ["connectors", "required", "optional"] as const)
          for (const connector of join[field] ?? []) ref("connectors", connector, field);
        if (join.failures !== undefined) ref("nodes", join.failures.returnsTo, "failures.returnsTo");
        break;
      }
      case "tests": {
        const test = value as Graph["tests"][number]; ref("nodes", test.node, "node");
        for (const connector of test.covers) ref("connectors", connector, "covers");
        for (const counterfactual of test.contract?.counterfactuals ?? []) ref("connectors", counterfactual.connector, "contract.counterfactuals");
        break;
      }
      case "requirements": {
        const requirement = value as NonNullable<Graph["requirements"]>[number];
        ref("artifacts", requirement.outcome, "outcome"); ref("actors", requirement.beneficiary, "beneficiary"); break;
      }
      case "edges": {
        const edge = value as NonNullable<Graph["edges"]>[number]; ref("nodes", edge.source, "source"); ref("nodes", edge.target, "target"); break;
      }
      case "journeys": {
        const journey = value as NonNullable<Graph["journeys"]>[number];
        ref("actors", journey.actor, "actor"); ref("artifacts", journey.outcome, "outcome"); ref("nodes", journey.entry, "entry");
        for (const node of journey.path) ref("nodes", node, "path");
        break;
      }
      case "transfers": {
        const transfer = value as NonNullable<Graph["transfers"]>[number]; ref("nodes", transfer.from, "from"); ref("nodes", transfer.to, "to"); break;
      }
      case "packets": ref("nodes", (value as NonNullable<Graph["packets"]>[number]).unit, "unit"); break;
      // These have no graph references: schema, channels, code paths and prose are opaque values.
      case "contracts": case "actors": break;
    }
  }
  return normalize(Object.fromEntries([["version", graph.version], ...parts.filter(part => graph[part] !== undefined)
    .map(part => [part, [...selected.get(part)!.values()]])]) as ResultDependencyGraph);
}

/** Dependency material only, not acceptance or a result key. The caller supplies the
 * complete C2-verified fills for one accepted N=2 obligation. IDs, provenance, optional
 * field presence and all selected definitions are retained; no text field is excluded.
 * This deliberately neither projects the input graph nor interprets replacement prose. */
export function extractResultSlice(graph: Graph, obligation: FrameObligation, fills: readonly FrameFill[]): OmResult<Sealed<ResultDependencySlice>> {
  try {
    const input = sealed({ graph, obligation, fills });
    requireInputs(input.graph, input.obligation, input.fills);
    const source = input as unknown as { graph: Graph; obligation: FrameObligation; fills: FrameFill[] };
    return delivered<ResultDependencySlice>({ version: 1, level: 2, obligation: source.obligation, fills: sorted(source.fills),
      graph: dependencies(source.graph, source.obligation, source.fills) });
  } catch (error) {
    if (error instanceof SliceFailure) return { ok: false, refusal: error.refusal };
    if (error instanceof EngineError && error.code === "unsealable_value")
      return refused("result_slice_invalid", "Result dependencies need finite acyclic JSON inputs",
        { unit: "F5.2", target: "result-slice", field: "inputs" }, "producer");
    throw error;
  }
}

type StructuralNode = Omit<Graph["nodes"][number], "title" | "purpose" | "benefit" | "beneficiary">;
export interface ResultContent {
  obligation: Omit<FrameObligation, "id" | "zone">;
  fills: Pick<FrameFill, "node" | "port">[];
  graph: Omit<ResultDependencyGraph, "nodes"> & { nodes: StructuralNode[] };
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new SliceFailure(result.refusal); return result.value; }
function contentOf(graph: Graph, obligation: FrameObligation, fills: readonly FrameFill[]): ResultContent {
  const slice = dependencies(graph, obligation, fills, false);
  const { id: _id, zone: _zone, ...upper } = obligation;
  return { obligation: upper, fills: sorted(fills.map(fill => ({ node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }) }))),
    graph: { ...slice, nodes: sorted(slice.nodes.map(node => {
      const { title: _title, purpose: _purpose, benefit: _benefit, beneficiary: _beneficiary, ...structure } = node;
      return structure;
    })) } };
}
/** Pure comparison material under the owner's #371 policy. It proves no acceptance
 * and returns no key; readResultIdentity is the authority for accepted result keys. */
export function normalizeResultContent(graph: Graph, obligation: FrameObligation, fills: readonly FrameFill[]): OmResult<Sealed<ResultContent>> {
  try {
    const input = sealed({ graph, obligation, fills });
    requireInputs(input.graph, input.obligation, input.fills);
    return delivered(contentOf(input.graph, input.obligation as FrameObligation, input.fills as FrameFill[]));
  } catch (error) {
    if (error instanceof SliceFailure) return { ok: false, refusal: error.refusal };
    if (error instanceof EngineError && error.code === "unsealable_value")
      return refused("result_slice_invalid", "Result dependencies need finite acyclic JSON inputs",
        { unit: "F5.2", target: "result-slice", field: "inputs" }, "producer");
    throw error;
  }
}

export interface ResultIdentityRequest { acceptance: AcceptedFrameRequest; obligation: string }
export interface ResultIdentity {
  key: string;
  obligation: FrameObligation;
  fills: FrameFill[];
  references: Ref[];
}
interface IdentityStep { frame: FrameRead; replacements: ProposalReplacement[]; before: FrameRead | null }
interface Address { node: string; port: string }
interface Renames { nodes: Map<string, string[]>; ports: Map<string, Address[]> }
const portKey = (node: string, port: string): string => canonical([node, port]);
const uniqueRefs = (values: readonly Ref[]) => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
function ambiguous(target: string, field: string): never {
  return reject("result_identity_ambiguous", target, field, "Accepted replacements do not determine one injective typed identity");
}
function distinct<T>(values: readonly T[]): T[] { return [...new Map(values.map(value => [canonical(value), value])).values()]; }
function destination<T>(map: Map<string, T[]>, key: string, fallback: T, field: string): T {
  const values = map.get(key);
  if (!values) return fallback;
  if (values.length !== 1) ambiguous(key, field);
  return values[0]!;
}
function nodeName(map: Renames, node: string): string { return destination(map.nodes, node, node, "node"); }
function portName(map: Renames, node: string, port: string): Address {
  const address = destination(map.ports, portKey(node, port), { node: nodeName(map, node), port }, "port");
  if (address.node !== nodeName(map, node)) ambiguous(node, "port.node");
  return address;
}
function addName<T>(map: Map<string, T[]>, key: string, value: T): void { map.set(key, distinct([...(map.get(key) ?? []), value])); }
interface StateObject { state: number; node: string; port: string | null }
const objectKey = (node: string, port: string | null) => canonical([node, port]);

// Addresses belong to a particular accepted state. Even a swap's identical
// spellings on opposite sides of a transition denote different vertices.
class ObjectHistory {
  private readonly vertices: StateObject[] = [];
  private readonly parents: number[] = [];
  private readonly members: Map<number, number>[] = [];
  private readonly states: Map<string, number>[] = [];

  constructor(steps: IdentityStep[], transitions: Renames[]) {
    for (const [state, step] of steps.entries()) {
      const index = new Map<string, number>(); this.states.push(index);
      const graph = step.frame.accepted?.graph ?? step.frame.upper;
      for (const node of graph.nodes) for (const port of [null, ...node.ports.map(value => value.id)]) {
        const vertex = this.vertices.length;
        this.vertices.push({ state, node: node.id, port }); this.parents.push(vertex);
        this.members.push(new Map([[state, vertex]])); index.set(objectKey(node.id, port), vertex);
      }
      if (state === 0) continue;
      const transition = transitions[state]!, previous = this.states[state - 1]!;
      const arrivals = new Map<string, number[]>();
      for (const vertex of previous.values()) {
        const value = this.vertices[vertex]!;
        const next = value.port === null ? { node: nodeName(transition, value.node), port: null }
          : portName(transition, value.node, value.port);
        const key = objectKey(next.node, next.port);
        arrivals.set(key, [...(arrivals.get(key) ?? []), vertex]);
      }
      for (const [key, vertex] of index) {
        const from = arrivals.get(key);
        // Only unchanged addresses carry identity without a rename proof. An
        // incoming renamed object must not inherit the old occupant's identity.
        if (from?.length === 1 && previous.get(key) === from[0]) this.unite(from[0]!, vertex);
      }
    }
  }

  private root(vertex: number): number {
    const parent = this.parents[vertex]!;
    if (parent !== vertex) this.parents[vertex] = this.root(parent);
    return this.parents[vertex]!;
  }
  private at(state: number, node: string, port: string | null): number {
    const vertex = this.states[state]!.get(objectKey(node, port));
    if (vertex === undefined) ambiguous(node, port === null ? "history.node" : "history.port");
    return vertex;
  }
  private unite(left: number, right: number): void {
    let a = this.root(left), b = this.root(right); if (a === b) return;
    // A class cannot contain two different objects that coexist in one state.
    // This checks actual split/merge, not collisions between chosen spellings.
    for (const [state, vertex] of this.members[a]!) {
      const other = this.members[b]!.get(state);
      if (other !== undefined && other !== vertex) ambiguous(this.vertices[vertex]!.node, "history.objects");
    }
    if (this.vertices[a]!.state > this.vertices[b]!.state) [a, b] = [b, a];
    this.parents[b] = a;
    for (const [state, vertex] of this.members[b]!) this.members[a]!.set(state, vertex);
    this.members[b]!.clear();
  }
  prove(from: number, to: number, content: ResultContent, transitions: Renames[]): void {
    for (const node of content.graph.nodes) {
      let current = node.id;
      for (let step = from + 1; step <= to; step++) current = nodeName(transitions[step]!, current);
      this.unite(this.at(from, node.id, null), this.at(to, current, null));
      for (const port of node.ports) {
        let endpoint = { node: node.id, port: port.id };
        for (let step = from + 1; step <= to; step++) endpoint = portName(transitions[step]!, endpoint.node, endpoint.port);
        this.unite(this.at(from, node.id, port.id), this.at(to, endpoint.node, endpoint.port));
      }
    }
  }
  names(state: number, content: ResultContent): Renames {
    const mapping: Renames = { nodes: new Map(), ports: new Map() };
    const labels = (vertices: number[], field: "node" | "port"): Map<number, string> => {
      const roots = vertices.map(vertex => this.root(vertex));
      if (new Set(roots).size !== roots.length) ambiguous("result", field);
      roots.sort((a, b) => {
        const left = this.vertices[a]!, right = this.vertices[b]!;
        const order = left.state - right.state;
        const x = objectKey(left.node, left.port), y = objectKey(right.node, right.port);
        return order || (x < y ? -1 : x > y ? 1 : 0);
      });
      const counts = new Map<string, number>(), result = new Map<number, string>();
      for (const root of roots) {
        const name = this.vertices[root]![field]!;
        const count = counts.get(name) ?? 0; counts.set(name, count + 1);
        // Reusing a former spelling does not merge objects. The discriminator
        // counts coexisting identities, never revisions or technical events;
        // '~' cannot occur in a graph identifier.
        result.set(root, count === 0 ? name : `~${canonical([name, count])}`);
      }
      return result;
    };
    const nodes = labels(content.graph.nodes.map(node => this.at(state, node.id, null)), "node");
    for (const node of content.graph.nodes) {
      const name = nodes.get(this.root(this.at(state, node.id, null)))!;
      mapping.nodes.set(node.id, [name]);
      const ports = labels(node.ports.map(port => this.at(state, node.id, port.id)), "port");
      for (const port of node.ports) mapping.ports.set(portKey(node.id, port.id), [{ node: name,
        port: ports.get(this.root(this.at(state, node.id, port.id)))! }]);
    }
    return mapping;
  }
}
function replacementsOf(step: IdentityStep, relevant: Set<string>): Renames {
  const mapping: Renames = { nodes: new Map(), ports: new Map() };
  if (!step.before) return mapping;
  for (const replacement of step.replacements) {
    if (!relevant.has(replacement.base.node) && !relevant.has(replacement.with.node)) continue;
    const old = step.before.result.fills.filter(fill => fill.source === "accepted" && fill.obligation === replacement.obligation
      && fill.node === replacement.base.node);
    // C3 allows multiple consumers of one obligation; base.node alone must still
    // determine exactly one old endpoint before an identity can be inferred.
    if (old.length !== 1) ambiguous(replacement.obligation, "replaces.base");
    const current = step.frame.result.fills.filter(fill => fill.source === "accepted" && fill.obligation === replacement.obligation
      && fill.node === replacement.with.node && (fill.port ?? null) === replacement.with.port);
    if (current.length !== 1) ambiguous(replacement.obligation, "replaces.with");
    addName(mapping.nodes, old[0]!.node, replacement.with.node);
    if (old[0]!.port !== undefined) {
      if (replacement.with.port === null) ambiguous(replacement.obligation, "replaces.port");
      addName(mapping.ports, portKey(old[0]!.node, old[0]!.port), { node: replacement.with.node, port: replacement.with.port });
    } else if (replacement.with.port !== null) ambiguous(replacement.obligation, "replaces.port");
  }
  const requireInjective = <T>(map: Map<string, T[]>, field: string) => {
    const destinations = new Set<string>();
    for (const [source, values] of map) {
      if (values.length !== 1 || destinations.has(canonical(values[0]))) ambiguous(source, field);
      destinations.add(canonical(values[0]));
    }
  };
  requireInjective(mapping.nodes, "replaces.nodes");
  requireInjective(mapping.ports, "replaces.ports");
  return mapping;
}
function renamed(content: ResultContent, map: Renames): ResultContent {
  const node = (id: string) => nodeName(map, id);
  const endpoint = <T extends Address>(value: T): T => ({ ...value, ...portName(map, value.node, value.port) });
  const graph = content.graph;
  const nodes = graph.nodes.map(value => ({ ...value, id: node(value.id), parent: value.parent === null ? null : node(value.parent),
    ports: value.ports.map(port => ({ ...port, id: portName(map, value.id, port.id).port })) }));
  if (new Set(nodes.map(value => value.id)).size !== nodes.length) ambiguous("result", "nodes");
  for (const value of nodes) if (new Set(value.ports.map(port => port.id)).size !== value.ports.length) ambiguous(value.id, "ports");
  const rewritten = { ...graph, nodes,
    connectors: graph.connectors.map(value => ({ ...value, returnsTo: node(value.returnsTo), bindings: value.bindings.map(binding => ({ ...binding,
      producer: endpoint(binding.producer), consumers: binding.consumers.map(endpoint) })) })),
    anchors: graph.anchors.map(value => ({ ...value, owner: node(value.owner) })),
    joins: graph.joins.map(value => ({ ...value, consumer: node(value.consumer),
      ...(value.failures === undefined ? {} : { failures: { ...value.failures, returnsTo: node(value.failures.returnsTo) } }) })),
    tests: graph.tests.map(value => ({ ...value, node: node(value.node) })),
    ...(graph.edges === undefined ? {} : { edges: graph.edges.map(value => ({ ...value, source: node(value.source), target: node(value.target) })) }),
    ...(graph.journeys === undefined ? {} : { journeys: graph.journeys.map(value => ({ ...value, entry: node(value.entry), path: value.path.map(node) })) }),
    ...(graph.transfers === undefined ? {} : { transfers: graph.transfers.map(value => ({ ...value, from: node(value.from), to: node(value.to) })) }),
    ...(graph.packets === undefined ? {} : { packets: graph.packets.map(value => ({ ...value, unit: node(value.unit) })) }),
  };
  // The upper obligation is immutable in the accepted N=2 transition. Lower
  // mappings must never silently rewrite its upper address, connector or flow.
  return { obligation: content.obligation,
    fills: sorted(content.fills.map(fill => fill.port === undefined ? { node: node(fill.node) } : endpoint(fill as Address))),
    graph: normalize(rewritten as ResultDependencyGraph) as ResultContent["graph"] };
}
function snapshot(frame: FrameRead, obligationId: string): { obligation: FrameObligation; fills: FrameFill[]; content: ResultContent } | null {
  const obligation = frame.result.obligations.find(value => value.id === obligationId);
  const fills = frame.result.fills.filter(fill => fill.obligation === obligationId);
  if (!frame.accepted || !obligation || frame.result.open.some(value => value.id === obligationId)
    || !fills.length || fills.some(fill => fill.source !== "accepted")) return null;
  return { obligation, fills, content: take(normalizeResultContent(frame.accepted.graph, obligation, fills)) as ResultContent };
}
function identityInputs(store: unknown, request: unknown): asserts request is ResultIdentityRequest {
  if (!(store instanceof Store) || !object(request) || !text(request["obligation"]) || !keys(request, ["acceptance", "obligation"]))
    reject("result_identity_invalid", "result", "request", "Identity reads require a store and one exact accepted obligation");
  const acceptance = request["acceptance"];
  if (!object(acceptance) || !text(acceptance["project"]) || acceptance["level"] !== 2
    || !["graph", "layer", "frame"].every(field => isRef(acceptance[field]))
    || !keys(acceptance, ["project", "level", "graph", "layer", "frame"]))
    reject("result_identity_invalid", "result", "acceptance", "Identity reads require an exact N=2 acceptance request");
}
function identityHistory(store: Store, request: ResultIdentityRequest): { steps: IdentityStep[]; references: Ref[] } {
  const reverse: IdentityStep[] = [], references: Ref[] = [], seen = new Set<string>();
  let acceptance = request.acceptance;
  for (;;) {
    const key = canonical(acceptance);
    if (seen.has(key)) ambiguous(acceptance.frame.id, "history");
    seen.add(key);
    const accepted = take(readAcceptedFrame(store, acceptance));
    if (!accepted.graph || !accepted.layer || !accepted.frame)
      reject("result_identity_unfilled", acceptance.frame.id, "acceptance", "The event must retain its accepted graph, layer and frame");
    const candidate = take(readCandidate(store, { project: acceptance.project, candidate: accepted.frame.value.acceptance.candidate }));
    const previous = candidate.value.request.frame;
    const before = take(readFrame(store, previous as FrameRead["request"])) as FrameRead;
    const frame = take(readFrame(store, { ...previous, graph: acceptance.graph, layer: acceptance.layer, frame: acceptance.frame } as FrameRead["request"])) as FrameRead;
    references.push(...frame.references, ...before.references, reference(candidate), ...accepted.proposals.map(reference),
      ...candidate.value.proposals, acceptance.graph, acceptance.layer, acceptance.frame);
    reverse.push({ frame, before, replacements: accepted.proposals.flatMap(value => value.value.replaces) as ProposalReplacement[] });
    if (previous.frame === null) {
      reverse.push({ frame: before, before: null, replacements: [] }); break;
    }
    if (previous.layer === null) reject("result_identity_unfilled", previous.graph.id, "layer", "An accepted predecessor needs its layer");
    acceptance = { project: previous.project, level: previous.level, graph: previous.graph, layer: previous.layer, frame: previous.frame };
  }
  return { steps: reverse.reverse(), references: uniqueRefs(references) };
}
/** Shared supplier-independent identity, derived only from exact C5/C2 history. */
export function readResultIdentity(store: Store, request: ResultIdentityRequest): OmResult<Sealed<ResultIdentity>> {
  try {
    identityInputs(store, request);
    request = sealed(request) as ResultIdentityRequest;
    const history = identityHistory(store, request), snapshots = history.steps.map(step => snapshot(step.frame, request.obligation));
    const current = snapshots.at(-1);
    if (!current) reject("result_identity_unfilled", request.obligation, "fills", "The accepted obligation needs every real fill");
    const relevant = new Set(snapshots.flatMap(value => value?.content.graph.nodes.map(node => node.id) ?? []));
    const transitions = history.steps.map(step => replacementsOf(step, relevant));
    const objects = new ObjectHistory(history.steps, transitions);
    const prior: { index: number; content: ResultContent; key: string }[] = [];
    let key = "";
    for (let index = 0; index < snapshots.length; index++) {
      const value = snapshots[index]; if (!value) continue;
      const matches: typeof prior = [];
      for (const old of prior) {
        let transformed = old.content;
        for (let step = old.index + 1; step <= index; step++) transformed = renamed(transformed, transitions[step]!);
        if (canonical(transformed) === canonical(value.content)) matches.push(old);
      }
      if (new Set(matches.map(value => value.key)).size > 1) ambiguous(request.obligation, "history.matches");
      // Only whole-content equality proves these typed correspondences. State
      // vertices let all pairs in a permutation refer to their original objects.
      for (const match of matches) objects.prove(match.index, index, match.content, transitions);
      const normalized = renamed(value.content, objects.names(index, value.content));
      // Later proofs may unite object classes, but never rehash an issued key.
      key = matches[0]?.key ?? `om-result:${hashJson({ project: request.acceptance.project, ...normalized })}`;
      prior.push({ index, content: value.content, key });
    }
    return delivered({ key, obligation: current.obligation, fills: current.fills, references: history.references });
  } catch (error) {
    if (error instanceof SliceFailure) return { ok: false, refusal: error.refusal };
    if (error instanceof EngineError && error.code === "unsealable_value")
      return refused("result_identity_invalid", "Identity request must be finite acyclic JSON", { unit: "F5.2", target: "result", field: "request" }, "producer");
    throw error;
  }
}
