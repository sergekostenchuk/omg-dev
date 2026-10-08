import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { uniqueTransactionGuards, type Environment } from '../runtime/environment.js';
import { readCapacity } from './capacity.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, isPlainObject, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readAnySeriesAt, seriesRequestOf, prepareSeriesLineAdmission, prepareEscalateSeries,
  readSeriesWorkAdmission, seriesRequiresAdmissionProof,
  STOP_REVIEW_KIND, stopReviewNamespace, type AnyRepairSeries, type AttemptGoal } from './series.js';
import { stopReportOfNewEra, stopReportSources, STOP_REPORT_CONTRACT_V2, type AnyStopReport, type StopReportSources } from './stop-report.js';
import { prepareLiftOriginHold, ORIGIN_ANALYSIS_KIND, originAnalysisNamespace,
  REFUSAL_CLASSES, type RefusalClass } from './repeat-gate.js';
import { normalizeOriginSource, type OriginSource } from './refusal-journal.js';
import { recordCall, type AnyRecordCallRequest, type CallBasis, type DispatchContract } from './call-record.js';
import { adapterRequest, transportUnder, type ModelTransportOutcome } from './model-call.js';
import { withHistoricalReads } from './input.js';
import { RunControlGate, RunControlLost, type RunControlHold } from './run-control.js';

export const STOP_ANALYSIS_CONTRACT = 'om-stop-analysis/v1';
/** LP6 (№3325 §4): a new intent stands on the report of the new era; its results and failures inherit its contract. */
export const STOP_ANALYSIS_CONTRACT_V2 = 'om-stop-analysis/v2';
type AnalysisContract = typeof STOP_ANALYSIS_CONTRACT | typeof STOP_ANALYSIS_CONTRACT_V2;
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
  contract: AnalysisContract; request: StopAnalysisRequest;
  sources: StopReportSources; report: AnyStopReport; packet: Json; call: AnyRecordCallRequest;
}
export interface PreparedStopAnalysis { intent: AnalysisIntent; writes: Write[]; guards: TransactionGuard[] }
interface AnalysisAdmission {
  contract: 'om-analysis-admission/v1'; project: string; intent: Ref; series: Ref; pointer: Ref; activation: Ref;
  owner: { kind: 'block'; block: string };
}
export interface AnalysisRecord {
  contract: AnalysisContract; projectId: string; intent: Ref; transport: Ref;
  state: 'decided' | 'undecided' | 'origin-established' | 'origin-unestablished' | 'failed';
  cause: AnalysisCause | null; change: AnalysisChange | null; error: Refusal | null;
  block?: string; owner?: { kind: 'mechanism'; mechanism: 'M5:addressing' };
  stop: number; goals: string[]; attempt: number; row: string | null;
  class: RefusalClass | null; basis: OriginSource[];
  /** LP8 (№3622): the first acceptance of an answer an old adapter wrapper refused — the refusal and the exchange it read. */
  recovery?: { failure: Ref; exchange: Ref };
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
const analysisAdmissionId = (project: string, intent: Ref) => `om-analysis-admission:${project}:${hashJson(intent)}`;
const failureId = (project: string, key: string) => `${STOP_ANALYSIS_FAILURE_KIND}:${project}:${key}`;
function groundId(request: StopAnalysisRequest, key: string): string {
  return `${request.hold === null ? stopReviewNamespace(request.project) : originAnalysisNamespace(request.project)}${key}`;
}
function declaredSources(report: AnyStopReport, request: StopAnalysisRequest): Ref[] {
  return uniqueRefs([...report.guards, request.dispatch.adapter, request.dispatch.config,
    ...report.obstacles.flatMap(row => [row.source, ...row.origin.sources.map(source => source.ref)]),
    ...report.remedies.flatMap(remedy => [...remedy.records]),
    // LP6 (№3325 §6): the exact witnesses of the completions are sources of the task, not guards of its write.
    ...(report.completionEvidence ?? []).flatMap(item => [...(item.close === null ? [] : [item.close]),
      ...item.decisions.flatMap(decision => [decision.e4, decision.call, decision.previous, decision.input]),
      ...item.ends.flatMap(end => [end.source, ...(end.replacement === null ? [] : [end.replacement])])])]);
}
const form = sealed({ protocol: 'omg-stop-analysis/v1', cause: 'null or {kind:evidence|hypothesis,text,sources:Ref[]}; evidence needs sources',
  change: 'null or {text,addresses:[{ref,field}]}', origin: 'null or {class,basis:OriginSource[]}; only origin analysis',
  rule: 'Diagnose this saved stop. State uncertainty explicitly. A proposal changes no graph, input or readiness.' });
/**
 * LP6 (№3325 §6): the form of an intent of the new era says the whole shape the acceptance below checks — the exact
 * Ref object, the non-empty field, origin null for a stop — with an example built from a Ref this task really declares.
 * The protocol of the answer is the same `omg-stop-analysis/v1`; only the description of its form is clearer.
 */
function formOf(contract: AnalysisContract, purpose: 'stop-analysis' | 'origin-analysis', example: Ref): Json {
  if (contract === STOP_ANALYSIS_CONTRACT) return form as unknown as Json;
  return json({
    protocol: 'omg-stop-analysis/v1',
    ref: 'A Ref is one whole exact object {"id":<string>,"revision":<integer>,"hash":<string>} copied unchanged from "sources" of this task. A string id, a partial object or a record outside "sources" is refused, never corrected.',
    cause: 'null, or {"kind":"evidence"|"hypothesis","text":<non-empty string>,"sources":[<Ref>, ...]}. Evidence needs at least one source; a hypothesis stays a hypothesis.',
    change: 'null, or {"text":<non-empty string>,"addresses":[{"ref":<Ref>,"field":<non-empty string>}, ...]} with at least one address. "field" names the field or aspect of that record to change: any non-empty string, not necessarily a JSON Pointer and not a closed vocabulary.',
    origin: purpose === 'stop-analysis' ? 'null: this is the analysis of a stop, not of an origin' : 'null or {class,basis:OriginSource[]}; only origin analysis',
    example: { protocol: 'omg-stop-analysis/v1', cause: { kind: 'hypothesis', text: '<the cause you see, with its uncertainty>', sources: [] },
      change: { text: '<the change you propose>', addresses: [{ ref: example, field: '<the field or aspect to change>' }] }, origin: null },
    rule: 'Diagnose this saved stop from the report, its lines and its completionEvidence. State uncertainty explicitly. A proposal changes no graph, input or readiness.',
  });
}
function deriveIntent(store: Store, request: StopAnalysisRequest, report: AnyStopReport): AnalysisIntent {
  // The era of an intent is the era of the report it stands on: a saved v1 report gives back its v1 intent literally.
  const contract: AnalysisContract = report.contract === STOP_REPORT_CONTRACT_V2 ? STOP_ANALYSIS_CONTRACT_V2 : STOP_ANALYSIS_CONTRACT;
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
  const packet = json({ contract, purpose, basis, goal, report, sources, form: formOf(contract, purpose, request.series) });
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
  return copy({ contract, request, sources: stopReportSources(report), report, packet, call });
}
/** NR (№3600): a trusted read — prepareStopAnalysis derived the intent from its exact report sources once. */
function readIntent(store: Store, project: string, ref: Ref): Revision<AnalysisIntent> {
  return take(readRecord<AnalysisIntent>(store, ref, { unit: 'A6', target: ref.id,
    idPrefix: `om-analysis-intent:${project}:`, kind: 'om-analysis-intent' })) as Revision<AnalysisIntent>;
}
function originalGuards(store: Store, intentRef: Ref, intent: AnalysisIntent): TransactionGuard[] {
  const guards: TransactionGuard[] = [...intent.report.guards, intent.request.dispatch.config, intent.request.dispatch.adapter];
  const source = seriesOf(store, intent.request);
  if (!seriesRequiresAdmissionProof(source.value)) return uniqueTransactionGuards(guards);
  const id = analysisAdmissionId(intent.request.project, intentRef), saved = store.get<AnalysisAdmission>(id, 1);
  if (!saved) fail('analysis_invalid', id, 'admission', 'This series era requires the immutable admission of its analysis intent');
  const value = saved.value;
  if (saved.kind !== 'om-analysis-admission' || saved.hash !== hashJson(value) || !object(value)
    || !keys(value, ['contract', 'project', 'intent', 'series', 'pointer', 'activation', 'owner'])
    || value.contract !== 'om-analysis-admission/v1' || value.project !== intent.request.project
    || !same(value.intent, intentRef) || !same(value.series, intent.request.series) || !isRef(value.pointer) || !isRef(value.activation)
    || 'owner' in source.value || !same(value.owner, { kind: 'block', block: source.value.block }))
    fail('analysis_invalid', id, 'admission', 'The fixed proof must name this exact intent, owner, series and activation');
  const admitted = take(readSeriesWorkAdmission(store, { project: intent.request.project, series: value.series, pointer: value.pointer }));
  if (!same(admitted.activation, value.activation))
    fail('analysis_invalid', id, 'activation', 'The common historical admission must prove this activation');
  return uniqueTransactionGuards([...guards, ...admitted.guards, reference(saved)]);
}
export function prepareStopAnalysis(store: Store, request: StopAnalysisRequest): OmResult<Sealed<PreparedStopAnalysis>> {
  requireRequest(store, request);
  return result(() => {
    const source = seriesOf(store, request), key = identity(store, request, source.value), id = intentId(request.project, key);
    const existing = store.get<AnalysisIntent>(id);
    if (existing) {
      const saved = readIntent(store, request.project, reference(existing));
      if (!same(saved.value.request, request)) fail('analysis_conflict', id, 'request', 'This saved ground already has its fixed analysis request');
      return { intent: saved.value, writes: [], guards: originalGuards(store, reference(saved), saved.value) };
    }
    const admission = take(prepareSeriesLineAdmission(store, request.project, request.series));
    const report = take(stopReportOfNewEra(store, seriesRequestOf(source.value))) as AnyStopReport;
    const intent = deriveIntent(store, request, report);
    const writes: Write[] = [{ id, kind: 'om-analysis-intent', expected: 0, value: json(intent) }];
    if (seriesRequiresAdmissionProof(source.value)) {
      if ('owner' in source.value || !admission.pointer || !admission.activation)
        fail('analysis_invalid', id, 'admission', 'Managed work requires its proved pointer and activation');
      const ref = { id, revision: 1, hash: hashJson(intent) };
      const proof: AnalysisAdmission = { contract: 'om-analysis-admission/v1', project: request.project, intent: ref,
        series: request.series, pointer: admission.pointer, activation: admission.activation,
        owner: { kind: 'block', block: source.value.block } };
      writes.push({ id: analysisAdmissionId(request.project, ref), kind: 'om-analysis-admission', expected: 0, value: json(proof) });
    }
    return { intent, writes, guards: uniqueTransactionGuards([...intent.report.guards,
      request.dispatch.config, request.dispatch.adapter, ...admission.guards]) };
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
  return copy({ contract: value.contract, projectId: request.project, intent: reference(intent), transport: reference(physical.record),
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
/** NR (№3600): a trusted read — runStopAnalysis (or its LP8 recovery) wrote the result from the physical response and its
 * fixed context once, atomically with its escalation or lift. */
export function readStopAnalysis(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<Revision<AnalysisRecord>>> {
  requireRead(store, request);
  return result(() => {
    const { project, record: ref } = request;
    const namespaces = [stopReviewNamespace(project), originAnalysisNamespace(project), `${STOP_ANALYSIS_FAILURE_KIND}:${project}:`];
    const kind = [STOP_REVIEW_KIND, ORIGIN_ANALYSIS_KIND, STOP_ANALYSIS_FAILURE_KIND][namespaces.findIndex(prefix => ref.id.startsWith(prefix))];
    if (!kind) fail('analysis_invalid', ref.id, 'id', 'This is not an analysis result address of the named project');
    return take(readRecord<AnalysisRecord>(store, ref, { unit: 'A6', target: ref.id, id: ref.id, kind })) as Revision<AnalysisRecord>;
  });
}
/** The adapter wrapper fields whose absence alone refused an answer of the old adapter (LP1/LP2 fixed the adapter). */
const WRAPPER_FIELDS: readonly string[] = ['confirmed', 'usage', 'envelope'];
interface RecoverableAnswer { failure: Revision<AnalysisRecord>; intent: Revision<AnalysisIntent>; exchange: Ref; raw: string; key: string }
/**
 * LP8 (№3620, №3622): a failed review whose physical response completed (exit 0, the exact request id, a research payload)
 * and was refused only for the wrapper of the old adapter — never for its content. Its saved payload is the answer the
 * reviewer gave; it has not been accepted yet. Null for any other failure: an empty, interrupted, foreign or malformed one.
 */
function recoverableAnswer(store: Store, project: string, failureRef: Ref): RecoverableAnswer | null {
  const prefix = `${STOP_ANALYSIS_FAILURE_KIND}:${project}:`;
  if (!failureRef.id.startsWith(prefix)) return null;
  const read = readStopAnalysis(store, { project, record: failureRef });
  if (!read.ok) return null;
  const failure = read.value as Revision<AnalysisRecord>, error = failure.value.error;
  if (failure.value.state !== 'failed' || !error || error.code !== 'model_adapter_response_invalid' || !WRAPPER_FIELDS.includes(error.at.field ?? '')) return null;
  const intent = readIntent(store, project, failure.value.intent);
  const physical = store.get<{ transport?: { exchange?: unknown } }>(failure.value.transport.id, failure.value.transport.revision);
  const exchangeRef = physical?.hash === failure.value.transport.hash ? physical.value.transport?.exchange : undefined;
  if (!isRef(exchangeRef)) return null;
  const exchange = store.get<{ wire?: { requestId?: unknown }; process?: { exitCode?: unknown; signal?: unknown; stdout?: unknown } | null }>(exchangeRef.id, exchangeRef.revision);
  const process = exchange?.hash === exchangeRef.hash ? exchange.value.process : null;
  if (!process || process.exitCode !== 0 || process.signal !== null || typeof process.stdout !== 'string') return null;
  let envelope: unknown;
  try { envelope = JSON.parse(process.stdout); } catch { return null; }
  const requestId = exchange!.value.wire?.requestId;
  if (!object(envelope) || envelope.protocol !== 'omg-agent/v1' || !text(requestId) || envelope.requestId !== requestId
    || requestId !== intent.value.call.call || !object(envelope.research)) return null;
  let raw: string;
  try { raw = canonical(envelope.research as Json); } catch { return null; }
  return { failure, intent, exchange: exchangeRef, raw, key: failureRef.id.slice(prefix.length) };
}
/** LP8: the review this failure was recovered into, if one is saved: the result at the review's own address naming it. */
export function readRecoveredStopAnalysis(store: Store, project: string, failureRef: Ref): Sealed<Revision<AnalysisRecord>> | null {
  const prefix = `${STOP_ANALYSIS_FAILURE_KIND}:${project}:`;
  if (!failureRef.id.startsWith(prefix)) return null;
  const read = readStopAnalysis(store, { project, record: failureRef });
  if (!read.ok || read.value.value.state !== 'failed') return null;
  const intent = readIntent(store, project, read.value.value.intent), key = failureRef.id.slice(prefix.length);
  for (const id of [groundId(intent.value.request, key)]) {
    const row = store.get<AnalysisRecord>(id);
    if (row && object(row.value) && object(row.value.recovery) && same(row.value.recovery.failure, failureRef))
      return take(readStopAnalysis(store, { project, record: reference(row) }));
  }
  return null;
}
export function stopAnalysisRecoverable(store: Store, project: string, failureRef: Ref): boolean {
  const found = recoverableAnswer(store, project, failureRef);
  return found !== null && parseAnswer(found.intent.value, found.raw).ok;
}
/**
 * LP8 (№3622): the one acceptance of the saved answer — by the producer of A6, as if it had just arrived: parsed against
 * the fixed request and written at the review's own address with its escalation or lift, linked to the refusal and the
 * exchange. No model is called and nothing old is changed. A repeat returns the saved recovery; an answer that does not
 * pass this first acceptance recovers nothing (the refusal stands).
 */
export function writeStopAnalysisRecovery(store: Store, request: { project: string; failure: Ref }): OmResult<Sealed<Revision<AnalysisRecord>>> {
  if (!(store instanceof Store) || !object(request) || !keys(request, ['project', 'failure']) || !text(request.project) || !isRef(request.failure))
    throw new EngineError('analysis_request_invalid', 'A recovery names its project and the exact refused review');
  return result(() => {
    const saved = readRecoveredStopAnalysis(store, request.project, request.failure);
    if (saved) return saved;
    const found = recoverableAnswer(store, request.project, request.failure);
    if (!found) fail('analysis_invalid', request.failure.id, 'recovery', 'Only a complete answer refused for the old adapter wrapper is recovered');
    const parsed = parseAnswer(found.intent.value, found.raw);
    if (!parsed.ok) return fail('analysis_response_invalid', request.failure.id, 'recovery', parsed.refusal.message);
    const intent = found.intent.value, answer = parsed.value as AnalysisAnswer, failed = found.failure.value;
    const holding = intent.request.hold === null ? null : intent.report.context.holds.find(hold => same(hold.hold, intent.request.hold))!;
    const state = holding !== null ? answer.origin === null || answer.origin.class === 'unknown' ? 'origin-unestablished' : 'origin-established'
      : answer.cause === null || answer.change === null ? 'undecided' : 'decided';
    const record: AnalysisRecord = copy({ ...failed, state, cause: answer.cause, change: answer.change, error: null,
      class: answer.origin?.class ?? null, basis: answer.origin?.basis ?? [], recovery: { failure: request.failure, exchange: found.exchange } });
    const address = resultAddress(intent, record, found.key), write: Write = { ...address, expected: 0, value: json(record) };
    let writes: readonly Write[] = [write];
    let guards = uniqueTransactionGuards([request.failure, reference(found.intent), found.exchange, { id: write.id, absent: true }]);
    if (state === 'undecided') {
      const series = seriesOf(store, intent.request), transition = take(prepareEscalateSeries(store, { ...seriesRequestOf(series.value),
        stop: record.stop, review: { pending: { id: write.id, kind: write.kind, value: json(write.value) } } }));
      writes = transition.writes; guards = uniqueTransactionGuards([...guards, ...transition.guards]);
    } else if (state === 'origin-established') {
      const transition = take(prepareLiftOriginHold(store, { project: request.project, hold: intent.request.hold!, ground: 'origin-analysis',
        record: { pending: { id: write.id, kind: write.kind, value: json(write.value) } } }));
      writes = transition.writes; guards = uniqueTransactionGuards([...guards, ...transition.guards]);
    }
    const stored = take(writeGuarded(store, { unit: 'A6', target: write.id, writes, guards }));
    return stored.find(row => row.id === write.id)! as unknown as Revision<AnalysisRecord>;
  });
}
/**
 * H1.3: the intent, E1 and dispatch of a review are new work under the pass's control; its saved result is read under
 * any control, and the application of a paid review (its result, escalation or lift) passes by its exact links.
 */
export async function runStopAnalysis(store: Store, request: StopAnalysisRequest, signal?: AbortSignal, control?: RunControlHold): Promise<OmResult<Sealed<Revision<AnalysisRecord>>>> {
  requireRequest(store, request);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new EngineError('analysis_request_invalid', 'A signal must be an AbortSignal');
  if (control !== undefined && (control === null || typeof control !== 'object')) throw new EngineError('analysis_request_invalid', 'A control hold must be an object');
  const gate = new RunControlGate(store, request.project, control);
  try {
    const prepared = take(prepareStopAnalysis(store, request));
    const intent = prepared.intent as AnalysisIntent, key = identity(store, request, seriesOf(store, request).value);
    const existing = [groundId(request, key), failureId(request.project, key)].flatMap(id => {
      const row = store.get(id); return row ? [row] : [];
    });
    // LP8: a review recovered from a refused answer stands at the review address beside its refusal; it is the result.
    if (existing[0]) return readStopAnalysis(store, { project: request.project, record: reference(existing[0]) });
    const originalIntent = { id: intentId(request.project, key), revision: 1, hash: hashJson(intent) };
    const source = prepared.writes.length ? take(writeGuarded(gate.view(), { unit: 'A6', target: intentId(request.project, key),
      writes: prepared.writes, guards: prepared.guards }))[0]! : readIntent(store, request.project, originalIntent);
    const admissionGuards = uniqueTransactionGuards([...prepared.guards, originalIntent]);
    const admitted = take(recordCall(gate.view(), request.project, intent.call, admissionGuards));
    const first = store.get(admitted.call.id, 1)!;
    const physical = take(await transportUnder(store, { project: request.project, call: reference(first), packet: intent.packet, role: 'reviewer' }, signal, admissionGuards, gate));
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
  } catch (error) {
    if (error instanceof AnalysisFailure) return { ok: false, refusal: error.refusal };
    if (error instanceof RunControlLost) return { ok: false, refusal: error.refusal };
    throw error;
  }
}
