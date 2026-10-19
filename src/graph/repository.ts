import { Store, storeObserved, type Revision, type RevisionIdentity, type TransactionGuard } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { requireCondition } from "../errors.js";
import { canonical, hashJson } from "../canonical.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { reference, uniqueRefs, STAGE_CLOSURE_CONTRACT, type Ref, type GateResult,
  type StageExternalCheck, type ExternalCheckHandler } from "../pipeline/contracts.js";
import { requireGraph, validateGraph } from "./validate.js";
import type { Graph } from "./model.js";
import { LEVEL } from "./model.js";
import { projectGraph } from "./project.js";
import { sourceIsCurrent, withSourceMemo, type Source } from "../evidence/evidence.js";
import { continuityFindings } from "./semantics.js";
import { composeLayer, layerDesignSpec, LAYER_DESIGN_VERSION } from "./layer-design.js";
import { obligationHandoff } from './obligation-handoff.js';
import { requireTaskObligations } from './task-obligations.js';

/** LG1: pure derivations shared inside one synchronous read — nothing store-dependent is cached,
 * and only where the reading store is a proven Store outside active observation (LAYERGATE1-01).
 * `projections` — projection hash by exact graph Ref + level; `fields` — an obligation field's hash
 * (or node absence) by the exact Ref of the record holding the nodes + node/field. */
interface GraphReadMemo { projections: Map<string, string>; fields: Map<string, string | null> }
let graphReadScope: WeakMap<Store, GraphReadMemo> | null = null;
/** One synchronous read, with no writes: share exact pure derivations across its neighboring graph
 * gates. Each Store view keeps its own memo; neither a successful read nor an exception leaves a
 * cache behind. Callers that gate the same vertex twice in one read reuse the derivations — the
 * GateResult itself is never cached and the heads are re-compared on every call. */
export function withGraphRead<T>(read: () => T): T {
  if (graphReadScope) return read();
  return withSourceMemo(() => {
    graphReadScope = new WeakMap();
    try { return read(); } finally { graphReadScope = null; }
  });
}
function graphReadMemo(store: Store): GraphReadMemo | null {
  if (!graphReadScope) return null;
  let memo = graphReadScope.get(store);
  if (!memo) { memo = { projections: new Map(), fields: new Map() }; graphReadScope.set(store, memo); }
  return memo;
}

interface Obligation { node: string; field: string; valueHash: string; inputs: Ref[] }
interface LayerProof { level: 1 | 2 | 3; hash: string; inputs: Ref[] }
interface Binding { graph: Ref; inputs: Ref[]; actor: string; obligations: Obligation[]; layerProofs?: LayerProof[] }
interface Layer { projection: ReturnType<typeof projectGraph>; inputs: Ref[]; obligations: Obligation[]; layerProofs?: LayerProof[] }
export class GraphRepository {
  constructor(private readonly store: Store, private readonly discovery: Discovery) {}
  #write(projectId: string, graph: Graph, expected: number, actor: string, obligations: Obligation[], guards: Ref[] = [], layerProofs: LayerProof[] = []): Revision<Graph> {
    requireCondition(typeof actor === "string" && actor.trim(), "actor_missing", "Graph changes require an author");
    const id = `graph:${projectId}`; const bindingId = `graph-binding:${projectId}`;
    const binding = this.store.get<Binding>(bindingId);
    const previous = this.store.get<Graph>(id);
    requireCondition(!previous || previous.value.id === graph.id, "graph_identity_changed", "Refinement must preserve the identity of the same operation map");
    requireCondition(!previous || previous.value.version !== 2 || graph.version === 2, "graph_downgrade", "An enriched graph cannot be downgraded to bypass its contracts");
    const continuity = previous ? continuityFindings(previous.value, graph) : [];
    requireCondition(continuity.length === 0, "graph_semantic_drift", continuity.map(item => `${item.code}: ${item.target}`).join("; "));
    if (previous?.revision === expected && previous.hash === hashJson(graph) && binding?.value.actor === actor
      && canonical(binding.value.obligations) === canonical(obligations) && canonical(binding.value.layerProofs ?? []) === canonical(layerProofs)) return previous;
    const inputs = uniqueRefs([...obligations.flatMap(obligation => obligation.inputs), ...layerProofs.flatMap(proof => proof.inputs)]);
    const ref = { id, revision: expected + 1, hash: hashJson(graph) };
    const writes = [
      { id, kind: "graph", expected, value: graph },
      { id: bindingId, kind: "graph-binding", expected: binding?.revision ?? 0, value: { graph: ref, actor, inputs, obligations, ...(layerProofs.length ? { layerProofs } : {}) } },
    ] as { id: string; kind: string; expected: number; value: unknown }[];
    for (const level of [1, 2, 3] as const) {
      const layerId = `graph-layer:${projectId}:${level}`;
      const previous = this.store.get<Layer>(layerId);
      const applicable = obligations.filter(obligation => {
        const node = graph.nodes.find(item => item.id === obligation.node);
        return node && LEVEL[node.kind] <= level;
      });
      const proofs = layerProofs.filter(proof => proof.level <= level);
      const value: Layer = { projection: projectGraph(graph, level), inputs: uniqueRefs([...applicable.flatMap(obligation => obligation.inputs), ...proofs.flatMap(proof => proof.inputs)]),
        obligations: applicable, ...(proofs.length ? { layerProofs: proofs } : {}) };
      if (!previous || previous.hash !== hashJson(value)) writes.push({ id: layerId, kind: "graph-layer", expected: previous?.revision ?? 0, value });
    }
    return this.store.writeMany<Graph>(writes, guards)[0]!;
  }
  save(projectId: string, value: unknown, expected: number, actor: string): Revision<Graph> {
    const graph = requireGraph(value);
    const previous = this.store.get<Binding>(`graph-binding:${projectId}`);
    // Ordinary authoring never turns an evidence-backed field into an untracked declaration.
    const obligations = (previous?.value.obligations ?? []).filter(item => graph.nodes.some(node => node.id === item.node));
    return this.#write(projectId, graph, expected, actor, obligations, [], previous?.value.layerProofs ?? []);
  }
  saveDerived(projectId: string, value: unknown, expected: number, actor: string, draftRef: Ref): Revision<Graph> {
    const graph = requireGraph(value); const checked = this.discovery.gate(projectId, draftRef);
    requireCondition(checked.findings.length === 0, "research_unresolved", "Map derivation needs current research");
    const obligations = graph.nodes.flatMap(node => (["title", "outcome", "ports"] as const).map(field => ({
      node: node.id, field, valueHash: hashJson(node[field]), inputs: checked.guards,
    })));
    const proofs: LayerProof[] = graph.version === 2 ? [{ level: 1, hash: hashJson(projectGraph(graph, 1)), inputs: checked.guards }] : [];
    return this.#write(projectId, graph, expected, actor, obligations, checked.guards, proofs);
  }
  refine(projectId: string, expected: number, draftRef: Ref, actor: string): Revision<Graph> {
    const graph = this.store.get<Graph>(`graph:${projectId}`);
    requireCondition(graph && graph.revision === expected && graph.kind === "graph", "graph_stale", "Graph changed or is missing");
    const result = this.discovery.gate(projectId, draftRef);
    requireCondition(result.findings.length === 0, "research_unresolved", "Only fully resolved discovery can refine the graph");
    const draft = this.store.get<DiscoveryDraft>(draftRef.id)!;
    const node = graph.value.nodes.find(item => item.id === draft.value.consumer);
    requireCondition(node, "consumer_missing", "Discovery must target an existing graph node");
    requireCondition(Object.keys(draft.value.fields).every(field => ["title", "ports", "code", "tests", "boundary"].includes(field)),
      "refinement_field_invalid", "Discovery cannot replace stable IDs or unrelated graph fields");
    const successor = structuredClone(graph.value);
    successor.nodes = successor.nodes.map(item => item.id === node.id ? { ...item, ...draft.value.fields } : item);
    const checked = requireGraph(successor);
    const prior = this.store.get<Binding>(`graph-binding:${projectId}`);
    const fields = new Set(Object.keys(draft.value.fields));
    const obligations = (prior?.value.obligations ?? []).filter(item => item.node !== node.id || !fields.has(item.field));
    for (const field of fields) obligations.push({ node: node.id, field, valueHash: hashJson(draft.value.fields[field]), inputs: result.guards });
    return this.#write(projectId, checked, expected, actor, obligations, result.guards, prior?.value.layerProofs ?? []);
  }
  deriveLayer(projectId: string, level: 2 | 3, expected: number, draftRef: Ref, actor: string, guards: Ref[] = []): Revision<Graph> {
    const current = this.store.get<Graph>(`graph:${projectId}`);
    requireCondition(current?.kind === "graph" && current.revision === expected, "graph_stale", "Graph changed or is missing");
    const checked = this.discovery.gate(projectId, draftRef);
    requireCondition(checked.findings.length === 0, "research_unresolved", "Layer construction requires current resolved research");
    const draft = this.store.get<DiscoveryDraft>(draftRef.id)!;
    const questions = draft.value.questions.map(id => this.store.get<Question>(id)!);
    const research = this.store.get(`phase:${projectId}:R${level - 1}`);
    const upper = this.store.get(`graph-layer:${projectId}:${level - 1}`);
    const handoff = level === 3 && research ? obligationHandoff(this.store, projectId, [reference(research)]) : null;
    requireCondition(draft.value.stage === "om-g2" && draft.value.level === `R${level - 1}`
      && draft.value.consumer === current.value.nodes.find(node => node.kind === "product")?.id
      && draft.value.contractVersion === LAYER_DESIGN_VERSION
      && canonical(questions.map(question => question.value.spec)) === canonical([layerDesignSpec(level, handoff)])
      && research && upper && [research, upper].every(record => draft.value.inputs.some(ref => canonical(ref) === canonical(reference(record)))),
    "layer_research_foreign", "Layer design must use its exact contract, accepted research and upper layer");
    requireCondition(questions.every(question => question.value.answer && this.store.get(question.value.answer.id)?.kind === "research-answer"),
      "research_assessment_required", "Layer construction requires assessed model research, not a manual graph declaration");
    const graph = composeLayer(current.value, level, draft.value.fields['layerDesign'], questions[0]!.value.spec.layerAssembly);
    if (handoff) requireTaskObligations(this.store, projectId, graph, handoff);
    const prior = this.store.get<Binding>(`graph-binding:${projectId}`);
    const proofs = [...(prior?.value.layerProofs ?? []).filter(proof => proof.level < level),
      { level, hash: hashJson(projectGraph(graph, level)), inputs: checked.guards }];
    if (canonical(prior?.value.layerProofs?.find(proof => proof.level === level) ?? null) === canonical(proofs.at(-1)))
      proofs.push(...(prior?.value.layerProofs ?? []).filter(proof => proof.level > level));
    const obligations = (prior?.value.obligations ?? []).filter(obligation => {
      const node = graph.nodes.find(item => item.id === obligation.node);
      return node && LEVEL[node.kind] < level;
    });
    return this.#write(projectId, graph, expected, actor, obligations,
      uniqueRefs([...guards, ...checked.guards, reference(current)]), proofs);
  }
  layerIsDerived(projectId: string, level: 2 | 3): boolean {
    const layer = this.store.get<Layer>(`graph-layer:${projectId}:${level}`);
    return Boolean(layer?.value.layerProofs?.some(proof => proof.level === level));
  }
  /** The physical Store this repository's reads are proven to be: a genuine Store, or a write-only
   * view proven identical to one, while no capture is actively observing it (LAYERGATE1-01). Only
   * then may a Ref-keyed memo or the shared headsMatch snapshot answer — an exact Ref out of any
   * other store or view certifies no body, so opaque/observed reads derive from the body each get
   * actually returns, and their source checks never borrow a Ref memo. */
  #physical(): Store | null {
    const physical = provenStore(this.store);
    return physical !== null && !storeObserved(physical) ? physical : null;
  }
  /** The hash of one graph's projection at a level — a pure derivation of the graph body, shared
   * inside a withGraphRead scope by the exact graph Ref and level, on proven reads only (LG1). */
  #projectionHash(graph: Revision<Graph>, level: 1 | 2 | 3): string {
    const memo = this.#physical() !== null ? graphReadMemo(this.store) : null;
    const key = `${canonical(reference(graph))}:${level}`;
    const cached = memo?.projections.get(key);
    if (cached !== undefined) return cached;
    const hash = hashJson(projectGraph(graph.value, level));
    memo?.projections.set(key, hash);
    return hash;
  }
  /** An obligation field's hash — a pure derivation of the record holding the nodes (layer
   * projection or graph), shared inside a withGraphRead scope by its exact Ref + node/field, on
   * proven reads only (LG1). `null` marks a node absent from the record. */
  #obligationFieldHash(holder: Ref, nodes: readonly { id: string }[], node: string, field: string): string | null {
    const memo = this.#physical() !== null ? graphReadMemo(this.store) : null;
    const key = `${canonical(holder)}:${node}:${field}`;
    if (memo && memo.fields.has(key)) return memo.fields.get(key)!;
    const found = nodes.find(item => item.id === node);
    const hash = found ? hashJson((found as unknown as Record<string, unknown>)[field]) : null;
    memo?.fields.set(key, hash);
    return hash;
  }
  /** The shared input scan of both graph gates (LG1): on a proved Store with no capture actively
   * observing, the input heads come from ONE chunked headsMatch snapshot and each input is then
   * compared to its snapshot head exactly as the per-input loop does — two revisions of one id are
   * answered per input — and only the ids whose snapshot kind is Source get their bodies read and
   * checked (a lawful Source id carries no 'source:' prefix requirement, G2a). The budget of one
   * inspection is then 1 + ceil(D/999) + S physical reads here (D distinct inputs, S matched
   * Sources). Every other store or view, and every read a proof is capturing, keeps the per-input
   * observable get — that fallback runs no snapshot and has no such budget. */
  #evidenceInputs(inputs: Ref[], staleMessage: string): { findings: GateResult['findings']; guards: Ref[]; sources: StageExternalCheck[] } {
    const findings: GateResult['findings'] = [], guards: Ref[] = [], sources: StageExternalCheck[] = [];
    const physical = this.#physical();
    if (physical !== null) {
      const heads = new Map<string, RevisionIdentity>(
        physical.headsMatch(inputs as TransactionGuard[]).heads.map(head => [head.id, head]));
      for (const input of inputs) {
        const head = heads.get(input.id);
        if (!head || head.revision !== input.revision || head.hash !== input.hash) {
          findings.push({ code: "graph_evidence_stale", target: input.id, message: staleMessage });
          continue;
        }
        if (head.kind === "source") {
          const current = physical.get<Source>(input.id, input.revision);
          if (!current || current.kind !== "source" || current.hash !== input.hash || !sourceIsCurrent(current.value, input)) {
            findings.push({ code: "graph_evidence_stale", target: input.id, message: staleMessage });
            continue;
          }
          sources.push({ kind: "source", ref: input });
        }
        guards.push({ id: input.id, revision: input.revision, hash: input.hash });
      }
      return { findings, guards, sources };
    }
    for (const input of inputs) {
      const current = this.store.get(input.id);
      if (!current || current.hash !== input.hash || current.revision !== input.revision
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) findings.push({ code: "graph_evidence_stale", target: input.id, message: staleMessage });
      else {
        guards.push(reference(current));
        if (current.kind === "source") sources.push({ kind: "source", ref: input });
      }
    }
    return { findings, guards, sources };
  }
  layerGate(projectId: string, level: 1 | 2 | 3, expected?: Ref): GateResult {
    return withGraphRead(() => this.#layerGate(projectId, level, expected));
  }
  #layerGate(projectId: string, level: 1 | 2 | 3, expected?: Ref): GateResult {
    const layer = this.store.get<Layer>(`graph-layer:${projectId}:${level}`);
    if (!layer || layer.kind !== "graph-layer" || (expected && (expected.id !== layer.id || expected.hash !== layer.hash || expected.revision !== layer.revision))) {
      return { findings: [{ code: "graph_layer_stale", target: `graph-layer:${projectId}:${level}`, message: "This graph layer is missing or changed" }], guards: [] };
    }
    const result: GateResult = { findings: [], guards: [reference(layer)] };
    const graph = this.store.get<Graph>(`graph:${projectId}`);
    for (const proof of layer.value.layerProofs ?? []) if (!graph || this.#projectionHash(graph, proof.level) !== proof.hash)
      result.findings.push({ code: "graph_layer_unproven", target: `L${proof.level}`, message: "Layer semantics changed without an updated research result" });
    for (const obligation of layer.value.obligations) {
      if (this.#obligationFieldHash(reference(layer), layer.value.projection.nodes, obligation.node, obligation.field) !== obligation.valueHash) result.findings.push({ code: "graph_field_unproven", target: `${obligation.node}/${obligation.field}`, message: "The field changed without a matching research result" });
    }
    const checked = this.#evidenceInputs(uniqueRefs(layer.value.inputs), "Research behind this layer has changed");
    result.findings.push(...checked.findings);
    result.guards.push(...checked.guards);
    const sources = checked.sources;
    const external: StageExternalCheck[] = [];
    const levelProof = layer.value.layerProofs?.find(p => p.level === level);
    const projectionHash = levelProof?.hash ?? hashJson(layer.value.projection);
    external.push({ kind: "graph-projection", level, hash: projectionHash });
    external.push(...sources);
    result.closure = { contract: STAGE_CLOSURE_CONTRACT, external };
    return result;
  }
  gate(projectId: string, expected?: Ref): GateResult {
    return withGraphRead(() => this.#gate(projectId, expected));
  }
  #gate(projectId: string, expected?: Ref): GateResult {
    const graph = this.store.get<Graph>(`graph:${projectId}`);
    const binding = this.store.get<Binding>(`graph-binding:${projectId}`);
    const result: GateResult = { findings: [], guards: [] };
    if (!graph || !binding || graph.kind !== "graph" || binding.kind !== "graph-binding"
      || binding.value.graph.hash !== graph.hash || binding.value.graph.revision !== graph.revision
      || (expected && (expected.id !== graph.id || expected.hash !== graph.hash || expected.revision !== graph.revision))) {
      result.findings.push({ code: "graph_stale", target: `graph:${projectId}`, message: "Graph or its binding is missing or changed" }); return result;
    }
    result.guards.push(reference(graph), reference(binding));
    result.findings.push(...validateGraph(graph.value).findings);
    for (const proof of binding.value.layerProofs ?? []) if (this.#projectionHash(graph, proof.level) !== proof.hash)
      result.findings.push({ code: "graph_layer_unproven", target: `L${proof.level}`, message: "Layer semantics changed without an updated research result" });
    for (const obligation of binding.value.obligations) {
      if (this.#obligationFieldHash(reference(graph), graph.value.nodes, obligation.node, obligation.field) !== obligation.valueHash) result.findings.push({ code: "graph_field_unproven", target: `${obligation.node}/${obligation.field}`, message: "The field changed without a matching research result" });
    }
    const checked = this.#evidenceInputs(uniqueRefs(binding.value.inputs), "Evidence used to refine the graph has changed");
    result.findings.push(...checked.findings);
    result.guards.push(...checked.guards);
    return result;
  }
}

/** G1/G2: External check handler for graph L1/L2/L3 projection. */
export const graphProjectionHandler: ExternalCheckHandler<"graph-projection"> = (check, context) => {
  if (check.level !== 1 && check.level !== 2 && check.level !== 3) {
    return { code: "graph_layer_unproven", target: `L${check.level}`, message: "Invalid layer level" };
  }
  const graph = context.store.get<Graph>(`graph:${context.projectId}`);
  if (!graph || graph.kind !== "graph") {
    return { code: "graph_layer_unproven", target: `L${check.level}`, message: "Graph is missing or changed" };
  }
  if (hashJson(projectGraph(graph.value, check.level)) !== check.hash) {
    return { code: "graph_layer_unproven", target: `L${check.level}`, message: "Layer semantics changed without an updated research result" };
  }
  return null;
};

