import { briefAnswerRepairable, briefContract, packetPrompt, briefReadings, type BriefManifest, type BriefReadings } from './packet-brief.js';
import type { AnswerGround } from './accepted-answer.js';
import { gapLinesId } from './gap-lines.js';
import { readAcceptedFrameLayer as readAcceptedFrameLayerOf, readLayerAcceptance as readLayerAcceptanceOf, readLayerEnvelope as readLayerEnvelopeOf, readUnacceptedLayer as readUnacceptedLayerOf } from './layer-basis.js';
import type { FrameAttemptBinding } from './layer-basis.js';
import { readCompletionCloseAt as readCompletionCloseAtOf, mechanismAttemptResults as mechanismAttemptResultsOf, prepareFinishClose as prepareFinishCloseOf } from './repeat-gate.js';
import { canonical, digest, hashJson, type Json } from '../canonical.js';
import { OM_CAPACITY_DELIVERY_CONTRACT, requireOmCapacityDelivery, type OmCapacityDelivery } from './capacity-delivery.js';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { EngineError } from '../errors.js';
import { physicalClaim, authorizeModelDispatch, prepareModelCallRecovery, readModelCallRecovery,
  prepareLateModelReceipt, readLateModelReceipt, executionOf, paidModelReceipt } from '../discovery/model-call-recovery.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { isStdioProtocol } from '../adapters/stdio-providers.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { pendingOverlay, storeView } from '../storage/store-view.js';
import { RunControlGate, RunControlLost, type RunControlHold } from './run-control.js';
import { ResearchSources } from '../discovery/research-sources.js';
import { contextValue } from '../discovery/working-context.js';
import { sourceIsCurrent, isWebDocumentSource, type Source } from '../evidence/evidence.js';
import { resolveRoleMode, uniqueTransactionGuards, workspacePath, readEnvironmentAt, type Environment } from '../runtime/environment.js';
import { tokenUsage, type TokenUsage, type ModelCall } from '../runtime/model-usage.js';
import type { ProcessResult } from '../runtime/process.js';
import { delivered, refused, sealed, isPlainObject, localErrors, localRefusals, transfer, transferring, type Refusal, type OmResult, type Sealed, type SourceCode, type SourceCodes } from './refusal.js';
import { readRecord as readRecordOf, writeGuarded as writeGuardedOf, type GuardedWrite, type RecordRequest } from './refs.js';
import { readAnswerCitations as readAnswerCitationsOf, prepareAnswerCitations as prepareAnswerCitationsOf, readAcceptedAnswer as readAcceptedAnswerOf, readMc1Question as readMc1QuestionOf } from './accepted-answer.js';
import { checkAnswerForm as checkAnswerFormOf, prepareAnswerForm as prepareAnswerFormOf, readSelectorProblem, readTextResult, readPointerResult,
  pointerSegments, jsonShape, READ_RESULT_CONTRACT, type ReadResult, type ReadTooLarge } from './answer-form.js';
import { readPacketResponse as readPacketResponseOf, readPartResult as readPartResultOf, readQuestionPacket as readQuestionPacketOf, writeQuestionPacket as writeQuestionPacketOf, normalizePartAnswer as normalizePartAnswerOf, shownNoProgress as shownNoProgressOf, type PacketRead, type QuestionPacketRecord, type PartProposalBody, type WorksPartBindings } from './question-packet.js';
import { readRoutes as readRoutesOf } from './routes.js';
import { readFrameProposals as readFrameProposalsOf, prepareFrameProposals as prepareFrameProposalsOf, type FrameProposals, type LayerProposal } from './frame-proposals.js';
import { readGaps as readGapsOf } from './gaps.js';
import { prepareOmObligations as prepareOmObligationsOf, readOmObligations as readOmObligationsOf, type OmObligations } from './obligations.js';
import { taskBindingId, taskObligations } from '../graph/task-obligations.js';
import { readWorkRejectionAt as readWorkRejectionAtOf } from './frame-accept.js';
import type { Graph } from '../graph/model.js';
import { RefinementRelations } from '../graph/relations.js';
import type { TaskObligationBinding } from '../graph/task-obligation-model.js';
import type { CarriedObligation } from '../graph/obligation-policy.js';
import { WORKS_FRAME_CONTRACT, readFrameBasis as readFrameBasisOf, prepareFrame as prepareFrameOf, type FrameRequest } from './frame-obligations.js';
import { withHistoricalReads, historicalRead, historicalTrace } from './input.js';
import { historicalRefusalRead } from '../history/proofs.js';
import { prepareAssessmentAdmission as prepareAssessmentAdmissionOf, readAssessmentIntentAt as readAssessmentIntentAtOf } from './assessment.js';

export const MODEL_CALL_CODES = Object.freeze([
  'model_call_request_invalid', 'model_adapter_response_invalid', 'model_adapter_interrupted',
  'model_delivery_invalid', 'model_read_unavailable',
  'model_parts_invalid', 'model_parts_conflict',
  'model_call_record_invalid', 'model_call_identity_conflict', 'model_call_in_progress', 'model_call_application_pending',
] as const);
/**
 * Q2 (№2452-5, №2460-7): every refusal code model-call.ts creates itself, from the actual places of issue; the older
 * MODEL_CALL_CODES above stays exported as it is. The two codes of a parsed transport answer are data of AdapterResult,
 * never a local refusal; the exceptions have their own small set.
 */
export const MODEL_CALL_LOCAL_CODES = Object.freeze([
  'model_call_request_invalid', 'model_call_record_invalid', 'model_call_identity_conflict', 'model_call_in_progress',
  'model_call_application_pending', 'model_call_foreign', 'model_call_not_running',
  'model_delivery_invalid', 'model_read_unavailable', 'model_parts_invalid', 'model_parts_conflict',
  'packet_invalid', 'packet_attempt_invalid', 'dispatch_contract_invalid', 'ledger_invalid', 'input_stale',
  'assessment_source_invalid',
  'completion_invalid', 'completion_foreign', 'completion_closed', 'completion_conflict', 'completion_ceased',
  'completion_claim_exists', 'completion_resolved', 'completion_cause_invalid', 'completion_cause_unproved',
] as const);
export type ModelCallLocalCode = typeof MODEL_CALL_LOCAL_CODES[number];
export const MODEL_CALL_ERROR_CODES = Object.freeze(['model_call_request_invalid', 'research_dispatch_invalid'] as const);
export type ModelCallErrorCode = typeof MODEL_CALL_ERROR_CODES[number];
/**
 * The codes of a transport outcome this module states itself (a parsed answer, a lost executor) — data of AdapterResult.error;
 * a saved launch error is the historical arm. They are no refusal code of a result: a failed exchange becomes a refusal only
 * through transportFailure, marked with its source (№2511-1).
 */
export const TRANSPORT_ERROR_CODES = Object.freeze(['model_adapter_interrupted', 'model_adapter_response_invalid', 'process_lost'] as const);
export type TransportErrorCode = typeof TRANSPORT_ERROR_CODES[number];
/**
 * The units whose refusals model-call.ts hands on, each through a declared transfer at its import or its boundary; the
 * 'transport' is the verified exchange of an adapter, passed on by transportFailure.
 */
export type ModelCallSource = 'refs' | 'input' | 'addressing' | 'accepted-answer' | 'answer-form' | 'answers-gate' | 'assessment'
  | 'call-record' | 'frame-obligations' | 'frame-proposals' | 'gaps' | 'layer-basis' | 'obligations' | 'question-packet' | 'refusal-journal'
  | 'repeat-gate' | 'routes' | 'series' | 'run-control' | 'transport' | 'frame-accept';
export type ModelCallCode = ModelCallLocalCode | SourceCodes<ModelCallSource>;
export type ModelCallResult<T> = OmResult<T, ModelCallCode>;

// Q2: the readers of the declared sources, bound once here — every refusal they return carries its source mark, and
// take() below accepts no other foreign result. The refs readers keep their generics through explicit wrappers.
const answersCheckState = transferring('answers-gate', answersCheckStateOf);
const checkAnswerForm = transferring('answer-form', checkAnswerFormOf);
const checkAnswersTransition = transferring('answers-gate', checkAnswersTransitionOf);
const mechanismAttemptResults = transferring('repeat-gate', mechanismAttemptResultsOf);
const normalizePartAnswer = transferring('question-packet', normalizePartAnswerOf);
const prepareAddressing = transferring('addressing', prepareAddressingOf);
const prepareAnswerCitations = transferring('accepted-answer', prepareAnswerCitationsOf);
const prepareAnswerForm = transferring('answer-form', prepareAnswerFormOf);
const prepareAssessmentAdmission = transferring('assessment', prepareAssessmentAdmissionOf);
const prepareCallDispatch = transferring('call-record', prepareCallDispatchOf);
const prepareCompleteAttempt = transferring('series', prepareCompleteAttemptOf);
const prepareCompletionAdmission = transferring('series', prepareCompletionAdmissionOf);
const prepareFinishClose = transferring('repeat-gate', prepareFinishCloseOf);
const prepareFrame = transferring('frame-obligations', prepareFrameOf);
const prepareFrameProposals = transferring('frame-proposals', prepareFrameProposalsOf);
const prepareJournalBatch = transferring('refusal-journal', prepareJournalBatchOf);
const preparePartResult = transferring('question-packet', preparePartResultOf);
const prepareQuestionPacket = transferring('question-packet', prepareQuestionPacketOf);
const prepareRecordRefusal = transferring('refusal-journal', prepareRecordRefusalOf);
const prepareSeriesLineAdmission = transferring('series', prepareSeriesLineAdmissionOf);
const readAcceptedAnswer = transferring('accepted-answer', readAcceptedAnswerOf);
const readAcceptedFrameLayer = transferring('layer-basis', readAcceptedFrameLayerOf);
const readAnswerCitations = transferring('accepted-answer', readAnswerCitationsOf);
const readAnswersGateAssignmentAt = transferring('series', readAnswersGateAssignmentAtOf);
const readAnswersParticipant = transferring('answers-gate', readAnswersParticipantOf);
const readAnySeriesAt = transferring('series', readAnySeriesAtOf);
const readAssessmentIntentAt = transferring('assessment', readAssessmentIntentAtOf);
const readAssessmentTerminalAt = transferring('assessment', readAssessmentTerminalAtOf);
const readCall = transferring('call-record', readCallOf);
const readCallLedger = transferring('call-record', readCallLedgerOf);
const readCallLedgerAt = transferring('call-record', readCallLedgerAtOf);
const readCompletionBinding = transferring('series', readCompletionBindingOf);
// G6.2: frame-accept reaches this module through a cycle of imports — its reader is bound at the call, not at load.
const readWorkRejectionAt = (store: Store, request: { project: string; record: Ref }) => transfer('frame-accept', readWorkRejectionAtOf(store, request));
const readCompletionCloseAt = transferring('repeat-gate', readCompletionCloseAtOf);
const readCompletionOriginalAdmission = transferring('series', readCompletionOriginalAdmissionOf);
const readCompletionOwnerAt = transferring('series', readCompletionOwnerAtOf);
const readCurrentSeriesPointer = transferring('series', readCurrentSeriesPointerOf);
const readFrameBasis = transferring('frame-obligations', readFrameBasisOf);
const readFrameProposals = transferring('frame-proposals', readFrameProposalsOf);
const readJournal = transferring('refusal-journal', readJournalOf);
const readJournalAt = transferring('refusal-journal', readJournalAtOf);
const readLayerAcceptance = transferring('layer-basis', readLayerAcceptanceOf);
const readLayerEnvelope = transferring('layer-basis', readLayerEnvelopeOf);
const readMc1Question = transferring('accepted-answer', readMc1QuestionOf);
const readOmInput = transferring('input', readOmInputOf);
const readPacketResponse = transferring('question-packet', readPacketResponseOf);
const readPartResult = transferring('question-packet', readPartResultOf);
const readQuestionPacket = transferring('question-packet', readQuestionPacketOf);
const readRouteProducers = transferring('answers-gate', readRouteProducersOf);
const readRoutes = transferring('routes', readRoutesOf);
const readGaps = transferring('gaps', readGapsOf);
const readOmObligations = transferring('obligations', readOmObligationsOf);
const prepareOmObligations = transferring('obligations', prepareOmObligationsOf);
const readSeriesAdmissionChange = transferring('series', readSeriesAdmissionChangeOf);
const readSeriesWorkAdmission = transferring('series', readSeriesWorkAdmissionOf);
const readUnacceptedLayer = transferring('layer-basis', readUnacceptedLayerOf);
const recordCall = transferring('call-record', recordCallOf);
const settleCall = transferring('call-record', settleCallOf);
const writeQuestionPacket = transferring('question-packet', writeQuestionPacketOf);
const shownNoProgress = transferring('question-packet', shownNoProgressOf);
const readRecord = <T = Json>(store: Store, reference: unknown, request: RecordRequest) => transfer('refs', readRecordOf<T>(store, reference, request));
const writeGuarded = <T = Json>(store: Store, request: GuardedWrite) => transfer('refs', writeGuardedOf<T>(store, request));

export interface AdapterRequest {
  protocol: 'omg-agent/v1'; requestId: string; mode: 'research';
  model: string; effort: string; speed?: 'fast' | 'inherited'; prompt: string;
}
export interface AdapterRequestInput {
  requestId: string; packet: Json; model: string; effort: string; speed?: 'fast' | 'inherited';
}
export interface AdapterResponseInput { requestId: string; process: ProcessResult }
type Confirmed = ModelCall['confirmed'];
interface AdapterResultBase { usage: TokenUsage | null; confirmed: Confirmed }
/**
 * The error of a failed exchange. The codes of a transport answer are a data type of their own (№2460-7); the saved launch
 * error of a historical exchange is the other arm, marked as the exchange's at transportOf — never a plain string.
 */
export interface AdapterError { code: TransportErrorCode | SourceCode<'exchange'>; field: string; message: string }
export type AdapterResult = AdapterResultBase & (
  | { kind: 'answered'; raw: string }
  | { kind: 'interrupted' | 'off-form'; error: AdapterError }
);

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const unknownConfirmed = (): Confirmed => ({ model: null, effort: null, speed: null });
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const refuse = localRefusals(MODEL_CALL_LOCAL_CODES);
// Annotated explicitly: only a declared `never` makes a bare call end the control flow for tsc.
const raise: (code: ModelCallErrorCode, message: string, details?: unknown) => never = localErrors(MODEL_CALL_ERROR_CODES);
function invalid(field: string): never {
  return raise('model_call_request_invalid', 'E4 requires an explicit complete request', { unit: 'E4', target: 'model-call', field });
}
/** The throw channel of this module: a refusal of the local catalogue (fail) or of a declared source (take), nothing else. */
class CallFailure extends Error { constructor(readonly refusal: Refusal<ModelCallCode>) { super(refusal.message); } }
function take<T>(result: OmResult<T, ModelCallCode>): T { if (!result.ok) throw new CallFailure(result.refusal); return result.value; }
function fail(code: ModelCallLocalCode, target: string, field: string, message: string, ref?: Ref): never {
  const result = refuse(code, message, { unit: 'E4', target, field, ref }, 'producer');
  if (!result.ok) throw new CallFailure(result.refusal);
  throw new Error('Unreachable');
}
/** Where the throw channel ends: the one failure class this module throws, turned back into its typed result. */
function caught(error: unknown): ModelCallResult<never> | null {
  return error instanceof CallFailure ? { ok: false, refusal: error.refusal } : null;
}
/** A control refusal of run-control reaching this module: the whole refusal, marked with its source. */
function controlLost(error: RunControlLost): ModelCallResult<never> {
  return transfer('run-control', { ok: false as const, refusal: error.refusal });
}
function result<T>(action: () => T): ModelCallResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { const failed = caught(error); if (failed) return failed; throw error; }
  });
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const compareJson = (a: unknown, b: unknown) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
const refs = (values: readonly Ref[]): Ref[] => [...new Map(values.map(ref => [canonical(ref), ref])).values()]
  .sort(compareJson);

/** Wire encoding only. Dispatch admission and the packet proof belong to E1 and E2. */
export function adapterRequest(request: AdapterRequestInput): ModelCallResult<Sealed<AdapterRequest>> {
  if (!object(request) || !text(request.requestId) || !text(request.model)
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(request.effort)
    || !Object.hasOwn(request, 'packet')
    || (Object.hasOwn(request, 'speed') && !['fast', 'inherited'].includes(request.speed as string))
    || Object.keys(request).some(key => !['requestId', 'packet', 'model', 'effort', 'speed'].includes(key))) invalid('request');
  let prompt: string;
  try { prompt = packetPrompt(request.packet, request.requestId); }
  catch (error) { if (error instanceof EngineError) invalid('packet'); throw error; }
  return delivered({ protocol: 'omg-agent/v1', requestId: request.requestId, mode: 'research',
    model: request.model, effort: request.effort, ...(request.speed === undefined ? {} : { speed: request.speed }), prompt });
}

/** Decode transport evidence, not the answer's product form or its acceptance. */
export function readAdapterResponse(request: AdapterResponseInput): ModelCallResult<Sealed<AdapterResult>> {
  if (!object(request) || !text(request.requestId) || !object(request.process)
    || !exactKeys(request, ['requestId', 'process'])
    || !exactKeys(request.process, ['exitCode', 'signal', 'stdout', 'stderr'])
    || !(request.process.exitCode === null || (Number.isInteger(request.process.exitCode) && request.process.exitCode >= 0))
    || !(request.process.signal === null || text(request.process.signal))
    || typeof request.process.stdout !== 'string' || typeof request.process.stderr !== 'string') invalid('process');
  const process = request.process;
  let usage: TokenUsage | null = null;
  let confirmed = unknownConfirmed();
  let envelope: unknown;
  let defect: { field: string; message: string } | null = null;
  try { envelope = JSON.parse(process.stdout); }
  catch { defect = { field: 'stdout', message: 'The adapter must return one JSON envelope' }; }
  if (!defect && (!object(envelope) || envelope.protocol !== 'omg-agent/v1' || envelope.requestId !== request.requestId))
    defect = { field: 'requestId', message: 'The adapter response must name this exact protocol and request' };
  // Usage from another request is not evidence about this dispatch, even on a failed process.
  if (!defect && object(envelope)) {
    try { usage = tokenUsage(envelope.usage); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'usage_invalid') throw error;
      defect = { field: 'usage', message: 'The adapter token counts are malformed' };
    }
    if (object(envelope.confirmed) && exactKeys(envelope.confirmed, ['model', 'effort', 'speed'])
      && Object.values(envelope.confirmed).every(value => value === null || text(value))) {
      confirmed = envelope.confirmed as unknown as Confirmed;
    } else if (process.exitCode === 0 && process.signal === null) {
      defect ??= { field: 'confirmed', message: 'The adapter must explicitly distinguish confirmed settings from unknown settings' };
    }
  }
  if (process.exitCode !== 0 || process.signal !== null) {
    return delivered({ kind: 'interrupted', usage, confirmed, error: { code: 'model_adapter_interrupted', field: 'process',
      message: `Adapter did not complete (exit=${process.exitCode}, signal=${process.signal})` } });
  }
  if (!defect && (!object(envelope) || !exactKeys(envelope, ['protocol', 'requestId', 'research', 'usage', 'confirmed'])))
    defect = { field: 'envelope', message: 'The adapter response requires exactly protocol, requestId, research, usage and confirmed' };
  if (defect) return delivered({ kind: 'off-form', usage, confirmed,
    error: { code: 'model_adapter_response_invalid', ...defect } });
  let raw: string;
  try { raw = canonical((envelope as Record<string, Json>).research!); }
  catch (error) {
    if (!(error instanceof EngineError) || error.code !== 'invalid_json') throw error;
    return delivered({ kind: 'off-form', usage, confirmed,
      error: { code: 'model_adapter_response_invalid', field: 'research', message: 'The adapter payload must be finite JSON' } });
  }
  return delivered({ kind: 'answered', raw, usage, confirmed });
}

export interface ReadDeliveryRequest { project: string; packet: Ref; call: Ref; response: Ref }
export interface ContinuationEvidenceRequest extends ReadDeliveryRequest { deliveries: Ref[] }
export interface ReadDeliveryRecord extends ReadDeliveryRequest {
  questionIds: string[]; read: PacketRead; sources: Ref[]; data: Json;
}
export const READ_DELIVERY_KIND = 'om-read-delivery';
const DELIVERY_SET_KIND = 'om-read-delivery-set';
const deliveryId = (value: ReadDeliveryRecord) => `om-read-delivery:${value.project}:${hashJson(value)}`;
const deliverySetId = (request: ReadDeliveryRequest) => `om-read-deliveries:${request.project}:${hashJson(request)}`;
function requireDeliveryRequest(store: Store, value: unknown, continuation = false): asserts value is ContinuationEvidenceRequest {
  if (!(store instanceof Store) || !object(value) || !text(value.project)
    || ![value.packet, value.call, value.response].every(isRef)
    || !exactKeys(value, ['project', 'packet', 'call', 'response', ...(continuation ? ['deliveries'] : [])])
    || continuation && (!Array.isArray(value.deliveries) || !value.deliveries.every(isRef))) invalid('delivery');
}
function exactSource(store: Store, project: string, ref: Ref, current: boolean): Revision<Source> {
  const record = take(readRecord<Source>(store, ref, { unit: 'E4', target: ref.id, idPrefix: `source:${project}:`, kind: 'source' }));
  if (!object(record.value) || record.value.projectId !== project || typeof record.value.content !== 'string'
    || digest(record.value.content) !== record.value.sha256 || !object(record.value.origin)
    || !['file', 'owner-document', 'web'].includes(record.value.origin.kind) || !text(record.value.origin.location)
    || !(['text/plain', 'application/json'].includes(record.value.mediaType) || isWebDocumentSource(record.value)))
    fail('model_delivery_invalid', ref.id, 'source', 'A read source belongs to this project and retains its captured bytes', ref);
  // An empty file is still a valid read. Nonempty sources also use D5's shared historical selector/checksum proof.
  if (record.value.content.length) take(readAnswerCitations(store, { project,
    citations: [{ source: ref, selector: { kind: 'text-range', start: 0, end: record.value.content.length } }] }));
  if (current) {
    const head = store.get(ref.id);
    if (!head || !same(reference(head), ref) || !sourceIsCurrent(record.value as Source))
      fail('input_stale', ref.id, 'source', 'The addressed source changed before this operation', ref);
  }
  return record as Revision<Source>;
}
/** MP3: the delivery form follows the exact packet it answers; readings mark the addressed-result era. */
const addressedEra = (packet: QuestionPacketRecord) => briefReadings(packet.packet) !== null;
export function readOmContextPage(record: unknown, pointer: string,
  page: { offset: number; end: number; total: number; unit: 'items' | 'utf16' }): Json {
  const selected = readPointerResult(record, pointer);
  if (!selected || selected.outcome !== 'complete')
    fail('model_delivery_invalid', pointer, 'pointer', 'A page needs an existing exact original');
  const original = contextValue(record, pointer);
  const unit = Array.isArray(original) && page.unit === 'items' ? 'items' : 'utf16';
  const total = Array.isArray(original) && unit === 'items' || typeof original === 'string'
    ? original.length : canonical(original as Json).length;
  if (page.unit !== unit || page.total !== total || !Number.isSafeInteger(page.offset)
    || !Number.isSafeInteger(page.end) || page.offset < 0 || page.end <= page.offset || page.end > total)
    fail('model_delivery_invalid', pointer, 'page', 'A page must use the exact original and its coordinates');
  return (typeof original === 'string' || Array.isArray(original) && page.unit === 'items'
    ? original.slice(page.offset, page.end)
    : canonical(original as Json).slice(page.offset, page.end)) as Json;
}
function deliveryData(store: Store, project: string, environment: Environment, read: PacketRead, sources: Ref[], current: boolean, addressed: boolean): Json {
  if (read.action === 'read_source') {
    if (!same(sources, [read.source])) fail('model_delivery_invalid', read.source.id, 'sources', 'The selected source must be the requested source');
    if (addressed) {
      const source = exactSource(store, project, read.source, current);
      if (readSelectorProblem(read.selector, source.value.mediaType))
        fail('model_delivery_invalid', read.source.id, 'selector', 'Only an E3-admitted selector is delivered', read.source);
      if (read.selector.kind === 'text-range') return readTextResult(source.value.content, read.selector) as unknown as Json;
      let parsed: unknown;
      try { parsed = JSON.parse(source.value.content); }
      catch (error) {
        if (error instanceof SyntaxError) fail('model_delivery_invalid', read.source.id, 'source', 'The captured JSON source is malformed', read.source);
        throw error;
      }
      return readPointerResult(parsed, read.selector.pointer) as unknown as Json;
    }
    const request = { project, citations: [{ source: read.source, selector: read.selector }] };
    const checked = current ? take(prepareAnswerCitations(store, request)) : take(readAnswerCitations(store, request));
    return checked.grounds[0]!.observation.value as Json;
  }
  if (read.action === 'read_context') {
    if (!same(sources, [read.record])) fail('model_delivery_invalid', read.record.id, 'sources', 'The selected record must be the requested record');
    const found = store.get(read.record.id, read.record.revision);
    if (!found || !same(reference(found), read.record)) fail('model_delivery_invalid', read.record.id, 'record', 'The exact context record must exist');
    const head = current ? store.get(read.record.id) : null;
    if (current && (!head || !same(reference(head), read.record))) fail('input_stale', read.record.id, 'record', 'The selected context changed');
    if (read.page) return readOmContextPage(found.value, read.pointer, read.page);
    const result = addressed ? readPointerResult(found.value, read.pointer) : null;
    if (addressed && !result) fail('model_delivery_invalid', read.record.id, 'pointer', 'Only an E3-admitted pointer is delivered', read.record);
    return (addressed ? result : contextValue(found.value, read.pointer)) as Json;
  }
  const records = sources.map(ref => exactSource(store, project, ref, current));
  if (read.action === 'read') {
    const location = join(environment.workspace, read.path);
    if (records.length !== 1 || records[0]!.value.origin.kind !== 'file'
      || records[0]!.value.origin.location !== location || records[0]!.value.mediaType !== read.media)
      fail('model_delivery_invalid', read.path, 'sources', 'The captured file must be this requested path and media');
    return records[0]!.value.content;
  }
  if (typeof read.within !== 'string' && !same(sources, [read.within]))
    fail('model_delivery_invalid', project, 'sources', 'Search remains inside the named exact source');
  if (typeof read.within === 'string') for (const source of records) {
    const within = relative(join(environment.workspace, read.within), source.value.origin.location);
    if (source.value.origin.kind !== 'file' || within === '..' || within.startsWith('../') || within.startsWith('/'))
      fail('model_delivery_invalid', read.within, 'sources', 'Search sources stay within the requested address');
  }
  return records.flatMap(source => source.value.content.split(/\r?\n/).flatMap((line, index) =>
    line.toLowerCase().includes(read.query.toLowerCase())
      ? [{ source: reference(source), line: index + 1, text: line }] : [])) as unknown as Json;
}

/** One historical proof for E2 continuations and E4 delivery/replay. Current adds freshness, never a different derivation. */
export function readContinuationEvidence(store: Store, request: ContinuationEvidenceRequest, current = false): ModelCallResult<Sealed<{ data: Json[]; novel: boolean; references: Ref[]; guards: TransactionGuard[] }>> {
  requireDeliveryRequest(store, request, true); if (typeof current !== 'boolean') invalid('current');
  request = sealed(request) as ContinuationEvidenceRequest;
  const derive = () => result(() => {
    const response = take(readPacketResponse(store, { project: request.project, packet: request.packet, call: request.call, response: request.response }));
    const answerRequest = { project: request.project, packet: request.packet, raw: response.record.value.raw };
    const prepared = current ? take(prepareAnswerForm(store, answerRequest)) : null;
    const checked = prepared ?? take(checkAnswerForm(store, answerRequest));
    if (checked.kind !== 'need-source') fail('model_delivery_invalid', request.response.id, 'action', 'Only an addressed need_source response supplies a continuation');
    if (request.deliveries.length !== checked.reads.length)
      fail('model_delivery_invalid', request.response.id, 'deliveries', 'Every addressed read has exactly one checked delivery');
    const envRef = response.packet.value.request.environment;
    const environment = take(readRecord<Environment>(store, envRef, { unit: 'E4', target: envRef.id, id: `environment:${request.project}`, kind: 'environment' }));
    const references: Ref[] = [...response.references, envRef], guards: TransactionGuard[] = prepared ? [...prepared.guards] : [];
    const addressed = addressedEra(response.packet.value as QuestionPacketRecord);
    const data = request.deliveries.map((ref, index) => {
      const record = take(readRecord<ReadDeliveryRecord>(store, ref, { unit: 'E4', target: ref.id, idPrefix: `om-read-delivery:${request.project}:`, kind: READ_DELIVERY_KIND }));
      const value = record.value;
      if (record.revision !== 1 || !object(value) || !exactKeys(value, ['project', 'packet', 'call', 'response', 'questionIds', 'read', 'sources', 'data'])
        || !Array.isArray(value.sources) || !value.sources.every(isRef) || record.id !== deliveryId(value as ReadDeliveryRecord)
        || value.project !== request.project || !same(value.packet, request.packet) || !same(value.call, request.call)
        || !same(value.response, request.response) || !same(value.questionIds, checked.questionIds) || !same(value.read, checked.reads[index]))
        fail('model_delivery_invalid', ref.id, 'delivery', 'A delivery belongs to this response, question set and requested read', ref);
      const expected = deliveryData(store, request.project, environment.value as Environment, value.read as PacketRead, value.sources as Ref[], current, addressed);
      if (!same(expected, value.data)) fail('model_delivery_invalid', ref.id, 'data', 'The delivery must reproduce data from the exact saved sources', ref);
      references.push(ref, ...value.sources); if (current) guards.push(ref, ...value.sources);
      return { delivery: ref, questionIds: value.questionIds, read: value.read, sources: value.sources, data: value.data } as unknown as Json;
    });
    return { data, novel: addsKnowledge(store, response.packet.value as QuestionPacketRecord, data),
      references: refs(references), guards: externalGuards(guards, []) };
  });
  // A saved delivery was checked against its response and reproduced from its exact sources when it was written: the
  // historical replay reads its data as written. The current branch above checks sources and admission afresh.
  const saved = () => result(() => {
    const response = take(readPacketResponse(store, { project: request.project, packet: request.packet, call: request.call, response: request.response }));
    const references: Ref[] = [...response.references, response.packet.value.request.environment];
    const data = request.deliveries.map(ref => {
      const value = take(readRecord<ReadDeliveryRecord>(store, ref, { unit: 'E4', target: ref.id, idPrefix: `om-read-delivery:${request.project}:`, kind: READ_DELIVERY_KIND })).value;
      if (!same(value.response, request.response) || !same(value.packet, request.packet) || !same(value.call, request.call))
        fail('model_delivery_invalid', ref.id, 'delivery', 'A delivery belongs to this response, question set and requested read', ref);
      references.push(ref, ...value.sources);
      return { delivery: ref, questionIds: value.questionIds, read: value.read, sources: value.sources, data: value.data } as unknown as Json;
    });
    return { data, novel: addsKnowledge(store, response.packet.value as QuestionPacketRecord, data),
      references: refs(references), guards: [] as TransactionGuard[] };
  });
  return current ? derive() : historicalRefusalRead(store, { reader: 'E4.continuation', project: request.project, ref: request.response,
    parameters: request as unknown as Json }, saved,
  () => refuse('model_delivery_invalid', 'Delivery provenance contains a cycle', { unit: 'E4', target: request.response.id, field: 'continuation' }, 'producer'));
}

/** Executes only the addresses E3 validated; the sources and actual delivered values remain readable after restart. */
/**
 * LP3 (№2817-3, row 2): an addressed need_source that passed E3 may still ask the engine for an operation it cannot perform
 * on the exact records it names — a search whose scope is a record of this project's context (an obligation basis, say)
 * rather than one of its captured sources. Derived from the exact packet, call and response alone, before any read is
 * performed, by the producer of the cycle and by its reader alike: the first such read in the order of the response, with
 * the addressed refusal of the read itself. A missing, stale or unreadable source is no such ground (rows 6–9).
 */
function readsIssue(store: Store, basis: ReadDeliveryRequest): { code: string; message: string; ref: Ref } | null {
  const response = take(readPacketResponse(store, basis));
  const checked = take(checkAnswerForm(store, { project: basis.project, packet: basis.packet, raw: response.record.value.raw }));
  if (checked.kind !== 'need-source') return null;
  for (const read of checked.reads) {
    if (read.action !== 'search' || typeof read.within === 'string') continue;
    const scope = readRecord(store, read.within, { unit: 'E4', target: read.within.id, idPrefix: `source:${basis.project}:`, kind: 'source' });
    if (!scope.ok && scope.refusal.code === 'record_foreign') return { code: scope.refusal.code, message: scope.refusal.message, ref: read.within };
  }
  return null;
}
export function deliverModelSources(store: Store, request: ReadDeliveryRequest): ModelCallResult<Sealed<{ deliveries: Ref[]; references: Ref[] }>> {
  requireDeliveryRequest(store, request); request = sealed(request) as ReadDeliveryRequest;
  return result(() => {
    const setId = deliverySetId(request), oldSet = store.get<ContinuationEvidenceRequest>(setId);
    if (oldSet) {
      if (oldSet.kind !== DELIVERY_SET_KIND || oldSet.revision !== 1 || !object(oldSet.value)
        || !exactKeys(oldSet.value, ['project', 'packet', 'call', 'response', 'deliveries'])
        || !Array.isArray(oldSet.value.deliveries) || !oldSet.value.deliveries.every(isRef)
        || !same({ project: oldSet.value.project, packet: oldSet.value.packet, call: oldSet.value.call, response: oldSet.value.response }, request))
        fail('model_delivery_invalid', setId, 'record', 'A delivery transition has one immutable source');
      const checked = take(readContinuationEvidence(store, oldSet.value));
      return { deliveries: oldSet.value.deliveries, references: refs([reference(oldSet), ...checked.references]) };
    }
    const response = take(readPacketResponse(store, request));
    const checked = take(prepareAnswerForm(store, { project: request.project, packet: request.packet, raw: response.record.value.raw }));
    if (checked.kind !== 'need-source') fail('model_delivery_invalid', request.response.id, 'action', 'Delivery requires an addressed need_source response');
    const envRef = response.packet.value.request.environment;
    const environment = take(readRecord<Environment>(store, envRef, { unit: 'E4', target: envRef.id, id: `environment:${request.project}`, kind: 'environment' }));
    const capture = new ResearchSources(store, request.project, environment.value.workspace);
    const addressed = addressedEra(response.packet.value as QuestionPacketRecord);
    const writes: Write[] = [], deliveries: Ref[] = [], guards: TransactionGuard[] = [...checked.guards, request.response];
    for (const read of checked.reads) {
      let sources: Ref[];
      try {
        if (read.action === 'read') sources = [reference(capture.read(read.path, read.media))];
        else if (read.action === 'read_source') sources = [read.source];
        else if (read.action === 'read_context') sources = [read.record];
        else if (typeof read.within !== 'string') sources = [read.within];
        else sources = searchScopeFiles(environment.value.workspace, read.within).map(file => reference(capture.read(file.path, 'text/plain')));
      } catch (error) {
        if (error instanceof CallFailure) throw error;
        if (error instanceof EngineError || object(error) && ['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR'].includes(String(error.code)))
          fail('model_read_unavailable', request.response.id, 'reads', error instanceof Error ? error.message : 'The addressed source cannot be read');
        throw error;
      }
      const value: ReadDeliveryRecord = { ...request, questionIds: [...checked.questionIds], read: read as PacketRead, sources,
        data: deliveryData(store, request.project, environment.value as Environment, read as PacketRead, sources, true, addressed) };
      const id = deliveryId(value), old = store.get(id);
      if (old && (old.kind !== READ_DELIVERY_KIND || old.revision !== 1 || !same(old.value, value)))
        fail('model_delivery_invalid', id, 'record', 'An immutable delivery cannot be replaced');
      deliveries.push({ id, revision: 1, hash: hashJson(value) }); guards.push(...sources);
      if (old) guards.push(reference(old));
      else if (!writes.some(write => write.id === id)) writes.push({ id, kind: READ_DELIVERY_KIND, expected: 0, value });
    }
    writes.push({ id: setId, kind: DELIVERY_SET_KIND, expected: 0, value: { ...request, deliveries } });
    take(writeGuarded(store, { unit: 'E4', target: request.response.id, writes, guards: externalGuards(guards, []) }));
    const proof = take(readContinuationEvidence(store, { ...request, deliveries }));
    return { deliveries, references: proof.references as Ref[] };
  });
}

/**
 * The concrete files of a search over a workspace path — the one walk of the delivery producer and of the carried scope's
 * currency (MP3, Codex-omg №3190): concrete paths only, no symbolic alias, directories in sorted order, never .git.
 */
function searchScopeFiles(workspace: string, within: string): { path: string; location: string }[] {
  const files: { path: string; location: string }[] = [];
  const visit = (path: string) => {
    const absolute = workspacePath(workspace, path);
    if (realpathSync(absolute) !== absolute) fail('model_read_unavailable', path, 'path', 'Search uses concrete paths without symbolic aliases');
    if (statSync(absolute).isDirectory()) for (const entry of readdirSync(absolute).sort()) {
      if (entry !== '.git') visit(`${path}/${entry}`);
    } else files.push({ path, location: absolute });
  };
  visit(within);
  return files;
}
/**
 * Today's scope of a carried search over a workspace path by that same walk: the locations of its files, or null when the walk
 * no longer holds there (a missing or aliased path, an escape). Reads the directory only: nothing is captured or delivered.
 */
export function currentSearchScope(workspace: string, within: string): string[] | null {
  try { return searchScopeFiles(workspace, within).map(file => file.location); }
  catch (error) {
    if (error instanceof CallFailure || error instanceof EngineError
      || object(error) && ['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR', 'ELOOP'].includes(String(error.code))) return null;
    throw error;
  }
}
/** MP3 carry-over: the deterministic set address of one physical step; the set itself is written only by delivery. */
export function deliverySetAddress(basis: ReadDeliveryRequest): string {
  if (!object(basis) || !text(basis.project) || ![basis.packet, basis.call, basis.response].every(isRef)) invalid('delivery');
  return deliverySetId({ project: basis.project, packet: basis.packet, call: basis.call, response: basis.response });
}
/** The exact saved set of one step, with every delivery proved by the common historical continuation proof. */
export function readDeliverySet(store: Store, project: string, ref: Ref): ModelCallResult<Sealed<{ basis: ReadDeliveryRequest; deliveries: Ref[]; data: Json[] }>> {
  if (!(store instanceof Store) || !text(project) || !isRef(ref)) invalid('delivery.set');
  return result(() => {
    const set = take(readRecord<ContinuationEvidenceRequest>(store, ref, { unit: 'E4', target: ref.id, idPrefix: `om-read-deliveries:${project}:`, kind: DELIVERY_SET_KIND }));
    const value = set.value;
    if (set.revision !== 1 || !object(value) || !exactKeys(value, ['project', 'packet', 'call', 'response', 'deliveries'])
      || value.project !== project || ![value.packet, value.call, value.response].every(isRef)
      || !Array.isArray(value.deliveries) || !value.deliveries.every(isRef)
      || set.id !== deliverySetId({ project, packet: value.packet, call: value.call, response: value.response }))
      fail('model_delivery_invalid', ref.id, 'record', 'A delivery set has one immutable exact step', ref);
    const proof = take(readContinuationEvidence(store, { ...value, deliveries: [...value.deliveries] }));
    return { basis: { project, packet: value.packet, call: value.call, response: value.response }, deliveries: [...value.deliveries], data: proof.data as Json[] };
  });
}

export interface PartAssemblyRequest { project: string; results: Ref[] }
export interface PartAssemblyRecord { project: string; results: Ref[]; proposal: Ref; works?: WorksPartBindings }
export const PART_ASSEMBLY_KIND = 'om-part-assembly';
const definitionSections = ['nodes', 'localConnectors', 'artifacts', 'contracts', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers', 'anchors'] as const;
function requireAssembly(store: Store, value: unknown): asserts value is PartAssemblyRequest {
  if (!(store instanceof Store) || !object(value) || !text(value.project) || !Array.isArray(value.results)
    || !value.results.length || !value.results.every(isRef) || !exactKeys(value, ['project', 'results'])) invalid('parts');
}
/**
 * The one derivation of a node assembly from its exact part results. `current` prepares a new assembly (a pending
 * proposal, its frame preparation and the final guards); `saved` names the stored proposal of an already saved assembly
 * (S1.1, №1863): it is read at that exact reference, compared with the derivation, and the frame is proved on the
 * original source — never on a fresh view that would derive the same history again on every path to the assembly.
 * Without either (the check of a failed assembly whose proposal was never written) the pending view stays.
 */
function deriveAssembly(store: Store, request: PartAssemblyRequest, current: boolean, saved: Ref | null = null) {
  const parts = request.results.map(record => take(readPartResult(store, { project: request.project, record })));
  const packets = parts.map(part => take(readQuestionPacket(store, { project: request.project, record: part.record.value.request.packet })));
  const first = packets[0]!, last = packets.at(-1)!, plan = last.value.plan;
  const worksContract = parts[0]!.proposal.value.worksContract;
  const works = parts.at(-1)!.record.value.works;
  if (worksContract !== undefined && (worksContract !== WORKS_FRAME_CONTRACT || parts[0]!.proposal.value.level !== 3))
    fail('model_parts_invalid', first.id, 'worksContract', 'A works assembly requires the supported L3 proposal contract', reference(first));
  if ((worksContract !== undefined) !== (works !== undefined))
    fail('model_parts_invalid', first.id, 'works', 'A works assembly retains the checked final part handoff', reference(first));
  const root = (packet: QuestionPacketRecord) => {
    const { previous: _previous, continuation: _continuation, correction: _correction, ...rest } = packet.request; return rest;
  };
  if (!plan || plan.assignments.length !== parts.length || new Set(request.results.map(canonical)).size !== parts.length)
    fail('model_parts_invalid', request.project, 'results', 'A node assembly contains every assigned part exactly once');
  const allAssigned = plan.assignments.flatMap(item => item.obligations);
  if (new Set(allAssigned).size !== allAssigned.length)
    fail('model_parts_invalid', request.project, 'assignments', 'Part assignments do not overlap');
  for (let index = 0; index < parts.length; index++) {
    const packet = packets[index]!, proposal = parts[index]!.proposal.value, payload = packet.value.packet;
    const transfer = parts[index]!.record.value.works;
    if (works ? !transfer || transfer.contract !== works.contract || !same(transfer.producer, works.producer)
      || !same(transfer.ledger, works.ledger) || (index < parts.length - 1 && transfer.bindings.length !== 0)
      : transfer !== undefined)
      fail('model_parts_invalid', packet.id, 'works', 'Every work part must retain one exact handoff; only the final part supplies bindings', reference(packet));
    const prefix = parts.slice(0, index).map((part, prior) => ({ packet: reference(packets[prior]!),
      proposal: reference(part.proposal), result: reference(part.record) }));
    if (!object(payload) || payload.task !== 'node-expansion' || !same(root(packet.value as QuestionPacketRecord), root(first.value as QuestionPacketRecord))
      || !packet.value.plan || !same(packet.value.plan.assignments, plan.assignments) || packet.value.plan.position !== index
      || !same(packet.value.request.previous, prefix) || !same(proposal.base, parts[0]!.proposal.value.base)
      || proposal.level !== parts[0]!.proposal.value.level || proposal.worksContract !== worksContract
      || packet.value.packetContract !== first.value.packetContract || packet.value.answerProtocol !== first.value.answerProtocol)
      fail('model_parts_invalid', packet.id, 'chain', 'Parts must be consecutive results of one exact node assignment', reference(packet));
    const assigned = new Set(plan.assignments[index]!.obligations);
    const covered = new Set([...proposal.fills, ...proposal.replaces].map(fill => fill.obligation));
    if (covered.size !== assigned.size || [...covered].some(id => !assigned.has(id)))
      fail('model_parts_invalid', packet.id, 'fills', 'Each part must fill exactly its assigned obligations before node assembly', reference(packet));
  }
  const definitions: Record<string, unknown[]> = {};
  for (const section of definitionSections) {
    const byId = new Map<string, unknown>();
    for (const part of parts) for (const definition of part.proposal.value[section]) {
      const previous = byId.get(definition.id);
      if (previous !== undefined && !same(previous, definition))
        fail('model_parts_conflict', definition.id, section, 'Части противоречат: one definition has different contents');
      byId.set(definition.id, definition);
    }
    definitions[section] = [...byId.values()];
  }
  const set = (name: 'removes' | 'redefines') => [...new Set(parts.flatMap(part => part.proposal.value[name]))];
  const body = take(normalizePartAnswer({ ...definitions, fills: parts.flatMap(part => part.proposal.value.fills),
    replaces: parts.flatMap(part => part.proposal.value.replaces), removes: set('removes'), redefines: set('redefines') }, worksContract));
  const proposalValue: LayerProposal = { base: parts[0]!.proposal.value.base as LayerProposal['base'], level: parts[0]!.proposal.value.level,
    source: 'input', status: 'proposed', ...body as PartProposalBody, ...(worksContract ? { worksContract } : {}) };
  const key = hashJson(request), proposal: Revision<LayerProposal> = { id: `om-proposal:${request.project}:assembly:${key}`,
    kind: 'layer-proposal', revision: 1, hash: hashJson(proposalValue), value: proposalValue };
  const value: PartAssemblyRecord = { ...request, proposal: reference(proposal), ...(works ? { works: works as WorksPartBindings } : {}) };
  const record: Revision<PartAssemblyRecord> = { id: `om-part-assembly:${request.project}:${key}`, kind: PART_ASSEMBLY_KIND,
    revision: 1, hash: hashJson(value), value };
  const routes = take(readRoutes(store, { project: request.project, record: first.value.request.routes }));
  const source = proposalValue.level === 2 ? routes.record.value.request.gaps.sources.operations : routes.record.value.request.gaps.sources.works;
  if ('state' in source) fail('model_parts_invalid', record.id, 'frame', 'The assigned frame must have its accepted upper source');
  const write: Write = { id: proposal.id, kind: proposal.kind, expected: 0, value: proposal.value };
  const proposalRequest = { frame: source.frame, proposals: [...source.proposals, reference(proposal)] };
  let view = store;
  if (saved) {
    if (!same(saved, reference(proposal)))
      fail('model_parts_invalid', record.id, 'proposal', 'A saved assembly names exactly the proposal its parts assemble', saved);
    const standing = take(readRecord<LayerProposal>(store, saved, { unit: 'E4', target: record.id, id: proposal.id, kind: 'layer-proposal' }));
    if (!same(standing, proposal)) fail('model_parts_invalid', record.id, 'proposal', 'The stored proposal must equal the verified assembly', saved);
  } else view = pendingCallStore(store, [write]);
  const historical = take(readFrameProposals(view, proposalRequest));
  const remaining = new Set(historical.result.open.map(item => item.id));
  if (allAssigned.some(id => remaining.has(id))) fail('model_parts_invalid', record.id, 'coverage', 'The assembled proposal leaves an assigned obligation open');
  const prepared = current ? take(prepareFrameProposals(view, proposalRequest)) : null;
  const packetAdmission = current && works ? take(prepareQuestionPacket(store, last.value.request as QuestionPacketRequest)) : null;
  if (packetAdmission && (packetAdmission.writes.length || !same(packetAdmission.record, last)))
    fail('model_parts_invalid', last.id, 'works', 'Assembly requires the current saved assignment and handoff, without producing another packet', reference(last));
  return { record, proposal, references: refs([...parts.flatMap(part => part.references), ...historical.references,
    ...packets.map(reference)]), guards: prepared ? externalGuards([...prepared.guards.filter(ref => ref.id !== proposal.id),
      ...(packetAdmission?.guards ?? [])], []) : [] };
}
export function readPartAssembly(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<{
  record: Revision<PartAssemblyRecord>; proposal: Revision<LayerProposal>; references: Ref[];
}>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('assembly.read');
  // NR (№3600): a trusted read — assembleModelParts derived the assembly and its proposal from the part chain once.
  return result(() => historicalRead(store, { reader: 'E4.part-assembly', project: request.project, ref: request.record }, () => {
    const saved = take(readRecord<PartAssemblyRecord>(store, request.record, { unit: 'E4', target: request.record.id,
      idPrefix: `om-part-assembly:${request.project}:`, kind: PART_ASSEMBLY_KIND })) as Revision<PartAssemblyRecord>;
    const proposal = take(readRecord<LayerProposal>(store, saved.value.proposal as Ref, { unit: 'E4', target: saved.id,
      id: (saved.value.proposal as Ref).id, kind: 'layer-proposal' })) as Revision<LayerProposal>;
    return { record: saved, proposal, references: refs([reference(saved), reference(proposal), ...(saved.value.results as Ref[])]) };
  }, () => fail('model_parts_invalid', request.record.id, 'history', 'An assembly cannot derive through itself', request.record)));
}
export function assembleModelParts(store: Store, request: PartAssemblyRequest): ModelCallResult<Sealed<{
  record: Revision<PartAssemblyRecord>; proposal: Revision<LayerProposal>; references: Ref[];
}>> {
  requireAssembly(store, request); request = sealed(request) as PartAssemblyRequest;
  return result(() => {
    const id = `om-part-assembly:${request.project}:${hashJson(request)}`, old = store.get(id);
    if (old) {
      const saved = take(readPartAssembly(store, { project: request.project, record: reference(old) }));
      const first = take(readPartResult(store, { project: request.project, record: request.results[0]! }));
      const admitted = take(readCall(store, request.project, first.record.value.request.call));
      const binding = take(readCompletionBinding(store, request.project, admitted.value.series, admitted.value.attempt));
      if (binding) {
        const update = take(prepareCompletionProducts(store, reference(binding), [reference(saved.record)]));
        if (update.writes.length) take(writeGuarded(store, { unit: 'E4', target: id,
          writes: update.writes as Write[], guards: update.guards as TransactionGuard[] }));
      }
      return saved;
    }
    const prepared = deriveAssembly(store, request, true);
    const writes: Write[] = [prepared.proposal, prepared.record]
      .map(record => ({ id: record.id, kind: record.kind, expected: 0, value: record.value }));
    const guards: TransactionGuard[] = [...prepared.guards];
    const first = take(readPartResult(store, { project: request.project, record: request.results[0]! }));
    const admitted = take(readCall(store, request.project, first.record.value.request.call));
    const binding = take(readCompletionBinding(store, request.project, admitted.value.series, admitted.value.attempt));
    if (binding) {
      const update = take(prepareCompletionProducts(pendingCallStore(store, writes), reference(binding), [reference(prepared.record)]));
      writes.push(...update.writes as Write[]); guards.push(...update.guards);
    }
    take(writeGuarded(store, { unit: 'E4', target: id, guards, writes }));
    return { record: prepared.record, proposal: prepared.proposal, references: prepared.references };
  });
}



export interface ModelCycleRecord {
  request: ModelCallRequest;
  steps: { packet: Ref; record: Ref }[];
  results: Ref[];
  assembly: Ref | null;
  next: Ref | null;
  diagnostic: Ref | null;
  terminal: 'outcome' | 'assembled' | 'blocked' | 'parts-invalid' | 'research-no-progress' | 'reads-invalid';
  /** MP2 (№2968 §4): a cycle of a brief chain begun after MP2; a saved cycle without it keeps its era's transitions. */
  cyclePolicy?: typeof CYCLE_POLICY;
}
export const CYCLE_POLICY = 'brief-correction/v1' as const;
export interface ModelCycleOutcome {
  record: Revision<ModelCycleRecord>; last: ModelCallOutcome; assembly: Ref | null; diagnostic: Ref | null; repeated: boolean;
}
export const MODEL_CYCLE_KIND = 'om-model-cycle';
const cycleId = (request: ModelCallRequest) => `om-model-cycle:${request.project}:${hashJson(request)}`;
/** LP3: the pass finds a saved cycle of its exact request without performing anything. */
export function modelCycleId(request: ModelCallRequest): string { return cycleId(request); }
function knowledgeOf(store: Store, value: Json): string[] {
  if (!object(value) || !object(value.read) || !Array.isArray(value.questionIds) || !Array.isArray(value.sources)) invalid('knowledge');
  const read = value.read as unknown as PacketRead;
  const sourceAddress = (ref: Ref) => {
    const record = store.get<Source>(ref.id, ref.revision);
    if (!record || !same(reference(record), ref)) fail('model_delivery_invalid', ref.id, 'source', 'Knowledge needs its exact captured source');
    return record.kind === 'source' ? { origin: record.value.origin, media: record.value.mediaType } : { record: record.id };
  };
  const address = read.action === 'read_source' ? { action: read.action, source: sourceAddress(read.source), selector: read.selector }
    : read.action === 'read_context' ? { action: read.action, record: read.record.id, pointer: read.pointer }
    : read.action === 'search' ? { action: read.action, within: typeof read.within === 'string' ? read.within : sourceAddress(read.within), query: read.query }
    : read;
  const data = read.action === 'search' && Array.isArray(value.data) ? value.data.map(item => {
    if (!object(item) || !isRef(item.source)) invalid('search.data');
    return { ...item, source: sourceAddress(item.source) };
  }) : value.data;
  return value.questionIds.map(question => hashJson({ question, address, data }));
}
/** MP2 (№2968 §3.4): whether a chain already spent its one correction — through any continuation, correction or earlier
 * part of its ancestry. Several paths to one old correction are one spent round. */
function correctionUsed(store: Store, project: string, packet: Revision<QuestionPacketRecord>): boolean {
  const seen = new Set<string>(), stack = [packet];
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const request = row.value.request;
    if (request.correction) return true;
    for (const ref of [...(request.continuation ? [request.continuation.packet] : []), ...request.previous.map(item => item.packet)])
      stack.push(take(readQuestionPacket(store, { project, record: ref })) as Revision<QuestionPacketRecord>);
  }
  return false;
}
export interface CorrectionGround { packet: Ref; call: Ref; response: Ref; diagnostic: Ref }
export type CorrectionDecision = { eligible: true; refusal: Refusal; raw: string; references: Ref[] } | { eligible: false };
/**
 * MP2 (№2968 §3): the one ground of a correction — the saved answer of an applied call of a brief chain whose E3 refusal,
 * proved again by the common historical E3 on that same raw, is exactly the recorded failure with its derived diagnostic,
 * belongs to MP1's closed repairable class and stands in an open managed chain that has not spent its correction. The cycle producer, the
 * cycle reader, the packet derivation and the completion snapshot decide by this same derivation; neither the answer nor
 * a caller grants it. A refusal of transport, admission, freshness, reads or assembly is no such ground.
 */
export function correctionGround(store: Store, project: string, ground: CorrectionGround): CorrectionDecision {
  const packet = take(readQuestionPacket(store, { project, record: ground.packet })) as Revision<QuestionPacketRecord>;
  const payload = packet.value.packet, requestId = object(payload) ? payload.requestId : undefined;
  if (!briefContract(packet.value.packetContract) || packet.value.state !== 'ready' || !text(requestId)) return { eligible: false };
  // Only a managed attempt stays open past a diagnostic: a standalone finish closes its attempt, nothing is left to correct.
  const attempt = packet.value.request.attempt;
  if (!attempt || !take(readCompletionBinding(store, project, attempt.series, attempt.ordinal))) return { eligible: false };
  const head = store.get<OmModelCall>(modelCallRecordId(project, requestId));
  if (!head) return { eligible: false };
  const state = take(readModelCallState(store, { project, record: reference(head) }));
  if (state.state !== 'applied') return { eligible: false };
  const outcome = state.outcome, failure = outcome.record.value.om.failure, exchange = outcome.record.value.om.exchange;
  if (!same(outcome.packet, ground.packet) || !same(outcome.call, ground.call) || !same(outcome.response, ground.response)
    || !same(outcome.diagnostic, ground.diagnostic) || outcome.part !== null || outcome.outcome !== null || !failure || !exchange
    || !briefAnswerRepairable(failure.code, failure.at.field ?? '')) return { eligible: false };
  if (correctionUsed(store, project, packet)) return { eligible: false };
  const response = take(readPacketResponse(store, { project, packet: ground.packet, call: ground.call, response: ground.response }));
  const raw = response.record.value.raw;
  const historical = checkAnswerForm(store, { project, packet: ground.packet, raw });
  if (historical.ok || !same(historical.refusal, failure)) return { eligible: false };
  const finish = prepareModelFinish(store, { project, packet: ground.packet, call: ground.call, response: ground.response,
    reason: 'off-form', code: failure.code, message: failure.message, evidence: [exchange] });
  if (!same(finish.diagnostic, ground.diagnostic)) return { eligible: false };
  return { eligible: true, refusal: failure, raw, references: refs([ground.packet, ground.call, ground.response, ground.diagnostic, reference(head)]) };
}
/** The same decision for E2, as a typed result of this module. */
export function readCorrectionGround(store: Store, project: string, ground: CorrectionGround): ModelCallResult<Sealed<CorrectionDecision>> {
  return result(() => correctionGround(store, project, ground));
}
/** MP2: the correctable ground of an applied call, when it has one. */
function callCorrection(store: Store, project: string,
  call: { packet: Ref; call: Ref; response: Ref | null; diagnostic: Ref | null; part: unknown; outcome: unknown }): CorrectionGround | null {
  if (!call.diagnostic || !call.response || call.part !== null || call.outcome !== null) return null;
  const ground = { packet: call.packet, call: call.call, response: call.response, diagnostic: call.diagnostic };
  return correctionGround(store, project, ground).eligible ? ground : null;
}
/**
 * MP2 (№3147): an applied call whose chain still owes its correction in this exact registry — the ground is proved and no
 * call of a packet naming it is among the products. Like an addressed source request, it is the remaining branch of its
 * step: the step is ceased with that remainder, keeping the paid answer, its diagnostic and its expense. A correction packet
 * the registry holds is owed only while unclaimed: a dispatched correction resolves through its own physical outcome and is
 * never declared undispatched; the claim addresses are returned for a cessation to keep absent until it commits.
 */
function owedCorrection(store: Store, project: string, products: readonly Ref[],
  call: { packet: Ref; call: Ref; response: Ref | null; diagnostic: Ref | null; part: unknown; outcome: unknown }): { claims: string[] } | null {
  const ground = callCorrection(store, project, call);
  if (!ground) return null;
  const claims = new Set<string>();
  for (const ref of products) {
    const row = store.get<{ packet?: unknown }>(ref.id, ref.revision);
    if (row?.kind === 'model-call') {
      const state = take(readModelCallState(store, { project, record: ref }));
      const record = state.state === 'running' || state.state === 'received' ? state.record : state.outcome.record;
      if (same(take(readQuestionPacket(store, { project, record: record.value.om.request.packet })).value.request.correction ?? null, ground)) return null;
      continue;
    }
    const packet = row?.kind === 'question-packet' ? ref : row?.kind === COMPLETION_PACKET_KIND && isRef(row.value.packet) ? row.value.packet : null;
    const source = packet ? store.get<QuestionPacketRecord>(packet.id, packet.revision)?.value : undefined;
    if (source?.state === 'ready' && same(source.request.correction ?? null, ground))
      claims.add(modelRecordId(project, (source.packet as { requestId: string }).requestId));
  }
  for (const claim of claims) if (store.get(claim)) fail('completion_claim_exists', claim, 'claim', 'A dispatched correction resolves through its own physical outcome');
  return { claims: [...claims] };
}
/**
 * MP3 (№2981 п.3): a fact the model could see. Sources keep the existing knowledge identity (origin and media), so an unchanged
 * recapture adds nothing and a changed content does; text is known by UTF-16 coverage, JSON by value or parent shape.
 */
type Fact =
  | { kind: 'text'; address: string; start: number; end: number; text: string }
  | { kind: 'length'; address: string; length: number }
  | { kind: 'capacity'; address: string; originalHash: string; start: number; end: number;
      unit: 'items' | 'utf16'; fragment: string | unknown[]; sourceContent: string | null }
  | { kind: 'value'; address: string; path: string[]; value: unknown; content: string | null }
  | { kind: 'shape'; address: string; path: string[]; shape: Json; content: string | null }
  | { kind: 'absent'; query: string; within: string | null; scope: { address: string; content: string }[] };
interface DeliveredRow { delivery?: Ref; read: PacketRead; sources: Ref[]; data: Json }
function knownRecord(store: Store, ref: unknown): Revision<Source> {
  const record = isRef(ref) ? store.get<Source>(ref.id, ref.revision) : undefined;
  if (!record || !same(reference(record), ref)) fail('model_delivery_invalid', isRef(ref) ? ref.id : 'knowledge', 'source', 'Knowledge needs its exact captured source');
  return record;
}
const knowledgeAddress = (record: Revision<Source>) => record.kind === 'source'
  ? canonical({ origin: record.value.origin, media: record.value.mediaType }) : canonical({ record: record.id });
function servedFacts(store: Store, row: DeliveredRow): Fact[] {
  const read = row.read;
  if (object(row.data) && row.data.contract === OM_CAPACITY_DELIVERY_CONTRACT) {
    const ref = row.delivery;
    const saved = ref && store.get<ReadDeliveryRecord>(ref.id, ref.revision);
    if (!ref || !saved || saved.kind !== READ_DELIVERY_KIND || !same(reference(saved), ref)
      || !same(saved.value.read, read) || !same(saved.value.sources, row.sources)) invalid('knowledge.data');
    const original = { record: ref, pointer: '/data', value: saved.value.data,
      packet: saved.value.packet, call: saved.value.call, response: saved.value.response, delivery: ref };
    try { requireOmCapacityDelivery(original, row.data); } catch { invalid('knowledge.data'); }
    const fragment = row.data as unknown as OmCapacityDelivery;
    if (!same(fragment.original.packet, original.packet) || !same(fragment.original.call, original.call)
      || !same(fragment.original.response, original.response) || !same(fragment.original.delivery, ref)) invalid('knowledge.data');
    const record = read.action === 'read_source' ? knownRecord(store, read.source)
      : read.action === 'read_context' ? knownRecord(store, read.record)
      : read.action === 'read' ? knownRecord(store, row.sources[0]) : null;
    const address = record ? knowledgeAddress(record) : canonical({ read, sources: row.sources });
    return [{ kind: 'capacity', address, originalHash: fragment.original.valueHash,
      start: fragment.served.offset, end: fragment.served.end, unit: fragment.served.unit,
      fragment: fragment.encoding === 'json-string-fragment' ? fragment.text! : fragment.value as string | unknown[],
      sourceContent: record?.kind === 'source' ? record.value.content : null }];
  }
  if (read.action === 'read_source' || read.action === 'read_context') {
    const record = knownRecord(store, read.action === 'read_source' ? read.source : read.record), address = knowledgeAddress(record);
    if (!object(row.data) || row.data.contract !== READ_RESULT_CONTRACT) invalid('knowledge.data');
    const data = row.data as unknown as ReadResult;
    // OBL1 (№3768, №3773, №3780): a read shown as too large is known by its length, a value by its shape at its pointer,
    // and the refusal itself: the first one is news to its reader, the same one again is not.
    if (data.outcome === 'too-large') {
      const { contract: _contract, outcome: _outcome, requested, length, limit: _limit, matches: _matches, ...shape } = data;
      return [...('pointer' in requested ? [{ kind: 'shape' as const, address, path: pointerSegments(requested.pointer)!.decoded,
        content: read.action === 'read_source' ? record.value.content : null, shape: shape as unknown as Json }]
        : [{ kind: 'length' as const, address, length }]), tooLargeFact(address, data)];
    }
    if ('length' in data) return [{ kind: 'length', address, length: data.length },
      ...(data.served ? [{ kind: 'text' as const, address, start: data.served.start, end: data.served.end, text: data.text! }] : [])];
    const content = read.action === 'read_source' ? record.value.content : null;
    if (data.outcome === 'complete') return [{ kind: 'value', address, path: pointerSegments(data.requested.pointer)!.decoded, value: data.value, content }];
    const { pointer, ...shape } = data.parent;
    return [{ kind: 'shape', address, path: pointerSegments(pointer)!.decoded, content, shape: shape as unknown as Json }];
  }
  if (read.action === 'read') {
    const record = knownRecord(store, row.sources[0]), address = knowledgeAddress(record);
    if (object(row.data) && row.data.outcome === 'too-large')
      return [{ kind: 'length', address, length: record.value.content.length }, tooLargeFact(address, row.data as unknown as ReadTooLarge)];
    return [{ kind: 'length', address, length: record.value.content.length },
      { kind: 'text', address, start: 0, end: record.value.content.length, text: record.value.content }];
  }
  return searchFacts(store, row as DeliveredRow & { read: Extract<PacketRead, { action: 'search' }> });
}
/**
 * The facts of one search delivery: its found lines, or "no match" for its query over its exact scope. The query semantics
 * (today the engine's literal search, №60) stay with the search delivery itself; a later semantics changes only this reading.
 */
function searchFacts(store: Store, row: DeliveredRow & { read: Extract<PacketRead, { action: 'search' }> }): Fact[] {
  const read = row.read;
  // OBL1 (№3773): a search too large to carry is known by its match count over its exact scope.
  if (object(row.data) && row.data.outcome === 'too-large') {
    const address = canonical({ search: read.query.toLowerCase(), within: read.within, scope: row.sources } as unknown as Json);
    return [{ kind: 'shape', address, path: [], shape: { type: 'array', keys: [], length: row.data.matches as number } as unknown as Json, content: null },
      tooLargeFact(address, row.data as unknown as ReadTooLarge)];
  }
  if (!Array.isArray(row.data)) invalid('search.data');
  // A search over a workspace path keeps its path: an existing empty directory has no source to cover (Codex-omg №3171).
  const within = typeof read.within === 'string' ? posix.normalize(read.within).replace(/\/+$/, '') : null;
  if (!row.data.length) return [{ kind: 'absent', query: read.query.toLowerCase(), within, scope: row.sources.map(ref => {
    const record = knownRecord(store, ref); return { address: knowledgeAddress(record), content: record.value.content };
  }).sort((a, b) => compareJson(a, b)) }];
  return row.data.map(item => {
    if (!object(item) || !Number.isSafeInteger(item.line) || typeof item.text !== 'string') invalid('search.data');
    const record = knownRecord(store, item.source), content = record.value.content;
    let start = 0;
    for (let line = 1; line < (item.line as number); line++) start = content.indexOf('\n', start) + 1;
    return { kind: 'text' as const, address: knowledgeAddress(record), start, end: start + (item.text as string).length, text: item.text as string };
  });
}
/** Everything the exact packet showed: catalogue lengths and quoted material, included carried reads, this chain's deliveries. */
function visibleFacts(store: Store, payload: Record<string, any>, readings: BriefReadings): Fact[] {
  const facts: Fact[] = [];
  for (const row of payload.brief.manifest as BriefManifest[]) {
    const record = knownRecord(store, row.source), address = knowledgeAddress(record);
    facts.push({ kind: 'length', address, length: row.length });
    if (row.completeness === 'whole') facts.push({ kind: 'text', address, start: 0, end: row.length, text: record.value.content });
  }
  for (const entry of readings.entries) if (entry.decision.state === 'included') facts.push(...servedFacts(store, entry as unknown as DeliveredRow));
  for (const item of Array.isArray(payload.sourceDeliveries) ? payload.sourceDeliveries : [])
    for (const row of Array.isArray(item?.data) ? item.data : []) facts.push(...servedFacts(store, row as DeliveredRow));
  return facts;
}
function covered(known: readonly Fact[], address: string, start: number, end: number, text: string): boolean {
  const pieces = known.flatMap(item => {
    if (item.kind !== 'text' || item.address !== address) return [];
    const from = Math.max(start, item.start), to = Math.min(end, item.end);
    return from < to && item.text.slice(from - item.start, to - item.start) === text.slice(from - start, to - start) ? [[from, to] as const] : [];
  }).sort((a, b) => a[0] - b[0]);
  let reach = start;
  for (const [from, to] of pieces) { if (from > reach) break; reach = Math.max(reach, to); }
  return reach >= end;
}
function knownFact(known: readonly Fact[], fact: Fact): boolean {
  if (fact.kind === 'length') return known.some(item => item.kind === 'length' && item.address === fact.address && item.length === fact.length);
  if (fact.kind === 'text') return covered(known, fact.address, fact.start, fact.end, fact.text);
  if (fact.kind === 'capacity') {
    if (fact.sourceContent !== null && covered(known, fact.address, 0, fact.sourceContent.length, fact.sourceContent)) return true;
    return known.some(item => {
      if (item.kind !== 'capacity' || item.address !== fact.address || item.originalHash !== fact.originalHash
        || item.unit !== fact.unit || item.start > fact.start || item.end < fact.end) return false;
      const from = fact.start - item.start, to = fact.end - item.start;
      return same(item.fragment.slice(from, to), fact.fragment);
    });
  }
  // No match over sources the model saw whole, or the same search seen before. An empty directory holds no text to have
  // seen: its emptiness is known only from an earlier delivery of that same path, whatever its query.
  if (fact.kind === 'absent') return !fact.scope.length
    ? known.some(item => item.kind === 'absent' && !item.scope.length && item.within === fact.within)
    : known.some(item => item.kind === 'absent' && item.query === fact.query && same(item.scope, fact.scope))
      || fact.scope.every(row => covered(known, row.address, 0, row.content.length, row.content));
  if (fact.content !== null && covered(known, fact.address, 0, fact.content.length, fact.content)) return true;
  if (fact.kind === 'shape' && known.some(item => item.kind === 'shape' && item.address === fact.address && same(item.path, fact.path) && same(item.shape, fact.shape))) return true;
  // A delivered value answers every pointer below it: its sub-value or the shape of a reached parent.
  return known.some(item => {
    if (item.kind !== 'value' || item.address !== fact.address || item.path.length > fact.path.length
      || item.path.some((segment, index) => segment !== fact.path[index])) return false;
    let current = item.value;
    for (const key of fact.path.slice(item.path.length)) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
      current = (current as Record<string, unknown>)[key];
    }
    return fact.kind === 'value' ? same(current, fact.value) : same(jsonShape(current), fact.shape);
  });
}
function addsAddressedKnowledge(store: Store, payload: Record<string, any>, readings: BriefReadings, data: readonly Json[]): boolean {
  const known = visibleFacts(store, payload, readings);
  return data.some(row => servedFacts(store, row as unknown as DeliveredRow).some(fact => !knownFact(known, fact)));
}
/** OBL1 (№3780): that this exact read was refused as too large to show — news once, a repeat after. */
const tooLargeFact = (address: string, data: ReadTooLarge): Fact => ({ kind: 'shape', address,
  path: ['#too-large', canonical(data.requested as unknown as Json)], shape: { limit: data.limit } as unknown as Json, content: null });
/** OBL1 (№3780): the continuation the cycle wrote for this source request showed nothing new — its own no-progress end. */
function shownRepeat(store: Store, project: string, set: ContinuationEvidenceRequest): boolean {
  const prior = take(readQuestionPacket(store, { project, record: set.packet })).value;
  const { continuation: _continuation, correction: _correction, ...base } = prior.request;
  return take(shownNoProgress(store, { ...base, previous: [...base.previous],
    continuation: { packet: set.packet, call: set.call, response: set.response, deliveries: [...set.deliveries] } }));
}
/** Whether delivered rows add what the reader of `packet` did not see yet (OBL1: also for the rows a continuation shows). */
export function addsKnowledge(store: Store, packet: QuestionPacketRecord, data: readonly Json[]): boolean {
  const readings = briefReadings(packet.packet);
  if (readings) return addsAddressedKnowledge(store, packet.packet as Record<string, any>, readings, data);
  const payload = packet.packet as Record<string, Json>;
  const delivered = Array.isArray(payload.sourceDeliveries) ? payload.sourceDeliveries.flatMap(item =>
    object(item) && Array.isArray(item.data) ? item.data as Json[] : []) : [];
  const previous = new Set(delivered.flatMap(value => knowledgeOf(store, value)));
  return data.flatMap(value => knowledgeOf(store, value)).some(value => !previous.has(value));
}
function cycleSources(store: Store, project: string, value: ModelCycleRecord): ModelCallOutcome {
  const policy = object(value) && Object.hasOwn(value, 'cyclePolicy');
  if (!object(value) || !object(value.request) || value.request.project !== project || !Array.isArray(value.steps)
    || !value.steps.length || !Array.isArray(value.results) || !value.results.every(isRef)
    || !exactKeys(value, ['request', 'steps', 'results', 'assembly', 'next', 'diagnostic', 'terminal', ...(policy ? ['cyclePolicy'] : [])])
    || ![value.assembly, value.next, value.diagnostic].every(ref => ref === null || isRef(ref))
    || !value.steps.every(step => object(step) && isRef(step.packet) && isRef(step.record)))
    fail('model_delivery_invalid', project, 'cycle', 'A cycle retains its physical dispatches and exact results');
  // MP2 (№2968 §4): the marker is known, belongs only to a brief chain, and only it admits a correction edge.
  if (policy && (value.cyclePolicy !== CYCLE_POLICY
    || !briefContract(take(readQuestionPacket(store, { project, record: value.request.packet })).value.packetContract)))
    fail('model_delivery_invalid', project, 'cyclePolicy', 'Only a brief chain carries the known correction policy');
  const calls = value.steps.map(step => take(readModelCall(store, { project, record: step.record })));
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!, step = value.steps[i]!;
    if (!same(call.record.value.om.request, { ...value.request, packet: step.packet })
      || !same(call.packet, step.packet) || i === 0 && !same(step.packet, value.request.packet))
      fail('model_delivery_invalid', step.record.id, 'packet', 'The physical call must belong to this exact cycle packet');
    const packet = take(readQuestionPacket(store, { project, record: step.packet }));
    if (i > 0) {
      const prior = calls[i - 1]!, priorStep = value.steps[i - 1]!;
      if (prior.outcome?.kind === 'need-source') {
        const c = packet.value.request.continuation;
        if (!c || !same(c.packet, priorStep.packet) || !same(c.call, prior.call) || !same(c.response, prior.response))
          fail('model_delivery_invalid', step.record.id, 'continuation', 'The next physical call must derive from the prior source request');
        const evidence = take(readContinuationEvidence(store, { project, ...c, deliveries: [...c.deliveries] }));
        if (!evidence.novel)
          fail('model_delivery_invalid', step.record.id, 'continuation', 'Repeated knowledge terminates this cycle before another call');
      } else if (prior.part) {
        const previous = packet.value.request.previous.at(-1);
        if (!previous || packet.value.request.correction || !same(previous, { packet: priorStep.packet, ...prior.part }))
          fail('model_parts_invalid', step.record.id, 'previous', 'The next part must follow this prior result');
      } else if (policy && packet.value.request.correction) {
        // MP2: the one correction edge — exactly the prior rejected step, by the common ground of the producer.
        if (!same(packet.value.request.correction, { packet: priorStep.packet, call: prior.call, response: prior.response, diagnostic: prior.diagnostic })
          || !callCorrection(store, project, prior))
          fail('model_delivery_invalid', step.record.id, 'correction', 'A correction follows only the proved correctable refusal of its prior step');
      } else fail('model_delivery_invalid', step.record.id, 'cycle', 'A terminal response does not start another call automatically');
    }
  }
  const results = calls.flatMap(call => call.part ? [call.part.result] : []);
  if (!same(results, value.results)) fail('model_parts_invalid', project, 'results', 'The cycle names exactly its produced part results');
  const last = calls.at(-1)!;
  let completion: { code: string; message: string; evidence: Ref[] } | null = null;
  if (value.terminal !== 'assembled' && value.assembly !== null || value.terminal !== 'blocked' && value.next !== null)
    fail('model_delivery_invalid', project, 'terminal', 'Only the corresponding terminal outcome can name an assembly or blocked successor');
  if (value.terminal === 'assembled') {
    if (!isRef(value.assembly)) fail('model_parts_invalid', project, 'assembly', 'Completed parts need their saved assembled proposal');
    const assembly = take(readPartAssembly(store, { project, record: value.assembly }));
    if (!same(assembly.record.value.results, results)) fail('model_parts_invalid', project, 'assembly', 'The assembly uses exactly this cycle');
  } else if (value.terminal === 'blocked') {
    if (!isRef(value.next))
      fail('model_delivery_invalid', project, 'next', 'Overflow needs its saved blocked packet');
    const next = take(readQuestionPacket(store, { project, record: value.next }));
    const prior = take(readQuestionPacket(store, { project, record: last.packet }));
    let expected: QuestionPacketRequest;
    if (last.outcome?.kind === 'need-source' && last.response) {
      const basis = { project, packet: last.packet, call: last.call, response: last.response };
      const set = store.get<ContinuationEvidenceRequest>(deliverySetId(basis));
      if (!set || set.kind !== DELIVERY_SET_KIND) fail('model_delivery_invalid', project, 'deliveries', 'A blocked continuation needs its deliveries');
      take(readContinuationEvidence(store, set.value));
      const { correction: _correction, ...base } = prior.value.request;
      expected = { ...base, previous: [...base.previous],
        continuation: { packet: last.packet, call: last.call, response: last.response, deliveries: [...set.value.deliveries] } };
    } else if (last.part) {
      const { continuation: _continuation, correction: _correction, ...root } = prior.value.request;
      expected = { ...root, previous: [...root.previous, { packet: last.packet, ...last.part }] };
    } else if (policy && callCorrection(store, project, last)) {
      const { continuation: _continuation, correction: _correction, ...root } = prior.value.request;
      expected = { ...root, previous: [...root.previous],
        correction: { packet: last.packet, call: last.call, response: last.response!, diagnostic: last.diagnostic! } };
    } else fail('model_delivery_invalid', project, 'next', 'Only a source request, completed part or correctable refusal can have a successor');
    if (next.value.state !== 'blocked' || !same(next.value.request, expected) || !next.value.refusal)
      fail('model_delivery_invalid', project, 'next', 'Overflow belongs to this exact cycle successor');
    completion = { code: next.value.refusal.code, message: next.value.refusal.message, evidence: [value.next] };
  } else if (value.terminal === 'parts-invalid') {
    const assembled = result(() => deriveAssembly(store, { project, results }, false));
    if (assembled.ok)
      fail('model_parts_invalid', project, 'terminal', 'Valid parts cannot stand for a failed assembly');
    completion = { code: assembled.refusal.code, message: assembled.refusal.message, evidence: results };
  } else if (value.terminal === 'reads-invalid') {
    if (!last.response || last.outcome?.kind !== 'need-source')
      fail('model_delivery_invalid', project, 'terminal', 'An unperformable read needs an actual source request');
    const issue = readsIssue(store, { project, packet: last.packet, call: last.call, response: last.response });
    if (!issue) fail('model_delivery_invalid', project, 'terminal', 'Performable reads cannot stand for an unperformable one');
    completion = { code: issue.code, message: issue.message, evidence: [issue.ref] };
  } else if (value.terminal === 'research-no-progress') {
    if (!last.response || last.outcome?.kind !== 'need-source') fail('model_delivery_invalid', project, 'terminal', 'No progress needs an actual repeated read request');
    const request = { project, packet: last.packet, call: last.call, response: last.response };
    const set = store.get<ContinuationEvidenceRequest>(deliverySetId(request));
    if (!set || set.kind !== DELIVERY_SET_KIND) fail('model_delivery_invalid', project, 'deliveries', 'No progress needs the saved read results');
    const evidence = take(readContinuationEvidence(store, set.value));
    if (evidence.novel && !shownRepeat(store, project, set.value))
      fail('model_delivery_invalid', project, 'terminal', 'New delivered information cannot be declared a repeated read');
    completion = { code: 'research_no_progress', message: 'The addressed reads add no information to this attempt', evidence: set.value.deliveries };
  } else if (value.terminal !== 'outcome' || last.outcome?.kind === 'need-source' || last.part !== null) {
    fail('model_delivery_invalid', project, 'terminal', 'A nonterminal source/part response cannot end the cycle');
  } else if (policy && callCorrection(store, project, last)) {
    fail('model_delivery_invalid', project, 'terminal', 'A correctable refusal of a brief chain continues with its correction');
  }
  if (completion) {
    const finished = prepareModelFinish(store, { project, packet: last.packet, call: last.call, response: last.response,
      reason: 'refused', ...completion });
    if (finished.writes.length || !same(finished.diagnostic, value.diagnostic))
      fail('model_delivery_invalid', project, 'diagnostic', 'The cycle must retain its derived journal and completed attempt');
  } else if (!same(value.diagnostic, last.diagnostic))
    fail('model_delivery_invalid', project, 'diagnostic', 'A cycle retains the actual physical outcome diagnostic');
  return last as ModelCallOutcome;
}
export function readModelCycle(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<ModelCycleOutcome>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('cycle.read');
  return result(() => {
    const record = take(readRecord<ModelCycleRecord>(store, request.record, { unit: 'E4', target: request.record.id,
      idPrefix: `om-model-cycle:${request.project}:`, kind: MODEL_CYCLE_KIND }));
    if (!object(record.value) || !object(record.value.request) || record.revision !== 1
      || record.id !== cycleId(record.value.request as ModelCallRequest))
      fail('model_delivery_invalid', record.id, 'request', 'A cycle has one immutable exact request');
    const last = cycleSources(store, request.project, record.value as ModelCycleRecord);
    return { record: record as Revision<ModelCycleRecord>, last, assembly: record.value.assembly, diagnostic: record.value.diagnostic, repeated: true };
  });
}
/** A cycle cursor may be lost after all its products have already closed the attempt.
 * Restore only that cursor; closed work still admits no new products or assignments. */
function prepareCycleCompletion(store: Store, binding: Ref, cycle: Ref, value: ModelCycleRecord) {
  const products = [cycle, ...(value.assembly ? [value.assembly] : []), ...(value.diagnostic ? [value.diagnostic] : [])];
  const head = store.get<CompletionWork>(completionWorkId(value.request.project, binding.id));
  if (!head) fail('completion_invalid', binding.id, 'work', 'A cycle retains its original completion registry');
  const snapshot = take(readCompletionWorkAt(store, value.request.project, reference(head)));
  if (!same(reference(snapshot.binding), binding))
    fail('completion_foreign', cycle.id, 'binding', 'A cycle belongs to its exact completion owner');
  const selected = packetCompletionAssignments(store, snapshot.binding as Revision<CompletionOwner>, value.request.packet).selected;
  if (snapshot.cessations.some(row => take(readCompletionAssignmentAt(store, value.request.project, row.value.assignment)).value.batch === selected.value.batch))
    take(checkCompletionDisposition(store, { ...snapshot, work: { ...snapshot.work, value: { ...snapshot.work.value, closed: null } } },
      { batch: selected.value.batch, action: 'cycle' }));
  if (!snapshot.work.value.closed) return take(prepareCompletionProducts(store, binding, products));
  // readCompletionWorkAt proves the exact pre-close composition and the common G7 outcome.
  // The cursor itself is optional; every underlying terminal product must be in that composition.
  const sources = refs([...value.steps.map(step => step.record), ...products.slice(1)]);
  if (!sources.every(source => snapshot.products.some(product => same(product, source))))
    fail('completion_closed', cycle.id, 'products', 'Cycle recovery cannot add evidence to a closed attempt');
  return { writes: [] as Write[], guards: [reference(head), binding, ...sources] as TransactionGuard[] };
}
/** Continue only addressed source reads and assigned node parts; neither starts another A3 attempt. */
export async function runModelCycle(store: Store, request: ModelCallRequest, signal?: AbortSignal, control?: RunControlHold): Promise<ModelCallResult<Sealed<ModelCycleOutcome>>> {
  requireModelRequest(store, request);
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  if (control !== undefined && !object(control)) invalid('control');
  request = sealed(request) as ModelCallRequest;
  const id = cycleId(request), old = store.get(id);
  if (old) return result(() => {
    const saved = take(readModelCycle(store, { project: request.project, record: reference(old) }));
    // A terminal cycle is immutable, but late physical evidence may arrive after it.
    // Reconcile every admitted dispatch through the same step as a direct replay.
    for (const step of saved.record.value.steps) {
      const call = same(step.record, reference(saved.last.record)) ? saved.last
        : take(readModelCall(store, { project: request.project, record: step.record }));
      settleAppliedCall(store, call as ModelCallOutcome);
    }
    const owner = saved.last.record.value.om.completionOwner;
    if (owner) {
      const prepared = prepareCycleCompletion(store, owner.binding, reference(saved.record), saved.record.value as ModelCycleRecord);
      if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: owner.binding.id,
        writes: prepared.writes as Write[], guards: prepared.guards as TransactionGuard[] }));
    }
    return saved as ModelCycleOutcome;
  });
  const selected = result(() => {
    const packet = take(readQuestionPacket(store, { project: request.project, record: request.packet }));
    const attempt = packet.value.request.attempt, batch = packet.value.request.batch;
    if (!attempt || !batch) return null;
    const binding = take(readCompletionBinding(store, request.project, attempt.series, attempt.ordinal));
    if (!binding) return null;
    const head = store.get(completionWorkId(request.project, binding.id));
    if (!head) fail('completion_invalid', binding.id, 'work', 'A cycle retains its exact registry');
    const snapshot = take(readCompletionWorkAt(store, request.project, reference(head)));
    // A saved cycle above repeats historically. A lost cursor cannot reinterpret a cessation as a new terminal.
    if (snapshot.cessations.some(row => take(readCompletionAssignmentAt(store, request.project, row.value.assignment)).value.batch === packet.value.request.batch))
      take(checkCompletionDisposition(store, { ...snapshot, work: { ...snapshot.work, value: { ...snapshot.work.value, closed: null } } },
        { batch, action: 'cycle' }));
    return null;
  });
  if (!selected.ok) return selected;
  // MP2 (№2968 §4): a new cycle of a brief chain — also one MP1 began without a saved cycle — carries the correction
  // policy; its already received or applied calls are reused below, never sent again.
  const chain = result(() => briefContract(take(readQuestionPacket(store, { project: request.project, record: request.packet })).value.packetContract));
  if (!chain.ok) return chain;
  const value: ModelCycleRecord = { request, steps: [], results: [], assembly: null, next: null, diagnostic: null, terminal: 'outcome',
    ...(chain.value ? { cyclePolicy: CYCLE_POLICY } : {}) };
  let packetRef = request.packet;
  // H1.3 (№2121-1): one admission for the whole chain of this invocation. Its first new work — a dispatch, a delivery
  // or a next packet — takes it once, and every later call, continuation and part writes under that same admission: a
  // stop and resume between them fence the old invocation instead of lending it the new generation. What was already
  // admitted and paid is accounted under any control. A lost control leaves no cycle record, so a resumed cycle finds
  // its saved calls again.
  const gate = new RunControlGate(store, request.project, control);
  try {
    while (true) {
      const call = take(await modelCallUnder(store, sealed({ ...request, packet: packetRef }) as ModelCallRequest, signal, gate));
      value.steps.push({ packet: packetRef, record: reference(call.record) });
      if (call.part) value.results.push(call.part.result);
      value.diagnostic = call.diagnostic;
      const packet = take(readQuestionPacket(store, { project: request.project, record: packetRef }));
      const finish = (code: string, message: string, evidence: Ref[] = []) => {
        value.diagnostic = take(finishModelAttempt(store, { project: request.project, packet: packetRef, call: call.call,
          response: call.response, code, message, reason: 'refused', evidence })).diagnostic;
      };
      if (call.outcome?.kind === 'need-source' && call.response) {
        const basis = { project: request.project, packet: packetRef, call: call.call, response: call.response };
        // Row 2: a read the engine cannot perform on its exact records ends this cycle with the read's own refusal; nothing
        // is read and nothing more is sent for it.
        const unperformable = readsIssue(store, basis);
        if (unperformable) {
          value.terminal = 'reads-invalid';
          finish(unperformable.code, unperformable.message, [unperformable.ref]); break;
        }
        const delivered = take(deliverModelSources(gate.view(), basis));
        // A read after a correction is a new immediate edge; the correction stays in the chain through its packet.
        const { correction: _correction, ...base } = packet.value.request;
        const next = take(writeQuestionPacket(gate.view(), { ...base, previous: [...base.previous],
          continuation: { packet: packetRef, call: call.call, response: call.response, deliveries: delivered.deliveries as Ref[] } }));
        if (next.record.value.state !== 'ready') {
          if (next.record.value.refusal?.code === 'research_no_progress') {
            value.terminal = 'research-no-progress';
            finish(next.record.value.refusal.code, next.record.value.refusal.message, delivered.deliveries as Ref[]); break;
          }
          value.terminal = 'blocked'; value.next = reference(next.record);
          finish(next.record.value.refusal?.code ?? 'packet_too_large', next.record.value.refusal?.message ?? 'The complete continuation does not fit', [value.next]); break;
        }
        packetRef = reference(next.record); continue;
      }
      if (call.part && packet.value.plan) {
        if (packet.value.plan.position + 1 < packet.value.plan.assignments.length) {
          const { continuation: _continuation, correction: _correction, ...root } = packet.value.request;
          const next = take(writeQuestionPacket(gate.view(), { ...root, previous: [...root.previous, { packet: packetRef, ...call.part }] }));
          if (next.record.value.state !== 'ready') {
            value.terminal = 'blocked'; value.next = reference(next.record);
            finish(next.record.value.refusal?.code ?? 'node_unexpandable', next.record.value.refusal?.message ?? 'The next assigned part does not fit', [value.next]); break;
          }
          packetRef = reference(next.record); continue;
        }
        const assembly = assembleModelParts(store, { project: request.project, results: value.results });
        if (assembly.ok) { value.assembly = reference(assembly.value.record); value.terminal = 'assembled'; }
        else { value.terminal = 'parts-invalid'; finish(assembly.refusal.code, assembly.refusal.message, value.results); }
        break;
      }
      // MP2 (№2968 §3): one correction of the chain — the same material, the exact refusal and the previous answer under
      // a new request, admitted and sent under this same gate. An occupied cycle address is never written over.
      const correction = value.cyclePolicy ? callCorrection(store, request.project, call) : null;
      if (correction) {
        if (store.get(id)) fail('model_delivery_invalid', id, 'cycle', 'A cycle at this exact address was saved meanwhile');
        const { continuation: _continuation, correction: _correction, ...root } = packet.value.request;
        const next = take(writeQuestionPacket(gate.view(), { ...root, previous: [...root.previous], correction }));
        if (next.record.value.state !== 'ready') {
          value.terminal = 'blocked'; value.next = reference(next.record);
          finish(next.record.value.refusal?.code ?? 'packet_too_large', next.record.value.refusal?.message ?? 'The complete correction does not fit', [value.next]); break;
        }
        packetRef = reference(next.record); continue;
      }
      break;
    }
    return result(() => {
      const last = cycleSources(store, request.project, value);
      const cycleWrite: Write = { id, kind: MODEL_CYCLE_KIND, expected: 0, value };
      const writes = [cycleWrite], guards: TransactionGuard[] = refs(value.steps.map(step => step.record));
      const owner = last.record.value.om.completionOwner;
      if (owner) {
        const work = prepareCycleCompletion(pendingCallStore(store, writes), owner.binding, writeRef(cycleWrite), value);
        writes.push(...work.writes as Write[]); guards.push(...work.guards);
      }
      const written = take(writeGuarded<ModelCycleRecord>(store, { unit: 'E4', target: id, writes, guards }));
      const read = take(readModelCycle(store, { project: request.project, record: reference(written[0]!) }));
      return { ...read, repeated: false } as ModelCycleOutcome;
    });
  } catch (error) {
    { const failed = caught(error); if (failed) return failed; }
    if (error instanceof RunControlLost) return controlLost(error);
    throw error;
  }
}

// Dispatch lifecycle.
import { readFileSync as readRejectedFile } from 'node:fs';
import { runProcess } from '../runtime/process.js';
import { isProcessStopRefusal, writeProcessStopWitness } from '../runtime/process-identity.js';
import { recordCall as recordCallOf, readCall as readCallOf, readCallLedgerAt as readCallLedgerAtOf, readCallLedger as readCallLedgerOf, callRecordId, callLedgerId, settleCall as settleCallOf, prepareCallDispatch as prepareCallDispatchOf, type AnyCallRecord, type AnyRecordCallRequest, type DispatchContract, type CallHistory, type CallLedger } from './call-record.js';
import { prepareQuestionPacket as prepareQuestionPacketOf, preparePartResult as preparePartResultOf, partResponseId, PART_RESPONSE_KIND, PART_RESULT_KIND, workAssignments, type QuestionPacketRequest, type PartResponseRecord } from './question-packet.js';
import { readAnySeriesAt as readAnySeriesAtOf, completionCloseId, type AnyRepairSeries, seriesRequestOf, prepareCompleteAttempt as prepareCompleteAttemptOf, prepareSeriesLineAdmission as prepareSeriesLineAdmissionOf, readSeriesWorkAdmission as readSeriesWorkAdmissionOf, readSeriesAdmissionChange as readSeriesAdmissionChangeOf, readCurrentSeriesPointer as readCurrentSeriesPointerOf, type AttemptGoal, type CompletionReason, type SeriesAdmissionChange } from './series.js';
import { prepareJournalBatch as prepareJournalBatchOf, prepareRecordRefusal as prepareRecordRefusalOf, unitRefusalNamespace, UNIT_REFUSAL_KIND, type UnitRefusalRecord } from './refusal-journal.js';
import { prepareAddressing as prepareAddressingOf, INPUT_DECISION_KIND, inputDecisionNamespace } from './addressing.js';
import { readOmInput as readOmInputOf } from './input.js';
import type { CheckedAnswerForm } from './answer-form.js';

export interface ModelCallRequest { project: string; packet: Ref; dispatch: DispatchContract; role: 'implementer' | 'reviewer' }
export interface ModelCallOutcome {
  record: Revision<OmModelCall>; packet: Ref; call: Ref; response: Ref | null; outcome: CheckedAnswerForm | null;
  part: { proposal: Ref; result: Ref } | null; diagnostic: Ref | null; repeated: boolean;
}
export interface ModelCallPhysical {
  record: Revision<OmModelCall>; call: Ref; packet: Ref; transport: AdapterResult | null;
}
interface ModelExchange {
  project: string; request: ModelCallRequest; call: Ref; wire: AdapterRequest;
  process: ProcessResult | null; launchError: { code: string; message: string } | null; admissionGuards: Ref[];
}
export type ModelApplicationState = 'running' | 'received' | 'applied' | 'application-refused' | 'recovered';
export type ModelCallState =
  | { state: 'running'; record: Revision<OmModelCall> }
  | { state: 'received'; record: Revision<OmModelCall>; exchange: Revision<ModelExchange>; transport: AdapterResult }
  | { state: 'applied' | 'application-refused' | 'recovered'; outcome: ModelCallOutcome };
export interface OmModelCall extends ModelCall {
  om: { version: 'om-model-call/v1' | 'om-model-call/managed-v1'; completionOwner?: CompletionCallOwner; application: ModelApplicationState; request: ModelCallRequest; call: Ref; exchange: Ref | null;
    part: { proposal: Ref; result: Ref } | null; diagnostic: Ref | null; input: Ref | null; failure: Refusal | null; rejection: Ref | null; completion?: Ref | null;
    admission?: ModelWorkAdmission; terminal?: ModelTerminalWitness;
    /** NR1 (№3600): the one checked form of the received answer, saved when it was applied; absent before NR1. */
    checked?: CheckedAnswerForm | null;
    resume?: { contract: 'om-model-application-resume/v1'; previous: Ref } };
}
export interface ModelWorkAdmission {
  contract: 'om-model-admission/v1'; series: Ref; pointer: Ref | null;
}
export interface ModelTerminalWitness {
  contract: 'om-model-terminal/v1'; source: Ref; call: Ref; series: Ref; attempt: number; goal: AttemptGoal;
  admission: ModelWorkAdmission; change: SeriesAdmissionChange; reason: 'interrupted';
}
export interface FinishModelAttemptRequest {
  project: string; packet: Ref; call: Ref; response: Ref | null; code: string; message: string;
  reason: Exclude<CompletionReason, 'result'>; evidence?: Ref[];
}
const EXCHANGE_KIND = 'om-model-exchange';
const modelRecordId = (project: string, requestId: string) => `model-call:${project}:om:${hashJson(requestId)}`;
/** H1.0d (C15, C43): G7 finds the runtime record of an E1 row of its own attempt. */
export function modelCallRecordId(project: string, name: string): string { return modelRecordId(project, name); }
const exchangeId = (request: ModelCallRequest) => `${EXCHANGE_KIND}:${request.project}:${hashJson(request)}`;
const writeRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
export function pendingCallStore(store: Store, writes: readonly Write[]): Store {
  // The common pending overlay of the storage helper (PF1, №2797-2): a frozen registered layer over proved reads — a
  // genuine Store, a write-only guarded view, another such overlay or a preview of the acceptance's Transaction — and the
  // opaque Proxy over anything else. Later writes of one id replace earlier ones, as they always did here.
  return pendingOverlay(store, writes.map(write => sealed({ ...writeRef(write), kind: write.kind, value: write.value })));
}
function externalGuards(guards: readonly Ref[], writes: readonly Write[]): Ref[];
function externalGuards(guards: readonly TransactionGuard[], writes: readonly Write[]): TransactionGuard[];
function externalGuards(guards: readonly TransactionGuard[], writes: readonly Write[]): TransactionGuard[] {
  const pending = new Set(writes.map(write => canonical(writeRef(write))));
  // H1.0d (C15): an absence the outcome relied on is carried to the final transaction, never cast away.
  const absent = [...new Map(guards.filter(guard => !isRef(guard)).map(guard => [guard.id, guard])).values()];
  return [...refs(guards.filter(isRef).filter(ref => !pending.has(canonical(ref)))), ...absent];
}
function requireModelRequest(store: Store, request: unknown): asserts request is ModelCallRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.packet)
    || !object(request.dispatch) || !exactKeys(request.dispatch, ['adapter', 'config'])
    || !isRef(request.dispatch.adapter) || !isRef(request.dispatch.config)
    || !['implementer', 'reviewer'].includes(request.role as string)
    || !exactKeys(request, ['project', 'packet', 'dispatch', 'role'])) invalid('model-call');
}
function readDispatchAdapter(store: Store, ref: Ref) {
  const adapter = take(readRecord<{ protocol: string }>(store, ref,
    { unit: 'E4', target: ref.id, id: ref.id, kind: 'dispatch-adapter' }));
  if (!object(adapter.value) || !isStdioProtocol(adapter.value.protocol))
    fail('dispatch_contract_invalid', ref.id, 'protocol', 'E4 executes only a known stdio dispatch contract');
  return adapter;
}
function modelAssignment(store: Store, request: ModelCallRequest) {
  const packet = take(readQuestionPacket(store, { project: request.project, record: request.packet }));
  const payload = packet.value.packet;
  if (packet.value.state !== 'ready' || !object(payload) || !text(payload.requestId)
    || !['model-research', 'model-design'].includes(payload.purpose as string) || !packet.value.request.attempt)
    fail('model_call_request_invalid', request.packet.id, 'packet', 'Dispatch requires a ready ordinary E2 assignment', request.packet);
  if (!same(request.dispatch.config, packet.value.request.environment))
    fail('dispatch_contract_invalid', request.packet.id, 'dispatch.config', 'Dispatch must use the exact environment measured in the packet');
  const configured = take(readRecord<Environment>(store, request.dispatch.config,
    { unit: 'E4', target: request.packet.id, id: `environment:${request.project}`, kind: 'environment' }));
  readDispatchAdapter(store, request.dispatch.adapter);
  const environment = configured.value as Environment;
  if (!object(environment)) fail('dispatch_contract_invalid', configured.id, 'environment', 'A dispatch environment must be a record');
  const configuredBinding = environment[request.role];
  if (environment.projectId !== request.project || !object(configuredBinding) || !text(configuredBinding.actor)
    || !text(configuredBinding.model) || !text(configuredBinding.effort) || !object(configuredBinding.command)
    || !text(configuredBinding.command.executable) || !Array.isArray(configuredBinding.command.args)
    || !configuredBinding.command.args.every(arg => typeof arg === 'string') || !text(environment.workspace)
    || !Number.isSafeInteger(environment.timeoutMs) || environment.timeoutMs < 100 || environment.timeoutMs > 3_600_000)
    fail('dispatch_contract_invalid', configured.id, request.role, 'The exact environment must provide a complete executor binding');
  const binding = resolveRoleMode(request.role, configuredBinding, 'research');
  const wire = take(adapterRequest({ requestId: payload.requestId, packet: payload as Json, model: binding.model,
    effort: binding.effort, ...(binding.speed === undefined ? {} : { speed: binding.speed }) }));
  const series = take(readAnySeriesAt(store, request.project, packet.value.request.attempt.series));
  const attempt = series.value.attempts.find(item => item.ordinal === packet.value.request.attempt!.ordinal);
  if (!attempt) fail('packet_attempt_invalid', request.packet.id, 'attempt', 'The packet must name its exact series attempt');
  const routes = take(readRoutes(store, { project: request.project, record: packet.value.request.routes }));
  const batch = routes.record.value.batches.find(item => item.id === packet.value.request.batch)!;
  const assigned = new Set((payload.questions as { id: string }[]).map(item => item.id));
  const common = { call: payload.requestId, purpose: payload.purpose as 'model-research' | 'model-design', basis: null,
    series: packet.value.request.attempt.series, attempt: attempt.ordinal, goal: attempt.goal,
    dispatch: request.dispatch, packet: payload as Json };
  const assignedItems = batch.items.filter(item => assigned.has(item.gap));
  const mechanismOwner = 'owner' in series.value ? series.value.owner : null;
  const admission: AnyRecordCallRequest = 'owner' in series.value
    ? { ...common, owner: series.value.owner, admission: { routes: packet.value.request.routes, batch: batch.id,
      gaps: routes.record.value.request.gaps }, gaps: assignedItems.map(item => ({ id: item.gap, goal: item.target,
        field: item.field, consumer: mechanismOwner! })) }
    : { ...common, block: series.value.block, gaps: assignedItems.flatMap(item => item.consumers.map(consumer =>
      ({ id: item.target, goal: item.target, field: item.field, consumer }))) };
  return { packet, payload, environment, binding, wire, series, admission, batch };
}
/**
 * H1.5 (№2166 п.3): the last defence of a NEW dispatch. A batch with a question that no answer producer serves is refused
 * before E1, the claim and the authorization — G4b would not accept that answer, so paying for it buys nothing, however
 * ready its packet is. It reads the packet's own exact routes and the complete D1 of them through the one G4b reading
 * (`readRouteProducers`), so it is the same verdict the choice of work of H1 acted on. Only a dispatch without a saved call
 * comes here: reading history, applying a received answer, recovery and a late receipt never ask it, so a paid call is
 * always finished and accounted as before. Inputs are exact immutable revisions, so no guard of its own is needed.
 */
function requireAnswerProducers(store: Store, packet: Ref, project: string, routes: Ref, batch: string): void {
  const read = take(readRouteProducers(store, { project, routes }));
  const judged = read.batches.find(item => item.batch === batch);
  if (!judged) fail('model_call_request_invalid', packet.id, 'batch', 'The packet names a batch its exact routes do not hold', routes);
  const first = judged.unserved[0];
  if (!first) return;
  const refusal = unservedProducer(first);
  if (!refusal.ok) throw new CallFailure(refusal.refusal);
}
/**
 * The verdict of G4b on an unserved question, as it came out of the exact D1 reading above: the code is answers-gate's own
 * (NoProducer names both), carried with its message and field as data and addressed here at E4, the owner's absence routed
 * to the owner as before. The one narrowing of this adapter only marks that code with its source after that reading.
 */
function unservedProducer(first: UnservedQuestion): ModelCallResult<never> {
  const code = first.producer.code as SourceCode<'answers-gate', NoProducer['code']>;
  return refused(code, first.producer.message, { unit: 'E4', target: first.target, field: first.producer.field, ref: first.gap },
    first.producer.code === 'owner_result_unavailable' ? 'owner' : 'producer');
}
function modelWorkAdmission(store: Store, record: Revision<OmModelCall>, series: Ref): ModelWorkAdmission {
  if (!object(record.value) || !object(record.value.om) || !['om-model-call/v1', 'om-model-call/managed-v1'].includes(record.value.om.version))
    fail('model_call_record_invalid', record.id, 'admission', 'An original admission belongs to a complete E4 runtime record');
  const saved = record.value.om.admission;
  if (saved !== undefined && (!object(saved) || !exactKeys(saved, ['contract', 'series', 'pointer'])
    || saved.contract !== 'om-model-admission/v1' || !isRef(saved.series) || !same(saved.series, series)
    || !(saved.pointer === null || isRef(saved.pointer))))
    fail('model_call_record_invalid', record.id, 'admission', 'The physical call retains its exact original series admission');
  const admission: ModelWorkAdmission = saved ?? { contract: 'om-model-admission/v1', series, pointer: null };
  // A missing field is legacy only when the exact source series proves that era.
  take(readSeriesWorkAdmission(store, { project: record.value.projectId, series, pointer: admission.pointer }));
  return admission;
}
function prepareModelTerminalWitness(store: Store, source: Revision<OmModelCall>) {
  if (source.value.om.completionOwner) return null;
  const call = take(readCall(store, source.value.projectId, source.value.om.call));
  const admission = modelWorkAdmission(store, source, call.value.series);
  const changed = readSeriesAdmissionChange(store, { project: source.value.projectId,
    series: admission.series, pointer: admission.pointer });
  if (!changed.ok) return null;
  return { witness: { contract: 'om-model-terminal/v1', source: reference(source), call: source.value.om.call,
    series: call.value.series, attempt: call.value.attempt, goal: call.value.goal, admission,
    change: changed.value.proof, reason: 'interrupted' } as ModelTerminalWitness, guards: changed.value.guards };
}
/** This proof ends at the physical outcome, before any later explicit A3 completion. */
function modelTerminalBasis(store: Store, project: string, witness: ModelTerminalWitness) {
  if (!object(witness) || !exactKeys(witness, ['contract', 'source', 'call', 'series', 'attempt', 'goal', 'admission', 'change', 'reason'])
    || witness.contract !== 'om-model-terminal/v1' || ![witness.source, witness.call, witness.series].every(isRef)
    || !Number.isSafeInteger(witness.attempt) || witness.attempt < 1 || witness.reason !== 'interrupted'
    || !object(witness.change) || !exactKeys(witness.change, ['contract', 'project', 'series', 'pointer', 'applied', 'currentPointer'])
    || witness.change.contract !== 'series-admission-change/v1' || witness.change.project !== project
    || ![witness.change.series, witness.change.applied, witness.change.currentPointer].every(isRef)
    || !(witness.change.pointer === null || isRef(witness.change.pointer)))
    fail('model_call_record_invalid', project, 'terminal', 'A terminal outcome requires its complete versioned admission-change witness');
  const source = take(readModelCallPhysical(store, { project, record: witness.source }));
  if (!['running', 'received'].includes(source.record.value.om.application))
    fail('model_call_record_invalid', witness.source.id, 'terminal', 'A terminal witness starts at a running claim or saved receipt');
  const call = take(readCall(store, project, witness.call));
  const admission = modelWorkAdmission(store, source.record as Revision<OmModelCall>, call.value.series);
  if (!same(source.call, witness.call) || !same(call.value.series, witness.series) || call.value.attempt !== witness.attempt
    || !same(call.value.goal, witness.goal) || !same(admission, witness.admission)
    || !same(witness.change.series, witness.series) || !same(witness.change.pointer, admission.pointer))
    fail('model_call_record_invalid', witness.source.id, 'terminal', 'Terminal evidence belongs to this exact call, attempt, goal and admission era');
  const changed = take(readSeriesAdmissionChange(store, { project, series: witness.series,
    pointer: admission.pointer, currentPointer: witness.change.currentPointer }));
  if (!same(changed.proof, witness.change))
    fail('model_call_record_invalid', witness.source.id, 'terminal', 'Only the applied A3 change can end the saved admission');
  return { source: source.record as Revision<OmModelCall>, references: refs([witness.source, witness.call, witness.series, ...changed.references]) };
}
export function readModelTerminalWitness(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<{
  series: Ref; attempt: number; goal: AttemptGoal; reason: 'interrupted'; call: Ref; change: SeriesAdmissionChange; references: Ref[];
}>> {
  return result(() => {
    const state = take(readModelCallState(store, request));
    if (state.state !== 'application-refused' && state.state !== 'recovered')
      fail('model_call_record_invalid', request.record.id, 'terminal', 'Only a proved terminal physical outcome can authorize explicit completion');
    const witness = state.outcome.record.value.om.terminal;
    if (!witness) fail('model_call_record_invalid', request.record.id, 'terminal', 'The terminal admission-change witness is required');
    const checked = modelTerminalBasis(store, request.project, witness as ModelTerminalWitness);
    return { series: witness.series, attempt: witness.attempt, goal: witness.goal, reason: witness.reason,
      call: witness.call, change: witness.change, references: refs([request.record, ...checked.references]) };
  });
}
function requireFinish(store: Store, request: unknown): asserts request is FinishModelAttemptRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.packet) || !isRef(request.call)
    || !(request.response === null || isRef(request.response)) || !text(request.code) || !text(request.message)
    || !['refused', 'off-form', 'interrupted', 'awaiting-owner'].includes(request.reason as string)
    || Object.hasOwn(request, 'evidence') && (!Array.isArray(request.evidence) || !request.evidence.every(isRef))
    || Object.keys(request).some(key => !['project', 'packet', 'call', 'response', 'code', 'message', 'reason', 'evidence'].includes(key))) invalid('finish');
}
/** The one checked form of a received answer and its failure, as the receipt derived them. */
type ReceivedForm = { checked: CheckedAnswerForm | null; failure: Refusal<ModelCallCode> | null };
function prepareModelFinish(store: Store, request: FinishModelAttemptRequest, received?: ReceivedForm) {
  const packet = take(readQuestionPacket(store, { project: request.project, record: request.packet }));
  const call = take(readCall(store, request.project, request.call));
  if (!packet.value.request.attempt || !object(packet.value.packet)
    || call.value.call !== packet.value.packet.requestId || !same(call.value.series, packet.value.request.attempt.series)
    || call.value.attempt !== packet.value.request.attempt.ordinal)
    fail('model_call_request_invalid', request.packet.id, 'call', 'Completion belongs to this exact admitted packet and attempt');
  if (request.response) take(readPacketResponse(store, { project: request.project, packet: request.packet, call: request.call, response: request.response }));
  const binding = take(readCompletionBinding(store, request.project, call.value.series, call.value.attempt)) as Revision<CompletionOwner> | null;
  const diagnosticWrite = modelFinishDiagnostic(store, request, binding, received);
  const diagnostic = writeRef(diagnosticWrite), old = store.get(diagnostic.id);
  if (old && (old.kind !== UNIT_REFUSAL_KIND || old.revision !== 1 || !same(old.value, diagnosticWrite.value)))
    fail('model_call_record_invalid', diagnostic.id, 'diagnostic', 'The immutable diagnostic cannot be replaced');
  if (binding && old) return { diagnostic, writes: [] as Write[], guards: [reference(old)] as TransactionGuard[] };
  const series = binding ? null : take(readAnySeriesAt(store, request.project, call.value.series));
  if (series && 'owner' in series.value) {
    // H1.0d (№1688-8, C43): a standalone M5 finish closes through the same G7 transition as a direct close — the
    // addressings its other calls already applied (never this call), the classes of this diagnostic and A3 in one
    // batch — so a later repeat, through here or G7, derives the same outcome and writes nothing.
    const staged: Write[] = old ? [] : [diagnosticWrite];
    const own = take(mechanismAttemptResults(pendingCallStore(store, staged), { project: request.project,
      owner: series.value.owner, series: call.value.series, attempt: call.value.attempt, goal: call.value.goal, except: request.call }));
    const rows = take(prepareJournalBatch(store, { project: request.project, sources: old ? [] : [diagnostic], pending: staged, classifications: [] })).value.rows;
    const claims = rows.filter(row => same(row.source, diagnostic)).map(row => ({ row: row.id, name: row.code, goal: row.goal }));
    const close = take(prepareFinishClose(store, { ...seriesRequestOf(series.value), attempt: call.value.attempt,
      outcome: { reason: own.results.achieved.length ? 'result' : request.reason, accepting: [...own.accepting], cancelling: [], refusals: claims } },
      old ? null : diagnosticWrite));
    const writes = [...close.writes] as Write[];
    return { diagnostic, writes, guards: externalGuards([...close.guards, ...(old ? [reference(old)] : [])], writes) };
  }
  const writes: Write[] = old ? [] : [diagnosticWrite];
  const journal = take(prepareRecordRefusal(pendingCallStore(store, writes), { project: request.project, source: diagnostic }));
  writes.push(...journal.writes);
  const claims = journal.value.rows.filter(row => same(row.source, diagnostic)).map(row => ({ row: row.id, name: row.code, goal: row.goal }));
  if (binding || !series) return { diagnostic, writes, guards: externalGuards([...journal.guards, ...(old ? [reference(old)] : [])] as TransactionGuard[], writes) };
  const completion = take(prepareCompleteAttempt(pendingCallStore(store, writes), { ...seriesRequestOf(series.value),
    attempt: call.value.attempt, outcome: { reason: request.reason, achieved: [], cancelled: [], refusals: claims } }));
  writes.push(...completion.writes);
  return { diagnostic, writes, guards: externalGuards([...journal.guards, ...completion.guards,
    ...(old ? [reference(old)] : [])] as TransactionGuard[], writes) };
}
/** Shared prepared completion; neighbours can atomically persist their result and the single A3 outcome. */
export function prepareModelAttemptFinish(store: Store, request: FinishModelAttemptRequest): ModelCallResult<Sealed<{ diagnostic: Ref; writes: Write[]; guards: TransactionGuard[] }>> {
  requireFinish(store, request); request = sealed(request) as FinishModelAttemptRequest;
  // H1.0d (№1715, C15): the guards include the absences the outcome relied on; the caller carries them to its write.
  return result(() => prepareModelFinish(store, request));
}
/** Records one addressed failure/control outcome through the common journal and A3 transition. */
export function finishModelAttempt(store: Store, request: FinishModelAttemptRequest): ModelCallResult<Sealed<{ diagnostic: Ref }>> {
  requireFinish(store, request); request = sealed(request) as FinishModelAttemptRequest;
  return result(() => {
    const prepared = prepareModelFinish(store, request);
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: request.call.id,
      writes: prepared.writes, guards: prepared.guards }));
    return { diagnostic: prepared.diagnostic };
  });
}
function transportOf(exchange: Pick<ModelExchange, 'wire' | 'call' | 'process' | 'launchError'>): AdapterResult {
  if (exchange.process !== null) return take(readAdapterResponse({ requestId: exchange.wire.requestId, process: exchange.process })) as AdapterResult;
  if (!exchange.launchError || !text(exchange.launchError.code) || !text(exchange.launchError.message))
    fail('model_call_record_invalid', exchange.call.id, 'process', 'Missing process evidence must have an explicit launch/interruption error');
  // The saved launch error is history outside today's transport catalogue (№2460-4): its code is marked as the exchange's own
  // after the check above — the one narrowing of this boundary; the record itself gains no field.
  return { kind: 'interrupted', usage: null, confirmed: unknownConfirmed(), error: { code: exchange.launchError.code as SourceCode<'exchange'>,
    field: 'process', message: exchange.launchError.message } };
}
/**
 * Boundary adapter of the verified transport (№2511-1): the error of a failed exchange as a refusal of E4. Its code is data
 * of the exchange — one of TRANSPORT_ERROR_CODES, or the saved launch error of the historical arm, already marked as the
 * exchange's — and it reaches the result channel only through this declared transfer, marked with its source; message,
 * field, address and route stay as the failed exchange states them.
 */
function transportFailure(error: AdapterError): ModelCallResult<never> {
  return transfer('transport', refused(error.code, error.message, { unit: 'E4', target: 'adapter', field: error.field }, 'producer'));
}
/** A failed exchange as a refusal of the result channel (through transportFailure), or the refusal of its answer form. */
function failureOf(transport: AdapterResult, form: ModelCallResult<Sealed<CheckedAnswerForm>> | null): Refusal<ModelCallCode> | null {
  if (transport.kind !== 'answered') {
    const failed = transportFailure(transport.error);
    return failed.ok ? null : failed.refusal;
  }
  return form && !form.ok ? form.refusal : null;
}
function finishReason(transport: AdapterResult, form: CheckedAnswerForm | null, failure: Refusal<ModelCallCode> | null): FinishModelAttemptRequest['reason'] | null {
  if (failure?.code === 'process_output_limit' || (transport.kind !== 'answered' && transport.error?.code === 'process_output_limit'))
    return 'awaiting-owner';
  if (transport.kind === 'interrupted') return 'interrupted';
  if (transport.kind === 'off-form' || failure) return 'off-form';
  if (form?.kind === 'awaiting-owner') return 'awaiting-owner';
  if (form?.kind === 'no-result') return 'refused';
  return null;
}
function finishDetail(transport: AdapterResult, form: CheckedAnswerForm | null, failure: Refusal<ModelCallCode> | null) {
  if (failure?.code === 'process_output_limit' || (transport.kind !== 'answered' && transport.error?.code === 'process_output_limit'))
    return { code: 'process_output_limit', message: failure?.message ?? (transport.kind !== 'answered' ? transport.error.message : 'Process output limit exceeded') };
  if (failure) return { code: failure.code, message: failure.message };
  if (form?.kind === 'awaiting-owner') return { code: 'model_need_owner', message: `${form.reason}; ${form.decision}` };
  if (form?.kind === 'no-result') return { code: `model_${form.action}`, message: form.reason };
  if (transport.kind !== 'answered') return { code: transport.error.code, message: transport.error.message };
  return null;
}

/** Unknown expense is justified only by a complete, unreceived physical claim. */
function requireUnreceivedModelCall(record: Revision<ModelCall>): void {
  const value = record.value;
  for (const field of ['finishedAt', 'response', 'usage', 'error'] as const) {
    if (value[field] !== null)
      fail('model_call_record_invalid', record.id, field, 'An unreceived dispatch retains an explicit null physical outcome');
  }
  if (value.status !== 'running' || Object.hasOwn(value, 'recovery'))
    fail('model_call_record_invalid', record.id, 'status', 'A running dispatch has no terminal recovery');
  if (!Number.isSafeInteger(value.startedAt) || value.startedAt < 0)
    fail('model_call_record_invalid', record.id, 'startedAt', 'A running dispatch retains its physical start time');
  if (!object(value.confirmed) || !same(value.confirmed, unknownConfirmed()) || value.usageSource !== 'unavailable')
    fail('model_call_record_invalid', record.id, 'receipt', 'A running dispatch has no confirmed executor or measured expense');
  try {
    if (!executionOf(value)) fail('model_call_record_invalid', record.id, 'execution', 'OM dispatch retains its mandatory physical claim');
  } catch (error) {
    if (error instanceof EngineError && error.code === 'model_call_execution_invalid')
      fail('model_call_record_invalid', record.id, 'execution', 'The physical claim retains its exact owner and authorization phase');
    throw error;
  }
}

function checkedModelExchange(store: Store, request: ModelCallRequest, callRef: Ref, exchangeRef: Ref) {
  const { wire } = modelAssignment(store, request);
    const exchange = take(readRecord<ModelExchange>(store, exchangeRef,
      { unit: 'E4', target: exchangeRef.id, id: exchangeId(request), kind: EXCHANGE_KIND }));
    if (exchange.revision !== 1 || !object(exchange.value)
      || !exactKeys(exchange.value, ['project', 'request', 'call', 'wire', 'process', 'launchError', 'admissionGuards'])
      || exchange.value.project !== request.project || !same(exchange.value.request, request)
      || !same(exchange.value.call, callRef) || !same(exchange.value.wire, wire)
      || !Array.isArray(exchange.value.admissionGuards) || !exchange.value.admissionGuards.length
      || !exchange.value.admissionGuards.every(isRef) || !same(refs(exchange.value.admissionGuards), exchange.value.admissionGuards)
      || (exchange.value.process === null) === (exchange.value.launchError === null))
      fail('model_call_record_invalid', exchangeRef.id, 'exchange', 'Transport evidence must belong to this exact request and original admission');
    for (const guard of exchange.value.admissionGuards) {
      const source = store.get(guard.id, guard.revision);
      if (!source || !same(reference(source), guard))
        fail('model_call_record_invalid', exchangeRef.id, 'admissionGuards', 'The received exchange retains exact dispatch sources');
    }
    return { exchange: exchange as Revision<ModelExchange>, transport: transportOf(exchange.value as ModelExchange) };
}

function requireModelCallRead(store: Store, request: { project: string; record: Ref }): void {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('record');
}
/** Exact E4 provenance and physical usage, including the original terminal completion contract. */
/** NR1 (№3600): a trusted read of the physical E4 record and its immutable exchange. Every revision was written by the
 * dispatch, receipt, application or recovery producer, each of which checked what was new to it then. */
export function readModelCallPhysical(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<ModelCallPhysical>> {
  requireModelCallRead(store, request);
  return result<ModelCallPhysical>(() => {
    const record = take(readRecord<OmModelCall>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `model-call:${request.project}:om:`, kind: 'model-call' })) as Revision<OmModelCall>;
    const value = record.value;
    if (value.om.application === 'running' || value.om.application === 'recovered' || !isRef(value.om.exchange))
      return { record, call: value.om.call, packet: value.om.request.packet, transport: null };
    const exchange = take(readRecord<ModelExchange>(store, value.om.exchange,
      { unit: 'E4', target: value.om.exchange.id, id: value.om.exchange.id, kind: EXCHANGE_KIND }));
    return { record, call: value.om.call, packet: value.om.request.packet, transport: transportOf(exchange.value as ModelExchange) };
  });
}

/** NR1 (№3600): the state of a call as its producers wrote it. The checked form of an applied answer is the one saved at
 * its application; a call applied before NR1 has none saved, and its form is read once from the saved raw answer. */
export function readModelCallState(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<ModelCallState>> {
  requireModelCallRead(store, request);
  return result<ModelCallState>(() => historicalRead(store, { reader: 'E4.model-call-state', project: request.project, ref: request.record }, () => {
    const physical = take(readModelCallPhysical(store, request));
    const record = physical.record as Revision<OmModelCall>, value = record.value;
    if (value.om.application === 'running') return { state: 'running', record };
    if (value.om.application === 'recovered') {
      return { state: 'recovered', outcome: { record, packet: value.om.request.packet,
        call: value.om.call, response: null, outcome: null, part: null, diagnostic: value.om.diagnostic, repeated: true } };
    }
    const transport = physical.transport as AdapterResult;
    if (value.om.application === 'received') {
      const exchange = take(readRecord<ModelExchange>(store, value.om.exchange!,
        { unit: 'E4', target: record.id, id: value.om.exchange!.id, kind: EXCHANGE_KIND }));
      return { state: 'received', record, exchange: exchange as Revision<ModelExchange>, transport };
    }
    if (value.om.rejection !== null) {
      return { state: 'application-refused', outcome: { record, packet: value.om.request.packet, call: value.om.call,
        response: null, outcome: null, part: null, diagnostic: value.om.diagnostic, repeated: true } };
    }
    const response = value.response?.record ?? null;
    let outcome: CheckedAnswerForm | null = null;
    if (value.om.checked !== undefined) outcome = value.om.checked;
    else if (transport.kind === 'answered') {
      const form = checkAnswerForm(store, { project: request.project, packet: value.om.request.packet, raw: transport.raw });
      if (form.ok) outcome = form.value as CheckedAnswerForm;
    }
    return { state: 'applied', outcome: { record, packet: value.om.request.packet, call: value.om.call, response, outcome,
      part: value.om.part, diagnostic: value.om.diagnostic, repeated: true } };
  }, () => fail('model_call_record_invalid', request.record.id, 'history', 'A physical outcome cannot derive through its own application')));
}

/** Product reads cannot mistake a durable receipt for a completed product result. */
export function readModelCall(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<ModelCallOutcome>> {
  return result(() => {
    const state = take(readModelCallState(store, request));
    if (state.state === 'running') fail('model_call_in_progress', request.record.id, 'application', 'Dispatch has no saved receipt; resending is not safe');
    if (state.state === 'received') fail('model_call_application_pending', request.record.id, 'application', 'The saved receipt must resume application before it is a product result');
    return state.outcome as ModelCallOutcome;
  });
}

/** The only received -> terminal transition. Fresh receipts and restarts use the same current checks,
 * E3 derivation, E2/D3/A3 application and atomic refusal path; neither branch launches a process. */
function applyReceivedModelCall(store: Store, state: { record: Revision<OmModelCall>; exchange: Revision<ModelExchange>; transport: AdapterResult }): ModelCallResult<Sealed<ModelCallOutcome>> {
  const { record: receiptRecord, exchange, transport } = state;
  const request = receiptRecord.value.om.request, call = receiptRecord.value.om.call, id = receiptRecord.id;
  const exchangeRef = reference(exchange), wire = exchange.value.wire;
  const exchangeWrite: Write = { id: exchange.id, kind: exchange.kind, expected: 0, value: exchange.value };
  const owner = receiptRecord.value.om.completionOwner;
  const writes: Write[] = [], guards: TransactionGuard[] = refs([reference(receiptRecord),
    ...(owner ? [] : [call, ...exchange.value.admissionGuards]), request.packet]);
  let environment: { store: Store; guards: Ref[]; remap: (guards: readonly TransactionGuard[]) => TransactionGuard[] } | null = null;
  try {
    if (owner) {
      const head = store.get(completionWorkId(request.project, owner.binding.id));
      if (!head) fail('completion_invalid', owner.binding.id, 'work', 'Application needs its exact managed registry');
      const snapshot = take(readCompletionWorkAt(store, request.project, reference(head)));
      const assigned = take(readCompletionAssignmentAt(store, request.project, owner.assignment));
      take(checkCompletionDisposition(store, snapshot, { batch: assigned.value.batch, assignment: owner.assignment, action: 'apply' }));
      guards.push(reference(head));
      const cause = take(prepareCompletionCause(store, request.project, owner.assignment));
      if (cause.cause) {
        const ceased = take(writeCompletionCessation(store, { project: request.project, binding: owner.binding, assignment: owner.assignment }));
        settlePhysicalCall(store, receiptRecord, call);
        fail('completion_ceased', owner.assignment.id, 'application', 'The received response retains its proved application cessation', reference(ceased));
      }
    }
    environment = owner ? take(prepareApplicationEnvironment(store, request.project, request.dispatch.config, request.role)) : null;
    const admittedStore = environment?.store ?? store;
    const assignment = modelAssignment(store, request);
    const admission = take(prepareSeriesLineAdmission(store, request.project, assignment.admission.series));
    guards.push(...admission.guards);
    const prepared = take(prepareQuestionPacket(admittedStore, assignment.packet.value.request as QuestionPacketRequest));
    if (!same(reference(prepared.record), request.packet))
      fail('model_call_request_invalid', request.packet.id, 'packet', 'Application retains its exact currently admitted assignment');
    guards.push(...prepared.guards); writes.push(...prepared.writes);
    if (owner) {
      // The paid exchange already proves dispatch. Application may follow an E1 settlement,
      // so it guards the current checked accounting row rather than requiring a fresh open claim.
      const currentCall = store.get(call.id), adapter = store.get(request.dispatch.adapter.id);
      if (!currentCall || !adapter || !same(reference(adapter), request.dispatch.adapter))
        fail('input_stale', call.id, 'application', 'The received assignment retains its current admitted identity');
      take(readCall(store, request.project, reference(currentCall)));
      guards.push(reference(currentCall), reference(adapter));
    } else {
      const dispatch = take(prepareCallDispatch(admittedStore, request.project, call));
      guards.push(...dispatch.guards);
    }
    let response: Ref | null = null, outcome: CheckedAnswerForm | null = null,
      part: ModelCallOutcome['part'] = null, input: Ref | null = null;
    let checked: ModelCallResult<Sealed<CheckedAnswerForm & { guards: TransactionGuard[] }>> | null = null;
    if (transport.kind === 'answered') {
      const responseWrite: Write = { id: partResponseId(request.project, call), kind: PART_RESPONSE_KIND, expected: 0,
        value: { project: request.project, packet: request.packet, call, requestId: wire.requestId, raw: transport.raw } satisfies PartResponseRecord };
      response = writeRef(responseWrite);
      checked = prepareAnswerForm(admittedStore, { project: request.project, packet: request.packet, raw: transport.raw });
      if (!checked.ok) {
        const historical = checkAnswerForm(store, { project: request.project, packet: request.packet, raw: transport.raw });
        if (historical.ok || !same(historical.refusal, checked.refusal)) {
          if (historical.ok) guards.push(...historical.value.references);
          throw new CallFailure(checked.refusal);
        }
      }
      if (checked.ok) {
        const { guards: formGuards, ...form } = checked.value;
        outcome = form as CheckedAnswerForm; guards.push(...formGuards);
        if (outcome.kind === 'node-proposal') {
          const produced = take(preparePartResult(admittedStore, { project: request.project, packet: request.packet, call, response: { pending: responseWrite } }));
          if (!same(produced.record.value.works ?? null, outcome.works ?? null))
            fail('model_call_record_invalid', id, 'works', 'The part handoff must derive from the same checked saved response');
          writes.push(...produced.writes); guards.push(...produced.guards);
          part = { proposal: reference(produced.proposal), result: reference(produced.record) };
        } else {
          writes.push(responseWrite);
          if (outcome.kind === 'input-decisions') {
            const pending = new Map(outcome.writes.map(write => [write.id, write]));
            const addressed = take(prepareAddressing(admittedStore, { project: request.project, input: outcome.input, graph: outcome.graph,
              decisions: outcome.decisions.map(ref => pending.has(ref.id) ? { pending: pending.get(ref.id)! } : { record: ref }) }));
            writes.push(...addressed.writes); guards.push(...addressed.guards); input = reference(addressed.record);
            // NR1: an applied answer names only decisions that stand — written here or saved before. One that D3 did not
            // apply (it decides nothing B1 does not already hold) is no saved decision, so the answer is not applied.
            for (const ref of outcome.decisions) if (!addressed.writes.some(write => write.id === ref.id))
              take(readRecord(admittedStore, ref, { unit: 'F5.3', target: ref.id, idPrefix: inputDecisionNamespace(request.project), kind: INPUT_DECISION_KIND }));
          }
        }
      } else writes.push(responseWrite);
    }
    const failure = failureOf(transport, checked), reason = finishReason(transport, outcome, failure);
    let diagnostic: Ref | null = null;
    if (reason) {
      const finish = prepareModelFinish(pendingCallStore(store, writes), { project: request.project, packet: request.packet, call, response,
        reason, ...finishDetail(transport, outcome, failure)!, evidence: [exchangeRef] }, { checked: outcome, failure });
      writes.push(...finish.writes); guards.push(...finish.guards); diagnostic = finish.diagnostic;
    }
    const finished: OmModelCall = { ...receiptRecord.value,
      status: transport.kind === 'answered' && !failure ? 'succeeded' : 'failed', confirmed: transport.confirmed,
      response: response && transport.kind === 'answered' ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: response } : null,
      usage: transport.usage, usageSource: transport.usage === null ? 'unavailable' : 'adapter', error: failure?.code ?? null,
      om: { ...receiptRecord.value.om, application: 'applied', exchange: exchangeRef, part, input, diagnostic, failure, rejection: null, checked: outcome,
        ...(receiptRecord.value.om.application === 'application-refused'
          ? { resume: { contract: 'om-model-application-resume/v1' as const, previous: reference(receiptRecord) } } : {}) } };
    writes.push({ id, kind: 'model-call', expected: receiptRecord.revision, value: finished });
    if (finished.om.completionOwner) {
      const terminal = writeRef(writes.at(-1)!);
      const work = take(prepareCompletionProducts(pendingCallStore(store, writes), finished.om.completionOwner.binding,
        [terminal, ...(diagnostic ? [diagnostic] : [])]));
      writes.push(...work.writes as Write[]); guards.push(...work.guards.filter(isRef));
    }
    // H1.0d (C15): absences the finish relied on reach this transaction; only exact references are remapped.
    const applicationGuards = externalGuards(environment ? environment.remap([...guards, ...environment.guards]) : guards, writes);
    const committed = writeGuarded<OmModelCall>(store, { unit: 'E4', target: id, writes, guards: applicationGuards });
    const record = take(committed).find(record => record.id === id)!;
    return delivered({ record, packet: request.packet, call, response, outcome, part, diagnostic, repeated: false }) as ModelCallResult<Sealed<ModelCallOutcome>>;
  } catch (error) {
    if (!(error instanceof CallFailure)) throw error;
    if (owner) {
      // The original receipt/refusal remains exact history. Transient admission or CAS failure
      // grants neither a new physical call nor an irreversible technical product.
      settlePhysicalCall(store, receiptRecord, call);
      return { ok: false, refusal: error.refusal };
    }
    // A second race may leave received intact. No settlement or product result is invented;
    // another invocation resumes this same transition from its immutable exchange.
    return saveRejectedModelApplication(store, { request, call, running: receiptRecord, exchange: exchangeWrite,
      transport, writes, guards: externalGuards(guards.filter(isRef), writes), failure: error.refusal });
  }
}
/** Accounting belongs to the mutating operation, never to a historical reader. */
function settlePhysicalCall(store: Store, record: Revision<ModelCall> | Sealed<Revision<ModelCall>>, call: Ref): void {
  if (record.value.recovery) settleRecoveredCall(store, record, call);
  else if ((record.value as OmModelCall).om?.completionOwner) {
    const prior = take(readCall(store, record.value.projectId, reference(store.get(call.id)!)));
    if (prior.value.status !== 'open') {
      if (!same(prior.value.usage, record.value.usage)) fail('model_call_record_invalid', call.id, 'usage', 'Application retry preserves the original physical expense');
      return;
    }
    take(settleCall(store, call, record.value.usage, record.value.status === 'succeeded' ? 'succeeded' : 'failed'));
  }
  else take(settleCall(store, call, record.value.usage, record.value.status === 'succeeded' ? 'succeeded' : 'failed'));
}
function settleAppliedCall(store: Store, outcome: ModelCallOutcome): ModelCallOutcome {
  const owner = outcome.record.value.om.completionOwner;
  if (owner && outcome.record.value.om.application !== 'application-refused') {
    const prepared = take(prepareCompletionProducts(store, owner.binding,
      [reference(outcome.record), ...(outcome.diagnostic ? [outcome.diagnostic] : [])]));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: owner.binding.id,
      writes: prepared.writes as Write[], guards: prepared.guards as TransactionGuard[] }));
  }
  settlePhysicalCall(store, outcome.record, outcome.call);
  return outcome;
}

/** One physical dispatch. Each new continuation is another packet and therefore another E1 call. */
export async function runModelCall(store: Store, request: ModelCallRequest, signal?: AbortSignal, control?: RunControlHold): Promise<ModelCallResult<Sealed<ModelCallOutcome>>> {
  requireModelRequest(store, request); request = sealed(request) as ModelCallRequest;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  if (control !== undefined && !object(control)) invalid('control');
  return modelCallUnder(store, request, signal, new RunControlGate(store, request.project, control));
}
/**
 * One dispatch under the gate of its chain (H1.3): a cycle hands its own gate on, so the admission its first new
 * dispatch takes is the one every continuation and next part of the same invocation writes under.
 */
async function modelCallUnder(store: Store, request: ModelCallRequest, signal: AbortSignal | undefined, gate: RunControlGate): Promise<ModelCallResult<Sealed<ModelCallOutcome>>> {
  try {
    const assignment = modelAssignment(store, request), { packet, payload, wire, binding } = assignment;
    const id = modelRecordId(request.project, wire.requestId), old = store.get<OmModelCall>(id);
    if (old) {
      if (!object(old.value) || !object(old.value.om) || !same(old.value.om.request, request))
        fail('model_call_identity_conflict', id, 'request', 'The packet already belongs to another exact dispatch binding');
      const state = take(readModelCallState(store, { project: request.project, record: reference(old) }));
      if (state.state === 'running') fail('model_call_in_progress', id, 'application', 'Dispatch has no saved receipt; resending is not safe');
      const outcome = state.state === 'received' ? take(applyReceivedModelCall(store, state as Extract<ModelCallState, { state: 'received' }>))
        : state.state === 'application-refused' && state.outcome.record.value.om.completionOwner
          ? take(applyReceivedModelCall(store, { record: state.outcome.record as Revision<OmModelCall>,
            ...checkedModelExchange(store, request, state.outcome.call, state.outcome.record.value.om.exchange!) }))
          : state.outcome as ModelCallOutcome;
      return delivered(settleAppliedCall(store, outcome as ModelCallOutcome)) as ModelCallResult<Sealed<ModelCallOutcome>>;
    }
    const environment = take(prepareManagedCallEnvironment(store, request.project, assignment.admission, request.role));
    const admittedStore = environment?.store ?? store;
    const admission = take(prepareSeriesLineAdmission(admittedStore, request.project, assignment.admission.series));
    const prepared = take(prepareQuestionPacket(admittedStore, packet.value.request as QuestionPacketRequest));
    if (!same(reference(prepared.record), request.packet)) fail('model_call_request_invalid', request.packet.id, 'packet', 'Dispatch uses exactly the currently admitted E2 packet');
    requireAnswerProducers(store, request.packet, request.project, packet.value.request.routes, assignment.batch.id);
    // H1.3: a new dispatch is new work of the pass; its E1, claim and transfer carry the admitted control.
    const controlled = gate.view();
    const guarded = storeView(store, { write(inputs, guards) {
      // Q1: one interception for write and writeMany; caller guards plus the
      // four groups are concatenated first, then environment.remap, then only
      // Refs exactly equal to a pending writeRef drop out (№1734, C20) — the
      // absent guards of H1.0d are kept, nothing is dropped by id alone.
      const all = [...guards, ...prepared.guards, ...admission.guards, request.packet, ...(environment?.guards ?? [])];
      return controlled.writeMany(inputs, (environment ? environment.remap(all) : all)
        .filter(guard => !isRef(guard) || !inputs.some(write => same(writeRef(write), guard))));
    } });
    const admitted = take(recordCall(guarded, request.project, assignment.admission));
    // E1 alone precedes the durable running claim. A repeat without that claim has not sent;
    // fresh dispatch admission plus expected=0 arbitrates concurrent resumptions.
    const call = reference(admitted.call), startedAt = Date.now();
    // Registration may have advanced work itself. Claim derives a new current admission after that transaction.
    const claimEnvironment = prepareClaimEnvironment(store, request.project, call, request.role);
    const claimStore = claimEnvironment?.store ?? store;
    const completion = take(prepareCompletionCall(claimStore, request.project, assignment.admission, 'claim'));
    const claimPacket = take(prepareQuestionPacket(claimStore, packet.value.request as QuestionPacketRequest));
    const claimAdmission = take(prepareSeriesLineAdmission(claimStore, request.project, assignment.admission.series));
    const running: OmModelCall = { projectId: request.project, draftId: packet.id, purpose: payload.purpose as string,
      requestId: wire.requestId, startedAt, finishedAt: null, status: 'running', requested: binding,
      confirmed: unknownConfirmed(), request: { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(payload), record: request.packet },
      response: null, usage: null, usageSource: 'unavailable', error: null,
      om: { version: completion.owner ? 'om-model-call/managed-v1' : 'om-model-call/v1',
        ...(completion.owner ? { completionOwner: { ...completion.owner, call } } : {}), application: 'running', request, call, exchange: null, part: null, diagnostic: null, input: null, failure: null, rejection: null,
        admission: { contract: 'om-model-admission/v1', series: assignment.admission.series, pointer: claimAdmission.pointer } } };
    const physical = await startPhysicalTransport(store, { project: request.project, call, packet: payload as Json, role: request.role },
      // H1.0d (№1715): the saved admission keeps exact references; an absence the packet relied on travels as a condition.
      { id, kind: 'model-call', expected: 0, value: running }, [...claimPacket.guards.filter(isRef), ...claimAdmission.guards, request.packet], signal,
      [...claimPacket.guards.filter(guard => !isRef(guard)),
        ...(claimEnvironment ? claimEnvironment.remap([...completion.guards, ...claimEnvironment.guards]) : completion.guards as TransactionGuard[])],
      completion.writes as Write[], gate);
    const runningRecord = physical.record as Revision<OmModelCall>;
    const exchange: ModelExchange = { project: request.project, request, call, wire: wire as AdapterRequest,
      process: physical.process, launchError: physical.launchError, admissionGuards: physical.guards };
    const exchangeWrite: Write = { id: exchangeId(request), kind: EXCHANGE_KIND, expected: 0, value: exchange }, exchangeRef = writeRef(exchangeWrite);
    const transport = transportOf(exchange);
    // Only the running claim guards physical receipt: changed product sources cannot erase received bytes.
    const receipt: OmModelCall = { ...runningRecord.value, finishedAt: Math.max(Date.now(), startedAt),
      status: transport.kind === 'answered' ? 'succeeded' : 'failed', confirmed: transport.confirmed,
      response: transport.kind === 'answered' ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: exchangeRef } : null,
      usage: transport.usage, usageSource: transport.usage === null ? 'unavailable' : 'adapter',
      error: transport.kind === 'answered' ? null : transport.error.code,
      om: { ...running.om, application: 'received', exchange: exchangeRef } };
    const savedReceipt = writeGuarded<OmModelCall>(store, { unit: 'E4', target: id,
      writes: [exchangeWrite, { id, kind: 'model-call', expected: runningRecord.revision, value: receipt }], guards: [reference(runningRecord)] });
    if (!savedReceipt.ok && store.get<ModelCall>(id)?.value.recovery) {
      const recovered = preserveLateTransport(store, request.project, runningRecord, call, physical);
      return delivered(take(readModelCall(store, { project: request.project, record: reference(recovered) }))) as ModelCallResult<Sealed<ModelCallOutcome>>;
    }
    const persisted = take(savedReceipt);
    const state = take(readModelCallState(store, { project: request.project, record: reference(persisted.find(row => row.id === id)!) }));
    if (state.state !== 'received') fail('model_call_record_invalid', id, 'application', 'Physical receipt must precede application');
    const applied = take(applyReceivedModelCall(store, state as Extract<ModelCallState, { state: 'received' }>));
    return delivered(settleAppliedCall(store, applied as ModelCallOutcome)) as ModelCallResult<Sealed<ModelCallOutcome>>;
  } catch (error) {
    { const failed = caught(error); if (failed) return failed; }
    if (error instanceof RunControlLost) return controlLost(error);
    throw error;
  }
}

export interface ModelTransportRequest { project: string; call: Ref; packet: Json; role: 'implementer' | 'reviewer' }
interface TransportExchange extends Omit<ModelExchange, 'request' | 'admissionGuards'> { request: ModelTransportRequest }
export interface TransportModelCall extends ModelCall {
  transport: { version: 'om-model-transport/v1' | 'om-model-transport/managed-v1'; completionOwner?: CompletionCallOwner; request: ModelTransportRequest; exchange: Ref | null };
}
export interface ModelTransportOutcome { record: Revision<TransportModelCall>; call: Ref; exchange: Ref | null; result: AdapterResult; repeated: boolean }
const DIRECT_TRANSPORT_PURPOSES: readonly string[] = Object.freeze(['fact-assessment', 'stop-analysis', 'origin-analysis', 'wake-choice']);
/** Calls outside a managed attempt's registry: the analyses and (G5.1) the wake choice of a frame's producer end. */
const unmanagedPurpose = (purpose: string): boolean => purpose === 'stop-analysis' || purpose === 'origin-analysis' || purpose === 'wake-choice';
const directTransportPurpose = (purpose: string): boolean => DIRECT_TRANSPORT_PURPOSES.includes(purpose);
function requireTransport(store: Store, request: unknown): asserts request is ModelTransportRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.call)
    || !Object.hasOwn(request, 'packet') || !['implementer', 'reviewer'].includes(request.role as string)
    || !exactKeys(request, ['project', 'call', 'packet', 'role'])) invalid('transport');
  try { canonical(request.packet); } catch (error) { if (error instanceof EngineError) invalid('packet'); throw error; }
}
function callPacketText(packet: unknown, call: string) {
  try { return packetPrompt(packet, call); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'packet_brief_invalid')
      fail('packet_invalid', call, 'packet', error.message);
    throw error;
  }
}
function transportAssignment(store: Store, request: ModelTransportRequest, history?: CallHistory) {
  const call = take(readCall(store, request.project, request.call, history));
  if (call.revision !== 1) fail('model_call_request_invalid', request.call.id, 'call', 'A transport names the original E1 admission');
  const packet = callPacketText(request.packet, call.value.call);
  if (!same(call.value.packet, { hash: hashJson(request.packet), chars: packet.length, bytes: Buffer.byteLength(packet) }))
    fail('packet_invalid', request.call.id, 'packet', 'The actual sent body must reproduce the admitted fingerprint and both sizes');
  const environment = take(readRecord<Environment>(store, call.value.dispatch.config,
    { unit: 'E4', target: request.call.id, id: `environment:${request.project}`, kind: 'environment' })).value as Environment;
  readDispatchAdapter(store, call.value.dispatch.adapter);
  if (!object(environment)) fail('dispatch_contract_invalid', request.call.id, 'environment', 'A dispatch environment must be a record');
  const configuredBinding = environment[request.role];
  if (environment.projectId !== request.project || !object(configuredBinding)
    || !text(configuredBinding.actor) || !object(configuredBinding.command) || !text(configuredBinding.command.executable)
    || !Array.isArray(configuredBinding.command.args) || !configuredBinding.command.args.every(arg => typeof arg === 'string')
    || !text(environment.workspace) || !Number.isSafeInteger(environment.timeoutMs) || environment.timeoutMs < 100 || environment.timeoutMs > 3_600_000)
    fail('dispatch_contract_invalid', request.call.id, 'dispatch', 'The admitted dispatch must supply the exact supported adapter and environment binding');
  const binding = resolveRoleMode(request.role, configuredBinding, 'research');
  const wire = take(adapterRequest({ requestId: call.value.call, packet: request.packet,
    model: binding.model, effort: binding.effort, ...(binding.speed === undefined ? {} : { speed: binding.speed }) }));
  return { call, environment, binding, wire };
}

function assessmentTransportAdmission(store: Store, request: ModelTransportRequest,
  call: Revision<AnyCallRecord>, binding: { actor: string }, current: boolean): readonly TransactionGuard[] {
  if (call.value.purpose !== 'fact-assessment') return [];
  const basis = call.value.basis;
  if (!basis || basis.kind !== 'fact-assessment' || !basis.assessment) {
    if (!current) return []; // E5.0 physical history predates the mandatory E5 intent.
    fail('model_call_request_invalid', call.id, 'basis.assessment', 'A new assessor dispatch needs its proved E5 intent');
  }
  let proof: { readonly call: string; readonly basis: unknown; readonly gaps: unknown; readonly series: unknown;
    readonly attempt: number; readonly goal: unknown; readonly dispatch: unknown; readonly packet: unknown;
    readonly originalActor: string };
  let admissionGuards: readonly TransactionGuard[] = [];
  if (current) {
    const prepared = take(prepareAssessmentAdmission(store, request.project, basis.assessment));
    proof = prepared;
    admissionGuards = prepared.guards;
  } else proof = take(readAssessmentIntentAt(store, request.project, basis.assessment));
  if (request.role !== 'reviewer' || binding.actor === proof.originalActor
    || call.value.call !== proof.call || !same(call.value.basis, proof.basis)
    || !same(call.value.gaps, proof.gaps) || !same(call.value.series, proof.series)
    || call.value.attempt !== proof.attempt || !same(call.value.goal, proof.goal)
    || !same(call.value.dispatch, proof.dispatch) || !same(request.packet, proof.packet)) {
    fail(current ? 'model_call_request_invalid' : 'model_call_record_invalid', call.id, 'assessment',
      'The assessor dispatch must reproduce its exact intent with a different actual actor');
  }
  return admissionGuards;
}
/** A claim proves the exact registered E1 and its selected plan before using current compatibility. */
function prepareClaimEnvironment(store: Store, project: string, callRef: Ref, role: 'implementer' | 'reviewer') {
  const call = take(readCall(store, project, callRef));
  // The body is already checked by transportAssignment; the resolver locates the exact E2/intent by E1 identity.
  return take(prepareManagedCallEnvironment(store, project, call.value, role));
}
/** Shared physical boundary: real body fingerprint, current purpose admission and durable claim before spawn. */
async function startPhysicalTransport(store: Store, request: ModelTransportRequest, running: Write, guards: readonly Ref[], signal: AbortSignal | undefined,
  extraGuards: readonly TransactionGuard[], sourceWrites: readonly Write[], gate: RunControlGate) {
  const assignment = transportAssignment(store, request);
  const environment = prepareClaimEnvironment(store, request.project, request.call, request.role);
  const admittedStore = environment?.store ?? store;
  const prepared = take(prepareCallDispatch(admittedStore, request.project, request.call));
  const assessmentGuards = assessmentTransportAdmission(admittedStore, request, assignment.call, assignment.binding, true);
  const line = 'om' in (running.value as ModelCall)
    ? take(prepareSeriesLineAdmission(admittedStore, request.project, assignment.call.value.series)) : null;
  const collected: TransactionGuard[] = [...guards, ...prepared.guards, ...(line?.guards ?? []), ...(environment?.guards ?? [])];
  const admissionGuards = refs((environment ? environment.remap(collected) : collected).filter(isRef));
  const counterId = `project-dispatch:${hashJson(request.project)}`;
  const counter = store.get<{ projectId: string; serial: number }>(counterId);
  if (counter && !(counter.kind === 'project-dispatch' && object(counter.value)
    && counter.value.projectId === request.project && Number.isSafeInteger(counter.value.serial) && counter.value.serial >= 0))
    raise('research_dispatch_invalid', 'Invalid project dispatch counter');
  const controlled = gate.view();
  let record = take(writeGuarded<ModelCall>(controlled, { unit: 'E4', target: running.id,
    writes: [...sourceWrites, { ...running, value: { ...running.value as ModelCall, ...physicalClaim() } },
      { id: counterId, kind: 'project-dispatch', expected: counter?.revision ?? 0,
        value: { projectId: request.project, serial: (counter?.value.serial ?? 0) + 1 } }],
    guards: uniqueTransactionGuards((environment ? environment.remap([...admissionGuards, ...assessmentGuards, ...extraGuards])
      : [...admissionGuards, ...assessmentGuards, ...extraGuards]).concat(counter ? [reference(counter)] : [])
      .filter(guard => !isRef(guard) || !sourceWrites.some(write => same(writeRef(write), guard)))) }))
    .find(row => row.id === running.id)!;
  let processResult: ProcessResult | null = null, launchError: ModelExchange['launchError'] = null;
  // The permission to transfer is the committed authorization under the admitted control (№1910 п.4): a stop saved
  // before it transfers nothing and the created process is stopped by the common runtime; after it, the live call is
  // cancelled through its signal once the watched control moves on.
  const cancel = new AbortController(), forward = () => cancel.abort();
  if (signal?.aborted) cancel.abort(); else signal?.addEventListener('abort', forward, { once: true });
  const unwatch = gate.watch(cancel);
  try { processResult = await runProcess(assignment.binding.command, assignment.environment.workspace,
    canonical(assignment.wire), assignment.environment.timeoutMs, cancel.signal, true, pid => {
      try { record = authorizeModelDispatch(controlled, reference(record), pid); }
      catch (error) {
        if (error instanceof RunControlLost) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
        throw error;
      }
    }); }
  catch (error) {
    // An unproven stop is not a launch error: the dispatched process may still
    // be executing. The claim stays running, the process-stop/v1 witness keeps
    // the evidence, and the typed error propagates for an explicit recovery.
    if (!(error instanceof EngineError)) throw error;
    if (isProcessStopRefusal(error)) {
      writeProcessStopWitness(store, reference(record),
        { owner: (record.value as ModelCall).ownerProcess ?? null, child: (record.value as ModelCall).providerProcess ?? null }, error);
      throw error;
    }
    // Every other typed failure at this physical boundary is retained, including a failed
    // ownership CAS/identity capture in onSpawn. No request was sent on that path.
    launchError = { code: error.code, message: error.message };
  } finally { unwatch(); signal?.removeEventListener('abort', forward); }
  return { record, process: processResult, launchError, guards: admissionGuards };
}
const transportExchangeId = (request: ModelTransportRequest) => `om-model-transport:${request.project}:${hashJson(request)}`;
/** Direct transport keeps E1's body and outcome opaque; it uses the same process boundary as ordinary E2/E3 calls. */
export function readModelTransport(store: Store, request: { project: string; record: Ref }, history?: CallHistory): ModelCallResult<Sealed<ModelTransportOutcome>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('transport-record');
  if (history !== undefined && (!object(history) || !exactKeys(history, ['journal']) || !isRef(history.journal))) invalid('history');
  return result(() => {
    const record = take(readRecord<TransportModelCall>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `model-call:${request.project}:om:`, kind: 'model-call' }));
    if (!object(record.value) || Object.hasOwn(record.value, 'om') || !object(record.value.transport) || !['om-model-transport/v1', 'om-model-transport/managed-v1'].includes(record.value.transport.version))
      fail('model_call_record_invalid', record.id, 'transport', 'Direct transport playback requires explicit transport provenance');
    const source = record.value.transport.request;
    requireTransport(store, source);
    if (source.project !== request.project) fail('model_call_record_invalid', record.id, 'project', 'This transport belongs to this project');
    const { call, wire, binding } = transportAssignment(store, source, history);
    if (!directTransportPurpose(call.value.purpose))
      fail('model_call_request_invalid', call.id, 'purpose', 'Ordinary dispatch is admitted through the E2/E3 orchestrator');
    assessmentTransportAdmission(store, source, call, binding, false);
    const completion = checkedCompletionOwner(store, request.project, source.call,
      call.value.basis?.kind === 'fact-assessment' && call.value.basis.assessment ? call.value.basis.assessment : source.call,
      record.value.transport.completionOwner, history);
    if (record.value.transport.version !== (completion ? 'om-model-transport/managed-v1' : 'om-model-transport/v1'))
      fail('completion_invalid', record.id, 'version', 'Transport version follows its exact purpose and completion era');
    const value = record.value;
    if (record.id !== modelRecordId(request.project, wire.requestId) || value.projectId !== request.project
      || value.draftId !== call.id || value.requestId !== wire.requestId || value.purpose !== call.value.purpose
      || !object(value.requested) || !object(value.request) || !same(value.requested, binding)
      || !same(value.request, { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(source.packet) }))
      fail('model_call_record_invalid', record.id, 'request', 'Direct transport runtime must reproduce the actual admitted body and executor');
    if (value.status === 'running') {
      requireUnreceivedModelCall(record as Revision<TransportModelCall>);
      if (value.transport.exchange !== null)
        fail('model_call_record_invalid', record.id, 'exchange', 'A running direct transport retains an explicit absence of received exchange');
      fail('model_call_in_progress', record.id, 'status', 'The admitted call already owns a physical dispatch');
    }
    if (value.recovery) {
      const recovered = readModelCallRecovery(store, request.project, request.record);
      requireUnreceivedModelCall(recovered.original);
      if (!Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt)
        fail('model_call_record_invalid', record.id, 'finishedAt', 'Direct transport recovery retains its physical completion time');
      if (!same((recovered.original.value as TransportModelCall).transport, value.transport) || value.transport.exchange !== null)
        fail('model_call_record_invalid', record.id, 'recovery', 'Direct transport recovery retains its exact assignment without an invented response');
      return { record: record as Revision<TransportModelCall>, call: source.call, exchange: null, repeated: true,
        result: { kind: 'interrupted' as const, usage: null, confirmed: unknownConfirmed(),
          error: { code: 'process_lost', field: 'process', message: recovered.incident.value.reason } } };
    }
    const ref = value.transport.exchange;
    if (!isRef(ref)) fail('model_call_record_invalid', record.id, 'exchange', 'A completed direct transport keeps the original transport evidence');
    const exchange = take(readRecord<TransportExchange>(store, ref,
      { unit: 'E4', target: record.id, id: transportExchangeId(source), kind: EXCHANGE_KIND }));
    if (exchange.revision !== 1 || !same(exchange.value.request, source) || !same(exchange.value.call, source.call)
      || exchange.value.project !== request.project || !same(exchange.value.wire, wire)
      || !exactKeys(exchange.value, ['project', 'request', 'call', 'wire', 'process', 'launchError'])
      || (exchange.value.process === null) === (exchange.value.launchError === null))
      fail('model_call_record_invalid', record.id, 'exchange', 'The transport evidence must belong to this actual E1 body');
    const decoded = transportOf(exchange.value as TransportExchange);
    if (value.status !== (decoded.kind === 'answered' ? 'succeeded' : 'failed')
      || !same(value.confirmed, decoded.confirmed) || !same(value.usage, decoded.usage)
      || value.usageSource !== (decoded.usage === null ? 'unavailable' : 'adapter')
      || value.error !== (decoded.kind === 'answered' ? null : decoded.error.code)
      || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt
      || !same(value.response, decoded.kind === 'answered' ? { chars: decoded.raw.length, bytes: Buffer.byteLength(decoded.raw), record: ref } : null))
      fail('model_call_record_invalid', record.id, 'outcome', 'Direct transport runtime is derived from the saved adapter response');
    return { record: record as Revision<TransportModelCall>, call: source.call, exchange: ref, result: decoded, repeated: true };
  });
}
export async function runModelTransport(store: Store, request: ModelTransportRequest, signal?: AbortSignal,
  extraGuards: readonly TransactionGuard[] = [], control?: RunControlHold): Promise<ModelCallResult<Sealed<ModelTransportOutcome>>> {
  requireTransport(store, request); request = sealed(request) as ModelTransportRequest;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  if (control !== undefined && !object(control)) invalid('control');
  return transportUnder(store, request, signal, extraGuards, new RunControlGate(store, request.project, control));
}
/** A direct transport under the gate of its producer's chain (E5 or A6): their intent, E1 and dispatch share one admission. */
export async function transportUnder(store: Store, request: ModelTransportRequest, signal: AbortSignal | undefined,
  extraGuards: readonly TransactionGuard[], gate: RunControlGate): Promise<ModelCallResult<Sealed<ModelTransportOutcome>>> {
  requireTransport(store, request); request = sealed(request) as ModelTransportRequest;
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal');
  if (!(gate instanceof RunControlGate && gate.project === request.project)) raise('model_call_request_invalid', 'A transport runs under the control gate of its own project');
  extraGuards = uniqueTransactionGuards(extraGuards);
  try {
    const { call, wire, binding } = transportAssignment(store, request), id = modelRecordId(request.project, wire.requestId);
    if (!directTransportPurpose(call.value.purpose))
      fail('model_call_request_invalid', request.call.id, 'purpose', 'Ordinary MC1/MC2 calls require the E2/E3 orchestrator');
    const prior = store.get(id);
    if (prior) {
      const saved = take(readModelTransport(store, { project: request.project, record: reference(prior) }));
      if (!same(saved.record.value.transport.request, request)) fail('model_call_identity_conflict', id, 'request', 'A physical identity cannot be rebound to another request');
      settlePhysicalCall(store, saved.record, request.call);
      return delivered(saved) as ModelCallResult<Sealed<ModelTransportOutcome>>;
    }
    const completion = take(prepareCompletionCall(store, request.project, { ...call.value, packet: request.packet } as AnyRecordCallRequest, 'claim'));
    if (completion.writes.length) fail('completion_invalid', call.id, 'work', 'The assessor must be registered before its claim');
    extraGuards = uniqueTransactionGuards([...extraGuards, ...completion.guards]);
    const startedAt = Date.now();
    const running: TransportModelCall = { projectId: request.project, draftId: call.id, purpose: call.value.purpose,
      requestId: call.value.call, startedAt, finishedAt: null, status: 'running', requested: binding, confirmed: unknownConfirmed(),
      request: { chars: wire.prompt.length, bytes: Buffer.byteLength(wire.prompt), hash: hashJson(request.packet) },
      response: null, usage: null, usageSource: 'unavailable', error: null,
      transport: { version: completion.owner ? 'om-model-transport/managed-v1' : 'om-model-transport/v1',
        ...(completion.owner ? { completionOwner: { ...completion.owner, call: request.call } } : {}), request, exchange: null } };
    const physical = await startPhysicalTransport(store, request, { id, kind: 'model-call', expected: 0, value: running }, [], signal, extraGuards, [], gate);
    const exchange: TransportExchange = { project: request.project, request, call: request.call, wire: wire as AdapterRequest,
      process: physical.process, launchError: physical.launchError };
    const exchangeWrite: Write = { id: transportExchangeId(request), kind: EXCHANGE_KIND, expected: 0, value: exchange }, ref = writeRef(exchangeWrite);
    const decoded = transportOf(exchange);
    const finished: TransportModelCall = { ...physical.record.value as TransportModelCall, finishedAt: Math.max(Date.now(), startedAt),
      status: decoded.kind === 'answered' ? 'succeeded' : 'failed', confirmed: decoded.confirmed, usage: decoded.usage,
      usageSource: decoded.usage === null ? 'unavailable' : 'adapter', error: decoded.kind === 'answered' ? null : decoded.error.code,
      response: decoded.kind === 'answered' ? { chars: decoded.raw.length, bytes: Buffer.byteLength(decoded.raw), record: ref } : null,
      transport: { ...running.transport, exchange: ref } };
    const savedReceipt = writeGuarded<TransportModelCall>(store, { unit: 'E4', target: id,
      writes: [exchangeWrite, { id, kind: 'model-call', expected: physical.record.revision, value: finished }], guards: [reference(physical.record)] });
    if (!savedReceipt.ok && store.get<ModelCall>(id)?.value.recovery) {
      const recovered = preserveLateTransport(store, request.project, physical.record as Revision<ModelCall>, request.call, physical);
      return delivered(take(readModelTransport(store, { project: request.project, record: reference(recovered) }))) as ModelCallResult<Sealed<ModelTransportOutcome>>;
    }
    const written = take(savedReceipt);
    settlePhysicalCall(store, written.find(record => record.id === id)!, request.call);
    return delivered({ record: written.find(record => record.id === id)!, call: request.call, exchange: ref, result: decoded, repeated: false }) as ModelCallResult<Sealed<ModelTransportOutcome>>;
  } catch (error) {
    if (error instanceof CallFailure) {
      return { ok: false, refusal: error.refusal };
    }
    if (error instanceof RunControlLost) return controlLost(error);
    throw error;
  }
}

/** Collect the exact dependency closure traversed by the common historical admission/form readers.
 * This deliberately observes their reads rather than keeping another, inevitably incomplete admission list. */
function historicalApplicationBasis(store: Store, request: ModelCallRequest, call: Ref, transport: AdapterResult): Ref[] {
  const seen: Ref[] = [];
  // S1.1 (№1887-5): the common transparent collector, not an opaque Proxy of its own — the readers' proofs stay shared
  // with the operation and a hot proof replays the same references to this collector. Only gets count, as before.
  // S1.2 (№2329): the basis is a sorted set of exact references, so the collector declares the distinct semantics it
  // needs: a replayed kept proof then visits each shared subproof once instead of once per nested use.
  const observed = historicalTrace(store, (ref, _head, method) => { if (method === 'get') seen.push(ref); }, 'distinct');
  modelAssignment(observed, request);
  take(readCall(observed, request.project, call));
  if (transport.kind === 'answered') checkAnswerForm(observed, { project: request.project, packet: request.packet, raw: transport.raw });
  return refs(seen);
}

export type ApplicationFileObservation = { kind: 'read'; bytes: string }
  | { kind: 'unavailable'; code: 'ENOENT' | 'ENOTDIR' | 'EACCES' | 'EISDIR' | 'EPERM' | 'file_alias' | 'file_too_large' };
const unavailableFileCodes: readonly string[] = ['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR', 'EPERM', 'file_alias', 'file_too_large'] as const;
/** The same bounded observation is used by physical E4 rejections and E5 application termination. */
export function captureApplicationFileObservation(source: Source): ApplicationFileObservation {
  const path = source.origin.location;
  try {
    return realpathSync(path) !== path ? { kind: 'unavailable', code: 'file_alias' }
      : statSync(path).size > 5_000_000 ? { kind: 'unavailable', code: 'file_too_large' }
      : { kind: 'read', bytes: readRejectedFile(path).toString('base64') };
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (!unavailableFileCodes.includes(code ?? '')) throw error;
    return { kind: 'unavailable', code: code as Extract<ApplicationFileObservation, { kind: 'unavailable' }>['code'] };
  }
}
/** Exact saved bytes only; this deliberately has no current filesystem access. */
export function readApplicationFileObservation(source: Source, observation: unknown): ModelCallResult<Sealed<{ changed: boolean }>> {
  return result(() => {
    if (!object(observation)) fail('model_call_record_invalid', source.origin.location, 'files', 'A file observation has a closed form');
    if (observation.kind === 'read') {
      if (typeof observation.bytes !== 'string' || Buffer.from(observation.bytes, 'base64').toString('base64') !== observation.bytes
        || Buffer.from(observation.bytes, 'base64').length > 5_000_000)
        fail('model_call_record_invalid', source.origin.location, 'files', 'A retained read contains bounded exact file bytes');
      return { changed: digest(Buffer.from(observation.bytes, 'base64')) !== source.sha256 };
    }
    if (observation.kind === 'unavailable' && typeof observation.code === 'string' && unavailableFileCodes.includes(observation.code)) return { changed: true };
    fail('model_call_record_invalid', source.origin.location, 'files', 'Unavailable file evidence names the concrete failed read');
  });
}

interface ModelApplicationRejection {
  project: string; packet: Ref; call: Ref; exchange: Ref; guards: Ref[]; completion: Ref | null;
  terminal?: ModelTerminalWitness;
  expectations: { id: string; expected: number }[]; heads: { id: string; head: Ref | null }[]; failure: Refusal;
  files: { source: Ref; observation: ApplicationFileObservation }[];
}
const APPLICATION_REJECTION_KIND = 'om-model-application-rejection';
/** The refused transaction keeps the exact failed expected/observed comparison; later heads cannot rewrite it. */
export function readModelApplicationRejection(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<{record: Revision<ModelApplicationRejection>; failure: Refusal}>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)
    || !exactKeys(request, ['project', 'record'])) invalid('application-rejection');
  return result(() => {
    const record = take(readRecord<ModelApplicationRejection>(store, request.record,
      { unit: 'E4', target: request.record.id, idPrefix: `${APPLICATION_REJECTION_KIND}:${request.project}:`, kind: APPLICATION_REJECTION_KIND }));
    const value = record.value;
    if (record.revision !== 1 || !object(value) || !exactKeys(value, ['project', 'packet', 'call', 'exchange', 'guards', 'expectations', 'heads', 'failure', 'files', 'completion',
      ...(Object.hasOwn(value, 'terminal') ? ['terminal'] : [])])
      || value.project !== request.project || ![value.packet, value.call, value.exchange].every(isRef)
      || !(value.completion === null || isRef(value.completion))
      || !Array.isArray(value.guards) || !value.guards.every(isRef) || !Array.isArray(value.expectations)
      || !value.expectations.every(row => object(row) && text(row.id) && Number.isSafeInteger(row.expected) && Number(row.expected) >= 0)
      || !Array.isArray(value.heads) || !value.heads.every(row => object(row) && text(row.id) && (row.head === null || isRef(row.head) && row.head.id === row.id))
      || !object(value.failure) || !['input_stale', 'revision_conflict'].includes(value.failure.code) || !text(value.failure.message)
      || !Array.isArray(value.files) || !value.files.every(file => object(file) && isRef(file.source) && object(file.observation))
      || record.id !== `${APPLICATION_REJECTION_KIND}:${request.project}:${hashJson(value)}`)
      fail('model_call_record_invalid', record.id, 'rejection', 'An immutable rejection needs explicit expected and observed source identities');
    take(readQuestionPacket(store, { project: request.project, record: value.packet }));
    const exchange = take(readRecord<ModelExchange>(store, value.exchange,
      { unit: 'E4', target: record.id, idPrefix: `${EXCHANGE_KIND}:${request.project}:`, kind: EXCHANGE_KIND }));
    requireModelRequest(store, exchange.value.request);
    if (!same(exchange.value.request.packet, value.packet) || !same(exchange.value.call, value.call))
      fail('model_call_record_invalid', record.id, 'exchange', 'A rejection belongs to its exact E2 assignment and admitted exchange');
    const assignment = modelAssignment(store, exchange.value.request);
    if (!same(exchange.value.wire, assignment.wire)) fail('model_call_record_invalid', record.id, 'wire', 'A rejection keeps the actual admitted wire');
    const decoded = transportOf(exchange.value as ModelExchange);
    const checked = decoded.kind === 'answered' ? checkAnswerForm(store, { project: request.project, packet: value.packet, raw: decoded.raw }) : null;
    const runtimeId = modelRecordId(request.project, exchange.value.wire.requestId), runtime = store.get<OmModelCall>(runtimeId, 1);
    if (!runtime) fail('model_call_record_invalid', record.id, 'runtime', 'A rejected transaction follows its durable pre-dispatch claim');
    const originalCall = take(readCall(store, request.project, value.call));
    const originalAdmission = modelWorkAdmission(store, runtime, originalCall.value.series);
    const originalProof = take(readSeriesWorkAdmission(store, { project: request.project,
      series: originalAdmission.series, pointer: originalAdmission.pointer }));
    let terminalReferences: Ref[] = [];
    if (Object.hasOwn(value, 'terminal')) {
      const terminal = modelTerminalBasis(store, request.project, value.terminal!);
      if (terminal.source.id !== runtimeId || terminal.source.value.om.application !== 'received'
        || !same(value.terminal!.call, value.call) || !same(terminal.source.value.om.request.packet, value.packet)
        || !same(terminal.source.value.om.exchange, value.exchange) || value.completion !== null || value.failure.code !== 'input_stale')
        fail('model_call_record_invalid', record.id, 'terminal', 'The rejected application retains its own received outcome and proved admission change');
      terminalReferences = terminal.references;
    }
    const relevant = new Set(refs([reference(runtime), ...originalProof.references,
      ...value.guards.filter(ref => {
        if (ref.id !== runtimeId) return false;
        const prior = store.get<OmModelCall>(ref.id, ref.revision);
        return prior && same(reference(prior), ref) && prior.value.om?.application === 'received'
          && same(prior.value.om.exchange, value.exchange) && same(prior.value.om.call, value.call);
      }), ...historicalApplicationBasis(store, exchange.value.request, value.call, decoded)]).map(canonical));
    if (value.completion) {
      const completed = take(readAnySeriesAt(store, request.project, value.completion));
      const original = take(readCall(store, request.project, value.call));
      const attempt = [...completed.value.inherited, ...completed.value.attempts].find(item => item.ordinal === original.value.attempt);
      if (completed.id !== original.value.series.id || !attempt?.outcome || !same(attempt.goal, original.value.goal)
        || !same(value.heads.find(row => row.id === completed.id)?.head ?? null, value.completion))
        fail('model_call_record_invalid', record.id, 'completion', 'An existing outcome must be the checked completion of the original admitted attempt');
    }
    const relevantStale = value.guards.filter(ref => relevant.has(canonical(ref))
      && !same(value.heads.find(row => row.id === ref.id)?.head ?? null, ref));
    const outputIds = new Set([runtimeId, value.exchange.id, partResponseId(request.project, value.call)]);
    if (decoded.kind === 'answered') {
      const responseValue: PartResponseRecord = { project: request.project, packet: value.packet, call: value.call,
        requestId: exchange.value.wire.requestId, raw: decoded.raw };
      const response = { id: partResponseId(request.project, value.call), revision: 1, hash: hashJson(responseValue) };
      const partKey = hashJson({ project: request.project, packet: value.packet, call: value.call, response });
      outputIds.add(`om-proposal:${request.project}:part:${partKey}`); outputIds.add(`om-part-result:${request.project}:${partKey}`);
    }
    if (checked?.ok && checked.value.kind === 'input-decisions') {
      outputIds.add(checked.value.input.id); for (const ref of checked.value.decisions) outputIds.add(ref.id);
    }
    const ids = [...new Set([...value.guards.map(ref => ref.id), ...value.expectations.map(row => row.id)])].sort();
    if (!same(value.heads.map(row => row.id), ids))
      fail('model_call_record_invalid', record.id, 'heads', 'Every guarded input and written identity has one observed head');
    for (const ref of [...value.guards, ...value.heads.flatMap(row => row.head ? [row.head] : []), value.packet, value.call, value.exchange]) {
      const row = store.get(ref.id, ref.revision);
      if (!row || !same(reference(row), ref)) fail('model_call_record_invalid', record.id, 'heads', 'Retained failure evidence must resolve at its exact historical revision');
    }
    const head = (id: string) => value.heads.find(row => row.id === id)!.head;
    let fileStale = false;
    for (const file of value.files) {
      if (!value.guards.some(ref => same(ref, file.source)) || !relevant.has(canonical(file.source)))
        fail('model_call_record_invalid', record.id, 'files', 'Observed files must belong to the actual guarded historical sources');
      const source = take(readRecord<Source>(store, file.source, { unit: 'E4', target: record.id, idPrefix: `source:${request.project}:`, kind: 'source' }));
      if (source.value.projectId !== request.project || source.value.origin.kind !== 'file' || digest(source.value.content) !== source.value.sha256)
        fail('model_call_record_invalid', record.id, 'files', 'A file observation compares a valid exact file source');
      // Validate every saved observation, even after an earlier one has proved a change.
      const observed = take(readApplicationFileObservation(source.value as Source, file.observation));
      fileStale = observed.changed || fileStale;
    }
    const stale = fileStale || relevantStale.length > 0 || terminalReferences.length > 0;
    const conflict = value.expectations.some(row => outputIds.has(row.id) && (head(row.id)?.revision ?? 0) !== row.expected);
    if (value.failure.code === 'revision_conflict' ? !conflict : !stale)
      fail('model_call_record_invalid', record.id, 'failure', 'The retained identities must prove the rejected transaction class');
    return { record: record as Revision<ModelApplicationRejection>, failure: value.failure as Refusal };
  });
}
function saveRejectedModelApplication(store: Store, input: { request: ModelCallRequest; call: Ref; running: Revision<OmModelCall>;
  exchange: Write; transport: AdapterResult; failure: Refusal; writes: Write[]; guards: Ref[] }): ModelCallResult<Sealed<ModelCallOutcome>> {
  return result(() => {
    const { request, call, running, exchange, transport } = input, exchangeRef = writeRef(exchange);
    const normalized = refuse('input_stale', `${input.failure.code}: ${input.failure.message}`,
      { ...input.failure.at, unit: 'E4' }, 'producer');
    let failure = ['input_stale', 'revision_conflict'].includes(input.failure.code) ? input.failure
      : !normalized.ok ? normalized.refusal : input.failure;
    const admitted = take(readCall(store, request.project, call)), seriesHead = store.get(admitted.value.series.id);
    const series = seriesHead ? take(readAnySeriesAt(store, request.project, reference(seriesHead))) : null;
    const completed = series?.value.attempts.find(item => item.ordinal === admitted.value.attempt)?.outcome;
    const completion = completed && series ? reference(series) : null;
    const terminal = completion ? null : prepareModelTerminalWitness(store, running);
    if (terminal && !normalized.ok) failure = normalized.refusal;
    const ids = [...new Set([...input.guards.map(ref => ref.id), ...input.writes.map(write => write.id)])].sort();
    const value: ModelApplicationRejection = { project: request.project, packet: request.packet, call, exchange: exchangeRef, completion,
      ...(terminal ? { terminal: terminal.witness } : {}),
      guards: input.guards, expectations: input.writes.map(write => ({ id: write.id, expected: write.expected })),
      heads: ids.map(id => { const head = store.get(id); return { id, head: head ? reference(head) : null }; }), failure,
      files: input.guards.flatMap(ref => {
        const source = store.get<Source>(ref.id, ref.revision);
        if (!source || source.kind !== 'source' || !object(source.value) || source.value.projectId !== request.project
          || !object(source.value.origin) || source.value.origin.kind !== 'file' || sourceIsCurrent(source.value)) return [];
        const observation = captureApplicationFileObservation(source.value);
        return [{ source: ref, observation }];
      }) };
    const rejected: Write = { id: `${APPLICATION_REJECTION_KIND}:${request.project}:${hashJson(value)}`,
      kind: APPLICATION_REJECTION_KIND, expected: 0, value };
    const rejectionRef = writeRef(rejected), writes = [rejected];
    take(readModelApplicationRejection(pendingCallStore(store, writes), { project: request.project, record: rejectionRef }));
    const finish = running.value.om.completionOwner || completion || terminal ? { diagnostic: null, writes: [], guards: terminal?.guards ?? [] }
      : prepareModelFinish(pendingCallStore(store, writes), { project: request.project, packet: request.packet, call,
        response: null, code: failure.code, message: failure.message, reason: 'interrupted', evidence: [exchangeRef, rejectionRef] });
    writes.push(...finish.writes);
    const finished: OmModelCall = { ...running.value, finishedAt: Math.max(Date.now(), running.value.startedAt), status: 'failed',
      confirmed: transport.confirmed, usage: transport.usage, usageSource: transport.usage === null ? 'unavailable' : 'adapter', error: failure.code,
      response: transport.kind === 'answered' ? { chars: transport.raw.length, bytes: Buffer.byteLength(transport.raw), record: exchangeRef } : null,
      om: { ...running.value.om, application: 'application-refused', exchange: exchangeRef, failure, rejection: rejectionRef, diagnostic: finish.diagnostic,
        ...(terminal ? { terminal: terminal.witness, completion: null } : {}) } };
    writes.push({ id: running.id, kind: running.kind, expected: running.revision, value: finished });
    const committed = take(writeGuarded<OmModelCall>(store, { unit: 'E4', target: running.id, writes,
      guards: externalGuards([reference(running), ...finish.guards], writes) }));
    return { record: committed.find(row => row.id === running.id)!, packet: request.packet, call,
      response: null, outcome: null, part: null, diagnostic: finish.diagnostic, repeated: false };
  });
}

function recoveryFinish(store: Store, record: Revision<OmModelCall>, incident: Ref) {
  return prepareModelFinish(store, { project: record.value.projectId, packet: record.value.om.request.packet,
    call: record.value.om.call, response: null, code: 'process_lost', message: 'The physical executor was lost; answer and usage remain unknown',
    reason: 'interrupted', evidence: [incident] });
}
/** The physical proof and the owning product transition are committed together. No liveness
 * logic belongs here: the engine's shared recovery preparation is the only observer. */
export function recoverOmModelCall(store: Store, project: string, ref: Ref): Revision<ModelCall> {
  try {
    const head = store.get<ModelCall>(ref.id);
    if (head?.value.recovery) {
      const checked = readModelCallRecovery(store, project, reference(head));
      if (!same(ref, reference(head)) && !same(ref, reference(checked.original)))
        fail('model_call_foreign', ref.id, 'recovery', 'Recovery repeat must name the original loss or its exact terminal result');
      const saved = 'om' in head.value ? take(readModelCall(store, { project, record: reference(head) }))
        : take(readModelTransport(store, { project, record: reference(head) }));
      settlePhysicalCall(store, saved.record, saved.call);
      return head;
    }
    const prepared = prepareModelCallRecovery(store, project, ref);
    const original = prepared.call, incident = reference(prepared.incident);
    let finished = prepared.writes[0]!.value as ModelCall;
    const writes = [...prepared.writes.slice(1)], guards: TransactionGuard[] = [...prepared.guards];
    if ('om' in original.value) {
      const state = take(readModelCallState(store, { project, record: ref }));
      if (state.state !== 'running') fail('model_call_not_running', ref.id, 'application', 'Only an unreceived physical call needs loss recovery');
      const record = original as Revision<OmModelCall>, admitted = take(readCall(store, project, record.value.om.call));
      const seriesHead = store.get(admitted.value.series.id);
      if (!seriesHead) fail('model_call_record_invalid', ref.id, 'series', 'The admitted attempt must retain its series');
      const series = take(readAnySeriesAt(store, project, reference(seriesHead)));
      const attempt = series.value.attempts.find(item => item.ordinal === admitted.value.attempt);
      if (!attempt || !same(attempt.goal, admitted.value.goal))
        fail('model_call_record_invalid', ref.id, 'attempt', 'Recovery belongs to the original admitted attempt');
      const completion = attempt.outcome ? reference(series) : null;
      const terminal = completion ? null : prepareModelTerminalWitness(store, record);
      const finish = completion || terminal ? { writes: [], guards: terminal?.guards ?? [], diagnostic: null }
        : recoveryFinish(pendingCallStore(store, [...writes, prepared.writes[0]!]), record, incident);
      writes.push(...finish.writes); guards.push(reference(seriesHead), ...finish.guards);
      finished = { ...finished, om: { ...record.value.om, application: 'recovered', diagnostic: finish.diagnostic, completion,
        ...(terminal ? { terminal: terminal.witness } : {}) } } as OmModelCall;
    } else if ('transport' in original.value) {
      const record = original as Revision<TransportModelCall>;
      const assignment = transportAssignment(store, record.value.transport.request);
      if (!directTransportPurpose(assignment.call.value.purpose)
        || !same(record.value.transport.exchange, null))
        fail('model_call_record_invalid', ref.id, 'transport', 'Only an unreceived direct transport can be interrupted without a result');
    } else fail('model_call_foreign', ref.id, 'producer', 'The runtime has no E4 producer');
    writes.push({ id: original.id, kind: original.kind, expected: original.revision, value: finished });
    // The late receipt prepared by shared recovery was bound to the
    // intermediate body; the committed recovery is this post-producer body —
    // the paid receipt is rebuilt over it so its recovered ref names the
    // saved revision, inside the same guarded write set.
    const receiptIndex = writes.findIndex(write => write.kind === 'model-late-receipt');
    if (receiptIndex >= 0) {
      const rebuilt = prepared.paid && paidModelReceipt(store, project, reference(original),
        writeRef(writes[writes.length - 1]!), incident, prepared.paid);
      if (rebuilt) writes[receiptIndex] = rebuilt; else writes.splice(receiptIndex, 1);
    }
    const view = pendingCallStore(store, writes), terminal = writeRef(writes[writes.length - 1]!);
    if ('om' in original.value) take(readModelCall(view, { project, record: terminal }));
    else take(readModelTransport(view, { project, record: terminal }));
    const managed = (finished as OmModelCall).om?.completionOwner;
    if (managed) {
      const update = take(prepareCompletionProducts(view, managed.binding, [terminal, ...((finished as OmModelCall).om.diagnostic ? [(finished as OmModelCall).om.diagnostic!] : [])]));
      writes.push(...update.writes as Write[]); guards.push(...update.guards.filter(isRef));
    }
    const committed = take(writeGuarded<ModelCall>(store, { unit: 'E4', target: ref.id, writes,
      guards: externalGuards(guards, writes) }));
    return committed.find(row => row.id === original.id)! as Revision<ModelCall>;
  } catch (error) {
    if (error instanceof CallFailure) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
    throw error;
  }
}
function settleRecoveredCall(store: Store, record: Revision<ModelCall> | Sealed<Revision<ModelCall>>, call: Ref): void {
  const late = readLateModelReceipt(store, record.value.projectId, reference(record));
  if (!late) return; // Unknown expenditure keeps the original E1 reservation open.
  const evidence = late.value.evidence;
  const decoded = transportOf({ ...evidence, call, wire: { requestId: record.value.requestId } as AdapterRequest });
  take(settleCall(store, call, decoded.usage, 'failed'));
}
function preserveLateTransport(store: Store, project: string, dispatch: Revision<ModelCall>, call: Ref,
  evidence: { process: ProcessResult | null; launchError: ModelExchange['launchError'] }): Revision<ModelCall> {
  const prepared = prepareLateModelReceipt(store, project, reference(dispatch), { process: evidence.process, launchError: evidence.launchError });
  if (prepared.writes.length) take(writeGuarded(store, { unit: 'E4', target: dispatch.id,
    writes: prepared.writes, guards: prepared.guards }));
  const recovered = prepared.recovered.record;
  settlePhysicalCall(store, recovered, call);
  return recovered;
}

// G7 completion graph: immutable logical assignments, exact producer products and a CAS registry.
// Readers of local products use only their immutable assignment, never this registry or its close proof.
import { completionAssignmentId, completionRootAssignments, completionWorkId, COMPLETION_ASSIGNMENT_KIND, COMPLETION_WORK_KIND, readCompletionBinding as readCompletionBindingOf, readCompletionOwnerAt as readCompletionOwnerAtOf, prepareCompletionAdmission as prepareCompletionAdmissionOf, readCompletionOriginalAdmission as readCompletionOriginalAdmissionOf, type CompletionAssignment, type CompletionOwner, type CompletionWork } from './series.js';
import { readAssessmentTerminalAt as readAssessmentTerminalAtOf, assessmentRefusalId, assessmentIntentId, assessmentCallNameForId } from './assessment.js';
import { readJournal as readJournalOf, readJournalAt as readJournalAtOf } from './refusal-journal.js';
import { answersProduct, answersCheckState as answersCheckStateOf, checkAnswersTransition as checkAnswersTransitionOf, readAnswersParticipant as readAnswersParticipantOf, readRouteProducers as readRouteProducersOf, type AnswersCheckState, type NoProducer, type UnservedQuestion } from './answers-gate.js';
import { readAnswersGateAssignmentAt as readAnswersGateAssignmentAtOf, ANSWERS_GATE_ASSIGNMENT_CONTRACT } from './series.js';
export interface CompletionCallOwner {
  contract: 'om-completion-call/v1'; binding: Ref; assignment: Ref; call: Ref; packetBasis: Ref;
}
export interface CompletionSnapshot {
  binding: Revision<CompletionOwner>; work: Revision<CompletionWork>; assignments: Revision<CompletionAssignment>[];
  products: Ref[]; resolved: Ref[]; cessations: Revision<CompletionCessation>[]; complete: boolean; accepting: Ref[]; negative: Ref[]; refusals: { row: string; name: string; goal: string }[];
  technical: { source: Ref; reason: 'off-form' | 'interrupted' }[]; waiting: Ref[]; guards: TransactionGuard[];
  answers: AnswersCheckState | null;
  /** LP6 (return №3371): the diagnostics a dispatched correction replaced (MP2) — refusals their chain no longer owes. */
  corrected: Ref[];
}
function completionRecord(value: CompletionAssignment): Revision<CompletionAssignment> {
  return { id: completionAssignmentId(value.project, value.binding.id, value.key), kind: COMPLETION_ASSIGNMENT_KIND,
    revision: 1, hash: hashJson(value), value };
}
function completionRoot(binding: Revision<CompletionOwner>, batch: string): Revision<CompletionAssignment> {
  const root = completionRootAssignments(binding).find(item => item.value.batch === batch);
  if (!root) fail('completion_foreign', binding.id, 'batch', 'This packet is outside the original whole assignment');
  return root;
}
/** MP2 (№2968 §2): one neighbour of a brief root — the finished node expansion of another root of its managed attempt. */
// LP5 (№3278 §3): a root of this attempt answered by a reuse names that exact reuse; its assembly is the origin.
export interface NeighbourSource { root: Ref; batch: string; node: string; assembly: Ref; proposal: Ref; reuse?: Ref }
export interface NeighbourWork {
  node: string; root: Ref; assembly: Ref; proposal: Ref; writes: string[];
  nodes: { id: string; kind: string; title: string; parent: string | null; ports: Json; code: Json }[];
}
export interface NeighbourRequest {
  project: string; attempt: { series: Ref; ordinal: number } | null; routes: Ref; batch: string;
  saved: readonly NeighbourSource[] | null; current: boolean;
}
/**
 * MP2 (№2968 §2, rows 5, 6, 19): the neighbours of a brief root. Without a saved set they are chosen once, at issuance,
 * from the current registry of the attempt — the assembled results of its other resolved, not ceased node-expansion roots
 * of the same level, read by the common assembly reader; never by a look-alike id or an accepted flag. A saved set is
 * proved again, member by member, from its exact references and, for a current admission, still stands: not ceased, the
 * registry guarded before the check. A later neighbour never enters an issued packet.
 */
export function readNeighbourResults(store: Store, request: NeighbourRequest): ModelCallResult<Sealed<{
  sources: NeighbourSource[]; works: NeighbourWork[]; guards: TransactionGuard[]; references: Ref[];
}>> {
  return result(() => {
    const { project, attempt } = request;
    const binding = attempt ? take(readCompletionBinding(store, project, attempt.series, attempt.ordinal)) as Revision<CompletionOwner> | null : null;
    if (!binding) {
      if (request.saved?.length) fail('completion_foreign', project, 'neighbors', 'Neighbours belong only to a managed attempt');
      return { sources: [], works: [], guards: [], references: [] };
    }
    if (!same(binding.value.plan.routes, request.routes))
      fail('completion_foreign', binding.id, 'neighbors', 'Neighbours belong to the exact plan of this attempt');
    const own = completionRoot(binding, request.batch);
    const routes = take(readRoutes(store, { project, record: binding.value.plan.routes })).record.value;
    const level = routes.batches.find(row => row.id === request.batch)?.level ?? null;
    const nodeOf = (batch: string): string | null => {
      const row = routes.batches.find(item => item.id === batch);
      return row?.task === 'node-expansion' && row.level === level && text(row.node) ? row.node : null;
    };
    const references: Ref[] = [reference(binding), binding.value.plan.routes], guards: TransactionGuard[] = [];
    const registry = () => {
      const head = store.get<CompletionWork>(completionWorkId(project, binding.id));
      if (!head) fail('completion_invalid', binding.id, 'work', 'A managed attempt keeps its registry');
      // The registry is guarded before anything is read from it.
      guards.push(reference(head));
      return take(readCompletionWorkAt(store, project, reference(head)));
    };
    const rootOf = (assembly: Sealed<{ record: Revision<PartAssemblyRecord> }>) => {
      const part = take(readPartResult(store, { project, record: assembly.record.value.results[0]! }));
      const packet = packetCompletionAssignments(store, binding, part.record.value.request.packet).packet;
      return completionRoot(binding, packet.value.request.batch!);
    };
    let sources: NeighbourSource[];
    if (request.saved === null) {
      const snapshot = registry();
      const ceased = new Set(snapshot.cessations.map(row => row.value.assignment.id));
      const resolved = new Set(snapshot.resolved.map(ref => ref.id));
      const found = new Map<string, NeighbourSource>();
      for (const ref of snapshot.products) {
        const kind = store.get(ref.id, ref.revision)?.kind;
        if (kind === COMPLETION_REUSE_KIND) {
          const reuse = take(readCompletionReuseAt(store, project, ref)).value;
          const root = completionRoot(binding, reuse.batch), node = nodeOf(root.value.batch);
          if (root.id === own.id || !node || ceased.has(root.id) || !resolved.has(root.id)) continue;
          const source = { root: reference(root), batch: root.value.batch, node, assembly: reuse.origin.assembly, proposal: reuse.origin.proposal, reuse: ref };
          found.set(canonical(source), source);
          continue;
        }
        if (kind !== PART_ASSEMBLY_KIND) continue;
        const assembly = take(readPartAssembly(store, { project, record: ref }));
        const root = rootOf(assembly), node = nodeOf(root.value.batch);
        if (root.id === own.id || !node || ceased.has(root.id) || !resolved.has(root.id)) continue;
        const source = { root: reference(root), batch: root.value.batch, node, assembly: ref, proposal: reference(assembly.proposal) };
        found.set(canonical(source), source);
      }
      sources = [...found.values()].sort((a, b) => a.node.localeCompare(b.node) || canonical(a.assembly).localeCompare(canonical(b.assembly)));
    } else {
      sources = request.saved.map(source => ({ ...source }));
      if (request.current) {
        const ceased = new Set(registry().cessations.map(row => row.value.assignment.id));
        for (const source of sources) if (ceased.has(source.root.id))
          fail('input_stale', source.root.id, 'neighbors', 'A saved neighbour no longer stands in the current line', source.root);
      }
    }
    const works = sources.map((source): NeighbourWork => {
      const assembly = take(readPartAssembly(store, { project, record: source.assembly }));
      // A reused root is proved by its reuse — never by putting this attempt's root to the old assembly by its name.
      const reuse = source.reuse ? take(readCompletionReuseAt(store, project, source.reuse)).value : null;
      const root = reuse ? completionRoot(binding, reuse.batch) : rootOf(assembly);
      if (!same(reference(assembly.proposal), source.proposal) || !same(reference(root), source.root) || root.value.batch !== source.batch
        || root.id === own.id || nodeOf(source.batch) !== source.node || reuse && (!same(reuse.binding, reference(binding))
          || !same(reuse.root, source.root) || !same(reuse.origin, { assembly: source.assembly, proposal: source.proposal })))
        fail('completion_foreign', source.assembly.id, 'neighbors', 'A neighbour is the exact finished expansion of another root of this attempt', source.assembly);
      references.push(source.root, source.assembly, source.proposal, ...(source.reuse ? [source.reuse] : []), ...assembly.references);
      const nodes = assembly.proposal.value.nodes.map(node => ({ id: node.id, kind: node.kind, title: node.title, parent: node.parent ?? null,
        ports: JSON.parse(canonical(node.ports)) as Json, code: JSON.parse(canonical(node.code ?? [])) as Json }));
      const writes = [...new Set(assembly.proposal.value.nodes.flatMap(node => (node.code ?? [])
        .filter(code => code.access === 'write').map(code => code.path)))].sort();
      return { node: source.node, root: source.root, assembly: source.assembly, proposal: source.proposal, nodes, writes };
    });
    return { sources, works, guards, references: refs(references) };
  });
}
/**
 * NR1 (№3674 п.2): a packet NEWLY registered in a managed work belongs to its receiving attempt — the same series and
 * ordinal, the routes of its plan and the full goal of that attempt — and keeps the plan of the first packet of its
 * chain. The producer checks this at registration; a registered packet is read as written (packetCompletionAssignments).
 */
function requirePacketOfAttempt(store: Store, binding: Revision<CompletionOwner>, packetRef: Ref): void {
  const project = binding.value.project;
  const packet = take(readQuestionPacket(store, { project, record: packetRef })) as Revision<QuestionPacketRecord>;
  const request = packet.value.request, attempt = request.attempt;
  if (!attempt || attempt.series.id !== binding.value.series.id || attempt.ordinal !== binding.value.attempt
    || !same(request.routes, binding.value.plan.routes) || !request.batch)
    fail('completion_foreign', packet.id, 'packet', 'The exact E2 must belong to this original managed root and attempt');
  const line = take(readAnySeriesAt(store, project, attempt.series));
  const cycle = line.value.attempts.find(item => item.ordinal === attempt.ordinal);
  if (!cycle || !same(cycle.goal, binding.value.goal)) fail('completion_foreign', packet.id, 'goal', 'The packet must retain the full original goal');
  if (packet.value.state !== 'ready') return;
  let first = packet;
  if (request.previous.length) first = take(readQuestionPacket(store, { project, record: request.previous[0]!.packet })) as Revision<QuestionPacketRecord>;
  for (let edge = first.value.request.continuation ?? first.value.request.correction; edge; edge = first.value.request.continuation ?? first.value.request.correction)
    first = take(readQuestionPacket(store, { project, record: edge.packet })) as Revision<QuestionPacketRecord>;
  if (!same(first.value.request.routes, request.routes) || first.value.request.batch !== request.batch
    || !same(first.value.plan?.assignments ?? null, packet.value.plan?.assignments ?? null))
    fail('completion_foreign', packet.id, 'plan', 'Parts and continuations preserve the first proved complete E2 plan');
}
function packetCompletionAssignments(store: Store, binding: Revision<CompletionOwner>, packetRef: Ref): {
  records: Revision<CompletionAssignment>[]; selected: Revision<CompletionAssignment>; packet: Revision<QuestionPacketRecord>;
} {
  // NR1 (№3600): a registered packet was checked against its attempt when it was registered (requirePacketOfAttempt in
  // checkCompletionTransition); its logical steps follow from it as written.
  const project = binding.value.project;
  const packet = take(readQuestionPacket(store, { project, record: packetRef })) as Revision<QuestionPacketRecord>;
  const request = packet.value.request;
  if (!request.batch) fail('completion_foreign', packet.id, 'packet', 'A managed E2 names its batch');
  const root = completionRoot(binding, request.batch);
  if (packet.value.state !== 'ready') return { records: [], selected: root, packet };
  let first = packet;
  if (request.previous.length) first = take(readQuestionPacket(store, { project, record: request.previous[0]!.packet })) as Revision<QuestionPacketRecord>;
  for (let edge = first.value.request.continuation ?? first.value.request.correction; edge; edge = first.value.request.continuation ?? first.value.request.correction)
    first = take(readQuestionPacket(store, { project, record: edge.packet })) as Revision<QuestionPacketRecord>;
  const count = first.value.plan?.assignments.length ?? 1, position = packet.value.plan?.position ?? 0;
  const records = Array.from({ length: count }, (_, index) => completionRecord({
    contract: 'om-completion-assignment/v1', project, binding: reference(binding), key: `${root.value.key}:part:${index}`,
    kind: 'part', parent: reference(root), source: reference(first), batch: request.batch!, position: index, question: null,
  }));
  let selected = records[position];
  if (!selected) fail('completion_foreign', packet.id, 'position', 'The step must belong to the exact complete part plan');
  if (request.continuation) {
    const parent = packetCompletionAssignments(store, binding, request.continuation.packet);
    const continuation = completionRecord({ contract: 'om-completion-assignment/v1', project, binding: reference(binding),
      key: `${root.value.key}:continue:${hashJson(request.continuation)}`, kind: 'continuation', parent: reference(parent.selected),
      source: packetRef, batch: request.batch, position, question: null });
    records.push(...parent.records.filter(row => !records.some(own => own.id === row.id)), continuation);
    selected = continuation;
  } else if (request.correction) {
    // MP2 (№2968 §2): the correction is a physical child step of the rejected one, under its own key; old keys stay.
    const parent = packetCompletionAssignments(store, binding, request.correction.packet);
    const correction = completionRecord({ contract: 'om-completion-assignment/v1', project, binding: reference(binding),
      key: `${root.value.key}:correct:${hashJson(request.correction)}`, kind: 'continuation', parent: reference(parent.selected),
      source: packetRef, batch: request.batch, position, question: null });
    records.push(...parent.records.filter(row => !records.some(own => own.id === row.id)), correction);
    selected = correction;
  }
  return { records, selected, packet };
}
function factCompletionAssignments(store: Store, binding: Revision<CompletionOwner>, modelRef: Ref): Revision<CompletionAssignment>[] {
  const state = take(readModelCallState(store, { project: binding.value.project, record: modelRef }));
  if (state.state !== 'applied' || state.outcome.outcome?.kind !== 'fact-candidates')
    fail('completion_foreign', modelRef.id, 'facts', 'Fact children derive only from the entire checked MC1 response');
  const parent = packetCompletionAssignments(store, binding, state.outcome.packet).selected;
  return state.outcome.outcome.facts.map(fact => completionRecord({ contract: 'om-completion-assignment/v1',
    project: binding.value.project, binding: reference(binding), key: `${parent.value.key}:fact:${fact.questionId}`,
    kind: 'fact', parent: reference(parent), source: modelRef, batch: parent.value.batch,
    position: null, question: fact.questionId }));
}
/** NR1 (№3600): a trusted read. The producer derived this exact assignment and wrote it under its guards
 * (prepareCompletionProducts); it is read by its exact reference, never derived again. */
export function readCompletionAssignmentAt(store: Store, project: string, ref: Ref): ModelCallResult<Sealed<Revision<CompletionAssignment>>> {
  return result(() => historicalRead(store, { reader: 'G7.completion-assignment', project, ref }, () =>
  {
    const row = take(readRecord<CompletionAssignment>(store, ref,
      { unit: 'G7', target: ref.id, kind: COMPLETION_ASSIGNMENT_KIND, idPrefix: `${COMPLETION_ASSIGNMENT_KIND}:${project}:` })) as Revision<CompletionAssignment>;
    // The two assignment contracts share one kind; each is read only by the reader of its own contract.
    if (object(row.value) && (row.value as { contract?: unknown }).contract === ANSWERS_GATE_ASSIGNMENT_CONTRACT)
      fail('completion_invalid', ref.id, 'contract', 'An answers check is read by its own reader, never as a physical assignment');
    return row;
  }, () => fail('completion_invalid', ref.id, 'parent', 'An assignment cannot descend from itself')));
}
/** NR1 (№3600): the logical graph of the products as written. Every product was admitted by its producer and registered
 * by prepareCompletionProducts (conflicts of logical assignments refused there); the graph reads what it needs, nothing
 * is proved again. */
function completionGraph(store: Store, binding: Revision<CompletionOwner>, products: readonly Ref[]) {
  const assignments = new Map(completionRootAssignments(binding).map(item => [item.id, item]));
  const packets = new Map<string, Revision<QuestionPacketRecord>>(), calls = new Map<string, ModelCallOutcome>();
  const terminals: ReturnType<typeof readAssessmentTerminalAt>[] = [];
  const cessations: Revision<CompletionCessation>[] = [];
  const finalizations: Revision<CompletionFinalization>[] = [];
  const reuses: Revision<CompletionReuse>[] = [];
  const answers: Ref[] = [];
  const add = (rows: Revision<CompletionAssignment>[]) => { for (const row of rows) assignments.set(row.id, row); };
  for (const ref of products) {
    const record = store.get(ref.id, ref.revision);
    if (!record || !same(reference(record), ref)) fail('completion_invalid', ref.id, 'product', 'Every product is exact immutable evidence');
    if (record.kind === 'question-packet') {
      const source = packetCompletionAssignments(store, binding, ref); add(source.records); packets.set(ref.id, source.packet);
    } else if (record.kind === 'model-call') {
      const state = take(readModelCallState(store, { project: binding.value.project, record: ref }));
      const value = state.state === 'running' || state.state === 'received' ? state.record : state.outcome.record;
      const source = packetCompletionAssignments(store, binding, value.value.om.request.packet); add(source.records);
      packets.set(source.packet.id, source.packet);
      if (state.state !== 'running' && state.state !== 'received') {
        const old = calls.get(ref.id);
        if (old && old.record.revision > ref.revision) continue;
        calls.set(ref.id, state.outcome as ModelCallOutcome);
        if (state.state === 'applied' && state.outcome.outcome?.kind === 'fact-candidates') add(factCompletionAssignments(store, binding, ref));
      }
    } else if (record.kind === 'om-assessment-result') {
      const terminal = readAssessmentTerminalAt(store, binding.value.project, ref); const checked = take(terminal);
      const intent = take(readAssessmentIntentAt(store, binding.value.project, checked.value.intent));
      add(factCompletionAssignments(store, binding, intent.record.value.source.modelCall)); terminals.push(terminal);
    } else if (record.kind === COMPLETION_CESSATION_KIND) {
      const cessation = take(readCompletionCessationAt(store, binding.value.project, ref));
      // H1.0c: the ceased check is a participant of its own; physical readers never see a non-physical assignment.
      if (cessation.value.disposition === 'check-ceased') answers.push(ref);
      else cessations.push(cessation as Revision<CompletionCessation>);
    } else if (record.kind === COMPLETION_FINALIZATION_KIND) {
      finalizations.push(take(readCompletionFinalizationAt(store, binding.value.project, ref)) as Revision<CompletionFinalization>);
    } else if (record.kind === COMPLETION_REUSE_KIND) {
      reuses.push(take(readCompletionReuseAt(store, binding.value.project, ref)) as Revision<CompletionReuse>);
    } else if (answersProduct(binding.value.project, ref, record)) answers.push(ref);
    // A registered candidate (E7), a cycle, an assembly and a unit refusal add no logical assignment of their own.
  }
  return { assignments: [...assignments.values()].sort((a, b) => a.id.localeCompare(b.id)), packets, calls,
    terminals: terminals.map(item => take(item)), cessations, finalizations, reuses, answers: take(readAnswersParticipant(store, binding, answers)) };
}
/** The registered answers-gate check is one more logical assignment of the same work (H1.0c). */
const completionAssignmentRefs = (graph: ReturnType<typeof completionGraph>): Ref[] =>
  refs([...graph.assignments, ...(graph.answers.check ? [graph.answers.check] : [])].map(reference));
/** NR1 (№3600): a trusted read of the work and the products it registers. Every revision was written by
 * prepareCompletionProducts or a close over the exact predecessor, its transition checked there (checkCompletionTransition,
 * completionNext, the assignment conflict check); the snapshot is computed from the products as written. */
export function readCompletionWorkAt(store: Store, project: string, ref: Ref): ModelCallResult<Sealed<CompletionSnapshot>> {
  return result(() => historicalRead(store, { reader: 'G7.completion-work', project, ref }, () => {
    const work = take(readRecord<CompletionWork>(store, ref, { unit: 'G7', target: ref.id,
      kind: COMPLETION_WORK_KIND, idPrefix: `${COMPLETION_WORK_KIND}:${project}:` })) as Revision<CompletionWork>;
    const binding = take(readCompletionOwnerAt(store, project, work.value.binding)) as Revision<CompletionOwner>;
    return deriveCompletionSnapshot(store, binding, work, completionGraph(store, binding, work.value.products));
  }, () => fail('completion_invalid', ref.id, 'history', 'A completion registry cannot derive through its own closure')));
}
/** H1.0c: exact open work plus exact additions, by the formula of its next revision; nothing is written or guessed. */
export function readCompletionEffectiveAt(store: Store, project: string, closure: { work: Ref; additions: readonly Ref[]; journal: Ref | null }): ModelCallResult<Sealed<CompletionSnapshot>> {
  if (!(store instanceof Store) || !text(project)) invalid('store');
  if (!object(closure) || !exactKeys(closure, ['work', 'additions', 'journal']) || !isRef(closure.work) || !Array.isArray(closure.additions)
    || !closure.additions.every(isRef) || !(closure.journal === null || isRef(closure.journal))) invalid('closure');
  // PF3.1 (№3459 §5): one derivation per exact closure — the work and the additions in the order presented, and the
  // journal, an explicit null included — so a malformed order is refused again rather than normalized by the key.
  return result(() => historicalRead(store, { reader: 'G7.completion-effective', project, ref: closure.work,
    parameters: { additions: [...closure.additions], journal: closure.journal } as unknown as Json }, () => {
    const prior = take(readCompletionWorkAt(store, project, closure.work)), cut = prior.work.value.journal;
    // The final journal of a close is the work's own cut or a later revision of it, never an older or another one.
    if (cut && !(closure.journal && closure.journal.id === cut.id && closure.journal.revision >= cut.revision))
      fail('completion_invalid', closure.work.id, 'journal', 'The final journal is the exact work cut or a later revision of it');
    if (!closure.additions.length) return prior;
    if (prior.work.value.closed) fail('completion_closed', closure.work.id, 'work', 'Closed work accepts only exact historical repeats');
    const added = refs(closure.additions), binding = prior.binding as Revision<CompletionOwner>;
    if (!same(added, closure.additions) || added.some(ref => prior.products.some(old => same(old, ref))))
      fail('completion_invalid', closure.work.id, 'additions', 'Additions are distinct exact products in canonical order the work does not hold yet');
    checkCompletionTransition(store, prior, added);
    const { graph, value } = completionNext(store, binding, prior.work, refs([...prior.products, ...added]), () => closure.journal
      ?? fail('completion_invalid', closure.work.id, 'journal', 'Unit refusal products keep their exact final journal'));
    const effective = deriveCompletionSnapshot(store, binding, { id: prior.work.id, kind: COMPLETION_WORK_KIND,
      revision: prior.work.revision + 1, hash: hashJson(value as unknown as Json), value }, graph);
    // The view is of the next revision; the snapshot names only the real work it stands on (no Ref of a revision to be).
    return { ...effective, work: prior.work, guards: prior.guards };
  }, () => fail('completion_invalid', closure.work.id, 'history', 'An effective registry cannot derive through its own closure')));
}
/** H1.0c: the one formula of every next work revision: the exact predecessor, the full products, their journal cut. */
function completionNext(store: Store, binding: Revision<CompletionOwner>, prior: Sealed<Revision<CompletionWork>>, products: Ref[],
  journal: () => Ref | null): { graph: ReturnType<typeof completionGraph>; value: CompletionWork } {
  const graph = completionGraph(store, binding, products);
  const unit = products.some(ref => store.get(ref.id, ref.revision)?.kind === UNIT_REFUSAL_KIND);
  return { graph, value: { ...prior.value as CompletionWork, previous: reference(prior), products, journal: unit ? journal() : null,
    assignments: completionAssignmentRefs(graph) } };
}
/** H1.0c: the single closed revision: the next revision over the close's additions and final journal, plus the proof. */
export function completionClosedWork(store: Store, project: string, prior: Sealed<Revision<CompletionWork>>,
  close: { additions: readonly Ref[]; journal: Ref | null }, closed: Ref): ModelCallResult<Sealed<CompletionWork>> {
  if (!(store instanceof Store) || !text(project)) invalid('store');
  if (!object(prior) || !isRef(reference(prior)) || !object(prior.value) || !isRef(prior.value.binding) || !Array.isArray(prior.value.products)
    || !object(close) || !Array.isArray(close.additions) || !close.additions.every(isRef)
    || !(close.journal === null || isRef(close.journal)) || !isRef(closed)) invalid('closure');
  return result(() => {
    const binding = take(readCompletionOwnerAt(store, project, prior.value.binding)) as Revision<CompletionOwner>;
    const { value } = completionNext(store, binding, prior, refs([...prior.value.products, ...close.additions]), () => close.journal);
    return { ...value, closed };
  });
}
export function prepareCompletionProducts(store: Store, bindingRef: Ref, products: readonly Ref[]): ModelCallResult<Sealed<{ writes: Write[]; guards: Ref[]; work: Ref }>> {
  return result(() => {
    const project = bindingRef.id.split(':')[1]!;
    const id = completionWorkId(project, bindingRef.id), head = store.get<CompletionWork>(id);
    if (!head) fail('completion_invalid', id, 'work', 'Managed work cannot lose its registry');
    const prior = take(readCompletionWorkAt(store, project, reference(head)));
    const combined = refs([...prior.products, ...products]);
    if (same(combined, prior.products)) return { writes: [], guards: [reference(head)], work: reference(head) };
    if (head.value.closed) fail('completion_closed', id, 'work', 'Closed work accepts only exact historical repeats');
    checkCompletionTransition(store, prior, combined.filter(ref => !prior.products.some(old => same(old, ref))));
    const { graph, value } = completionNext(store, prior.binding as Revision<CompletionOwner>, head, combined,
      () => reference(take(readJournal(store, { project }))));
    const writes: Write[] = [];
    for (const assignment of [...graph.assignments, ...(graph.answers.check ? [graph.answers.check] : [])]) {
      const old = store.get(assignment.id);
      if (old && !same(old, assignment)) fail('completion_conflict', assignment.id, 'assignment', 'The logical assignment cannot be rebound');
      if (!old) writes.push({ id: assignment.id, kind: assignment.kind, expected: 0, value: assignment.value });
    }
    const write: Write = { id, kind: COMPLETION_WORK_KIND, expected: head.revision, value }; writes.push(write);
    take(answersCheckState(store, prior.binding as Revision<CompletionOwner>, { ...head, revision: head.revision + 1, value }, graph.answers));
    // The initial assignment/opening guards and current work close the registration-vs-G7 window.
    const line = store.get(prior.binding.value.series.id);
    if (!line) fail('completion_invalid', id, 'series', 'The current original line must exist');
    const added = combined.filter(ref => !prior.products.some(old => same(old, ref)));
    const completionOnly = added.every(ref => {
      const record = store.get(ref.id, ref.revision)!;
      if (record.kind === 'om-assessment-result' || record.kind === UNIT_REFUSAL_KIND || record.kind === COMPLETION_CESSATION_KIND) return true;
      if (record.kind !== 'model-call') return false;
      const state = take(readModelCallState(store, { project, record: ref }));
      return state.state === 'recovered' || state.state === 'applied';
    });
    const admitted = completionOnly ? take(prepareCompletionAdmission(store, project, bindingRef))
      : take(prepareSeriesLineAdmission(store, project, reference(line)));
    return { writes, guards: [reference(head), bindingRef, ...admitted.guards], work: writeRef(write) };
  });
}
export const COMPLETION_PACKET_KIND = 'om-completion-packet';
interface CompletionPacket { contract: 'om-completion-packet/v1'; project: string; binding: Ref; root: Ref; packet: Ref }
function completionPacketRecord(store: Store, project: string, bindingRef: Ref, packet: Ref): Revision<CompletionPacket> {
  const binding = take(readCompletionOwnerAt(store, project, bindingRef)) as Revision<CompletionOwner>;
  const source = packetCompletionAssignments(store, binding, packet);
  const root = completionRoot(binding, source.selected.value.batch);
  const value: CompletionPacket = { contract: 'om-completion-packet/v1', project, binding: bindingRef, root: reference(root), packet };
  return { id: `${COMPLETION_PACKET_KIND}:${project}:${hashJson({ binding: bindingRef, root: reference(root), packet })}`,
    kind: COMPLETION_PACKET_KIND, revision: 1, hash: hashJson(value), value };
}
/** NR1 (№3600): a trusted read — the candidate registration was written from completionPacketRecord. */
export function readCompletionPacketAt(store: Store, project: string, ref: Ref): ModelCallResult<Sealed<Revision<CompletionPacket>>> {
  return result(() => take(readRecord<CompletionPacket>(store, ref, { unit: 'G7', target: ref.id,
    kind: COMPLETION_PACKET_KIND, idPrefix: `${COMPLETION_PACKET_KIND}:${project}:` })) as Revision<CompletionPacket>);
}
function checkPacketMaterialization(store: Store, snapshot: Sealed<CompletionSnapshot>, packet: Ref) {
  const source = packetCompletionAssignments(store, snapshot.binding as Revision<CompletionOwner>, packet), selected = source.selected;
  take(checkCompletionDisposition(store, snapshot, { batch: selected.value.batch, assignment: reference(selected),
    ...(selected.value.parent ? { parent: selected.value.parent } : {}), action: 'materialize' }));
  const chosen = snapshot.assignments.filter(row => row.value.kind === 'part' && row.value.batch === selected.value.batch);
  if (chosen.length && source.records.filter(row => row.value.kind === 'part').some(row => !chosen.some(old => same(old, row))))
    fail('completion_conflict', selected.id, 'plan', 'Materialization cannot replace the already selected executable plan');
  if (chosen.length && source.packet.value.state !== 'ready' && !source.packet.value.request.previous.length && !source.packet.value.request.continuation
    && !source.packet.value.request.correction)
    fail('completion_conflict', selected.id, 'plan', 'A blocked new first candidate cannot replace the selected plan');
}
/** E2 registers an immutable candidate, while E1 selects its executable plan and all parts. */
export function prepareCompletionPacket(store: Store, packet: Ref): ModelCallResult<Sealed<{ writes: Write[]; guards: Ref[] }>> {
  return result(() => {
    const project = packet.id.split(':')[1]!;
    const source = take(readQuestionPacket(store, { project, record: packet }));
    const attempt = source.value.request.attempt;
    if (!attempt) return { writes: [], guards: [] };
    const binding = take(readCompletionBinding(store, project, attempt.series, attempt.ordinal));
    if (!binding) return { writes: [], guards: [] };
    const record = completionPacketRecord(store, project, reference(binding), packet), old = store.get(record.id);
    if (old) { take(readCompletionPacketAt(store, project, reference(old))); return { writes: [], guards: [] }; }
    const head = store.get(completionWorkId(project, binding.id));
    if (!head) fail('completion_invalid', binding.id, 'work', 'Materialization requires its proved registry');
    const snapshot = take(readCompletionWorkAt(store, project, reference(head)));
    checkPacketMaterialization(store, snapshot, packet);
    const write: Write = { id: record.id, kind: record.kind, expected: 0, value: record.value };
    const next = take(prepareCompletionProducts(pendingCallStore(store, [write]), reference(binding), [reference(record)]));
    return { writes: [write, ...next.writes], guards: [...next.guards] };
  });
}
function deriveCompletionSnapshot(store: Store, binding: Revision<CompletionOwner>, work: Revision<CompletionWork>, graph: ReturnType<typeof completionGraph>): CompletionSnapshot {
  const project = binding.value.project, completed = new Set<string>();
  const accepting: Ref[] = [], negative: Ref[] = [], technical: CompletionSnapshot['technical'] = [], waiting: Ref[] = [];
  const diagnostics: Ref[] = [], replacedDiagnostics: Ref[] = [], products = work.value.products;
  // MP2 (№2968 §3): the refusals a dispatched correction replaced (a call of its packet is registered — never a packet only
  // written or blocked), and the calls a saved cycle already ended.
  const corrected = new Set(products.filter(ref => store.get(ref.id, ref.revision)?.kind === 'model-call').flatMap(ref => {
    const state = take(readModelCallState(store, { project, record: ref }));
    const record = state.state === 'running' || state.state === 'received' ? state.record : state.outcome.record;
    const correction = take(readQuestionPacket(store, { project, record: record.value.om.request.packet })).value.request.correction;
    return correction ? [canonical(correction)] : [];
  }));
  const cycled = new Set(products.filter(ref => store.get(ref.id, ref.revision)?.kind === MODEL_CYCLE_KIND)
    .flatMap(ref => take(readModelCycle(store, { project, record: ref })).record.value.steps.map(step => step.record.id)));
  // №3147: a step owes nothing more once it, or its correction (a direct continuation), is ceased.
  const ceased = new Set(graph.cessations.flatMap(row => [row.value.assignment.id,
    ...graph.assignments.filter(item => item.id === row.value.assignment.id && item.value.parent).map(item => item.value.parent!.id)]));
  for (const call of graph.calls.values()) {
    const step = packetCompletionAssignments(store, binding, call.packet).selected;
    if (call.record.value.om.application === 'application-refused') continue;
    if (call.outcome?.kind === 'need-source') continue;
    const replaced = call.diagnostic !== null && call.response !== null
      && corrected.has(canonical({ packet: call.packet, call: call.call, response: call.response, diagnostic: call.diagnostic }));
    // A refusal its chain still owes the correction keeps its step open: the root is not closed before it (MP2). Once the
    // step or its correction is ceased (№3147) the refusal is final: it completes its step and decides with its rows.
    if (call.diagnostic && !replaced && !cycled.has(call.record.id) && !ceased.has(step.id) && callCorrection(store, project, call)) continue;
    completed.add(step.id);
    if (call.diagnostic) {
      diagnostics.push(call.diagnostic);
      if (replaced) replacedDiagnostics.push(call.diagnostic);
      const checked = take(readManagedModelDiagnostic(store, binding, call.diagnostic));
      // The replaced refusal stays in the history; the corrected chain decides the outcome.
      if (!replaced && (checked.reason === 'off-form' || checked.reason === 'interrupted')) technical.push({ source: reference(call.record), reason: checked.reason });
      if (checked.reason === 'awaiting-owner') waiting.push(call.diagnostic);
    }
  }
  for (const terminal of graph.terminals) {
    const intent = take(readAssessmentIntentAt(store, project, terminal.value.intent));
    const fact = factCompletionAssignments(store, binding, intent.record.value.source.modelCall).find(row => row.value.question === intent.fact.questionId);
    if (!fact) fail('completion_foreign', terminal.id, 'fact', 'A terminal must belong to an enumerated original fact');
    const value = terminal.value;
    if (value.verdict === 'supported') { accepting.push(value.accepted!); completed.add(fact.id); }
    else if (value.verdict === 'off-form' || value.verdict === 'interrupted' || value.verdict === 'application-terminated') {
      technical.push({ source: reference(terminal), reason: value.verdict === 'application-terminated' ? 'interrupted' : value.verdict }); completed.add(fact.id);
    } else {
      negative.push(reference(terminal));
      const row = products.find(ref => ref.id === assessmentRefusalId(project, reference(terminal)));
      if (row) { diagnostics.push(row); completed.add(fact.id); }
    }
  }
  const parentOf = new Map(graph.assignments.map(row => [row.id, row.value.parent?.id ?? null]));
  const below = (child: string, parent: string): boolean => {
    let id: string | null | undefined = child;
    while (id) { if (id === parent) return true; id = parentOf.get(id); }
    return false;
  };
  // LP5: the ended remainder of a common acceptance or confirmation is a cause of ending, not a verdict (№3278 §2).
  for (const row of graph.finalizations) technical.push({ source: reference(row), reason: 'interrupted' });
  // LP5 (№3278 §3): a reuse resolves exactly its own new root; the paid source keeps its own result.
  for (const row of graph.reuses) completed.add(row.value.root.id);
  for (const row of graph.cessations) {
    technical.push({ source: reference(row), reason: 'interrupted' });
    if (row.value.remainder !== 'assembly') completed.add(row.value.assignment.id);
  }
  // Continuations discharge their exact parent's source request; they never skip sibling parts or facts.
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const row of graph.assignments) if (row.value.kind === 'continuation' && completed.has(row.id)
      && !completed.has(row.value.parent!.id)) { completed.add(row.value.parent!.id); advanced = true; }
  }
  for (const root of completionRootAssignments(binding)) {
    const parts = graph.assignments.filter(row => row.value.kind === 'part' && row.value.parent?.id === root.id);
    if (!parts.length) continue;
    let complete = graph.assignments.filter(row => row.id !== root.id && below(row.id, root.id))
      .every(row => completed.has(row.id));
    const node = [...graph.packets.values()].some(packet => packet.value.plan && packet.value.request.batch === root.value.batch);
    if (node) {
      const assemblies = products.filter(ref => store.get(ref.id, ref.revision)?.kind === PART_ASSEMBLY_KIND);
      const assembled = assemblies.some(ref => {
        const assembly = take(readPartAssembly(store, { project, record: ref }));
        const actual = [...graph.calls.values()].filter(call => call.part && below(packetCompletionAssignments(store, binding, call.packet).selected.id, root.id));
        return same(refs(actual.map(call => call.part!.result)), refs(assembly.record.value.results));
      });
      complete &&= assembled || graph.cessations.some(row => row.value.assignment.id === root.id && row.value.remainder === 'assembly');
    }
    for (const ref of products.filter(ref => store.get(ref.id, ref.revision)?.kind === MODEL_CYCLE_KIND)) {
      const cycle = take(readModelCycle(store, { project, record: ref }));
      if (packetCompletionAssignments(store, binding, cycle.record.value.request.packet).selected.value.batch !== root.value.batch) continue;
      if (['blocked', 'research-no-progress', 'parts-invalid', 'reads-invalid'].includes(cycle.record.value.terminal)
        || cycle.record.value.terminal === 'outcome' && cycle.last.diagnostic !== null
          && cycle.last.record.value.om.application !== 'application-refused') {
        complete = true; if (cycle.record.value.diagnostic) diagnostics.push(cycle.record.value.diagnostic);
      }
    }
    if (complete) completed.add(root.id);
    else completed.delete(root.id);
  }
  const refusals: CompletionSnapshot['refusals'] = [];
  if (diagnostics.length) {
    if (!work.value.journal) fail('completion_invalid', work.id, 'journal', 'Work retains the exact journal cut for its diagnostics');
    const journal = take(readJournalAt(store, project, work.value.journal));
    for (const diagnostic of refs(diagnostics)) {
      const matching = journal.value.rows.filter(row => same(row.source, diagnostic));
      refusals.push(...matching.map(row => ({ row: row.id, name: row.code, goal: row.goal })));
    }
  }
  const answers = take(answersCheckState(store, binding, work, graph.answers)) as AnswersCheckState | null;
  if (answers?.ceased) technical.push({ source: answers.ceased, reason: 'interrupted' });
  return { binding, work, assignments: graph.assignments, products: [...products],
    resolved: graph.assignments.filter(row => completed.has(row.id)).map(reference), cessations: graph.cessations,
    complete: completionRootAssignments(binding).every(root => completed.has(root.id)) && (answers?.complete ?? true),
    accepting: refs(accepting), negative: refs(negative), refusals: [...new Map(refusals.map(row => [row.row, row])).values()].sort((a,b) => a.row.localeCompare(b.row)),
    technical, waiting: refs(waiting), guards: [reference(work), reference(binding)], answers, corrected: refs(replacedDiagnostics) };
}
/** E1 is a cross-check of the registered plan, never the plan itself. */
export function checkCompletionLedger(store: Store, snapshot: Sealed<CompletionSnapshot>, ledger: Ref, journal: Ref | null = null): ModelCallResult<Sealed<true>> {
  return result(() => {
    const owner = snapshot.binding.value, project = owner.project;
    // Context selection is not proof: readCallLedgerAt still rederives every row and
    // preceding revision. Mechanism analyses retain the close's exact journal cut.
    const saved = take(readRecord<CallLedger>(store, ledger, { unit: 'G7', target: ledger.id,
      kind: 'om-call-ledger', id: `om-call-ledger:${project}` }));
    if (!object(saved.value) || !Array.isArray(saved.value.calls))
      fail('ledger_invalid', ledger.id, 'calls', 'A saved ledger needs its complete call list');
    const histories = journal ? saved.value.calls.filter(row => object(row) && Object.hasOwn(row, 'owner')
      && row.purpose === 'origin-analysis' && isRef(row.call)).map(row => ({ call: row.call, journal })) : [];
    const exact = take(readCallLedgerAt(store, project, ledger, histories));
    for (const row of exact.value.calls) {
      if (row.series.id !== owner.series.id || row.attempt !== owner.attempt) continue;
      if (unmanagedPurpose(row.purpose)) continue;
      const admitted = take(readCall(store, project, row.call));
      if (!same(admitted.value.goal, owner.goal)) fail('completion_foreign', row.call.id, 'goal', 'E1 cannot change the whole managed goal');
      if (row.purpose === 'fact-assessment') {
        if (row.basis?.kind !== 'fact-assessment' || !row.basis.assessment)
          fail('completion_foreign', row.call.id, 'assessment', 'Managed E1 must retain its original fact intent');
        const intent = take(readAssessmentIntentAt(store, project, row.basis.assessment));
        if (intent.call !== row.name || !snapshot.assignments.some(item => item.value.kind === 'fact'
          && same(item.value.source, intent.record.value.source.modelCall) && item.value.question === intent.fact.questionId))
          fail('completion_foreign', row.call.id, 'assignment', 'Every assessor E1 belongs to an original mandatory fact');
      } else {
        const packets = snapshot.products.filter(ref => store.get(ref.id, ref.revision)?.kind === 'question-packet')
          .map(ref => packetCompletionAssignments(store, snapshot.binding, ref));
        const matched = packets.filter(({packet}) => object(packet.value.packet)
          && packet.value.packet.requestId === row.name && packet.value.fingerprint !== null
          && same({ hash: packet.value.fingerprint.hash, chars: packet.value.fingerprint.chars,
            bytes: packet.value.fingerprint.utf8Bytes }, admitted.value.packet));
        if (matched.length !== 1 || !snapshot.assignments.some(item => same(reference(item), reference(matched[0]!.selected))))
          fail('completion_foreign', row.call.id, 'assignment', 'Every working E1 belongs to one exactly registered physical step');
      }
    }
    return true as const;
  });
}
/** NR1 (№3600): an E4 diagnostic as written. Its producer (prepareModelFinish → modelFinishDiagnostic, validateManagedFinish
 * for a managed attempt) derived it from the physical response and its journal when it was new; it is read, not reproduced. */
function deriveManagedModelDiagnostic(store: Store, binding: Revision<CompletionOwner>, ref: Ref): { reason: FinishModelAttemptRequest['reason']; request: FinishModelAttemptRequest } {
  const project = binding.value.project;
  const record = take(readRecord<UnitRefusalRecord>(store, ref, { unit: 'E4', target: ref.id,
    kind: UNIT_REFUSAL_KIND, idPrefix: `${unitRefusalNamespace(project)}e4:` }));
  const first = record.value.refusals[0]!, origin = first.origin as unknown as { stage: string; sources: { role: string; ref: Ref }[] };
  const named = (role: string) => origin.sources.filter(source => source.role === role).map(source => source.ref);
  const request: FinishModelAttemptRequest = { project, packet: named('packet')[0]!, call: named('call')[0]!, response: named('response')[0] ?? null,
    code: first.code, message: first.remedy, reason: origin.stage.slice('model-call:'.length) as FinishModelAttemptRequest['reason'], evidence: named('evidence') };
  return { reason: request.reason, request };
}
export function readManagedModelDiagnostic(store: Store, binding: Revision<CompletionOwner>, ref: Ref):
  ModelCallResult<Sealed<{ reason: FinishModelAttemptRequest['reason']; request: FinishModelAttemptRequest }>> {
  return result(() => deriveManagedModelDiagnostic(store, binding, ref));
}
/** The physical E1 stores a fingerprint, while registration carries the actual body. */
function completionCallPacket(store: Store, project: string, request: AnyRecordCallRequest | AnyCallRecord): Ref {
  const candidates = store.list<QuestionPacketRecord>('question-packet').filter(record => record.value.project === project
    && object(record.value.packet) && record.value.packet.requestId === request.call);
  if (candidates.length !== 1) fail('completion_foreign', request.call, 'packet', 'A call must name one exact E2, not just a batch');
  const packet = take(readQuestionPacket(store, { project, record: reference(candidates[0]!) }));
  const payload = packet.value.packet!, bytes = callPacketText(payload, request.call);
  if (!same(request.packet, payload) && !same(request.packet, { hash: hashJson(payload), chars: bytes.length, bytes: Buffer.byteLength(bytes) }))
    fail('completion_foreign', request.call, 'packet', 'The E1 body or fingerprint must reproduce its exact E2');
  return reference(packet);
}
type EnvironmentAdmission = {
  store: Store; guards: Ref[]; remap: (guards: readonly TransactionGuard[]) => TransactionGuard[];
};
/** One current resolver for materialization, registration and claim. Historical packet/intent
 * readers prove the full child; work proves that its exact original plan was selected. */
export function prepareManagedEnvironment(store: Store, project: string, target: { packet: Ref } | { intent: Ref },
  role: 'implementer' | 'reviewer' | null = null): ModelCallResult<EnvironmentAdmission | null> {
  try {
    const intent = 'intent' in target ? take(readAssessmentIntentAt(store, project, target.intent)) : null;
    const packet = 'packet' in target ? take(readQuestionPacket(store, { project, record: target.packet })) : null;
    const attempt = intent ? { series: intent.series, ordinal: intent.attempt } : packet!.value.request.attempt;
    if (!attempt) return { ok: true, value: null };
    const binding = take(readCompletionBinding(store, project, attempt.series, attempt.ordinal));
    if (!binding) return { ok: true, value: null };
    const original = intent ? intent.dispatch.config : packet!.value.request.environment;
    const current = store.get(original.id);
    // No compatibility privilege is needed for the exact current source; existing disposition gates still apply.
    if (current && same(reference(current), original)) return { ok: true, value: null };
    const head = store.get(completionWorkId(project, binding.id));
    if (!head) fail('completion_invalid', binding.id, 'work', 'Compatibility requires the original work registry');
    const snapshot = take(readCompletionWorkAt(store, project, reference(head)));
    if (intent) {
      const facts = factCompletionAssignments(store, binding as Revision<CompletionOwner>, intent.record.value.source.modelCall);
      const fact = facts.find(row => row.value.question === intent.fact.questionId);
      if (!fact || !snapshot.assignments.some(row => same(row, fact)))
        fail('completion_foreign', intent.intent.id, 'assignment', 'The exact MC1 fact must already belong to the selected work');
      take(checkCompletionDisposition(store, snapshot, { batch: fact.value.batch, assignment: reference(fact), action: 'dispatch' }));
    } else {
      const source = packetCompletionAssignments(store, binding as Revision<CompletionOwner>, reference(packet!));
      const chosen = snapshot.assignments.filter(row => row.value.kind === 'part' && row.value.batch === source.selected.value.batch);
      if (!chosen.length) return { ok: true, value: null }; // Unselected candidates use the ordinary current Environment contract.
      checkPacketMaterialization(store, snapshot, reference(packet!));
    }
    const admission = take(prepareApplicationEnvironment(store, project, original, intent ? 'reviewer' : role));
    return { ok: true, value: { ...admission, guards: refs([...admission.guards, reference(head), reference(binding)]) } };
  } catch (error) { { const failed = caught(error); if (failed) return failed; } throw error; }
}
export function prepareManagedCallEnvironment(store: Store, project: string, request: AnyRecordCallRequest | AnyCallRecord,
  role: 'implementer' | 'reviewer' | null = null): ModelCallResult<EnvironmentAdmission | null> {
  try {
    if (unmanagedPurpose(request.purpose)
      || !take(readCompletionBinding(store, project, request.series, request.attempt))) return { ok: true, value: null };
    const configured = store.get(request.dispatch.config.id);
    if (configured && same(reference(configured), request.dispatch.config)) return { ok: true, value: null };
    if (request.purpose === 'fact-assessment') {
      if (request.basis?.kind !== 'fact-assessment' || !request.basis.assessment)
        fail('completion_foreign', request.call, 'intent', 'An assessor belongs to its exact mandatory fact intent');
      const intent = take(readAssessmentIntentAt(store, project, request.basis.assessment));
      if (!same(request.dispatch, intent.dispatch)) fail('completion_foreign', request.call, 'dispatch', 'The assessor preserves its intent dispatch');
      return prepareManagedEnvironment(store, project, { intent: intent.intent }, 'reviewer');
    }
    const packet = completionCallPacket(store, project, request);
    const source = take(readQuestionPacket(store, { project, record: packet }));
    if (!same(request.dispatch.config, source.value.request.environment))
      fail('completion_foreign', request.call, 'dispatch', 'A selected E1 retains its original E2 Environment');
    return prepareManagedEnvironment(store, project, { packet }, role);
  } catch (error) { { const failed = caught(error); if (failed) return failed; } throw error; }
}
/** E1 producer and physical claim share this assignment resolver; the caller cannot select an era. */
export function prepareCompletionCall(store: Store, project: string, request: AnyRecordCallRequest, mode: 'registration' | 'claim' = 'registration'): ModelCallResult<Sealed<{
  owner: Omit<CompletionCallOwner, 'call'> | null; writes: Write[]; guards: TransactionGuard[];
}>> {
  return result(() => {
    if (unmanagedPurpose(request.purpose)) return { owner: null, writes: [], guards: [] };
    const binding = take(readCompletionBinding(store, project, request.series, request.attempt)) as Revision<CompletionOwner> | null;
    if (!binding) return { owner: null, writes: [], guards: [] };
    if (!same(request.goal, binding.value.goal)) fail('completion_foreign', binding.id, 'goal', 'The call retains the original whole goal');
    let assignment: Revision<CompletionAssignment>, packetBasis: Ref, products: Ref[];
    const sourceWrites: Write[] = [], sourceGuards: TransactionGuard[] = [];
    if (request.purpose === 'fact-assessment') {
      if (request.basis?.kind !== 'fact-assessment' || !request.basis.assessment)
        fail('completion_foreign', binding.id, 'assessment', 'An assessor inherits ownership through its exact E5 intent');
      const intent = take(readAssessmentIntentAt(store, project, request.basis.assessment));
      if (request.call !== intent.call || !same(request.packet, intent.packet) || !same(request.basis, intent.basis))
        fail('completion_foreign', binding.id, 'assessment', 'Assessor identity is derived from its original fact intent');
      const children = factCompletionAssignments(store, binding, intent.record.value.source.modelCall);
      const found = children.filter(row => row.value.question === intent.fact.questionId);
      if (found.length !== 1) fail('completion_foreign', binding.id, 'assessment', 'The original response must contain this one fact');
      assignment = found[0]!; packetBasis = intent.intent; products = [intent.record.value.source.modelCall];
    } else {
      const source = packetCompletionAssignments(store, binding, completionCallPacket(store, project, request));
      if (!object(source.packet.value.packet) || source.packet.value.packet.requestId !== request.call
        || source.packet.value.packet.purpose !== request.purpose)
        fail('completion_foreign', binding.id, 'call', 'An assignment cannot be renamed to create a second physical call');
      const expected = modelAssignment(store, { project, packet: reference(source.packet), dispatch: request.dispatch, role: 'implementer' }).admission;
      const normalized = (value: AnyRecordCallRequest) => ({ ...value, gaps: [...value.gaps].sort(compareJson),
        goal: { ...value.goal, questions: [...value.goal.questions].sort() } });
      if (!same(normalized(request), normalized(expected)))
        fail('completion_foreign', binding.id, 'call', 'Every E1 field must reproduce this proved E2 assignment');
      {
        const admittedPacket = take(prepareQuestionPacket(store, source.packet.value.request as QuestionPacketRequest));
        if (!same(admittedPacket.record, source.packet)) fail('completion_foreign', binding.id, 'packet', 'Current admission cannot replace the original packet');
        sourceWrites.push(...admittedPacket.writes); sourceGuards.push(...admittedPacket.guards);
      }
      assignment = source.selected; packetBasis = reference(source.packet); products = [packetBasis];
    }
    const prepared = take(prepareCompletionProducts(store, reference(binding), products));
    const view = pendingCallStore(store, prepared.writes as Write[]);
    const work = take(readCompletionWorkAt(view, project, prepared.work));
    if (work.work.value.closed || !work.assignments.some(row => same(reference(row), reference(assignment))))
      fail('completion_closed', binding.id, 'assignment', 'A physical claim belongs to one registered open assignment');
    if (mode === 'claim') take(checkCompletionDisposition(store, work, { batch: assignment.value.batch,
      assignment: reference(assignment), action: 'dispatch' }));
    return { owner: { contract: 'om-completion-call/v1', binding: reference(binding), assignment: reference(assignment), packetBasis },
      writes: [...sourceWrites, ...prepared.writes as Write[]],
      guards: uniqueTransactionGuards([...sourceGuards, ...prepared.guards].filter(guard => !isRef(guard)
        || !sourceWrites.some(write => same(writeRef(write), guard)))) };
  });
}
function checkedCompletionOwner(store: Store, project: string, call: Ref, packetBasis: Ref, marker: unknown, history?: CallHistory): CompletionCallOwner | null {
  const admitted = take(readCall(store, project, call, history));
  const purpose = admitted.value.purpose;
  const binding = unmanagedPurpose(purpose) ? null
    : take(readCompletionBinding(store, project, admitted.value.series, admitted.value.attempt));
  if (!binding) {
    if (marker !== undefined) fail('completion_invalid', call.id, 'completionOwner', 'Standalone history cannot acquire managed provenance');
    return null;
  }
  if (!object(marker) || marker.contract !== 'om-completion-call/v1' || !isRef(marker.assignment)
    || !same(marker.binding, reference(binding)) || !same(marker.call, call) || !same(marker.packetBasis, packetBasis)
    || !exactKeys(marker, ['contract', 'binding', 'assignment', 'call', 'packetBasis']))
    fail('completion_invalid', call.id, 'completionOwner', 'Every managed physical step retains its exact proved ownership');
  const assignment = take(readCompletionAssignmentAt(store, project, marker.assignment));
  if (!same(assignment.value.binding, reference(binding))) fail('completion_foreign', call.id, 'binding', 'The assignment belongs to its own original owner');
  if (purpose === 'fact-assessment') {
    if (admitted.value.basis?.kind !== 'fact-assessment' || !same(admitted.value.basis.assessment, packetBasis))
      fail('completion_foreign', call.id, 'intent', 'The assessor retains its exact originating intent');
    const intent = take(readAssessmentIntentAt(store, project, packetBasis));
    const children = factCompletionAssignments(store, binding as Revision<CompletionOwner>, intent.record.value.source.modelCall);
    if (!children.some(row => same(reference(row), marker.assignment) && row.value.question === intent.fact.questionId))
      fail('completion_foreign', call.id, 'fact', 'The assessor must be this original response child');
  } else {
    const source = packetCompletionAssignments(store, binding as Revision<CompletionOwner>, packetBasis);
    if (!same(reference(source.selected), marker.assignment)) fail('completion_foreign', call.id, 'packet', 'The physical step must be exactly the selected E2 assignment');
  }
  return marker as unknown as CompletionCallOwner;
}

function modelFinishDiagnostic(store: Store, request: FinishModelAttemptRequest, binding: Revision<CompletionOwner> | null,
  received?: ReceivedForm): Write {
  const call = take(readCall(store, request.project, request.call));
  if (binding) validateManagedFinish(store, request, binding, received);
  const sources = refs([request.packet, request.call, ...(request.response ? [request.response] : []), ...(request.evidence ?? [])]);
  for (const ref of sources) {
    const record = store.get(ref.id, ref.revision);
    if (!record || !same(reference(record), ref)) fail('model_call_request_invalid', ref.id, 'evidence', 'Completion evidence must exist at the exact reference');
  }
  const diagnosticValue: UnitRefusalRecord = { gate: 'E4', refusals: [...new Set(call.value.gaps.map(gap => gap.goal))].sort().map(goal =>
    ({ code: request.code, goal, remedy: request.message, origin: { name: request.code, stage: `model-call:${request.reason}`, subject: call.value.call,
      sources: sources.map(ref => ({ role: ref.id === request.packet.id ? 'packet' : ref.id === request.call.id ? 'call'
        : ref.id === request.response?.id ? 'response' : 'evidence', ref })) } })) };
  const diagnosticWrite: Write = { id: `${unitRefusalNamespace(request.project)}e4:${hashJson(diagnosticValue)}`,
    kind: UNIT_REFUSAL_KIND, expected: 0, value: diagnosticValue };
  return diagnosticWrite;
}
/** The form saved by the application of this exact exchange; absent for calls applied before NR1. */
function savedReceivedForm(store: Store, project: string, callRef: Ref, exchange: Ref | null, response?: Ref): ReceivedForm | null {
  const call = take(readCall(store, project, callRef));
  const saved = store.get<OmModelCall>(modelRecordId(project, call.value.call))?.value;
  const om = saved?.om;
  return om && om.checked !== undefined && (exchange ? same(om.exchange, exchange) : same(saved!.response?.record ?? null, response ?? null))
    ? { checked: om.checked, failure: om.failure as Refusal<ModelCallCode> | null } : null;
}
function validateManagedFinish(store: Store, request: FinishModelAttemptRequest, binding: Revision<CompletionOwner>, received?: ReceivedForm): void {
  packetCompletionAssignments(store, binding, request.packet);
  const project = request.project, evidence = request.evidence ?? [];
  const exchangeRef = evidence.find(ref => store.get(ref.id, ref.revision)?.kind === EXCHANGE_KIND);
  if (exchangeRef) {
    const source = take(readRecord<ModelExchange>(store, exchangeRef, { unit: 'E4', target: request.call.id, kind: EXCHANGE_KIND, id: exchangeRef.id }));
    if (!object(source.value) || !object(source.value.request) || !same(source.value.request.packet, request.packet))
      fail('completion_foreign', request.call.id, 'exchange', 'The terminal evidence must belong to this exact packet');
    requireModelRequest(store, source.value.request);
    const { transport } = checkedModelExchange(store, source.value.request, request.call, exchangeRef);
    // The answer form is checked once, when the response is received; the claimed reason is compared with that result.
    const known = received ?? savedReceivedForm(store, project, request.call, exchangeRef);
    const form = known || transport.kind !== 'answered' ? null : checkAnswerForm(store, { project, packet: request.packet, raw: transport.raw });
    const checked = known ? known.checked : form?.ok ? form.value as CheckedAnswerForm : null;
    const failure = known ? known.failure : failureOf(transport, form), reason = finishReason(transport, checked, failure);
    const detail = finishDetail(transport, checked, failure);
    if (!reason || reason !== request.reason || !detail || detail.code !== request.code || detail.message !== request.message)
      fail('completion_invalid', request.call.id, 'reason', 'The local reason and diagnostic must be derived from the physical response');
    return;
  }
  if (request.code === 'process_lost' && request.reason === 'interrupted') {
    const call = take(readCall(store, project, request.call));
    const incidentRef = evidence.find(ref => store.get(ref.id, ref.revision)?.kind === 'model-call-recovery');
    const incident = incidentRef ? store.get<{call:Ref}>(incidentRef.id, incidentRef.revision) : null;
    const id = modelRecordId(project, call.value.call);
    const head = incident && isRef(incident.value.call) && incident.value.call.id === id
      ? store.get<ModelCall>(id, incident.value.call.revision + 1) : null;
    if (!head?.value.recovery) fail('completion_invalid', request.call.id, 'incident', 'Physical loss requires its proved recovery record');
    const recovery = readModelCallRecovery(store, project, reference(head));
    if (!evidence.some(ref => same(ref, reference(recovery.incident)))) fail('completion_invalid', request.call.id, 'incident', 'The incident must belong to the exact original physical claim');
    return;
  }
  if (request.reason === 'refused' && request.response) {
    const source = take(readPacketResponse(store, { project, packet: request.packet, call: request.call, response: request.response }));
    // MP2: a blocked correction stands on a refused answer; only an admitted one can be a read request.
    // Its form was checked once when it was received.
    const known = savedReceivedForm(store, project, request.call, null, request.response);
    const form = known ? null : checkAnswerForm(store, { project, packet: request.packet, raw: source.record.value.raw });
    const checked = known ? known.checked : form?.ok ? form.value : null;
    if (checked?.kind === 'need-source') {
      const reads = readContinuationEvidence(store, { project, packet: request.packet, call: request.call, response: request.response, deliveries: evidence });
      if (reads.ok && (!reads.value.novel || shownRepeat(store, project, { project, packet: request.packet, call: request.call, response: request.response,
        deliveries: evidence })) && request.code === 'research_no_progress'
        && request.message === 'The addressed reads add no information to this attempt') return;
      // Row 2 (LP3): the read the engine cannot perform, derived again from the same exact response.
      const issue = readsIssue(store, { project, packet: request.packet, call: request.call, response: request.response });
      if (issue && issue.code === request.code && issue.message === request.message && same(evidence, [issue.ref])) return;
    }
    for (const ref of evidence) if (store.get(ref.id, ref.revision)?.kind === 'question-packet') {
      const next = take(readQuestionPacket(store, { project, record: ref }));
      const parent = next.value.request.continuation ?? next.value.request.correction;
      const last = next.value.request.previous.at(-1);
      if (next.value.state === 'blocked' && next.value.refusal?.code === request.code && next.value.refusal.message === request.message
        && (parent && same(parent.packet, request.packet) && same(parent.call, request.call) && same(parent.response, request.response)
          || last && same(last.packet, request.packet))) return;
    }
    if (evidence.length && evidence.every(ref => store.get(ref.id, ref.revision)?.kind === PART_RESULT_KIND)) {
      // Diagnostic source roles are canonical sets; assembly input is an ordered
      // plan. Recover that order from each proved E2, not from hash/id ordering.
      const parts = evidence.map(ref => {
        const part = take(readPartResult(store, { project, record: ref }));
        const assigned = packetCompletionAssignments(store, binding, part.record.value.request.packet);
        return { ref, part, packet: assigned.packet, position: assigned.packet.value.plan?.position ?? -1 };
      }).sort((a,b) => a.position - b.position);
      const last = parts.at(-1)!;
      if (!last.packet.value.plan || parts.length !== last.packet.value.plan.assignments.length
        || parts.some((part,index) => part.position !== index)
        || !same(reference(last.packet), request.packet)
        || !same(last.part.record.value.request.call, request.call)
        || !same(last.part.record.value.request.response, request.response))
        fail('completion_invalid', request.call.id, 'parts', 'A failed assembly retains the entire ordered plan and its exact final physical step');
      const assembly = result(() => deriveAssembly(store, { project, results: parts.map(row => row.ref) }, false));
      if (!assembly.ok && assembly.refusal.code === request.code && assembly.refusal.message === request.message) return;
    }
  }
  fail('completion_invalid', request.call.id, 'reason', 'A local technical or cycle terminal needs its exact common producer proof');
}


export type CompletionCause = { kind: 'file-observation'; source: Ref; observation: ApplicationFileObservation }
  | { kind: 'required-record-replaced'; prerequisite: CompletionPrerequisite; replacement: Ref; proof: Ref | null }
  | { kind: 'required-absence-ended'; frame: FrameRequest; field: 'frame' | 'layer' | 'upper.frame'; appeared: Ref; graph: Ref }
  | { kind: 'series-admission-change'; condition: 'same-line' | 'active-participation'; change: SeriesAdmissionChange }
  // LP4 (№2887): a proved cessation of a step of this cycle in the exact predecessor work forbids its remaining work.
  | { kind: 'cycle-step-ceased'; cessation: Ref; work: Ref };
/** G6.2 (№3891): an end of a remaining acceptance — by its area's replaced B1, or by the saved G5 rejection of its group. */
export type FinalizationCause = CompletionCause | { kind: 'group-rejected'; rejection: Ref };
export interface CompletionDispositionContext {
  binding: Revision<CompletionOwner>; assignment: Revision<CompletionAssignment>; snapshot: CompletionSnapshot;
}
/** A product proves its exact predecessor registry without recursing through the product being read. */
export function readCompletionDispositionContext(store: Store, project: string, request: {
  binding: Ref; assignment: Ref; work: Ref;
}): ModelCallResult<Sealed<CompletionDispositionContext>> {
  return result(() => {
    const snapshot = take(readCompletionWorkAt(store, project, request.work));
    const assignment = take(readCompletionAssignmentAt(store, project, request.assignment));
    if (snapshot.work.value.closed || !same(reference(snapshot.binding), request.binding)
      || !same(assignment.value.binding, request.binding)
      || !snapshot.assignments.some(row => same(reference(row), request.assignment)))
      fail('completion_invalid', request.assignment.id, 'work', 'A disposition belongs to one assignment in its exact open predecessor');
    if (snapshot.resolved.some(ref => same(ref, request.assignment)))
      fail('completion_resolved', request.assignment.id, 'assignment', 'An already resolved assignment keeps its original product');
    return { binding: snapshot.binding, assignment, snapshot } as CompletionDispositionContext;
  });
}
export function prepareAssessmentDisposition(store: Store, project: string, intentRef: Ref): ModelCallResult<Sealed<{
  binding: Ref; assignment: Ref; work: Ref; guards: Ref[];
} | null>> {
  return result(() => {
    const intent = take(readAssessmentIntentAt(store, project, intentRef));
    const binding = take(readCompletionBinding(store, project, intent.originalSeries, intent.attempt));
    if (!binding) return null;
    const head = store.get(completionWorkId(project, binding.id));
    if (!head) fail('completion_invalid', binding.id, 'work', 'The assessment cannot lose its managed work');
    const assignment = factCompletionAssignments(store, binding as Revision<CompletionOwner>, intent.record.value.source.modelCall)
      .find(row => row.value.question === intent.fact.questionId)!;
    const request = { binding: reference(binding), assignment: reference(assignment), work: reference(head) };
    const context = take(readCompletionDispositionContext(store, project, request));
    take(checkCompletionDisposition(store, context.snapshot, { batch: assignment.value.batch, assignment: reference(assignment), action: 'apply' }));
    return { ...request, guards: [reference(head)] };
  });
}
/** Common source closure for application: exact B1 facts and, when present, the selected MC1 fact. */
export function readApplicationSources(store: Store, project: string, inputRef: Ref, grounds: readonly Sealed<AnswerGround>[]): ModelCallResult<Sealed<{
  sources: Revision<Source>[]; references: Ref[];
}>> {
  return result(() => {
    const input = take(readOmInput(store, project, inputRef));
    const applied = (input.value.input.facts ?? []).map(fact => take(readAcceptedAnswer(store, { project, record: fact.answer })));
    const all = [...grounds, ...applied.flatMap(answer => answer.record.value.grounds)];
    const citations = all.length ? take(readAnswerCitations(store, { project, citations: all.map(ground =>
      ({ source: ground.observation.source, selector: ground.observation.selector })) })) : { references: [] };
    const sources = citations.references.map(ref => take(readRecord<Source>(store, ref,
      { unit: 'G7', target: inputRef.id, kind: 'source', idPrefix: `source:${project}:` })));
    return { sources: sources as Revision<Source>[], references: refs([inputRef,
      ...applied.flatMap(answer => answer.references), ...citations.references]) };
  });
}
function completionSources(store: Store, binding: Revision<CompletionOwner>, assignment: Revision<CompletionAssignment>) {
  const project = binding.value.project;
  const routes = take(readRoutes(store, { project, record: binding.value.plan.routes }));
  let grounds: readonly Sealed<AnswerGround>[] = [];
  if (assignment.value.kind === 'fact') {
    const physical = take(readModelCallState(store, { project, record: assignment.value.source }));
    if (physical.state !== 'applied' || physical.outcome.outcome?.kind !== 'fact-candidates')
      fail('completion_invalid', assignment.id, 'source', 'A fact derives from an applied original MC1');
    grounds = physical.outcome.outcome.facts.find(row => row.questionId === assignment.value.question)!.grounds;
  }
  return take(readApplicationSources(store, project, routes.record.value.request.gaps.sources.input, grounds)).sources;
}
/** H1.0c: a saved assignment is read by the reader of its own contract; neither reader accepts the other kind. */
function readAnyCompletionAssignmentAt(store: Store, project: string, ref: Ref): { assignment: Revision<CompletionAssignment>; check: boolean } {
  const row = store.get(ref.id, ref.revision);
  if (row && object(row.value) && row.value.contract === ANSWERS_GATE_ASSIGNMENT_CONTRACT)
    return { assignment: take(readAnswersGateAssignmentAt(store, project, ref)) as unknown as Revision<CompletionAssignment>, check: true };
  return { assignment: take(readCompletionAssignmentAt(store, project, ref)) as Revision<CompletionAssignment>, check: false };
}
/** One derivation proves a cause for both its producer and all historical disposition readers. */
export function readCompletionCause(store: Store, project: string, assignmentRef: Ref, cause: CompletionCause): ModelCallResult<Sealed<{ references: Ref[] }>> {
  return result(() => {
    const { assignment, check } = readAnyCompletionAssignmentAt(store, project, assignmentRef);
    const binding = take(readCompletionOwnerAt(store, project, assignment.value.binding)) as Revision<CompletionOwner>;
    if (!object(cause)) fail('completion_cause_invalid', assignment.id, 'cause', 'A disposition requires a closed proof of a necessary condition');
    if (check && cause.kind !== 'series-admission-change' && !(cause.kind === 'required-record-replaced' && object(cause.prerequisite)
      && cause.prerequisite.kind === 'input'))
      fail('completion_cause_invalid', assignment.id, 'cause', 'The answers-gate check ends only by its proved admission change or the replaced B1 of its area');
    if (cause.kind === 'file-observation') {
      if (!exactKeys(cause, ['kind', 'source', 'observation']) || !isRef(cause.source) || !object(cause.observation)
        || !exactKeys(cause.observation, cause.observation.kind === 'read' ? ['kind', 'bytes'] : ['kind', 'code']))
        fail('completion_cause_invalid', assignment.id, 'cause', 'File cause has exact source and bounded observation');
      const source = completionSources(store, binding, assignment).filter(row => row.value.origin.kind === 'file').find(row => same(reference(row), cause.source));
      if (!source || !take(readApplicationFileObservation(source.value as Source, cause.observation)).changed)
        fail('completion_cause_invalid', assignment.id, 'source', 'Changed file evidence must violate an original required fact');
      return { references: [assignmentRef, cause.source] };
    }
    if (cause.kind === 'required-record-replaced') {
      if (!exactKeys(cause, ['kind', 'prerequisite', 'replacement', 'proof']) || !object(cause.prerequisite)
        || !isRef(cause.replacement) || !isRef(cause.prerequisite.source)
        || ((cause.prerequisite.kind === 'environment' || cause.prerequisite.kind === 'adapter') && !isRef(cause.prerequisite.context))
        || (cause.prerequisite.kind === 'adapter' && !(cause.prerequisite.packet === null || isRef(cause.prerequisite.packet)))
        || !(cause.proof === null || isRef(cause.proof))) fail('completion_cause_invalid', assignment.id, 'cause', 'Replacement proof has an exact declared prerequisite');
      const prerequisites = check ? { records: [areaInput(store, binding)] } : completionPrerequisites(store, binding, assignment,
        cause.prerequisite.kind === 'environment' || cause.prerequisite.kind === 'adapter' && cause.prerequisite.packet === null ? cause.prerequisite.context : null,
        cause.prerequisite.kind === 'adapter' ? cause.prerequisite : null,
        cause.prerequisite.kind === 'environment' ? cause.prerequisite.physical : null);
      if (!prerequisites.records.some(row => same(row, cause.prerequisite)))
        fail('completion_cause_invalid', assignment.id, 'prerequisite', 'Service heads or foreign facts are not mandatory subject inputs');
      return { references: [assignmentRef, ...readReplacement(store, project, cause.prerequisite, cause.replacement, cause.proof)] };
    }
    if (cause.kind === 'required-absence-ended') {
      if (!exactKeys(cause, ['kind', 'frame', 'field', 'appeared', 'graph']) || !isRef(cause.appeared) || !isRef(cause.graph)
        || !['frame', 'layer', 'upper.frame'].includes(cause.field)) fail('completion_cause_invalid', assignment.id, 'cause', 'Absence follows the exact source request');
      if (!completionPrerequisites(store, binding, assignment).frames.some(row => same(row, cause.frame)))
        fail('completion_cause_invalid', assignment.id, 'frame', 'A caller cannot invent a necessary absence');
      return { references: [assignmentRef, ...readAbsenceEnd(store, project, cause.frame, cause.field, cause.appeared, cause.graph)] };
    }
    if (cause.kind === 'series-admission-change') {
      if (binding.value.owner.kind !== 'block' || !exactKeys(cause, ['kind', 'condition', 'change'])
        || !object(cause.change) || !isRef(cause.change.currentPointer))
        fail('completion_cause_invalid', assignment.id, 'cause', 'Only a block assignment has participation admission');
      const original = take(readCompletionOriginalAdmission(store, project, reference(binding)));
      const change = take(readSeriesAdmissionChange(store, { project, series: original.series, pointer: original.pointer,
        currentPointer: cause.change.currentPointer }));
      const pointer = take(readCurrentSeriesPointer(store, { project, record: cause.change.currentPointer }));
      const row = pointer.value.series.find(row => row.block === (binding.value.owner as { block: string }).block);
      const condition = row && row.activation.id !== binding.value.series.id ? 'same-line'
        : row && row.participation !== 'active' ? 'active-participation' : null;
      if (!condition || cause.condition !== condition || !same(change.proof, cause.change))
        fail('completion_cause_invalid', assignment.id, 'cause', "The exact applied transition must remove this assignment's admission");
      return { references: [...original.references, ...change.references, assignmentRef] };
    }
    if (cause.kind === 'cycle-step-ceased') {
      if (!exactKeys(cause, ['kind', 'cessation', 'work']) || !isRef(cause.cessation) || !isRef(cause.work))
        fail('completion_cause_invalid', assignment.id, 'cause', 'A ceased cycle step names its exact cessation and work');
      const ceased = ceasedCycleStep(store, project, binding, assignment, cause.work);
      if (!ceased || !same(reference(ceased), cause.cessation))
        fail('completion_cause_invalid', assignment.id, 'cessation', 'Only the proved cessation of a step of this cycle forbids its remaining work');
      return { references: [assignmentRef, cause.work, cause.cessation] };
    }
    fail('completion_cause_invalid', assignment.id, 'cause', 'Unknown causes do not end application');
  });
}
/**
 * LP4 (№2887): the one derivation of a cycle-step-ceased cause, for its producer and its historical reader alike. In the
 * exact open predecessor work of this binding, the target is an unresolved part or continuation of a cycle, or the
 * unresolved root of a node (parts of a materialized plan, whose remainder is its assembly), below an unresolved root; the ground is a
 * proved cessation of a part or continuation of the same root — by exact parent references — that forbids the cycle of
 * their batch by the E4 rule itself. Facts, answers-gate checks and anything already resolved get no such cause. Of
 * several grounds the first by exact reference is chosen, whatever the order of the products.
 */
function ceasedCycleStep(store: Store, project: string, binding: Revision<CompletionOwner>, assignment: Revision<CompletionAssignment>,
  workRef: Ref): Sealed<Revision<CompletionCessation>> | null {
  const snapshot = take(readCompletionWorkAt(store, project, workRef));
  const resolved = (row: Revision<CompletionAssignment>) => snapshot.resolved.some(ref => same(ref, reference(row)));
  const byId = new Map(snapshot.assignments.map(row => [row.id, row]));
  const target = byId.get(assignment.id);
  if (!snapshot.cessations.length || snapshot.work.value.closed || !same(reference(snapshot.binding), reference(binding)) || !target
    || !same(reference(target), reference(assignment)) || resolved(target)) return null;
  // The root of an assignment by its exact parent references: a link that does not lead to an exact row leads nowhere.
  const rootOf = (row: Revision<CompletionAssignment>): Revision<CompletionAssignment> | null => {
    for (let at = row; ;) {
      if (!at.value.parent) return at.value.kind === 'root' ? at : null;
      const parent = byId.get(at.value.parent.id);
      if (!parent || !same(reference(parent), at.value.parent)) return null;
      at = parent;
    }
  };
  const root = rootOf(target);
  if (!root || resolved(root)) return null;
  if (target.value.kind === 'root' ? !snapshot.assignments.some(row => row.value.kind === 'part' && row.value.parent !== null
    && same(row.value.parent, reference(root))) || !nodePlanned(store, project, snapshot, target.value.batch)
    : target.value.kind !== 'part' && target.value.kind !== 'continuation') return null;
  const below = completionBelow(snapshot);
  const grounds = snapshot.cessations.filter(cessation => {
    const step = byId.get(cessation.value.assignment.id);
    return !!step && same(reference(step), cessation.value.assignment) && step !== target
      && (step.value.kind === 'part' || step.value.kind === 'continuation') && step.value.batch === target.value.batch
      && rootOf(step) === root && cessationForbids(store, snapshot, below, cessation, { batch: target.value.batch, action: 'cycle' }) !== null;
  }).sort((a, b) => compareJson(reference(a), reference(b)));
  return grounds[0] ?? null;
}
/**
 * LP4 (№2887, №2902): the proof that the cycle of a root is forbidden by a ceased step of that cycle — the ground of a
 * cycle-step-ceased cause on the current work — whatever cause the root is ceased by first. A direct cause keeps its
 * priority when the root is ceased; it does not hide that the cycle itself is forbidden.
 */
export function ceasedCycleGround(store: Store, project: string, rootRef: Ref): ModelCallResult<Sealed<Ref> | null> {
  return result(() => {
    const { assignment } = readAnyCompletionAssignmentAt(store, project, rootRef);
    const binding = take(readCompletionOwnerAt(store, project, assignment.value.binding)) as Revision<CompletionOwner>;
    const head = store.get(completionWorkId(project, binding.id));
    const ceased = head && assignment.value.kind === 'root' ? ceasedCycleStep(store, project, binding, assignment, reference(head)) : null;
    return ceased ? reference(ceased) : null;
  });
}
/**
 * LP5 (№3278 §1): the mandatory B1 of an attempt's own area — the exact om-input the D1 of its plan stands on. Only its
 * proved replacement by a later revision of that same record ends the area's remaining non-physical work (the registered
 * check, the common acceptance or confirmation); a moved D1/M6 on the same B1 does not (H1.0c, №1616 п.1).
 */
function areaInput(store: Store, binding: Revision<CompletionOwner>): CompletionPrerequisite {
  const routes = take(readRoutes(store, { project: binding.value.project, record: binding.value.plan.routes }));
  return { kind: 'input', source: routes.record.value.request.gaps.sources.input, graph: null, level: null };
}
function areaReplacement(store: Store, binding: Revision<CompletionOwner>): { cause: CompletionCause; guards: Ref[] } | null {
  const prerequisite = areaInput(store, binding), head = store.get(prerequisite.source.id);
  if (!head) fail('completion_cause_invalid', prerequisite.source.id, 'source', 'Loss of original Store evidence is not lawful replacement');
  if (same(reference(head), prerequisite.source)) return null;
  const cause: CompletionCause = { kind: 'required-record-replaced', prerequisite, replacement: reference(head), proof: null };
  readReplacement(store, binding.value.project, prerequisite, cause.replacement, null);
  return { cause, guards: [reference(head)] };
}
/**
 * G6.2 (№3888, №3891): the one admission of the end by a group's G5 rejection. The exact saved rejection, which rejected
 * proposals to replace, of the works candidate of this attempt's own group — the attempt its works step named, or one
 * whose own result the refused G5 checked. Every member ends so, the defective one too (it closes on its own rows
 * besides), so its sound roots stay reusable; the group stays the one it was, however many of its members closed since.
 */
function groupRejection(store: Store, binding: Revision<CompletionOwner>, ref: Ref): { cause: FinalizationCause; guards: Ref[] } {
  const project = binding.value.project;
  const rejection = take(readWorkRejectionAt(store, { project, record: ref }));
  if (!rejection.proposals.length) fail('completion_cause_unproved', ref.id, 'proposals', 'A rejection of the candidate alone replaces no member: no administrative end');
  if (!rejection.binding) fail('completion_cause_unproved', ref.id, 'binding', 'The rejection names the attempt whose works step assembled the candidate');
  // The original group is who the rejection checked: the accepting attempt and every attempt whose own result the refused
  // G5 took — never a later attempt on the same D1, which would end by it again and again.
  const accepting = binding.value.series.id === rejection.binding.series.id && binding.value.attempt === rejection.binding.ordinal;
  const head = store.get<CompletionWork>(completionWorkId(project, binding.id));
  if (!head) fail('completion_invalid', binding.id, 'work', 'A managed binding keeps its work registry');
  const products = take(readCompletionWorkAt(store, project, reference(head))).products;
  if (!accepting && !products.some(product => rejection.results.some(result => same(result.record, product))))
    fail('completion_cause_unproved', binding.id, 'group', 'Only an attempt of the group the rejection checked ends by it');
  return { cause: { kind: 'group-rejected', rejection: ref }, guards: [ref] };
}
/** LP6 (№3325 §3): the exact B1 prerequisite of an attempt's own area — what an administrative end must have replaced. */
export function readCompletionAreaInput(store: Store, project: string, bindingRef: Ref): ModelCallResult<Sealed<{
  kind: 'input'; source: Ref; graph: null; level: null;
}>> {
  return result(() => areaInput(store, take(readCompletionOwnerAt(store, project, bindingRef)) as Revision<CompletionOwner>) as {
    kind: 'input'; source: Ref; graph: null; level: null });
}
/** LP5: whether the B1 of this attempt's own area was replaced — the proved cause and its guarded head, or none. */
export function readAreaReplacement(store: Store, project: string, bindingRef: Ref): ModelCallResult<Sealed<{ cause: CompletionCause; guards: Ref[] } | null>> {
  return result(() => areaReplacement(store, take(readCompletionOwnerAt(store, project, bindingRef)) as Revision<CompletionOwner>));
}
export function prepareCompletionCause(store: Store, project: string, assignmentRef: Ref): ModelCallResult<Sealed<{
  cause: CompletionCause | null; guards: Ref[];
}>> {
  return result(() => {
    const { assignment, check } = readAnyCompletionAssignmentAt(store, project, assignmentRef);
    const binding = take(readCompletionOwnerAt(store, project, assignment.value.binding)) as Revision<CompletionOwner>;
    if (binding.value.owner.kind === 'block') {
      const original = take(readCompletionOriginalAdmission(store, project, reference(binding)));
      const pointerHead = store.get(`om-series-current:${project}`);
      if (original.pointer && !pointerHead) fail('completion_cause_invalid', assignment.id, 'pointer', 'Lost original pointer is an integrity failure');
      if (pointerHead && !same(reference(pointerHead), original.pointer)) {
        const pointer = take(readCurrentSeriesPointer(store, { project, record: reference(pointerHead) }));
        const row = pointer.value.series.find(row => row.block === (binding.value.owner as { block: string }).block);
        const condition = row && row.activation.id !== binding.value.series.id ? 'same-line'
          : row && row.participation !== 'active' ? 'active-participation' : null;
        if (condition) {
          const change = take(readSeriesAdmissionChange(store, { project, series: original.series, pointer: original.pointer,
            currentPointer: reference(pointerHead) }));
          const cause: CompletionCause = { kind: 'series-admission-change', condition, change: change.proof };
          take(readCompletionCause(store, project, assignmentRef, cause));
          return { cause, guards: [reference(pointerHead)] };
        }
      }
    }
    // H1.0c: movement of D1/M6 or of physical inputs does not prove that the check ended; LP5 (№3278 §1): the proved
    // replacement of its area's mandatory B1 does.
    if (check) {
      const replaced = areaReplacement(store, binding);
      if (replaced) take(readCompletionCause(store, project, assignmentRef, replaced.cause));
      return replaced ?? { cause: null, guards: [] };
    }
    let context: Ref | null = null;
    if (assignment.value.kind === 'fact') {
      const physical = take(readModelCallState(store, { project, record: assignment.value.source }));
      if (physical.state !== 'applied' || physical.outcome.outcome?.kind !== 'fact-candidates') fail('completion_invalid', assignment.id, 'source', 'A fact retains its original MC1');
      const fact = physical.outcome.outcome.facts.find(row => row.questionId === assignment.value.question)!;
      const intent = store.get(assessmentIntentId(project, { call: physical.outcome.call, question: fact.question, questionId: fact.questionId }), 1);
      context = intent ? reference(intent) : null;
    }
    let adapterBasis: { context: Ref; packet: Ref | null } | null = null, physicalBasis: Ref | null = null;
    if (assignment.value.kind === 'part' || assignment.value.kind === 'continuation') {
      const workHead = store.get(completionWorkId(project, binding.id));
      if (!workHead) fail('completion_invalid', assignment.id, 'work', 'A registered step retains its exact work');
      const work = take(readCompletionWorkAt(store, project, reference(workHead)));
      // Every position/continuation has its own E2 and dispatch; the assignment's
      // source alone can name the first packet of a multi-part plan.
      for (const ref of work.products) {
        if (store.get(ref.id, ref.revision)?.kind !== 'question-packet') continue;
        const packet = packetCompletionAssignments(store, binding, ref);
        if (!same(reference(packet.selected), assignmentRef) || !object(packet.packet.value.packet)) continue;
        const call = store.get(callRecordId(project, packet.packet.value.packet.requestId as string), 1);
        if (call) {
          if (adapterBasis) fail('completion_invalid', assignment.id, 'call', 'One registered physical step has one E1');
          adapterBasis = { context: reference(call), packet: ref };
          const claim = store.get(modelRecordId(project, packet.packet.value.packet.requestId as string), 1);
          physicalBasis = claim ? reference(claim) : null;
        }
      }
    }
    const prerequisites = completionPrerequisites(store, binding, assignment, context, adapterBasis, physicalBasis);
    const replaced = (records: CompletionPrerequisite[]): { cause: CompletionCause; guards: Ref[] } | null => {
      for (const prerequisite of records) {
        const head = store.get(prerequisite.source.id);
        if (!head) fail('completion_cause_invalid', prerequisite.source.id, 'source', 'Loss of original Store evidence is not lawful replacement');
        if (same(reference(head), prerequisite.source)) continue;
        if (prerequisite.kind === 'environment') {
          const before = completionEnvironment(store, project, prerequisite.source), after = completionEnvironment(store, project, reference(head));
          if (deriveAssignmentEnvironment(before.value, after.value, prerequisite.role).compatible) continue;
        }
        const proof = prerequisite.kind === 'graph' ? store.get(`graph-layer:${project}:1`)
          : prerequisite.kind === 'layer' ? store.get(`graph:${project}`) : null;
        const cause: CompletionCause = { kind: 'required-record-replaced', prerequisite,
          replacement: reference(head), proof: proof ? reference(proof) : null };
        take(readCompletionCause(store, project, assignmentRef, cause));
        return { cause, guards: [reference(head), ...(proof ? [reference(proof)] : [])] };
      }
      return null;
    };
    const nonStructural = prerequisites.records.filter(row => !['graph', 'layer', 'frame'].includes(row.kind));
    const changed = replaced(nonStructural);
    if (changed) return changed;
    // A saved file violation is a completion cause, even when it also prevents
    // current preparation of the old frame. Prove it before testing new-work admission.
    for (const source of completionSources(store, binding, assignment).filter(row => row.value.origin.kind === 'file')) {
      let observation: ApplicationFileObservation;
      try { observation = captureApplicationFileObservation(source.value as Source); }
      catch (error) { if (!(error instanceof Error)) throw error;
        fail('completion_cause_unproved', source.id, 'file', 'Unknown file errors are not a proved change'); }
      if (!take(readApplicationFileObservation(source.value as Source, observation)).changed) continue;
      const cause: CompletionCause = { kind: 'file-observation', source: reference(source), observation };
      take(readCompletionCause(store, project, assignmentRef, cause));
      return { cause, guards: [reference(source)] };
    }
    for (const frame of prerequisites.frames) {
      for (const field of ['frame', 'upper.frame', 'layer'] as const) {
        if (field === 'frame' && frame.frame !== null || field === 'layer' && frame.layer !== null
          || field === 'upper.frame' && (!frame.upper || frame.upper.frame !== null)) continue;
        const level = field === 'upper.frame' ? 2 : frame.level;
        const appeared = store.get(field === 'layer' ? `graph-layer:${project}:${level}` : `om-frame:${project}:${level}`);
        if (!appeared) continue;
        if (field === 'layer') {
          const value = appeared.value as { acceptance?: unknown; layerProofs?: { level: number }[] };
          if (value.acceptance === undefined && !value.layerProofs?.some(row => row.level === level)) {
            // C2's current admission proves that this inert lower projection is lawfully
            // unaccepted. It need not equal today's graph after an upper-layer acceptance.
            take(prepareFrame(store, frame));
            continue;
          }
        }
        const graph = field === 'layer' ? store.get(`graph:${project}`)
          : take(readAcceptedFrameLayer(store, { project, level, frame: reference(appeared) })).graph;
        if (!graph) fail('completion_cause_invalid', appeared.id, 'graph', 'Accepted source cannot lose its graph');
        const cause: CompletionCause = { kind: 'required-absence-ended', frame, field, appeared: reference(appeared), graph: reference(graph) };
        take(readCompletionCause(store, project, assignmentRef, cause));
        return { cause, guards: [reference(appeared), reference(graph)] };
      }
    }
    const structureChanged = replaced(prerequisites.records.filter(row => ['graph', 'layer', 'frame'].includes(row.kind)));
    if (structureChanged) return structureChanged;
    // LP4 (№2887): after every direct cause, the remaining work of a cycle a proved cessation of its own step forbids.
    const workHead = store.get(completionWorkId(project, binding.id));
    const ceased = workHead ? ceasedCycleStep(store, project, binding, assignment, reference(workHead)) : null;
    if (ceased) {
      const cause: CompletionCause = { kind: 'cycle-step-ceased', cessation: reference(ceased), work: reference(workHead!) };
      take(readCompletionCause(store, project, assignmentRef, cause));
      return { cause, guards: [reference(workHead!)] };
    }
    return { cause: null, guards: [] };
  });
}

export const COMPLETION_CESSATION_KIND = 'om-completion-cessation';
export interface CompletionCessation {
  contract: 'om-completion-cessation/v1'; project: string; binding: Ref; assignment: Ref; work: Ref;
  cause: CompletionCause; disposition: 'not-dispatched' | 'branch-ceased' | 'check-ceased';
  remainder: 'expansion' | 'continuation' | 'assembly' | 'application' | 'answers-gate' | null;
  packet: Ref | null; callId: string | null; physicalId: string | null; call: Ref | null; ledger: Ref | null;
  physical: Ref | null; exchange: Ref | null; rejection: Ref | null;
  // LP5 (№3278 §4): a check ceased by the replaced B1 of its area is a variant of its own era; no earlier record has it.
  variant?: typeof AREA_INPUT_VARIANT;
}
export const AREA_INPUT_VARIANT = 'area-input/v1' as const;
export const completionCessationId = (project: string, binding: string, assignment: string): string =>
  `${COMPLETION_CESSATION_KIND}:${project}:${hashJson({ binding, assignment })}`;
function assignmentCallAddress(store: Store, context: Sealed<CompletionDispositionContext>, packet: Ref | null): {
  callId: string; physicalId: string;
} | null {
  const assignment = context.assignment, project = context.binding.value.project;
  let name: string;
  if (assignment.value.kind === 'fact') {
    const state = take(readModelCallState(store, { project, record: assignment.value.source }));
    if (state.state !== 'applied' || state.outcome.outcome?.kind !== 'fact-candidates')
      fail('completion_invalid', assignment.id, 'source', 'A mandatory assessor address derives from the original applied MC1');
    const fact = state.outcome.outcome.facts.find(row => row.questionId === assignment.value.question)!;
    name = assessmentCallNameForId(project, assessmentIntentId(project,
      { call: state.outcome.call, question: fact.question, questionId: fact.questionId }));
  } else {
    if (!packet) return null;
    const source = packetCompletionAssignments(store, context.binding as Revision<CompletionOwner>, packet);
    if (!same(reference(source.selected), reference(assignment)) || !object(source.packet.value.packet)
      || !text(source.packet.value.packet.requestId))
      fail('completion_foreign', assignment.id, 'packet', 'The physical address belongs to the exact selected assignment');
    name = source.packet.value.packet.requestId;
  }
  return { callId: callRecordId(project, name), physicalId: modelRecordId(project, name) };
}
function checkedAssignmentCall(store: Store, binding: Revision<CompletionOwner> | Sealed<Revision<CompletionOwner>>,
  assignment: Revision<CompletionAssignment> | Sealed<Revision<CompletionAssignment>>, packet: Ref | null, callRef: Ref) {
  const project = binding.value.project, call = take(readCall(store, project, callRef));
  let expected: AnyRecordCallRequest;
  if (assignment.value.kind === 'fact') {
    if (call.value.basis?.kind !== 'fact-assessment' || !call.value.basis.assessment)
      fail('completion_foreign', call.id, 'intent', 'An assessor E1 needs its own exact authorized intent');
    const intent = take(readAssessmentIntentAt(store, project, call.value.basis.assessment));
    if (!same(intent.record.value.source.modelCall, assignment.value.source) || intent.fact.questionId !== assignment.value.question)
      fail('completion_foreign', call.id, 'intent', 'The assessor belongs to the exact original fact');
    expected = { call: intent.call, purpose: 'fact-assessment', basis: intent.basis, block: intent.block,
      gaps: intent.gaps, series: intent.series, attempt: intent.attempt, goal: intent.goal, dispatch: intent.dispatch, packet: intent.packet as Json };
  } else {
    if (!packet || !same(reference(packetCompletionAssignments(store, binding as Revision<CompletionOwner>, packet).selected), reference(assignment)))
      fail('completion_foreign', call.id, 'packet', 'The E1 belongs to this exact planned physical step');
    expected = modelAssignment(store, { project, packet, dispatch: call.value.dispatch, role: 'implementer' }).admission;
  }
  const actual = call.value;
  const normalized = (row: Pick<AnyCallRecord, 'call' | 'purpose' | 'basis' | 'gaps' | 'series' | 'attempt' | 'goal' | 'dispatch' | 'packet'>) => ({
    call: row.call, purpose: row.purpose, basis: row.basis, gaps: [...row.gaps].sort(compareJson), series: row.series,
    attempt: row.attempt, goal: { ...row.goal, questions: [...row.goal.questions].sort() }, dispatch: row.dispatch, packet: row.packet,
  });
  const body = callPacketText(expected.packet, expected.call);
  if (actual.series.id !== binding.value.series.id || actual.attempt !== binding.value.attempt || !same(actual.goal, binding.value.goal)
    || !same(normalized(actual), normalized({ ...expected,
      packet: { hash: hashJson(expected.packet), chars: body.length, bytes: Buffer.byteLength(body) } } as AnyCallRecord))
    || ('owner' in actual ? !('owner' in expected) || !same(actual.owner, expected.owner) : 'owner' in expected || actual.block !== expected.block))
    fail('completion_foreign', call.id, 'call', 'All E1 fields must reproduce the original assignment and its full goal');
  return call;
}
/** No current heads/files: all modes are derived from the exact predecessor and their own producer evidence. */
function cessationValue(store: Store, project: string, request: {
  binding: Ref; assignment: Ref; work: Ref; cause: CompletionCause; packet: Ref | null;
  ledger: Ref | null; physical: Ref | null;
}): CompletionCessation {
  const context = take(readCompletionDispositionContext(store, project, request));
  take(readCompletionCause(store, project, request.assignment, request.cause));
  if (request.cause.kind === 'cycle-step-ceased' && !same(request.cause.work, request.work))
    fail('completion_invalid', request.assignment.id, 'cause', 'A ceased cycle step is proved on the exact predecessor of this cessation');
  const { assignment, snapshot, binding } = context;
  if (request.ledger) take(checkCompletionLedger(store, snapshot, request.ledger, snapshot.work.value.journal));
  const base = { contract: 'om-completion-cessation/v1' as const, project, binding: request.binding,
    assignment: request.assignment, work: request.work, cause: request.cause, packet: request.packet,
    callId: null, physicalId: null, call: null, ledger: request.ledger, physical: null, exchange: null, rejection: null };
  const address = assignmentCallAddress(store, context, request.packet);
  if (request.physical) {
    if (!address || assignment.value.kind === 'fact') fail('completion_invalid', assignment.id, 'physical', 'Received assessor outcomes use their E5 result slot');
    const physical = take(readModelCallPhysical(store, { project, record: request.physical }));
    const value = physical.record.value, marker = value.om.completionOwner;
    if (!marker || !same(marker.assignment, request.assignment) || !same(marker.binding, request.binding)
      || physical.record.id !== address.physicalId || !['received', 'application-refused'].includes(value.om.application)
      || !value.om.exchange || !physical.transport
      || request.cause.kind === 'required-record-replaced' && request.cause.prerequisite.kind === 'environment'
        && (!request.cause.prerequisite.physical || request.cause.prerequisite.role !== value.om.request.role))
      fail('completion_invalid', assignment.id, 'physical', 'Only the exact received, unapplied physical response can cease application');
    return { ...base, ...address, disposition: 'branch-ceased', remainder: 'application',
      physical: request.physical, call: physical.call, exchange: value.om.exchange, rejection: value.om.rejection ?? null };
  }
  if (address) {
    // Once a claim exists, only its physical reader/recovery can establish a terminal.
    // A later unpaid E1 is legal, so its historical presence is determined by the saved ledger cut.
    if (store.get(address.physicalId, 1)) fail('completion_claim_exists', address.physicalId, 'claim', 'A physical claim cannot be declared never dispatched');
    const ledger = request.ledger ? take(readCallLedgerAt(store, project, request.ledger)) : null;
    const entries = ledger?.value.calls.filter(row => row.call.id === address.callId) ?? [];
    if (entries.length > 1) fail('completion_invalid', address.callId, 'ledger', 'One assignment has one admitted address');
    const call = entries.length ? checkedAssignmentCall(store, binding, assignment, request.packet, entries[0]!.call) : null;
    if (call && (call.value.status !== 'open' || call.value.series.id !== binding.value.series.id
      || call.value.attempt !== binding.value.attempt || !same(call.value.goal, binding.value.goal)))
      fail('completion_invalid', address.callId, 'call', 'Only an exact unpaid E1 belongs to a never-dispatched assignment');
    return { ...base, ...address, call: call ? reference(call) : null, disposition: 'not-dispatched', remainder: null };
  }
  if (request.ledger !== null) take(readCallLedgerAt(store, project, request.ledger));
  if (assignment.value.kind === 'root') {
    const parts = snapshot.assignments.filter(row => row.value.kind === 'part' && row.value.parent?.id === assignment.id);
    const remainder = parts.length ? 'assembly' : 'expansion';
    if (parts.length && !nodePlanned(store, project, snapshot, assignment.value.batch))
      fail('completion_invalid', assignment.id, 'remainder', 'Only a node plan has an assembly remainder');
    return { ...base, disposition: 'branch-ceased', remainder };
  }
  if (assignment.value.kind === 'part' || assignment.value.kind === 'continuation') {
    // Its remaining continuation: an addressed source request, or (MP2, №3147) the correction its chain still owes.
    const outcomes = snapshot.products.filter(ref => store.get(ref.id, ref.revision)?.kind === 'model-call')
      .map(ref => take(readModelCallState(store, { project, record: ref })))
      .filter(state => state.state === 'applied' && same(state.outcome.record.value.om.completionOwner?.assignment, request.assignment)
        && (state.outcome.outcome?.kind === 'need-source' || owedCorrection(store, project, snapshot.products, state.outcome) !== null));
    if (outcomes.length === 1) return { ...base, disposition: 'branch-ceased', remainder: 'continuation' };
    // A part is reserved by the original complete plan before its E2 can be materialized.
    // It has no physical identity until then; cease only that exact planned remainder.
    if (assignment.value.kind === 'part' && !snapshot.products.some(ref => {
      const row = store.get(ref.id, ref.revision);
      return row?.kind === 'question-packet' && same(reference(packetCompletionAssignments(store, binding as Revision<CompletionOwner>, ref).selected), request.assignment);
    })) return { ...base, disposition: 'branch-ceased', remainder: 'expansion' };
    fail('completion_invalid', assignment.id, 'remainder', 'A remaining branch needs its exact prior response or unmaterialized plan position');
  }
  fail('completion_invalid', assignment.id, 'remainder', 'No unknown physical address may be fabricated for a remaining branch');
}
/** A batch of the work is a node: one of its own materialized packets carries the complete part plan. */
function nodePlanned(store: Store, project: string, snapshot: Sealed<CompletionSnapshot>, batch: string): boolean {
  return snapshot.products.filter(ref => store.get(ref.id, ref.revision)?.kind === 'question-packet')
    .map(ref => take(readQuestionPacket(store, { project, record: ref })))
    .some(packet => packet.value.request.batch === batch && !!packet.value.plan);
}
/** NR1 (№3600): a trusted read — prepareCompletionCessation wrote the value of its common exact derivation. */
export function readCompletionCessationAt(store: Store, project: string, ref: Ref): ModelCallResult<Sealed<Revision<CompletionCessation>>> {
  return result(() => historicalRead(store, { reader: 'G7.completion-cessation', project, ref }, () =>
    take(readRecord<CompletionCessation>(store, ref, { unit: 'G7', target: ref.id,
      kind: COMPLETION_CESSATION_KIND, idPrefix: `${COMPLETION_CESSATION_KIND}:${project}:` })) as Revision<CompletionCessation>,
  () => fail('completion_invalid', ref.id, 'history', 'A cessation cannot prove itself')));
}
export function prepareCompletionCessation(store: Store, request: { project: string; binding: Ref; assignment: Ref }): ModelCallResult<Sealed<{
  record: Revision<CompletionCessation>; writes: Write[]; guards: TransactionGuard[];
}>> {
  return result(() => {
    const { project, binding, assignment } = request;
    const id = completionCessationId(project, binding.id, assignment.id), prior = store.get(id);
    if (prior) return { record: take(readCompletionCessationAt(store, project, reference(prior))), writes: [], guards: [] };
    const work = store.get(completionWorkId(project, binding.id)), ledgerHead = store.get(callLedgerId(project));
    if (!work) fail('completion_invalid', binding.id, 'work', 'A managed assignment needs its exact registry');
    const context = take(readCompletionDispositionContext(store, project, { binding, assignment, work: reference(work) }));
    const cause = take(prepareCompletionCause(store, project, assignment));
    if (!cause.cause) fail('completion_cause_unproved', assignment.id, 'cause', 'Current conditions still permit this assignment');
    const ledger = take(readCallLedger(store, project));
    if (!same(ledger ? reference(ledger) : null, ledgerHead ? reference(ledgerHead) : null))
      fail('input_stale', callLedgerId(project), 'ledger', 'The ledger changed during the absence proof');
    const packets = store.list<QuestionPacketRecord>('question-packet').filter(row => row.value.project === project)
      .filter(row => {
        const r = row.value.request;
        return r?.attempt?.series.id === context.binding.value.series.id && r.attempt.ordinal === context.binding.value.attempt
          && r.batch === context.assignment.value.batch && row.value.state === 'ready';
      }).map(row => packetCompletionAssignments(store, context.binding, reference(row)))
      .filter(row => same(reference(row.selected), assignment));
    if (packets.length > 1) fail('completion_conflict', assignment.id, 'packet', 'An assignment has exactly one physical packet');
    let packet = packets[0] ? reference(packets[0].packet) : null;
    const address = assignmentCallAddress(store, context, packet);
    const physicalHead = address ? store.get<OmModelCall>(address.physicalId) : null;
    let physical: Ref | null = null;
    const unclaimed: TransactionGuard[] = [];
    if (physicalHead) {
      if (context.assignment.value.kind === 'fact') fail('completion_claim_exists', physicalHead.id, 'claim', 'An assessor claim resolves through its physical E5 outcome');
      const state = take(readModelCallState(store, { project, record: reference(physicalHead) }));
      const owed = state.state === 'applied' ? owedCorrection(store, project, context.snapshot.products, state.outcome) : null;
      if (state.state === 'applied' && (state.outcome.outcome?.kind === 'need-source' || owed)) {
        packet = null;
        // MP2 (№3147): a packet written for the owed correction stays unclaimed until this cessation commits.
        unclaimed.push(...(owed?.claims ?? []).map(id => ({ id, absent: true as const })));
      } else if (state.state === 'received' || state.state === 'application-refused') physical = reference(physicalHead);
      else fail('completion_claim_exists', physicalHead.id, 'claim', 'This physical claim is unresolved or already applied');
    }
    const value = cessationValue(store, project, { ...request, work: reference(work), cause: cause.cause,
      packet, physical, ledger: ledger ? reference(ledger) : null });
    const record: Revision<CompletionCessation> = { id, kind: COMPLETION_CESSATION_KIND, revision: 1, hash: hashJson(value), value };
    const write: Write = { id, kind: record.kind, expected: 0, value };
    const completion = take(prepareCompletionProducts(pendingCallStore(store, [write]), binding, [reference(record)]));
    const writes = [write, ...completion.writes];
    const guards: TransactionGuard[] = [...cause.guards, ...completion.guards,
      ledgerHead ? reference(ledgerHead) : { id: callLedgerId(project), absent: true }, ...unclaimed];
    if (value.disposition === 'not-dispatched') {
      const callHead = store.get(value.callId!);
      if (!same(callHead ? reference(callHead) : null, value.call)) fail('input_stale', value.callId!, 'call', 'The admitted call changed during preparation');
      guards.push(callHead ? reference(callHead) : { id: value.callId!, absent: true }, { id: value.physicalId!, absent: true });
    } else if (physicalHead) guards.push(reference(physicalHead));
    return { record, writes, guards: uniqueTransactionGuards(guards.filter(guard => !isRef(guard)
      || !writes.some(row => same(writeRef(row), guard)))) };
  });
}
export function writeCompletionCessation(store: Store, request: { project: string; binding: Ref; assignment: Ref }): ModelCallResult<Sealed<Revision<CompletionCessation>>> {
  return result(() => {
    const prepared = take(prepareCompletionCessation(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'G7', target: prepared.record.id,
      writes: prepared.writes, guards: prepared.guards }));
    return prepared.record as Revision<CompletionCessation>;
  });
}

// ---- LP5 (№3278 §2): the end of an attempt's remaining common acceptance or confirmation after its area's B1 was replaced ----
export const COMPLETION_FINALIZATION_KIND = 'om-completion-finalization';
export type FinalizationPhase = 'acceptance' | 'confirmation';
/**
 * The product that ends the non-physical remainder of a complete attempt whose area lost its B1: the common acceptance
 * (C5) its complete check was waiting for, or the D2 confirmation of a goal already accepted. It is no evaluation and no
 * cessation of the complete check; every resolved root, the evaluation and the paid products keep their meaning.
 */
export interface CompletionFinalization {
  contract: 'om-completion-finalization/v1'; project: string; binding: Ref; work: Ref; phase: FinalizationPhase;
  outcome: 'ceased'; cause: FinalizationCause; level: 2 | 3; evaluation: Ref; accepted: Ref | null; basis: ConfirmationGround | null;
}
export const completionFinalizationId = (project: string, binding: string, phase: FinalizationPhase): string =>
  `${COMPLETION_FINALIZATION_KIND}:${project}:${hashJson({ binding, phase })}`;
/** The level of the attempt's own common acceptance — its node expansions, L2 before L3 — or none. */
function acceptanceLevel(store: Store, binding: Revision<CompletionOwner>): 2 | 3 | null {
  const routes = take(readRoutes(store, { project: binding.value.project, record: binding.value.plan.routes })).record.value;
  const own = routes.batches.filter(row => binding.value.plan.batches.includes(row.id) && row.task === 'node-expansion');
  return own.some(row => row.level === 2) ? 2 : own.some(row => row.level === 3) ? 3 : null;
}
/**
 * LP5 (return №3294 п.2): the own results a common acceptance of this level takes from a work — at L2 the proposals of
 * its assemblies, at L3 its assemblies and the reuses that answer its roots (the reuse itself, never the old assembly).
 * The one derivation of the pass and of the end of a remaining acceptance or confirmation.
 */
export function completionAcceptanceResults(store: Store, project: string, work: { readonly products: readonly Ref[] }, level: 2 | 3): Ref[] {
  const rows: Ref[] = [];
  for (const product of work.products) {
    const kind = store.get(product.id, product.revision)?.kind;
    if (kind !== PART_ASSEMBLY_KIND && kind !== COMPLETION_REUSE_KIND) continue;
    const proposal = kind === PART_ASSEMBLY_KIND ? take(readPartAssembly(store, { project, record: product })).proposal
      : take(readReuseResult(store, { project, record: product })).proposal;
    if (proposal.value.level === level) rows.push(level === 2 ? reference(proposal) : product);
  }
  return rows;
}
/** An accepted frame request (frame-accept `AcceptedFrameRequest`), named here by its shape: frame-accept reaches this module through atomic-gate. */
export interface AcceptedFrameRequest { project: string; level: 2 | 3; graph: Ref; layer: Ref; frame: Ref }
/** The one common acceptance that took exactly these own results: its accepted frame, frame request and attempt binding. */
export interface CompletionAcceptance { frame: Ref; acceptance: AcceptedFrameRequest; binding: FrameAttemptBinding | null }
/**
 * The common acceptance that took exactly these own results, read from the standard sources of the pass: the accepted N2
 * whose candidate carries the proposals, or the works acceptance whose results are the assemblies and reuses — whichever
 * attempt of the group coordinated it. The one derivation of the pass and of the end of a remaining acceptance.
 */
export function completionAcceptance(store: Store, project: string, level: 2 | 3, own: readonly Ref[]): CompletionAcceptance | null {
  if (!own.length) return null;
  const covers = (refs: readonly unknown[]) => own.every(ref => refs.some(other => same(other, ref)));
  if (level === 2) {
    for (const row of store.history<{ acceptance?: { candidate?: Ref; binding?: FrameAttemptBinding | null } }>(`om-frame:${project}:2`)) {
      const candidate = row.value.acceptance?.candidate;
      const proposals = candidate ? store.get<{ request: { proposals: Ref[] } }>(candidate.id, candidate.revision)?.value.request.proposals : null;
      if (!proposals || !covers(proposals)) continue;
      const read = take(readAcceptedFrameLayer(store, { project, level: 2, frame: reference(row) }));
      return { frame: reference(row), binding: row.value.acceptance!.binding ?? null,
        acceptance: { project, level: 2, graph: reference(read.graph), layer: reference(read.layer), frame: reference(read.frame) } };
    }
    return null;
  }
  for (const row of store.list<{ request: { results: { record: Ref }[]; binding?: FrameAttemptBinding | null }; acceptance: AcceptedFrameRequest | null }>('om-works-acceptance'))
    if (row.id.startsWith(`om-works-acceptance:${project}:`) && row.value.acceptance && covers(row.value.request.results.map(item => item.record)))
      return { frame: row.value.acceptance.frame, acceptance: row.value.acceptance, binding: row.value.request.binding ?? null };
  return null;
}
/** The acceptance that took the own results of this work at its level, or none — the pass's reading of the same derivation. */
export function readCompletionAcceptance(store: Store, project: string, work: { readonly products: readonly Ref[] }, level: 2 | 3): ModelCallResult<Sealed<CompletionAcceptance | null>> {
  return result(() => completionAcceptance(store, project, level, completionAcceptanceResults(store, project, work, level)));
}
/**
 * LP5 (return №3294 п.1): the heads that prove the D2 confirmation of an accepted goal impossible on its area. The machine
 * D1 of the project stands on the accepted frame of each level and on the graph head (run-bases `upperBasis`); once the
 * accepted frame of the goal's level or the graph it was accepted on is replaced, no D2 of this acceptance is admitted
 * (run `ownersScope`). While both heads are still the acceptance's own, D2 is the one way to the goal's result.
 */
export interface ConfirmationGround { frame: Ref; graph: Ref }
export function readConfirmationGround(store: Store, project: string, acceptance: AcceptedFrameRequest, level: 2 | 3): ModelCallResult<Sealed<{
  ground: ConfirmationGround | null; guards: Ref[];
}>> {
  return result(() => {
    const frame = store.get(`om-frame:${project}:${level}`), graph = store.get(`graph:${project}`);
    if (!frame || !graph) fail('completion_invalid', acceptance.frame.id, 'accepted', 'An accepted goal keeps its accepted frame and graph');
    const ground = { frame: reference(frame), graph: reference(graph) };
    readSupersession(store, project, acceptance, level, ground, false);
    return { ground: same(ground.frame, acceptance.frame) && same(ground.graph, acceptance.graph) ? null : ground, guards: [ground.frame, ground.graph] };
  });
}
/** The historical proof of a saved ground: exact later revisions of the very accepted frame and graph, one of them moved. */
function readSupersession(store: Store, project: string, acceptance: AcceptedFrameRequest, level: 2 | 3, ground: ConfirmationGround, moved: boolean): void {
  if (!object(ground) || !exactKeys(ground, ['frame', 'graph']) || !isRef(ground.frame) || !isRef(ground.graph))
    fail('completion_invalid', acceptance.frame.id, 'basis', 'A confirmation remainder names the exact frame and graph heads it ended on');
  const pairs = [[ground.frame, acceptance.frame, `om-frame:${project}:${level}`, 'connection-frame'], [ground.graph, acceptance.graph, `graph:${project}`, 'graph']] as const;
  for (const [later, accepted, id, kind] of pairs) {
    if (later.id !== id || accepted.id !== id || later.revision < accepted.revision)
      fail('completion_invalid', id, 'basis', 'The ground is a revision of the accepted frame or graph itself, never an earlier one');
    take(readRecord(store, later, { unit: 'G7', target: id, id, kind }));
  }
  if (moved && same(ground.frame, acceptance.frame) && same(ground.graph, acceptance.graph))
    fail('completion_invalid', acceptance.frame.id, 'basis', 'While the accepted frame and graph stand, D2 is the one way to the result');
}
/** The D2 event that confirmed the goal of this exact attempt (№1749 п.4–6), wherever it stands in the history. */
function confirmationOfAttempt(store: Store, project: string, binding: Revision<CompletionOwner>): Ref | null {
  for (const row of store.history<{ request: { closures: { attempt?: { series: Ref; attempt: number } }[] } }>(gapLinesId(project)))
    if (row.value.request.closures.some(item => item.attempt?.series.id === binding.value.series.id && item.attempt.attempt === binding.value.attempt))
      return reference(row);
  return null;
}
/** The saved replacement of the area's B1, read at its exact references — never today's head. */
function readAreaCause(store: Store, binding: Revision<CompletionOwner>, cause: CompletionCause): Ref[] {
  if (!object(cause) || cause.kind !== 'required-record-replaced' || !exactKeys(cause, ['kind', 'prerequisite', 'replacement', 'proof'])
    || !same(cause.prerequisite, areaInput(store, binding)) || cause.proof !== null)
    fail('completion_cause_invalid', binding.id, 'cause', 'The remaining acceptance ends only by the replaced B1 of its own area');
  return readReplacement(store, binding.value.project, cause.prerequisite, cause.replacement, null);
}
/** The one derivation of the end of a remaining acceptance or confirmation, for its producer and for every reader. */
function finalizationValue(store: Store, project: string, request: {
  binding: Ref; work: Ref; phase: FinalizationPhase; cause: FinalizationCause; accepted: Ref | null; basis: ConfirmationGround | null;
}): CompletionFinalization {
  const binding = take(readCompletionOwnerAt(store, project, request.binding)) as Revision<CompletionOwner>;
  if (!same(reference(binding), request.binding) || binding.value.owner.kind !== 'block')
    fail('completion_invalid', request.binding.id, 'binding', 'Only a block attempt has a common acceptance to end');
  const before = take(readCompletionWorkAt(store, project, request.work));
  if (before.work.value.closed || !same(reference(before.binding), reference(binding)))
    fail('completion_invalid', request.work.id, 'work', 'The end stands on the open work of its binding');
  const resolved = new Set(before.resolved.map(ref => canonical(ref)));
  if (before.assignments.some(row => !resolved.has(canonical(reference(row)))))
    fail('completion_invalid', request.work.id, 'assignments', 'Every physical root and remainder is resolved before its acceptance ends');
  const answers = before.answers;
  if (!answers || !answers.complete || answers.ceased || !answers.evaluation)
    fail('completion_invalid', request.work.id, 'answers', 'The remaining acceptance follows a complete, evaluated check');
  const level = acceptanceLevel(store, binding);
  if (!level) fail('completion_invalid', binding.id, 'level', 'Only an attempt with a common acceptance has its remainder');
  if (object(request.cause) && request.cause.kind === 'group-rejected') {
    if (!exactKeys(request.cause, ['kind', 'rejection']) || request.phase !== 'acceptance') fail('completion_cause_invalid', binding.id, 'cause',
      'The end by a group rejection names its exact event and ends a remaining acceptance');
    groupRejection(store, binding, request.cause.rejection);
  } else readAreaCause(store, binding, request.cause as CompletionCause);
  if (request.phase === 'confirmation') {
    const accepted = completionAcceptance(store, project, level, completionAcceptanceResults(store, project, before, level));
    if (!accepted || !request.accepted || !same(accepted.frame, request.accepted))
      fail('completion_invalid', binding.id, 'accepted', 'A confirmation remainder names the exact acceptance of its own results');
    take(readAcceptedFrameLayer(store, { project, level, frame: request.accepted }));
    // Its era's ground, at its saved references: the accepted frame or graph superseded — never today's heads.
    readSupersession(store, project, accepted.acceptance, level, request.basis as ConfirmationGround, true);
  } else if (request.accepted !== null || request.basis !== null || request.phase !== 'acceptance')
    fail('completion_invalid', binding.id, 'phase', 'The end of an acceptance names no accepted frame and no ground of a confirmation');
  return { contract: 'om-completion-finalization/v1', project, binding: reference(binding), work: reference(before.work),
    phase: request.phase, outcome: 'ceased', cause: request.cause, level, evaluation: answers.evaluation, accepted: request.accepted,
    basis: request.basis };
}
/** NR1 (№3600): a trusted read — prepareCompletionFinalization wrote the value of its common exact derivation. */
export function readCompletionFinalizationAt(store: Store, project: string, ref: Ref): ModelCallResult<Sealed<Revision<CompletionFinalization>>> {
  return result(() => historicalRead(store, { reader: 'G7.completion-finalization', project, ref }, () =>
    take(readRecord<CompletionFinalization>(store, ref, { unit: 'G7', target: ref.id,
      kind: COMPLETION_FINALIZATION_KIND, idPrefix: `${COMPLETION_FINALIZATION_KIND}:${project}:` })) as Revision<CompletionFinalization>,
  () => fail('completion_invalid', ref.id, 'history', 'A finalization cannot prove itself')));
}
/**
 * LP5 (№3278 §2; return №3294 п.1–2): the producer of that end. The cause is today's replacement of the area's B1, guarded.
 * The acceptance is the one common derivation over the attempt's own assemblies and reuses: while it stands the
 * acceptance is kept, never ceased; its frame head or absence is guarded. A confirmation remainder ends only when D2 is
 * proved impossible — the accepted frame or graph superseded, both heads guarded — and only while no D2 confirmed this
 * attempt (the D2 history guarded). The record and its registration are one transaction.
 */
export function prepareCompletionFinalization(store: Store, request: { project: string; binding: Ref; phase: FinalizationPhase; rejection?: Ref }): ModelCallResult<Sealed<{
  record: Revision<CompletionFinalization>; writes: Write[]; guards: TransactionGuard[];
}>> {
  return result(() => {
    const { project, phase } = request;
    if (phase !== 'acceptance' && phase !== 'confirmation') fail('completion_invalid', project, 'phase', 'A finalization names its phase');
    const binding = take(readCompletionOwnerAt(store, project, request.binding)) as Revision<CompletionOwner>;
    const id = completionFinalizationId(project, binding.id, phase), prior = store.get(id);
    if (prior) return { record: take(readCompletionFinalizationAt(store, project, reference(prior))), writes: [], guards: [] };
    const head = store.get<CompletionWork>(completionWorkId(project, binding.id));
    if (!head) fail('completion_invalid', binding.id, 'work', 'A managed binding keeps its work registry');
    if (head.value.closed) fail('completion_closed', head.id, 'work', 'Closed work accepts only exact historical repeats');
    if (request.rejection !== undefined && (!isRef(request.rejection) || phase !== 'acceptance'))
      fail('completion_invalid', binding.id, 'rejection', 'Only a remaining acceptance ends by its group\'s rejection, named by its exact event');
    const replaced = request.rejection ? groupRejection(store, binding, request.rejection) : areaReplacement(store, binding);
    if (!replaced) fail('completion_cause_unproved', binding.id, 'cause', 'The remaining acceptance keeps its area: only a replaced B1 ends it');
    const snapshot = take(readCompletionWorkAt(store, project, reference(head)));
    const level = acceptanceLevel(store, binding);
    if (!level) fail('completion_invalid', binding.id, 'level', 'Only an attempt with a common acceptance has its remainder');
    const frameId = `om-frame:${project}:${level}`, frameHead = store.get(frameId);
    const guards: TransactionGuard[] = [...replaced.guards, frameHead ? reference(frameHead) : { id: frameId, absent: true }];
    const accepted = completionAcceptance(store, project, level, completionAcceptanceResults(store, project, snapshot, level));
    if (phase === 'acceptance' && accepted)
      fail('completion_resolved', binding.id, 'accepted', 'A real acceptance of these results stands; it is kept, never ceased', accepted.frame);
    let basis: ConfirmationGround | null = null;
    if (phase === 'confirmation') {
      if (!accepted) fail('completion_invalid', binding.id, 'accepted', 'Only an accepted goal has a confirmation remainder');
      const linesHead = store.get(gapLinesId(project));
      guards.push(linesHead ? reference(linesHead) : { id: gapLinesId(project), absent: true });
      const confirmed = confirmationOfAttempt(store, project, binding);
      if (confirmed) fail('completion_resolved', binding.id, 'confirmation', 'The goal of this attempt is already confirmed by D2', confirmed);
      const read = take(readConfirmationGround(store, project, accepted.acceptance, level));
      if (!read.ground) fail('completion_cause_unproved', binding.id, 'confirmation',
        'D2 of the accepted goal is still admissible on its accepted frame and graph; only their replacement ends its confirmation', accepted.frame);
      guards.push(...read.guards);
      basis = read.ground as ConfirmationGround;
    }
    const value = finalizationValue(store, project, { binding: reference(binding), work: reference(head), phase, cause: replaced.cause,
      accepted: phase === 'confirmation' ? accepted!.frame : null, basis });
    const write: Write = { id, kind: COMPLETION_FINALIZATION_KIND, expected: 0, value: value as unknown as Json };
    const record: Revision<CompletionFinalization> = { id, kind: COMPLETION_FINALIZATION_KIND, revision: 1, hash: hashJson(value), value };
    const completion = take(prepareCompletionProducts(pendingCallStore(store, [write]), reference(binding), [reference(record)]));
    const writes = [write, ...completion.writes];
    return { record, writes, guards: uniqueTransactionGuards([...guards, ...completion.guards].filter(guard => !isRef(guard)
      || !writes.some(row => same(writeRef(row), guard)))) };
  });
}
export function writeCompletionFinalization(store: Store, request: { project: string; binding: Ref; phase: FinalizationPhase; rejection?: Ref }): ModelCallResult<Sealed<Revision<CompletionFinalization>>> {
  return result(() => {
    const prepared = take(prepareCompletionFinalization(store, request));
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'G7', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record as Revision<CompletionFinalization>;
  });
}

// ---- LP5 (№3278 §3): T1 — a paid complete L3 assembly admitted again into an unstarted root of a later attempt ----
export const COMPLETION_REUSE_KIND = 'om-completion-reuse';
/** The immediate source of a reuse: the closed earlier attempt, its exact pre-close work and close, its root and result. */
export interface CompletionReuseSource { binding: Ref; close: Ref; work: Ref; root: Ref; result: Ref }
/**
 * The proof that one unstarted L3 node-expansion root of a later attempt is answered by a paid complete assembly of an
 * earlier attempt of the same line, closed because the B1 of its area was replaced: the same complete subject, today's
 * admission of its proposal to the new works frame, and its D7 bindings carried to today's handoff by the common
 * assignment key. Nothing physical is created; the source keeps its result, expense and outcome. Through several
 * replacements the origin stays the first complete assembly; each admission is its own.
 */
export interface CompletionReuse {
  contract: 'om-completion-reuse/v1'; project: string; binding: Ref; root: Ref; work: Ref; routes: Ref; batch: string;
  source: CompletionReuseSource; origin: { assembly: Ref; proposal: Ref }; works: WorksPartBindings;
}
export const completionReuseId = (project: string, binding: string, root: string): string =>
  `${COMPLETION_REUSE_KIND}:${project}:${hashJson({ binding, root })}`;
interface ExpansionArea { node: string; source: { frame: FrameRequest; proposals: Ref[] }; frame: FrameProposals; open: string[]; subject: Json }
/**
 * The complete subject of an L3 node expansion of a binding's plan — what its answer had to fill: the batch and its routed
 * items with the whole content of their D1 gaps, and the open obligations of the node in the works frame. The addresses
 * of the area (D1 records, horizon and frame references) are no part of it. Null for any other batch.
 */
function expansionArea(store: Store, project: string, binding: Revision<CompletionOwner>, batchId: string): ExpansionArea | null {
  const routes = take(readRoutes(store, { project, record: binding.value.plan.routes })).record.value;
  const batch = routes.batches.find(row => row.id === batchId);
  const works = routes.request.gaps.sources.works as unknown as { frame: FrameRequest; proposals: Ref[] } | { state: string };
  if (!batch || batch.task !== 'node-expansion' || batch.level !== 3 || !text(batch.node) || 'state' in works) return null;
  const node = batch.node, frame = take(readFrameProposals(store, works as never)) as unknown as FrameProposals;
  const records = take(readGaps(store, routes.request.gaps as never)).records;
  const items = batch.items.map(item => {
    const row = records.find(record => same(reference(record), item.record));
    if (!row) fail('completion_invalid', item.record.id, 'gap', 'A routed item keeps its exact D1 gap');
    const { record: _record, ...rest } = item;
    return { ...rest, content: row.value.gap };
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const open = frame.result.open.filter(item => item.upper.node === node).sort((a, b) => a.id.localeCompare(b.id));
  const { id: _id, items: _items, ...head } = batch;
  return { node, source: works, frame, open: open.map(item => item.id),
    subject: JSON.parse(canonical({ ...head, items, open })) as Json };
}
/** The common assignment key of a D7 task: every responsibility and policy field, the scope and origin aside. */
function reuseAssignmentKey(value: CarriedObligation): string {
  const { scope: _scope, original: _original, ...policy } = value as CarriedObligation & { original?: unknown };
  return canonical(policy);
}
/** The D7 tasks the works packet of this node assigns (the packet's own derivation), by their common assignment key. */
function assignedTasks(area: ExpansionArea, basis: OmObligations): Map<string, CarriedObligation> {
  const assigned = new Set(workAssignments(area.frame, area.node, basis).nodeAssignments), rows = new Map<string, CarriedObligation>();
  for (const item of taskObligations(basis.handoff)) {
    if (!assigned.has(taskBindingId(item))) continue;
    const key = reuseAssignmentKey(item);
    if (rows.has(key)) fail('completion_invalid', item.obligation, 'assignments', 'An assignment cannot map to two destinations');
    rows.set(key, item);
  }
  return rows;
}
/** The D7 basis a work answer names, at its exact producer and complete ledger. */
function worksBasisAt(store: Store, project: string, works: { producer: Ref; ledger: Ref }): OmObligations {
  const basis = take(readOmObligations(store, { project, producer: works.producer })) as OmObligations;
  if (!same(reference(basis.record), works.ledger)) fail('completion_invalid', works.ledger.id, 'works', 'A D7 basis names its exact complete ledger');
  return basis;
}
/**
 * G6 (В3): whether a question the origin input held is an applied fact of today's input whose consumer is this area — its
 * node, a node above it (its block) or below it. The consumer is the applied fact's, addressed; the origin may hold the
 * question still unaddressed.
 */
function learnedSince(store: Store, project: string, origin: OmObligations, today: OmObligations, node: string): boolean {
  const before = origin.producer.value.request.gaps.sources, after = today.producer.value.request.gaps.sources;
  if (same(before.input, after.input)) return false;
  const now = take(readOmInput(store, project, after.input)).value.input;
  const applied = new Map((now.facts ?? []).map(fact => [fact.question.id, fact.question.consumer]));
  if (!applied.size) return false;
  const held = new Set(now.questions.map(question => question.id));
  const graph = take(readRecord<Graph>(store, after.graph, { unit: 'G7', target: after.graph.id, id: `graph:${project}`, kind: 'graph' })).value;
  const relations = new RefinementRelations(graph as unknown as Graph);
  return take(readOmInput(store, project, before.input)).value.input.questions.some(question => {
    const consumer = held.has(question.id) ? undefined : applied.get(question.id);
    return consumer !== undefined && (consumer === node || relations.refines(node, consumer) || relations.refines(consumer, node));
  });
}
/** Whether any physical or result step of this root already exists in the work: a packet, its parts, a call, a cycle or a result. */
function rootStarted(store: Store, binding: Revision<CompletionOwner>, before: Sealed<CompletionSnapshot>, root: Revision<CompletionAssignment>): boolean {
  const project = binding.value.project;
  const parents = new Map(before.assignments.map(row => [row.id, row.value.parent?.id ?? null]));
  const under = (id: string) => { for (let at: string | null | undefined = id; at; at = parents.get(at)) if (at === root.id) return true; return false; };
  if (before.resolved.some(ref => ref.id === root.id) || before.cessations.some(row => row.value.assignment.id === root.id)) return true;
  if (before.assignments.some(row => row.id !== root.id && under(row.id))) return true;
  for (const ref of before.products) {
    const record = store.get(ref.id, ref.revision);
    let packet: Ref | null = null;
    if (record?.kind === 'question-packet') packet = ref;
    else if (record?.kind === 'model-call') {
      const state = take(readModelCallState(store, { project, record: ref }));
      packet = (state.state === 'running' || state.state === 'received' ? state.record : state.outcome.record).value.om.request.packet;
    } else if (record?.kind === MODEL_CYCLE_KIND) packet = take(readModelCycle(store, { project, record: ref })).record.value.request.packet;
    else if (record?.kind === COMPLETION_REUSE_KIND && (record.value as unknown as CompletionReuse).root.id === root.id) return true;
    if (packet && under(packetCompletionAssignments(store, binding, packet).selected.id)) return true;
  }
  return false;
}
/** Whether a closed attempt was ended by the replaced B1 of its area (LP5): only such an attempt hands its results on. */
/** G6.2 (№3891): a work ended by the saved G5 rejection of its group — its sound results stay reusable whatever its close. */
function endedByGroupRejection(store: Store, snapshot: Sealed<CompletionSnapshot>): boolean {
  return snapshot.products.some(ref => {
    const record = store.get<CompletionFinalization>(ref.id, ref.revision);
    return record?.kind === COMPLETION_FINALIZATION_KIND && object(record.value.cause) && record.value.cause.kind === 'group-rejected';
  });
}
/** The one rule of a source attempt whose results hand on: ended by its area's B1 and interrupted, or by its group's rejection. */
function handsOn(store: Store, reason: string, snapshot: Sealed<CompletionSnapshot>): boolean {
  return reason === 'interrupted' && endedByArea(store, snapshot) || endedByGroupRejection(store, snapshot);
}
function endedByArea(store: Store, snapshot: Sealed<CompletionSnapshot>): boolean {
  if (snapshot.products.some(ref => store.get(ref.id, ref.revision)?.kind === COMPLETION_FINALIZATION_KIND)) return true;
  return snapshot.products.some(ref => {
    const record = store.get<CompletionCessation>(ref.id, ref.revision);
    return record?.kind === COMPLETION_CESSATION_KIND && record.value.disposition === 'check-ceased' && record.value.variant === AREA_INPUT_VARIANT;
  });
}
/** The root of a binding a result of its work answers: an assembly by its parts' packet, a reuse by its own root. */
function resultRoot(store: Store, project: string, binding: Revision<CompletionOwner>, result: Ref): { root: Revision<CompletionAssignment>;
  origin: { assembly: Ref; proposal: Ref }; works: WorksPartBindings } | null {
  const record = store.get(result.id, result.revision);
  if (record?.kind === PART_ASSEMBLY_KIND) {
    const assembly = take(readPartAssembly(store, { project, record: result }));
    const part = take(readPartResult(store, { project, record: assembly.record.value.results[0]! }));
    const packet = packetCompletionAssignments(store, binding, part.record.value.request.packet).packet;
    const works = (assembly.record.value as unknown as { works?: WorksPartBindings }).works;
    if (!works) return null;
    return { root: completionRoot(binding, packet.value.request.batch!), origin: { assembly: result, proposal: reference(assembly.proposal) }, works };
  }
  if (record?.kind === COMPLETION_REUSE_KIND) {
    const reuse = take(readCompletionReuseAt(store, project, result));
    if (!same(reuse.value.binding, reference(binding))) fail('completion_foreign', result.id, 'binding', 'A reuse belongs to its exact binding');
    return { root: completionRoot(binding, reuse.value.batch), origin: reuse.value.origin, works: reuse.value.works as unknown as WorksPartBindings };
  }
  return null;
}
/**
 * The one derivation of a reuse for its producer (`current`) and its historical reader. It throws on a broken or foreign
 * proof and returns null when the found result simply does not fit the new root: another subject, a partial fill, an
 * inadmissible proposal or a changed D7 task — then the root is new work.
 */
function reuseValue(store: Store, project: string, request: { binding: Ref; root: Ref; work: Ref; works: { producer: Ref; ledger: Ref };
  source: CompletionReuseSource }, current: boolean): { value: CompletionReuse; guards: TransactionGuard[] } | null {
  const binding = take(readCompletionOwnerAt(store, project, request.binding)) as Revision<CompletionOwner>;
  if (!same(reference(binding), request.binding) || binding.value.owner.kind !== 'block')
    fail('completion_invalid', request.binding.id, 'binding', 'Only a block attempt reuses a node expansion');
  const before = take(readCompletionWorkAt(store, project, request.work));
  if (before.work.value.closed || !same(reference(before.binding), reference(binding)))
    fail('completion_invalid', request.work.id, 'work', 'A reuse stands on the open work of its binding');
  const root = completionRootAssignments(binding).find(row => same(reference(row), request.root));
  if (!root) fail('completion_foreign', request.root.id, 'root', 'A reuse answers a root of its own whole assignment');
  if (rootStarted(store, binding, before, root)) fail('completion_resolved', root.id, 'root', 'A started root keeps its own work; no earlier answer replaces it');
  const area = expansionArea(store, project, binding, root.value.batch);
  if (!area) fail('completion_invalid', root.id, 'batch', 'Only an L3 node expansion is reused');
  const guards: TransactionGuard[] = [];
  // Today's D7 of the exact D1 of this plan: the authority the reused bindings receive (the packet's own basis check).
  const basis = worksBasisAt(store, project, request.works);
  const plan = take(readRoutes(store, { project, record: binding.value.plan.routes })).record.value.request.gaps;
  if (!same(basis.producer.value.request.gaps.sources, plan.sources) || !same(sortedRefs(basis.producer.value.request.gaps.records), sortedRefs(plan.records)))
    fail('completion_invalid', request.works.producer.id, 'works', 'The handoff belongs to the exact D1 of this plan');
  if (current) {
    const prepared = take(prepareOmObligations(store, basis.producer.value.request as never));
    if (prepared.writes.length || !same(reference(prepared.producer), request.works.producer) || !same(reference(prepared.record), request.works.ledger))
      fail('input_stale', request.works.producer.id, 'works', 'The complete current handoff must already be saved at the declared references');
    guards.push(...prepared.guards);
  }
  // The source: a closed earlier attempt of the same block line (or of a line it continues), ended by its replaced B1.
  const source = request.source;
  const owner = take(readCompletionOwnerAt(store, project, source.binding)) as Revision<CompletionOwner>;
  if (!same(reference(owner), source.binding) || owner.value.owner.kind !== 'block'
    || (owner.value.owner as { block: string }).block !== (binding.value.owner as { block: string }).block
    || !lineContinues(store, project, binding, owner))
    fail('completion_foreign', source.binding.id, 'source', 'A reuse comes from an earlier attempt of the same block line');
  const close = take(readCompletionCloseAt(store, project, source.close));
  if (source.close.id !== completionCloseId(project, owner.id) || !same(close.binding, reference(owner)) || !same(close.work, source.work))
    fail('completion_foreign', source.close.id, 'close', 'The source attempt is closed on its exact work');
  const earlier = take(readCompletionWorkAt(store, project, source.work));
  if (!handsOn(store, close.claim.reason, earlier))
    fail('completion_foreign', source.work.id, 'work', 'Only an attempt ended by the replaced B1 of its area or by its group\'s rejection hands its results on');
  if (!earlier.products.some(ref => same(ref, source.result)) || !earlier.resolved.some(ref => same(ref, source.root)))
    fail('completion_foreign', source.result.id, 'result', 'The result and its resolved root belong to the exact source work');
  const answered = resultRoot(store, project, owner, source.result);
  if (!answered || !same(reference(answered.root), source.root))
    fail('completion_foreign', source.result.id, 'root', 'The result is the complete assembly of exactly the named root');
  const before3 = expansionArea(store, project, owner, answered.root.value.batch);
  if (!before3 || !same(before3.subject, area.subject)) return null;
  const origin = take(readPartAssembly(store, { project, record: answered.origin.assembly }));
  if (!same(reference(origin.proposal), answered.origin.proposal)) fail('completion_foreign', answered.origin.assembly.id, 'origin', 'The origin names its exact proposal');
  // G6 (В3, №3869): a reuse never makes old work aware of new knowledge. The input the ORIGIN paid assembly was asked on
  // is compared with today's: a question it held that today's input holds as an applied fact of this area makes the old
  // result unfit, and the root is new work whose packet carries the answer. An intermediate
  // reuse changes nothing; a saved reuse is never recomputed.
  // G6.2 (№3891): a proposal G5 rejected for a defect of its own content is never reused — through any chain of reuses,
  // whose origin is this one assembly. Only today's admission asks: a saved reuse is never recomputed.
  if (current && store.get<{ status?: string }>(answered.origin.proposal.id)?.value.status === 'rejected') return null;
  const originWorks = (origin.record.value as unknown as { works?: WorksPartBindings }).works;
  if (!originWorks) fail('completion_foreign', answered.origin.assembly.id, 'works', 'A reused origin keeps the handoff it was asked on');
  if (learnedSince(store, project, worksBasisAt(store, project, originWorks), basis, area.node)) return null;
  const proposal = origin.proposal.value as unknown as { level: number; worksContract?: string; fills: { obligation: string }[] };
  if (proposal.level !== 3 || proposal.worksContract !== WORKS_FRAME_CONTRACT
    || canonical([...new Set(proposal.fills.map(fill => fill.obligation))].sort()) !== canonical(area.open)) return null;
  // Today's admission of the proposal to the new works frame — the historical reading never stands in for it.
  const proof = { frame: area.source.frame, proposals: refs([...area.source.proposals, answered.origin.proposal]) };
  const admitted = current ? prepareFrameProposals(store, proof as never) : readFrameProposals(store, proof as never);
  if (!admitted.ok) {
    if (admitted.refusal.code === 'input_stale') take(admitted);
    return null;
  }
  const result = admitted.value.result;
  if (result.open.some(item => area.open.includes(item.id)) || !area.open.every(id => result.fills.some(fill => fill.obligation === id
    && fill.source === 'proposed' && same(fill.basis, answered.origin.proposal)))) return null;
  if (current) guards.push(...(admitted.value as unknown as { guards: TransactionGuard[] }).guards);
  // The same D7 tasks of the node, and every binding of the answer carried losslessly to today's handoff.
  const formerBasis = worksBasisAt(store, project, answered.works);
  const before7 = assignedTasks(before3, formerBasis), after7 = assignedTasks(area, basis);
  if (canonical([...before7.keys()].sort()) !== canonical([...after7.keys()].sort())) return null;
  const former = new Map(taskObligations(formerBasis.handoff).map(item => [taskBindingId(item), item]));
  const bindings: TaskObligationBinding[] = [];
  for (const row of answered.works.bindings) {
    const task = former.get(row.id);
    if (!task || row.obligation !== task.obligation || !same(row.scope, task.scope))
      fail('completion_foreign', row.id, 'bindings', 'Every binding refers to its checked original handoff');
    const next = after7.get(reuseAssignmentKey(task));
    if (!next) return null;
    bindings.push({ id: taskBindingId(next), scope: next.scope, obligation: next.obligation, consumers: row.consumers.map(item => ({ node: item.node, tests: [...item.tests] })) });
  }
  const value: CompletionReuse = { contract: 'om-completion-reuse/v1', project, binding: reference(binding), root: reference(root),
    work: reference(before.work), routes: binding.value.plan.routes, batch: root.value.batch, source: { ...source }, origin: answered.origin,
    works: { contract: WORKS_FRAME_CONTRACT, producer: request.works.producer, ledger: request.works.ledger,
      bindings: [...bindings].sort((a, b) => canonical(a).localeCompare(canonical(b))) } };
  return { value: JSON.parse(canonical(value)) as unknown as CompletionReuse, guards };
}
const sortedRefs = (rows: readonly Ref[]): Ref[] => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
/** Whether the source attempt is an earlier one of this binding's line, or of a line this line continues by its predecessors. */
function lineContinues(store: Store, project: string, binding: Revision<CompletionOwner>, source: Revision<CompletionOwner>): boolean {
  if (source.value.series.id === binding.value.series.id) return source.value.attempt < binding.value.attempt;
  for (let at = take(readAnySeriesAt(store, project, binding.value.series)) as Sealed<Revision<AnyRepairSeries>>; at.value.predecessor;) {
    at = take(readAnySeriesAt(store, project, at.value.predecessor)) as Sealed<Revision<AnyRepairSeries>>;
    if (at.id === source.value.series.id) return true;
  }
  return false;
}
/**
 * The candidate results for a root, in the one deterministic order: the latest closed earlier attempt of the line first,
 * then the lines it continues; inside one attempt, its one result for this node. Contradictory results are a refusal.
 */
function reuseCandidates(store: Store, project: string, binding: Revision<CompletionOwner>, root: Revision<CompletionAssignment>): CompletionReuseSource[] {
  const area = expansionArea(store, project, binding, root.value.batch);
  if (!area) return [];
  const lines: Sealed<Revision<AnyRepairSeries>>[] = [];
  for (let at: Sealed<Revision<AnyRepairSeries>> | null = take(readAnySeriesAt(store, project, binding.value.series)) as Sealed<Revision<AnyRepairSeries>>; at;
    at = at.value.predecessor ? take(readAnySeriesAt(store, project, at.value.predecessor)) as Sealed<Revision<AnyRepairSeries>> : null) lines.push(at);
  const found: CompletionReuseSource[] = [];
  for (const line of lines) {
    const ordinals = line.value.attempts.map(row => row.ordinal).filter(ordinal => line.id !== binding.value.series.id || ordinal < binding.value.attempt)
      .sort((a, b) => b - a);
    for (const ordinal of ordinals) {
      const owner = take(readCompletionBinding(store, project, reference(line), ordinal)) as Revision<CompletionOwner> | null;
      const closeHead = owner ? store.get(completionCloseId(project, owner.id)) : null;
      if (!owner || !closeHead) continue;
      const close = take(readCompletionCloseAt(store, project, reference(closeHead)));
      const earlier = take(readCompletionWorkAt(store, project, close.work));
      if (!handsOn(store, close.claim.reason, earlier)) continue;
      const rows: CompletionReuseSource[] = [];
      for (const ref of earlier.products) {
        const kind = store.get(ref.id, ref.revision)?.kind;
        if (kind !== PART_ASSEMBLY_KIND && kind !== COMPLETION_REUSE_KIND) continue;
        const answered = resultRoot(store, project, owner, ref);
        if (!answered || !earlier.resolved.some(item => same(item, reference(answered.root)))) continue;
        if (expansionArea(store, project, owner, answered.root.value.batch)?.node !== area.node) continue;
        rows.push({ binding: reference(owner), close: reference(closeHead), work: close.work, root: reference(answered.root), result: ref });
      }
      if (rows.length > 1) fail('completion_conflict', owner.id, 'results', 'One original assignment holds contradictory results for this node');
      found.push(...rows);
    }
  }
  return found;
}
/** NR1 (№3600): a trusted read — prepareCompletionReuse wrote the value of its common exact derivation. */
export function readCompletionReuseAt(store: Store, project: string, ref: Ref): ModelCallResult<Sealed<Revision<CompletionReuse>>> {
  return result(() => historicalRead(store, { reader: 'G7.completion-reuse', project, ref }, () =>
    take(readRecord<CompletionReuse>(store, ref, { unit: 'G7', target: ref.id,
      kind: COMPLETION_REUSE_KIND, idPrefix: `${COMPLETION_REUSE_KIND}:${project}:` })) as Revision<CompletionReuse>,
  () => fail('completion_invalid', ref.id, 'history', 'A reuse cannot prove itself')));
}
/**
 * The reuse producer for one unstarted L3 root: the first fitting result of the deterministic candidates, admitted today,
 * written with its registration in one guarded transaction; no fitting result is `null` — the root is new work.
 */
export function prepareCompletionReuse(store: Store, request: { project: string; binding: Ref; root: Ref; works: { producer: Ref; ledger: Ref } }): ModelCallResult<Sealed<{
  record: Revision<CompletionReuse> | null; writes: Write[]; guards: TransactionGuard[];
}>> {
  return result(() => {
    const project = request.project;
    const binding = take(readCompletionOwnerAt(store, project, request.binding)) as Revision<CompletionOwner>;
    const id = completionReuseId(project, binding.id, request.root.id), prior = store.get(id);
    if (prior) return { record: take(readCompletionReuseAt(store, project, reference(prior))), writes: [], guards: [] };
    const head = store.get<CompletionWork>(completionWorkId(project, binding.id));
    if (!head) fail('completion_invalid', binding.id, 'work', 'A managed binding keeps its work registry');
    if (head.value.closed) fail('completion_closed', head.id, 'work', 'Closed work accepts only exact historical repeats');
    const root = completionRootAssignments(binding).find(row => same(reference(row), request.root));
    if (!root) fail('completion_foreign', request.root.id, 'root', 'A reuse answers a root of its own whole assignment');
    for (const source of reuseCandidates(store, project, binding, root)) {
      const derived = reuseValue(store, project, { binding: reference(binding), root: request.root, work: reference(head), works: request.works, source }, true);
      if (!derived) continue;
      const value = derived.value;
      const write: Write = { id, kind: COMPLETION_REUSE_KIND, expected: 0, value: value as unknown as Json };
      const record: Revision<CompletionReuse> = { id, kind: COMPLETION_REUSE_KIND, revision: 1, hash: hashJson(value), value };
      const completion = take(prepareCompletionProducts(pendingCallStore(store, [write]), reference(binding), [reference(record)]));
      const writes = [write, ...completion.writes];
      return { record, writes, guards: uniqueTransactionGuards([...derived.guards, ...completion.guards].filter(guard => !isRef(guard)
        || !writes.some(row => same(writeRef(row), guard)))) };
    }
    return { record: null, writes: [], guards: [] };
  });
}
export function writeCompletionReuse(store: Store, request: { project: string; binding: Ref; root: Ref; works: { producer: Ref; ledger: Ref } }): ModelCallResult<Sealed<Revision<CompletionReuse>>> {
  return result(() => {
    const prepared = take(prepareCompletionReuse(store, request));
    if (!prepared.record) fail('completion_invalid', request.root.id, 'reuse', 'No earlier complete result fits this root; it is new work');
    if (prepared.writes.length) take(writeGuarded(store, { unit: 'G7', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record as Revision<CompletionReuse>;
  });
}
/** The reused result as a checked L3 model source: the origin proposal with the bindings carried to today's handoff. */
export function readReuseResult(store: Store, request: { project: string; record: Ref }): ModelCallResult<Sealed<{
  record: Revision<CompletionReuse>; proposal: Revision<LayerProposal>; references: Ref[];
}>> {
  return result(() => {
    const reuse = take(readCompletionReuseAt(store, request.project, request.record));
    const origin = take(readPartAssembly(store, { project: request.project, record: reuse.value.origin.assembly }));
    return { record: reuse as Revision<CompletionReuse>, proposal: origin.proposal as Revision<LayerProposal>,
      references: refs([request.record, reuse.value.origin.assembly, reuse.value.origin.proposal, ...origin.references]) };
  });
}

function completionBelow(snapshot: Sealed<CompletionSnapshot>): (child: string, ancestor: string) => boolean {
  const parents = new Map(snapshot.assignments.map(row => [row.id, row.value.parent?.id ?? null]));
  return (child, ancestor) => {
    let id: string | null | undefined = child;
    while (id) { if (id === ancestor) return true; id = parents.get(id); }
    return false;
  };
}
/** The one E4 rule by which a proved cessation forbids an action of its batch: the admission of every action and the
 * ground of a ceased cycle step (LP4, №2887) read it alike. The ceased assignment when it forbids, otherwise null. */
function cessationForbids(store: Store, snapshot: Sealed<CompletionSnapshot>, below: (child: string, ancestor: string) => boolean,
  cessation: Sealed<Revision<CompletionCessation>>, request: { batch: string; assignment?: Ref; parent?: Ref; action: string }): Sealed<Revision<CompletionAssignment>> | null {
  const assignment = take(readCompletionAssignmentAt(store, snapshot.binding.value.project, cessation.value.assignment));
  if (assignment.value.batch !== request.batch) return null;
  const sameStep = request.assignment && same(request.assignment, cessation.value.assignment);
  const inherited = request.parent && below(request.parent.id, assignment.id)
    || request.assignment && below(request.assignment.id, assignment.id);
  const closedRoot = assignment.value.kind === 'root'
    && (cessation.value.remainder === 'expansion' || request.action === 'materialize');
  return request.action === 'cycle' || sameStep || closedRoot || inherited
    && ['expansion', 'continuation'].includes(cessation.value.remainder ?? '') ? assignment : null;
}
/** Current action admission is separate from historical product reading. */
export function checkCompletionDisposition(store: Store, snapshot: Sealed<CompletionSnapshot>, request: {
  batch: string; assignment?: Ref; parent?: Ref; action: 'dispatch' | 'materialize' | 'apply' | 'cycle';
}): ModelCallResult<Sealed<true>> {
  return result(() => {
    const below = completionBelow(snapshot);
    for (const cessation of snapshot.cessations) {
      const assignment = cessationForbids(store, snapshot, below, cessation, request);
      if (assignment) fail('completion_ceased', assignment.id, 'disposition', 'The exact step retains its proved cessation', reference(cessation));
    }
    if (request.assignment) {
      for (const ref of snapshot.products) if (store.get(ref.id, ref.revision)?.kind === 'om-assessment-result') {
        const terminal = take(readAssessmentTerminalAt(store, snapshot.binding.value.project, ref));
        if (terminal.value.verdict === 'application-terminated' && same(terminal.value.assignment, request.assignment))
          fail('completion_ceased', request.assignment.id, 'disposition', 'This fact retains its application termination', ref);
      }
    }
    if (snapshot.work.value.closed) fail('completion_closed', snapshot.work.id, 'work', 'Closed work cannot admit another action', snapshot.work.value.closed);
    return true as const;
  });
}
/** A missing assessor intent is still addressed through the whole original MC1 fact set. */
export function readAssessmentCessation(store: Store, project: string, modelCall: Ref, questionId: string): ModelCallResult<Sealed<Revision<CompletionCessation> | null>> {
  return result(() => {
    const state = take(readModelCallState(store, { project, record: modelCall }));
    if (state.state !== 'applied' || state.outcome.outcome?.kind !== 'fact-candidates')
      fail('assessment_source_invalid', modelCall.id, 'modelCall', 'An assessment names its exact original applied MC1');
    const marker = state.outcome.record.value.om.completionOwner;
    if (!marker) return null;
    const binding = take(readCompletionOwnerAt(store, project, marker.binding)) as Revision<CompletionOwner>;
    const fact = factCompletionAssignments(store, binding, modelCall).find(row => row.value.question === questionId);
    if (!fact) fail('assessment_source_invalid', modelCall.id, 'questionId', 'The exact original set must include the requested fact');
    const head = store.get(completionCessationId(project, binding.id, fact.id));
    return head ? take(readCompletionCessationAt(store, project, reference(head))) as Revision<CompletionCessation> : null;
  });
}


type CompletionPrerequisite = {
  kind: 'input' | 'graph' | 'layer' | 'frame' | 'source' | 'question'; source: Ref;
  graph: Ref | null; level: 1 | 2 | 3 | null;
} | { kind: 'environment'; source: Ref; context: Ref; physical: Ref | null; role: 'implementer' | 'reviewer' | null }
  | { kind: 'adapter'; source: Ref; context: Ref; packet: Ref | null };
function completionPrerequisites(store: Store, binding: Revision<CompletionOwner>, assignment: Revision<CompletionAssignment>, environmentBasis: Ref | null = null, adapterBasis: { context: Ref; packet: Ref | null } | null = null, physicalBasis: Ref | null = null): {
  records: CompletionPrerequisite[]; frames: FrameRequest[];
} {
  const project = binding.value.project, routes = take(readRoutes(store, { project, record: binding.value.plan.routes }));
  const source = routes.record.value.request.gaps.sources;
  const frames: FrameRequest[] = [source.operations.frame as FrameRequest,
    ...('frame' in source.works ? [source.works.frame as FrameRequest] : [])];
  const records: CompletionPrerequisite[] = [
    { kind: 'input', source: source.input, graph: null, level: null },
    { kind: 'graph', source: source.graph, graph: null, level: null },
  ];
  for (const frame of frames) {
    take(readFrameBasis(store, frame));
    if (frame.layer) records.push({ kind: 'layer', source: frame.layer, graph: frame.graph, level: frame.level });
    if (frame.frame) records.push({ kind: 'frame', source: frame.frame, graph: frame.graph, level: frame.level });
    if (frame.upper?.frame) records.push({ kind: 'frame', source: frame.upper.frame, graph: frame.graph, level: 2 });
  }
  if ('state' in source.works) records.push({ kind: 'layer', source: source.works.layer, graph: source.graph, level: 2 });
  const sources = completionSources(store, binding, assignment);
  for (const record of sources) records.push({ kind: 'source', source: reference(record), graph: null, level: null });
  if (assignment.value.kind === 'fact') {
    const model = take(readModelCallState(store, { project, record: assignment.value.source }));
    if (model.state !== 'applied' || model.outcome.outcome?.kind !== 'fact-candidates')
      fail('completion_invalid', assignment.id, 'source', 'The original fact set is required');
    const fact = model.outcome.outcome.facts.find(row => row.questionId === assignment.value.question)!;
    take(readMc1Question(store, { project, record: fact.question }));
    records.push({ kind: 'question', source: fact.question, graph: null, level: null });
    // Store replacement applies also to owner-document citations, not only live files.
    const citations = take(readAnswerCitations(store, { project, citations: fact.grounds.map(ground =>
      ({ source: ground.observation.source, selector: ground.observation.selector })) }));
    for (const ref of citations.references) records.push({ kind: 'source', source: ref, graph: null, level: null });
  }
  const context = assignment.value.kind === 'fact' ? environmentBasis
    : assignment.value.kind === 'root' ? null : assignment.value.source;
  if (context) {
    let source: Ref, role: 'implementer' | 'reviewer' | null;
    if (assignment.value.kind === 'fact') {
      const intent = take(readAssessmentIntentAt(store, project, context));
      if (!same(intent.record.value.source.modelCall, assignment.value.source) || intent.fact.questionId !== assignment.value.question
        || intent.originalSeries.id !== binding.value.series.id || intent.attempt !== binding.value.attempt || !same(intent.goal, binding.value.goal))
        fail('completion_cause_invalid', assignment.id, 'context', 'The dispatch context belongs to this exact mandatory fact');
      source = intent.dispatch.config; role = 'reviewer';
      readDispatchAdapter(store, intent.dispatch.adapter);
      records.push({ kind: 'adapter', source: intent.dispatch.adapter, context, packet: null });
    } else {
      const packet = packetCompletionAssignments(store, binding, context).packet;
      source = packet.value.request.environment; role = null;
      if (physicalBasis) {
        const physical = take(readModelCallPhysical(store, { project, record: physicalBasis }));
        const marker = physical.record.value.om.completionOwner;
        if (!marker || !same(marker.assignment, reference(assignment)) || !same(marker.binding, reference(binding))
          || !same(physical.record.value.om.request.dispatch.config, source))
          fail('completion_cause_invalid', assignment.id, 'physical', 'The selected role belongs to this exact physical assignment');
        role = physical.record.value.om.request.role;
      }
    }
    completionEnvironment(store, project, source);
    records.push({ kind: 'environment', source, context, physical: assignment.value.kind === 'fact' ? null : physicalBasis, role });
  }
  if (adapterBasis?.packet) {
    const call = checkedAssignmentCall(store, binding, assignment, adapterBasis.packet, adapterBasis.context);
    readDispatchAdapter(store, call.value.dispatch.adapter);
    records.push({ kind: 'adapter', source: call.value.dispatch.adapter, ...adapterBasis });
  }
  return { records: [...new Map(records.map(row => [canonical(row), row])).values()], frames };
}
function readReplacement(store: Store, project: string, prerequisite: CompletionPrerequisite, replacement: Ref, proof: Ref | null): Ref[] {
  const original = prerequisite.source;
  if (!isRef(replacement) || replacement.id !== original.id || replacement.revision <= original.revision)
    fail('completion_cause_invalid', original.id, 'replacement', 'Replacement must be an exact later revision of the necessary source');
  const kinds = { input: 'om-input', graph: 'graph', layer: 'graph-layer', frame: 'connection-frame', source: 'source', question: 'mc1-question', environment: 'environment', adapter: 'dispatch-adapter' };
  const row = take(readRecord<unknown>(store, replacement, { unit: 'G7', target: original.id, id: original.id, kind: kinds[prerequisite.kind] }));
  switch (prerequisite.kind) {
    case 'adapter': {
      readDispatchAdapter(store, original); readDispatchAdapter(store, replacement);
      if (proof !== null) fail('completion_cause_invalid', replacement.id, 'proof', 'Adapter replacement retains its own exact dispatch contract');
      return [original, replacement, prerequisite.context, ...(prerequisite.packet ? [prerequisite.packet] : [])];
    }
    case 'environment': {
      const before = completionEnvironment(store, project, original), after = completionEnvironment(store, project, replacement);
      if (proof !== null || deriveAssignmentEnvironment(before.value, after.value, prerequisite.role).compatible)
        fail('completion_cause_invalid', replacement.id, 'condition', 'Revision movement or unrelated settings do not violate this dispatch assignment');
      return [original, replacement, prerequisite.context, ...(prerequisite.physical ? [prerequisite.physical] : [])];
    }
    case 'input': take(readOmInput(store, project, replacement)); break;
    case 'question': take(readMc1Question(store, { project, record: replacement })); break;
    case 'source': {
      const value = row.value as Source;
      if (row.kind !== 'source' || typeof value.content !== 'string' || !value.content.length)
        fail('completion_cause_invalid', row.id, 'source', 'Replacement evidence retains its own valid Source contract');
      take(readAnswerCitations(store, { project, citations: [{ source: replacement,
        selector: { kind: 'text-range', start: 0, end: value.content.length } }] }));
      break;
    }
    case 'frame': {
      const frame = take(readAcceptedFrameLayer(store, { project, level: prerequisite.level as 2 | 3, frame: replacement }));
      return [...frame.references];
    }
    case 'graph': {
      if (!proof) fail('completion_cause_invalid', row.id, 'proof', 'A replacement graph needs its exact accepted upper envelope');
      const layer = take(readLayerEnvelope(store, { project, level: 1, graph: replacement, layer: proof }));
      return [...layer.references];
    }
    case 'layer': {
      if (!proof) fail('completion_cause_invalid', row.id, 'proof', 'A replacement layer names its exact graph');
      const envelope = take(readLayerEnvelope(store, { project, level: prerequisite.level as 2 | 3, graph: proof, layer: replacement }));
      const accepted = envelope.layer.value.acceptance !== undefined || envelope.layer.value.layerProofs?.some(row => row.level === prerequisite.level);
      const layer = take((accepted ? readLayerAcceptance : readUnacceptedLayer)(store,
        { project, level: prerequisite.level as 2 | 3, graph: proof, layer: replacement }));
      return [...layer.references];
    }
  }
  if (proof !== null) fail('completion_cause_invalid', row.id, 'proof', 'This source derives its own complete provenance');
  return [original, replacement];
}
function readAbsenceEnd(store: Store, project: string, frame: FrameRequest, field: 'frame' | 'layer' | 'upper.frame', appeared: Ref, graph: Ref): Ref[] {
  const original = take(readFrameBasis(store, frame));
  if (field === 'layer') {
    if (frame.layer !== null || appeared.id !== `graph-layer:${project}:${frame.level}`)
      fail('completion_cause_invalid', appeared.id, 'absence', 'This exact request must require an unaccepted lower layer');
    const accepted = take(readLayerAcceptance(store, { project, level: frame.level, graph, layer: appeared }));
    return [...original.references, ...accepted.references];
  }
  const level = field === 'upper.frame' ? 2 : frame.level;
  if (field === 'upper.frame' ? !frame.upper || frame.upper.frame !== null : frame.frame !== null)
    fail('completion_cause_invalid', appeared.id, 'absence', 'The exact original request requires this omitted frame');
  const accepted = take(readAcceptedFrameLayer(store, { project, level, frame: appeared }));
  if (!same(reference(accepted.graph), graph)) fail('completion_cause_invalid', appeared.id, 'graph', 'The appeared frame retains its own exact output graph');
  return [...original.references, ...accepted.references];
}


function completionEnvironment(store: Store, project: string, ref: Ref): Revision<Environment> {
  try { return readEnvironmentAt(store, project, ref); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    fail('completion_cause_invalid', ref.id, 'environment', error.message, ref);
  }
}

/** The same stage table governs first admission, application and the proof that work can no longer execute.
 * null means ordinary work has not selected a role. Exact claim/response readers supply its selected role;
 * the assessor contract supplies reviewer even before claim. No assumed ordinary role is persisted. */
function deriveAssignmentEnvironment(before: Environment, after: Environment, selected: 'implementer' | 'reviewer' | null) {
  const roles: readonly ('implementer' | 'reviewer')[] = selected === null ? ['implementer', 'reviewer'] : [selected];
  const common = (value: Environment) => ({ workspace: value.workspace, timeoutMs: value.timeoutMs,
    capacity: value.requestCapacityChars ?? null });
  const roleValue = (value: Environment, role: 'implementer' | 'reviewer') => {
    const binding = resolveRoleMode(role, value[role], 'research');
    return { actor: binding.actor, model: binding.model, effort: binding.effort,
      speed: binding.speed ?? 'inherited', command: binding.command };
  };
  const commonCompatible = same(common(before), common(after));
  const compatibleRoles = commonCompatible ? roles.filter(role => same(roleValue(before, role), roleValue(after, role))) : [];
  return { roles, compatibleRoles, commonCompatible, compatible: compatibleRoles.length > 0 };
}

/** A selected assignment keeps its original dispatch at claim and application; equivalent current settings provide fresh CAS admission. */
export function prepareApplicationEnvironment(store: Store, project: string, original: Ref, role: 'implementer' | 'reviewer' | null): ModelCallResult<EnvironmentAdmission> {
  try {
    const head = store.get(`environment:${project}`);
    if (!head) fail('completion_cause_invalid', original.id, 'environment', 'The required environment cannot disappear');
    const source = completionEnvironment(store, project, original), current = completionEnvironment(store, project, reference(head));
    if (!deriveAssignmentEnvironment(source.value, current.value, role).compatible)
      fail('input_stale', head.id, 'environment', 'Current settings no longer admit this exact assignment');
    const remap = (guards: readonly TransactionGuard[]) => uniqueTransactionGuards(guards.map(guard =>
      isRef(guard) && same(guard, original) ? reference(head) : guard));
    const view = same(reference(head), original) ? store : new Proxy(store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === original.id && revision === undefined ? source : target.get(id, revision);
      const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member;
    } });
    // This current-only handle intentionally is not a sealed/serializable proof object.
    return { ok: true, value: { store: view, guards: [reference(head)], remap } };
  } catch (error) { { const failed = caught(error); if (failed) return failed; } throw error; }
}


function checkCompletionTransition(store: Store, before: Sealed<CompletionSnapshot>, added: readonly Ref[]): void {
  const project = before.binding.value.project, binding = before.binding as Revision<CompletionOwner>;
  for (const ref of added) {
    const record = store.get(ref.id, ref.revision);
    if (!record || !same(reference(record), ref)) fail('completion_invalid', ref.id, 'product', 'A transition only registers exact products');
    if (record.kind === COMPLETION_PACKET_KIND) {
      const candidate = take(readCompletionPacketAt(store, project, ref));
      checkPacketMaterialization(store, before, candidate.value.packet);
    } else if (record.kind === COMPLETION_CESSATION_KIND) {
      const ceased = take(readCompletionCessationAt(store, project, ref));
      if (!same(ceased.value.work, reference(before.work)))
        fail('completion_invalid', ref.id, 'work', 'A cessation is atomic with its immediately succeeding registry');
    } else if (record.kind === COMPLETION_FINALIZATION_KIND) {
      const finalized = take(readCompletionFinalizationAt(store, project, ref));
      if (!same(finalized.value.work, reference(before.work)))
        fail('completion_invalid', ref.id, 'work', 'A finalization is atomic with its immediately succeeding registry');
    } else if (record.kind === COMPLETION_REUSE_KIND) {
      const reuse = take(readCompletionReuseAt(store, project, ref));
      if (!same(reuse.value.work, reference(before.work)))
        fail('completion_invalid', ref.id, 'work', 'A reuse is atomic with its immediately succeeding registry');
      take(checkCompletionDisposition(store, before, { batch: reuse.value.batch, assignment: reuse.value.root, action: 'materialize' }));
    } else if (record.kind === 'om-assessment-result') {
      const result = take(readAssessmentTerminalAt(store, project, ref));
      const intent = take(readAssessmentIntentAt(store, project, result.value.intent));
      const fact = factCompletionAssignments(store, binding, intent.record.value.source.modelCall)
        .find(row => row.value.question === intent.fact.questionId)!;
      take(checkCompletionDisposition(store, before, { batch: fact.value.batch, assignment: reference(fact), action: 'apply' }));
      if (result.value.verdict === 'application-terminated' && !same(result.value.work, reference(before.work)))
        fail('completion_invalid', ref.id, 'work', 'Application termination is atomic with its exact predecessor work');
    } else if (record.kind === 'question-packet') {
      requirePacketOfAttempt(store, binding, ref);
      const step = packetCompletionAssignments(store, binding, ref).selected;
      take(checkCompletionDisposition(store, before, { batch: step.value.batch, assignment: reference(step),
        ...(step.value.parent ? { parent: step.value.parent } : {}), action: 'materialize' }));
    } else if (record.kind === 'model-call') {
      const physical = take(readModelCallState(store, { project, record: ref }));
      const value = physical.state === 'running' || physical.state === 'received' ? physical.record : physical.outcome.record;
      requirePacketOfAttempt(store, binding, value.value.om.request.packet);
      const step = packetCompletionAssignments(store, binding, value.value.om.request.packet).selected;
      take(checkCompletionDisposition(store, before, { batch: step.value.batch, assignment: reference(step), action: 'apply' }));
    } else if (record.kind === MODEL_CYCLE_KIND) {
      const cycle = take(readModelCycle(store, { project, record: ref }));
      requirePacketOfAttempt(store, binding, cycle.record.value.request.packet);
      const step = packetCompletionAssignments(store, binding, cycle.record.value.request.packet).selected;
      take(checkCompletionDisposition(store, before, { batch: step.value.batch, action: 'cycle' }));
    }
  }
  take(checkAnswersTransition(store, before, added));
}
