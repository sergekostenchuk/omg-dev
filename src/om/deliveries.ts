import { Ajv } from 'ajv';
import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import { requireCompatibleReceipt } from '../compiler/inputs.js';
import { receiptId, type ArtifactReceipt } from '../compiler/model.js';
import { writeGrants } from '../compiler/ownership.js';
import { controlPredecessors } from '../graph/dependencies.js';
import type { Graph } from '../graph/model.js';
import { RefinementRelations } from '../graph/relations.js';
import { graphSchema, graphV2Schema } from '../graph/schema.js';
import { selectWriter, type WriterProof } from '../ownership/owners.js';
import { prepareWriterIndex, readWriterIndex } from '../ownership/writer-index.js';
import type { ExecutionRoot } from '../runtime/environment.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type TransactionGuard, type Revision, type Write } from '../storage/store.js';
import type { CandidateReadRequest, CandidateRequest } from './frame-candidate.js';
import { readHorizon } from './horizon.js';
import { withHistoricalReads } from './input.js';
import { readRecord } from './refs.js';
import { delivered, refused, sealed, type OmResult, type Sealed } from './refusal.js';
import { prepareWorksFrame, readWorksFrame } from './works-frame.js';

export const DELIVERY_CODES = Object.freeze(['delivery_request_invalid', 'delivery_basis_unproven',
  'available_basis_missing', 'available_basis_unresolved', 'available_basis_stale', 'available_basis_mismatch',
  'available_basis_foreign', 'available_basis_ambiguous', 'ownership_predecessor_missing'] as const);
export type DeliveryBases = Record<string, Record<string, Ref>>;
/** Exact positive writer selections. A missing path does not prove that no writer existed. */
export type DeliveryWriterBasis = Record<string, Ref>;
export interface DeliveryFinding {
  code: string; target: string; producer: string; block: string; artifact: string;
  message: string; route: 'readiness';
}
export interface DeliveryCheck {
  /** Keys are canonical JSON pairs [connector/control-edge, producer], so colons in IDs cannot alias. */
  receipts: Record<string, Ref>; writers: DeliveryWriterBasis;
  findings: DeliveryFinding[]; references: Ref[]; guards: Ref[];
}
export interface DeliveryOptions {
  /** The compiler's confirmed writer provider (Owners.latest), not an artifact receipt. */
  owner: (path: string) => WriterProof | null;
}
export interface DeliveryInputOptions extends DeliveryOptions { identities: readonly string[]; current?: boolean }
export interface DeliveryOwnershipBasis {
  contract: 'delivery-ownership/v1'; root: Ref | null; indexes: Record<string, Ref>;
}
export interface DeliveryReadRequest extends CandidateReadRequest { ownership: DeliveryOwnershipBasis }
export interface DeliveryRead extends Omit<DeliveryCheck, 'guards'> { request: DeliveryReadRequest; writes: Write[]; guards: TransactionGuard[] }
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unique = <T>(refs: readonly T[]): T[] => [...new Map(refs.map(ref => [canonical(ref), ref])).values()]
  .sort((a, b) => order(canonical(a), canonical(b)));
const ajv = new Ajv({ strict: true, allowUnionTypes: true });
const shapes = [ajv.compile(sealed(graphSchema)), ajv.compile(sealed(graphV2Schema))];
function invalid(field: string): OmResult<never> {
  return refused('delivery_request_invalid', 'Delivery checking needs explicit, well-formed sources',
    { unit: 'F7.4', target: 'deliveries', field }, 'producer');
}

/** Pure graph boundary: the caller supplies its checked snapshot, M2 bases and confirmed writer provider.
 * Persisted callers use prepareDeliveries/readDeliveries so a graph or readiness claim cannot stand for C4/B2.
 * This checks compatibility only; resolveArtifact at M8 still proves execution and repository contents. */
export function checkDeliveries(store: Store, project: string, graph: Graph, bases: DeliveryBases,
  options: DeliveryInputOptions): OmResult<Sealed<DeliveryCheck>> {
  if (!(store instanceof Store) || !text(project)) return invalid('store/project');
  if (!object(graph) || !shapes[graph.version === 2 ? 1 : 0]!(graph)) return invalid('graph');
  if (!object(bases) || !Object.values(bases).every(map => object(map) && Object.values(map).every(isRef))) return invalid('bases');
  if (!object(options) || typeof options.owner !== 'function' || !Array.isArray(options.identities)
    || !options.identities.every(text) || (Object.hasOwn(options, 'current') && typeof options.current !== 'boolean')) return invalid('options');
  graph = sealed(graph) as unknown as Graph; bases = sealed(bases) as DeliveryBases;
  const current = options.current !== false, identities = new Set(options.identities);
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), active = new Set(graph.horizon);
  if (graph.horizon.some(id => nodes.get(id)?.kind !== 'work' || identities.has(id))
    || options.identities.some(id => nodes.get(id)?.kind !== 'work')) return invalid('works');
  if (graph.artifacts.some(artifact => !graph.contracts.some(contract => contract.id === artifact.contract))
    || graph.connectors.some(connector => !graph.artifacts.some(artifact => artifact.id === connector.artifact)
      || connector.bindings.some(binding => !nodes.has(binding.producer.node) || binding.consumers.some(end => !nodes.has(end.node))))
    || graph.horizon.some(id => controlPredecessors(graph, id).some(edge => !nodes.has(edge.producer)))) return invalid('graph.references');
  const relations = new RefinementRelations(graph), findings: DeliveryFinding[] = [], references: Ref[] = [], guards: Ref[] = [];
  const receipts: Record<string, Ref> = {}, named = new Map<string, Revision<ArtifactReceipt> | null>();
  const fail = (code: string, target: string, producer: string, block: string, artifact: string, message: string) => {
    findings.push({ code, target, producer, block, artifact, message, route: 'readiness' });
  };
  const real = (id: string) => nodes.get(id)?.kind === 'work' && !identities.has(id);
  const produces = (id: string, artifact: string) => nodes.get(id)?.outcome === artifact || graph.connectors.some(connector =>
    connector.artifact === artifact && connector.bindings.some(binding => binding.level === 3 && binding.producer.node === id));
  const compatible = (record: Revision<ArtifactReceipt>, producer: string, artifact: string): boolean => {
    if (!graph.artifacts.some(item => item.id === artifact) || !nodes.has(producer)) return false;
    try { requireCompatibleReceipt(record, project, graph, producer, artifact); return true; }
    catch (error) { if (error instanceof EngineError && error.code === 'producer_not_ready') return false; throw error; }
  };
  // Every named result is checked, even if no currently active edge consumes it.
  for (const [block, map] of Object.entries(bases)) for (const [artifact, ref] of Object.entries(map)) {
    const key = canonical([block, artifact]); named.set(key, null);
    const read = readRecord<ArtifactReceipt>(store, ref, { unit: 'F7.4', target: block, kind: 'artifact', id: receiptId(project, artifact) });
    if (!read.ok) { fail('available_basis_unresolved', block, '', block, artifact, 'The exact named artifact receipt cannot be resolved'); continue; }
    const record = read.value as Revision<ArtifactReceipt>; references.push(ref);
    if (!object(record.value)) { fail('available_basis_mismatch', block, '', block, artifact, 'The receipt has no compatible body'); continue; }
    const producer = record.value.node;
    if (nodes.get(block)?.kind !== 'block' || !text(producer) || !real(producer) || !relations.refines(producer, block) || !produces(producer, artifact)) {
      fail('available_basis_foreign', block, text(producer) ? producer : '', block, artifact, 'The named result must belong to a real work refining this block'); continue;
    }
    if (current) {
      const head = store.get(ref.id);
      if (!head || !same(reference(head), ref)) {
        fail('available_basis_stale', block, producer, block, artifact, 'M2 must name the same artifact revision that the compiler will read'); continue;
      }
      guards.push(ref);
    }
    if (!compatible(record, producer, artifact)) {
      fail('available_basis_mismatch', block, producer, block, artifact, 'The receipt does not match the compiler signature and result contract'); continue;
    }
    named.set(key, record);
  }
  const input = (target: string, producer: string, artifact: string) => {
    if (graph.artifacts.find(item => item.id === artifact)?.external) return;
    const blocks = relations.ancestry(producer).filter(node => node.kind === 'block').map(node => node.id).sort();
    const candidates = blocks.filter(block => Object.hasOwn(bases, block) && Object.hasOwn(bases[block]!, artifact));
    if (!candidates.length) { fail('available_basis_missing', target, producer, blocks.join(','), artifact, 'M2 has not named this producer result'); return; }
    const distinct = unique(candidates.map(block => bases[block]![artifact]!));
    if (distinct.length !== 1) { fail('available_basis_ambiguous', target, producer, candidates.join(','), artifact, 'Different named bases cannot be chosen by traversal order'); return; }
    const block = candidates[0]!, record = named.get(canonical([block, artifact]));
    if (!record) {
      // Retain the failing edge as well as the readiness block; several edges may share one invalid basis.
      const reason = findings.find(item => item.target === block && item.block === block && item.artifact === artifact);
      if (reason) fail(reason.code, target, producer, candidates.join(','), artifact, reason.message);
      return;
    }
    if (!real(producer) || !compatible(record, producer, artifact)) {
      fail('available_basis_mismatch', target, producer, candidates.join(','), artifact, 'The named receipt belongs to another producer or signature'); return;
    }
    receipts[canonical([target, producer])] = distinct[0]!;
  };
  for (const connector of graph.connectors) for (const binding of connector.bindings) {
    if (binding.level === 3 && !active.has(binding.producer.node) && binding.consumers.some(end => active.has(end.node)))
      input(connector.id, binding.producer.node, connector.artifact);
  }
  const ids = new Map(graph.horizon.map(id => [id, id]));
  const owners = new Map<string, WriterProof | null>();
  const owner = (path: string): WriterProof | null => {
    if (owners.has(path)) return owners.get(path)!;
    const proof = options.owner(path);
    if (proof !== null && (!object(proof) || !isRef(proof.ref) || !text(proof.node) || proof.path !== path
      || !object(proof.boundary))) throw new EngineError('delivery_request_invalid',
      'The writer provider must return an explicit null or an addressed proof for this exact path',
      { unit: 'F7.4', target: path, field: 'owner' });
    const captured = proof === null ? null : sealed(proof) as WriterProof;
    if (captured) { references.push(captured.ref); if (current) guards.push(captured.ref); }
    owners.set(path, captured); return captured;
  };
  for (const consumer of graph.horizon) {
    for (const edge of controlPredecessors(graph, consumer)) {
      if (graph.transfers?.some(transfer => transfer.id === edge.id) || active.has(edge.producer)) continue;
      input(edge.id, edge.producer, nodes.get(edge.producer)!.outcome);
    }
    // Check every write path independently so one bad predecessor cannot mislabel another transfer.
    const node = nodes.get(consumer)!;
    for (const path of [...new Set(node.code.filter(ref => ref.access === 'write').map(ref => ref.path))].sort(order)) {
      try {
        const grants = writeGrants(graph, { ...node, code: node.code.filter(ref => ref.path === path) }, ids, owner);
        for (const grant of grants) if (grant.receipt) {
          if (!isRef(grant.receipt)) return invalid('owner.ref');
          references.push(grant.receipt); if (current) guards.push(grant.receipt);
          if (grant.transfer && grant.from) receipts[canonical([grant.transfer, grant.from])] = grant.receipt;
        }
      } catch (error) {
        if (error instanceof EngineError && error.code === 'delivery_request_invalid') return invalid('owner');
        if (!(error instanceof EngineError) || !['ownership_boundary_changed', 'ownership_transfer_required', 'ownership_predecessor_missing',
          'ownership_proof_foreign', 'ownership_ambiguous', 'ownership_code_changed',
          'artifact_set_invalid', 'checks_not_passed', 'review_not_passed', 'task_obligation_plan_foreign',
          'task_obligation_proof_missing', 'task_obligation_proof_foreign', 'task_obligation_result_required'].includes(error.code)) throw error;
        const transfers = graph.transfers?.filter(transfer => transfer.to === consumer && transfer.path === path && !active.has(transfer.from)) ?? [];
        if (!transfers.length) fail('ownership_predecessor_missing', consumer, '', '', path, error.message);
        for (const transfer of transfers) fail('ownership_predecessor_missing', transfer.id, transfer.from,
          relations.ancestry(transfer.from).filter(node => node.kind === 'block').map(node => node.id).sort().join(','), transfer.path, error.message);
      }
    }
  }
  const writers = Object.fromEntries([...owners].filter((entry): entry is [string, WriterProof] => entry[1] !== null)
    .sort(([a], [b]) => order(a, b)).map(([path, proof]) => [path, proof.ref]));
  return delivered({ receipts, writers, findings: findings.sort((a, b) => order(canonical(a), canonical(b))), references: unique(references), guards: unique(guards) });
}

interface OwnershipSelection {
  basis: DeliveryOwnershipBasis; owner: (path: string) => WriterProof | null;
  writes: Write[]; references: Ref[]; guards: Ref[];
}
/** The saved index must be complete for this exact execution-root interval, for both positive and empty selections. */
function ownershipSources(store: Store, project: string, graph: Graph, basis?: DeliveryOwnershipBasis): OmResult<OwnershipSelection> {
  const current = basis === undefined;
  const paths = [...new Set(graph.nodes.filter(node => graph.horizon.includes(node.id))
    .flatMap(node => node.code.filter(code => code.access === 'write').map(code => code.path)))].sort(order);
  const bad = (target: string, field: string) => refused('delivery_basis_unproven',
    'Ownership needs the exact complete writer indexes and the accepted execution context', { unit: 'F7.4', target, field }, 'producer');
  if (!current && (!object(basis) || basis.contract !== 'delivery-ownership/v1'
    || !Object.hasOwn(basis, 'root') || (basis.root !== null && !isRef(basis.root)) || !object(basis.indexes)
    || !same(Object.keys(basis.indexes).sort(order), paths) || !Object.values(basis.indexes).every(isRef))) return bad(project, 'ownership');
  const rootId = `execution-root:${project}`;
  const rootRef = current ? (() => { const row = store.get(rootId); return row ? reference(row) : null; })() : basis!.root;
  let root: Revision<ExecutionRoot> | null = null;
  const references: Ref[] = [], guards: Ref[] = [], writes: Write[] = [];
  if (rootRef) {
    const read = readRecord<ExecutionRoot>(store, rootRef, { unit: 'F7.4', target: project, kind: 'execution-root', id: rootId });
    if (!read.ok) return read;
    root = read.value as Revision<ExecutionRoot>;
    if (!object(root.value) || root.value.projectId !== project || root.value.state !== 'ready'
      || !text(root.value.path) || !/^[a-f0-9]{40,64}$/.test(root.value.head)) return bad(rootId, 'root');
    references.push(rootRef); if (current) guards.push(rootRef);
  }
  const indexes = new Map<string, Ref>(), owners = new Map<string, WriterProof | null>();
  for (const path of paths) {
    try {
      const prepared = current ? prepareWriterIndex(store, project, path, rootRef) : null;
      const record = prepared ? prepared.record : readWriterIndex(store, project, path, basis!.indexes[path]!, rootRef);
      if (prepared) { writes.push(...prepared.writes); guards.push(...prepared.guards); }
      indexes.set(path, reference(record)); references.push(reference(record), ...record.value.writers);
      // Before the first execution root only a proven empty selection has a meaning.
      if (!root && record.value.writers.length) return bad(path, 'execution-root');
      owners.set(path, root ? selectWriter(store, project, { root: root.value.path, head: root.value.head }, record.value.writers, path) : null);
    } catch (error) {
      if (!(error instanceof EngineError) || (!error.code.startsWith('ownership_') && !error.code.startsWith('writer_index_')
        && !['artifact_set_invalid', 'checks_not_passed', 'review_not_passed'].includes(error.code)
        && !error.code.startsWith('task_obligation_'))) throw error;
      return refused(error.code, error.message, { unit: 'F7.4', target: path, field: 'ownership' }, 'readiness');
    }
  }
  return { ok: true, value: { basis: { contract: 'delivery-ownership/v1', root: rootRef, indexes: Object.fromEntries(indexes) },
    owner: path => owners.get(path) ?? null, writes, references, guards } };
}

function checked(store: Store, request: CandidateReadRequest | DeliveryReadRequest, current: boolean): OmResult<Sealed<DeliveryRead>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.candidate)) return invalid('candidate');
  if (!current) {
    const basis = (request as DeliveryReadRequest).ownership;
    if (!object(basis) || basis.contract !== 'delivery-ownership/v1' || !Object.hasOwn(basis, 'root')
      || (basis.root !== null && !isRef(basis.root)) || !object(basis.indexes) || !Object.values(basis.indexes).every(isRef))
      return refused('delivery_basis_unproven', 'Historical delivery checking requires its saved ownership basis',
        { unit: 'F7.4', target: request.candidate.id, field: 'ownership' }, 'producer');
  }
  const candidate = readWorksFrame(store, { project: request.project, candidate: request.candidate }); if (!candidate.ok) return candidate;
  const record = candidate.value, source = record.value, guards: TransactionGuard[] = [];
  const horizon = readHorizon(store, request.project, source.request.frame.horizon); if (!horizon.ok) return horizon;
  if (horizon.value.gate.value.state !== 'accepted') return refused('delivery_basis_unproven', 'Delivery bases require an accepted M2 horizon',
    { unit: 'F7.4', target: source.request.frame.horizon.id, field: 'horizon' }, 'readiness');
  const bases: DeliveryBases = Object.create(null) as DeliveryBases;
  const selection = horizon.value.horizon.value.result.horizon;
  for (const [block, execution] of Object.entries(selection.execution)) if (execution.state === 'available') bases[block] = structuredClone(execution.basis) as Record<string, Ref>;
  for (const boundary of selection.boundary) bases[boundary.block] = structuredClone(boundary.basis) as Record<string, Ref>;
  const ownership = ownershipSources(store, request.project, source.graph as Graph,
    current ? undefined : (request as DeliveryReadRequest).ownership);
  if (!ownership.ok) return ownership;
  const result = checkDeliveries(store, request.project, source.graph as Graph, bases, { owner: ownership.value.owner, current,
    identities: [...new Set(source.fills.filter(fill => fill.source === 'identity').map(fill => fill.node))] });
  if (!result.ok) return result;
  if (current) {
    const finding = result.value.findings[0];
    // A failed delivery is an addressed refusal, never a partial current admission with incomplete guards.
    if (finding) return refused(finding.code, finding.message, { unit: 'F7.4', target: finding.target,
      field: canonical({ producer: finding.producer, block: finding.block, artifact: finding.artifact }) }, 'readiness');
    const prepared = prepareWorksFrame(store, source.request as CandidateRequest); if (!prepared.ok) return prepared;
    if (prepared.value.state !== 'candidate' || !prepared.value.existing || prepared.value.writes.length
      || !same(reference(prepared.value.existing), request.candidate)) return refused('delivery_basis_unproven',
      'Current delivery checking must use exactly the saved, currently admitted candidate',
      { unit: 'F7.4', target: request.candidate.id, field: 'candidate' }, 'producer');
    guards.push(...prepared.value.guards, request.candidate);
  }
  return delivered({ ...result.value, request: { project: request.project, candidate: request.candidate, ownership: ownership.value.basis },
    writes: ownership.value.writes, references: unique([...result.value.references, ...ownership.value.references, request.candidate,
      reference(horizon.value.horizon), reference(horizon.value.gate)]), guards: unique([...result.value.guards, ...ownership.value.guards, ...guards]) });
}
export function prepareDeliveries(store: Store, request: CandidateReadRequest): OmResult<Sealed<DeliveryRead>> {
  return withHistoricalReads(() => checked(store, request, true));
}
/** Replays exact historical bases, with no writer/head discovery and no pending writes. */
export function readDeliveries(store: Store, request: DeliveryReadRequest): OmResult<Sealed<DeliveryRead>> {
  return withHistoricalReads(() => checked(store, request, false));
}
