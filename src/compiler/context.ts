import { Ajv } from "ajv";
import { canonical, digest, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import type { Revision } from "../storage/store.js";
import { RefinementRelations } from "../graph/relations.js";
import type { Command, Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { controlPredecessors } from "../graph/dependencies.js";
import { sealed, type Sealed } from "../om/refusal.js";
import type { NeighborCollection, NeighborPacket } from "../om/neighbors.js";
import type { CompiledTask, MachinePlan } from "./model.js";

export interface ContextText { text: string; chars: number; utf8Bytes: number; hash: string }
export function boundedContext(value: unknown, maxChars: number): ContextText {
  requireCondition(Number.isSafeInteger(maxChars) && maxChars > 0, "context_budget_invalid", "Context needs a positive configured character allowance");
  const text = canonical(value);
  if (text.length > maxChars) throw new EngineError("context_budget_exceeded", "The essential context exceeds the allowance; increase it or refine the task instead of truncating its obligations",
    { requiredChars: text.length, maxChars });
  return { text, chars: text.length, utf8Bytes: Buffer.byteLength(text, "utf8"), hash: digest(text) };
}

export interface TaskContextSource { graph: Graph; task: CompiledTask; fullCheck: Command }
export interface PreplanContextSource extends TaskContextSource {
  project: string;
  basis: { candidate: Ref; environment: Ref };
  /** Already checked by F4's readNeighbors/prepareNeighbors; a DTO is not proof of acceptance. */
  neighbors: Revision<NeighborCollection>;
}

function requireFullCheck(fullCheck: Command): void {
  requireCondition(fullCheck && typeof fullCheck.executable === "string" && fullCheck.executable.trim()
    && Array.isArray(fullCheck.args) && fullCheck.args.every(arg => typeof arg === "string"),
  "context_check_missing", "The implementation context needs its configured full-run command");
}

// One selection formula for both eras. Legacy metadata and optional fields remain at their old boundary.
function content({ graph, task, fullCheck }: TaskContextSource) {
  const node = graph.nodes.find(item => item.id === task.node)!;
  const ancestry = new Set(new RefinementRelations(graph).ancestry(node.id).map(item => item.id));
  const testConnectors = new Set(task.tests.flatMap(test => test.covers));
  const connectors = graph.connectors.filter(connector => testConnectors.has(connector.id)
    || connector.bindings.some(binding => binding.level === 3 && [binding.producer, ...binding.consumers].some(endpoint => endpoint.node === node.id)))
    .map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 3) }));
  const artifactIds = new Set([...task.produces, ...task.inputs.map(input => input.artifact), ...connectors.map(connector => connector.artifact)]);
  const controls = (graph.edges ?? []).filter(edge => ancestry.has(edge.source));
  const anchors = graph.anchors.filter(anchor => connectors.some(connector => connector.bindings.some(binding => binding.anchor === anchor.id)));
  const wakeTests = new Set([...connectors.flatMap(connector => connector.wakeTest ? [connector.wakeTest] : []), ...anchors.map(anchor => anchor.test)]);
  const tests = [...task.tests, ...graph.tests.filter(test => wakeTests.has(test.id) && !node.tests.includes(test.id))];
  const joins = graph.joins.filter(join => join.consumer === node.id);
  const routes = new Set([...connectors.map(connector => connector.returnsTo), ...controls.map(edge => edge.target), ...joins.flatMap(join => join.failures ? [join.failures.returnsTo] : [])]);
  for (const route of graph.nodes.filter(node => routes.has(node.id))) artifactIds.add(route.outcome);
  const artifacts = graph.artifacts.filter(artifact => artifactIds.has(artifact.id));
  const contractIds = new Set([...artifacts.map(artifact => artifact.contract), ...node.ports.map(port => port.contract)]);
  return {
    action: { title: task.title, outcome: task.outcome, ...(task.purpose ? { purpose: task.purpose, benefit: task.benefit!, beneficiary: task.beneficiary! } : {}) },
    scope: { boundary: task.boundary, code: node.code, ports: node.ports, packets: task.packets ?? [], ownership: task.ownership ?? [] },
    requirements: task.requirements ?? [], actor: graph.actors?.find(actor => actor.id === task.beneficiary) ?? null,
    inputs: task.inputs, produces: task.produces, artifacts,
    contracts: graph.contracts.filter(contract => contractIds.has(contract.id)),
    criteria: { tests, fullCheck, obligations: task.obligations, joins,
      ...(task.researchObligations !== undefined ? { researchObligations: task.researchObligations } : {}) },
    connections: connectors, controls, anchors,
    transfers: (graph.transfers ?? []).filter(transfer => transfer.from === node.id || transfer.to === node.id),
    correction: graph.nodes.filter(node => routes.has(node.id)).map(node => ({ id: node.id, title: node.title, outcome: node.outcome, boundary: node.boundary })),
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
const graphShapes = [ajv.compile(sealed(graphSchema)), ajv.compile(sealed(graphV2Schema))];
const codeShape = ajv.compile(sealed(graphV2Schema.properties["nodes"].items.properties.code.items));
function invalid(field: string, target = "task-context"): never {
  throw new EngineError("context_source_invalid", "Task context needs explicit, consistent checked sources",
    { unit: "V2", target, field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === "unsealable_value") invalid("json"); throw error; }
}
function requireContentSource(source: TaskContextSource): void {
  if (!object(source)) invalid("source");
  requireFullCheck(source.fullCheck);
  const { graph, task } = source;
  if (!object(graph) || !graphShapes[graph.version === 2 ? 1 : 0]!(graph)) invalid("graph");
  if (!object(task) || ![task.id, task.node, task.title, task.outcome, task.signature].every(text)
    || !object(task.boundary) || ![task.readPaths, task.writePaths, task.dependencies, task.produces].every(texts)
    || !Array.isArray(task.tests) || !task.tests.every(t => object(t) && text(t.id) && texts(t.covers))
    || !Array.isArray(task.inputs) || !task.inputs.every(input => object(input) && text(input.connector) && text(input.artifact)
      && (input.producerTask === null || text(input.producerTask)) && (input.receipt === null || isRef(input.receipt))
      && (input.source === null || isRef(input.source)))
    || !Array.isArray(task.obligations) || !task.obligations.every(o => object(o)
      && ["outcome", "durable_cold_read", "restart_cold", "provider_safety"].includes(o.name)
      && ["required", "not_applicable"].includes(o.status) && text(o.reason))) invalid("task");
  const nodes = graph.nodes.filter(node => node.id === task.node);
  requireCondition(nodes.length === 1 && nodes[0]!.kind === "work" && graph.horizon.includes(task.node),
    "task_foreign", "Task does not belong to the supplied execution horizon");
  const node = nodes[0]!;
  if (!same(task.boundary, node.boundary) || task.outcome !== node.outcome
    || task.tests.some(test => !graph.tests.some(item => same(test, item)))
    || [...task.produces, ...task.inputs.map(input => input.artifact)].some(id => !graph.artifacts.some(a => a.id === id))) invalid("task.graph", task.id);
  for (const field of ["purpose", "benefit", "beneficiary"] as const)
    if (Object.hasOwn(task, field) && !text(task[field])) invalid(`task.${field}`, task.id);
  for (const field of ["packets", "requirements", "ownership", "researchObligations"] as const)
    if (Object.hasOwn(task, field) && (!Array.isArray(task[field]) || !task[field]!.every(object))) invalid(`task.${field}`, task.id);
  if (task.ownership?.some(grant => !text(grant.path) || ![grant.from, grant.transfer, grant.producerTask].every(value => value === null || text(value))
    || !(grant.receipt === null || isRef(grant.receipt)))) invalid("task.ownership", task.id);
  if (task.researchObligations?.some(bound => !text(bound.binding) || !texts(bound.tests)
    || !object(bound.requirement) || !isRef(bound.requirement.scope) || !text(bound.requirement.obligation)
    || !object(bound.requirement.original) || !isRef(bound.requirement.original.record) || !text(bound.requirement.original.pointer)
    || ![bound.requirement.kind, bound.requirement.moment, bound.requirement.responsibleNode,
      bound.requirement.responsibleConsumer, bound.requirement.reason].every(text)
    || typeof bound.requirement.neededForR2 !== "boolean"
    || !(bound.requirement.returnCondition === null || text(bound.requirement.returnCondition))
    || !(bound.requirement.wake === null || object(bound.requirement.wake)))) invalid("task.researchObligations", task.id);
  if (task.purpose && (!task.benefit || !task.beneficiary)) invalid("task.action", task.id);
}

/** Pure content, using a caller's derived task and checked graph. No reference is authenticated here. */
export function taskContextContent(source: TaskContextSource): Sealed<ReturnType<typeof content>> {
  source = copy(source); requireContentSource(source);
  return sealed(content(source));
}

function neighborShape(value: unknown): boolean {
  if (!object(value) || !text(value['direction']) || !object(value['neighbor'])
    || ![value['neighbor']['work'], value['neighbor']['operation'], value['neighbor']['block']].every(node => object(node)
      && text(node['id']) && text(node['title']) && text(node['outcome']))
    || !["in-plan", "available", "external", "sleeping", "undelivered"].includes(value['delivery'] as string)
    || (Object.hasOwn(value, "basis") && !isRef(value['basis']))
    || (value['delivery'] === "available" && !isRef(value['basis']))) return false;
  const contract = value['contract'];
  const dataContract = object(contract) && text(contract['id']) && typeof contract['hash'] === 'string'
    && /^[a-f0-9]{64}$/.test(contract['hash']) && typeof contract['external'] === 'boolean';
  const code = (ref: unknown) => ref === null || codeShape(ref);
  if (["reads", "writes"].includes(value['direction'])) return !Object.hasOwn(value, 'control')
    && text(value['connector']) && text(value['artifact']) && dataContract && text(value['port']) && code(value['codeRef'])
    && text(value['neighbor']['port']) && code(value['neighbor']['codeRef']) && text(value['returnsTo'])
    && (!Object.hasOwn(value, 'anchor') || text(value['anchor'])) && (!Object.hasOwn(value, 'wakeTest') || text(value['wakeTest']));
  if (!text(value['control']) || ['connector', 'port', 'codeRef', 'returnsTo', 'anchor', 'wakeTest'].some(key => Object.hasOwn(value, key))
    || ['port', 'codeRef'].some(key => Object.hasOwn(value['neighbor'] as object, key))) return false;
  if (value['direction'] === 'requires') return text(value['artifact']) && dataContract
    && !Object.hasOwn(value, 'path') && !Object.hasOwn(value, 'condition');
  return ['receives', 'sends'].includes(value['direction']) && text(value['path']) && value['condition'] === 'producer_committed'
    && !Object.hasOwn(value, 'artifact') && !Object.hasOwn(value, 'contract');
}

function requireNeighbors(source: PreplanContextSource): NeighborPacket {
  const { project, graph, task, basis, neighbors: row } = source;
  if (!text(project) || !object(basis) || !isRef(basis.candidate) || !isRef(basis.environment)
    || !basis.candidate.id.startsWith(`om-candidate:${project}:`) || basis.environment.id !== `environment:${project}`) invalid("basis");
  if (!object(row) || !isRef(row) || row.kind !== "om-neighbors" || row.revision !== 1 || !object(row.value)) invalid("neighbors");
  const value = row.value, origin = value.source;
  if (value.contract !== "neighbor-packets/v1" || value.project !== project || !object(origin)
    || origin.project !== project || !isRef(origin.candidate) || !same(origin.candidate, basis.candidate)
    || !object(origin.ownership) || origin.ownership.contract !== "delivery-ownership/v1"
    || !(origin.ownership.root === null || (isRef(origin.ownership.root) && origin.ownership.root.id === `execution-root:${project}`))
    || !object(origin.ownership.indexes) || !Object.values(origin.ownership.indexes).every(isRef)
    || !Array.isArray(value.packets)) invalid("neighbors.source");
  if (row.hash !== hashJson(value)
    || row.id !== `om-neighbors:${project}:${hashJson({ contract: value.contract, source: origin })}`) invalid("neighbors.reference");
  const works = new Set<string>();
  for (const packet of value.packets) {
    if (!object(packet) || !text(packet.work) || !Array.isArray(packet.neighbors) || packet.hash !== hashJson(packet.neighbors)
      || works.has(packet.work) || !graph.horizon.includes(packet.work)) invalid("neighbors.packets");
    works.add(packet.work);
    if (!packet.neighbors.every(neighborShape)) invalid("neighbors.entries", packet.work);
    // Completeness/provenance is established by F4, not by the hash above. Even at this pure boundary,
    // an explicit empty packet must not contradict the supplied graph's incident data/control edges.
    if (packet.neighbors.length === 0 && (graph.connectors.some(connector => connector.bindings.some(binding => binding.level === 3
      && binding.consumers.some(consumer => consumer.node !== binding.producer.node
        && (consumer.node === packet.work || binding.producer.node === packet.work))))
      || controlPredecessors(graph, packet.work).length > 0 || (graph.transfers ?? []).some(transfer => transfer.from === packet.work)))
      invalid("neighbors.empty", packet.work);
  }
  if (works.size !== graph.horizon.length || graph.horizon.some(work => !works.has(work))) invalid("neighbors.coverage");
  return value.packets.find(packet => packet.work === task.node)!;
}

/** Pre-plan era. The caller verifies candidate/environment, D7 and F4 with their common readers and
 * supplies the allowance from V1. This pure serialization neither admits work nor permits a model send. */
export function preplanTaskContext(source: PreplanContextSource, maxChars: number): ContextText {
  source = copy(source); requireContentSource(source);
  const packet = requireNeighbors(source), { task, project, basis, neighbors } = source;
  for (const field of ["ownership", "researchObligations", ...(source.graph.version === 2 ? ["requirements", "packets"] as const : [])] as const)
    if (!Object.hasOwn(task, field) || !Array.isArray(task[field])) invalid(`task.${field}`, task.id);
  const body = content(source);
  return boundedContext({ version: "omg-task-context/preplan-v1",
    binding: { candidate: basis.candidate, environment: basis.environment, neighbors: reference(neighbors), task: task.id },
    ...body, scope: { ...body.scope, readPaths: task.readPaths, writePaths: task.writePaths },
    neighbors: packet, deliveryOwnership: neighbors.value.source.ownership,
    details: { source: "works-candidate", project, candidate: basis.candidate, task: task.id,
      selectors: ["graph entity ID", "evidence-index", "bound evidence reference ID and JSON pointer or text range"] },
  }, maxChars);
}

/** This is an implementation brief, not the scheduler's complete machine plan. */
export function taskContext(plan: Revision<MachinePlan>, fullCheck: Command, taskId: string, maxChars: number): ContextText {
  requireFullCheck(fullCheck);
  const graph = plan.value.graphSnapshot;
  const task = plan.value.tasks.find(item => item.id === taskId);
  requireCondition(task, "task_foreign", "Task does not belong to the bound machine plan");
  return boundedContext({ version: "omg-task-context/v1", binding: { plan: reference(plan), graph: plan.value.graph, task: task.id,
    base: { commit: plan.value.base.head, tree: plan.value.base.tree } },
    ...content({ graph, task, fullCheck }),
    details: { command: "task-detail", project: plan.value.projectId, plan: reference(plan), task: task.id,
      selectors: ["graph entity ID", "evidence-index", "bound evidence reference ID and JSON pointer or text range"] },
  }, maxChars);
}

export interface DetailSelector { id: string; pointer: string; start: number | null; end: number | null }
export function selectDetail(value: unknown, selector: DetailSelector): unknown {
  requireCondition(typeof selector.pointer === "string" && (selector.pointer === "" || selector.pointer.startsWith("/")),
    "context_selector_invalid", "Use an empty pointer or an explicit JSON pointer");
  let selected: unknown = value;
  for (const segment of selector.pointer === "" ? [] : selector.pointer.slice(1).split("/")) {
    requireCondition(!/~(?:[^01]|$)/.test(segment), "context_selector_invalid", "Invalid JSON pointer escape");
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    requireCondition(selected !== null && typeof selected === "object" && Object.hasOwn(selected, key)
      && (!Array.isArray(selected) || /^(0|[1-9][0-9]*)$/.test(key)), "context_detail_missing", "The exact selected field is missing");
    selected = (selected as Record<string, unknown>)[key];
  }
  if (selector.start !== null || selector.end !== null) {
    requireCondition(typeof selected === "string" && Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)
      && selector.start! >= 0 && selector.end! > selector.start! && selector.end! <= selected.length,
    "context_selector_invalid", "A text range needs explicit valid offsets within a string");
    return selected.slice(selector.start!, selector.end!);
  }
  return selected;
}

export interface EvidenceDetail { ref: Ref; kind: string }
