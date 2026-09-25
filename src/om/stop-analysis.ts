import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { uniqueTransactionGuards, type Environment } from '../runtime/environment.js';
import { readCapacity } from './capacity.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, isPlainObject, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readAnySeriesAt, seriesRequestOf, prepareSeriesLineAdmission, prepareEscalateSeries,
  STOP_REVIEW_KIND, stopReviewNamespace, type AnyRepairSeries, type AttemptGoal } from './series.js';
import { stopReport, stopReportSources, readStopReport, type AnyStopReport, type StopReportSources } from './stop-report.js';
import { prepareLiftOriginHold, readOriginHoldAt, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace,
  REFUSAL_CLASSES, type RefusalClass } from './repeat-gate.js';
import { normalizeOriginSource, type OriginSource } from './refusal-journal.js';
import { recordCall, readCall, type AnyRecordCallRequest, type CallBasis, type DispatchContract } from './call-record.js';
import { adapterRequest, runModelTransport, readModelTransport, type ModelTransportOutcome } from './model-call.js';
import { withHistoricalReads } from './input.js';

export const STOP_ANALYSIS_CONTRACT = 'om-stop-analysis/v1';
export const STOP_ANALYSIS_FAILURE_KIND = 'om-stop-analysis-failure';
export const STOP_ANALYSIS_CODES = Object.freeze(['analysis_request_invalid', 'analysis_invalid', 'analysis_conflict',
  'analysis_response_invalid', 'assessor_not_independent', 'context_too_large'] as const);
export interface StopAnalysisRequest { project: string; series: Ref; hold: Ref | null; dispatch: DispatchContract }
export interface AnalysisCause { kind: 'evidence' | 'hypothesis'; text: string; sources: Ref[] }
export interface AnalysisChange { text: string; addresses: { ref: Ref; field: string }[] }
export interface AnalysisAnswer {
  protocol: 'omg-stop-analysis/v1'; cause: AnalysisCause | null; change: AnalysisChange | null;
  origin: { class: RefusalClass; basis: OriginSource[] } | null;
}
export interface AnalysisIntent {
  contract: typeof STOP_ANALYSIS_CONTRACT; request: StopAnalysisRequest;
  sources: StopReportSources; report: AnyStopReport; packet: Json; call: AnyRecordCallRequest;
}
export interface PreparedStopAnalysis { intent: AnalysisIntent; writes: Write[]; guards: TransactionGuard[] }
export interface AnalysisRecord {
  contract: typeof STOP_ANALYSIS_CONTRACT; projectId: string; intent: Ref; transport: Ref;
  state: 'decided' | 'undecided' | 'origin-established' | 'origin-unestablished' | 'failed';
  cause: AnalysisCause | null; change: AnalysisChange | null; error: Refusal | null;
  block?: string; owner?: { kind: 'mechanism'; mechanism: 'M5:addressing' };
  stop: number; goals: string[]; attempt: number; row: string | null;
  class: RefusalClass | null; basis: OriginSource[];
}
const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const keys = (value: object, expected: string[]) => same(Object.keys(value).sort(), [...expected].sort());
const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const copy = <T>(value: T): T => sealed(value) as T;
const uniqueRefs = (refs: readonly Ref[]): Ref[] => [...new Map(refs.map(ref => [canonical(ref), { id: ref.id, revision: ref.revision, hash: ref.hash }])).values()]
  .sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
class AnalysisFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new AnalysisFailure(result.refusal); return result.value; }
function fail(code: string, target: string, field: string, message: string): never {
  take(refused(code, message, { unit: 'A6', target, field }, 'producer')); throw new Error('Unreachable');
}
function result<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => { try { return delivered(action()); } catch (error) {
    if (error instanceof AnalysisFailure) return { ok: false, refusal: error.refusal }; throw error;
  } });
}
function requireRequest(store: Store, request: StopAnalysisRequest): void {
  if (!(store instanceof Store) || !object(request) || !keys(request, ['project', 'series', 'hold', 'dispatch'])
    || !text(request.project) || request.project.includes(':') || !isRef(request.series)
    || !(request.hold === null || isRef(request.hold)) || !object(request.dispatch)
    || !keys(request.dispatch, ['adapter', 'config']) || !isRef(request.dispatch.adapter) || !isRef(request.dispatch.config))
    throw new EngineError('analysis_request_invalid', 'Analysis needs a project, exact series, explicit hold or null and dispatch',
      { unit: 'A6', target: 'stop-analysis', field: 'request' });
}
function requireRead(store: Store, request: { project: string; record: Ref }): void {
  if (!(store instanceof Store) || !object(request) || !keys(request, ['project', 'record'])
    || !text(request.project) || request.project.includes(':') || !isRef(request.record))
    throw new EngineError('analysis_request_invalid', 'Analysis history needs its exact record and project',
      { unit: 'A6', target: 'stop-analysis', field: 'record' });
}
function seriesOf(store: Store, request: StopAnalysisRequest): Revision<AnyRepairSeries> {
  return take(readAnySeriesAt(store, request.project, request.series)) as Revision<AnyRepairSeries>;
}
function identity(store: Store, request: StopAnalysisRequest, series: AnyRepairSeries): string {
  if (request.hold !== null) return hashJson({ project: request.project, hold: request.hold });
  if (series.stop === null) fail('analysis_invalid', request.series.id, 'stop', 'An analysis needs a saved stop or an explicit hold');
  let origin = request.series, ancestor = series;
  while (ancestor.predecessor !== null) {
    const previous = take(readAnySeriesAt(store, request.project, ancestor.predecessor));
    if (previous.value.stop?.attempt !== series.stop.attempt) break;
    origin = ancestor.predecessor; ancestor = previous.value as AnyRepairSeries;
  }
  return hashJson({ project: request.project, series: origin.id, stop: series.stop.attempt });
}
const intentId = (project: string, key: string) => `om-analysis-intent:${project}:${key}`;
const failureId = (project: string, key: string) => `${STOP_ANALYSIS_FAILURE_KIND}:${project}:${key}`;
function groundId(request: StopAnalysisRequest, key: string): string {
  return `${request.hold === null ? stopReviewNamespace(request.project) : originAnalysisNamespace(request.project)}${key}`;
}
function declaredSources(report: AnyStopReport, request: StopAnalysisRequest): Ref[] {
  return uniqueRefs([...report.guards, request.dispatch.adapter, request.dispatch.config,
    ...report.obstacles.flatMap(row => [row.source, ...row.origin.sources.map(source => source.ref)]),
    ...report.remedies.flatMap(remedy => [...remedy.records])]);
}
const form = sealed({ protocol: 'omg-stop-analysis/v1', cause: 'null or {kind:evidence|hypothesis,text,sources:Ref[]}; evidence needs sources',
  change: 'null or {text,addresses:[{ref,field}]}', origin: 'null or {class,basis:OriginSource[]}; only origin analysis',
  rule: 'Diagnose this saved stop. State uncertainty explicitly. A proposal changes no graph, input or readiness.' });
function deriveIntent(store: Store, request: StopAnalysisRequest, report: AnyStopReport): AnalysisIntent {
  const series = seriesOf(store, request), key = identity(store, request, series.value), id = intentId(request.project, key);
  if (report.project !== request.project || report.series !== request.series.id
    || !report.guards.some(ref => same(ref, request.series))) fail('analysis_invalid', id, 'report', 'The report must name the exact saved series');
  const hold = request.hold === null ? null : report.context.holds.find(item => same(item.hold, request.hold));
  if (request.hold !== null && !hold) fail('analysis_invalid', id, 'hold', 'The report must contain the exact standing hold');
  const attempt = hold?.attempt ?? series.value.stop?.attempt;
  if (attempt === undefined || (request.hold === null && (report.rung !== 1 || report.context.stop === null)))
    fail('analysis_invalid', id, 'stop', 'Only a saved first-rung stop admits its independent review');
  const purpose: 'stop-analysis' | 'origin-analysis' = request.hold === null ? 'stop-analysis' : 'origin-analysis';
  const basis: CallBasis = hold ? { kind: 'origin-hold', hold: hold.hold }
    : { kind: 'series-stop', series: request.series, attempt };
  const goal: AttemptGoal = { key: `A6:${key}`, questions: report.context.goals.map(goal => goal.key).sort(),
    result: 'A cause with evidence or an explicit hypothesis and an addressed change for this saved ground' };
  if (goal.questions.length === 0) fail('analysis_invalid', id, 'goals', 'A stop analysis needs the goals of its saved context');
  const sources = declaredSources(report, request);
  const environment = take(readRecord<Environment>(store, request.dispatch.config,
    { unit: 'A6', target: id, id: `environment:${request.project}`, kind: 'environment' }));
  const env = environment.value;
  if (!object(env) || env.projectId !== request.project || !object(env.implementer) || !object(env.reviewer)
    || !text(env.implementer.actor) || !text(env.reviewer.actor)) fail('analysis_invalid', id, 'dispatch', 'Both environment roles must name their actors');
  if (env.implementer.actor === env.reviewer.actor)
    fail('assessor_not_independent', request.dispatch.config.id, 'reviewer.actor', 'The reviewer must be a different actor from the implementer');
  take(readRecord(store, request.dispatch.adapter, { unit: 'A6', target: id, id: request.dispatch.adapter.id, kind: 'dispatch-adapter' }));
  const packet = json({ contract: STOP_ANALYSIS_CONTRACT, purpose, basis, goal, report, sources, form });
  const callKey = `A6:${key}`;
  const wire = take(adapterRequest({ requestId: callKey, packet, model: env.reviewer.model, effort: env.reviewer.effort,
    ...(env.reviewer.speed === undefined ? {} : { speed: env.reviewer.speed }) }));
  const capacity = take(readCapacity(store, { project: request.project, environment: request.dispatch.config, current: false }));
  if (canonical(wire).length > capacity.maxRequestChars)
    fail('context_too_large', id, 'packet', 'The complete reviewer request exceeds the saved technical capacity');
  const common = { call: callKey, purpose, basis, series: request.series, attempt, goal, dispatch: request.dispatch, packet };
  const gap = { id: request.hold?.id ?? request.series.id, goal: goal.key, field: request.hold === null ? 'stop' : 'origin' };
  let call: AnyRecordCallRequest;
  if ('owner' in series.value) {
    const admitted = series.value.admissions.find(item => item.attempt === attempt);
    if (!admitted) fail('analysis_invalid', id, 'admission', 'The mechanism attempt must retain its exact admission');
    call = { ...common, owner: series.value.owner, admission: admitted.basis, gaps: [{ ...gap, consumer: series.value.owner }] };
  } else call = { ...common, block: series.value.block, gaps: [{ ...gap, consumer: 'A6:stop-analysis' }] };
  return copy({ contract: STOP_ANALYSIS_CONTRACT, request, sources: stopReportSources(report), report, packet, call });
}
function readIntent(store: Store, project: string, ref: Ref): Revision<AnalysisIntent> {
  const record = take(readRecord<AnalysisIntent>(store, ref, { unit: 'A6', target: ref.id,
    idPrefix: `om-analysis-intent:${project}:`, kind: 'om-analysis-intent' }));
  const saved = record.value;
  if (!object(saved) || !keys(saved, ['contract', 'request', 'sources', 'report', 'packet', 'call'])
    || saved.contract !== STOP_ANALYSIS_CONTRACT || !object(saved.sources))
    fail('analysis_invalid', ref.id, 'intent', 'An analysis intent must retain its producer and complete exact sources');
  requireRequest(store, saved.request as StopAnalysisRequest);
  if (saved.request.project !== project) fail('analysis_invalid', ref.id, 'project', 'An intent belongs to its project');
  const report = take(readStopReport(store, { project, sources: saved.sources })) as AnyStopReport;
  const derived = deriveIntent(store, saved.request as StopAnalysisRequest, report);
  if (record.id !== intentId(project, identity(store, derived.request, seriesOf(store, derived.request).value))
    || record.revision !== 1 || !same(derived, saved)) fail('analysis_invalid', ref.id, 'intent', 'The exact sources do not reproduce this intent');
  return record as Revision<AnalysisIntent>;
}
function originalGuards(intent: AnalysisIntent): TransactionGuard[] {
  return uniqueTransactionGuards([...intent.report.guards, intent.request.dispatch.config, intent.request.dispatch.adapter]);
}
export function prepareStopAnalysis(store: Store, request: StopAnalysisRequest): OmResult<Sealed<PreparedStopAnalysis>> {
  requireRequest(store, request);
  return result(() => {
    const source = seriesOf(store, request), key = identity(store, request, source.value), id = intentId(request.project, key);
    const existing = store.get<AnalysisIntent>(id);
    if (existing) {
      const saved = readIntent(store, request.project, reference(existing));
      if (!same(saved.value.request, request)) fail('analysis_conflict', id, 'request', 'This saved ground already has its fixed analysis request');
      return { intent: saved.value, writes: [], guards: originalGuards(saved.value) };
    }
    take(prepareSeriesLineAdmission(store, request.project, request.series));
    const report = take(stopReport(store, seriesRequestOf(source.value))) as AnyStopReport;
    const intent = deriveIntent(store, request, report);
    return { intent, writes: [{ id, kind: 'om-analysis-intent', expected: 0, value: json(intent) }], guards: originalGuards(intent) };
  });
}
function responseError(target: string, field: string, message: string): Refusal {
  const error = refused('analysis_response_invalid', message, { unit: 'A6', target, field }, 'producer');
  if (error.ok) throw new Error('Unreachable'); return error.refusal;
}
function parseAnswer(intent: AnalysisIntent, raw: string): OmResult<Sealed<AnalysisAnswer>> {
  const target = intent.request.series.id;
  let answer: unknown;
  try { answer = JSON.parse(raw); } catch { return { ok: false, refusal: responseError(target, 'response', 'The reviewer response must be JSON') }; }
  const bad = (field: string) => ({ ok: false as const, refusal: responseError(target, field, 'The review must retain the explicit cause, addressed change and origin form') });
  if (!object(answer) || !keys(answer, ['protocol', 'cause', 'change', 'origin']) || answer.protocol !== 'omg-stop-analysis/v1') return bad('response');
  const refs = declaredSources(intent.report, intent.request), allowed = (ref: unknown): ref is Ref => isRef(ref) && refs.some(source => same(source, ref));
  const cause = answer.cause, change = answer.change, origin = answer.origin;
  if (cause !== null && (!object(cause) || !keys(cause, ['kind', 'text', 'sources']) || !['evidence', 'hypothesis'].includes(cause.kind as string)
    || !text(cause.text) || !Array.isArray(cause.sources) || !cause.sources.every(allowed)
    || (cause.kind === 'evidence' && cause.sources.length === 0))) return bad('cause');
  if (change !== null && (!object(change) || !keys(change, ['text', 'addresses']) || !text(change.text)
    || !Array.isArray(change.addresses) || change.addresses.length === 0 || !change.addresses.every(address => object(address)
      && keys(address, ['ref', 'field']) && allowed(address.ref) && text(address.field)))) return bad('change');
  if (intent.request.hold === null && origin !== null) return bad('origin');
  if (origin !== null) {
    if (!object(origin) || !keys(origin, ['class', 'basis']) || !REFUSAL_CLASSES.includes(origin.class as RefusalClass)
      || !Array.isArray(origin.basis) || (origin.class !== 'unknown' && origin.basis.length === 0)) return bad('origin');
    try { for (const source of origin.basis) normalizeOriginSource(source); }
    catch (error) { if (error instanceof EngineError) return bad('origin.basis'); throw error; }
    // Map sources are validated by G7's observing readers. Environment sources must belong to this dispatch.
    if (origin.basis.some(source => source.role === 'environment' && !same(source.ref, intent.request.dispatch.config))) return bad('origin.basis');
  }
  const parsed = answer as unknown as AnalysisAnswer;
  return delivered({ ...parsed,
    cause: parsed.cause === null ? null : { ...parsed.cause, sources: [...parsed.cause.sources].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) },
    change: parsed.change === null ? null : { ...parsed.change, addresses: [...parsed.change.addresses].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) },
    origin: parsed.origin === null ? null : { ...parsed.origin, basis: parsed.origin.basis.map(normalizeOriginSource)
      .sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) } });
}
function deriveRecord(intent: Revision<AnalysisIntent>, physical: Sealed<ModelTransportOutcome>): AnalysisRecord {
  const value = intent.value, request = value.request, report = value.report;
  const parsed = physical.result.kind === 'answered' ? parseAnswer(value, physical.result.raw)
    : refused(physical.result.error.code, physical.result.error.message,
      { unit: 'A6', target: request.series.id, field: physical.result.error.field }, 'producer');
  const answer = parsed.ok ? parsed.value as AnalysisAnswer : null;
  const holding = request.hold === null ? null : report.context.holds.find(hold => same(hold.hold, request.hold))!;
  const state = answer === null ? 'failed' : holding !== null
    ? answer.origin === null || answer.origin.class === 'unknown' ? 'origin-unestablished' : 'origin-established'
    : answer.cause === null || answer.change === null ? 'undecided' : 'decided';
  return copy({ contract: STOP_ANALYSIS_CONTRACT, projectId: request.project, intent: reference(intent), transport: reference(physical.record),
    state, cause: answer?.cause ?? null, change: answer?.change ?? null, error: parsed.ok ? null : parsed.refusal,
    ...('owner' in report ? { owner: report.owner } : { block: report.block }),
    stop: report.context.stop?.attempt ?? holding!.attempt, goals: [...(report.context.stop?.goals ?? report.context.goals.map(goal => goal.key))].sort(),
    attempt: value.call.attempt, row: holding?.row ?? null,
    class: answer?.origin?.class ?? null, basis: answer?.origin?.basis ?? [] });
}
function resultAddress(intent: AnalysisIntent, body: AnalysisRecord, key: string): { id: string; kind: string } {
  return body.state === 'failed' ? { id: failureId(intent.request.project, key), kind: STOP_ANALYSIS_FAILURE_KIND }
    : { id: groundId(intent.request, key), kind: intent.request.hold === null ? STOP_REVIEW_KIND : ORIGIN_ANALYSIS_KIND };
}
export function readStopAnalysis(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<Revision<AnalysisRecord>>> {
  requireRead(store, request);
  return result(() => {
    const { project, record: ref } = request;
    const namespaces = [stopReviewNamespace(project), originAnalysisNamespace(project), `${STOP_ANALYSIS_FAILURE_KIND}:${project}:`];
    const kind = [STOP_REVIEW_KIND, ORIGIN_ANALYSIS_KIND, STOP_ANALYSIS_FAILURE_KIND][namespaces.findIndex(prefix => ref.id.startsWith(prefix))];
    if (!kind) fail('analysis_invalid', ref.id, 'id', 'This is not an analysis result address of the named project');
    const saved = take(readRecord<AnalysisRecord>(store, ref, { unit: 'A6', target: ref.id, id: ref.id, kind }));
    const body = saved.value;
    if (!object(body) || body.contract !== STOP_ANALYSIS_CONTRACT || !isRef(body.intent) || !isRef(body.transport))
      fail('analysis_invalid', ref.id, 'contract', 'An A6 result must name its intent and physical response');
    const intent = readIntent(store, project, body.intent);
    const history = intent.value.sources.journal === null ? undefined : { journal: intent.value.sources.journal };
    const physical = take(readModelTransport(store, { project, record: body.transport }, history));
    const original = take(readCall(store, project, physical.record.value.transport.request.call, history));
    const expectedCall = { ...intent.value.call, projectId: project, packet: { hash: hashJson(intent.value.packet),
      chars: canonical(intent.value.packet).length, bytes: Buffer.byteLength(canonical(intent.value.packet)) } };
    const actualCall = Object.fromEntries(Object.keys(expectedCall).map(key => [key, (original.value as unknown as Record<string, unknown>)[key]]));
    if (!same(actualCall, expectedCall) || !same(physical.record.value.transport.request.packet, intent.value.packet)
      || physical.record.value.transport.request.role !== 'reviewer')
      fail('analysis_invalid', ref.id, 'transport', 'The physical response must belong to this exact reviewer request');
    const derived = deriveRecord(intent, physical), key = identity(store, intent.value.request, seriesOf(store, intent.value.request).value);
    const address = resultAddress(intent.value, derived, key);
    if (saved.id !== address.id || saved.kind !== address.kind || saved.revision !== 1 || !same(body, derived))
      fail('analysis_invalid', ref.id, 'result', 'The physical response and fixed context do not reproduce the saved analysis');
    if (derived.state === 'origin-established') {
      const before = intent.value.request.hold!;
      const after = store.get(before.id, before.revision + 1);
      if (!after) fail('analysis_invalid', ref.id, 'lift', 'An established origin was atomically saved with its exact lift');
      if (intent.value.sources.journal === null) fail('analysis_invalid', ref.id, 'sources.journal', 'Origin history needs its exact journal');
      const hold = take(readOriginHoldAt(store, project, reference(after), intent.value.sources.journal));
      if (!hold.value.lift || !same(hold.value.lift.record, ref)) fail('analysis_invalid', ref.id, 'lift', 'This exact analysis must be the lift ground');
    }
    if (derived.state === 'undecided') {
      const before = intent.value.request.series, after = store.get(before.id, before.revision + 1);
      if (!after) fail('analysis_invalid', ref.id, 'escalation', 'An undecided review was atomically saved with its escalation');
      const series = take(readAnySeriesAt(store, project, reference(after)));
      if (!series.value.escalations.some(item => same(item.review, ref) && item.after === derived.stop))
        fail('analysis_invalid', ref.id, 'escalation', 'This exact review must be the escalation ground');
    }
    return saved as Revision<AnalysisRecord>;
  });
}
export async function runStopAnalysis(store: Store, request: StopAnalysisRequest, signal?: AbortSignal): Promise<OmResult<Sealed<Revision<AnalysisRecord>>>> {
  requireRequest(store, request);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new EngineError('analysis_request_invalid', 'A signal must be an AbortSignal');
  try {
    const prepared = take(prepareStopAnalysis(store, request));
    const intent = prepared.intent as AnalysisIntent, key = identity(store, request, seriesOf(store, request).value);
    const existing = [groundId(request, key), failureId(request.project, key)].flatMap(id => {
      const row = store.get(id); return row ? [row] : [];
    });
    if (existing.length > 1) fail('analysis_invalid', request.series.id, 'result', 'A single reviewer request cannot have two results');
    if (existing[0]) return readStopAnalysis(store, { project: request.project, record: reference(existing[0]) });
    const originalIntent = { id: intentId(request.project, key), revision: 1, hash: hashJson(intent) };
    const source = prepared.writes.length ? take(writeGuarded(store, { unit: 'A6', target: intentId(request.project, key),
      writes: prepared.writes, guards: prepared.guards }))[0]! : readIntent(store, request.project, originalIntent);
    const admissionGuards = uniqueTransactionGuards([...prepared.guards, originalIntent]);
    const admitted = take(recordCall(store, request.project, intent.call, admissionGuards));
    const first = store.get(admitted.call.id, 1)!;
    const physical = take(await runModelTransport(store, { project: request.project, call: reference(first), packet: intent.packet, role: 'reviewer' }, signal, admissionGuards));
    const record = deriveRecord({ ...source, value: intent } as Revision<AnalysisIntent>, physical);
    const address = resultAddress(intent, record, key), write: Write = { ...address, expected: 0, value: json(record) };
    let writes: readonly Write[] = [write], guards = uniqueTransactionGuards([...prepared.guards, reference(source)]);
    if (record.state === 'undecided') {
      const series = seriesOf(store, request), transition = take(prepareEscalateSeries(store, { ...seriesRequestOf(series.value),
        stop: record.stop, review: { pending: { id: write.id, kind: write.kind, value: json(write.value) } } }));
      writes = transition.writes; guards = uniqueTransactionGuards([...guards, ...transition.guards]);
    } else if (record.state === 'origin-established') {
      const transition = take(prepareLiftOriginHold(store, { project: request.project, hold: request.hold!, ground: 'origin-analysis',
        record: { pending: { id: write.id, kind: write.kind, value: json(write.value) } } }));
      writes = transition.writes; guards = uniqueTransactionGuards([...guards, ...transition.guards]);
    }
    const stored = writeGuarded(store, { unit: 'A6', target: write.id, writes, guards });
    if (!stored.ok) {
      const raced = store.get(write.id);
      if (raced && same(raced.value, record)) return readStopAnalysis(store, { project: request.project, record: reference(raced) });
      return stored;
    }
    const saved = stored.value.find(row => row.id === write.id)!;
    return readStopAnalysis(store, { project: request.project, record: reference(saved) });
  } catch (error) { if (error instanceof AnalysisFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
