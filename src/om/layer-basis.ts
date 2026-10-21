import { Ajv } from "ajv";
import { canonical, canonicalSorted, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import { LEVEL, type Graph } from "../graph/model.js";
import { graphV2Schema } from "../graph/schema.js";
import { projectGraph } from "../graph/project.js";
import { RefinementRelations } from "../graph/relations.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import { readRecord } from "./refs.js";
import { readCandidate, type CandidateGate, type FrameCandidateRecord } from "./frame-candidate.js";
import { WORKS_FRAME_CONTRACT, readFrame, readFrameBasis, prepareFrameBasis, carryFrameFills, type FrameFill, type FrameRequest, type ConnectionFrame, type FrameCarrySource } from "./frame-obligations.js";
import { type AtomicGateRecord } from "./atomic-gate.js";
import { withHistoricalReads, historicalProof } from "./input.js";
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
  references: Ref[]; producer: "om"; upper: Ref; frame: Ref | null; currentReferences: Ref[]; open: string[];
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
} & FrameAcceptanceProduction;
export type OmAcceptedFrame = {
  project: string; candidateHash: string; layerHash: string; upperHash: string; lowerHash: string;
  fills: FrameFill[]; acceptance: OmFrameAcceptance;
} & ({ level: 2; worksContract?: never } | { level: 3; worksContract: typeof WORKS_FRAME_CONTRACT });
export interface FrameRebaseRequest { from: FrameRequest; to: FrameRequest }
export interface OmRebasedFrame extends ConnectionFrame {
  level: 3; worksContract: typeof WORKS_FRAME_CONTRACT; upperHash: string; lowerHash: string;
  retired: FrameFill[]; rebasedFrom: Ref; rebase: FrameRebaseRequest;
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
const sorted = canonicalSorted;
const schemas = new Ajv({ strict: true, allowUnionTypes: true });
const graphShape = schemas.compile(sealed(graphV2Schema));
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
  if (!object(graph.value) || graph.value.version !== 2 || !graphShape(graph.value))
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
function acceptanceProduction(value: OmFrameAcceptance, project: string, level: 2 | 3, target: string): FrameAcceptanceProduction {
  if (!Object.hasOwn(value, 'contract'))
    reject(target, 'acceptance.contract', 'Attempt bindings and result locators require their explicit producer contract');
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
    const layer = store.get<LayerBasis>(production.layer.id, production.layer.revision);
    if (!layer || layer.id !== production.layer.id || layer.revision !== production.layer.revision)
      reject(frame.id, 'acceptance.layer', 'The exact result-layer revision named by the producer is absent');
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
/** NR (№3600): the basis of a saved layer as its producer wrote it — the upper basis it names and its accepting frame.
 * The layer was proved by its producer when it was new; only what a consumer needs of it is computed here (the open
 * obligations of a rebased work layer), nothing is proved again. */
function verifyHistoricalBasis(store: Store, request: HistoricalLayerRequest, found: LayerEnvelope): HistoricalLayerBasis {
  const { project, level, upper: upperRef } = request;
  const lower = found.layer, refs = found.references;
  const frame = lower.value.acceptance?.frame;
  if (!frame) reject(request.layer.id, "acceptance", "A historical layer must name its recorded OM acceptance");
  if (!lower.value.layerProofs?.some(proof => proof.level === level))
    reject(request.layer.id, "layerProofs", "An accepted layer needs its own derivation proof");
  let open: string[] = [], currentReferences = [upperRef, frame];
  if (level === 3) {
    const savedFrame = exactRecord<Record<string, unknown>>(store, frame, `om-frame:${project}:3`, "connection-frame", refs).value;
    if (object(savedFrame) && !Object.hasOwn(savedFrame, "acceptance")) {
      const rebase = proveRebasedLayer(store, request, found);
      refs.push(...rebase.references); open = rebase.open;
      currentReferences = [...rebase.currentReferences, frame];
    }
  }
  // The basis names its direct links as written: the upper it stands on and its accepting frame — references only; none
  // of them is read or proved again.
  refs.push(upperRef);
  return { references: unique(refs), producer: "om", upper: upperRef, frame,
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
    const found = envelope(store, request), { layer } = found;
    const nativeUnaccepted = !Object.hasOwn(layer.value, "acceptance")
      && !(layer.value.layerProofs ?? []).some(proof => proof.level >= request.level);
    if (!nativeUnaccepted)
      reject(layer.id, "acceptance", "This producer does not establish that the lower layer is still unaccepted");
    return { references: found.references, currentReferences: unique([request.graph, request.layer]) };
  });
}
/** Hash the layer's own nodes, bindings and dependent definitions, excluding its inherited upper. */
export function lowerLayerHash(graph: Graph, level: 2 | 3): string {
  if ((level !== 2 && level !== 3) || !object(graph) || graph.version !== 2 || !graphShape(graph)) invalidRequest();
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
  production: FrameAcceptanceProduction): Sealed<OmAcceptedFrame> {
  if (!object(candidate) || !isRef(candidate) || candidate.kind !== "frame-candidate" || candidate.revision !== 1
    || !object(candidate.value) || !text(candidate.value.project) || ![2, 3].includes(candidate.value.level)
    || !object(candidate.value.graph) || candidate.value.graph.version !== 2 || !graphShape(candidate.value.graph)
    || !object(candidate.value.base) || !isRef(candidate.value.base.graph)
    || candidate.value.base.frame !== null && !isRef(candidate.value.base.frame)
    || !hash(candidate.value.graphHash) || !hash(candidate.value.layerHash) || !hash(candidate.value.upperHash)
    || !isRef(graph) || !isRef(upper) || !object(gate) || gate.passed !== true || !isRef(gate.candidate)
    || !hash(gate.graphHash) || !Array.isArray(gate.findings) || gate.findings.length !== 0) invalidRequest();
  const value = candidate.value;
  const level = value.level, upperLevel = (level - 1) as 1 | 2;
  if (!productionShape(production, value.project, level)) invalidRequest();
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
      contract: production.contract, binding: production.binding === null ? null
        : { ...production.binding, obligations: sorted(production.binding.obligations) }, layer: { ...production.layer } } }) as Sealed<OmAcceptedFrame>;
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
    || candidate.value.graph.version !== 2 || !graphShape(candidate.value.graph)) invalidRequest();
  const proof = acceptedLayerProof(candidate, reference(upper), frame);
  if (canonical(upper.value.projection) !== canonical(projectGraph(candidate.value.graph, (candidate.value.level - 1) as 1 | 2))) invalidRequest();
  const proofs = [...(upper.value.layerProofs ?? []), { ...proof, inputs: [...proof.inputs] }];
  return sealed({ projection: projectGraph(candidate.value.graph, candidate.value.level), obligations: upper.value.obligations,
    layerProofs: proofs, inputs: unique([...upper.value.obligations.flatMap(item => item.inputs), ...proofs.flatMap(item => item.inputs)]),
    acceptance: { producer: 'om', frame } });
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
  return result(() => withHistoricalReads(() => rebaseBasis(store, request, false)));
}
/** The basis of a new rebase: its producer checks the new upper basis and every carried relation. */
export function prepareRebaseBasis(store: Store, request: FrameRebaseRequest): OmResult<Sealed<RebaseBasis>> {
  requireRebaseRequest(store, request);
  return result(() => withHistoricalReads(() => rebaseBasis(store, request, true)));
}
/** A saved rebase was checked by its producer; reading it computes the carried frame from its exact sources. */
function rebaseBasis(store: Store, request: FrameRebaseRequest, fresh: boolean): RebaseBasis {
  const before = rebaseTake(readFrame(store, request.from));
  const after = rebaseTake((fresh ? prepareFrameBasis : readFrameBasis)(store, request.to));
  const project = request.to.project, refs = [...before.references, ...after.references];
  const upper = rebaseTake(readLayerAcceptance(store, { project, level: 2, graph: request.to.graph, layer: after.upperRef }));
  if (fresh && (upper.producer !== "om" || canonical(upper.frame) !== canonical(request.to.upper!.frame)))
    reject(after.upperRef.id, "rebase.upper", "The new work basis must be the exact accepted OM upper frame");
  refs.push(...upper.references);
  const acceptedUpper = exactRecord<OmAcceptedFrame>(store, upper.frame!, `om-frame:${project}:2`, "connection-frame", refs);
  if (fresh && canonical(acceptedUpper.value.acceptance.graph) !== canonical(request.to.graph))
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
    if (fresh && (previous.producer !== "om" || canonical(previous.frame) !== canonical(previousFrame)))
      reject(previousLayer.id, "rebase.chain", "Every intermediate upper change must have its own exact accepted OM frame");
    refs.push(...previous.references);
    frame = exactRecord<OmAcceptedFrame>(store, previousFrame, `om-frame:${project}:2`, "connection-frame", refs);
    if (fresh && canonical(frame.value.acceptance.graph) !== canonical(candidate.value.base.graph))
      reject(previousFrame.id, "rebase.chain", "An intermediate acceptance must be the actual base of its successor");
  }
  const graph = exactRecord<Graph>(store, request.to.graph, `graph:${project}`, "graph", refs).value;
  const originalGraph = exactRecord<Graph>(store, request.from.graph, `graph:${project}`, "graph", refs).value;
  if (fresh && lowerLayerHash(originalGraph, 3) !== lowerLayerHash(graph, 3))
    reject(request.to.graph.id, "rebase.lower", "A rebase cannot change the accepted work layer's own content");
  const old = exactRecord<ConnectionFrame & Partial<OmRebasedFrame>>(store, request.from.frame!, `om-frame:${project}:3`, "connection-frame", refs).value;
  if (old.worksContract !== WORKS_FRAME_CONTRACT)
    reject(request.from.frame!.id, "rebase.worksContract", "The carried work layer needs its recorded works contract");
  const oldLayer = readLayer(store, request.from.layer!, project, 3, refs);
  if (fresh && old.retired !== undefined && (!object(oldLayer.value.acceptance)
    || canonical(oldLayer.value.acceptance.frame) !== canonical(request.from.frame) || !old.rebase || !Array.isArray(old.retired)))
    reject(request.from.frame!.id, "rebase.retired", "Retired fills need their exact prior verified OM rebase event");
  const carried = rebaseTake(carryFrameFills(after.upper as Graph, after.scope as Parameters<typeof carryFrameFills>[1],
    { graph, reference: request.to.graph }, { obligations: before.result.obligations, fills: old.fills,
      worksContract: WORKS_FRAME_CONTRACT } as FrameCarrySource,
    after.upperRef, request.to.level));
  const fills = carried.fills as FrameFill[], retired = sorted([...(old.retired ?? []), ...carried.retired]);
  const rebased: OmRebasedFrame = { project, level: 3, worksContract: WORKS_FRAME_CONTRACT, candidateHash: old.candidateHash,
    layerHash: hashJson(projectGraph(graph, 3)), upperHash: hashJson(projectGraph(graph, 2)), lowerHash: lowerLayerHash(graph, 3),
    fills, retired, rebasedFrom: request.from.frame!, rebase: request };
  return { frame: rebased, upper: after.upperRef, references: unique(refs),
    currentReferences: unique([after.upperRef, upper.frame!]),
    open: carried.open.map(obligation => obligation.id).sort(order) };
}
/** The writer and historical verifier derive the same explicitly carried proof envelope. */
export function buildRebasedLayer(request: RebasedLayerRequest): Sealed<LayerBasis> {
  if (!object(request) || !object(request.frame) || !isRef(request.reference) || !object(request.graph)
    || request.graph.version !== 2 || !graphShape(request.graph) || !isRef(request.upper) || !isRef(request.previous)
    || !validLayer(request.upper.value, 2) || !validLayer(request.previous.value, 3) || !validRebaseRequest(request.frame.rebase)
    || !text(request.frame.project) || !hash(request.frame.candidateHash) || !hash(request.frame.layerHash)
    || !hash(request.frame.upperHash) || !hash(request.frame.lowerHash) || !Array.isArray(request.frame.fills)
    || !Array.isArray(request.frame.retired) || !isRef(request.frame.rebasedFrom)
    || request.frame.worksContract !== WORKS_FRAME_CONTRACT) invalidRequest();
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
/** A rebased layer was checked by prepareRebaseFrame; its open obligations are computed from the saved rebase. */
function proveRebasedLayer(store: Store, request: HistoricalLayerRequest, found: LayerEnvelope): RebaseBasis {
  const frameRef = found.layer.value.acceptance!.frame, refs: Ref[] = [];
  const frame = exactRecord<OmRebasedFrame>(store, frameRef, `om-frame:${request.project}:3`, "connection-frame", refs);
  const basis = rebaseTake(readRebaseBasis(store, frame.value.rebase));
  readLayer(store, basis.upper, request.project, 2, refs);
  readLayer(store, frame.value.rebase.from.layer!, request.project, 3, refs);
  return { ...basis as RebaseBasis, references: unique([...basis.references, ...refs]) };
}

