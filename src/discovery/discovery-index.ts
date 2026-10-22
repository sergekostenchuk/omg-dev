import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { IdentityMethod, Revision, Store } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { DISCOVERY_ACCEPTANCE_ACT_KIND, DISCOVERY_CLAIMS_CONTRACT, discoveryAcceptanceActId,
  type DiscoveryAcceptanceAct } from './v7-contracts.js';
import { provePlanQuestions, type V7PlanQuestion } from './v7-plan-questions.js';
import { resolveClaimAddress, type ClaimAddress } from './claim-address.js';
import { readV7ProgressStateAt } from './v7-progress.js';
import type { V7ProgressState } from './research-model.js';
import { coverageCellKey, decodeCoverageCell, type CoverageCell } from './coverage.js';

/** A Store event boundary, deliberately not P's {run,number} cursor. */
export interface DiscoveryIndexCursor { databaseId: string; sequence: number; tail: Ref | null }
export interface DiscoveryIndexScope { contract: 'discovery-index/v1'; databaseId: string; project: string; plan: Ref }
export interface DiscoveryIndexSource { sequence: number; record: Revision }
export interface DiscoveryIndexProvenance { from: Ref; to: Ref; path: string;
  availability: 'exact' | 'missing' | 'hash-mismatch' | 'foreign-project' }
export interface DiscoveryIndex {
  scope: DiscoveryIndexScope; cursor: DiscoveryIndexCursor; indexedThrough: number;
  /** Completeness of this event range ONLY. No dossier/coverage/acceptance decision. */
  rangeComplete: boolean;
  questions: V7PlanQuestion[];
  claims: { verification: 'structural'; address: ClaimAddress; value: Json }[];
  progress: { verification: 'application'; state: Ref; data: V7ProgressState }[];
  coverage: { complete: false; reason: 'deep-coverage-unavailable'; cells: {verification: 'structural'; source: Ref; cell: CoverageCell}[] };
  sources: DiscoveryIndexSource[];
  provenance: DiscoveryIndexProvenance[];
}
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function invalid(field: string, message: string): never {
  throw new EngineError('discovery_index_invalid', `[${field}] ${message}`, {field});
}
export function discoveryIndexCursor(store: Store): DiscoveryIndexCursor {
  const sequence = store.lastEvent();
  return {databaseId: store.databaseId, sequence, tail: store.eventAt(sequence)};
}
function cursorHolds(store: Store, cursor: DiscoveryIndexCursor): void {
  if (!object(cursor) || cursor.databaseId !== store.databaseId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0
    || (cursor.sequence === 0 ? cursor.tail !== null : !isRef(cursor.tail) || !same(store.eventAt(cursor.sequence), cursor.tail)))
    invalid('cursor', 'Expected this database identity and an exact committed event boundary');
}
/** Every common reader sees the SAME historical event boundary, including its head and
 * list requests. Exact future revisions are absent. This facade has no writing capability. */
function historicalView(store: Store, sequence: number): Store {
  const get = <T = Json>(id: string, revision?: number) => store.getAtEvent<T>(sequence, id, revision);
  const list = <T = Json>(kind?: string) => store.identitiesAtEvent(sequence, kind)
    .map(row => get<T>(row.id, row.revision)!);
  const history = <T = Json>(id: string) => store.identitiesAtEvent(sequence, undefined, id, true)
    .map(row => get<T>(row.id, row.revision)!);
  const identities = (method: IdentityMethod, id?: string, revision?: number) => {
    if (method === 'get') { const row = get(id!, revision); return row ? [referenceIdentity(row)] : []; }
    if (method === 'history') return store.identitiesAtEvent(sequence, undefined, id, true);
    return store.identitiesAtEvent(sequence, method === 'list' ? id : undefined)
      .filter(row => method !== 'prefix' || row.id.startsWith(id!));
  };
  const reads = {get, list, history, identities};
  // Opaque read projection: common historical readers deliberately keep their conservative
  // branch. It is never registered as a genuine Store and cannot reuse head-based proofs.
  return new Proxy(store, {get(_target, property) {
    if (Object.hasOwn(reads, property)) return reads[property as keyof typeof reads];
    if (property === 'path') return store.path;
    if (property === 'databaseId') return store.databaseId;
    return () => { throw new EngineError('store_view_method_unsupported',
      'The committed event view exposes only historical record reads', {method: String(property)}); };
  }});
}
function referenceIdentity(row: Revision) { return {id: row.id, revision: row.revision, hash: row.hash, kind: row.kind}; }
function exact<T>(view: Store, at: Ref, kind?: string): Revision<T> {
  const row = isRef(at) ? view.get<T>(at.id, at.revision) : null;
  if (!row || row.hash !== at.hash || (kind !== undefined && row.kind !== kind) || hashJson(row.value as Json) !== row.hash)
    invalid('source', 'The exact source is missing, substituted or later than the committed cursor');
  return row;
}
function planAt(view: Store, project: string, plan: Ref): {draft: Revision<DiscoveryDraft>; questions: V7PlanQuestion[]} {
  const answer = exact<Record<string, any>>(view, plan, 'research-answer');
  if (!object(answer.value) || answer.value.projectId !== project || typeof answer.value.question !== 'string')
    invalid('plan', 'The plan answer must belong to this project');
  const q = view.get<Question>(answer.value.question, 1);
  if (!q || q.kind !== 'question' || q.value.projectId !== project || q.value.spec.field !== 'plan')
    invalid('plan', 'The plan needs its own issued plan question');
  const act = view.get<DiscoveryAcceptanceAct>(discoveryAcceptanceActId(project, q.value.draftId, 'plan', plan));
  if (!act || act.kind !== DISCOVERY_ACCEPTANCE_ACT_KIND || !isRef(act.value.draftAfter))
    invalid('plan', 'The plan needs its saved exact acceptance');
  const draft = exact<DiscoveryDraft>(view, act.value.draftAfter, 'discovery-draft');
  return {draft, questions: provePlanQuestions(view, draft, plan)};
}
const KINDS = new Set(['question', 'discovery-draft', 'research-answer', 'research-attempt',
  'discovery-assessment', 'v7-progress-application', 'v7-progress-state', 'v7-attempt-account',
  'research-progress-event', 'discovery-coverage-cell', DISCOVERY_ACCEPTANCE_ACT_KIND]);
function selected(row: Revision, scope: DiscoveryIndexScope, draft: Revision<DiscoveryDraft>): boolean {
  if (!KINDS.has(row.kind) || !object(row.value)) return false;
  const v = row.value as Record<string, any>;
  if ((v.projectId ?? v.project ?? v.subject?.project ?? null) !== scope.project) return false;
  if (row.kind === 'discovery-draft') return row.id === draft.id;
  if (row.kind === 'question') return v.draftId === draft.id && draft.value.questions.includes(row.id);
  if (row.kind === 'research-answer') return draft.value.questions.includes(v.question);
  if (row.kind === DISCOVERY_ACCEPTANCE_ACT_KIND) return v.draftId === draft.id;
  if (row.kind === 'research-attempt') return same(v.planAnswer ?? null, scope.plan);
  if (row.kind === 'discovery-coverage-cell') return same(v.subject?.planAnswer ?? v.subject?.packet?.planAnswer ?? null, scope.plan);
  // Assessment packets and the P application/state/account/event all carry the exact subject.
  return same(v.subject?.planAnswer ?? v.subject?.packet?.planAnswer ?? null, scope.plan);
}
function references(value: unknown, path = ''): {path: string; ref: Ref}[] {
  if (isRef(value)) return [{path, ref: value}];
  if (!object(value) && !Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => references(child,
    `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
}

/** Advance at most maxEvents committed journal entries. Even an empty selected range advances
 * the cursor. Sequence gaps are lawful. Reopening resumes from the persisted cursor; a request
 * for an older boundary uses its original source revisions, never the later index head.
 * This is the index producer, not DRS2.2's proof of a consumer's requested basis. */
export function buildDiscoveryIndexAt(store: Store, project: string, plan: Ref, cursor: DiscoveryIndexCursor,
  options: {maxEvents?: number} = {}): DiscoveryIndex {
  cursorHolds(store, cursor);
  if (typeof project !== 'string' || !project.trim() || !isRef(plan)) invalid('scope', 'Expected project and exact plan');
  const maxEvents = options.maxEvents ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) invalid('maxEvents', 'Expected a positive safe integer');
  const scope: DiscoveryIndexScope = {contract: 'discovery-index/v1', databaseId: store.databaseId, project, plan};
  const key = digest(canonical(scope)), view = historicalView(store, cursor.sequence), provenPlan = planAt(view, project, plan);
  let saved = store.eventIndexRead(key, cursor.sequence, false);
  if (saved && saved.scope !== canonical(scope)) invalid('scope', 'The saved index belongs to another scope');
  const from = saved?.cursor ?? 0;
  if (from < cursor.sequence) {
    const events = store.eventsPage(from, cursor.sequence, maxEvents);
    const through = events.length === maxEvents ? events.at(-1)!.sequence : cursor.sequence;
    const rows = events.flatMap(event => {
      if (!KINDS.has(event.kind)) return [];
      const row = view.get(event.id, event.revision);
      if (!row || row.kind !== event.kind || hashJson(row.value) !== row.hash) invalid('source', 'A committed source disappeared or changed');
      return selected(row, scope, provenPlan.draft) ? [{sequence: event.sequence, value: {sequence: event.sequence, record: row}}] : [];
    });
    store.eventIndexWrite(scope, from, through, rows);
    saved = store.eventIndexRead(key, cursor.sequence, false)!;
  }
  const result: DiscoveryIndex = {scope, cursor: structuredClone(cursor), indexedThrough: saved?.cursor ?? 0,
    rangeComplete: (saved?.cursor ?? 0) >= cursor.sequence, questions: [], claims: [], progress: [],
    coverage: {complete: false, reason: 'deep-coverage-unavailable', cells: []}, sources: [], provenance: []};
  // A partial scan never masquerades as an empty complete projection.
  if (!result.rangeComplete) return result;
  saved = store.eventIndexRead(key, cursor.sequence);
  result.questions = provenPlan.questions;
  for (const stored of saved?.rows ?? []) {
    const source = JSON.parse(stored.body) as DiscoveryIndexSource;
    if (!object(source) || source.sequence !== stored.sequence || !object(source.record)) invalid('row', 'Malformed index row');
    const event = store.eventAt(stored.sequence), row = exact<Json>(view, reference(source.record), source.record.kind);
    if (!event || !same(event, reference(row)) || !same(row, source.record) || !selected(row, scope, provenPlan.draft))
      invalid('row', 'Index row does not match its exact scoped primary event');
    result.sources.push(source);
    for (const {path, ref} of references(row.value)) {
      const target = view.get<Record<string, any>>(ref.id, ref.revision);
      const owner = object(target?.value) ? target.value.projectId ?? target.value.project ?? target.value.subject?.project : undefined;
      result.provenance.push({from: reference(row), to: ref, path, availability: !target ? 'missing'
        : target.hash !== ref.hash || hashJson(target.value as Json) !== target.hash ? 'hash-mismatch' : owner !== undefined && owner !== project ? 'foreign-project' : 'exact'});
    }
    const v = row.value as Record<string, any>;
    const claims = row.kind === 'research-attempt' && v.end?.type === 'submitted' ? v.end.value?.claims
      : row.kind === 'research-answer' && v.contract === DISCOVERY_CLAIMS_CONTRACT ? v.value?.claims : undefined;
    if (Array.isArray(claims)) for (const [index, claim] of claims.entries()) {
      if (row.kind === 'research-answer' && (!Array.isArray(claim?.planQuestions)
        || !claim.planQuestions.some((q: Record<string, unknown>) => same(q.planAnswer ?? null, plan)))) continue;
      const address: ClaimAddress = {project, container: reference(row), containerKind: row.kind,
        pointer: `/claims/${index}`, claimId: claim?.id};
      const resolved = resolveClaimAddress(view, address);
      result.claims.push({verification: 'structural', address, value: resolved.claim});
    }
    if (row.kind === 'v7-progress-state') {
      const state = readV7ProgressStateAt(view, reference(row));
      result.progress.push({verification: 'application', state: reference(state), data: state.value});
    }
    if (row.kind === 'discovery-coverage-cell') {
      const cell = decodeCoverageCell(v);
      if (row.id !== coverageCellKey(cell)) invalid('coverage', 'A structural cell needs its canonical address');
      result.coverage.cells.push({verification: 'structural', source: reference(row), cell});
    }
  }
  return result;
}
