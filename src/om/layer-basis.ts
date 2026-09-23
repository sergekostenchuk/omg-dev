import { Ajv } from "ajv";
import { canonical, digest, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import { Discovery } from "../discovery/discovery.js";
import type { Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { projectGraph } from "../graph/project.js";
import { composeLayer, layerDesignSpec, LAYER_DESIGN_VERSION } from "../graph/layer-design.js";
import { obligationHandoff } from "../graph/obligation-handoff.js";
import { requireTaskObligations } from "../graph/task-obligations.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, refused, sealed, type OmResult, type Sealed } from "./refusal.js";
import { readRecord } from "./refs.js";

export const LAYER_BASIS_REFUSAL_CODES = Object.freeze(["layer_basis_request_invalid", "layer_basis_unproven"] as const);
export interface LayerBasis {
  projection: ReturnType<typeof projectGraph>;
  inputs: Ref[];
  obligations: { node: string; field: string; valueHash: string; inputs: Ref[] }[];
  layerProofs?: { level: 1 | 2 | 3; hash: string; inputs: Ref[] }[];
}
export interface LayerEnvelopeRequest { project: string; level: 1 | 2 | 3; graph: Ref; layer: Ref }
export interface HistoricalLayerRequest extends LayerEnvelopeRequest { level: 2 | 3; upper: Ref }
export interface LayerEnvelope { graph: Revision<Graph>; layer: Revision<LayerBasis>; references: Ref[] }
export interface HistoricalLayerBasis { references: Ref[] }
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
function readLayer(store: Store, ref: Ref, project: string, level: 1 | 2 | 3, refs: Ref[]): Revision<LayerBasis> {
  const saved = exactRecord<LayerBasis>(store, ref, `graph-layer:${project}:${level}`, "graph-layer", refs), layer = saved.value;
  if (!object(layer) || !object(layer.projection) || layer.projection.level !== level
    || !Array.isArray(layer.inputs) || !layer.inputs.every(isRef) || !Array.isArray(layer.obligations)
    || !layer.obligations.every(item => object(item) && text(item.node) && text(item.field) && hash(item.valueHash)
      && Array.isArray(item.inputs) && item.inputs.every(isRef))
    || (layer.layerProofs !== undefined && (!Array.isArray(layer.layerProofs) || !layer.layerProofs.every(proof => object(proof)
      && [1, 2, 3].includes(proof.level) && hash(proof.hash) && Array.isArray(proof.inputs) && proof.inputs.every(isRef)))))
    reject(ref.id, "layer", "The saved layer has an invalid proof envelope");
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
  return result(() => {
    const { project, level, layer: layerRef, upper: upperRef } = request;
    const found = envelope(store, request), graph = found.graph.value, lower = found.layer, refs = found.references;
    const upper = readLayer(store, upperRef, project, (level - 1) as 1 | 2, refs);
    if (canonical(upper.value.projection) !== canonical(projectGraph(graph, (level - 1) as 1 | 2)))
      reject(upperRef.id, "upper", "The lower layer must retain its exact upper projection");
    const proofs = lower.value.layerProofs ?? [], own = proofs.filter(proof => proof.level === level);
    if (own.length !== 1 || proofs.some(proof => proof.level > level))
      reject(layerRef.id, "layerProofs", "The lower layer needs exactly one own derivation proof and no later proofs");
    const bases = [...new Map(own[0]!.inputs.filter(ref => ref.id === upperRef.id).map(ref => [canonical(ref), ref])).values()];
    if (bases.length !== 1 || canonical(bases[0]) !== canonical(upperRef))
      reject(layerRef.id, "upper", "The own proof must name exactly this accepted upper basis");
    proveLayer(store, project, graph, lower, upperRef, refs);
    return { references: unique(refs) };
  });
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
