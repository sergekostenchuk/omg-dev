import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { delivered, refused, isPlainObject, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { Ajv, MissingRefError } from 'ajv';
import { basename, dirname } from 'node:path';
import type { DiscoveryDraft, FieldSpec, Question } from '../discovery/discovery.js';
import type { ResearchAnswer, ResearchAssessment } from '../discovery/research-model.js';
import { Evidence, sourceIsCurrent, type Observation, type Selector, type Source } from '../evidence/evidence.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { readRecord, writeGuarded } from './refs.js';
import { prepareCurrentGaps, readGaps, type Gap, type GapReadRequest } from './gaps.js';
import { historicalRead, withHistoricalReads, prepareExistingOmInput, readOmInput, type OmInput, type OmInputRecord } from './input.js';
import { gapLineKey, gapLineExpectedResult, type GapLineAttempt } from './gap-lines.js';
import { readAnySeriesAt, readSeries, prepareSeriesLineAdmission, type RepairSeries, type AttemptGoal } from './series.js';
import { factResultKey } from './result-identity.js';
import type { AcceptanceContext, Confirmation } from './achievements.js';
import { assessmentResultId, checkCurrentAssessmentAttemptClosure,
  readAssessmentOutcomeAt, readAssessmentTerminalBasisAt } from './assessment.js';

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
export const ANSWER_TASK_KIND = 'answer-task';
export const ANSWER_INDEX_KIND = 'answer-index';
export const ANSWER_REFUSAL_CODES = Object.freeze([
  'answer_question_invalid', 'answer_unconfirmed', 'answer_record_invalid', 'answer_inapplicable', 'answer_attempt_invalid', 'input_stale',
] as const);
export interface Mc1QuestionRequest {
  project: string; input: Ref; gaps: GapReadRequest; gap: Ref;
  contract: AnswerQuestionContract; requirements: { pointer: string }[];
  engineQuestion: Ref; draft: Ref;
  task?: Ref;
}
export interface AnswerTaskRequest {
  project: string; input: Ref; gaps: GapReadRequest; gap: Ref;
  requirements: { pointer: string }[]; resultForm: Json;
}
export interface AnswerTaskRecord { project: string; request: AnswerTaskRequest; contract: AnswerQuestionContract; fingerprint: string }
export type AnswerTaskBasis = { record: Ref } | { pending: Write };
export interface CheckedAnswerTask {
  request: AnswerTaskRequest; record: Revision<AnswerTaskRecord>; contract: AnswerQuestionContract; gap: Gap;
  references: Ref[]; guards: Ref[]; writes: Write[];
}
export interface Mc1QuestionRecord { project: string; request: Mc1QuestionRequest; fingerprint: string }
export interface AnswerRequest {
  project: string; question: Ref; answer: Ref; answeredQuestion: Ref; draft: Ref; attempt: GapLineAttempt | null;
}
export interface E5AnswerRequest { project: string; intent: Ref; assessor: Ref }
export const ANSWER_GROUNDS_ERA = 'citation-v2';
type GroundsEra = typeof ANSWER_GROUNDS_ERA | 'legacy';
export interface AnswerCitation { source: Ref; selector: Selector }
export interface AnswerCitationsRequest { project: string; citations: AnswerCitation[] }
export interface AnswerGround { observation: Observation; state: string; proofLimit: 'repository-observation' | 'reported-not-runtime-proof' | 'quoted-intent-requires-attribution' }
export interface NativeAcceptedAnswerRecord {
  project: string; request: AnswerRequest; target: string; field: string; contract: AnswerQuestionContract;
  fingerprint: string; value: Json; grounds: AnswerGround[]; groundsEra?: typeof ANSWER_GROUNDS_ERA;
}
export interface E5AcceptedAnswerRecord {
  project: string; producer: 'E5'; request: E5AnswerRequest; assessment: Ref;
  target: string; field: string; contract: AnswerQuestionContract; fingerprint: string;
  value: Json; grounds: AnswerGround[]; groundsEra: typeof ANSWER_GROUNDS_ERA;
}
export type AcceptedAnswerRecord = NativeAcceptedAnswerRecord | E5AcceptedAnswerRecord;
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
export type PreparedNativeAnswer = Omit<PreparedAnswer, 'record'> & { record: Revision<NativeAcceptedAnswerRecord> };
export type PreparedE5Answer = Omit<PreparedAnswer, 'record'> & { record: Revision<E5AcceptedAnswerRecord> };
export interface AnswerInvalidation { record: Ref; sources: { before: Ref; after: Ref }[] }
export interface AnswerIndex { project: string; target: string; field: string; answers: Ref[]; previous: Ref | null }
export interface PreparedAnswerSearch { record: Revision<AnswerIndex>; answers: Ref[]; writes: Write[]; guards: Ref[]; references: Ref[] }
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
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof AnswerFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
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
    || !Array.isArray(value.requirements) || !value.requirements.every(item => object(item) && typeof item.pointer === 'string')
    || Object.hasOwn(value, 'task') && !isRef(value.task)) requestInvalid('question');
  normalizeAnswerContract(value.contract);
}
function requireTask(value: unknown): asserts value is AnswerTaskRequest {
  if (!object(value) || !text(value.project) || !isRef(value.input) || !isRef(value.gap)
    || !object(value.gaps) || !object(value.gaps.sources) || !Array.isArray(value.gaps.records) || !value.gaps.records.every(isRef)
    || !Array.isArray(value.requirements) || !value.requirements.every(item => object(item) && typeof item.pointer === 'string')
    || !Object.hasOwn(value, 'resultForm') || value.resultForm === undefined) requestInvalid('task');
}
function requireAnswer(value: unknown): asserts value is AnswerRequest {
  if (!object(value) || !text(value.project) || !['question', 'answer', 'answeredQuestion', 'draft'].every(key => isRef(value[key]))
    || !(value.attempt === null || object(value.attempt) && isRef(value.attempt.series)
      && Number.isSafeInteger(value.attempt.attempt) && value.attempt.attempt > 0)) requestInvalid('answer');
}
function requireE5Answer(value: unknown): asserts value is E5AnswerRequest {
  if (!object(value) || !text(value.project) || !isRef(value.intent) || !isRef(value.assessor)
    || Object.keys(value).some(key => !['project', 'intent', 'assessor'].includes(key))) requestInvalid('e5-answer');
}
function head(store: Store, ref: Ref): void {
  check(same(store.get(ref.id) ? reference(store.get(ref.id)!) : null, ref), 'input_stale', ref.id, 'reference', 'A current source changed');
}
function exact<T>(store: Store, project: string, ref: Ref, kind: string, prefix = `${kind}:${project}:`): Revision<T> {
  return take(readRecord<T>(store, ref, { unit: 'D5', target: ref.id, kind, idPrefix: prefix })) as Revision<T>;
}
type PointerValue = { present: false } | { present: true; value: Json };
function selectPointer(value: unknown, path: string, target: string): PointerValue {
  check(path === '' || path.startsWith('/'), 'answer_question_invalid', target, 'requirements.pointer', 'A requirement needs a JSON pointer');
  const keys = (path === '' ? [] : path.slice(1).split('/')).map(raw => {
    check(!/~(?![01])/.test(raw), 'answer_question_invalid', target, 'requirements.pointer', 'Malformed pointer escape');
    return raw.replaceAll('~1', '/').replaceAll('~0', '~');
  });
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { present: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { present: true, value: copy(value) as Json };
}
function pointer(value: unknown, path: string, target: string): Json {
  const selected = selectPointer(value, path, target);
  check(selected.present, 'answer_question_invalid', target, 'requirements.pointer', 'The requirement field is absent');
  return selected.value;
}
export function acceptedAnswerNamespace(project: string): string {
  if (!text(project)) requestInvalid('project'); return `om-answer:${project}:`;
}
export function mc1QuestionNamespace(project: string): string {
  if (!text(project)) requestInvalid('project'); return `om-mc1-question:${project}:`;
}
export function answerTaskNamespace(project: string): string {
  if (!text(project)) requestInvalid('project'); return `om-answer-task:${project}:`;
}
function normalizedTask(request: AnswerTaskRequest): AnswerTaskRequest {
  return copy({ project: request.project, input: request.input, gaps: { ...request.gaps, records: sorted(request.gaps.records) },
    gap: request.gap, requirements: sorted(request.requirements), resultForm: request.resultForm });
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
function taskRequestForQuestion(request: Mc1QuestionRequest): AnswerTaskRequest {
  return normalizedTask({ project: request.project, input: request.input, gaps: request.gaps, gap: request.gap,
    requirements: request.requirements, resultForm: request.contract.resultForm });
}
function checkResultForm(schema: Json, target: string): void {
  check(typeof schema === 'boolean' || object(schema), 'answer_question_invalid', target, 'resultForm', 'The result schema must be an object or boolean');
  const validator = new Ajv({ strict: true, allowUnionTypes: true });
  try {
    check(validator.validateSchema(schema as object), 'answer_question_invalid', target, 'resultForm', 'The producer task must specify a valid result schema');
    validator.compile(schema as object);
  } catch (error) {
    if (error instanceof MissingRefError || error instanceof SyntaxError || error instanceof Error && error.constructor === Error)
      fail('answer_question_invalid', target, 'resultForm', 'The producer task must specify a supported result schema');
    throw error;
  }
}
function taskContext(store: Store, request: AnswerTaskRequest) {
  const gaps = take(historicalRead(store, { reader: 'D5.question-gaps', project: request.project, ref: request.input,
    parameters: request.gaps as unknown as Json }, () => readGaps(store, request.gaps),
  () => fail('answer_question_invalid', request.gap.id, 'history', 'The producer task has cyclic gap sources')));
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
  const consumer = { blocks: [...gap.consumers], ...(gap.mechanism ? { mechanism: gap.mechanism } : {}), ...(gap.uses ? { uses: [...gap.uses] } : {}) };
  checkResultForm(request.resultForm, gap.target);
  const contract = normalizeAnswerContract({ establishes: sourceQuestion.question, consumer,
    requirements: request.requirements.map(item => pointer(input.value.input, item.pointer, gap.target)), resultForm: request.resultForm }) as AnswerQuestionContract;
  return { gap: gap as Gap, input, contract, references: unique([request.input, request.gap, ...request.gaps.records]), collection: gaps.collection, guards: [] as Ref[] };
}
function questionContext(store: Store, request: Mc1QuestionRequest) {
  const taskRequest = taskRequestForQuestion(request);
  const task = request.task ? loadAnswerTask(store, { project: request.project, record: request.task }) : null;
  check(!task || same(task.request, taskRequest), 'answer_question_invalid', request.gap.id, 'task', 'The issued MC1 question must preserve its exact producer task');
  const context = task?.context ?? taskContext(store, taskRequest), gap = context.gap;
  check(same(request.contract, context.contract), 'answer_question_invalid', gap.target, 'contract',
    'The full contract must retain its D1 question, consumers and selected requirements');
  const engine = exact<Question>(store, request.project, request.engineQuestion, 'question');
  const draft = exact<DiscoveryDraft>(store, request.project, request.draft, 'discovery-draft', `discovery:${request.project}:`);
  check(object(engine.value) && engine.value.projectId === request.project && engine.value.status === 'open' && engine.value.answer === null
    && engine.value.draftId === draft.id && object(draft.value) && draft.value.projectId === request.project
    && Array.isArray(draft.value.questions) && same(draft.value.questions, [engine.id]) && Array.isArray(draft.value.inputs)
    && draft.value.inputs.some(ref => same(ref, request.input)) && draft.value.inputs.some(ref => same(ref, request.gap))
    && (!request.task || draft.value.inputs.some(ref => same(ref, request.task)))
    && engine.value.stage === draft.value.stage && engine.value.level === draft.value.level
    && gap.consumers.includes(engine.value.consumer) && engine.value.consumer === draft.value.consumer
    && object(engine.value.spec) && same(engine.value.spec, mc1FieldSpec(request)) && object(draft.value.fields)
    && Object.hasOwn(draft.value.fields, engine.value.spec.field) && hashJson(draft.value.fields[engine.value.spec.field]) === engine.value.beforeHash,
    'answer_question_invalid', gap.target, 'engineQuestion', 'The exact issued engine question and draft must implement this complete OM contract');
  const references = unique([...context.references, request.engineQuestion, request.draft, ...(request.task ? [request.task] : [])]);
  return { ...context, engine, draft, references };
}
function currentTaskGuards(store: Store, request: AnswerTaskRequest): Ref[] {
  const prepared = take(prepareCurrentGaps(store, request.gaps));
  const guards = unique([...prepared.guards, request.input, ...request.gaps.records]);
  for (const guard of guards) head(store, guard);
  return guards;
}
function currentQuestionContext(store: Store, request: Mc1QuestionRequest, context: ReturnType<typeof questionContext>) {
  const guards = currentTaskGuards(store, taskRequestForQuestion(request));
  if (request.task) { head(store, request.task); guards.push(request.task); }
  return { ...context, guards: unique(guards) };
}
function predictedTask(request: AnswerTaskRequest, contract: AnswerQuestionContract): Revision<AnswerTaskRecord> {
  const value = { project: request.project, request, contract, fingerprint: answerContractFingerprint(contract) };
  return { id: `${answerTaskNamespace(request.project)}${hashJson(request)}`, kind: ANSWER_TASK_KIND, revision: 1, hash: hashJson(value), value };
}
function checkTaskRecord(store: Store, project: string, record: Revision<AnswerTaskRecord>) {
  check(record.kind === ANSWER_TASK_KIND && record.id.startsWith(answerTaskNamespace(project))
    && object(record.value) && record.value.project === project && object(record.value.request),
    'answer_question_invalid', record.id, 'task', 'A producer task must preserve its complete source request');
  try { requireTask(record.value.request); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'answer_request_invalid')
      fail('answer_question_invalid', record.id, 'task', 'The saved producer task is incomplete');
    throw error;
  }
  const normalized = normalizedTask(record.value.request);
  check(normalized.project === project && same(normalized, record.value.request),
    'answer_question_invalid', record.id, 'task', 'The saved task must preserve its normalized project and complete sources');
  const context = taskContext(store, normalized);
  check(same(record, predictedTask(normalized, context.contract)), 'answer_question_invalid', record.id, 'task',
    'The producer task and full contract must be derived from their exact sources');
  return copy({ request: normalized, record, contract: context.contract, gap: context.gap,
    references: unique([reference(record), ...context.references]), context });
}
function loadAnswerTask(store: Store, request: AnswerReadRequest) {
  return historicalRead(store, { reader: 'D5.answer-task', project: request.project, ref: request.record }, () => {
    const record = exact<AnswerTaskRecord>(store, request.project, request.record, ANSWER_TASK_KIND, answerTaskNamespace(request.project));
    return checkTaskRecord(store, request.project, record);
  }, () => fail('answer_question_invalid', request.record.id, 'history', 'The producer task has cyclic historical sources'));
}
export function prepareAnswerTask(store: Store, request: AnswerTaskRequest): OmResult<Sealed<CheckedAnswerTask>> {
  requireStore(store); requireTask(request); request = normalizedTask(request);
  return result(() => {
    const context = taskContext(store, request), guards = currentTaskGuards(store, request);
    const record = predictedTask(request, context.contract), old = store.get(record.id);
    check(!old || same(old, record), 'answer_question_invalid', record.id, 'task', 'The producer task cannot be overwritten under the same source request');
    return { request, record, contract: context.contract, gap: context.gap,
      references: unique([reference(record), ...context.references]),
      guards: unique([...guards, ...(old ? [reference(old)] : [])]),
      writes: old ? [] : [{ id: record.id, kind: record.kind, expected: 0, value: record.value }] };
  });
}
export function writeAnswerTask(store: Store, request: AnswerTaskRequest): OmResult<Sealed<Revision<AnswerTaskRecord>>> {
  return withHistoricalReads(() => {
    const prepared = prepareAnswerTask(store, request);
    if (!prepared.ok) return prepared;
    if (prepared.value.writes.length) {
      const written = writeGuarded(store, { unit: 'D5', target: prepared.value.record.id, writes: prepared.value.writes, guards: prepared.value.guards });
      if (!written.ok) return written;
    }
    return delivered(prepared.value.record);
  });
}
export function readAnswerTask(store: Store, request: AnswerReadRequest): OmResult<Sealed<CheckedAnswerTask>> {
  requireRefRequest(store, request);
  return result(() => {
    const { context: _context, ...checked } = loadAnswerTask(store, request);
    return { ...checked, guards: [], writes: [] };
  });
}
function answerTaskBasis(store: Store, project: string, task: AnswerTaskBasis) {
  check(object(task) && (Object.hasOwn(task, 'record') !== Object.hasOwn(task, 'pending')),
    'answer_question_invalid', 'answer-task', 'task', 'The task basis must name a saved or pending producer task');
  if ('record' in task) {
    check(isRef(task.record), 'answer_question_invalid', 'answer-task', 'task.record', 'The producer task needs an exact saved reference');
    return { checked: loadAnswerTask(store, { project, record: task.record }), writes: [] as Write[] };
  }
  const write = task.pending;
  check(object(write) && text(write.id) && write.kind === ANSWER_TASK_KIND && write.expected === 0 && object(write.value),
    'answer_question_invalid', 'answer-task', 'task.pending', 'A pending task uses the immutable producer task contract');
  const row = { id: write.id, kind: write.kind, value: copy(write.value), revision: 1, hash: hashJson(write.value) };
  const old = store.get(row.id);
  check(!old || same(old, row), 'answer_question_invalid', row.id, 'task.pending', 'A pending task conflicts with an existing record');
  if (old) return { checked: loadAnswerTask(store, { project, record: reference(old) }), writes: [] as Write[] };
  const checked = historicalRead(store, { reader: 'D5.answer-task-pending', project, ref: reference(row), parameters: copy(write) as unknown as Json },
    () => checkTaskRecord(store, project, row as Revision<AnswerTaskRecord>),
    () => fail('answer_question_invalid', row.id, 'history', 'The pending producer task has cyclic sources'));
  return { checked, writes: [write] };
}
export function readAnswerTaskBasis(store: Store, request: { project: string; task: AnswerTaskBasis; current: boolean }): OmResult<Sealed<CheckedAnswerTask>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !object(request.task) || typeof request.current !== 'boolean') requestInvalid('task');
  request = copy(request);
  return result(() => {
    const basis = answerTaskBasis(store, request.project, request.task), checked = basis.checked;
    const guards = request.current ? currentTaskGuards(store, checked.request) : [];
    if (request.current && !basis.writes.length) { head(store, reference(checked.record)); guards.push(reference(checked.record)); }
    const { context: _context, ...answerTask } = checked;
    return { ...answerTask, guards: unique(guards), writes: basis.writes };
  });
}
export function prepareMc1Question(store: Store, request: Mc1QuestionRequest): OmResult<Sealed<{ record: Revision<Mc1QuestionRecord>; writes: Write[]; guards: Ref[] }>> {
  requireStore(store); requireQuestion(request); request = normalizedQuestion(request);
  return result(() => {
    const context = currentQuestionContext(store, request, questionContext(store, request));
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
  return withHistoricalReads(() => {
    const prepared = prepareMc1Question(store, request);
    if (!prepared.ok) return prepared;
    if (prepared.value.writes.length) {
      const written = writeGuarded(store, { unit: 'D5', target: prepared.value.record.id, writes: prepared.value.writes, guards: prepared.value.guards });
      if (!written.ok) return written;
    }
    return delivered(prepared.value.record);
  });
}
function loadMc1Question(store: Store, request: AnswerReadRequest) {
  return historicalRead(store, { reader: 'D5.mc1-question', project: request.project, ref: request.record }, () => {
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
    const context = questionContext(store, record.value.request);
    return copy({ record, gap: context.gap, references: unique([request.record, ...context.references]), context });
  }, () => fail('answer_question_invalid', request.record.id, 'history', 'The saved MC1 question has cyclic historical sources'));
}
export function readMc1Question(store: Store, request: AnswerReadRequest): OmResult<Sealed<{ record: Revision<Mc1QuestionRecord>; gap: Gap; references: Ref[] }>> {
  requireRefRequest(store, request);
  return result(() => {
    const { record, gap, references } = loadMc1Question(store, request);
    return { record, gap, references };
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
function citationGround(store: Store, project: string, citation: AnswerCitation, era: GroundsEra) {
  if (era !== 'legacy') {
    const selector = citation.selector;
    check(selector.kind === 'json-pointer' && Object.keys(selector).every(key => ['kind', 'pointer'].includes(key))
      || selector.kind === 'text-range' && Object.keys(selector).every(key => ['kind', 'start', 'end'].includes(key)),
    'answer_unconfirmed', citation.source.id, 'selector', 'A citation must contain only its standard selector fields');
  }
  return historicalRead(store, { reader: 'D5.citation', project, ref: citation.source,
    parameters: { selector: citation.selector, era } as unknown as Json }, () => {
    const source = checkedSource(store, project, citation.source), value = source.value;
    // Only saved bytes are projected into Evidence's standard selector. This is not current admission.
    const historicalSource = { ...source, value: { ...value, origin: { kind: 'owner-document' as const, location: value.origin.location } } };
    const view = new Proxy(store, { get(target, prop) {
      if (prop === 'get') return (id: string, revision?: number) => id === source.id ? historicalSource : target.get(id, revision);
      const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    let observation: Observation;
    try { observation = new Evidence(view).observe(project, citation.source, citation.selector); }
    catch (error) {
      if (error instanceof EngineError && ['selector_invalid', 'evidence_missing', 'evidence_input_invalid'].includes(error.code))
        fail('answer_unconfirmed', source.id, 'selector', 'The citation does not resolve against its saved source');
      throw error;
    }
    const ground: AnswerGround = { observation, state: value.sha256,
      proofLimit: value.origin.kind === 'file' ? 'repository-observation'
        : era === 'legacy' ? 'quoted-intent-requires-attribution' : 'reported-not-runtime-proof' };
    return copy({ source, ground });
  }, () => fail('answer_unconfirmed', citation.source.id, 'history', 'A citation has cyclic historical sources'));
}
function currentCitation(store: Store, source: Revision<Source>): void {
  head(store, reference(source));
  check(sourceIsCurrent(source.value), 'answer_inapplicable', source.id, 'source', 'The captured source no longer describes the current file');
}
function requireCitations(store: Store, value: unknown): asserts value is AnswerCitationsRequest {
  requireStore(store);
  if (!object(value) || !text(value.project) || !Array.isArray(value.citations) || value.citations.length === 0
    || Object.keys(value).some(key => !['project', 'citations'].includes(key))
    || !value.citations.every(item => object(item) && isRef(item.source) && object(item.selector)
      && Object.keys(item).every(key => ['source', 'selector'].includes(key)))) requestInvalid('citations');
}
function answerCitations(store: Store, request: AnswerCitationsRequest, current: boolean) {
  const selected = request.citations.map(citation => citationGround(store, request.project, citation, ANSWER_GROUNDS_ERA));
  if (current) for (const item of selected) currentCitation(store, item.source);
  const references = unique(selected.map(item => reference(item.source)));
  return { grounds: sorted(selected.map(item => item.ground)), references, ...(current ? { guards: references } : {}) };
}
/** E3 uses the same exact historical evidence as D5, without implying assessment or acceptance. */
export function readAnswerCitations(store: Store, request: AnswerCitationsRequest): OmResult<Sealed<{ grounds: AnswerGround[]; references: Ref[] }>> {
  requireCitations(store, request); request = copy(request);
  return result(() => answerCitations(store, request, false));
}
/** Fresh heads and files are checked separately on every preparation; the guards join the caller's transaction. */
export function prepareAnswerCitations(store: Store, request: AnswerCitationsRequest): OmResult<Sealed<{ grounds: AnswerGround[]; references: Ref[]; guards: Ref[] }>> {
  requireCitations(store, request); request = copy(request);
  return result(() => {
    const checked = answerCitations(store, request, true);
    return { ...checked, guards: checked.guards! };
  });
}
function checkedGround(store: Store, project: string, raw: Observation, current: boolean, era: GroundsEra): AnswerGround {
  check(object(raw) && raw.projectId === project && isRef(raw.source) && object(raw.selector) && Object.hasOwn(raw, 'value'),
    'answer_unconfirmed', project, 'observations', 'Each citation needs its exact source, selector and computed value');
  const checked = citationGround(store, project, raw, era);
  check(same(checked.ground.observation, raw), 'answer_unconfirmed', raw.source.id, 'observation.value', 'Evidence value must be derived from the exact citation');
  if (current) currentCitation(store, checked.source);
  return checked.ground;
}
function checkedSource(store: Store, project: string, ref: Ref): Revision<Source> {
  const source = exact<Source>(store, project, ref, 'source'), value = source.value;
  check(object(value) && value.projectId === project && typeof value.content === 'string' && digest(value.content) === value.sha256
    && ['text/plain', 'application/json'].includes(value.mediaType) && object(value.origin)
    && ['file', 'owner-document'].includes(value.origin.kind) && text(value.origin.location),
    'answer_unconfirmed', ref.id, 'source', 'Evidence must retain its project, origin and content digest');
  if (value.mediaType === 'application/json') {
    try { JSON.parse(value.content); }
    catch (error) { if (error instanceof SyntaxError) fail('answer_unconfirmed', source.id, 'source.content', 'The captured JSON source is malformed'); throw error; }
  }
  return source;
}
function deriveAnswerHistory(store: Store, request: AnswerRequest, era: GroundsEra) {
  const q = loadMc1Question(store, { project: request.project, record: request.question });
  const context = q.context;
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
  const grounds = sorted(assessment.value.observations.map(raw => checkedGround(store, request.project, raw, false, era)));
  const attempt = attemptOf(store, request.project, context.gap, request.attempt, false);
  const value: NativeAcceptedAnswerRecord = { project: request.project, request, target: context.gap.target, field: context.gap.field,
    contract: q.record.value.request.contract as AnswerQuestionContract, fingerprint: q.record.value.fingerprint, value: answer.value.value, grounds, ...(era === 'legacy' ? {} : { groundsEra: era }) };
  const references = unique([...q.references, request.answer, request.answeredQuestion, request.draft, answer.value.assessment,
    assessment.value.environment, ...grounds.map(item => item.observation.source), ...(attempt ? [attempt.series] : [])]);
  const guards = unique([...context.guards, request.question, request.answer, request.answeredQuestion, request.draft, answer.value.assessment,
    assessment.value.environment, ...grounds.map(item => item.observation.source), ...(attempt ? [attempt.series] : [])]);
  return { value, references, guards, question: q.record as Revision<Mc1QuestionRecord>, gap: context.gap, attempt };
}
function deriveAnswer(store: Store, request: AnswerRequest, current: boolean, era: GroundsEra = ANSWER_GROUNDS_ERA,
  currentAttempt = true) {
  const historical = historicalRead(store, { reader: 'D5.answer-sources', project: request.project, ref: request.answer,
    parameters: { request, era } as unknown as Json }, () => copy(deriveAnswerHistory(store, request, era)),
  () => fail('answer_unconfirmed', request.answer.id, 'history', 'The accepted answer has cyclic historical sources'));
  if (!current) return historical;
  const question = loadMc1Question(store, { project: request.project, record: request.question });
  const context = currentQuestionContext(store, question.record.value.request, question.context);
  // Reusing an exact accepted fact does not assign a new result to its historical attempt.
  const guards = historical.guards.filter(ref => currentAttempt || !request.attempt || !same(ref, request.attempt.series));
  for (const guard of guards) head(store, guard);
  for (const ground of historical.value.grounds) checkedGround(store, request.project, ground.observation, true, era);
  return { ...historical, guards: unique([...guards, ...context.guards]) };
}
function deriveE5AnswerHistory(store: Store, request: E5AnswerRequest) {
  const outcome = take(readAssessmentOutcomeAt(store, request.project, request.intent, request.assessor));
  const intent = outcome.intent, fact = intent.fact;
  check(same(intent.intent, request.intent) && same(reference(outcome.assessor), request.assessor)
    && outcome.verdict === 'supported', 'answer_unconfirmed', request.assessor.id, 'assessment',
    'The supported assessor outcome must belong to this exact prepared intent and transport');
  const q = loadMc1Question(store, { project: request.project, record: intent.question.record });
  const gap = q.context.gap;
  check(same(fact.question, intent.question.record) && same(intent.question.record, reference(q.record))
    && intent.question.target === gap.target && intent.question.field === gap.field
    && same(intent.question.contract, q.record.value.request.contract)
    && intent.question.fingerprint === q.record.value.fingerprint,
  'answer_unconfirmed', request.intent.id, 'question', 'The assessment must retain the exact issued MC1 fact and full question contract');
  const schema = q.record.value.request.contract.resultForm;
  const validator = new Ajv({ strict: true, allowUnionTypes: true });
  check(validator.validateSchema(schema as object), 'answer_question_invalid', q.record.id, 'resultForm', 'The question must contain a valid result schema');
  check(validator.compile(schema as object)(fact.value), 'answer_unconfirmed', request.assessor.id, 'value',
    'The supported value must match the exact saved question result form');
  check(Array.isArray(fact.grounds) && fact.grounds.length > 0, 'answer_unconfirmed', request.intent.id, 'grounds',
    'The supported fact needs its checked citation grounds');
  const grounds = sorted(fact.grounds.map(ground => {
    check(object(ground) && object(ground.observation), 'answer_unconfirmed', request.intent.id, 'grounds',
      'Each assessment ground needs a complete saved observation');
    const checked = checkedGround(store, request.project, ground.observation as unknown as Observation, false, ANSWER_GROUNDS_ERA);
    check(same(ground, checked), 'answer_unconfirmed', request.intent.id, 'grounds',
      'The assessment grounds must be derived from the exact saved citations');
    return checked;
  }));
  const link = { series: intent.originalSeries, attempt: intent.attempt };
  const attempt = attemptOf(store, request.project, gap, link, false);
  check(attempt !== null, 'answer_attempt_invalid', request.intent.id, 'attempt',
    'An E5 fact acceptance belongs to its original running attempt');
  const value: E5AcceptedAnswerRecord = { project: request.project, producer: 'E5', request,
    assessment: request.assessor, target: gap.target, field: gap.field,
    contract: q.record.value.request.contract as AnswerQuestionContract, fingerprint: q.record.value.fingerprint,
    value: fact.value as unknown as Json, grounds, groundsEra: ANSWER_GROUNDS_ERA };
  const references = unique([...q.references, request.intent, request.assessor, ...outcome.references,
    ...grounds.map(ground => ground.observation.source), attempt.series, intent.series]);
  return { value, references, guards: unique([request.intent, request.assessor, reference(q.record),
    ...grounds.map(ground => ground.observation.source)]), question: q.record, gap, attempt };
}
function currentAcceptedAttempt(store: Store, project: string, attempt: AnswerAttempt,
  accepted?: { ref: Ref; key: string }): Ref[] {
  const head = store.get<RepairSeries>(attempt.series.id);
  check(head, 'answer_attempt_invalid', attempt.series.id, 'attempt',
    'The original E5 fact attempt needs a current series line');
  const admission = take(prepareSeriesLineAdmission(store, project, reference(head)));
  const series = admission.series.value;
  const running = 'block' in series && series.block === attempt.block
    ? series.attempts.find(item => item.ordinal === attempt.ordinal) : null;
  const acceptedInOutcome = (): boolean => {
    if (!running || accepted === undefined || running.outcome?.reason !== 'result') return false;
    const fact = take(readAcceptedAnswer(store, { project, record: accepted.ref }));
    if (fact.key !== accepted.key || !fact.attempt
      || fact.attempt.series.id !== attempt.series.id || fact.attempt.ordinal !== attempt.ordinal
      || fact.attempt.block !== attempt.block || !same(fact.attempt.goal, attempt.goal)) return false;
    return running.outcome.achieved.some(item => {
      if (item.key !== fact.key || !item.basis.id.startsWith(acceptedAnswerNamespace(project))) return false;
      return acceptedAnswerRepresents(store, { project, block: attempt.block, goal: attempt.goal,
        attempt: { series: reference(head), ordinal: attempt.ordinal }, accepting: [item.basis] },
      item.basis, fact.key);
    });
  };
  check(running && same(running.goal, attempt.goal)
    && (accepted === undefined ? running.outcome === null : running.outcome === null || acceptedInOutcome()),
    'answer_attempt_invalid', attempt.series.id, 'attempt',
    'The supported E5 fact must belong to the same full attempt goal and its accepted result');
  return admission.guards as Ref[];
}
function deriveE5Answer(store: Store, request: E5AnswerRequest, current: boolean, currentAttempt = true) {
  const historical = historicalRead(store, { reader: 'D5.e5-answer-sources', project: request.project, ref: request.assessor,
    parameters: request as unknown as Json }, () => copy(deriveE5AnswerHistory(store, request)),
  () => fail('answer_unconfirmed', request.assessor.id, 'history', 'The supported E5 answer has cyclic historical sources'));
  if (!current) return historical;
  const question = loadMc1Question(store, { project: request.project, record: reference(historical.question) });
  const context = currentQuestionContext(store, question.record.value.request, question.context);
  const guards = historical.guards;
  for (const guard of guards) head(store, guard);
  for (const ground of historical.value.grounds) checkedGround(store, request.project, ground.observation, true, ANSWER_GROUNDS_ERA);
  return { ...historical, guards: unique([...guards, ...context.guards,
    ...(currentAttempt ? currentAcceptedAttempt(store, request.project, historical.attempt) : [])]) };
}
function predicted(value: NativeAcceptedAnswerRecord): Revision<NativeAcceptedAnswerRecord>;
function predicted(value: E5AcceptedAnswerRecord): Revision<E5AcceptedAnswerRecord>;
function predicted(value: AcceptedAnswerRecord): Revision<AcceptedAnswerRecord>;
function predicted(value: AcceptedAnswerRecord): Revision<AcceptedAnswerRecord> {
  const id = 'producer' in value
    ? `${acceptedAnswerNamespace(value.project)}e5:${hashJson(value.request)}`
    : `${acceptedAnswerNamespace(value.project)}${hashJson(value.groundsEra === undefined ? value.request : { request: value.request, groundsEra: value.groundsEra })}`;
  return { id, kind: ACCEPTED_ANSWER_KIND,
    revision: 1, hash: hashJson(value), value };
}
function checkAcceptedRecord(store: Store, project: string, record: Revision<AcceptedAnswerRecord>): CheckedAnswer {
  check(record.kind === ACCEPTED_ANSWER_KIND && record.id.startsWith(acceptedAnswerNamespace(project))
    && object(record.value) && record.value.project === project && object(record.value.request),
    'answer_record_invalid', record.id, 'record', 'An accepted fact must retain its source request');
  try { if ('producer' in record.value) requireE5Answer(record.value.request); else requireAnswer(record.value.request); }
  catch (error) { if (error instanceof EngineError && error.code === 'answer_request_invalid') fail('answer_record_invalid', record.id, 'request', 'The saved answer request is malformed'); throw error; }
  check(record.value.request.project === project, 'answer_record_invalid', record.id, 'project', 'The source request belongs to this project');
  check(!Object.hasOwn(record.value, 'groundsEra') || record.value.groundsEra === ANSWER_GROUNDS_ERA,
    'answer_record_invalid', record.id, 'groundsEra', 'The saved evidence contract must name a supported era');
  const derived = 'producer' in record.value
    ? (check(record.value.producer === 'E5' && same(record.value.assessment, record.value.request.assessor)
        && record.value.groundsEra === ANSWER_GROUNDS_ERA,
      'answer_record_invalid', record.id, 'producer', 'An E5 answer names its exact assessment and evidence era'),
      deriveE5Answer(store, record.value.request, false))
    : deriveAnswer(store, record.value.request, false, record.value.groundsEra ?? 'legacy');
  check(same(record, predicted(derived.value)), 'answer_record_invalid', record.id, 'content', 'Acceptance must be rederived from its exact saved sources');
  return copy({ record, question: derived.question, gap: derived.gap, attempt: derived.attempt,
    key: factResultKey({ project, target: record.value.target, field: record.value.field, contract: record.value.contract, value: record.value.value }),
    references: unique([reference(record), ...derived.references]) });
}
type IndexHistory = { record: Ref; answers: Ref[] }[];
function loadAnswer(store: Store, request: AnswerReadRequest, indexHistory?: IndexHistory): CheckedAnswer {
  return historicalRead(store, { reader: indexHistory ? 'D5.accepted-answer-index-member' : 'D5.accepted-answer',
    project: request.project, ref: request.record }, () => {
    const record = exact<AcceptedAnswerRecord>(store, request.project, request.record, ACCEPTED_ANSWER_KIND, acceptedAnswerNamespace(request.project));
    const checked = checkAcceptedRecord(store, request.project, record);
    if ('producer' in record.value) {
      const resultId = assessmentResultId(request.project, record.value.request.intent);
      const saved = store.get(resultId, 1);
      check(saved, 'answer_record_invalid', record.id, 'assessmentResult',
        'An E5 answer is accepted only with its atomic terminal result');
      const terminal = take(readAssessmentTerminalBasisAt(store, request.project, reference(saved)));
      check(terminal.value.verdict === 'supported' && same(terminal.value.accepted, reference(record))
        && terminal.value.index !== null,
        'answer_record_invalid', record.id, 'assessmentResult',
        'The exact supported E5 terminal result must name this accepted fact and its index');
      if (indexHistory) {
        const entry = indexHistory.find(item => same(item.record, terminal.value.index));
        check(entry && entry.answers.some(ref => same(ref, reference(record))),
          'answer_record_invalid', record.id, 'assessmentResult.index',
          'The terminal index must be a checked revision containing this accepted fact');
      } else {
        const search = loadAnswerSearch(store, { project: request.project, record: terminal.value.index });
        check(search.answers.some(ref => same(ref, reference(record))),
          'answer_record_invalid', record.id, 'assessmentResult.index',
          'The terminal index must include this exact accepted fact');
      }
    }
    return checked;
  }, () => fail('answer_record_invalid', request.record.id, 'history', 'The accepted answer has cyclic historical sources'));
}
export function readAcceptedAnswer(store: Store, request: AnswerReadRequest): OmResult<Sealed<CheckedAnswer>> {
  requireRefRequest(store, request); return result(() => loadAnswer(store, request));
}
export function answerIndexId(project: string, target: string, field: string): string {
  if (!text(project) || !text(target) || !text(field)) requestInvalid('search');
  return `om-answer-index:${project}:${hashJson({ target, field })}`;
}
function loadAnswerSearch(store: Store, request: AnswerReadRequest): {
  record: Revision<AnswerIndex>; answers: Ref[]; references: Ref[]; indexHistory: IndexHistory;
} {
  return historicalRead(store, { reader: 'D5.answer-index', project: request.project, ref: request.record }, () => {
    const record = exact<AnswerIndex>(store, request.project, request.record, ANSWER_INDEX_KIND, `om-answer-index:${request.project}:`), value = record.value;
    check(object(value) && value.project === request.project && text(value.target) && text(value.field) && Array.isArray(value.answers)
      && value.answers.every(isRef) && (value.previous === null || isRef(value.previous))
      && record.id === answerIndexId(request.project, value.target, value.field) && same(value.answers, unique(value.answers))
      && new Set(value.answers.map(ref => ref.id)).size === value.answers.length,
      'answer_record_invalid', record.id, 'index', 'The answer index must preserve its exact line and canonical complete set');
    const references: Ref[] = [request.record];
    let indexHistory: IndexHistory = [{ record: request.record, answers: value.answers }];
    if (value.previous === null) check(record.revision === 1, 'answer_record_invalid', record.id, 'index.previous', 'Only the first index revision can omit its predecessor');
    else {
      check(value.previous.id === record.id && value.previous.revision === record.revision - 1,
        'answer_record_invalid', record.id, 'index.previous', 'The index names its exact immediate predecessor');
      const previous = loadAnswerSearch(store, { project: request.project, record: value.previous });
      check(previous.answers.length < value.answers.length && previous.answers.every(ref => value.answers.some(item => same(item, ref))),
        'answer_record_invalid', record.id, 'index.answers', 'An index revision only adds answers and never loses a previous answer');
      references.push(...previous.references);
      indexHistory = [...indexHistory, ...previous.indexHistory];
    }
    for (const ref of value.answers) {
      const checked = loadAnswer(store, { project: request.project, record: ref },
        ref.id.startsWith(`${acceptedAnswerNamespace(request.project)}e5:`) ? indexHistory : undefined);
      check(checked.record.value.target === value.target && checked.record.value.field === value.field,
        'answer_record_invalid', record.id, 'index.answers', 'Every indexed answer must belong to this exact obligation');
      references.push(...checked.references);
    }
    return copy({ record, answers: value.answers, references: unique(references), indexHistory });
  }, () => fail('answer_record_invalid', request.record.id, 'index.previous', 'The answer index history is cyclic'));
}
export function readAnswerSearch(store: Store, request: AnswerReadRequest): OmResult<Sealed<{ record: Revision<AnswerIndex>; answers: Ref[]; references: Ref[] }>> {
  requireRefRequest(store, request);
  return result(() => {
    const { record, answers, references } = loadAnswerSearch(store, request);
    return { record, answers, references };
  });
}
function prepareAnswerIndex(store: Store, request: { project: string; target: string; field: string; pending?: Write[] }): OmResult<Sealed<PreparedAnswerSearch>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !text(request.target) || !text(request.field)
    || Object.hasOwn(request, 'pending') && !Array.isArray(request.pending)) requestInvalid('search');
  request = copy(request);
  return result(() => {
    const id = answerIndexId(request.project, request.target, request.field), old = store.get<AnswerIndex>(id);
    const indexed = old ? loadAnswerSearch(store, { project: request.project, record: reference(old) }) : null;
    const existing: Ref[] = [], references: Ref[] = [...(indexed?.references ?? [])];
    for (const row of store.list()) if (row.id.startsWith(acceptedAnswerNamespace(request.project))) {
      const checked = loadAnswer(store, { project: request.project, record: reference(row) });
      if (checked.record.value.target === request.target && checked.record.value.field === request.field) {
        existing.push(reference(checked.record)); references.push(...checked.references);
      }
    }
    const current = unique(existing);
    check(!indexed || same(indexed.answers, current), 'answer_record_invalid', id, 'index.answers',
      'The current index must contain every saved answer of this obligation, without omissions or extra entries');
    const writes: Write[] = [], additions: Ref[] = [], pendingIds = new Set<string>();
    for (const write of request.pending ?? []) {
      check(object(write) && write.kind === ACCEPTED_ANSWER_KIND && text(write.id) && write.expected === 0 && object(write.value)
        && !pendingIds.has(write.id), 'answer_record_invalid', id, 'pending', 'A pending search contains distinct immutable accepted-answer writes');
      pendingIds.add(write.id);
      const row = { id: write.id, kind: write.kind, revision: 1, value: write.value, hash: hashJson(write.value) } as Revision<AcceptedAnswerRecord>;
      const previous = store.get(row.id);
      check(!previous || same(previous, row), 'answer_record_invalid', row.id, 'pending', 'A pending answer must not replace existing content');
      const checked = previous ? loadAnswer(store, { project: request.project, record: reference(previous) })
        : historicalRead(store, { reader: 'D5.pending-answer', project: request.project, ref: reference(row), parameters: write as unknown as Json },
          () => checkAcceptedRecord(store, request.project, row), () => fail('answer_record_invalid', row.id, 'history', 'A pending answer has cyclic sources'));
      check(checked.record.value.target === request.target && checked.record.value.field === request.field,
        'answer_record_invalid', row.id, 'pending', 'A pending answer belongs to the indexed obligation');
      additions.push(reference(checked.record)); references.push(...checked.references);
      if (!previous) writes.push(write);
    }
    const answers = unique([...current, ...additions]);
    const value: AnswerIndex = { project: request.project, target: request.target, field: request.field, answers,
      previous: old ? reference(old) : null };
    const change = !old || !same(current, answers);
    const record = change ? { id, kind: ANSWER_INDEX_KIND, revision: (old?.revision ?? 0) + 1, hash: hashJson(value), value } : old;
    if (change) writes.push({ id, kind: ANSWER_INDEX_KIND, expected: old?.revision ?? 0, value });
    return { record: record!, answers, writes, guards: unique([...(old ? [reference(old)] : []), ...current]),
      references: unique([...references, reference(record!)]) };
  });
}
/** Current enumeration is read-only except for its index. Accepted facts enter only through admitted D5 writers. */
export function prepareAnswerSearch(store: Store, request: { project: string; target: string; field: string }): OmResult<Sealed<PreparedAnswerSearch>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !text(request.target) || !text(request.field) || Object.hasOwn(request, 'pending')) requestInvalid('search');
  return prepareAnswerIndex(store, request);
}
export function prepareAcceptedAnswer(store: Store, request: AnswerRequest): OmResult<Sealed<PreparedNativeAnswer>> {
  requireStore(store); requireAnswer(request); request = copy(request);
  return result(() => {
    const history = deriveAnswer(store, request, false), record = predicted(history.value), old = store.get(record.id);
    check(!old || same(old, record), 'answer_record_invalid', record.id, 'record', 'A fact acceptance cannot be overwritten under the same source request');
    const checked = deriveAnswer(store, request, true, ANSWER_GROUNDS_ERA, !old);
    const admission = !old && request.attempt ? take(prepareSeriesLineAdmission(store, request.project, request.attempt.series)).guards : [];
    const write: Write = { id: record.id, kind: record.kind, expected: 0, value: record.value };
    const search = take(prepareAnswerIndex(store, { project: request.project, target: checked.gap.target, field: checked.gap.field, pending: old ? [] : [write] }));
    return { record, writes: search.writes as Write[], guards: unique([...checked.guards, ...admission, ...search.guards]), references: unique([...checked.references, ...search.references]),
      closure: { id: checked.gap.id, reason: 'filled' as const, basis: reference(record), acceptance: null, attempt: request.attempt,
        answer: old ? { record: reference(record) } : { pending: write } } };
  });
}
/** E5 accepts one supported assessor outcome and joins the fact with D5's complete index CAS. */
export function prepareE5AcceptedAnswer(store: Store, request: E5AnswerRequest): OmResult<Sealed<PreparedE5Answer>> {
  requireStore(store); requireE5Answer(request); request = copy(request);
  return result(() => {
    const history = deriveE5Answer(store, request, false), record = predicted(history.value), old = store.get(record.id);
    check(!old || same(old, record), 'answer_record_invalid', record.id, 'record',
      'An assessed fact cannot be overwritten under the same exact outcome');
    const checked = deriveE5Answer(store, request, true, !old);
    const write: Write = { id: record.id, kind: record.kind, expected: 0, value: record.value };
    const search = take(prepareAnswerIndex(store, { project: request.project, target: checked.gap.target,
      field: checked.gap.field, pending: old ? [] : [write] }));
    const attempt = { series: checked.attempt.series, attempt: checked.attempt.ordinal };
    return { record, writes: search.writes as Write[],
      guards: unique([...checked.guards, ...search.guards]),
      references: unique([...checked.references, ...search.references]),
      closure: { id: checked.gap.id, reason: 'filled' as const, basis: reference(record),
        acceptance: null, attempt, answer: old ? { record: reference(record) } : { pending: write } } };
  });
}
/** A neighbour needing several answers takes this whole bundle; one line receives one final index CAS. */
export function prepareAcceptedAnswers(store: Store, requests: AnswerRequest[]): OmResult<Sealed<{
  records: Revision<NativeAcceptedAnswerRecord>[]; closures: PreparedAnswer['closure'][]; writes: Write[]; guards: Ref[]; references: Ref[];
}>> {
  requireStore(store);
  if (!Array.isArray(requests) || requests.length === 0) requestInvalid('answers');
  for (const request of requests) requireAnswer(request);
  requests = copy(requests);
  return result(() => {
    const prepared = requests.map(request => take(prepareAcceptedAnswer(store, request)));
    check(new Set(prepared.map(item => item.record.id)).size === prepared.length, 'answer_record_invalid', 'accepted-answer', 'answers',
      'A combined preparation names distinct accepted answers');
    const groups = new Map<string, { project: string; target: string; field: string; pending: Write[] }>();
    for (const item of prepared) {
      const { project, target, field } = item.record.value, id = answerIndexId(project, target, field);
      const group = groups.get(id) ?? { project, target, field, pending: [] };
      group.pending.push(...item.writes.filter(write => write.kind === ACCEPTED_ANSWER_KIND) as Write[]); groups.set(id, group);
    }
    const searches = [...groups.values()].map(group => take(prepareAnswerIndex(store, group)));
    const intermediate = new Set(prepared.flatMap(item => item.writes.filter(write => write.kind === ANSWER_INDEX_KIND).map(write =>
      canonical({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) }))));
    return { records: prepared.map(item => item.record) as Revision<NativeAcceptedAnswerRecord>[],
      closures: prepared.map(item => item.closure) as PreparedAnswer['closure'][], writes: searches.flatMap(item => item.writes) as Write[],
      guards: unique([...prepared.flatMap(item => item.guards), ...searches.flatMap(item => item.guards)]),
      references: unique([...prepared.flatMap(item => item.references).filter(ref => !intermediate.has(canonical(ref))), ...searches.flatMap(item => item.references)]) };
  });
}
export function writeAcceptedAnswer(store: Store, request: AnswerRequest): OmResult<Sealed<Revision<NativeAcceptedAnswerRecord>>> {
  return withHistoricalReads(() => {
    const prepared = prepareAcceptedAnswer(store, request);
    if (!prepared.ok) return prepared;
    if (prepared.value.writes.length) {
      const written = writeGuarded(store, { unit: 'D5', target: prepared.value.record.id, writes: prepared.value.writes, guards: prepared.value.guards });
      if (!written.ok) return written;
    }
    return delivered(prepared.value.record);
  });
}
export interface AnswerInputRequest { project: string; record: Ref; question: Ref; input: Ref; current: boolean }
export interface AnswerRequirementChange { pointer: string; before: Json; after: PointerValue }
export interface AnswerInputBody {
  checked: CheckedAnswer; sourceQuestion: OmInput['questions'][number]; applicable: boolean; guards: Ref[]; references: Ref[];
  requirementChanges: AnswerRequirementChange[];
}
function answerInputBody(store: Store, request: { project: string; record: Ref; question: Ref; input: OmInputRecord }): AnswerInputBody {
  const checked = loadAnswer(store, request), question = loadMc1Question(store, { project: request.project, record: request.question });
  const saved = checked.question.value.request;
  const original = take(readOmInput(store, request.project, saved.input));
  const originalQuestion = original.value.input.questions.find(item => item.id === checked.record.value.target)!;
  const issued = same(saved.input, question.record.value.request.input) ? original
    : take(readOmInput(store, request.project, question.record.value.request.input));
  const issuedQuestion = issued.value.input.questions.find(item => item.id === question.gap.target)!;
  const open = request.input.input.questions.filter(item => item.id === checked.record.value.target);
  const facts = (request.input.input.facts ?? []).filter(item => item.question.id === checked.record.value.target);
  check(open.length + facts.length === 1, 'answer_inapplicable', checked.record.value.target, 'input.question',
    'The exact target input must contain one unresolved question or its saved application');
  const sourceQuestion = open[0] ?? facts[0]!.question;
  const filling = facts[0];
  const selected = question.record.value.request.requirements.map(item => ({ pointer: item.pointer,
    before: pointer(issued.value.input, item.pointer, checked.record.value.target),
    after: selectPointer(request.input.input, item.pointer, checked.record.value.target) }));
  const requirements = sorted(selected.flatMap(item => item.after.present ? [item.after.value] : []));
  const requirementChanges = selected.filter(item => !item.after.present || !same(item.before, item.after.value));
  const applicable = request.input.projectId === request.project
    && checked.record.value.target === question.gap.target && checked.record.value.field === question.gap.field
    && same(checked.record.value.contract, question.record.value.request.contract)
    && same(sourceQuestion, originalQuestion) && same(sourceQuestion, issuedQuestion)
    && selected.every(item => item.after.present) && same(sorted(checked.record.value.contract.requirements), requirements)
    && (!filling || same(filling.answer, request.record) && same(filling.mc1Question, request.question)
      && same(filling.value, checked.record.value.value));
  return { checked, sourceQuestion, applicable, requirementChanges, guards: [],
    references: unique([...checked.references, ...question.references, saved.input]) };
}
/** B1 calls this on a body it has just derived. It verifies the fact's binding, not the input's acceptance. */
export function checkAnswerInputBody(store: Store, request: { project: string; record: Ref; question: Ref; input: OmInputRecord }): OmResult<Sealed<AnswerInputBody>> {
  requireRefRequest(store, request);
  if (!isRef(request.question) || !inputBodyShape(request.input)) requestInvalid('input');
  request = copy(request);
  return result(() => answerInputBody(store, request));
}
function inputBodyShape(body: unknown): body is OmInputRecord {
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
  const rows = (value: unknown, shape: (item: Record<string, any>) => boolean) => Array.isArray(value)
    && value.every(item => object(item) && shape(item));
  const question = (item: Record<string, any>) => text(item.id) && typeof item.question === 'string'
    && typeof item.consumer === 'string' && Object.hasOwn(item, 'kind') && typeof item.blocks === 'boolean' && isRef(item.source)
    && (!Object.hasOwn(item, 'addressedBy') || isRef(item.addressedBy))
    && (!Object.hasOwn(item, 'originalConsumer') || typeof item.originalConsumer === 'string');
  if (!object(body) || !text(body.projectId) || !text(body.hash) || !object(body.input)
    || !rows(body.gaps, gap => ['code', 'target', 'field', 'message'].every(key => typeof gap[key] === 'string')
      && Object.hasOwn(gap, 'consumer') && (gap.source === null || isRef(gap.source)))
    || Object.hasOwn(body, 'derivation') && !object(body.derivation)) return false;
  const input = body.input;
  return rows(input.sources, source => text(source.stage)
      && (source.contractVersion === null || Number.isSafeInteger(source.contractVersion)) && isRef(source))
    && (input.inventory === null || isRef(input.inventory))
    && rows(input.requirements, item => typeof item.id === 'string' && typeof item.section === 'string')
    && rows(input.criteria, item => typeof item.id === 'string' && typeof item.requirement === 'string'
      && (item.checkKind === null || typeof item.checkKind === 'string'))
    && rows(input.contracts, item => ['id', 'outcome', 'actor', 'proof'].every(key => typeof item[key] === 'string')
      && (item.nodes === null || strings(item.nodes)) && strings(item.requirements) && strings(item.success)
      && strings(item.failures) && strings(item.forbiddenEffects) && object(item.state))
    && rows(input.features, item => Number.isSafeInteger(item.index) && typeof item.title === 'string' && typeof item.outcome === 'string'
      && Array.isArray(item.behaviorIndexes) && item.behaviorIndexes.every(Number.isSafeInteger)
      && strings(item.requirementIds) && strings(item.contracts))
    && rows(input.questions, question)
    && object(input.map) && strings(input.map.nodes) && strings(input.map.artifacts) && strings(input.map.connectors)
    && (!Object.hasOwn(input, 'facts') || rows(input.facts, item => object(item.question) && question(item.question)
      && isRef(item.answer) && isRef(item.mc1Question) && Object.hasOwn(item, 'value')));
}
function currentAnswerSources(store: Store, project: string, checked: CheckedAnswer) {
  let applicable = true;
  const guards = [reference(checked.record)];
  for (const ground of checked.record.value.grounds) {
    const ref = ground.observation.source, source = exact<Source>(store, project, ref, 'source');
    if (!same(store.get(ref.id) ? reference(store.get(ref.id)!) : null, ref) || !sourceIsCurrent(source.value)) applicable = false;
    guards.push(ref);
  }
  return { applicable, guards: unique(guards), references: checked.references };
}
/** Current evidence only: B1 already admits its input and must not recurse through that admission here. */
export function answerSourceGuards(store: Store, request: AnswerReadRequest): OmResult<Sealed<{ applicable: boolean; guards: Ref[]; references: Ref[] }>> {
  requireRefRequest(store, request);
  return result(() => currentAnswerSources(store, request.project, loadAnswer(store, request)));
}
/** Capture through the native producer while leaving its write for B1's atomic transition. */
function captureChangedFile(store: Store, project: string, source: Revision<Source>): { record: Revision<Source>; write: Write } {
  const writes: Write[] = [];
  const view = new Proxy(store, { get(target, prop) {
    if (prop === 'write') return (write: Write) => {
      writes.push(copy(write));
      return { id: write.id, kind: write.kind, value: write.value, revision: write.expected + 1, hash: hashJson(write.value) };
    };
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  let record: Revision<Source>;
  try {
    record = new Evidence(view).file(project, source.id.slice(`source:${project}:`.length), dirname(source.value.origin.location),
      basename(source.value.origin.location), source.value.mediaType, source.revision);
  } catch (error) {
    if (error instanceof SyntaxError
      || error instanceof EngineError && ['source_invalid', 'source_path_invalid'].includes(error.code)
      || error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP'].includes(String(error.code)))
      fail('answer_inapplicable', source.id, 'invalidation.source', 'The changed evidence file cannot supply a valid durable source revision');
    throw error;
  }
  check(writes.length === 1 && record.id === source.id && record.revision === source.revision + 1,
    'answer_unconfirmed', source.id, 'invalidation.source', 'The native source producer must capture one successor of the current source');
  return { record, write: writes[0]! };
}
export function prepareAnswerInvalidation(store: Store, request: AnswerReadRequest): OmResult<Sealed<{
  invalidation: AnswerInvalidation | null; writes: Write[]; guards: Ref[]; references: Ref[];
}>> {
  requireRefRequest(store, request);
  return result(() => {
    const checked = loadAnswer(store, request), sources: AnswerInvalidation['sources'] = [], writes: Write[] = [];
    const guards: Ref[] = [request.record], references: Ref[] = [...checked.references];
    head(store, request.record);
    for (const before of unique(checked.record.value.grounds.map(ground => ground.observation.source))) {
      const latest = store.get<Source>(before.id);
      check(latest, 'answer_inapplicable', before.id, 'invalidation.source', 'The fact source has no current revision');
      const current = checkedSource(store, request.project, reference(latest));
      guards.push(reference(current)); references.push(reference(current));
      let after = current;
      if (!sourceIsCurrent(current.value)) {
        check(current.value.origin.kind === 'file', 'answer_inapplicable', current.id, 'invalidation.source',
          'The source cannot establish a current replacement');
        const captured = captureChangedFile(store, request.project, current);
        after = captured.record; writes.push(captured.write);
      }
      if (!same(before, reference(after))) {
        check(after.revision > before.revision, 'answer_unconfirmed', before.id, 'invalidation.source', 'Invalidation must identify a later source revision');
        sources.push({ before, after: reference(after) }); references.push(reference(after));
      }
    }
    return { invalidation: sources.length ? { record: request.record, sources: sorted(sources) } : null,
      writes, guards: unique(guards), references: unique(references) };
  });
}
/** Historical cause of reopening: exact source revisions, with no requirements on today's heads or files. */
export function readAnswerInvalidation(store: Store, request: { project: string; invalidation: AnswerInvalidation | Sealed<AnswerInvalidation> }): OmResult<Sealed<{ references: Ref[] }>> {
  requireStore(store);
  if (!object(request) || !text(request.project) || !object(request.invalidation) || !isRef(request.invalidation.record)
    || !Array.isArray(request.invalidation.sources) || !request.invalidation.sources.every(pair => object(pair) && isRef(pair.before) && isRef(pair.after)))
    requestInvalid('invalidation');
  request = copy(request);
  return result(() => {
    const { invalidation } = request, checked = loadAnswer(store, { project: request.project, record: invalidation.record });
    check(invalidation.sources.length > 0 && new Set(invalidation.sources.map(pair => pair.before.id)).size === invalidation.sources.length,
      'answer_inapplicable', invalidation.record.id, 'invalidation.sources', 'Reopening needs a nonempty unambiguous set of changed evidence sources');
    const sources = invalidation.sources.map(pair => {
      check(checked.record.value.grounds.some(ground => same(ground.observation.source, pair.before))
        && pair.after.id === pair.before.id && pair.after.revision > pair.before.revision,
        'answer_inapplicable', invalidation.record.id, 'invalidation.sources', 'Each cause must supersede this accepted fact\'s exact evidence source');
      const before = checkedSource(store, request.project, pair.before), after = checkedSource(store, request.project, pair.after);
      return { before: reference(before), after: reference(after) };
    });
    check(same(invalidation, { record: reference(checked.record), sources: sorted(sources) }),
      'answer_inapplicable', invalidation.record.id, 'invalidation.sources', 'The saved invalidation must retain its complete canonical exact source pairs');
    return { references: unique([...checked.references, ...sources.flatMap(pair => [pair.before, pair.after])]) };
  });
}
export interface AnswerTaskApplicationRequest {
  project: string; record: Ref; task: AnswerTaskBasis; current: boolean; invalidation?: AnswerInvalidation | null;
}
export function applicableAnswerTask(store: Store, request: AnswerTaskApplicationRequest): OmResult<Sealed<{
  applicable: boolean; value: Json; key: string; task: Ref; invalidation: AnswerInvalidation | null;
  guards: Ref[]; references: Ref[]; writes: Write[];
}>> {
  requireRefRequest(store, request);
  if (!object(request.task) || typeof request.current !== 'boolean'
    || !request.current && (!Object.hasOwn(request, 'invalidation') || request.invalidation === undefined)) requestInvalid('task.applicability');
  request = copy(request);
  return result(() => {
    const task = take(readAnswerTaskBasis(store, { project: request.project, task: request.task, current: request.current }));
    const checked = loadAnswer(store, request);
    const contractMatches = checked.record.value.target === task.gap.target && checked.record.value.field === task.gap.field
      && same(checked.record.value.contract, task.contract);
    let invalidation: AnswerInvalidation | null;
    const guards: Ref[] = [...task.guards], references: Ref[] = [...task.references, ...checked.references], writes: Write[] = [...task.writes];
    if (request.current && !contractMatches) {
      head(store, request.record); guards.push(request.record); invalidation = null;
    } else if (request.current) {
      const evidence = take(prepareAnswerInvalidation(store, request));
      invalidation = evidence.invalidation as AnswerInvalidation | null;
      guards.push(...evidence.guards); references.push(...evidence.references); writes.push(...evidence.writes);
    } else {
      invalidation = request.invalidation!;
      if (invalidation !== null) {
        check(object(invalidation) && isRef(invalidation.record) && same(invalidation.record, request.record),
          'answer_inapplicable', request.record.id, 'invalidation', 'The saved evidence change must belong to this exact accepted answer');
        references.push(...take(readAnswerInvalidation(store, { project: request.project, invalidation })).references);
      }
    }
    return { applicable: invalidation === null && contractMatches,
      value: checked.record.value.value, key: checked.key, task: reference(task.record), invalidation,
      guards: unique(guards), references: unique(references), writes };
  });
}
export function readAnswerForInput(store: Store, request: AnswerInputRequest): OmResult<Sealed<AnswerInputBody & { input: Revision<OmInputRecord> }>> {
  requireRefRequest(store, request);
  if (!isRef(request.question) || !isRef(request.input) || typeof request.current !== 'boolean') requestInvalid('input');
  request = copy(request);
  return result(() => {
    const input = take(readOmInput(store, request.project, request.input)) as Revision<OmInputRecord>;
    const body = answerInputBody(store, { ...request, input: input.value });
    const guards: Ref[] = [];
    let applicable = body.applicable;
    if (request.current) {
      const admission = take(prepareExistingOmInput(store, request.project, request.input));
      const sources = currentAnswerSources(store, request.project, body.checked);
      applicable &&= sources.applicable;
      guards.push(...admission.guards, ...sources.guards, request.question);
      head(store, request.question);
    }
    return { ...body, input, applicable, guards: unique(guards), references: unique([...body.references, request.input]) };
  });
}
export function applicableAnswer(store: Store, request: { project: string; record: Ref; question: Ref; input?: Ref }): OmResult<Sealed<{ applicable: boolean; guards: Ref[]; references: Ref[] }>> {
  requireRefRequest(store, request);
  if (!isRef(request.question) || Object.hasOwn(request, 'input') && !isRef(request.input)) requestInvalid('question');
  return result(() => {
    const question = loadMc1Question(store, { project: request.project, record: request.question });
    const checked = take(readAnswerForInput(store, { ...request, input: request.input ?? question.record.value.request.input, current: true }));
    return { applicable: checked.applicable, guards: checked.guards, references: checked.references };
  });
}
export function confirmAcceptedAnswerResult(record: Sealed<Revision<Json>>, context: AcceptanceContext, store: Store): Confirmation {
  return withHistoricalReads(() => {
    requireStore(store);
    if (!object(record) || !isRef(record) || !text(record.kind) || !Object.hasOwn(record, 'value')
      || !object(context) || !text(context.project) || !text(context.block) || !object(context.goal)
      || !text(context.goal.key) || !text(context.goal.result) || !Array.isArray(context.goal.questions)
      || !context.goal.questions.every(text)) requestInvalid('confirmation');
    const { refusals: closingRefusals, ...existingContext } = context;
    context = copy(existingContext);
    const checked = readAcceptedAnswer(store, { project: context.project, record: reference(record) });
    if (!checked.ok) return { unconfirmed: `${checked.refusal.code}: ${checked.refusal.message}` };
    const attempt = checked.value.attempt;
    if (!attempt || attempt.block !== context.block || !same({ ...attempt.goal, questions: sorted(attempt.goal.questions) },
      { ...context.goal, questions: sorted(context.goal.questions) })) return { unconfirmed: 'The fact does not belong to this previously recorded full attempt goal' };
    if ('producer' in checked.value.record.value) {
      const closing = context.attempt;
      if (!closing || !isRef(closing.series) || !Number.isSafeInteger(closing.ordinal)
        || closing.series.id !== attempt.series.id || closing.series.revision < attempt.series.revision
        || closing.series.revision === attempt.series.revision && !same(closing.series, attempt.series)
        || closing.ordinal !== attempt.ordinal)
        return { unconfirmed: 'The E5 fact belongs to another exact series line or attempt' };
      if (!Array.isArray(context.accepting))
        return { unconfirmed: 'E5 needs the complete accepting set of this attempt' };
      const series = readAnySeriesAt(store, context.project, closing.series);
      if (!series.ok) return { unconfirmed: `${series.refusal.code}: ${series.refusal.message}` };
      const cycle = [...series.value.value.inherited, ...series.value.value.attempts]
        .find(item => item.ordinal === closing.ordinal);
      if (!cycle || !same({ ...cycle.goal, questions: sorted(cycle.goal.questions) },
        { ...attempt.goal, questions: sorted(attempt.goal.questions) }))
        return { unconfirmed: 'The E5 fact needs its exact original attempt and full goal' };
      // A completed delivery is compared with the saved A3 outcome by the gate. New work must first account for
      // every E5 call of the attempt, discovered from E1 rather than from the caller's accepting/refusal claims.
      if (cycle.outcome !== null) return { keys: [checked.value.key] };
      const closure = checkCurrentAssessmentAttemptClosure(store,
        { project: context.project, block: context.block, series: closing.series,
          attempt: closing.ordinal, goal: cycle.goal },
        { series: closing.series, attempt: closing.ordinal, block: context.block,
          goal: cycle.goal, reason: 'result', accepting: context.accepting,
          cancelling: [], refusals: closingRefusals ?? [] });
      if (!closure.ok) return { unconfirmed: `${closure.refusal.code}: ${closure.refusal.message}` };
      return { keys: [checked.value.key], guards: closure.value.guards };
    }
    return { keys: [checked.value.key] };
  });
}

/** Confirm an outcome representative by its own D5 producer contract. */
export function acceptedAnswerRepresents(store: Store, context: AcceptanceContext, basis: Ref, key: string): boolean {
  if (!(store instanceof Store) || !isPlainObject(context) || !isRef(basis) || !text(key))
    requestInvalid('representative');
  const record = store.get<Json>(basis.id, basis.revision);
  if (!record || record.kind !== ACCEPTED_ANSWER_KIND || !same(reference(record), basis)) return false;
  const confirmation = confirmAcceptedAnswerResult(sealed(record), context, store);
  return 'keys' in confirmation && confirmation.keys.includes(key);
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
    const old = take(readGaps(view.store, request.prior)), now = take(readGaps(view.store, request.current));
    const gap = old.collection.gaps.find(item => item.target === request.target && item.field === request.field);
    check(old.sources.project === request.project && now.sources.project === request.project && gap
      && checked.record.value.target === gap.target && checked.record.value.field === gap.field
      && same(gap.consumers, checked.gap.consumers) && gap.kind === checked.gap.kind,
      'answer_unconfirmed', request.target, 'closure.prior', 'The fact must belong to the same line and verified prior D1 consumer contract');
    check(!now.collection.gaps.some(item => item.target === request.target && item.field === request.field),
      'answer_inapplicable', request.target, 'closure.current', 'An active gap cannot close before its producer applies the answer');
    const applied = take(readOmInput(view.store, request.project, now.sources.input));
    const filling = applied.value.input.facts?.find(item => item.question.id === request.target);
    check(filling && same(filling.answer, view.ref) && same(filling.value, checked.record.value.value),
      'answer_inapplicable', request.target, 'closure.application',
      'The closing input must contain the verified application of this exact accepted answer');
    const bindings = [old.sources.input, now.sources.input].map(input => take(readAnswerForInput(view.store,
      { project: request.project, record: view.ref, question: filling.mc1Question, input, current: false })));
    check(bindings.every(binding => binding.applicable), 'answer_inapplicable', request.target, 'closure.contract',
      'Both saved D1 inputs must retain the exact question, consumer and essential conditions of this accepted answer');
    check(same(request.attempt, checked.attempt
      ? { series: checked.attempt.series, attempt: checked.attempt.ordinal } : null),
      'answer_attempt_invalid', request.target, 'closure.attempt',
      'A line may not reattribute a fact to a different attempt');
    const guards: Ref[] = [];
    if (request.currentOnly) {
      const prepared = take(prepareCurrentGaps(view.store, request.current));
      guards.push(...prepared.guards, now.sources.input, ...request.current.records);
      const sources = currentAnswerSources(view.store, request.project, checked);
      check(sources.applicable, 'answer_inapplicable', request.target, 'closure.sources', 'The applied fact no longer describes its current evidence');
      guards.push(...sources.guards.filter(ref => !view.writes.length || ref.id !== view.ref.id));
      if (checked.attempt) guards.push(...currentAcceptedAttempt(store, request.project,
        checked.attempt, { ref: view.ref, key: checked.key }));
      if (!view.writes.length) guards.push(view.ref);
      else {
        const acceptance = 'producer' in checked.record.value
          ? deriveE5Answer(view.store, checked.record.value.request, false)
          : deriveAnswer(view.store, checked.record.value.request, false, checked.record.value.groundsEra ?? 'legacy');
        for (const guard of acceptance.guards) { head(store, guard); guards.push(guard); }
      }
    }
    const search = request.currentOnly && view.writes.length ? take(prepareAnswerIndex(store, { project: request.project,
      target: request.target, field: request.field, pending: view.writes })) : null;
    return { key: checked.key, references: unique([...checked.references, ...bindings.flatMap(binding => binding.references), ...request.prior.records,
      ...request.current.records, ...(search?.references ?? [])]),
      guards: unique([...guards, ...(search?.guards ?? [])].filter(ref => !view.writes.length || !same(ref, view.ref))),
      writes: request.currentOnly ? (search?.writes as Write[] | undefined) ?? view.writes : [], attempt: checked.attempt };
  });
}
