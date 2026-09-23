import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { delivered, refused, isPlainObject, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { Ajv } from 'ajv';
import type { DiscoveryDraft, FieldSpec, Question } from '../discovery/discovery.js';
import type { ResearchAnswer, ResearchAssessment } from '../discovery/research-model.js';
import { Evidence, sourceIsCurrent, type Observation, type Source } from '../evidence/evidence.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { readRecord, writeGuarded } from './refs.js';
import { prepareGaps, readGaps, type Gap, type GapReadRequest, type GapRequest } from './gaps.js';
import { readOmInput } from './input.js';
import { gapLineKey, gapLineExpectedResult, type GapLineAttempt } from './gap-lines.js';
import { readSeries, type RepairSeries, type AttemptGoal } from './series.js';
import { factResultKey } from './result-identity.js';
import type { AcceptanceContext, Confirmation } from './achievements.js';

export interface AnswerQuestionContract {
  establishes: string;
  consumer: Json;
  requirements: Json[];
  resultForm: Json;
}

const CONTRACT_FIELDS = Object.freeze(['establishes', 'consumer', 'requirements', 'resultForm'] as const);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function invalid(field: string): never {
  throw new EngineError('answer_contract_invalid', 'An answer needs all four explicit parts of its question contract',
    { unit: 'D5', target: 'question-contract', field });
}

/** Fingerprinting does not establish acceptance or the contract's binding to a saved question. */
export function normalizeAnswerContract(contract: AnswerQuestionContract): Sealed<AnswerQuestionContract> {
  if (!isPlainObject(contract)) invalid('contract');
  for (const field of CONTRACT_FIELDS) if (!Object.hasOwn(contract, field)) invalid(field);
  if (Object.keys(contract).some(field => !(CONTRACT_FIELDS as readonly string[]).includes(field))) invalid('contract');
  if (typeof contract.establishes !== 'string' || contract.establishes.trim().length === 0) invalid('establishes');
  if (!Array.isArray(contract.requirements)) invalid('requirements');
  for (const field of CONTRACT_FIELDS) {
    try { sealed(contract[field]); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'unsealable_value') invalid(field);
      throw error;
    }
  }
  // Only the requirements collection is a set; arrays inside schemas and other values retain their order.
  const requirements = [...contract.requirements].sort((a, b) => order(canonical(a), canonical(b)));
  return sealed({ establishes: contract.establishes, consumer: contract.consumer, requirements, resultForm: contract.resultForm });
}

export function answerContractFingerprint(contract: AnswerQuestionContract): string {
  return hashJson(normalizeAnswerContract(contract));
}

export const MC1_QUESTION_KIND = 'mc1-question';
export const ACCEPTED_ANSWER_KIND = 'accepted-answer';
export const ANSWER_REFUSAL_CODES = Object.freeze([
  'answer_question_invalid', 'answer_unconfirmed', 'answer_record_invalid', 'answer_inapplicable', 'answer_attempt_invalid', 'input_stale',
] as const);
export interface Mc1QuestionRequest {
  project: string; input: Ref; gaps: GapReadRequest; gap: Ref;
  contract: AnswerQuestionContract; requirements: { pointer: string }[];
  engineQuestion: Ref; draft: Ref;
}
export interface Mc1QuestionRecord { project: string; request: Mc1QuestionRequest; fingerprint: string }
export interface AnswerRequest {
  project: string; question: Ref; answer: Ref; answeredQuestion: Ref; draft: Ref; attempt: GapLineAttempt | null;
}
export interface AnswerGround { observation: Observation; state: string; proofLimit: 'repository-observation' | 'quoted-intent-requires-attribution' }
export interface AcceptedAnswerRecord {
  project: string; request: AnswerRequest; target: string; field: string; contract: AnswerQuestionContract;
  fingerprint: string; value: Json; grounds: AnswerGround[];
}
export type AnswerBasis = { record: Ref } | { pending: Write };
export interface AnswerReadRequest { project: string; record: Ref }
export interface AnswerAttempt { series: Ref; ordinal: number; block: string; goal: AttemptGoal }
export interface CheckedAnswer {
  record: Revision<AcceptedAnswerRecord>; question: Revision<Mc1QuestionRecord>; gap: Gap;
  key: string; references: Ref[]; attempt: AnswerAttempt | null;
}
export interface PreparedAnswer {
  record: Revision<AcceptedAnswerRecord>; writes: Write[]; guards: Ref[]; references: Ref[];
  closure: { id: string; reason: 'filled'; basis: Ref; acceptance: null; attempt: GapLineAttempt | null; answer: AnswerBasis };
}
const object = (value: unknown): value is Record<string, any> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sorted = <T>(items: readonly T[]): T[] => [...items].sort((a, b) => order(canonical(a), canonical(b)));
const unique = <T>(items: readonly T[]): T[] => sorted([...new Map(items.map(item => [canonical(item), item])).values()]);
class AnswerFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: string, target: string, field: string, message: string): never {
  const result = refused(code, message, { unit: 'D5', target, field }, 'producer');
  if (!result.ok) throw new AnswerFailure(result.refusal);
  throw new Error('Unreachable refusal');
}
function check(condition: unknown, code: string, target: string, field: string, message: string): asserts condition {
  if (!condition) fail(code, target, field, message);
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new AnswerFailure(result.refusal); return result.value; }
function result<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof AnswerFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function requestInvalid(field: string): never {
  throw new EngineError('answer_request_invalid', 'Answer operations require explicit well-formed arguments', { unit: 'D5', target: 'accepted-answer', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') requestInvalid('json'); throw error; }
}
function requireStore(store: Store): void { if (!(store instanceof Store)) requestInvalid('store'); }
function requireRefRequest(store: Store, value: unknown): asserts value is AnswerReadRequest {
  requireStore(store);
  if (!object(value) || !text(value.project) || !isRef(value.record)) requestInvalid('record');
}
function requireQuestion(value: unknown): asserts value is Mc1QuestionRequest {
  if (!object(value) || !text(value.project) || !isRef(value.input) || !isRef(value.gap)
    || !object(value.gaps) || !object(value.gaps.sources) || !Array.isArray(value.gaps.records)
    || !value.gaps.records.every(isRef) || !isRef(value.engineQuestion) || !isRef(value.draft)
    || !Array.isArray(value.requirements) || !value.requirements.every(item => object(item) && typeof item.pointer === 'string')) requestInvalid('question');
  normalizeAnswerContract(value.contract);
}
function requireAnswer(value: unknown): asserts value is AnswerRequest {
  if (!object(value) || !text(value.project) || !['question', 'answer', 'answeredQuestion', 'draft'].every(key => isRef(value[key]))
    || !(value.attempt === null || object(value.attempt) && isRef(value.attempt.series)
      && Number.isSafeInteger(value.attempt.attempt) && value.attempt.attempt > 0)) requestInvalid('answer');
}
function head(store: Store, ref: Ref): void {
  check(same(store.get(ref.id) ? reference(store.get(ref.id)!) : null, ref), 'input_stale', ref.id, 'reference', 'A current source changed');
}
function exact<T>(store: Store, project: string, ref: Ref, kind: string, prefix = `${kind}:${project}:`): Revision<T> {
  return take(readRecord<T>(store, ref, { unit: 'D5', target: ref.id, kind, idPrefix: prefix })) as Revision<T>;
}
function pointer(value: unknown, path: string, target: string): Json {
  check(path === '' || path.startsWith('/'), 'answer_question_invalid', target, 'requirements.pointer', 'A requirement needs a JSON pointer');
  for (const raw of path === '' ? [] : path.slice(1).split('/')) {
    check(!/~(?![01])/.test(raw), 'answer_question_invalid', target, 'requirements.pointer', 'Malformed pointer escape');
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    check(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'answer_question_invalid', target, 'requirements.pointer', 'The requirement field is absent');
    value = (value as Record<string, unknown>)[key];
  }
  return copy(value) as Json;
}
export function acceptedAnswerNamespace(project: string): string {
  if (!text(project)) requestInvalid('project'); return `om-answer:${project}:`;
}
export function mc1QuestionNamespace(project: string): string {
  if (!text(project)) requestInvalid('project'); return `om-mc1-question:${project}:`;
}
function normalizedQuestion(request: Mc1QuestionRequest): Mc1QuestionRequest {
  return copy({ ...request, requirements: sorted(request.requirements), contract: normalizeAnswerContract(request.contract),
    gaps: { ...request.gaps, records: sorted(request.gaps.records) } }) as Mc1QuestionRequest;
}
/** E2 uses this exact spec before Discovery.create, then persists the issued question's reference. */
export function mc1FieldSpec(input: { input: Ref; gap: Ref; contract: AnswerQuestionContract }): FieldSpec {
  if (!object(input) || !isRef(input.input) || !isRef(input.gap)) requestInvalid('question.spec');
  const contract = normalizeAnswerContract(input.contract);
  return copy({ field: 'answer', kind: 'fact', proof: 'assessment',
    prompt: canonical({ kind: 'MC1', input: input.input, gap: input.gap, contract }),
    risk: 'Unsupported evidence must leave the obligation open', schema: contract.resultForm }) as FieldSpec;
}
function questionContext(store: Store, request: Mc1QuestionRequest, current: boolean) {
  const gaps = take(readGaps(store, request.gaps));
  const gapRecord = gaps.records.find(row => same(reference(row), request.gap));
  check(gaps.sources.project === request.project && same(gaps.sources.input, request.input) && gapRecord,
    'answer_question_invalid', request.gap.id, 'gaps', 'The question must name its exact complete D1 source and OM input');
  const gap = gapRecord.value.gap;
  check(gap.kind === 'repository-fact' && gap.routes.includes('research') && !gap.deferral,
    'answer_question_invalid', gap.target, 'route', 'MC1 requires an active repository fact that admits research');
  const input = take(readOmInput(store, request.project, request.input));
  const sourceQuestion = input.value.input.questions.find(item => item.id === gap.target);
  check(sourceQuestion && gap.field === 'answer' && sourceQuestion.kind === 'repository-fact',
    'answer_question_invalid', gap.target, 'target', 'This fact needs a producer question with a known address and knowledge kind');
  const consumer = { blocks: [...gap.consumers], ...(gap.mechanism ? { mechanism: gap.mechanism } : {}), ...(gap.uses ? { uses: gap.uses } : {}) };
  check(request.contract.establishes === sourceQuestion.question && same(request.contract.consumer, consumer)
    && same(sorted(request.contract.requirements), sorted(request.requirements.map(item => pointer(input.value.input, item.pointer, gap.target)))),
    'answer_question_invalid', gap.target, 'contract', 'The full contract must retain its D1 question, consumers and selected requirements');
  const engine = exact<Question>(store, request.project, request.engineQuestion, 'question');
  const draft = exact<DiscoveryDraft>(store, request.project, request.draft, 'discovery-draft', `discovery:${request.project}:`);
  check(object(engine.value) && engine.value.projectId === request.project && engine.value.status === 'open' && engine.value.answer === null
    && engine.value.draftId === draft.id && object(draft.value) && draft.value.projectId === request.project
    && Array.isArray(draft.value.questions) && same(draft.value.questions, [engine.id]) && Array.isArray(draft.value.inputs)
    && draft.value.inputs.some(ref => same(ref, request.input)) && draft.value.inputs.some(ref => same(ref, request.gap))
    && engine.value.stage === draft.value.stage && engine.value.level === draft.value.level
    && gap.consumers.includes(engine.value.consumer) && engine.value.consumer === draft.value.consumer
    && object(engine.value.spec) && same(engine.value.spec, mc1FieldSpec(request)) && object(draft.value.fields)
    && Object.hasOwn(draft.value.fields, engine.value.spec.field) && hashJson(draft.value.fields[engine.value.spec.field]) === engine.value.beforeHash,
    'answer_question_invalid', gap.target, 'engineQuestion', 'The exact issued engine question and draft must implement this complete OM contract');
  const references = unique([request.input, request.gap, request.engineQuestion, request.draft, ...request.gaps.records]);
  const guards: Ref[] = [];
  if (current) {
    const prepared = take(prepareGaps(store, request.gaps.sources));
    check(same(prepared.collection, gaps.collection), 'answer_question_invalid', gap.target, 'gaps', 'Current D1 must preserve the issued source set');
    guards.push(...prepared.guards, request.input, ...request.gaps.records);
    for (const guard of guards) head(store, guard);
  }
  return { gap: gap as Gap, input, engine, draft, references, guards: unique(guards) };
}
export function prepareMc1Question(store: Store, request: Mc1QuestionRequest): OmResult<Sealed<{ record: Revision<Mc1QuestionRecord>; writes: Write[]; guards: Ref[] }>> {
  requireStore(store); requireQuestion(request); request = normalizedQuestion(request);
  return result(() => {
    const context = questionContext(store, request, true);
    head(store, request.engineQuestion); head(store, request.draft);
    const value: Mc1QuestionRecord = { project: request.project, request, fingerprint: answerContractFingerprint(request.contract) };
    const record = { id: `${mc1QuestionNamespace(request.project)}${hashJson(value)}`, kind: MC1_QUESTION_KIND, revision: 1, hash: hashJson(value), value };
    const old = store.get(record.id);
    check(!old || same(old, record), 'answer_question_invalid', record.id, 'record', 'A question record must preserve its exact issued content');
    return { record, writes: old ? [] : [{ id: record.id, kind: record.kind, expected: 0, value }],
      guards: unique([...context.guards, request.engineQuestion, request.draft, ...(old ? [reference(old)] : [])]) };
  });
}
export function writeMc1Question(store: Store, request: Mc1QuestionRequest): OmResult<Sealed<Revision<Mc1QuestionRecord>>> {
  const prepared = prepareMc1Question(store, request);
  if (!prepared.ok) return prepared;
  if (prepared.value.writes.length) {
    const written = writeGuarded(store, { unit: 'D5', target: prepared.value.record.id, writes: prepared.value.writes, guards: prepared.value.guards });
    if (!written.ok) return written;
  }
  return delivered(prepared.value.record);
}
export function readMc1Question(store: Store, request: AnswerReadRequest): OmResult<Sealed<{ record: Revision<Mc1QuestionRecord>; gap: Gap; references: Ref[] }>> {
  requireRefRequest(store, request);
  return result(() => {
    const record = exact<Mc1QuestionRecord>(store, request.project, request.record, MC1_QUESTION_KIND, mc1QuestionNamespace(request.project));
    check(object(record.value) && record.value.project === request.project && object(record.value.request),
      'answer_question_invalid', record.id, 'record', 'A complete saved MC1 question is required');
    try { requireQuestion(record.value.request); }
    catch (error) { if (error instanceof EngineError && ['answer_request_invalid', 'answer_contract_invalid'].includes(error.code))
      fail('answer_question_invalid', record.id, 'request', 'The saved MC1 question is malformed'); throw error; }
    check(record.value.request.project === request.project && same(record.value.request, normalizedQuestion(record.value.request))
      && record.value.fingerprint === answerContractFingerprint(record.value.request.contract)
      && record.id === `${mc1QuestionNamespace(request.project)}${hashJson(record.value)}` && record.revision === 1,
      'answer_question_invalid', record.id, 'fingerprint', 'The question must preserve its normalized full contract and exact source request');
    const context = questionContext(store, record.value.request, false);
    return { record, gap: context.gap, references: unique([request.record, ...context.references]) };
  });
}
function attemptOf(store: Store, project: string, gap: Gap, link: GapLineAttempt | null, current: boolean): AnswerAttempt | null {
  if (link === null) return null;
  const exactSeries = exact<RepairSeries>(store, project, link.series, 'repair-series');
  check(object(exactSeries.value) && text(exactSeries.value.block) && Number.isSafeInteger(exactSeries.value.line),
    'answer_attempt_invalid', gap.target, 'attempt', 'A fact achievement needs a saved repair series');
  const view = new Proxy(store, { get(target, prop) {
    if (prop === 'get') return (id: string, revision?: number) => id === link.series.id && revision === undefined ? exactSeries : target.get(id, revision);
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const series = take(readSeries(view, { project, block: exactSeries.value.block, line: exactSeries.value.line }));
  const attempt = series.value.attempts.find(item => item.ordinal === link.attempt);
  check(attempt && attempt.outcome === null && gap.consumers.includes(series.value.block)
    && attempt.goal.questions.includes(gapLineKey(project, gap.target, gap.field))
    && attempt.goal.result === gapLineExpectedResult(project, gap.target, gap.field),
    'answer_attempt_invalid', gap.target, 'attempt.goal', 'The fact and its consumer must have been named by the full goal of this running attempt');
  if (current) head(store, link.series);
  return { series: link.series, ordinal: link.attempt, block: series.value.block, goal: attempt.goal as AttemptGoal };
}
function checkedGround(store: Store, project: string, raw: Observation, current: boolean): AnswerGround {
  check(object(raw) && raw.projectId === project && isRef(raw.source) && object(raw.selector) && Object.hasOwn(raw, 'value'),
    'answer_unconfirmed', project, 'observations', 'Each citation needs its exact source, selector and computed value');
  const source = exact<Source>(store, project, raw.source, 'source');
  const value = source.value;
  check(object(value) && value.projectId === project && typeof value.content === 'string' && digest(value.content) === value.sha256
    && ['text/plain', 'application/json'].includes(value.mediaType) && object(value.origin)
    && ['file', 'owner-document'].includes(value.origin.kind) && text(value.origin.location),
    'answer_unconfirmed', raw.source.id, 'source', 'Evidence must retain its project, origin and content digest');
  if (value.mediaType === 'application/json') {
    try { JSON.parse(value.content); }
    catch (error) { if (error instanceof SyntaxError) fail('answer_unconfirmed', source.id, 'source.content', 'The captured JSON source is malformed'); throw error; }
  }
  // Historical reads use the same Evidence selector against saved bytes, without consulting today's filesystem.
  const historicalSource = { ...source, value: { ...value, origin: { kind: 'owner-document' as const, location: value.origin.location } } };
  const view = new Proxy(store, { get(target, prop) {
    if (prop === 'get') return (id: string, revision?: number) => id === source.id ? historicalSource : target.get(id, revision);
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  let observation: Observation;
  try { observation = new Evidence(view).observe(project, raw.source, raw.selector); }
  catch (error) {
    if (error instanceof EngineError && ['selector_invalid', 'evidence_missing', 'evidence_input_invalid'].includes(error.code))
      fail('answer_unconfirmed', source.id, 'selector', 'The citation does not resolve against its saved source');
    throw error;
  }
  check(same(observation, raw), 'answer_unconfirmed', source.id, 'observation.value', 'Evidence value must be derived from the exact citation');
  if (current) {
    head(store, raw.source);
    check(sourceIsCurrent(value), 'answer_inapplicable', source.id, 'source', 'The captured source no longer describes the current file');
  }
  return { observation, state: value.sha256, proofLimit: value.origin.kind === 'file' ? 'repository-observation' : 'quoted-intent-requires-attribution' };
}
function deriveAnswer(store: Store, request: AnswerRequest, current: boolean) {
  const q = take(readMc1Question(store, { project: request.project, record: request.question }));
  const context = questionContext(store, q.record.value.request as Mc1QuestionRequest, current);
  const answer = exact<ResearchAnswer>(store, request.project, request.answer, 'research-answer');
  const answered = exact<Question>(store, request.project, request.answeredQuestion, 'question');
  const draft = exact<DiscoveryDraft>(store, request.project, request.draft, 'discovery-draft', `discovery:${request.project}:`);
  check(object(answer.value) && answer.value.projectId === request.project && answer.value.question === context.engine.id && isRef(answer.value.assessment)
    && Object.hasOwn(answer.value, 'value'), 'answer_unconfirmed', answer.id, 'answer', 'The native answer must belong to this exact issued question');
  const assessment = exact<ResearchAssessment>(store, request.project, answer.value.assessment, 'research-assessment', 'research-assessment:');
  check(object(assessment.value) && assessment.value.projectId === request.project && same(assessment.value.question, reference(context.engine))
    && assessment.value.verdict === 'supported' && text(assessment.value.researcher) && text(assessment.value.assessor)
    && assessment.value.researcher !== assessment.value.assessor && Array.isArray(assessment.value.observations) && assessment.value.observations.length > 0
    && Object.hasOwn(assessment.value, 'value') && same(assessment.value.value, answer.value.value) && isRef(assessment.value.environment),
    'answer_unconfirmed', assessment.id, 'assessment', 'The exact question and value need an independent supported assessment');
  const environment = take(readRecord<Record<string, any>>(store, assessment.value.environment, { unit: 'D5', target: assessment.id, id: `environment:${request.project}`, kind: 'environment' }));
  check(object(environment.value) && environment.value.projectId === request.project && object(environment.value.implementer) && object(environment.value.reviewer)
    && environment.value.implementer.actor === assessment.value.researcher && environment.value.reviewer.actor === assessment.value.assessor,
    'answer_unconfirmed', assessment.id, 'roles', 'The roles must match the saved assessment environment');
  check(answered.id === context.engine.id && answered.revision === context.engine.revision + 1
    && same(answered.value, { ...context.engine.value, status: 'answered', answer: request.answer })
    && draft.id === context.draft.id && draft.revision === context.draft.revision + 1
    && same(draft.value, { ...context.draft.value, fields: { ...context.draft.value.fields, [context.engine.value.spec.field]: answer.value.value } }),
    'answer_unconfirmed', answer.id, 'acceptance', 'Acceptance must bind the issued question, exact answer and resulting draft field');
  const schema = q.record.value.request.contract.resultForm;
  const validator = new Ajv({ strict: true, allowUnionTypes: true });
  check(validator.validateSchema(schema as object), 'answer_question_invalid', q.record.id, 'resultForm', 'The question must contain a valid result schema');
  const valid = validator.compile(schema as object)(answer.value.value);
  check(valid, 'answer_unconfirmed', answer.id, 'value', 'The fact value must match the saved result form');
  const grounds = sorted(assessment.value.observations.map(raw => checkedGround(store, request.project, raw, current)));
  const attempt = attemptOf(store, request.project, context.gap, request.attempt, current);
  const value: AcceptedAnswerRecord = { project: request.project, request, target: context.gap.target, field: context.gap.field,
    contract: q.record.value.request.contract as AnswerQuestionContract, fingerprint: q.record.value.fingerprint, value: answer.value.value, grounds };
  const references = unique([...q.references, request.answer, request.answeredQuestion, request.draft, answer.value.assessment,
    assessment.value.environment, ...grounds.map(item => item.observation.source), ...(attempt ? [attempt.series] : [])]);
  const guards = unique([...context.guards, request.question, request.answer, request.answeredQuestion, request.draft, answer.value.assessment,
    assessment.value.environment, ...grounds.map(item => item.observation.source), ...(attempt ? [attempt.series] : [])]);
  if (current) for (const guard of guards) head(store, guard);
  return { value, references, guards, question: q.record as Revision<Mc1QuestionRecord>, gap: context.gap, attempt };
}
function predicted(value: AcceptedAnswerRecord): Revision<AcceptedAnswerRecord> {
  return { id: `${acceptedAnswerNamespace(value.project)}${hashJson(value.request)}`, kind: ACCEPTED_ANSWER_KIND,
    revision: 1, hash: hashJson(value), value };
}
function loadAnswer(store: Store, request: AnswerReadRequest): CheckedAnswer {
  const record = exact<AcceptedAnswerRecord>(store, request.project, request.record, ACCEPTED_ANSWER_KIND, acceptedAnswerNamespace(request.project));
  check(object(record.value) && record.value.project === request.project && object(record.value.request),
    'answer_record_invalid', record.id, 'record', 'An accepted fact must retain its source request');
  try { requireAnswer(record.value.request); }
  catch (error) { if (error instanceof EngineError && error.code === 'answer_request_invalid') fail('answer_record_invalid', record.id, 'request', 'The saved answer request is malformed'); throw error; }
  check(record.value.request.project === request.project, 'answer_record_invalid', record.id, 'project', 'The source request belongs to this project');
  const derived = deriveAnswer(store, record.value.request, false);
  check(same(record, predicted(derived.value)), 'answer_record_invalid', record.id, 'content', 'Acceptance must be rederived from its exact saved sources');
  return { record, question: derived.question, gap: derived.gap, attempt: derived.attempt,
    key: factResultKey({ project: request.project, target: record.value.target, field: record.value.field, contract: record.value.contract, value: record.value.value }),
    references: unique([request.record, ...derived.references]) };
}
export function readAcceptedAnswer(store: Store, request: AnswerReadRequest): OmResult<Sealed<CheckedAnswer>> {
  requireRefRequest(store, request); return result(() => loadAnswer(store, request));
}
export function prepareAcceptedAnswer(store: Store, request: AnswerRequest): OmResult<Sealed<PreparedAnswer>> {
  requireStore(store); requireAnswer(request); request = copy(request);
  return result(() => {
    const checked = deriveAnswer(store, request, true), record = predicted(checked.value), old = store.get(record.id);
    check(!old || same(old, record), 'answer_record_invalid', record.id, 'record', 'A fact acceptance cannot be overwritten under the same source request');
    const write: Write = { id: record.id, kind: record.kind, expected: 0, value: record.value };
    return { record, writes: old ? [] : [write], guards: unique([...checked.guards, ...(old ? [reference(old)] : [])]), references: checked.references,
      closure: { id: checked.gap.id, reason: 'filled' as const, basis: reference(record), acceptance: null, attempt: request.attempt,
        answer: old ? { record: reference(record) } : { pending: write } } };
  });
}
export function writeAcceptedAnswer(store: Store, request: AnswerRequest): OmResult<Sealed<Revision<AcceptedAnswerRecord>>> {
  const prepared = prepareAcceptedAnswer(store, request);
  if (!prepared.ok) return prepared;
  if (prepared.value.writes.length) {
    const written = writeGuarded(store, { unit: 'D5', target: prepared.value.record.id, writes: prepared.value.writes, guards: prepared.value.guards });
    if (!written.ok) return written;
  }
  return delivered(prepared.value.record);
}
export function applicableAnswer(store: Store, request: { project: string; record: Ref; question: Ref }): OmResult<Sealed<{ applicable: boolean; guards: Ref[]; references: Ref[] }>> {
  requireRefRequest(store, request); if (!isRef(request.question)) requestInvalid('question');
  return result(() => {
    const old = loadAnswer(store, request), current = take(readMc1Question(store, { project: request.project, record: request.question }));
    const context = questionContext(store, current.record.value.request as Mc1QuestionRequest, true);
    const equivalent = old.record.value.target === current.gap.target && old.record.value.field === current.gap.field
      && same(old.record.value.contract, current.record.value.request.contract);
    let sourcesCurrent = true;
    for (const ground of old.record.value.grounds) {
      const ref = ground.observation.source, source = exact<Source>(store, request.project, ref, 'source');
      if (!same(store.get(ref.id) ? reference(store.get(ref.id)!) : null, ref) || !sourceIsCurrent(source.value)) sourcesCurrent = false;
    }
    return { applicable: equivalent && sourcesCurrent, guards: unique([...context.guards, request.record, request.question,
      ...old.record.value.grounds.map(item => item.observation.source)]), references: unique([...old.references, ...current.references]) };
  });
}
export function confirmAcceptedAnswerResult(record: Sealed<Revision<Json>>, context: AcceptanceContext, store: Store): Confirmation {
  requireStore(store);
  if (!object(record) || !isRef(record) || !text(record.kind) || !Object.hasOwn(record, 'value')
    || !object(context) || !text(context.project) || !text(context.block) || !object(context.goal)
    || !text(context.goal.key) || !text(context.goal.result) || !Array.isArray(context.goal.questions)
    || !context.goal.questions.every(text)) requestInvalid('confirmation');
  context = copy(context);
  const checked = readAcceptedAnswer(store, { project: context.project, record: reference(record) });
  if (!checked.ok) return { unconfirmed: `${checked.refusal.code}: ${checked.refusal.message}` };
  const attempt = checked.value.attempt;
  if (!attempt || attempt.block !== context.block || !same({ ...attempt.goal, questions: sorted(attempt.goal.questions) },
    { ...context.goal, questions: sorted(context.goal.questions) })) return { unconfirmed: 'The fact does not belong to this previously recorded full attempt goal' };
  return { keys: [checked.value.key] };
}

export interface AnswerGapClosureRequest {
  project: string; basis: AnswerBasis; target: string; field: string; prior: GapReadRequest; current: GapReadRequest;
  attempt: GapLineAttempt | null; currentOnly: boolean;
}
function basisView(store: Store, basis: AnswerBasis): { store: Store; ref: Ref; writes: Write[] } {
  check(object(basis) && (Object.hasOwn(basis, 'record') !== Object.hasOwn(basis, 'pending')),
    'answer_record_invalid', 'accepted-answer', 'basis', 'An answer basis names either a saved or a pending record');
  if ('record' in basis) {
    check(isRef(basis.record), 'answer_record_invalid', 'accepted-answer', 'basis.record', 'An exact answer reference is required');
    return { store, ref: basis.record, writes: [] };
  }
  const write = basis.pending;
  check(object(write) && text(write.id) && write.kind === ACCEPTED_ANSWER_KIND && write.expected === 0 && object(write.value),
    'answer_record_invalid', 'accepted-answer', 'basis.pending', 'A pending fact uses the same immutable accepted-answer record contract');
  const row = { id: write.id, kind: write.kind, value: copy(write.value), revision: 1, hash: hashJson(write.value) };
  const old = store.get(write.id);
  check(!old || same(old, row), 'answer_record_invalid', row.id, 'basis.pending', 'A pending basis conflicts with existing content');
  const view = new Proxy(store, { get(target, prop) {
    if (prop === 'get') return (id: string, revision?: number) => id === row.id && (revision === undefined || revision === 1) ? row : target.get(id, revision);
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  return { store: view, ref: reference(row), writes: old ? [] : [write] };
}
export function confirmAnswerGapClosure(store: Store, request: AnswerGapClosureRequest): OmResult<Sealed<{
  key: string; references: Ref[]; guards: Ref[]; writes: Write[]; attempt: AnswerAttempt | null;
}>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !text(request.target) || !text(request.field)
    || !object(request.prior) || !object(request.current) || typeof request.currentOnly !== 'boolean'
    || !(request.attempt === null || object(request.attempt) && isRef(request.attempt.series)
      && Number.isSafeInteger(request.attempt.attempt) && request.attempt.attempt > 0)) requestInvalid('closure');
  request = copy(request);
  return result(() => {
    const view = basisView(store, request.basis), checked = loadAnswer(view.store, { project: request.project, record: view.ref });
    const old = take(readGaps(store, request.prior)), now = take(readGaps(store, request.current));
    const gap = old.collection.gaps.find(item => item.target === request.target && item.field === request.field);
    check(old.sources.project === request.project && now.sources.project === request.project && gap
      && checked.record.value.target === gap.target && checked.record.value.field === gap.field
      && same(gap.consumers, checked.gap.consumers) && gap.kind === checked.gap.kind,
      'answer_unconfirmed', request.target, 'closure.prior', 'The fact must belong to the same line and verified prior D1 consumer contract');
    check(!now.collection.gaps.some(item => item.target === request.target && item.field === request.field),
      'answer_inapplicable', request.target, 'closure.current', 'An active gap cannot close before its producer applies the answer');
    const q = checked.question.value.request;
    for (const ref of [old.sources.input, now.sources.input]) {
      const input = take(readOmInput(store, request.project, ref));
      const sourceQuestion = input.value.input.questions.find(item => item.id === request.target);
      check(sourceQuestion && sourceQuestion.question === q.contract.establishes && sourceQuestion.kind === 'repository-fact'
        && same(sorted(q.contract.requirements), sorted(q.requirements.map(item => pointer(input.value.input, item.pointer, request.target)))),
        'answer_inapplicable', request.target, 'closure.contract', 'The saved D1 input must prove the same question and essential conditions; an applied-field producer must supply any replacement binding');
    }
    check(same(request.attempt, checked.record.value.request.attempt), 'answer_attempt_invalid', request.target, 'closure.attempt',
      'A line may not reattribute a fact to a different attempt');
    const guards: Ref[] = [];
    if (request.currentOnly) {
      const prepared = take(prepareGaps(store, now.sources as GapRequest));
      check(same(prepared.collection, now.collection), 'answer_inapplicable', request.target, 'closure.current', 'The closing D1 source must be current');
      guards.push(...prepared.guards, now.sources.input, ...request.current.records);
      for (const ground of checked.record.value.grounds) {
        checkedGround(store, request.project, ground.observation as Observation, true); guards.push(ground.observation.source);
      }
      if (checked.attempt) { head(store, checked.attempt.series); guards.push(checked.attempt.series); }
      if (!view.writes.length) guards.push(view.ref);
      else {
        const acceptance = deriveAnswer(view.store, checked.record.value.request, false);
        for (const guard of acceptance.guards) { head(store, guard); guards.push(guard); }
      }
    }
    return { key: checked.key, references: unique([...checked.references, ...request.prior.records, ...request.current.records]),
      guards: unique(guards), writes: view.writes, attempt: checked.attempt };
  });
}
