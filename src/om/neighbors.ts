import { uniqueTransactionGuards } from '../runtime/environment.js';
import { Ajv } from 'ajv';
import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { controlPredecessors } from '../graph/dependencies.js';
import type { Binding, CodeRef, Connector, Endpoint, Graph, Node } from '../graph/model.js';
import { RefinementRelations } from '../graph/relations.js';
import { graphSchema, graphV2Schema } from '../graph/schema.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type TransactionGuard, type Revision, type Write } from '../storage/store.js';
import { prepareDeliveries, type DeliveryRead, type DeliveryReadRequest } from './deliveries.js';
import type { CandidateReadRequest } from './frame-candidate.js';
import { flowKey, readFrame, readFrameFlow, type FrameFlowRead, type FrameObligation, type FrameRequest } from './frame-obligations.js';
import { withHistoricalReads } from './input.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, isPlainObject, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readWorksFrame } from './works-frame.js';

export const NEIGHBOR_CODES = Object.freeze(['neighbor_request_invalid', 'neighbor_chain_broken',
  'neighbor_chain_ambiguous', 'neighbor_contract_missing', 'neighbor_record_forged'] as const);
export const NEIGHBOR_CONTRACT = 'neighbor-packets/v1' as const;
export interface NeighborFill {
  obligation: string; node: string; port?: string; codeRef?: CodeRef; source: 'accepted' | 'identity' | 'proposed';
}
export interface NeighborFrame { obligations: FrameObligation[]; fills: NeighborFill[] }
export interface NeighborSources {
  identity: string[]; receipts: Record<string, Ref>;
  frames: { operations: NeighborFrame; works: NeighborFrame };
}
export interface NeighborNode { id: string; title: string; outcome: string; represented?: true }
export interface NeighborChain { work: NeighborNode; operation: NeighborNode; block: NeighborNode }
export interface DataNeighbor {
  control?: never; connector: string; artifact: string; contract: { id: string; hash: string; external: boolean };
  direction: 'reads' | 'writes'; port: string; codeRef: CodeRef | null;
  neighbor: NeighborChain & { port: string; codeRef: CodeRef | null };
  returnsTo: string; delivery: 'in-plan' | 'available' | 'external' | 'sleeping' | 'undelivered';
  anchor?: string; wakeTest?: string; basis?: Ref;
}
interface ControlNeighbor {
  control: string; connector?: never; port?: never; codeRef?: never; returnsTo?: never; anchor?: never; wakeTest?: never;
  neighbor: NeighborChain & { port?: never; codeRef?: never };
  delivery: DataNeighbor['delivery']; basis?: Ref;
}
export interface RequiresNeighbor extends ControlNeighbor {
  direction: 'requires'; artifact: string; contract: DataNeighbor['contract']; path?: never; condition?: never;
}
export interface OwnershipNeighbor extends ControlNeighbor {
  direction: 'receives' | 'sends'; path: string; condition: 'producer_committed'; artifact?: never; contract?: never;
}
export type Neighbor = DataNeighbor | RequiresNeighbor | OwnershipNeighbor;
export interface NeighborPacket { work: string; neighbors: Neighbor[]; hash: string }
const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const uniqueRefs = (refs: readonly Ref[]): Ref[] => [...new Map(refs.map(ref => [canonical(ref), ref])).values()]
  .sort((a, b) => order(canonical(a), canonical(b)));
type Validator = ReturnType<Ajv['compile']>;
let shapes: { graphShapes: Validator[]; codeShape: Validator } | undefined;
const neighborShapes = () => shapes ??= (() => {
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  return { graphShapes: [ajv.compile(sealed(graphSchema)), ajv.compile(sealed(graphV2Schema))],
    codeShape: ajv.compile(sealed(graphV2Schema.properties['nodes'].items.properties.code.items)) };
})();
function invalid(field: string): never {
  throw new EngineError('neighbor_request_invalid', 'Neighbors require explicit, well-formed sources',
    { unit: 'F7.3', target: 'neighbors', field });
}
class NeighborFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function reject(code: string, target: string, field: string, message: string): never {
  const result = refused(code, message, { unit: 'F7.3', target, field }, 'producer');
  if (!result.ok) throw new NeighborFailure(result.refusal);
  throw new EngineError('neighbor_internal_error', 'A refusal unexpectedly returned a value');
}
function result<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof NeighborFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function unwrap<T>(value: OmResult<T>): T { if (!value.ok) throw new NeighborFailure(value.refusal); return value.value; }
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function requireSources(graph: unknown, sources: unknown): asserts sources is NeighborSources {
  if (!object(graph) || !neighborShapes().graphShapes[graph['version'] === 2 ? 1 : 0]!(graph)) invalid('graph');
  if (!object(sources) || !Array.isArray(sources['identity']) || !sources['identity'].every(text)
    || !object(sources['receipts']) || !Object.values(sources['receipts']).every(isRef) || !object(sources['frames'])) invalid('sources');
  for (const [name, level] of [['operations', 2], ['works', 3]] as const) {
    const frame = sources['frames'][name];
    if (!object(frame) || !Array.isArray(frame['obligations']) || !frame['obligations'].every(o => object(o)
      && text(o['id']) && o['level'] === level && ['connection-end', 'block-outcome', 'operation-outcome'].includes(o['kind'] as string)
      && object(o['upper']) && text(o['upper']['node']) && (!Object.hasOwn(o['upper'], 'port') || text(o['upper']['port']))
      && text(o['artifact']) && ['horizon', 'outside'].includes(o['zone'] as string)
      && (o['kind'] !== 'connection-end' || (text(o['connector']) && ['producer', 'consumer'].includes(o['role'] as string)
        && text(o['flow']) && text(o['upper']['port']))))) invalid(`frames.${name}.obligations`);
    if (!Array.isArray(frame['fills']) || !frame['fills'].every(fill => object(fill)
      && text(fill['obligation']) && text(fill['node']) && ['accepted', 'identity', 'proposed'].includes(fill['source'] as string)
      && (!Object.hasOwn(fill, 'port') || text(fill['port'])) && (!Object.hasOwn(fill, 'codeRef') || neighborShapes().codeShape(fill['codeRef']))))
      invalid(`frames.${name}.fills`);
  }
}
interface Context { graph: Graph; sources: NeighborSources; nodes: Map<string, Node>; identities: Set<string>; flows: Map<string, Sealed<FrameFlowRead>> }
function context(graph: Graph, sources: NeighborSources): Context {
  requireSources(graph, sources); graph = copy(graph); sources = copy(sources);
  const checkIds = (values: readonly { id: string }[], field: string) => {
    if (new Set(values.map(v => v.id)).size !== values.length) reject('neighbor_chain_ambiguous', 'neighbors', field, 'Duplicate addresses cannot select a neighbor');
  };
  for (const field of ['nodes', 'artifacts', 'contracts', 'connectors', 'anchors', 'tests'] as const) checkIds(graph[field], field);
  checkIds([...(graph.edges ?? []), ...(graph.transfers ?? [])], 'controls');
  if (new Set(graph.horizon).size !== graph.horizon.length) reject('neighbor_chain_ambiguous', 'neighbors', 'horizon', 'Each work has exactly one packet');
  const nodes = new Map(graph.nodes.map(n => [n.id, n])), identities = new Set(sources.identity);
  if (identities.size !== sources.identity.length) invalid('identity.duplicates');
  for (const id of identities) if (!['work', 'operation'].includes(nodes.get(id)?.kind ?? '')) invalid('identity');
  for (const node of graph.nodes) checkIds(node.ports, `${node.id}.ports`);
  for (const id of graph.horizon) if (nodes.get(id)?.kind !== 'work' || identities.has(id))
    reject('neighbor_chain_broken', id, 'horizon', 'The execution horizon contains real works');
  const relations = new RefinementRelations(graph);
  for (const frame of [sources.frames.operations, sources.frames.works]) {
    checkIds(frame.obligations, 'obligations');
    const fills = new Set<string>();
    for (const fill of frame.fills) {
      const key = canonical([fill.obligation, fill.node, fill.port ?? null]);
      if (fills.has(key)) reject('neighbor_chain_ambiguous', fill.node, 'fills', 'Duplicate correspondence is not another address');
      fills.add(key);
      if (!frame.obligations.some(o => o.id === fill.obligation) || !nodes.has(fill.node))
        reject('neighbor_chain_broken', fill.node, 'fills', 'A correspondence must name a known obligation and node');
      const obligation = frame.obligations.find(o => o.id === fill.obligation)!;
      if (!nodes.has(obligation.upper.node) || !relations.refines(fill.node, obligation.upper.node))
        reject('neighbor_chain_broken', fill.node, fill.obligation, 'The saved correspondence must refine its named upper node');
      if (obligation.kind === 'connection-end') {
        const connector = graph.connectors.find(c => c.id === obligation.connector);
        const endpoints = (binding: Binding) => obligation.role === 'producer' ? [binding.producer] : binding.consumers;
        if (!connector || !connector.bindings.some(b => b.level === obligation.level - 1 && flowKey(b) === obligation.flow
          && endpoints(b).some(e => e.node === obligation.upper.node && e.port === obligation.upper.port))
          || !connector.bindings.some(b => b.level === obligation.level && endpoints(b).some(e => e.node === fill.node && e.port === fill.port
            && (obligation.level !== 3 || fill.source === 'identity' || same(e.codeRef ?? null, fill.codeRef ?? null)))))
          reject('neighbor_chain_broken', fill.node, fill.obligation, 'The correspondence must describe exact ends of this connection');
      }
      if ((fill.source === 'identity') !== identities.has(fill.node))
        reject('neighbor_chain_broken', fill.node, 'identity', 'Representative classification must agree with the supplied frame');
    }
  }
  return { graph, sources, nodes, identities, flows: new Map() };
}
function descriptor(ctx: Context, id: string, kind: Node['kind']): NeighborNode {
  const node = ctx.nodes.get(id);
  if (!node || node.kind !== kind) reject('neighbor_chain_broken', id, kind, 'A neighbor chain must resolve each level');
  return { id, title: node.title, outcome: node.outcome, ...(ctx.identities.has(id) ? { represented: true as const } : {}) };
}
function endpointCode(ctx: Context, end: Endpoint, direction: 'in' | 'out', contract: string): CodeRef | null {
  const node = ctx.nodes.get(end.node), port = node?.ports.find(p => p.id === end.port);
  if (!node || node.kind !== 'work' || !port || port.direction !== direction || port.contract !== contract)
    reject('neighbor_chain_broken', end.node, end.port, 'The work endpoint must name its contracted port');
  if (ctx.identities.has(end.node)) return null;
  if (!end.codeRef || node.code.filter(code => same(code, end.codeRef)).length !== 1)
    reject('neighbor_chain_broken', end.node, end.port, 'A real endpoint requires its exact declared code reference');
  return end.codeRef;
}
interface UpperAddress { endpoint: Endpoint; binding: Binding }
function upperAddresses(ctx: Context, connector: Connector, binding: Binding, end: Endpoint,
  role: 'producer' | 'consumer'): UpperAddress[] {
  const level = binding.level, frame = level === 3 ? ctx.sources.frames.works : ctx.sources.frames.operations;
  const key = canonical([connector.id, binding]);
  let flow = ctx.flows.get(key);
  if (!flow) {
    const read = readFrameFlow(ctx.graph, ctx.graph, { obligations: frame.obligations,
      fills: frame.fills.map(fill => ({ ...fill, source: fill.source === 'identity' ? 'identity' : 'accepted' })),
      ...(level === 3 ? { worksContract: 'works-frame/v1' as const } : {}) }, connector.id, binding);
    if (!read.ok) reject(read.refusal.code === 'accepted_binding_ambiguous' ? 'neighbor_chain_ambiguous' : 'neighbor_chain_broken',
      connector.id, `flow:${level}`, read.refusal.message);
    flow = read.value; ctx.flows.set(key, flow);
  }
  const selected = flow.ends.filter(item => item.role === role && same(item.lower, end))
    .map(item => ({ endpoint: item.upper as Endpoint, binding: flow!.upper as Binding }));
  if (!selected.length) reject('neighbor_chain_broken', end.node, connector.id, 'The whole flow does not address this exact endpoint');
  return selected;
}
function localParent(ctx: Context, connector: Connector, binding: Binding, kind: 'operation' | 'block'): string {
  const parent = ctx.nodes.get(binding.producer.node)?.parent;
  if (ctx.graph.version !== 2 || connector.bindings.some(upper => upper.level < binding.level) || !parent
    || !binding.consumers.every(end => ctx.nodes.get(end.node)?.parent === parent))
    reject('neighbor_chain_broken', connector.id, 'local', 'Locality requires every endpoint to share its direct parent, with no upper binding');
  descriptor(ctx, parent, kind);
  return parent;
}
function physicalChain(ctx: Context, id: string): NeighborChain {
  const work = descriptor(ctx, id, 'work'), operationId = ctx.nodes.get(id)!.parent;
  if (!operationId) reject('neighbor_chain_broken', id, 'parent', 'A work requires its physical operation');
  const operation = descriptor(ctx, operationId, 'operation'), blockId = ctx.nodes.get(operationId)!.parent;
  if (!blockId) reject('neighbor_chain_broken', operationId, 'parent', 'An operation requires its physical block');
  return { work, operation, block: descriptor(ctx, blockId, 'block') };
}
function dataChains(ctx: Context, connector: Connector, binding: Binding, other: Endpoint, role: 'producer' | 'consumer'): NeighborChain[] {
  const work = descriptor(ctx, other.node, 'work');
  if (!connector.bindings.some(upper => upper.level < 3)) {
    const operation = localParent(ctx, connector, binding, 'operation'), block = ctx.nodes.get(operation)!.parent;
    if (!block) reject('neighbor_chain_broken', operation, 'parent', 'A local operation requires its physical block');
    return [{ work, operation: descriptor(ctx, operation, 'operation'), block: descriptor(ctx, block, 'block') }];
  }
  return upperAddresses(ctx, connector, binding, other, role).flatMap(operation => {
    const blocks = connector.bindings.some(upper => upper.level === 1)
      ? upperAddresses(ctx, connector, operation.binding, operation.endpoint, role).map(address => address.endpoint.node)
      : [localParent(ctx, connector, operation.binding, 'block')];
    return blocks.map(block => ({ work, operation: descriptor(ctx, operation.endpoint.node, 'operation'), block: descriptor(ctx, block, 'block') }));
  });
}
function artifactContract(ctx: Context, id: string, target: string): DataNeighbor['contract'] {
  const artifact = ctx.graph.artifacts.find(a => a.id === id), contract = ctx.graph.contracts.find(c => c.id === artifact?.contract);
  if (!artifact || !contract) reject('neighbor_contract_missing', target, 'artifact.contract', 'The artifact must name a known contract');
  return { id: contract.id, hash: hashJson(contract.schema), external: artifact.external };
}
function inputDelivery(ctx: Context, target: string, producer: string, external: boolean): Pick<DataNeighbor, 'delivery' | 'basis'> {
  if (ctx.graph.horizon.includes(producer)) return { delivery: 'in-plan' };
  if (external) return { delivery: 'external' };
  const basis = ctx.sources.receipts[canonical([target, producer])];
  return basis ? { delivery: 'available', basis } : { delivery: 'undelivered' };
}
function dataRows(ctx: Context, work: string): DataNeighbor[] {
  const rows: DataNeighbor[] = [];
  for (const connector of ctx.graph.connectors) for (const binding of connector.bindings.filter(b => b.level === 3)) {
    for (const consumer of binding.consumers) {
      if (binding.producer.node !== work && consumer.node !== work) continue;
      if (binding.producer.node === consumer.node) continue;
      const contract = artifactContract(ctx, connector.artifact, connector.id);
      if (!ctx.nodes.has(connector.returnsTo)) reject('neighbor_chain_broken', connector.id, 'returnsTo', 'The return address must name a graph node');
      const direction = binding.producer.node === work ? 'writes' : 'reads';
      const own = direction === 'writes' ? binding.producer : consumer, other = direction === 'writes' ? consumer : binding.producer;
      const ownCode = endpointCode(ctx, own, direction === 'writes' ? 'out' : 'in', contract.id);
      const otherCode = endpointCode(ctx, other, direction === 'writes' ? 'in' : 'out', contract.id);
      const role = direction === 'writes' ? 'consumer' : 'producer';
      for (const chain of dataChains(ctx, connector, binding, other, role)) {
        const row: DataNeighbor = { connector: connector.id, artifact: connector.artifact, contract, direction,
          port: own.port, codeRef: ownCode, neighbor: { ...chain, port: other.port, codeRef: otherCode },
          returnsTo: connector.returnsTo, delivery: 'undelivered' };
        if (direction === 'reads') Object.assign(row, inputDelivery(ctx, connector.id, other.node, contract.external));
        else if (ctx.graph.horizon.includes(other.node)) row.delivery = 'in-plan';
        else if (binding.anchor !== null) {
          // C4 proves mechanical derivation; this projection preserves its exact anchor, including local flows.
          const anchor = ctx.graph.anchors.find(a => a.id === binding.anchor);
          if (!anchor || anchor.owner !== work || anchor.outcome !== connector.artifact || !text(connector.wakeTest)
            || !ctx.graph.tests.some(t => t.id === connector.wakeTest) || !ctx.graph.tests.some(t => t.id === anchor.test))
            reject('neighbor_chain_broken', connector.id, 'anchor', 'Sleeping delivery requires the saved anchor and wake test');
          row.delivery = 'sleeping'; row.anchor = anchor.id; row.wakeTest = connector.wakeTest;
        }
        rows.push(row);
      }
    }
  }
  return rows;
}
function controlRows(ctx: Context, work: string): (RequiresNeighbor | OwnershipNeighbor)[] {
  const rows: (RequiresNeighbor | OwnershipNeighbor)[] = [];
  for (const predecessor of controlPredecessors(ctx.graph, work)) {
    const transfer = ctx.graph.transfers?.find(t => t.id === predecessor.id), neighbor = physicalChain(ctx, predecessor.producer);
    if (transfer) rows.push({ control: transfer.id, direction: 'receives', path: transfer.path, condition: transfer.condition,
      neighbor, ...inputDelivery(ctx, transfer.id, transfer.from, false) });
    else {
      const artifact = neighbor.work.outcome, contract = artifactContract(ctx, artifact, predecessor.id);
      rows.push({ control: predecessor.id, direction: 'requires', artifact, contract, neighbor,
        ...inputDelivery(ctx, predecessor.id, predecessor.producer, contract.external) });
    }
  }
  for (const transfer of ctx.graph.transfers?.filter(t => t.from === work) ?? []) rows.push({ control: transfer.id, direction: 'sends',
    path: transfer.path, condition: transfer.condition, neighbor: physicalChain(ctx, transfer.to),
    delivery: ctx.graph.horizon.includes(transfer.to) ? 'in-plan' : 'sleeping' });
  return rows;
}
function packet(ctx: Context, work: string): NeighborPacket {
  descriptor(ctx, work, 'work');
  const neighbors: Neighbor[] = [...dataRows(ctx, work), ...controlRows(ctx, work)].sort((a, b) => order(hashJson(a), hashJson(b)));
  return { work, neighbors, hash: hashJson(neighbors) };
}
/** Both gate checking and plan dispatch pass their exact graph and checked frame/delivery sources here. */
export function neighborsOf(graph: Graph, work: string, sources: NeighborSources): OmResult<Sealed<NeighborPacket>> {
  if (!text(work)) invalid('work');
  return result(() => packet(context(graph, sources), work));
}
export function buildPackets(graph: Graph, sources: NeighborSources): OmResult<Sealed<NeighborPacket[]>> {
  return result(() => { const ctx = context(graph, sources); return [...ctx.graph.horizon].sort(order).map(work => packet(ctx, work)); });
}

export interface NeighborCollection { contract: typeof NEIGHBOR_CONTRACT; project: string; source: DeliveryReadRequest; packets: NeighborPacket[] }
export interface NeighborReadRequest { project: string; neighbors: Ref }
export interface PreparedNeighbors {
  record: NeighborCollection; reference: Ref; existing: Revision<NeighborCollection> | null;
  references: Ref[]; guards: TransactionGuard[]; writes: Write[];
}
const collectionId = (value: Pick<NeighborCollection, 'contract' | 'project' | 'source'>) =>
  `om-neighbors:${value.project}:${hashJson({ contract: value.contract, source: value.source })}`;
function requireStore<Key extends 'candidate' | 'neighbors'>(store: Store, request: unknown, field: Key): asserts request is { project: string } & Record<Key, Ref> {
  if (!(store instanceof Store) || !object(request) || !text(request['project'])
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request['project']) || !isRef(request[field])) invalid(field);
}
function deriveCollection(store: Store, delivery: Sealed<DeliveryRead>): { value: NeighborCollection; references: Ref[] } {
  const first = delivery.findings[0];
  if (first) reject(first.code, first.target, 'delivery', first.message);
  const candidate = unwrap(readWorksFrame(store, delivery.request)), request = candidate.value.request.frame as FrameRequest;
  const works = unwrap(readFrame(store, request));
  if (!request.upper) reject('neighbor_chain_broken', delivery.request.candidate.id, 'upper', 'The works candidate requires its exact operation frame');
  const operations = unwrap(readFrame(store, { project: request.project, level: 2, graph: request.graph,
    horizon: request.horizon, layer: works.upperRef, frame: request.upper.frame, upper: null }));
  const fills2 = operations.accepted?.frame?.value.fills;
  if (!Array.isArray(fills2)) reject('neighbor_chain_broken', request.project, 'frames.operations.fills', 'The accepted operations require their recorded correspondence');
  const sources: NeighborSources = copy({ identity: [...new Set([...candidate.value.fills, ...fills2]
    .filter(f => f.source === 'identity').map(f => f.node))].sort(order), receipts: delivery.receipts,
    frames: { operations: { obligations: operations.result.obligations, fills: fills2 },
      works: { obligations: works.result.obligations, fills: candidate.value.fills } } }) as unknown as NeighborSources;
  const packets = unwrap(buildPackets(candidate.value.graph as Graph, sources));
  return { value: { contract: NEIGHBOR_CONTRACT, project: delivery.request.project, source: copy(delivery.request) as DeliveryReadRequest,
    packets: copy(packets) as NeighborPacket[] }, references: uniqueRefs([...delivery.references, ...works.references, ...operations.references]) };
}
function checkedRecord(store: Store, request: NeighborReadRequest): Revision<NeighborCollection> {
  requireStore(store, request, 'neighbors');
  const row = unwrap(readRecord<NeighborCollection>(store, request.neighbors, { unit: 'F7.3', target: request.neighbors.id,
    kind: 'om-neighbors', idPrefix: `om-neighbors:${request.project}:` }));
  // NR (№3600): a trusted read — the collection was derived from its exact saved deliveries once, by its producer.
  return row as Revision<NeighborCollection>;
}
/** Historical reading never discovers current delivery heads or admits new work. */
export function readNeighbors(store: Store, request: NeighborReadRequest): OmResult<Sealed<Revision<NeighborCollection>>> {
  return withHistoricalReads(() => result(() => checkedRecord(store, request)));
}
export function prepareNeighbors(store: Store, request: CandidateReadRequest): OmResult<Sealed<PreparedNeighbors>> {
  return withHistoricalReads(() => result(() => {
    requireStore(store, request, 'candidate');
    const delivery = unwrap(prepareDeliveries(store, request)), derived = deriveCollection(store, delivery);
    const id = collectionId(derived.value), head = store.get<NeighborCollection>(id);
    const existing = head ? checkedRecord(store, { project: request.project, neighbors: reference(head) }) : null;
    if (existing && !same(existing.value, derived.value)) reject('neighbor_record_forged', id, 'sources', 'The stored collection differs from its source derivation');
    const writes: Write[] = [...delivery.writes] as Write[];
    if (!existing) writes.push({ id, kind: 'om-neighbors', expected: 0, value: derived.value });
    return { record: derived.value, reference: existing ? reference(existing) : { id, revision: 1, hash: hashJson(derived.value) }, existing,
      references: derived.references, guards: uniqueTransactionGuards([...delivery.guards, ...(existing ? [reference(existing)] : [])]).sort((a,b) => order(canonical(a),canonical(b))), writes };
  }));
}
export function writeNeighbors(store: Store, request: CandidateReadRequest): OmResult<Sealed<Revision<NeighborCollection>>> {
  return withHistoricalReads(() => result(() => {
    const prepared = unwrap(prepareNeighbors(store, request));
    if (!prepared.writes.length && prepared.existing) return prepared.existing as Revision<NeighborCollection>;
    const rows = unwrap(writeGuarded<NeighborCollection>(store, { unit: 'F7.3', target: prepared.reference.id,
      writes: prepared.writes as Write[], guards: prepared.guards }));
    const saved = rows.find(row => row.id === prepared.reference.id);
    if (!saved) throw new EngineError('neighbor_internal_error', 'The packet transaction did not save its collection');
    return saved as Revision<NeighborCollection>;
  }));
}
