import { Ajv } from 'ajv';
import type { Selector } from '../evidence/evidence.js';
import { graphV2Schema } from '../graph/schema.js';
import { readCall, type AnyCallRecord } from './call-record.js';
import { readContinuationEvidence, prepareModelAttemptFinish, prepareCompletionPacket, prepareManagedEnvironment, pendingCallStore } from './model-call.js';
import { canonical, hashJson, type Json } from '../canonical.js';
import { boundedContext } from '../compiler/context.js';
import { Discovery } from '../discovery/discovery.js';
import { LEVEL, type Graph } from '../graph/model.js';
import { RefinementRelations } from '../graph/relations.js';
import { taskObligationBindingSchema, type TaskObligationBinding } from '../graph/task-obligation-model.js';
import { checkTaskObligationBinding, taskBindingId, taskObligations } from '../graph/task-obligations.js';
import type { CarriedObligation } from '../graph/obligation-policy.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Write, type Revision, type TransactionGuard } from '../storage/store.js';
import { captureView } from '../storage/store-view.js';
import { prepareAnswerTask, readAnswerTaskBasis, mc1FieldSpec, prepareMc1Question, readMc1Question,
  type AnswerTaskRequest, type CheckedAnswerTask } from './accepted-answer.js';
import { readCapacity } from './capacity.js';
import { prepareRoutes, prepareManagedRouteBatch, readRoutes, type RoutedBatch, type RoutesRecord } from './routes.js';
import { prepareFrameProposals, readFrameProposals, observeProposal, type LayerProposal, type FrameProposals } from './frame-proposals.js';
import { flowKey, WORKS_FRAME_CONTRACT, type FrameObligation } from './frame-obligations.js';
import { readCompletionBinding, readAnySeriesAt, readMechanismAdmission, prepareSeriesLineAdmission, type RepairSeries, type AnyRepairSeries } from './series.js';
import { readJournal, journalId, type RefusalJournal } from './refusal-journal.js';
import { prepareCurrentGaps, readGaps, type GapReadRequest, type GapRecords } from './gaps.js';
import { gapLineKey, gapLineExpectedResult } from './gap-lines.js';
import { historicalRead, withHistoricalReads } from './input.js';
import { delivered, refused, sealed, isPlainObject, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readRecord, writeGuarded } from './refs.js';
import { prepareOmObligations, readOmObligations, type ObligationRequest, type OmObligations, type OmObligationHandoff } from './obligations.js';

export const QUESTION_PACKET_CODES = Object.freeze([
  'question_packet_request_invalid', 'packet_task_set_invalid', 'packet_attempt_invalid', 'packet_record_invalid',
  'packet_series_unsupported',
  'packet_context_unbounded', 'packet_too_large', 'node_unexpandable', 'packet_batch_invalid', 'packet_chain_invalid',
  'part_result_invalid', 'part_answer_invalid', 'research_no_progress',
] as const);
export interface QuestionTaskRequest {
  project: string;
  gaps: GapReadRequest;
  questions: { gap: Ref; requirements: { pointer: string }[]; resultForm: Json }[];
}
export interface PreparedQuestionTasks {
  tasks: CheckedAnswerTask[];
  writes: Write[];
  guards: Ref[];
  references: Ref[];
}

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const unique = <T>(values: readonly T[]): T[] => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
class PacketFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(value: OmResult<T>): T { if (!value.ok) throw new PacketFailure(value.refusal); return value.value; }
function fail(code: string, target: string, field: string, message: string, ref?: Ref): never {
  const failure = refused(code, message, { unit: 'E2', target, field, ref }, 'producer');
  if (!failure.ok) throw new PacketFailure(failure.refusal);
  throw new Error('Unreachable refusal');
}
function invalid(field: string): never {
  throw new EngineError('question_packet_request_invalid', 'A question packet requires explicit complete source addresses',
    { unit: 'E2', target: 'question-packet', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function result<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof PacketFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function requireTasks(store: Store, value: unknown): asserts value is QuestionTaskRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(value) || !text(value.project) || !object(value.gaps) || !object(value.gaps.sources)
    || !Array.isArray(value.gaps.records) || !value.gaps.records.every(isRef) || !Array.isArray(value.questions)) invalid('request');
  for (const question of value.questions) {
    if (!object(question) || !isRef(question.gap) || !Array.isArray(question.requirements)
      || !question.requirements.every(item => object(item) && typeof item.pointer === 'string')
      || !Object.hasOwn(question, 'resultForm')) invalid('questions');
  }
}

/** Producer tasks precede M6. Their four-part contracts are derived only by D5. */
export function prepareQuestionTasks(store: Store, request: QuestionTaskRequest): OmResult<Sealed<PreparedQuestionTasks>> {
  requireTasks(store, request); request = copy(request);
  return result(() => {
    const gaps = take(readGaps(store, request.gaps));
    if (gaps.sources.project !== request.project)
      fail('packet_task_set_invalid', request.project, 'gaps', 'The complete D1 source must belong to this project');
    const current = take(prepareCurrentGaps(store, request.gaps));
    for (const ref of request.gaps.records) {
      const head = store.get(ref.id);
      if (!head || !same(reference(head), ref))
        fail('input_stale', ref.id, 'gaps', 'The producer task set needs the current exact gap revisions');
    }
    const needed = gaps.records.filter(record => record.value.gap.kind === 'repository-fact'
      && record.value.gap.code !== 'inventory_missing' && !record.value.gap.deferral);
    const offered = new Map<string, QuestionTaskRequest['questions'][number]>();
    for (const question of request.questions) {
      if (offered.has(question.gap.id) || !needed.some(record => same(reference(record), question.gap)))
        fail('packet_task_set_invalid', question.gap.id, 'questions', 'Every descriptor must name a distinct active fact in the exact D1 set');
      offered.set(question.gap.id, question);
    }
    for (const record of needed) if (!offered.has(record.id))
      fail('packet_task_set_invalid', record.value.gap.target, 'questions', 'An active fact has no producer question descriptor');
    const tasks: CheckedAnswerTask[] = [];
    for (const record of sorted(needed)) {
      const descriptor = offered.get(record.id)!;
      const source: AnswerTaskRequest = { project: request.project, input: gaps.sources.input,
        gaps: request.gaps, gap: reference(record), requirements: descriptor.requirements, resultForm: descriptor.resultForm };
      tasks.push(take(prepareAnswerTask(store, source)) as CheckedAnswerTask);
    }
    return { tasks, writes: tasks.flatMap(task => task.writes),
      guards: unique([...current.guards, ...request.gaps.records, ...tasks.flatMap(task => task.guards)]),
      references: unique([...current.references, ...request.gaps.records, ...tasks.flatMap(task => task.references)]) };
  });
}

export function writeQuestionTasks(store: Store, request: QuestionTaskRequest): OmResult<Sealed<PreparedQuestionTasks>> {
  requireTasks(store, request);
  return result(() => {
    const prepared = take(prepareQuestionTasks(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'E2', target: request.project,
      writes: prepared.writes as Write[], guards: prepared.guards as Ref[] }));
    return prepared as PreparedQuestionTasks;
  });
}

export interface QuestionPacketRequest {
  project: string; routes: Ref; batch: string | null; environment: Ref;
  attempt: { series: Ref; ordinal: number } | null;
  previous: { packet: Ref; proposal: Ref; result: Ref }[];
  works?: { producer: Ref; ledger: Ref };
  continuation?: { packet: Ref; call: Ref; response: Ref; deliveries: Ref[] };
}
export interface QuestionPacketRecord {
  project: string; request: QuestionPacketRequest; state: 'ready' | 'blocked' | 'empty';
  answerProtocol?: 'omg-answer/v2';
  packetContract?: 'om-packet/v3' | 'om-packet/works-v1';
  packet: Json | null; fingerprint: { hash: string; chars: number; utf8Bytes: number } | null;
  native: { gap: Ref; draft: Ref; engineQuestion: Ref; question: Ref }[];
  plan: { mode: 'whole' | 'parts'; assignments: { connector: string | null; obligations: string[] }[]; position: number } | null;
  fullChars: number | null; refusal: Refusal | null; journal: Ref | null;
}
export interface PreparedQuestionPacket {
  record: Revision<QuestionPacketRecord>; writes: Write[]; guards: TransactionGuard[]; references: Ref[]; existing: boolean;
}
export const QUESTION_PACKET_KIND = 'question-packet';
const packetNamespace = (project: string) => `om-question-packet:${project}:`;
export const PACKET_ANSWER_PROTOCOL = 'omg-answer/v2' as const;
export const PACKET_CONTRACT = 'om-packet/v3' as const;
export const WORKS_PACKET_CONTRACT = 'om-packet/works-v1' as const;
const packetWorkContract = (packet: QuestionPacketRecord) => packet.packetContract === WORKS_PACKET_CONTRACT ? WORKS_FRAME_CONTRACT : undefined;
function currentPacketContract(store: Store, request: QuestionPacketRequest) {
  const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
  const batch = routes.record.value.batches.find(item => item.id === request.batch);
  return batch?.task === 'node-expansion' && batch.level === 3 ? WORKS_PACKET_CONTRACT : PACKET_CONTRACT;
}
const packetKey = (request: QuestionPacketRequest, protocol: QuestionPacketRecord['answerProtocol'], contract?: QuestionPacketRecord['packetContract']) =>
  hashJson(contract ? { contract, protocol, request } : protocol ? { protocol, request } : request);
const packetId = (request: QuestionPacketRequest, protocol: QuestionPacketRecord['answerProtocol'], contract?: QuestionPacketRecord['packetContract']) =>
  `${packetNamespace(request.project)}${packetKey(request, protocol, contract)}`;
const json = (value: unknown) => copy(value) as Json;
function requirePacket(store: Store, value: unknown): asserts value is QuestionPacketRequest {
  if (!(store instanceof Store) || !object(value) || !text(value.project) || !isRef(value.routes)
    || !(value.batch === null || text(value.batch)) || !isRef(value.environment)
    || !(value.attempt === null || (object(value.attempt) && isRef(value.attempt.series)
      && Number.isSafeInteger(value.attempt.ordinal) && (value.attempt.ordinal as number) > 0
      && Object.keys(value.attempt).every(key => ['series', 'ordinal'].includes(key))))
    || !Array.isArray(value.previous) || !value.previous.every(item => object(item) && isRef(item.packet) && isRef(item.proposal) && isRef(item.result)
      && Object.keys(item).every(key => ['packet', 'proposal', 'result'].includes(key)))
    || Object.hasOwn(value, 'works') && (!object(value.works) || !isRef(value.works.producer) || !isRef(value.works.ledger)
      || Object.keys(value.works).some(key => !['producer', 'ledger'].includes(key)))
    || Object.hasOwn(value, 'continuation') && (!object(value.continuation)
      || ![value.continuation.packet, value.continuation.call, value.continuation.response].every(isRef)
      || !Array.isArray(value.continuation.deliveries) || !value.continuation.deliveries.length
      || !value.continuation.deliveries.every(isRef)
      || Object.keys(value.continuation).some(key => !['packet', 'call', 'response', 'deliveries'].includes(key)))
    || Object.keys(value).some(key => !['project', 'routes', 'batch', 'environment', 'attempt', 'previous', 'continuation', 'works'].includes(key))) invalid('request');
}
function head(store: Store, ref: Ref) {
  const found = store.get(ref.id);
  if (!found || !same(reference(found), ref)) fail('input_stale', ref.id, 'head', 'A packet source changed before this preparation');
}
function pinned(store: Store, record: Revision<unknown>): Store {
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => id === record.id
      && (revision === undefined || revision === record.revision) ? record : target.get(id, revision);
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
}
function previousRefusals(store: Store, request: QuestionPacketRequest, batch: RoutedBatch, gaps: GapRecords, current: boolean,
  savedJournal: Ref | null | undefined, guards: TransactionGuard[], references: Ref[], contract: QuestionPacketRecord['packetContract']) {
  if (!request.attempt) fail('packet_attempt_invalid', batch.id, 'attempt', 'A model packet needs the attempt declared before assembly');
  const ref = request.attempt.series;
  const record = take(readRecord<AnyRepairSeries>(store, ref, { unit: 'E2', target: batch.id,
    idPrefix: `repair-series:${request.project}:`, kind: 'repair-series' }));
  const value = record.value;
  const mechanism = (contract === PACKET_CONTRACT || contract === WORKS_PACKET_CONTRACT) && 'owner' in value;
  if ('owner' in value && !mechanism)
    fail('packet_series_unsupported', batch.id, 'attempt', 'This historical packet era does not admit mechanism-owned series', ref);
  const proof = mechanism ? take(readMechanismAdmission(store, { project: request.project, series: ref,
    attempt: request.attempt.ordinal, admission: { routes: request.routes, batch: batch.id,
      gaps: { sources: gaps.sources, records: gaps.records.map(reference) } }, current })) : null;
  const checked = proof?.series ?? take(readAnySeriesAt(store, request.project, ref));
  if (proof) { guards.push(...proof.guards); references.push(...proof.references); }
  const attempt = checked.value.attempts.find(item => item.ordinal === request.attempt!.ordinal);
  if (!attempt || attempt.outcome !== null || checked.value.stop)
    fail('packet_attempt_invalid', batch.id, 'attempt', 'This exact series does not contain the declared running attempt');
  // These are the same line addresses, result and consumer checked by D5/D2 on acceptance.
  // Check the entire node assignment here, before its packet is split into individual parts.
  for (const item of batch.items) {
    const gap = gaps.records.find(row => same(reference(row), item.record))?.value.gap;
    if (!gap) fail('packet_batch_invalid', item.target, 'gap', 'The routed item has no exact D1 source');
    if (!mechanism && !gap.consumers.length && gap.mechanism)
      fail('packet_series_unsupported', item.target, item.field,
        `Серия механизма не поддержана: ${gap.mechanism}; необходим договор владельца серии A3`, item.record);
    if (!attempt.goal.questions.includes(gapLineKey(request.project, item.target, item.field))
      || attempt.goal.result !== gapLineExpectedResult(request.project, item.target, item.field)
      || !mechanism && (!gap.consumers.includes((checked.value as RepairSeries).block)
      || batch.task === 'node-expansion' && batch.level === 2 && (checked.value as RepairSeries).block !== batch.node))
      fail('packet_attempt_invalid', item.target, 'attempt.goal',
        'The declared attempt must name this result at its exact gap-line address and belong to its consumer', item.record);
  }
  if (current) {
    if (mechanism) { head(store, ref); guards.push(ref); }
    else guards.push(...take(prepareSeriesLineAdmission(store, request.project, ref)).guards);
  }
  references.push(ref);
  // A3 owns goal identity. E2 only carries refusals from the preceding attempt of that same declared goal.
  const prior = [...checked.value.inherited, ...checked.value.attempts].filter(item => item.ordinal < attempt.ordinal
    && same(item.goal, attempt.goal)).at(-1);
  const rows = prior?.outcome?.refusals ?? [];
  if (!rows.length) {
    if (savedJournal) fail('packet_record_invalid', batch.id, 'journal', 'An unused journal cannot be added to a packet');
    return { journal: null, refusals: [] };
  }
  const journalRef = savedJournal === undefined ? reference(take(readJournal(store, { project: request.project }))) : savedJournal;
  if (!journalRef) fail('packet_record_invalid', batch.id, 'journal', 'A repeated question must preserve its refusal source');
  const journal = take(readRecord<RefusalJournal>(store, journalRef, { unit: 'E2', target: batch.id,
    id: journalId(request.project), kind: 'om-refusal-journal' }));
  const checkedJournal = take(readJournal(pinned(store, journal), { project: request.project }));
  references.push(journalRef);
  if (current) { head(store, journalRef); guards.push(journalRef); }
  const addresses = new Set(batch.items.flatMap(item => [item.target, item.gap]));
  const refusals = rows.map(link => {
    const row = checkedJournal.value.rows.find(row => row.id === link.row);
    if (!row) fail('packet_record_invalid', link.row, 'refusals', 'The preceding attempt names a missing journal row');
    return row;
  }).filter(row => addresses.has(row.goal)).map(row => ({ code: row.code, target: row.goal }));
  return { journal: journalRef, refusals: sorted(refusals) };
}

/** Capture the native producer's writes. The real Store sees them only in E2's guarded transaction. */
function nativeQuestions(store: Store, project: string, tasks: CheckedAnswerTask[], guards: TransactionGuard[]) {
  // Q1 + №1734-13: both write methods are intercepted by one batch helper; the
  // additions to the caller's guard set stay LOCAL until the whole pack is
  // accepted — a failure leaves no observed dependencies behind.
  const localGuards: TransactionGuard[] = [];
  const rows = new Map<string, Revision>();
  const captured = captureView(store, {
    rows,
    admit: write => {
      if (write.expected !== 0) fail('packet_record_invalid', write.id, 'native', 'Native issuance must create distinct records');
    },
    get: (id, revision) => {
      const pending = rows.get(id);
      if (pending && (revision === undefined || revision === pending.revision)) return pending;
      const record = store.get(id, revision);
      if (revision === undefined && record) localGuards.push(reference(record));
      return record;
    },
  });
  const native: QuestionPacketRecord['native'] = [];
  for (const task of tasks) {
    const draft = new Discovery(captured.view).create(project, 'om-g2', 'R1', task.gap.consumers[0]!,
      [mc1FieldSpec({ input: task.request.input, gap: task.request.gap, contract: task.contract })],
      [task.request.input, task.request.gap, reference(task.record)]);
    const engineQuestion = reference(rows.get(draft.value.questions[0]!)!);
    const { resultForm: _resultForm, ...sources } = task.request;
    const question = take(prepareMc1Question(captured.view, { ...sources, contract: task.contract,
      engineQuestion, draft: reference(draft), task: reference(task.record) }));
    captured.writes.push(...question.writes); localGuards.push(...question.guards);
    native.push({ gap: task.request.gap, draft: reference(draft), engineQuestion, question: reference(question.record) });
  }
  // Guards on captured rows are fulfilled by these expected=0 writes; real dependencies remain protected.
  // Every guard the producers attached during the capture rides to the final E2 (№1760-1): the
  // helper accepted them, the connection must not drop them. Ref and absent are both kept.
  const pendingRefs = new Set(captured.writes.map(write => canonical({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) })));
  return { native, writes: captured.writes,
    guards: [...guards, ...localGuards, ...captured.guards].filter(ref => !pendingRefs.has(canonical(ref))) };
}
function checkNative(store: Store, project: string, tasks: CheckedAnswerTask[], native: QuestionPacketRecord['native'], current: boolean, guards: TransactionGuard[]) {
  if (!Array.isArray(native) || native.length !== tasks.length)
    fail('packet_record_invalid', project, 'native', 'Each fact in the packet needs its complete native question');
  return native.flatMap((item, index) => {
    if (!object(item) || ![item.gap, item.draft, item.engineQuestion, item.question].every(isRef))
      fail('packet_record_invalid', project, 'native', 'Issued questions must preserve all exact references');
    const task = tasks[index]!;
    const checked = take(readMc1Question(store, { project, record: item.question }));
    const { resultForm: _resultForm, ...sources } = task.request;
    const expected = { ...sources, contract: task.contract, engineQuestion: item.engineQuestion,
      draft: item.draft, task: reference(task.record) };
    if (!same(item.gap, task.request.gap) || !same(checked.record.value.request, expected))
      fail('packet_record_invalid', item.question.id, 'native', 'The native question belongs to another packet task');
    if (current) for (const ref of [item.question, item.engineQuestion, item.draft]) { head(store, ref); guards.push(ref); }
    return [item.question, ...checked.references];
  });
}
function bounded(value: Json, max: number) {
  try { const { text: _text, ...fingerprint } = boundedContext(value, max); return fingerprint; }
  catch (error) { if (error instanceof EngineError && error.code === 'context_budget_exceeded') return null; throw error; }
}
function blocked(code: string, target: string): Refusal {
  const response = refused(code, code === 'node_unexpandable' ? 'Узел не раскрывается по частям: обязательный контекст превышает вместимость'
    : 'The complete question packet exceeds the configured technical capacity', { unit: 'E2', target, field: 'packet' }, code === 'node_unexpandable' ? 'owner' : 'producer');
  if (!response.ok) return response.refusal;
  throw new Error('Unreachable refusal');
}
function ownRequirements(tasks: CheckedAnswerTask[]) {
  for (const task of tasks) for (const requirement of task.request.requirements)
    if (['', '/contracts', '/criteria', '/requirements', '/features', '/questions', '/facts', '/sources',
      '/map', '/map/nodes', '/map/artifacts', '/map/connectors'].includes(requirement.pointer))
      fail('packet_context_unbounded', task.gap.target, 'requirements', 'Name an individual essential requirement; a complete input or section is not a question context');
}
function connectionContext(graph: Graph, obligations: FrameObligation[]) {
  return [...new Set(obligations.flatMap(item => item.connector ? [item.connector] : []))].sort(order).map(id => {
    const connector = graph.connectors.find(item => item.id === id)!;
    const artifact = graph.artifacts.find(item => item.id === connector.artifact)!;
    const wanted = new Set(obligations.filter(item => item.connector === id).map(item => item.flow));
    return { id, returnsTo: connector.returnsTo, wakeTest: connector.wakeTest, artifact, contract: graph.contracts.find(item => item.id === artifact.contract)!,
      flows: connector.bindings.filter(binding => wanted.has(flowKey(binding))).map(binding => ({ ...binding,
        endpoints: [binding.producer, ...binding.consumers].map(endpoint => {
          const node = graph.nodes.find(item => item.id === endpoint.node)!;
          const port = node.ports.find(item => item.id === endpoint.port)!;
          return { node: { id: node.id, title: node.title }, port, contract: graph.contracts.find(item => item.id === port.contract)! };
        }) })) };
  });
}
function expansionContext(frame: FrameProposals, node: string) {
  const graph = frame.frame.upper, upper = graph.nodes.find(item => item.id === node);
  if (!upper) fail('packet_batch_invalid', node, 'node', 'The expansion target is absent from its accepted upper layer');
  const obligations = frame.result.obligations.filter(item => item.upper.node === node), ids = new Set(obligations.map(item => item.id));
  const acceptedGraph = frame.frame.accepted?.graph;
  const relations = acceptedGraph ? new RefinementRelations(acceptedGraph) : null;
  const nodes = acceptedGraph?.nodes.filter(item => LEVEL[item.kind] === frame.frame.request.level && relations!.refines(item.id, node)) ?? [];
  return { upper: { id: upper.id, title: upper.title, outcome: upper.outcome, boundary: upper.boundary, ports: upper.ports },
    artifacts: graph.artifacts.filter(item => obligations.some(obligation => obligation.artifact === item.id)),
    contracts: graph.contracts.filter(item => upper.ports.some(port => port.contract === item.id)
      || graph.artifacts.some(artifact => artifact.contract === item.id && obligations.some(obligation => obligation.artifact === artifact.id))),
    obligations, assigned: [] as string[], connections: [] as ReturnType<typeof connectionContext>,
    accepted: { nodes, fills: frame.result.fills.filter(item => ids.has(item.obligation) && item.source !== 'proposed') },
    proposed: frame.proposals.map(item => {
      const proposedGraph = { ...graph, nodes: [...graph.nodes, ...item.value.nodes],
        edges: [...(graph.edges ?? []), ...item.value.edges] } as Graph;
      const proposedRelations = new RefinementRelations(proposedGraph);
      return { basis: item.reference, nodes: item.value.nodes.filter(candidate => proposedRelations.refines(candidate.id, node)),
        fills: frame.result.fills.filter(fill => ids.has(fill.obligation) && fill.source === 'proposed' && same(fill.basis, item.reference)) };
    }),
    reserved: frame.result.representatives.map(item => item.id).sort(order), previous: [] as Json[] };
}
function worksTaskBasis(store: Store, request: QuestionPacketRequest, gaps: Sealed<GapReadRequest>, current: boolean) {
  if (!request.works) fail('packet_task_set_invalid', request.batch!, 'works', 'A work assignment needs its exact D7 producer and complete ledger, including an empty ledger');
  const basis = request.works;
  const saved = historicalRead(store, { reader: 'E2.works-basis', project: request.project, ref: basis.producer },
    () => take(readOmObligations(store, { project: request.project, producer: basis.producer })) as OmObligations,
    () => fail('packet_chain_invalid', basis.producer.id, 'works', 'The work assignment basis contains a cycle'));
  if (!same(reference(saved.record), basis.ledger)
    || !same(saved.producer.value.request.gaps.sources, gaps.sources)
    || !same(sorted(saved.producer.value.request.gaps.records), sorted(gaps.records)))
    fail('packet_task_set_invalid', basis.producer.id, 'works', 'The complete handoff must belong to the exact D1 assignment preceding this answer');
  const prepared = current ? take(prepareOmObligations(store, saved.producer.value.request as ObligationRequest)) : null;
  if (prepared && (prepared.writes.length || !same(reference(prepared.producer), basis.producer)
    || !same(reference(prepared.record), basis.ledger)))
    fail('packet_task_set_invalid', basis.producer.id, 'works', 'The complete current handoff must already be saved at the declared references');
  return { ...saved, guards: prepared ? [...prepared.guards] : [] };
}
interface WorksPacketContext {
  contract: typeof WORKS_FRAME_CONTRACT; producer: Ref; ledger: Ref;
  obligations: CarriedObligation[]; nodeAssignments: string[]; assigned: string[];
}
function assignmentGraph(frame: FrameProposals): Graph {
  const initial = frame.frame.accepted?.graph ?? frame.frame.upper;
  return { ...initial, nodes: [...new Map([...initial.nodes, ...frame.proposals.flatMap(item => item.value.nodes)]
    .map(node => [node.id, node] as const)).values()], edges: [...(initial.edges ?? []), ...frame.proposals.flatMap(item => item.value.edges)] } as Graph;
}
function workAssignments(frame: FrameProposals, node: string, basis: OmObligations): WorksPacketContext {
  const graph = assignmentGraph(frame);
  const relations = new RefinementRelations(graph);
  const refinements = graph.nodes.filter(item => relations.refines(item.id, node));
  const assigned = taskObligations(basis.handoff).filter(obligation => refinements.some(item =>
    relations.refines(item.id, obligation.responsibleNode) && relations.refines(item.id, obligation.responsibleConsumer)))
    .map(taskBindingId).sort(order);
  return { contract: WORKS_FRAME_CONTRACT, producer: reference(basis.producer), ledger: reference(basis.record),
    obligations: basis.handoff.obligations, nodeAssignments: assigned, assigned };
}

function deriveContinuation(store: Store, request: QuestionPacketRequest, current: boolean,
  contract: NonNullable<QuestionPacketRecord['packetContract']>) {
  const continuation = request.continuation!;
  const prior = loadPacket(store, request.project, continuation.packet);
  const { continuation: _priorContinuation, ...priorRoot } = prior.value.request;
  const { continuation: _continuation, ...root } = request;
  if (prior.value.packetContract !== contract || prior.value.state !== 'ready' || !object(prior.value.packet)
    || !same(root, priorRoot))
    fail('packet_chain_invalid', continuation.packet.id, 'continuation',
      'A continuation preserves the exact ready assignment, sources and attempt of its current-contract predecessor');
  // Reuse the saved native questions and part assignment while checking today's admission dependencies.
  const priorDerived = derivePacket(store, prior.value.request, current, prior.value as QuestionPacketRecord);
  const evidence = take(readContinuationEvidence(store, { project: request.project, ...continuation }, current));
  const capacity = take(readCapacity(store, { project: request.project, environment: request.environment, current }));
  const guards = [...priorDerived.guards, ...capacity.guards, ...evidence.guards];
  if (current) {
    for (const ref of [continuation.packet, continuation.response]) { head(store, ref); guards.push(ref); }
    // Admission is revision one; an already settled call legitimately has a later current head.
    guards.push(reference(store.get(continuation.call.id)!));
  }
  const requestId = packetKey(request, PACKET_ANSWER_PROTOCOL, contract);
  const payload = prior.value.packet;
  const packet = json({ ...payload, requestId,
    responseForm: { ...(payload.responseForm as Record<string, Json>), requestId },
    sourceDeliveries: [...(Array.isArray(payload.sourceDeliveries) ? payload.sourceDeliveries : []),
      { ...continuation, data: evidence.data }] });
  const fingerprint = bounded(packet, capacity.maxRequestChars);
  const value: QuestionPacketRecord = { ...copy(prior.value) as QuestionPacketRecord, request, packetContract: contract,
    state: evidence.novel && fingerprint ? 'ready' : 'blocked', packet: evidence.novel && fingerprint ? packet : null,
    fingerprint: evidence.novel ? fingerprint : null, fullChars: canonical(packet).length,
    refusal: !evidence.novel ? { code: 'research_no_progress', message: 'The addressed reads add no information to this attempt',
      at: { unit: 'E2', target: request.batch!, field: 'continuation', ref: continuation.response }, route: 'producer' }
      : fingerprint ? null : blocked(payload.task === 'node-expansion' ? 'node_unexpandable' : 'packet_too_large', request.batch!) };
  return { value, guards: unique(guards), references: unique([...priorDerived.references, continuation.packet,
    ...capacity.references, ...evidence.references]), writes: priorDerived.writes };
}
function derivePacket(store: Store, request: QuestionPacketRequest, current: boolean, saved?: QuestionPacketRecord): {
  value: QuestionPacketRecord; guards: TransactionGuard[]; references: Ref[]; writes: Write[];
} {
  const protocol = saved ? saved.answerProtocol : PACKET_ANSWER_PROTOCOL;
  const contract = saved ? saved.packetContract : currentPacketContract(store, request);
  if (request.continuation) {
    if (contract !== PACKET_CONTRACT && contract !== WORKS_PACKET_CONTRACT)
      fail('packet_record_invalid', request.continuation.packet.id, 'packetContract', 'A historical packet cannot acquire continuation semantics');
    return deriveContinuation(store, request, current, contract);
  }
  const routes = take(readRoutes(store, { project: request.project, record: request.routes })) as { record: Revision<RoutesRecord>; references: Ref[] };
  const batch = request.batch === null ? null : routes.record.value.batches.find(item => item.id === request.batch);
  if (request.batch !== null && !batch || request.batch === null && routes.record.value.batches.length)
    fail('packet_batch_invalid', request.routes.id, 'batch', 'Name an exact routed model batch; absence is valid only without routed work');
  const references: Ref[] = [...routes.references, request.routes], guards: TransactionGuard[] = [], routeWrites: Write[] = [];
  if (current) {
    head(store, request.routes);
    const binding = request.attempt ? take(readCompletionBinding(store, request.project, request.attempt.series, request.attempt.ordinal)) : null;
    const prepared = binding
      ? take(prepareManagedRouteBatch(store, { project: request.project, series: request.attempt!.series,
        attempt: request.attempt!.ordinal, routes: request.routes, batch: request.batch! }))
      : take(prepareRoutes(store, { ...routes.record.value.request,
        tasks: routes.record.value.request.tasks.map(record => ({ record })) }));
    if (!same(prepared.record, routes.record) || !binding && prepared.writes.length)
      fail('route_stale', request.routes.id, 'routes', 'The saved route no longer describes the currently admitted assignment');
    routeWrites.push(...prepared.writes); guards.push(...prepared.guards); references.push(...prepared.references);
  }
  if (contract === WORKS_PACKET_CONTRACT && (batch?.task !== 'node-expansion' || batch.level !== 3))
    fail('packet_record_invalid', request.routes.id, 'packetContract', 'The work answer era belongs only to an L3 node assignment');
  if (contract !== WORKS_PACKET_CONTRACT && Object.hasOwn(request, 'works'))
    fail('packet_task_set_invalid', request.routes.id, 'works', 'A D7 handoff is accepted only by the declared work-packet era');
  const base: QuestionPacketRecord = { project: request.project, request, ...(protocol ? { answerProtocol: protocol } : {}),
    ...(contract ? { packetContract: contract } : {}), state: 'empty', packet: null, fingerprint: null,
    native: [], plan: null, fullChars: null, refusal: null, journal: null };
  if (!batch) {
    if (request.previous.length) fail('packet_chain_invalid', request.routes.id, 'previous', 'An empty route has no preceding parts');
    return { value: base, guards: unique(guards), references: unique(references), writes: routeWrites };
  }
  const capacity = take(readCapacity(store, { project: request.project, environment: request.environment, current }));
  guards.push(...capacity.guards); references.push(...capacity.references);
  const gaps = take(readGaps(store, routes.record.value.request.gaps)) as GapRecords;
  const retry = previousRefusals(store, request, batch, gaps, current, saved?.journal, guards, references, contract);
  base.journal = retry.journal;
  const tasks: CheckedAnswerTask[] = [];
  const questions = batch.items.map(item => {
    const gap = gaps.records.find(row => same(reference(row), item.record));
    if (!gap) fail('packet_batch_invalid', item.target, 'gap', 'A routed item must remain bound to its exact full D1 source');
    if (batch.model === 'MC1') {
      if (!item.task) fail('packet_task_set_invalid', item.target, 'task', 'M6 must preserve the producer task preceding research');
      const task = take(readAnswerTaskBasis(store, { project: request.project, task: { record: item.task }, current })) as CheckedAnswerTask;
      if (!same(task.request.gap, item.record) || !same(task.request.gaps, routes.record.value.request.gaps))
        fail('packet_task_set_invalid', item.target, 'task', 'The routed task must belong to this exact gap context');
      tasks.push(task); guards.push(...task.guards); references.push(...task.references);
      return { id: item.gap, target: item.target, field: item.field, consumers: item.consumers, contract: task.contract,
        addresses: item.addresses, evidence: 'Return the value and exact verifiable source addresses; unsupported claims are not facts' };
    }
    return { id: item.gap, target: item.target, field: item.field, consumers: item.consumers,
      ...(batch.task === 'node-expansion' ? {} : { question: gap.value.gap.evidence.map(entry => ({ origin: entry.origin, value: entry.value })) }) };
  });
  ownRequirements(tasks);
  const requestId = packetKey(request, protocol, contract);
  const common = { version: contract === WORKS_PACKET_CONTRACT ? 'om-question-packet/works-v1'
    : contract ? 'om-question-packet/v3' : protocol ? 'om-question-packet/v2' : 'om-question-packet/v1', requestId, model: batch.model,
    purpose: batch.model === 'MC1' ? 'model-research' : 'model-design', task: batch.task, kind: batch.kind, questions,
    responseForm: protocol ? { protocol, requestId, schema: packetAnswerSchema(batch.task === 'node-expansion' ? 'node' : batch.model === 'MC1' ? 'fact' : 'field',
      packetWorkContract(base)) }
      : batch.task === 'node-expansion'
      ? { protocol: 'omg-part/v1', requestId, proposal: PART_PROPOSAL_SCHEMA }
      : batch.model === 'MC1'
        ? { results: 'One result per question id', value: 'The question contract resultForm', citations: 'Exact source reference and text-range or JSON-pointer selector' }
        : { results: 'One result per target and field', fields: ['target', 'field', 'value', 'basis'],
          value: 'Only the missing field: address = consumer and kind; nodes = block ids; state = nodes and actors; checkKind = check kind' },
    refusals: retry.refusals, rules: batch.model === 'MC1'
      ? ['answer_route_foreign', 'answer_question_invalid', 'answer_inapplicable', 'evidence_missing']
      : ['slot_fill_foreign', 'slot_fill_conflict', 'proposal_node_reserved', 'frame_upper_drift'] };
  let packet = json(common);
  if (batch.task === 'node-expansion') {
    const source = batch.level === 2 ? gaps.sources.operations : gaps.sources.works;
    if ('state' in source || !batch.node || source.frame.level !== batch.level)
      fail('packet_batch_invalid', batch.id, 'frame', 'A node expansion needs the producer frame for its level');
    const frame = take(readFrameProposals(store, source)) as FrameProposals;
    references.push(...frame.references);
    if (current) guards.push(...take(prepareFrameProposals(store, source)).guards);
    const context = expansionContext(frame, batch.node), open = frame.result.open.filter(item => item.upper.node === batch.node);
    const worksBasis = contract === WORKS_PACKET_CONTRACT ? worksTaskBasis(store, request,
      routes.record.value.request.gaps, current) : null;
    if (worksBasis) { guards.push(...worksBasis.guards); references.push(reference(worksBasis.producer), reference(worksBasis.record), ...worksBasis.inputs); }
    const works = worksBasis ? workAssignments(frame, batch.node, worksBasis) : null;
    if (!open.length) return { value: base, guards: unique(guards), references: unique(references), writes: routeWrites };
    const allIds = open.map(item => item.id).sort(order);
    const whole = { ...context, assigned: allIds, connections: connectionContext(frame.frame.upper, open) };
    packet = json({ ...common, expansion: whole, ...(works ? { works } : {}) });
    base.fullChars = canonical(packet).length;
    base.plan = { mode: 'whole', assignments: [{ connector: null, obligations: allIds }], position: 0 };
    if (!bounded(packet, capacity.maxRequestChars)) {
      const connectors = [...new Set(open.flatMap(item => item.connector ? [item.connector] : []))].sort(order);
      const assignments = connectors.map(connector => ({ connector: connector as string | null,
        obligations: open.filter(item => item.connector === connector).map(item => item.id) }));
      if (!assignments.length) assignments.push({ connector: null, obligations: [] });
      assignments.at(-1)!.obligations.push(...open.filter(item => !item.connector).map(item => item.id));
      assignments.forEach(item => item.obligations.sort(order));
      base.plan = { mode: 'parts', assignments, position: request.previous.length };
      context.previous = previousParts(store, request, base.plan, references, protocol, contract);
      context.reserved = unique([...context.reserved, ...context.previous.flatMap(item => (item as unknown as {nodes: Graph['nodes']}).nodes.map(node => node.id))]);
      if (request.previous.length === assignments.length)
        return { value: base, guards: unique(guards), references: unique(references), writes: routeWrites };
      const assignment = assignments[request.previous.length]!;
      const assigned = open.filter(item => assignment.obligations.includes(item.id));
      packet = json({ ...common, questions: questions.filter(item => assignment.obligations.includes(item.target)),
        expansion: { ...context, assigned: assignment.obligations,
        connections: connectionContext(frame.frame.upper, assigned) },
        ...(works ? { works: { ...works, assigned: request.previous.length === assignments.length - 1 ? works.nodeAssignments : [] } } : {}) });
    } else if (request.previous.length) {
      fail('packet_chain_invalid', batch.id, 'previous', 'A packet that fits whole has no parts');
    }
  } else {
    if (request.previous.length) fail('packet_chain_invalid', batch.id, 'previous', 'Only a node expansion can have preceding parts');
    base.fullChars = canonical(packet).length;
  }
  const fingerprint = bounded(packet, capacity.maxRequestChars);
  if (!fingerprint) {
    base.state = 'blocked'; base.refusal = blocked(batch.task === 'node-expansion' ? 'node_unexpandable' : 'packet_too_large', batch.node ?? batch.id);
    return { value: base, guards: unique(guards), references: unique(references), writes: routeWrites };
  }
  base.state = 'ready'; base.packet = packet; base.fingerprint = fingerprint;
  const writes: Write[] = [...routeWrites];
  if (batch.model === 'MC1') {
    if (saved) {
      references.push(...checkNative(store, request.project, tasks, saved.native, current, guards)); base.native = saved.native;
    } else {
      const issued = nativeQuestions(store, request.project, tasks, guards);
      writes.push(...issued.writes); base.native = issued.native;
      references.push(...issued.native.flatMap(item => [item.draft, item.engineQuestion, item.question]));
      guards.splice(0, guards.length, ...issued.guards);
    }
  }
  return { value: base, guards: unique(guards), references: unique(references), writes };
}
function loadPacket(store: Store, project: string, ref: Ref): Revision<QuestionPacketRecord> {
  return historicalRead(store, { reader: 'E2.question-packet', project, ref }, () => {
    const record = take(readRecord<QuestionPacketRecord>(store, ref, { unit: 'E2', target: ref.id,
      idPrefix: packetNamespace(project), kind: QUESTION_PACKET_KIND }));
    if (!object(record.value) || record.value.project !== project || !object(record.value.request))
      fail('packet_record_invalid', ref.id, 'record', 'The packet must carry its complete producer request');
    try { requirePacket(store, record.value.request); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'question_packet_request_invalid')
        fail('packet_record_invalid', ref.id, 'request', 'The saved producer request is malformed');
      throw error;
    }
    const request = record.value.request;
    if (record.value.answerProtocol !== undefined && record.value.answerProtocol !== PACKET_ANSWER_PROTOCOL)
      fail('packet_record_invalid', ref.id, 'answerProtocol', 'The packet answer contract era is unsupported');
    if (record.value.packetContract !== undefined && (![PACKET_CONTRACT, WORKS_PACKET_CONTRACT].includes(record.value.packetContract)
      || record.value.answerProtocol !== PACKET_ANSWER_PROTOCOL))
      fail('packet_record_invalid', ref.id, 'packetContract', 'The packet derivation contract era is unsupported');
    if (request.project !== project || record.id !== packetId(request, record.value.answerProtocol, record.value.packetContract) || record.revision !== 1)
      fail('packet_record_invalid', ref.id, 'request', 'A packet preserves the identity of its exact immutable source request');
    const expected = derivePacket(store, request, false, record.value as QuestionPacketRecord);
    if (!same(expected.value, record.value))
      fail('packet_record_invalid', ref.id, 'value', 'The complete packet, assignment and native bindings must follow from their exact sources');
    const completion = continuationFinish(store, record.value as QuestionPacketRecord);
    if (completion?.writes.length)
      fail('packet_record_invalid', ref.id, 'completion', 'The no-progress packet and its completed attempt must be saved together');
    return record as Revision<QuestionPacketRecord>;
  }, () => fail('packet_chain_invalid', ref.id, 'previous', 'The packet history contains a cycle'));
}
export function readQuestionPacket(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<Revision<QuestionPacketRecord>>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('read');
  return result(() => loadPacket(store, request.project, request.record));
}
function continuationFinish(store: Store, record: QuestionPacketRecord) {
  const continuation = record.request.continuation;
  if (record.refusal?.code !== 'research_no_progress' || !continuation) return null;
  return take(prepareModelAttemptFinish(store, { project: record.project, packet: continuation.packet,
    call: continuation.call, response: continuation.response, reason: 'refused', code: record.refusal.code,
    message: record.refusal.message, evidence: continuation.deliveries }));
}
export function prepareQuestionPacket(store: Store, request: QuestionPacketRequest): OmResult<Sealed<PreparedQuestionPacket>> {
  requirePacket(store, request); request = copy(request);
  return result(() => {
    const contract = currentPacketContract(store, request);
    const old = store.get<QuestionPacketRecord>(packetId(request, PACKET_ANSWER_PROTOCOL, contract));
    const checked = old ? loadPacket(store, request.project, reference(old)) : undefined;
    // A completed no-progress transition is a technical repeat, not a new admission.
    if (checked?.value.refusal?.code === 'research_no_progress') {
      return { record: checked, existing: true, writes: [], guards: [], references: [reference(checked)] };
    }
    // Prove a candidate historically before granting current compatibility. This invokes the
    // same complete E2 derivation as its exact reader, not a second test of batch membership.
    let environment: NonNullable<Extract<ReturnType<typeof prepareManagedEnvironment>, { ok: true }>['value']> | null = null;
    const config = store.get(request.environment.id);
    if (!config || !same(reference(config), request.environment)) {
      const historical = checked ?? (() => {
        const value = derivePacket(store, request, false).value;
        return { id: packetId(request, PACKET_ANSWER_PROTOCOL, contract), kind: QUESTION_PACKET_KIND,
          revision: 1, hash: hashJson(value), value };
      })();
      const proof = pendingCallStore(store, checked ? [] : [{ id: historical.id, kind: historical.kind, expected: 0, value: historical.value }]);
      environment = take(prepareManagedEnvironment(proof, request.project, { packet: reference(historical) }));
    }
    const admittedStore = environment?.store ?? store;
    const derived = derivePacket(admittedStore, request, true, checked?.value);
    if (checked && !same(checked.value, derived.value))
      fail('packet_record_invalid', checked.id, 'value', 'An existing packet cannot change without a new source request');
    const record: Revision<QuestionPacketRecord> = checked ?? { id: packetId(request, PACKET_ANSWER_PROTOCOL, contract), kind: QUESTION_PACKET_KIND,
      revision: 1, hash: hashJson(derived.value), value: derived.value };
    const finished = continuationFinish(store, record.value);
    const writes: Write[] = [...derived.writes, ...(finished?.writes ?? []),
      ...(checked ? [] : [{ id: record.id, kind: record.kind, expected: 0, value: record.value }])];
    const completion = checked ? { writes: [], guards: [] } : take(prepareCompletionPacket(pendingCallStore(admittedStore, writes), reference(record)));
    writes.push(...completion.writes);
    const pending = new Set(writes.map(write => canonical({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) })));
    return { record, existing: Boolean(checked), references: derived.references,
      // H1.0d (№1715): the finish may rely on an absence (an admitted call without its E4); it stays a condition of
      // this write. Only exact references of records written here are dropped.
      guards: unique((environment ? environment.remap : (guards: readonly TransactionGuard[]) => guards)([...derived.guards, ...(finished?.guards ?? []), ...completion.guards,
        ...(environment?.guards ?? []), ...(checked ? [reference(checked)] : [])])
        .filter(guard => !isRef(guard) || !pending.has(canonical(guard)))), writes };
  });
}
export function writeQuestionPacket(store: Store, request: QuestionPacketRequest): OmResult<Sealed<PreparedQuestionPacket>> {
  requirePacket(store, request);
  return result(() => {
    // Replaying a saved delivery transition does not admit another physical call.
    // Dispatch still requires prepareQuestionPacket's fresh current admission.
    const managed = request.attempt ? take(readCompletionBinding(store, request.project, request.attempt.series, request.attempt.ordinal)) : null;
    const old = managed || request.continuation || request.previous.length > 0
      ? store.get(packetId(request, PACKET_ANSWER_PROTOCOL, currentPacketContract(store, request))) : null;
    if (old) {
      const record = loadPacket(store, request.project, reference(old));
      return { record, existing: true, writes: [], guards: [], references: [reference(record)] };
    }
    const prepared = take(prepareQuestionPacket(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'E2', target: prepared.record.id,
      writes: prepared.writes, guards: prepared.guards }));
    return prepared as PreparedQuestionPacket;
  });
}

export interface PartResponseRecord { project: string; packet: Ref; call: Ref; requestId: string; raw: string }
export interface PartResultRequest { project: string; packet: Ref; call: Ref; response: Ref }
export interface PreparePartResultRequest extends Omit<PartResultRequest, 'response'> {
  response: Ref | { pending: Write };
}
export interface WorksPartBindings {
  contract: typeof WORKS_FRAME_CONTRACT; producer: Ref; ledger: Ref; bindings: TaskObligationBinding[];
}
export interface PartResultRecord { project: string; request: PartResultRequest; proposal: Ref; works?: WorksPartBindings }
export interface CheckedPartResult { record: Revision<PartResultRecord>; proposal: Revision<LayerProposal>; references: Ref[] }
export const PART_RESPONSE_KIND = 'part-response';
export const PART_RESULT_KIND = 'part-result';
export function partResponseId(project: string, call: Ref): string {
  if (!text(project) || !isRef(call)) invalid('response');
  return `om-part-response:${project}:${hashJson(call)}`;
}
const bodySections = ['nodes', 'fills', 'localConnectors', 'artifacts', 'contracts', 'joins', 'tests', 'edges', 'journeys',
  'packets', 'transfers', 'anchors', 'removes', 'replaces', 'redefines'] as const;
export type PartProposalBody = Pick<LayerProposal, typeof bodySections[number]>;
const refShape = { type: 'object', additionalProperties: false, required: ['id', 'revision', 'hash'], properties: {
  id: { type: 'string', minLength: 1 }, revision: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } };
const fillShape = { type: 'object', additionalProperties: false, required: ['obligation', 'node'], properties: {
  obligation: { type: 'string', minLength: 1 }, node: { type: 'string', minLength: 1 }, port: { type: 'string', minLength: 1 } } };
const replacementShape = { type: 'object', additionalProperties: false, required: ['obligation', 'base', 'with', 'basis'], properties: {
  obligation: { type: 'string', minLength: 1 }, basis: { type: 'string', minLength: 1 },
  base: { type: 'object', additionalProperties: false, required: ['node', 'graph'], properties: { node: { type: 'string', minLength: 1 }, graph: refShape } },
  with: { type: 'object', additionalProperties: false, required: ['node', 'port'], properties: {
    node: { type: 'string', minLength: 1 }, port: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] } } } } };
export const PART_PROPOSAL_SCHEMA = sealed({ type: 'object', additionalProperties: false, required: [...bodySections],
  properties: Object.fromEntries(bodySections.map(section => {
    const field = section === 'localConnectors' ? 'connectors' : section;
    const native = (graphV2Schema.properties as Record<string, { items?: object }>)[field]?.items;
    return [section, { type: 'array', items: native ?? (section === 'fills' ? fillShape : section === 'replaces'
      ? replacementShape : { type: 'string', minLength: 1 }) }];
  })) });
// The work answer extends the declared end of a connection with the native CodeRef.
// Keep the preceding form intact: a historical packet never acquires these fields.
export const WORKS_PART_PROPOSAL_SCHEMA = sealed({ ...PART_PROPOSAL_SCHEMA, properties: {
  ...PART_PROPOSAL_SCHEMA.properties, fills: { type: 'array', items: { ...fillShape,
    properties: { ...fillShape.properties, codeRef: graphV2Schema.properties.nodes.items.properties.code.items } } },
} });
const validatePartBody = new Ajv({ strict: true, allowUnionTypes: true }).compile(PART_PROPOSAL_SCHEMA);
const validateWorksPartBody = new Ajv({ strict: true, allowUnionTypes: true }).compile(WORKS_PART_PROPOSAL_SCHEMA);
function requirePart(store: Store, value: unknown): asserts value is PartResultRequest {
  if (!(store instanceof Store) || !object(value) || !text(value.project)
    || ![value.packet, value.call, value.response].every(isRef)
    || Object.keys(value).some(key => !['project', 'packet', 'call', 'response'].includes(key))) invalid('part');
}
/** The one normalizer for the narrow typed answer of a node part. E3 reuses it; acceptance belongs to E4/C5. */
export function normalizePartAnswer(value: unknown, worksContract?: typeof WORKS_FRAME_CONTRACT): OmResult<Sealed<PartProposalBody>> {
  return result(() => {
    if (worksContract !== undefined && worksContract !== WORKS_FRAME_CONTRACT)
      fail('part_answer_invalid', 'part-answer', 'worksContract', 'The work answer must name its known proposal contract');
    const validate = worksContract === WORKS_FRAME_CONTRACT ? validateWorksPartBody : validatePartBody;
    if (!validate(value))
      fail('part_answer_invalid', 'part-answer', validate.errors?.[0]?.instancePath || 'proposal',
        'A typed part answer must satisfy the exact content schema without service fields');
    const body = copy(value) as unknown as PartProposalBody;
    // Only schema-declared sets are reordered. Arrays within schemas, commands and paths retain their meaning.
    return { ...body, ...Object.fromEntries(bodySections.map(key => [key, sorted<unknown>(body[key])])),
      nodes: sorted(body.nodes.map(node => ({ ...node, ports: sorted(node.ports), tests: sorted(node.tests),
        ...(node.implements ? { implements: sorted(node.implements) } : {}) }))),
      localConnectors: sorted(body.localConnectors.map(connector => ({ ...connector,
        bindings: sorted(connector.bindings.map(binding => ({ ...binding, consumers: sorted(binding.consumers) }))) }))) } as PartProposalBody;
  });
}
export type PacketRead =
  | { action: 'read'; path: string; media: 'text/plain' | 'application/json' }
  | { action: 'read_source'; source: Ref; selector: Selector }
  | { action: 'read_context'; record: Ref; pointer: string }
  | { action: 'search'; within: string | Ref; query: string };
export interface PacketAnswerRequest { project: string; packet: Ref; raw: string }
export type PacketAnswer =
  | { action: 'answer'; proposal: PartProposalBody; bindings?: TaskObligationBinding[] }
  | { action: 'answer'; results: { questionId: string; value: Json; citations: { source: Ref; selector: Selector }[] }[] }
  | { action: 'answer'; results: { target: string; field: string; value: Json; basis: Ref }[] }
  | { action: 'need_source'; questionIds: string[]; missing: string; reads: PacketRead[] }
  | { action: 'need_owner'; questionIds: string[]; reason: string; decision: string }
  | { action: 'cannot_answer' | 'pause'; questionIds: string[]; reason: string };
export interface CheckedPacketAnswer {
  packet: Revision<QuestionPacketRecord>; answer: PacketAnswer; references: Ref[];
}
const nonempty = { type: 'string', minLength: 1, pattern: '\\S' };
const selectorShape = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'pointer'], properties: {
    kind: { const: 'json-pointer' }, pointer: { type: 'string' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'start', 'end'], properties: {
    kind: { const: 'text-range' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } } },
] };
const readShapes = [
  { action: { const: 'read' }, path: nonempty, media: { enum: ['text/plain', 'application/json'] } },
  { action: { const: 'read_source' }, source: refShape, selector: selectorShape },
  { action: { const: 'read_context' }, record: refShape, pointer: { type: 'string' } },
  { action: { const: 'search' }, within: { oneOf: [nonempty, refShape] }, query: nonempty },
].map(properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }));
const factResults = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
  required: ['questionId', 'value', 'citations'], properties: { questionId: nonempty, value: {},
    citations: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['source', 'selector'], properties: { source: refShape, selector: selectorShape } } } } } };
const fieldResults = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
  required: ['target', 'field', 'value', 'basis'], properties: { target: nonempty, field: nonempty, value: {}, basis: refShape } } };
function responseShape(properties: Record<string, unknown>) {
  const fields = { protocol: { const: PACKET_ANSWER_PROTOCOL }, requestId: nonempty, ...properties };
  return { type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields };
}
const controls = [
  responseShape({ action: { const: 'need_source' }, questionIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonempty },
    missing: nonempty, reads: { type: 'array', minItems: 1, items: { oneOf: readShapes } } }),
  responseShape({ action: { const: 'need_owner' }, questionIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonempty },
    reason: nonempty, decision: nonempty }),
  ...['cannot_answer', 'pause'].map(action => responseShape({ action: { const: action },
    questionIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonempty }, reason: nonempty })),
];
const answerSchemas = sealed({
  node: { oneOf: [responseShape({ action: { const: 'answer' }, proposal: PART_PROPOSAL_SCHEMA }), ...controls] },
  fact: { oneOf: [responseShape({ action: { const: 'answer' }, results: factResults }), ...controls] },
  field: { oneOf: [responseShape({ action: { const: 'answer' }, results: fieldResults }), ...controls] },
});
const worksAnswerSchema = sealed({ oneOf: [responseShape({ action: { const: 'answer' }, proposal: WORKS_PART_PROPOSAL_SCHEMA,
  bindings: { type: 'array', items: taskObligationBindingSchema } }), ...controls] });
/** One stable schema family for producer payloads, E3 and E4; it is not compiled per packet. */
export function packetAnswerSchema(kind: keyof typeof answerSchemas, worksContract?: typeof WORKS_FRAME_CONTRACT): Sealed<Json> {
  if (kind !== 'node' && kind !== 'fact' && kind !== 'field') invalid('answer.schema');
  if (worksContract !== undefined && (worksContract !== WORKS_FRAME_CONTRACT || kind !== 'node')) invalid('answer.worksContract');
  return (worksContract ? worksAnswerSchema : answerSchemas[kind]) as Sealed<Json>;
}
const answerSchemasAjv = new Ajv({ strict: true, allowUnionTypes: true });
const answerValidators = { node: answerSchemasAjv.compile(answerSchemas.node), fact: answerSchemasAjv.compile(answerSchemas.fact),
  field: answerSchemasAjv.compile(answerSchemas.field) };
const worksAnswerValidator = answerSchemasAjv.compile(worksAnswerSchema);
const legacyResultValidators = {
  fact: answerSchemasAjv.compile({ type: 'object', additionalProperties: false, required: ['results'], properties: { results: factResults } }),
  field: answerSchemasAjv.compile({ type: 'object', additionalProperties: false, required: ['results'], properties: { results: fieldResults } }),
};
function packetReply(packet: Revision<QuestionPacketRecord>, raw: string): PacketAnswer {
  const value = packet.value, payload = value.packet;
  if (value.state !== 'ready' || !object(payload))
    fail('part_answer_invalid', packet.id, 'packet', 'An answer must name a ready, saved assignment');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { if (error instanceof SyntaxError) fail('part_answer_invalid', packet.id, 'raw', 'The reply is not typed JSON'); throw error; }
  try { parsed = sealed(parsed); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'unsealable_value')
      fail('part_answer_invalid', packet.id, 'raw', 'A reply must contain finite JSON values');
    throw error;
  }
  if (!object(parsed)) fail('part_answer_invalid', packet.id, 'raw', 'An answer has exactly one typed envelope');
  const kind = payload.task === 'node-expansion' ? 'node' : payload.model === 'MC1' ? 'fact' : 'field';
  if (value.answerProtocol) {
    const validate = packetWorkContract(value) ? worksAnswerValidator : answerValidators[kind];
    if (!validate(parsed)) fail('part_answer_invalid', packet.id, validate.errors?.[0]?.instancePath || 'reply',
      'The reply must use exactly one branch of the declared answer form without service fields');
    if (parsed.requestId !== payload.requestId)
      fail('part_result_invalid', packet.id, 'requestId', 'The reply must echo the exact sent request identifier');
    if (parsed.action !== 'answer') {
      const questionIds = parsed.questionIds as string[];
      const assigned = (payload.questions as unknown as { id: string }[]).map(item => item.id);
      if (questionIds.some(id => !assigned.includes(id)))
        fail('part_answer_invalid', packet.id, 'questionIds', 'A control reply may name only questions of its exact assignment');
    }
  } else if (kind === 'node') {
    if (parsed.protocol !== 'omg-part/v1' || parsed.requestId !== payload.requestId || !Object.hasOwn(parsed, 'proposal')
      || Object.keys(parsed).some(key => !['protocol', 'requestId', 'proposal'].includes(key)))
      fail('part_result_invalid', packet.id, 'requestId', 'The old packet accepts only its original exact node reply envelope');
  } else {
    const validate = legacyResultValidators[kind];
    if (!validate(parsed)) fail('part_answer_invalid', packet.id, 'results', 'The old packet accepts only its declared results form');
  }
  const { protocol: _protocol, requestId: _requestId, ...body } = parsed;
  // Only the declared set boundaries are normalized; values, schemas and address strings stay literal.
  // Preserve duplicates for downstream coverage/conflict checks rather than silently shrinking the reply.
  if (value.answerProtocol) {
    if (Array.isArray(body.results)) body.results = sorted(body.results.map(item => {
      const row = item as Record<string, unknown>;
      return kind === 'fact' ? { ...row, citations: sorted(row.citations as unknown[]) } : row;
    }));
    if (Array.isArray(body.questionIds)) body.questionIds = sorted(body.questionIds);
    if (Array.isArray(body.reads)) body.reads = sorted(body.reads);
    if (Array.isArray(body.bindings)) body.bindings = sorted((body.bindings as TaskObligationBinding[]).map(binding => ({ ...binding,
      consumers: sorted(binding.consumers.map(consumer => ({ ...consumer, tests: sorted(consumer.tests) }))) }))) as unknown[];
  }
  return json({ ...body, action: body.action ?? 'answer',
    ...(kind === 'node' && (body.action === undefined || body.action === 'answer')
      ? { proposal: take(normalizePartAnswer(body.proposal, packetWorkContract(value))) } : {}) }) as unknown as PacketAnswer;
}
/** Observes content only. A reply parsed here is not proof of an admitted or completed call. */
export function readPacketAnswer(store: Store, request: PacketAnswerRequest): OmResult<Sealed<CheckedPacketAnswer>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.packet) || typeof request.raw !== 'string'
    || Object.keys(request).some(key => !['project', 'packet', 'raw'].includes(key))) invalid('answer');
  request = copy(request);
  return result(() => {
    const packet = loadPacket(store, request.project, request.packet);
    return { packet, answer: packetReply(packet, request.raw), references: [request.packet] };
  });
}

function partContext(store: Store, project: string, packet: Revision<QuestionPacketRecord>) {
  const value = packet.value;
  if (value.state !== 'ready' || !value.packet || !value.plan || !value.request.attempt)
    fail('part_result_invalid', packet.id, 'packet', 'A part result needs an issued node-expansion packet');
  const payload = value.packet as Record<string, Json>, expansion = payload.expansion as unknown as ReturnType<typeof expansionContext>;
  if (payload.model !== 'MC2' || payload.task !== 'node-expansion' || !expansion)
    fail('part_result_invalid', packet.id, 'packet', 'This packet does not assign a node expansion');
  const routes = take(readRoutes(store, { project, record: value.request.routes }));
  const source = routes.record.value.request.gaps.sources;
  const batch = routes.record.value.batches.find(item => item.id === value.request.batch)!;
  const frameSource = batch.level === 2 ? source.operations : source.works;
  if ('state' in frameSource) fail('part_result_invalid', packet.id, 'frame', 'A part needs an available frame source');
  return { value, payload, expansion, routes, batch, frameSource };
}
function partProposal(store: Store, project: string, packet: Revision<QuestionPacketRecord>, body: PartProposalBody,
  bindings?: TaskObligationBinding[]) {
  const { value, expansion, routes, frameSource } = partContext(store, project, packet);
  const assigned = new Set(expansion.assigned);
  if (body.fills.some(fill => !assigned.has(fill.obligation)) || body.replaces.some(fill => !assigned.has(fill.obligation)))
    fail('part_result_invalid', packet.id, 'assigned', 'A previous answer may address only the obligations assigned to its own packet');
  const previousNodes = expansion.previous.flatMap(item => (item as unknown as { nodes: Graph['nodes'] }).nodes);
  const frame = take(readFrameProposals(store, frameSource as import('./frame-proposals.js').ProposalRequest)) as FrameProposals;
  const graph = assignmentGraph(frame);
  const scopedGraph = { ...graph, nodes: [...graph.nodes.filter(node => !body.nodes.some(item => item.id === node.id)),
    ...previousNodes.filter(node => !body.nodes.some(item => item.id === node.id) && !graph.nodes.some(item => item.id === node.id)), ...body.nodes],
    edges: [...(graph.edges ?? []), ...value.request.previous.flatMap(item => checkedPart(store, project, item.result).proposal.value.edges), ...body.edges] } as Graph;
  const relations = new RefinementRelations(scopedGraph);
  if (body.nodes.some(node => LEVEL[node.kind] !== frameSource.frame.level || !relations.refines(node.id, expansion.upper.id))
    || body.fills.some(fill => !relations.refines(fill.node, expansion.upper.id)))
    fail('part_result_invalid', packet.id, 'node', 'Every used lower node must belong to this upper-node assignment');
  const worksContract = packetWorkContract(value);
  const proposalValue: LayerProposal = { ...body, base: { graph: frameSource.frame.graph, frame: frameSource.frame.frame },
    level: frameSource.frame.level, source: 'decision', status: 'proposed',
    ...(worksContract ? { worksContract } : {}) };
  let works: WorksPartBindings | undefined;
  if (worksContract) {
    // Reuse C3 for the native work-end contract, including exact membership in Node.code.
    // Prior nodes may be reused by the next part; the temporary observation proves content only.
    const previous = value.request.previous.map(item => checkedPart(store, project, item.result).proposal.value as LayerProposal);
    const reuse = <T>(prior: T[], supplied: T[]) => [...unique(prior).filter(item => !supplied.some(value => same(item, value))), ...supplied];
    const contextual: LayerProposal = { ...proposalValue, nodes: reuse(previousNodes, body.nodes),
      tests: reuse(previous.flatMap(item => item.tests), body.tests),
      edges: reuse(previous.flatMap(item => item.edges), body.edges) };
    const preview: Revision<LayerProposal> = { id: `om-proposal:${project}:answer-content:${hashJson(contextual)}`,
      kind: 'layer-proposal', revision: 1, hash: hashJson(contextual), value: contextual };
    historicalRead(store, { reader: 'E2.works-proposal-content', project, ref: reference(preview), parameters: json(frameSource) },
      () => take(readFrameProposals(pinned(store, preview), { frame: frameSource.frame,
        proposals: [...frameSource.proposals, reference(preview)] })),
      () => fail('packet_chain_invalid', packet.id, 'proposal', 'The work-part content has a cyclic source derivation'));
    const assignment = (packet.value.packet as Record<string, Json>).works as unknown as WorksPacketContext;
    if (!Array.isArray(bindings) || new Set(bindings.map(binding => binding.id)).size !== bindings.length
      || bindings.length !== assignment.assigned.length || bindings.some(binding => !assignment.assigned.includes(binding.id)))
      fail('part_result_invalid', packet.id, 'bindings', 'The work answer must cover every assigned handoff identity exactly once, only in its designated part');
    const basis = worksTaskBasis(store, value.request, routes.record.value.request.gaps, false);
    const concrete = new Set(scopedGraph.nodes
      .filter(node => LEVEL[node.kind] === 3 && relations.refines(node.id, expansion.upper.id)).map(node => node.id));
    const identity = new Set(frame.result.fills.filter(fill => fill.source === 'identity').map(fill => fill.node));
    const testGraph: Graph = { ...scopedGraph, tests: unique([...graph.tests, ...frame.proposals.flatMap(item => item.value.tests), ...contextual.tests]) };
    for (const binding of bindings) {
      if (binding.consumers.some(consumer => !concrete.has(consumer.node) || identity.has(consumer.node)))
        fail('part_result_invalid', binding.id, 'bindings.consumers', 'Each consumer must be a concrete work of this exact node assignment and checked part chain');
      const checked = checkTaskObligationBinding(store, project, testGraph, basis.handoff as OmObligationHandoff, binding);
      if (checked.findings.length) fail('part_result_invalid', binding.id, 'bindings', checked.findings.map(item => `${item.code}: ${item.target}`).join('; '));
    }
    works = { contract: worksContract, producer: assignment.producer, ledger: assignment.ledger, bindings };
  }
  return { proposal: proposalValue, ...(works ? { works } : {}), frameSource,
    references: unique([reference(packet), ...frame.references, ...routes.references,
      ...(works ? [works.producer, works.ledger] : [])]) };
}
export interface DerivedPartProposal {
  packet: Revision<QuestionPacketRecord>; proposal: LayerProposal; works?: WorksPartBindings; references: Ref[];
}
/** E3 and E4 share this derivation; it supplies content, never an invented call or proposal reference. */
export function derivePartProposal(store: Store, request: PacketAnswerRequest): OmResult<Sealed<DerivedPartProposal>> {
  return result(() => {
    const checked = take(readPacketAnswer(store, request));
    if (checked.answer.action !== 'answer' || !('proposal' in checked.answer))
      fail('part_answer_invalid', request.packet.id, 'reply', 'A node proposal requires the substantive node branch');
    const derived = partProposal(store, request.project, checked.packet as Revision<QuestionPacketRecord>, checked.answer.proposal as PartProposalBody,
      checked.answer.bindings as TaskObligationBinding[] | undefined);
    return { packet: checked.packet as Revision<QuestionPacketRecord>, proposal: derived.proposal,
      ...(derived.works ? { works: derived.works } : {}), references: derived.references };
  });
}
export interface CheckedPacketResponse {
  record: Revision<PartResponseRecord>; packet: Revision<QuestionPacketRecord>; call: Revision<AnyCallRecord>; references: Ref[];
}
/** Common packet/call/response provenance. Content parsing and acceptance remain separate. */
export function readPacketResponse(store: Store, request: PartResultRequest): OmResult<Sealed<CheckedPacketResponse>> {
  requirePart(store, request); request = copy(request);
  return result(() => packetResponse(store, request));
}
function packetResponse(store: Store, request: PartResultRequest): CheckedPacketResponse {
  const packet = loadPacket(store, request.project, request.packet);
  const value = packet.value;
  if (value.state !== 'ready' || !object(value.packet) || !value.request.attempt || !value.fingerprint)
    fail('part_result_invalid', packet.id, 'packet', 'A response needs an exact ready assignment and its declared attempt');
  const payload = value.packet;
  const routes = take(readRoutes(store, { project: request.project, record: value.request.routes }));
  const batch = routes.record.value.batches.find(item => item.id === value.request.batch)!;
  const call = take(readCall(store, request.project, request.call));
  const series = take(readAnySeriesAt(store, request.project, value.request.attempt.series));
  const goal = series.value.attempts.find(item => item.ordinal === value.request.attempt!.ordinal)!.goal;
  const assigned = new Set((payload.questions as { id: string }[]).map(item => item.id));
  const addressed = sorted(batch.items.filter(item => assigned.has(item.gap)).flatMap(item =>
    ('owner' in series.value ? [series.value.owner] : item.consumers).map(consumer =>
    ({ id: 'owner' in series.value ? item.gap : item.target, goal: item.target, field: item.field, consumer }))));
  const fingerprint = value.fingerprint!;
  const ownerMatches = 'owner' in series.value ? 'owner' in call.value && same(call.value.owner, series.value.owner)
    && same(call.value.admission.routes, value.request.routes) && call.value.admission.batch === value.request.batch
    && same(call.value.admission.gaps.sources, routes.record.value.request.gaps.sources)
    && same(sorted(call.value.admission.gaps.records), sorted(routes.record.value.request.gaps.records))
    : !('owner' in call.value) && call.value.block === series.value.block;
  if (call.revision !== 1 || call.value.call !== payload.requestId || call.value.purpose !== payload.purpose || call.value.basis !== null
    || !same(call.value.series, value.request.attempt!.series) || call.value.attempt !== value.request.attempt!.ordinal
    || !same(call.value.goal, goal) || !ownerMatches || !same(sorted<unknown>(call.value.gaps), addressed)
    || !same(call.value.packet, { hash: fingerprint.hash, chars: fingerprint.chars, bytes: fingerprint.utf8Bytes }))
    fail('part_result_invalid', request.call.id, 'call', 'The admitted call must name this exact packet, attempt, goal and assigned questions');
  const response = take(readRecord<PartResponseRecord>(store, request.response, { unit: 'E2', target: request.call.id,
    id: partResponseId(request.project, request.call), kind: PART_RESPONSE_KIND }));
  if (response.revision !== 1 || !object(response.value) || response.value.project !== request.project
    || !isRef(response.value.packet) || !isRef(response.value.call) || !text(response.value.requestId)
    || !same(response.value.packet, request.packet) || !same(response.value.call, request.call)
    || response.value.requestId !== payload.requestId || typeof response.value.raw !== 'string'
    || Object.keys(response.value).some(key => !['project', 'packet', 'call', 'requestId', 'raw'].includes(key)))
    fail('part_result_invalid', request.response.id, 'response', 'The immutable adapter response must belong to the sent request and admitted call');
  return { record: response as Revision<PartResponseRecord>, packet, call: call as Revision<AnyCallRecord>,
    references: unique([request.packet, request.call, request.response, value.request.attempt.series, ...routes.references]) };
}
function partSource(store: Store, request: PartResultRequest) {
  const checked = packetResponse(store, request);
  const { frameSource } = partContext(store, request.project, checked.packet);
  const response = checked.record;
  const derived = take(derivePartProposal(store, { project: request.project, packet: request.packet, raw: response.value.raw }));
  const proposalValue = derived.proposal as LayerProposal;
  const key = hashJson(request);
  const proposal: Revision<LayerProposal> = { id: `om-proposal:${request.project}:part:${key}`, kind: 'layer-proposal',
    revision: 1, hash: hashJson(proposalValue), value: proposalValue };
  const resultValue: PartResultRecord = { project: request.project, request, proposal: reference(proposal),
    ...(derived.works ? { works: derived.works as WorksPartBindings } : {}) };
  const record: Revision<PartResultRecord> = { id: `om-part-result:${request.project}:${key}`, kind: PART_RESULT_KIND,
    revision: 1, hash: hashJson(resultValue), value: resultValue };
  return { record, proposal, frameSource, references: unique([...checked.references, ...derived.references]) };
}
function checkedPart(store: Store, project: string, ref: Ref): CheckedPartResult {
  return historicalRead(store, { reader: 'E2.part-result', project, ref }, () => {
    const saved = take(readRecord<PartResultRecord>(store, ref, { unit: 'E2', target: ref.id,
      idPrefix: `om-part-result:${project}:`, kind: PART_RESULT_KIND }));
    if (!object(saved.value) || saved.value.project !== project || !isRef(saved.value.proposal))
      fail('part_result_invalid', ref.id, 'record', 'A result must preserve its sources and derived proposal');
    try { requirePart(store, saved.value.request); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'question_packet_request_invalid')
        fail('part_result_invalid', ref.id, 'request', 'The saved part sources are malformed');
      throw error;
    }
    if (saved.value.request.project !== project) fail('part_result_invalid', ref.id, 'project', 'The result belongs to another project');
    const expected = partSource(store, saved.value.request);
    if (!same(expected.record, saved)) fail('part_result_invalid', ref.id, 'proposal', 'The result must be derived from the saved response of its own call');
    const observed = take(observeProposal(store, { project, proposal: saved.value.proposal,
      request: { frame: expected.frameSource.frame, proposals: [saved.value.proposal] } }));
    if (!same(observed.record, expected.proposal)) fail('part_result_invalid', ref.id, 'proposal', 'The original proposal does not match the common typed response derivation');
    return { record: expected.record, proposal: expected.proposal, references: unique([...expected.references, ...observed.references, ref]) };
  }, () => fail('packet_chain_invalid', ref.id, 'history', 'The part-result history contains a cycle'));
}
export function readPartResult(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<CheckedPartResult>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('part.read');
  return result(() => checkedPart(store, request.project, request.record));
}
/** E4 owns persistence. An unsaved response and its derived pair share one guarded transaction. */
export function preparePartResult(store: Store, request: PreparePartResultRequest): OmResult<Sealed<CheckedPartResult & { writes: Write[]; guards: TransactionGuard[] }>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || ![request.packet, request.call].every(isRef)
    || !(isRef(request.response) || object(request.response) && Object.keys(request.response).length === 1
      && object(request.response.pending) && text(request.response.pending.id) && text(request.response.pending.kind)
      && Number.isSafeInteger(request.response.pending.expected) && Object.hasOwn(request.response.pending, 'value')
      && Object.keys(request.response.pending).every(key => ['id', 'kind', 'expected', 'value'].includes(key)))
    || Object.keys(request).some(key => !['project', 'packet', 'call', 'response'].includes(key))) invalid('part');
  request = copy(request);
  return result(() => {
    const pending = isRef(request.response) ? null : request.response.pending;
    if (pending && (pending.expected !== 0 || pending.kind !== PART_RESPONSE_KIND
      || pending.id !== partResponseId(request.project, request.call)))
      fail('part_result_invalid', request.call.id, 'response', 'A pending response creates the original exact adapter-response identity');
    const response: Revision<PartResponseRecord> | null = pending ? { id: pending.id, kind: pending.kind,
      revision: 1, hash: hashJson(pending.value), value: pending.value as PartResponseRecord } : null;
    const stored = response ? store.get(response.id) : null;
    if (stored && !same(stored, response))
      fail('part_result_invalid', stored.id, 'response', 'A saved response cannot be replaced under its original identity');
    const source: PartResultRequest = { ...request, response: response ? reference(response) : request.response as Ref };
    const view = response && !stored ? new Proxy(store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === response.id && (revision === undefined || revision === 1)
        ? response : target.get(id, revision);
      const member: unknown = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    } }) : store;
    const expected = partSource(view, source);
    const old = store.get(expected.record.id);
    if (old) {
      const existing = checkedPart(store, request.project, reference(old));
      if (!same(existing.record, expected.record)) fail('part_result_invalid', old.id, 'record', 'The result identity cannot be reused');
      return { ...existing, writes: [], guards: [reference(old)] };
    }
    const packet = loadPacket(store, request.project, request.packet);
    const current = take(prepareQuestionPacket(store, packet.value.request));
    if (!same(reference(current.record), reference(packet)))
      fail('part_result_invalid', packet.id, 'answerProtocol', 'An old packet cannot become a current-era admission');
    if (store.get(expected.proposal.id)) fail('part_result_invalid', expected.proposal.id, 'proposal', 'The proposal must be saved atomically with its result');
    return { record: expected.record, proposal: expected.proposal, references: expected.references,
      guards: unique([...current.guards, request.packet, reference(store.get(request.call.id)!),
        ...(response && !stored ? [] : [source.response])]), writes: [...(pending && !stored ? [pending] : []),
        ...[expected.proposal, expected.record].map(record => ({ id: record.id, kind: record.kind, expected: 0, value: record.value }))] };
  });
}
function previousParts(store: Store, request: QuestionPacketRequest, plan: NonNullable<QuestionPacketRecord['plan']>, references: Ref[],
  protocol: QuestionPacketRecord['answerProtocol'], contract: QuestionPacketRecord['packetContract']) {
  if (request.previous.length > plan.assignments.length) fail('packet_chain_invalid', request.batch!, 'previous', 'The chain exceeds its assigned parts');
  return request.previous.map((item, index) => {
    const prior = loadPacket(store, request.project, item.packet);
    const { continuation: _continuation, ...priorRequest } = prior.value.request;
    const { continuation: _currentContinuation, ...rootRequest } = request;
    const expected = { ...rootRequest, previous: request.previous.slice(0, index) };
    if (prior.value.answerProtocol !== protocol || prior.value.packetContract !== contract
      || !same(priorRequest, expected) || prior.value.state !== 'ready' || prior.value.plan?.mode !== 'parts'
      || prior.value.plan.position !== index || !same(prior.value.plan.assignments, plan.assignments))
      fail('packet_chain_invalid', item.packet.id, 'previous', 'A prior packet must be the preceding assignment of this same chain');
    const checked = checkedPart(store, request.project, item.result);
    if (!same(checked.record.value.request.packet, item.packet) || !same(reference(checked.proposal), item.proposal))
      fail('packet_chain_invalid', item.result.id, 'previous', 'The prior proposal must be the saved result of this exact packet');
    references.push(...checked.references, item.packet, item.proposal, item.result);
    return json({ packet: item.packet, proposal: item.proposal, result: item.result, nodes: checked.proposal.value.nodes,
      ...(contract === WORKS_PACKET_CONTRACT ? { tests: checked.proposal.value.tests, edges: checked.proposal.value.edges } : {}) });
  });
}
