import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Graph } from '../graph/model.js';
import { ProductEngine } from '../product/engine.js';
import { isRef, reference, type Ref, type StageArtifact } from '../pipeline/contracts.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { readHorizon, type HorizonRecords } from './horizon.js';
import { prepareHorizonBasis } from './frame-obligations.js';
import { historicalTrace, readOmAdmissionGuards, readOmInput, withHistoricalReads } from './input.js';
import { readLayerAcceptance, readLayerEnvelope } from './layer-basis.js';
import { readRecord, writeGuarded } from './refs.js';
import { readRoutes, prepareRoutes, type RoutesRecord } from './routes.js';
import { delivered, isPlainObject, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';

export const QUEUE_POLICY_VERSION = 'structural-weight/v1';
export const BLOCK_QUEUE_CONTRACT = 'block-weight/v1';
export const QUEUE_REFUSAL_CODES = Object.freeze([
  'queue_request_invalid', 'queue_policy_invalid', 'queue_source_invalid', 'queue_override_invalid', 'queue_record_invalid',
] as const);
/** The successful L1 journey the machine policy selects (H1.1, №1844 п.7): its exact layer, journey, actor and outcome. */
export interface MachinePath { layer: Ref; journeyId: string; actorId: string; outcomeId: string }
export interface QueuePolicy { version: typeof QUEUE_POLICY_VERSION; machinePath: MachinePath }
export interface QueueRequest {
  project: string; horizon: Ref; policy: QueuePolicy; override: { order: string[]; reason: string } | null;
}
export interface BlockWeight { block: string; D: number; P: 0 | 1; S: 0 | 1; weight: number; position: number }
export interface BlockQueueRecord {
  contract: typeof BLOCK_QUEUE_CONTRACT; request: QueueRequest; order: BlockWeight[]; maxD: number;
  horizonHash: string; policyVersion: typeof QUEUE_POLICY_VERSION;
}
export interface PreparedBlockQueue { record: Revision<BlockQueueRecord>; writes: Write[]; guards: TransactionGuard[] }
export interface QuestionQueueRequest { project: string; queue: Ref; routes: Ref }
export interface QuestionQueue { queue: Ref; routes: Ref; order: BlockWeight[]; references: Ref[] }

const DURABILITY = Object.freeze({ durable_source: true, immutable: true, durable_draft: true,
  versioned: false, reconstructible: false, evidence: false, recoverable: false, capability: false });
const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const exactRef = (value: unknown): value is Ref => object(value) && isRef(value)
  && canonical(Object.keys(value).sort()) === canonical(['hash', 'id', 'revision']);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const uniqueRefs = (refs: Ref[]): Ref[] => [...new Map(refs.map(ref => [canonical(ref), ref])).values()]
  .sort((a, b) => order(canonical(a), canonical(b)));
class QueueFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new QueueFailure(result.refusal); return result.value; }
function fail(code: string, target: string, field: string, message: string): never {
  // The path is chosen by the machine policy (№1860-9): only an explicit owner permutation is the owner's.
  return take(refused(code, message, { unit: 'M3', target, field }, code === 'queue_override_invalid' ? 'owner' : 'producer'));
}
function run<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(withHistoricalReads(action)); }
  catch (error) { if (error instanceof QueueFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function invalid(field: string): never {
  throw new EngineError('queue_request_invalid', 'A block queue needs explicit sources and its declared machine policy',
    { unit: 'M3', target: 'block-weight', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function policyShape(value: unknown): asserts value is QueuePolicy {
  if (!object(value) || !text(value.version) || !object(value.machinePath)) invalid('policy');
  const choice = value.machinePath;
  if (!exactRef(choice.layer) || !['journeyId', 'actorId', 'outcomeId'].every(key => text(choice[key]))) invalid('policy');
}
function checkPolicy(policy: QueuePolicy): void {
  if (policy.version !== QUEUE_POLICY_VERSION || !same(Object.keys(policy).sort(), ['machinePath', 'version'])
    || !same(Object.keys(policy.machinePath).sort(), ['actorId', 'journeyId', 'layer', 'outcomeId']))
    fail('queue_policy_invalid', policy.machinePath.layer.id, 'policy', 'The immutable algorithm accepts only its declared machine path');
}
function projectName(value: unknown): asserts value is string {
  if (!text(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) invalid('project');
}
function requireRequest(store: Store, value: unknown): asserts value is QueueRequest {
  if (!(store instanceof Store) || !object(value)) invalid('request');
  projectName(value.project);
  if (!exactRef(value.horizon)) invalid('horizon');
  policyShape(value.policy);
  if (!(value.override === null || object(value.override) && Array.isArray(value.override.order)
    && value.override.order.every(text) && typeof value.override.reason === 'string')) invalid('override');
  if (!same(Object.keys(value).sort(), ['horizon', 'override', 'policy', 'project'])) invalid('request.fields');
}
function requireRead(store: Store, value: unknown): asserts value is { project: string; record: Ref } {
  if (!(store instanceof Store) || !object(value)) invalid('read');
  projectName(value.project); if (!exactRef(value.record)) invalid('record');
}
function current(store: Store, ref: Ref): void {
  const head = store.get(ref.id);
  if (!head || !same(reference(head), ref)) fail('input_stale', ref.id, 'head', 'A queue source is no longer current');
}

/** Pure arithmetic over an explicitly supplied L1 snapshot; persisted entry points also prove its acceptance. */
export function computeBlockWeights(upper: Graph, blocks: string[], policy: QueuePolicy): OmResult<Sealed<{ order: BlockWeight[]; maxD: number }>> {
  if (!object(upper) || !Array.isArray(upper.nodes) || !Array.isArray(upper.artifacts) || !Array.isArray(upper.connectors)
    || !Array.isArray(blocks) || !blocks.every(text)) invalid('upper');
  policyShape(policy); upper = copy(upper); blocks = copy(blocks); policy = copy(policy);
  return run(() => {
    checkPolicy(policy);
    const source = (target: string, field: string, message: string): never => fail('queue_source_invalid', target, field, message);
    if (upper.version !== 1 && upper.version !== 2) source('upper', 'version', 'The upper graph version must be known');
    if (!upper.nodes.every(node => object(node) && text(node.id) && ['product', 'block', 'operation', 'work'].includes(node.kind) && text(node.outcome)
      && object(node.boundary) && text(node.boundary.writer) && text(node.boundary.rollback))) source('upper', 'nodes', 'Every node needs its structural identity');
    const nodes = new Map(upper.nodes.map(node => [node.id, node]));
    if (nodes.size !== upper.nodes.length) source('upper', 'nodes', 'Node identities must be unambiguous');
    const allBlocks = upper.nodes.filter(node => node.kind === 'block');
    if (!blocks.length || new Set(blocks).size !== blocks.length || blocks.some(id => nodes.get(id)?.kind !== 'block'))
      source('horizon', 'nodes', 'The horizon names a nonempty distinct set of upper-layer blocks');
    if (!upper.artifacts.every(artifact => object(artifact) && text(artifact.id))) source('upper', 'artifacts', 'Artifact identities are explicit');
    const artifacts = new Map(upper.artifacts.map(artifact => [artifact.id, artifact]));
    if (artifacts.size !== upper.artifacts.length) source('upper', 'artifacts', 'Artifact identities must be unambiguous');
    // Both OR branches have the same mandatory outcome basis, even when another block delegates writing to b.
    for (const id of blocks) {
      const b = nodes.get(id)!, artifact = artifacts.get(b.outcome);
      if (!artifact || !text(artifact.durability) || !Object.hasOwn(DURABILITY, artifact.durability))
        source(b.outcome, 'durability', 'Every block outcome needs an artifact and a known durability');
    }
    const choice = policy.machinePath;
    if (!Array.isArray(upper.journeys) || !Array.isArray(upper.actors))
      fail('queue_policy_invalid', choice.layer.id, 'machinePath', 'The accepted L1 must define the selected journey and actor');
    if (!upper.journeys.every(journey => object(journey) && text(journey.id) && text(journey.actor) && text(journey.outcome)
      && text(journey.terminal) && Array.isArray(journey.path) && journey.path.every(text))
      || !upper.actors.every(actor => object(actor) && text(actor.id))) source(choice.layer.id, 'journeys', 'Journeys and actors must have explicit identities');
    const selected = upper.journeys.filter(journey => journey.id === choice.journeyId);
    if (selected.length !== 1 || selected[0]!.actor !== choice.actorId || selected[0]!.outcome !== choice.outcomeId
      || selected[0]!.terminal !== 'success' || upper.actors.filter(actor => actor.id === choice.actorId).length !== 1
      || !artifacts.has(choice.outcomeId) || !selected[0]!.path.length
      || selected[0]!.path.some(id => !nodes.has(id) || !['product', 'block'].includes(nodes.get(id)!.kind)))
      fail('queue_policy_invalid', choice.journeyId, 'machinePath', 'Exactly one named successful journey must match the selected actor and outcome');
    if (!Array.isArray(upper.edges) || !upper.edges.every(edge => object(edge) && text(edge.id) && text(edge.relation)
      && ['on_success', 'on_failure', 'returns_to', 'requires', 'realizes'].includes(edge.relation)
      && text(edge.source) && text(edge.target) && nodes.has(edge.source) && nodes.has(edge.target)))
      source('upper', 'edges', 'Control transitions require known endpoints and relation kinds');
    for (const connector of upper.connectors) {
      if (!object(connector) || !text(connector.id) || !text(connector.artifact) || !artifacts.has(connector.artifact)
        || !Array.isArray(connector.bindings)) source('upper', 'connectors', 'A connector must name its artifact and explicit bindings');
      for (const binding of connector.bindings) if (!object(binding) || ![1, 2, 3].includes(binding.level)
        || !object(binding.producer) || !text(binding.producer.node) || !Array.isArray(binding.consumers)
        || !binding.consumers.every(consumer => object(consumer) && text(consumer.node))
        || binding.level === 1 && (!nodes.has(binding.producer.node) || binding.consumers.some(consumer => !nodes.has(consumer.node))))
        source(connector.id, 'bindings', 'Every structural flow needs its exact endpoints');
    }
    const rows = blocks.map(block => {
      const b = nodes.get(block)!, artifact = artifacts.get(b.outcome);
      const dependents = new Set<string>();
      for (const connector of upper.connectors)
        for (const binding of connector.bindings) if (binding.level === 1 && binding.producer.node === b.id)
          for (const consumer of binding.consumers) if (consumer.node !== b.id && nodes.get(consumer.node)?.kind === 'block') dependents.add(consumer.node);
      for (const edge of upper.edges!) if (edge.target === b.id && edge.source !== b.id && nodes.get(edge.source)?.kind === 'block'
        && ['on_success', 'on_failure', 'returns_to'].includes(edge.relation)) dependents.add(edge.source);
      const P = selected[0]!.path.includes(b.id) ? 1 as const : 0 as const;
      const S = allBlocks.some(q => q.id !== b.id && (q.boundary.writer === b.id || q.boundary.rollback === b.id))
        || b.boundary.writer === b.id && DURABILITY[artifact!.durability! as keyof typeof DURABILITY] ? 1 as const : 0 as const;
      return { block, D: dependents.size, P, S };
    });
    const maxD = Math.max(...rows.map(row => row.D));
    const ranked = rows.map(row => ({ ...row, weight: 2 * (maxD === 0 ? 0 : row.D / maxD) + 2 * row.P + 3 * row.S }))
      .sort((a, b) => b.weight - a.weight || order(a.block, b.block));
    return { order: ranked.map((row, i) => ({ ...row, position: i + 1 })), maxD };
  });
}

/** The accepted horizon and the exact L1 its B1 accepted: the layer the operation-map stage names and its projection. */
function horizonUpper(store: Store, project: string, ref: Ref, selected: Ref | null): { horizon: HorizonRecords; layer: Ref; upper: Graph } {
  const horizon = take(readHorizon(store, project, ref)) as HorizonRecords;
  if (horizon.gate.value.state !== 'accepted') fail('queue_source_invalid', ref.id, 'state', 'A queue needs the accepted horizon');
  const input = take(readOmInput(store, project, horizon.horizon.value.request.input));
  const maps = input.value.input.sources.filter(source => source.stage === 'operation-map');
  if (maps.length !== 1) fail('queue_source_invalid', ref.id, 'operation-map', 'The input must name its accepted upper stage');
  const stage = take(readRecord<StageArtifact>(store, maps[0], { unit: 'M3', target: project,
    id: `stage:${project}:operation-map`, kind: 'stage' }));
  const layerRef = object(stage.value.content) && exactRef(stage.value.content.graph) ? stage.value.content.graph : null;
  if (!layerRef && !selected) fail('queue_source_invalid', maps[0]!.id, 'content.graph', 'The accepted upper stage must name its exact L1');
  if (selected && (!layerRef || !same(layerRef, selected)))
    fail('queue_policy_invalid', selected.id, 'layer', 'The selected L1 must be exactly the one accepted by this horizon input');
  const layer = take(readLayerEnvelope(store, { project, level: 1, graph: horizon.horizon.value.request.graph, layer: layerRef! }));
  const { level: _level, ...projection } = layer.layer.value.projection;
  return { horizon, layer: layerRef!, upper: { ...projection, version: layer.graph.value.version } as Graph };
}
function sources(store: Store, request: QueueRequest): { horizon: HorizonRecords; upper: Graph } {
  const { horizon, upper } = horizonUpper(store, request.project, request.horizon, request.policy.machinePath.layer);
  return { horizon, upper };
}
export interface MachinePathRequest { project: string; horizon: Ref }
/**
 * The machine queue path (H1.1, №1844 п.7, №1852 п.4): among the successful journeys of the exact accepted L1 whose
 * outcome is an outcome of this horizon, each candidate is admitted by the common C1 arithmetic and the minimum
 * canonical([outcomeId, actorId, journeyId]) is chosen. A refused common source is returned, never skipped for the
 * next convenient path; a path of another outcome is never taken.
 */
export function prepareMachinePath(store: Store, request: MachinePathRequest): OmResult<Sealed<MachinePath>> {
  if (!(store instanceof Store) || !object(request)) invalid('machinePath');
  projectName(request.project);
  if (!exactRef(request.horizon) || !same(Object.keys(request).sort(), ['horizon', 'project'])) invalid('machinePath');
  request = copy(request);
  return run(() => {
    const { horizon, layer, upper } = horizonUpper(store, request.project, request.horizon, null);
    return take(selectMachinePath(upper, horizon.horizon.value.result.horizon.nodes, horizon.horizon.value.result.horizon.features, layer));
  });
}
/** The machine choice over an explicit L1 snapshot, its horizon blocks and outcomes (the pure part of prepareMachinePath). */
export function selectMachinePath(upper: Graph, blocks: string[], outcomes: readonly string[], layer: Ref): OmResult<Sealed<MachinePath>> {
  if (!object(upper) || !Array.isArray(blocks) || !blocks.every(text) || !Array.isArray(outcomes) || !outcomes.every(text) || !exactRef(layer))
    invalid('machinePath');
  upper = copy(upper); blocks = copy(blocks); layer = copy(layer);
  const wanted = new Set(outcomes);
  return run(() => {
    if (!Array.isArray(upper.journeys))
      fail('queue_policy_invalid', layer.id, 'machinePath', 'The accepted L1 must define the successful journeys of this horizon');
    const key = (path: MachinePath) => canonical([path.outcomeId, path.actorId, path.journeyId]);
    const candidates = upper.journeys.filter(journey => object(journey) && journey.terminal === 'success' && text(journey.outcome)
      && wanted.has(journey.outcome) && text(journey.id) && text(journey.actor))
      .map(journey => ({ layer, journeyId: journey.id, actorId: journey.actor, outcomeId: journey.outcome }))
      .sort((a, b) => order(key(a), key(b)));
    for (const path of candidates) {
      const weights = computeBlockWeights(upper, blocks, { version: QUEUE_POLICY_VERSION, machinePath: path });
      if (weights.ok) return path;
      if (weights.refusal.code !== 'queue_policy_invalid') throw new QueueFailure(weights.refusal);
    }
    return fail('queue_policy_invalid', layer.id, 'machinePath', 'No successful journey of this horizon\'s outcomes is admitted by the common queue policy');
  });
}
function derive(store: Store, request: QueueRequest): BlockQueueRecord {
  checkPolicy(request.policy);
  const { horizon, upper } = sources(store, request);
  // The machine path belongs to an outcome of this very horizon (№1852 п.4): it never orders a horizon by another result.
  if (!horizon.horizon.value.result.horizon.features.includes(request.policy.machinePath.outcomeId))
    fail('queue_policy_invalid', request.policy.machinePath.outcomeId, 'machinePath', 'The machine path must reach an outcome of this horizon');
  const weights = take(computeBlockWeights(upper, horizon.horizon.value.result.horizon.nodes, request.policy));
  let ranked = weights.order as BlockWeight[];
  if (request.override !== null) {
    const override = request.override;
    if (!text(override.reason) || !same(Object.keys(override).sort(), ['order', 'reason'])
      || !same([...override.order].sort(order), ranked.map(row => row.block).sort(order)))
      fail('queue_override_invalid', request.project, 'override', 'An owner permutation needs a reason and every horizon block exactly once');
    ranked = override.order.map((id, i) => ({ ...ranked.find(row => row.block === id)!, position: i + 1 }));
  }
  return { contract: BLOCK_QUEUE_CONTRACT, request, ...weights, order: ranked,
    horizonHash: horizon.horizon.value.result.horizon.hash, policyVersion: QUEUE_POLICY_VERSION };
}
function idOf(request: QueueRequest): string { return `block-weight:${request.project}:${hashJson(request)}`; }
function checked(store: Store, project: string, ref: Ref): Revision<BlockQueueRecord> {
  const record = take(readRecord<BlockQueueRecord>(store, ref, { unit: 'M3', target: ref.id, kind: 'block-weight', idPrefix: `block-weight:${project}:` }));
  if (!object(record.value) || record.value.contract !== BLOCK_QUEUE_CONTRACT || !object(record.value.request))
    fail('queue_record_invalid', ref.id, 'contract', 'A queue retains its complete versioned producer and request');
  const request = record.value.request;
  try { requireRequest(store, request); }
  catch (error) { if (error instanceof EngineError && error.code === 'queue_request_invalid')
    fail('queue_record_invalid', ref.id, 'request', 'The stored queue request is incomplete'); throw error; }
  if (request.project !== project || record.id !== idOf(request) || record.revision !== 1 || !same(record.value, derive(store, request)))
    fail('queue_record_invalid', ref.id, 'content', 'Queue content must be rederived from the exact accepted sources and declared policy');
  return record as Revision<BlockQueueRecord>;
}
export function readBlockQueue(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<Revision<BlockQueueRecord>>> {
  requireRead(store, request); request = copy(request);
  return run(() => checked(store, request.project, request.record));
}
/** M3 retains the current refinement admission that is intentionally not part of the common H/B1/L1 check. */
function refinementGuards(store: Store, horizon: HorizonRecords, graph: Ref): Ref[] {
  const request = horizon.horizon.value.request, refinement = request.refinement;
  if (!refinement) return [];
  const guards = new Map<string, Ref>();
  const remember = (ref: Ref) => {
    const previous = guards.get(ref.id);
    if (previous && !same(previous, ref)) fail('input_stale', ref.id, 'head', 'A refinement source changed during queue preparation');
    guards.set(ref.id, ref);
  };
  const traced = historicalTrace(store, (ref, head) => { if (head) remember(ref); }, 'distinct');
  current(traced, refinement);
  if (refinement.id === `graph-layer:${request.project}:2`) {
    const basis = readLayerAcceptance(traced, { project: request.project, level: 2, graph, layer: refinement });
    if (!basis.ok) fail('horizon_refinement_unproven', basis.refusal.at.target, basis.refusal.at.field ?? 'acceptance', basis.refusal.message);
    for (const ref of basis.value.currentReferences) current(traced, ref);
  } else {
    const phase = take(readRecord<{ layer: Ref }>(traced, refinement,
      { unit: 'M3', target: refinement.id, kind: 'phase', id: `phase:${request.project}:L2` }));
    // Legacy layers need the full projection check too, even when they predate layerProofs.
    take(readLayerEnvelope(traced, { project: request.project, level: 2, graph, layer: phase.value.layer }));
    const engine = new ProductEngine(traced);
    for (const [name, gate] of [['refinement.L2', engine.refinement.gate(request.project, 'L2')],
      ['layer.2', engine.graphs.layerGate(request.project, 2, phase.value.layer)]] as const) {
      const admission = take(readOmAdmissionGuards(gate.admissionGuards, name, 'G2'));
      if (gate.findings.length) {
        const finding = gate.findings[0]!;
        fail('horizon_refinement_unproven', finding.target, finding.code, finding.message);
      }
      for (const ref of [...gate.guards, ...admission]) remember(ref);
    }
  }
  return [...guards.values()];
}
export function prepareBlockQueue(store: Store, request: QueueRequest): OmResult<Sealed<PreparedBlockQueue>> {
  requireRequest(store, request); request = copy(request);
  return run(() => {
    const value = derive(store, request), id = idOf(request);
    const graph = store.get<Graph>(`graph:${request.project}`);
    if (!graph) fail('record_missing', `graph:${request.project}`, 'graph', 'A queue requires the current full graph');
    const prepared = take(prepareHorizonBasis(store, { project: request.project, horizon: request.horizon, graph: reference(graph) }));
    if (!same(prepared.upperRef, request.policy.machinePath.layer))
      fail('queue_policy_invalid', request.policy.machinePath.layer.id, 'layer', 'The queue policy must select the exact admitted L1');
    const refinement = refinementGuards(store, prepared.horizon as HorizonRecords, reference(graph));
    const existing = store.get(id);
    if (existing) checked(store, request.project, reference(existing));
    const record: Revision<BlockQueueRecord> = { id, kind: 'block-weight', revision: 1, hash: hashJson(value), value };
    return { record, writes: existing ? [] : [{ id, kind: record.kind, expected: 0, value }],
      guards: uniqueTransactionGuards([...prepared.guards, ...refinement, request.horizon, request.policy.machinePath.layer, ...(existing ? [reference(existing)] : [])]) };
  });
}
export function writeBlockQueue(store: Store, request: QueueRequest): OmResult<Sealed<Revision<BlockQueueRecord>>> {
  requireRequest(store, request); request = copy(request);
  return run(() => {
    const previous = store.get(idOf(request), 1);
    if (previous) return checked(store, request.project, reference(previous));
    const prepared = take(prepareBlockQueue(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'M3', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record as Revision<BlockQueueRecord>;
  });
}

function questionRequest(store: Store, value: unknown): asserts value is QuestionQueueRequest {
  if (!(store instanceof Store) || !object(value)) invalid('questions');
  projectName(value.project); if (!exactRef(value.queue) || !exactRef(value.routes)) invalid('questions.sources');
}
function questions(store: Store, request: QuestionQueueRequest): QuestionQueue {
  const queue = checked(store, request.project, request.queue), routed = take(readRoutes(store, { project: request.project, record: request.routes }));
  const source = routed.record.value.request.gaps.sources, base = sources(store, queue.value.request);
  if (!same(source.horizon, queue.value.request.horizon) || !same(source.input, base.horizon.horizon.value.request.input))
    fail('queue_source_invalid', request.routes.id, 'gaps.sources', 'Question routes must belong to this exact horizon input');
  take(readLayerEnvelope(store, { project: request.project, level: 1, graph: source.graph, layer: queue.value.request.policy.machinePath.layer }));
  const known = new Set(base.upper.nodes.filter(node => node.kind === 'block').map(node => node.id)), consumers = new Set<string>();
  // M6 already selects unanswered model questions. D1 supplies their block consumers; targets are not block identities.
  for (const batch of routed.record.value.batches) for (const item of batch.items) for (const consumer of item.consumers) {
    if (!known.has(consumer)) fail('queue_source_invalid', consumer, 'consumers', 'A question consumer must resolve to an accepted L1 block');
    consumers.add(consumer);
  }
  return { queue: request.queue, routes: request.routes, order: queue.value.order.filter(row => consumers.has(row.block)),
    references: uniqueRefs([request.queue, request.routes, queue.value.request.horizon, queue.value.request.policy.machinePath.layer,
      ...routed.references as Ref[]]) };
}
/** Historical ordering is not permission to send; model consumers still use M6/E1/E4 admission. */
export function readQuestionQueue(store: Store, request: QuestionQueueRequest): OmResult<Sealed<QuestionQueue>> {
  questionRequest(store, request); request = copy(request);
  return run(() => questions(store, request));
}
export function prepareQuestionQueue(store: Store, request: QuestionQueueRequest): OmResult<Sealed<QuestionQueue & { guards: TransactionGuard[] }>> {
  questionRequest(store, request); request = copy(request);
  return run(() => {
    const value = questions(store, request), queue = checked(store, request.project, request.queue);
    const bases = [request.queue, request.routes, queue.value.request.horizon, queue.value.request.policy.machinePath.layer];
    for (const ref of bases) current(store, ref);
    const routes = take(readRoutes(store, { project: request.project, record: request.routes })), saved = routes.record.value.request as RoutesRecord['request'];
    const prepared = take(prepareRoutes(store, { ...saved, tasks: saved.tasks.map(record => ({ record })) }));
    if (prepared.writes.length || !same(reference(prepared.record), request.routes))
      fail('input_stale', request.routes.id, 'routes', 'Question ordering requires the exact currently admitted routing');
    // M4 may extend the graph after the base queue. M6 proves today's graph against the same exact L1 and horizon;
    // requiring the old full graph head again would prevent this queue's second, question-ordering use.
    return { ...value, guards: uniqueTransactionGuards([...bases, ...prepared.guards]) };
  });
}
