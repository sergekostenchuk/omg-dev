import { HASH_RE, canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Connector, Node } from '../graph/model.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision } from '../storage/store.js';
import { withHistoricalReads } from '../history/proofs.js';
import { observeCandidate, readCandidate, type CandidateResult, type FrameCandidateRecord } from './frame-candidate.js';
import { readWorksFrame } from './works-frame.js';
import { readRecord } from './refs.js';
import { delivered, refused, sealed, type Refusal, type Sealed } from './refusal.js';

// 9.5 (№14392): the proven subject material of one exact OM block for the keeper. A saved frame candidate is the
// proven snapshot: observeCandidate checks its envelope, its source request, its base/proposal/works identity and
// its graph hash against the store. The package assembled here is what that snapshot says about the named block —
// the block itself, its whole operation/work subtree, the connections touching that subtree with both of their ends
// kept, and the exact source records the candidate's identity names, with contents. The caller picks the project,
// the candidate and the block address; it does not pick an inventory. A paid check and admission to acceptance are
// 9.2/9.3/9.4 business; this unit only reads.
export const BLOCK_SUBJECT_KIND = 'om-block-subject' as const;
export const BLOCK_SUBJECT_CONTRACT = 'om-block-subject/v1' as const;
/** Every refusal this unit can produce. The list is the checklist its test walks, so a new code cannot arrive untested. */
export const BLOCK_SUBJECT_REFUSAL_CODES = Object.freeze([
  'block_subject_missing', 'block_subject_mismatch',
] as const);
export type BlockSubjectRefusalCode = typeof BLOCK_SUBJECT_REFUSAL_CODES[number];

/** project + exact candidate Ref + block address. The candidate ref is what the caller already proved to hold. */
export interface BlockSubjectRequest { project: string; candidate: Ref; block: string }
/** The source records the saved candidate's identity names, each at its exact referenced revision — contents included. */
export interface BlockGrounds {
  graph: Revision<Json>; frame: Revision<Json> | null; proposals: Revision<Json>[];
  works: { producer: Revision<Json>; ledger: Revision<Json> } | null;
}
export interface BlockSubject {
  contract: typeof BLOCK_SUBJECT_CONTRACT;
  /** `om-block-subject:<project>:<sha256 of every other field>` — the identity of this exact composition. */
  subject: string; project: string; candidate: Ref; level: 2 | 3;
  /** The block node itself; members are the whole subtree below it — operations, and works at L3. */
  block: Node; members: Node[];
  /** Whole saved connectors: internal have every end inside the subtree, boundary keep both the inside and the outside end. */
  internal: Connector[]; boundary: Connector[]; grounds: BlockGrounds;
}

const PACKAGE_FIELDS = ['contract', 'subject', 'project', 'candidate', 'level', 'block', 'members',
  'internal', 'boundary', 'grounds'] as const;
const GROUND_FIELDS = ['graph', 'frame', 'proposals', 'works'] as const;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const isRevision = (value: unknown): boolean => object(value) && text(value['id']) && text(value['kind'])
  && Number.isSafeInteger(value['revision']) && (value['revision'] as number) >= 1
  && typeof value['hash'] === 'string' && HASH_RE.test(value['hash']) && 'value' in value;
class BlockSubjectFailure extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message); }
}
function invalid(field: string): never {
  throw new EngineError('block_subject_request_invalid', 'A block subject read needs explicit, well-formed inputs',
    { unit: '9.5', target: 'subject', field });
}
function invalidSubject(field: string): never {
  throw new EngineError('block_subject_invalid', 'A block subject is the closed proven form of one exact block',
    { unit: '9.5', target: 'subject', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function reject(code: BlockSubjectRefusalCode, target: string, field: string, message: string): never {
  const result = refused(code, message, { unit: '9.5', target, field }, 'producer');
  if (!result.ok) throw new BlockSubjectFailure(result.refusal);
  throw new EngineError('block_subject_internal_error', 'Refusal unexpectedly produced a value');
}
function take<V, R>(result: { readonly ok: true; readonly value: V } | { readonly ok: false; readonly refusal: R }): V {
  if (!result.ok) throw new BlockSubjectFailure(result.refusal as Refusal);
  return result.value;
}
function outcome<T>(action: () => T): CandidateResult<T> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) {
      if (error instanceof BlockSubjectFailure) return { ok: false, refusal: sealed(error.refusal) };
      throw error;
    }
  });
}
function requireStore(store: Store): void { if (!(store instanceof Store)) invalid('store'); }
function requireRequest(value: unknown): asserts value is BlockSubjectRequest {
  if (!object(value) || !text(value['project'])) invalid('project');
  if (!isRef(value['candidate'])) invalid('candidate');
  if (!text(value['block'])) invalid('block');
}

// The whole subtree below the block: a node belongs iff its parent chain reaches the block's id.
function subtree(nodes: readonly Node[], root: string): Set<string> {
  const inside = new Set<string>([root]);
  let open = [root];
  while (open.length) {
    const next: string[] = [];
    for (const node of nodes)
      if (node.parent !== null && inside.has(node.parent) && !inside.has(node.id)) { inside.add(node.id); next.push(node.id); }
    open = next;
  }
  return inside;
}
// Every node a connector ends on: producer and consumers of each binding, plus the saved return address. An end is
// kept whole — never trimmed to the side that happens to be inside the subtree.
function endpoints(connector: Connector): string[] {
  const ends = connector.bindings.flatMap(binding => [binding.producer.node, ...binding.consumers.map(consumer => consumer.node)]);
  if (typeof connector.returnsTo === 'string' && connector.returnsTo.length) ends.push(connector.returnsTo);
  return ends;
}
// A ground is read at the exact {id, revision, hash} the proven candidate names — heads are never consulted.
function ground(store: Store, ref: Ref, kind: string, id: string, exact: boolean): Revision<Json> {
  return take(readRecord<Json>(store, ref, exact
    ? { unit: '9.5', target: ref.id, id, kind }
    : { unit: '9.5', target: ref.id, idPrefix: id, kind })) as Revision<Json>;
}

function collect(store: Store, request: BlockSubjectRequest): BlockSubject {
  // The trusted read of the proven snapshot — its envelope, source request, identity fields and graph hash.
  const record = take(observeCandidate(store, request)).record as Revision<FrameCandidateRecord>;
  // The era's own read agrees the saved record is what the caller named — the works entry point requires L3.
  take((record.value.level === 3 ? readWorksFrame : readCandidate)(store, request));
  const value = record.value, graph = value.graph;
  const node = graph.nodes.find(item => item.id === request.block);
  if (!node || node.kind !== 'block')
    reject('block_subject_missing', request.block, 'block', node
      ? `The address names a ${node.kind}, not a block`
      : 'No node of the proven candidate carries this address');
  const block = node as Node;
  const inside = subtree(graph.nodes, block.id);
  const members = sorted(graph.nodes.filter(item => item.id !== block.id && inside.has(item.id)));
  const present = graph.connectors.filter(connector => endpoints(connector).some(id => inside.has(id)));
  const grounds: BlockGrounds = {
    graph: ground(store, value.base.graph, 'graph', `graph:${request.project}`, true),
    frame: value.base.frame === null ? null
      : ground(store, value.base.frame, 'connection-frame', `om-frame:${request.project}:`, false),
    proposals: value.proposals.map(ref => ground(store, ref, 'layer-proposal', `om-proposal:${request.project}:`, false)),
    works: value.level === 3
      ? { producer: ground(store, value.works!.producer, 'om-obligation-basis', `om-obligation-basis:${request.project}:`, false),
          ledger: ground(store, value.works!.ledger, 'om-obligations', `om-obligations:${request.project}:`, false) }
      : null,
  };
  const identity = { contract: BLOCK_SUBJECT_CONTRACT, project: request.project, candidate: request.candidate,
    level: value.level, block, members, grounds,
    internal: sorted(present.filter(connector => endpoints(connector).every(id => inside.has(id)))),
    boundary: sorted(present.filter(connector => endpoints(connector).some(id => !inside.has(id)))) };
  return { ...identity, subject: `${BLOCK_SUBJECT_KIND}:${request.project}:${hashJson(identity as unknown as Json)}` };
}

/**
 * The closed form of a package, checked at every field before any content is trusted. A truncated package, an extra
 * mark or a wrong shape is a defect of the presented value — reported at the offending field, never repaired.
 */
export function decodeBlockSubject(value: unknown): BlockSubject {
  if (!object(value)) invalidSubject('contract');
  if (value['contract'] !== BLOCK_SUBJECT_CONTRACT) invalidSubject('contract');
  for (const field of PACKAGE_FIELDS) if (!Object.hasOwn(value, field)) invalidSubject(field);
  for (const key of Object.keys(value)) if (!(PACKAGE_FIELDS as readonly string[]).includes(key)) invalidSubject(key);
  if (typeof value['subject'] !== 'string'
    || !new RegExp(`^${BLOCK_SUBJECT_KIND}:[^:]+:[0-9a-f]{64}$`).test(value['subject'])) invalidSubject('subject');
  if (!text(value['project'])) invalidSubject('project');
  if (!isRef(value['candidate'])) invalidSubject('candidate');
  if (value['level'] !== 2 && value['level'] !== 3) invalidSubject('level');
  if (!object(value['block']) || value['block']['kind'] !== 'block' || !text(value['block']['id'])) invalidSubject('block');
  if (!Array.isArray(value['members']) || !(value['members'] as unknown[]).every(member =>
      object(member) && text(member['id']) && (member['kind'] === 'operation' || member['kind'] === 'work'))) invalidSubject('members');
  for (const field of ['internal', 'boundary'] as const)
    if (!Array.isArray(value[field]) || !(value[field] as unknown[]).every(connector =>
        object(connector) && text(connector['id']) && Array.isArray(connector['bindings']))) invalidSubject(field);
  const grounds = value['grounds'];
  if (!object(grounds) || !GROUND_FIELDS.every(field => Object.hasOwn(grounds, field))
    || Object.keys(grounds).some(key => !(GROUND_FIELDS as readonly string[]).includes(key))) invalidSubject('grounds');
  if (!isRevision(grounds!['graph'])) invalidSubject('grounds.graph');
  if (grounds!['frame'] !== null && !isRevision(grounds!['frame'])) invalidSubject('grounds.frame');
  if (!Array.isArray(grounds!['proposals']) || !(grounds!['proposals'] as unknown[]).every(isRevision)) invalidSubject('grounds.proposals');
  const works = grounds!['works'];
  if (value['level'] === 3
    ? !(object(works) && Object.keys(works).length === 2 && isRevision(works['producer']) && isRevision(works['ledger']))
    : works !== null) invalidSubject('grounds.works');
  return value as unknown as BlockSubject;
}

/** The proven subject package of one block of one saved candidate. Read-only: nothing is written, nothing is paid. */
export function collectBlockSubject(store: Store, request: BlockSubjectRequest): CandidateResult<Sealed<BlockSubject>> {
  requireStore(store); requireRequest(request); request = copy(request);
  return outcome(() => collect(store, request));
}
/**
 * A presented package stands only if it is the closed form AND identical to what the proven snapshot now holds —
 * a truncated, substituted or stale package is refused at the field where it first differs, and the delivered value
 * is the proven package itself, not the presented one.
 */
export function checkBlockSubject(store: Store, request: BlockSubjectRequest, presented: unknown): CandidateResult<Sealed<BlockSubject>> {
  requireStore(store); requireRequest(request); request = copy(request);
  const decoded = decodeBlockSubject(presented);
  return outcome(() => {
    if (decoded.project !== request.project)
      reject('block_subject_mismatch', request.candidate.id, 'project', 'The package belongs to another project');
    if (!same(decoded.candidate, request.candidate))
      reject('block_subject_mismatch', request.candidate.id, 'candidate', 'The package was not collected from this candidate');
    if (decoded.block.id !== request.block)
      reject('block_subject_mismatch', request.block, 'block', 'The package belongs to another block');
    const collected = collect(store, request);
    for (const field of PACKAGE_FIELDS)
      if (!same(decoded[field], collected[field]))
        reject('block_subject_mismatch', request.block, field, `The presented package differs at ${field}`);
    return collected;
  });
}
