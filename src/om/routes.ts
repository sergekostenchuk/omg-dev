import { canonical, canonicalSorted, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write, storeObserved } from '../storage/store.js';
import { provenStore } from '../storage/store-view.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { readRecord, writeGuarded } from './refs.js';
import { readCompletionWorkAt, checkCompletionDisposition } from './model-call.js';
import { completionWorkId, prepareSeriesLineAdmission, readCompletionBinding } from './series.js';
import { historicalRead, readOmInput, withHistoricalReads } from './input.js';
import { bypassRouteOf, collectGaps, gateGaps, readGaps, prepareCurrentGaps, GAP_ROUTES as ROUTE_POLICY, type GapReadRequest, type Gap, type GapCollection, type GapKind,
  type GapMoment, type GapSources } from './gaps.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { applicableAnswerTask, prepareAnswerSearch, readAnswerTaskBasis,
  type AnswerInvalidation, type AnswerTaskBasis } from './accepted-answer.js';

export { ROUTE_POLICY };
export const ROUTE_CODES = sealed(['route_request_invalid', 'answer_route_foreign', 'route_source_invalid', 'route_task_invalid',
  'route_task_missing', 'route_answer_ambiguous', 'route_record_invalid', 'route_stale', 'inventory_format_unsupported'] as const);
export type GapRoute = 'code' | 'research' | 'design' | 'owner' | 'environment' | 'task-result';
export interface RouteCatalog { paths: string[]; records: Ref[] }
export interface PlannedRoute {
  gap: string; target: string; field: string; kind: GapKind; route: GapRoute;
  state: 'pending' | 'deferred' | 'answered'; moment: GapMoment; consumers: string[]; addresses: RouteCatalog;
}
export interface RouteBatchItem {
  gap: string; target: string; field: string; consumers: string[]; addresses: RouteCatalog;
}
export interface RouteBatch {
  id: string; model: 'MC1' | 'MC2'; task: 'fact' | 'input-field' | 'node-expansion';
  kind: GapKind; node: string | null; level: 2 | 3 | null; items: RouteBatchItem[];
}
export interface RoutePlan { routes: PlannedRoute[]; batches: RouteBatch[] }

export interface RoutesRequest { project: string; gaps: GapReadRequest; tasks: AnswerTaskBasis[]; catalog: RouteCatalog; previous: Ref | null }
export interface SavedRoutesRequest extends Omit<RoutesRequest, 'tasks'> { tasks: Ref[] }
export interface RoutedGap extends PlannedRoute { input: Ref; record: Ref; task: Ref | null; answer: Ref | null }
export interface RoutedBatch extends Omit<RouteBatch, 'items'> { items: (RouteBatchItem & { record: Ref; task: Ref | null })[] }
export interface RouteSearch {
  gap: string; index: Ref; checks: { answer: Ref; invalidation: AnswerInvalidation | null }[];
}
export interface RoutesRecord { grouping: 'block-input-v1'; project: string; request: SavedRoutesRequest; searches: RouteSearch[];
  routes: RoutedGap[]; batches: RoutedBatch[]; refusals: Refusal[] }
export interface PreparedRoutes { record: Revision<RoutesRecord>; existing: boolean; writes: Write[]; guards: TransactionGuard[]; references: Ref[] }
export interface RoutesReadRequest { project: string; record: Ref }
export const ROUTES_KIND = 'route-result';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sorted = canonicalSorted;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const unique = <T>(values: readonly T[]): T[] => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
class RoutingFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(value: OmResult<T>): T { if (!value.ok) throw new RoutingFailure(value.refusal); return value.value; }
function fail(code: string, target: string, field: string, message: string): never {
  const failure = refused(code, message, { unit: 'M6', target, field }, 'producer');
  if (!failure.ok) throw new RoutingFailure(failure.refusal);
  throw new Error('Unreachable refusal');
}
function outcome<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof RoutingFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function invalid(field: string): never {
  throw new EngineError('route_request_invalid', 'Routing requires explicit source sets and address catalogs',
    { unit: 'M6', target: 'routes', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) {
    if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json');
    throw error;
  }
}
function requireCatalog(value: unknown): asserts value is RouteCatalog {
  if (!object(value) || !Array.isArray(value.paths) || !value.paths.every(text)
    || !Array.isArray(value.records) || !value.records.every(isRef)) invalid('catalog');
}
function requireStore(store: Store): void { if (!(store instanceof Store)) invalid('store'); }
function requireRequest(value: unknown): asserts value is RoutesRequest {
  if (!object(value) || !text(value.project) || !object(value.gaps) || !object(value.gaps.sources)
    || !Array.isArray(value.gaps.records) || !value.gaps.records.every(isRef) || !Array.isArray(value.tasks)
    || !(value.previous === null || isRef(value.previous))) invalid('request');
  requireCatalog(value.catalog);
  for (const basis of value.tasks) if (!object(basis) || !(isRef(basis.record) && Object.keys(basis).length === 1
    || object(basis.pending) && Object.keys(basis).length === 1 && text(basis.pending.id) && text(basis.pending.kind)
      && Number.isSafeInteger(basis.pending.expected) && Number(basis.pending.expected) >= 0 && Object.hasOwn(basis.pending, 'value'))) invalid('tasks');
}
function head(store: Store, ref: Ref): void {
  const latest = store.get(ref.id);
  if (!latest || !same(reference(latest), ref)) fail('input_stale', ref.id, 'reference', 'A routing source is no longer current');
}
function checkHeads(store: Store, guards: readonly TransactionGuard[]): void {
  const checked = uniqueTransactionGuards(guards);
  if (checked.length === 0) return;
  const source = provenStore(store);
  if (source !== null && !storeObserved(source)) {
    const match = source.headsMatch(checked);
    if (!match.ok) {
      const mismatch = match.mismatches[0];
      const id = mismatch?.id ?? checked[0]!.id;
      fail('input_stale', id, 'reference', 'A routing source is no longer current');
    }
    return;
  }
  for (const guard of checked) {
    const current = store.get(guard.id);
    const ok = 'absent' in guard ? current === null
      : current !== null && current.revision === guard.revision && current.hash === guard.hash;
    if (!ok) fail('input_stale', guard.id, 'reference', 'A routing source is no longer current');
  }
}
function normalized(request: RoutesRequest): RoutesRequest {
  return copy({ ...request, tasks: sorted(request.tasks), gaps: { ...request.gaps, records: sorted(request.gaps.records) },
    catalog: { paths: sorted(request.catalog.paths), records: sorted(request.catalog.records) } });
}
function routeSources(store: Store, request: RoutesRequest, currentTasks?: ReadonlySet<string>) {
  const gaps = take(readGaps(store, request.gaps));
  if (gaps.sources.project !== request.project) fail('route_source_invalid', request.project, 'gaps', 'The D1 source belongs to another project');
  const input = take(readOmInput(store, request.project, gaps.sources.input));
  const guards: TransactionGuard[] = [], references: Ref[] = [gaps.sources.input, ...request.gaps.records];
  const prepared = take(prepareCurrentGaps(store, request.gaps));
  guards.push(...prepared.guards, gaps.sources.input, ...request.gaps.records);
  references.push(...prepared.references);
  // The catalog only advertises exact readable addresses; it never establishes a question's answer.
  for (const ref of request.catalog.records) {
    const row = store.get(ref.id, ref.revision);
    if (!row) fail('record_missing', ref.id, 'catalog', 'A catalog address must resolve to a saved record');
    if (row.hash !== ref.hash) fail('record_forged', ref.id, 'hash', 'The catalog address has a forged content hash');
    guards.push(ref);
    references.push(ref);
  }
  const inventoryRef = input.value.input.inventory, refusals: Refusal[] = [];
  if (inventoryRef) {
    take(readRecord(store, inventoryRef, { unit: 'P1', target: inventoryRef.id, kind: 'repo-inventory', id: `repo-inventory:${request.project}` }));
    const refusal = refused('inventory_format_unsupported', 'P1 has not supplied a supported inventory contract',
      { unit: 'P1', target: inventoryRef.id, field: 'format', ref: inventoryRef }, 'producer');
    if (!refusal.ok) refusals.push(refusal.refusal);
    references.push(inventoryRef); guards.push(inventoryRef);
  }
  checkHeads(store, unique(guards));
  const tasks = new Map<string, ReturnType<typeof checkedTask>>(), writes: Write[] = [];
  function checkedTask(basis: AnswerTaskBasis) {
    const historical = take(readAnswerTaskBasis(store, { project: request.project, task: basis, current: false }));
    return !currentTasks || currentTasks.has(historical.gap.id)
      ? take(readAnswerTaskBasis(store, { project: request.project, task: basis, current: true })) : historical;
  }
  const needed = gaps.collection.gaps.filter(gap => gap.kind === 'repository-fact' && gap.code !== 'inventory_missing' && !gap.deferral);
  for (const basis of request.tasks) {
    const task = checkedTask(basis), gap = needed.find(gap => gap.id === task.gap.id);
    if (!gap || !same(task.request.input, gaps.sources.input) || !same(task.request.gaps.sources, gaps.sources)
      || !same(sorted(task.request.gaps.records), sorted(request.gaps.records)) || tasks.has(task.gap.id))
      fail('route_task_invalid', task.gap.target, 'task', 'Every task must name a distinct active gap in this exact complete D1 source');
    tasks.set(gap.id, task); guards.push(...task.guards); references.push(...task.references); writes.push(...task.writes);
  }
  for (const gap of needed) if (!tasks.has(gap.id))
    fail('route_task_missing', gap.target, 'task', 'E2 must supply the explicit current question task before M6 can choose a route');
  const saved: SavedRoutesRequest = { ...request, gaps: { sources: gaps.sources as GapReadRequest['sources'], records: sorted(request.gaps.records) },
    tasks: sorted([...tasks.values()].map(task => reference(task.record))) };
  return { gaps, input, tasks, request: saved, writes, guards: unique(guards), references: unique(references), refusals };
}
function requireCollection(value: unknown): asserts value is GapCollection {
  if (!object(value) || !Array.isArray(value.gaps) || !Array.isArray(value.refusals)) invalid('gaps');
  for (const gap of value.gaps) {
    if (!object(gap) || !text(gap.id) || !text(gap.target) || !text(gap.field) || !text(gap.code)
      || !text(gap.kind) || !text(gap.moment) || typeof gap.blocking !== 'boolean'
      || !Array.isArray(gap.routes) || !gap.routes.every(text)
      || !Array.isArray(gap.consumers) || !gap.consumers.every(text)
      || !Array.isArray(gap.origins) || !gap.origins.every(text) || !Array.isArray(gap.evidence)) invalid('gaps.item');
    for (const evidence of gap.evidence) if (!object(evidence) || !text(evidence.origin) || !text(evidence.target)
      || !(evidence.source === null || isRef(evidence.source)) || !Object.hasOwn(evidence, 'value')) invalid('gaps.evidence');
  }
}
function addresses(gap: Gap, catalog: RouteCatalog): RouteCatalog {
  return { paths: sorted(catalog.paths), records: sorted([...catalog.records,
    ...gap.evidence.flatMap(item => item.source ? [item.source] : [])]) };
}
function fallback(gap: Gap): GapRoute {
  if (gap.code === 'inventory_missing') return 'code';
  const bypass = bypassRouteOf(gap);
  if (bypass) return bypass;
  // The verified classification comes from D1; the record's claimed routes never select behavior.
  const routes = ROUTE_POLICY[gap.kind];
  return (gap.kind === 'repository-fact' ? routes[1] : routes[0]) as GapRoute;
}
function batchKind(gap: Gap): Pick<RouteBatch, 'model' | 'task' | 'kind' | 'node' | 'level'> | null {
  if (gap.kind === 'repository-fact' && gap.code !== 'inventory_missing')
    return { model: 'MC1', task: 'fact', kind: gap.kind, node: null, level: null };
  // OWN1: an owner question the pass needs now is asked of the model, like a design decision.
  if (bypassRouteOf(gap)) return { model: 'MC2', task: 'input-field', kind: gap.kind, node: null, level: null };
  if (gap.kind !== 'design-decision') return null;
  if (gap.code !== 'obligation_open')
    return { model: 'MC2', task: 'input-field', kind: gap.kind, node: null, level: null };
  const questions = gap.evidence.flatMap(item => {
    if (item.origin !== 'operations' && item.origin !== 'works') return [];
    const value = item.value;
    if (!object(value) || !object(value.question) || !text(value.question.upper)
      || (value.question.level !== 2 && value.question.level !== 3)) invalid('gaps.frame');
    return [{ node: value.question.upper, level: value.question.level as 2 | 3 }];
  });
  const first = questions[0];
  if (!first || questions.some(item => !same(item, first))) invalid('gaps.frame');
  return { model: 'MC2', task: 'node-expansion', kind: gap.kind, node: first.node, level: first.level };
}

// The block's own input fields, each a D3 decision of B1. Address is the M5 mechanism's and an answer is a decision of
// its own question (OWN1): both keep their field batches, so a block's input never waits on them (LP7, №3393 §2).
const BLOCK_INPUT_FIELDS: readonly string[] = Object.freeze(['nodes', 'state', 'checkKind']);
/** block-input-v1, the one routing era: the block's input fields of one complete consumer set are one batch. */
function planVerifiedGaps(gaps: readonly Gap[], catalog: RouteCatalog): RoutePlan {
  const routes: PlannedRoute[] = [], groups = new Map<string, Omit<RouteBatch, 'id'>>();
  for (const gap of gaps) {
    const known = addresses(gap, catalog), route = fallback(gap);
    routes.push({ gap: gap.id, target: gap.target, field: gap.field, kind: gap.kind, route,
      state: gap.deferral ? 'deferred' : 'pending', moment: gap.moment, consumers: sorted(gap.consumers), addresses: known });
    if (gap.deferral) continue;
    const kind = batchKind(gap);
    if (!kind) continue;
    // Small questions share the complete consumer set; node expansion stays indivisible by consumers. In block-input-v1
    // the block's input fields of one complete consumer set are one batch: one answer applies them as one B1 revision.
    const joined = kind.task === 'input-field' && BLOCK_INPUT_FIELDS.includes(gap.field);
    const key = canonical({ ...kind, field: kind.task === 'input-field' && !joined ? gap.field : null,
      ...(kind.task !== 'node-expansion' ? { consumers: sorted(gap.consumers) } : {}) });
    const batch = groups.get(key) ?? { ...kind, items: [] };
    batch.items.push({ gap: gap.id, target: gap.target, field: gap.field, consumers: sorted(gap.consumers), addresses: known });
    groups.set(key, batch);
  }
  const batches = [...groups.values()].map(group => {
    const value = { ...group, items: sorted(group.items) };
    return { id: hashJson(value), ...value };
  });
  return { routes: sorted(routes), batches: sorted(batches) };
}

/** Plan the fallback work for unanswered gaps. Catalog entries are addresses, never answers or admission to a model call. */
export function planGapRoutes(collection: GapCollection, sources: GapSources, catalog: RouteCatalog): OmResult<Sealed<RoutePlan>> {
  requireCollection(collection); requireCatalog(catalog);
  if (!object(sources)) invalid('sources');
  collection = copy(collection); sources = copy(sources); catalog = copy(catalog);
  const expected = collectGaps(sources);
  if (expected.refusals.length) return { ok: false, refusal: expected.refusals[0]! };
  const wanted = new Map(expected.gaps.map(gap => [gap.id, gap]));
  for (const gap of collection.gaps) {
    const fresh = wanted.get(gap.id);
    if (fresh && !same(sorted(gap.routes), sorted(fresh.routes))) return refused('answer_route_foreign',
      'The requested routes do not belong to the source-derived knowledge kind',
      { unit: 'M6', target: gap.target, field: 'routes' }, 'producer');
  }
  const checked = gateGaps(collection, sources);
  if (!checked.passed) return { ok: false, refusal: checked.findings[0]! };
  return delivered(planVerifiedGaps(expected.gaps as Gap[], catalog));
}

function mergedWrites(writes: readonly Write[]): Write[] {
  const all = new Map<string, Write>();
  for (const write of writes) {
    const old = all.get(write.id);
    if (old && !same(old, write)) fail('route_source_invalid', write.id, 'writes', 'The routing transaction has inconsistent prepared sources');
    all.set(write.id, write);
  }
  return sorted([...all.values()]);
}
function idOf(request: SavedRoutesRequest): string { return `om-routes:${request.project}:${hashJson(request)}`; }
function requestForHistory(request: SavedRoutesRequest): RoutesRequest {
  return { ...request, tasks: request.tasks.map(record => ({ record })) };
}
/** The same answer-selection rule serves full M6 production and one already-owned batch. */
function selectTaskAnswers(store: Store, request: RoutesRequest, tasks: ReturnType<typeof routeSources>['tasks']) {
  const writes: Write[] = [], guards: TransactionGuard[] = [], references: Ref[] = [];
  const answers = new Map<string, Ref>(), searches: RouteSearch[] = [];
  for (const [gap, task] of tasks) {
    const search = take(prepareAnswerSearch(store, { project: request.project, target: task.gap.target, field: task.gap.field }));
    if (search.record.value.target !== task.gap.target || search.record.value.field !== task.gap.field)
      fail('route_record_invalid', gap, 'index', 'The answer index belongs to a different obligation');
    writes.push(...search.writes); guards.push(...search.guards);
    references.push(...search.references, reference(search.record));
    const checks: RouteSearch['checks'] = [], matches: { record: Ref; key: string }[] = [];
    for (const answer of search.answers) {
      const basis = request.tasks.find(item => {
        const ref = 'record' in item ? item.record : { id: item.pending.id, revision: item.pending.expected + 1, hash: hashJson(item.pending.value) };
        return same(ref, reference(task.record));
      })!;
      const checked = take(applicableAnswerTask(store, { project: request.project, record: answer, task: basis, current: true }));
      writes.push(...checked.writes); guards.push(...checked.guards); references.push(...checked.references);
      checks.push({ answer, invalidation: checked.invalidation as AnswerInvalidation | null });
      if (checked.applicable) matches.push({ record: answer, key: checked.key });
    }
    if (new Set(matches.map(match => match.key)).size > 1)
      fail('route_answer_ambiguous', task.gap.target, 'answers', 'Different applicable facts require an explicit resolution; M6 cannot choose one by ordering');
    // Reconfirmations of one fact have the same result key. Keep the complete search evidence and use a stable exact representative.
    if (matches.length) answers.set(gap, sorted(matches.map(match => match.record))[0]!);
    searches.push({ gap, index: reference(search.record), checks: sorted(checks) });
  }
  return { answers, searches, writes, guards, references };
}
function deriveRoutes(store: Store, request: RoutesRequest) {
  const source = routeSources(store, request), writes = [...source.writes], guards = [...source.guards], references = [...source.references];
  if (request.previous) {
    const previous = loadRoutes(store, { project: request.project, record: request.previous });
    references.push(reference(previous.record));
  }
  const { answers, searches, ...selection } = selectTaskAnswers(store, request, source.tasks);
  writes.push(...selection.writes); guards.push(...selection.guards); references.push(...selection.references);
  const gaps = source.gaps.collection.gaps as Gap[], fallback = planVerifiedGaps(gaps, request.catalog);
  const recordFor = (gap: string): Ref => reference(source.gaps.records.find(record => record.value.gap.id === gap)!);
  const taskFor = (gap: string): Ref | null => source.tasks.has(gap) ? reference(source.tasks.get(gap)!.record) : null;
  const routes: RoutedGap[] = fallback.routes.map(route => ({ ...route, input: source.gaps.sources.input, record: recordFor(route.gap),
    task: taskFor(route.gap), answer: answers.get(route.gap) ?? null,
    ...(answers.has(route.gap) ? { route: 'code' as const, state: 'answered' as const } : {}) }));
  const batches: RoutedBatch[] = fallback.batches.flatMap(batch => {
    const items = batch.items.filter(item => !answers.has(item.gap)).map(item => ({ ...item, record: recordFor(item.gap), task: taskFor(item.gap) }));
    if (!items.length) return [];
    const { id: _id, ...body } = batch, normalized = { ...body, items: sorted(items) };
    return [{ id: hashJson(normalized), ...normalized }];
  });
  const value: RoutesRecord = { grouping: 'block-input-v1', project: request.project, request: source.request, searches: sorted(searches),
    routes: sorted(routes), batches: sorted(batches), refusals: sorted(source.refusals) };
  return { value, writes: mergedWrites(writes), guards: unique(guards), references: unique(references) };
}
function requireRead(store: Store, request: unknown): asserts request is RoutesReadRequest {
  requireStore(store);
  if (!object(request) || !text(request.project) || !isRef(request.record)) invalid('record');
}
/** NR1 (№3600): a trusted read — prepareRoutes wrote the routing derived by its saved algorithm from its exact sources. */
function loadRoutes(store: Store, request: RoutesReadRequest) {
  return historicalRead(store, { reader: 'M6.route-result', project: request.project, ref: request.record }, () => {
    const record = take(readRecord<RoutesRecord>(store, request.record,
      { unit: 'M6', target: request.record.id, kind: ROUTES_KIND, idPrefix: `om-routes:${request.project}:` }));
    // The one routing era is block-input-v1 (LG22): a saved record without it — the old task-v1 or consumer-set-v1, or
    // an unknown name — is a routing contract of another era and is never read as this one.
    if ((record.value as { grouping?: unknown }).grouping !== 'block-input-v1')
      fail('route_record_invalid', record.id, 'grouping', 'The saved routing contract is unsupported');
    return copy({ record: record as Revision<RoutesRecord>, references: [reference(record)] });
  }, () => fail('route_record_invalid', request.record.id, 'history', 'Routing cannot derive through itself'));
}
/** Historical repetition carries no new model admission. E2/G8 must prepare the current route before sending. */
export function readRoutes(store: Store, request: RoutesReadRequest): OmResult<Sealed<{ record: Revision<RoutesRecord>; references: Ref[] }>> {
  requireRead(store, request); request = copy(request);
  return outcome(() => loadRoutes(store, request));
}
/** Existing managed work keeps its immutable whole assignment while rechecking only its own searches.
 * The owner reader proves the initial complete M6 and full attempt goal; this is never an opening admission. */
export function prepareManagedRouteBatch(store: Store, request: {
  project: string; series: Ref; attempt: number; routes: Ref; batch: string;
}): OmResult<Sealed<{ record: Revision<RoutesRecord>; batch: RoutedBatch; writes: Write[]; guards: TransactionGuard[]; references: Ref[] }>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !isRef(request.series) || !isRef(request.routes)
    || !Number.isSafeInteger(request.attempt) || request.attempt < 1 || !text(request.batch)) invalid('managed');
  return outcome(() => {
    const binding = take(readCompletionBinding(store, request.project, request.series, request.attempt));
    if (!binding || !same(binding.value.plan.routes, request.routes) || !binding.value.plan.batches.includes(request.batch))
      fail('answer_route_foreign', request.routes.id, 'completion', 'The exact whole batch must belong to this proved managed attempt');
    const line = take(prepareSeriesLineAdmission(store, request.project, request.series));
    const attempt = line.series.value.attempts.find(row => row.ordinal === request.attempt);
    if (!attempt || attempt.outcome !== null || !same(attempt.goal, binding.value.goal))
      fail('answer_route_foreign', request.series.id, 'attempt', 'Current admission requires the same unfinished attempt and full original goal');
    const workHead = store.get(completionWorkId(request.project, binding.id));
    if (!workHead) fail('completion_invalid', binding.id, 'work', 'The current managed registry is mandatory');
    const work = take(readCompletionWorkAt(store, request.project, reference(workHead)));
    take(checkCompletionDisposition(store, work, { batch: request.batch, action: 'materialize' }));
    const historical = loadRoutes(store, { project: request.project, record: request.routes });
    const batch = historical.record.value.batches.find(row => row.id === request.batch)!;
    const sourceRequest = normalized(requestForHistory(historical.record.value.request));
    const targets = new Set(batch.items.map(item => item.gap));
    const source = routeSources(store, sourceRequest, targets);
    const selection = selectTaskAnswers(store, sourceRequest, new Map([...source.tasks].filter(([gap]) => targets.has(gap))));
    if (selection.answers.size)
      fail('route_stale', request.batch, 'searches', 'A target item now has an applicable answer; the original whole batch cannot be sent again');
    head(store, request.routes);
    return { record: historical.record, batch, writes: mergedWrites([...source.writes, ...selection.writes]),
      guards: unique([reference(binding), reference(workHead), request.routes, ...line.guards, ...source.guards, ...selection.guards]),
      references: unique([...historical.references, reference(binding), ...line.references, ...source.references, ...selection.references]) };
  });
}
/** Includes the task, index initialization, captured evidence and route in one guarded transaction. */
export function prepareRoutes(store: Store, request: RoutesRequest): OmResult<Sealed<PreparedRoutes>> {
  requireStore(store); requireRequest(request); request = normalized(request);
  return outcome(() => {
    // A saved block-input-v1 record stays current while its sources and searches are: a new code alone needs no
    // successor, so an issued assignment keeps its exact route (LP7, №3393 §3). A different derived plan is refused.
    const derived = deriveRoutes(store, request), id = idOf(derived.value.request), old = store.get<RoutesRecord>(id);
    if (old) {
      const checked = loadRoutes(store, { project: request.project, record: reference(old) });
      if (!same(checked.record.value, derived.value)) fail('route_stale', id, 'searches', 'This historical route no longer selects the current answer; prepare its successor explicitly');
    }
    const record: Revision<RoutesRecord> = { id, kind: ROUTES_KIND, revision: 1, hash: hashJson(derived.value), value: derived.value };
    const writes = mergedWrites([...derived.writes, ...(old ? [] : [{ id, kind: ROUTES_KIND, expected: 0, value: derived.value }])]);
    return { record, existing: old !== null, writes, guards: unique([...derived.guards, ...(old ? [reference(old)] : [])]), references: derived.references };
  });
}
/** A delivered request of the supported era is idempotent after source changes; another era requires an explicit successor. */
export function writeRoutes(store: Store, request: RoutesRequest): OmResult<Sealed<Revision<RoutesRecord>>> {
  requireStore(store); requireRequest(request); request = normalized(request);
  return outcome(() => {
    const tasks = request.tasks.map(task => reference(take(readAnswerTaskBasis(store, { project: request.project, task, current: false })).record));
    const gaps = take(readGaps(store, request.gaps));
    const source: SavedRoutesRequest = { ...request, gaps: { sources: gaps.sources as GapReadRequest['sources'], records: sorted(request.gaps.records) },
      tasks: sorted(tasks) }, old = store.get<RoutesRecord>(idOf(source));
    if (old) return loadRoutes(store, { project: request.project, record: reference(old) }).record;
    const prepared = take(prepareRoutes(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'M6', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record as Revision<RoutesRecord>;
  });
}
