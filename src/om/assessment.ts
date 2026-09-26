import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { uniqueTransactionGuards, type Environment } from '../runtime/environment.js';
import { delivered, isPlainObject, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readRecord, writeGuarded } from './refs.js';
import { historicalRead, withHistoricalReads } from './input.js';
import { checkAnswerForm } from './answer-form.js';
import { readMc1Question, prepareMc1Question, prepareAnswerCitations, prepareE5AcceptedAnswer,
  readAcceptedAnswer, readAnswerSearch, answerIndexId,
  ANSWER_INDEX_KIND,
  type AnswerGround, type AnswerQuestionContract, type Mc1QuestionRequest } from './accepted-answer.js';
import { readFactAssessmentOrigin, readCall, recordCall, type AddressedGap, type DispatchContract,
  type FactAssessmentBasis, type RecordCallRequest } from './call-record.js';
import { readModelCallState, readModelTransport, runModelTransport, type TransportModelCall } from './model-call.js';
import { readPacketResponse } from './question-packet.js';
import { prepareSeriesLineAdmission, readAnySeriesAt, readSeriesWorkAdmission, seriesCurrentId,
  seriesId, type AttemptGoal } from './series.js';
import { prepareCloseAttempt } from './repeat-gate.js';

export const ASSESSMENT_INTENT_KIND = 'om-assessment-intent';
export const ASSESSMENT_RESULT_KIND = 'om-assessment-result';
const INTENT_CONTRACT = 'om-assessment-intent/v1';
const RESULT_CONTRACT = 'om-assessment-result/v1';
const CALL_PREFIX = 'e5-assessor/v1:';

type SourceBasis = Omit<FactAssessmentBasis, 'assessment'>;
type Fact = { questionId: string; question: Ref; value: Json; grounds: AnswerGround[] };
type Candidate = { questionId: string; question: Ref };
export interface AssessmentIntentRequest {
  project: string; modelCall: Ref; questionId: string; dispatch: DispatchContract;
}
export interface AssessmentQuestion {
  record: Ref; target: string; field: string; contract: AnswerQuestionContract; fingerprint: string;
}
export interface AssessmentIntentRecord {
  contract: typeof INTENT_CONTRACT; project: string; source: SourceBasis; candidates: Candidate[];
  fact: Fact; question: AssessmentQuestion; originalSeries: Ref; series: Ref;
  attempt: number; goal: AttemptGoal; block: string; gaps: AddressedGap[];
  dispatch: DispatchContract; packet: Json; originalActor: string; originalGuards: Ref[];
}
export interface CheckedAssessmentIntent {
  intent: Ref; record: Revision<AssessmentIntentRecord>; call: string; basis: FactAssessmentBasis;
  gaps: AddressedGap[]; series: Ref; originalSeries: Ref; attempt: number; goal: AttemptGoal;
  block: string; dispatch: DispatchContract; packet: Json; originalActor: string;
  question: AssessmentQuestion; fact: Fact; candidates: Candidate[];
}
export interface AssessmentAdmission extends CheckedAssessmentIntent { guards: TransactionGuard[] }
export interface PreparedAssessmentIntent {
  record: Revision<AssessmentIntentRecord>; writes: Write[]; guards: TransactionGuard[];
}
export type AssessmentVerdict = 'supported' | 'insufficient' | 'conflicting' | 'off-form' | 'interrupted';
export interface AssessmentResultRecord {
  contract: typeof RESULT_CONTRACT; project: string; intent: Ref; assessor: Ref;
  verdict: AssessmentVerdict; reasons: string[]; accepted: Ref | null; index: Ref | null;
}

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const order = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const refs = (values: readonly Ref[]): Ref[] => [...new Map(values.map(value => [canonical(value), value])).values()]
  .sort((a, b) => order(canonical(a), canonical(b)));
class AssessmentFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(value: OmResult<T>): T { if (!value.ok) throw new AssessmentFailure(value.refusal); return value.value; }
function fail(code: string, target: string, field: string, message: string, ref?: Ref): never {
  const outcome = refused(code, message, { unit: 'E5', target, field, ref }, 'producer');
  if (!outcome.ok) throw new AssessmentFailure(outcome.refusal);
  throw new Error('Unreachable');
}
function checked<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof AssessmentFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function invalid(field: string): never {
  throw new EngineError('assessment_request_invalid', 'E5 needs an explicit complete request',
    { unit: 'E5', target: ASSESSMENT_INTENT_KIND, field });
}
function requireProject(store: Store, project: unknown): asserts project is string {
  if (!(store instanceof Store)) invalid('store');
  if (!text(project) || project.includes(':')) invalid('project');
}
function requireIntentRequest(store: Store, request: unknown): asserts request is AssessmentIntentRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || request.project.includes(':')
    || !isRef(request.modelCall) || !text(request.questionId) || !object(request.dispatch)
    || !isRef(request.dispatch.adapter) || !isRef(request.dispatch.config)
    || !same(Object.keys(request).sort(), ['dispatch', 'modelCall', 'project', 'questionId'])
    || !same(Object.keys(request.dispatch).sort(), ['adapter', 'config'])) invalid('request');
}
function requireIntentRef(store: Store, project: unknown, ref: unknown): asserts ref is Ref {
  requireProject(store, project);
  if (!isRef(ref)) invalid('intent');
}
function intentId(project: string, source: Pick<SourceBasis, 'call' | 'question' | 'questionId'>): string {
  return `${ASSESSMENT_INTENT_KIND}:${project}:${hashJson({ call: source.call.id, question: source.question.id, questionId: source.questionId })}`;
}
export function assessmentIntentId(project: string, source: Pick<SourceBasis, 'call' | 'question' | 'questionId'>): string {
  if (!text(project) || project.includes(':') || !object(source) || !isRef(source.call)
    || !isRef(source.question) || !text(source.questionId)) invalid('source');
  return intentId(project, source);
}
export function isAssessmentCallName(name: string): boolean {
  return typeof name === 'string' && /^e5-assessor\/v1:[a-f0-9]{64}$/.test(name);
}
export function assessmentCallName(project: string, intent: Ref): string {
  if (!text(project) || project.includes(':') || !isRef(intent)
    || !intent.id.startsWith(`${ASSESSMENT_INTENT_KIND}:${project}:`)) invalid('intent');
  return `${CALL_PREFIX}${hashJson({ project, intent: intent.id })}`;
}
function sourceBasis(store: Store, project: string, modelCall: Ref, questionId: string): SourceBasis {
  const state = take(readModelCallState(store, { project, record: modelCall }));
  const outcome = state.state === 'applied' ? state.outcome : null;
  if (!outcome || outcome.outcome?.kind !== 'fact-candidates' || !outcome.response)
    fail('assessment_source_invalid', modelCall.id, 'modelCall', 'The source must be one applied MC1 fact response', modelCall);
  const facts = outcome.outcome.facts.filter(item => item.questionId === questionId);
  if (facts.length !== 1) fail('assessment_source_invalid', modelCall.id, 'questionId', 'The source needs one exact addressed fact', modelCall);
  return { kind: 'fact-assessment', modelCall, call: outcome.call, packet: outcome.packet,
    response: outcome.response, question: facts[0]!.question, questionId };
}
function sourceBody(store: Store, project: string, source: SourceBasis, dispatch: DispatchContract,
  series: Ref, current: boolean): { value: AssessmentIntentRecord; guards: Ref[]; requiredGuards: Ref[] } {
  const origin = take(readFactAssessmentOrigin(store, project, source, source.modelCall.id));
  if ('owner' in origin.call.value) fail('assessment_source_invalid', source.call.id, 'owner', 'MC1 fact assessment belongs to a block attempt');
  const state = take(readModelCallState(store, { project, record: source.modelCall }));
  const original = state.state === 'applied' ? state.outcome : null;
  if (!original || original.outcome?.kind !== 'fact-candidates' || !original.response
    || !same(original.call, source.call) || !same(original.packet, source.packet)
    || !same(original.response, source.response))
    fail('assessment_source_invalid', source.modelCall.id, 'outcome', 'The exact E4 producer must hold these complete fact candidates', source.modelCall);
  const response = take(readPacketResponse(store, { project, packet: source.packet, call: source.call, response: source.response }));
  const question = take(readMc1Question(store, { project, record: source.question }));
  const selected = original.outcome.facts.filter(item => item.questionId === source.questionId && same(item.question, source.question));
  if (selected.length !== 1 || question.gap.target !== origin.gaps[0]?.id || question.gap.field !== origin.gaps[0]?.field)
    fail('assessment_source_invalid', source.question.id, 'question', 'The selected value belongs to this exact issued MC1 question', source.question);
  const fact = selected[0]! as Fact;
  const candidates = sorted(original.outcome.facts.map(item => ({ questionId: item.questionId, question: item.question })));
  if (new Set(candidates.map(item => item.questionId)).size !== candidates.length)
    fail('assessment_source_invalid', source.modelCall.id, 'candidates', 'One response names each candidate question once', source.modelCall);
  const originalSeries = origin.call.value.series;
  const line = take(readAnySeriesAt(store, project, series));
  if (series.id !== originalSeries.id || !('block' in line.value) || line.value.block !== origin.call.value.block)
    fail('assessment_source_invalid', series.id, 'series', 'The assessor belongs to the original block line', series);
  const attempt = line.value.attempts.find(item => item.ordinal === origin.call.value.attempt);
  if (!attempt || !same(attempt.goal, origin.call.value.goal) || (current && attempt.outcome !== null))
    fail('assessment_source_invalid', series.id, 'attempt', 'The assessor belongs to the original open attempt', series);
  const environment = take(readRecord<Environment>(store, dispatch.config,
    { unit: 'E5', target: source.modelCall.id, id: `environment:${project}`, kind: 'environment' }));
  const adapter = take(readRecord<{ projectId: string; protocol: string }>(store, dispatch.adapter,
    { unit: 'E5', target: source.modelCall.id, kind: 'dispatch-adapter', idPrefix: `adapter:${project}:` }));
  const originalActor = original.record.value.requested.actor;
  if (!object(environment.value) || environment.value.projectId !== project
    || !object(environment.value.reviewer) || !text(environment.value.reviewer.actor)
    || !text(originalActor) || environment.value.reviewer.actor === originalActor
    || !object(adapter.value) || adapter.value.projectId !== project || adapter.value.protocol !== 'codex-stdio')
    fail('assessment_independence_invalid', dispatch.config.id, 'reviewer.actor', 'The actual reviewer must differ from the original MC1 actor', dispatch.config);
  const request = { project, packet: source.packet, raw: response.record.value.raw };
  const form = take(checkAnswerForm(store, request));
  if (form.kind !== 'fact-candidates' || !same(form.facts, original.outcome.facts))
    fail('assessment_source_invalid', source.response.id, 'form', 'The exact answer and citations must pass the shared E3 form check', source.response);
  const liveQuestion = current ? take(prepareMc1Question(store, question.record.value.request as unknown as Mc1QuestionRequest)) : null;
  if (liveQuestion && !same(liveQuestion.record, question.record))
    fail('assessment_source_stale', source.question.id, 'question', 'The selected MC1 question must retain its current producer basis', source.question);
  const liveCitations = current ? take(prepareAnswerCitations(store, { project,
    citations: fact.grounds.map(ground => ({ source: ground.observation.source, selector: ground.observation.selector })) })) : null;
  if (liveCitations && !same(liveCitations.grounds, fact.grounds))
    fail('assessment_source_stale', source.response.id, 'grounds', 'The selected fact still needs its exact current evidence', source.response);
  const contract = question.record.value.request.contract as unknown as AnswerQuestionContract;
  const prompt = sealed({ protocol: 'omg-fact-assessment/v1', questionId: source.questionId,
    question: { target: question.gap.target, field: question.gap.field,
      contract, fingerprint: question.record.value.fingerprint },
    answer: { value: fact.value, grounds: fact.grounds },
  }) as unknown as Json;
  const guards = current ? refs([source.modelCall, source.packet, source.response, series,
    dispatch.adapter, dispatch.config, ...(liveQuestion?.guards ?? []), ...(liveCitations?.guards ?? []),
    ...take(prepareSeriesLineAdmission(store, project, series)).guards]) : [];
  const requiredGuards = refs([source.modelCall, source.packet, source.response, series,
    dispatch.adapter, dispatch.config, ...question.references,
    ...fact.grounds.map(ground => ground.observation.source)]);
  if (current && requiredGuards.some(required => !guards.some(guard => same(guard, required))))
    fail('assessment_source_invalid', source.question.id, 'guards', 'The admission must guard every exact question and citation source', source.question);
  if (current) for (const ref of guards) {
    const head = store.get(ref.id);
    if (!head || !same(reference(head), ref)) fail('assessment_source_stale', ref.id, 'head', 'The assessment source moved', ref);
  }
  return { value: { contract: INTENT_CONTRACT, project, source, candidates, fact,
    question: { record: source.question, target: question.gap.target, field: question.gap.field,
      contract, fingerprint: question.record.value.fingerprint },
    originalSeries, series, attempt: origin.call.value.attempt, goal: origin.call.value.goal,
    block: origin.call.value.block, gaps: [...origin.gaps], dispatch, packet: prompt, originalActor,
    originalGuards: guards }, guards, requiredGuards };
}
function checkedIntent(record: Revision<AssessmentIntentRecord>): CheckedAssessmentIntent {
  const intent = reference(record), source = record.value.source;
  return { intent, record, call: assessmentCallName(record.value.project, intent),
    basis: { ...source, assessment: intent }, gaps: record.value.gaps, series: record.value.series,
    originalSeries: record.value.originalSeries, attempt: record.value.attempt, goal: record.value.goal,
    block: record.value.block, dispatch: record.value.dispatch, packet: record.value.packet,
    originalActor: record.value.originalActor, question: record.value.question,
    fact: record.value.fact, candidates: record.value.candidates };
}
export function prepareAssessmentIntent(store: Store, request: AssessmentIntentRequest): OmResult<Sealed<PreparedAssessmentIntent>> {
  requireIntentRequest(store, request); request = sealed(request) as AssessmentIntentRequest;
  return checked(() => {
    const source = sourceBasis(store, request.project, request.modelCall, request.questionId);
    const id = intentId(request.project, source), prior = store.get<AssessmentIntentRecord>(id);
    if (prior) {
      const checkedPrior = take(readAssessmentIntentAt(store, request.project, reference(prior)));
      if (!same(checkedPrior.record.value.source, source) || !same(checkedPrior.dispatch, request.dispatch))
        fail('assessment_identity_conflict', id, 'intent', 'One original fact has one assessor intent', reference(prior));
      return { record: checkedPrior.record, writes: [], guards: [] };
    }
    const original = take(readFactAssessmentOrigin(store, request.project, source, source.call.id));
    const current = store.get(original.call.value.series.id);
    if (!current) fail('assessment_source_invalid', original.call.value.series.id, 'series', 'The original attempt has no current series');
    const derived = sourceBody(store, request.project, source, request.dispatch, reference(current), true);
    const record: Revision<AssessmentIntentRecord> = { id, kind: ASSESSMENT_INTENT_KIND, revision: 1,
      hash: hashJson(derived.value), value: derived.value };
    return { record, writes: [{ id, kind: ASSESSMENT_INTENT_KIND, expected: 0, value: derived.value }],
      guards: uniqueTransactionGuards(derived.guards) };
  });
}
export function writeAssessmentIntent(store: Store, request: AssessmentIntentRequest): OmResult<Sealed<Revision<AssessmentIntentRecord>>> {
  const prepared = prepareAssessmentIntent(store, request);
  if (!prepared.ok) return prepared;
  if (!prepared.value.writes.length) return delivered(prepared.value.record);
  const written = writeGuarded<AssessmentIntentRecord>(store, { unit: 'E5', target: prepared.value.record.id,
    writes: prepared.value.writes, guards: prepared.value.guards });
  return written.ok ? delivered(written.value[0]!) : written;
}
export function readAssessmentIntentAt(store: Store, project: string, ref: Ref): OmResult<Sealed<CheckedAssessmentIntent>> {
  requireIntentRef(store, project, ref);
  return checked(() => historicalRead(store, { reader: 'E5.assessment-intent', project, ref }, () => {
    const record = take(readRecord<AssessmentIntentRecord>(store, ref, { unit: 'E5', target: ref.id,
      kind: ASSESSMENT_INTENT_KIND, idPrefix: `${ASSESSMENT_INTENT_KIND}:${project}:` }));
    const value = record.value;
    if (record.revision !== 1 || !object(value) || value.contract !== INTENT_CONTRACT || value.project !== project
      || !object(value.source) || !isRef(value.source.modelCall) || !isRef(value.source.call)
      || !isRef(value.source.packet) || !isRef(value.source.response) || !isRef(value.source.question)
      || !text(value.source.questionId) || !isRef(value.series) || !object(value.dispatch)
      || !isRef(value.dispatch.adapter) || !isRef(value.dispatch.config)
      || !Array.isArray(value.originalGuards) || !value.originalGuards.every(isRef)
      || record.id !== intentId(project, value.source))
      fail('assessment_intent_invalid', ref.id, 'record', 'The intent needs its complete exact source and fixed identity', ref);
    const derived = sourceBody(store, project, value.source, value.dispatch, value.series, false);
    if (!same({ ...value, originalGuards: [] }, { ...derived.value, originalGuards: [] }))
      fail('assessment_intent_invalid', ref.id, 'content', 'The intent must be rederived from the original answer', ref);
    const pointerGuards = value.originalGuards.filter(guard => guard.id === seriesCurrentId(project));
    if (pointerGuards.length > 1)
      fail('assessment_intent_invalid', ref.id, 'originalGuards', 'One intent has at most one original series pointer guard', ref);
    const seriesAdmission = readSeriesWorkAdmission(store, { project, series: value.series,
      pointer: pointerGuards[0] ?? null });
    if (!seriesAdmission.ok)
      fail('assessment_intent_invalid', ref.id, 'originalGuards',
        'The original series and its saved pointer must prove the historical work admission', value.series);
    const required = refs([...derived.requiredGuards, ...seriesAdmission.value.guards]);
    if (required.some(guard => !value.originalGuards.some(saved => same(saved, guard))))
      fail('assessment_intent_invalid', ref.id, 'originalGuards', 'The intent must retain every exact question and citation source guard', ref);
    for (const guard of value.originalGuards) {
      const found = store.get(guard.id, guard.revision);
      if (!found || !same(reference(found), guard))
        fail('assessment_intent_invalid', ref.id, 'originalGuards', 'The original admission retains exact checked sources', guard);
    }
    if (!same(value.originalGuards, refs(value.originalGuards)))
      fail('assessment_intent_invalid', ref.id, 'originalGuards', 'Original guards have one canonical order', ref);
    return checkedIntent(record as unknown as Revision<AssessmentIntentRecord>);
  }, () => fail('assessment_intent_invalid', ref.id, 'history', 'An intent cannot depend on itself', ref)));
}
function originalGuardHeads(store: Store, intent: Sealed<CheckedAssessmentIntent>): Ref[] {
  const original = intent.record.value.originalGuards;
  for (const guard of original) {
    const head = store.get(guard.id);
    if (!head || !same(reference(head), guard))
      fail('assessment_source_stale', guard.id, 'originalGuards',
        'The assessor retains every head captured before its original intent was written', guard);
  }
  return [...original];
}
export function prepareAssessmentAdmission(store: Store, project: string, ref: Ref): OmResult<Sealed<AssessmentAdmission>> {
  requireIntentRef(store, project, ref);
  return checked(() => {
    const intent = take(readAssessmentIntentAt(store, project, ref));
    const current = sourceBody(store, project, intent.record.value.source, intent.dispatch, intent.series, true);
    if (!same({ ...intent.record.value, originalGuards: [] }, { ...current.value, originalGuards: [] }))
      fail('assessment_source_stale', ref.id, 'source', 'The current admission differs from the saved intent', ref);
    const head = store.get(ref.id);
    if (!head || !same(reference(head), ref)) fail('assessment_source_stale', ref.id, 'intent', 'The intent must remain the exact head', ref);
    const originalGuards = originalGuardHeads(store, intent);
    return { ...intent, guards: uniqueTransactionGuards([ref, ...originalGuards, ...current.guards]) };
  });
}
function applicationGuards(store: Store, intent: Sealed<CheckedAssessmentIntent>): TransactionGuard[] {
  const source = intent.record.value, currentLine = store.get(source.series.id);
  if (!currentLine) fail('assessment_source_stale', source.series.id, 'series', 'The original attempt has no active line', source.series);
  const current = sourceBody(store, source.project, source.source, source.dispatch, reference(currentLine), true);
  const comparable = (value: Sealed<AssessmentIntentRecord>) => ({ ...value, series: null, originalGuards: [] });
  if (!same(comparable(source), comparable(current.value)))
    fail('assessment_source_stale', intent.intent.id, 'source', 'The assessment no longer has its original fact and running attempt', intent.intent);
  const head = store.get(intent.intent.id);
  if (!head || !same(reference(head), intent.intent))
    fail('assessment_source_stale', intent.intent.id, 'intent', 'The intent must remain the exact head', intent.intent);
  const originalGuards = originalGuardHeads(store, intent);
  return uniqueTransactionGuards([intent.intent, ...originalGuards, ...current.guards]);
}
function verdictOf(raw: string): { verdict: 'supported' | 'insufficient' | 'conflicting'; reasons: string[] } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!object(parsed) || !['supported', 'insufficient', 'conflicting'].includes(String(parsed.verdict))
    || !Array.isArray(parsed.reasons) || !parsed.reasons.every(text)
    || (parsed.verdict !== 'supported' && parsed.reasons.length === 0)
    || !same(Object.keys(parsed).sort(), ['reasons', 'verdict'])) return null;
  return { verdict: parsed.verdict as 'supported' | 'insufficient' | 'conflicting', reasons: parsed.reasons as string[] };
}
export function readAssessmentResultAt(store: Store, project: string, intentRef: Ref, assessorRef: Ref): OmResult<Sealed<{
  intent: CheckedAssessmentIntent; assessor: Revision<TransportModelCall>; call: Ref;
  verdict: AssessmentVerdict; reasons: string[]; references: Ref[];
}>> {
  requireIntentRef(store, project, intentRef);
  if (!isRef(assessorRef)) invalid('assessor');
  return checked(() => {
    const intent = take(readAssessmentIntentAt(store, project, intentRef));
    const physical = take(readModelTransport(store, { project, record: assessorRef }));
    const call = physical.call;
    const child = take(readCall(store, project, call));
    if (child.value.purpose !== 'fact-assessment' || !object(child.value.basis)
      || child.value.basis.kind !== 'fact-assessment' || !same(child.value.basis.assessment, intentRef)
      || child.value.call !== intent.call || !same(physical.record.value.transport.request.packet, intent.packet)
      || physical.record.value.transport.request.role !== 'reviewer'
      || physical.record.value.requested.actor === intent.originalActor)
      fail('assessment_result_invalid', assessorRef.id, 'assessor', 'The exact independent physical call belongs to this intent', assessorRef);
    const parsed = physical.result.kind === 'answered' ? verdictOf(physical.result.raw) : null;
    const verdict: AssessmentVerdict = parsed?.verdict ?? (physical.result.kind === 'interrupted' ? 'interrupted' : 'off-form');
    const reasons = parsed?.reasons ?? [physical.result.kind === 'answered' ? 'Invalid assessment verdict form'
      : physical.result.error.message];
    return { intent, assessor: physical.record, call, verdict, reasons,
      references: refs([intentRef, assessorRef, call, intent.record.value.source.modelCall,
        intent.record.value.source.response, intent.record.value.source.question]) };
  });
}
/** D5 uses this proof; only a supported physical verdict can become an accepted fact. */
export function readAssessmentOutcomeAt(store: Store, project: string, intent: Ref, assessor: Ref): OmResult<Sealed<{
  intent: CheckedAssessmentIntent; assessor: Revision<TransportModelCall>; call: Ref;
  verdict: 'supported'; reasons: string[]; references: Ref[];
}>> {
  const result = readAssessmentResultAt(store, project, intent, assessor);
  if (!result.ok) return result;
  if (result.value.verdict !== 'supported') return refused('assessment_not_supported', 'Only a supported independent verdict can be accepted',
    { unit: 'E5', target: assessor.id, field: 'verdict', ref: assessor }, 'gap');
  return delivered({ ...result.value, verdict: 'supported' as const });
}

export function assessmentResultId(project: string, intent: Ref): string {
  if (!text(project) || project.includes(':') || !isRef(intent)
    || !intent.id.startsWith(`${ASSESSMENT_INTENT_KIND}:${project}:`)) invalid('intent');
  return `${ASSESSMENT_RESULT_KIND}:${project}:${hashJson(intent.id)}`;
}
function resultReference(write: Write): Ref {
  return { id: write.id, revision: write.expected + 1, hash: hashJson(write.value) };
}
function terminalValue(store: Store, project: string, intent: Ref, assessor: Ref,
  accepted: Ref | null, index: Ref | null): AssessmentResultRecord {
  const actual = take(readAssessmentResultAt(store, project, intent, assessor));
  return { contract: RESULT_CONTRACT, project, intent, assessor, verdict: actual.verdict,
    reasons: [...actual.reasons], accepted, index };
}
/** A terminal result never replaces the physical receipt or charges the model again. */
export function applyAssessmentResult(store: Store, request: { project: string; intent: Ref; assessor: Ref }):
  OmResult<Sealed<Revision<AssessmentResultRecord>>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || request.project.includes(':')
    || !isRef(request.intent) || !isRef(request.assessor)
    || !same(Object.keys(request).sort(), ['assessor', 'intent', 'project'])) invalid('result');
  const applied = checked(() => {
    const id = assessmentResultId(request.project, request.intent), prior = store.get<AssessmentResultRecord>(id);
    if (prior) {
      const historical = take(readAssessmentTerminalAt(store, request.project, reference(prior)));
      if (!same(historical.value.intent, request.intent) || !same(historical.value.assessor, request.assessor))
        fail('assessment_identity_conflict', id, 'assessor', 'One fact has one terminal assessment', reference(prior));
      return historical;
    }
    const outcome = take(readAssessmentResultAt(store, request.project, request.intent, request.assessor));
    const admissionGuards = applicationGuards(store, outcome.intent);
    const writes: Write[] = [];
    let accepted: Ref | null = null, index: Ref | null = null;
    let guards: TransactionGuard[] = [...admissionGuards];
    if (outcome.verdict === 'supported') {
      const prepared = take(prepareE5AcceptedAnswer(store,
        { project: request.project, intent: request.intent, assessor: request.assessor }));
      writes.push(...prepared.writes as Write[]);
      accepted = reference(prepared.record);
      const indexWrite = prepared.writes.find(write => write.kind === ANSWER_INDEX_KIND);
      if (indexWrite) index = resultReference(indexWrite);
      else {
        const head = store.get(answerIndexId(request.project, prepared.record.value.target, prepared.record.value.field));
        if (!head) fail('assessment_result_invalid', prepared.record.id, 'index', 'A supported answer needs its complete D5 index');
        index = reference(head);
      }
      guards = uniqueTransactionGuards([...guards, ...prepared.guards]);
    }
    const value = terminalValue(store, request.project, request.intent, request.assessor, accepted, index);
    const write: Write = { id, kind: ASSESSMENT_RESULT_KIND, expected: 0, value };
    const result: Revision<AssessmentResultRecord> = { id, kind: ASSESSMENT_RESULT_KIND,
      revision: 1, hash: hashJson(value), value };
    const saved = take(writeGuarded(store, { unit: 'E5', target: id,
      writes: [...writes, write], guards: uniqueTransactionGuards(guards) }));
    const written = saved.find(row => row.id === id);
    if (!written || !same(written, result)) fail('assessment_result_invalid', id, 'write', 'The terminal result must be written with the full answer bundle');
    return result;
  });
  if (!applied.ok) return applied;
  const closure = finishSupportedAssessmentAttempt(store, request.project, request.intent);
  return closure.ok ? applied : closure;
}

/** Reprove the paid terminal outcome without descending into its D5 answer or index. */
export function readAssessmentTerminalBasisAt(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<AssessmentResultRecord>>> {
  requireIntentRef(store, project, ref);
  return checked(() => historicalRead(store, { reader: 'E5.assessment-result-basis', project, ref }, () => {
    const record = take(readRecord<AssessmentResultRecord>(store, ref, { unit: 'E5', target: ref.id,
      kind: ASSESSMENT_RESULT_KIND, idPrefix: `${ASSESSMENT_RESULT_KIND}:${project}:` }));
    const value = record.value;
    if (record.revision !== 1 || !object(value) || value.contract !== RESULT_CONTRACT || value.project !== project
      || !isRef(value.intent) || !isRef(value.assessor) || !Array.isArray(value.reasons)
      || !value.reasons.every(text) || !(value.accepted === null || isRef(value.accepted))
      || !(value.index === null || isRef(value.index)) || record.id !== assessmentResultId(project, value.intent))
      fail('assessment_result_invalid', ref.id, 'record', 'The saved result needs one exact intent and assessor', ref);
    const physical = take(readAssessmentResultAt(store, project, value.intent, value.assessor));
    if (value.verdict !== physical.verdict || !same(value.reasons, physical.reasons))
      fail('assessment_result_invalid', ref.id, 'verdict', 'The terminal verdict derives from the paid assessor response', ref);
    if (value.verdict === 'supported') {
      if (!value.accepted || !value.index) fail('assessment_result_invalid', ref.id, 'accepted', 'Support needs its complete D5 acceptance', ref);
    } else if (value.accepted !== null || value.index !== null)
      fail('assessment_result_invalid', ref.id, 'accepted', 'An unsupported verdict cannot accept a fact', ref);
    return record;
  }, () => fail('assessment_result_invalid', ref.id, 'history', 'A result cannot depend on itself', ref)));
}

export function readAssessmentTerminalAt(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<AssessmentResultRecord>>> {
  requireIntentRef(store, project, ref);
  return checked(() => historicalRead(store, { reader: 'E5.assessment-result', project, ref }, () => {
    const record = take(readAssessmentTerminalBasisAt(store, project, ref));
    const value = record.value;
    if (value.verdict === 'supported') {
      const answer = take(readAcceptedAnswer(store, { project, record: value.accepted! }));
      if (!('producer' in answer.record.value) || answer.record.value.producer !== 'E5'
        || !same(answer.record.value.request, { project, intent: value.intent, assessor: value.assessor }))
        fail('assessment_result_invalid', ref.id, 'accepted', 'The exact D5 answer must belong to this supported verdict', ref);
      const search = take(readAnswerSearch(store, { project, record: value.index! }));
      if (!search.answers.some(candidate => same(candidate, value.accepted)))
        fail('assessment_result_invalid', ref.id, 'index', 'The complete D5 index must include the accepted answer', value.index!);
    }
    return record;
  }, () => fail('assessment_result_invalid', ref.id, 'history', 'A result cannot depend on itself', ref)));
}

/** The candidate set comes from the original E4 answer, never from the caller's chosen subset. */
export function readAssessmentSet(store: Store, project: string, intentRef: Ref): OmResult<Sealed<{
  source: Ref; originalSeries: Ref; attempt: number; block: string; goal: AttemptGoal;
  complete: boolean; allSupported: boolean; accepted: Ref[]; results: Ref[]; guards: Ref[];
}>> {
  requireIntentRef(store, project, intentRef);
  return checked(() => {
    const first = take(readAssessmentIntentAt(store, project, intentRef));
    const source = first.record.value.source;
    const accepted: Ref[] = [], results: Ref[] = [], guards: Ref[] = [source.modelCall];
    let complete = true, allSupported = true;
    for (const candidate of first.candidates) {
      const id = intentId(project, { call: source.call, question: candidate.question, questionId: candidate.questionId });
      // Intent and result contracts have one immutable revision. Historical proof reads that revision;
      // new closure guards it as the current head in its transaction.
      const savedIntent = store.get<AssessmentIntentRecord>(id, 1);
      if (!savedIntent) { complete = false; allSupported = false; continue; }
      const checkedIntent = take(readAssessmentIntentAt(store, project, reference(savedIntent)));
      guards.push(reference(savedIntent));
      if (!same(checkedIntent.record.value.source.modelCall, source.modelCall)
        || !same(checkedIntent.candidates, first.candidates)
        || !same(checkedIntent.originalSeries, first.originalSeries)
        || checkedIntent.attempt !== first.attempt || checkedIntent.block !== first.block
        || !same(checkedIntent.goal, first.goal))
        fail('assessment_set_invalid', id, 'source', 'Every assessment belongs to the same complete original response', reference(savedIntent));
      const resultId = assessmentResultId(project, reference(savedIntent));
      const savedResult = store.get<AssessmentResultRecord>(resultId, 1);
      if (!savedResult) { complete = false; allSupported = false; continue; }
      const result = take(readAssessmentTerminalAt(store, project, reference(savedResult)));
      guards.push(reference(savedResult));
      results.push(reference(result));
      if (result.value.verdict !== 'supported' || !result.value.accepted) allSupported = false;
      else { accepted.push(result.value.accepted); guards.push(result.value.accepted); }
    }
    return { source: source.modelCall, originalSeries: first.originalSeries, attempt: first.attempt,
      block: first.block, goal: first.goal, complete, allSupported, accepted: refs(accepted),
      results: refs(results), guards: refs(guards) };
  });
}

/** G7 closes only an entirely supported original set; E5.1 owns refused and mixed completion. */
export function finishSupportedAssessmentAttempt(store: Store, project: string, intent: Ref): OmResult<Sealed<{
  complete: boolean; closed: boolean; results: Ref[];
}>> {
  requireIntentRef(store, project, intent);
  return checked(() => {
    const set = take(readAssessmentSet(store, project, intent));
    if (!set.complete || !set.allSupported) return { complete: set.complete, closed: false, results: set.results as Ref[] };
    const line = take(readAnySeriesAt(store, project, set.originalSeries));
    if (!('block' in line.value) || line.value.block !== set.block)
      fail('assessment_set_invalid', set.originalSeries.id, 'series', 'The complete set belongs to one block attempt', set.originalSeries);
    const prepared = take(prepareCloseAttempt(store, { project, block: set.block, line: line.value.line, attempt: set.attempt,
      outcome: { reason: 'result', accepting: set.accepted, cancelling: [], refusals: [] } }));
    if (prepared.writes.length > 0) {
      const current = store.get(line.id);
      if (!current) fail('assessment_set_invalid', line.id, 'series', 'The complete attempt needs its current line', set.originalSeries);
      const admission = take(prepareSeriesLineAdmission(store, project, reference(current)));
      take(writeGuarded(store, { unit: 'E5', target: line.id, writes: [...prepared.writes] as Write[],
        guards: uniqueTransactionGuards([...prepared.guards, ...admission.guards, ...set.guards,
          { id: seriesId(project, set.block, line.value.line + 1), absent: true }]) }));
    }
    return { complete: true, closed: true, results: set.results as Ref[] };
  });
}

/** Public producer joins the intent, E1 admission, saved physical reply and product application. */
export async function assessFact(store: Store, request: AssessmentIntentRequest, signal?: AbortSignal):
  Promise<OmResult<Sealed<Revision<AssessmentResultRecord>>>> {
  requireIntentRequest(store, request);
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  const intent = writeAssessmentIntent(store, request);
  if (!intent.ok) return intent;
  const intentRef = reference(intent.value), history = readAssessmentIntentAt(store, request.project, intentRef);
  if (!history.ok) return history;
  const terminal = store.get<AssessmentResultRecord>(assessmentResultId(request.project, intentRef));
  if (terminal) return applyAssessmentResult(store, { project: request.project,
    intent: intentRef, assessor: terminal.value.assessor });
  const admission = history.value;
  const callRequest: RecordCallRequest = { call: admission.call, purpose: 'fact-assessment',
    basis: admission.basis, block: admission.block, gaps: admission.gaps,
    series: admission.series, attempt: admission.attempt, goal: admission.goal,
    dispatch: admission.dispatch, packet: admission.packet as unknown as Json };
  const call = recordCall(store, request.project, callRequest);
  if (!call.ok) return call;
  const firstCall = store.get(call.value.call.id, 1);
  if (!firstCall) return refused('assessment_result_invalid', 'The assessor needs its original E1 admission',
    { unit: 'E5', target: call.value.call.id, field: 'call' }, 'producer');
  const transport = await runModelTransport(store, { project: request.project, call: reference(firstCall),
    packet: admission.packet as unknown as Json, role: 'reviewer' }, signal);
  if (!transport.ok) return transport;
  return applyAssessmentResult(store,
    { project: request.project, intent: intentRef, assessor: reference(transport.value.record) });
}
