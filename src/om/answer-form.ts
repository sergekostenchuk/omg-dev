import { Ajv } from 'ajv';
import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { readMc1Question, readAnswerCitations, prepareAnswerCitations, type AnswerGround, type AnswerCitation } from './accepted-answer.js';
import { contextValue } from '../discovery/working-context.js';
import { safeRelativePath } from '../graph/topology.js';
import { LEVEL, type Graph } from '../graph/model.js';
import { workspacePath, type Environment } from '../runtime/environment.js';
import { readRecord } from './refs.js';
import { readRoutes, prepareRoutes, prepareManagedRouteBatch, type RoutesRequest } from './routes.js';
import { readGaps, type GapReadRequest } from './gaps.js';
import { decidedAnswer, inputDecisionWrite, deriveInputDecisions, prepareAddressing, type InputFieldDecision } from './addressing.js';
import { ownerAnswersOf } from './owner-result.js';
import { readOmInput, withHistoricalReads, type OmInputRecord } from './input.js';
import { readPacketAnswer, packetReadPath, derivePartProposal, prepareQuestionPacket, type PartProposalBody, type PacketAnswerRequest,
  type PacketRead, type QuestionPacketRecord, type QuestionPacketRequest, type WorksPartBindings } from './question-packet.js';
import { briefReadings } from './packet-brief.js';
import type { Source } from '../evidence/evidence.js';
import type { LayerProposal } from './frame-proposals.js';
import type { TaskObligationBinding } from '../graph/task-obligation-model.js';
import { delivered, isPlainObject, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';

export const ANSWER_FORM_CODES = Object.freeze([
  'answer_form_request_invalid', 'answer_form_invalid', 'answer_form_task_invalid', 'answer_form_value_invalid', 'answer_form_address_invalid',
] as const);
export type AnswerTaskAddress = { project: string; kind: 'node-expansion'; packet: Ref }
  | { project: string; kind: 'fact'; question: Ref };
export interface NodeAnswerFormRequest { project: string; packet: Ref; raw: string }
export interface FactValueFormRequest { project: string; question: Ref; value: Json }
export interface NodeAnswerForm {
  kind: 'node-form'; task: Extract<AnswerTaskAddress, { kind: 'node-expansion' }>;
  proposal: PartProposalBody; bindings?: TaskObligationBinding[]; references: Ref[];
}
export interface FactValueForm {
  kind: 'fact-value-form'; task: Extract<AnswerTaskAddress, { kind: 'fact' }>;
  value: Json; references: Ref[];
}
export type AnswerFormOutcome = NodeAnswerForm | FactValueForm;

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const references = (refs: readonly Ref[]) => [...new Map(refs.map(ref => [canonical(ref), ref])).values()]
  .sort((a, b) => order(canonical(a), canonical(b)));
// H1.0d (№1715): transaction conditions of the current admission, including absences; provenance stays Ref[].
const conditions = (guards: readonly TransactionGuard[]): TransactionGuard[] => [...references(guards.filter(isRef)),
  ...new Map(guards.filter(guard => !isRef(guard)).map(guard => [guard.id, guard])).values()];
class FormFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function invalid(field: string): never {
  throw new EngineError('answer_form_request_invalid', 'Answer form checks require an exact task and explicit reply',
    { unit: 'E3', target: 'answer-form', field });
}
function fail(code: string, task: Ref, field: string, message: string): never {
  const result = refused(code, message, { unit: 'E3', target: task.id, field, ref: task }, 'producer');
  if (!result.ok) throw new FormFailure(result.refusal);
  throw new Error('Unreachable refusal');
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new FormFailure(result.refusal); return result.value; }
function result<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof FormFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function requireRequest(store: Store, request: unknown, kind: 'node' | 'fact'): void {
  if (!(store instanceof Store)) invalid('store');
  if (!object(request) || !text(request.project)) invalid('request');
  const source = kind === 'node' ? 'packet' : 'question', reply = kind === 'node' ? 'raw' : 'value';
  if (!isRef(request[source])) invalid(source);
  if (!Object.hasOwn(request, reply) || kind === 'node' && typeof request.raw !== 'string') invalid(reply);
  if (Object.keys(request).some(key => !['project', source, reply].includes(key))) invalid('request');
}
function copyRequest<T>(request: T): T {
  try { return sealed(request) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function parseReply(raw: string, task: Ref): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    if (error instanceof SyntaxError) fail('answer_form_invalid', task, 'raw', 'The reply must be typed JSON without surrounding prose');
    throw error;
  }
  try { return sealed(parsed); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'unsealable_value')
      fail('answer_form_invalid', task, 'raw', 'The reply must contain finite JSON values');
    throw error;
  }
}

/** Form checking grants neither call provenance nor acceptance of the proposed layer. */
export function checkNodeAnswerForm(store: Store, request: NodeAnswerFormRequest): OmResult<Sealed<NodeAnswerForm>> {
  requireRequest(store, request, 'node'); request = copyRequest(request);
  return result(() => {
    const checked = take(readPacketAnswer(store, request)), payload = checked.packet.value.packet;
    if (!object(payload) || payload.model !== 'MC2' || payload.task !== 'node-expansion')
      fail('answer_form_task_invalid', request.packet, 'packet', 'This form belongs to a ready node-expansion assignment');
    if (checked.answer.action !== 'answer' || !('proposal' in checked.answer))
      fail('answer_form_invalid', request.packet, 'reply', 'This check requires a substantive node answer');
    return { kind: 'node-form', task: { project: request.project, kind: 'node-expansion', packet: request.packet },
      proposal: checked.answer.proposal as PartProposalBody,
      ...(checked.answer.bindings ? { bindings: checked.answer.bindings as TaskObligationBinding[] } : {}),
      references: checked.references as Ref[] } satisfies NodeAnswerForm;
  });
}

/** This checks only the saved question's value schema; citations and acceptance have separate contracts. */
export function checkFactValueForm(store: Store, request: FactValueFormRequest): OmResult<Sealed<FactValueForm>> {
  requireRequest(store, request, 'fact'); request = copyRequest(request);
  return result(() => {
    const question = take(readMc1Question(store, { project: request.project, record: request.question }));
    // The validator is local: deserialized schema objects must not accumulate in a process-wide Ajv cache.
    const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(question.record.value.request.contract.resultForm as object);
    if (!validate(request.value))
      fail('answer_form_value_invalid', request.question, validate.errors?.[0]?.instancePath || 'value',
        'The candidate value does not match the exact saved question result form');
    return { kind: 'fact-value-form', task: { project: request.project, kind: 'fact', question: request.question },
      value: request.value, references: references([request.question, ...question.references]) } satisfies FactValueForm;
  });
}

export interface InputFieldAnswerRequest { project: string; routes: Ref; batch: string; raw: string }
export interface InputDecisionsForm {
  kind: 'input-decisions'; unanswered: string[]; input: Ref; graph: Ref; decisions: Ref[]; writes: Write[]; references: Ref[];
}
interface AssignedQuestion { id: string; target: string; field: string; consumers: string[] }
interface PacketOutcomeBase { unanswered: string[]; task: { project: string; packet: Ref }; references: Ref[] }
export type CheckedAnswerForm = PacketOutcomeBase & (
  | { kind: 'node-proposal'; proposal: LayerProposal; works?: WorksPartBindings }
  | { kind: 'fact-candidates'; facts: { questionId: string; question: Ref; value: Json; grounds: AnswerGround[] }[] }
  | InputDecisionsForm
  | { kind: 'need-source'; questionIds: string[]; missing: string; reads: PacketRead[]; questions: AssignedQuestion[] }
  | { kind: 'awaiting-owner'; recipient: 'owner'; questionIds: string[]; reason: string; decision: string; questions: AssignedQuestion[] }
  | { kind: 'no-result'; action: 'cannot_answer' | 'pause'; questionIds: string[]; reason: string; questions: AssignedQuestion[] }
);

function fieldForm(store: Store, request: InputFieldAnswerRequest, current: boolean,
  attempt: { series: Ref; ordinal: number } | null = null): InputDecisionsForm & { guards: TransactionGuard[] } {
  const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
  const batch = routes.record.value.batches.find(item => item.id === request.batch);
  if (!batch || batch.model !== 'MC2' || batch.task !== 'input-field')
    fail('answer_form_task_invalid', request.routes, 'batch', 'The exact route must assign missing input fields');
  const gaps = take(readGaps(store, routes.record.value.request.gaps as GapReadRequest));
  const source = gaps.sources, base = take(readOmInput(store, request.project, source.input));
  const graph = take(readRecord<Graph>(store, source.graph, { unit: 'E3', target: request.routes.id,
    id: `graph:${request.project}`, kind: 'graph' }));
  const parsed = parseReply(request.raw, request.routes);
  if (!object(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.results) || parsed.results.length === 0)
    fail('answer_form_invalid', request.routes, 'results', 'An input-field reply contains an explicit nonempty results array');
  const writes: Write[] = [], seen = new Set<string>();
  for (const row of parsed.results) {
    if (!object(row) || !text(row.target) || !text(row.field) || !Object.hasOwn(row, 'value') || !isRef(row.basis)
      || Object.keys(row).some(key => !['target', 'field', 'value', 'basis'].includes(key)))
      fail('answer_form_invalid', request.routes, 'results', 'Each field result names its exact target, field, value and gap basis');
    // OWN1 (№3711, №3719): a model decides a question only by a decision with its alternatives — never in the owner's form.
    if (row.field === 'answer' && !decidedAnswer(row.value))
      fail('answer_form_value_invalid', request.routes, 'results', 'A decision names what is decided and why and two or three other options with their consequences, in words of its own');
    const item = batch.items.find(item => item.target === row.target && item.field === row.field);
    const key = canonical([row.target, row.field]);
    if (!item || seen.has(key) || canonical(row.basis) !== canonical(item.record))
      fail('answer_form_task_invalid', request.routes, 'results.basis', 'A result must address a distinct assigned field and its exact D1 gap');
    seen.add(key);
    // D3 owns field semantics. These IDs only select exact lower-layer bases from this D1 source.
    const value = row.value, ids = row.field === 'address' && object(value) ? [value.consumer]
      : row.field === 'nodes' && Array.isArray(value) ? value
      : row.field === 'state' && object(value) ? Object.values(value) : [];
    const levels = [...new Set(ids.flatMap(id => {
      const node = graph.value.nodes.find(node => node.id === id); return node && LEVEL[node.kind] > 1 ? [LEVEL[node.kind]] : [];
    }))];
    const layers = levels.map(level => {
      const frame = level === 2 ? source.operations.frame : 'frame' in source.works ? source.works.frame : null;
      if (!frame?.layer) fail('answer_form_task_invalid', request.routes, 'layers', 'The assigned D1 source has no accepted layer for this consumer');
      return frame.layer;
    });
    writes.push(inputDecisionWrite({ project: request.project, input: source.input, graph: source.graph, layers,
      decision: { target: row.target, field: row.field as InputFieldDecision['field'], value: row.value as Json } }) as Write);
  }
  writes.sort((a, b) => order(a.id, b.id));
  const pending = new Map(writes.map(write => [write.id, { id: write.id, kind: write.kind, revision: 1,
    hash: hashJson(write.value), value: write.value } as Revision]));
  const view = new Proxy(store, { get(target, property) {
    if (property === 'get') return (id: string, revision?: number) =>
      pending.has(id) && (revision === undefined || revision === 1) ? pending.get(id)! : target.get(id, revision);
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const decisions = [...pending.values()].map(reference);
  const derived = take(deriveInputDecisions(view, { project: request.project, previous: base as Revision<OmInputRecord>, graph: source.graph, decisions }));
  const guards: TransactionGuard[] = [], refs = [request.routes, ...routes.references, ...derived.references];
  if (current) {
    // OWN1 (№3719 P2-1): the owner's answer is above the model's — a question the owner has answered by H2 meanwhile
    // takes no model decision; the owner's answer is applied by the pass itself.
    const owned = new Set(ownerAnswersOf(store, request.project, request.routes, source.input, { routes: readRoutes, input: readOmInput })
      .map(owner => canonical([owner.target, owner.field])));
    if (parsed.results.some((row: { target: string; field: string }) => owned.has(canonical([row.target, row.field]))))
      fail('answer_form_task_invalid', request.routes, 'results', 'The owner has answered this question by H2; the model decision is not applied');
    // OWN1: an accepted answer of another batch of the same managed attempt (its fact) moves the route's searches, never
    // this batch: the attempt still answers its own planned batch by the admission E2 issued it with, stale only when an
    // answer now covers an item of this very batch.
    const fresh = prepareRoutes(store, { ...routes.record.value.request,
      tasks: routes.record.value.request.tasks.map(record => ({ record })) } as RoutesRequest);
    const preparedRoutes = !fresh.ok && fresh.refusal.code === 'route_stale' && attempt
      ? take(prepareManagedRouteBatch(store, { project: request.project, series: attempt.series, attempt: attempt.ordinal,
        routes: request.routes, batch: request.batch }))
      : take(fresh);
    if (canonical(reference(preparedRoutes.record)) !== canonical(request.routes))
      fail('answer_form_task_invalid', request.routes, 'routes', 'Historical routing cannot grant a new form admission');
    const prepared = take(prepareAddressing(store, { project: request.project, input: source.input, graph: source.graph,
      decisions: writes.map(pending => ({ pending })) }));
    guards.push(request.routes, ...preparedRoutes.guards, ...prepared.guards);
    refs.push(...prepared.references);
  }
  // E3 publishes only proposals; the caller applies them through D3's separately guarded transition.
  const missing = current ? writes.filter(write => {
    const saved = store.get(write.id);
    if (saved && canonical(saved) !== canonical(pending.get(write.id)))
      fail('answer_form_task_invalid', request.routes, 'decision', 'The deterministic decision address contains another value');
    return !saved;
  }) : writes;
  return { kind: 'input-decisions', unanswered: batch.items.filter(item => !seen.has(canonical([item.target, item.field]))).map(item => item.gap).sort(order), input: source.input, graph: source.graph, decisions, writes: missing,
    references: references(refs), guards: conditions(guards) };
}
function requireFieldRequest(store: Store, request: unknown): asserts request is InputFieldAnswerRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.routes)
    || !text(request.batch) || typeof request.raw !== 'string'
    || Object.keys(request).some(key => !['project', 'routes', 'batch', 'raw'].includes(key))) invalid('request');
}
/** Content interface for A3.3's future mechanism series: it never creates a packet or a call admission. */
export function checkInputFieldAnswer(store: Store, request: InputFieldAnswerRequest): OmResult<Sealed<InputDecisionsForm>> {
  requireFieldRequest(store, request); request = copyRequest(request);
  return result(() => { const { guards: _guards, ...form } = fieldForm(store, request, false); return form; });
}
export function prepareInputFieldAnswer(store: Store, request: InputFieldAnswerRequest): OmResult<Sealed<InputDecisionsForm & { guards: TransactionGuard[] }>> {
  requireFieldRequest(store, request); request = copyRequest(request);
  return result(() => fieldForm(store, request, true));
}

/**
 * MP3 (№2981 п.2): the addressed result of one read, distinct from a citation. Offsets are UTF-16 units of the whole saved
 * content and are never moved around a surrogate pair; a pointer walks own properties exactly as Evidence and context reads do.
 */
export const READ_RESULT_CONTRACT = 'om-read-result/v1' as const;
export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export interface JsonShape { type: JsonType; keys: string[]; length?: number }
export type ReadRange = { start: number; end: number };
export type ReadResult =
  | { contract: typeof READ_RESULT_CONTRACT; outcome: 'complete' | 'clipped'; requested: ReadRange; length: number; unit: 'utf16'; served: ReadRange; text: string }
  | { contract: typeof READ_RESULT_CONTRACT; outcome: 'outside'; requested: ReadRange; length: number; unit: 'utf16'; served: null; text: null }
  | { contract: typeof READ_RESULT_CONTRACT; outcome: 'complete'; requested: { pointer: string }; value: Json }
  | { contract: typeof READ_RESULT_CONTRACT; outcome: 'missing'; requested: { pointer: string }; missing: string; parent: { pointer: string } & JsonShape };
/** The one pointer syntax of Evidence and saved context: '' or '/'-prefixed, ~ escaped only as ~0 and ~1. */
export function pointerSegments(pointer: unknown): { encoded: string[]; decoded: string[] } | null {
  if (typeof pointer !== 'string' || pointer !== '' && !pointer.startsWith('/')) return null;
  const encoded = pointer === '' ? [] : pointer.slice(1).split('/');
  if (encoded.some(part => /~(?![01])/.test(part))) return null;
  return { encoded, decoded: encoded.map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')) };
}
export function jsonShape(value: unknown): JsonShape {
  if (value === null) return { type: 'null', keys: [] };
  if (Array.isArray(value)) return { type: 'array', keys: Object.keys(value), length: value.length };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).sort(order) };
  return { type: typeof value as 'string' | 'number' | 'boolean', keys: [] };
}
/** Requires a checked range (safe integers, 0 <= start < end); the length is that of the whole saved content. */
export function readTextResult(content: string, range: ReadRange): ReadResult {
  const length = content.length, requested = { start: range.start, end: range.end };
  if (range.start >= length) return { contract: READ_RESULT_CONTRACT, outcome: 'outside', requested, length, unit: 'utf16', served: null, text: null };
  const end = Math.min(range.end, length);
  return { contract: READ_RESULT_CONTRACT, outcome: end < range.end ? 'clipped' : 'complete', requested, length, unit: 'utf16',
    served: { start: range.start, end }, text: content.slice(range.start, end) };
}
/** Null for a syntactically invalid pointer; an absent segment is a result, never a refusal. */
export function readPointerResult(value: unknown, pointer: string): ReadResult | null {
  const segments = pointerSegments(pointer);
  if (!segments) return null;
  let current = value;
  for (let index = 0; index < segments.decoded.length; index++) {
    const key = segments.decoded[index]!;
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key))
      return { contract: READ_RESULT_CONTRACT, outcome: 'missing', requested: { pointer }, missing: key,
        parent: { pointer: index ? `/${segments.encoded.slice(0, index).join('/')}` : '', ...jsonShape(current) } };
    current = (current as Record<string, unknown>)[key];
  }
  return { contract: READ_RESULT_CONTRACT, outcome: 'complete', requested: { pointer }, value: JSON.parse(canonical(current)) as Json };
}
/** The form E3 admits for an addressed read in the MP3 era; existence and length are results of the read itself. */
export function readSelectorProblem(selector: unknown, media: unknown): string | null {
  if (!object(selector)) return 'A read selector is a text-range or json-pointer object';
  const keys = Object.keys(selector);
  if (selector.kind === 'text-range') {
    if (keys.length !== 3 || !keys.every(key => ['kind', 'start', 'end'].includes(key)))
      return 'A text range has exactly kind, start and end';
    const { start, end } = selector;
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0 && (end as number) > (start as number) ? null
      : 'A text range needs safe integers 0 <= start < end in UTF-16 units';
  }
  if (selector.kind === 'json-pointer') {
    if (keys.length !== 2 || !keys.every(key => ['kind', 'pointer'].includes(key))) return 'A JSON pointer selector has exactly kind and pointer';
    if (!pointerSegments(selector.pointer)) return 'Use a JSON pointer that is empty or starts with / and escapes ~ as ~0 and / as ~1';
    return media === 'application/json' ? null : 'A JSON pointer selects only from a JSON source';
  }
  return 'A read selector is a text-range or json-pointer object';
}
/** MP3 E3 admission of read_source: exact source and selector form, never its length or the existence of a segment. */
function sourceRead(store: Store, project: string, task: Ref, read: Extract<PacketRead, { action: 'read_source' }>): Ref[] {
  const found = store.get<Source>(read.source.id, read.source.revision);
  const row = found && same(reference(found), read.source) && object(found.value) ? found : null;
  if (!row || row.value.content !== '') {
    // D5's shared exact-source proof keeps its own refusal for a missing, foreign or damaged source; for an intact
    // nonempty source it is the whole saved text, as at delivery.
    const length = row && typeof row.value.content === 'string' ? row.value.content.length : 1;
    take(readAnswerCitations(store, { project, citations: [{ source: read.source, selector: { kind: 'text-range', start: 0, end: length } }] }));
  } else if (row.kind !== 'source' || !read.source.id.startsWith(`source:${project}:`) || row.value.projectId !== project
    || digest('') !== row.value.sha256 || row.value.mediaType !== 'text/plain' || !object(row.value.origin)
    || !['file', 'owner-document'].includes(row.value.origin.kind) || !text(row.value.origin.location))
    // An empty source has no nonempty range for D5; an empty JSON source is malformed.
    fail('answer_form_address_invalid', task, 'source', 'A read needs an exact intact source of this project');
  const problem = readSelectorProblem(read.selector, found!.value.mediaType);
  if (problem) fail('answer_form_address_invalid', task, 'selector', problem);
  return [read.source];
}
function contextRecord(store: Store, project: string, task: Ref, ref: Ref) {
  const record = store.get(ref.id, ref.revision), namespace = ref.id.slice(0, ref.id.indexOf(':'));
  const address = `${namespace}:${project}`;
  if (!record || record.hash !== ref.hash || !object(record.value)
    || !(ref.id === address || ref.id.startsWith(`${address}:`))
    || ('project' in record.value && record.value.project !== project)
    || ('projectId' in record.value && record.value.projectId !== project))
    fail('answer_form_address_invalid', task, 'record', 'An address must resolve to an exact record of this project');
  return record;
}
function checkReads(store: Store, request: PacketAnswerRequest, packet: Revision<QuestionPacketRecord>, reads: PacketRead[], current: boolean): Ref[] {
  const refs: Ref[] = [];
  const path = (value: string) => {
    if (packet.value.answerProtocol === 'omg-answer/v3' ? !packetReadPath(value)
      : !safeRelativePath(value) || value.split('/').some(part => part.toLowerCase() === '.git'))
      fail('answer_form_address_invalid', request.packet, 'path', 'A read needs an explicit path inside the selected project');
    if (current) {
      const environment = take(readRecord<Environment>(store, packet.value.request.environment,
        { unit: 'E3', target: request.packet.id, id: `environment:${request.project}`, kind: 'environment' }));
      try { workspacePath(environment.value.workspace, value); }
      catch (error) {
        if (error instanceof EngineError && ['path_invalid', 'path_escape'].includes(error.code))
          fail('answer_form_address_invalid', request.packet, 'path', error.message);
        throw error;
      }
    }
  };
  // MP3: the era of the exact packet selects the read protocol; a packet without readings keeps the D5 citation check (№57).
  const addressed = briefReadings(packet.value.packet) !== null;
  for (const read of reads) {
    if (read.action === 'read') path(read.path);
    else if (read.action === 'read_source') {
      if (addressed) { refs.push(...sourceRead(store, request.project, request.packet, read)); continue; }
      const cited = take(readAnswerCitations(store, { project: request.project, citations: [{ source: read.source, selector: read.selector }] }));
      refs.push(...cited.references);
    } else if (read.action === 'read_context') {
      const record = contextRecord(store, request.project, request.packet, read.record);
      if (addressed) {
        if (!pointerSegments(read.pointer)) fail('answer_form_address_invalid', request.packet, 'pointer', 'Use a JSON pointer');
        refs.push(read.record); continue;
      }
      try { contextValue(record.value, read.pointer); }
      catch (error) {
        if (error instanceof EngineError && ['selector_invalid', 'context_missing'].includes(error.code))
          fail('answer_form_address_invalid', request.packet, 'pointer', error.message);
        throw error;
      }
      refs.push(read.record);
    } else {
      if (!text(read.query) || read.query.length > 1000)
        fail('answer_form_address_invalid', request.packet, 'query', 'Search needs a bounded nonempty literal query in an explicit scope');
      if (typeof read.within === 'string') path(read.within);
      else { contextRecord(store, request.project, request.packet, read.within); refs.push(read.within); }
    }
  }
  return refs;
}
function answerForm(store: Store, request: PacketAnswerRequest, current: boolean): CheckedAnswerForm & { guards: TransactionGuard[] } {
  const checked = take(readPacketAnswer(store, request));
  const packet = checked.packet, answer = checked.answer, payload = packet.value.packet as Record<string, Json>;
  const guards: TransactionGuard[] = [], refs = [...checked.references];
  if (current) {
    const prepared = take(prepareQuestionPacket(store, packet.value.request as QuestionPacketRequest));
    if (canonical(reference(prepared.record)) !== canonical(request.packet))
      fail('answer_form_task_invalid', request.packet, 'packet', 'The exact saved packet is not admitted for current work');
    guards.push(request.packet, ...prepared.guards); refs.push(...prepared.references);
  }
  const task = { project: request.project, packet: request.packet };
  if (answer.action !== 'answer') {
    const questions = (payload.questions as unknown as AssignedQuestion[]).filter(q => answer.questionIds.includes(q.id))
      .map(q => ({ id: q.id, target: q.target, field: q.field, consumers: [...q.consumers] }));
    const common = { task, unanswered: (payload.questions as unknown as AssignedQuestion[]).map(q => q.id).sort(order), questionIds: [...answer.questionIds], questions, guards: conditions(guards) };
    if (answer.action === 'need_source') {
      refs.push(...checkReads(store, request, packet as Revision<QuestionPacketRecord>, answer.reads as PacketRead[], current));
      return { ...common, kind: 'need-source', missing: answer.missing, reads: answer.reads as PacketRead[], references: references(refs) };
    }
    // OWN1 (№3719 P2-2): a question the bypass gives the model is decided by it; the owner is not asked in this pass.
    if (answer.action === 'need_owner' && (payload.questions as unknown as AssignedQuestion[]).some(q => q.field === 'answer')
      && payload.task === 'input-field')
      fail('part_answer_invalid', request.packet, 'reply', 'Decide the question: a decision, why, and two or three other options with their consequences');
    if (answer.action === 'need_owner') return { ...common, kind: 'awaiting-owner', recipient: 'owner',
      reason: answer.reason, decision: answer.decision, references: references(refs) };
    return { ...common, kind: 'no-result', action: answer.action, reason: answer.reason, references: references(refs) };
  }
  if ('proposal' in answer) {
    const derived = take(derivePartProposal(store, request));
    const filled = new Set([...derived.proposal.fills, ...derived.proposal.replaces].map(fill => fill.obligation));
    return { task, unanswered: (payload.questions as unknown as AssignedQuestion[]).filter(q => !filled.has(q.target)).map(q => q.id).sort(order),
      kind: 'node-proposal', proposal: derived.proposal as LayerProposal,
      ...(derived.works ? { works: derived.works as WorksPartBindings } : {}),
      references: references([...refs, ...derived.references]), guards: conditions(guards) };
  }
  if (payload.model === 'MC1') {
    const seen = new Set<string>(), facts: Extract<CheckedAnswerForm, { kind: 'fact-candidates' }>['facts'] = [];
    const questions = payload.questions as unknown as AssignedQuestion[];
    const routed = take(readRoutes(store, { project: request.project, record: packet.value.request.routes }));
    const batch = routed.record.value.batches.find(batch => batch.id === packet.value.request.batch)!;
    for (const row of answer.results) {
      if (!('questionId' in row) || seen.has(row.questionId) || !questions.some(q => q.id === row.questionId))
        fail('answer_form_task_invalid', request.packet, 'results.questionId', 'Each fact must answer a distinct question of this exact assignment');
      seen.add(row.questionId);
      const item = batch.items.find(item => item.gap === row.questionId);
      const native = item && packet.value.native.find(native => canonical(native.gap) === canonical(item.record));
      if (!native) fail('answer_form_task_invalid', request.packet, 'native', 'The fact needs the saved MC1 question issued for its assigned gap');
      const value = take(checkFactValueForm(store, { project: request.project, question: native.question, value: row.value as Json }));
      const citationRequest = { project: request.project, citations: row.citations as AnswerCitation[] };
      const citations = current ? take(prepareAnswerCitations(store, citationRequest)) : { ...take(readAnswerCitations(store, citationRequest)), guards: [] };
      guards.push(...citations.guards);
      refs.push(...value.references, ...citations.references);
      facts.push({ questionId: row.questionId, question: native.question, value: row.value as Json, grounds: citations.grounds as AnswerGround[] });
    }
    return { task, unanswered: questions.filter(q => !seen.has(q.id)).map(q => q.id).sort(order), kind: 'fact-candidates', facts, references: references(refs), guards: conditions(guards) };
  }
  const fields = fieldForm(store, { project: request.project, routes: packet.value.request.routes,
    batch: packet.value.request.batch!, raw: canonical({ results: answer.results }) }, current, packet.value.request.attempt);
  return { ...fields, task, references: references([...refs, ...fields.references]), guards: conditions([...guards, ...fields.guards]) };
}
/** Historical content checking. E4 must independently bind it to a saved adapter response and admitted call. */
export function checkAnswerForm(store: Store, request: PacketAnswerRequest): OmResult<Sealed<CheckedAnswerForm>> {
  requireRequest(store, request, 'node'); request = copyRequest(request);
  return result(() => { const { guards: _guards, ...checked } = answerForm(store, request, false); return checked; });
}
/** Current preparation supplies guards, without delivery, acceptance, series changes or call settlement. */
export function prepareAnswerForm(store: Store, request: PacketAnswerRequest): OmResult<Sealed<CheckedAnswerForm & { guards: TransactionGuard[] }>> {
  requireRequest(store, request, 'node'); request = copyRequest(request);
  return result(() => answerForm(store, request, true));
}
