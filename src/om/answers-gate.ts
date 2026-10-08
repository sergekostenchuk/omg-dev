import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { deriveInputDecisions, inputDecisionNamespace, type InputDecisionProposal } from './addressing.js';
import { applicableAnswerTask, readAnswerTaskBasis, readMc1Question, readAcceptedAnswer,
  type AnswerInvalidation } from './accepted-answer.js';
import { assessmentRefusalId, readAssessmentIntentAt, readAssessmentTerminalAt, type AssessmentResultRecord } from './assessment.js';
import { readCall, readFactAssessmentOrigin } from './call-record.js';
import { readCandidate, gateCandidate, prepareCandidate, type CandidateRequest } from './frame-candidate.js';
import { prepareFrameProposals, readFrameProposals } from './frame-proposals.js';
import { bypassRouteOf, readGaps, prepareCurrentGaps, type GapReadRequest, type Gap, type GapKind, type GapMoment } from './gaps.js';
import { gapLineKey } from './gap-lines.js';
import { historicalRead, readOmInput, withHistoricalReads, type OmInputRecord } from './input.js';
import { readPartAssembly, readModelCallState, readModelTransport, readCompletionWorkAt, prepareCompletionProducts, readModelCycle,
  readManagedModelDiagnostic,
  pendingCallStore, readCompletionCause, prepareCompletionCause, readCompletionCessationAt, completionCessationId,
  COMPLETION_CESSATION_KIND, AREA_INPUT_VARIANT, COMPLETION_REUSE_KIND, readReuseResult, type CompletionCause, type CompletionCessation, type CompletionSnapshot } from './model-call.js';
import { answersGateAssignment, completionWorkId, readCompletionBinding, readCompletionOwnerAt, readAnswersGateAssignmentAt, type AnswersGateAssignment,
  type AttemptGoal, type CompletionOwner, type CompletionWork } from './series.js';
import { UNIT_REFUSAL_KIND, answersSourceMarks, journalId, prepareJournalBatch, readJournalAt, registerAnswersSourceReader,
  unitRefusalNamespace, type UnitRefusalRecord } from './refusal-journal.js';
import { readPartResult, readQuestionPacket } from './question-packet.js';
import { ownerAnswersOf, ownerResultNamespace, readOwnerResult,
  type OwnerReaders } from './owner-result.js';
import { readRecord, writeGuarded } from './refs.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type RefusalRoute, type Sealed } from './refusal.js';
import { readRoutes, prepareRoutes, type RoutesRequest, type RoutedGap, type SavedRoutesRequest } from './routes.js';
import { captureManagedCloseHeads, prepareCloseAttempt, prepareLinkedClose, requireCloseRequestShape, type AnyCloseAttemptRequest,
  type RepeatOutcome } from './repeat-gate.js';

export const ANSWERS_GATE_CONTRACT = 'om-answers-gate/v1' as const;
export const ANSWERS_GATE_KIND = 'om-answers-gate';
export const ANSWERS_GATE_CODES = sealed([
  'answers_gate_request_invalid', 'answers_gate_record_invalid', 'answers_missing', 'gap_source_missing', 'input_stale',
  'revision_conflict', 'record_foreign', 'answer_missing_for_blocking_gap', 'answer_version_stale',
  'answer_route_foreign', 'answer_duplicate', 'answer_gap_unknown', 'route_result_missing',
  'route_result_unsupported', 'owner_result_unavailable', 'owner_result_answered', 'owner_result_foreign',
  'deferral_not_permitted',
  'delta_not_verified', 'delta_stale', 'answers_binding_invalid', 'answers_evaluation_owner_unsupported',
  'answers_evaluation_invalid',
] as const);

export interface AnswerRouteResult {
  gap: Ref; result: Ref | null; candidate: Ref | null;
  deferral?: { reason: 'outside_horizon'; until: 'horizon-entry' };
}
export interface AnswersGateRequest { project: string; gaps: GapReadRequest; routes: Ref; results: AnswerRouteResult[] }
export interface AnswersGateOutcome { passed: boolean; codes: string[]; findings: Refusal[] }
export interface AnswersGateRecord {
  contract: typeof ANSWERS_GATE_CONTRACT; project: string; request: AnswersGateRequest; result: AnswersGateOutcome;
}
export interface PreparedAnswersGate {
  record: Revision<AnswersGateRecord>; writes: Write[]; guards: TransactionGuard[]; references: Ref[];
}
// One kind per emission point of derive, and one per proven cause where a single point covers several.
export const ANSWERS_GATE_EMISSIONS = sealed([
  'gap-revision-stale', 'gap-ref-inexact', 'gap-unknown', 'gap-unrouted', 'deferral-declared', 'deferral-inherited', 'duplicate',
  'owner-absent', 'unsupported-absent', 'blocking-absent', 'route-disallowed', 'candidate-without-result',
  'owner-offered', 'unsupported-offered', 'owner-answered', 'blocking-null', 'result-route-disallowed', 'fact-candidate',
  'answer-foreign-project', 'answer-without-fact-task', 'answer-search-missing', 'answer-outside-search',
  'answer-inapplicable', 'answer-route-not-code', 'answer-unselected', 'answer-candidate',
  'decision-unapplied', 'decision-foreign', 'offered-known-foreign', 'offered-unrecognized',
  'part-not-assembly', 'design-known-foreign', 'design-unrecognized', 'assembly-assignment-foreign',
  'candidate-absent', 'candidate-gate-negative', 'candidate-stale', 'works-candidate', 'works-frame-unavailable',
  'works-obligation-open', 'works-obligation-filled-elsewhere', 'batch-level-foreign',
  'mc1-unfinished', 'mc1-foreign-task', 'mc1-task-foreign-gap', 'mc1-fact-candidates', 'mc1-technical',
  'transport-foreign', 'legacy-question-foreign', 'assessment-question-foreign', 'assessment-task-foreign',
  'assessment-supported', 'assessment-transport-managed', 'assessment-insufficient', 'assessment-conflicting',
  'assessment-off-form', 'assessment-interrupted', 'assessment-terminated', 'assessment-legacy-transport',
  'mc2-terminal', 'mc2-terminal-foreign',
] as const);
export type AnswersGateEmission = typeof ANSWERS_GATE_EMISSIONS[number];
export const ANSWERS_GATE_SOURCE_ROLES = sealed([
  'offered', 'answer', 'search-index', 'decision', 'part', 'assembly', 'proposal', 'packet', 'candidate',
  'model-call', 'call', 'packet-routes', 'response', 'diagnostic', 'transport', 'terminal', 'intent', 'question',
  'accepted', 'binding', 'assignment', 'work', 'receipt', 'observed-source', 'prerequisite', 'replacement',
  'replacement-proof', 'appeared', 'appeared-graph', 'admission-series', 'admission-pointer', 'admission-applied',
  'admission-current', 'cycle', 'ceased-step', 'ceased-work', 'reuse',
] as const);
export type AnswersGateSourceRole = typeof ANSWERS_GATE_SOURCE_ROLES[number];
// Every violated condition of a composite emission point, so one emitted finding keeps all of its checked causes.
export const ANSWERS_GATE_MISMATCHES = sealed([
  'call-purpose', 'call-basis', 'source-batch-absent', 'current-batch-absent', 'batch-model', 'batch-task',
  'batch-changed', 'item-absent', 'route-task-absent', 'gap-unassigned', 'gap-kind', 'question-gap', 'question-task',
  'question-address', 'task-address', 'task-contract', 'graph-hash', 'level', 'proposal',
  'cycle-terminal', 'cycle-binding', 'cycle-candidate',
] as const);
export type AnswersGateMismatch = typeof ANSWERS_GATE_MISMATCHES[number];
export interface AnswersGateSource { role: AnswersGateSourceRole; ref: Ref }
export interface AnswersGateDetail {
  declared?: boolean; inherited?: boolean; allowed?: string[]; recognized?: boolean; state?: string;
  outcome?: string | null; verdict?: string; purpose?: string; level?: number | null; mismatch?: AnswersGateMismatch[];
  cessation?: CompletionCause['kind']; observation?: string; prerequisite?: string; absence?: string; condition?: string;
}
export interface AnswersGateRouteTrace { routes: Ref; route: string; task: Ref | null }
/**
 * gap is null only when the submission names no gap of the exact D1 set. occurrences are the exact rows of the saved
 * v1 request, as submitted, with their multiplicity; every other Ref of the cause is exactly {id, revision, hash}.
 */
export interface AnswersGateCause {
  emission: AnswersGateEmission; gap: Ref | null; occurrences: AnswerRouteResult[];
  route: AnswersGateRouteTrace | null; sources: AnswersGateSource[]; detail: AnswersGateDetail;
}
export interface AnswersGateTraceEntry { finding: Refusal; cause: AnswersGateCause }
export interface AnswersGateTrace { record: Revision<AnswersGateRecord>; trace: AnswersGateTraceEntry[] }
export interface TracedAnswersGate { prepared: PreparedAnswersGate; trace: AnswersGateTraceEntry[] }
interface DerivedAnswersGate extends PreparedAnswersGate { trace: AnswersGateTraceEntry[] }
type Traced = (emission: AnswersGateEmission, found: Refusal, sources?: AnswersGateSource[],
  detail?: AnswersGateDetail) => AnswersGateTraceEntry;

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const unique = <T>(values: readonly T[]): T[] => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
class GateFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: string, target: string, field: string, message: string, ref?: Ref): never {
  const result = refused(code, message, { unit: 'G4b', target, field, ref }, 'readiness');
  if (!result.ok) throw new GateFailure(result.refusal);
  throw new Error('Unreachable refusal');
}
function finding(code: string, target: string, field: string, message: string, ref?: Ref): Refusal {
  const route: RefusalRoute = code.startsWith('owner_result_') ? 'owner'
    : code === 'route_result_unsupported' ? 'producer' : 'readiness';
  const result = refused(code, message, { unit: 'G4b', target, field, ref }, route);
  if (!result.ok) return result.refusal;
  throw new Error('Unreachable refusal');
}

/**
 * H1.5 (№2166): the one place that says whether OM has a producer for the answer to a question. It reads only the fields
 * of a gap of the proven D1; G4b's two emission points, the choice of work of H1 and the physical admission of E4 all ask
 * it, so none of them keeps a list of its own. An owner question waits for the separately authenticated H2 producer; a
 * predecessor question that is not a repository fact has no answer producer in the current contract. Nothing else does
 * (M5 addressing, the input fields nodes/state/checkKind and the node expansion have their own producers).
 */
export type AnswerProducer =
  | { readonly present: true }
  | { readonly present: false; readonly code: 'owner_result_unavailable' | 'route_result_unsupported';
    readonly field: 'owner-result' | 'answer'; readonly message: string };
export type NoProducer = Extract<AnswerProducer, { present: false }>;
const PRODUCER_PRESENT: AnswerProducer = Object.freeze({ present: true });
const OWNER_ABSENT: NoProducer = Object.freeze({ present: false, code: 'owner_result_unavailable', field: 'owner-result',
  message: 'An owner gap needs the separately authenticated H2 owner-result producer' });
const ANSWER_UNSUPPORTED: NoProducer = Object.freeze({ present: false, code: 'route_result_unsupported', field: 'answer',
  message: 'This question has no OM answer producer in the current contract' });
export function answerProducerOf(gap: Pick<Gap, 'code' | 'field' | 'kind' | 'moment'>): AnswerProducer {
  if (!object(gap) || !text(gap.code) || !text(gap.field) || !text(gap.kind) || !text(gap.moment)) invalid('gap');
  // OWN1 (№3702, №3711): the owner's standing word is the bypass — the model decides a design or an owner question of the
  // pass itself (MC2 input-field, applied by F5.3); an owner's own H2 result still covers its gap when one is offered. A
  // mode with the owner's choice among prepared answers comes later with the UI. A question asked at a later moment
  // (a decision or an environment confirmation at task start, a proof after the task) is no question of the pass: the
  // pass has no producer of it, and D7 carries it to its consumer — an owner's still waits for the owner's H2.
  if (gap.code !== 'predecessor_question' || gap.field !== 'answer') return PRODUCER_PRESENT;
  if (gap.kind === 'owner-decision' && gap.moment !== 'om-pass') return OWNER_ABSENT;
  if (gap.kind === 'environment-confirmation' || gap.kind === 'post-implementation-proof' || gap.moment !== 'om-pass')
    return ANSWER_UNSUPPORTED;
  return PRODUCER_PRESENT;
}
/** OWN1: the bypass route of an owner question is its M6 route as much as the routes D1 keeps for an offered result. */
const routeAllowed = (gap: Pick<Gap, 'kind' | 'code' | 'field' | 'moment'> & { readonly routes: readonly string[] }, route: string): boolean =>
  gap.routes.includes(route) || route === bypassRouteOf(gap);
/** The emission points of derive that name a question without an answer producer (`answerProducerOf` says absent). */
export const NO_PRODUCER_EMISSIONS: readonly AnswersGateEmission[] = Object.freeze(['owner-absent', 'owner-offered',
  'unsupported-absent', 'unsupported-offered'] as const);
/**
 * H2.0: positive emissions carry a proof of acceptance, not a refusal. They still appear in the trace — every cause is
 * observable — but they are not findings: `result.findings`, `result.codes` and `passed` count only the negative half,
 * and the evaluation journals only refusals. A positive entry's `finding` field stays a populated Refusal (the
 * informational verdict of the admission), so every historical consumer that types it non-null keeps working.
 */
export const POSITIVE_EMISSIONS: readonly AnswersGateEmission[] = Object.freeze(['owner-answered'] as const);
const isPositive = (entry: AnswersGateTraceEntry): boolean =>
  (POSITIVE_EMISSIONS as readonly string[]).includes(entry.cause.emission);
// H2.0: the producer and the gate share one reader — the same om readers this file already uses, handed in so the
// owner-result module itself stays off the OM import ring.
const OWNER_READERS: OwnerReaders = { routes: readRoutes, input: readOmInput };
// The E5 terminal verdict is the checked distinction between N, T and cessation under one G4b code.
const TERMINAL_EMISSIONS: Readonly<Record<AssessmentResultRecord['verdict'], AnswersGateEmission>> = Object.freeze({
  supported: 'assessment-supported', insufficient: 'assessment-insufficient', conflicting: 'assessment-conflicting',
  'off-form': 'assessment-off-form', interrupted: 'assessment-interrupted', 'application-terminated': 'assessment-terminated',
});
// isRef admits extra keys, so every Ref the trace carries is rebuilt from its three identifying fields.
function exactRef(ref: Ref): Ref { return { id: ref.id, revision: ref.revision, hash: ref.hash }; }
function cite(role: AnswersGateSourceRole, ref: Ref): AnswersGateSource { return { role, ref: exactRef(ref) }; }
function offered(ref: Ref | null): AnswersGateSource[] { return ref ? [cite('offered', ref)] : []; }
function violated(checks: readonly (readonly [AnswersGateMismatch, boolean])[]): AnswersGateMismatch[] {
  return checks.filter(([, failed]) => failed).map(([name]) => name);
}
/** The checked H1.0b cessation cause of a terminal, by its kind and exact Refs; its full body stays in the terminal. */
function cessation(cause: CompletionCause): { sources: AnswersGateSource[]; detail: AnswersGateDetail } {
  switch (cause.kind) {
    case 'file-observation': return { sources: [cite('observed-source', cause.source)], detail: { cessation: cause.kind,
      observation: cause.observation.kind === 'read' ? 'read' : cause.observation.code } };
    case 'required-record-replaced': return { sources: [cite('prerequisite', cause.prerequisite.source),
      cite('replacement', cause.replacement), ...(cause.proof ? [cite('replacement-proof', cause.proof)] : [])],
    detail: { cessation: cause.kind, prerequisite: cause.prerequisite.kind } };
    case 'required-absence-ended': return { sources: [cite('appeared', cause.appeared), cite('appeared-graph', cause.graph)],
      detail: { cessation: cause.kind, absence: cause.field } };
    case 'series-admission-change': return { sources: [cite('admission-series', cause.change.series),
      ...(cause.change.pointer ? [cite('admission-pointer', cause.change.pointer)] : []),
      cite('admission-applied', cause.change.applied), cite('admission-current', cause.change.currentPointer)],
    detail: { cessation: cause.kind, condition: cause.condition } };
    // LP4 (№2887): the exact ceased step of the cycle and the exact work it is proved on.
    case 'cycle-step-ceased': return { sources: [cite('ceased-step', cause.cessation), cite('ceased-work', cause.work)],
      detail: { cessation: cause.kind } };
  }
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new GateFailure(result.refusal); return result.value; }
function run<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof GateFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function invalid(field: string): never {
  throw new EngineError('answers_gate_request_invalid', 'G4b requires complete exact source and result addresses',
    { unit: 'G4b', target: 'answers', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function requireRequest(store: Store, value: unknown): asserts value is AnswersGateRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(value) || !text(value.project) || !object(value.gaps) || !object(value.gaps.sources)
    || !Array.isArray(value.gaps.records) || !value.gaps.records.every(isRef) || !isRef(value.routes)
    || Object.keys(value).some(key => !['project', 'gaps', 'routes', 'results'].includes(key))) invalid('request');
  if (!Array.isArray(value.results)) fail('answers_missing', value.project, 'results', 'The result set must be supplied explicitly');
  for (const row of value.results) {
    if (!object(row)) fail('answers_missing', value.project, 'results', 'Every declared result must be an object');
    if (!isRef(row.gap) || !(row.result === null || isRef(row.result))
      || !(row.candidate === null || isRef(row.candidate))
      || Object.hasOwn(row, 'deferral') && (!object(row.deferral) || row.deferral.reason !== 'outside_horizon'
        || row.deferral.until !== 'horizon-entry' || Object.keys(row.deferral).length !== 2)
      || Object.keys(row).some(key => !['gap', 'result', 'candidate', 'deferral'].includes(key))) invalid('results');
  }
}
function normalized(request: AnswersGateRequest): AnswersGateRequest {
  return copy({ ...request, gaps: { ...request.gaps, records: sorted(request.gaps.records) }, results: sorted(request.results) });
}
function idOf(request: AnswersGateRequest): string { return `om-answers-gate:${request.project}:${hashJson(request)}`; }
function sourceRequest(saved: SavedRoutesRequest): RoutesRequest {
  return { ...saved, tasks: saved.tasks.map(record => ({ record })) };
}
function matchPart(store: Store, project: string, ref: Ref) {
  const assembly = take(readPartAssembly(store, { project, record: ref }));
  const first = assembly.record.value.results[0]!;
  const part = take(readPartResult(store, { project, record: first }));
  return { proposal: reference(assembly.proposal), packet: part.record.value.request.packet,
    references: unique([...assembly.references, ...part.references]) as Ref[],
    parts: assembly.record.value.results as Ref[] };
}
function proveInputDecision(store: Store, project: string, ref: Ref): Ref[] {
  const proposal = take(readRecord<InputDecisionProposal>(store, ref,
    { unit: 'G4b', target: ref.id, idPrefix: inputDecisionNamespace(project), kind: 'input-decision' }));
  const previous = take(readOmInput(store, project, proposal.value.input));
  const derived = take(deriveInputDecisions(store, { project,
    previous: previous as Revision<OmInputRecord>, graph: proposal.value.graph, decisions: [ref] }));
  return unique([ref, ...derived.references]);
}
function modelCallKind(store: Store, project: string, ref: Ref): 'ordinary' | 'transport' {
  const record = take(readRecord<{ om?: unknown; transport?: unknown }>(store, ref,
    { unit: 'G4b', target: ref.id, idPrefix: `model-call:${project}:om:`, kind: 'model-call' }));
  const ordinary = object(record.value) && Object.hasOwn(record.value, 'om');
  const transport = object(record.value) && Object.hasOwn(record.value, 'transport');
  if (ordinary === transport) fail('model_call_record_invalid', ref.id, 'contract',
    'A model call must have exactly one E4 producer contract', ref);
  return ordinary ? 'ordinary' : 'transport';
}
/** Reprove recognizable offered records before classifying a wrong variant; never accept them on shape alone. */
function proveOfferedRecord(store: Store, project: string, ref: Ref): boolean {
  if (ref.id.startsWith('om-answer:')) take(readAcceptedAnswer(store, { project, record: ref }));
  else if (ref.id.startsWith('om-part-result:')) take(readPartResult(store, { project, record: ref }));
  else if (ref.id.startsWith('om-part-assembly:')) take(readPartAssembly(store, { project, record: ref }));
  else if (ref.id.startsWith('om-assessment-result:')) take(readAssessmentTerminalAt(store, project, ref));
  else if (ref.id.startsWith('model-call:')) {
    if (modelCallKind(store, project, ref) === 'ordinary') take(readModelCallState(store, { project, record: ref }));
    else take(readModelTransport(store, { project, record: ref }));
  }
  else if (ref.id.startsWith('om-routes:')) take(readRoutes(store, { project, record: ref }));
  else if (ref.id.startsWith('om-input-decision:')) proveInputDecision(store, project, ref);
  else if (ref.id.startsWith('om-owner-result:')) take(readRecord(store, ref,
    { unit: 'G4b', target: ref.id, idPrefix: `om-owner-result:${project}:`, kind: 'om-owner-result' }));
  else return false;
  return true;
}
function negativeFact(store: Store, request: AnswersGateRequest, row: AnswerRouteResult, route: RoutedGap,
  gap: Gap, current: boolean, guards: TransactionGuard[], references: Ref[], writes: Write[], traced: Traced): AnswersGateTraceEntry {
  const ref = row.result!, project = request.project;
  if (ref.id.startsWith('model-call:') && modelCallKind(store, project, ref) === 'ordinary') {
    const state = take(readModelCallState(store, { project, record: ref }));
    if (state.state === 'running' || state.state === 'received' || state.state === 'recovered')
      return traced('mc1-unfinished', finding('route_result_missing', gap.target, 'result',
        'An unfinished MC1 call is not an answer', ref), [cite('model-call', ref)], { state: state.state });
    const outcome = state.outcome;
    const call = take(readCall(store, project, outcome.call));
    const packet = take(readQuestionPacket(store, { project, record: outcome.packet }));
    const exchange = [cite('model-call', ref), cite('call', outcome.call), cite('packet', outcome.packet),
      cite('packet-routes', packet.value.request.routes)];
    const sourceRoutes = take(readRoutes(store, { project, record: packet.value.request.routes }));
    const currentRoutes = take(readRoutes(store, { project, record: request.routes }));
    const sourceBatch = sourceRoutes.record.value.batches.find(item => item.id === packet.value.request.batch);
    const currentBatch = currentRoutes.record.value.batches.find(item => item.id === packet.value.request.batch);
    if (call.value.purpose !== 'model-research' || call.value.basis !== null || !sourceBatch || !currentBatch
      || sourceBatch.model !== 'MC1' || sourceBatch.task !== 'fact' || !same(sourceBatch, currentBatch)
      || !sourceBatch.items.some(item => item.gap === gap.id && same(item.record, row.gap)
        && same(item.task, route.task)) || !route.task)
      return traced('mc1-foreign-task', finding('answer_version_stale', gap.target, 'result',
        'The ordinary MC1 result must belong to this exact current M6 fact task', ref), exchange,
      { purpose: call.value.purpose, mismatch: violated([['call-purpose', call.value.purpose !== 'model-research'],
        ['call-basis', call.value.basis !== null], ['source-batch-absent', !sourceBatch],
        ['current-batch-absent', !currentBatch], ['batch-model', !!sourceBatch && sourceBatch.model !== 'MC1'],
        ['batch-task', !!sourceBatch && sourceBatch.task !== 'fact'],
        ['batch-changed', !!sourceBatch && !!currentBatch && !same(sourceBatch, currentBatch)],
        ['item-absent', !!sourceBatch && !sourceBatch.items.some(item => item.gap === gap.id && same(item.record, row.gap)
          && same(item.task, route.task))], ['route-task-absent', !route.task]]) });
    const task = take(readAnswerTaskBasis(store, { project, task: { record: route.task }, current }));
    if (task.gap.target !== gap.target || task.gap.field !== gap.field)
      return traced('mc1-task-foreign-gap', finding('answer_version_stale', gap.target, 'result',
        'The MC1 fact task addresses another gap', ref), exchange);
    guards.push(...task.guards, ...(current ? [ref] : []));
    references.push(ref, outcome.call, outcome.packet, packet.value.request.routes, ...task.references);
    writes.push(...task.writes);
    const substantive = outcome.outcome?.kind === 'fact-candidates';
    return traced(substantive ? 'mc1-fact-candidates' : 'mc1-technical',
      finding(substantive ? 'route_result_missing' : 'answer_missing_for_blocking_gap',
        gap.target, 'result', substantive
          ? 'A substantive MC1 result needs its separately accepted D5 answer'
          : 'A checked technical MC1 result does not accept a D5 fact', ref),
      [...exchange, ...(outcome.response ? [cite('response', outcome.response)] : []),
        ...(outcome.diagnostic ? [cite('diagnostic', outcome.diagnostic)] : [])],
      { state: state.state, outcome: outcome.outcome?.kind ?? null });
  }
  let questionRef: Ref, supported = false, managedTransport = false, legacyTransport = false;
  let verdict: AssessmentResultRecord['verdict'] | null = null, ceased: ReturnType<typeof cessation> | null = null;
  const chain: AnswersGateSource[] = [];
  if (ref.id.startsWith('om-assessment-result:')) {
    const terminal = take(readAssessmentTerminalAt(store, project, ref));
    const intent = take(readAssessmentIntentAt(store, project, terminal.value.intent));
    questionRef = intent.question.record;
    supported = terminal.value.verdict === 'supported';
    verdict = terminal.value.verdict;
    references.push(ref, terminal.value.intent, intent.question.record);
    chain.push(cite('terminal', ref), cite('intent', terminal.value.intent));
    if (terminal.value.accepted) chain.push(cite('accepted', terminal.value.accepted));
    if (terminal.value.verdict === 'application-terminated') {
      ceased = cessation(terminal.value.cause);
      chain.push(cite('binding', terminal.value.binding), cite('assignment', terminal.value.assignment),
        cite('work', terminal.value.work), cite('call', terminal.value.call), cite('receipt', terminal.value.receipt),
        ...ceased.sources);
    }
  } else {
    const transport = take(readModelTransport(store, { project, record: ref }));
    const call = take(readCall(store, project, transport.call));
    const basis = call.value.basis;
    chain.push(cite('transport', ref), cite('call', transport.call));
    if (call.value.purpose !== 'fact-assessment' || !basis || basis.kind !== 'fact-assessment')
      return traced('transport-foreign', finding('record_foreign', gap.target, 'result',
        'This transport is not a fact assessment', ref), chain, { purpose: call.value.purpose,
        mismatch: violated([['call-purpose', call.value.purpose !== 'fact-assessment'],
          ['call-basis', !basis || basis.kind !== 'fact-assessment']]) });
    if (basis.assessment) {
      const intent = take(readAssessmentIntentAt(store, project, basis.assessment));
      questionRef = intent.question.record;
      managedTransport = true;
      references.push(basis.assessment);
      chain.push(cite('intent', basis.assessment));
    } else {
      const origin = take(readFactAssessmentOrigin(store, project, basis, ref.id));
      questionRef = basis.question;
      legacyTransport = true;
      if (!origin.gaps.some(address => address.id === gap.target && address.field === gap.field))
        return traced('legacy-question-foreign', finding('answer_version_stale', gap.target, 'result',
          'The assessed fact belongs to another question', ref), [...chain, cite('model-call', basis.modelCall),
          cite('packet', basis.packet), cite('response', basis.response), cite('question', basis.question)]);
    }
    references.push(ref, transport.call, basis.modelCall, basis.packet, basis.response, basis.question);
    chain.push(cite('model-call', basis.modelCall), cite('packet', basis.packet), cite('response', basis.response));
  }
  chain.push(cite('question', questionRef));
  const question = take(readMc1Question(store, { project, record: questionRef }));
  if (!route.task || !same(question.record.value.request.gap, row.gap)
    || (question.record.value.request.task === undefined ? !legacyTransport
      : !same(question.record.value.request.task, route.task))
    || question.gap.target !== gap.target || question.gap.field !== gap.field)
    return traced('assessment-question-foreign', finding('answer_version_stale', gap.target, 'result',
      'The assessed fact does not belong to the exact current M6 question', ref), chain, { mismatch: violated([
      ['route-task-absent', !route.task], ['question-gap', !same(question.record.value.request.gap, row.gap)],
      ['question-task', question.record.value.request.task === undefined ? !legacyTransport
        : !same(question.record.value.request.task, route.task)],
      ['question-address', question.gap.target !== gap.target || question.gap.field !== gap.field]]) });
  const task = take(readAnswerTaskBasis(store, { project, task: { record: route.task }, current }));
  if (task.gap.target !== gap.target || task.gap.field !== gap.field || !same(task.contract, question.record.value.request.contract))
    return traced('assessment-task-foreign', finding('answer_version_stale', gap.target, 'result',
      'The assessed question differs from the exact current D5 task', ref), chain, { mismatch: violated([
      ['task-address', task.gap.target !== gap.target || task.gap.field !== gap.field],
      ['task-contract', !same(task.contract, question.record.value.request.contract)]]) });
  guards.push(...task.guards);
  if (current && ref.id.startsWith('om-assessment-result:')) guards.push(ref);
  references.push(...task.references, questionRef);
  writes.push(...task.writes);
  if (supported) return traced('assessment-supported', finding('route_result_missing', gap.target, 'result',
    'A supported assessment is not its accepted D5 answer', ref), chain, { verdict: 'supported' });
  if (managedTransport) return traced('assessment-transport-managed', finding('route_result_missing', gap.target, 'result',
    'A managed assessor transport is not its checked E5 terminal result', ref), chain);
  const negative = finding('answer_missing_for_blocking_gap', gap.target, 'result',
    'A checked negative or technical assessment does not accept a D5 fact', ref);
  if (verdict === null) return traced('assessment-legacy-transport', negative, chain);
  return traced(TERMINAL_EMISSIONS[verdict], negative, chain, { verdict, ...ceased?.detail });
}
function proveResult(store: Store, request: AnswersGateRequest, row: AnswerRouteResult, route: RoutedGap,
  gap: Gap, current: boolean, guards: TransactionGuard[], references: Ref[], writes: Write[], traced: Traced): AnswersGateTraceEntry | null {
  const target = gap.target, producer = answerProducerOf(gap);
  // OWN1 (№3713): the bypass routes an owner question to the model, yet an owner's own H2 result offered for it is still
  // proved and admitted on any route — it is never replaced by the model's decision.
  if (route.route === 'owner' || !producer.present && producer.code === 'owner_result_unavailable'
    || gap.kind === 'owner-decision' && row.result !== null && row.result.id.startsWith(ownerResultNamespace(request.project))) {
    const recognized = row.result ? proveOfferedRecord(store, request.project, row.result) : null;
    // H2.0: an offered om-owner-result is proved by the common reader, and admitted only when its om-owner-question/v1
    // binds this exact gap record, this exact M6 routes Ref and this exact B1 input — a valid result of another
    // question or route version is foreign here, and a forged or unreadable record is no result at all.
    if (row.result) {
      const proved = readOwnerResult(store, { project: request.project, record: row.result }, OWNER_READERS);
      if (proved.ok) {
        const question = proved.value.question;
        if (same(question.gap, route.record) && same(question.routes, request.routes)
          && same(question.input, request.gaps.sources.input) && question.route.gap === gap.id
          && question.route.target === gap.target && question.route.field === gap.field) {
          if (current) guards.push(row.result);
          references.push(row.result, reference(proved.value.command));
          return traced('owner-answered', finding('owner_result_answered', target, OWNER_ABSENT.field,
            'The owner answered this gap through the separately authenticated H2 producer', row.result),
            [cite('answer', row.result), cite('receipt', reference(proved.value.command))]);
        }
        return traced('owner-offered', finding('owner_result_foreign', target, OWNER_ABSENT.field,
          'This owner result answers another question', row.result), offered(row.result), { recognized: true });
      }
    }
    return traced('owner-offered', finding(OWNER_ABSENT.code, target, OWNER_ABSENT.field, OWNER_ABSENT.message, row.result ?? row.gap),
      offered(row.result), recognized === null ? {} : { recognized });
  }
  if (!producer.present) {
    const recognized = row.result ? proveOfferedRecord(store, request.project, row.result) : null;
    return traced('unsupported-offered', finding(producer.code, target, producer.field, producer.message, row.gap),
      offered(row.result), recognized === null ? {} : { recognized });
  }
  if (row.result === null) return traced('blocking-null', finding('answer_missing_for_blocking_gap', target, 'result',
    'A blocking gap needs an exact result', row.gap));
  if (!routeAllowed(gap, route.route)) return traced('result-route-disallowed', finding('answer_route_foreign', target,
    'route', 'The D1 knowledge kind does not allow this route'), offered(row.result), { allowed: [...gap.routes] });
  if (gap.kind === 'repository-fact' && (route.route === 'code' || route.route === 'research')
    && (row.result.id.startsWith('om-assessment-result:') || row.result.id.startsWith('model-call:'))) {
    if (row.candidate !== null) return traced('fact-candidate', finding('answer_route_foreign', target, 'candidate',
      'A fact result has no layer candidate', row.candidate), [cite('offered', row.result), cite('candidate', row.candidate)]);
    return negativeFact(store, request, row, route, gap, current, guards, references, writes, traced);
  }
  if (row.result.id.startsWith('om-answer:') && !row.result.id.startsWith(`om-answer:${request.project}:`)) {
    take(readAcceptedAnswer(store, { project: request.project, record: row.result }));
    return traced('answer-foreign-project', finding('record_foreign', target, 'result',
      'A foreign accepted answer cannot cover this gap', row.result), [cite('answer', row.result)]);
  }
  if (row.result.id.startsWith(`om-answer:${request.project}:`)) {
    take(readAcceptedAnswer(store, { project: request.project, record: row.result }));
    const answer = [cite('answer', row.result)];
    if (gap.kind !== 'repository-fact' || !route.task)
      return traced('answer-without-fact-task', finding('answer_route_foreign', target, 'result',
        'An accepted fact needs the exact M6 question task', row.result), answer,
      { mismatch: violated([['gap-kind', gap.kind !== 'repository-fact'], ['route-task-absent', !route.task]]) });
    const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
    const search = routes.record.value.searches.find(item => item.gap === gap.id);
    if (!search) return traced('answer-search-missing', finding('route_result_missing', target, 'search',
      'The fact route lacks its complete answer search'), answer);
    const searched = [...answer, cite('search-index', search.index)];
    const check = search.checks.find(item => same(item.answer, row.result));
    if (!check) return traced('answer-outside-search', finding('answer_version_stale', target, 'search',
      'The exact answer is absent from the saved full search', row.result), searched);
    const checked = take(applicableAnswerTask(store, { project: request.project, record: row.result,
      task: { record: route.task }, current,
      ...(!current ? { invalidation: copy<AnswerInvalidation | null>(check!.invalidation as AnswerInvalidation | null) } : {}) }));
    guards.push(...checked.guards, ...(current ? [row.result] : []));
    references.push(...checked.references, row.result);
    writes.push(...checked.writes);
    if (!checked.applicable) return traced('answer-inapplicable', finding('answer_version_stale', target, 'answer',
      'The saved answer no longer applies to this exact question', row.result), searched);
    if (route.route !== 'code' || !route.answer || !check)
      return traced(route.route !== 'code' ? 'answer-route-not-code' : 'answer-unselected',
        finding('answer_route_foreign', target, 'result',
          'An applicable D5 answer must occur in the complete current M6 search', row.result), searched);
    if (row.candidate !== null) return traced('answer-candidate', finding('answer_route_foreign', target, 'candidate',
      'A fact result does not carry a layer candidate'), [...searched, cite('candidate', row.candidate)]);
    return null;
  }
  if (row.result.id.startsWith('om-input-decision:')) {
    references.push(...proveInputDecision(store, request.project, row.result));
    if (current) guards.push(row.result);
    const unapplied = gap.origins.includes('input') || gap.code === 'question_unaddressed';
    return traced(unapplied ? 'decision-unapplied' : 'decision-foreign',
      finding(unapplied ? 'answer_missing_for_blocking_gap' : 'answer_route_foreign', target, 'result',
        'A D3 decision changes the next B1/D1 derivation; it does not cover an existing gap', row.result),
      [cite('decision', row.result)]);
  }
  if (route.route !== 'design' || gap.kind !== 'design-decision' || gap.code !== 'obligation_open') {
    const known = proveOfferedRecord(store, request.project, row.result);
    return traced(known ? 'offered-known-foreign' : 'offered-unrecognized',
      finding(known ? 'answer_route_foreign' : 'route_result_unsupported', target, 'result',
        'Only a checked producer result can satisfy this route', row.result), offered(row.result));
  }
  if (row.result.id.startsWith(`om-part-result:${request.project}:`)) {
    take(readPartResult(store, { project: request.project, record: row.result }));
    return traced('part-not-assembly', finding('route_result_missing', target, 'assembly',
      'A part is not proof of the complete MC2 node', row.result), [cite('part', row.result)]);
  }
  if (row.result.id.startsWith(`om-model-cycle:${request.project}:`))
    return mc2Terminal(store, request, row, gap, current, guards, references, traced);
  if (row.result.id.startsWith(`${COMPLETION_REUSE_KIND}:${request.project}:`))
    return reusedResult(store, request, row, gap, current, guards, references, traced);
  if (!row.result.id.startsWith(`om-part-assembly:${request.project}:`)) {
    const known = proveOfferedRecord(store, request.project, row.result);
    return traced(known ? 'design-known-foreign' : 'design-unrecognized', finding(known ? 'record_foreign' : 'route_result_unsupported',
      target, 'result', 'A design result needs a checked complete MC2 assembly', row.result), offered(row.result));
  }
  const part = matchPart(store, request.project, row.result);
  const assembled = [cite('assembly', row.result), cite('proposal', part.proposal), cite('packet', part.packet),
    ...part.parts.map(record => cite('part', record))];
  const packet = take(readQuestionPacket(store, { project: request.project, record: part.packet }));
  const routeRecord = take(readRoutes(store, { project: request.project, record: request.routes }));
  const batch = routeRecord.record.value.batches.find(item => item.id === packet.value.request.batch);
  const assigned = part.parts.flatMap(record => {
    const checked = take(readPartResult(store, { project: request.project, record }));
    const source = take(readQuestionPacket(store, { project: request.project, record: checked.record.value.request.packet }));
    if (!object(source.value.packet) || !Array.isArray(source.value.packet.questions))
      fail('route_result_missing', source.id, 'questions', 'An MC2 result needs its exact assigned questions');
    return source.value.packet.questions.map(question => object(question) && text(question.id) ? question.id : '');
  });
  const assignedRoutes = take(readRoutes(store, { project: request.project, record: packet.value.request.routes }));
  const assignedBatch = assignedRoutes.record.value.batches.find(item => item.id === packet.value.request.batch);
  if (!batch || !assignedBatch || !same(assignedBatch, batch) || batch.task !== 'node-expansion'
    || !assigned.includes(gap.id)
    || !batch.items.some(item => item.gap === gap.id && same(item.record, row.gap)))
    return traced('assembly-assignment-foreign', finding('answer_route_foreign', target, 'packet',
      'The MC2 assignment must include this exact routed gap', part.packet),
    [...assembled, cite('packet-routes', packet.value.request.routes)], { mismatch: violated([
      ['current-batch-absent', !batch], ['source-batch-absent', !assignedBatch],
      ['batch-changed', !!batch && !!assignedBatch && !same(assignedBatch, batch)],
      ['batch-task', !!batch && batch.task !== 'node-expansion'], ['gap-unassigned', !assigned.includes(gap.id)],
      ['item-absent', !!batch && !batch.items.some(item => item.gap === gap.id && same(item.record, row.gap))]]) });
  references.push(row.result, part.proposal, part.packet, ...part.references);
  if (current) guards.push(row.result, part.proposal, part.packet);
  if (batch.level === 2) {
    if (!row.candidate) return traced('candidate-absent', finding('delta_not_verified', target, 'candidate',
      'An operation proposal needs the exact G3 candidate'), assembled, { level: 2 });
    const candidate = take(readCandidate(store, { project: request.project, candidate: row.candidate }));
    const gate = take(gateCandidate(store, { project: request.project, candidate: row.candidate }));
    if (!gate.passed) return traced('candidate-gate-negative', finding('delta_not_verified', gate.findings[0]?.target ?? target,
      gate.findings[0]?.field ?? 'candidate', gate.findings[0]?.message ?? 'G3 did not verify the candidate', row.candidate),
    [...assembled, cite('candidate', row.candidate)], { level: 2 });
    if (gate.graphHash !== candidate.value.graphHash || candidate.value.level !== 2
      || !candidate.value.request.proposals.some(ref => same(ref, part.proposal)))
      return traced('candidate-stale', finding('delta_stale', target, 'candidate',
        'G3 must verify the candidate carrying this exact operation proposal', row.candidate),
      [...assembled, cite('candidate', row.candidate)], { level: 2, mismatch: violated([
        ['graph-hash', gate.graphHash !== candidate.value.graphHash], ['level', candidate.value.level !== 2],
        ['proposal', !candidate.value.request.proposals.some(ref => same(ref, part.proposal))]]) });
    const source = request.gaps.sources.operations;
    if (current) {
      const prepared = take(prepareCandidate(store, copy<CandidateRequest>({
        ...candidate.value.request, frame: source.frame,
      } as CandidateRequest)));
      if (prepared.state !== 'candidate' || prepared.writes.length || !prepared.existing
        || !same(reference(prepared.existing), row.candidate))
        fail('input_stale', target, 'candidate', 'The G3 candidate is not admitted by the current frame', row.candidate);
      guards.push(...prepared.guards, row.candidate);
    }
    references.push(row.candidate);
  } else if (batch.level === 3) {
    if (row.candidate !== null) return traced('works-candidate', finding('answer_route_foreign', target, 'candidate',
      'Works are admitted to assembly before G5 acceptance'), [...assembled, cite('candidate', row.candidate)], { level: 3 });
    const works = request.gaps.sources.works;
    if (!('frame' in works)) return traced('works-frame-unavailable', finding('route_result_missing', target, 'works',
      'The exact works frame is unavailable', row.result), assembled, { level: 3 });
    const proof = { frame: works.frame, proposals: unique([...works.proposals, part.proposal]) };
    const derived = take(readFrameProposals(store, proof));
    const open = derived.result.open.some(item => item.id === target);
    if (open || !derived.result.fills.some(fill => fill.obligation === target && fill.source === 'proposed'
        && same(fill.basis, part.proposal)))
      return traced(open ? 'works-obligation-open' : 'works-obligation-filled-elsewhere',
        finding('route_result_missing', target, 'proposal',
          'The complete MC2 proposal does not fill the exact works obligation', row.result), assembled, { level: 3 });
    references.push(...derived.references);
    if (current) {
      const prepared = take(prepareFrameProposals(store, proof));
      if (!same(prepared.result, derived.result)) fail('input_stale', target,
        'works', 'The works proposal changed before current admission', row.result);
      guards.push(...prepared.guards);
      references.push(...prepared.references);
    }
  } else return traced('batch-level-foreign', finding('answer_route_foreign', target, 'batch',
    'A node proposal needs a level-two or level-three MC2 batch'), assembled, { level: batch.level });
  return null;
}
/**
 * LP5 (№3278 §3): a reuse answers an L3 obligation of a later attempt. The reuse, read by its common reader, names this
 * exact current batch and routed gap, and its origin proposal fills the obligation in the current works frame — admitted
 * today for a current check. The old assembly is never a result of the new attempt by itself.
 */
function reusedResult(store: Store, request: AnswersGateRequest, row: AnswerRouteResult, gap: Gap, current: boolean,
  guards: TransactionGuard[], references: Ref[], traced: Traced): AnswersGateTraceEntry | null {
  const target = gap.target, ref = row.result!;
  const read = take(readReuseResult(store, { project: request.project, record: ref })), reuse = read.record.value;
  const cited = [cite('reuse', ref), cite('assembly', reuse.origin.assembly), cite('proposal', reuse.origin.proposal)];
  const batch = take(readRoutes(store, { project: request.project, record: request.routes })).record.value.batches.find(item => item.id === reuse.batch);
  const own = take(readRoutes(store, { project: request.project, record: reuse.routes })).record.value.batches.find(item => item.id === reuse.batch);
  if (!batch || !own || !same(own, batch) || batch.task !== 'node-expansion' || batch.level !== 3
    || !batch.items.some(item => item.gap === gap.id && same(item.record, row.gap)))
    return traced('assembly-assignment-foreign', finding('answer_route_foreign', target, 'reuse',
      'The reuse must answer this exact routed gap of the current batch', ref), [...cited, cite('packet-routes', reuse.routes)], { mismatch: violated([
      ['current-batch-absent', !batch], ['source-batch-absent', !own], ['batch-changed', !!batch && !!own && !same(own, batch)],
      ['batch-task', !!batch && (batch.task !== 'node-expansion' || batch.level !== 3)],
      ['item-absent', !!batch && !batch.items.some(item => item.gap === gap.id && same(item.record, row.gap))]]) });
  if (row.candidate !== null) return traced('works-candidate', finding('answer_route_foreign', target, 'candidate',
    'Works are admitted to assembly before G5 acceptance'), [...cited, cite('candidate', row.candidate)], { level: 3 });
  const works = request.gaps.sources.works;
  if (!('frame' in works)) return traced('works-frame-unavailable', finding('route_result_missing', target, 'works',
    'The exact works frame is unavailable', ref), cited, { level: 3 });
  const proof = { frame: works.frame, proposals: unique([...works.proposals, reuse.origin.proposal]) };
  const derived = take(readFrameProposals(store, proof));
  const open = derived.result.open.some(item => item.id === target);
  if (open || !derived.result.fills.some(fill => fill.obligation === target && fill.source === 'proposed' && same(fill.basis, reuse.origin.proposal)))
    return traced(open ? 'works-obligation-open' : 'works-obligation-filled-elsewhere', finding('route_result_missing', target, 'proposal',
      'The reused complete proposal does not fill the exact works obligation', ref), cited, { level: 3 });
  references.push(ref, ...read.references, ...derived.references);
  if (current) {
    const prepared = take(prepareFrameProposals(store, proof));
    if (!same(prepared.result, derived.result)) fail('input_stale', target, 'works', 'The works proposal changed before current admission', ref);
    guards.push(ref, ...prepared.guards);
    references.push(...prepared.references);
  }
  return null;
}
/**
 * №1770: the negative outcome of an MC2 node root — a completed cycle without assembly (cannot_answer, research without
 * progress, a blocked successor, invalid parts), whose final diagnostic the cycle itself proves. It never fills the gap:
 * the full G4b keeps a negative finding and no C5 is admitted. The exact root belongs to the checked gap by the same
 * rules as a positive assembly (the exact current and source batch, the gap assigned to one of its packets), and to the
 * attempt that opened it (its binding and that binding's own E4 diagnostic).
 */
function mc2Terminal(store: Store, request: AnswersGateRequest, row: AnswerRouteResult, gap: Gap, current: boolean,
  guards: TransactionGuard[], references: Ref[], traced: Traced): AnswersGateTraceEntry {
  const project = request.project, ref = row.result!, target = gap.target;
  const cycle = take(readModelCycle(store, { project, record: ref })).record.value;
  const packet = take(readQuestionPacket(store, { project, record: cycle.request.packet }));
  const sources = [cite('cycle', ref), cite('packet', cycle.request.packet), ...cycle.steps.map(step => cite('model-call', step.record)),
    ...(cycle.diagnostic ? [cite('diagnostic', cycle.diagnostic)] : []), cite('packet-routes', packet.value.request.routes)];
  const routeRecord = take(readRoutes(store, { project, record: request.routes }));
  const batch = routeRecord.record.value.batches.find(item => item.id === packet.value.request.batch);
  const sourceRoutes = take(readRoutes(store, { project, record: packet.value.request.routes }));
  const sourceBatch = sourceRoutes.record.value.batches.find(item => item.id === packet.value.request.batch);
  const assigned = cycle.steps.flatMap(step => {
    const source = take(readQuestionPacket(store, { project, record: step.packet }));
    if (!object(source.value.packet) || !Array.isArray(source.value.packet.questions))
      fail('route_result_missing', source.id, 'questions', 'An MC2 result needs its exact assigned questions');
    return source.value.packet.questions.map(question => object(question) && text(question.id) ? question.id : '');
  });
  const attempt = packet.value.request.attempt;
  const binding = attempt ? take(readCompletionBinding(store, project, attempt.series, attempt.ordinal)) : null;
  const terminal = cycle.terminal !== 'assembled' && cycle.diagnostic !== null;
  const mismatch = violated([['cycle-candidate', row.candidate !== null], ['cycle-terminal', !terminal],
    ['current-batch-absent', !batch], ['source-batch-absent', !sourceBatch],
    ['batch-changed', !!batch && !!sourceBatch && !same(batch, sourceBatch)],
    ['batch-task', !!batch && batch.task !== 'node-expansion'], ['gap-unassigned', !assigned.includes(gap.id)],
    ['item-absent', !!batch && !batch.items.some(item => item.gap === gap.id && same(item.record, row.gap))],
    ['cycle-binding', !binding]]);
  if (mismatch.length) return traced('mc2-terminal-foreign', finding('record_foreign', target, 'result',
    'Only the proved terminal of the exact MC2 root of this routed gap stands for it', ref), sources,
  { state: cycle.terminal, mismatch, level: batch?.level ?? null });
  // The final diagnostic is the one its binding's own E4 producer derives; its reason is E4's, not G4b's.
  const diagnostic = take(readManagedModelDiagnostic(store, binding! as Revision<CompletionOwner>, cycle.diagnostic!));
  references.push(ref, cycle.request.packet, cycle.diagnostic!, packet.value.request.routes, ...cycle.steps.map(step => step.record));
  if (current) guards.push(ref);
  return traced('mc2-terminal', finding('answer_missing_for_blocking_gap', target, 'result',
    'A proved MC2 terminal without assembly does not fill this gap', ref), sources,
  { state: cycle.terminal, outcome: diagnostic.reason, level: batch!.level });
}
/**
 * H2.0 (№2719-4): current-mode admission of owner results. The om-owner-result:<project>: namespace is scanned by
 * identity (Q4 metadata, no body decode); every candidate is proved by the common reader (re-derivation, not its own
 * claim), and a proved result is attached as the exact result row of the gap its om-owner-question/v1 binds — same gap
 * record, same routes version, same B1 input. A result that binds no gap of this request's exact D1/M6 answers nothing
 * here; a record the reader refuses answers nothing anywhere. Historical derivations never scan: the admitted rows are
 * part of the saved request itself, so an old gate re-derives unchanged even after later results appear.
 */
function admitOwnerResults(store: Store, request: AnswersGateRequest): AnswersGateRequest {
  const declared = new Map(request.gaps.records.map(record => [record.id, record]));
  const offered = new Set(request.results.map(row => row.gap.id));
  const additions: AnswerRouteResult[] = [];
  // list() over the kind — never identities(): the gate runs under store views whose declared read surface is
  // get/list/history (om-commands drives through them), and a scan is a body read anyway. OWN1: the one scan and proof
  // the pass also reads the owner's answers by (ownerAnswersOf).
  for (const answer of ownerAnswersOf(store, request.project, request.routes, request.gaps.sources.input, OWNER_READERS)) {
    const gap = answer.gap;
    if (!declared.has(gap.id) || !same(declared.get(gap.id), gap) || offered.has(gap.id)) continue;
    additions.push({ gap: exactRef(gap), result: answer.result, candidate: null });
  }
  if (additions.length === 0) return request;
  return normalized({ ...request, results: [...request.results, ...additions] });
}
function derive(store: Store, request: AnswersGateRequest, current: boolean): DerivedAnswersGate {
  requireRequest(store, request); request = normalized(request);
  if (current) request = admitOwnerResults(store, request);
  const gaps = take(readGaps(store, request.gaps));
  if (gaps.sources.project !== request.project) fail('gap_source_missing', request.project, 'gaps', 'G4b needs this project\'s complete exact D1 set');
  if (!gaps.gate.passed) fail('gap_source_missing', request.project, 'gaps', 'The D1 source has not passed its complete derivation gate');
  const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
  if (!same(routes.record.value.request.gaps.sources, gaps.sources)
    || !same(sorted(routes.record.value.request.gaps.records), sorted(request.gaps.records)))
    fail('input_stale', request.project, 'routes', 'The M6 route must use this exact complete D1 version', request.routes);
  const guards: TransactionGuard[] = [], writes: Write[] = [],
    references: Ref[] = [request.routes, request.gaps.sources.input, ...request.gaps.records, ...routes.references];
  if (current) {
    const preparedGaps = take(prepareCurrentGaps(store, request.gaps));
    const preparedRoutes = take(prepareRoutes(store, sourceRequest(copy<SavedRoutesRequest>(routes.record.value.request as SavedRoutesRequest))));
    if (!same(reference(preparedRoutes.record), request.routes))
      fail('input_stale', request.routes.id, 'routes', 'The saved M6 route is not the complete current derivation', request.routes);
    guards.push(...preparedGaps.guards, ...preparedRoutes.guards, request.routes, request.gaps.sources.input,
      ...request.gaps.records);
    references.push(...preparedGaps.references, ...preparedRoutes.references);
    writes.push(...preparedRoutes.writes);
  }
  // The trace is built by the very branches that emit, from reads both modes perform; guards and writes stay out of it.
  const emitted: AnswersGateTraceEntry[] = [], grouped = new Map<string, AnswerRouteResult[]>();
  const emit = (emission: AnswersGateEmission, found: Refusal, gap: Ref | null, occurrences: AnswerRouteResult[],
    route: AnswersGateRouteTrace | null, sources: AnswersGateSource[] = [], detail: AnswersGateDetail = {}) => {
    emitted.push({ finding: found, cause: { emission, gap, occurrences, route, sources, detail } });
  };
  const all = new Map(gaps.records.map(record => [record.id, record]));
  for (const row of request.results) {
    const saved = all.get(row.gap.id);
    if (saved && saved.revision === row.gap.revision && saved.hash !== row.gap.hash)
      fail('record_forged', row.gap.id, 'gap.hash', 'The declared gap has a false exact content hash', row.gap);
    if (saved && !same(reference(saved), row.gap)) {
      // The same revision and hash differ from the saved Ref only by extra keys: an inexact Ref, not a stale revision.
      emit(saved.revision === row.gap.revision ? 'gap-ref-inexact' : 'gap-revision-stale', finding('answer_version_stale',
        saved.value.gap.target, 'gap', 'The result names another revision of this D1 gap', row.gap), reference(saved), [row], null);
    }
    if (!saved) {
      emit('gap-unknown', finding('answer_gap_unknown', row.gap.id, 'gap', 'The result is outside this exact complete D1 set',
        row.gap), null, [row], null);
      continue;
    }
    grouped.set(row.gap.id, [...(grouped.get(row.gap.id) ?? []), row]);
  }
  for (const saved of gaps.records) {
    const gap = saved.value.gap, exact = reference(saved);
    const rows = grouped.get(saved.id) ?? [];
    const route = routes.record.value.routes.find(item => item.gap === gap.id && same(item.record, exact));
    if (!route) {
      emit('gap-unrouted', finding('answer_route_foreign', gap.target, 'route', 'The M6 route does not name this exact gap',
        exact), exact, [], null);
      continue;
    }
    const trail: AnswersGateRouteTrace = { routes: exactRef(request.routes), route: route.route,
      task: route.task ? exactRef(route.task) : null };
    for (const offered of rows) {
      const declared = Object.hasOwn(offered, 'deferral'), inherited = gap.blocking && gap.deferral !== undefined;
      const deferred = declared || inherited;
      if (deferred && gap.blocking) emit(declared ? 'deferral-declared' : 'deferral-inherited',
        finding('deferral_not_permitted', gap.target, 'blocking', 'A blocking gap cannot be deferred by its result', offered.gap),
        exact, [offered], trail, [], { declared, inherited });
    }
    if (rows.length > 1) {
      emit('duplicate', finding('answer_duplicate', gap.target, 'gap', 'A gap has more than one proposed result', exact),
        exact, rows, trail);
      continue;
    }
    const row = rows[0];
    if (!row) {
      if (!gap.blocking) continue;
      const producer = answerProducerOf(gap);
      if (!producer.present) emit(producer.code === 'owner_result_unavailable' ? 'owner-absent' : 'unsupported-absent',
        finding(producer.code, gap.target, producer.field, producer.message, exact), exact, [], trail);
      else emit('blocking-absent', finding('answer_missing_for_blocking_gap', gap.target, 'result',
        'Every blocking D1 gap needs one result', exact), exact, [], trail);
      continue;
    }
    if (!same(row.gap, exact)) continue;
    if (!routeAllowed(gap, route.route)) emit('route-disallowed', finding('answer_route_foreign', gap.target,
      'route', 'The D1 knowledge kind does not allow this route', row.gap), exact, [row], trail, [], { allowed: [...gap.routes] });
    const deferred = Object.hasOwn(row, 'deferral') || gap.blocking && gap.deferral !== undefined;
    if (row.result === null && row.candidate !== null) {
      emit('candidate-without-result', finding('route_result_missing', gap.target, 'result',
        'A candidate without its complete result cannot cover a gap', row.candidate), exact, [row], trail,
      [cite('candidate', row.candidate)]);
      continue;
    }
    if (row.result === null && !gap.blocking) continue;
    if (row.result === null && deferred) continue;
    const traced: Traced = (emission, found, sources = [], detail = {}) =>
      ({ finding: found, cause: { emission, gap: exact, occurrences: [row], route: trail, sources, detail } });
    const issue = proveResult(store, request, row, route as RoutedGap, gap as Gap, current, guards, references, writes, traced);
    if (issue) emitted.push(issue);
  }
  // Ties in the finding keep the v1 order (they are equal findings); the cause only makes the trace order total.
  const trace = [...emitted].sort((a, b) => order(canonical(a.finding), canonical(b.finding))
    || order(canonical(a.cause), canonical(b.cause)));
  // H2.0: a positive emission (owner-answered) is proof of acceptance, not a refusal — it stays in the trace but
  // never counts as a finding, so a fully answered gate passes.
  const findings = trace.filter(item => !isPositive(item)).map(item => item.finding);
  const outcome: AnswersGateOutcome = { passed: findings.length === 0, codes: unique(findings.map(item => item.code)), findings };
  const value: AnswersGateRecord = { contract: ANSWERS_GATE_CONTRACT, project: request.project, request, result: outcome };
  const record: Revision<AnswersGateRecord> = { id: idOf(request), kind: ANSWERS_GATE_KIND, revision: 1, hash: hashJson(value), value };
  const merged = new Map<string, Write>();
  for (const write of writes) {
    const old = merged.get(write.id);
    if (old && !same(old, write)) fail('revision_conflict', write.id, 'writes', 'Two admitted sources require different writes');
    merged.set(write.id, write);
  }
  return { record, writes: [...merged.values()], guards: unique(guards), references: unique(references), trace };
}
/** NR1 (№3600): a trusted read of a saved G4b outcome — writeAnswersGate derived it from its exact sources once. */
function readGateRecord(store: Store, request: { project: string; record: Ref }): Revision<AnswersGateRecord> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.record)) invalid('read');
  return take(readRecord<AnswersGateRecord>(store, request.record, { unit: 'G4b', target: request.record.id,
    kind: ANSWERS_GATE_KIND, idPrefix: `om-answers-gate:${request.project}:` })) as Revision<AnswersGateRecord>;
}
/** The trace of every finding of a saved G4b is no part of its record: it is computed from the saved request when a
 * consumer needs it (the groups of an evaluation, the grounds of a run reason) — a computation, never a check. */
function readTraced(store: Store, request: { project: string; record: Ref }): AnswersGateTrace {
  const saved = readGateRecord(store, request);
  return historicalRead(store, { reader: 'G4b.answers', project: request.project, ref: request.record },
    () => ({ record: saved, trace: derive(store, copy<AnswersGateRequest>(saved.value.request as AnswersGateRequest), false).trace }),
    () => fail('answer_version_stale', request.record.id, 'history', 'G4b contains a cyclic historical source'));
}
function prepareTraced(store: Store, request: AnswersGateRequest): TracedAnswersGate {
  const derived = derive(store, request, true), old = store.get(derived.record.id);
  const prepared: PreparedAnswersGate = { record: derived.record, writes: derived.writes, guards: derived.guards,
    references: derived.references };
  if (old) {
    const existing = readGateRecord(store, { project: request.project, record: reference(old) });
    if (!same(existing, prepared.record)) fail('answer_version_stale', old.id, 'result', 'One G4b identity has one derived outcome');
    prepared.guards.push(reference(existing));
  } else prepared.writes.push({ id: prepared.record.id, kind: prepared.record.kind, expected: 0, value: prepared.record.value });
  return { prepared, trace: derived.trace };
}
export function readAnswersGate(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<Revision<AnswersGateRecord>>> {
  return run(() => readGateRecord(store, request));
}
/** Read-only: the same checks and historical derivation as readAnswersGate, plus the trace of every finding. */
export function readAnswersGateTrace(store: Store, request: { project: string; record: Ref }): OmResult<Sealed<AnswersGateTrace>> {
  return run(() => readTraced(store, request));
}
export function prepareAnswersGate(store: Store, request: AnswersGateRequest): OmResult<Sealed<PreparedAnswersGate>> {
  return run(() => prepareTraced(store, request).prepared);
}
/** Writes nothing: the current preparation of prepareAnswersGate together with the trace its derivation produced. */
export function prepareAnswersGateTrace(store: Store, request: AnswersGateRequest): OmResult<Sealed<TracedAnswersGate>> {
  return run(() => prepareTraced(store, request));
}
export function writeAnswersGate(store: Store, request: AnswersGateRequest): OmResult<Sealed<Revision<AnswersGateRecord>>> {
  return run(() => {
    requireRequest(store, request); request = normalized(request);
    // H2.0: the admitted owner results are part of the request identity — the same submission re-checks the exact
    // record the admission produced, and a result written later derives a new gate, never mutates the old one.
    request = admitOwnerResults(store, request);
    const old = store.get(idOf(request));
    if (old) return take(readAnswersGate(store, { project: request.project, record: reference(old) })) as Revision<AnswersGateRecord>;
    const prepared = take(prepareAnswersGate(store, request));
    take(writeGuarded(store, { unit: 'G4b', target: prepared.record.id, writes: prepared.writes, guards: prepared.guards }));
    return prepared.record;
  });
}

/**
 * One question of a routed batch whose answer no producer of the current contract serves, with the exact gap it names.
 * `blocking` is the D1 classification of that gap (an active question of the pass): a blocking one is a ground of the
 * end of the pass (R13); a non-blocking one is merely not paid for.
 */
export interface UnservedQuestion { gap: Ref; target: string; field: string; blocking: boolean; producer: NoProducer }
/** A batch of the route: the exact D1 records of its items (the bases of any decision on it) and its unserved questions. */
export interface BatchProducers { batch: string; records: Ref[]; unserved: UnservedQuestion[] }
export interface RouteProducers { routes: Ref; batches: BatchProducers[] }
/**
 * H1.5 (№2166): which questions of the batches of one M6 route have no answer producer. The route and the complete D1 it
 * was derived on are read by their common readers, so neither the caller's copy of a kind nor the batch's own claim
 * proves anything; every item is judged by `answerProducerOf` alone. The choice of work of H1 leaves an unserved batch out
 * of a new paid attempt, and the physical admission of E4 refuses to send one: both ask this one reading. The batch is
 * judged as it is — its composition is never cut down to the served part.
 */
export function readRouteProducers(store: Store, request: { project: string; routes: Ref }): OmResult<Sealed<RouteProducers>> {
  return run(() => {
    if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.routes)
      || Object.keys(request).length !== 2) invalid('producers');
    const routes = take(readRoutes(store, { project: request.project, record: request.routes }));
    const gaps = take(readGaps(store, copy<GapReadRequest>(routes.record.value.request.gaps as GapReadRequest)));
    if (gaps.sources.project !== request.project || !gaps.gate.passed)
      fail('gap_source_missing', request.project, 'gaps', 'A producer check needs this project\'s complete exact D1 set that passed its gate');
    const records = new Map(gaps.records.map(record => [record.id, record]));
    const batches = routes.record.value.batches.map(batch => {
      const exact: Ref[] = [], unserved: UnservedQuestion[] = [];
      for (const item of batch.items) {
        const saved = records.get(item.record.id);
        if (!saved || !same(reference(saved), item.record) || saved.value.gap.id !== item.gap
          || saved.value.gap.target !== item.target || saved.value.gap.field !== item.field)
          fail('answer_route_foreign', item.target, 'route', 'A batch item is not a gap of the exact complete D1 set of its route', item.record);
        exact.push(exactRef(reference(saved)));
        const producer = answerProducerOf(saved.value.gap);
        if (!producer.present) unserved.push({ gap: exactRef(reference(saved)), target: item.target, field: item.field,
          blocking: saved.value.gap.blocking === true, producer });
      }
      return { batch: batch.id, records: sorted(exact), unserved: sorted(unserved) };
    });
    return { routes: exactRef(request.routes), batches: sorted(batches) };
  });
}

// H1.0c managed check. The registration is one exact product of the open work that also adds the answers-gate
// assignment in the same work transition; it never reads its own future work.
export const ANSWERS_REGISTRATION_KIND = 'om-answers-registration';
export const ANSWERS_REGISTRATION_CONTRACT = 'om-answers-registration/v1' as const;
export interface AnswersRegistration {
  contract: typeof ANSWERS_REGISTRATION_CONTRACT; project: string; binding: Ref; assignment: Ref; work: Ref;
}
export interface ReadAnswersRegistration {
  record: Revision<AnswersRegistration>; binding: Revision<CompletionOwner>; assignment: Revision<AnswersGateAssignment>;
}
export interface PreparedAnswersRegistration { record: Revision<AnswersRegistration>; writes: Write[]; guards: TransactionGuard[] }
/**
 * Composition of the check inside one work: at most one registration of the one answers-gate assignment, the chain of
 * its evaluations and the G4b sources delivered from them (H1.0c S3).
 */
export interface AnswersParticipant {
  check: Revision<AnswersGateAssignment> | null; registration: Ref | null; evaluations: Ref[]; sources: Ref[];
  /** The H1.0b door of the check (S6): its proved cessation, a product of the same work. */
  ceased: Ref | null;
}
/** Why a registered check is not complete yet: no evaluation, or a barrier group of the latest one. */
export type AnswersWaitReason = 'unevaluated' | AnswersWait;
/**
 * The whole check state in the work snapshot, from one formula: its latest evaluation, completeness, the grounds of
 * existing producers it points at, and the addressed causes it waits for. There is no subject refusal of G4b (№1628 Q1).
 */
export interface AnswersCheckState {
  assignment: Ref; registration: Ref; evaluation: Ref | null; ceased: Ref | null; complete: boolean; existing: Ref[];
  waiting: { reason: AnswersWaitReason; ref: Ref; code: string | null }[];
}
export const answersRegistrationId = (project: string, assignment: Ref): string =>
  `om-answers-gate:${project}:registration:${hashJson({ assignment })}`;
function registrationShape(store: unknown, project: unknown, ref: unknown): void {
  if (!(store instanceof Store)) invalid('store');
  if (!text(project) || !isRef(ref)) invalid('registration');
}
/** №1628 Q2: until a door and a consumer are proved, the check exists only for a block binding. */
function blockBinding(binding: Revision<CompletionOwner>, target: string): void {
  if (binding.value.owner.kind !== 'block') fail('answers_evaluation_owner_unsupported', target, 'owner',
    'A mechanism binding has no answers-gate check yet', reference(binding));
}
/** NR1 (№3600): a trusted read — writeAnswersRegistration wrote the one check of its exact binding over its open work. */
function readRegistration(store: Store, project: string, ref: Ref): ReadAnswersRegistration {
  return historicalRead(store, { reader: 'G4b.registration', project, ref }, () => {
    const record = take(readRecord<AnswersRegistration>(store, ref, { unit: 'G4b', target: ref.id,
      kind: ANSWERS_REGISTRATION_KIND, idPrefix: `om-answers-gate:${project}:registration:` })) as Revision<AnswersRegistration>;
    const binding = take(readCompletionOwnerAt(store, project, record.value.binding)) as Revision<CompletionOwner>;
    return { record, binding, assignment: answersGateAssignment(binding) };
  }, () => fail('completion_invalid', ref.id, 'history', 'A registration cannot derive from itself', ref));
}
export function readAnswersRegistrationAt(store: Store, project: string, ref: Ref): OmResult<Sealed<ReadAnswersRegistration>> {
  registrationShape(store, project, ref);
  return run(() => readRegistration(store, project, ref));
}
/** Registers the check of the whole selected goal; an existing registration is its historical repeat. */
export function prepareAnswersRegistration(store: Store, request: { project: string; binding: Ref }): OmResult<Sealed<PreparedAnswersRegistration>> {
  if (!object(request) || Object.keys(request).sort().join() !== 'binding,project') invalid('registration');
  registrationShape(store, request.project, request.binding);
  const { project } = request, bindingRef: Ref = { id: request.binding.id, revision: request.binding.revision, hash: request.binding.hash };
  return run(() => {
    const read = readCompletionOwnerAt(store, project, bindingRef);
    if (!read.ok) fail('answers_binding_invalid', bindingRef.id, 'binding',
      `The check needs an exact managed binding (${read.refusal.code})`, bindingRef);
    const binding = read.value as Revision<CompletionOwner>;
    blockBinding(binding, binding.id);
    const assignment = reference(answersGateAssignment(binding)), id = answersRegistrationId(project, assignment);
    const old = store.get(id);
    if (old) return { record: readRegistration(store, project, reference(old)).record, writes: [], guards: [] };
    const head = store.get<CompletionWork>(completionWorkId(project, binding.id));
    if (!head) fail('completion_invalid', binding.id, 'work', 'A managed binding keeps its work registry', bindingRef);
    if (head.value.closed) fail('completion_closed', head.id, 'work', 'Closed work accepts no new registration', reference(head));
    const value: AnswersRegistration = { contract: ANSWERS_REGISTRATION_CONTRACT, project, binding: reference(binding),
      assignment, work: reference(head) };
    const write: Write = { id, kind: ANSWERS_REGISTRATION_KIND, expected: 0, value: copy(value) as unknown as Write['value'] };
    const record: Revision<AnswersRegistration> = { id, kind: ANSWERS_REGISTRATION_KIND, revision: 1, hash: hashJson(write.value), value };
    const next = take(prepareCompletionProducts(pendingCallStore(store, [write]), reference(binding), [reference(record)]));
    return { record, writes: [write, ...next.writes], guards: [...next.guards] };
  });
}
export function writeAnswersRegistration(store: Store, request: { project: string; binding: Ref }): OmResult<Sealed<Revision<AnswersRegistration>>> {
  const prepared = prepareAnswersRegistration(store, request);
  if (!prepared.ok) return prepared;
  return run(() => {
    const { record, writes, guards } = prepared.value;
    if (writes.length) take(writeGuarded(store, { unit: 'G4b', target: record.id, writes: [...writes], guards: [...guards] }));
    return record as Revision<AnswersRegistration>;
  });
}

// ---- H1.0c S3: evaluation, finding-proof, A2 source and their three readers (№1446 п.1–3, №1616 п.1–2, №1628) ----
export const ANSWERS_EVALUATION_KIND = 'om-answers-evaluation';
export const ANSWERS_EVALUATION_CONTRACT = 'om-answers-evaluation/v1' as const;
export const ANSWERS_FINDING_KIND = 'om-answers-finding';
export const ANSWERS_FINDING_CONTRACT = 'om-answers-finding/v1' as const;
/** One item of the original M6 plan of the binding: its batch, D1 gap and the exact record it was planned from. */
export interface AnswersPlanItem { batch: string; gap: string; record: Ref; line: string; kind: GapKind; moment: GapMoment }
/** One gap of the current D1 the attempt answers for, with every original plan item of the same identity. */
export interface AnswersScopeItem {
  line: string; gap: Ref; target: string; field: string; kind: GapKind; moment: GapMoment; blocking: boolean;
  consumers: string[]; plan: AnswersPlanItem[];
}
/** The proved area of the assignment: current gaps it covers and original items whose gap vanished (row 20). */
export interface AnswersScope { items: AnswersScopeItem[]; absent: AnswersPlanItem[] }
export interface AnswersEvaluation {
  contract: typeof ANSWERS_EVALUATION_CONTRACT; project: string; binding: Ref; assignment: Ref; registration: Ref;
  work: Ref; previous: Ref | null; gate: Ref; series: Ref; ordinal: number; goal: AttemptGoal; scope: AnswersScope;
}
export type AnswersGroupScope = { kind: 'gap'; line: string; gap: Ref } | { kind: 'submission'; gap: Ref };
export type AnswersWait = 'work' | 'submission' | 'producer';
/** A finding of G4b is either journal-only diagnostics or points at the ground of an existing producer (№1628 Q1). */
export type AnswersContribution =
  | { kind: 'journal-only'; wait: AnswersWait; barrier: boolean }
  | { kind: 'existing'; producer: 'E5-N' | 'E5-T' | 'E4-T' | 'E4-terminal' | 'cessation'; basis: Ref[] };
export interface AnswersFinding {
  contract: typeof ANSWERS_FINDING_CONTRACT; project: string; evaluation: Ref; finding: Refusal; cause: AnswersGateCause;
  scope: AnswersGroupScope; occurrences: number[]; contribution: AnswersContribution;
}
export interface AnswersGroup { proof: Revision<AnswersFinding>; source: Revision<UnitRefusalRecord> }
export interface ReadAnswersEvaluation {
  record: Revision<AnswersEvaluation>; binding: Revision<CompletionOwner>; work: Sealed<CompletionSnapshot>;
  gate: Revision<AnswersGateRecord>; trace: AnswersGateTraceEntry[]; groups: AnswersGroup[];
}
export interface ReadAnswersFinding {
  record: Revision<AnswersFinding>; evaluation: Revision<AnswersEvaluation>; binding: Revision<CompletionOwner>;
  source: Revision<UnitRefusalRecord>;
}
export interface ReadAnswersGateRefusal {
  record: Revision<UnitRefusalRecord>; proof: Revision<AnswersFinding>; evaluation: Revision<AnswersEvaluation>;
  binding: Ref; contribution: AnswersContribution;
}
/** With `close`, the evaluation, its delivered sources and the close of the attempt are one bundle (H1.0c, №1616 п.3). */
export interface AnswersEvaluationRequest { project: string; binding: Ref; request: AnswersGateRequest; deliver?: 'all' | 'none';
  close?: AnyCloseAttemptRequest }
export interface AnswersGroupSummary { proof: Ref; source: Ref; contribution: AnswersContribution }
export interface PreparedAnswersEvaluation {
  evaluation: Revision<AnswersEvaluation>; repeated: boolean; groups: AnswersGroupSummary[];
  writes: Write[]; guards: TransactionGuard[]; closed?: RepeatOutcome;
}
export type WrittenAnswersEvaluation = Omit<PreparedAnswersEvaluation, 'writes' | 'guards'>;
export interface AnswersDeliveryRequest { project: string; evaluation: Ref; group?: string }
export interface PreparedAnswersDelivery { groups: AnswersGroupSummary[]; writes: Write[]; guards: TransactionGuard[] }
export const answersEvaluationId = (project: string, assignment: Ref, gate: Ref): string =>
  `om-answers-gate:${project}:evaluation:${hashJson({ assignment: exactRef(assignment), gate: exactRef(gate) })}`;
export const answersFindingId = (project: string, identity: { evaluation: Ref; finding: Refusal; cause: AnswersGateCause;
  scope: AnswersGroupScope }): string => `om-answers-gate:${project}:finding:${hashJson(identity)}`;
export const answersRefusalId = (project: string, proof: Ref): string =>
  `${unitRefusalNamespace(project)}g4b:${hashJson(exactRef(proof))}`;

/**
 * Lesson 46: the contribution of every emission point, one row per kind, chosen by cause.emission and never by code or
 * route. E5-N/E5-T/E4-T hold only for the attempt's own result; otherwise the finding is a wrong submission. A covering
 * H1.0b cessation of the area turns any other point into that existing ground (row 14, C56). candidate-gate-negative
 * is unreachable (CandidateGate.passed is true, STALE-4): a stored one is refused, never invented as a G3 outcome.
 */
type ContributionRule = 'E5-N' | 'E5-T' | 'E4-T' | 'E4-terminal' | AnswersWait | 'unreachable';
const CONTRIBUTION_RULES: Readonly<Record<AnswersGateEmission, ContributionRule>> = Object.freeze({
  'gap-revision-stale': 'submission', 'gap-ref-inexact': 'submission', 'gap-unknown': 'submission',
  'gap-unrouted': 'producer', 'deferral-declared': 'submission', 'deferral-inherited': 'submission',
  duplicate: 'submission', 'owner-absent': 'producer', 'unsupported-absent': 'producer', 'blocking-absent': 'submission',
  'route-disallowed': 'submission', 'candidate-without-result': 'submission', 'owner-offered': 'producer',
  'unsupported-offered': 'producer', 'blocking-null': 'submission', 'result-route-disallowed': 'submission',
  'fact-candidate': 'submission', 'answer-foreign-project': 'submission', 'answer-without-fact-task': 'submission',
  'answer-search-missing': 'submission', 'answer-outside-search': 'submission', 'answer-inapplicable': 'submission',
  'answer-route-not-code': 'submission', 'answer-unselected': 'submission', 'answer-candidate': 'submission',
  'decision-unapplied': 'submission', 'decision-foreign': 'submission', 'offered-known-foreign': 'submission',
  'offered-unrecognized': 'submission', 'part-not-assembly': 'work', 'design-known-foreign': 'submission',
  'design-unrecognized': 'submission', 'assembly-assignment-foreign': 'submission', 'candidate-absent': 'work',
  'candidate-gate-negative': 'unreachable', 'candidate-stale': 'submission', 'works-candidate': 'submission',
  'works-frame-unavailable': 'producer', 'works-obligation-open': 'submission',
  'works-obligation-filled-elsewhere': 'submission', 'batch-level-foreign': 'submission', 'mc1-unfinished': 'work',
  'mc1-foreign-task': 'submission', 'mc1-task-foreign-gap': 'submission', 'mc1-fact-candidates': 'work',
  'mc1-technical': 'E4-T', 'transport-foreign': 'submission', 'legacy-question-foreign': 'submission',
  'assessment-question-foreign': 'submission', 'assessment-task-foreign': 'submission',
  'assessment-supported': 'submission', 'assessment-transport-managed': 'work', 'assessment-insufficient': 'E5-N',
  'assessment-conflicting': 'E5-N', 'assessment-off-form': 'E5-T', 'assessment-interrupted': 'E5-T',
  'assessment-terminated': 'E5-T', 'assessment-legacy-transport': 'submission',
  'mc2-terminal': 'E4-terminal', 'mc2-terminal-foreign': 'submission',
  // H2.0: an accepted owner answer is not a finding — positive entries are filtered before grouping, so this rule is
  // structurally unreachable and must stay so.
  'owner-answered': 'unreachable',
});
function evaluationFail(target: string, field: string, message: string, ref?: Ref): never {
  return fail('answers_evaluation_invalid', target, field, message, ref);
}
const recordOf = <T>(write: Write): Revision<T> =>
  ({ id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(write.value), value: write.value as T });
const writeOf = (record: Revision<unknown>): Write =>
  ({ id: record.id, kind: record.kind, expected: record.revision - 1, value: record.value as Write['value'] });
/** One write per id: identical duplicates collapse, different ones are a conflict of the bundle. */
function bundle(writes: readonly Write[]): Write[] {
  const merged = new Map<string, Write>();
  for (const write of writes) {
    const old = merged.get(write.id);
    if (old && !same(old, write)) fail('revision_conflict', write.id, 'writes', 'One transaction writes one record once');
    merged.set(write.id, write);
  }
  return [...merged.values()];
}
/** Guards name what stood before the bundle, never a record the same bundle writes. */
function external(guards: readonly TransactionGuard[], writes: readonly Write[]): TransactionGuard[] {
  const pending = new Set(writes.map(write => canonical(reference(recordOf(write)))));
  return unique(guards.filter(guard => !pending.has(canonical(guard))));
}
function summaryOf(groups: readonly AnswersGroup[]): AnswersGroupSummary[] {
  return groups.map(group => ({ proof: reference(group.proof), source: reference(group.source),
    contribution: group.proof.value.contribution }));
}
/** The binding of the check, refused as a binding failure (row 5) and admitted only for a block owner (№1628 Q2). */
function checkedBinding(store: Store, project: string, ref: Ref): Revision<CompletionOwner> {
  const read = readCompletionOwnerAt(store, project, exactRef(ref));
  if (!read.ok) fail('answers_binding_invalid', ref.id, 'binding', `The check needs an exact managed binding (${read.refusal.code})`, exactRef(ref));
  const binding = read.value as Revision<CompletionOwner>;
  blockBinding(binding, binding.id);
  return binding;
}

/**
 * №1616 п.2: the area of the assignment is derived from every original plan item of the binding, the full goal and
 * the exact current D1 of the gate: the same line, kind and moment, and the block among ALL consumers of the gap. The
 * current M6 of the gate need not equal the plan (STALE-3); an item whose gap left D1 is absent, not held (row 20).
 */
function deriveAnswersScope(store: Store, binding: Revision<CompletionOwner>, gate: Revision<AnswersGateRecord>): AnswersScope {
  const project = binding.value.project, owner = binding.value.owner;
  if (owner.kind !== 'block') fail('answers_evaluation_owner_unsupported', binding.id, 'owner', 'A mechanism binding has no answers-gate check yet', reference(binding));
  const plan = take(readRoutes(store, { project, record: binding.value.plan.routes }));
  const planned: AnswersPlanItem[] = [];
  for (const id of binding.value.plan.batches) {
    const batch = plan.record.value.batches.find(item => item.id === id);
    if (!batch) evaluationFail(binding.id, 'plan', 'The binding plan names its exact original batches', reference(binding));
    for (const item of batch.items) {
      const route = plan.record.value.routes.find(row => row.gap === item.gap && same(row.record, item.record));
      if (!route) evaluationFail(binding.id, 'plan', 'Every original plan item keeps its routed gap', reference(binding));
      planned.push({ batch: id, gap: item.gap, record: exactRef(item.record), line: gapLineKey(project, item.target, item.field),
        kind: route.kind, moment: route.moment });
    }
  }
  const current = take(readGaps(store, gate.value.request.gaps));
  const items: AnswersScopeItem[] = [];
  for (const record of current.records) {
    const gap = record.value.gap, line = gapLineKey(project, gap.target, gap.field);
    if (!binding.value.goal.questions.includes(line) || !gap.consumers.includes(owner.block)) continue;
    const matched = planned.filter(item => item.line === line && item.kind === gap.kind && item.moment === gap.moment);
    if (!matched.length) continue;
    items.push({ line, gap: reference(record), target: gap.target, field: gap.field, kind: gap.kind, moment: gap.moment,
      blocking: gap.blocking, consumers: [...gap.consumers], plan: sorted(matched) });
  }
  const covered = items.flatMap(item => item.plan);
  return { items: sorted(items), absent: sorted(planned.filter(item => !covered.some(own => same(own, item)))) };
}
/**
 * The area of one emission: an exact scope gap, or a submission naming no current gap whose every row names exactly an
 * original plan record of this binding (proved belonging, C09, row 27). Anything else stays only in the full G4b.
 */
function groupScope(cause: AnswersGateCause, scope: AnswersScope): { area: AnswersGroupScope; item: AnswersScopeItem | null } | null {
  if (cause.gap) {
    const item = scope.items.find(row => same(row.gap, cause.gap));
    return item ? { area: { kind: 'gap', line: item.line, gap: item.gap }, item } : null;
  }
  const rows = cause.occurrences, first = rows[0];
  if (!first) return null;
  const plan = [...scope.items.flatMap(item => item.plan), ...scope.absent];
  if (!rows.every(row => same(row.gap, first.gap)) || !plan.some(item => same(item.record, first.gap))) return null;
  return { area: { kind: 'submission', gap: exactRef(first.gap) }, item: null };
}
/** A cessation of the evaluated work whose assignment covers this scope item (root, its fact or its assigned part). */
function coveringCessation(store: Store, before: Sealed<CompletionSnapshot>, item: AnswersScopeItem): Ref | null {
  const byId = new Map(before.assignments.map(row => [row.id, row]));
  for (const cessation of before.cessations) {
    const assignment = byId.get(cessation.value.assignment.id);
    if (!assignment) continue;
    let root = assignment;
    while (root.value.parent) {
      const parent = byId.get(root.value.parent.id);
      if (!parent) break;
      root = parent;
    }
    if (root.value.kind !== 'root' || !item.plan.some(plan => plan.batch === root.value.batch)) continue;
    if (assignment.value.kind === 'root') return reference(cessation);
    if (assignment.value.kind === 'fact') {
      if (item.plan.some(plan => plan.gap === assignment.value.question)) return reference(cessation);
      continue;
    }
    const packet = take(readQuestionPacket(store, { project: before.binding.value.project, record: assignment.value.source }));
    const planned = packet.value.plan;
    if (!planned) return reference(cessation);
    const obligations = planned.assignments[assignment.value.position ?? 0]?.obligations ?? [];
    if (obligations.includes(item.target)) return reference(cessation);
  }
  return null;
}
/** The one contribution of a group, from the table above; existing grounds are this attempt's own exact products. */
function contributionOf(store: Store, before: Sealed<CompletionSnapshot>, cause: AnswersGateCause, area: AnswersGroupScope,
  item: AnswersScopeItem | null): AnswersContribution {
  const rule = CONTRIBUTION_RULES[cause.emission], project = before.binding.value.project;
  if (rule === 'unreachable') evaluationFail(cause.emission, 'cause',
    'A negative G3 outcome is not produced by the common G3 gate; no G4b ground is invented for it');
  const cited = (role: AnswersGateSourceRole) => cause.sources.find(source => source.role === role)?.ref ?? null;
  const own = (ref: Ref | null): ref is Ref => ref !== null && before.products.some(product => same(product, ref));
  if (rule === 'E5-N' || rule === 'E5-T') {
    const terminal = cited('terminal');
    if (own(terminal)) {
      if (rule === 'E5-T') return { kind: 'existing', producer: 'E5-T', basis: [terminal] };
      const canonicalSource = before.products.find(product => product.id === assessmentRefusalId(project, terminal));
      if (!canonicalSource) fail('completion_invalid', terminal.id, 'assessment',
        'An own E5 N keeps its canonical E5 source; G4b never makes a copy of it (STALE-10, C42)', terminal);
      return { kind: 'existing', producer: 'E5-N', basis: [terminal, exactRef(canonicalSource)] };
    }
  }
  if (rule === 'E4-T') {
    const call = cited('model-call'), diagnostic = cited('diagnostic');
    if (own(call) && diagnostic) return { kind: 'existing', producer: 'E4-T', basis: [call, diagnostic] };
  }
  // №1770: a proved terminal of this attempt's own MC2 root (its cycle and that cycle's diagnostic, both products of
  // the work) is the existing E4 ground of the check; another attempt's terminal stays a wrong submission.
  if (rule === 'E4-terminal') {
    const cycle = cited('cycle'), diagnostic = cited('diagnostic');
    if (own(cycle) && own(diagnostic)) return { kind: 'existing', producer: 'E4-terminal', basis: [cycle, diagnostic] };
  }
  const ceased = item ? coveringCessation(store, before, item) : null;
  if (ceased) return { kind: 'existing', producer: 'cessation', basis: [ceased] };
  const wait: AnswersWait = rule === 'work' || rule === 'producer' ? rule : 'submission';
  return { kind: 'journal-only', wait, barrier: area.kind === 'gap' && item !== null && item.blocking };
}
/**
 * The groups of one evaluation: full finding + exact cause + area, with every occurrence index of the trace (C08,
 * row 26). Each yields its proof and its A2 source, derived from the proof alone (C18, C19); nothing is chosen by a caller.
 */
function deriveAnswersGroups(store: Store, evaluation: Revision<AnswersEvaluation>, before: Sealed<CompletionSnapshot>,
  trace: readonly AnswersGateTraceEntry[]): AnswersGroup[] {
  const project = evaluation.value.project, grouped = new Map<string, { entry: AnswersGateTraceEntry;
    area: AnswersGroupScope; item: AnswersScopeItem | null; occurrences: number[] }>();
  trace.forEach((entry, index) => {
    if (isPositive(entry)) return;   // H2.0: admissions prove a row, they journal no refusal
    const scoped = groupScope(entry.cause, evaluation.value.scope);
    if (!scoped) return;
    const key = canonical({ finding: entry.finding, cause: entry.cause, scope: scoped.area });
    const group = grouped.get(key);
    if (group) group.occurrences.push(index);
    else grouped.set(key, { entry, area: scoped.area, item: scoped.item, occurrences: [index] });
  });
  return [...grouped.entries()].sort(([a], [b]) => order(a, b)).map(([, group]) => {
    const value: AnswersFinding = { contract: ANSWERS_FINDING_CONTRACT, project, evaluation: reference(evaluation),
      finding: group.entry.finding, cause: group.entry.cause, scope: group.area, occurrences: group.occurrences,
      contribution: contributionOf(store, before, group.entry.cause, group.area, group.item) };
    const proofValue = copy(value);
    const proof: Revision<AnswersFinding> = { id: answersFindingId(project, { evaluation: reference(evaluation),
      finding: proofValue.finding, cause: proofValue.cause, scope: proofValue.scope }), kind: ANSWERS_FINDING_KIND,
    revision: 1, hash: hashJson(proofValue), value: proofValue };
    return { proof, source: groupSource(project, evaluation, proof) };
  });
}
/** The A2 source of one finding-proof: its body and address follow from the proof alone. */
function groupSource(project: string, evaluation: Revision<AnswersEvaluation>, proof: Revision<AnswersFinding>): Revision<UnitRefusalRecord> {
  const finding = proof.value.finding;
  const body: UnitRefusalRecord = copy({ gate: 'G4b', refusals: [{ code: finding.code, goal: evaluation.value.goal.result,
    remedy: finding.message, origin: { name: finding.code, stage: 'answers-gate/v1', subject: finding.at.target,
      sources: [{ role: 'answers-finding', ref: reference(proof) }] } }] });
  return { id: answersRefusalId(project, reference(proof)), kind: UNIT_REFUSAL_KIND, revision: 1, hash: hashJson(body), value: body };
}

/** NR1 (№3600): the evaluation as writeAnswersEvaluation wrote it over its exact open work and gate. Its groups are no
 * part of the record (their proofs are written only when delivered), so they are computed from the work and the gate's
 * trace — read as written, nothing of it proved again. */
function readEvaluation(store: Store, project: string, ref: Ref): ReadAnswersEvaluation {
  return historicalRead(store, { reader: 'G4b.evaluation', project, ref }, () => {
    const record = take(readRecord<AnswersEvaluation>(store, ref, { unit: 'G4b', target: ref.id,
      kind: ANSWERS_EVALUATION_KIND, idPrefix: `om-answers-gate:${project}:evaluation:` })) as Revision<AnswersEvaluation>;
    const value = record.value;
    const binding = take(readCompletionOwnerAt(store, project, value.binding)) as Revision<CompletionOwner>;
    const work = take(readCompletionWorkAt(store, project, value.work));
    const gate = readTraced(store, { project, record: value.gate });
    return { record, binding, work, gate: gate.record, trace: gate.trace, groups: deriveAnswersGroups(store, record, work, gate.trace) };
  }, () => evaluationFail(ref.id, 'history', 'An evaluation cannot derive from itself', ref));
}
/** NR1 (№3600): a trusted read of a delivered finding-proof and its evaluation; its A2 source follows from the proof. */
function readFinding(store: Store, project: string, ref: Ref): ReadAnswersFinding {
  return historicalRead(store, { reader: 'G4b.finding', project, ref }, () => {
    const record = take(readRecord<AnswersFinding>(store, ref, { unit: 'G4b', target: ref.id,
      kind: ANSWERS_FINDING_KIND, idPrefix: `om-answers-gate:${project}:finding:` })) as Revision<AnswersFinding>;
    const evaluation = take(readRecord<AnswersEvaluation>(store, record.value.evaluation, { unit: 'G4b', target: ref.id,
      kind: ANSWERS_EVALUATION_KIND, idPrefix: `om-answers-gate:${project}:evaluation:` })) as Revision<AnswersEvaluation>;
    const binding = take(readCompletionOwnerAt(store, project, evaluation.value.binding)) as Revision<CompletionOwner>;
    return { record, evaluation, binding, source: groupSource(project, evaluation, record) };
  }, () => evaluationFail(ref.id, 'history', 'A finding cannot derive from itself', ref));
}
/** NR1 (№3600): a trusted read of a delivered G4b source, its finding-proof and evaluation. */
function readGateRefusal(store: Store, project: string, ref: Ref): ReadAnswersGateRefusal {
  return historicalRead(store, { reader: 'G4b.refusal', project, ref }, () => {
    const record = take(readRecord<UnitRefusalRecord>(store, ref, { unit: 'G4b', target: ref.id,
      kind: UNIT_REFUSAL_KIND, idPrefix: `${unitRefusalNamespace(project)}g4b:` })) as Revision<UnitRefusalRecord>;
    const finding = readFinding(store, project, record.value.refusals[0]!.origin.sources[0]!.ref);
    return { record, proof: finding.record, evaluation: finding.evaluation, binding: reference(finding.binding),
      contribution: finding.record.value.contribution };
  }, () => evaluationFail(ref.id, 'history', 'A G4b source cannot derive from itself', ref));
}
function readShape(store: unknown, project: unknown, ref: unknown, field: string): void {
  if (!(store instanceof Store)) invalid('store');
  if (!text(project) || !isRef(ref)) invalid(field);
}
export function readAnswersEvaluationAt(store: Store, project: string, ref: Ref): OmResult<Sealed<ReadAnswersEvaluation>> {
  readShape(store, project, ref, 'evaluation');
  return run(() => readEvaluation(store, project, exactRef(ref)));
}
export function readAnswersFindingAt(store: Store, project: string, ref: Ref): OmResult<Sealed<ReadAnswersFinding>> {
  readShape(store, project, ref, 'finding');
  return run(() => readFinding(store, project, exactRef(ref)));
}
/**
 * The typed reader of G4b A2 sources. It reads no close, no current head and no journal revision but the strictly
 * earlier cut of the work its evaluation stands on (C66): source → finding → evaluation → preceding work.
 */
export function readAnswersGateRefusalAt(store: Store, project: string, source: Ref): OmResult<Sealed<ReadAnswersGateRefusal>> {
  readShape(store, project, source, 'source');
  return run(() => readGateRefusal(store, project, exactRef(source)));
}

/**
 * №1628 Q3, one function in the order of its table: the same saved assignment/gate is the historical repeat of that
 * evaluation (even resolved or closed); closed work takes no new one; a resolved check keeps its result; an unresolved
 * one on open work takes a new evaluation through the full current G4b preparation and its chain of predecessors.
 */
function prepareEvaluation(store: Store, input: AnswersEvaluationRequest): PreparedAnswersEvaluation {
  requireRequest(store, input.request);
  const request = normalized(input.request), project = input.project;
  const binding = checkedBinding(store, project, input.binding);
  // A linked close captures every head it stands on before the evaluation reads anything (row 41).
  const heads = input.close ? take(captureManagedCloseHeads(store, input.close)) : null;
  if (heads && !same(heads.binding, reference(binding)))
    fail('completion_foreign', binding.id, 'close', 'A linked close closes the attempt of the evaluated binding', heads.binding);
  const assignment = reference(answersGateAssignment(binding));
  const standing = store.get(idOf(request));
  const saved = standing ? store.get(answersEvaluationId(project, assignment, reference(standing))) : null;
  if (saved) {
    const repeat = readEvaluation(store, project, reference(saved));
    const done = { evaluation: repeat.record, repeated: true, groups: summaryOf(repeat.groups) };
    if (!input.close) return { ...done, writes: [], guards: [] };
    // An included evaluation is repeated historically; its close is then the general G7 over the same work.
    const closing = take(prepareCloseAttempt(store, input.close));
    return { ...done, writes: [...closing.writes] as Write[], guards: [...closing.guards], closed: closing.value };
  }
  const head = heads ? store.get<CompletionWork>(heads.work.id, heads.work.revision) : store.get<CompletionWork>(completionWorkId(project, binding.id));
  if (!head) fail('completion_invalid', binding.id, 'work', 'A managed binding keeps its work registry', reference(binding));
  if (head.value.closed) fail('completion_closed', head.id, 'work', 'Closed work takes no new evaluation', reference(head));
  const journal = heads ? (heads.journal ? store.get(heads.journal.id, heads.journal.revision) : null) : store.get(journalId(project));
  const before = take(readCompletionWorkAt(store, project, reference(head)));
  if (!before.answers) fail('answers_binding_invalid', binding.id, 'registration',
    'The check is registered in the open work before it is evaluated', reference(binding));
  if (before.answers.complete) fail('completion_resolved', before.answers.assignment.id, 'assignment',
    'A resolved check keeps its evaluation; a moved D1 does not reopen it', before.answers.evaluation ?? before.answers.registration);
  const gate = prepareTraced(store, request).prepared, gateRef = reference(gate.record);
  const staged = pendingCallStore(store, gate.writes);
  const traced = readTraced(staged, { project, record: gateRef });
  const value: AnswersEvaluation = { contract: ANSWERS_EVALUATION_CONTRACT, project, binding: reference(binding), assignment,
    registration: before.answers.registration, work: reference(head), previous: before.answers.evaluation, gate: gateRef,
    series: exactRef(binding.value.series), ordinal: binding.value.attempt, goal: binding.value.goal,
    scope: deriveAnswersScope(staged, binding, traced.record) };
  const evaluationWrite: Write = { id: answersEvaluationId(project, assignment, gateRef), kind: ANSWERS_EVALUATION_KIND,
    expected: 0, value: copy(value) as unknown as Write['value'] };
  const evaluation = recordOf<AnswersEvaluation>(evaluationWrite);
  const groups = deriveAnswersGroups(staged, evaluation, before, traced.trace);
  const delivered = (input.deliver ?? 'all') === 'all' && groups.length > 0;
  const proofs = delivered ? groups.map(group => writeOf(group.proof)) : [];
  if (heads) {
    // The rows, the classes of the close and the single final revision of the work are prepared by the close itself.
    const sources = groups.map(group => reference(group.source));
    const closing = take(prepareLinkedClose(store, input.close!, { heads, writes: bundle([...gate.writes, evaluationWrite, ...proofs]),
      guards: gate.guards, sources, pending: groups.map(group => writeOf(group.source)),
      additions: unique([reference(evaluation), ...sources]) }));
    return { evaluation, repeated: false, groups: summaryOf(groups), writes: [...closing.writes] as Write[],
      guards: [...closing.guards], closed: closing.value };
  }
  let view = pendingCallStore(staged, [evaluationWrite, ...proofs]);
  const journalled = delivered ? take(prepareJournalBatch(view, { project, sources: groups.map(group => reference(group.source)),
    pending: groups.map(group => writeOf(group.source)), classifications: [] })) : null;
  if (journalled) {
    if (!same(journalled.guards[journalled.guards.length - 1], journal ? reference(journal) : { id: journalId(project), absent: true }))
      fail('input_stale', journalId(project), 'journal', 'The journal moved while the evaluation was prepared');
    view = pendingCallStore(view, journalled.writes as Write[]);
  }
  const added = [reference(evaluation), ...(delivered ? groups.map(group => reference(group.source)) : [])];
  const work = take(prepareCompletionProducts(view, reference(binding), added));
  const writes = bundle([...gate.writes, evaluationWrite, ...proofs, ...(journalled?.writes ?? []) as Write[], ...work.writes]);
  const guards = external([...gate.guards, reference(head), journal ? reference(journal) : { id: journalId(project), absent: true },
    ...(journalled?.guards ?? []), ...work.guards], writes);
  return { evaluation, repeated: false, groups: summaryOf(groups), writes, guards };
}
function evaluationShape(store: unknown, request: unknown): asserts request is AnswersEvaluationRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(request) || Object.keys(request).some(key => !['project', 'binding', 'request', 'deliver', 'close'].includes(key))
    || !text(request.project) || !isRef(request.binding) || !object(request.request) || request.request.project !== request.project
    || request.deliver !== undefined && request.deliver !== 'all' && request.deliver !== 'none'
    || request.close !== undefined && (!object(request.close) || request.close.project !== request.project || request.deliver === 'none'))
    invalid('evaluation');
  // The linked close is an argument too: its whole shape is refused before the binding or any head is read.
  if (request.close !== undefined) requireCloseRequestShape(store, request.close as unknown as AnyCloseAttemptRequest);
}
/** The evaluation bundle without writing it: gate, evaluation, proofs, A2 sources and rows, and the work transition. */
export function prepareAnswersEvaluation(store: Store, request: AnswersEvaluationRequest): OmResult<Sealed<PreparedAnswersEvaluation>> {
  evaluationShape(store, request);
  return run(() => prepareEvaluation(store, request));
}
/** Writes the prepared bundle in one guarded transaction; without `close` it saves diagnostics and never closes A3. */
export function writeAnswersEvaluation(store: Store, request: AnswersEvaluationRequest): OmResult<Sealed<WrittenAnswersEvaluation>> {
  evaluationShape(store, request);
  return run(() => {
    const { writes, guards, ...written } = prepareEvaluation(store, request);
    if (writes.length) take(writeGuarded(store, { unit: request.close ? 'G7' : 'G4b', target: written.evaluation.id, writes, guards }));
    return written;
  });
}

/**
 * Rows 34, 35, 44: the proofs and A2 sources of a saved evaluation are delivered by the same addresses, with their rows
 * and the work transition in one bundle; an already delivered group is a repeat without a write, also after close.
 */
function prepareDelivery(store: Store, input: AnswersDeliveryRequest): PreparedAnswersDelivery {
  const project = input.project, read = readEvaluation(store, project, exactRef(input.evaluation));
  const chosen = input.group === undefined ? read.groups : read.groups.filter(group => group.proof.id === input.group);
  if (input.group !== undefined && !chosen.length)
    evaluationFail(input.group, 'group', 'The group is one the evaluation derives', reference(read.record));
  const head = store.get<CompletionWork>(completionWorkId(project, read.binding.id));
  if (!head) fail('completion_invalid', read.binding.id, 'work', 'A managed binding keeps its work registry', reference(read.binding));
  const current = take(readCompletionWorkAt(store, project, reference(head)));
  const sources = chosen.map(group => reference(group.source));
  const missing = sources.filter(source => !current.products.some(product => same(product, source)));
  if (!missing.length) return { groups: summaryOf(chosen), writes: [], guards: [] };
  if (head.value.closed) fail('completion_closed', head.id, 'work', 'Closed work takes only exact historical repeats', reference(head));
  if (!current.answers || !same(current.answers.evaluation, reference(read.record)))
    fail('completion_conflict', read.record.id, 'evaluation', 'Only the latest evaluation of the check is delivered',
      current.answers?.evaluation ?? undefined);
  const journal = store.get(journalId(project));
  const late = chosen.filter(group => missing.some(source => same(source, reference(group.source))));
  const proofs = late.filter(group => !store.get(group.proof.id, 1)).map(group => writeOf(group.proof));
  let view = pendingCallStore(store, proofs);
  const journalled = take(prepareJournalBatch(view, { project, sources: late.map(group => reference(group.source)),
    pending: late.filter(group => !store.get(group.source.id, 1)).map(group => writeOf(group.source)), classifications: [] }));
  view = pendingCallStore(view, journalled.writes as Write[]);
  const work = take(prepareCompletionProducts(view, reference(read.binding), missing));
  const writes = bundle([...proofs, ...journalled.writes as Write[], ...work.writes]);
  const guards = external([reference(head), journal ? reference(journal) : { id: journalId(project), absent: true },
    ...journalled.guards, ...work.guards], writes);
  return { groups: summaryOf(chosen), writes, guards };
}
function deliveryShape(store: unknown, request: unknown): asserts request is AnswersDeliveryRequest {
  if (!(store instanceof Store)) invalid('store');
  if (!object(request) || Object.keys(request).some(key => !['project', 'evaluation', 'group'].includes(key))
    || !text(request.project) || !isRef(request.evaluation) || request.group !== undefined && !text(request.group)) invalid('delivery');
}
export function prepareAnswersDelivery(store: Store, request: AnswersDeliveryRequest): OmResult<Sealed<PreparedAnswersDelivery>> {
  deliveryShape(store, request);
  return run(() => prepareDelivery(store, request));
}
export function writeAnswersDelivery(store: Store, request: AnswersDeliveryRequest): OmResult<Sealed<{ groups: AnswersGroupSummary[] }>> {
  deliveryShape(store, request);
  return run(() => {
    const { writes, guards, groups } = prepareDelivery(store, request);
    if (writes.length) take(writeGuarded(store, { unit: 'G4b', target: request.evaluation.id, writes, guards }));
    return { groups };
  });
}

/** Lesson 1: the exact revisions the check helpers of the work reader are handed, refused before any field is read. */
const revisionShape = (value: unknown): value is Revision<Record<string, unknown>> =>
  object(value) && isRef({ id: value.id, revision: value.revision, hash: value.hash }) && object(value.value);
function bindingShape(binding: unknown): asserts binding is Revision<CompletionOwner> {
  if (!revisionShape(binding) || !text(binding.value.project) || !isRef(binding.value.series)) invalid('binding');
}
const refsShape = (value: unknown): value is Ref[] => Array.isArray(value) && value.every(isRef);
/** A product of the check: its registration, an evaluation, or any record carrying a mark of G4b (C19: never E5/E4). */
export function answersProduct(project: string, ref: Ref, record: Revision<unknown>): boolean {
  if (!text(project) || !isRef(ref) || !object(record)) invalid('product');
  return record.kind === ANSWERS_REGISTRATION_KIND || record.kind === ANSWERS_EVALUATION_KIND
    || record.kind === UNIT_REFUSAL_KIND && answersSourceMarks(project, ref, record.value).any;
}
/** Reads the check part of one exact work composition; an empty set is an empty participant without reads. */
export function readAnswersParticipant(store: Store, binding: Revision<CompletionOwner>, products: readonly Ref[]): OmResult<Sealed<AnswersParticipant>> {
  if (!(store instanceof Store)) invalid('store');
  bindingShape(binding);
  if (!refsShape(products)) invalid('products');
  return run(() => {
    const project = binding.value.project, participant: AnswersParticipant = { check: null, registration: null, evaluations: [], sources: [],
      ceased: null };
    // NR1 (№3600): the products were admitted by checkAnswersTransition when the work took them; read, not proved again.
    for (const ref of products) {
      const kind = store.get(ref.id, ref.revision)?.kind;
      if (kind === ANSWERS_EVALUATION_KIND) participant.evaluations.push(ref);
      else if (kind === COMPLETION_CESSATION_KIND) participant.ceased = ref;
      else if (kind === UNIT_REFUSAL_KIND) participant.sources.push(ref);
      else if (kind === ANSWERS_REGISTRATION_KIND) {
        const registration = readRegistration(store, project, ref);
        participant.check = registration.assignment; participant.registration = reference(registration.record);
      }
    }
    return participant;
  });
}
/**
 * The work transition that adds a registration is its immediate successor; an evaluation stands on the immediately
 * preceding work after its latest predecessor, one per transition, and never on a resolved check (№1628 Q3); a G4b
 * source comes from the evaluation added now or from the latest one (C39, row 42).
 */
export function checkAnswersTransition(store: Store, before: Sealed<CompletionSnapshot>, added: readonly Ref[]): OmResult<Sealed<true>> {
  if (!(store instanceof Store)) invalid('store');
  if (!object(before) || !revisionShape(before.work) || !(before.answers === null || object(before.answers))) invalid('work');
  bindingShape(before.binding);
  if (!refsShape(added)) invalid('products');
  return run(() => {
    const project = before.binding.value.project;
    const kinds = added.map(ref => store.get(ref.id, ref.revision));
    const evaluations = added.filter((_, index) => kinds[index]?.kind === ANSWERS_EVALUATION_KIND);
    if (evaluations.length > 1) fail('completion_conflict', evaluations[1]!.id, 'evaluation', 'One transition adds one next evaluation', evaluations[1]);
    const ceasing = added.find((_, index) => kinds[index]?.kind === COMPLETION_CESSATION_KIND
      && (kinds[index]!.value as { disposition?: unknown }).disposition === 'check-ceased');
    if (ceasing && evaluations.length)
      fail('completion_conflict', ceasing.id, 'evaluation', 'A check ceases or takes a next evaluation, never both at once', evaluations[0]);
    added.forEach((ref, index) => {
      const record = kinds[index];
      if (record?.kind === ANSWERS_REGISTRATION_KIND) {
        const registration = readRegistration(store, project, ref);
        if (!same(registration.record.value.work, reference(before.work)))
          fail('completion_invalid', ref.id, 'work', 'A registration is atomic with its immediately succeeding work', ref);
      } else if (record?.kind === ANSWERS_EVALUATION_KIND) {
        const value = record.value as unknown as AnswersEvaluation;
        if (!object(value) || !same(value.work, reference(before.work)))
          fail('completion_invalid', ref.id, 'work', 'An evaluation enters the work immediately succeeding its own', ref);
        if (!before.answers) fail('completion_invalid', ref.id, 'registration', 'An evaluation needs its registered check', ref);
        if (before.answers.complete) fail('completion_resolved', ref.id, 'assignment', 'A resolved check takes no new evaluation', ref);
        if (!same(value.previous, before.answers.evaluation))
          fail('completion_conflict', ref.id, 'previous', 'The next evaluation follows the latest one of this work', ref);
      } else if (record?.kind === UNIT_REFUSAL_KIND && answersSourceMarks(project, ref, record.value).any) {
        const source = readGateRefusal(store, project, ref);
        if (!evaluations.some(item => same(item, reference(source.evaluation)))
          && !same(before.answers?.evaluation ?? null, reference(source.evaluation)))
          fail('completion_conflict', ref.id, 'evaluation', 'Only a source of the latest evaluation is delivered', ref);
      }
    });
    return true as const;
  });
}
/**
 * The one formula of the check (№1616 п.1): the latest evaluation of the chain; its barrier journal-only groups are the
 * addressed causes the check waits for, and its existing groups point at their producers' grounds. Every delivered
 * source keeps its row in the exact journal cut of the work.
 */
export function answersCheckState(store: Store, binding: Revision<CompletionOwner>, work: Revision<CompletionWork>,
  participant: Sealed<AnswersParticipant>): OmResult<Sealed<AnswersCheckState | null>> {
  if (!(store instanceof Store)) invalid('store');
  bindingShape(binding);
  if (!revisionShape(work) || !(work.value.journal === null || isRef(work.value.journal))) invalid('work');
  if (!object(participant) || !(participant.check === null || revisionShape(participant.check))
    || !(participant.registration === null || isRef(participant.registration)) || !(participant.ceased === null || isRef(participant.ceased))
    || !refsShape(participant.evaluations) || !refsShape(participant.sources)) invalid('participant');
  return run(() => {
    if (!participant.check || !participant.registration) return null;
    const project = binding.value.project, base = { assignment: reference(participant.check), registration: participant.registration,
      ceased: participant.ceased };
    if (participant.sources.length) {
      const journal = work.value.journal;
      if (!journal) fail('completion_invalid', work.id, 'journal', 'Delivered G4b sources keep the exact journal cut', reference(work));
      const rows = take(readJournalAt(store, project, journal)).value.rows;
      for (const source of participant.sources) if (!rows.some(row => same(row.source, source)))
        fail('completion_invalid', source.id, 'journal', 'A delivered G4b source keeps its A2 row in the work journal cut', source);
    }
    // A proved cessation completes the check; its saved evaluations, sources and existing grounds stay (№1616 п.1).
    if (!participant.evaluations.length) return { ...base, evaluation: null, complete: participant.ceased !== null, existing: [],
      waiting: participant.ceased ? [] : [{ reason: 'unevaluated' as const, ref: participant.registration, code: null }] };
    const read = participant.evaluations.map(ref => readEvaluation(store, project, ref));
    const latest = read.filter(item => !read.some(other => same(other.record.value.previous, reference(item.record))));
    if (latest.length !== 1) fail('completion_invalid', work.id, 'evaluation', 'The evaluations of one check form one chain', reference(work));
    const groups = latest[0]!.groups;
    const waiting = participant.ceased ? [] : groups.flatMap(({ proof }) => proof.value.contribution.kind === 'journal-only'
      && proof.value.contribution.barrier ? [{ reason: proof.value.contribution.wait, ref: reference(proof), code: proof.value.finding.code }] : []);
    const existing = unique(groups.flatMap(({ proof }) => proof.value.contribution.kind === 'existing' ? proof.value.contribution.basis : []));
    return { ...base, evaluation: reference(latest[0]!.record), complete: waiting.length === 0, existing, waiting };
  });
}
// ---- H1.0c S6: the H1.0b door of the non-physical check (№1616 п.1, №1446 row 40) ----
export interface PreparedAnswersCheckCessation { record: Revision<CompletionCessation>; writes: Write[]; guards: TransactionGuard[] }
/**
 * The one derivation of a ceased check, for its producer and for readCompletionCessationAt: the registered, still
 * unresolved check of the exact open work, ended only by the proved admission change of its block line. No E1, claim,
 * packet or ledger is invented for it; no current head is read.
 */
function checkCessationValue(store: Store, project: string, request: { binding: Ref; assignment: Ref; work: Ref; cause: CompletionCause }): CompletionCessation {
  const binding = checkedBinding(store, project, request.binding);
  if (!same(reference(binding), exactRef(request.binding)))
    fail('completion_invalid', request.binding.id, 'binding', 'The cessation names its exact binding', exactRef(request.binding));
  const assignment = take(readAnswersGateAssignmentAt(store, project, exactRef(request.assignment)));
  if (!same(assignment.value.binding, reference(binding)))
    fail('completion_foreign', assignment.id, 'binding', 'The ceased check belongs to the binding of the cessation', exactRef(request.assignment));
  const before = take(readCompletionWorkAt(store, project, exactRef(request.work)));
  if (before.work.value.closed || !same(reference(before.binding), reference(binding)))
    fail('completion_invalid', request.work.id, 'work', 'A cessation stands on the open work of its binding', exactRef(request.work));
  if (!before.answers || !same(before.answers.assignment, reference(assignment)))
    fail('completion_invalid', request.work.id, 'registration', 'Only the check registered in this work can cease', exactRef(request.work));
  if (before.answers.complete) fail('completion_resolved', assignment.id, 'assignment',
    'A complete check keeps its evaluation; nothing of it remains to cease', before.answers.evaluation ?? before.answers.registration);
  take(readCompletionCause(store, project, reference(assignment), request.cause));
  return { contract: 'om-completion-cessation/v1', project, binding: reference(binding), assignment: reference(assignment),
    work: reference(before.work), cause: copy(request.cause), disposition: 'check-ceased', remainder: 'answers-gate',
    packet: null, callId: null, physicalId: null, call: null, ledger: null, physical: null, exchange: null, rejection: null,
    ...(request.cause.kind === 'required-record-replaced' ? { variant: AREA_INPUT_VARIANT } : {}) };
}
export function answersCheckCessationValue(store: Store, project: string,
  request: { binding: Ref; assignment: Ref; work: Ref; cause: CompletionCause }): OmResult<Sealed<CompletionCessation>> {
  if (!(store instanceof Store)) invalid('store');
  if (!text(project) || !object(request) || !isRef(request.binding) || !isRef(request.assignment) || !isRef(request.work)) invalid('cessation');
  return run(() => checkCessationValue(store, project, request));
}
function prepareCheckCessation(store: Store, input: { project: string; binding: Ref }): PreparedAnswersCheckCessation {
  const project = input.project, binding = checkedBinding(store, project, input.binding);
  const assignment = reference(answersGateAssignment(binding));
  const id = completionCessationId(project, binding.id, assignment.id), prior = store.get(id);
  if (prior) return { record: take(readCompletionCessationAt(store, project, reference(prior))) as Revision<CompletionCessation>,
    writes: [], guards: [] };
  const head = store.get<CompletionWork>(completionWorkId(project, binding.id));
  if (!head) fail('completion_invalid', binding.id, 'work', 'A managed binding keeps its work registry', reference(binding));
  if (head.value.closed) fail('completion_closed', head.id, 'work', 'Closed work accepts only exact historical repeats', reference(head));
  const before = take(readCompletionWorkAt(store, project, reference(head)));
  if (!before.answers) fail('answers_binding_invalid', binding.id, 'registration', 'Only a registered check can cease', reference(binding));
  if (before.answers.complete) fail('completion_resolved', assignment.id, 'assignment',
    'A complete check keeps its evaluation; nothing of it remains to cease', before.answers.evaluation ?? before.answers.registration);
  const cause = take(prepareCompletionCause(store, project, assignment));
  if (!cause.cause) fail('completion_cause_unproved', assignment.id, 'cause',
    'The check keeps its admission: a moved D1, M6 or physical input does not end it', assignment);
  const value = checkCessationValue(store, project, { binding: reference(binding), assignment, work: reference(head), cause: cause.cause });
  const write: Write = { id, kind: COMPLETION_CESSATION_KIND, expected: 0, value: copy(value) as unknown as Write['value'] };
  const record = recordOf<CompletionCessation>(write);
  // A completion-only product: the work moves by the completion admission of its original line (H1.0b), not by new work.
  const completion = take(prepareCompletionProducts(pendingCallStore(store, [write]), reference(binding), [reference(record)]));
  const writes = bundle([write, ...completion.writes]);
  return { record, writes, guards: external([...cause.guards, ...completion.guards], writes) };
}
function cessationShape(store: unknown, request: unknown): asserts request is { project: string; binding: Ref } {
  if (!(store instanceof Store)) invalid('store');
  if (!object(request) || Object.keys(request).sort().join() !== 'binding,project' || !text(request.project) || !isRef(request.binding))
    invalid('cessation');
}
/** The proved cessation of a still unresolved check, without writing it; an existing one is its historical repeat. */
export function prepareAnswersCheckCessation(store: Store, request: { project: string; binding: Ref }): OmResult<Sealed<PreparedAnswersCheckCessation>> {
  cessationShape(store, request);
  return run(() => prepareCheckCessation(store, request));
}
export function writeAnswersCheckCessation(store: Store, request: { project: string; binding: Ref }): OmResult<Sealed<Revision<CompletionCessation>>> {
  cessationShape(store, request);
  return run(() => {
    const { record, writes, guards } = prepareCheckCessation(store, request);
    if (writes.length) take(writeGuarded(store, { unit: 'G7', target: record.id, writes, guards }));
    return record;
  });
}
/** The journal admits a G4b source only through this typed reader (C36); registered once, when this unit loads. */
function answersJournalReader(store: Store, project: string, source: Ref): OmResult<unknown> {
  return readAnswersGateRefusalAt(store, project, source);
}
registerAnswersSourceReader(answersJournalReader);
