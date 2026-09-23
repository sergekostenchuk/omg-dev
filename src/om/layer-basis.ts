import { Ajv } from "ajv";
import { canonical, digest, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import { Discovery } from "../discovery/discovery.js";
import { LEVEL, type Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { projectGraph } from "../graph/project.js";
import { composeLayer, layerDesignSpec, LAYER_DESIGN_VERSION } from "../graph/layer-design.js";
import { obligationHandoff } from "../graph/obligation-handoff.js";
import { requireTaskObligations } from "../graph/task-obligations.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import { readRecord } from "./refs.js";
import { gateCandidate, type CandidateGate, type FrameCandidateRecord } from "./frame-candidate.js";
import { readFrame, readFrameBasis, carryFrameFills, type FrameFill, type FrameRequest, type ConnectionFrame, type FrameCarrySource } from "./frame-obligations.js";
import type { LayerProposal } from "./frame-proposals.js";

export const LAYER_BASIS_REFUSAL_CODES = Object.freeze(["layer_basis_request_invalid", "layer_basis_unproven"] as const);
export interface LayerBasis {
  projection: ReturnType<typeof projectGraph>;
  inputs: Ref[];
  obligations: { node: string; field: string; valueHash: string; inputs: Ref[] }[];
  layerProofs?: { level: 1 | 2 | 3; hash: string; inputs: Ref[] }[];
  acceptance?: { producer: "om"; frame: Ref };
}
export interface LayerEnvelopeRequest { project: string; level: 1 | 2 | 3; graph: Ref; layer: Ref }
export interface HistoricalLayerRequest extends LayerEnvelopeRequest { level: 2 | 3; upper: Ref }
export interface LayerEnvelope { graph: Revision<Graph>; layer: Revision<LayerBasis>; references: Ref[] }
export interface HistoricalLayerBasis {
  references: Ref[]; producer: "research" | "om"; upper: Ref; frame: Ref | null; currentReferences: Ref[]; open: string[];
}
export interface LayerAcceptanceRequest extends LayerEnvelopeRequest { level: 2 | 3 }
export interface OmFrameAcceptance {
  producer: "om"; candidate: Ref; gate: CandidateGate & { name: "G3" }; graph: Ref; upper: Ref;
}
export interface OmAcceptedFrame {
  project: string; level: 2; candidateHash: string; layerHash: string; upperHash: string; lowerHash: string;
  fills: FrameFill[]; acceptance: OmFrameAcceptance;
}
export interface FrameRebaseRequest { from: FrameRequest; to: FrameRequest }
export interface OmRebasedFrame extends ConnectionFrame {
  level: 3; upperHash: string; lowerHash: string; retired: FrameFill[]; rebasedFrom: Ref; rebase: FrameRebaseRequest;
}
export interface RebaseBasis {
  frame: OmRebasedFrame; upper: Ref; references: Ref[]; currentReferences: Ref[]; open: string[];
}
export interface RebasedLayerRequest {
  frame: OmRebasedFrame; reference: Ref; graph: Graph; upper: Revision<LayerBasis>; previous: Revision<LayerBasis>;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: T[]) => [...values].sort((a, b) => order(canonical(a), canonical(b)));
interface HistoricalReads { checked: Map<string, HistoricalLayerBasis>; active: Set<string> }
const historicalReads = new WeakMap<Store, HistoricalReads>();
function withinHistoricalRead<T>(store: Store, action: () => T): T {
  if (historicalReads.has(store)) return action();
  historicalReads.set(store, { checked: new Map(), active: new Set() });
  try { return action(); } finally { historicalReads.delete(store); }
}
const schemas = new Ajv({ strict: true, allowUnionTypes: true });
const graphShapes = [schemas.compile(sealed(graphSchema)), schemas.compile(sealed(graphV2Schema))];
class BasisFailure extends Error {
  constructor(readonly target: string, readonly field: string, message: string) { super(message); }
}
function reject(target: string, field: string, message: string): never { throw new BasisFailure(target, field, message); }
function exactRecord<T>(store: Store, ref: Ref, id: string, kind: string, refs: Ref[]): Revision<T> {
  const result = readRecord<T>(store, ref, { unit: "layer-basis", target: id, id, kind });
  if (!result.ok) reject(result.refusal.at.target, result.refusal.at.field ?? "reference", result.refusal.message);
  refs.push(reference(result.value));
  return result.value as Revision<T>;
}
function validLayer(value: unknown, level: 1 | 2 | 3): value is LayerBasis {
  return object(value) && object(value['projection']) && value['projection']['level'] === level
    && Array.isArray(value['inputs']) && value['inputs'].every(isRef) && Array.isArray(value['obligations'])
    && value['obligations'].every(item => object(item) && text(item['node']) && text(item['field']) && hash(item['valueHash'])
      && Array.isArray(item['inputs']) && item['inputs'].every(isRef))
    && (value['layerProofs'] === undefined || Array.isArray(value['layerProofs']) && value['layerProofs'].every(proof => object(proof)
      && [1, 2, 3].includes(proof['level'] as number) && hash(proof['hash']) && Array.isArray(proof['inputs']) && proof['inputs'].every(isRef)));
}
function readLayer(store: Store, ref: Ref, project: string, level: 1 | 2 | 3, refs: Ref[]): Revision<LayerBasis> {
  const saved = exactRecord<LayerBasis>(store, ref, `graph-layer:${project}:${level}`, "graph-layer", refs), layer = saved.value;
  if (!validLayer(layer, level))
    reject(ref.id, "layer", "The saved layer has an invalid proof envelope");
  if (Object.hasOwn(layer, "acceptance") && (!object(layer.acceptance) || layer.acceptance.producer !== "om"
    || !isRef(layer.acceptance.frame))) reject(ref.id, "acceptance", "The layer must name its explicit OM acceptance producer");
  return saved;
}
function requireRequest(store: Store, request: unknown): asserts request is LayerEnvelopeRequest {
  if (!(store instanceof Store) || !object(request) || !text(request['project'])
    || (request['level'] !== 1 && request['level'] !== 2 && request['level'] !== 3)
    || !isRef(request['graph']) || !isRef(request['layer'])) invalidRequest();
}
function invalidRequest(): never {
  throw new EngineError("layer_basis_request_invalid", "Historical layer admission needs its project, level and exact bases",
    { unit: "layer-basis", target: "layer", field: "request" });
}
function result<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) {
    if (error instanceof BasisFailure) return refused("layer_basis_unproven", error.message,
      { unit: "layer-basis", target: error.target, field: error.field }, "producer");
    throw error;
  }
}
function envelope(store: Store, request: LayerEnvelopeRequest): LayerEnvelope {
  const { project, level, graph: graphRef, layer: layerRef } = request, refs: Ref[] = [];
  const graph = exactRecord<Graph>(store, graphRef, `graph:${project}`, "graph", refs);
  if (!object(graph.value) || !graphShapes[graph.value.version === 2 ? 1 : 0]!(graph.value))
    reject(graphRef.id, "graph", "The saved graph has an invalid shape");
  const layer = readLayer(store, layerRef, project, level, refs);
  if (canonical(layer.value.projection) !== canonical(projectGraph(graph.value, level)))
    reject(layerRef.id, "layer", "The saved layer differs from the graph");
  for (const proof of layer.value.layerProofs ?? []) {
    if (proof.hash !== hashJson(projectGraph(graph.value, proof.level)))
      reject(layerRef.id, "layerProofs", "The saved proof differs from its projected layer");
  }
  for (const obligation of layer.value.obligations) {
    const node = graph.value.nodes.find(item => item.id === obligation.node);
    if (!node || !Object.hasOwn(node, obligation.field)
      || hashJson((node as unknown as Record<string, unknown>)[obligation.field]) !== obligation.valueHash)
      reject(layerRef.id, "obligations", "An inherited field must preserve its exact evidence-backed value");
  }
  if (canonical(unique(layer.value.inputs)) !== canonical(unique([
    ...layer.value.obligations.flatMap(item => item.inputs), ...(layer.value.layerProofs ?? []).flatMap(item => item.inputs),
  ]))) reject(layerRef.id, "inputs", "The layer must retain the complete guard envelope of its proofs");
  return { graph, layer, references: refs };
}
const unique = (items: Ref[]) => sorted([...new Map(items.map(ref => [canonical(ref), ref])).values()]);
/** Legacy consumers use the same envelope rules without inventing research requirements for their era. */
export function readLayerEnvelope(store: Store, request: LayerEnvelopeRequest): OmResult<Sealed<LayerEnvelope>> {
  requireRequest(store, request);
  return result(() => envelope(store, request));
}
/** A historical proof names immutable sources; it does not assert that their heads or files are current. */
export function readLayerBasis(store: Store, request: HistoricalLayerRequest): OmResult<Sealed<HistoricalLayerBasis>> {
  requireRequest(store, request);
  if ((request.level !== 2 && request.level !== 3) || !isRef(request.upper)) invalidRequest();
  return result(() => withinHistoricalRead(store, () => historicalBasis(store, request, envelope(store, request))));
}
/** Resolve the producer's recorded upper basis rather than a current graph-layer head. */
export function readLayerAcceptance(store: Store, request: LayerAcceptanceRequest): OmResult<Sealed<HistoricalLayerBasis>> {
  requireRequest(store, request);
  if (request.level !== 2 && request.level !== 3) invalidRequest();
  return result(() => withinHistoricalRead(store, () => {
    const found = envelope(store, request), proofs = found.layer.value.layerProofs ?? [];
    const own = proofs.filter(proof => proof.level === request.level);
    if (own.length !== 1) reject(request.layer.id, "layerProofs", "An accepted layer needs exactly one own derivation proof");
    const uppers = unique(own[0]!.inputs.filter(ref => ref.id === `graph-layer:${request.project}:${request.level - 1}`));
    if (uppers.length !== 1) reject(request.layer.id, "upper", "The producer must name one exact upper basis");
    return historicalBasis(store, { ...request, upper: uppers[0]! }, found);
  }));
}
function historicalBasis(store: Store, request: HistoricalLayerRequest, found: LayerEnvelope): HistoricalLayerBasis {
  const reads = historicalReads.get(store)!, key = canonical(request);
  const checked = reads.checked.get(key);
  if (checked) return checked;
  if (reads.active.has(key)) reject(request.layer.id, "acceptance", "A historical layer cannot depend cyclically on its own acceptance");
  reads.active.add(key);
  try {
    const checked = verifyHistoricalBasis(store, request, found);
    reads.checked.set(key, checked);
    return checked;
  } finally { reads.active.delete(key); }
}
function verifyHistoricalBasis(store: Store, request: HistoricalLayerRequest, found: LayerEnvelope): HistoricalLayerBasis {
  const { project, level, layer: layerRef, upper: upperRef } = request;
  const graph = found.graph.value, lower = found.layer, refs = found.references;
  const upper = readLayer(store, upperRef, project, (level - 1) as 1 | 2, refs);
  if (canonical(upper.value.projection) !== canonical(projectGraph(graph, (level - 1) as 1 | 2)))
    reject(upperRef.id, "upper", "The lower layer must retain its exact upper projection");
  const proofs = lower.value.layerProofs ?? [], own = proofs.filter(proof => proof.level === level);
  if (own.length !== 1 || proofs.some(proof => proof.level > level))
    reject(layerRef.id, "layerProofs", "The lower layer needs exactly one own derivation proof and no later proofs");
  const bases = unique(own[0]!.inputs.filter(ref => ref.id === upperRef.id));
  if (bases.length !== 1 || canonical(bases[0]) !== canonical(upperRef))
    reject(layerRef.id, "upper", "The own proof must name exactly this accepted upper basis");
  const frame = lower.value.acceptance?.frame ?? null;
  let open: string[] = [], currentReferences = frame ? [upperRef, frame] : [request.graph, request.layer, upperRef];
  if (frame && level === 3) {
    const rebase = proveRebasedLayer(store, request, found);
    refs.push(...rebase.references); open = rebase.open;
    currentReferences = [...rebase.currentReferences, frame];
  } else if (frame) proveOmLayer(store, project, graph, lower, upperRef, refs);
  else proveLayer(store, project, graph, lower, upperRef, refs);
  return { references: unique(refs), producer: frame ? "om" : "research", upper: upperRef, frame,
    currentReferences: unique(currentReferences), open };
}

/** The accepted fill retains its exact source, while proposed becomes accepted. */
export function acceptedCandidateFills(fills: FrameCandidateRecord['fills']): Sealed<FrameFill[]> {
  if (!Array.isArray(fills) || !fills.every(fill => object(fill) && text(fill.obligation) && text(fill.node)
    && (fill.port === undefined || text(fill.port)) && ["accepted", "proposed", "identity"].includes(fill.source)
    && isRef(fill.basis))) invalidRequest();
  return sealed(sorted(fills.map(fill => ({ ...fill, source: fill.source === "proposed" ? "accepted" as const : fill.source }))));
}
/** Only a producer's explicit pre-acceptance envelope can justify an unavailable lower-frame source. */
export function readUnacceptedLayer(store: Store, request: LayerAcceptanceRequest): OmResult<Sealed<{
  references: Ref[]; currentReferences: Ref[];
}>> {
  requireRequest(store, request);
  if (request.level !== 2 && request.level !== 3) invalidRequest();
  return result(() => {
    const found = envelope(store, request), { layer, graph } = found;
    const nativeUnaccepted = !Object.hasOwn(layer.value, "acceptance")
      && !(layer.value.layerProofs ?? []).some(proof => proof.level >= request.level);
    const lowerKinds = request.level === 2 ? ["operation", "work"] : ["work"];
    if (!nativeUnaccepted || graph.value.version !== 2 && graph.value.nodes.some(node => lowerKinds.includes(node.kind)))
      reject(layer.id, "acceptance", "This producer does not establish that the lower layer is still unaccepted");
    return { references: found.references, currentReferences: unique([request.graph, request.layer]) };
  });
}
/** Hash the layer's own nodes, bindings and dependent definitions, excluding its inherited upper. */
export function lowerLayerHash(graph: Graph, level: 2 | 3): string {
  if ((level !== 2 && level !== 3) || !object(graph) || !graphShapes[graph.version === 2 ? 1 : 0]!(graph)) invalidRequest();
  const projection = projectGraph(graph, level), upper = projectGraph(graph, (level - 1) as 1 | 2);
  const own = (key: "anchors" | "joins" | "tests" | "edges" | "transfers" | "packets") => {
    const inherited = new Set((upper[key] ?? []).map(value => hashJson(value)));
    return sorted((projection[key] ?? []).filter(value => !inherited.has(hashJson(value))));
  };
  return hashJson({ nodes: sorted(projection.nodes.filter(node => node.kind === (level === 2 ? "operation" : "work"))),
    bindings: sorted(projection.connectors.map(connector => ({ id: connector.id, wakeTest: connector.wakeTest ?? null,
      bindings: sorted(connector.bindings.filter(binding => binding.level === level)) })).filter(connector => connector.bindings.length)),
    anchors: own("anchors"), joins: own("joins"), tests: own("tests"), edges: own("edges"),
    transfers: own("transfers"), packets: own("packets"), horizon: sorted(projection.horizon) });
}
/** Shared accepted-body derivation: the writer and historical reader must not define different acceptance records. */
export function omAcceptedFrame(candidate: Revision<FrameCandidateRecord>, gate: CandidateGate | Sealed<CandidateGate>, graph: Ref, upper: Ref): Sealed<OmAcceptedFrame> {
  if (!object(candidate) || !isRef(candidate) || candidate.kind !== "frame-candidate" || candidate.revision !== 1
    || !object(candidate.value) || !text(candidate.value.project) || candidate.value.level !== 2
    || !object(candidate.value.graph) || !graphShapes[candidate.value.graph.version === 2 ? 1 : 0]!(candidate.value.graph)
    || !object(candidate.value.base) || !isRef(candidate.value.base.graph)
    || candidate.value.base.frame !== null && !isRef(candidate.value.base.frame)
    || !hash(candidate.value.graphHash) || !hash(candidate.value.layerHash) || !hash(candidate.value.upperHash)
    || !isRef(graph) || !isRef(upper) || !object(gate) || gate.passed !== true || !isRef(gate.candidate)
    || !hash(gate.graphHash) || !Array.isArray(gate.findings) || gate.findings.length !== 0) invalidRequest();
  const value = candidate.value;
  if (candidate.hash !== hashJson(value) || canonical(gate.candidate) !== canonical(reference(candidate))
    || gate.graphHash !== value.graphHash || graph.id !== `graph:${value.project}` || graph.hash !== value.graphHash
    || graph.revision !== value.base.graph.revision + 1 || upper.id !== `graph-layer:${value.project}:1`
    || value.graphHash !== hashJson(value.graph) || value.layerHash !== hashJson(projectGraph(value.graph, 2))
    || value.upperHash !== hashJson(projectGraph(value.graph, 1))) invalidRequest();
  return sealed({ project: value.project, level: 2, candidateHash: value.graphHash, layerHash: value.layerHash,
    upperHash: value.upperHash, lowerHash: lowerLayerHash(value.graph, 2), fills: acceptedCandidateFills(value.fills),
    acceptance: { producer: "om", candidate: reference(candidate), gate: { name: "G3", ...gate }, graph, upper } });
}

function proveOmLayer(store: Store, project: string, graph: Graph, lower: Revision<LayerBasis>, upperRef: Ref, refs: Ref[]): void {
  const frameRef = lower.value.acceptance!.frame;
  if (lower.value.projection.level !== 2) reject(lower.id, "acceptance.level", "OM work-layer acceptance requires the future F2/F5 contract");
  const frame = exactRecord<OmAcceptedFrame>(store, frameRef, `om-frame:${project}:2`, "connection-frame", refs).value;
  if (!object(frame) || frame.project !== project || frame.level !== 2 || !hash(frame.candidateHash)
    || !hash(frame.layerHash) || !hash(frame.upperHash) || !hash(frame.lowerHash) || !Array.isArray(frame.fills)
    || !object(frame.acceptance) || frame.acceptance.producer !== "om" || !isRef(frame.acceptance.candidate) || !isRef(frame.acceptance.graph)
    || !isRef(frame.acceptance.upper) || !object(frame.acceptance.gate))
    reject(frameRef.id, "acceptance", "An OM layer requires its complete accepted frame and exact candidate gate");
  const witness = frame.acceptance;
  const traced = new Proxy(store, { get(target, key) {
    if (key === "get") return <T>(id: string, revision?: number): Revision<T> | null => {
      const record = target.get<T>(id, revision);
      if (record) refs.push(reference(record));
      return record;
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const reads = historicalReads.get(store);
  if (reads) historicalReads.set(traced, reads);
  try {
    const candidate = exactRecord<FrameCandidateRecord>(traced, witness.candidate, witness.candidate.id, "frame-candidate", refs);
    const gate = gateCandidate(traced, { project, candidate: witness.candidate });
    if (!gate.ok) reject(gate.refusal.at.target, `acceptance.${gate.refusal.at.field ?? "gate"}`, gate.refusal.message);
    if (canonical(witness.gate) !== canonical({ ...gate.value, name: "G3" }))
      reject(frameRef.id, "acceptance.gate", "The recorded OM gate must equal the code-verified outcome for its exact candidate");
    const savedGraph = exactRecord<Graph>(store, witness.graph, `graph:${project}`, "graph", refs);
    const value = candidate.value;
    const source = readFrame(traced, value.request.frame);
    if (!source.ok) reject(source.refusal.at.target, `acceptance.${source.refusal.at.field ?? "upper"}`, source.refusal.message);
    if (canonical(source.value.upperRef) !== canonical(upperRef))
      reject(frameRef.id, "acceptance.upper", "OM acceptance must retain the exact upper admitted by the candidate producer");
    if (canonical(savedGraph.value) !== canonical(value.graph) || witness.graph.revision !== value.base.graph.revision + 1
      || frameRef.revision !== (value.base.frame?.revision ?? 0) + 1)
      reject(frameRef.id, "acceptance.graph", "The OM result must be the exact candidate graph at the transition from its named base");
    const expected = omAcceptedFrame(candidate, gate.value, witness.graph, upperRef);
    if (canonical(frame) !== canonical(expected))
      reject(frameRef.id, "acceptance.fills", "The accepted frame must derive completely from the exact candidate and verified gate");
    if (canonical(witness.upper) !== canonical(upperRef)
      || canonical(projectGraph(savedGraph.value, 2)) !== canonical(projectGraph(graph, 2)))
      reject(frameRef.id, "acceptance.upper", "The accepted OM result must retain its exact upper basis and lower projection");
    for (const ref of value.proposals) {
      const original = exactRecord<LayerProposal>(store, ref, ref.id, "layer-proposal", refs);
      const accepted = store.get<LayerProposal>(ref.id, ref.revision + 1);
      const expected = { ...original.value, status: "accepted", verdict: {
        candidateHash: value.graphHash, candidate: witness.candidate, codes: [],
      } };
      if (!accepted || accepted.kind !== "layer-proposal" || canonical(accepted.value) !== canonical(expected))
        reject(ref.id, "acceptance.proposals", "OM acceptance must retain every exact proposed-to-accepted transition");
      refs.push(reference(accepted));
    }
    const upper = readLayer(store, upperRef, project, 1, refs).value;
    const proof = { level: 2, hash: value.layerHash, inputs: unique([upperRef, witness.candidate, frameRef]) };
    if (canonical(lower.value.obligations) !== canonical(upper.obligations)
      || canonical(lower.value.layerProofs) !== canonical([...(upper.layerProofs ?? []), proof]))
      reject(lower.id, "acceptance.inputs", "The OM layer must retain exactly its upper proof envelope and own accepted transition");
  } finally { historicalReads.delete(traced); }
}

function validRebaseRequest(request: unknown): request is FrameRebaseRequest {
  const frame = (value: unknown): value is FrameRequest => object(value) && text(value['project']) && value['level'] === 3
    && isRef(value['graph']) && isRef(value['horizon']) && (value['layer'] === null || isRef(value['layer']))
    && (value['frame'] === null || isRef(value['frame'])) && object(value['upper']) && isRef(value['upper']['horizon'])
    && (value['upper']['frame'] === null || isRef(value['upper']['frame']));
  return object(request) && frame(request['from']) && frame(request['to'])
    && request['from'].project === request['to'].project && isRef(request['from'].layer) && isRef(request['from'].frame)
    && request['to'].layer === null && request['to'].frame === null && isRef(request['to'].upper?.frame);
}
function requireRebaseRequest(store: Store, request: unknown): asserts request is FrameRebaseRequest {
  if (!(store instanceof Store) || !validRebaseRequest(request)) invalidRequest();
}
function rebaseTake<T>(value: OmResult<T>): T {
  if (!value.ok) reject(value.refusal.at.target, `rebase.${value.refusal.at.field ?? "source"}`, value.refusal.message);
  return value.value;
}
/** A rebase carries a previously accepted mapping; it never claims a new work-layer candidate or G5. */
export function readRebaseBasis(store: Store, request: FrameRebaseRequest): OmResult<Sealed<RebaseBasis>> {
  requireRebaseRequest(store, request);
  return result(() => withinHistoricalRead(store, () => {
    const before = rebaseTake(readFrame(store, request.from));
    const after = rebaseTake(readFrameBasis(store, request.to));
    const project = request.to.project, refs = [...before.references, ...after.references];
    const upper = rebaseTake(readLayerAcceptance(store, { project, level: 2, graph: request.to.graph, layer: after.upperRef }));
    if (upper.producer !== "om" || canonical(upper.frame) !== canonical(request.to.upper!.frame))
      reject(after.upperRef.id, "rebase.upper", "The new work basis must be the exact accepted OM upper frame");
    refs.push(...upper.references);
    const acceptedUpper = exactRecord<OmAcceptedFrame>(store, upper.frame!, `om-frame:${project}:2`, "connection-frame", refs);
    if (canonical(acceptedUpper.value.acceptance.graph) !== canonical(request.to.graph))
      reject(request.to.graph.id, "rebase.graph", "Rebase must use the graph actually written by the named upper acceptance");
    let frame = acceptedUpper;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(canonical(reference(frame)))) reject(frame.id, "rebase.chain", "The accepted upper transition chain is cyclic");
      visited.add(canonical(reference(frame)));
      const candidate = exactRecord<FrameCandidateRecord>(store, frame.value.acceptance.candidate,
        frame.value.acceptance.candidate.id, "frame-candidate", refs);
      if (canonical(candidate.value.base.graph) === canonical(request.from.graph)) break;
      const previousFrame = candidate.value.base.frame, previousLayer = candidate.value.request.frame.layer;
      if (!previousFrame || !previousLayer) reject(frame.id, "rebase.chain", "The upper acceptance does not descend from the named previous work graph");
      const previous = rebaseTake(readLayerAcceptance(store, { project, level: 2, graph: candidate.value.base.graph, layer: previousLayer }));
      if (previous.producer !== "om" || canonical(previous.frame) !== canonical(previousFrame))
        reject(previousLayer.id, "rebase.chain", "Every intermediate upper change must have its own exact accepted OM frame");
      refs.push(...previous.references);
      frame = exactRecord<OmAcceptedFrame>(store, previousFrame, `om-frame:${project}:2`, "connection-frame", refs);
      if (canonical(frame.value.acceptance.graph) !== canonical(candidate.value.base.graph))
        reject(previousFrame.id, "rebase.chain", "An intermediate acceptance must be the actual base of its successor");
    }
    const graph = exactRecord<Graph>(store, request.to.graph, `graph:${project}`, "graph", refs).value;
    const originalGraph = exactRecord<Graph>(store, request.from.graph, `graph:${project}`, "graph", refs).value;
    if (lowerLayerHash(originalGraph, 3) !== lowerLayerHash(graph, 3))
      reject(request.to.graph.id, "rebase.lower", "A rebase cannot change the accepted work layer's own content");
    const old = exactRecord<ConnectionFrame & Partial<OmRebasedFrame>>(store, request.from.frame!, `om-frame:${project}:3`, "connection-frame", refs).value;
    const oldLayer = readLayer(store, request.from.layer!, project, 3, refs);
    if (old.retired !== undefined && (!object(oldLayer.value.acceptance)
      || canonical(oldLayer.value.acceptance.frame) !== canonical(request.from.frame) || !old.rebase || !Array.isArray(old.retired)))
      reject(request.from.frame!.id, "rebase.retired", "Retired fills need their exact prior verified OM rebase event");
    const carried = rebaseTake(carryFrameFills(after.upper as Graph, after.scope as Parameters<typeof carryFrameFills>[1],
      { graph, reference: request.to.graph }, { obligations: before.result.obligations, fills: old.fills } as FrameCarrySource,
      after.upperRef, request.to.level));
    const fills = carried.fills as FrameFill[], retired = sorted([...(old.retired ?? []), ...carried.retired]);
    const rebased: OmRebasedFrame = { project, level: 3, candidateHash: old.candidateHash,
      layerHash: hashJson(projectGraph(graph, 3)), upperHash: hashJson(projectGraph(graph, 2)), lowerHash: lowerLayerHash(graph, 3),
      fills, retired, rebasedFrom: request.from.frame!, rebase: request };
    return { frame: rebased, upper: after.upperRef, references: unique(refs),
      currentReferences: unique([after.upperRef, upper.frame!]),
      open: carried.open.map(obligation => obligation.id).sort(order) };
  }));
}
/** The writer and historical verifier derive the same explicitly carried proof envelope. */
export function buildRebasedLayer(request: RebasedLayerRequest): Sealed<LayerBasis> {
  if (!object(request) || !object(request.frame) || !isRef(request.reference) || !object(request.graph)
    || !graphShapes[request.graph.version === 2 ? 1 : 0]!(request.graph) || !isRef(request.upper) || !isRef(request.previous)
    || !validLayer(request.upper.value, 2) || !validLayer(request.previous.value, 3) || !validRebaseRequest(request.frame.rebase)
    || !text(request.frame.project) || !hash(request.frame.candidateHash) || !hash(request.frame.layerHash)
    || !hash(request.frame.upperHash) || !hash(request.frame.lowerHash) || !Array.isArray(request.frame.fills)
    || !Array.isArray(request.frame.retired) || !isRef(request.frame.rebasedFrom)) invalidRequest();
  const { frame, graph, upper, previous } = request, project = frame.project;
  for (const rows of [frame.fills, frame.retired]) {
    if (!Array.from(rows).every(fill => object(fill) && ["accepted", "identity"].includes(fill.source))) invalidRequest();
    let normalized: Sealed<FrameFill[]>;
    try { normalized = acceptedCandidateFills(sealed(rows) as FrameCandidateRecord['fills']); }
    catch (error) {
      if (error instanceof EngineError && error.code === "unsealable_value") invalidRequest();
      throw error;
    }
    if (canonical(rows) !== canonical(normalized)) invalidRequest();
  }
  if (frame.level !== 3 || request.reference.id !== `om-frame:${project}:3` || request.reference.hash !== hashJson(frame)
    || request.reference.revision !== frame.rebase.from.frame!.revision + 1
    || upper.id !== `graph-layer:${project}:2` || previous.id !== `graph-layer:${project}:3`
    || canonical(reference(previous)) !== canonical(frame.rebase.from.layer)
    || hashJson(graph) !== frame.rebase.to.graph.hash || canonical(upper.value.projection) !== canonical(projectGraph(graph, 2))
    || frame.layerHash !== hashJson(projectGraph(graph, 3)) || frame.upperHash !== hashJson(projectGraph(graph, 2))
    || frame.lowerHash !== lowerLayerHash(graph, 3)) invalidRequest();
  const workIds = new Set(graph.nodes.filter(node => LEVEL[node.kind] === 3).map(node => node.id));
  const obligations = sorted([...new Map([...upper.value.obligations, ...previous.value.obligations.filter(item => workIds.has(item.node))]
    .map(item => [canonical(item), item])).values()]);
  const own = { level: 3 as const, hash: frame.layerHash,
    inputs: unique([reference(upper), reference(previous), frame.rebase.from.frame!, request.reference]) };
  const proofs = [...(upper.value.layerProofs ?? []), own];
  return sealed({ projection: projectGraph(graph, 3), obligations, layerProofs: proofs,
    inputs: unique([...obligations.flatMap(item => item.inputs), ...proofs.flatMap(item => item.inputs)]),
    acceptance: { producer: "om", frame: request.reference } });
}
function proveRebasedLayer(store: Store, request: HistoricalLayerRequest, found: LayerEnvelope): RebaseBasis {
  const frameRef = found.layer.value.acceptance!.frame, refs: Ref[] = [];
  const frame = exactRecord<OmRebasedFrame>(store, frameRef, `om-frame:${request.project}:3`, "connection-frame", refs);
  if (!object(frame.value) || !object(frame.value.rebase)) reject(frameRef.id, "rebase", "Work-layer OM provenance requires its explicit rebase sources");
  try { requireRebaseRequest(store, frame.value.rebase); }
  catch (error) {
    if (error instanceof EngineError && error.code === "layer_basis_request_invalid") reject(frameRef.id, "rebase", "The saved rebase request is malformed");
    throw error;
  }
  if (found.layer.revision !== frame.value.rebase.from.layer!.revision + 1 || frameRef.revision !== frame.value.rebase.from.frame!.revision + 1)
    reject(frameRef.id, "rebase.transition", "A rebase writes exactly the next layer and frame revisions of its named source");
  const basis = rebaseTake(readRebaseBasis(store, frame.value.rebase));
  if (canonical(basis.frame) !== canonical(frame.value) || canonical(basis.upper) !== canonical(request.upper)
    || canonical(frame.value.rebase.to.graph) !== canonical(request.graph))
    reject(frameRef.id, "rebase", "The carried frame must derive completely from its exact old mapping and accepted new upper");
  const upper = readLayer(store, basis.upper, request.project, 2, refs);
  const previous = readLayer(store, frame.value.rebase.from.layer!, request.project, 3, refs);
  const expected = buildRebasedLayer({ frame: frame.value, reference: frameRef, graph: found.graph.value, upper, previous });
  if (canonical(expected) !== canonical(found.layer.value))
    reject(request.layer.id, "rebase.inputs", "The work layer must retain precisely its historical source and new accepted upper envelope");
  return { ...basis as RebaseBasis, references: unique([...basis.references, ...refs]) };
}

// A layer's own hash is only a claim. Re-run its producer's research gate against the exact
// saved inputs and compose the design again; both historical and current readers use this path.
function proveLayer(store: Store, project: string, graph: Graph, lower: Revision<LayerBasis>, upperRef: Ref, refs: Ref[]): void {
  const level = lower.value.projection.level as 2 | 3;
  const proof = lower.value.layerProofs!.find(item => item.level === level)!;
  function check(condition: unknown, field: string, message: string): asserts condition {
    if (!condition) reject(lower.id, `research.${field}`, message);
  }
  const records = new Map<string, Revision<Record<string, unknown>>>();
  const historical = new Map<string, Revision>();
  for (const ref of proof.inputs) {
    const record = store.get<Record<string, unknown>>(ref.id, ref.revision);
    check(record && record.hash === ref.hash && object(record.value), "inputs", "The layer needs its exact saved research prerequisites");
    check(!records.has(ref.id) || canonical(reference(records.get(ref.id)!)) === canonical(ref), "inputs", "A layer proof cannot mix revisions of one prerequisite");
    records.set(ref.id, record); historical.set(canonical([ref.id, ref.revision]), record as Revision); refs.push(ref);
  }
  const saved = (ref: unknown, kind: string): Revision<Record<string, unknown>> => {
    if (!isRef(ref)) reject(lower.id, "research.inputs", "Research must name its exact source");
    const record = records.get(ref.id);
    if (!record || record.kind !== kind || canonical(reference(record)) !== canonical(ref))
      reject(lower.id, "research.inputs", "The layer proof must include this research source");
    return record;
  };
  const products = graph.nodes.filter(node => node.kind === "product");
  check(products.length === 1, "consumer", "Layer research must name the unique product");
  const candidates = [...records.values()].filter(record => record.kind === "discovery-draft"
    && record.value['stage'] === "om-g2" && record.value['level'] === `R${level - 1}` && record.value['consumer'] === products[0]!.id);
  check(candidates.length === 1, "draft", "The layer needs exactly one saved design research draft");
  const draftRecord = candidates[0]!;
  const draft = draftRecord.value;
  check(draftRecord.id.startsWith(`discovery:${project}:`) && draft['projectId'] === project && draft['contractVersion'] === LAYER_DESIGN_VERSION
    && object(draft['fields']) && Object.hasOwn(draft['fields'], "layerDesign") && draft['derivations'] === undefined
    && Array.isArray(draft['inputs']) && draft['inputs'].every(isRef) && Array.isArray(draft['questions'])
    && draft['questions'].length === 1 && draft['questions'].every(text), "draft", "Layer research must retain its assessed design contract and explicit inputs");
  const inputs = draft['inputs'] as Ref[];
  for (const input of inputs) {
    const record = records.get(input.id);
    check(record && canonical(reference(record)) === canonical(input), "inputs", "The design lost its exact input");
  }
  const research = records.get(`phase:${project}:R${level - 1}`);
  check(research?.kind === "phase" && research.value['projectId'] === project && research.value['phase'] === `R${level - 1}`
    && isRef(research.value['draft']) && research.value['layer'] === null && Array.isArray(research.value['inputs'])
    && research.value['inputs'].every(isRef) && (research.value['contractVersion'] === undefined || research.value['contractVersion'] === 2),
  "phase", "Layer research needs its saved research predecessor");
  const researchInputs = research.value['inputs'] as Ref[];
  check(researchInputs.some(ref => canonical(ref) === canonical(research.value['draft'])), "phase", "The research milestone must retain its draft");
  for (const ref of researchInputs) {
    const record = store.get(ref.id, ref.revision);
    check(record && record.hash === ref.hash, "phase.inputs", "The accepted research predecessor has lost an exact source");
    refs.push(ref);
  }
  const researchDraft = exactRecord<Record<string, unknown>>(store, research.value['draft'] as Ref,
    (research.value['draft'] as Ref).id, "discovery-draft", refs);
  check(researchDraft.id.startsWith(`discovery:${project}:`) && object(researchDraft.value) && researchDraft.value['projectId'] === project
    && researchDraft.value['stage'] === "om-g2" && researchDraft.value['level'] === `R${level - 1}`
    && researchDraft.value['consumer'] === "compilation" && Array.isArray(researchDraft.value['inputs'])
    && researchDraft.value['inputs'].every(isRef), "phase.draft", "The predecessor must name its own completed research");
  check(inputs.some(ref => canonical(ref) === canonical(upperRef))
    && inputs.some(ref => canonical(ref) === canonical(reference(research!))), "inputs", "The design must use its accepted upper and research predecessor");
  if (level === 3) {
    const scopeRef = researchInputs.find(ref => ref.id === `research-scope:${project}:R2`);
    if (scopeRef) {
      const scope = exactRecord<Record<string, unknown>>(store, scopeRef, scopeRef.id, "research-scope", refs).value;
      check(object(scope) && scope['projectId'] === project, "scope", "R2 must preserve its own scope");
      if (scope['policy'] !== undefined) {
        const texts = (value: unknown) => Array.isArray(value) && value.every(text);
        check(object(scope['policy']) && Array.isArray(scope['obligations']) && scope['obligations'].every(item =>
          object(item) && object(item['gap']) && text(item['gap']['id'])
          && (item['state'] === "active" || item['state'] === "deferred")
          && (item['wake'] === null || object(item['wake']) && texts(item['wake']['nodes'])
            && texts(item['wake']['paths']) && typeof item['wake']['uiRequired'] === "boolean"))
          && texts(scope['nodes']) && texts(scope['changedPaths']) && typeof scope['uiRequired'] === "boolean"
          && [scope['boundaries'], scope['expansions']].every(items => Array.isArray(items)
            && items.every(item => object(item) && text(item['node']))),
        "scope", "The saved policy scope must retain its obligations and wake conditions");
      }
    }
  }
  let handoff: ReturnType<typeof obligationHandoff> = null;
  try { if (level === 3) handoff = obligationHandoff(store, project, [reference(research)]); }
  catch (error) {
    if (error instanceof EngineError && ["obligation_handoff_foreign", "research_obligation_handoff_invalid",
      "obligation_policy_invalid", "obligation_policy_incomplete"].includes(error.code))
      reject(lower.id, "research.handoff", error.message);
    throw error;
  }
  const spec = layerDesignSpec(level, handoff);
  const questionRecord = records.get((draft['questions'] as string[])[0]!);
  check(questionRecord?.kind === "question" && questionRecord.id.startsWith(`question:${project}:`), "question", "The design question is absent from the proof");
  const question = questionRecord!.value;
  check(question['projectId'] === project && question['draftId'] === draftRecord.id && question['stage'] === "om-g2"
    && question['level'] === `R${level - 1}` && question['consumer'] === products[0]!.id && question['status'] === "answered"
    && isRef(question['answer']) && object(question['spec']) && canonical(question['spec']) === canonical(spec), "question", "The answered question must retain this layer's exact design contract");
  const answer = saved(question['answer'], "research-answer");
  check(answer.id.startsWith(`research-answer:${project}:`) && answer.value['projectId'] === project && answer.value['question'] === questionRecord!.id
    && isRef(answer.value['assessment']) && Object.hasOwn(answer.value, "value"), "answer", "Layer construction requires an assessed answer to its question");
  const assessment = saved(answer.value['assessment'], "research-assessment").value;
  check(assessment['projectId'] === project && isRef(assessment['question']) && isRef(assessment['environment'])
    && text(assessment['researcher']) && text(assessment['assessor']) && assessment['researcher'] !== assessment['assessor']
    && assessment['verdict'] === "supported" && Array.isArray(assessment['reasons']) && assessment['reasons'].every(item => typeof item === "string")
    && Array.isArray(assessment['observations']) && assessment['observations'].length > 0 && Object.hasOwn(assessment, "value"),
  "assessment", "The design needs its saved independent assessment and supporting observations");
  for (const [ref, kind, id] of [[assessment['question'], "question", questionRecord!.id],
    [assessment['environment'], "environment", `environment:${project}`]] as const) {
    const record = exactRecord<Record<string, unknown>>(store, ref as Ref, id, kind, refs);
    check(object(record.value) && record.value['projectId'] === project, kind, "A historical assessment source is malformed or belongs to another project");
    if (kind === "question") check(record.value['draftId'] === draftRecord.id && record.value['stage'] === "om-g2"
      && record.value['level'] === `R${level - 1}` && record.value['consumer'] === products[0]!.id
      && object(record.value['spec']) && canonical(record.value['spec']) === canonical(spec), "issuedQuestion", "Assessment must bind the exact issued question");
    historical.set(canonical([record.id, record.revision]), record as Revision);
  }
  if (assessment['runtimeProofs'] !== undefined) check(Array.isArray(assessment['runtimeProofs'])
    && assessment['runtimeProofs'].every(item => object(item) && text(item['obligation']) && text(item['document'])
      && isRef(item['observation']) && isRef(item['source']) && isRef(item['authorization']) && Array.isArray(item['code']) && item['code'].every(isRef)),
  "runtimeProofs", "Runtime evidence needs its explicit exact dependencies");
  const view = new Proxy(store, { get(target, key) {
    if (key === "get") return (id: string, revision?: number) => revision === undefined ? records.get(id) ?? null
      : historical.get(canonical([id, revision])) ?? null;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const discovery = new Discovery(view);
  // Evidence.verify normally checks today's file. Historical admission instead derives the observation
  // from its immutable captured contents; the native current layer gate still checks live sources later.
  discovery.evidence.verify = observation => {
    check(object(observation) && observation.projectId === project && isRef(observation.source)
      && object(observation.selector) && Object.hasOwn(observation, "value"), "observation", "Evidence needs its source, selector and observed value");
    const source = saved(observation.source, "source");
    check(source.id.startsWith(`source:${project}:`) && source.value['projectId'] === project && typeof source.value['content'] === "string"
      && digest(source.value['content']) === source.value['sha256'] && object(source.value['origin'])
      && (source.value['origin']['kind'] === "file" || source.value['origin']['kind'] === "owner-document") && typeof source.value['origin']['location'] === "string"
      && (source.value['mediaType'] === "text/plain" || source.value['mediaType'] === "application/json"), "source", "Evidence must preserve its exact captured content and origin");
    const content = source.value['content'] as string, selector = observation.selector;
    let value: unknown;
    if (selector.kind === "text-range") {
      check(Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end) && selector.start >= 0
        && selector.end > selector.start && selector.end <= content.length, "selector", "The saved text range is invalid");
      value = content.slice(selector.start, selector.end);
    } else {
      check(selector.kind === "json-pointer" && source.value['mediaType'] === "application/json" && typeof selector.pointer === "string"
        && (selector.pointer === "" || selector.pointer.startsWith("/")), "selector", "The saved JSON pointer is invalid");
      try { value = JSON.parse(content); }
      catch (error) { if (error instanceof SyntaxError) reject(source.id, "research.source", "Saved JSON cannot be parsed"); throw error; }
      if (selector.pointer) for (const encoded of selector.pointer.slice(1).split("/")) {
        check(!/~(?![01])/.test(encoded), "selector", "JSON pointer has an invalid escape");
        const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        check(value !== null && typeof value === "object" && Object.hasOwn(value, key), "selector", "The saved selected field is absent");
        value = (value as Record<string, unknown>)[key];
      }
    }
    return canonical(value) === canonical(observation.value);
  };
  const checked = discovery.gate(project, reference(draftRecord));
  check(checked.findings.length === 0, "gate", checked.findings[0]?.message ?? "The saved design research was not accepted");
  check(canonical(unique(checked.guards)) === canonical(unique(proof.inputs)), "inputs", "The layer must retain its complete native research proof");
  const design = (draft['fields'] as Record<string, unknown>)['layerDesign'];
  check(new Ajv({ strict: true, allowUnionTypes: true }).compile(spec.schema as object)(design),
    "layerDesign", "The saved design violates its layer contract");
  let composed: Graph;
  try {
    composed = composeLayer(graph, level, design, spec.layerAssembly);
    if (handoff) requireTaskObligations(store, project, composed, handoff);
  } catch (error) {
    if (error instanceof EngineError && ["graph_upgrade_required", "layer_design_missing", "derived_field_conflict", "layer_assembly_invalid",
      "graph_invalid", "layer_detail_invalid", "horizon_empty", "upper_layer_drift", "layer_outcome_uncovered", "layer_connector_uncovered",
      "layer_port_unbound", "task_obligation_bindings_invalid"].includes(error.code))
      reject(lower.id, "research.layerDesign", error.message);
    throw error;
  }
  check(canonical(projectGraph(composed, level)) === canonical(lower.value.projection), "layerDesign", "The accepted layer must derive from the exact assessed design");
}
