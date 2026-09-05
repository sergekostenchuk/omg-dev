import { Store, type Revision } from "../storage/store.js";
import { requireCondition } from "../errors.js";
import { canonical, hashJson } from "../canonical.js";
import { Discovery, type DiscoveryDraft, type Question } from "../discovery/discovery.js";
import { reference, uniqueRefs, type Ref, type GateResult } from "../pipeline/contracts.js";
import { requireGraph, validateGraph } from "./validate.js";
import type { Graph } from "./model.js";
import { LEVEL } from "./model.js";
import { projectGraph } from "./project.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { continuityFindings } from "./semantics.js";
import { composeLayer, layerDesignSpec, LAYER_DESIGN_VERSION } from "./layer-design.js";

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
    requireCondition(draft.value.stage === "om-g2" && draft.value.level === `R${level - 1}`
      && draft.value.consumer === current.value.nodes.find(node => node.kind === "product")?.id
      && draft.value.contractVersion === LAYER_DESIGN_VERSION
      && canonical(questions.map(question => question.value.spec)) === canonical([layerDesignSpec(level)])
      && research && upper && [research, upper].every(record => draft.value.inputs.some(ref => canonical(ref) === canonical(reference(record)))),
    "layer_research_foreign", "Layer design must use its exact contract, accepted research and upper layer");
    requireCondition(questions.every(question => question.value.answer && this.store.get(question.value.answer.id)?.kind === "research-answer"),
      "research_assessment_required", "Layer construction requires assessed model research, not a manual graph declaration");
    const graph = composeLayer(current.value, level, draft.value.fields['layerDesign']);
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
  layerGate(projectId: string, level: 1 | 2 | 3, expected?: Ref): GateResult {
    const layer = this.store.get<Layer>(`graph-layer:${projectId}:${level}`);
    if (!layer || layer.kind !== "graph-layer" || (expected && (expected.id !== layer.id || expected.hash !== layer.hash || expected.revision !== layer.revision))) {
      return { findings: [{ code: "graph_layer_stale", target: `graph-layer:${projectId}:${level}`, message: "This graph layer is missing or changed" }], guards: [] };
    }
    const result: GateResult = { findings: [], guards: [reference(layer)] };
    const graph = this.store.get<Graph>(`graph:${projectId}`);
    for (const proof of layer.value.layerProofs ?? []) if (!graph || hashJson(projectGraph(graph.value, proof.level)) !== proof.hash)
      result.findings.push({ code: "graph_layer_unproven", target: `L${proof.level}`, message: "Layer semantics changed without an updated research result" });
    for (const obligation of layer.value.obligations) {
      const node = layer.value.projection.nodes.find(item => item.id === obligation.node);
      if (!node || hashJson((node as unknown as Record<string, unknown>)[obligation.field]) !== obligation.valueHash) result.findings.push({ code: "graph_field_unproven", target: `${obligation.node}/${obligation.field}`, message: "The field changed without a matching research result" });
    }
    for (const input of uniqueRefs(layer.value.inputs)) {
      const current = this.store.get(input.id);
      if (!current || current.hash !== input.hash || current.revision !== input.revision
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "graph_evidence_stale", target: input.id, message: "Research behind this layer has changed" });
      else result.guards.push(reference(current));
    }
    return result;
  }
  gate(projectId: string, expected?: Ref): GateResult {
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
    for (const proof of binding.value.layerProofs ?? []) if (hashJson(projectGraph(graph.value, proof.level)) !== proof.hash)
      result.findings.push({ code: "graph_layer_unproven", target: `L${proof.level}`, message: "Layer semantics changed without an updated research result" });
    for (const obligation of binding.value.obligations) {
      const node = graph.value.nodes.find(item => item.id === obligation.node);
      if (!node || hashJson((node as unknown as Record<string, unknown>)[obligation.field]) !== obligation.valueHash) result.findings.push({ code: "graph_field_unproven", target: `${obligation.node}/${obligation.field}`, message: "The field changed without a matching research result" });
    }
    for (const input of uniqueRefs(binding.value.inputs)) {
      const current = this.store.get(input.id);
      if (!current || current.hash !== input.hash || current.revision !== input.revision
        || (current.kind === "source" && !sourceIsCurrent(current.value as unknown as Source))) result.findings.push({ code: "graph_evidence_stale", target: input.id, message: "Evidence used to refine the graph has changed" });
      else result.guards.push(reference(current));
    }
    return result;
  }
}
