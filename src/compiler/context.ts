import { Ajv } from "ajv";
import { canonical, digest, hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, uniqueRefs, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { RefinementRelations } from "../graph/relations.js";
import type { Command, Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { controlPredecessors } from "../graph/dependencies.js";
import { sealed, type Sealed } from "../om/refusal.js";
import { neighborsOf, readAcceptedFrame, readAtomicGate, readDeliveries, readFeasibility, readFrame, readNeighbors, readWorksFrame,
  type DeliveryOwnershipBasis, type FrameRequest, type NeighborCollection, type NeighborPacket, type NeighborSources,
  readTaskContextBasis, readTaskSpecification, type TaskSpecification, type TaskContextBasis, type OmReaderResult } from "./om-readers.js";
import { historicalTrace, withHistoricalReads } from "../history/proofs.js";
import { readRecord } from "../om/refs.js";
import { TASK_CONTEXT_CONTRACT, type CompiledTask, type MachinePlan } from "./model.js";

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
  taskContextContract?: typeof TASK_CONTEXT_CONTRACT;
  specification?: TaskSpecification;
  project: string;
  basis: { candidate: Ref; environment: Ref };
  /** Already checked by F4's readNeighbors/prepareNeighbors; a DTO is not proof of acceptance. */
  neighbors: Revision<NeighborCollection>;
}
export interface PlanTaskContextSources {
  specification?: { basis: Extract<TaskContextBasis, { contract: typeof TASK_CONTEXT_CONTRACT }>; tasks: Record<string, TaskSpecification> };
  plan: Ref; graph: Ref; candidate: Ref; references: Ref[];
  neighbors: NeighborSources; deliveryOwnership: DeliveryOwnershipBasis;
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
function take<T>(result: OmReaderResult<T>): T {
  if (!result.ok) throw new EngineError(result.refusal.code, result.refusal.message, result.refusal.at);
  return result.value;
}
function requirePlan(plan: Revision<MachinePlan>): void {
  if (!object(plan) || !isRef(plan) || plan.kind !== "plan" || !object(plan.value)) invalid("plan");
  const value = plan.value;
  if (Object.hasOwn(value, 'taskContextContract') && value.taskContextContract !== TASK_CONTEXT_CONTRACT) invalid('plan.taskContextContract', plan.id);
  if (value.taskContextContract && !value.feasibility?.id.startsWith('om-feasibility:')) invalid('plan.feasibility', plan.id);
  if (!text(value.projectId) || ![value.graph, value.environment, value.feasibility].every(isRef)
    || !Array.isArray(value.guards) || !value.guards.every(isRef)
    || !Array.isArray(value.tasks) || !value.tasks.every(object)
    || !object(value.base) || !text(value.base.head) || !text(value.base.tree)
    || !object(value.graphSnapshot) || !graphShapes[value.graphSnapshot.version === 2 ? 1 : 0]!(value.graphSnapshot)) invalid("plan.value");
}
function needsOmSources(plan: MachinePlan): boolean {
  return plan.feasibility.id.startsWith("om-feasibility:")
    || plan.guards.some(ref => ["om-frame:", "om-neighbors:", "om-candidate:"].some(prefix => ref.id.startsWith(prefix)));
}

/** Resolve exact historical sources once; the returned DTO can be used without reading any current heads. */
export function loadTaskContextSources(store: Store, plan: Revision<MachinePlan>): Sealed<PlanTaskContextSources> | null {
  if (!(store instanceof Store)) invalid("store");
  plan = copy(plan); requirePlan(plan);
  if (!needsOmSources(plan.value)) return null;
  return withHistoricalReads(() => {
    const project = plan.value.projectId, references: Ref[] = [];
    const source = historicalTrace(store, ref => { references.push(ref); }, "distinct");
    const saved = take(readRecord<MachinePlan>(source, reference(plan),
      { unit: "G3", target: plan.id, idPrefix: `plan:${project}:`, kind: "plan" }));
    if (!same(saved.value, plan.value)) invalid("plan.record", plan.id);
    const graph = take(readRecord<Graph>(source, plan.value.graph,
      { unit: "G3", target: plan.id, id: `graph:${project}`, kind: "graph" }));
    if (!same(graph.value, plan.value.graphSnapshot)) invalid("plan.graphSnapshot", plan.id);
    let candidateRef: Ref, layer: Ref, frame: Ref, ownership: DeliveryOwnershipBasis;
    if (plan.value.feasibility.id.startsWith("om-feasibility:")) {
      const checked = take(readFeasibility(source, { project, record: plan.value.feasibility })), value = checked.value;
      if (!value.ready || !same(value.graph, plan.value.graph) || !same(value.environment, plan.value.environment)
        || !value.producer.deliveries.ownership) invalid("feasibility", checked.id);
      references.push(...value.inputs);
      candidateRef = value.producer.candidate; layer = value.producer.layer; frame = value.producer.frame;
      ownership = { contract: "delivery-ownership/v1", ...value.producer.deliveries.ownership };
    } else {
      // In the earlier plan era these records were direct guards. Never select a head or the first of several revisions.
      const exact = (id: string): Ref => {
        const matches = uniqueRefs(plan.value.guards.filter(ref => ref.id === id));
        if (matches.length !== 1) invalid("plan.guards", id);
        return matches[0]!;
      };
      layer = exact(`graph-layer:${project}:3`); frame = exact(`om-frame:${project}:3`);
      const accepted = take(readAcceptedFrame(source, { project, level: 3, graph: plan.value.graph, layer, frame }));
      if (!accepted.frame) invalid("frame", frame.id);
      candidateRef = accepted.frame.value.acceptance.candidate;
      const gate = accepted.frame.value.acceptance.gate;
      if (gate.name !== "G5" || !("basis" in gate) || !isRef(gate.basis)) invalid("frame.acceptance.gate", frame.id);
      const atomic = take(readAtomicGate(source, { project, record: gate.basis }));
      if (!same(atomic.value.request.candidate, candidateRef)) invalid("frame.acceptance.candidate", frame.id);
      const neighbors = take(readNeighbors(source, { project, neighbors: atomic.value.request.neighbors }));
      if (!same(neighbors.value.source.candidate, candidateRef)) invalid("neighbors.candidate", neighbors.id);
      ownership = neighbors.value.source.ownership;
      const roots = uniqueRefs(plan.value.guards.filter(ref => ref.id === `execution-root:${project}`));
      if (roots.length > 1 || !same(ownership.root, roots[0] ?? null)) invalid("plan.guards.execution-root", plan.id);
    }
    const candidate = take(readWorksFrame(source, { project, candidate: candidateRef }));
    if (!same(candidate.value.graph, plan.value.graphSnapshot)) invalid("candidate.graph", candidate.id);
    const request: FrameRequest = { ...candidate.value.request.frame, graph: plan.value.graph, layer, frame };
    const works = take(readFrame(source, request));
    if (!request.upper) invalid("frame.upper", frame.id);
    const operations = take(readFrame(source, { project, level: 2, graph: request.graph, horizon: request.horizon,
      layer: works.upperRef, frame: request.upper.frame, upper: null }));
    const delivery = take(readDeliveries(source, { project, candidate: candidateRef, ownership }));
    const finding = delivery.findings[0];
    if (finding) throw new EngineError(finding.code, finding.message, { unit: "G3", target: finding.target, field: "delivery" });
    const fills = operations.accepted?.frame?.value.fills ?? null;
    references.push(plan.value.graph, plan.value.environment, plan.value.feasibility, candidateRef, layer, frame,
      ...works.references, ...operations.references, ...delivery.references);
    const specification = plan.value.taskContextContract ? (() => {
      const basis = take(readTaskContextBasis(source, { project, record: plan.value.feasibility }));
      if (basis.contract !== plan.value.taskContextContract) invalid('plan.taskContextContract', plan.id);
      return { basis, tasks: Object.fromEntries(plan.value.tasks.map(task => [task.id,
        loadTaskSpecification(source, project, basis.input, plan.value.graphSnapshot, task)])) };
    })() : undefined;
    return sealed({ ...(specification ? { specification } : {}), plan: reference(plan), graph: plan.value.graph, candidate: candidateRef, references: uniqueRefs(references),
      neighbors: { identity: [...new Set([...candidate.value.fills, ...(fills ?? [])]
        .filter(fill => fill.source === "identity").map(fill => fill.node))].sort(), receipts: delivery.receipts,
      frames: { operations: { obligations: operations.result.obligations, fills },
        works: { obligations: works.result.obligations, fills: candidate.value.fills } } },
      deliveryOwnership: ownership,
    });
  });
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

function omContent(source: TaskContextSource, neighbors: Sealed<NeighborPacket>, deliveryOwnership: Sealed<DeliveryOwnershipBasis>) {
  const { task, graph } = source;
  for (const field of ["ownership", "researchObligations", ...(graph.version === 2 ? ["requirements", "packets"] as const : [])] as const)
    if (!Object.hasOwn(task, field) || !Array.isArray(task[field])) invalid(`task.${field}`, task.id);
  const body = content(source);
  return { ...body, scope: { ...body.scope, readPaths: task.readPaths, writePaths: task.writePaths }, neighbors, deliveryOwnership };
}

function planNeighbors(plan: Revision<MachinePlan>, task: CompiledTask, sources: Sealed<PlanTaskContextSources>): Sealed<NeighborPacket> {
  if (!object(sources) || !isRef(sources.plan) || !same(sources.plan, reference(plan)) || !isRef(sources.graph)
    || !same(sources.graph, plan.value.graph) || !isRef(sources.candidate)
    || !sources.candidate.id.startsWith(`om-candidate:${plan.value.projectId}:`)
    || !Array.isArray(sources.references) || !sources.references.every(isRef)
    || ![sources.graph, sources.candidate, plan.value.environment, plan.value.feasibility]
      .every(ref => sources.references.some(item => same(item, ref)))) invalid("sources", plan.id);
  const ownership = sources.deliveryOwnership;
  const paths = [...new Set(plan.value.graphSnapshot.nodes.filter(node => plan.value.graphSnapshot.horizon.includes(node.id))
    .flatMap(node => node.code.filter(code => code.access === "write").map(code => code.path)))].sort();
  if (!object(ownership) || ownership.contract !== "delivery-ownership/v1"
    || !(ownership.root === null || isRef(ownership.root) && ownership.root.id === `execution-root:${plan.value.projectId}`)
    || !object(ownership.indexes) || !Object.values(ownership.indexes).every(isRef)
    || !same(Object.keys(ownership.indexes).sort(), paths)) invalid("sources.deliveryOwnership", task.id);
  return take(neighborsOf(plan.value.graphSnapshot, task.node, sources.neighbors as unknown as NeighborSources));
}

// The compiler uses its installed slot; direct G5 supplies the same OM reader without requiring product assembly.
export function loadTaskSpecification(store: Store, project: string, input: Ref, graph: Graph, task: CompiledTask,
  reader: typeof readTaskSpecification = readTaskSpecification): TaskSpecification {
  return copy(take(reader(store, { project, input, requirements: (task.requirements ?? []).map(row => row.id),
    nodes: new RefinementRelations(graph).ancestry(task.node).map(node => node.id) }))) as TaskSpecification;
}

function requireSpecification(value: unknown, target: string): asserts value is TaskSpecification {
  if (!object(value) || value['contract'] !== 'selected-specification/v1' || !Array.isArray(value['contracts'])
    || !Array.isArray(value['preparations']) || !object(value['constraints']) || !isRef(value['constraints']['source'])
    || value['constraints']['pointer'] !== '/content/fields/constraints' || !Array.isArray(value['constraints']['value'])) invalid('selectedSpecification', target);
  const row = (value: unknown): value is Record<string, unknown> => object(value) && isRef(value['source'])
    && Number.isSafeInteger(value['index']) && (value['index'] as number) >= 0 && Object.hasOwn(value, 'value');
  for (const entry of value['contracts']) if (!row(entry) || entry['pointer'] !== `/content/fields/behaviorContracts/${entry['index']}`
    || !object(entry['effective']) || !isRef(entry['effective']['source']) || !/^\/contracts\/(0|[1-9][0-9]*)$/.test(String(entry['effective']['pointer']))
    || !Object.hasOwn(entry['effective'], 'value')) invalid('selectedSpecification.contracts', target);
  for (const entry of value['preparations']) if (!row(entry) || entry['pointer'] !== `/content/fields/featurePreparation/${entry['index']}`
    || !Number.isSafeInteger(entry['featureIndex']) || (entry['featureIndex'] as number) < 0) invalid('selectedSpecification.preparations', target);
}
function contextWithSpecification(value: unknown, maxChars: number, specification: Sealed<TaskSpecification> | undefined, target: string): ContextText {
  try { return boundedContext(value, maxChars); }
  catch (error) {
    if (specification && error instanceof EngineError && error.code === 'context_budget_exceeded')
      throw new EngineError(error.code, error.message, { ...(error.details as object), unit: 'V2', target, field: 'selectedSpecification',
        sources: uniqueRefs([specification.constraints.source, ...specification.contracts.flatMap(row => [row.source, row.effective.source]),
          ...specification.preparations.map(row => row.source)]) });
    throw error;
  }
}

/** Pre-plan era. The caller verifies candidate/environment, D7 and F4 with their common readers and
 * supplies the allowance from V1. This pure serialization neither admits work nor permits a model send. */
export function preplanTaskContext(source: PreplanContextSource, maxChars: number): ContextText {
  source = copy(source); requireContentSource(source);
  const packet = requireNeighbors(source), { task, project, basis, neighbors } = source;
  if (Object.hasOwn(source, 'taskContextContract') && source.taskContextContract !== TASK_CONTEXT_CONTRACT) invalid('taskContextContract', task.id);
  const specification = source.taskContextContract ? source.specification : undefined;
  if (source.taskContextContract) requireSpecification(specification, task.id);
  else if (Object.hasOwn(source, 'specification')) invalid('taskContextContract', task.id);
  return contextWithSpecification({ version: source.taskContextContract ? 'omg-task-context/preplan-v2' : "omg-task-context/preplan-v1",
    binding: { candidate: basis.candidate, environment: basis.environment, neighbors: reference(neighbors), task: task.id },
    ...omContent(source, packet, neighbors.value.source.ownership), ...(specification ? { selectedSpecification: specification } : {}),
    details: { source: "works-candidate", project, candidate: basis.candidate, task: task.id,
      selectors: ["graph entity ID", "evidence-index", "bound evidence reference ID and JSON pointer or text range"] },
  }, maxChars, specification, task.id);
}

/** This is an implementation brief, not the scheduler's complete machine plan. */
export function taskContext(plan: Revision<MachinePlan>, fullCheck: Command, taskId: string, maxChars: number,
  sources?: Sealed<PlanTaskContextSources> | null): ContextText {
  requireFullCheck(fullCheck);
  plan = copy(plan); requirePlan(plan);
  if (!text(taskId)) invalid("taskId", plan.id);
  const graph = plan.value.graphSnapshot;
  const task = plan.value.tasks.find(item => item.id === taskId);
  requireCondition(task, "task_foreign", "Task does not belong to the bound machine plan");
  const source = { graph, task, fullCheck }; requireContentSource(source);
  const om = needsOmSources(plan.value);
  if ((om && !sources) || (!om && sources !== undefined && sources !== null)) invalid("sources", plan.id);
  const checked = sources ? copy(sources) : null;
  const body = checked ? omContent(source, planNeighbors(plan, task, checked), checked.deliveryOwnership) : content(source);
  const specification = plan.value.taskContextContract ? checked?.specification?.tasks[task.id] : undefined;
  if (plan.value.taskContextContract) {
    if (checked?.specification?.basis.contract !== plan.value.taskContextContract) invalid('sources.taskContextContract', plan.id);
    requireSpecification(specification, task.id);
  } else if (checked?.specification) invalid('sources.taskContextContract', plan.id);
  return contextWithSpecification({ version: plan.value.taskContextContract ?? "omg-task-context/v1", binding: { plan: reference(plan), graph: plan.value.graph, task: task.id,
    base: { commit: plan.value.base.head, tree: plan.value.base.tree } },
    ...body, ...(specification ? { selectedSpecification: specification } : {}),
    details: { command: "task-detail", project: plan.value.projectId, plan: reference(plan), task: task.id,
      selectors: ["graph entity ID", "evidence-index", "bound evidence reference ID and JSON pointer or text range"] },
  }, maxChars, specification, task.id);
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
