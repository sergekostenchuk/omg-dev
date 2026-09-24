import { Ajv } from 'ajv';
import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type Write } from '../storage/store.js';
import { readMc1Question, readAnswerCitations, prepareAnswerCitations, type AnswerGround, type AnswerCitation } from './accepted-answer.js';
import { contextValue } from '../discovery/working-context.js';
import { safeRelativePath } from '../graph/topology.js';
import { LEVEL, type Graph } from '../graph/model.js';
import { workspacePath, type Environment } from '../runtime/environment.js';
import { readRecord } from './refs.js';
import { readRoutes, prepareRoutes, type RoutesRequest } from './routes.js';
import { readGaps, type GapReadRequest } from './gaps.js';
import { inputDecisionWrite, deriveInputDecisions, prepareAddressing, type InputFieldDecision } from './addressing.js';
import { readOmInput, withHistoricalReads, type OmInputRecord } from './input.js';
import { readPacketAnswer, derivePartProposal, prepareQuestionPacket, type PartProposalBody, type PacketAnswerRequest,
  type PacketRead, type QuestionPacketRecord, type QuestionPacketRequest, type WorksPartBindings } from './question-packet.js';
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
const references = (refs: readonly Ref[]) => [...new Map(refs.map(ref => [canonical(ref), ref])).values()]
  .sort((a, b) => order(canonical(a), canonical(b)));
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

function fieldForm(store: Store, request: InputFieldAnswerRequest, current: boolean): InputDecisionsForm & { guards: Ref[] } {
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
  const guards: Ref[] = [], refs = [request.routes, ...routes.references, ...derived.references];
  if (current) {
    const preparedRoutes = take(prepareRoutes(store, { ...routes.record.value.request,
      tasks: routes.record.value.request.tasks.map(record => ({ record })) } as RoutesRequest));
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
    references: references(refs), guards: references(guards) };
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
export function prepareInputFieldAnswer(store: Store, request: InputFieldAnswerRequest): OmResult<Sealed<InputDecisionsForm & { guards: Ref[] }>> {
  requireFieldRequest(store, request); request = copyRequest(request);
  return result(() => fieldForm(store, request, true));
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
    if (!safeRelativePath(value) || value.split('/').some(part => part.toLowerCase() === '.git'))
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
  for (const read of reads) {
    if (read.action === 'read') path(read.path);
    else if (read.action === 'read_source') {
      const cited = take(readAnswerCitations(store, { project: request.project, citations: [{ source: read.source, selector: read.selector }] }));
      refs.push(...cited.references);
    } else if (read.action === 'read_context') {
      const record = contextRecord(store, request.project, request.packet, read.record);
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
function answerForm(store: Store, request: PacketAnswerRequest, current: boolean): CheckedAnswerForm & { guards: Ref[] } {
  const checked = take(readPacketAnswer(store, request));
  const packet = checked.packet, answer = checked.answer, payload = packet.value.packet as Record<string, Json>;
  const guards: Ref[] = [], refs = [...checked.references];
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
    const common = { task, unanswered: (payload.questions as unknown as AssignedQuestion[]).map(q => q.id).sort(order), questionIds: [...answer.questionIds], questions, guards: references(guards) };
    if (answer.action === 'need_source') {
      refs.push(...checkReads(store, request, packet as Revision<QuestionPacketRecord>, answer.reads as PacketRead[], current));
      return { ...common, kind: 'need-source', missing: answer.missing, reads: answer.reads as PacketRead[], references: references(refs) };
    }
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
      references: references([...refs, ...derived.references]), guards: references(guards) };
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
    return { task, unanswered: questions.filter(q => !seen.has(q.id)).map(q => q.id).sort(order), kind: 'fact-candidates', facts, references: references(refs), guards: references(guards) };
  }
  const fields = fieldForm(store, { project: request.project, routes: packet.value.request.routes,
    batch: packet.value.request.batch!, raw: canonical({ results: answer.results }) }, current);
  return { ...fields, task, references: references([...refs, ...fields.references]), guards: references([...guards, ...fields.guards]) };
}
/** Historical content checking. E4 must independently bind it to a saved adapter response and admitted call. */
export function checkAnswerForm(store: Store, request: PacketAnswerRequest): OmResult<Sealed<CheckedAnswerForm>> {
  requireRequest(store, request, 'node'); request = copyRequest(request);
  return result(() => { const { guards: _guards, ...checked } = answerForm(store, request, false); return checked; });
}
/** Current preparation supplies guards, without delivery, acceptance, series changes or call settlement. */
export function prepareAnswerForm(store: Store, request: PacketAnswerRequest): OmResult<Sealed<CheckedAnswerForm & { guards: Ref[] }>> {
  requireRequest(store, request, 'node'); request = copyRequest(request);
  return result(() => answerForm(store, request, true));
}
