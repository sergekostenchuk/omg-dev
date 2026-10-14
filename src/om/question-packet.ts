import { BRIEF_PACKET_CONTRACT, WORKS_BRIEF_PACKET_CONTRACT, BRIEF_VERSION, WORKS_BRIEF_VERSION, BRIEF_CONTENT_CONTRACT, BRIEF_REOPEN_CONTRACT, NEIGHBOR_CONTRACT, briefContract, briefMaterial, boundedBrief, briefRepairRule, packetPrompt, packetFingerprint, graphIndex, reopenedMaterial, resolveBriefAnswer, type BriefBasis, type BriefLabel,
  briefReadings, withReadings, type BriefReadings, type CarriedBasis, type CarriedEntry, type ReadingEntry, type ReadingOrigin, type ReadingSnapshot,
  IMPACT_BRIEF_CONTRACT, briefImpactForm, type BriefImpact, BRIEF_SELECTION_CONTRACT } from './packet-brief.js';
import { SELECTED_SPECIFICATION_CODES } from './selected-specification.js';
import { IMPACT_BOUNDARY, IMPACT_GATE_CODES, IMPACT_PARSER, deriveTestMap, isRepository, readSnapshot, resolveSnapshot, transitionField } from './impact.js';
import { IMPACT_SEMANTIC_CODES } from '../graph/semantics.js';
import { CANDIDATE_REFUSAL_CODES } from './frame-candidate.js';
import { ANSWER_FORM_CODES, readTextResult, readPointerResult, tooLargeRead, type ReadResult } from './answer-form.js';
import { Ajv } from 'ajv';
import { sourceIsCurrent, type Selector, type Source } from '../evidence/evidence.js';
import { graphV2Schema } from '../graph/schema.js';
import { readCall, type AnyCallRecord } from './call-record.js';
import { readContinuationEvidence, currentSearchScope, prepareModelAttemptFinish, prepareCompletionPacket, prepareManagedEnvironment, pendingCallStore, readManagedModelDiagnostic, readCorrectionGround, readNeighbourResults, type NeighbourSource,
  readModelCallState, readCompletionWorkAt, readDeliverySet, deliverySetAddress, addsKnowledge } from './model-call.js';
import { readAssessmentRefusalAt } from './assessment.js';
import { readDefinitions } from './repeat-gate.js';
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
import { ONE_ARTIFACT, PROPOSAL_REFUSAL_CODES, WAKE_TEST, prepareFrameProposals, readFrameProposals, readL3Reopen, type LayerProposal, type FrameProposals,
  type FrameReopen } from './frame-proposals.js';
import { FRAME_REFUSAL_CODES, flowKey, WORKS_FRAME_CONTRACT, type FrameObligation } from './frame-obligations.js';
import { readCompletionBinding, readAnySeriesAt, readMechanismAdmission, prepareSeriesLineAdmission, completionWorkId, type Attempt, type RepairSeries, type AnyRepairSeries } from './series.js';
import { readJournal, readJournalAt, journalId, registerJournalProofExecutor, unitRefusalNamespace, type JournalRow, type RefusalJournal } from './refusal-journal.js';
import { prepareCurrentGaps, readGaps, type GapReadRequest, type GapRecords } from './gaps.js';
import { gapLineKey, gapLineExpectedResult } from './gap-lines.js';
import { readOmInput, historicalRead, historicalProof, withHistoricalReads } from './input.js';
import { historicalLayer } from '../history/proofs.js';
import { delivered, refused, sealed, isPlainObject, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readRecord, writeGuarded } from './refs.js';
import { prepareOmObligations, readOmObligations, type ObligationRequest, type OmObligations, type OmObligationHandoff } from './obligations.js';

export const QUESTION_PACKET_CODES = Object.freeze([
  'question_packet_request_invalid', 'packet_task_set_invalid', 'packet_attempt_invalid', 'packet_record_invalid',
  'packet_series_unsupported',
  'packet_context_unbounded', 'packet_too_large', 'node_unexpandable', 'packet_batch_invalid', 'packet_chain_invalid',
  'part_result_invalid', 'part_answer_invalid', 'research_no_progress', 'answer_label_unknown', 'packet_brief_invalid',
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
    catch (error) {
      if (error instanceof PacketFailure) return { ok: false, refusal: error.refusal };
      if (error instanceof EngineError && ['packet_brief_invalid', 'input_stale', ...SELECTED_SPECIFICATION_CODES].includes(error.code))
        return refused(error.code, error.message, (error.details ?? { unit: 'E2', target: 'packet-brief' }) as Refusal['at'], 'producer');
      throw error;
    }
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
  /** MP2 (№2968 §3): the exact rejected step this packet corrects — never beside a continuation. */
  correction?: { packet: Ref; call: Ref; response: Ref; diagnostic: Ref };
}
export interface QuestionPacketRecord {
  project: string; request: QuestionPacketRequest; state: 'ready' | 'blocked' | 'empty';
  answerProtocol?: 'omg-answer/v2' | 'omg-answer/v3';
  packetContract?: 'om-packet/v3' | 'om-packet/works-v1' | typeof BRIEF_PACKET_CONTRACT | typeof WORKS_BRIEF_PACKET_CONTRACT;
  briefCatalogue?: Ref[];
  /** Absent on historical v1 records, including empty/blocked; descendants retain their proved root's version. */
  briefContract?: typeof BRIEF_CONTENT_CONTRACT | typeof BRIEF_REOPEN_CONTRACT;
  /** SP1 (№4714 §2.1): a brief root issued after SP1 declares that its brief carries the selected specification whole;
   * its parts, continuations and corrections keep it; absent in a root saved before. */
  briefSelection?: typeof BRIEF_SELECTION_CONTRACT;
  /** MP2 (№2968 §2, row 19): the neighbour set a brief root issued after MP2 saved; absent in a packet MP1 issued. */
  briefNeighbors?: { contract: typeof NEIGHBOR_CONTRACT; sources: NeighbourSource[] };
  /**
   * OBL1 (№3768, №3773): a works brief step issued since OBL1 shows the exact binding data of its D7 obligations; absent in
   * one issued before, which keeps its bytes. Every new step — a root, a part, a continuation or a correction of an older
   * chain — is issued in the new era.
   */
  worksBindings?: true;
  /**
   * OBL1 (№3773): a brief continuation issued since OBL1 fits what its reads brought into its capacity — the largest
   * delivered results it shows as their length and shape until it fits; absent in one issued before, which keeps its bytes.
   */
  readsFit?: true;
  /**
   * G5 (№3820, №3822): a works brief step issued since G5 whose assignment holds a producer end asks its answer to name the
   * wake test of that end; absent in one issued before, which keeps its bytes, and in a step without a producer end. A
   * continuation or correction keeps the era of its chain.
   */
  wakeTests?: true;
  /**
   * G6 (№3857, №3869): a works brief step issued since the group transition that assigns obligations shows the applied facts
   * of its consumers and the one-artifact rule in its brief, and checks that rule when its new works are accepted; absent in
   * one issued before, which keeps its bytes. A continuation or correction keeps the era of its chain.
   */
  transitionEra?: true;
  /**
   * AT1 (№4091 п.5): the one repository snapshot of a works chain and its test map — resolved once by a new works root,
   * kept by its parts, continuations and corrections; absent in a packet issued before, which keeps its bytes.
   */
  briefImpact?: BriefImpact;
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
export const PACKET_ANSWER_PROTOCOL = 'omg-answer/v3' as const;
type AnswerProtocol = NonNullable<QuestionPacketRecord['answerProtocol']>;
const answerProtocols: readonly AnswerProtocol[] = ['omg-answer/v2', PACKET_ANSWER_PROTOCOL];
export const PACKET_CONTRACT = 'om-packet/v3' as const;
export const WORKS_PACKET_CONTRACT = 'om-packet/works-v1' as const;
const worksPacketContract = (contract: unknown) => contract === WORKS_PACKET_CONTRACT || contract === WORKS_BRIEF_PACKET_CONTRACT;
const packetWorkContract = (packet: QuestionPacketRecord) => worksPacketContract(packet.packetContract) ? WORKS_FRAME_CONTRACT : undefined;
const currentContract = (contract: unknown) => contract === PACKET_CONTRACT || worksPacketContract(contract) || contract === BRIEF_PACKET_CONTRACT;
function currentPacketContract(store: Store, request: QuestionPacketRequest) {
  const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
  const batch = routes.record.value.batches.find(item => item.id === request.batch);
  return batch?.task === 'node-expansion' && batch.level === 3 ? WORKS_PACKET_CONTRACT : PACKET_CONTRACT;
}
const packetKey = (request: QuestionPacketRequest, protocol: QuestionPacketRecord['answerProtocol'], contract?: QuestionPacketRecord['packetContract']) =>
  hashJson(contract ? { contract, protocol, request } : protocol ? { protocol, request } : request);
const packetId = (request: QuestionPacketRequest, protocol: QuestionPacketRecord['answerProtocol'], contract?: QuestionPacketRecord['packetContract']) =>
  `${packetNamespace(request.project)}${packetKey(request, protocol, contract)}`;
function packetEra(store: Store, request: QuestionPacketRequest) {
  const oldContract = currentPacketContract(store, request);
  const newContract = oldContract === WORKS_PACKET_CONTRACT ? WORKS_BRIEF_PACKET_CONTRACT : BRIEF_PACKET_CONTRACT;
  const predecessors = [...(request.continuation ? [request.continuation.packet] : []), ...(request.correction ? [request.correction.packet] : []),
    ...request.previous.map(part => part.packet)]
    .map(ref => loadPacket(store, request.project, ref));
  const inherited = predecessors[0]?.value;
  if (predecessors.some(prior => prior.value.answerProtocol !== inherited!.answerProtocol
    || prior.value.packetContract !== inherited!.packetContract
    || prior.value.briefContract !== inherited!.briefContract
    || prior.value.packetContract !== undefined && worksPacketContract(prior.value.packetContract) !== worksPacketContract(oldContract)))
    fail('packet_chain_invalid', request.batch ?? request.project, 'request', 'A chain preserves one supported answer era and packet contract');
  const eras: { contract: QuestionPacketRecord['packetContract']; protocol: QuestionPacketRecord['answerProtocol'] }[] = inherited
    ? [{ contract: inherited.packetContract, protocol: inherited.answerProtocol }]
    : [{ contract: undefined, protocol: undefined }, { contract: undefined, protocol: 'omg-answer/v2' },
      ...answerProtocols.map(protocol => ({ contract: oldContract, protocol })), { contract: newContract, protocol: PACKET_ANSWER_PROTOCOL }];
  const candidates = eras.map(era => ({ ...era, id: packetId(request, era.protocol, era.contract) }))
    .map(candidate => ({ ...candidate, record: store.get<QuestionPacketRecord>(candidate.id) }));
  const present = candidates.filter(candidate => candidate.record);
  if (present.length > 1)
    fail('packet_chain_invalid', request.batch ?? request.project, 'request', 'The exact request has packets in multiple eras');
  const found = present[0];
  const checked = found?.record ? loadPacket(store, request.project, reference(found.record)) : undefined;
  return { protocol: inherited ? inherited.answerProtocol : found ? found.protocol : PACKET_ANSWER_PROTOCOL,
    contract: inherited ? inherited.packetContract : found ? found.contract : newContract, checked,
    guards: candidates.map(({ id, record }): TransactionGuard => record ? reference(record) : { id, absent: true }) };
}
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
    || Object.hasOwn(value, 'correction') && (Object.hasOwn(value, 'continuation') || !object(value.correction)
      || ![value.correction.packet, value.correction.call, value.correction.response, value.correction.diagnostic].every(isRef)
      || Object.keys(value.correction).some(key => !['packet', 'call', 'response', 'diagnostic'].includes(key)))
    || Object.keys(value).some(key => !['project', 'routes', 'batch', 'environment', 'attempt', 'previous', 'continuation', 'correction', 'works'].includes(key))) invalid('request');
}
function head(store: Store, ref: Ref) {
  const found = store.get(ref.id);
  if (!found || !same(reference(found), ref)) fail('input_stale', ref.id, 'head', 'A packet source changed before this preparation');
}
/**
 * MP2 (№2968 §3, №3153): a correction is a step of its chain — it stands on its root's saved journal, which the very refusal
 * it corrects has already moved past. Everything derived inside it stands there too, wherever it is called from: the earlier
 * steps, the E3 recheck of a need_source behind a continuation, the current admission of a packet already answered.
 */
let chainSteps = 0;
function inChainStep<T>(derive: () => T): T {
  chainSteps++;
  try { return derive(); } finally { chainSteps--; }
}
function previousRefusals(store: Store, request: QuestionPacketRequest, batch: RoutedBatch, gaps: GapRecords, current: boolean,
  savedJournal: Ref | null | undefined, guards: TransactionGuard[], references: Ref[], contract: QuestionPacketRecord['packetContract']) {
  if (!request.attempt) fail('packet_attempt_invalid', batch.id, 'attempt', 'A model packet needs the attempt declared before assembly');
  const ref = request.attempt.series;
  const record = take(readRecord<AnyRepairSeries>(store, ref, { unit: 'E2', target: batch.id,
    idPrefix: `repair-series:${request.project}:`, kind: 'repair-series' }));
  const value = record.value;
  const mechanism = currentContract(contract) && 'owner' in value;
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
  // E2.2 (№1801 row 11, return №1): a later part of a split node continues the chosen task — it stands on the journal of
  // its chain root (the first part, proved at its exact reference), never on today's head; only a new preparation of a
  // chain root takes the current head and guards it.
  const root = request.previous.length ? loadPacket(store, request.project, request.previous[0]!.packet) : null;
  if (root) references.push(reference(root));
  const rows = prior?.outcome?.refusals ?? [];
  if (!rows.length) {
    if (savedJournal) fail('packet_record_invalid', batch.id, 'journal', 'An unused journal cannot be added to a packet');
    if (root?.value.journal) fail('packet_record_invalid', batch.id, 'journal', 'A part cannot name a journal its chain root has no preceding refusals for');
    return { journal: null, refusals: [] };
  }
  const journalRef = root ? root.value.journal : savedJournal === undefined ? reference(take(readJournal(store, { project: request.project }))) : savedJournal;
  if (!journalRef) fail('packet_record_invalid', batch.id, 'journal', 'A repeated question must preserve its refusal source');
  const journal = take(readRecord<RefusalJournal>(store, journalRef, { unit: 'E2', target: batch.id,
    id: journalId(request.project), kind: 'om-refusal-journal' }));
  // S1.1 (№1773): the saved revision is proved at its exact reference, inside the common proof scope of this
  // operation — never today's head, and never through a view of its own that would derive the history again.
  const checkedJournal = take(readJournalAt(store, request.project, reference(journal)));
  references.push(journalRef);
  if (current && !root && !chainSteps) { head(store, journalRef); guards.push(journalRef); }
  // The line this series continues: the exact original series of a claimed cause must be this one or one it inherits
  // from — a cause of another line of the same block is foreign, however alike its goal reads (№1801, rows 5–6).
  const line = new Set<string>([checked.id]);
  for (let cursor = checked; cursor.value.predecessor;) {
    cursor = take(readAnySeriesAt(store, request.project, cursor.value.predecessor));
    references.push(reference(cursor)); line.add(cursor.id);
  }
  return { journal: journalRef, refusals: retryRefusals(store, request.project, batch, checkedJournal.value, rows, prior!, mechanism,
    mechanism ? null : (checked.value as RepairSeries).block, line, references) };
}

/**
 * One cause of the preceding attempt delivered to the model with the repeated question (E2.2, №1801): the journal row
 * it stands in, its typed refusal, the exact question address of THIS packet it concerns, and the remedy of its proved
 * source. Nothing is invented for the model: the code and the remedy are the source's own, the address is the question's.
 */
export interface RetryRefusal { row: string; code: string; target: string; field: string; remedy: string }

/** The kinds of journal rows E2 tells apart, by the gate and the namespace of the row's source (№1801, return №2 table). */
type CauseKind = 'g4b' | 'e5' | 'e4' | 'gate';
function causeKind(project: string, row: JournalRow): CauseKind {
  const namespace = unitRefusalNamespace(project);
  if (row.gate === 'G4b' || row.source.id.startsWith(`${namespace}g4b:`)) return 'g4b';
  if (row.gate === 'E5' || row.source.id.startsWith(`${namespace}e5:`)) return 'e5';
  if (row.gate === 'E4' || row.source.id.startsWith(`${namespace}e4:`)) return 'e4';
  return 'gate';
}
/** The source roles G7 weighs for a class through the origin reader; every other role is never read as a definition. */
const DEFINITION_ROLES: readonly string[] = ['proposal', 'base', 'derived'];

/**
 * E2.2 (№1801, returns №1 and №2): which claimed causes of the preceding attempt of the same full goal reach the repeated
 * packet, and at which question address — ONE decision per journal row, by the table of row kinds:
 *
 *   kind of row                      decision   exact bases and their common reader (a refusal of the reader is carried as it is)
 *   G4b observation                  refuse     none — an observation of the check is never a subject; a claim of it is E2's own refusal
 *   E5 N (insufficient/conflicting)  deliver    readAssessmentRefusalAt: refusal record → exact result → intent → MC1 question; own line, attempt, goal, block, consumer
 *   E5 T / supported                 —          no journal row exists for them: nothing to exclude, the technical outcome lives in the completion snapshot
 *   E4, stage not "refused"          exclude    none — a technical or owner-control end (off-form, interrupted, awaiting-owner) is no task for the model; the stage is the producer's own, proved with the record by the journal
 *   E4 refused, legacy series        deliver    readCall (exact admitted E1: line, attempt, goal, subject, block) and readQuestionPacket (the exact E2 the E1 names: requestId, attempt, body or fingerprint); address = the gaps of the E1
 *   E4 refused, managed attempt      deliver    readCall, readCompletionBinding, readManagedModelDiagnostic (the whole diagnostic by its exact physical derivation, reason from the reader)
 *   other gate, no saved class       refuse     none — an unclassified claimed row has no context; E2's own refusal
 *   other gate, class unknown/input/derivation/conditions/readiness   exclude   none — the class G7 saved excludes the row from the task of the model; no reader is applied to a role it does not read
 *   other gate, class proposal       deliver    the bases G7 weighed: definition roles (proposal, base, derived) through readDefinitions, an environment role at its exact reference; address = the node G7 named as addressee
 *   a part of a split node           —          the same table on the journal of the chain root, delivered for the questions the part sends
 *   a need_source continuation       —          a copy of the root packet's context
 *
 * E2's OWN findings about the link — a missing row, a G4b claim, a row of no class, a source of another line, attempt, goal,
 * block or consumer, an E4 without its stage, call or packet, a proposal without a node addressee, an environment source
 * away from its exact reference — are packet_record_invalid at this packet's refusals; nothing is ever turned into an
 * empty context. The classification is G7's record: it is read, never re-derived here. The delivery is per exact
 * (target, field) the packet actually sends, in canonical order, one element per row and address.
 */
function retryRefusals(store: Store, project: string, batch: RoutedBatch, journal: RefusalJournal, links: readonly { row: string }[],
  prior: Attempt, mechanism: boolean, block: string | null, line: ReadonlySet<string>, references: Ref[]): RetryRefusal[] {
  const questions = batch.items.map(item => ({ target: item.target, field: item.field, consumers: item.consumers }));
  const addressed = (target: string, field: string, consumer: string | null) => questions.some(question =>
    question.target === target && question.field === field && (mechanism || consumer === null || question.consumers.includes(consumer)));
  const invalid = (row: JournalRow, message: string, ref: Ref = row.source): never => fail('packet_record_invalid', row.id, 'refusals', message, ref);
  const classes = new Map(journal.classifications.map(item => [item.row, item]));
  const delivered = new Map<string, RetryRefusal>();
  const deliver = (row: JournalRow, target: string, field: string) => {
    const key = canonical([row.id, target, field]);
    if (!delivered.has(key)) delivered.set(key, { row: row.id, code: row.code, target, field, remedy: row.remedy });
  };
  for (const link of links) {
    const row = journal.rows.find(item => item.id === link.row);
    if (!row) fail('packet_record_invalid', link.row, 'refusals', 'The preceding attempt names a missing journal row');
    const kind = causeKind(project, row);
    if (kind === 'g4b') invalid(row, 'A G4b finding is an observation of the check, not a refusal of the proposal the model can answer for');
    if (kind === 'e5') {
      // The common E5 reader proves the verdict, the exact result and intent, the original attempt and the question.
      const proof = take(readAssessmentRefusalAt(store, project, row.source));
      const intent = proof.intent;
      if (mechanism) invalid(row, 'E5 fact assessments belong to block attempts', reference(proof.result));
      if (!line.has(intent.originalSeries.id) || intent.attempt !== prior.ordinal || !same(intent.goal, prior.goal) || intent.block !== block || proof.consumer !== block)
        invalid(row, 'The claimed E5 refusal belongs to another line, attempt, goal or block', reference(proof.result));
      references.push(...proof.guards);
      if (addressed(intent.question.target, intent.question.field, proof.consumer)) deliver(row, intent.question.target, intent.question.field);
      continue;
    }
    if (kind === 'e4') {
      const stage = /^model-call:(.+)$/.exec(row.origin.stage)?.[1];
      const callSource = row.origin.sources.find(item => item.role === 'call'), packetSource = row.origin.sources.find(item => item.role === 'packet');
      if (!stage || !callSource || !packetSource) invalid(row, 'An E4 diagnostic names its producer stage, the admitted call and the packet');
      // A technical or owner-control end is excluded from the task of the model without any reader.
      if (stage !== 'refused') continue;
      const call = take(readCall(store, project, callSource!.ref));
      if (!line.has(call.value.series.id) || call.value.attempt !== prior.ordinal || !same(call.value.goal, prior.goal) || call.value.call !== row.origin.subject
        || (block !== null && ('owner' in call.value || call.value.block !== block)) || (block === null && !('owner' in call.value)))
        invalid(row, 'The claimed E4 diagnostic belongs to a call of another line, attempt, goal or block', callSource!.ref);
      references.push(callSource!.ref);
      const binding = take(readCompletionBinding(store, project, call.value.series, call.value.attempt));
      if (binding) {
        // A managed attempt proves the whole diagnostic by its exact physical derivation; the reason is the reader's.
        const diagnostic = take(readManagedModelDiagnostic(store, binding, row.source));
        if (diagnostic.request.code !== row.code || diagnostic.request.message !== row.remedy || !same(diagnostic.request.call, callSource!.ref))
          invalid(row, 'The claimed E4 row must be the diagnostic of its own admitted call');
        references.push(reference(binding));
        if (diagnostic.reason !== 'refused') continue;
      } else {
        // A legacy series has no binding: the exact E2 the E1 names is read by its own reader and must be the packet of
        // this call and attempt — the E1 carries its requestId and its body or fingerprint (the mechanism E1 stores).
        const packet = take(readQuestionPacket(store, { project, record: packetSource!.ref }));
        const payload = packet.value.packet as Record<string, Json> | null, attempt = packet.value.request.attempt;
        if (!payload || payload.requestId !== call.value.call || !attempt || attempt.series.id !== call.value.series.id || attempt.ordinal !== call.value.attempt)
          invalid(row, 'The packet source of the claimed E4 diagnostic is not the E2 of its admitted call and attempt', packetSource!.ref);
        const bytes = packetPrompt(payload);
        if (!same(call.value.packet, payload) && !same(call.value.packet, packet.value.fingerprint)
          && !same(call.value.packet, { hash: hashJson(payload), chars: bytes.length, bytes: Buffer.byteLength(bytes) }))
          invalid(row, 'The admitted call must carry the body or the fingerprint of its exact E2', packetSource!.ref);
        references.push(packetSource!.ref);
      }
      for (const gap of call.value.gaps) {
        if (gap.goal !== row.goal) continue;
        const consumer = typeof gap.consumer === 'string' ? gap.consumer : null;
        if (addressed(gap.goal, gap.field, consumer)) deliver(row, gap.goal, gap.field);
      }
      continue;
    }
    // Any other gate: the class G7 saved beside the row decides; an excluded class reads nothing further.
    const placed = classes.get(row.id);
    if (!placed) invalid(row, 'A claimed refusal of another gate has neither a proved subject kind nor a saved class: its context is unavailable');
    if (placed!.class !== 'proposal') continue;
    const addressee = /^node:(.+)$/.exec(placed!.addressee)?.[1];
    if (!addressee) invalid(row, 'A refusal of the proposal must be addressed to a node by its saved class');
    // The bases G7 weighed for the proposal must read now, each through the reader of its role; the reader's refusal is
    // carried as it is. A role G7 does not read as a definition is not read here either.
    for (const source of unique(placed!.basis)) {
      if (source.role === 'environment') {
        const found = store.get(source.ref.id, source.ref.revision);
        if (!found || found.hash !== source.ref.hash) invalid(row, 'An environment source of the claimed refusal does not stand at its exact reference', source.ref);
        references.push(source.ref);
      } else if (DEFINITION_ROLES.includes(source.role)) references.push(...take(readDefinitions(store, { project, source })).references, source.ref);
    }
    for (const question of questions) {
      if (question.target === addressee && (mechanism || block === null || question.consumers.includes(block))) deliver(row, question.target, question.field);
    }
  }
  return sorted([...delivered.values()]);
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
  try {
    if (object(value) && [BRIEF_VERSION, WORKS_BRIEF_VERSION].includes(value.version as typeof BRIEF_VERSION)) {
      const fingerprint = packetFingerprint(value); return fingerprint.chars <= max ? fingerprint : null;
    }
    const { text: _text, ...fingerprint } = boundedContext(value, max); return fingerprint;
  }
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
/** RB1: whether a request expands an L3 node over a works frame the owner reopened (RL3) — the root then shows those works whole. */
function reopenedRoot(store: Store, request: QuestionPacketRequest): boolean {
  if (request.batch === null) return false;
  const routes = take(readRoutes(store, { project: request.project, record: request.routes })) as unknown as { record: Revision<RoutesRecord> };
  const batch = routes.record.value.batches.find(item => item.id === request.batch);
  const works = routes.record.value.request.gaps.sources.works as unknown as { frame?: { reopen?: FrameReopen } };
  return batch?.task === 'node-expansion' && batch.level === 3 && object(works.frame) && object(works.frame.reopen);
}
/**
 * RB1 (№4285, №4291; class of 03.10: every duty with its material in the first request): each work the owner reopened under
 * the expanded node, whole as the accepted graph holds it — the node, its tests, its L3 bindings, the joins it consumes, its
 * edges, and the works before it (by order, by the bindings it consumes, by its integrations) with their ports and code
 * references — with what the AT1 door found in it and the tests its change reaches. A policy finding carries the decision
 * B1 now holds for its exact policy, producer and contract (or null), so that the model designs by it and never decides it
 * again. The model redefines the work under the same id (removes) instead of asking for what it must keep or change.
 */
type PolicyRow = { question: { id: string; readiness?: { cause: string; policy?: string; producer?: string; governs?: { contract: string; hash: string };
  snapshot?: { commit: string; tree: string }; file?: string; line?: number; site?: { start: number; end: number; hash: string }; works?: string[] } }; value: Json };
function reopenedContext(store: Store, frame: FrameProposals, node: string, references: Ref[], input: Json): Json[] {
  const reopen = (frame.frame.request as { reopen?: FrameReopen }).reopen, graph = frame.frame.accepted?.graph;
  if (!reopen || !graph) return [];
  const record = take(readL3Reopen(store, frame.frame.request.project, reopen.record)) as unknown as Revision<{ snapshot: { commit: string; tree: string };
    findings: { code: string; target: string; field: string; message: string }[];
    impact: { works: { work: string; entries: { test: string; direct: boolean; cases?: unknown; addressable?: boolean }[] }[] } }>;
  references.push(reopen.record);
  const held = input as { facts?: PolicyRow[]; decided?: PolicyRow[] }, applied = [...held.facts ?? [], ...held.decided ?? []];
  const policies = applied.filter(row => row.question.readiness?.cause === 'policy');
  const decision = (field: string) => {
    const row = policies.find(item => { const cause = item.question.readiness!; return `${cause.policy}:${cause.producer}:${cause.governs?.contract}` === field; });
    return row ? { question: row.question.id, governs: row.question.readiness!.governs!, value: row.value } : null;
  };
  // №4343: a transition the door found is closed by the answer B1 applied for that exact site of the reopening's snapshot
  // and this work — whichever block its question was asked at (its consumer); its works and places name this one.
  const transitions = applied.filter(row => row.question.readiness?.cause === 'transition');
  const answered = (work: string, field: string) => {
    const row = transitions.find(item => { const cause = item.question.readiness!;
      return cause.snapshot?.tree === record.value.snapshot.tree && (cause.works ?? []).includes(work)
        && transitionField({ file: cause.file!, line: cause.line!, site: cause.site! }) === field; });
    return row ? { question: row.question.id, snapshot: row.question.readiness!.snapshot!, value: row.value } : null;
  };
  const relations = new RefinementRelations(graph);
  return reopen.works.filter(work => relations.refines(work, node)).sort(order).map(work => json({ ...reopenedDefinition(graph, work),
    findings: record.value.findings.filter(finding => finding.target === work)
      .map(finding => finding.code === 'work_policy_open' ? { ...finding, decision: decision(finding.field) }
        : finding.code === 'work_impact_unresolved' ? { ...finding, decision: answered(work, finding.field) } : finding),
    affected: (record.value.impact.works.find(row => row.work === work)?.entries ?? [])
      .map(entry => ({ test: entry.test, direct: entry.direct, ...(entry.addressable ? { cases: entry.cases } : {}) })) }));
}
/**
 * RB1: a reopened work as the accepted graph defines it — the node, its tests, its L3 bindings with the wake test of their
 * connector (№4337), the sleeping anchors it owns (the wake test its producer end chose), the joins it consumes, its edges,
 * and the works before it. Its accepted fills do not keep the wake choice: the redefinition names it again.
 */
export function reopenedDefinition(graph: Graph, work: string) {
  const definition = graph.nodes.find(item => item.id === work)!;
  const bindings = graph.connectors.flatMap(connector => connector.bindings.filter(binding => binding.level === 3
    && (binding.producer.node === work || binding.consumers.some(end => end.node === work)))
    .map(binding => ({ connector: connector.id, artifact: connector.artifact, wakeTest: connector.wakeTest, binding })));
  const edges = (graph.edges ?? []).filter(edge => edge.source === work || edge.target === work);
  const before = new Set([...edges.filter(edge => edge.target === work).map(edge => edge.source),
    ...bindings.filter(row => row.binding.producer.node !== work).map(row => row.binding.producer.node),
    ...(definition.integrations ?? []).flatMap(item => 'predecessor' in item.basis ? [item.basis.predecessor] : [])]);
  return { work, node: definition, tests: graph.tests.filter(test => test.node === work), bindings,
    anchors: graph.anchors.filter(anchor => anchor.owner === work),
    joins: graph.joins.filter(join => join.consumer === work), edges,
    predecessors: graph.nodes.filter(item => before.has(item.id) && item.id !== work).sort((a, b) => order(a.id, b.id)) };
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
export interface WorksPacketContext {
  contract: typeof WORKS_FRAME_CONTRACT; producer: Ref; ledger: Ref;
  obligations: CarriedObligation[]; nodeAssignments: string[]; assigned: string[];
}
function assignmentGraph(frame: FrameProposals): Graph {
  const initial = frame.frame.accepted?.graph ?? frame.frame.upper;
  return { ...initial, nodes: [...new Map([...initial.nodes, ...frame.proposals.flatMap(item => item.value.nodes)]
    .map(node => [node.id, node] as const)).values()], edges: [...(initial.edges ?? []), ...frame.proposals.flatMap(item => item.value.edges)] } as Graph;
}
/** The D7 tasks a work packet assigns to one node — one derivation for the packet and for an LP5 reuse of its answer. */
export function workAssignments(frame: FrameProposals, node: string, basis: OmObligations): WorksPacketContext {
  const graph = assignmentGraph(frame);
  const relations = new RefinementRelations(graph);
  const refinements = graph.nodes.filter(item => relations.refines(item.id, node));
  const assigned = taskObligations(basis.handoff).filter(obligation => refinements.some(item =>
    relations.refines(item.id, obligation.responsibleNode) && relations.refines(item.id, obligation.responsibleConsumer)))
    .map(taskBindingId).sort(order);
  return { contract: WORKS_FRAME_CONTRACT, producer: reference(basis.producer), ledger: reference(basis.record),
    obligations: basis.handoff.obligations, nodeAssignments: assigned, assigned };
}

/**
 * MP3 (№2981 п.1): whether this request continues the readings era. A new independent brief root opens it; an existing exact
 * packet keeps its own form (MP1 priority); parts and continuations inherit the era of their root.
 */
function chainReadings(store: Store, request: QuestionPacketRequest, saved: QuestionPacketRecord | undefined): boolean {
  const ancestor = request.continuation?.packet ?? request.previous[0]?.packet;
  if (ancestor) return briefReadings(loadPacket(store, request.project, ancestor).value.packet) !== null;
  return saved ? briefReadings(saved.packet) !== null : true;
}
type CarriedRow = Omit<ReadingEntry, 'decision'>;
interface DeliveryRow { delivery: Ref; questionIds: string[]; read: PacketRead; sources: Ref[]; data: Json }
const originRank = (origin: ReadingOrigin) => origin.kind === 'part' ? [0, -origin.position] : [1, -origin.ordinal];
const compareOrigins = (a: ReadingOrigin, b: ReadingOrigin) => {
  const [x, y] = [originRank(a), originRank(b)];
  return x[0]! - y[0]! || x[1]! - y[1]! || order(canonical(a.delivery), canonical(b.delivery));
};
/** Equal read, sources and data are one shown item with every origin; later parts and attempts first, then exact references. */
function groupCarried(rows: readonly CarriedRow[]): CarriedRow[] {
  const groups = new Map<string, CarriedRow>();
  for (const row of rows) {
    const key = canonical({ read: row.read, sources: row.sources, data: row.data }), group = groups.get(key);
    if (!group) groups.set(key, { origins: [...row.origins], read: row.read, sources: row.sources, data: row.data });
    else for (const origin of row.origins) if (!group.origins.some(item => same(item, origin))) group.origins.push(origin);
  }
  const grouped = [...groups.values()].map(row => ({ ...row, origins: [...row.origins].sort(compareOrigins) }));
  return grouped.sort((a, b) => compareOrigins(a.origins[0]!, b.origins[0]!) || order(canonical(a), canonical(b)));
}
/** A delivery of an earlier era is shown in the addressed form, re-derived from its exact proved source; the record is unchanged. */
function representedData(store: Store, row: DeliveryRow, addressed: boolean): Json {
  if (addressed || (row.read.action !== 'read_source' && row.read.action !== 'read_context')) return row.data;
  const record = row.read.action === 'read_source' ? store.get(row.read.source.id, row.read.source.revision)
    : store.get(row.read.record.id, row.read.record.revision);
  let result: ReadResult | null = null;
  if (record && row.read.action === 'read_source') {
    const content = (record.value as unknown as Source).content;
    result = row.read.selector.kind === 'text-range' ? readTextResult(content, row.read.selector) : readPointerResult(JSON.parse(content), row.read.selector.pointer);
  }
  else if (record && row.read.action === 'read_context') result = readPointerResult(record.value, row.read.pointer);
  if (!result || result.outcome !== 'complete' || !same('text' in result ? result.text : 'value' in result ? result.value : null, row.data))
    fail('packet_record_invalid', row.delivery.id, 'readings', 'A carried earlier delivery must be its exact complete read', row.delivery);
  return json(result);
}
/** The node, level or question set a batch assigns: equal assignments of different attempts may have different batch ids. */
function assignmentKey(batch: RoutedBatch): string {
  return canonical(batch.task === 'node-expansion' ? { model: batch.model, task: batch.task, kind: batch.kind, level: batch.level, node: batch.node }
    : { model: batch.model, task: batch.task, kind: batch.kind, questions: sorted(batch.items.map(item => [item.target, item.field])) });
}
function packetAssignment(store: Store, project: string, packet: Revision<QuestionPacketRecord>): string | null {
  const routes = take(readRoutes(store, { project, record: packet.value.request.routes })) as unknown as { record: Revision<RoutesRecord> };
  const batch = routes.record.value.batches.find(item => item.id === packet.value.request.batch);
  return batch ? assignmentKey(batch) : null;
}
/** Deliveries of the chain that ends at a prior part packet: its need_source links back to the first packet of that part. */
function partRows(store: Store, project: string, last: Revision<QuestionPacketRecord>): CarriedRow[] {
  const rows: CarriedRow[] = [], position = last.value.plan?.position;
  if (position === undefined) fail('packet_chain_invalid', last.id, 'readings', 'A carried part has its exact plan position');
  // The part's chain back to its first packet: continuations bring their deliveries; an MP2 correction is a step of the same
  // chain without deliveries of its own, so the walk passes through it to the rejected step and its reads.
  for (let cursor = last; ;) {
    const link = cursor.value.request.continuation;
    if (link) {
      const evidence = take(readContinuationEvidence(store, { project, ...link }));
      for (const row of evidence.data as unknown as DeliveryRow[]) rows.push({ origins: [{ kind: 'part', position, packet: link.packet, call: link.call,
        response: link.response, delivery: row.delivery, questionIds: [...row.questionIds] }], read: row.read as unknown as Json, sources: [...row.sources], data: row.data });
      cursor = loadPacket(store, project, link.packet);
    } else if (cursor.value.request.correction) cursor = loadPacket(store, project, cursor.value.request.correction.packet);
    else break;
  }
  return rows;
}
/**
 * Deliveries of earlier completed attempts of the same proved line (own and inherited attempts only) and full goal, for the
 * same assignment, from the exact registry snapshot of each managed attempt and its deterministic step sets. A legacy
 * attempt without a registry has no exact snapshot and gives nothing.
 */
function attemptRows(store: Store, request: QuestionPacketRequest, batch: RoutedBatch, saved: readonly ReadingSnapshot[] | null) {
  const project = request.project, attemptRef = request.attempt!;
  const series = take(readAnySeriesAt(store, project, attemptRef.series));
  const attempt = series.value.attempts.find(item => item.ordinal === attemptRef.ordinal);
  if (!attempt) fail('packet_attempt_invalid', batch.id, 'attempt', 'Carried reads need the declared running attempt');
  const key = assignmentKey(batch), snapshots: ReadingSnapshot[] = [], rows: CarriedRow[] = [];
  const earlier = [...series.value.inherited, ...series.value.attempts]
    .filter(item => item.ordinal < attempt.ordinal && item.outcome !== null && same(item.goal, attempt.goal)).sort((a, b) => b.ordinal - a.ordinal);
  for (const item of earlier) {
    const binding = take(readCompletionBinding(store, project, attemptRef.series, item.ordinal));
    if (!binding) continue;
    const kept = saved?.find(row => row.kind === 'attempt' && row.ordinal === item.ordinal) as Extract<ReadingSnapshot, { kind: 'attempt' }> | undefined;
    const head = kept ? null : store.get(completionWorkId(project, binding.id));
    if (saved && !kept || !kept && !head) fail('packet_record_invalid', binding.id, 'readings', 'An earlier managed attempt keeps its exact registry snapshot');
    const workRef = kept ? kept.work : reference(head!);
    const work = take(readCompletionWorkAt(store, project, workRef));
    if (!same(reference(work.binding), reference(binding)))
      fail('packet_record_invalid', workRef.id, 'readings', 'The registry snapshot belongs to the binding of this earlier attempt');
    const steps = new Map<string, { record: Ref; basis: { project: string; packet: Ref; call: Ref; response: Ref } }>();
    const continued: { project: string; packet: Ref; call: Ref; response: Ref; deliveries: Ref[] }[] = [];
    for (const ref of work.products) {
      const kind = store.get(ref.id, ref.revision)?.kind;
      if (kind === 'model-call') {
        const state = take(readModelCallState(store, { project, record: ref }));
        if (state.state !== 'applied' || state.outcome.outcome?.kind !== 'need-source' || !state.outcome.response) continue;
        if (packetAssignment(store, project, loadPacket(store, project, state.outcome.packet)) !== key) continue;
        const old = steps.get(ref.id);
        if (!old || old.record.revision < ref.revision) steps.set(ref.id, { record: ref,
          basis: { project, packet: state.outcome.packet, call: state.outcome.call, response: state.outcome.response } });
      } else if (kind === QUESTION_PACKET_KIND) {
        const packet = loadPacket(store, project, ref), link = packet.value.request.continuation;
        if (link && packetAssignment(store, project, packet) === key) continued.push({ project, ...link });
      }
    }
    const found = kept ? kept.sets : [...steps.values()].flatMap(step => {
      const set = store.get(deliverySetAddress(step.basis)); return set ? [reference(set)] : [];
    }).sort((a, b) => order(canonical(a), canonical(b)));
    for (const link of continued) {
      const set = found.find(ref => ref.id === deliverySetAddress(link));
      if (!set) fail('packet_record_invalid', link.response.id, 'readings', 'A delivery set referenced by a saved continuation is missing');
    }
    for (const ref of found) {
      const set = take(readDeliverySet(store, project, ref));
      const step = [...steps.values()].find(row => same(row.basis, set.basis));
      if (!step) fail('packet_record_invalid', ref.id, 'readings', 'A carried set belongs to a step of this exact earlier assignment', ref);
      const continuation = continued.find(link => same({ project, packet: link.packet, call: link.call, response: link.response }, set.basis));
      if (continuation && !same(continuation.deliveries, set.deliveries))
        fail('packet_record_invalid', ref.id, 'readings', 'A saved continuation names exactly the deliveries of its step', ref);
      const addressed = briefReadings(loadPacket(store, project, set.basis.packet).value.packet) !== null;
      for (const row of set.data as unknown as DeliveryRow[]) rows.push({ origins: [{ kind: 'attempt', ordinal: item.ordinal, binding: reference(binding),
        work: workRef, packet: set.basis.packet, call: set.basis.call, response: set.basis.response, delivery: row.delivery,
        questionIds: [...row.questionIds] }], read: row.read as unknown as Json, sources: [...row.sources], data: representedData(store, row, addressed) });
    }
    snapshots.push({ kind: 'attempt', ordinal: item.ordinal, binding: reference(binding), work: workRef, sets: found });
  }
  if (saved && !same(snapshots, saved)) fail('packet_record_invalid', batch.id, 'readings', 'The saved readings snapshots must follow from the exact attempt line');
  return { snapshots, rows };
}
/**
 * Currency of a carried delivery at its first selection: an exact head for every source, a prior file check for files and, for
 * a search over a workspace path, its whole scope today — the producer's own walk must find exactly the delivered files, also
 * when there were none (Codex-omg №3190); otherwise the delivery is omitted as unconfirmed. Nothing is captured or delivered.
 */
function carriedCurrency(store: Store, row: CarriedRow, workspace: () => string): CarriedEntry['decision'] {
  for (const source of row.sources) {
    const head = store.get(source.id);
    if (!head) fail('packet_record_invalid', source.id, 'readings', 'A carried source keeps its record');
    if (!same(reference(head), source)) return { state: 'omitted', reason: 'head-changed', source, observed: reference(head) };
    const value = head.value as unknown as Source;
    if (head.kind === 'source' && object(value) && object(value.origin) && value.origin.kind === 'file' && !sourceIsCurrent(value))
      return { state: 'omitted', reason: 'currency-unconfirmed', source };
  }
  const read = row.read as unknown as PacketRead;
  if (read.action === 'search' && typeof read.within === 'string') {
    const today = currentSearchScope(workspace(), read.within);
    const delivered = row.sources.map(ref => store.get<Source>(ref.id, ref.revision)!.value.origin.location);
    if (!today || !same([...today].sort(), [...delivered].sort())) return { state: 'omitted', reason: 'scope-unconfirmed' };
  }
  return { state: 'eligible' };
}
/** History keeps the saved decision and checks its evidence; current admission requires every included source to be current. */
function replayedCurrency(store: Store, entry: ReadingEntry, current: boolean, workspace: () => string): CarriedEntry['decision'] {
  const decision = entry.decision;
  if (decision.state === 'included') {
    if (current) {
      const now = carriedCurrency(store, entry, workspace);
      // A moved search scope changes no single source: the refusal names the carried delivery itself.
      if (now.state !== 'eligible') {
        const at = 'source' in now ? now.source : entry.origins[0]!.delivery;
        fail('input_stale', at.id, 'readings', 'source' in now ? 'A carried source changed after its selection'
          : 'The scope of a carried search changed after its selection', at);
      }
    }
    return { state: 'eligible' };
  }
  if (decision.reason === 'capacity' || decision.reason === 'unaddressed') return { state: 'eligible' };
  // History keeps an unconfirmed scope as it was decided: today's disk is not walked again (Codex-omg №3190).
  if (decision.reason === 'scope-unconfirmed') return decision;
  if (!entry.sources.some(source => same(source, decision.source))) fail('packet_record_invalid', decision.source.id, 'readings', 'An omission names a source of its delivery');
  if (decision.reason === 'head-changed') {
    const observed = store.get(decision.observed.id, decision.observed.revision);
    if (!observed || !same(reference(observed), decision.observed) || decision.observed.id !== decision.source.id
      || decision.observed.revision <= decision.source.revision)
      fail('packet_record_invalid', decision.source.id, 'readings', 'A changed head is proved by the saved later revision');
    return decision;
  }
  const record = store.get<Source>(decision.source.id, decision.source.revision);
  if (record?.kind !== 'source' || record.value.origin?.kind !== 'file')
    fail('packet_record_invalid', decision.source.id, 'readings', 'Only a file source can have an unconfirmed currency');
  return decision;
}
/**
 * MP3 (№2981 п.4–5): the carried set of a new packet. A continuation keeps the set of its packet; a part adds the chain of the
 * preceding part to that part's set; a new attempt root selects from earlier attempts. The set is fixed at first issuance;
 * saved readings are replayed from the same snapshots.
 */
function carriedReadings(store: Store, request: QuestionPacketRequest, batch: RoutedBatch, current: boolean, saved: BriefReadings | null): CarriedBasis {
  const project = request.project;
  let snapshots: ReadingSnapshot[], rows: CarriedRow[];
  const link = request.continuation ?? request.correction;
  if (link) {
    const prior = briefReadings(loadPacket(store, project, link.packet).value.packet)!;
    snapshots = prior.snapshots; rows = prior.entries.map(({ decision: _decision, ...row }) => row);
  } else if (request.previous.length) {
    const last = loadPacket(store, project, request.previous.at(-1)!.packet), prior = briefReadings(last.value.packet);
    if (!prior) fail('packet_chain_invalid', last.id, 'readings', 'A part continues the readings of its preceding part');
    snapshots = [{ kind: 'packet', packet: reference(last) }];
    rows = groupCarried([...prior.entries.map(({ decision: _decision, ...row }) => row), ...partRows(store, project, last)]);
  } else ({ snapshots, rows } = (() => {
    const selected = attemptRows(store, request, batch, saved ? saved.snapshots : null);
    return { snapshots: selected.snapshots, rows: groupCarried(selected.rows) };
  })());
  if (saved && (!same(saved.snapshots, snapshots) || !same(saved.entries.map(({ decision: _decision, ...row }) => row), rows)))
    fail('packet_record_invalid', batch.id, 'readings', 'The saved carried set must follow from its exact snapshots');
  const workspace = () => take(readRecord<{ workspace: string }>(store, request.environment,
    { unit: 'E2', target: batch.id, id: `environment:${project}`, kind: 'environment' })).value.workspace;
  return { snapshots, entries: rows.map((row, index) => ({ ...row,
    decision: saved ? replayedCurrency(store, saved.entries[index]!, current, workspace) : carriedCurrency(store, row, workspace) })) };
}
const includedSources = (packet: Json): Ref[] => (briefReadings(packet)?.entries ?? [])
  .flatMap(entry => entry.decision.state === 'included' ? entry.sources : []);
/**
 * MP3: a chain step of the readings era — a continuation or an MP2 correction — shows the set fixed for the step it follows
 * (the same snapshots and entries), in the capacity left after its mandatory content; a saved step replays its decisions.
 * The era is the root's: the caller asks only when the step it follows carries readings.
 */
function chainStepReadings(store: Store, request: QuestionPacketRequest, prior: Revision<QuestionPacketRecord>, saved: QuestionPacketRecord | undefined,
  current: boolean, packet: Json, limit: number): { packet: Json; guards: Ref[] } {
  const savedReadings = saved ? briefReadings(saved.packet) : null;
  if (saved && !savedReadings) fail('packet_record_invalid', prior.id, 'readings', 'A chain step of the readings era keeps its readings');
  const routed = take(readRoutes(store, { project: request.project, record: request.routes })) as unknown as { record: Revision<RoutesRecord> };
  const batch = routed.record.value.batches.find(item => item.id === request.batch)!;
  const next = json(withReadings(packet as Record<string, any>, carriedReadings(store, request, batch, current, savedReadings), limit));
  return { packet: next, guards: current ? includedSources(next) : [] };
}
function deriveContinuation(store: Store, request: QuestionPacketRequest, current: boolean,
  contract: NonNullable<QuestionPacketRecord['packetContract']>, protocol: QuestionPacketRecord['answerProtocol'], saved?: QuestionPacketRecord) {
  const continuation = request.continuation!;
  const prior = loadPacket(store, request.project, continuation.packet);
  const { continuation: _priorContinuation, correction: _priorCorrection, ...priorRoot } = prior.value.request;
  const { continuation: _continuation, ...root } = request;
  if (prior.value.packetContract !== contract || prior.value.answerProtocol !== protocol || prior.value.state !== 'ready' || !object(prior.value.packet)
    || !same(root, priorRoot))
    fail('packet_chain_invalid', continuation.packet.id, 'continuation',
      'A continuation preserves the exact ready assignment, sources and attempt of its current-contract predecessor');
  // Reuse the saved native questions and part assignment while checking today's admission dependencies.
  const priorDerived = derivePacket(store, prior.value.request, current, prior.value.answerProtocol, prior.value.packetContract, prior.value as QuestionPacketRecord);
  const evidence = take(readContinuationEvidence(store, { project: request.project, ...continuation }, current));
  const capacity = take(readCapacity(store, { project: request.project, environment: request.environment, current }));
  const guards = [...priorDerived.guards, ...capacity.guards, ...evidence.guards];
  if (current) {
    for (const ref of [continuation.packet, continuation.response]) { head(store, ref); guards.push(ref); }
    // Admission is revision one; an already settled call legitimately has a later current head.
    guards.push(reference(store.get(continuation.call.id)!));
  }
  const requestId = packetKey(request, protocol, contract);
  const payload = prior.value.packet;
  let basis = priorDerived.briefBasis;
  if (briefContract(contract)) {
    if (!basis) fail('packet_record_invalid', prior.id, 'brief', 'A continuation needs the rederived prior assignment');
    const environment = take(readRecord<{ workspace: string }>(store, request.environment,
      { unit: 'E2', target: requestId, id: `environment:${request.project}`, kind: 'environment' }));
    const deliveredSources = evidence.data.flatMap(row => object(row) && Array.isArray(row.sources) ? row.sources.filter(ref => isRef(ref) && ref.id.startsWith(`source:${request.project}:`)) as Ref[] : []);
    const material = briefMaterial(store, request.project, environment.value.workspace, current,
      unique([...basis.material.references, ...deliveredSources]));
    basis = { ...basis, material, worksBindings: stepShowsBindings(prior.value as QuestionPacketRecord, contract, saved), priorLabels: (payload.brief as unknown as { labels: BriefLabel[] }).labels };
    guards.push(...material.guards);
  }
  const kind = payload.task === 'node-expansion' ? 'node' : payload.model === 'MC1' ? 'fact' : 'field';
  const build = (rows: readonly Json[]) => {
    const whole = json({ ...payload, requestId,
      responseForm: { ...(payload.responseForm as Record<string, Json>), requestId },
      sourceDeliveries: [...(Array.isArray(payload.sourceDeliveries) ? payload.sourceDeliveries : []),
        { ...continuation, data: rows as Json[] }] });
    return briefContract(contract) ? json(boundedBrief({ ...whole as object, responseForm: { protocol, requestId,
      schema: packetAnswerSchema(kind, packetWorkContract(prior.value as QuestionPacketRecord), protocol) } }, basis!, capacity.maxRequestChars)) : whole;
  };
  let packet = build(evidence.data as unknown as Json[]);
  let fingerprint = bounded(packet, capacity.maxRequestChars);
  // OBL1 (№3773): what the reads brought never blocks the continuation that carries them — the largest delivered results
  // are shown as their length and shape until it fits; the deliveries keep their whole data. A continuation of before
  // keeps its own era, and so does a chain of the packet contracts before the brief.
  const readsFit = briefContract(contract) && (saved ? saved.readsFit === true : true);
  let novel = evidence.novel;
  if (!fingerprint && readsFit && novel) {
    const rows = [...evidence.data] as unknown as Record<string, Json>[];
    const order = rows.map((row, index) => [index, canonical(row.data ?? null).length] as const).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [index] of order) {
      rows[index] = { ...rows[index]!, data: tooLargeRead(rows[index]!.data, rows[index]!.read as { action: string }, capacity.maxRequestChars) };
      packet = build(rows); fingerprint = bounded(packet, capacity.maxRequestChars);
      if (fingerprint) break;
    }
    // №3780: what is new is judged by what the reader is shown — the same shape again is no progress, a narrower read is.
    if (fingerprint) novel = addsKnowledge(store, prior.value as QuestionPacketRecord, rows as unknown as Json[]);
  }
  const fullChars = packetPrompt(packet).length;
  if (basis && novel && fingerprint && briefReadings(payload) !== null) {
    const step = chainStepReadings(store, request, prior, saved, current, packet, capacity.maxRequestChars);
    packet = step.packet; fingerprint = bounded(packet, capacity.maxRequestChars); guards.push(...step.guards);
  }
  const { readsFit: _priorFit, ...priorValue } = stepEra(copy(prior.value) as QuestionPacketRecord, contract, saved);
  const value: QuestionPacketRecord = { ...priorValue, ...(readsFit ? { readsFit: true as const } : {}), request, packetContract: contract,
    ...(basis ? { briefCatalogue: basis.material.references } : {}),
    state: novel && fingerprint ? 'ready' : 'blocked', packet: novel && fingerprint ? packet : null,
    fingerprint: novel ? fingerprint : null, fullChars,
    refusal: !novel ? { code: 'research_no_progress', message: 'The addressed reads add no information to this attempt',
      at: { unit: 'E2', target: request.batch!, field: 'continuation', ref: continuation.response }, route: 'producer' }
      : fingerprint ? null : blocked(payload.task === 'node-expansion' ? 'node_unexpandable' : 'packet_too_large', request.batch!) };
  return { value, guards: unique(guards), references: unique([...priorDerived.references, continuation.packet,
    ...capacity.references, ...evidence.references]), writes: priorDerived.writes, ...(basis ? { briefBasis: basis } : {}) };
}
/**
 * MP2 (№2968 §3): the one correction of a brief chain — the same material, labels, assignment, neighbours, earlier parts and
 * delivered reads as the rejected step, plus its exact proved refusal and its verbatim answer, under a new request and
 * response form. The ground is proved again by the common derivation; a caller cannot hand one in.
 */
function deriveCorrection(store: Store, request: QuestionPacketRequest, current: boolean,
  contract: NonNullable<QuestionPacketRecord['packetContract']>, protocol: QuestionPacketRecord['answerProtocol'], saved?: QuestionPacketRecord) {
  const correction = request.correction!;
  const prior = loadPacket(store, request.project, correction.packet);
  const { continuation: _priorContinuation, correction: _priorCorrection, ...priorRoot } = prior.value.request;
  const { correction: _correction, ...root } = request;
  if (prior.value.packetContract !== contract || prior.value.answerProtocol !== protocol || prior.value.state !== 'ready' || !object(prior.value.packet)
    || !same(root, priorRoot))
    fail('packet_chain_invalid', correction.packet.id, 'correction',
      'A correction preserves the exact ready assignment, sources and attempt of the rejected step');
  const priorDerived = derivePacket(store, prior.value.request, current, prior.value.answerProtocol, prior.value.packetContract, prior.value as QuestionPacketRecord);
  const basis = priorDerived.briefBasis;
  if (!basis) fail('packet_record_invalid', prior.id, 'brief', 'A correction needs the rederived prior assignment');
  const ground = take(readCorrectionGround(store, request.project, correction));
  if (!ground.eligible)
    fail('packet_chain_invalid', correction.response.id, 'correction', 'Only a proved correctable refusal of this chain, once, grants its correction');
  const capacity = take(readCapacity(store, { project: request.project, environment: request.environment, current }));
  const guards = [...priorDerived.guards, ...capacity.guards];
  if (current) {
    for (const ref of [correction.packet, correction.response, correction.diagnostic]) { head(store, ref); guards.push(ref); }
    // Admission is revision one; an already settled call legitimately has a later current head.
    guards.push(reference(store.get(correction.call.id)!));
  }
  const requestId = packetKey(request, protocol, contract);
  const payload = prior.value.packet as Record<string, Json>;
  const refusal = ground.refusal;
  const kind = payload.task === 'node-expansion' ? 'node' : payload.model === 'MC1' ? 'fact' : 'field';
  let packet = json(boundedBrief({ ...payload, requestId,
    correction: { refusals: [{ code: refusal.code, field: refusal.at.field ?? null, message: refusal.message, rule: briefRepairRule(refusal.code) }],
      answer: ground.raw },
    responseForm: { protocol, requestId, schema: packetAnswerSchema(kind, packetWorkContract(prior.value as QuestionPacketRecord), protocol) } },
  { ...basis, worksBindings: stepShowsBindings(prior.value as QuestionPacketRecord, contract, saved), priorLabels: (payload.brief as unknown as { labels: BriefLabel[] }).labels }, capacity.maxRequestChars));
  let fingerprint = bounded(packet, capacity.maxRequestChars);
  const fullChars = packetPrompt(packet).length;
  if (fingerprint && briefReadings(payload) !== null) {
    const step = chainStepReadings(store, request, prior, saved, current, packet, capacity.maxRequestChars);
    packet = step.packet; fingerprint = bounded(packet, capacity.maxRequestChars); guards.push(...step.guards);
  }
  const value: QuestionPacketRecord = { ...stepEra(copy(prior.value) as QuestionPacketRecord, contract, saved), request, packetContract: contract,
    briefCatalogue: basis.material.references, state: fingerprint ? 'ready' : 'blocked', packet: fingerprint ? packet : null,
    fingerprint, fullChars,
    refusal: fingerprint ? null : blocked(payload.task === 'node-expansion' ? 'node_unexpandable' : 'packet_too_large', request.batch!) };
  return { value, guards: unique(guards), references: unique([...priorDerived.references, correction.packet, correction.call, correction.response,
    correction.diagnostic, ...capacity.references, ...ground.references]), writes: priorDerived.writes, briefBasis: basis };
}
/** AT1: the saved impact form — its contract, exact snapshot and test map; anything else refuses. */
function impactOf(value: unknown, target: string): BriefImpact {
  if (!briefImpactForm(value)) fail('packet_record_invalid', target, 'briefImpact', 'A works chain keeps its exact repository snapshot and test map');
  return copy(value) as BriefImpact;
}
/** The one resolution of a new works root: HEAD once, the tree of that commit, the test map of that exact tree. */
function issuedImpact(workspace: string): BriefImpact {
  const snapshot = resolveSnapshot(workspace);
  return { contract: IMPACT_BRIEF_CONTRACT, snapshot, parser: IMPACT_PARSER, boundary: [...IMPACT_BOUNDARY], ...deriveTestMap(readSnapshot(workspace, snapshot)) };
}
/** MP2 (№2968 §1): the explicit saved neighbour form — its known contract and exact finished sources; anything else refuses. */
function neighbourForm(value: unknown, target: string): { contract: typeof NEIGHBOR_CONTRACT; sources: NeighbourSource[] } {
  if (!object(value) || value.contract !== NEIGHBOR_CONTRACT || !Array.isArray(value.sources)
    || Object.keys(value).some(key => !['contract', 'sources'].includes(key))
    || value.sources.some(row => !object(row) || !isRef(row.root) || !text(row.batch) || !text(row.node) || !isRef(row.assembly)
      || !isRef(row.proposal) || Object.hasOwn(row, 'reuse') && !isRef(row.reuse)
      || Object.keys(row).some(key => !['root', 'batch', 'node', 'assembly', 'proposal', 'reuse'].includes(key)))
    || new Set(value.sources.map(row => canonical(row))).size !== value.sources.length)
    fail('packet_record_invalid', target, 'briefNeighbors', 'The neighbour form names its known contract and exact finished sources');
  return value as unknown as { contract: typeof NEIGHBOR_CONTRACT; sources: NeighbourSource[] };
}
function contentContract(store: Store, request: QuestionPacketRequest, contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord) {
  const target = packetId(request, saved ? saved.answerProtocol : PACKET_ANSWER_PROTOCOL, contract);
  const declared = saved && Object.hasOwn(saved, 'briefContract');
  if (declared && (![BRIEF_CONTENT_CONTRACT, BRIEF_REOPEN_CONTRACT].includes(saved.briefContract!) || !briefContract(contract)))
    fail('packet_record_invalid', target, 'briefContract', 'Only a brief packet can declare the supported content version');
  if (!briefContract(contract)) return undefined;
  const predecessors = [...(request.continuation ? [request.continuation.packet] : []),
    ...(request.correction ? [request.correction.packet] : []), ...request.previous.map(part => part.packet)]
    .map(ref => loadPacket(store, request.project, ref));
  const inherited = predecessors[0]?.value.briefContract;
  if (predecessors.some(prior => prior.value.briefContract !== inherited))
    fail('packet_chain_invalid', target, 'briefContract', 'All preceding steps preserve the brief content version of their root');
  // RB1 (№4285): a new works root over a reopened frame shows the reopened works whole (om-brief/v3); every other new root,
  // and every saved packet and chain step, keeps the version it was issued with.
  const chosen = saved ? saved.briefContract : predecessors.length ? inherited
    : contract === WORKS_BRIEF_PACKET_CONTRACT && reopenedRoot(store, request) ? BRIEF_REOPEN_CONTRACT : BRIEF_CONTENT_CONTRACT;
  if (saved && predecessors.length && chosen !== inherited)
    fail('packet_chain_invalid', target, 'briefContract', 'A saved descendant preserves its proved root content version');
  // RB1: om-brief/v3 is issued only to a works root over a reopened frame; a saved root claiming it elsewhere is no record of it.
  if (saved && !predecessors.length && chosen === BRIEF_REOPEN_CONTRACT && !(contract === WORKS_BRIEF_PACKET_CONTRACT && reopenedRoot(store, request)))
    fail('packet_record_invalid', target, 'briefContract', 'Only a works root over a reopened frame declares om-brief/v3');
  if (saved?.packet !== undefined && saved.packet !== null && (!object(saved.packet) || !object(saved.packet.brief)
    || saved.packet.brief.contract !== (chosen ?? 'om-brief/v1')))
    fail('packet_record_invalid', target, 'briefContract', 'The saved marker and inner brief content version must agree');
  return chosen;
}
/**
 * SP1 (№4714 §2.1): the selection era is the saved declaration of the chain root — never the content of a stage, today's
 * configuration or what an assembled text shows. A new brief root declares it; every preceding step of a chain agrees.
 */
function selectionContract(store: Store, request: QuestionPacketRequest, contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord) {
  const target = packetId(request, saved ? saved.answerProtocol : PACKET_ANSWER_PROTOCOL, contract);
  if (saved && Object.hasOwn(saved, 'briefSelection') && (saved.briefSelection !== BRIEF_SELECTION_CONTRACT || !briefContract(contract)))
    fail('packet_record_invalid', target, 'briefSelection', 'Only a brief packet can declare the supported selection version');
  if (!briefContract(contract)) return undefined;
  const predecessors = [...(request.continuation ? [request.continuation.packet] : []),
    ...(request.correction ? [request.correction.packet] : []), ...request.previous.map(part => part.packet)]
    .map(ref => loadPacket(store, request.project, ref));
  const inherited = predecessors[0]?.value.briefSelection;
  if (predecessors.some(prior => prior.value.briefSelection !== inherited))
    fail('packet_chain_invalid', target, 'briefSelection', 'All preceding steps preserve the selection version of their root');
  const chosen = saved ? saved.briefSelection : predecessors.length ? inherited : BRIEF_SELECTION_CONTRACT;
  if (saved && predecessors.length && chosen !== inherited)
    fail('packet_chain_invalid', target, 'briefSelection', 'A saved descendant preserves its proved root selection version');
  return chosen;
}
/** OBL1: a continuation or correction takes its predecessor's record, but the bindings era of its own step. */
function stepEra(prior: QuestionPacketRecord, contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord): QuestionPacketRecord {
  const { worksBindings: _prior, ...rest } = prior;
  return stepShowsBindings(prior, contract, saved) ? { ...rest, worksBindings: true } : rest;
}
/** OBL1: a step of the bindings era shows bindings where its works assign D7 obligations. */
function stepShowsBindings(prior: QuestionPacketRecord, contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord): boolean {
  return worksBindingsEra(contract, saved) && showsBindings(object(prior.packet) ? (prior.packet as Record<string, unknown>).works : null);
}
function showsBindings(works: unknown): boolean {
  return object(works) && Array.isArray(works.obligations) && Array.isArray(works.assigned)
    && (works.obligations as Parameters<typeof taskBindingId>[0][]).some(row => (works.assigned as string[]).includes(taskBindingId(row)));
}
/** G5: the saved step keeps its own era; a root or part issued now is of the wake-test era (works brief packets only). */
function wakeTestsEra(contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord): boolean {
  if (saved && Object.hasOwn(saved, 'wakeTests') && (saved.wakeTests !== true || contract !== WORKS_BRIEF_PACKET_CONTRACT))
    fail('packet_record_invalid', saved.request.routes.id, 'wakeTests', 'Only a works brief packet declares the wake-test era');
  return contract === WORKS_BRIEF_PACKET_CONTRACT && (saved ? saved.wakeTests === true : true);
}
/** G6: the saved step keeps its own era; a step issued now is of the transition era (works brief packets only). */
function transitionEraOf(contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord): boolean {
  if (saved && Object.hasOwn(saved, 'transitionEra') && (saved.transitionEra !== true || contract !== WORKS_BRIEF_PACKET_CONTRACT))
    fail('packet_record_invalid', saved.request.routes.id, 'transitionEra', 'Only a works brief packet declares the transition era');
  return contract === WORKS_BRIEF_PACKET_CONTRACT && (saved ? saved.transitionEra === true : true);
}
/** G5: the era is marked only where it changes the form — an assignment holding a producer end of a connection. */
const holdsProducerEnd = (assigned: readonly FrameObligation[]): boolean =>
  assigned.some(item => item.kind === 'connection-end' && item.role === 'producer');
/** OBL1: the saved step keeps its own era; a step issued now is of the bindings era (works brief packets only). */
function worksBindingsEra(contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord): boolean {
  if (saved && Object.hasOwn(saved, 'worksBindings') && (saved.worksBindings !== true || contract !== WORKS_BRIEF_PACKET_CONTRACT))
    fail('packet_record_invalid', saved.request.routes.id, 'worksBindings', 'Only a works brief packet declares the bindings era');
  return contract === WORKS_BRIEF_PACKET_CONTRACT && (saved ? saved.worksBindings === true : true);
}
type DerivedPacket = { value: QuestionPacketRecord; guards: TransactionGuard[]; references: Ref[]; writes: Write[]; briefBasis?: BriefBasis };
/**
 * PF5 (№4235): a step of a continuation or correction chain derives the step it follows, and so does the E3 recheck of the
 * need_source behind it (readContinuationEvidence → prepareAnswerForm → prepareQuestionPacket) — two paths to the same link,
 * each again for its own predecessor: 2^depth. While the outermost derivation runs (a preparation is synchronous and writes
 * nothing), a derivation of the same exact request, mode, saved record and chain-step state on the same Store view is the
 * same result and is derived once; the memo ends with that outermost call and never crosses preparations. A refusal is not
 * kept: it ends the preparation it is met in.
 */
let derivations = 0, memo: Map<string, DerivedPacket> | null = null, views = 0;
const viewIds = new WeakMap<Store, number>();
const viewId = (store: Store): number => viewIds.get(store) ?? (viewIds.set(store, ++views), views);
/** PF5: how many packet derivations have run in this process — the measure of one preparation in the tests. */
export function packetDerivations(): number { return derivations; }
function derivePacket(store: Store, request: QuestionPacketRequest, current: boolean,
  protocol: QuestionPacketRecord['answerProtocol'], contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord): DerivedPacket {
  const outer = memo === null;
  if (outer) memo = new Map();
  try {
    const key = canonical([viewId(store), request, current, protocol ?? null, contract ?? null, saved === undefined ? null : hashJson(saved as unknown as Json),
      chainSteps > 0] as unknown as Json);
    const known = memo!.get(key);
    if (known) return known;
    derivations++;
    const derived = derivePacketOnce(store, request, current, protocol, contract, saved);
    memo!.set(key, derived);
    return derived;
  } finally { if (outer) memo = null; }
}
function derivePacketOnce(store: Store, request: QuestionPacketRequest, current: boolean,
  protocol: QuestionPacketRecord['answerProtocol'], contract: QuestionPacketRecord['packetContract'], saved?: QuestionPacketRecord): DerivedPacket {
  const briefVersion = contentContract(store, request, contract, saved);
  const selection = selectionContract(store, request, contract, saved);
  if (request.continuation) {
    if (!currentContract(contract))
      fail('packet_record_invalid', request.continuation.packet.id, 'packetContract', 'A historical packet cannot acquire continuation semantics');
    return deriveContinuation(store, request, current, contract!, protocol, saved);
  }
  if (request.correction) {
    if (!briefContract(contract))
      fail('packet_record_invalid', request.correction.packet.id, 'packetContract', 'Only a brief chain can acquire a correction');
    return inChainStep(() => deriveCorrection(store, request, current, contract!, protocol, saved));
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
  if (worksPacketContract(contract) && (batch?.task !== 'node-expansion' || batch.level !== 3))
    fail('packet_record_invalid', request.routes.id, 'packetContract', 'The work answer era belongs only to an L3 node assignment');
  if (!worksPacketContract(contract) && Object.hasOwn(request, 'works'))
    fail('packet_task_set_invalid', request.routes.id, 'works', 'A D7 handoff is accepted only by the declared work-packet era');
  const bindingsEra = worksBindingsEra(contract, saved), wakeEra = wakeTestsEra(contract, saved), transitionStep = transitionEraOf(contract, saved);
  const base: QuestionPacketRecord = { project: request.project, request, ...(protocol ? { answerProtocol: protocol } : {}),
    ...(contract ? { packetContract: contract } : {}), ...(briefVersion ? { briefContract: briefVersion } : {}),
    ...(selection ? { briefSelection: selection } : {}),
    ...(bindingsEra ? { worksBindings: true as const } : {}), ...(wakeEra ? { wakeTests: true as const } : {}),
    ...(transitionStep ? { transitionEra: true as const } : {}), state: 'empty', packet: null, fingerprint: null,
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
  const common = { version: contract === WORKS_BRIEF_PACKET_CONTRACT ? WORKS_BRIEF_VERSION
    : contract === BRIEF_PACKET_CONTRACT ? BRIEF_VERSION : contract === WORKS_PACKET_CONTRACT ? 'om-question-packet/works-v1'
    : contract ? 'om-question-packet/v3' : protocol ? 'om-question-packet/v2' : 'om-question-packet/v1', requestId, model: batch.model,
    purpose: batch.model === 'MC1' ? 'model-research' : 'model-design', task: batch.task, kind: batch.kind, questions,
    responseForm: protocol ? { protocol, requestId, schema: packetAnswerSchema(batch.task === 'node-expansion' ? 'node' : batch.model === 'MC1' ? 'fact' : 'field',
      packetWorkContract(base), protocol) }
      : batch.task === 'node-expansion'
      ? { protocol: 'omg-part/v1', requestId, proposal: PART_PROPOSAL_SCHEMA }
      : batch.model === 'MC1'
        ? { results: 'One result per question id', value: 'The question contract resultForm', citations: 'Exact source reference and text-range or JSON-pointer selector' }
        : { results: 'One result per target and field', fields: ['target', 'field', 'value', 'basis'],
          value: 'Only the missing field: address = consumer and kind; nodes = block ids; state = nodes and actors; checkKind = check kind' },
    refusals: retry.refusals, rules: batch.model === 'MC1'
      ? ['answer_route_foreign', 'answer_question_invalid', 'answer_inapplicable', 'evidence_missing']
      : ['slot_fill_foreign', 'slot_fill_conflict', 'proposal_node_reserved', 'frame_upper_drift'] };
  let briefBasis: BriefBasis | null = null, briefWorkspace: string | undefined;
  if (briefContract(contract)) {
    if (saved && !Array.isArray(saved.briefCatalogue)) fail('packet_record_invalid', requestId, 'briefCatalogue', 'The text era retains its observed catalogue even when blocked');
    const environment = take(readRecord<{ workspace: string }>(store, request.environment,
      { unit: 'E2', target: requestId, id: `environment:${request.project}`, kind: 'environment' }));
    briefWorkspace = environment.value.workspace;
    const priorBrief = request.previous.length ? loadPacket(store, request.project, request.previous.at(-1)!.packet) : null;
    const material = briefMaterial(store, request.project, environment.value.workspace, current, saved?.briefCatalogue ?? priorBrief?.value.briefCatalogue);
    base.briefCatalogue = material.references;
    references.push(...material.references); guards.push(...material.guards);
    const input = take(readOmInput(store, request.project, gaps.sources.input));
    const graph = take(readRecord<Graph>(store, gaps.sources.graph,
      { unit: 'E2', target: requestId, id: `graph:${request.project}`, kind: 'graph' }));
    briefBasis = { ...(briefVersion ? { briefContract: briefVersion } : {}), ...(selection ? { selection } : {}), worksBindings: bindingsEra, wakeTests: wakeEra, project: request.project, node: batch.node ?? null, graph: graph.value as Graph,
      gaps: batch.items.map(item => ({ question: item.gap, target: item.target, field: item.field, ref: item.record,
        evidence: json(gaps.records.find(row => same(reference(row), item.record))!.value.gap.evidence) })),
      contexts: unique([gaps.sources.input, gaps.sources.graph, ...input.value.input.sources.map(({ id, revision, hash }) => ({ id, revision, hash }))]),
      input: json(input.value.input), accepted: input.value.input.sources.map(source => {
        const row = take(readRecord<{ content: { fields: Record<string, Json> } }>(store, source,
          { unit: 'E2', target: requestId, id: source.id, kind: 'stage' }));
        return { stage: source.stage, ref: { id: source.id, revision: source.revision, hash: source.hash }, fields: json(row.value.content.fields) as Record<string, Json> };
      // RB1 (№4293 п.3): a brief over reopened works may fill the whole request; the selection rules, not a budget, bound it.
      }), material, materialBudget: briefVersion === BRIEF_REOPEN_CONTRACT ? capacity.maxRequestChars : Math.min(45000, Math.floor(capacity.maxRequestChars / 4)),
      codes: [...[...QUESTION_PACKET_CODES, ...ANSWER_FORM_CODES].map(code => ({ code, phase: 'answer' as const })),
        ...[...FRAME_REFUSAL_CODES, ...PROPOSAL_REFUSAL_CODES, ...CANDIDATE_REFUSAL_CODES].map(code => ({ code, phase: 'assembly' as const }))] };
    references.push(...briefBasis.contexts);
    if (current) for (const ref of briefBasis.contexts) { head(store, ref); guards.push(ref); }
    if (priorBrief) {
      briefBasis.priorLabels = (priorBrief.value.packet as unknown as { brief: { labels: BriefLabel[] } }).brief.labels;
    }
    // MP2 (№2968 §2, row 19): the saved form decides — a packet MP1 issued keeps no section, a later part keeps its root's
    // form and set, and only a new root chooses its neighbours, once. Only node expansions have neighbours of a frame.
    const form = saved ? (Object.hasOwn(saved, 'briefNeighbors') ? neighbourForm(saved.briefNeighbors, requestId) : undefined)
      : priorBrief ? (Object.hasOwn(priorBrief.value, 'briefNeighbors') ? neighbourForm(priorBrief.value.briefNeighbors, requestId) : undefined)
      : null;
    if (form !== undefined) {
      if (batch.task !== 'node-expansion' && form?.sources.length)
        fail('packet_record_invalid', requestId, 'briefNeighbors', 'Only a node expansion has neighbours of its frame');
      const read = batch.task === 'node-expansion' ? take(readNeighbourResults(store, { project: request.project, attempt: request.attempt,
        routes: request.routes, batch: batch.id, saved: form ? form.sources : null, current })) : { sources: [], works: [], guards: [], references: [] };
      base.briefNeighbors = { contract: NEIGHBOR_CONTRACT, sources: read.sources as NeighbourSource[] };
      // The text names the work, not its private references: those stay in the saved form.
      briefBasis.neighbors = { contract: NEIGHBOR_CONTRACT, works: json(read.works.map(work => ({ node: work.node, nodes: work.nodes, writes: work.writes }))) as Json[] };
      references.push(...read.references); guards.push(...read.guards);
    }
    // AT1 (№4091 п.5): the saved form decides, as for the neighbours — a new works root resolves HEAD once and saves the
    // tree with its test map; a part keeps its root's; a replay reads what was saved, never the repository again.
    if (contract === WORKS_BRIEF_PACKET_CONTRACT) {
      const impact = saved ? (Object.hasOwn(saved, 'briefImpact') ? impactOf(saved.briefImpact, requestId) : undefined)
        : priorBrief ? (Object.hasOwn(priorBrief.value, 'briefImpact') ? impactOf(priorBrief.value.briefImpact, requestId) : undefined)
        : null;
      // A workspace that is no repository gives no section: G5 then records no snapshot, and M8 refuses such an acceptance.
      const value = impact === null ? (isRepository(environment.value.workspace) ? issuedImpact(environment.value.workspace) : undefined) : impact;
      if (value !== undefined) {
        base.briefImpact = value; briefBasis.impact = value;
        briefBasis.codes = [...briefBasis.codes, ...[...IMPACT_SEMANTIC_CODES, ...IMPACT_GATE_CODES].map(code => ({ code, phase: 'assembly' as const }))];
      }
    }
  }
  const encode = (value: unknown): Json => {
    if (!briefBasis) return json(value);
    return json(boundedBrief(value as Record<string, unknown>, briefBasis, capacity.maxRequestChars));
  };
  let packet = json(common);
  if (batch.task === 'node-expansion') {
    const source = batch.level === 2 ? gaps.sources.operations : gaps.sources.works;
    if ('state' in source || !batch.node || source.frame.level !== batch.level)
      fail('packet_batch_invalid', batch.id, 'frame', 'A node expansion needs the producer frame for its level');
    const frame = take(readFrameProposals(store, source)) as FrameProposals;
    references.push(...frame.references);
    if (briefBasis) { briefBasis.graph = frame.frame.upper; briefBasis.contexts = unique([...briefBasis.contexts, frame.frame.upperRef]); }
    // The same work is never given twice: what the accepted graph of the frame already holds stays MP1's material.
    if (briefBasis?.neighbors) {
      const accepted = new Set((frame.frame.accepted?.graph.nodes ?? []).map(node => node.id));
      briefBasis.neighbors = { ...briefBasis.neighbors, works: briefBasis.neighbors.works.map(work => json({ ...(work as Record<string, Json>),
        nodes: ((work as { nodes: { id: string }[] }).nodes).filter(node => !accepted.has(node.id)) })) };
    }
    if (current) guards.push(...take(prepareFrameProposals(store, source)).guards);
    const context = expansionContext(frame, batch.node), open = frame.result.open.filter(item => item.upper.node === batch.node);
    const reopened = briefVersion === BRIEF_REOPEN_CONTRACT ? reopenedContext(store, frame, batch.node, references, briefBasis!.input) : [];
    if (reopened.length) {
      // RB1 (№4291 п.1): their material is read from the exact snapshot of this chain — the one G5 judges the answer by.
      if (!briefBasis!.impact || briefWorkspace === undefined)
        fail('packet_brief_invalid', batch.node, 'reopened', 'A reopened work is shown with the files of the exact repository snapshot of its chain');
      // №4293 п.3: and anything else of the accepted graph is reachable by its index, under a label of this packet.
      const accepted = frame.frame.accepted!;
      briefBasis!.contexts = unique([...briefBasis!.contexts, accepted.reference]); references.push(accepted.reference);
      if (current) { head(store, accepted.reference); guards.push(accepted.reference); }
      Object.assign(context, { reopened, reopenedFiles: reopenedMaterial(readSnapshot(briefWorkspace, briefBasis!.impact.snapshot), reopened),
        graphIndex: graphIndex(accepted.graph, accepted.reference) });
    }
    const worksBasis = worksPacketContract(contract) ? worksTaskBasis(store, request,
      routes.record.value.request.gaps, current) : null;
    if (worksBasis) { guards.push(...worksBasis.guards); references.push(reference(worksBasis.producer), reference(worksBasis.record), ...worksBasis.inputs); }
    const works = worksBasis ? workAssignments(frame, batch.node, worksBasis) : null;
    // OBL1: the bindings era is marked only where it shows bindings; every other works packet keeps the bytes of before.
    const shows = bindingsEra && showsBindings(works);
    if (!shows) delete (base as { worksBindings?: true }).worksBindings;
    if (briefBasis) briefBasis.worksBindings = shows;
    if (!wakeEra || !holdsProducerEnd(open)) delete (base as { wakeTests?: true }).wakeTests;
    // G6: the era is marked only where the brief states it — a step that assigns obligations.
    if (!transitionStep || !open.length) delete (base as { transitionEra?: true }).transitionEra;
    if (briefBasis) briefBasis.transitionEra = transitionStep && open.length > 0;
    if (!open.length) return { value: base, guards: unique(guards), references: unique(references), writes: routeWrites };
    const allIds = open.map(item => item.id).sort(order);
    const whole = { ...context, assigned: allIds, connections: connectionContext(frame.frame.upper, open) };
    packet = encode({ ...common, expansion: whole, ...(works ? { works } : {}) });
    base.fullChars = packetPrompt(packet).length;
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
      if (wakeEra && holdsProducerEnd(assigned)) base.wakeTests = true; else delete (base as { wakeTests?: true }).wakeTests;
      // E2.2 (№1801, row 4): a part carries the causes of the questions it actually sends, never of the whole node.
      const sent = questions.filter(item => assignment.obligations.includes(item.target));
      packet = encode({ ...common, questions: sent,
        refusals: retry.refusals.filter(item => sent.some(question => question.target === item.target && question.field === item.field)),
        expansion: { ...context, assigned: assignment.obligations,
        connections: connectionContext(frame.frame.upper, assigned) },
        ...(works ? { works: { ...works, assigned: request.previous.length === assignments.length - 1 ? works.nodeAssignments : [] } } : {}) });
    } else if (request.previous.length) {
      fail('packet_chain_invalid', batch.id, 'previous', 'A packet that fits whole has no parts');
    }
  } else {
    packet = encode(common);
    if (request.previous.length) fail('packet_chain_invalid', batch.id, 'previous', 'Only a node expansion can have preceding parts');
    base.fullChars = packetPrompt(packet).length;
  }
  let fingerprint = bounded(packet, capacity.maxRequestChars);
  if (!fingerprint) {
    base.state = 'blocked'; base.refusal = blocked(batch.task === 'node-expansion' ? 'node_unexpandable' : 'packet_too_large', batch.node ?? batch.id);
    // RB1 (№4291 п.1): reopened works come with all their material or not at all — when it does not fit, the refusal names
    // the works to split by their results, never a brief with part of it.
    const reopenedWorks = object(packet) && object(packet.expansion) && Array.isArray(packet.expansion.reopened)
      ? (packet.expansion.reopened as { work: string }[]).map(row => row.work) : [];
    if (reopenedWorks.length) base.refusal = { ...base.refusal, at: { unit: 'E2', target: reopenedWorks.length === 1 ? reopenedWorks[0]! : batch.node!, field: 'reopened' },
      message: `Reopened ${reopenedWorks.join(', ')} with the whole material of their duties (${packetPrompt(packet).length} chars) exceed the capacity of one request (${capacity.maxRequestChars}): split the work by its results`,
      };
    return { value: base, guards: unique(guards), references: unique(references), writes: routeWrites };
  }
  // MP3: optional carried reads in the capacity left by the fitting packet; they never block or split it.
  if (briefBasis && chainReadings(store, request, saved)) {
    const savedReadings = saved ? briefReadings(saved.packet) : null;
    if (saved && !savedReadings) fail('packet_record_invalid', requestId, 'readings', 'A packet of the readings era keeps its readings');
    packet = json(withReadings(packet as Record<string, any>, carriedReadings(store, request, batch, current, savedReadings), capacity.maxRequestChars));
    fingerprint = bounded(packet, capacity.maxRequestChars)!;
    if (current) guards.push(...includedSources(packet));
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
  return { value: base, guards: unique(guards), references: unique(references), writes, ...(briefBasis ? { briefBasis } : {}) };
}
/** NR1 (№3600): a trusted read. The packet was derived by prepareQuestionPacket from its exact sources and written once
 * (with its completed no-progress attempt, when it has one); it is read at its exact reference, never derived again. */
function loadPacket(store: Store, project: string, ref: Ref): Revision<QuestionPacketRecord> {
  return historicalRead(store, { reader: 'E2.question-packet', project, ref }, () =>
    take(readRecord<QuestionPacketRecord>(store, ref, { unit: 'E2', target: ref.id,
      idPrefix: packetNamespace(project), kind: QUESTION_PACKET_KIND })) as Revision<QuestionPacketRecord>,
  () => fail('packet_chain_invalid', ref.id, 'previous', 'The packet history contains a cycle'));
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
/**
 * OBL1 (№3780): whether the saved continuation of this exact source request ended as no progress by what it shows — a
 * continuation of the fitting era judges novelty by the results it shows, not by the whole deliveries behind them.
 */
export function shownNoProgress(store: Store, request: QuestionPacketRequest): OmResult<boolean> {
  requirePacket(store, request); request = copy(request);
  return result(() => {
    const saved = packetEra(store, request).checked;
    return !!saved && saved.value.readsFit === true && saved.value.refusal?.code === 'research_no_progress';
  }) as OmResult<boolean>;
}
export function prepareQuestionPacket(store: Store, request: QuestionPacketRequest): OmResult<Sealed<PreparedQuestionPacket>> {
  requirePacket(store, request); request = copy(request);
  return result(() => {
    const era = packetEra(store, request), { contract, protocol, checked } = era;
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
        const value = derivePacket(store, request, false, protocol, contract).value;
        return { id: packetId(request, protocol, contract), kind: QUESTION_PACKET_KIND,
          revision: 1, hash: hashJson(value), value };
      })();
      const proof = pendingCallStore(store, checked ? [] : [{ id: historical.id, kind: historical.kind, expected: 0, value: historical.value }]);
      environment = take(prepareManagedEnvironment(proof, request.project, { packet: reference(historical) }));
    }
    const admittedStore = environment?.store ?? store;
    const derived = derivePacket(admittedStore, request, true, protocol, contract, checked?.value);
    if (checked && !same(checked.value, derived.value))
      fail('packet_record_invalid', checked.id, 'value', 'An existing packet cannot change without a new source request');
    const record: Revision<QuestionPacketRecord> = checked ?? { id: packetId(request, protocol, contract), kind: QUESTION_PACKET_KIND,
      revision: 1, hash: hashJson(derived.value), value: derived.value };
    // OBL1 (№3784): the finish of a no-progress continuation judges what that continuation shows, so it sees the prepared
    // packet; both are written in the one transaction below.
    const finished = continuationFinish(checked ? store
      : pendingCallStore(store, [{ id: record.id, kind: record.kind, expected: 0, value: record.value }]), record.value);
    const writes: Write[] = [...derived.writes, ...(finished?.writes ?? []),
      ...(checked ? [] : [{ id: record.id, kind: record.kind, expected: 0, value: record.value }])];
    const completion = checked ? { writes: [], guards: [] } : take(prepareCompletionPacket(pendingCallStore(admittedStore, writes), reference(record)));
    writes.push(...completion.writes);
    const pending = new Set(writes.map(write => canonical({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) })));
    return { record, existing: Boolean(checked), references: derived.references,
      // H1.0d (№1715): the finish may rely on an absence (an admitted call without its E4); it stays a condition of
      // this write. Only exact references of records written here are dropped.
      guards: unique((environment ? environment.remap : (guards: readonly TransactionGuard[]) => guards)([...era.guards, ...derived.guards, ...(finished?.guards ?? []), ...completion.guards,
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
    const record = managed || request.continuation || request.correction || request.previous.length > 0 ? packetEra(store, request).checked : undefined;
    if (record) {
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
// AT1 (№4091 п.4, п.7): the node of a part answer keeps its form of before; only a works packet of the impact era admits a
// work's impact decisions and required connections — its brief shows them, its protocol check admits them.
const IMPACT_NODE_FIELDS = ['impact', 'integrations'] as const;
const stableNode = (() => { const node = structuredClone(graphV2Schema.properties.nodes.items);
  for (const field of IMPACT_NODE_FIELDS) delete node.properties[field]; return node; })();
export const PART_PROPOSAL_SCHEMA = sealed({ type: 'object', additionalProperties: false, required: [...bodySections],
  properties: Object.fromEntries(bodySections.map(section => {
    const field = section === 'localConnectors' ? 'connectors' : section;
    const native = section === 'nodes' ? stableNode : (graphV2Schema.properties as Record<string, { items?: object }>)[field]?.items;
    return [section, { type: 'array', items: native ?? (section === 'fills' ? fillShape : section === 'replaces'
      ? replacementShape : { type: 'string', minLength: 1 }) }];
  })) });
// The work answer extends the declared end of a connection with the native CodeRef.
// Keep the preceding form intact: a historical packet never acquires these fields.
export const WORKS_PART_PROPOSAL_SCHEMA = sealed({ ...PART_PROPOSAL_SCHEMA, properties: {
  ...PART_PROPOSAL_SCHEMA.properties, fills: { type: 'array', items: { ...fillShape,
    properties: { ...fillShape.properties, codeRef: graphV2Schema.properties.nodes.items.properties.code.items } } },
} });
// G5 (№3820, №3822): the body check admits the wake test a works answer of the wake-test era names (its packet form asks
// for it, E2 checks it); the form an older packet carries keeps its own schema and never acquires the field.
// It is built on first use: frame-proposals, which owns the rule, is part of this module's import cycle.
const worksFill = WORKS_PART_PROPOSAL_SCHEMA.properties.fills.items;
const worksBodySchema = (wake = true, impact = true) => ({ ...WORKS_PART_PROPOSAL_SCHEMA, properties: { ...WORKS_PART_PROPOSAL_SCHEMA.properties,
  ...(wake ? { fills: { type: 'array', items: { ...worksFill, properties: { ...worksFill.properties, [WAKE_TEST.field]: { type: 'string', minLength: 1 } } } } } : {}),
  ...(impact ? { nodes: { type: 'array', items: structuredClone(graphV2Schema.properties.nodes.items) } } : {}) } });
let worksBody: ReturnType<Ajv['compile']> | undefined;
const validateWorksPartBody = (value: unknown) => (worksBody ??= new Ajv({ strict: true, allowUnionTypes: true }).compile(worksBodySchema()))(value);
const validatePartBody = new Ajv({ strict: true, allowUnionTypes: true }).compile(PART_PROPOSAL_SCHEMA);
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
    const valid = worksContract === WORKS_FRAME_CONTRACT ? validateWorksPartBody(value) : validatePartBody(value);
    const errors = worksContract === WORKS_FRAME_CONTRACT ? worksBody?.errors : validatePartBody.errors;
    if (!valid)
      fail('part_answer_invalid', 'part-answer', errors?.[0]?.instancePath || 'proposal',
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
// Segment alternatives encode safeRelativePath and the case-insensitive .git exclusion without lookahead.
const forbiddenPathCharacters = '\\\\/*?\\u0000-\\u001f';
const pathCharacter = `[^${forbiddenPathCharacters}]`;
const exceptPath = (characters: string) => `[^${characters}${forbiddenPathCharacters}]`;
const dottedPath = `\\.(?:${exceptPath('.gG')}${pathCharacter}*|\\.${pathCharacter}+|[gG](?:${exceptPath('iI')}${pathCharacter}*|[iI](?:${exceptPath('tT')}${pathCharacter}*|[tT]${pathCharacter}+)?)?)`;
const pathSegment = `(?:${exceptPath('.')}${pathCharacter}*|${dottedPath})`;
const firstPathSegment = `(?:(?:${exceptPath('.A-Za-z')}${pathCharacter}*|[A-Za-z](?:${exceptPath(':')}${pathCharacter}*)?)|${dottedPath})`;
const readPathShape = sealed({ ...nonempty, allOf: [{ pattern: `^${firstPathSegment}(?:/${pathSegment})*$` }],
  description: 'Path relative to the selected project root, for example package.json or src/file.ts. No absolute paths, ./, .., .git segments (any case), backslashes or glob patterns. For searching the whole context use its record Ref, not ".".' });
const selectorShape = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'pointer'], properties: {
    kind: { const: 'json-pointer' }, pointer: { type: 'string' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'start', 'end'], properties: {
    kind: { const: 'text-range' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } } },
] };
const readShapes = (protocol: AnswerProtocol) => [
  { action: { const: 'read' }, path: protocol === 'omg-answer/v2' ? nonempty : readPathShape, media: { enum: ['text/plain', 'application/json'] } },
  { action: { const: 'read_source' }, source: refShape, selector: selectorShape },
  { action: { const: 'read_context' }, record: refShape, pointer: { type: 'string' } },
  { action: { const: 'search' }, within: { oneOf: [protocol === 'omg-answer/v2' ? nonempty : readPathShape, refShape] }, query: nonempty },
].map(properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }));
const factResults = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
  required: ['questionId', 'value', 'citations'], properties: { questionId: nonempty, value: {},
    citations: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['source', 'selector'], properties: { source: refShape, selector: selectorShape } } } } } };
const fieldResults = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
  required: ['target', 'field', 'value', 'basis'], properties: { target: nonempty, field: nonempty, value: {}, basis: refShape } } };
function answerSchemaFamily(protocol: AnswerProtocol) {
  function responseShape(properties: Record<string, unknown>) {
    const fields = { protocol: { const: protocol }, requestId: nonempty, ...properties };
    return { type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields };
  }
  const controls = [
    responseShape({ action: { const: 'need_source' }, questionIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonempty },
      missing: nonempty, reads: { type: 'array', minItems: 1, items: { oneOf: readShapes(protocol) } } }),
    responseShape({ action: { const: 'need_owner' }, questionIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonempty },
      reason: nonempty, decision: nonempty }),
    ...['cannot_answer', 'pause'].map(action => responseShape({ action: { const: action },
      questionIds: { type: 'array', minItems: 1, uniqueItems: true, items: nonempty }, reason: nonempty })),
  ];
  return sealed({
    node: { oneOf: [responseShape({ action: { const: 'answer' }, proposal: PART_PROPOSAL_SCHEMA }), ...controls] },
    fact: { oneOf: [responseShape({ action: { const: 'answer' }, results: factResults }), ...controls] },
    field: { oneOf: [responseShape({ action: { const: 'answer' }, results: fieldResults }), ...controls] },
    works: { oneOf: [responseShape({ action: { const: 'answer' }, proposal: WORKS_PART_PROPOSAL_SCHEMA,
      bindings: { type: 'array', items: taskObligationBindingSchema } }), ...controls] },
  });
}
const answerSchemas = { 'omg-answer/v2': answerSchemaFamily('omg-answer/v2'), 'omg-answer/v3': answerSchemaFamily('omg-answer/v3') };
/** One stable schema family per proven era for producer payloads, E3 and E4. */
export function packetAnswerSchema(kind: 'node' | 'fact' | 'field', worksContract?: typeof WORKS_FRAME_CONTRACT,
  protocol: AnswerProtocol = PACKET_ANSWER_PROTOCOL): Sealed<Json> {
  if (kind !== 'node' && kind !== 'fact' && kind !== 'field') invalid('answer.schema');
  if (!answerProtocols.includes(protocol)) invalid('answer.protocol');
  if (worksContract !== undefined && (worksContract !== WORKS_FRAME_CONTRACT || kind !== 'node')) invalid('answer.worksContract');
  return answerSchemas[protocol][worksContract ? 'works' : kind] as Sealed<Json>;
}
const answerSchemasAjv = new Ajv({ strict: true, allowUnionTypes: true });
const compileAnswers = (family: ReturnType<typeof answerSchemaFamily>) => ({
  node: answerSchemasAjv.compile(family.node), fact: answerSchemasAjv.compile(family.fact),
  field: answerSchemasAjv.compile(family.field), works: answerSchemasAjv.compile(family.works),
});
/**
 * G5: the protocol check of a works packet of the wake-test era admits the wake test its form asks for. AT1: one of the
 * impact era admits the work's impact decisions and required connections. Each era admits only its own fields.
 */
const eraWorksValidators = new Map<string, ReturnType<Ajv['compile']>>();
function eraWorksValidator(protocol: AnswerProtocol, wake: boolean, impact: boolean): ReturnType<Ajv['compile']> {
  const key = `${protocol}:${wake}:${impact}`;
  let validator = eraWorksValidators.get(key);
  if (!validator) {
    const works = JSON.parse(canonical(answerSchemas[protocol].works as unknown as Json));
    works.oneOf[0].properties.proposal = worksBodySchema(wake, impact);
    eraWorksValidators.set(key, validator = answerSchemasAjv.compile(works));
  }
  return validator;
}
const answerValidators = { 'omg-answer/v2': compileAnswers(answerSchemas['omg-answer/v2']),
  'omg-answer/v3': compileAnswers(answerSchemas['omg-answer/v3']) };
const readPathValidator = answerSchemasAjv.compile(readPathShape);
/** The exact lexical rule used by the v3 schema, with no shared mutable RegExp exposed. */
export function packetReadPath(value: unknown): value is string { return readPathValidator(value); }
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
  if (briefContract(value.packetContract)) {
    if (parsed.protocol !== PACKET_ANSWER_PROTOCOL || !text(parsed.requestId))
      fail('part_answer_invalid', packet.id, 'protocol', 'The reply must use its declared answer protocol');
    if (parsed.requestId !== payload.requestId)
      fail('part_result_invalid', packet.id, 'requestId', 'The reply must name its exact sent form and request');
    const form = payload.responseForm as Record<string, Json>;
    const branch = (form.schema as unknown as { oneOf: { required: string[]; properties: Record<string, { const?: unknown }> }[] }).oneOf
      .find(branch => branch.properties.action!.const === (parsed as Record<string, unknown>).action);
    if (!branch || branch.required.some(key => !Object.hasOwn(parsed as object, key))
      || Object.keys(parsed).some(key => !Object.hasOwn(branch.properties, key)))
      fail('part_answer_invalid', packet.id, 'reply', 'The response envelope must match exactly one declared branch before resolving labels');
    const resolved = take(resolveBriefAnswer(payload, parsed));
    const validateWire = answerSchemasAjv.compile(form.schema as object);
    if (!validateWire(parsed)) fail('part_answer_invalid', packet.id, validateWire.errors?.[0]?.instancePath || 'reply',
      'The reply must use this packet-specific form');
    parsed = resolved;
  }
  if (!object(parsed)) fail('part_answer_invalid', packet.id, 'raw', 'An answer must remain a typed object');
  if (value.answerProtocol) {
    const wake = value.wakeTests === true, impact = Object.hasOwn(value, 'briefImpact');
    const validate = packetWorkContract(value) && (wake || impact) ? eraWorksValidator(value.answerProtocol, wake, impact)
      : answerValidators[value.answerProtocol][packetWorkContract(value) ? 'works' : kind];
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
    // S1.1 (№1915): the unwritten preview is read through the common pending overlay — a replayable
    // source view over a plain Store, the opaque branch over a caller's Proxy — never through an ad-hoc Proxy
    // that would make every proof of the history under it unrepeatable.
    const previous = value.request.previous.map(item => checkedPart(store, project, item.result).proposal.value as LayerProposal);
    const reuse = <T>(prior: T[], supplied: T[]) => [...unique(prior).filter(item => !supplied.some(value => same(item, value))), ...supplied];
    const contextual: LayerProposal = { ...proposalValue, nodes: reuse(previousNodes, body.nodes),
      tests: reuse(previous.flatMap(item => item.tests), body.tests),
      edges: reuse(previous.flatMap(item => item.edges), body.edges) };
    const preview: Revision<LayerProposal> = { id: `om-proposal:${project}:answer-content:${hashJson(contextual)}`,
      kind: 'layer-proposal', revision: 1, hash: hashJson(contextual), value: contextual };
    // PF4 (№3499 §4): the preview is exactly the Ref of this key — its id, revision and content hash — so the layer it is
    // read through is internal to this derivation: its row is constant, every other read is the Store's own.
    historicalRead(store, { reader: 'E2.works-proposal-content', project, ref: reference(preview), parameters: json(frameSource) },
      () => take(readFrameProposals(historicalLayer(store, [sealed({ id: preview.id, revision: 1, hash: hashJson(preview.value), kind: preview.kind, value: preview.value })]),
        { frame: frameSource.frame,
        proposals: [...frameSource.proposals, reference(preview)] })),
      () => fail('packet_chain_invalid', packet.id, 'proposal', 'The work-part content has a cyclic source derivation'));
    // G5 (№3820, №3822, №3841): a producer end whose work has more than one test covering its connection names its wake
    // test, checked when this work is accepted, whatever its neighbour sleeps; a named test is checked by the common E2
    // rule above. With one covering test there is nothing to choose; the engine never takes the first of several.
    if (value.wakeTests === true) {
      const tests = new Map([...graph.tests, ...frame.proposals.flatMap(item => item.value.tests), ...contextual.tests].map(test => [test.id, test]));
      for (const fill of body.fills) {
        const obligation = frame.result.obligations.find(item => item.id === fill.obligation);
        const node = scopedGraph.nodes.find(item => item.id === fill.node);
        if (!obligation || obligation.kind !== 'connection-end' || obligation.role !== 'producer' || !obligation.connector || !node
          || Object.hasOwn(fill, WAKE_TEST.field)) continue;
        if ([...tests.values()].filter(test => test.node === node.id && node.tests.includes(test.id) && test.covers.includes(obligation.connector!)).length > 1)
          fail('part_result_invalid', fill.obligation, WAKE_TEST.field, WAKE_TEST.rule);
      }
    }
    // G6 (В4, №3869): the G5 invariant at the primary acceptance of a new work of this era — its outcome and the artifact
    // of every connection it is the producer end of (the upper ones it fills, its own local ones) are one artifact.
    if (value.transitionEra === true) {
      const artifactOf = new Map([...graph.connectors, ...(contextual.localConnectors ?? [])].map(connector => [connector.id, connector.artifact]));
      for (const node of body.nodes.filter(item => item.kind === 'work')) {
        const artifacts = new Set([node.outcome]);
        for (const fill of body.fills) {
          const obligation = frame.result.obligations.find(item => item.id === fill.obligation);
          if (fill.node === node.id && obligation?.kind === 'connection-end' && obligation.role === 'producer' && obligation.connector)
            artifacts.add(artifactOf.get(obligation.connector) ?? obligation.connector);
        }
        for (const connector of contextual.localConnectors ?? []) if (connector.bindings.some(binding => binding.level === 3 && binding.producer.node === node.id))
          artifacts.add(connector.artifact);
        if (artifacts.size !== 1) fail('part_result_invalid', node.id, 'outcome', ONE_ARTIFACT.rule);
      }
    }
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
/** NR1 (№3600): a trusted read of a saved part result and the proposal written with it (preparePartResult derived both
 * from the saved response of its own call, in one guarded transaction). */
function checkedPart(store: Store, project: string, ref: Ref): CheckedPartResult {
  return historicalRead(store, { reader: 'E2.part-result', project, ref }, () => {
    const saved = take(readRecord<PartResultRecord>(store, ref, { unit: 'E2', target: ref.id,
      idPrefix: `om-part-result:${project}:`, kind: PART_RESULT_KIND })) as Revision<PartResultRecord>;
    const proposal = store.get<LayerProposal>(saved.value.proposal.id, saved.value.proposal.revision) as Revision<LayerProposal> | null;
    if (!proposal || proposal.hash !== saved.value.proposal.hash) fail('part_result_invalid', ref.id, 'proposal', 'The result names its saved proposal');
    const request = saved.value.request as { packet: Ref; call: Ref; response: Ref };
    return { record: saved, proposal, references: unique([ref, saved.value.proposal, request.packet, request.call, request.response].filter(isRef)) };
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
    // S1.1 (№1915): the unwritten response is read through the common pending overlay (a replayable source view
    // over a plain Store; the opaque branch over a caller's Proxy). A matching saved response keeps the plain Store;
    // a differing one was refused above — the overlay never hides a saved record.
    const view = response && pending && !stored ? pendingCallStore(store, [pending]) : store;
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
    const { continuation: _continuation, correction: _correction, ...priorRequest } = prior.value.request;
    const { continuation: _currentContinuation, correction: _currentCorrection, ...rootRequest } = request;
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
      ...(worksPacketContract(contract) ? { tests: checked.proposal.value.tests, edges: checked.proposal.value.edges } : {}) });
  });
}

// S1.1 (№1773): the journal proves an exact historical revision through the common proof scope of this operation.
// The journal must not import input.ts itself (an ESM cycle would reach its reader registry before it has evaluated),
// so this module, which already imports both, hands the existing executor in once; nothing is called here.
registerJournalProofExecutor(historicalProof);
