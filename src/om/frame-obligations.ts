import { Ajv } from "ajv";
import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { LEVEL, type Binding, type CodeRef, type Endpoint, type Graph, type Node } from "../graph/model.js";
import { projectGraph } from "../graph/project.js";
import { RefinementRelations } from "../graph/relations.js";
import { workZone } from "./work-zone.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { isRef, reference, type GateResult, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { delivered, refused, sealed, type OmResult, type Refusal, type RefusalRoute, type Sealed } from "./refusal.js";
import { Store, type Revision } from "../storage/store.js";
import { StageChecks } from "../product/stage-checks.js";
import { readHorizon, type HorizonRecords } from "./horizon.js";
import { historicalProof, historicalTrace, withHistoricalReads, prepareExistingOmInput, readOmAdmissionGuards, readOmInput } from "./input.js";
import { readRecord } from "./refs.js";
import { readLayerAcceptance, readLayerBasis, type HistoricalLayerBasis, type LayerAcceptanceRequest, type LayerBasis } from "./layer-basis.js";

export const FRAME_REFUSAL_CODES = Object.freeze([
  "frame_request_invalid", "upper_binding_ambiguous", "accepted_binding_ambiguous", "frame_upper_drift",
  "frame_layer_drift", "frame_record_invalid", "horizon_producer_unrefined", "representative_id_conflict",
  "frame_basis_unproven", "input_stale", "works_code_missing", "works_code_foreign",
] as const);
export type FrameLevel = 2 | 3;
export const WORKS_FRAME_CONTRACT = "works-frame/v1" as const;
export interface FrameScope { nodes: string[]; excluded: { block: string; reason: string; returnCondition: string }[]; hash: string }
export interface FrameObligation {
  id: string; level: FrameLevel; kind: "block-outcome" | "operation-outcome" | "connection-end";
  upper: { node: string; port?: string }; artifact: string; zone: "horizon" | "outside";
  connector?: string; role?: "producer" | "consumer"; flow?: string;
}
export interface FrameFill { obligation: string; node: string; port?: string; codeRef?: CodeRef; source: "accepted" | "identity"; basis: Ref }
export interface ConnectionFrame { project: string; level: FrameLevel; candidateHash: string; layerHash: string; fills: FrameFill[];
  worksContract?: typeof WORKS_FRAME_CONTRACT }
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
const frameCodeShape = frameSchemas.compile(sealed(graphV2Schema.properties['nodes'].items.properties.code.items));
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
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof FrameFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
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
export function workAnchorId(connector: string, flow: string, producer: Pick<Endpoint, "node" | "port">): string {
  if (!frameText(connector) || !frameHash(flow) || !frameObject(producer) || !frameText(producer.node) || !frameText(producer.port))
    frameInvalid("anchor");
  return `om-work-anchor:${hashJson([connector, flow, producer.node, producer.port]).slice(0, 40)}`;
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
function acceptsFlowAnchor(upper: Graph, graph: Graph, flow: FrameFlow, binding: Pick<Binding, "anchor" | "consumers" | "producer">,
  level: FrameLevel, works = false): boolean {
  if (works && level === 3) {
    if (binding.anchor === null) return !graph.horizon.includes(binding.producer.node)
      || binding.consumers.every(endpoint => graph.horizon.includes(endpoint.node));
    const anchor = graph.anchors.find(item => item.id === binding.anchor), connector = graph.connectors.find(item => item.id === flow.connector);
    return graph.horizon.includes(binding.producer.node) && !binding.consumers.some(endpoint => graph.horizon.includes(endpoint.node))
      && !!anchor && anchor.id === workAnchorId(flow.connector, flow.key, binding.producer)
      && anchor.owner === binding.producer.node && anchor.outcome === flow.artifact
      && graph.nodes.some(node => node.id === anchor.owner && node.outcome === anchor.outcome && node.tests.includes(anchor.test))
      && graph.tests.some(test => test.id === anchor.test && test.node === binding.producer.node && test.covers.includes(flow.connector))
      && connector?.wakeTest === (upper.connectors.find(item => item.id === flow.connector)?.wakeTest ?? anchor.test)
      && graph.tests.some(test => test.id === connector?.wakeTest);
  }
  if (flow.anchor === binding.anchor) return true;
  if (level !== 3 || flow.anchor !== null || binding.anchor === null
    || upper.connectors.find(item => item.id === flow.connector)?.bindings.some(item => item.level === level - 1 && item.anchor === binding.anchor)
    || binding.consumers.some(endpoint => graph.horizon.includes(endpoint.node))) return false;
  const anchor = graph.anchors.find(item => item.id === binding.anchor), connector = graph.connectors.find(item => item.id === flow.connector);
  return !!anchor && anchor.outcome === flow.artifact && graph.nodes.some(node => node.id === anchor.owner && node.outcome === anchor.outcome)
    && graph.tests.some(test => test.id === anchor.test) && !!connector?.wakeTest && graph.tests.some(test => test.id === connector.wakeTest);
}
interface FlowFault { connector: string; message: string; obligations: string[] }
type FlowFill = Omit<FrameFill, "basis">;
function flowFaults(upper: Graph, graph: Graph, obligations: FrameObligation[], rows: Map<string, FlowFill[]>, level: FrameLevel,
  partial: boolean, works = false, assignedFlow?: (flow: FrameFlow, delivery: Binding) => void): FlowFault[] {
  const faults: FlowFault[] = [];
  const flows = upperFlows(upper, level).map(flow => {
    const ends = obligations.filter(item => item.connector === flow.connector && item.flow === flow.key);
    const producers = rows.get(ends.find(item => item.role === "producer")!.id) ?? [];
    if (producers.length > 1) faults.push({ connector: flow.connector, obligations: ends.map(item => item.id),
      message: "An upper flow has several lower producers" });
    return { flow, ends, producer: producers[0], consumers: new Set(ends.filter(item => item.role === "consumer")
      .flatMap(item => (rows.get(item.id) ?? []).map(frameEndpointKey))), actual: new Set<string>() };
  });
  const fault = (items: typeof flows, connector: string, message: string) => faults.push({ connector, message,
    obligations: items.flatMap(item => item.ends.map(end => end.id)) });
  // A verified partial frame leaves retired deliveries in the graph. Only unrepresented deliveries
  // are ignored; every delivery belonging to a carried producer and anchor still has one whole flow.
  for (const connector of graph.connectors) {
    const expected = flows.filter(item => item.flow.connector === connector.id);
    if (!expected.length) continue;
    const deliveries = new Map<string, Binding>();
    for (const binding of connector.bindings.filter(item => item.level === level)) {
      const key = flowKey(binding), delivery = deliveries.get(key);
      if (delivery) {
        if (works && canonical(delivery.producer.codeRef ?? null) !== canonical(binding.producer.codeRef ?? null))
          fault(expected, connector.id, "One lower producer cannot have different code references across its deliveries");
        delivery.consumers.push(...binding.consumers);
      }
      else deliveries.set(key, { ...binding, consumers: [...binding.consumers] });
    }
    for (const delivery of deliveries.values()) {
      const owners = expected.filter(item => item.producer && frameEndpointKey(item.producer) === frameEndpointKey(delivery.producer)
        && acceptsFlowAnchor(upper, graph, item.flow, delivery, level, works));
      if (partial && !owners.length) continue;
      const consumers = delivery.consumers.map(frameEndpointKey);
      if (new Set(consumers).size !== consumers.length)
        fault(owners, connector.id, "The same consumer occurs twice in one accepted lower flow");
      const candidates = owners.filter(item => consumers.every(endpoint => item.consumers.has(endpoint)));
      if (candidates.length !== 1) {
        fault(owners.length ? owners : expected, connector.id, "Each accepted lower flow must correspond to exactly one whole upper flow");
        continue;
      }
      const assigned = candidates[0]!;
      if (assignedFlow) for (const binding of connector.bindings.filter(item => item.level === level && flowKey(item) === flowKey(delivery)))
        assignedFlow(assigned.flow, binding);
      if (works) for (const [role, endpoints] of [["producer", [delivery.producer]], ["consumer", delivery.consumers]] as const)
        for (const endpoint of endpoints) {
          const fills = assigned.ends.filter(item => item.role === role).flatMap(item => rows.get(item.id) ?? [])
            .filter(row => frameEndpointKey(row) === frameEndpointKey(endpoint));
          if (fills.some(row => row.source === "accepted" ? canonical(row.codeRef ?? null) !== canonical(endpoint.codeRef ?? null)
            : Object.hasOwn(endpoint, "codeRef")))
            fault([assigned], connector.id, "A recorded code reference must match its exact lower flow endpoint");
        }
      for (const endpoint of consumers) {
        if (assigned.actual.has(endpoint)) fault([assigned], connector.id, "An upper consumer is repeated across active and sleeping deliveries");
        assigned.actual.add(endpoint);
      }
    }
  }
  for (const item of flows) {
    const { flow, producer, consumers, actual } = item;
    if ((producer && actual.size === 0) || consumers.size !== actual.size || [...consumers].some(endpoint => !actual.has(endpoint)))
      fault([item], flow.connector, "The complete accepted lower flow differs from its recorded producer and consumers");
  }
  return faults;
}
function checkFlowCorrespondence(upper: Graph, graph: Graph, obligations: FrameObligation[], rows: Map<string, FrameFill[]>, level: FrameLevel,
  code: "frame_record_invalid" | "accepted_binding_ambiguous", target: string, partial = false, works = false): void {
  const first = flowFaults(upper, graph, obligations, rows, level, partial, works)[0];
  if (first) frameReject(code, target, first.connector, first.message);
}
function fillMismatch(upper: Graph, graph: Graph, obligation: FrameObligation | undefined, row: FlowFill, level: FrameLevel,
  relations: RefinementRelations, works = false): string | null {
  const node = graph.nodes.find(item => item.id === row.node);
  if (!obligation || !node || LEVEL[node.kind] !== level || !relations.refines(node.id, obligation.upper.node))
    return "A recorded endpoint does not refine its obligation";
  if (works) {
    if (obligation.kind !== "connection-end" || row.source === "identity") {
      if (Object.hasOwn(row, "codeRef")) return "Only a real connection end carries a code reference";
    } else if (!Object.hasOwn(row, "codeRef") || !frameCodeShape(row.codeRef)
      || !node.code.some(code => canonical(code) === canonical(row.codeRef)))
      return "A real work endpoint needs one exact declared code reference";
  }
  if (obligation.kind !== "connection-end")
    return row.port !== undefined || node.outcome !== obligation.artifact ? "An outcome fill must produce this upper outcome" : null;
  const port = node.ports.find(item => item.id === row.port), artifact = upper.artifacts.find(item => item.id === obligation.artifact);
  return !port || port.direction !== (obligation.role === "producer" ? "out" : "in") || port.contract !== artifact?.contract
    ? "A recorded endpoint has a different port direction or contract" : null;
}
const isFrameFill = (row: unknown): row is FrameFill => frameObject(row) && frameText(row['obligation']) && frameText(row['node'])
  && (row['port'] === undefined || frameText(row['port'])) && (row['source'] === "accepted" || row['source'] === "identity") && isRef(row['basis']);

function checkedAccepted(upper: Graph, accepted: AcceptedFrame, obligations: FrameObligation[], level: FrameLevel, permittedOpen: Set<string>): Map<string, FrameFill[]> | null {
  if (canonical(projectGraph(upper, (level - 1) as 1 | 2)) !== canonical(projectGraph(accepted.graph, (level - 1) as 1 | 2)))
    frameReject("frame_upper_drift", accepted.reference.id, "upper", "The accepted lower layer uses a different upper layer", "owner");
  if (!/^graph:[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(accepted.reference.id) || accepted.reference.hash !== hashJson(accepted.graph)) frameReject("frame_record_invalid", accepted.reference.id, "hash", "The accepted graph differs from its exact reference");
  if (!accepted.frame) return null;
  const { reference: frameRef, value } = accepted.frame;
  if (Object.hasOwn(value, "worksContract") && (level !== 3 || value.worksContract !== WORKS_FRAME_CONTRACT))
    frameReject("frame_record_invalid", frameRef.id, "worksContract", "The work correspondence contract must be known and apply to L3");
  if (!frameObject(value) || !frameText(value.project) || value.level !== level || !frameHash(value.candidateHash)
    || !frameHash(value.layerHash) || !Array.isArray(value.fills) || accepted.reference.id !== `graph:${value.project}`
    || frameRef.id !== `om-frame:${value.project}:${level}` || frameRef.hash !== hashJson(value))
    frameReject("frame_record_invalid", frameRef.id, "frame", "The accepted frame must identify its project, level and exact content");
  if (value.layerHash !== hashJson(projectGraph(accepted.graph, level)))
    frameReject("frame_layer_drift", frameRef.id, "layerHash", "The layer changed outside its accepted frame", "owner");
  return checkedRows(upper, accepted.graph, obligations, value.fills, level, frameRef.id, permittedOpen, value.worksContract === WORKS_FRAME_CONTRACT);
}
function checkedRows(upper: Graph, graph: Graph, obligations: FrameObligation[], fills: FrameFill[], level: FrameLevel,
  target: string, permittedOpen: Set<string>, works = false): Map<string, FrameFill[]> {
  if (canonical(fills) !== canonical(frameSorted(fills)))
    frameReject("frame_record_invalid", target, "fills", "The accepted fill set must retain canonical order");
  const byObligation = new Map(obligations.map(item => [item.id, item])), rows = new Map<string, FrameFill[]>();
  const relations = new RefinementRelations(graph), classification = new Map<string, string>(), identities = new Map<string, string>();
  const identityForUpper = new Map<string, string>();
  for (const row of fills) {
    if (!isFrameFill(row))
      frameReject("frame_record_invalid", target, "fills", "A recorded fill needs its source, exact basis and endpoint");
    const obligation = byObligation.get(row.obligation), mismatch = fillMismatch(upper, graph, obligation, row, level, relations, works);
    if (mismatch) frameReject("frame_record_invalid", target, row.obligation, mismatch);
    const node = graph.nodes.find(item => item.id === row.node)!;
    if (!obligation) frameReject("frame_record_invalid", target, row.obligation, "A recorded endpoint needs its obligation");
    if (classification.has(node.id) && classification.get(node.id) !== row.source)
      frameReject("frame_record_invalid", target, row.obligation, "One accepted node cannot be both identity and real");
    classification.set(node.id, row.source);
    if (row.source === "identity") {
      if (identities.has(node.id) && identities.get(node.id) !== obligation.upper.node)
        frameReject("frame_record_invalid", target, row.obligation, "An identity node represents exactly one upper node");
      if (identityForUpper.has(obligation.upper.node) && identityForUpper.get(obligation.upper.node) !== node.id)
        frameReject("frame_record_invalid", target, row.obligation, "An upper node has exactly one identity representative");
      identities.set(node.id, obligation.upper.node); identityForUpper.set(obligation.upper.node, node.id);
    }
    const prior = rows.get(row.obligation) ?? [];
    if (prior.some(item => item.node === row.node && item.port === row.port))
      frameReject("frame_record_invalid", target, row.obligation, "The same recorded endpoint is duplicated");
    prior.push(row); rows.set(row.obligation, prior);
  }
  for (const obligation of obligations) {
    const mine = rows.get(obligation.id);
    if (!mine?.length && permittedOpen.has(obligation.id)) continue;
    if (!mine?.length || (obligation.role !== "consumer" && mine.length !== 1))
      frameReject("frame_record_invalid", target, obligation.id, "The accepted mapping must cover each source obligation with its declared cardinality");
  }
  checkFlowCorrespondence(upper, graph, obligations, rows, level, "frame_record_invalid", target, permittedOpen.size > 0, works);
  return rows;
}
function historicalFills(upper: Graph, graph: Graph, obligation: FrameObligation, level: FrameLevel, relations: RefinementRelations,
  preserveCode = false): Endpoint[] {
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
  return preserveCode ? result : [...new Map(result.map(endpoint => [canonical([endpoint.node, endpoint.port]), endpoint])).values()];
}
/** Pure correspondence projection; it neither admits a layer nor supplies acceptance provenance. */
export interface FrameFlowSource {
  obligations: FrameObligation[]; fills: FlowFill[] | null; worksContract?: typeof WORKS_FRAME_CONTRACT;
}
export interface FrameFlowRead {
  upper: Binding;
  ends: { role: "producer" | "consumer"; upper: Endpoint; lower: Endpoint }[];
}
export function readFrameFlow(upper: Graph, graph: Graph, source: FrameFlowSource, connector: string,
  binding: Binding): OmResult<Sealed<FrameFlowRead>> {
  requireFrameGraph(upper, "upper"); requireFrameGraph(graph, "graph"); requireFlow(binding);
  const level = binding.level; requireFrameLevel(level);
  if (!frameText(connector) || !frameObject(source) || !Array.isArray(source.obligations)
    || !source.obligations.every(item => isFrameObligation(item, level))
    || (Object.hasOwn(source, "worksContract") && (level !== 3 || source.worksContract !== WORKS_FRAME_CONTRACT))
    || (source.fills !== null && (!Array.isArray(source.fills) || !source.fills.every(row => frameObject(row)
      && frameText(row.obligation) && frameText(row.node) && ["accepted", "identity"].includes(row.source)
      && (!Object.hasOwn(row, "port") || frameText(row.port))
      && (!Object.hasOwn(row, "codeRef") || frameCodeShape(row.codeRef)))))) frameInvalid("flow.source", connector);
  return frameResult(() => {
    upper = frameCopy(upper); graph = frameCopy(graph); source = frameCopy(source); binding = frameCopy(binding);
    const upperConnector = upper.connectors.find(item => item.id === connector), lowerConnector = graph.connectors.find(item => item.id === connector);
    if (!upperConnector || !lowerConnector || upperConnector.artifact !== lowerConnector.artifact
      || !upperConnector.bindings.some(item => item.level === level - 1))
      frameReject("frame_record_invalid", connector, "connector", "The whole flow needs the same connection at both levels");
    // Other connections may still be open in a partial accepted frame. This query proves this connection only.
    upper = { ...upper, connectors: [upperConnector] }; graph = { ...graph, connectors: [lowerConnector] };
    const obligations = obligationsOf(upper, { nodes: [], excluded: [], hash: hashJson([]) }, level)
      .filter(item => item.kind === "connection-end");
    const supplied = source.obligations.filter(item => item.connector === connector);
    if (canonical(frameSorted(supplied.map(obligationContent))) !== canonical(frameSorted(obligations.map(obligationContent))))
      frameReject("frame_record_invalid", connector, "obligations", "The flow must retain every exact upper-end obligation");
    const rows = new Map<string, FlowFill[]>(), relations = new RefinementRelations(graph);
    if (source.fills?.some(row => !source.obligations.some(item => item.id === row.obligation)))
      frameReject("frame_record_invalid", connector, "fills", "A flow fill must name its declared obligation");
    for (const obligation of obligations) {
      const entries: FlowFill[] = source.fills === null
        ? historicalFills(upper, graph, obligation, level, relations, true).map(endpoint => ({
          obligation: obligation.id, node: endpoint.node, port: endpoint.port, source: "accepted",
          ...(source.worksContract && endpoint.codeRef ? { codeRef: endpoint.codeRef } : {}),
        }))
        : source.fills.filter(row => row.obligation === obligation.id);
      for (const row of entries) {
        const mismatch = fillMismatch(upper, graph, obligation, row, level, relations, source.worksContract === WORKS_FRAME_CONTRACT);
        if (mismatch) frameReject("frame_record_invalid", connector, obligation.id, mismatch);
      }
      if (source.fills !== null && new Set(entries.map(frameEndpointKey)).size !== entries.length)
        frameReject("frame_record_invalid", connector, obligation.id, "The same recorded flow endpoint is duplicated");
      // Historical inference can encounter the same end in several physical deliveries of one flow.
      rows.set(obligation.id, source.fills === null
        ? [...new Map(entries.map(row => [canonical(row), row])).values()] : entries);
    }
    const group = lowerConnector.bindings.filter(item => item.level === level && flowKey(item) === flowKey(binding));
    const grouped = group.length ? { ...group[0]!, consumers: frameSorted(group.flatMap(item => item.consumers)) } : null;
    const normalized = (item: Binding) => ({ ...item, consumers: frameSorted(item.consumers) });
    if (!group.some(item => canonical(normalized(item)) === canonical(normalized(binding)))
      && canonical(grouped) !== canonical(normalized(binding)))
      frameReject("frame_record_invalid", connector, "binding", "The query must name an exact lower binding or its complete grouped flow");
    const assigned = new Map<string, FrameFlow>();
    const faults = flowFaults(upper, graph, obligations, rows, level, true, source.worksContract === WORKS_FRAME_CONTRACT,
      (flow, delivery) => { if (flowKey(delivery) === flowKey(binding)) assigned.set(flow.key, flow); });
    if (faults.length) frameReject("frame_record_invalid", connector, "flow", faults[0]!.message);
    if (assigned.size !== 1) frameReject("accepted_binding_ambiguous", connector, "flow",
      "The requested lower flow requires exactly one upper flow");
    const flow = [...assigned.values()][0]!;
    const ends: FrameFlowRead["ends"] = obligations.filter(item => item.flow === flow.key).flatMap(obligation =>
      (rows.get(obligation.id) ?? []).map(row => ({ role: obligation.role!,
        upper: { node: obligation.upper.node, port: obligation.upper.port! },
        lower: { node: row.node, port: row.port!, ...(row.codeRef ? { codeRef: row.codeRef } : {}) },
      })));
    return { upper: { level: level - 1 as 1 | 2, producer: flow.producer, consumers: flow.consumers, anchor: flow.anchor }, ends };
  });
}

/** Extract code only at a new-candidate boundary; this does not admit an accepted layer or change historical fills. */
export function workFillCode(upper: Graph, accepted: AcceptedFrame, obligation: FrameObligation, fill: FrameFill): OmResult<Sealed<CodeRef>> {
  requireFrameGraph(upper, "upper");
  if (!frameObject(accepted) || !isRef(accepted.reference) || !Object.hasOwn(accepted, "frame")) frameInvalid("accepted");
  requireFrameGraph(accepted.graph, "accepted.graph");
  if (accepted.frame !== null && (!frameObject(accepted.frame) || !isRef(accepted.frame.reference) || !frameObject(accepted.frame.value)))
    frameInvalid("accepted.frame");
  if (!isFrameObligation(obligation, 3) || !isFrameFill(fill)) frameInvalid("fill");
  return frameResult(() => {
    upper = frameCopy(upper); accepted = frameCopy(accepted); obligation = frameCopy(obligation); fill = frameCopy(fill);
    const obligations = obligationsOf(upper, { nodes: [], excluded: [], hash: hashJson([]) }, 3);
    const source = obligations.find(item => item.id === obligation.id);
    if (!source || canonical(obligationContent(source)) !== canonical(obligationContent(obligation))
      || obligation.kind !== "connection-end" || fill.obligation !== obligation.id || fill.source !== "accepted" || !frameText(fill.port))
      frameReject("works_code_foreign", fill.node, "codeRef", "Only an accepted real end of this exact upper flow supplies code");
    const saved = Array.isArray(accepted.frame?.value.fills) ? accepted.frame.value.fills : [];
    // A rebase may intentionally leave unrepresented flows. Its provenance is admitted by the common C2 reader,
    // while extraction checks every represented correspondence and grants no authority to the missing rows.
    const permittedOpen = new Set(obligations.filter(item => !saved.some(row => row.obligation === item.id)).map(item => item.id));
    const recorded = checkedAccepted(upper, accepted, obligations, 3, permittedOpen);
    const endpoints: Endpoint[] = [];
    if (recorded) {
      if (!(recorded.get(obligation.id) ?? []).some(row => row.source === "accepted" && frameEndpointKey(row) === frameEndpointKey(fill)))
        frameReject("works_code_foreign", fill.node, "codeRef", "The exact saved correspondence does not contain this real endpoint");
      const faults = flowFaults(upper, accepted.graph, obligations, recorded, 3, permittedOpen.size > 0,
        accepted.frame!.value.worksContract === WORKS_FRAME_CONTRACT, (flow, delivery) => {
          if (flow.connector === obligation.connector && flow.key === obligation.flow)
            endpoints.push(...(obligation.role === "producer" ? [delivery.producer] : delivery.consumers)
              .filter(endpoint => frameEndpointKey(endpoint) === frameEndpointKey(fill)));
        });
      if (faults.length) frameReject("frame_record_invalid", accepted.frame!.reference.id, faults[0]!.connector, faults[0]!.message);
    } else endpoints.push(...historicalFills(upper, accepted.graph, obligation, 3, new RefinementRelations(accepted.graph), true)
      .filter(endpoint => frameEndpointKey(endpoint) === frameEndpointKey(fill)));
    if (!endpoints.length || endpoints.some(endpoint => !Object.hasOwn(endpoint, "codeRef")))
      frameReject("works_code_missing", fill.node, "codeRef", "Every exact accepted flow endpoint must retain its code reference");
    const node = accepted.graph.nodes.find(item => item.id === fill.node);
    for (const endpoint of endpoints) if (!frameCodeShape(endpoint.codeRef)
      || !node?.code.some(code => canonical(code) === canonical(endpoint.codeRef)))
      frameReject("works_code_foreign", fill.node, "codeRef", "The accepted endpoint code must exactly match a declared work code reference");
    const distinct = [...new Map(endpoints.map(endpoint => [canonical(endpoint.codeRef), endpoint.codeRef!])).values()];
    if (distinct.length !== 1) frameReject("works_code_missing", fill.node, "codeRef", "One exact accepted flow end must identify one code reference");
    return distinct[0]!;
  });
}
export function fillObligations(upper: Graph, scope: FrameScope, accepted: AcceptedFrame | null, upperRef: Ref, level: FrameLevel): OmResult<Sealed<FilledFrame>> {
  return fillFrame(upper, scope, accepted, upperRef, level, new Set());
}
function fillFrame(upper: Graph, scope: FrameScope, accepted: AcceptedFrame | null, upperRef: Ref, level: FrameLevel, permittedOpen: Set<string>): OmResult<Sealed<FilledFrame>> {
  requireFrameGraph(upper, "upper"); requireFrameScope(scope); requireFrameLevel(level);
  if (!isRef(upperRef)) frameInvalid("upperRef");
  if (accepted !== null) {
    if (!frameObject(accepted) || !isRef(accepted.reference) || !Object.hasOwn(accepted, "frame")) frameInvalid("accepted");
    requireFrameGraph(accepted.graph, "accepted.graph");
    if (accepted.frame !== null && (!frameObject(accepted.frame) || !isRef(accepted.frame.reference) || !frameObject(accepted.frame.value))) frameInvalid("accepted.frame");
  }
  return frameResult(() => {
    if (accepted?.frame && Object.hasOwn(accepted.frame.value, "worksContract")
      && (level !== 3 || accepted.frame.value.worksContract !== WORKS_FRAME_CONTRACT))
      frameReject("frame_record_invalid", accepted.frame.reference.id, "worksContract", "The work correspondence contract must be known and apply to L3");
    upper = frameCopy(upper); scope = frameCopy(scope); accepted = frameCopy(accepted); upperRef = frameCopy(upperRef);
    const obligations = obligationsOf(upper, scope, level);
    const recorded = accepted ? checkedAccepted(upper, accepted, obligations, level, permittedOpen) : null;
    return fillResolved(upper, accepted, upperRef, level, obligations, recorded);
  });
}
function fillResolved(upper: Graph, accepted: AcceptedFrame | null, upperRef: Ref, level: FrameLevel,
  obligations: FrameObligation[], recorded: Map<string, FrameFill[]> | null): FilledFrame {
  const fills: FrameFill[] = [], open: FrameObligation[] = [];
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
        ...(accepted!.frame?.value.worksContract === WORKS_FRAME_CONTRACT && row.codeRef ? { codeRef: row.codeRef } : {}),
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
}

export interface FrameCarrySource { obligations: FrameObligation[]; fills: FrameFill[]; worksContract?: typeof WORKS_FRAME_CONTRACT }
export interface CarriedFrame { fills: FrameFill[]; retired: FrameFill[]; open: FrameObligation[] }
function isFrameObligation(value: unknown, level: FrameLevel): value is FrameObligation {
  if (!frameObject(value) || !frameHash(value['id']) || value['level'] !== level
    || !["block-outcome", "operation-outcome", "connection-end"].includes(value['kind'] as string)
    || !frameObject(value['upper']) || !frameText(value['upper']['node']) || !frameText(value['artifact'])
    || !["horizon", "outside"].includes(value['zone'] as string)) return false;
  return value['kind'] === "connection-end" ? frameText(value['upper']['port']) && frameText(value['connector'])
    && ["producer", "consumer"].includes(value['role'] as string) && frameHash(value['flow'])
    : value['kind'] === (level === 2 ? "block-outcome" : "operation-outcome") && value['upper']['port'] === undefined
      && value['connector'] === undefined && value['role'] === undefined && value['flow'] === undefined;
}
const obligationContent = ({ zone: _zone, ...value }: FrameObligation) => value;
/** Carry only rows that still satisfy the same requirement and complete flow on the new upper basis. */
export function carryFrameFills(upper: Graph, scope: FrameScope, accepted: Pick<AcceptedFrame, "graph" | "reference">,
  previous: FrameCarrySource, upperRef: Ref, level: FrameLevel): OmResult<Sealed<CarriedFrame>> {
  requireFrameGraph(upper, "upper"); requireFrameScope(scope); requireFrameLevel(level);
  if (!frameObject(accepted) || !isRef(accepted.reference)) frameInvalid("accepted");
  requireFrameGraph(accepted.graph, "accepted.graph");
  if (!frameObject(previous) || !Array.isArray(previous.obligations) || !Array.from(previous.obligations).every(item => isFrameObligation(item, level))
    || !Array.isArray(previous.fills) || !Array.from(previous.fills).every(isFrameFill)) frameInvalid("previous");
  if (!isRef(upperRef)) frameInvalid("upperRef");
  return frameResult(() => {
    if (Object.hasOwn(previous, "worksContract") && (level !== 3 || previous.worksContract !== WORKS_FRAME_CONTRACT))
      frameReject("frame_record_invalid", accepted.reference.id, "worksContract", "The carried work contract must be known and apply to L3");
    upper = frameCopy(upper); scope = frameCopy(scope); accepted = frameCopy(accepted); previous = frameCopy(previous); upperRef = frameCopy(upperRef);
    const works = previous.worksContract === WORKS_FRAME_CONTRACT;
    if (accepted.reference.hash !== hashJson(accepted.graph))
      frameReject("frame_record_invalid", accepted.reference.id, "hash", "The carried graph differs from its exact reference");
    if (canonical(projectGraph(upper, (level - 1) as 1 | 2)) !== canonical(projectGraph(accepted.graph, (level - 1) as 1 | 2)))
      frameReject("frame_upper_drift", accepted.reference.id, "upper", "The carried graph must preserve its named new upper", "owner");
    const obligations = obligationsOf(upper, scope, level), old = new Map(previous.obligations.map(item => [item.id, item]));
    if (old.size !== previous.obligations.length) frameInvalid("previous.obligations");
    const byId = new Map(obligations.map(item => [item.id, item])), relations = new RefinementRelations(accepted.graph);
    let fills = previous.fills.filter(row => {
      const obligation = byId.get(row.obligation), before = old.get(row.obligation);
      return obligation && before && canonical(obligationContent(obligation)) === canonical(obligationContent(before))
        && fillMismatch(upper, accepted.graph, obligation, row, level, relations, works) === null;
    });
    const groups = upperFlows(upper, level).map(flow => obligations.filter(item => item.connector === flow.connector && item.flow === flow.key));
    const invalid = new Set<string>();
    for (const group of groups) {
      const first = group[0]!, prior = previous.obligations.filter(item => item.connector === first.connector && item.flow === first.flow);
      if (canonical(frameSorted(group.map(obligationContent))) !== canonical(frameSorted(prior.map(obligationContent)))
        || group.some(item => !fills.some(fill => fill.obligation === item.id)))
        for (const item of group) invalid.add(item.id);
    }
    fills = fills.filter(fill => !invalid.has(fill.obligation));
    const rowsOf = (values: FrameFill[]) => {
      const rows = new Map<string, FrameFill[]>();
      for (const fill of values) rows.set(fill.obligation, [...(rows.get(fill.obligation) ?? []), fill]);
      return rows;
    };
    while (true) {
      const faults = flowFaults(upper, accepted.graph, obligations, rowsOf(fills), level, true, works);
      const unfit = new Set(faults.flatMap(fault => fault.obligations));
      const kept = fills.filter(fill => !unfit.has(fill.obligation));
      if (kept.length === fills.length) break;
      fills = kept;
    }
    fills = frameSorted(fills);
    const kept = new Set(fills), retired = frameSorted(previous.fills.filter(fill => !kept.has(fill)));
    // This is the structural absence in the saved mapping, including outside-horizon requirements.
    const open = obligations.filter(item => !fills.some(fill => fill.obligation === item.id));
    const rows = checkedRows(upper, accepted.graph, obligations, fills, level, accepted.reference.id, new Set(open.map(item => item.id)), works);
    fillResolved(upper, { ...accepted, frame: null }, upperRef, level, obligations, rows);
    return { fills, retired, open };
  });
}

/** Exact historical inputs. `upper` supplies the accepted L2 witness for work frames. */
export interface FrameRequest {
  project: string; level: FrameLevel; horizon: Ref; graph: Ref; layer: Ref | null; frame: Ref | null;
  upper: { horizon: Ref; frame: Ref | null } | null;
  workZoneContract?: "accepted-l2-v1";
}
export interface FrameRead {
  request: FrameRequest; upper: Graph; upperRef: Ref; scope: FrameScope;
  accepted: AcceptedFrame | null; result: FilledFrame; references: Ref[];
}
export interface FrameBasis extends Omit<FrameRead, "result"> { obligations: FrameObligation[]; permittedOpen: string[] }
export interface PreparedFrame extends FrameRead {
  guards: Ref[];
  // C5 must CAS all three writes in its single acceptance transaction. In particular a missing frame is
  // protected by expected.frame=0; Store read guards describe existing revisions, never absence.
  expected: { graph: number; layer: number; frame: number };
}
export interface HorizonBasisRequest { project: string; graph: Ref; horizon: Ref }
export interface PreparedHorizonBasis { horizon: HorizonRecords; upperRef: Ref; upper: Graph; guards: Ref[] }
type FrameLayer = LayerBasis;
function frameTake<T>(result: OmResult<T>): T {
  if (!result.ok) throw new FrameFailure(result.refusal);
  return result.value;
}
function requireFrameRequest(request: unknown): asserts request is FrameRequest {
  if (!frameObject(request) || !frameText(request['project'])) frameInvalid("request");
  requireFrameLevel(request['level']);
  if (Object.hasOwn(request, 'workZoneContract')
    && (request['level'] !== 3 || request['workZoneContract'] !== 'accepted-l2-v1')) frameInvalid("workZoneContract");
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
function frameLayerAcceptance(store: Store, request: Parameters<typeof readLayerAcceptance>[1]) {
  const basis = readLayerAcceptance(store, request);
  if (!basis.ok) frameReject("frame_basis_unproven", basis.refusal.at.target,
    basis.refusal.at.field ?? "acceptance", basis.refusal.message);
  return basis.value;
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
function horizonBasisSources(store: Store, request: HorizonBasisRequest, refs: Ref[]): {
  horizon: HorizonRecords; graph: Graph; upperRef: Ref; upper: Graph;
} {
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
  return { horizon, graph, upperRef: l1ref, upper: frameProjection(graph, 1) };
}
function frameSources(store: Store, request: FrameRequest): FrameBasis {
  const refs: Ref[] = [];
  const { horizon, graph, upperRef: l1ref } = horizonBasisSources(store, request, refs);
  const inputRef = horizon.horizon.value.request.input;
  const ownerScope = horizon.horizon.value.result.horizon;
  let scope: FrameScope = { nodes: ownerScope.nodes, excluded: ownerScope.excluded, hash: ownerScope.hash };
  let upperRef: Ref = l1ref;
  if (request.upper) {
    const witness = frameAcceptedHorizon(store, request.project, request.upper.horizon, refs);
    if (canonical(witness.horizon.value.request.input) !== canonical(inputRef))
      frameReject("frame_basis_unproven", request.upper.horizon.id, "input", "The accepted L2 must belong to this OM input");
    const phaseRef = witness.horizon.value.request.refinement;
    if (!phaseRef) frameReject("frame_basis_unproven", request.upper.horizon.id, "refinement", "The upper witness must prove accepted L2");
    if (phaseRef.id === `graph-layer:${request.project}:2`) {
      const basis = frameLayerAcceptance(store, { project: request.project, level: 2, graph: request.graph, layer: phaseRef });
      if (basis.producer !== "om" || canonical(basis.frame) !== canonical(request.upper.frame))
        frameReject("frame_basis_unproven", phaseRef.id, "upper.frame", "The OM upper layer needs its exact accepted connection frame");
      refs.push(...basis.references);
      upperRef = phaseRef;
    } else {
      const phase = frameReadRecord<{ layer: Ref }>(store, phaseRef, `phase:${request.project}:L2`, "phase", refs);
      upperRef = phase.value.layer;
    }
    const l2 = frameReadLayer(store, upperRef, request.project, 2, refs);
    frameCompareUpper(l2.value, graph, 2, l2.id);
    const upperFrame = frameReadConnection(store, request.project, 2, request.upper.frame, refs);
    frameTake(fillObligations(frameProjection(graph, 1), scope,
      { graph, reference: request.graph, frame: upperFrame }, l1ref, 2));
    // Entering the new block horizon reopens identity obligations; it does not turn the saved identity into
    // a real operation. Read that classification from the validated accepted frame before zone filtering.
    const identities = new Set((upperFrame?.value.fills ?? []).filter(fill => fill.source === "identity").map(fill => fill.node));
    // Unmarked saved requests retain the full-graph derivation of their producer's era.
    const relations = request.workZoneContract === undefined ? new RefinementRelations(graph) : null;
    const nodes = relations
      ? graph.nodes.filter(node => node.kind === "operation" && !identities.has(node.id)
        && ownerScope.nodes.some(block => ownerScope.execution[block]?.state === "needed" && relations.refines(node.id, block)))
        .map(node => node.id).sort(frameOrder)
      : [...frameTake(workZone(frameProjection(graph, 2), ownerScope, [...identities]))];
    scope = { nodes, excluded: ownerScope.excluded, hash: hashJson([ownerScope.hash, 3, nodes]) };
  }
  let accepted: AcceptedFrame | null = null;
  let permittedOpen: string[] = [];
  if (request.layer) {
    const lower = frameReadLayer(store, request.layer, request.project, request.level, refs);
    const omBasis = lower.value.acceptance !== undefined ? frameLayerAcceptance(store,
      { project: request.project, level: request.level, graph: request.graph, layer: request.layer }) : null;
    if (omBasis) {
      if (omBasis.producer !== "om" || canonical(omBasis.upper) !== canonical(upperRef)
        || canonical(omBasis.frame) !== canonical(request.frame))
        frameReject("frame_basis_unproven", request.layer.id, "frame", "The OM layer needs its exact accepted upper and connection frame");
      refs.push(...omBasis.references);
      permittedOpen = [...omBasis.open];
    } else {
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
    }
    accepted = { graph, reference: request.graph, frame: frameReadConnection(store, request.project, request.level, request.frame, refs) };
  } else if (request.frame) frameReject("frame_basis_unproven", request.frame.id, "layer", "A connection frame requires an accepted lower layer");
  const upper = frameProjection(graph, (request.level - 1) as 1 | 2);
  const obligations = frameTake(frameObligations(upper, scope, request.level)) as FrameObligation[];
  return { request, upper, upperRef, scope, accepted, obligations, permittedOpen,
    references: frameSorted([...new Map(refs.map(ref => [canonical(ref), ref])).values()]) };
}
/** Resolve the common exact upper sources without prematurely inventing lower fills. */
export function readFrameBasis(store: Store, request: FrameRequest): OmResult<Sealed<FrameBasis>> {
  if (!(store instanceof Store)) frameInvalid("store");
  requireFrameRequest(request);
  return frameResult(() => frameBasis(store, frameCopy(request)));
}
function frameBasis(store: Store, request: FrameRequest): FrameBasis {
  return historicalProof(store, { reader: "C2.frameBasis", project: request.project, ref: request.graph,
    parameters: request as unknown as Json }, source => frameCopy(frameSources(source, request)),
  () => frameReject("frame_basis_unproven", request.graph.id, "history", "The exact frame basis must not depend on itself"));
}
function frameDerive(store: Store, request: FrameRequest): FrameRead {
  const { obligations: _obligations, permittedOpen, ...basis } = frameBasis(store, request);
  const result = frameTake(fillFrame(basis.upper, basis.scope, basis.accepted, basis.upperRef, request.level, new Set(permittedOpen)));
  return { ...basis, result: result as FilledFrame };
}
function frameReading(store: Store, request: FrameRequest): FrameRead {
  return historicalProof(store, { reader: "C2.frameDerive", project: request.project, ref: request.graph,
    parameters: request as unknown as Json }, source => frameCopy(frameDerive(source, request)),
  () => frameReject("frame_basis_unproven", request.graph.id, "history", "The exact frame derivation must not depend on itself"));
}
/** History is checked exclusively through immutable exact references, even after heads move. */
export function readFrame(store: Store, request: FrameRequest): OmResult<Sealed<FrameRead>> {
  if (!(store instanceof Store)) frameInvalid("store");
  requireFrameRequest(request);
  return frameResult(() => frameReading(store, frameCopy(request)));
}
function frameCurrentSources(store: Store) {
  const guards = new Map<string, Ref>();
  const remember = (ref: Ref) => {
    const previous = guards.get(ref.id);
    if (previous && canonical(previous) !== canonical(ref))
      frameReject("input_stale", ref.id, "head", "A frame prerequisite changed during preparation");
    guards.set(ref.id, ref);
  };
  const traced = historicalTrace(store, (ref, head) => { if (head) remember(ref); }, 'distinct');
  const current = (ref: Ref) => {
    const head = traced.get(ref.id);
    if (!head || canonical(reference(head)) !== canonical(ref))
      frameReject("input_stale", ref.id, "head", "The frame prerequisite is no longer current");
  };
  const acceptGate = (gate: GateResult, name: string) => {
    const admission = frameTake(readOmAdmissionGuards(gate.admissionGuards, name, "F4"));
    if (gate.findings.length) {
      const finding = gate.findings[0]!;
      frameReject("frame_basis_unproven", finding.target, finding.code, finding.message);
    }
    for (const guard of [...gate.guards, ...admission]) remember(guard);
  };
  return { traced, guards, remember, current, acceptGate };
}
/** Admit a saved horizon against today's graph without requiring its historical graph or refinement heads. */
export function prepareHorizonBasis(store: Store, request: HorizonBasisRequest): OmResult<Sealed<PreparedHorizonBasis>> {
  if (!(store instanceof Store)) frameInvalid("store");
  if (!frameObject(request) || !frameText(request['project'])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request['project'])) frameInvalid("request");
  for (const key of ['graph', 'horizon']) if (!isRef(request[key])) frameInvalid(key);
  request = frameCopy(request);
  return frameResult(() => {
    const { traced, guards, remember, current } = frameCurrentSources(store);
    const basis = horizonBasisSources(traced, request, []);
    const inputRef = basis.horizon.horizon.value.request.input;
    for (const ref of [request.graph, request.horizon, reference(basis.horizon.horizon), inputRef, basis.upperRef,
      ...Object.values(basis.horizon.horizon.value.request.available).flatMap(value => Object.values(value))]) current(ref);
    const prepared = frameTake(prepareExistingOmInput(traced, request.project, inputRef));
    if (!prepared.existing || canonical(reference(prepared.existing)) !== canonical(inputRef))
      frameReject("input_stale", inputRef.id, "input", "The horizon needs the currently admitted OM input");
    for (const guard of prepared.guards) remember(guard);
    return { horizon: basis.horizon, upperRef: basis.upperRef, upper: basis.upper, guards: frameSorted([...guards.values()]) };
  });
}
/** Admit a layer by its producer without introducing an input or horizon dependency. */
export function prepareLayerAcceptance(store: Store, request: LayerAcceptanceRequest): OmResult<Sealed<HistoricalLayerBasis & { guards: Ref[] }>> {
  return frameResult(() => {
    const basis = frameLayerAcceptance(store, request);
    const { traced, guards, current, acceptGate } = frameCurrentSources(store);
    for (const ref of [request.graph, request.layer, ...basis.currentReferences]) current(ref);
    if (basis.producer === "research") {
      const engine = new StageChecks(traced);
      acceptGate(engine.graphs.layerGate(request.project, request.level, request.layer), `layer.${request.level}`);
      const phase = request.level === 2 ? "R1" : "R2";
      acceptGate(engine.refinement.gate(request.project, phase), `refinement.${phase}`);
    }
    return { ...basis, guards: frameSorted([...guards.values()]) };
  });
}
/** New producers save this exact request; historical readers never add its contract. */
export function currentFrameRequest(request: FrameRequest): Sealed<FrameRequest> {
  requireFrameRequest(request);
  const copied = frameCopy(request);
  return copied.level === 3 ? frameCopy({ ...copied, workZoneContract: "accepted-l2-v1" }) : copied;
}
/** Prepare current acceptance without writing; hand the guards and CAS revisions to C5. */
export function prepareFrame(store: Store, request: FrameRequest): OmResult<Sealed<PreparedFrame>> {
  if (!(store instanceof Store)) frameInvalid("store");
  requireFrameRequest(request);
  request = currentFrameRequest(request);
  return frameResult(() => {
    const read = frameReading(store, request);
    const { traced, guards, remember, current, acceptGate } = frameCurrentSources(store);
    const horizonBasis = frameTake(prepareHorizonBasis(traced, { project: request.project, graph: request.graph, horizon: request.horizon }));
    for (const guard of horizonBasis.guards) remember(guard);
    for (const ref of [...(request.layer ? [request.layer] : []),
      ...(request.frame ? [request.frame] : []), ...(request.upper ? [request.upper.horizon, ...(request.upper.frame ? [request.upper.frame] : [])] : [])]) current(ref);
    const frameHead = traced.get(`om-frame:${request.project}:${request.level}`);
    if (!request.frame && frameHead) frameReject("input_stale", frameHead.id, "frame", "An existing frame cannot be omitted");
    if (request.upper && !request.upper.frame && traced.get(`om-frame:${request.project}:2`))
      frameReject("input_stale", `om-frame:${request.project}:2`, "upper.frame", "The accepted upper frame cannot be omitted");
    const layerHead = traced.get<FrameLayer>(`graph-layer:${request.project}:${request.level}`);
    if (!request.layer && (layerHead?.value.acceptance !== undefined || layerHead?.value.layerProofs?.some(proof => proof.level === request.level)))
      frameReject("frame_basis_unproven", layerHead.id, "layer", "An accepted lower layer cannot be omitted");
    const engine = new StageChecks(traced);
    if (request.layer) {
      const admission = frameTake(prepareLayerAcceptance(store,
        { project: request.project, level: request.level, graph: request.graph, layer: request.layer }));
      for (const guard of admission.guards) remember(guard);
    }
    const gates: { name: string; gate: GateResult }[] = [];
    if (request.upper) {
      const witness = frameTake(readHorizon(traced, request.project, request.upper.horizon));
      current(reference(witness.horizon));
      current(witness.horizon.value.request.refinement!);
      if (witness.horizon.value.request.refinement!.id === `graph-layer:${request.project}:2`) {
        const upper = frameLayerAcceptance(traced, { project: request.project, level: 2, graph: request.graph, layer: read.upperRef });
        for (const ref of upper.currentReferences) current(ref);
      } else gates.push({ name: "refinement.L2", gate: engine.refinement.gate(request.project, "L2") },
        { name: "layer.2", gate: engine.graphs.layerGate(request.project, 2, read.upperRef) });
    }
    for (const { name, gate } of gates) acceptGate(gate, name);
    return { ...read, guards: frameSorted([...guards.values()]),
      expected: { graph: request.graph.revision, layer: layerHead?.revision ?? 0, frame: frameHead?.revision ?? 0 } };
  });
}
