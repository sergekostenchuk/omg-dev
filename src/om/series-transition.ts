import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { controlPredecessors } from '../graph/dependencies.js';
import { LEVEL, type Graph, type Node, type Binding, type Endpoint } from '../graph/model.js';
import { projectGraph } from '../graph/project.js';
import { RefinementRelations } from '../graph/relations.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { readHorizon, prepareHorizon, type Horizon, type HorizonBasis, type HorizonRecords } from './horizon.js';
import { readFrameBasis, readFrame, fillObligations, flowKey, type FilledFrame, type FrameRequest, type FrameScope } from './frame-obligations.js';
import { readLayerAcceptance } from './layer-basis.js';
import { historicalTrace, withHistoricalReads } from './input.js';
import { readAnySeriesAt, prepareSeriesLineAdmission, type RepairSeries } from './series.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, type OmResult, type Refusal, type Sealed } from './refusal.js';

export const SERIES_TRANSITION_CONTRACT = 'om-series-transition/v1';
export const SERIES_SLICE_CONTRACT = 'series-slice/v1';
export const SERIES_TRANSITION_KIND = 'series-transition';
// This names participants; only B3.0b's membership CAS can prove the set complete for application.
export interface SeriesTransitionRequest { project: string; choiceVersion: string; horizon: Ref; series: Ref[] }
export interface SeriesSlice { contract: typeof SERIES_SLICE_CONTRACT; body: Json; hash: string }
export interface PreparedSeriesDecision {
  block: string; series: Ref; participation: 'active' | 'excluded' | 'boundary' | 'unselected';
  outcome: 'establish-basis' | 'inactive'; previousSlice: string; slice: SeriesSlice | null;
}
export interface PreparedSeriesTransitionRecord {
  contract: typeof SERIES_TRANSITION_CONTRACT; state: 'prepared'; request: SeriesTransitionRequest;
  decisions: PreparedSeriesDecision[];
}
export interface PreparedSeriesTransition {
  record: Revision<PreparedSeriesTransitionRecord>; writes: Write[]; guards: TransactionGuard[];
}
const UNIT = 'B3';
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const exactRef = (value: unknown): value is Ref => object(value) && isRef(value)
  && canonical(Object.keys(value).sort()) === canonical(['hash', 'id', 'revision']);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(items: readonly T[]): T[] => [...items].sort((a, b) => order(canonical(a), canonical(b)));
const uniqueRefs = (refs: readonly Ref[]): Ref[] => sorted([...new Map(refs.map(ref => [canonical(ref), ref])).values()]);
class TransitionFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(result: OmResult<T>): T {
  if (!result.ok) throw new TransitionFailure(result.refusal);
  return result.value;
}
function fail(target: string, field: string, message: string, code = 'series_transition_unproven'): never {
  return take(refused(code, message, { unit: UNIT, target, field }, 'producer'));
}
function result<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(withHistoricalReads(action)); }
  catch (error) { if (error instanceof TransitionFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function requireRequest(store: Store, value: unknown): asserts value is SeriesTransitionRequest {
  if (!(store instanceof Store) || !object(value) || !text(value['project'])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value['project']) || !text(value['choiceVersion'])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value['choiceVersion']) || !exactRef(value['horizon'])
    || !Array.isArray(value['series']) || !value['series'].every(exactRef))
    throw new EngineError('series_transition_request_invalid', 'A prepared transition names its exact horizon and explicit series set',
      { unit: UNIT, target: 'series-transition', field: 'request' });
}
function normalized(request: SeriesTransitionRequest): SeriesTransitionRequest {
  return { project: request.project, choiceVersion: request.choiceVersion, horizon: { ...request.horizon }, series: sorted(request.series) };
}
function transitionId(request: SeriesTransitionRequest): string {
  return `series-transition:${request.project}:${hashJson(request)}`;
}
function exact<T>(store: Store, ref: Ref, id: string, kind: string): Revision<T> {
  return take(readRecord<T>(store, ref, { unit: UNIT, target: id, id, kind })) as Revision<T>;
}
function horizonSource(store: Store, request: SeriesTransitionRequest): HorizonRecords {
  const horizon = take(readHorizon(store, request.project, request.horizon)) as HorizonRecords;
  if (horizon.gate.value.choiceVersion !== request.choiceVersion)
    fail(request.horizon.id, 'choiceVersion', 'A transition needs the proved horizon outcome of this exact choice');
  return horizon;
}
interface SliceFrame extends FilledFrame { identities: string[] }
function frameSource(store: Store, horizon: HorizonRecords, horizonRef: Ref, graph: Graph): SliceFrame {
  const source = horizon.horizon.value.request;
  const request: FrameRequest = { project: source.project, level: 2, horizon: horizonRef, graph: source.graph,
    layer: null, frame: null, upper: null };
  const base = take(readFrameBasis(store, request));
  if (source.refinement?.id === `graph-layer:${source.project}:2`) {
    const accepted = take(readLayerAcceptance(store, { project: source.project, level: 2, graph: source.graph, layer: source.refinement }));
    const read = take(readFrame(store, { ...request, layer: source.refinement, frame: accepted.frame }));
    if (!read.accepted?.frame) fail(source.refinement.id, 'frame', 'Accepted OM disclosure requires its exact correspondence frame');
    return { ...read.result as FilledFrame, identities: read.accepted.frame.value.fills
      .filter(fill => fill.source === 'identity').map(fill => fill.node) };
  }
  // readHorizon has proved the research milestone, including old L2 without a modern own layer proof.
  return { ...take(fillObligations(base.upper as Graph, base.scope as FrameScope, source.refinement
    ? { graph, reference: source.graph, frame: null } : null, base.upperRef, 2)) as FilledFrame, identities: [] };
}
function endpoint(value: Endpoint): Endpoint {
  return { node: value.node, port: value.port, ...(value.codeRef === undefined ? {} : { codeRef: { ...value.codeRef } }) };
}
function nodeContent(node: Node, version: Graph['version']): Node {
  return { id: node.id, kind: node.kind, parent: node.parent, title: node.title, outcome: node.outcome,
    boundary: { ...node.boundary }, ports: sorted(node.ports), code: sorted(node.code), tests: sorted(node.tests),
    ...(version === 2 ? { purpose: node.purpose!, benefit: node.benefit!, beneficiary: node.beneficiary!, implements: sorted(node.implements!) } : {}) };
}
function required<T extends { id: string }>(source: readonly T[], ids: Iterable<string>, field: string): T[] {
  return sorted([...new Set(ids)].map(id => {
    const found = source.filter(item => item.id === id);
    if (found.length !== 1) fail(id, field, 'Every selected semantic reference needs exactly one definition', 'series_slice_unproven');
    return found[0]!;
  }));
}
function projectSlice(graph: Graph, horizon: Horizon, frame: SliceFrame, block: string, hasL2: boolean,
  availableReceipts: Record<string, HorizonBasis>): SeriesSlice {
  // Cap sources at the proved layer before local selection, including a connector's layer-specific wake test.
  const full = graph, level = hasL2 ? 2 : 1;
  const { level: _level, ...projection } = projectGraph(graph, level);
  graph = { ...projection, version: graph.version } as Graph;
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const available = new Set(horizon.nodes), boundary = new Set(horizon.boundary.map(item => item.block));
  const artifactsById = new Map(graph.artifacts.map(artifact => [artifact.id, artifact]));
  const selected = new Set<string>(), queue = [block];
  while (queue.length) {
    const id = queue.shift()!;
    if (selected.has(id)) continue;
    if (!available.has(id) || nodesById.get(id)?.kind !== 'block')
      fail(id, 'nodes', 'The local dependency must belong to the proved horizon', 'series_slice_unproven');
    selected.add(id);
    const predecessors = graph.connectors.flatMap(connector => connector.bindings
      .filter(binding => binding.level === 1 && binding.anchor === null && binding.consumers.some(consumer => consumer.node === id))
      .flatMap(binding => artifactsById.get(connector.artifact)?.external ? [] : [binding.producer.node]));
    predecessors.push(...controlPredecessors(graph, id).map(item => item.producer));
    for (const predecessor of predecessors) if (!selected.has(predecessor) && !boundary.has(predecessor)) queue.push(predecessor);
  }
  const blocks = new Set(selected), relations = new RefinementRelations(graph);
  const identities = new Set(frame.identities);
  if (hasL2) for (const node of graph.nodes) if (node.kind === 'operation' && !identities.has(node.id)
    && [...blocks].some(parent => relations.refines(node.id, parent))) selected.add(node.id);
  // Select upper ends from the same local flows as the connector projection. A producer may also
  // serve independent consumers; those separate flows are not this block's disclosure obligations.
  const localEnds = new Set(graph.connectors.flatMap(connector => connector.bindings
    .filter(binding => binding.level === 1 && binding.consumers.some(consumer => blocks.has(consumer.node)))
    .flatMap(binding => [
      canonical([connector.id, flowKey(binding), 'producer', binding.producer.node, binding.producer.port]),
      ...binding.consumers.filter(consumer => blocks.has(consumer.node))
        .map(consumer => canonical([connector.id, flowKey(binding), 'consumer', consumer.node, consumer.port])),
    ])));
  const localObligations = frame.obligations.filter(item => blocks.has(item.upper.node)
    && (item.kind !== 'connection-end' || localEnds.has(canonical([item.connector, item.flow, item.role, item.upper.node, item.upper.port]))));
  const obligationIds = new Set(localObligations.map(item => item.id));
  const fills = frame.fills.filter(fill => obligationIds.has(fill.obligation));
  if (hasL2) for (const fill of fills) if (fill.source === 'accepted') {
    if (nodesById.get(fill.node)?.kind !== 'operation') fail(fill.node, 'fills', 'An accepted L2 correspondence names an operation', 'series_slice_unproven');
    selected.add(fill.node);
  }
  const nodes = required(graph.nodes, selected, 'nodes').map(node => nodeContent(node, graph.version));
  required(graph.nodes, nodes.flatMap(node => node.parent === null ? [] : [node.parent]), 'nodes.parent');
  const connectors = graph.connectors.flatMap(connector => {
    const bindings: Binding[] = connector.bindings.filter(binding => binding.level <= (hasL2 ? 2 : 1)).flatMap(binding => {
      const consumers = binding.consumers.filter(consumer => selected.has(consumer.node));
      if (!consumers.length) return [];
      return [{ level: binding.level, anchor: binding.anchor, producer: endpoint(binding.producer), consumers: sorted(consumers.map(endpoint)) }];
    });
    if (!bindings.length) return [];
    const original = required(full.connectors, [connector.id], 'connectors')[0]!;
    let wakeTest = original.wakeTest;
    if (wakeTest !== null) {
      const test = required(full.tests, [wakeTest], 'wakeTest')[0]!;
      const node = required(full.nodes, [test.node], 'wakeTest.node')[0]!;
      if (LEVEL[node.kind] > level) wakeTest = null;
    }
    return [{ id: connector.id, artifact: connector.artifact, returnsTo: connector.returnsTo,
      wakeTest, bindings: sorted(bindings) }];
  });
  for (const connector of connectors) {
    required(graph.nodes, [connector.returnsTo], 'connectors.returnsTo');
    for (const binding of connector.bindings) for (const end of [binding.producer, ...binding.consumers]) {
      const node = required(graph.nodes, [end.node], 'binding.node')[0]!;
      const ports = node.ports.filter(port => port.id === end.port);
      if (ports.length !== 1) fail(end.node, end.port, 'A selected flow endpoint requires its exact port', 'series_slice_unproven');
      if (ports[0]!.contract !== artifactsById.get(connector.artifact)?.contract
        || ports[0]!.direction !== (end === binding.producer ? 'out' : 'in'))
        fail(end.node, end.port, 'The endpoint must implement the selected artifact contract and direction', 'series_slice_unproven');
      required(graph.contracts, ports.map(port => port.contract), 'binding.contract');
    }
  }
  const anchorIds = new Set(connectors.flatMap(connector => connector.bindings.flatMap(binding => binding.anchor === null ? [] : [binding.anchor])));
  graph.anchors.filter(anchor => selected.has(anchor.owner)).forEach(anchor => anchorIds.add(anchor.id));
  const anchors = required(graph.anchors, anchorIds, 'anchors');
  const joins = graph.joins.filter(join => selected.has(join.consumer)).map(join => ({ id: join.id, consumer: join.consumer,
    connectors: sorted(join.connectors), ...(join.failures === undefined ? {} : { failures: { ...join.failures } }),
    ...(join.condition === undefined ? {} : { condition: join.condition }),
    ...(join.required === undefined ? {} : { required: sorted(join.required) }), ...(join.optional === undefined ? {} : { optional: sorted(join.optional) }) }));
  for (const join of joins) {
    required(graph.connectors, [...join.connectors, ...(join.required ?? []), ...(join.optional ?? [])], 'joins.connectors');
    if (join.failures) required(graph.nodes, [join.failures.returnsTo], 'joins.returnsTo');
  }
  const testIds = new Set([...nodes.flatMap(node => node.tests), ...anchors.map(anchor => anchor.test),
    ...connectors.flatMap(connector => connector.wakeTest === null ? [] : [connector.wakeTest])]);
  const tests = required(graph.tests, testIds, 'tests').map(test => ({ id: test.id, node: test.node, command: test.command,
    covers: sorted(test.covers), ...(test.obligations === undefined ? {} : { obligations: sorted(test.obligations) }),
    ...(test.contract === undefined ? {} : { contract: { ...test.contract,
      counterfactuals: sorted(test.contract.counterfactuals), resources: sorted(test.contract.resources) } }) }));
  for (const test of tests) {
    required(graph.nodes, [test.node], 'tests.node');
    required(graph.connectors, [...test.covers, ...(test.contract?.counterfactuals.map(item => item.connector) ?? [])], 'tests.covers');
  }
  const requirements = graph.version === 2 ? required(graph.requirements!, nodes.flatMap(node => node.implements!), 'implements') : [];
  const edges = graph.version === 2 ? graph.edges!.filter(edge => selected.has(edge.source)) : [];
  const transfers = graph.version === 2 ? graph.transfers!.filter(transfer => selected.has(transfer.to)) : [];
  const packets = graph.version === 2 ? graph.packets!.filter(packet => selected.has(packet.unit)).map(packet => ({ ...packet, writePaths: sorted(packet.writePaths) })) : [];
  const journeys = graph.version === 2 ? graph.journeys!.flatMap(journey => {
    const segments: { entry: string; path: string[]; exit: string | null; outcome?: string; terminal?: string }[] = [];
    for (let index = 0; index < journey.path.length;) {
      if (!selected.has(journey.path[index]!)) { index++; continue; }
      const start = index;
      while (index < journey.path.length && selected.has(journey.path[index]!)) index++;
      segments.push({ entry: start === 0 ? journey.entry : journey.path[start - 1]!, path: journey.path.slice(start, index),
        exit: journey.path[index] ?? null, ...(index === journey.path.length ? { outcome: journey.outcome, terminal: journey.terminal } : {}) });
    }
    return segments.length ? [{ id: journey.id, actor: journey.actor, variant: journey.variant, segments }] : [];
  }) : [];
  required(graph.nodes, [...edges.map(edge => edge.target), ...transfers.map(transfer => transfer.from),
    ...anchors.map(anchor => anchor.owner), ...journeys.flatMap(journey => journey.segments.flatMap(segment =>
      [segment.entry, ...(segment.exit === null ? [] : [segment.exit])]))], 'semantic.target');
  const artifacts = required(graph.artifacts, [...nodes.map(node => node.outcome), ...connectors.map(connector => connector.artifact),
    ...localObligations.map(item => item.artifact), ...anchors.map(anchor => anchor.outcome), ...requirements.map(item => item.outcome),
    ...journeys.flatMap(journey => journey.segments.flatMap(segment => segment.outcome === undefined ? [] : [segment.outcome]))], 'artifacts');
  const contracts = required(graph.contracts, [...nodes.flatMap(node => node.ports.map(port => port.contract)),
    ...artifacts.map(artifact => artifact.contract)], 'contracts');
  const actors = graph.version === 2 ? required(graph.actors!, [...nodes.map(node => node.beneficiary!),
    ...requirements.map(item => item.beneficiary), ...journeys.map(item => item.actor)], 'actors').map(actor => ({ ...actor, channels: sorted(actor.channels) })) : [];
  // A boundary can carry receipts for other consumers. Only actual local consumption is a slice dependency.
  const receipts: { source: string; artifact: string; receipt: Ref }[] = [];
  const consume = (source: string, artifact: string) => {
    const state = horizon.execution[source], external = artifactsById.get(artifact)?.external === true;
    // An external-only supplier need not belong to nodes or boundary. H has still checked every declared receipt.
    const basis = external ? (Object.hasOwn(availableReceipts, source) ? availableReceipts[source] : undefined)
      : horizon.boundary.find(item => item.block === source)?.basis ?? (state?.state === 'available' ? state.basis : undefined);
    if (basis) {
      // External inputs need a receipt only when the horizon explicitly includes one for this artifact.
      if (external && !Object.hasOwn(basis, artifact)) return;
      const receipt = basis[artifact];
      if (!isRef(receipt)) fail(source, artifact, 'Local readiness requires its exact consumed receipt', 'series_slice_unproven');
      if (!receipts.some(item => item.source === source && item.artifact === artifact)) receipts.push({ source, artifact, receipt });
    }
  };
  for (const connector of connectors) for (const binding of connector.bindings) if (binding.level === 1 && binding.anchor === null) consume(binding.producer.node, connector.artifact);
  for (const id of blocks) for (const predecessor of controlPredecessors(graph, id)) consume(predecessor.producer, nodesById.get(predecessor.producer)!.outcome);
  const own = horizon.execution[block], outcome = nodesById.get(block)!.outcome;
  if (horizon.features.includes(outcome) || own?.state === 'available' && Object.hasOwn(own.basis, outcome)) consume(block, outcome);
  const external = horizon.externalInputs.filter(item => selected.has(item.consumer));
  const body = { block, blocks: sorted([...blocks]), nodes: sorted(nodes), connectors: sorted(connectors), artifacts, contracts, anchors,
    joins: sorted(joins), tests, requirements, actors, edges: sorted(edges), transfers: sorted(transfers), packets: sorted(packets), journeys: sorted(journeys),
    refinement: sorted([...blocks].map(id => ({ block: id, state: horizon.refinement[id]! }))),
    obligations: sorted(localObligations), fills: sorted(fills.map(({ basis: _basis, ...fill }) => fill)),
    open: sorted(frame.open.filter(item => obligationIds.has(item.id))), receipts: sorted(receipts), external: sorted(external) } as unknown as Json;
  return { contract: SERIES_SLICE_CONTRACT, body, hash: hashJson({ contract: SERIES_SLICE_CONTRACT, body }) };
}
function derive(store: Store, request: SeriesTransitionRequest): PreparedSeriesTransitionRecord {
  const horizon = horizonSource(store, request), source = horizon.horizon.value.request, h = horizon.horizon.value.result.horizon;
  const graph = exact<Graph>(store, source.graph, `graph:${request.project}`, 'graph').value;
  const blocks = new Set<string>();
  const seriesSources = request.series.map(ref => {
    const read = take(readAnySeriesAt(store, request.project, ref));
    if (!('block' in read.value)) fail(ref.id, 'owner', 'Mechanism series do not participate in block transitions');
    const series = read.value as RepairSeries;
    if (blocks.has(series.block) || !graph.nodes.some(node => node.id === series.block && node.kind === 'block'))
      fail(ref.id, 'block', 'The explicit series set names each known block at most once');
    blocks.add(series.block);
    return { ref, series };
  });
  // A proved refusal carries the named sources, but cannot assert active participation or a local slice.
  if (horizon.gate.value.state === 'refused')
    return { contract: SERIES_TRANSITION_CONTRACT, state: 'prepared', request, decisions: [] };
  const frame = frameSource(store, horizon, request.horizon, graph);
  const decisions = seriesSources.map(({ ref, series }) => {
    const participation = h.nodes.includes(series.block) ? 'active' : h.excluded.some(item => item.block === series.block)
      ? 'excluded' : h.boundary.some(item => item.block === series.block) ? 'boundary' : 'unselected';
    // Activation and the proof of the last applied active basis belong to B3.0b. A legacy string cannot prove equality.
    return { block: series.block, series: ref, participation, outcome: participation === 'active' ? 'establish-basis' : 'inactive',
      previousSlice: series.slice, slice: participation === 'active'
        ? projectSlice(graph, h, frame, series.block, source.refinement !== null, source.available) : null } as PreparedSeriesDecision;
  });
  return { contract: SERIES_TRANSITION_CONTRACT, state: 'prepared', request, decisions: sorted(decisions) };
}
function checked(store: Store, project: string, ref: Ref): Revision<PreparedSeriesTransitionRecord> {
  const read = take(readRecord<PreparedSeriesTransitionRecord>(store, ref, { unit: UNIT, target: project,
    idPrefix: `series-transition:${project}:`, kind: SERIES_TRANSITION_KIND }));
  const value = read.value;
  if (!object(value) || value.contract !== SERIES_TRANSITION_CONTRACT || value.state !== 'prepared' || !object(value.request))
    fail(ref.id, 'contract', 'The exact source must be a prepared transition of the known producer');
  try { requireRequest(store, value.request); }
  catch (error) { if (error instanceof EngineError && error.code === 'series_transition_request_invalid')
    fail(ref.id, 'request', 'The saved transition requires all exact sources'); throw error; }
  if (value.request.project !== project || ref.revision !== 1 || ref.id !== transitionId(value.request)
    || canonical(value.request) !== canonical(normalized(value.request))) fail(ref.id, 'request', 'The prepared transition has a noncanonical identity');
  const derived = derive(store, value.request as SeriesTransitionRequest);
  if (canonical(derived) !== canonical(value)) fail(ref.id, 'decisions', 'The transition and local slices must follow their exact sources');
  return read as Revision<PreparedSeriesTransitionRecord>;
}
export function readPreparedSeriesTransition(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<{
  record: Revision<PreparedSeriesTransitionRecord>; references: Ref[];
}>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !exactRef(request.record))
    throw new EngineError('series_transition_request_invalid', 'Historical transition reading needs an exact reference',
      { unit: UNIT, target: 'series-transition', field: 'record' });
  return result(() => {
    const references: Ref[] = [];
    const traced = historicalTrace(store, ref => references.push(ref));
    const record = checked(traced, request.project, request.record);
    return { record, references: uniqueRefs(references) };
  });
}
export function prepareSeriesTransition(store: Store, request: SeriesTransitionRequest): OmResult<Sealed<PreparedSeriesTransition>> {
  requireRequest(store, request); request = normalized(request);
  return result(() => {
    const id = transitionId(request), existing = store.get<PreparedSeriesTransitionRecord>(id, 1);
    const record = existing ? checked(store, request.project, reference(existing))
      : { id, kind: SERIES_TRANSITION_KIND, revision: 1, value: derive(store, request), hash: '' };
    if (!existing) record.hash = hashJson(record.value);
    const horizon = horizonSource(store, request);
    const admission = take(prepareHorizon(store, horizon.horizon.value.request));
    const guards: TransactionGuard[] = [...admission.guards];
    for (const ref of request.series) guards.push(...take(prepareSeriesLineAdmission(store, request.project, ref)).guards);
    if (existing) guards.push(reference(existing));
    return { record, writes: existing ? [] : [{ id, kind: SERIES_TRANSITION_KIND, expected: 0, value: record.value }],
      guards: uniqueTransactionGuards(guards) };
  });
}
export function writeSeriesTransition(store: Store, request: SeriesTransitionRequest): OmResult<Sealed<Revision<PreparedSeriesTransitionRecord>>> {
  requireRequest(store, request); request = normalized(request);
  const existing = store.get<PreparedSeriesTransitionRecord>(transitionId(request), 1);
  if (existing) return result(() => checked(store, request.project, reference(existing)));
  const prepared = prepareSeriesTransition(store, request);
  if (!prepared.ok) return prepared;
  if (!prepared.value.writes.length) return delivered(prepared.value.record);
  const written = writeGuarded<PreparedSeriesTransitionRecord>(store, { unit: UNIT, target: request.project,
    writes: prepared.value.writes, guards: prepared.value.guards });
  return written.ok ? delivered(written.value[0]!) : written;
}
/** Content comparison only. Applying it requires B3.0b's proof of the last active basis and complete series membership. */
export function comparePreparedSeriesSlices(store: Store, request: { project: string; previous: Ref; next: Ref; block: string }): OmResult<Sealed<'continue' | 'new-work'>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !exactRef(request.previous) || !exactRef(request.next) || !text(request.block))
    throw new EngineError('series_transition_request_invalid', 'Slice comparison names two exact prepared sources and a block',
      { unit: UNIT, target: 'series-transition', field: 'comparison' });
  return result(() => {
    const previous = checked(store, request.project, request.previous).value.decisions.find(item => item.block === request.block);
    const next = checked(store, request.project, request.next).value.decisions.find(item => item.block === request.block);
    if (!previous?.slice || !next?.slice) fail(request.block, 'slice', 'Comparison needs two proven active local slices');
    return canonical(previous.slice) === canonical(next.slice) ? 'continue' : 'new-work';
  });
}
