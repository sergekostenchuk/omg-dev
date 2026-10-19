import { Ajv } from "ajv";
import { canonical, hashJson } from "../canonical.js";
import { EngineError } from "../errors.js";
import { controlPredecessors } from "../graph/dependencies.js";
import type { Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { isRef, reference, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { delivered, isPlainObject, localErrors, localRefusals, sealed, transfer, type OmResult, type Refusal, type RefusalRoute, type Sealed, type SourceCodes } from "./refusal.js";
import { receiptId, type ArtifactReceipt } from "../compiler/model.js";
import { projectGraph } from "../graph/project.js";
import { RefinementRelations } from "../graph/relations.js";
import { StageChecks } from "../product/stage-checks.js";
import { Store, storeObserved, type Revision, type TransactionGuard, type Write, type HeadsMatch, type HeadsMatchMismatch } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import { prepareExistingOmInput, readOmAdmissionGuards, readOmInput } from "./input.js";
import { readRecord, writeGuarded } from "./refs.js";
import { readLayerAcceptance, readLayerBasis, readLayerEnvelope, type LayerBasis } from "./layer-basis.js";
import { prepareSeriesTransition, readPreparedSeriesTransition } from "./series-transition.js";

export const HORIZON_REFUSAL_CODES = Object.freeze([
  "horizon_empty", "horizon_unclosed", "horizon_feature_unknown", "horizon_requires_excluded",
  "horizon_exclusion_unjustified", "horizon_exclusion_unknown", "horizon_available_unproven",
  "horizon_available_uncovered", "horizon_refinement_unproven",
] as const);
export type HorizonRefusalCode = typeof HORIZON_REFUSAL_CODES[number];
/**
 * Q2 (№2452-5, №2460): every code horizon.ts creates itself — the gate subset above and the issuance set below stay the
 * exact sets older tests pin; the local constructor accepts this whole catalogue and nothing else.
 */
export const HORIZON_LOCAL_CODES = Object.freeze([...HORIZON_REFUSAL_CODES,
  "horizon_issuance_request_invalid", "horizon_issuance_binding_invalid", "horizon_issuance_record_invalid",
  "horizon_choice_conflict", "input_stale", "record_forged"] as const);
export type HorizonLocalCode = typeof HORIZON_LOCAL_CODES[number];
/** The exceptions horizon.ts throws itself. */
export const HORIZON_ERROR_CODES = Object.freeze(["horizon_request_invalid", "input_stale"] as const);
export type HorizonErrorCode = typeof HORIZON_ERROR_CODES[number];
/** The units whose refusals horizon.ts hands on unchanged, each through a declared transfer. */
export type HorizonSource = "refs" | "input" | "series-transition";
export type HorizonCode = HorizonLocalCode | SourceCodes<HorizonSource>;
export type HorizonResult<T> = OmResult<T, HorizonCode>;
const refuse = localRefusals(HORIZON_LOCAL_CODES);
// Annotated explicitly: only a declared `never` makes a bare call end the control flow for tsc.
const raise: (code: HorizonErrorCode, message: string, details?: unknown) => never = localErrors(HORIZON_ERROR_CODES);
export interface HorizonChoice {
  choiceVersion: string;
  features: { outcome: string }[];
  excluded: { block: string; reason: string; returnCondition: string }[];
}
export type HorizonBasis = Record<string, Ref>;
export interface HorizonOptions extends HorizonChoice { refined: string[]; available: Record<string, HorizonBasis> }
export interface Horizon {
  choiceVersion: string; features: string[]; nodes: string[];
  refinement: Record<string, "accepted" | "needed">;
  execution: Record<string, { state: "needed" } | { state: "available"; basis: HorizonBasis }>;
  boundary: { block: string; basis: HorizonBasis }[];
  externalInputs: { consumer: string; connector: string; source: string; consumerPort: string; sourcePort: string; artifact: string }[];
  excluded: HorizonChoice['excluded']; hash: string;
}
export interface HorizonConflict { code: "horizon_requires_excluded"; block: string; path: string[] }
export interface HorizonBuildResult { horizon: Horizon; conflicts: HorizonConflict[]; refusals: Refusal<HorizonRefusalCode>[] }

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
function invalid(field: string): never {
  return raise("horizon_request_invalid", "Horizon needs explicit well-formed inputs", { unit: "G2", target: "horizon", field });
}
function jsonCopy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) {
    if (error instanceof EngineError && error.code === "unsealable_value") invalid("json");
    throw error;
  }
}
let graphShapes: ReturnType<Ajv['compile']>[] | undefined;
const horizonShapes = () => graphShapes ??= (() => {
  const schema = new Ajv({ strict: true, allErrors: false, allowUnionTypes: true });
  return [schema.compile(sealed(graphSchema)), schema.compile(sealed(graphV2Schema))];
})();
function requireChoice(value: unknown): asserts value is HorizonChoice {
  if (!object(value) || !text(value['choiceVersion']) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value['choiceVersion'])) invalid("choiceVersion");
  if (!Array.isArray(value['features']) || !value['features'].every(feature => object(feature) && text(feature['outcome']))) invalid("features");
  if (!Array.isArray(value['excluded']) || !value['excluded'].every(item => object(item) && text(item['block']))) invalid("excluded");
}
function requireOptions(value: unknown): asserts value is HorizonOptions {
  requireChoice(value);
  if (!Array.isArray((value as HorizonOptions).refined) || !(value as HorizonOptions).refined.every(text)) invalid("refined");
  if (!object((value as HorizonOptions).available)) invalid("available");
}

export function closeHorizon(upper: Graph, options: HorizonOptions): Sealed<HorizonBuildResult> {
  if (!object(upper) || !horizonShapes()[upper.version === 2 ? 1 : 0]!(upper)) invalid("upper");
  requireOptions(options);
  upper = jsonCopy(upper); options = jsonCopy(options);
  const blocks = new Map(upper.nodes.filter(node => node.kind === "block").map(node => [node.id, node]));
  const artifacts = new Map(upper.artifacts.map(artifact => [artifact.id, artifact]));
  const refusals: Refusal<HorizonRefusalCode>[] = [], conflicts: HorizonConflict[] = [];
  const fail = (code: HorizonRefusalCode, target: string, field: string, message: string, route: RefusalRoute = "owner") => {
    const result = refuse(code, message, { unit: "G2", target, field }, route);
    if (!result.ok) refusals.push(result.refusal);
  };
  for (const exclusion of options.excluded) {
    if (!blocks.has(exclusion.block)) fail("horizon_exclusion_unknown", exclusion.block, "excluded", "The excluded block is not in the upper layer");
    if (!text(exclusion.reason) || !text(exclusion.returnCondition))
      fail("horizon_exclusion_unjustified", exclusion.block, "excluded", "An exclusion needs its reason and return condition");
  }
  const refined = new Set(options.refined), available = new Map<string, HorizonBasis>();
  for (const block of refined) if (!blocks.has(block))
    fail("horizon_refinement_unproven", block, "refined", "Refinement must identify an upper-layer block", "producer");
  for (const [block, basis] of Object.entries(options.available)) {
    if (!blocks.has(block) || !object(basis) || !Object.keys(basis).length || !Object.values(basis).every(isRef))
      fail("horizon_available_unproven", block, "available", "Availability needs an exact receipt per artifact", "readiness");
    else available.set(block, basis);
  }
  const roots: { block: string; feature: string }[] = [];
  for (const feature of options.features) {
    const producers = [...blocks.values()].filter(block => block.outcome === feature.outcome);
    if (!artifacts.has(feature.outcome) || !producers.length)
      fail("horizon_feature_unknown", feature.outcome, "features", "The feature needs a known outcome and a block producer");
    else for (const producer of producers) roots.push({ block: producer.id, feature: feature.outcome });
  }
  type Need = { block: string; via: string; artifact: string; external: boolean; consumerPort: string; sourcePort: string };
  const needs = (id: string): Need[] => sorted([
    ...upper.connectors.flatMap(connector => connector.bindings.filter(binding => binding.level === 1 && binding.anchor === null)
      .flatMap(binding => binding.consumers.filter(consumer => consumer.node === id
        && (binding.producer.node !== id || artifacts.get(connector.artifact)?.external === true))
        .map(consumer => ({ block: binding.producer.node, via: connector.id, artifact: connector.artifact,
          external: artifacts.get(connector.artifact)?.external === true, consumerPort: consumer.port, sourcePort: binding.producer.port })))),
    ...controlPredecessors(upper, id).map(predecessor => ({ block: predecessor.producer, via: predecessor.id,
      artifact: blocks.get(predecessor.producer)?.outcome ?? "", external: false, consumerPort: "", sourcePort: "" })),
  ]);
  const excluded = new Set(options.excluded.map(item => item.block)), rootIds = new Set(roots.map(root => root.block));
  const nodes = new Set<string>(), boundary = new Map<string, HorizonBasis>();
  const queue = sorted(roots).map(root => ({ block: root.block, path: [`feature:${root.feature}`, root.block] }));
  while (queue.length) {
    const next = queue.shift()!;
    if (excluded.has(next.block)) {
      conflicts.push({ code: "horizon_requires_excluded", block: next.block, path: next.path });
      fail("horizon_requires_excluded", next.block, "excluded", "The owner must resolve the exclusion of a required block");
      continue;
    }
    if (!blocks.has(next.block)) { fail("horizon_unclosed", next.block, "dependency", "A required internal producer is absent from the upper layer", "producer"); continue; }
    if (nodes.has(next.block)) continue;
    nodes.add(next.block); boundary.delete(next.block);
    for (const need of needs(next.block)) {
      if (!artifacts.has(need.artifact))
        fail("horizon_unclosed", next.block, need.via, "A required dependency must name an existing artifact", "producer");
      if (need.external || nodes.has(need.block)) continue;
      if (available.has(need.block) && refined.has(need.block) && !excluded.has(need.block) && !rootIds.has(need.block)) {
        boundary.set(need.block, available.get(need.block)!); continue;
      }
      queue.push({ block: need.block, path: [...next.path, need.via, need.block] });
    }
  }
  const externalInputs: Horizon['externalInputs'] = [];
  const cover = (block: string, artifact: string, via: string) => {
    const basis = available.get(block);
    if (basis && (!Object.hasOwn(basis, artifact) || !isRef(basis[artifact])))
      fail("horizon_available_uncovered", `${block}:${artifact}`, via, "Availability does not cover this required result", "readiness");
  };
  for (const id of [...nodes].sort(order)) for (const need of needs(id)) {
    if (need.external) externalInputs.push({ consumer: id, connector: need.via, source: need.block,
      consumerPort: need.consumerPort, sourcePort: need.sourcePort, artifact: need.artifact });
    else if (nodes.has(need.block) || boundary.has(need.block)) cover(need.block, need.artifact, need.via);
  }
  for (const root of roots) if (nodes.has(root.block)) cover(root.block, root.feature, "feature");
  if (!nodes.size) fail("horizon_empty", "horizon", "nodes", "The selected horizon is empty");
  const nodeIds = [...nodes].sort(order);
  const value = {
    choiceVersion: options.choiceVersion, features: options.features.map(feature => feature.outcome).sort(order), nodes: nodeIds,
    refinement: Object.fromEntries(nodeIds.map(id => [id, refined.has(id) ? "accepted" as const : "needed" as const])),
    execution: Object.fromEntries(nodeIds.map(id => [id, available.has(id)
      ? { state: "available" as const, basis: available.get(id)! } : { state: "needed" as const }])),
    boundary: sorted([...boundary].map(([block, basis]) => ({ block, basis }))), externalInputs: sorted(externalInputs),
    excluded: sorted(options.excluded),
  };
  return sealed({ horizon: { ...value, hash: hashJson(value) }, conflicts: sorted(conflicts), refusals: sorted(refusals) });
}

export function gateHorizon(upper: Graph, options: HorizonOptions, candidate: HorizonBuildResult): Sealed<{ passed: boolean; codes: string[] }> {
  if (!object(candidate) || !object(candidate.horizon) || !Array.isArray(candidate.conflicts) || !Array.isArray(candidate.refusals)) invalid("candidate");
  candidate = jsonCopy(candidate);
  const expected = closeHorizon(upper, options);
  const codes = [...expected.refusals.map(refusal => refusal.code), ...expected.conflicts.map(conflict => conflict.code)];
  if (canonical(candidate) !== canonical(expected)) codes.push("horizon_unclosed");
  return sealed({ passed: codes.length === 0, codes: [...new Set(codes)].sort(order) });
}

export interface HorizonRequest {
  project: string; input: Ref; graph: Ref; refinement: Ref | null;
  choice: HorizonChoice; available: Record<string, HorizonBasis>;
}
export interface HorizonRecord { project: string; request: HorizonRequest; result: HorizonBuildResult }
export interface OmHorizonRecord {
  project: string; choiceVersion: string; horizon: Ref; horizonHash: string;
  state: "accepted" | "refused"; codes: string[];
}
export interface HorizonRecords { horizon: Revision<HorizonRecord>; gate: Revision<OmHorizonRecord> }
export interface PreparedHorizon {
  record: HorizonRecord; gate: OmHorizonRecord; writes: Write[]; guards: TransactionGuard[]; existing: HorizonRecords | null;
}
const address = (target: string, field: string, ref?: Ref) => ({ unit: "G2", target, field, ...(ref ? { ref } : {}) });
function requireStore(store: Store, project: string): void {
  if (!(store instanceof Store)) invalid("store");
  if (!text(project) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(project)) invalid("project");
}
function requireRequest(store: Store, request: HorizonRequest): void {
  if (!object(request)) invalid("request");
  requireStore(store, request.project);
  if (!isRef(request.input)) invalid("input");
  if (!isRef(request.graph)) invalid("graph");
  if (request.refinement !== null && !isRef(request.refinement)) invalid("refinement");
  requireChoice(request.choice);
  if (!object(request.available)) invalid("available");
}
function normalizedRequest(request: HorizonRequest): HorizonRequest {
  return jsonCopy({ ...request, choice: { ...request.choice,
    features: sorted(request.choice.features), excluded: sorted(request.choice.excluded) } });
}
function receiptShape(value: unknown, project: string, artifact: string): value is ArtifactReceipt {
  if (!object(value) || value['projectId'] !== project || value['artifact'] !== artifact
    || !["node", "signature", "contractHash", "commit", "tree"].every(field => text(value[field]))
    || !object(value['value']) || !Array.isArray(value['value']['files'])
    || !value['value']['files'].every(file => object(file) && text(file['path']) && (file['hash'] === null || text(file['hash'])))) return false;
  return (value['plan'] === undefined || isRef(value['plan'])) && (value['run'] === undefined || isRef(value['run']));
}
interface SavedPhase { projectId: string; phase: string; inputs: Ref[]; layer: Ref | null; draft: Ref | null; contractVersion?: number }
// Resolve the producer's recorded proof closure historically; only current admission below reads heads.
function exactClosure(store: Store, refs: Ref[]): HorizonResult<Sealed<Revision[]>> {
  const pending = [...refs], seen = new Set<string>(), records: Revision[] = [];
  while (pending.length) {
    const ref = pending.shift()!;
    if (!isRef(ref)) return refuse("horizon_refinement_unproven", "Refinement has an invalid proof reference", address("refinement", "inputs"), "producer");
    const key = canonical(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = store.get(ref.id, ref.revision);
    if (!record || record.hash !== ref.hash) return refuse("horizon_refinement_unproven", "Refinement proof is absent or has a different hash", address(ref.id, "inputs", ref), "producer");
    records.push(record);
    if ((record.kind === "phase" || record.kind === "graph-layer") && object(record.value)) {
      if (!Array.isArray(record.value['inputs']) || !record.value['inputs'].every(isRef))
        return refuse("horizon_refinement_unproven", "Refinement proof needs its explicit input set", address(ref.id, "inputs", ref), "producer");
      pending.push(...record.value['inputs'] as unknown as Ref[]);
      if (record.kind === "phase") for (const field of ["draft", "layer"] as const) {
        const input = record.value[field];
        if (isRef(input)) pending.push(input);
        else if (input !== null) return refuse("horizon_refinement_unproven", "Refinement phase has an invalid source", address(ref.id, field, ref), "producer");
      }
    }
  }
  return delivered(records);
}
function readRefinement(store: Store, request: HorizonRequest, graph: Graph): HorizonResult<Sealed<string[]>> {
  if (!request.refinement) return delivered([]);
  if (request.refinement.id === `graph-layer:${request.project}:2`) {
    const basis = readLayerAcceptance(store, { project: request.project, level: 2, graph: request.graph, layer: request.refinement });
    if (!basis.ok) return refuse("horizon_refinement_unproven", basis.refusal.message,
      address(basis.refusal.at.target, basis.refusal.at.field ?? "acceptance", request.refinement), "producer");
    if (basis.value.producer !== "om") return refuse("horizon_refinement_unproven", "Research refinement must retain its accepted milestone",
      address(request.refinement.id, "producer", request.refinement), "producer");
    const relations = new RefinementRelations(graph);
    const frame = store.get<{ fills: { node: string; source: string }[] }>(basis.value.frame!.id, basis.value.frame!.revision)!;
    const identities = new Set(frame.value.fills.filter(fill => fill.source === "identity").map(fill => fill.node));
    return delivered(graph.nodes.filter(block => block.kind === "block" && graph.nodes.some(operation => operation.kind === "operation"
      && !identities.has(operation.id) && relations.refines(operation.id, block.id))).map(block => block.id).sort(order));
  }
  const read = readRecord<SavedPhase>(store, request.refinement, { unit: "G2", target: request.project,
    id: `phase:${request.project}:L2`, kind: "phase" });
  if (!read.ok) return transfer("refs", read);
  const phase = read.value.value;
  const reject = (field: string, source: Ref = request.refinement!) => refuse("horizon_refinement_unproven", "Refinement must be an accepted L2 milestone with its exact proof closure",
    address(source.id, field, source), "producer");
  if (!object(phase) || phase.projectId !== request.project || phase.phase !== "L2" || phase.draft !== null
    || !isRef(phase.layer) || !Array.isArray(phase.inputs) || !phase.inputs.every(isRef)
    || !phase.inputs.some(ref => canonical(ref) === canonical(phase.layer))
    || !phase.inputs.some(ref => ref.id === `phase:${request.project}:R1`)
    || (phase.contractVersion !== undefined && phase.contractVersion !== 2)) return reject("inputs");
  const layerRead = readRecord<LayerBasis>(store, phase.layer, { unit: "G2", target: request.project,
    id: `graph-layer:${request.project}:2`, kind: "graph-layer" });
  if (!layerRead.ok) return transfer("refs", layerRead);
  const layer = layerRead.value.value;
  if (!object(layer) || !object(layer.projection) || !Array.isArray(layer.inputs) || !layer.inputs.every(isRef)
    || !Array.isArray(layer.obligations) || (layer.layerProofs !== undefined && !Array.isArray(layer.layerProofs))) return reject("layer");
  if (graph.version === 2 && !layer.layerProofs?.some(proof => object(proof) && proof.level === 2)) return reject("layerProofs");
  if (graph.version === 1) {
    const checked = readLayerEnvelope(store, { project: request.project, level: 2, graph: request.graph, layer: phase.layer });
    if (!checked.ok) return refuse("horizon_refinement_unproven", checked.refusal.message,
      address(checked.refusal.at.target, checked.refusal.at.field ?? "inputs", phase.layer), "producer");
  }
  const closure = exactClosure(store, [request.refinement, ...layer.inputs]);
  if (!closure.ok) return closure;
  const phaseOrder = ["R0", "L1", "R1", "L2"];
  const byRef = new Map(closure.value.map(record => [canonical(reference(record)), record]));
  for (const record of closure.value) if (record.kind === "phase") {
    const value = record.value, source = reference(record);
    if (!object(value) || value['projectId'] !== request.project || !text(value['phase'])
      || !phaseOrder.includes(value['phase']) || record.id !== `phase:${request.project}:${value['phase']}`)
      return reject("projectId", source);
    if (!Array.isArray(value['inputs']) || !value['inputs'].every(isRef)) return reject("inputs", source);
    const inputs = value['inputs'] as unknown as Ref[];
    const has = (ref: Ref) => inputs.some(input => canonical(input) === canonical(ref));
    const version = value['contractVersion'];
    if (version !== undefined && version !== 2) return reject("contractVersion", source);
    if (version === 2 && value['phase'] !== "R0") {
      const predecessorId = `phase:${request.project}:${phaseOrder[phaseOrder.indexOf(value['phase']) - 1]}`;
      const predecessors = inputs.filter(ref => ref.id === predecessorId);
      if (predecessors.length !== 1) return reject("inputs", source);
      const predecessor = byRef.get(canonical(predecessors[0]));
      if (predecessor?.kind !== "phase" || !object(predecessor.value) || predecessor.value['contractVersion'] !== 2)
        return reject("contractVersion", source);
    }
    if (value['phase'] === "R0" || value['phase'] === "R1") {
      if (value['layer'] !== null || !isRef(value['draft']) || !has(value['draft'])) return reject("draft", source);
      const draft = byRef.get(canonical(value['draft']));
      if (!draft || draft.kind !== "discovery-draft" || (value['phase'] === "R0"
        ? draft.id !== `derived-research:${request.project}:R0` : !draft.id.startsWith(`discovery:${request.project}:`))
        || !object(draft.value) || draft.value['projectId'] !== request.project || draft.value['stage'] !== "om-g2"
        || draft.value['level'] !== value['phase'] || draft.value['consumer'] !== "compilation"
        || (version === 2 && draft.value['contractVersion'] !== 2)) return reject("draft", source);
    } else {
      if (value['draft'] !== null || !isRef(value['layer']) || !has(value['layer'])) return reject("layer", source);
      const savedLayer = byRef.get(canonical(value['layer']));
      const level = value['phase'] === "L1" ? 1 : 2;
      if (!savedLayer || savedLayer.kind !== "graph-layer" || savedLayer.id !== `graph-layer:${request.project}:${level}`
        || !object(savedLayer.value) || !object(savedLayer.value['projection'])
        || canonical(savedLayer.value['projection']) !== canonical(projectGraph(graph, level))) return reject("layer", source);
    }
  }
  if (graph.version === 2) {
    const upper = phase.inputs.filter(ref => ref.id === `graph-layer:${request.project}:1`);
    if (upper.length !== 1) return reject("inputs");
    const checked = readLayerBasis(store, { project: request.project, level: 2, graph: request.graph, layer: phase.layer, upper: upper[0]! });
    if (!checked.ok) return refuse("horizon_refinement_unproven", checked.refusal.message,
      address(checked.refusal.at.target, `layerProofs.${checked.refusal.at.field ?? "inputs"}`, phase.layer), "producer");
    const research = phase.inputs.filter(ref => ref.id === `phase:${request.project}:R1`);
    const ownProof = layer.layerProofs!.find(proof => proof.level === 2)!;
    if (research.length !== 1 || !ownProof.inputs.some((ref: Ref) => canonical(ref) === canonical(research[0]))) return reject("inputs");
  }
  const relations = new RefinementRelations(graph);
  return delivered(graph.nodes.filter(block => block.kind === "block" && graph.nodes.some(operation => operation.kind === "operation"
    && relations.refines(operation.id, block.id))).map(block => block.id).sort(order));
}
function deriveHorizon(store: Store, request: HorizonRequest): HorizonResult<Sealed<HorizonRecord>> {
  const inputRead = readOmInput(store, request.project, request.input);
  if (!inputRead.ok) return transfer("input", inputRead);
  const graphRead = readRecord<Graph>(store, request.graph, { unit: "G2", target: request.project, id: `graph:${request.project}`, kind: "graph" });
  if (!graphRead.ok) return transfer("refs", graphRead);
  const graph = graphRead.value.value as Graph;
  if (!object(graph) || !horizonShapes()[graph.version === 2 ? 1 : 0]!(graph))
    return refuse("horizon_unclosed", "The saved graph has an invalid shape", address(request.graph.id, "graph", request.graph), "producer");
  const map = inputRead.value.value.input.sources.find(source => source.stage === "operation-map")!;
  const stage = readRecord<StageArtifact>(store, map, { unit: "G2", target: request.project, id: `stage:${request.project}:operation-map`, kind: "stage" });
  if (!stage.ok) return transfer("refs", stage);
  const layerRef = object(stage.value.value.content) ? stage.value.value.content['graph'] : null;
  const layer = readRecord<LayerBasis>(store, layerRef, { unit: "G2", target: request.project, id: `graph-layer:${request.project}:1`, kind: "graph-layer" });
  if (!layer.ok) return transfer("refs", layer);
  if (canonical(projectGraph(graph, 1)) !== canonical(layer.value.value.projection))
    return refuse("horizon_unclosed", "The graph must retain the exact accepted upper layer from OM input", address(request.graph.id, "upper", request.graph), "producer");
  const refined = readRefinement(store, request, graph);
  if (!refined.ok) return refined;
  for (const [block, basis] of Object.entries(request.available)) {
    if (!object(basis) || !Object.keys(basis).length || !Object.values(basis).every(isRef))
      return refuse("horizon_available_unproven", "Availability needs exact receipts per artifact", address(block, "available"), "readiness");
    for (const [artifact, ref] of Object.entries(basis)) {
      const receipt = readRecord<ArtifactReceipt>(store, ref, { unit: "G2", target: block, id: receiptId(request.project, artifact), kind: "artifact" });
      if (!receipt.ok) return transfer("refs", receipt);
      if (!receiptShape(receipt.value.value, request.project, artifact))
        return refuse("horizon_available_unproven", "The receipt must name this project and artifact with complete producer evidence", address(block, artifact, ref), "readiness");
    }
  }
  const { level: _level, ...projection } = projectGraph(graph, 1);
  const upper = { ...projection, version: graph.version } as Graph;
  const options = { ...request.choice, refined: refined.value as string[], available: request.available };
  const result = closeHorizon(upper, options);
  const knownOutcomes = new Set(inputRead.value.value.input.features.map(feature => feature.outcome));
  const extra: Refusal<HorizonRefusalCode>[] = [];
  for (const feature of request.choice.features) if (!knownOutcomes.has(feature.outcome)) {
    const refusal = refuse("horizon_feature_unknown", "The owner choice must name a feature of the accepted input", address(feature.outcome, "features"), "owner");
    if (!refusal.ok) extra.push(refusal.refusal);
  }
  return delivered({ project: request.project, request, result: { ...result, refusals: sorted([...result.refusals, ...extra]) } });
}

function currentHorizonSources(store: Store, request: HorizonRequest): HorizonResult<Sealed<TransactionGuard[]>> {
  const guards = new Map<string, TransactionGuard>();
  const remember = (guard: TransactionGuard) => {
    const previous = guards.get(guard.id);
    if (previous) {
      if ('absent' in previous !== 'absent' in guard || canonical(previous) !== canonical(guard)) {
        raise("input_stale", "A horizon prerequisite changed during preparation",
          address(guard.id, "head", !('absent' in previous) ? previous : undefined));
      }
    }
    guards.set(guard.id, guard);
  };
  const matchHeads = (targetStore: Store, candidateGuards: readonly TransactionGuard[]): HeadsMatch => {
    const physical = provenStore(targetStore);
    if (physical && !storeObserved(physical)) return physical.headsMatch(candidateGuards);
    const mismatches: HeadsMatchMismatch[] = [];
    for (const g of candidateGuards) {
      const head = targetStore.get(g.id);
      if ('absent' in g) {
        if (head !== null) mismatches.push({ id: g.id, expected: [g], actual: head ? { id: head.id, kind: head.kind, revision: head.revision, hash: head.hash } : null });
      } else {
        if (!head || head.revision !== g.revision || head.hash !== g.hash) {
          mismatches.push({ id: g.id, expected: [g], actual: head ? { id: head.id, kind: head.kind, revision: head.revision, hash: head.hash } : null });
        }
      }
    }
    return { ok: mismatches.length === 0, conflict: false, mismatches };
  };
  try {
    const refs = [request.input, request.graph, ...(request.refinement ? [request.refinement] : []),
      ...Object.values(request.available).flatMap(basis => Object.values(basis))];
    const match = matchHeads(store, refs);
    if (!match.ok) {
      const failing = refs.find(r => match.mismatches.some(m => m.id === r.id)) ?? refs[0]!;
      return refuse("input_stale", "The horizon prerequisite is no longer current", address(failing.id, "head", failing), "producer");
    }
    for (const ref of refs) remember(ref);
    const prepared = prepareExistingOmInput(store, request.project, request.input);
    if (!prepared.ok) return transfer("input", prepared);
    if (!prepared.value.existing || canonical(reference(prepared.value.existing)) !== canonical(request.input))
      return refuse("input_stale", "Horizon needs the currently admitted input", address(request.input.id, "input", request.input), "producer");
    for (const guard of prepared.value.guards) remember(guard);
    if (request.refinement?.id === `graph-layer:${request.project}:2`) {
      const basis = readLayerAcceptance(store, { project: request.project, level: 2, graph: request.graph, layer: request.refinement });
      if (!basis.ok) return refuse("horizon_refinement_unproven", basis.refusal.message,
        address(basis.refusal.at.target, basis.refusal.at.field ?? "acceptance", request.refinement), "producer");
      const layerMatch = matchHeads(store, basis.value.currentReferences);
      if (!layerMatch.ok) {
        const failing = basis.value.currentReferences.find(r => layerMatch.mismatches.some(m => m.id === r.id)) ?? basis.value.currentReferences[0]!;
        return refuse("input_stale", "The accepted OM refinement is no longer current", address(failing.id, "head", failing), "producer");
      }
      for (const ref of basis.value.currentReferences) remember(ref);
    } else if (request.refinement) {
      const engine = new StageChecks(store);
      const phase = store.get<SavedPhase>(request.refinement.id, request.refinement.revision)!;
      for (const [name, gate] of [["refinement.L2", engine.refinement.gate(request.project, "L2")],
        ["layer.2", engine.graphs.layerGate(request.project, 2, phase.value.layer!)]] as const) {
        const admission = readOmAdmissionGuards(gate.admissionGuards, name, "G2");
        if (!admission.ok) return transfer("input", admission);
        if (gate.findings.length) {
          const finding = gate.findings[0]!;
          return refuse("horizon_refinement_unproven", finding.message, address(finding.target, finding.code, request.refinement), "producer");
        }
        for (const guard of [...gate.guards, ...admission.value]) remember(guard);
      }
    }
    return delivered(uniqueTransactionGuards([...guards.values()]));
  } catch (error) {
    if (error instanceof EngineError && error.code === "input_stale")
      return refuse("input_stale", error.message, address(request.project, "sources"), "producer");
    throw error;
  }
}
function gateRecord(record: HorizonRecord, horizon: Ref): OmHorizonRecord {
  const codes = [...new Set([...record.result.refusals.map(item => item.code), ...record.result.conflicts.map(item => item.code)])].sort(order);
  return { project: record.project, choiceVersion: record.request.choice.choiceVersion, horizon,
    horizonHash: record.result.horizon.hash, state: codes.length ? "refused" : "accepted", codes };
}
function replay(store: Store, request: HorizonRequest): HorizonResult<Sealed<HorizonRecords | null>> {
  const suffix = `${request.project}:${request.choice.choiceVersion}`;
  const gate = store.get<OmHorizonRecord>(`om-horizon:${suffix}`);
  if (!gate) {
    if (store.get(`horizon:${suffix}`)) return refuse("record_forged", "A horizon candidate has no atomic G2 outcome", address(`horizon:${suffix}`, "gate"), "producer");
    return delivered(null);
  }
  const saved = readHorizon(store, request.project, reference(gate));
  if (!saved.ok) return saved;
  if (canonical(saved.value.horizon.value.request) !== canonical(request))
    return refuse("horizon_choice_conflict", "This owner choice version already names a different request", address(gate.id, "choiceVersion", reference(gate)), "owner");
  return saved;
}
export function prepareHorizon(store: Store, request: HorizonRequest): HorizonResult<Sealed<PreparedHorizon>> {
  requireRequest(store, request);
  request = normalizedRequest(request);
  const existing = replay(store, request);
  if (!existing.ok) return existing;
  const derived = existing.value ? delivered(existing.value.horizon.value) : deriveHorizon(store, request);
  if (!derived.ok) return derived;
  const admission = currentHorizonSources(store, request);
  if (!admission.ok) return admission;
  const record = derived.value as HorizonRecord;
  const horizon = { id: `horizon:${request.project}:${request.choice.choiceVersion}`, revision: 1, hash: hashJson(record) };
  const gate = gateRecord(record, horizon);
  const writes: Write[] = existing.value ? [] : [
    { id: horizon.id, kind: "horizon", expected: 0, value: record },
    { id: `om-horizon:${request.project}:${request.choice.choiceVersion}`, kind: "om-horizon", expected: 0, value: gate },
  ];
  return delivered({ record, gate, writes, guards: uniqueTransactionGuards([...admission.value,
    ...(existing.value ? [reference(existing.value.horizon), reference(existing.value.gate)] : [])]), existing: existing.value });
}
export function writeHorizon(store: Store, request: HorizonRequest): HorizonResult<Sealed<HorizonRecords>> {
  requireRequest(store, request);
  request = normalizedRequest(request);
  // Delivery of an already applied owner command is historical; using it in a new transaction calls prepareHorizon.
  const existing = replay(store, request);
  if (!existing.ok) return existing;
  if (existing.value) return delivered(existing.value);
  const prepared = prepareHorizon(store, request);
  if (!prepared.ok) return prepared;
  if (prepared.value.existing) return delivered(prepared.value.existing);
  const written = writeGuarded(store, { unit: "G2", target: request.project, writes: prepared.value.writes as Write[], guards: prepared.value.guards });
  if (!written.ok) return transfer("refs", written);
  return delivered({ horizon: written.value[0] as unknown as Revision<HorizonRecord>, gate: written.value[1] as unknown as Revision<OmHorizonRecord> });
}
/** NR1 (№3600): a trusted read — prepareHorizon derived the horizon and its G2 outcome from their exact sources once. */
export function readHorizon(store: Store, project: string, ref: Ref): HorizonResult<Sealed<HorizonRecords>> {
  requireStore(store, project);
  if (!isRef(ref)) invalid("reference");
  const gate = readRecord<OmHorizonRecord>(store, ref, { unit: "G2", target: project, idPrefix: `om-horizon:${project}:`, kind: "om-horizon" });
  if (!gate.ok) return transfer("refs", gate);
  const value = gate.value.value;
  const horizon = readRecord<HorizonRecord>(store, value.horizon, { unit: "G2", target: project,
    id: `horizon:${project}:${value.choiceVersion}`, kind: "horizon" });
  if (!horizon.ok) return transfer("refs", horizon);
  return delivered({ horizon: horizon.value, gate: gate.value });
}

export const HORIZON_ISSUANCE_CONTRACT = "om-horizon-issuance/v1";
export const HORIZON_ISSUANCE_KIND = "om-horizon-issuance";
export const HORIZON_ISSUANCE_CODES = Object.freeze([
  "horizon_issuance_request_invalid", "horizon_issuance_binding_invalid", "horizon_issuance_record_invalid",
] as const);
export interface HorizonIssuanceRequest { project: string; choiceVersion: string; horizon: Ref; transition: Ref }
export interface HorizonIssuanceRecord extends HorizonIssuanceRequest {
  contract: typeof HORIZON_ISSUANCE_CONTRACT; state: "accepted" | "refused"; codes: string[];
}
export interface PreparedHorizonIssuance {
  record: Revision<HorizonIssuanceRecord>; writes: Write[]; guards: TransactionGuard[];
}
export interface CheckedHorizonIssuance { record: Revision<HorizonIssuanceRecord>; references: Ref[] }
interface DerivedHorizonIssuance extends CheckedHorizonIssuance {
  transitionRequest: Parameters<typeof prepareSeriesTransition>[1];
}
const issuanceObject = (value: unknown): value is Record<string, unknown> => object(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const issuanceKeys = (value: object, fields: string[]): boolean => canonical(Object.keys(value).sort()) === canonical([...fields].sort());
const issuanceRef = (value: unknown): value is Ref => issuanceObject(value)
  && issuanceKeys(value, ["id", "revision", "hash"]) && isRef(value);
const issuanceProject = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
const issuanceChoice = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const issuanceRefs = (values: readonly Ref[]): Ref[] => sorted([...new Map(values.map(ref => [canonical(ref), ref])).values()]);
const issuanceId = (request: HorizonIssuanceRequest): string => `${HORIZON_ISSUANCE_KIND}:${request.project}:${hashJson({ horizon: request.horizon, transition: request.transition })}`;
function issuanceFailure(code: typeof HORIZON_ISSUANCE_CODES[number], target: string, field: string, message: string, ref?: Ref): HorizonResult<never> {
  return refuse(code, message, address(target, field, ref), "producer");
}
function checkIssuanceRequest(store: Store, request: HorizonIssuanceRequest): HorizonResult<Sealed<HorizonIssuanceRequest>> {
  const bad = (field: string) => issuanceFailure("horizon_issuance_request_invalid", "horizon-issuance", field,
    "A G2 issuance needs its explicit project, choice version, exact horizon and saved prepared transition");
  if (!(store instanceof Store)) return bad("store");
  if (!issuanceObject(request)) return bad("request");
  if (!issuanceProject(request.project)) return bad("project");
  if (!issuanceChoice(request.choiceVersion)) return bad("choiceVersion");
  if (!issuanceRef(request.horizon)) return bad("horizon");
  if (!issuanceRef(request.transition)) return bad("transition");
  if (!issuanceKeys(request, ["project", "choiceVersion", "horizon", "transition"])) return bad("request");
  return delivered(request);
}
/** P proves its own sources; G binds that exact P to the independently checked horizon outcome. */
function deriveHorizonIssuance(store: Store, request: HorizonIssuanceRequest): HorizonResult<Sealed<DerivedHorizonIssuance>> {
  const horizon = readHorizon(store, request.project, request.horizon);
  if (!horizon.ok) return horizon;
  const gate = horizon.value.gate.value;
  if (gate.project !== request.project || gate.choiceVersion !== request.choiceVersion)
    return issuanceFailure("horizon_issuance_binding_invalid", request.horizon.id, "horizon",
      "The issuance must name the proved horizon outcome of this exact project and choice version", request.horizon);
  const transition = readPreparedSeriesTransition(store, { project: request.project, record: request.transition });
  if (!transition.ok) return transfer("series-transition", transition);
  const prepared = transition.value.record.value;
  if (prepared.state !== "prepared" || prepared.request.project !== request.project
    || prepared.request.choiceVersion !== request.choiceVersion || canonical(prepared.request.horizon) !== canonical(request.horizon))
    return issuanceFailure("horizon_issuance_binding_invalid", request.transition.id, "horizon",
      "The prepared transition must derive from this exact horizon, project and choice version", request.transition);
  const value: HorizonIssuanceRecord = { contract: HORIZON_ISSUANCE_CONTRACT, ...request, state: gate.state, codes: [...gate.codes] };
  const record: Revision<HorizonIssuanceRecord> = { id: issuanceId(request), kind: HORIZON_ISSUANCE_KIND, revision: 1, hash: hashJson(value), value };
  return delivered({ record, transitionRequest: prepared.request as Parameters<typeof prepareSeriesTransition>[1],
    references: issuanceRefs([request.horizon, reference(horizon.value.horizon), request.transition, ...transition.value.references]) });
}
function readIssuanceRecord(store: Store, project: string, ref: Ref): HorizonResult<Sealed<CheckedHorizonIssuance>> {
  const saved = readRecord<HorizonIssuanceRecord>(store, ref, { unit: "G2", target: ref.id,
    idPrefix: `${HORIZON_ISSUANCE_KIND}:${project}:`, kind: HORIZON_ISSUANCE_KIND });
  if (!saved.ok) return transfer("refs", saved);
  const value = saved.value.value;
  const bad = (field: string) => issuanceFailure("horizon_issuance_record_invalid", ref.id, field,
    "The issuance must be reproduced from its exact saved prepared transition and horizon", ref);
  if (!issuanceObject(value)) return bad("record");
  const fields = ["contract", "project", "choiceVersion", "horizon", "transition", "state", "codes"];
  for (const field of fields) if (!Object.hasOwn(value, field)) return bad(field);
  if (!issuanceKeys(value, fields)) return bad("record");
  if (value.contract !== HORIZON_ISSUANCE_CONTRACT) return bad("contract");
  if (value.project !== project) return bad("project");
  // NR (№3600): a trusted read — prepareHorizonIssuance derived the issuance from its exact P and horizon once.
  return delivered({ record: saved.value, references: issuanceRefs([ref, value.horizon, value.transition]) });
}
/** Historical delivery never replaces the named P revision with its later applied/discarded head. */
export function readHorizonIssuance(store: Store, request: { project: string; record: Ref }): HorizonResult<Sealed<CheckedHorizonIssuance>> {
  const bad = (field: string) => issuanceFailure("horizon_issuance_request_invalid", "horizon-issuance", field,
    "A saved G2 issuance is read by its project and exact record reference");
  if (!(store instanceof Store)) return bad("store");
  if (!issuanceObject(request)) return bad("request");
  if (!issuanceProject(request.project)) return bad("project");
  if (!issuanceRef(request.record)) return bad("record");
  if (!issuanceKeys(request, ["project", "record"])) return bad("request");
  return readIssuanceRecord(store, request.project, request.record);
}
export function prepareHorizonIssuance(store: Store, request: HorizonIssuanceRequest): HorizonResult<Sealed<PreparedHorizonIssuance>> {
  const checked = checkIssuanceRequest(store, request);
  if (!checked.ok) return checked;
  request = checked.value as HorizonIssuanceRequest;
  const derived = deriveHorizonIssuance(store, request);
  if (!derived.ok) return derived;
  const record = derived.value.record, existing = store.get(record.id);
  if (existing && canonical(existing) !== canonical(record))
    return issuanceFailure("horizon_issuance_record_invalid", record.id, "content", "An immutable issuance cannot be replaced by different content", reference(existing));
  const current = prepareSeriesTransition(store, derived.value.transitionRequest as Parameters<typeof prepareSeriesTransition>[1]);
  if (!current.ok) return transfer("series-transition", current);
  if (current.value.writes.length || canonical(reference(current.value.record)) !== canonical(request.transition))
    return issuanceFailure("horizon_issuance_binding_invalid", request.transition.id, "transition",
      "An issuance uses an already saved exact preparation; it cannot create or replace that preparation", request.transition);
  for (const source of [request.horizon, request.transition]) {
    const head = store.get(source.id);
    if (!head || canonical(reference(head)) !== canonical(source))
      return refuse("input_stale", "The horizon or prepared transition is no longer current", address(source.id, "source", source), "producer");
  }
  return delivered({ record, writes: existing ? [] : [{ id: record.id, kind: record.kind, expected: 0, value: record.value }],
    guards: uniqueTransactionGuards([...current.value.guards, request.horizon, request.transition, ...(existing ? [reference(existing)] : [])]) });
}
export function writeHorizonIssuance(store: Store, request: HorizonIssuanceRequest): HorizonResult<Sealed<Revision<HorizonIssuanceRecord>>> {
  const checked = checkIssuanceRequest(store, request);
  if (!checked.ok) return checked;
  request = checked.value as HorizonIssuanceRequest;
  const existing = store.get(issuanceId(request));
  if (existing) {
    const saved = readIssuanceRecord(store, request.project, reference(existing));
    if (!saved.ok) return saved;
    const value = saved.value.record.value;
    if (value.choiceVersion !== request.choiceVersion || canonical(value.horizon) !== canonical(request.horizon)
      || canonical(value.transition) !== canonical(request.transition))
      return issuanceFailure("horizon_issuance_binding_invalid", existing.id, "request", "A repeat must name the exact original issuance request", reference(existing));
    return delivered(saved.value.record);
  }
  const prepared = prepareHorizonIssuance(store, request);
  if (!prepared.ok) return prepared;
  if (!prepared.value.writes.length) return delivered(prepared.value.record);
  const written = writeGuarded<HorizonIssuanceRecord>(store, { unit: "G2", target: prepared.value.record.id,
    writes: prepared.value.writes, guards: prepared.value.guards });
  if (!written.ok) return transfer("refs", written);
  return delivered(written.value[0]!);
}
