import { Ajv } from "ajv";
import { canonical, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import { LEVEL, type Binding, type Endpoint, type Graph, type Node } from "../graph/model.js";
import { projectGraph } from "../graph/project.js";
import { RefinementRelations } from "../graph/relations.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { isRef, reference, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { delivered, refused, sealed, type OmResult, type Refusal, type RefusalRoute, type Sealed } from "./refusal.js";
import { Store, type Revision } from "../storage/store.js";
import { ProductEngine } from "../product/engine.js";
import { readHorizon, type HorizonRecords } from "./horizon.js";
import { prepareOmInput, readOmInput, type InputRequest } from "./input.js";
import { readRecord } from "./refs.js";
import { readLayerBasis, type LayerBasis } from "./layer-basis.js";

export const FRAME_REFUSAL_CODES = Object.freeze([
  "frame_request_invalid", "upper_binding_ambiguous", "accepted_binding_ambiguous", "frame_upper_drift",
  "frame_layer_drift", "frame_record_invalid", "horizon_producer_unrefined", "representative_id_conflict",
  "frame_basis_unproven", "input_stale",
] as const);
export type FrameLevel = 2 | 3;
export interface FrameScope { nodes: string[]; excluded: { block: string; reason: string; returnCondition: string }[]; hash: string }
export interface FrameObligation {
  id: string; level: FrameLevel; kind: "block-outcome" | "operation-outcome" | "connection-end";
  upper: { node: string; port?: string }; artifact: string; zone: "horizon" | "outside";
  connector?: string; role?: "producer" | "consumer"; flow?: string;
}
export interface FrameFill { obligation: string; node: string; port?: string; source: "accepted" | "identity"; basis: Ref }
export interface ConnectionFrame { project: string; level: FrameLevel; candidateHash: string; layerHash: string; fills: FrameFill[] }
export interface AcceptedFrame { graph: Graph; reference: Ref; frame: { reference: Ref; value: ConnectionFrame } | null }
export interface FilledFrame {
  obligations: FrameObligation[]; fills: FrameFill[]; open: FrameObligation[]; representatives: Node[]; joins: Graph['joins'];
}
const frameObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const frameText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const frameHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const frameOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const frameSorted = <T>(values: readonly T[]) => [...values].sort((a, b) => frameOrder(canonical(a), canonical(b)));
function frameCopy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) {
    if (error instanceof EngineError && error.code === "unsealable_value") frameInvalid("json");
    throw error;
  }
}
const frameSchemas = new Ajv({ strict: true, allowUnionTypes: true });
const frameGraphShapes = [frameSchemas.compile(sealed(graphSchema)), frameSchemas.compile(sealed(graphV2Schema))];
function frameInvalid(field: string, target = "frame"): never {
  throw new EngineError("frame_request_invalid", "A frame needs explicit, well-formed inputs", { unit: "F4", target, field });
}
class FrameFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function frameReject(code: string, target: string, field: string, message: string, route: RefusalRoute = "producer"): never {
  const result = refused(code, message, { unit: "F4", target, field }, route);
  if (!result.ok) throw new FrameFailure(result.refusal);
  throw new EngineError("frame_internal_error", "Refusal unexpectedly produced a value");
}
function frameResult<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof FrameFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function requireFrameLevel(level: unknown): asserts level is FrameLevel {
  if (level !== 2 && level !== 3) frameInvalid("level");
}
function requireFrameGraph(graph: unknown, field: string): asserts graph is Graph {
  if (!frameObject(graph) || !frameGraphShapes[graph['version'] === 2 ? 1 : 0]!(graph)) frameInvalid(field);
}
function requireFrameScope(scope: unknown): asserts scope is FrameScope {
  if (!frameObject(scope) || !Array.isArray(scope['nodes']) || !scope['nodes'].every(frameText)
    || !Array.isArray(scope['excluded']) || !scope['excluded'].every(item => frameObject(item) && frameText(item['block'])
      && frameText(item['reason']) && frameText(item['returnCondition'])) || !frameHash(scope['hash'])) frameInvalid("scope");
}
function requireFlow(binding: unknown): asserts binding is Binding {
  const endpoint = (value: unknown) => frameObject(value) && frameText(value['node']) && frameText(value['port']);
  if (!frameObject(binding) || (binding['level'] !== 1 && binding['level'] !== 2 && binding['level'] !== 3) || !endpoint(binding['producer'])
    || !Array.isArray(binding['consumers']) || !binding['consumers'].length || !binding['consumers'].every(endpoint)
    || !(binding['anchor'] === null || frameText(binding['anchor']))) frameInvalid("binding");
}
export function flowKey(binding: Binding): string {
  requireFlow(binding);
  return hashJson([binding.producer.node, binding.producer.port, binding.anchor]);
}
export function representativeId(upperId: string, level: FrameLevel): string {
  if (!frameText(upperId)) frameInvalid("upperId");
  requireFrameLevel(level);
  return `om-identity:${level}:${hashJson(upperId)}`;
}
interface FrameFlow { connector: string; artifact: string; key: string; producer: Endpoint; consumers: Endpoint[]; anchor: string | null }
function upperFlows(upper: Graph, level: FrameLevel): FrameFlow[] {
  const flows = new Map<string, FrameFlow>(), consumers = new Map<string, Set<string>>();
  for (const connector of upper.connectors) for (const binding of connector.bindings.filter(item => item.level === level - 1)) {
    const key = flowKey(binding), address = canonical([connector.id, key]);
    let flow = flows.get(address);
    if (!flow) {
      flow = { connector: connector.id, artifact: connector.artifact, key, producer: binding.producer, consumers: [], anchor: binding.anchor };
      flows.set(address, flow); consumers.set(address, new Set());
    }
    for (const endpoint of binding.consumers) {
      const end = canonical([endpoint.node, endpoint.port]);
      if (consumers.get(address)!.has(end)) frameReject("upper_binding_ambiguous", connector.id, endpoint.port,
        "The same consumer endpoint occurs twice in one upper flow");
      consumers.get(address)!.add(end); flow.consumers.push(endpoint);
    }
  }
  return frameSorted([...flows.values()].map(flow => ({ ...flow, consumers: frameSorted(flow.consumers) })));
}
function obligationsOf(upper: Graph, scope: FrameScope, level: FrameLevel): FrameObligation[] {
  const nodes = new Set(scope.nodes), result: FrameObligation[] = [];
  const add = (value: Omit<FrameObligation, "id" | "zone" | "level">) => result.push({ ...value, level,
    zone: nodes.has(value.upper.node) ? "horizon" : "outside",
    id: hashJson([value.kind, value.connector ?? null, level, value.role ?? null, value.upper.node, value.upper.port ?? null, value.flow ?? null]) });
  for (const node of upper.nodes.filter(node => LEVEL[node.kind] === level - 1)) {
    if (!upper.artifacts.some(artifact => artifact.id === node.outcome)) frameInvalid("upper.outcome", node.id);
    add({ kind: level === 2 ? "block-outcome" : "operation-outcome", upper: { node: node.id }, artifact: node.outcome });
  }
  for (const flow of upperFlows(upper, level)) for (const [role, endpoints] of [["producer", [flow.producer]], ["consumer", flow.consumers]] as const)
    for (const endpoint of endpoints) {
      const node = upper.nodes.find(item => item.id === endpoint.node), port = node?.ports.find(item => item.id === endpoint.port);
      const artifact = upper.artifacts.find(item => item.id === flow.artifact);
      if (!node || LEVEL[node.kind] !== level - 1 || !port || !artifact || port.contract !== artifact.contract
        || port.direction !== (role === "producer" ? "out" : "in")) frameInvalid("upper.binding", flow.connector);
      add({ kind: "connection-end", connector: flow.connector, artifact: flow.artifact, role,
        upper: { node: endpoint.node, port: endpoint.port }, flow: flow.key });
    }
  return result.sort((a, b) => frameOrder(a.id, b.id));
}
export function frameObligations(upper: Graph, scope: FrameScope, level: FrameLevel): OmResult<Sealed<FrameObligation[]>> {
  requireFrameGraph(upper, "upper"); requireFrameScope(scope); requireFrameLevel(level);
  return frameResult(() => obligationsOf(frameCopy(upper), frameCopy(scope), level));
}

const frameEndpointKey = (endpoint: { node: string; port?: string }) => canonical([endpoint.node, endpoint.port]);
function acceptsFlowAnchor(upper: Graph, graph: Graph, flow: FrameFlow, binding: Pick<Binding, "anchor" | "consumers">, level: FrameLevel): boolean {
  if (flow.anchor === binding.anchor) return true;
  if (level !== 3 || flow.anchor !== null || binding.anchor === null
    || upper.connectors.find(item => item.id === flow.connector)?.bindings.some(item => item.level === level - 1 && item.anchor === binding.anchor)
    || binding.consumers.some(endpoint => graph.horizon.includes(endpoint.node))) return false;
  const anchor = graph.anchors.find(item => item.id === binding.anchor), connector = graph.connectors.find(item => item.id === flow.connector);
  return !!anchor && anchor.outcome === flow.artifact && graph.nodes.some(node => node.id === anchor.owner && node.outcome === anchor.outcome)
    && graph.tests.some(test => test.id === anchor.test) && !!connector?.wakeTest && graph.tests.some(test => test.id === connector.wakeTest);
}
function checkFlowCorrespondence(upper: Graph, graph: Graph, obligations: FrameObligation[], rows: Map<string, FrameFill[]>, level: FrameLevel,
  code: "frame_record_invalid" | "accepted_binding_ambiguous", target: string): void {
  const flows = upperFlows(upper, level).map(flow => {
    const ends = obligations.filter(item => item.connector === flow.connector && item.flow === flow.key);
    const producers = rows.get(ends.find(item => item.role === "producer")!.id) ?? [];
    if (producers.length > 1) frameReject(code, target, flow.connector, "An upper flow has several lower producers");
    return { flow, producer: producers[0], consumers: new Set(ends.filter(item => item.role === "consumer")
      .flatMap(item => (rows.get(item.id) ?? []).map(frameEndpointKey))), actual: new Set<string>() };
  });
  // The lower graph supplies every delivery, while rows supply exact renamed endpoints. Sleeping
  // work deliveries may partition one upper flow, but no delivery may satisfy two upper flows.
  for (const connector of graph.connectors) {
    const expected = flows.filter(item => item.flow.connector === connector.id);
    if (!expected.length) continue;
    const deliveries = new Map<string, Binding>();
    for (const binding of connector.bindings.filter(item => item.level === level)) {
      const key = flowKey(binding), delivery = deliveries.get(key);
      if (delivery) delivery.consumers.push(...binding.consumers);
      else deliveries.set(key, { ...binding, consumers: [...binding.consumers] });
    }
    for (const delivery of deliveries.values()) {
      const consumers = delivery.consumers.map(frameEndpointKey);
      if (new Set(consumers).size !== consumers.length)
        frameReject(code, target, connector.id, "The same consumer occurs twice in one accepted lower flow");
      const candidates = expected.filter(item => item.producer && frameEndpointKey(item.producer) === frameEndpointKey(delivery.producer)
        && acceptsFlowAnchor(upper, graph, item.flow, delivery, level) && consumers.every(endpoint => item.consumers.has(endpoint)));
      if (candidates.length !== 1)
        frameReject(code, target, connector.id, "Each accepted lower flow must correspond to exactly one whole upper flow");
      const assigned = candidates[0]!;
      for (const endpoint of consumers) {
        if (assigned.actual.has(endpoint)) frameReject(code, target, connector.id, "An upper consumer is repeated across active and sleeping deliveries");
        assigned.actual.add(endpoint);
      }
    }
  }
  for (const { flow, producer, consumers, actual } of flows) {
    if ((producer && actual.size === 0) || consumers.size !== actual.size || [...consumers].some(endpoint => !actual.has(endpoint)))
      frameReject(code, target, flow.connector, "The complete accepted lower flow differs from its recorded producer and consumers");
  }
}

function checkedAccepted(upper: Graph, accepted: AcceptedFrame, obligations: FrameObligation[], level: FrameLevel): Map<string, FrameFill[]> | null {
  if (canonical(projectGraph(upper, (level - 1) as 1 | 2)) !== canonical(projectGraph(accepted.graph, (level - 1) as 1 | 2)))
    frameReject("frame_upper_drift", accepted.reference.id, "upper", "The accepted lower layer uses a different upper layer", "owner");
  if (!/^graph:[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(accepted.reference.id) || accepted.reference.hash !== hashJson(accepted.graph)) frameReject("frame_record_invalid", accepted.reference.id, "hash", "The accepted graph differs from its exact reference");
  if (!accepted.frame) return null;
  const { reference: frameRef, value } = accepted.frame;
  if (!frameObject(value) || !frameText(value.project) || value.level !== level || !frameHash(value.candidateHash)
    || !frameHash(value.layerHash) || !Array.isArray(value.fills) || accepted.reference.id !== `graph:${value.project}`
    || frameRef.id !== `om-frame:${value.project}:${level}` || frameRef.hash !== hashJson(value))
    frameReject("frame_record_invalid", frameRef.id, "frame", "The accepted frame must identify its project, level and exact content");
  if (value.layerHash !== hashJson(projectGraph(accepted.graph, level)))
    frameReject("frame_layer_drift", frameRef.id, "layerHash", "The layer changed outside its accepted frame", "owner");
  if (canonical(value.fills) !== canonical(frameSorted(value.fills)))
    frameReject("frame_record_invalid", frameRef.id, "fills", "The accepted fill set must retain canonical order");
  const byObligation = new Map(obligations.map(item => [item.id, item])), rows = new Map<string, FrameFill[]>();
  const relations = new RefinementRelations(accepted.graph), classification = new Map<string, string>(), identities = new Map<string, string>();
  const identityForUpper = new Map<string, string>();
  for (const row of value.fills) {
    if (!frameObject(row) || !frameText(row.obligation) || !frameText(row.node) || (row.port !== undefined && !frameText(row.port))
      || (row.source !== "accepted" && row.source !== "identity") || !isRef(row.basis))
      frameReject("frame_record_invalid", frameRef.id, "fills", "A recorded fill needs its source, exact basis and endpoint");
    const obligation = byObligation.get(row.obligation), node = accepted.graph.nodes.find(item => item.id === row.node);
    if (!obligation || !node || LEVEL[node.kind] !== level || !relations.refines(node.id, obligation.upper.node))
      frameReject("frame_record_invalid", frameRef.id, row.obligation, "A recorded endpoint does not refine its obligation");
    if (classification.has(node.id) && classification.get(node.id) !== row.source)
      frameReject("frame_record_invalid", frameRef.id, row.obligation, "One accepted node cannot be both identity and real");
    classification.set(node.id, row.source);
    if (row.source === "identity") {
      if (identities.has(node.id) && identities.get(node.id) !== obligation.upper.node)
        frameReject("frame_record_invalid", frameRef.id, row.obligation, "An identity node represents exactly one upper node");
      if (identityForUpper.has(obligation.upper.node) && identityForUpper.get(obligation.upper.node) !== node.id)
        frameReject("frame_record_invalid", frameRef.id, row.obligation, "An upper node has exactly one identity representative");
      identities.set(node.id, obligation.upper.node); identityForUpper.set(obligation.upper.node, node.id);
    }
    if (obligation.kind !== "connection-end") {
      if (row.port !== undefined || node.outcome !== obligation.artifact)
        frameReject("frame_record_invalid", frameRef.id, row.obligation, "An outcome fill must produce this upper outcome");
    } else {
      const port = node.ports.find(item => item.id === row.port), artifact = upper.artifacts.find(item => item.id === obligation.artifact);
      if (!port || port.direction !== (obligation.role === "producer" ? "out" : "in") || port.contract !== artifact?.contract)
        frameReject("frame_record_invalid", frameRef.id, row.obligation, "A recorded endpoint has a different port direction or contract");
    }
    const prior = rows.get(row.obligation) ?? [];
    if (prior.some(item => item.node === row.node && item.port === row.port))
      frameReject("frame_record_invalid", frameRef.id, row.obligation, "The same recorded endpoint is duplicated");
    prior.push(row); rows.set(row.obligation, prior);
  }
  for (const obligation of obligations) {
    const mine = rows.get(obligation.id);
    if (!mine?.length || (obligation.role !== "consumer" && mine.length !== 1))
      frameReject("frame_record_invalid", frameRef.id, obligation.id, "The accepted mapping must cover each source obligation with its declared cardinality");
  }
  checkFlowCorrespondence(upper, accepted.graph, obligations, rows, level, "frame_record_invalid", frameRef.id);
  return rows;
}
function historicalFills(upper: Graph, graph: Graph, obligation: FrameObligation, level: FrameLevel, relations: RefinementRelations): Endpoint[] {
  if (obligation.kind !== "connection-end") return graph.nodes.filter(node => LEVEL[node.kind] === level
    && node.outcome === obligation.artifact && relations.refines(node.id, obligation.upper.node)).map(node => ({ node: node.id, port: "" }));
  const flows = upperFlows(upper, level).filter(flow => flow.connector === obligation.connector);
  const result: Endpoint[] = [];
  for (const binding of graph.connectors.find(item => item.id === obligation.connector)?.bindings.filter(item => item.level === level) ?? []) {
    let candidates = flows.filter(flow => acceptsFlowAnchor(upper, graph, flow, binding, level)
      && relations.refines(binding.producer.node, flow.producer.node)
      && binding.consumers.every(endpoint => flow.consumers.some(consumer => relations.refines(endpoint.node, consumer.node))));
    if (candidates.length > 1) {
      candidates = candidates.filter(flow => flow.producer.port === binding.producer.port
        && binding.consumers.every(endpoint => flow.consumers.some(consumer => relations.refines(endpoint.node, consumer.node) && endpoint.port === consumer.port)));
      if (candidates.length !== 1) frameReject("accepted_binding_ambiguous", obligation.connector!, "flow",
        "The historical lower binding needs distinct port IDs or an accepted recorded mapping");
    }
    const flow = candidates.find(item => item.key === obligation.flow);
    if (!flow) continue;
    if (obligation.role === "producer") result.push(binding.producer);
    else {
      const ports = new Set(flow.consumers.filter(endpoint => endpoint.node === obligation.upper.node).map(endpoint => endpoint.port));
      const endpoints = binding.consumers.filter(endpoint => relations.refines(endpoint.node, obligation.upper.node));
      if (ports.size > 1 && endpoints.some(endpoint => !ports.has(endpoint.port)))
        frameReject("accepted_binding_ambiguous", obligation.connector!, "consumer.port",
          "Several upper ports of this consumer need distinct port IDs or an accepted recorded mapping");
      result.push(...endpoints.filter(endpoint => ports.size <= 1 || endpoint.port === obligation.upper.port));
    }
  }
  return [...new Map(result.map(endpoint => [canonical([endpoint.node, endpoint.port]), endpoint])).values()];
}
export function fillObligations(upper: Graph, scope: FrameScope, accepted: AcceptedFrame | null, upperRef: Ref, level: FrameLevel): OmResult<Sealed<FilledFrame>> {
  requireFrameGraph(upper, "upper"); requireFrameScope(scope); requireFrameLevel(level);
  if (!isRef(upperRef)) frameInvalid("upperRef");
  if (accepted !== null) {
    if (!frameObject(accepted) || !isRef(accepted.reference) || !Object.hasOwn(accepted, "frame")) frameInvalid("accepted");
    requireFrameGraph(accepted.graph, "accepted.graph");
    if (accepted.frame !== null && (!frameObject(accepted.frame) || !isRef(accepted.frame.reference) || !frameObject(accepted.frame.value))) frameInvalid("accepted.frame");
  }
  upper = frameCopy(upper); scope = frameCopy(scope); accepted = frameCopy(accepted); upperRef = frameCopy(upperRef);
  return frameResult(() => {
    const obligations = obligationsOf(upper, scope, level), fills: FrameFill[] = [], open: FrameObligation[] = [];
    const recorded = accepted ? checkedAccepted(upper, accepted, obligations, level) : null;
    const relations = new RefinementRelations(accepted?.graph ?? upper);
    const historical = new Map<string, FrameFill[]>();
    if (accepted && !recorded) for (const obligation of obligations) historical.set(obligation.id,
      historicalFills(upper, accepted.graph, obligation, level, relations).map(endpoint => ({
        obligation: obligation.id, node: endpoint.node, ...(obligation.kind === "connection-end" ? { port: endpoint.port } : {}),
        source: "accepted", basis: accepted.reference,
      })));
    const representatives = new Map<string, { node: Node; upper: string; ports: Set<string> }>();
    for (const obligation of obligations) {
      const entries = (recorded ?? historical).get(obligation.id) ?? [];
      const real = entries.filter(entry => entry.source === "accepted");
      if (obligation.role !== "consumer" && real.length > 1)
        frameReject("accepted_binding_ambiguous", obligation.id, "fill", "The single-valued obligation has several real accepted endpoints");
      if (real.length) {
        for (const row of real) fills.push({ obligation: obligation.id, node: row.node, ...(row.port === undefined ? {} : { port: row.port }),
          source: "accepted", basis: accepted!.frame?.reference ?? accepted!.reference });
        continue;
      }
      if (obligation.zone === "horizon") { open.push(obligation); continue; }
      const upperNode = upper.nodes.find(node => node.id === obligation.upper.node)!;
      if (!upperNode) frameInvalid("upper.node", obligation.upper.node);
      const kept = entries.filter(entry => entry.source === "identity");
      if (kept.length > 1) frameReject("frame_record_invalid", obligation.id, "identity", "An upper node has only one identity representative");
      const id = kept[0]?.node ?? representativeId(upperNode.id, level);
      if (!representatives.has(id)) {
        const old = accepted?.graph.nodes.find(node => node.id === id);
        if (old && !kept.length) frameReject("representative_id_conflict", id, "id", "The reserved identity ID is already used by another accepted node");
        const node: Node = old ? frameCopy(old) : { ...upperNode, id, kind: level === 2 ? "operation" : "work", parent: upperNode.id };
        representatives.set(id, { node, upper: upperNode.id, ports: new Set() });
      }
      const port = kept[0]?.port ?? obligation.upper.port;
      if (port !== undefined) representatives.get(id)!.ports.add(port);
      fills.push({ obligation: obligation.id, node: id, ...(port === undefined ? {} : { port }), source: "identity", basis: upperRef });
    }
    if (accepted && !recorded) checkFlowCorrespondence(upper, accepted.graph, obligations, historical, level,
      "accepted_binding_ambiguous", accepted.reference.id);
    for (const obligation of obligations.filter(item => item.role === "producer" && item.zone === "outside")) {
      const external = upper.artifacts.find(item => item.id === obligation.artifact)?.external;
      const needed = obligations.some(item => item.connector === obligation.connector && item.flow === obligation.flow
        && item.role === "consumer" && item.zone === "horizon");
      if (!external && needed && !fills.some(fill => fill.obligation === obligation.id && fill.source === "accepted"))
        frameReject("horizon_producer_unrefined", obligation.id, "producer", "This flow needs a real refined producer outside the horizon", "readiness");
    }
    const joins: Graph['joins'] = [];
    const nodes = [...representatives.values()].map(({ node, upper: upperId, ports }) => {
      const result = { ...node, ports: node.ports.filter(port => ports.has(port.id)).sort((a, b) => frameOrder(a.id, b.id)) };
      for (const join of upper.joins.filter(item => item.consumer === upperId)) joins.push({ ...join,
        id: `om-identity-join:${level}:${hashJson([join.id, upperId])}`, consumer: node.id });
      return result;
    });
    return { obligations, fills: frameSorted(fills), open, representatives: nodes.sort((a, b) => frameOrder(a.id, b.id)), joins: frameSorted(joins) };
  });
}

/** Exact historical inputs. `upper` supplies the accepted L2 witness for work frames. */
export interface FrameRequest {
  project: string; level: FrameLevel; horizon: Ref; graph: Ref; layer: Ref | null; frame: Ref | null;
  upper: { horizon: Ref; frame: Ref | null } | null;
}
export interface FrameRead {
  request: FrameRequest; upper: Graph; upperRef: Ref; scope: FrameScope;
  accepted: AcceptedFrame | null; result: FilledFrame; references: Ref[];
}
export interface PreparedFrame extends FrameRead {
  guards: Ref[];
  // C5 must CAS all three writes in its single acceptance transaction. In particular a missing frame is
  // protected by expected.frame=0; Store read guards describe existing revisions, never absence.
  expected: { graph: number; layer: number; frame: number };
}
type FrameLayer = LayerBasis;
function frameTake<T>(result: OmResult<T>): T {
  if (!result.ok) throw new FrameFailure(result.refusal);
  return result.value;
}
function requireFrameRequest(store: Store, request: unknown): asserts request is FrameRequest {
  if (!(store instanceof Store) || !frameObject(request) || !frameText(request['project'])) frameInvalid("request");
  requireFrameLevel(request['level']);
  for (const key of ['horizon', 'graph']) if (!isRef(request[key])) frameInvalid(key);
  for (const key of ['layer', 'frame']) if (request[key] !== null && !isRef(request[key])) frameInvalid(key);
  const upper = request['upper'];
  if (request['level'] === 2 ? upper !== null : !frameObject(upper) || !isRef(upper['horizon'])
    || (upper['frame'] !== null && !isRef(upper['frame']))) frameInvalid("upper");
}
function frameReadRecord<T>(store: Store, ref: Ref, id: string, kind: string, refs: Ref[]): Revision<T> {
  const record = frameTake(readRecord<T>(store, ref, { unit: "F4", target: id, id, kind }));
  refs.push(reference(record));
  return record as Revision<T>;
}
function frameReadLayer(store: Store, ref: Ref, project: string, level: 1 | 2 | 3, refs: Ref[]): Revision<FrameLayer> {
  const saved = frameReadRecord<FrameLayer>(store, ref, `graph-layer:${project}:${level}`, "graph-layer", refs);
  const layer = saved.value;
  if (!frameObject(layer) || !frameObject(layer.projection) || layer.projection.level !== level
    || !Array.isArray(layer.inputs) || !layer.inputs.every(isRef) || !Array.isArray(layer.obligations)
    || !layer.obligations.every(item => frameObject(item) && frameText(item.node) && frameText(item.field)
      && frameHash(item.valueHash) && Array.isArray(item.inputs) && item.inputs.every(isRef))
    || (layer.layerProofs !== undefined && (!Array.isArray(layer.layerProofs) || !layer.layerProofs.every(proof =>
      frameObject(proof) && [1, 2, 3].includes(proof.level) && proof.level <= level && frameHash(proof.hash)
      && Array.isArray(proof.inputs) && proof.inputs.every(isRef)))))
    frameReject("frame_record_invalid", ref.id, "layer", "The layer has an invalid proof envelope");
  return saved;
}
function frameAcceptedHorizon(store: Store, project: string, ref: Ref, refs: Ref[]): HorizonRecords {
  const saved = frameTake(readHorizon(store, project, ref));
  if (saved.gate.value.state !== "accepted") frameReject("frame_basis_unproven", ref.id, "state", "The frame needs an accepted horizon");
  refs.push(reference(saved.gate), reference(saved.horizon), saved.horizon.value.request.input);
  return saved as HorizonRecords;
}
function frameProjection(graph: Graph, level: 1 | 2 | 3): Graph {
  const { level: _level, ...projection } = projectGraph(graph, level);
  return { ...projection, version: graph.version } as Graph;
}
function frameCompareUpper(layer: FrameLayer, graph: Graph, level: 1 | 2, target: string): void {
  if (canonical(layer.projection) !== canonical(projectGraph(graph, level)))
    frameReject("frame_upper_drift", target, "upper", "The graph changed the upper layer on which this frame was accepted", "owner");
  for (const proof of (layer.layerProofs ?? []).filter(proof => proof.level === level))
    if (proof.hash !== hashJson(projectGraph(graph, level)))
      frameReject("frame_upper_drift", target, "layerProofs", "The present upper proof disagrees with the accepted projection", "owner");
}
function frameReadConnection(store: Store, project: string, level: FrameLevel, ref: Ref | null, refs: Ref[]): AcceptedFrame['frame'] {
  return ref ? { reference: ref, value: frameReadRecord<ConnectionFrame>(store, ref, `om-frame:${project}:${level}`, "connection-frame", refs).value } : null;
}
function frameDerive(store: Store, request: FrameRequest): FrameRead {
  const refs: Ref[] = [];
  const horizon = frameAcceptedHorizon(store, request.project, request.horizon, refs);
  const inputRef = horizon.horizon.value.request.input;
  const input = frameTake(readOmInput(store, request.project, inputRef));
  const map = input.value.input.sources.find(source => source.stage === "operation-map")!;
  const stage = frameReadRecord<StageArtifact>(store, map, `stage:${request.project}:operation-map`, "stage", refs);
  const l1ref = frameObject(stage.value.content) ? stage.value.content['graph'] : null;
  if (!isRef(l1ref)) frameReject("frame_basis_unproven", map.id, "graph", "The accepted map must name its upper layer");
  const graph = frameReadRecord<Graph>(store, request.graph, `graph:${request.project}`, "graph", refs).value;
  requireFrameGraph(graph, "graph");
  const l1 = frameReadLayer(store, l1ref, request.project, 1, refs);
  frameCompareUpper(l1.value, graph, 1, l1.id);
  const ownerScope = horizon.horizon.value.result.horizon;
  let scope: FrameScope = { nodes: ownerScope.nodes, excluded: ownerScope.excluded, hash: ownerScope.hash };
  let upperRef: Ref = l1ref;
  if (request.upper) {
    const witness = frameAcceptedHorizon(store, request.project, request.upper.horizon, refs);
    if (canonical(witness.horizon.value.request.input) !== canonical(inputRef))
      frameReject("frame_basis_unproven", request.upper.horizon.id, "input", "The accepted L2 must belong to this OM input");
    const phaseRef = witness.horizon.value.request.refinement;
    if (!phaseRef) frameReject("frame_basis_unproven", request.upper.horizon.id, "refinement", "The upper witness must prove accepted L2");
    const phase = frameReadRecord<{ layer: Ref }>(store, phaseRef, `phase:${request.project}:L2`, "phase", refs);
    upperRef = phase.value.layer;
    const l2 = frameReadLayer(store, upperRef, request.project, 2, refs);
    frameCompareUpper(l2.value, graph, 2, l2.id);
    const upperFrame = frameReadConnection(store, request.project, 2, request.upper.frame, refs);
    frameTake(fillObligations(frameProjection(graph, 1), scope,
      { graph, reference: request.graph, frame: upperFrame }, l1ref, 2));
    // Entering the new block horizon reopens identity obligations; it does not turn the saved identity into
    // a real operation. Read that classification from the validated accepted frame before zone filtering.
    const identities = new Set((upperFrame?.value.fills ?? []).filter(fill => fill.source === "identity").map(fill => fill.node));
    const relations = new RefinementRelations(graph);
    const nodes = graph.nodes.filter(node => node.kind === "operation" && !identities.has(node.id)
      && ownerScope.nodes.some(block => ownerScope.execution[block]?.state === "needed" && relations.refines(node.id, block)))
      .map(node => node.id).sort(frameOrder);
    scope = { nodes, excluded: ownerScope.excluded, hash: hashJson([ownerScope.hash, 3, nodes]) };
  }
  let accepted: AcceptedFrame | null = null;
  if (request.layer) {
    const lower = frameReadLayer(store, request.layer, request.project, request.level, refs);
    const own = (lower.value.layerProofs ?? []).filter(proof => proof.level === request.level);
    if (own.length !== 1) frameReject("frame_basis_unproven", request.layer.id, "layerProofs", "An accepted lower layer needs its own derivation proof");
    const proof = own[0]!;
    const upperBases = new Map(proof.inputs.filter(ref => ref.id === `graph-layer:${request.project}:${request.level - 1}`)
      .map(ref => [canonical(ref), ref]));
    if (upperBases.size !== 1) frameReject("frame_basis_unproven", request.layer.id, "inputs", "The lower proof must retain its exact upper basis");
    const savedBase = [...upperBases.values()][0]!;
    const base = frameReadLayer(store, savedBase, request.project, (request.level - 1) as 1 | 2, refs);
    frameCompareUpper(base.value, graph, (request.level - 1) as 1 | 2, request.layer.id);
    if (canonical(savedBase) !== canonical(upperRef))
      frameReject("frame_basis_unproven", request.layer.id, "upper", "The saved upper basis is not the named accepted upper revision");
    for (const upperProof of (lower.value.layerProofs ?? []).filter(item => item.level === request.level - 1))
      if (upperProof.hash !== hashJson(projectGraph(graph, upperProof.level)))
        frameReject("frame_upper_drift", request.layer.id, "layerProofs", "The present upper proof cannot be replaced by a fallback", "owner");
    if (canonical(lower.value.projection) !== canonical(projectGraph(graph, request.level))
      || proof.hash !== hashJson(projectGraph(graph, request.level)))
      frameReject("frame_layer_drift", request.layer.id, "projection", "The accepted lower layer no longer matches this graph", "owner");
    const basis = readLayerBasis(store, { project: request.project, level: request.level,
      graph: request.graph, layer: request.layer, upper: savedBase });
    if (!basis.ok) frameReject("frame_basis_unproven", basis.refusal.at.target, basis.refusal.at.field ?? "research", basis.refusal.message);
    refs.push(...basis.value.references);
    accepted = { graph, reference: request.graph, frame: frameReadConnection(store, request.project, request.level, request.frame, refs) };
  } else if (request.frame) frameReject("frame_basis_unproven", request.frame.id, "layer", "A connection frame requires an accepted lower layer");
  const upper = frameProjection(graph, (request.level - 1) as 1 | 2);
  const result = frameTake(fillObligations(upper, scope, accepted, upperRef, request.level));
  return { request, upper, upperRef, scope, accepted, result: result as FilledFrame,
    references: frameSorted([...new Map(refs.map(ref => [canonical(ref), ref])).values()]) };
}
/** History is checked exclusively through immutable exact references, even after heads move. */
export function readFrame(store: Store, request: FrameRequest): OmResult<Sealed<FrameRead>> {
  requireFrameRequest(store, request);
  return frameResult(() => frameDerive(store, frameCopy(request)));
}
/** Prepare current acceptance without writing; hand the guards and CAS revisions to C5. */
export function prepareFrame(store: Store, request: FrameRequest): OmResult<Sealed<PreparedFrame>> {
  requireFrameRequest(store, request);
  request = frameCopy(request);
  return frameResult(() => {
    const read = frameDerive(store, request), guards = new Map<string, Ref>();
    const remember = (ref: Ref) => {
      const previous = guards.get(ref.id);
      if (previous && canonical(previous) !== canonical(ref))
        frameReject("input_stale", ref.id, "head", "A frame prerequisite changed during preparation");
      guards.set(ref.id, ref);
    };
    const traced = new Proxy(store, { get(target, key) {
      if (key === "get") return <T>(id: string, revision?: number): Revision<T> | null => {
        const result = target.get<T>(id, revision);
        if (revision === undefined && result) remember(reference(result));
        return result;
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const current = (ref: Ref) => {
      const head = traced.get(ref.id);
      if (!head || canonical(reference(head)) !== canonical(ref))
        frameReject("input_stale", ref.id, "head", "The frame prerequisite is no longer current");
    };
    for (const ref of [request.graph, request.horizon, ...(request.layer ? [request.layer] : []),
      ...(request.frame ? [request.frame] : []), ...(request.upper ? [request.upper.horizon, ...(request.upper.frame ? [request.upper.frame] : [])] : [])]) current(ref);
    const frameHead = traced.get(`om-frame:${request.project}:${request.level}`);
    if (!request.frame && frameHead) frameReject("input_stale", frameHead.id, "frame", "An existing frame cannot be omitted");
    if (request.upper && !request.upper.frame && traced.get(`om-frame:${request.project}:2`))
      frameReject("input_stale", `om-frame:${request.project}:2`, "upper.frame", "The accepted upper frame cannot be omitted");
    const layerHead = traced.get<FrameLayer>(`graph-layer:${request.project}:${request.level}`);
    if (!request.layer && layerHead?.value.layerProofs?.some(proof => proof.level === request.level))
      frameReject("frame_basis_unproven", layerHead.id, "layer", "An accepted lower layer cannot be omitted");
    const horizon = frameTake(readHorizon(traced, request.project, request.horizon));
    current(reference(horizon.horizon));
    for (const basis of Object.values(horizon.horizon.value.request.available)) for (const ref of Object.values(basis)) current(ref);
    const inputRef = horizon.horizon.value.request.input;
    current(inputRef);
    const input = frameTake(readOmInput(traced, request.project, inputRef));
    const inputRequest: InputRequest = { project: request.project, expected: inputRef.revision,
      inventory: input.value.input.inventory, stages: Object.fromEntries(input.value.input.sources.map(source =>
        [source.stage, { id: source.id, revision: source.revision, hash: source.hash }])) as InputRequest['stages'] };
    const prepared = frameTake(prepareOmInput(traced, inputRequest));
    if (!prepared.existing || canonical(reference(prepared.existing)) !== canonical(inputRef))
      frameReject("input_stale", inputRef.id, "input", "The frame needs the currently admitted OM input");
    for (const guard of prepared.guards) remember(guard);
    const engine = new ProductEngine(traced);
    const gates = request.layer ? [engine.graphs.layerGate(request.project, request.level, request.layer),
      engine.refinement.gate(request.project, request.level === 2 ? "R1" : "R2")] : [];
    if (request.upper) {
      const witness = frameTake(readHorizon(traced, request.project, request.upper.horizon));
      current(reference(witness.horizon));
      current(witness.horizon.value.request.refinement!);
      gates.push(engine.refinement.gate(request.project, "L2"), engine.graphs.layerGate(request.project, 2, read.upperRef));
    }
    for (const gate of gates) {
      if (gate.findings.length) {
        const finding = gate.findings[0]!;
        frameReject("frame_basis_unproven", finding.target, finding.code, finding.message);
      }
      for (const guard of [...gate.guards, ...(gate.admissionGuards ?? [])]) remember(guard);
    }
    return { ...read, guards: frameSorted([...guards.values()]),
      expected: { graph: request.graph.revision, layer: layerHead?.revision ?? 0, frame: frameHead?.revision ?? 0 } };
  });
}
