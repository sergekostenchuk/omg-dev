import { Ajv } from "ajv";
import { canonical, digest, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import { Discovery, readAcceptedResearchAnswer } from "../discovery/discovery.js";
import { LEVEL, type Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { projectGraph } from "../graph/project.js";
import { RefinementRelations } from "../graph/relations.js";
import { composeLayer, layerDesignSpec, LAYER_DESIGN_VERSION } from "../graph/layer-design.js";
import { obligationHandoff } from "../graph/obligation-handoff.js";
import { requireTaskObligations } from "../graph/task-obligations.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import { readRecord } from "./refs.js";
import { gateCandidate, readCandidate, type CandidateGate, type FrameCandidateRecord } from "./frame-candidate.js";
import { WORKS_FRAME_CONTRACT, readFrame, readFrameBasis, carryFrameFills, type FrameFill, type FrameRequest, type ConnectionFrame, type FrameCarrySource } from "./frame-obligations.js";
import type { LayerProposal } from "./frame-proposals.js";
import { readAtomicGate, type AtomicGateRecord } from "./atomic-gate.js";
import { withHistoricalReads, historicalProof, historicalTrace } from "./input.js";
import { readSeriesAt } from "./series.js";
import { gapLineKey, GAP_LINE_EXPECTED_RESULT } from "./gap-lines.js";

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
export type AcceptedAtomicGate = AtomicGateRecord['result'] & { basis: Ref };
export type AcceptedFrameGate = CandidateGate | AcceptedAtomicGate;
export const FRAME_ACCEPTANCE_CONTRACT = "om-frame-acceptance/v1" as const;
export interface FrameAttemptBinding { series: Ref; ordinal: number; obligations: string[] }
export interface FrameAcceptanceProduction {
  contract: typeof FRAME_ACCEPTANCE_CONTRACT; binding: FrameAttemptBinding | null; layer: { id: string; revision: number };
}
export type OmFrameAcceptance = {
  producer: "om"; candidate: Ref;
  gate: CandidateGate & { name: "G3" } | AcceptedAtomicGate & { name: "G5" };
  graph: Ref; upper: Ref;
} & (FrameAcceptanceProduction | { contract?: never; binding?: never; layer?: never });
export type OmAcceptedFrame = {
  project: string; candidateHash: string; layerHash: string; upperHash: string; lowerHash: string;
  fills: FrameFill[]; acceptance: OmFrameAcceptance;
} & ({ level: 2; worksContract?: never } | { level: 3; worksContract: typeof WORKS_FRAME_CONTRACT });
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
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: T[]) => [...values].sort((a, b) => order(canonical(a), canonical(b)));
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
/** A binding names one exact attempt and a nonempty unique set of raw frame-obligation ids. */
export function isFrameAttemptBinding(value: unknown): value is FrameAttemptBinding {
  return object(value) && isRef(value['series']) && positive(value['ordinal'])
    && Array.isArray(value['obligations']) && value['obligations'].length > 0 && Array.from(value['obligations']).every(text)
    && new Set(value['obligations']).size === value['obligations'].length
    && exactKeys(value, ['series', 'ordinal', 'obligations']);
}
function productionShape(value: unknown, project: string, level: 2 | 3): value is FrameAcceptanceProduction {
  return object(value) && value['contract'] === FRAME_ACCEPTANCE_CONTRACT && Object.hasOwn(value, 'binding')
    && (value['binding'] === null || isFrameAttemptBinding(value['binding'])) && object(value['layer'])
    && value['layer']['id'] === `graph-layer:${project}:${level}` && positive(value['layer']['revision'])
    && exactKeys(value['layer'], ['id', 'revision']) && exactKeys(value, ['contract', 'binding', 'layer']);
}
function acceptanceProduction(value: OmFrameAcceptance, project: string, level: 2 | 3, target: string): FrameAcceptanceProduction | undefined {
  if (!Object.hasOwn(value, 'contract')) {
    if (Object.hasOwn(value, 'binding') || Object.hasOwn(value, 'layer'))
      reject(target, 'acceptance.contract', 'Attempt bindings and result locators require their explicit producer contract');
    return undefined;
  }
  const production = { contract: value.contract, binding: value.binding, layer: value.layer };
  if (!productionShape(production, project, level))
    reject(target, 'acceptance.contract', 'The new acceptance contract requires its binding or explicit null and exact result-layer locator');
  return production;
}
/** Historical binding proof; current producers separately guard the exact series revision before their write. */
export function readFrameAttemptBinding(store: Store, request: {
  project: string; candidate: Ref; binding: FrameAttemptBinding | null;
}): OmResult<Sealed<{ binding: FrameAttemptBinding | null; references: Ref[] }>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.candidate)) invalidRequest();
  return result(() => withHistoricalReads(() => {
    if (request.binding !== null && !isFrameAttemptBinding(request.binding))
      reject(request.candidate.id, 'acceptance.binding', 'A binding needs one exact series, positive ordinal and unique obligation ids');
    if (request.binding === null) return { binding: null, references: [] };
    const candidate = readCandidate(store, { project: request.project, candidate: request.candidate });
    if (!candidate.ok) reject(candidate.refusal.at.target, candidate.refusal.at.field ?? 'candidate', candidate.refusal.message);
    return proveFrameAttemptBinding(store, request.project, candidate.value as Revision<FrameCandidateRecord>, request.binding);
  }));
}
function proveFrameAttemptBinding(store: Store, project: string, candidate: Revision<FrameCandidateRecord>, binding: FrameAttemptBinding): {
  binding: FrameAttemptBinding; references: Ref[];
} {
  const checked = readSeriesAt(store, project, binding.series);
  if (!checked.ok) reject(checked.refusal.at.target, `acceptance.binding.${checked.refusal.at.field ?? 'series'}`, checked.refusal.message);
  const attempt = checked.value.value.attempts.find(item => item.ordinal === binding.ordinal);
  if (!attempt || attempt.outcome !== null || attempt.goal.result !== GAP_LINE_EXPECTED_RESULT
    || attempt.goal.questions.length === 0 || new Set(attempt.goal.questions).size !== attempt.goal.questions.length)
    reject(binding.series.id, 'acceptance.binding.goal', 'Acceptance must refer to a running attempt whose goal declared unique frame fillings');
  const source = readFrame(store, candidate.value.request.frame);
  if (!source.ok) reject(source.refusal.at.target, `acceptance.binding.${source.refusal.at.field ?? 'frame'}`, source.refusal.message);
  const { block } = checked.value.value, upper = source.value.upper as Graph, relations = new RefinementRelations(upper);
  if (!upper.nodes.some(node => node.id === block && node.kind === 'block'))
    reject(binding.series.id, 'acceptance.binding.block', 'The attempt belongs to a block of the exact source frame');
  const obligations = new Map(source.value.result.obligations.map(obligation => [obligation.id, obligation]));
  const declared = new Map(source.value.result.obligations.map(obligation => [gapLineKey(project, obligation.id, 'fill'), obligation]));
  for (const question of attempt.goal.questions) {
    const obligation = declared.get(question);
    if (!obligation || (candidate.value.level === 2 ? obligation.upper.node !== block : !relations.refines(obligation.upper.node, block)))
      reject(binding.series.id, 'acceptance.binding.goal', 'Every declared filling must be an obligation of this attempt block in the exact source frame');
  }
  for (const id of binding.obligations) {
    const obligation = obligations.get(id), fills = candidate.value.fills.filter(fill => fill.obligation === id);
    if (!obligation || !attempt.goal.questions.includes(gapLineKey(project, id, 'fill')) || !fills.length
      || fills.some(fill => fill.source === 'identity'))
      reject(binding.series.id, 'acceptance.binding.obligations', 'A bound result must be a declared obligation filled by real accepted definitions');
  }
  return { binding: { series: binding.series, ordinal: binding.ordinal, obligations: sorted(binding.obligations) },
    references: unique([reference(candidate), binding.series, ...source.value.references]) };
}
/** Legacy consumers use the same envelope rules without inventing research requirements for their era. */
export function readLayerEnvelope(store: Store, request: LayerEnvelopeRequest): OmResult<Sealed<LayerEnvelope>> {
  requireRequest(store, request);
  return result(() => envelope(store, request));
}
/** A historical proof names immutable sources; it does not assert that their heads or files are current. */
export function readLayerBasis(store: Store, request: HistoricalLayerRequest): OmResult<Sealed<HistoricalLayerBasis>> {
  requireRequest(store, request);
  if ((request.level !== 2 && request.level !== 3) || !isRef(request.upper)) invalidRequest();
  return result(() => withHistoricalReads(() => historicalBasis(store, request, envelope(store, request))));
}
/** Resolve the producer's recorded upper basis rather than a current graph-layer head. */
export function readLayerAcceptance(store: Store, request: LayerAcceptanceRequest): OmResult<Sealed<HistoricalLayerBasis>> {
  requireRequest(store, request);
  if (request.level !== 2 && request.level !== 3) invalidRequest();
  return result(() => withHistoricalReads(() => {
    const found = envelope(store, request), proofs = found.layer.value.layerProofs ?? [];
    const own = proofs.filter(proof => proof.level === request.level);
    if (own.length !== 1) reject(request.layer.id, "layerProofs", "An accepted layer needs exactly one own derivation proof");
    const uppers = unique(own[0]!.inputs.filter(ref => ref.id === `graph-layer:${request.project}:${request.level - 1}`));
    if (uppers.length !== 1) reject(request.layer.id, "upper", "The producer must name one exact upper basis");
    return historicalBasis(store, { ...request, upper: uppers[0]! }, found);
  }));
}
/** Restore an accepting event's exact output; the new contract never chooses a matching historical layer. */
export function readAcceptedFrameLayer(store: Store, request: { project: string; level: 2 | 3; frame: Ref }): OmResult<Sealed<{
  graph: Revision<Graph>; layer: Revision<LayerBasis>; frame: Revision<OmAcceptedFrame>; references: Ref[];
}>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project)
    || ![2, 3].includes(request.level) || !isRef(request.frame)) invalidRequest();
  return result(() => withHistoricalReads(() => {
    const { project, level } = request, refs: Ref[] = [];
    const frame = exactRecord<OmAcceptedFrame>(store, request.frame, `om-frame:${project}:${level}`, 'connection-frame', refs);
    if (!object(frame.value) || frame.value.project !== project || frame.value.level !== level
      || !object(frame.value.acceptance) || frame.value.acceptance.producer !== 'om' || !isRef(frame.value.acceptance.graph))
      reject(frame.id, 'acceptance', 'The result must come from an exact candidate-accepting frame');
    const production = acceptanceProduction(frame.value.acceptance, project, level, frame.id);
    const layerId = `graph-layer:${project}:${level}`;
    let layer: Revision<LayerBasis> | null;
    if (production) {
      layer = store.get<LayerBasis>(production.layer.id, production.layer.revision);
      if (!layer || layer.id !== production.layer.id || layer.revision !== production.layer.revision)
        reject(frame.id, 'acceptance.layer', 'The exact result-layer revision named by the producer is absent');
    } else {
      // This first-event lookup is the previous producer's historical contract only.
      layer = store.history<LayerBasis>(layerId).filter(row => object(row.value) && object(row.value.acceptance)
        && canonical(row.value.acceptance.frame ?? null) === canonical(request.frame)).sort((a, b) => a.revision - b.revision)[0] ?? null;
      if (!layer) reject(frame.id, 'acceptance.layer', 'The historical accepting frame needs its saved result layer');
    }
    const found = envelope(store, { project, level, graph: frame.value.acceptance.graph, layer: reference(layer) });
    if (!object(found.layer.value.acceptance) || canonical(found.layer.value.acceptance.frame) !== canonical(request.frame))
      reject(layerId, 'acceptance.frame', 'The exact result layer must link back to this accepting frame');
    const basis = readLayerAcceptance(store, { project, level, graph: reference(found.graph), layer: reference(found.layer) });
    if (!basis.ok) reject(basis.refusal.at.target, basis.refusal.at.field ?? 'acceptance', basis.refusal.message);
    if (basis.value.producer !== 'om' || canonical(basis.value.frame) !== canonical(request.frame))
      reject(layerId, 'acceptance.frame', 'The complete output must derive from this exact candidate acceptance');
    return { graph: found.graph, layer: found.layer, frame, references: unique([...refs, ...found.references, ...basis.value.references]) };
  }));
}
function historicalBasis(store: Store, request: HistoricalLayerRequest, found: LayerEnvelope): HistoricalLayerBasis {
  return historicalProof(store, { reader: "C5.layerBasis", project: request.project, ref: request.layer,
    parameters: { ...request, graph: { ...request.graph }, layer: { ...request.layer }, upper: { ...request.upper } } }, store => verifyHistoricalBasis(store, request, found),
  () => reject(request.layer.id, "acceptance", "A historical layer cannot depend cyclically on its own acceptance"));
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
  const savedFrame = frame && level === 3
    ? exactRecord<Record<string, unknown>>(store, frame, `om-frame:${project}:3`, "connection-frame", refs).value : null;
  if (frame && level === 3 && !object(savedFrame)) reject(frame.id, "acceptance", "The work frame needs its recorded producer body");
  if (frame && level === 3 && !Object.hasOwn(savedFrame!, "acceptance")) {
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
export function omAcceptedFrame(candidate: Revision<FrameCandidateRecord>, gate: AcceptedFrameGate | Sealed<AcceptedFrameGate>, graph: Ref, upper: Ref,
  production?: FrameAcceptanceProduction): Sealed<OmAcceptedFrame> {
  if (!object(candidate) || !isRef(candidate) || candidate.kind !== "frame-candidate" || candidate.revision !== 1
    || !object(candidate.value) || !text(candidate.value.project) || ![2, 3].includes(candidate.value.level)
    || !object(candidate.value.graph) || !graphShapes[candidate.value.graph.version === 2 ? 1 : 0]!(candidate.value.graph)
    || !object(candidate.value.base) || !isRef(candidate.value.base.graph)
    || candidate.value.base.frame !== null && !isRef(candidate.value.base.frame)
    || !hash(candidate.value.graphHash) || !hash(candidate.value.layerHash) || !hash(candidate.value.upperHash)
    || !isRef(graph) || !isRef(upper) || !object(gate) || gate.passed !== true || !isRef(gate.candidate)
    || !hash(gate.graphHash) || !Array.isArray(gate.findings) || gate.findings.length !== 0) invalidRequest();
  const value = candidate.value;
  const level = value.level, upperLevel = (level - 1) as 1 | 2;
  if (production !== undefined && !productionShape(production, value.project, level)) invalidRequest();
  if (level === 3 ? value.works?.contract !== WORKS_FRAME_CONTRACT || !('gate' in gate) || gate.gate !== 'G5'
    || !('basis' in gate) || !isRef(gate.basis) || !Array.isArray(gate.codes) || gate.codes.length !== 0
    : 'basis' in gate || 'gate' in gate) invalidRequest();
  if (candidate.hash !== hashJson(value) || canonical(gate.candidate) !== canonical(reference(candidate))
    || gate.graphHash !== value.graphHash || graph.id !== `graph:${value.project}` || graph.hash !== value.graphHash
    || graph.revision !== value.base.graph.revision + 1 || upper.id !== `graph-layer:${value.project}:${upperLevel}`
    || value.graphHash !== hashJson(value.graph) || value.layerHash !== hashJson(projectGraph(value.graph, level))
    || value.upperHash !== hashJson(projectGraph(value.graph, upperLevel))) invalidRequest();
  return sealed({ project: value.project, level, ...(level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}),
    candidateHash: value.graphHash, layerHash: value.layerHash,
    upperHash: value.upperHash, lowerHash: lowerLayerHash(value.graph, level), fills: acceptedCandidateFills(value.fills),
    acceptance: { producer: "om", candidate: reference(candidate), gate: { name: level === 3 ? "G5" : "G3", ...gate }, graph, upper,
      ...(production === undefined ? {} : { ...production, binding: production.binding === null ? null
        : { ...production.binding, obligations: sorted(production.binding.obligations) } }) } }) as Sealed<OmAcceptedFrame>;
}

/** The accepted L3 envelope exposes its exact D7 pair to native consumers of layer inputs. */
export function acceptedLayerProof(candidate: Revision<FrameCandidateRecord>, upper: Ref, frame: Ref): Sealed<{
  level: 2 | 3; hash: string; inputs: Ref[];
}> {
  if (!object(candidate) || !isRef(candidate) || candidate.kind !== "frame-candidate" || candidate.revision !== 1
    || !object(candidate.value) || !text(candidate.value.project) || ![2, 3].includes(candidate.value.level)
    || !hash(candidate.value.layerHash) || candidate.hash !== hashJson(candidate.value) || !isRef(upper) || !isRef(frame)) invalidRequest();
  const { project, level, works } = candidate.value;
  if (upper.id !== `graph-layer:${project}:${level - 1}` || frame.id !== `om-frame:${project}:${level}`
    || level === 3 && (!object(works) || works.contract !== WORKS_FRAME_CONTRACT || !isRef(works.producer) || !isRef(works.ledger))) invalidRequest();
  return sealed({ level, hash: candidate.value.layerHash,
    inputs: unique([upper, reference(candidate), frame, ...(level === 3 ? [works!.producer, works!.ledger] : [])]) });
}

/** One complete output formula is shared by the producer and the new historical contract. */
export function buildAcceptedLayer(candidate: Revision<FrameCandidateRecord>, upper: Revision<LayerBasis>, frame: Ref): Sealed<LayerBasis> {
  if (!object(candidate) || !object(candidate.value) || ![2, 3].includes(candidate.value.level)
    || !object(upper) || !isRef(upper) || upper.kind !== 'graph-layer'
    || !validLayer(upper.value, (candidate.value.level - 1) as 1 | 2)
    || upper.hash !== hashJson(upper.value) || !object(candidate.value.graph)
    || !graphShapes[candidate.value.graph.version === 2 ? 1 : 0]!(candidate.value.graph)) invalidRequest();
  const proof = acceptedLayerProof(candidate, reference(upper), frame);
  if (canonical(upper.value.projection) !== canonical(projectGraph(candidate.value.graph, (candidate.value.level - 1) as 1 | 2))) invalidRequest();
  const proofs = [...(upper.value.layerProofs ?? []), { ...proof, inputs: [...proof.inputs] }];
  return sealed({ projection: projectGraph(candidate.value.graph, candidate.value.level), obligations: upper.value.obligations,
    layerProofs: proofs, inputs: unique([...upper.value.obligations.flatMap(item => item.inputs), ...proofs.flatMap(item => item.inputs)]),
    acceptance: { producer: 'om', frame } });
}

function proveOmLayer(store: Store, project: string, graph: Graph, lower: Revision<LayerBasis>, upperRef: Ref, refs: Ref[]): void {
  const frameRef = lower.value.acceptance!.frame;
  const level = lower.value.projection.level;
  if (level !== 2 && level !== 3) reject(lower.id, "acceptance.level", "An OM acceptance belongs to an operation or work layer");
  const upperLevel = (level - 1) as 1 | 2;
  const frame = exactRecord<OmAcceptedFrame>(store, frameRef, `om-frame:${project}:${level}`, "connection-frame", refs).value;
  if (!object(frame) || frame.project !== project || frame.level !== level || !hash(frame.candidateHash)
    || !hash(frame.layerHash) || !hash(frame.upperHash) || !hash(frame.lowerHash) || !Array.isArray(frame.fills)
    || !object(frame.acceptance) || frame.acceptance.producer !== "om" || !isRef(frame.acceptance.candidate) || !isRef(frame.acceptance.graph)
    || !isRef(frame.acceptance.upper) || !object(frame.acceptance.gate))
    reject(frameRef.id, "acceptance", "An OM layer requires its complete accepted frame and exact candidate gate");
  if (level === 3 && (frame.worksContract !== WORKS_FRAME_CONTRACT || frame.acceptance.gate.name !== 'G5'
    || !('basis' in frame.acceptance.gate) || !isRef(frame.acceptance.gate.basis)))
    reject(frameRef.id, "acceptance.contract", "A work acceptance needs its exact works contract and original G5 basis");
  const witness = frame.acceptance;
  const production = acceptanceProduction(witness, project, level, frameRef.id);
  if (production && (production.layer.id !== lower.id || production.layer.revision !== lower.revision))
    reject(frameRef.id, 'acceptance.layer', 'The layer must be the exact output revision retained by its accepting producer');
  const traced = historicalTrace(store, (ref, _head, method) => { if (method === 'get') refs.push(ref); }, 'distinct');
  {
    const candidate = exactRecord<FrameCandidateRecord>(traced, witness.candidate, witness.candidate.id, "frame-candidate", refs);
    let verifiedGate: AcceptedFrameGate;
    if (level === 3) {
      const basis = (witness.gate as AcceptedAtomicGate).basis;
      const checked = readAtomicGate(traced, { project, record: basis });
      if (!checked.ok) reject(checked.refusal.at.target, `acceptance.${checked.refusal.at.field ?? "gate"}`, checked.refusal.message);
      const atomic = { ...checked.value.value.result, basis } as AcceptedAtomicGate;
      verifiedGate = atomic;
      if (!atomic.passed || canonical(atomic.candidate) !== canonical(witness.candidate)
        || atomic.graphHash !== candidate.value.graphHash || atomic.codes.length || atomic.findings.length)
        reject(frameRef.id, "acceptance.gate", "A work layer needs the successful exact candidate outcome rederived from its original G5 sources");
    } else {
      const checked = gateCandidate(traced, { project, candidate: witness.candidate });
      if (!checked.ok) reject(checked.refusal.at.target, `acceptance.${checked.refusal.at.field ?? "gate"}`, checked.refusal.message);
      verifiedGate = checked.value as CandidateGate;
    }
    if (canonical(witness.gate) !== canonical({ ...verifiedGate, name: level === 3 ? "G5" : "G3" }))
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
    if (candidate.value.level !== level) reject(frameRef.id, "acceptance.level", "The accepted candidate belongs to this exact layer");
    if (production && production.binding !== null) {
      const binding = proveFrameAttemptBinding(traced, project, candidate, production.binding);
      refs.push(...binding.references);
    }
    const expected = omAcceptedFrame(candidate, verifiedGate, witness.graph, upperRef, production);
    if (canonical(frame) !== canonical(expected))
      reject(frameRef.id, "acceptance.fills", "The accepted frame must derive completely from the exact candidate and verified gate");
    if (canonical(witness.upper) !== canonical(upperRef)
      || canonical(projectGraph(savedGraph.value, level)) !== canonical(projectGraph(graph, level)))
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
    const upperRecord = readLayer(store, upperRef, project, upperLevel, refs), upper = upperRecord.value;
    const proof = acceptedLayerProof(candidate, upperRef, frameRef);
    if (canonical(lower.value.obligations) !== canonical(upper.obligations)
      || canonical(lower.value.layerProofs) !== canonical([...(upper.layerProofs ?? []), proof]))
      reject(lower.id, "acceptance.inputs", "The OM layer must retain exactly its upper proof envelope and own accepted transition");
    if (production && canonical(lower.value) !== canonical(buildAcceptedLayer(candidate, upperRecord, frameRef)))
      reject(lower.id, 'acceptance.layer', 'The complete result layer must equal the producer derivation with its exact accepting frame');
  }
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
  return result(() => withHistoricalReads(() => {
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
      { graph, reference: request.to.graph }, { obligations: before.result.obligations, fills: old.fills,
        ...(old.worksContract === WORKS_FRAME_CONTRACT ? { worksContract: WORKS_FRAME_CONTRACT } : {}) } as FrameCarrySource,
      after.upperRef, request.to.level));
    const fills = carried.fills as FrameFill[], retired = sorted([...(old.retired ?? []), ...carried.retired]);
    const rebased: OmRebasedFrame = { project, level: 3, ...(old.worksContract === WORKS_FRAME_CONTRACT ? { worksContract: WORKS_FRAME_CONTRACT } : {}), candidateHash: old.candidateHash,
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
    || !Array.isArray(request.frame.retired) || !isRef(request.frame.rebasedFrom)
    || Object.hasOwn(request.frame, 'worksContract') && request.frame.worksContract !== WORKS_FRAME_CONTRACT) invalidRequest();
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
  // D8.4.2 (№2276-2): the accepted answer's provenance — a managed answer's own K chain (O/P/I,
  // R/B/M/S/A, the pair), a rebound's source chain — is proven on the ORIGINAL store by exact
  // records through the common reader. Every record that proof read joins the historical view and
  // the basis trail, so the gate below re-proves the same chain from saved records; today's heads
  // never replace a missing historical source (a head read here is only the immutable
  // single-revision record the chain itself names, and it is proven by the chain).
  const traced = new Proxy(store, { get(target, key) {
    if (key === "get") return (id: string, revision?: number) => {
      const record = target.get<Record<string, unknown>>(id, revision);
      if (record && object(record.value)) {
        if (revision === undefined) { if (!records.has(id)) records.set(id, record); }
        else historical.set(canonical([id, revision]), record as Revision);
        refs.push(reference(record));
      }
      return record;
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  try { readAcceptedResearchAnswer(traced, project, question['answer'] as Ref); }
  catch (error) {
    if (error instanceof EngineError && error.code.startsWith("research_")) reject(lower.id, "research.acceptance", error.message);
    throw error;
  }
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
