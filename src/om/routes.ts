import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { readRecord, writeGuarded } from './refs.js';
import { historicalRead, readOmInput, withHistoricalReads } from './input.js';
import { collectGaps, gateGaps, readGaps, prepareGaps, GAP_ROUTES as ROUTE_POLICY, type GapReadRequest, type Gap, type GapCollection, type GapKind,
  type GapMoment, type GapSources } from './gaps.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { applicableAnswerTask, prepareAnswerSearch, readAnswerSearch, readAnswerTaskBasis,
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
export interface RoutesRecord { grouping?: 'consumer-set-v1'; project: string; request: SavedRoutesRequest; searches: RouteSearch[];
  routes: RoutedGap[]; batches: RoutedBatch[]; refusals: Refusal[] }
export interface PreparedRoutes { record: Revision<RoutesRecord>; existing: boolean; writes: Write[]; guards: Ref[]; references: Ref[] }
export interface RoutesReadRequest { project: string; record: Ref }
export const ROUTES_KIND = 'route-result';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
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
function normalized(request: RoutesRequest): RoutesRequest {
  return copy({ ...request, tasks: sorted(request.tasks), gaps: { ...request.gaps, records: sorted(request.gaps.records) },
    catalog: { paths: sorted(request.catalog.paths), records: sorted(request.catalog.records) } });
}
function routeSources(store: Store, request: RoutesRequest, current: boolean) {
  const gaps = take(readGaps(store, request.gaps));
  if (gaps.sources.project !== request.project) fail('route_source_invalid', request.project, 'gaps', 'The D1 source belongs to another project');
  const input = take(readOmInput(store, request.project, gaps.sources.input));
  const guards: Ref[] = [], references: Ref[] = [gaps.sources.input, ...request.gaps.records];
  if (current) {
    const prepared = take(prepareGaps(store, gaps.sources as GapReadRequest['sources']));
    if (!same(prepared.collection, gaps.collection)) fail('route_source_invalid', request.project, 'gaps', 'D1 sources changed their full gap set');
    guards.push(...prepared.guards, gaps.sources.input, ...request.gaps.records);
    references.push(...prepared.references);
  }
  // The catalog only advertises exact readable addresses; it never establishes a question's answer.
  for (const ref of request.catalog.records) {
    const row = store.get(ref.id, ref.revision);
    if (!row) fail('record_missing', ref.id, 'catalog', 'A catalog address must resolve to a saved record');
    if (row.hash !== ref.hash) fail('record_forged', ref.id, 'hash', 'The catalog address has a forged content hash');
    if (current) guards.push(ref);
    references.push(ref);
  }
  const inventoryRef = input.value.input.inventory, refusals: Refusal[] = [];
  if (inventoryRef) {
    take(readRecord(store, inventoryRef, { unit: 'P1', target: inventoryRef.id, kind: 'repo-inventory', id: `repo-inventory:${request.project}` }));
    const refusal = refused('inventory_format_unsupported', 'P1 has not supplied a supported inventory contract',
      { unit: 'P1', target: inventoryRef.id, field: 'format', ref: inventoryRef }, 'producer');
    if (!refusal.ok) refusals.push(refusal.refusal);
    references.push(inventoryRef); if (current) guards.push(inventoryRef);
  }
  for (const ref of unique(guards)) head(store, ref);
  const tasks = new Map<string, ReturnType<typeof checkedTask>>(), writes: Write[] = [];
  function checkedTask(basis: AnswerTaskBasis) { return take(readAnswerTaskBasis(store, { project: request.project, task: basis, current })); }
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
  // The verified classification comes from D1; the record's claimed routes never select behavior.
  const routes = ROUTE_POLICY[gap.kind];
  return (gap.kind === 'repository-fact' ? routes[1] : routes[0]) as GapRoute;
}
function batchKind(gap: Gap): Pick<RouteBatch, 'model' | 'task' | 'kind' | 'node' | 'level'> | null {
  if (gap.kind === 'repository-fact' && gap.code !== 'inventory_missing')
    return { model: 'MC1', task: 'fact', kind: gap.kind, node: null, level: null };
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

type RouteGrouping = 'task-v1' | 'consumer-set-v1';
const CURRENT_GROUPING: RouteGrouping = 'consumer-set-v1';
function planVerifiedGaps(gaps: readonly Gap[], catalog: RouteCatalog, grouping: RouteGrouping): RoutePlan {
  const routes: PlannedRoute[] = [], groups = new Map<string, Omit<RouteBatch, 'id'>>();
  for (const gap of gaps) {
    const known = addresses(gap, catalog), route = fallback(gap);
    routes.push({ gap: gap.id, target: gap.target, field: gap.field, kind: gap.kind, route,
      state: gap.deferral ? 'deferred' : 'pending', moment: gap.moment, consumers: sorted(gap.consumers), addresses: known });
    if (gap.deferral) continue;
    const kind = batchKind(gap);
    if (!kind) continue;
    // Small questions share the complete consumer set; node expansion stays indivisible by consumers.
    const key = canonical({ ...kind, field: kind.task === 'input-field' ? gap.field : null,
      ...(grouping === 'consumer-set-v1' && kind.task !== 'node-expansion' ? { consumers: sorted(gap.consumers) } : {}) });
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
  return delivered(planVerifiedGaps(expected.gaps as Gap[], catalog, CURRENT_GROUPING));
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
function deriveRoutes(store: Store, request: RoutesRequest, current: boolean, grouping: RouteGrouping, history?: RouteSearch[]) {
  const source = routeSources(store, request, current), writes = [...source.writes], guards = [...source.guards], references = [...source.references];
  if (request.previous) {
    const previous = loadRoutes(store, { project: request.project, record: request.previous });
    references.push(reference(previous.record));
  }
  const answers = new Map<string, Ref>(), searches: RouteSearch[] = [];
  if (!current && (!Array.isArray(history) || history.length !== source.tasks.size))
    fail('route_record_invalid', request.project, 'searches', 'Historical routing must retain every fact search');
  for (const [gap, task] of source.tasks) {
    const old = history?.filter(item => item.gap === gap);
    if (!current && old?.length !== 1) fail('route_record_invalid', gap, 'searches', 'A fact requires one historical search basis');
    const preparedSearch = current
      ? take(prepareAnswerSearch(store, { project: request.project, target: task.gap.target, field: task.gap.field })) : null;
    const search = preparedSearch ?? take(readAnswerSearch(store, { project: request.project, record: old![0]!.index }));
    if (search.record.value.target !== task.gap.target || search.record.value.field !== task.gap.field)
      fail('route_record_invalid', gap, 'index', 'The answer index belongs to a different obligation');
    if (preparedSearch) { writes.push(...preparedSearch.writes); guards.push(...preparedSearch.guards); }
    references.push(...search.references, reference(search.record));
    const checks: RouteSearch['checks'] = [], matches: { record: Ref; key: string }[] = [];
    if (!current && !same(sorted(old![0]!.checks.map(check => check.answer)), sorted(search.answers)))
      fail('route_record_invalid', gap, 'checks', 'Historical search must check the full saved answer index');
    for (const answer of search.answers) {
      const basis = request.tasks.find(item => {
        const ref = 'record' in item ? item.record : { id: item.pending.id, revision: item.pending.expected + 1, hash: hashJson(item.pending.value) };
        return same(ref, reference(task.record));
      })!;
      const checked = take(applicableAnswerTask(store, { project: request.project, record: answer, task: basis, current,
        ...(!current ? { invalidation: old![0]!.checks.find(check => same(check.answer, answer))!.invalidation } : {}) }));
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
  const fallback = planVerifiedGaps(source.gaps.collection.gaps as Gap[], request.catalog, grouping);
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
  const value: RoutesRecord = { ...(grouping === 'consumer-set-v1' ? { grouping } : {}), project: request.project, request: source.request, searches: sorted(searches),
    routes: sorted(routes), batches: sorted(batches), refusals: sorted(source.refusals) };
  return { value, writes: mergedWrites(writes), guards: unique(guards), references: unique(references) };
}
function requireRead(store: Store, request: unknown): asserts request is RoutesReadRequest {
  requireStore(store);
  if (!object(request) || !text(request.project) || !isRef(request.record)) invalid('record');
}
function loadRoutes(store: Store, request: RoutesReadRequest) {
  return historicalRead(store, { reader: 'M6.route-result', project: request.project, ref: request.record }, () => {
    const record = take(readRecord<RoutesRecord>(store, request.record,
      { unit: 'M6', target: request.record.id, kind: ROUTES_KIND, idPrefix: `om-routes:${request.project}:` }));
    const value = record.value;
    if (!object(value) || value.project !== request.project || !object(value.request) || value.request.project !== request.project || !Array.isArray(value.request.tasks)
      || !value.request.tasks.every(isRef) || !Array.isArray(value.searches))
      fail('route_record_invalid', record.id, 'record', 'A route must retain its full source task and search grounds');
    let source: RoutesRequest;
    try { source = requestForHistory(copy(value.request) as SavedRoutesRequest); requireRequest(source); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'route_request_invalid') fail('route_record_invalid', record.id, 'request', 'The saved routing request is malformed');
      throw error;
    }
    for (const search of value.searches) if (!object(search) || !text(search.gap) || !isRef(search.index) || !Array.isArray(search.checks)
      || !search.checks.every(check => object(check) && isRef(check.answer) && (check.invalidation === null || object(check.invalidation))))
      fail('route_record_invalid', record.id, 'searches', 'Every historical search needs an exact index and explicit checks');
    if (Object.hasOwn(value, 'grouping') && value.grouping !== CURRENT_GROUPING)
      fail('route_record_invalid', record.id, 'grouping', 'The saved routing contract is unsupported');
    const grouping: RouteGrouping = Object.hasOwn(value, 'grouping') ? 'consumer-set-v1' : 'task-v1';
    const derived = deriveRoutes(store, normalized(source), false, grouping, value.searches as RouteSearch[]);
    if (record.revision !== 1 || record.id !== idOf(derived.value.request) || !same(value, derived.value))
      fail('route_record_invalid', record.id, 'content', 'Routing must be rederived from its exact saved sources and complete answer searches');
    return copy({ record: record as Revision<RoutesRecord>, references: unique([reference(record), ...derived.references]) });
  }, () => fail('route_record_invalid', request.record.id, 'history', 'Routing history contains a cycle'));
}
/** Historical repetition carries no new model admission. E2/G8 must prepare the current route before sending. */
export function readRoutes(store: Store, request: RoutesReadRequest): OmResult<Sealed<{ record: Revision<RoutesRecord>; references: Ref[] }>> {
  requireRead(store, request); request = copy(request);
  return outcome(() => loadRoutes(store, request));
}
/** Includes the task, index initialization, captured evidence and route in one guarded transaction. */
export function prepareRoutes(store: Store, request: RoutesRequest): OmResult<Sealed<PreparedRoutes>> {
  requireStore(store); requireRequest(request); request = normalized(request);
  return outcome(() => {
    const derived = deriveRoutes(store, request, true, CURRENT_GROUPING), id = idOf(derived.value.request), old = store.get<RoutesRecord>(id);
    if (old) {
      const checked = loadRoutes(store, { project: request.project, record: reference(old) });
      if (!same(checked.record.value, derived.value)) fail('route_stale', id, 'searches', 'This historical route no longer selects the current answer; prepare its successor explicitly');
    }
    const record: Revision<RoutesRecord> = { id, kind: ROUTES_KIND, revision: 1, hash: hashJson(derived.value), value: derived.value };
    const writes = mergedWrites([...derived.writes, ...(old ? [] : [{ id, kind: ROUTES_KIND, expected: 0, value: derived.value }])]);
    return { record, existing: old !== null, writes, guards: unique([...derived.guards, ...(old ? [reference(old)] : [])]), references: derived.references };
  });
}
/** A delivered request in the current era is idempotent after source changes; older eras require an explicit successor. */
export function writeRoutes(store: Store, request: RoutesRequest): OmResult<Sealed<Revision<RoutesRecord>>> {
  requireStore(store); requireRequest(request); request = normalized(request);
  return outcome(() => {
    const tasks = request.tasks.map(task => reference(take(readAnswerTaskBasis(store, { project: request.project, task, current: false })).record));
    const gaps = take(readGaps(store, request.gaps));
    const source: SavedRoutesRequest = { ...request, gaps: { sources: gaps.sources as GapReadRequest['sources'], records: sorted(request.gaps.records) },
      tasks: sorted(tasks) }, old = store.get<RoutesRecord>(idOf(source));
    if (old) {
      const checked = loadRoutes(store, { project: request.project, record: reference(old) }).record;
      if (checked.value.grouping !== CURRENT_GROUPING)
        fail('route_stale', old.id, 'grouping', 'The historical routing era needs an explicit successor before current use');
      return checked;
    }
    const prepared = take(prepareRoutes(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'M6', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record as Revision<RoutesRecord>;
  });
}
