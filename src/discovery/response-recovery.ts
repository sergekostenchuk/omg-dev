import { prepareResearchEnvelope } from './research-protocol.js';
import { readRequestWire, readArchiveBody, prepareContextPreparation, readPreparationRecord, readPreparedContext,
  CONTEXT_PREPARATION_CONTRACT, ARCHIVE_PARTS_CONTRACT, type ContextPreparationBinding } from './request-parts.js';
import { stageNeighbors, STAGE_NEIGHBOR_CONTEXT } from './stage-neighbors.js';
import { earlyResearchStage, earlyResearchFailure, earlyUpstreamTargets, deliveredConceptSections,
  EARLY_RESEARCH_OUTCOME, requireEscalationReply, researchCapacityInput, declareResultCapacity,
  researchResultFailure, researchResultEnvelopeLimit, RESULT_CAPACITY, RESULT_CAPACITY_REFUSAL } from './early-research-outcome.js';
import { consolidationInput, consolidationPage, consolidationFragment,
  CONSOLIDATION_DELIVERY, CONSOLIDATION_FRAGMENT } from './conclusion-consolidation.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Ajv } from 'ajv';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { constants as systemConstants } from 'node:os';
import type { Store, Revision, Write, TransactionGuard } from '../storage/store.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { Environment, RoleBinding } from '../runtime/environment.js';
import { Environments, uniqueTransactionGuards, transactionGuardsCurrent } from '../runtime/environment.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { Graph } from '../graph/model.js';
import { composeLayer } from '../graph/layer-design.js';
import { projectGraph } from '../graph/project.js';
import { obligationHandoff } from '../graph/obligation-handoff.js';
import { requireTaskObligations } from '../graph/task-obligations.js';
import { OBLIGATION_EVIDENCE_PAUSES, requireDocumentarySources } from '../graph/obligation-evidence.js';
import { collectRuntimeEvidence } from '../graph/runtime-evidence.js';
import { technicalProposalFindings, type LegacyPathResolution } from '../graph/research-evidence.js';
import type { TechnicalReport } from '../graph/research-contracts.js';
import type { RecoverableContextSession } from './context-recovery.js';
import { readerPilot, pilotEnvironment, type ReaderPilot } from './reader-pilot.js';
import { archivedContext, contextValue } from './working-context.js';
import { requirePacketMaterialDelivery } from './research-delivery.js';
import { requirePlanningNavigation } from './planning-context.js';
import { contextWorkspace } from './context-workspace.js';

import { canonical, digest, hashJson } from '../canonical.js';
import { reference, isRef, uniqueRefs, type Ref, type Finding, type StageArtifact } from '../pipeline/contracts.js';
import { EngineError, requireCondition } from '../errors.js';
import { Evidence, SOURCE_READ_CONTRACT, SOURCE_READ_CONTRACT_V2, SOURCE_READ_CONTRACT_V3,
  type Source, type Observation, type Selector } from '../evidence/evidence.js';
import { webCaptureId, readWebCaptureBudget, type WebCapture } from './web-research.js';
import { processStart } from '../runtime/process-identity.js';
import { readModelCallRecovery, readLateModelReceipt, recoverModelCall, executionOf } from './model-call-recovery.js';
import { stopCancelledCall, liftedStop } from '../om/run-control.js';
import { isResearchPreview } from './research-preview.js';
import { projectReaderSelection, readerDraftEquivalent, projectResearchPhysicalReply,
  isReservationOnlySessionStep, turnAction, responseAction, webResearchCapability, earlyUnknownEra, EARLY_UNKNOWN,
  projectSynthesisTransition, SYNTHESIS_TRANSITION_REFUSAL_CODES, parseSynthesisSessionV2,
  parseSynthesisSessionV3, synthesisSessionSubject, synthesisStepSubject, SYNTHESIS_SESSION_V3_PREFIX,
  projectResearchContextRead, assertResearchTurnTransition, projectPaidTurnAdmission,
  projectPaidOwnerReview, projectPaidLocalRefusal, projectSearchTurnCompletion,
  projectAddressedWorkspace, projectResearchTurnRevision, projectSourceReadingTurn, isCorrectableLayerDesignFailure,
  managedTurnId, matchAcceptedPaidAnswer, ACTION_RESPONSE_REFUSAL_CODES,
  acceptanceBindingId, acceptanceEraOf, projectAcceptanceBinding,
  ACCEPTANCE_BINDING_CONTRACT, ACCEPTANCE_BINDING_FIELDS, attemptEraOf, projectAttemptBinding,
  type AttemptTurnInputs,
  type SynthesisSessionState, type SynthesisTransitionInput,
  type ManagedResearchTurn, type TurnTransitionProof, type LayerDesignRefusalProof,
  type AcceptedPaidAnswerInputs, type ResearchAcceptanceBinding,
  type ContextReadIdentityInput, type ContextTurnHistoryProof } from './research-consumer-transition.js';
import type { ResearchAction, ResearchAnswer, ResearchAssessment, ResearchRun, ResearchTurn } from './research-model.js';
import { expandLayerDelta, type LayerDelta } from './layer-delta.js';
import { derivePaidReaderResult, readerApplicationAdmission, readReaderResultAt } from './reader.js';
import { findAcceptedPaidAnswerChain } from './research-continuation.js';
import { queuedChildReached } from './reading-plan.js';
import { paidOriginId, paidSessionId, limitedAssessmentRetryScope } from './assessment-session.js';
import { readResearchAssessmentAt, assessmentBindingId } from './research-assessment.js';
import { ATTEMPT_BINDING_CONTRACT, ATTEMPT_BINDING_FIELDS, ATTEMPT_BINDING_KIND, addressedQuestionId, attemptBindingId,
  callAddressesSubject, planSubjectOf, sameSubject, questionDispatchId, type ResearchAttemptBinding, type V7PlanSubject } from './v7-managed-attempt.js';
import { proveAttempt, provePlanQuestions, type V7Attempt } from './v7-plan-questions.js';
import { V7_CONTRACT_ERA } from './v7-contracts.js';

export interface ResponseRecovery {
  projectId: string; declaredBy: string; call: Ref; request: Ref; response: Ref; archive: Ref;
  sessionBefore: Ref; sessionAfter: Ref; state: 'applied';
}
interface RecoveryScope {
  store: Store;
  id: string; project: string; draft: string; question: string; purpose: string; role: RoleBinding;
  profile: Ref | null; session: Ref; archive: Ref; subject: Record<string, any>; payload: unknown;
  origin: Omit<ResponseRecovery, 'sessionAfter' | 'state'>; guards: Ref[]; delivered: boolean; applied: boolean;
}
const current = new AsyncLocalStorage<RecoveryScope>();
const boundary = () => new EngineError('response_recovery_boundary', 'The selected paid response was consumed; no next provider call is allowed during recovery');

/** Recovery is an explicit operator command. Ordinary research has no replay
 * permission from this scope and follows its normal dispatch path. */
export function recoveredResponseBoundary(): void { if (current.getStore()?.applied) throw boundary(); }
export function isResponseRecovery(): boolean { return current.getStore() !== undefined; }
export function markApplicationResponseRecovered(call: Ref, session: Ref): void {
  const scope = current.getStore(); if (!scope) return;
  requireCondition(isRef(call) && isRef(session) && canonical(call) === canonical(scope.origin.call)
    && canonical(session) === canonical(scope.session), 'response_recovery_context_changed',
  'An application may consume only the exact paid response selected by the operator');
  scope.delivered = true;
}
export function recoveryDispatchBoundary(): void { if (current.getStore()?.delivered) throw boundary(); }
export function recoveryConsolidationMode(): boolean | undefined {
  const scope = current.getStore(); return scope ? scope.subject.dispatchMode === 'consolidation' : undefined;
}
export function recoveryAssessmentSessionId(computed: string): string {
  const scope = current.getStore(); return scope?.purpose === 'assessor' ? scope.session.id : computed;
}
export function operatorReplayedResponse(role: RoleBinding, input: string,
  audit?: { draftId: string; questionId?: string; purpose: string; session?: Ref; pilot?: Revision<import('./reader-pilot.js').ReaderPilot> }) {
  const scope = current.getStore(); if (!scope) return null;
  const request = JSON.parse(input);
  requireCondition(audit && audit.draftId === scope.draft && audit.questionId === scope.question && audit.purpose === scope.purpose
    && canonical(audit.session ?? null) === canonical(scope.session) && canonical(role) === canonical(scope.role)
    && canonical(audit.pilot ? reference(audit.pilot) : null) === canonical(scope.profile)
    && canonical(request.subject?.working?.archive ?? null) === canonical(scope.archive),
  'response_recovery_context_changed', 'Recovery must reach the exact original consumer context, role, profile and session');
  scope.delivered = true;
  return { research: scope.payload, subject: scope.subject };
}

/** Commit the ordinary consumer's state and its recovery receipt together.
 * A crash cannot advance a cursor without preserving the applied identity.
 * extraWrites carries the transition's checkpoint into the same transaction. */
export function recoverySessionWrites(write: Write, extraWrites: Write[] = []): { writes: Write[]; guards: TransactionGuard[] } {
  const scope = current.getStore(); if (!scope) return { writes: [], guards: [] };
  requireCondition(scope.delivered && !scope.applied && write.id === scope.session.id && write.expected === scope.session.revision,
    'response_recovery_context_changed', 'An operator replay may update only its exact unconsumed session');
  const value = write.value as RecoverableContextSession;
  requireCondition(!value.workspace?.blocked, 'response_recovery_not_applied', 'An invalid contextual read cannot count as recovered material');
  const sessionAfter = { id: write.id, revision: write.expected + 1, hash: hashJson(write.value) };
  const receipt: Write = { id: scope.id, kind: 'research-response-recovery', expected: 0,
    value: { ...scope.origin, sessionAfter, state: 'applied' } satisfies ResponseRecovery };
  const physical = scope.store.get<ModelCall>(scope.origin.call.id, 1);
  const intentRef = (physical?.value as ModelCall & { consumerIntent?: Ref } | undefined)?.consumerIntent;
  if (!isRef(intentRef)) return { writes: [receipt], guards: scope.guards };
  const original = readResearchConsumerIntent(scope.store, intentRef);
  const head = scope.store.get<ResearchConsumerIntent>(original.id);
  requireCondition(head, 'response_recovery_context_changed', 'The original consumer intent disappeared');
  const application = prepareResearchConsumerApplication(scope.store, reference(head), scope.origin.call,
    [write, ...extraWrites], [scope.session, ...scope.guards]);
  return { writes: [receipt, ...application.writes.slice(1)],
    guards: uniqueTransactionGuards([...scope.guards, ...application.guards]) };
}
export function markRecoveredSessionWritten(additions: { writes: Write[] }): void {
  if (additions.writes.length) current.getStore()!.applied = true;
}

function responseSessionBinding(session: Revision<RecoverableContextSession>) {
  // The v2 synthesis session parses through the shared producer contract
  // (№1555 X52); legacy and assessment sessions keep their own checks.
  if (session.kind === 'synthesis-session' && session.id.startsWith('synthesis-session:v2:')) {
    const parsed = parseSynthesisSessionV2(session.value);
    requireCondition(parsed, 'response_recovery_binding_missing', 'The v2 session must retain its complete research binding');
    return parsed.binding;
  }
  // DR3a3-S1: a v3 session keeps its exact subject; it never falls back to
  // the address-less legacy check below, which knows no subject.
  if (session.kind === 'synthesis-session' && session.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX)) {
    const parsed = parseSynthesisSessionV3(session.value);
    requireCondition(parsed, 'response_recovery_binding_missing', 'The v3 session must retain its complete research binding and subject');
    return parsed.binding;
  }
  const binding = session.value.binding;
  requireCondition(binding && isRef(binding.draft) && isRef(binding.question) && isRef(binding.environment)
    && Array.isArray(binding.inputs) && binding.inputs.every(isRef) && Array.isArray(session.value['notes'])
    && Number.isSafeInteger(session.value['offset']) && Number(session.value['offset']) >= 0,
    'response_recovery_binding_missing', 'The session must retain its complete research binding');
  return binding;
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

export type ResearchConsumerKind = 'synthesis' | 'consolidation' | 'reader' | 'analyst' | 'reading-planner' | 'escalation-assessor';
/** DRS1a2: v2 keeps the analyst call context once in an immutable
 * context-preparation/v1 (request parts) and names it by exact Ref; its cursor
 * carries no context. v1 keeps cursor.context. The saved contract decides. */
export const CONSUMER_INTENT_V1 = 'research-consumer-intent/v1' as const;
export const CONSUMER_INTENT_V2 = 'research-consumer-intent/v2' as const;
export interface ResearchConsumerIntent {
  contract: typeof CONSUMER_INTENT_V1 | typeof CONSUMER_INTENT_V2; projectId: string; kind: ResearchConsumerKind; key: string;
  rootKey: string; generation: number; previous: Ref | null;
  owner: Ref; draft: Ref; question: Ref; role: RoleBinding; dispatch: Environment; profile: Ref | null;
  cursor: Record<string, any>; basis: Ref[]; guards: TransactionGuard[];
  state: 'prepared' | 'running' | 'applied' | 'refused';
  call: Ref | null; request: Ref | null; archive: Ref | null; outputs: Ref[] | null;
  refusal: { code: string; kind: 'provider-failed' | 'terminal' | 'reader-invalid' | 'consumer-invalid';
    call: Ref; request: Ref; response: Ref | null; archive: Ref; capacity?: Record<string, unknown> } | null;
  /** v2 only: the exact immutable preparation (revision 1) holding the context. */
  preparation?: Ref;
}
export type ResearchConsumerIntentInput = Omit<ResearchConsumerIntent,
  'contract' | 'rootKey' | 'generation' | 'previous' | 'state' | 'call' | 'request' | 'archive' | 'outputs' | 'refusal' | 'preparation'>;
const consumerKinds: ResearchConsumerKind[] = ['synthesis', 'consolidation', 'reader', 'analyst', 'reading-planner', 'escalation-assessor'];
function sameLogicalConsumerStep(a: ResearchConsumerIntent, b: ResearchConsumerIntent): boolean {
  if (a.projectId !== b.projectId || a.kind !== b.kind || a.rootKey !== b.rootKey
    || a.owner.id !== b.owner.id || a.draft.id !== b.draft.id || a.question.id !== b.question.id)
    return false;
  // DR3a3-K: one Question at two plan-questions — or one plan-question id in
  // two plan editions — is two logical steps; the subject is part of the step.
  if (!sameSubject(cursorSubject(a), cursorSubject(b))) return false;
  if (a.kind === 'reader') return a.cursor.rootKey === b.cursor.rootKey
    && canonical(a.cursor.child) === canonical(b.cursor.child)
    && a.cursor.purpose === b.cursor.purpose;
  if (a.kind === 'synthesis' || a.kind === 'consolidation')
    return a.cursor.sessionId === b.cursor.sessionId && a.cursor.offset === b.cursor.offset
      && a.cursor.materialOffset === b.cursor.materialOffset;
  return a.cursor.run === b.cursor.run && a.cursor.turn === b.cursor.turn;
}
function samePreparedSubject(store: Store, a: ResearchConsumerIntent, b: ResearchConsumerIntent): boolean {
  const fixed = (value: ResearchConsumerIntent) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['role', 'dispatch', 'profile', 'guards', ...(value.kind === 'reader' ? ['draft'] : [])].includes(key))
    .map(([key, item]) => key === 'cursor' ? [key, Object.fromEntries(Object.entries(item)
      .filter(([name]) => !['resultCapacity', 'resultCapacityContract', 'resultCapacityPrompt'].includes(name)))] : [key, item]));
  return canonical(fixed(a)) === canonical(fixed(b))
    && (a.kind !== 'reader' || readerDraftEquivalent(store, a.draft, b.draft, a.question));
}
function consumerInvalid(id: string, message: string): never {
  throw new EngineError('research_consumer_intent_invalid', `[${id}] ${message}`);
}
/** DR3a3-K: the attempt subject a saved intent's cursor declares (null for
 * the field-question path). The Question basis stays intent.question. */
function cursorSubject(intent: ResearchConsumerIntent, id = 'research-consumer-intent'): V7PlanSubject | null {
  try { return planSubjectOf(intent.cursor); }
  catch (error) {
    if (error instanceof EngineError) consumerInvalid(id, error.message);
    throw error;
  }
}
/** The consumers whose application writes an original turn (O@1): the runner
 * application and the synthesis handoff. Only these may name an attempt subject. */
const SUBJECT_KINDS: readonly ResearchConsumerKind[] = ['analyst', 'reading-planner', 'synthesis', 'consolidation'];
export function synthesisTurnMatches(store: Store, intent: Revision<ResearchConsumerIntent>,
  session: Revision<{ result: unknown }>, action: unknown): boolean {
  if (canonical(session.value.result) === canonical(action)) return true;
  // A pause is control flow: the session deliberately retains result:null so
  // a later explicit run may continue. Its one handoff still has to come from
  // the exact paid response, never from a caller's proposed turn action.
  if (session.value.result !== null || !object(action) || action.action !== 'pause') return false;
  const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  return paid.kind === 'response' && object(paid.payload) && canonical(paid.payload) === canonical(action);
}
export function researchConsumerIntentId(projectId: string, kind: ResearchConsumerKind, key: string, generation = 0): string {
  if (typeof projectId !== 'string' || !projectId || !consumerKinds.includes(kind) || typeof key !== 'string' || !key
    || !Number.isSafeInteger(generation) || generation < 0)
    consumerInvalid('research-consumer-intent', 'The intent address needs a project, consumer kind and stable operation key');
  return `research-consumer-intent:v1:${hashJson([projectId, kind, key, generation])}`;
}
function pendingRef(write: Write): Ref { return { id: write.id, revision: write.expected + 1, hash: hashJson(write.value) }; }
function consumerShape(value: unknown, id: string): asserts value is ResearchConsumerIntent {
  if (!object(value)) consumerInvalid(id, 'The saved consumer intent is not a record');
  // DRS1a2: the contract is read first; v2 adds only its exact preparation and
  // drops cursor.context — analyst only.
  const v2 = value.contract === CONSUMER_INTENT_V2;
  if (Object.keys(value).sort().join(',') !== ['archive', 'basis', 'call', 'contract', 'cursor', 'dispatch', 'draft',
    'generation', 'guards', 'key', 'kind', 'outputs', 'owner', 'previous', 'profile', 'projectId', 'question',
    'refusal', 'request', 'role', 'rootKey', 'state', ...(v2 ? ['preparation'] : [])].sort().join(',')
    || !(value.contract === CONSUMER_INTENT_V1 || v2) || typeof value.projectId !== 'string' || !value.projectId
    || !consumerKinds.includes(value.kind) || typeof value.key !== 'string' || !value.key
    || value.rootKey !== value.key || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !(value.previous === null || isRef(value.previous))
    || !isRef(value.owner) || !isRef(value.draft) || !isRef(value.question)
    || !object(value.role) || !object(value.dispatch) || value.dispatch.projectId !== value.projectId
    || !(value.profile === null || isRef(value.profile)) || !object(value.cursor)
    || (v2 ? value.kind !== 'analyst' || !isRef(value.preparation) || value.preparation.revision !== 1
      || Object.hasOwn(value.cursor, 'context') : !object(value.cursor.context))
    || typeof (value.cursor.prompt ?? value.cursor.instruction) !== 'string'
    || !Array.isArray(value.basis) || !value.basis.every(isRef)
    || !Array.isArray(value.guards) || canonical(uniqueTransactionGuards(value.guards)) !== canonical(value.guards)
    || !['prepared', 'running', 'applied', 'refused'].includes(value.state)
    || !(value.call === null || isRef(value.call)) || !(value.request === null || isRef(value.request))
    || !(value.archive === null || isRef(value.archive))
    || !(value.outputs === null || Array.isArray(value.outputs) && value.outputs.every(isRef))
    || !(value.refusal === null || object(value.refusal) && Object.keys(value.refusal).sort().join(',') === (value.refusal.capacity === undefined ? 'archive,call,code,kind,request,response' : 'archive,call,capacity,code,kind,request,response')
      && ['provider-failed', 'terminal', 'reader-invalid', 'consumer-invalid'].includes(value.refusal.kind)
      && typeof value.refusal.code === 'string' && !!value.refusal.code
      && isRef(value.refusal.call) && isRef(value.refusal.request)
      && (value.refusal.response === null || isRef(value.refusal.response)) && isRef(value.refusal.archive)))
    consumerInvalid(id, 'The saved consumer intent has an incomplete or incompatible producer contract');
  if (value.kind === 'reader') {
    if (typeof value.cursor.rootKey !== 'string' || !value.cursor.rootKey || !Array.isArray(value.cursor.rootSourceOrder)
      || value.cursor.rootSourceOrder.length === 0
      || !value.cursor.rootSourceOrder.every((entry: unknown, index: number) => object(entry) && entry.sourceIndex === index
        && isRef(entry.source) && object(entry.window) && Number.isSafeInteger(entry.window.start)
        && Number.isSafeInteger(entry.window.end) && entry.window.start >= 0 && entry.window.end >= entry.window.start)
      || !Array.isArray(value.cursor.sourceOrder)
      || !Array.isArray(value.cursor.reusedFrom) || !value.cursor.reusedFrom.every(isRef)
      || !Array.isArray(value.cursor.child) || !value.cursor.child.every((part: unknown) => Number.isSafeInteger(part) && Number(part) >= 0)
      || !value.cursor.sourceOrder.every((entry: unknown, index: number) => object(entry) && entry.sourceIndex === index
        && isRef(entry.source) && object(entry.window) && Number.isSafeInteger(entry.window.start)
        && Number.isSafeInteger(entry.window.end) && entry.window.start >= 0 && entry.window.end >= entry.window.start))
      consumerInvalid(id, 'The reader intent lost source order, exact windows, reuse proof or child position');
  } else if (value.kind === 'synthesis' || value.kind === 'consolidation') {
    if (typeof value.cursor.sessionId !== 'string' || value.cursor.sessionId !== value.owner.id
      || !Number.isSafeInteger(value.cursor.offset) || value.cursor.offset < 0
      || !Object.hasOwn(value.cursor, 'materialEncoding')
      || !(value.cursor.materialEncoding === null || typeof value.cursor.materialEncoding === 'string'))
      consumerInvalid(id, 'The synthesis intent lost its exact session cursor');
  } else if (typeof value.cursor.run !== 'string' || value.cursor.run !== value.owner.id
    || !Number.isSafeInteger(value.cursor.turn) || value.cursor.turn <= 0)
    consumerInvalid(id, 'The runner intent lost its exact run and turn');
  if (cursorSubject(value as ResearchConsumerIntent, id) !== null && !SUBJECT_KINDS.includes(value.kind))
    consumerInvalid(id, 'Only a consumer that writes an original turn can name an attempt subject');
  const required = uniqueTransactionGuards([value.owner, value.draft, value.question, ...value.basis,
    ...(value.profile ? [value.profile] : [])]);
  if (!required.every(guard => value.guards.some((saved: TransactionGuard) => canonical(saved) === canonical(guard))))
    consumerInvalid(id, 'The intent omitted an original positive transaction dependency');
  if (value.state === 'prepared' ? value.call !== null || value.request !== null || value.archive !== null || value.outputs !== null
      || value.refusal !== null
    : value.call === null || value.request === null || value.archive === null
      || value.state === 'running' && value.outputs !== null
      || value.state === 'running' && value.refusal !== null
      || value.state === 'applied' && (!value.outputs || value.outputs.length === 0 || value.refusal !== null)
      || value.state === 'refused' && (value.outputs !== null || value.refusal === null))
    consumerInvalid(id, 'The intent state contradicts its exact physical and application references');
}
/** Only the explicit new C producer declares these reads. Old paid cursors keep
 * their original context and never acquire today's neighboring heads. */
function requireEscalationNeighbors(store: Store, intent: ResearchConsumerIntent, id: string): void {
  if (intent.kind !== 'escalation-assessor' || intent.cursor.contextContract === undefined) return;
  if (intent.cursor.contextContract !== STAGE_NEIGHBOR_CONTEXT
    || intent.cursor.context.assessmentContextContract !== STAGE_NEIGHBOR_CONTEXT
    || !object(intent.cursor.neighborReads) || intent.cursor.neighborReads.contract !== 'assessment-read/v1')
    consumerInvalid(id, 'The escalation lost its declared stage material and exact read proof');
  const draft = store.get<DiscoveryDraft>(intent.draft.id, intent.draft.revision);
  const question = store.get<Question>(intent.question.id, intent.question.revision);
  if (!draft || !question || canonical(reference(draft)) !== canonical(intent.draft)
    || canonical(reference(question)) !== canonical(intent.question))
    consumerInvalid(id, 'The escalation lost its original draft or question');
  const view = assessmentReadView(store, intent.cursor.neighborReads as AssessmentReadProof);
  const neighbors = stageNeighbors(view.store, draft, question);
  view.finish();
  if (!neighbors.context || intent.cursor.context.stageNeighbors === undefined
    || canonical(neighbors.context) !== canonical(intent.cursor.context.stageNeighbors)
    || neighbors.guards.some(ref => !intent.guards.some(guard => canonical(guard) === canonical(ref))
      || !intent.basis.some(basis => canonical(basis) === canonical(ref))))
    consumerInvalid(id, 'The escalation material does not derive from its exact accepted neighbors');
}
/** G5a (№6218/6200): the saved intent is a commit. Its transitions, capacity
 * and generation chain are proved once by the producer writing each revision
 * (prepare/reservation/refusal/application, the C23 rebind and the synthesis
 * delivery append); a substituted byte is om-fsck's finding, not a read check.
 * The reader therefore trusts the exact saved row: kind, exact Ref, producer
 * address and field shape — without recomputing hashes, capacity or history. */
export function readResearchConsumerIntent(store: Store, ref: Ref): Revision<ResearchConsumerIntent> {
  if (!store || typeof store.get !== 'function' || !isRef(ref)) consumerInvalid('research-consumer-intent', 'An exact saved intent is required');
  const saved = store.get<ResearchConsumerIntent>(ref.id, ref.revision);
  if (!saved || saved.kind !== 'research-consumer-intent' || canonical(reference(saved)) !== canonical(ref))
    consumerInvalid(ref.id, 'The exact intent is missing or changed');
  consumerShape(saved.value, saved.id);
  if (saved.id !== researchConsumerIntentId(saved.value.projectId, saved.value.kind, saved.value.key, saved.value.generation))
    consumerInvalid(saved.id, 'The intent address does not match its saved producer');
  // DRS1a2 (P2-03): a v2 intent stands on the one exact preparation of its own
  // step — the record and its binding, without re-reading history or parts.
  if (saved.value.contract === CONSUMER_INTENT_V2)
    readPreparationRecord(store, saved.value.preparation!, preparationBinding(saved.value, saved.id));
  return saved;
}
/** DRS1a2: the step a v2 preparation must be bound to — from the intent's own
 * saved fields: project/draft/Question/owner, kind, instruction, the exact
 * attempt subject and the immutable action-era fields of its cursor. */
export function preparationBinding(intent: ResearchConsumerIntent, id = 'research-consumer-intent'): ContextPreparationBinding {
  const cursor = intent.cursor;
  return { projectId: intent.projectId, draft: intent.draft, question: intent.question, owner: intent.owner,
    kind: 'analyst', instruction: cursor.prompt ?? cursor.instruction, subject: cursorSubject(intent, id),
    earlyActions: typeof cursor.earlyActions === 'string' ? cursor.earlyActions : null,
    graphBase: isRef(cursor.graphBase) ? cursor.graphBase : null };
}
/** DRS1a2: the exact call context of a saved intent by its own contract — v1
 * its cursor.context, v2 the context restored from its bound preparation. The
 * contract decides before any representation is chosen; nothing else (a
 * caller field, a pending value) substitutes it. */
export function consumerIntentContext(store: Store, intent: ResearchConsumerIntent, id = 'research-consumer-intent'): Record<string, any> {
  if (intent.contract === CONSUMER_INTENT_V1) return intent.cursor.context;
  if (intent.contract === CONSUMER_INTENT_V2)
    return readPreparedContext(store, intent.preparation!, preparationBinding(intent, id)).context;
  consumerInvalid(id, 'The consumer intent names an unknown contract');
}
/** A queued managed plan owns its children even though their old addresses do
 * not contain the managed-era marker. Find the exact queue before deciding
 * which historical contract applies to a completed child search. */
function managedSearchParent(store: Store, child: Revision<Record<string, any>>) {
  const matches = store.list<ResearchTurn>('research-turn').flatMap(head => {
    if (!head.id.startsWith('research-turn:v1:')) return [];
    const original = store.get<ResearchTurn>(head.id, 1);
    const queued = store.get<ResearchTurn>(head.id, 2);
    const children = (queued?.value.observation as { children?: unknown } | null)?.children;
    if (!original || !queued || !Array.isArray(children)
      || !children.some(ref => queuedChildReached(store, ref, child as Revision<ResearchTurn>))) return [];
    return [{ original, queued }];
  });
  if (matches.length > 1) consumerInvalid(child.id, 'Several managed reading plans claim the same child');
  return matches[0] ?? null;
}

/** DR3a3-S3: a legacy-address turn carries a plan subject only as the lineage
 * of its exact planner parent — a paid planning-mode O@1 of the attempt era
 * with the same subject. A child of such a parent cannot lose it, a child of
 * a field-path parent cannot gain one, and the lineage never makes the child
 * an attempt. A field-path child whose parent is not saved keeps its rules. */
function queuedChildLineage(store: Store, saved: Revision<Record<string, any>>): void {
  const plannedBy = saved.value.plannedBy;
  const parent = isRef(plannedBy) ? store.get<Record<string, any>>(plannedBy.id, plannedBy.revision) : null;
  const exact = !!parent && parent.kind === 'research-turn' && canonical(reference(parent)) === canonical(plannedBy);
  if (!Object.hasOwn(saved.value, 'subject') && !exact) return;
  let child: V7PlanSubject | null = null, owner: V7PlanSubject | null = null;
  try { child = planSubjectOf(saved.value); owner = exact ? planSubjectOf(parent!.value) : null; }
  catch { consumerInvalid(saved.id, 'The queued turn or its planner parent carries a damaged plan subject'); }
  if (child && (!exact || parent!.value.attemptContract !== ATTEMPT_BINDING_CONTRACT
    || parent!.value.dispatchMode !== 'planning' || isRef(parent!.value.plannedBy))
    || !sameSubject(child, owner))
    consumerInvalid(saved.id, 'The queued turn subject differs from the subject of its exact planner parent');
}

/** The saved process result is a bounded capture made with the completed turn.
 * Recompute its entire content-addressed value and the turn from exact pending
 * action, queued parent and every saved Source byte; today's files are not a
 * historical input. */
function readManagedSearchCompletion(store: Store, before: Revision<Record<string, any>>,
  after: Revision<Record<string, any>>, parent = managedSearchParent(store, before)) {
  const action = turnAction(before.value);
  if (action.action !== 'search' || after.value.status !== 'completed' || after.value.error !== null)
    consumerInvalid(before.id, 'A completed managed search lost its exact pending action');
  const captureRef = after.value.observation?.capture;
  const capture = isRef(captureRef) ? store.get<Record<string, any>>(captureRef.id, captureRef.revision) : null;
  if (!capture || capture.kind !== 'research-search-capture' || capture.revision !== 1
    || canonical(reference(capture)) !== canonical(captureRef)
    || hashJson(capture.value) !== capture.hash || !object(capture.value))
    consumerInvalid(before.id, 'The managed search lost its exact immutable capture');
  if (parent) readResearchConsumerTurn(store, reference(parent.queued));
  const intentRef = parent ? (parent.original.value as ManagedResearchTurn).consumerIntent
    : (before.value as ManagedResearchTurn).consumerIntent;
  if (!isRef(intentRef)) consumerInvalid(before.id, 'The search lost its paid consumer origin');
  const intent = readResearchConsumerIntent(store, intentRef);
  if (capture.value.workspace !== intent.value.dispatch.workspace)
    consumerInvalid(before.id, 'The search capture changed the original workspace');
  const sources = Array.isArray(capture.value.sources) ? capture.value.sources.map((ref: unknown) => {
    const source = isRef(ref) ? store.get<Source>(ref.id, ref.revision) : null;
    if (!source || source.kind !== 'source' || canonical(reference(source)) !== canonical(ref)
      || hashJson(source.value) !== source.hash || source.value.projectId !== intent.value.projectId)
      consumerInvalid(before.id, 'The search capture lost exact Source bytes');
    return { ref: reference(source), value: source.value };
  }) : null;
  if (!sources) consumerInvalid(before.id, 'The search capture lost its full Source snapshot');
  const projected = projectSearchTurnCompletion({ projectId: intent.value.projectId,
    turn: before as Revision<ResearchTurn>, store, ...(parent ? { parent } : {}),
    query: action.query, workspace: intent.value.dispatch.workspace,
    sources, process: capture.value.process, searchContract: capture.value.contract });
  if (capture.id !== projected.capture.id
    || canonical(reference(capture)) !== canonical(projected.capture.ref)
    || canonical(capture.value) !== canonical(projected.capture.value)
    || canonical(after.value) !== canonical(projected.turn))
    consumerInvalid(before.id, 'The completed search differs from its exact capture projection');
}

/* The technical refusal record is written by the runner together with the
 * completed turn in one atomic set; the historical reader below re-derives the
 * same findings from the saved reads, canonical workspace, captured path
 * resolutions and runtime grounds — never today's filesystem (№1745-1). */
export const PROPOSAL_REFUSAL = 'research-proposal-refusal/v1' as const;
const PROPOSAL_REFUSAL_MESSAGE = 'Correct the typed proposal findings before model assessment';
type AssessmentRuntime = ReturnType<typeof collectRuntimeEvidence>;
export interface ManagedProposalRefusal {
  contract: typeof PROPOSAL_REFUSAL; projectId: string; turn: Ref; pending: Ref;
  draft: Ref; question: Ref; environment: Ref; graph: Ref; root: string;
  legacyPaths: LegacyPathResolution[]; reads: AssessmentReadProof;
  runtime: AssessmentRuntime; findings: Finding[];
}
export class PreparedManagedProposalRefusal extends EngineError {
  constructor(public readonly prepared: { write: Write; ref: Ref; guards: TransactionGuard[] },
    findings: Finding[]) {
    super('research_proposal_invalid', PROPOSAL_REFUSAL_MESSAGE, findings);
  }
}
export const proposalRefusalId = (projectId: string, turnId: string) =>
  `research-proposal-refusal:v1:${hashJson({ projectId, turnId })}`;
function exactRecord<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  requireCondition(isRef(ref), 'research_assessment_binding_invalid', 'An exact assessment source is required');
  const saved = store.get<T>(ref.id, ref.revision);
  requireCondition(saved?.kind === kind && canonical(reference(saved)) === canonical(ref)
    && hashJson(saved.value) === saved.hash,
    'research_assessment_binding_invalid', `[${ref.id}] Exact source is missing, foreign or changed`);
  return saved;
}
function checkAssessmentRuntimeMaterials(projectId: string,
  runtime: ReturnType<typeof collectRuntimeEvidence>, originId: string): void {
  if (!object(runtime) || Object.keys(runtime).sort().join(',') !== 'admissionGuards,guards,proofs,supporting'
    || !Array.isArray(runtime.proofs) || !Array.isArray(runtime.supporting)
    || !Array.isArray(runtime.guards) || !Array.isArray(runtime.admissionGuards)
    || !runtime.guards.every(guard => isRef(guard) && Object.keys(guard).sort().join(',') === 'hash,id,revision')
    || canonical(runtime.guards) !== canonical([...new Map(runtime.guards.map((guard: Ref) => [canonical(guard), guard])).values()]
      .sort((left, right) => `${left.id}:${left.revision}:${left.hash}`.localeCompare(`${right.id}:${right.revision}:${right.hash}`)))
    || !runtime.admissionGuards.every(guard => object(guard)
      && ('absent' in guard ? Object.keys(guard).sort().join(',') === 'absent,id'
        && typeof guard.id === 'string' && guard.id.length > 0 && guard.absent === true
        : isRef(guard) && Object.keys(guard).sort().join(',') === 'hash,id,revision'))
    || canonical(runtime.admissionGuards) !== canonical(uniqueTransactionGuards(runtime.admissionGuards)))
    consumerInvalid(originId, 'The original runtime result is incomplete or duplicated');
  for (const proof of runtime.proofs) {
    if (!object(proof) || Object.keys(proof).sort().join(',') !== 'authorization,code,document,obligation,observation,source'
      || typeof proof.obligation !== 'string' || !proof.obligation || typeof proof.document !== 'string' || !proof.document
      || !isRef(proof.observation) || !isRef(proof.source) || !isRef(proof.authorization)
      || !Array.isArray(proof.code) || !proof.code.every(isRef))
      consumerInvalid(originId, 'A saved runtime proof lost its exact sources');
  }
  for (const observation of runtime.supporting) {
    if (!object(observation) || Object.keys(observation).sort().join(',') !== 'projectId,selector,source,value'
      || observation.projectId !== projectId || !isRef(observation.source)
      || !object(observation.selector) || !Object.hasOwn(observation, 'value'))
      consumerInvalid(originId, 'A supporting runtime observation is incomplete or foreign');
  }
}
/** Prepare the pre-assessor refusal for one atomic write with the completed
 * turn. A local technical finding has no authority without the exact captured
 * reads. */
export function prepareManagedProposalRefusal(projectId: string, turn: Ref, pending: Ref,
  draft: Revision<DiscoveryDraft>, question: Revision<Question>, environment: Revision<Environment>,
  graph: Ref, root: string, legacyPaths: LegacyPathResolution[], reads: AssessmentReadProof,
  runtime: AssessmentRuntime, findings: Finding[], guards: TransactionGuard[]): PreparedManagedProposalRefusal {
  requireCondition(isRef(turn) && isRef(pending) && turn.id === pending.id && turn.revision === 1
    && isRef(graph) && graph.id === `graph:${projectId}` && isAbsolute(root) && normalize(root) === root
    && reads.contract === 'assessment-read/v1' && findings.length > 0
    && !findings.some(finding => OBLIGATION_EVIDENCE_PAUSES.has(finding.code)),
  'research_proposal_refusal_invalid', 'A technical refusal needs its exact pre-assessor sources and non-pausing findings');
  const value: ManagedProposalRefusal = { contract: PROPOSAL_REFUSAL, projectId, turn, pending,
    draft: reference(draft), question: reference(question), environment: reference(environment),
    graph, root, legacyPaths, reads, runtime, findings };
  const id = proposalRefusalId(projectId, turn.id);
  const write: Write = { id, kind: 'research-proposal-refusal', expected: 0, value };
  return new PreparedManagedProposalRefusal({ write, ref: { id, revision: 1, hash: hashJson(value) },
    guards: uniqueTransactionGuards([pending, reference(draft), reference(question), reference(environment), graph,
      ...runtime.guards, ...runtime.admissionGuards, ...guards, { id, absent: true },
      { id: paidOriginId(projectId, turn.id), absent: true }]) }, findings);
}

/** Read-only store projection of the exact delta.base and the complete revises
 * chain (№1745-3). Head reads resolve only inside the pinned set — no fallback
 * to today's heads — and every other access method stays unreachable. */
export function pinnedLayerDeltaStore(store: Store, delta: LayerDelta): Store {
  const pinned = new Map<string, Revision<unknown>>();
  const pin = (ref: Ref, kind: string): Revision<unknown> => {
    const record = store.get(ref.id, ref.revision);
    requireCondition(record?.kind === kind && canonical(reference(record)) === canonical(ref)
      && hashJson(record.value) === record.hash,
      'layer_delta_base_invalid', 'The historical layer view lost an exact pinned revision');
    return record;
  };
  pinned.set(delta.base.id, pin(delta.base, 'graph'));
  const seen = new Set<string>();
  let previous = delta.revises;
  while (previous) {
    requireCondition(isRef(previous) && !seen.has(previous.id),
      'layer_delta_revision_invalid', 'Invalid or cyclic proposal revision');
    seen.add(previous.id);
    const turn = pin(previous, 'research-turn');
    pinned.set(previous.id, turn);
    const action = (turn.value as { action?: unknown }).action;
    previous = object(action) ? (action as LayerDelta).revises : undefined;
  }
  return new Proxy(store, { get(target, key) {
    if (key === 'get') return <T>(id: string, revision?: number): Revision<T> | null => {
      if (revision !== undefined) return store.get<T>(id, revision);
      const record = pinned.get(id);
      requireCondition(record !== undefined, 'layer_delta_base_invalid',
        'Historical layer reads are limited to the exact saved base and revision chain');
      return record as Revision<T>;
    };
    const value = Reflect.get(target, key, target);
    if (typeof value === 'function')
      return () => { throw new EngineError('layer_delta_base_invalid',
        'The historical layer view is read-only and has no listing surface'); };
    return value;
  } });
}

/** A rejected design is a correction opportunity only when the original paid
 * answer reproduces a correctable failure against its exact admitted graph.
 * Historical reads use saved revisions and the pinned layer view; live
 * completion also needs current draft, question and graph heads. */
export function projectPaidLayerDesignRefusal(store: Store, producer: Revision<ResearchConsumerIntent>,
  before: Revision<Record<string, any>>, admission: 'current' | 'historical' = 'historical'):
  { proof: LayerDesignRefusalProof; turn: ManagedResearchTurn; failure: EngineError } | null {
  const action = turnAction(before.value);
  const delivery = producer.value.cursor.delivery;
  if ((action.action !== 'answer' && action.action !== 'answer_delta') || before.kind !== 'research-turn'
    || before.value.status !== 'pending' || hashJson(before.value) !== before.hash
    || before.value.contract !== 'research-consumer-turn/v1'
    || !isRef(before.value.consumerIntent) || before.value.consumerIntent.id !== producer.id
    || !isRef(before.value.question)
    || canonical(before.value.question) !== canonical(producer.value.question)
    || action.question !== producer.value.question.id
    || !(['analyst', 'reading-planner'].includes(producer.value.kind)
      && producer.value.cursor.run === before.value.run
      && producer.value.cursor.turn === before.value.number
      || producer.value.kind === 'synthesis'
      && object(delivery)
      && delivery.run === before.value.run
      && delivery.turn === before.value.number)) return null;
  const producerContext = consumerIntentContext(store, producer.value, producer.id);
  const graphRef = action.action === 'answer_delta' ? action.base
    : producer.value.cursor.graphBase ?? (producer.value.profile ? producerContext?.graphBase : null);
  if (!isRef(graphRef)
    || action.action === 'answer_delta' && (!producer.value.profile
      || !isRef(producerContext?.graphBase)
      || canonical(graphRef) !== canonical(producerContext.graphBase))
    || isRef(producer.value.cursor.graphBase)
      && canonical(graphRef) !== canonical(producer.value.cursor.graphBase)
    || action.action === 'answer' && !producer.value.profile
      && !producer.value.guards.some(guard => canonical(guard) === canonical(graphRef))) return null;
  const draftRef = producer.value.draft, questionRef = producer.value.question;
  const draft = store.get<DiscoveryDraft>(draftRef.id, draftRef.revision);
  const question = store.get<Question>(questionRef.id, questionRef.revision);
  const graph = store.get<Graph>(graphRef.id, graphRef.revision);
  if (!draft || draft.kind !== 'discovery-draft' || canonical(reference(draft)) !== canonical(draftRef)
    || hashJson(draft.value) !== draft.hash
    || !question || question.kind !== 'question' || canonical(reference(question)) !== canonical(questionRef)
    || hashJson(question.value) !== question.hash
    || !graph || graph.kind !== 'graph' || canonical(reference(graph)) !== canonical(graphRef)
    || hashJson(graph.value) !== graph.hash
    || draft.value.projectId !== producer.value.projectId
    || question.value.projectId !== producer.value.projectId || question.value.draftId !== draft.id
    || !draft.value.questions.includes(question.id) || question.value.spec.field !== 'layerDesign'
    || draft.value.stage !== 'om-g2' || !['R1', 'R2'].includes(draft.value.level)
    || graph.id !== `graph:${producer.value.projectId}`) return null;
  if (action.action === 'answer' && !producer.value.profile && draft.value.level !== 'R2') return null;
  if (producer.value.profile) {
    if (!isRef(producerContext?.graphBase)
      || canonical(producerContext.graphBase) !== canonical(graphRef)) return null;
  } else {
    const upper = draft.value.level === 'R2' ? 2 : 1;
    const map = producerContext?.operationMap;
    const layerRef = map?.ref;
    const layer = isRef(layerRef) ? store.get<{ projection: Graph }>(layerRef.id, layerRef.revision) : null;
    if (!isRef(layerRef) || !layer || layer.kind !== 'graph-layer'
      || canonical(reference(layer)) !== canonical(layerRef)
      || hashJson(layer.value) !== layer.hash
      || layer.id !== `graph-layer:${producer.value.projectId}:${upper}`
      || !draft.value.inputs.some(ref => canonical(ref) === canonical(layerRef))
      || map.level !== upper
      || canonical(map.graph) !== canonical(layer.value.projection)
      || canonical(projectGraph(graph.value, upper)) !== canonical(layer.value.projection)) return null;
  }
  if (admission === 'current') {
    const currentDraft = store.get(draft.id), currentQuestion = store.get(question.id), currentGraph = store.get(graph.id);
    if (!currentDraft || !currentQuestion || !currentGraph
      || canonical(reference(currentDraft)) !== canonical(draftRef)
      || canonical(reference(currentQuestion)) !== canonical(questionRef)
      || canonical(reference(currentGraph)) !== canonical(graphRef)) return null;
  }
  // A correction source must be a prior proved turn in this same run. A
  // rehashed standalone record cannot lend authority to a paid refusal.
  let prior = action.action === 'answer_delta' ? action.revises : null;
  const seen = new Set<string>();
  while (prior) {
    if (!isRef(prior) || seen.has(prior.id)) return null;
    seen.add(prior.id);
    const saved = store.get<ResearchTurn>(prior.id, prior.revision);
    if (!saved || saved.kind !== 'research-turn' || canonical(reference(saved)) !== canonical(prior)
      || hashJson(saved.value) !== saved.hash || saved.value.status !== 'completed'
      || saved.value.run !== before.value.run || saved.value.number >= before.value.number
      || canonical(saved.value.question) !== canonical(questionRef)
      || (saved.value as ManagedResearchTurn).contract !== 'research-consumer-turn/v1') return null;
    try { readResearchConsumerTurn(store, prior); }
    catch { return null; }
    const previousAction = turnAction(saved.value);
    if (previousAction.action !== 'answer_delta'
      || canonical(previousAction.base) !== canonical(graphRef)) return null;
    prior = previousAction.revises;
  }
  const pinned = pinnedLayerDeltaStore(store,
    action.action === 'answer_delta' ? action : { base: graphRef, upserts: {}, removes: {} });
  let failure: EngineError;
  try {
    if (action.action === 'answer_delta') expandLayerDelta(pinned, draft, question, action);
    else if (producer.value.profile)
      throw new EngineError('layer_delta_required', 'The L2 experiment accepts changes, not a regenerated full graph');
    else {
      requireCondition(new Ajv({ strict: true, allowUnionTypes: true }).compile(question.value.spec.schema as object)(action.value),
        'answer_invalid', 'Proposed research result does not satisfy its consumer contract');
      const handoff = obligationHandoff(store, draft.value.projectId, draft.value.inputs);
      const assembled = composeLayer(graph.value, 3, action.value, question.value.spec.layerAssembly);
      if (handoff) requireTaskObligations(store, draft.value.projectId, assembled, handoff);
    }
    return null;
  }
  catch (error) {
    if (!(error instanceof EngineError) || !isCorrectableLayerDesignFailure(error)) return null;
    failure = error;
  }
  const proof: LayerDesignRefusalProof = { kind: 'layer-design-refusal',
    projectId: producer.value.projectId, draft, question, graph,
    failure: { code: failure.code, message: failure.message, details: failure.details } };
  return { proof, turn: projectResearchTurnRevision(before.value as ManagedResearchTurn, proof), failure };
}

/** Historical refusal replays the same technical precheck over exact saved
 * input revisions; changed current heads and filesystem are not its inputs. */
export function readManagedProposalRefusalAt(store: Store, projectId: string, turnId: string,
  refusalRef: Ref): Revision<ManagedProposalRefusal> {
  const id = proposalRefusalId(projectId, turnId);
  requireCondition(isRef(refusalRef) && refusalRef.id === id && refusalRef.revision === 1,
    'research_proposal_refusal_invalid', 'A managed refusal needs its exact immutable address');
  const record = exactRecord<ManagedProposalRefusal>(store, refusalRef, 'research-proposal-refusal');
  const value = record.value;
  const fields = ['contract', 'projectId', 'turn', 'pending', 'draft', 'question', 'environment',
    'graph', 'root', 'legacyPaths', 'reads', 'runtime', 'findings'];
  requireCondition(record.id === id && record.revision === 1
    && object(value)
    && Object.keys(value).sort().join(',') === fields.sort().join(',')
    && value.contract === PROPOSAL_REFUSAL && value.projectId === projectId
    && isRef(value.turn) && value.turn.id === turnId && value.turn.revision === 1
    && isRef(value.pending) && value.pending.id === turnId
    && isRef(value.graph) && value.graph.id === `graph:${projectId}`
    && typeof value.root === 'string' && isAbsolute(value.root) && normalize(value.root) === value.root
    && Array.isArray(value.legacyPaths) && value.legacyPaths.every((item: unknown) =>
      object(item)
      && Object.keys(item).sort().join(',') === 'path,resolved'
      && typeof item.path === 'string' && item.path.length > 0 && typeof item.resolved === 'string'
      && isAbsolute(item.resolved) && normalize(item.resolved) === item.resolved)
    && value.reads?.contract === 'assessment-read/v1' && Array.isArray(value.findings)
    && value.findings.every((item: unknown) => object(item)
      && typeof item.code === 'string' && typeof item.target === 'string'
      && typeof item.field === 'string' && typeof item.message === 'string')
    && value.findings.length > 0 && !value.findings.some((item: Finding) => OBLIGATION_EVIDENCE_PAUSES.has(item.code)),
    'research_proposal_refusal_invalid', `[${id}] Technical refusal has incomplete or foreign original materials`);
  const draft = exactRecord<DiscoveryDraft>(store, value.draft, 'discovery-draft');
  const question = exactRecord<Question>(store, value.question, 'question');
  const environment = exactRecord<Environment>(store, value.environment, 'environment');
  requireCondition(draft.value.projectId === projectId && question.value.projectId === projectId
    && question.value.draftId === draft.id && environment.value.projectId === projectId
    && environment.value.implementer.actor !== environment.value.reviewer.actor
    && draft.value.stage === 'om-g2' && ['R1', 'R2'].includes(draft.value.level)
    && draft.value.consumer === 'compilation',
    'research_proposal_refusal_invalid', `[${id}] Technical refusal belongs to another assessment`);
  const first = readResearchConsumerTurn(store, value.turn);
  const pending = readResearchConsumerTurn(store, value.pending);
  const paid = turnAction(first.value);
  requireCondition(pending.value.status === 'pending' && canonical(reference(pending)) === canonical(value.pending)
    && canonical(pending.value.question) === canonical(value.question)
    && (paid.action === 'answer' || paid.action === 'answer_delta') && paid.question === question.id,
    'research_proposal_refusal_invalid', `[${id}] Technical refusal lost its original paid answer`);
  const producerIntent = readResearchConsumerIntent(store, (first.value as ManagedResearchTurn).consumerIntent);
  requireCondition(canonical(producerIntent.value.draft) === canonical(value.draft)
    && canonical(producerIntent.value.question) === canonical(value.question),
    'research_proposal_refusal_invalid', `[${id}] Technical refusal belongs to another consumer intent`);
  const deltaStore = paid.action === 'answer_delta' ? pinnedLayerDeltaStore(store, paid) : store;
  const action: Extract<ResearchAction, { action: 'answer' }> = paid.action === 'answer' ? paid
    : { action: 'answer', question: paid.question,
      value: expandLayerDelta(deltaStore, draft, question, paid), citations: paid.citations };
  checkAssessmentRuntimeMaterials(projectId, value.runtime, id);
  const view = assessmentReadView(store, value.reads);
  requireDocumentarySources(view.store, projectId, question.value.spec);
  const schemaOk = new Ajv({ strict: true, allowUnionTypes: true })
    .compile(question.value.spec.schema as object)(action.value);
  const capturedDraft = view.store.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(capturedDraft && canonical(reference(capturedDraft)) === canonical(value.draft),
    'research_proposal_refusal_invalid', `[${id}] Technical refusal lost its captured draft`);
  const observations = action.citations.map(item => new Evidence(view.store).observe(projectId, item.source, item.selector));
  const graph = view.store.get<Graph>(`graph:${projectId}`);
  requireCondition(graph?.kind === 'graph' && canonical(reference(graph)) === canonical(value.graph),
    'research_proposal_refusal_invalid', `[${id}] Technical refusal lost its captured graph`);
  // A malformed paid answer cannot drive the typed findings derivation; its
  // refusal is exactly the schema refusal and nothing else.
  const findings: Finding[] = !schemaOk
    ? [{ code: 'answer_invalid', target: question.id, field: question.value.spec.field,
        message: 'Proposed research result does not satisfy its consumer contract' }]
    : technicalProposalFindings(view.store, projectId, draft.value.level, question.id,
        question.value.spec.field, action.value as unknown as TechnicalReport, observations,
        graph.value, value.root, value.runtime, { mode: 'historical', legacyPaths: value.legacyPaths });
  view.finish();
  requireCondition(findings.length > 0 && canonical(findings) === canonical(value.findings)
    && !findings.some(item => OBLIGATION_EVIDENCE_PAUSES.has(item.code)),
    'research_proposal_refusal_invalid', `[${id}] Technical refusal does not derive from its exact source reads`);
  return record;
}

function historicalTurnTransitionProof(store: Store, producer: Revision<ResearchConsumerIntent>,
  before: Revision<Record<string, any>>, after: Revision<Record<string, any>>): TurnTransitionProof | 'checked-search' | null {
  if (before.value.status !== 'pending')
    consumerInvalid(before.id, 'A completed paid turn cannot acquire another transition');
  let action: ResearchAction;
  try { action = turnAction(before.value); }
  catch { consumerInvalid(before.id, 'The original paid turn action is invalid'); }
  if (after.value.status === 'completed' && after.value.observation?.code === 'research_context_incomplete') {
    const paid = readResearchConsumerExecutionFromIntent(store, producer.value.projectId, producer);
    if (paid.kind !== 'response' || !isRef(before.value.question)
      || (action.action !== 'answer' && action.action !== 'answer_delta'))
      consumerInvalid(before.id, 'An incomplete answer lost its exact paid subject');
    const prior = producer.value.basis.flatMap(ref => {
      const turn = store.get<ResearchTurn>(ref.id, ref.revision);
      if (!turn || turn.kind !== 'research-turn') return [];
      if (canonical(reference(turn)) !== canonical(ref))
        consumerInvalid(before.id, 'An incomplete answer changed an exact prior turn');
      return turn.value.run === before.value.run && turn.value.number < before.value.number ? [turn] : [];
    });
    const draft = store.get<DiscoveryDraft>(producer.value.draft.id, producer.value.draft.revision);
    if (!draft || canonical(reference(draft)) !== canonical(producer.value.draft))
      consumerInvalid(before.id, 'An incomplete answer lost its exact draft');
    const history = readContextTurnHistoryAt(store, producer.value.projectId,
      draft, before.value.question, prior, before.value.number);
    return { kind: 'context-incomplete',
      workspace: projectAddressedWorkspace(before.value as ManagedResearchTurn, history, before.value.question),
      subject: paid.subject };
  }
  if (after.value.status === 'completed' && after.value.observation?.code === 'research_question_reopened') {
    const originalRef = before.value.question;
    const questionRef = after.value.observation.question, draftRef = after.value.observation.draft;
    const original = isRef(originalRef) ? store.get<Question>(originalRef.id, originalRef.revision) : null;
    const reopened = isRef(questionRef) ? store.get<Question>(questionRef.id, questionRef.revision) : null;
    const draft = isRef(draftRef) ? store.get<DiscoveryDraft>(draftRef.id, draftRef.revision) : null;
    if (!original || !reopened || !draft || canonical(reference(original)) !== canonical(originalRef)
      || canonical(reference(reopened)) !== canonical(questionRef) || canonical(reference(draft)) !== canonical(draftRef))
      consumerInvalid(before.id, 'The reopened turn lost its exact draft and question');
    return { kind: 'question-reopened', original, reopened, draft };
  }
  if (after.value.status === 'completed' && after.value.observation?.contract === EARLY_UNKNOWN)
    return earlyUnknownProof(store, readResearchConsumerIntent(store, before.value.consumerIntent), before);
  if (after.value.status === 'completed' && after.value.observation?.contract === EARLY_RESEARCH_OUTCOME) {
    const draftRef = producer.value.draft, questionRef = before.value.question;
    const draft = store.get<DiscoveryDraft>(draftRef.id, draftRef.revision);
    const question = isRef(questionRef) ? store.get<Question>(questionRef.id, questionRef.revision) : null;
    if (!draft || !question || canonical(reference(draft)) !== canonical(draftRef)
      || canonical(reference(question)) !== canonical(questionRef))
      consumerInvalid(before.id, 'The early model refusal lost its exact original contract');
    const refusalProducer = readResearchConsumerIntent(store, before.value.consumerIntent);
    const admission = earlyUnknownAdmission(store, refusalProducer, draft, question);
    return { kind: 'early-model-refusal', draft, question, producer: refusalProducer,
      context: consumerIntentContext(store, refusalProducer.value, refusalProducer.id),
      ...(intentWebCapability(store, producer) ? { web: true } : {}), ...(admission ? { unknown: admission } : {}) };
  }
  const localRefusal = projectPaidLocalRefusal(before.value as ManagedResearchTurn, earlyUnknownEra(producer.value.cursor));
  if (localRefusal) return localRefusal.proof;
  if (action.action === 'read_context' && after.value.status === 'pending'
    && after.value.observation?.code === 'research_no_progress') {
    const draftRef = producer.value.draft;
    const draft = store.get<DiscoveryDraft>(draftRef.id, draftRef.revision);
    const questionRef = before.value.question;
    const question = isRef(questionRef) ? store.get<Question>(questionRef.id, questionRef.revision) : null;
    const profileRef = producer.value.profile;
    const profile = profileRef ? store.get<ReaderPilot>(profileRef.id, profileRef.revision) : null;
    if (!draft || !question || canonical(reference(draft)) !== canonical(draftRef)
      || canonical(reference(question)) !== canonical(questionRef)
      || profileRef && (!profile || canonical(reference(profile)) !== canonical(profileRef)))
      consumerInvalid(before.id, 'The repeated read lost its exact draft, question or profile');
    const refs = after.value.observation.history;
    if (!Array.isArray(refs) || !refs.every(isRef))
      consumerInvalid(before.id, 'The repeated read lost its full earlier turn history');
    const turns = refs.map((ref: Ref) => {
      const turn = store.get<ResearchTurn>(ref.id, ref.revision);
      if (!turn || turn.kind !== 'research-turn' || canonical(reference(turn)) !== canonical(ref))
        consumerInvalid(before.id, 'A repeated read changed an earlier exact turn');
      return turn;
    });
    const limit = profile?.value.maxRequestChars ?? 300000;
    const observation = readResearchContextOutcomeAt(store, draft, question, action, limit);
    return { kind: 'repeat-context',
      current: readContextIdentityAt(store, producer.value.projectId, draft, questionRef, action, observation),
      history: readContextTurnHistoryAt(store, producer.value.projectId,
        draft, questionRef, turns, before.value.number) };
  }
  if (action.action === 'search' && after.value.status === 'completed' && after.value.error === null) {
    readManagedSearchCompletion(store, before, after);
    return 'checked-search';
  }
  if (action.action === 'pause') return { kind: 'pause' };
  if (action.action === 'read_context' && after.value.status === 'completed') {
    const draft = store.get<DiscoveryDraft>(producer.value.draft.id, producer.value.draft.revision);
    const question = store.get<Question>(producer.value.question.id, producer.value.question.revision);
    const pilotRef = producer.value.profile;
    const pilot = pilotRef ? store.get<ReaderPilot>(pilotRef.id, pilotRef.revision) : null;
    if (!draft || !question || pilotRef && !pilot || canonical(reference(draft)) !== canonical(producer.value.draft)
      || canonical(reference(question)) !== canonical(producer.value.question)
      || pilot && canonical(reference(pilot)) !== canonical(pilotRef))
      consumerInvalid(before.id, 'The paid addressed read lost its exact draft, question or profile');
    const record = readResearchContextRecordAt(store, draft, action);
    const maxChars = pilot?.value.maxRequestChars ?? 300000;
    const legacySizeRefusal = after.value.error === 'Use a smaller addressed context page'
      && after.value.observation?.code === 'context_read_limit';
    let refused = false;
    const recordValue = contextRecordValue(store, record);
    try { projectResearchContextRead(recordValue, action.record, action.pointer, action.page,
      maxChars, legacySizeRefusal ? 'legacy' : 'bounded'); }
    catch (error) { if (error instanceof EngineError) refused = true; else throw error; }
    if (refused) return { kind: 'context-refusal', recordValue,
      record: action.record, maxChars,
      ...(!legacySizeRefusal ? { projection: 'bounded' as const } : {}) };
    if (after.value.error !== null) {
      const prior = producer.value.basis.flatMap(ref => {
        const turn = store.get<ResearchTurn>(ref.id, ref.revision);
        if (!turn || turn.kind !== 'research-turn') return [];
        if (canonical(reference(turn)) !== canonical(ref))
          consumerInvalid(before.id, 'The paid delivery lost an exact prior turn');
        return turn.value.run === before.value.run && turn.value.number < before.value.number ? [turn] : [];
      });
      const history = readContextTurnHistoryAt(store, producer.value.projectId,
        draft, before.value.question, prior, before.value.number);
      const workspace = projectAddressedWorkspace(before.value as ManagedResearchTurn,
        history, before.value.question);
      const paid = readResearchConsumerExecutionFromIntent(store, producer.value.projectId, producer);
      if (paid.kind !== 'response' || !Array.isArray(paid.subject.contextWorkspace))
        consumerInvalid(before.id, 'The refused delivery lost its exact original packet');
      return { kind: 'delivery-refusal', recordValue, record: action.record,
        maxChars, workspace, delivered: paid.subject.contextWorkspace,
        ...(pilot?.value.contextLimits?.maxLookups !== undefined
          ? { maxLookups: pilot.value.contextLimits.maxLookups } : {}) };
    }
    return { kind: 'read-context', recordValue,
      record: action.record, maxChars };
  }
  if (action.action === 'read_bundle' && after.value.status === 'completed' && after.value.error === null) {
    const resultRef = after.value.observation?.ref;
    if (!isRef(resultRef)) consumerInvalid(before.id, 'The completed bundle lost its exact result reference');
    const result = readReaderResultAt(store, producer.value.projectId, resultRef);
    return { kind: 'read-bundle', result: { ref: reference(result), value: result.value } };
  }
  if (action.action === 'checkpoint' && after.value.status === 'completed' && after.value.error === null) {
    const draft = store.get<DiscoveryDraft>(producer.value.draft.id, producer.value.draft.revision);
    const question = store.get<Question>(producer.value.question.id, producer.value.question.revision);
    if (!draft || !question || canonical(reference(draft)) !== canonical(producer.value.draft)
      || canonical(reference(question)) !== canonical(producer.value.question))
      consumerInvalid(before.id, 'The checkpoint lost its exact draft and question');
    const expected = historicalCheckpoint(store, draft, question, action);
    const checkpoint = store.get<Record<string, any>>(expected.ref.id, expected.ref.revision);
    if (!checkpoint || checkpoint.kind !== 'research-checkpoint'
      || canonical(reference(checkpoint)) !== canonical(expected.ref)
      || canonical(checkpoint.value) !== canonical(expected.value))
      consumerInvalid(before.id, 'The completed checkpoint is not the paid action result');
    return { kind: 'checkpoint', checkpoint: { ref: expected.ref, value: expected.value } };
  }
  if ((action.action === 'web_search' || action.action === 'web_fetch') && after.value.status === 'completed') {
    // WB1: every web completion (page, search, saved failure, refusal) derives from the capture of this exact turn.
    const capture = store.get<WebCapture>(webCaptureId(reference(before)));
    if (!capture || capture.kind !== 'web-capture' || hashJson(capture.value) !== capture.hash)
      consumerInvalid(before.id, 'The completed web turn lost its saved capture');
    return { kind: 'web', projectId: producer.value.projectId, capture, budget: readWebCaptureBudget(store, capture) };
  }
  if ((action.action === 'read' || action.action === 'read_source')
    && after.value.status === 'completed' && after.value.error === null) {
    const sourceRef = action.action === 'read' ? after.value.observation?.ref : action.source;
    const source = isRef(sourceRef) ? store.get<Source>(sourceRef.id, sourceRef.revision) : null;
    if (!source || source.kind !== 'source' || canonical(reference(source)) !== canonical(sourceRef)
      || hashJson(source.value) !== source.hash || source.value.projectId !== producer.value.projectId
      || typeof source.value.content !== 'string' || digest(source.value.content) !== source.value.sha256)
      consumerInvalid(before.id, 'The paid source action lost its exact source bytes');
    return { kind: action.action === 'read' ? 'source-read' : 'source-excerpt',
      ...(action.action === 'read_source' && Object.hasOwn(after.value.observation ?? {}, 'contract')
        ? { readContract: after.value.observation.contract } : {}),
      projectId: producer.value.projectId, source: { ref: reference(source), value: source.value } };
  }
  if (action.action === 'read_plan' && after.value.status === 'completed' && after.value.error === null) {
    const children = after.value.observation?.children;
    if (!Array.isArray(children) || children.length !== action.reads.length || !children.every(isRef))
      consumerInvalid(before.id, 'The paid reading plan lost its complete saved child queue');
    for (let index = 0; index < children.length; index += 1) {
      const ref = children[index] as Ref;
      const child = store.get<Record<string, any>>(ref.id, ref.revision);
      if (!child || child.kind !== 'research-turn' || canonical(reference(child)) !== canonical(ref)
        || hashJson(child.value) !== child.hash
        || child.id !== `research-turn:${hashJson([before.id, 'read', index])}`
        || child.value.run !== before.value.run || child.value.number !== before.value.number + index + 1
        || canonical(child.value.action) !== canonical(action.reads[index])
        || canonical(child.value.question) !== canonical(before.value.question)
        || canonical(child.value.plannedBy) !== canonical(reference(before))
        // DR3a3-S3: every child carries exactly its planner's subject lineage (none on the field path).
        || Object.hasOwn(child.value, 'subject') !== Object.hasOwn(before.value, 'subject')
        || canonical(child.value.subject ?? null) !== canonical(before.value.subject ?? null)
        || ['attemptContract', 'attempt', 'attemptBinding'].some(field => Object.hasOwn(child.value, field)))
        consumerInvalid(before.id, 'A saved reader child differs from its paid queue position');
    }
    return { kind: 'reading-plan-queued', children: children as Ref[] };
  }
  if ((action.action === 'synthesize' || action.action === 'need_research')
    && after.value.status === 'completed' && after.value.error === null)
    return { kind: 'reading-mode' };
  // DR3a3-K: a paid answer of the attempt era completes only through its
  // attempt binding — never through the assessed or accepted answer branches.
  // A missing or damaged binding is a typed refusal, never a fall-through.
  if (attemptEraOf(before.value) === 'attempt' && action.action === 'answer'
    && after.value.status === 'completed' && after.value.error === null) {
    const link = (after.value as { attemptBinding?: unknown }).attemptBinding;
    if (!isRef(link))
      throw new EngineError('research_attempt_binding_invalid',
        `[${before.id}] The completed attempt turn lost the link to its attempt record`,
        { ref: { id: attemptBindingId(producer.value.projectId, before.id), revision: 1 }, reason: 'link' });
    const proven = readResearchAttemptBinding(store, producer.value.projectId, before.id);
    if (!proven)
      throw new EngineError('research_attempt_binding_invalid',
        `[${before.id}] The completed attempt turn names a missing attempt record`, { ref: link, reason: 'missing' });
    if (canonical(reference(proven.binding)) !== canonical(link)
      || canonical(reference(proven.pending)) !== canonical(reference(before)))
      throw new EngineError('research_attempt_binding_invalid',
        `[${before.id}] The completed attempt turn names another attempt record or pending revision`,
        { ref: link, reason: 'link' });
    return { kind: 'attempt-recorded', inputs: proven.inputs,
      binding: { ref: reference(proven.binding), value: proven.binding.value } };
  }
  if ((action.action === 'answer' || action.action === 'answer_delta')
    && after.value.status === 'completed') {
    const originalRef = before.value.question;
    const original = isRef(originalRef)
      ? store.get<Question>(originalRef.id, originalRef.revision) : null;
    if (!original || original.kind !== 'question'
      || canonical(reference(original)) !== canonical(originalRef))
      consumerInvalid(before.id, 'The completed answer lost its exact original question');
    if (after.value.error !== null) {
      const refusal = projectPaidLayerDesignRefusal(store, producer, before);
      if (refusal) return refusal.proof;
    }
    if (after.value.observation?.code === 'research_proposal_invalid') {
      const refusalRef = after.value.observation.refusal;
      if (!isRef(refusalRef))
        consumerInvalid(before.id, 'A technical refusal lost its exact pre-assessor proof');
      const refusal = readManagedProposalRefusalAt(store, producer.value.projectId, before.id, refusalRef);
      return { kind: 'technical-refusal', result: { ref: reference(refusal), value: refusal.value } };
    }
    const assessmentRef = after.value.assessment;
    if (after.value.error === null && isRef(assessmentRef)) {
      // №2000-12/R19: the era is selected by the turn's stable links — any of
      // its paid origin (M), managed session (S) or read binding (B) proves a
      // managed paid step. A missing M then fails inside
      // readResearchAssessmentAt as a typed refusal instead of silently
      // choosing the legacy era; turns without any such link keep prior rules.
      const managedEra = [paidOriginId, paidSessionId, assessmentBindingId]
        .some(identity => store.get(identity(producer.value.projectId, before.id)) !== null);
      const assessment = managedEra
        ? readResearchAssessmentAt(store, producer.value.projectId, before.id, assessmentRef)
        : store.get<ResearchAssessment>(assessmentRef.id, assessmentRef.revision);
      if (!assessment || assessment.kind !== 'research-assessment' || assessment.revision !== 1
        || canonical(reference(assessment)) !== canonical(assessmentRef)
        || assessment.id !== `research-assessment:${hashJson(assessment.value)}`
        || assessment.hash !== hashJson(assessment.value))
        consumerInvalid(before.id, 'The paid answer lost its exact original assessment');
      if (assessment.value.verdict === 'supported') {
        // D8.4e: a turn of the binding era — or any turn whose completion
        // names an acceptance record — completes only through the proven K.
        // The era is the turn's own immutable field; a missing or damaged K
        // is a typed refusal, never a fall-through to the stored chain or
        // the bounded scan.
        const bindingLink = (after.value as { acceptanceBinding?: unknown }).acceptanceBinding;
        if (acceptanceEraOf(before.value) === 'binding' || bindingLink !== undefined) {
          if (!isRef(bindingLink))
            throw new EngineError('research_acceptance_binding_invalid',
              `[${before.id}] The completed managed turn lost the link to its acceptance record`,
              { ref: { id: acceptanceBindingId(producer.value.projectId, before.id), revision: 1 }, reason: 'link' });
          const proven = readResearchAcceptanceBinding(store, producer.value.projectId, before.id);
          if (!proven)
            throw new EngineError('research_acceptance_binding_invalid',
              `[${before.id}] The completed managed turn names a missing acceptance record`,
              { ref: bindingLink, reason: 'missing' });
          if (canonical(reference(proven.binding)) !== canonical(bindingLink)
            || canonical(reference(proven.pending)) !== canonical(reference(before))
            || canonical(reference(proven.assessment)) !== canonical(reference(assessment)))
            throw new EngineError('research_acceptance_binding_invalid',
              `[${before.id}] The completed managed turn names another acceptance record, pending revision or assessment`,
              { ref: bindingLink, reason: 'link' });
          return { kind: 'accepted-answer', inputs: proven.inputs,
            binding: { ref: reference(proven.binding), value: proven.binding.value } };
        }
        // №1745-2: the completed turn persists the exact acceptance chain;
        // consume those references instead of rescanning a draft that may
        // have accepted further identical answers since.
        const stored = (after.value as { acceptance?: unknown }).acceptance;
        if (stored !== undefined)
          return { kind: 'accepted-answer',
            inputs: storedAcceptedAnswerInputs(store, before, original, assessment,
              producer.value.projectId, stored) };
        // Records written before the field existed keep the bounded scan.
        const answered = store.get<Question>(original.id, original.revision + 1);
        const bound = answered?.kind === 'question' && answered.value.status === 'answered'
          && isRef(answered.value.answer)
          ? findAcceptedPaidAnswerChain(store, producer.value.projectId,
              before as Revision<ResearchTurn>, original, answered)
          : null;
        if (!bound) consumerInvalid(before.id,
          'The accepted paid answer has no single complete chain of exact references');
        return { kind: 'accepted-answer', inputs: bound.inputs };
      }
      const draft = store.get<DiscoveryDraft>(producer.value.draft.id, producer.value.draft.revision);
      if (!draft || canonical(reference(draft)) !== canonical(producer.value.draft))
        consumerInvalid(before.id, 'The assessed answer lost its exact draft');
      return { kind: 'assessed-answer', question: original, assessment,
        ...(action.action === 'answer_delta'
          ? { expandedProposal: expandLayerDelta(pinnedLayerDeltaStore(store, action), draft, original, action) }
          : {}) };
    }
  }
  if (action.action === 'need_owner' && after.value.status === 'completed') {
    const afterRef = reference(after), beforeRef = reference(before);
    // The reviewer's application is the exact third intent revision. A later
    // head (or runtime telemetry on its call) is not the producer of this
    // historical turn transition.
    const reviewers = store.list<ResearchConsumerIntent>('research-consumer-intent')
      .map(candidate => store.get<ResearchConsumerIntent>(candidate.id, 3))
      .filter((candidate): candidate is Revision<ResearchConsumerIntent> => !!candidate
      && candidate.value.kind === 'escalation-assessor' && candidate.value.state === 'applied'
      && canonical(candidate.value.cursor.pendingTurn) === canonical(beforeRef)
      && !!candidate.value.outputs?.some(output => canonical(output) === canonical(afterRef)));
    if (reviewers.length > 1) consumerInvalid(before.id, 'Several reviewers claim the same paid owner turn');
    if (reviewers.length === 1) {
      const reviewer = readResearchConsumerIntent(store, reference(reviewers[0]!));
      const paid = readResearchConsumerExecutionFromIntent(store, producer.value.projectId, reviewer);
      if (paid.kind !== 'response' || !object(paid.payload)
        || typeof paid.payload.necessary !== 'boolean' || typeof paid.payload.reason !== 'string'
        || !paid.payload.reason.trim())
        consumerInvalid(before.id, 'The completed owner turn lacks its paid reviewer verdict');
      return { kind: 'owner-review', verdict: paid.payload as { necessary: boolean; reason: string } };
    }
    const prior = producer.value.basis.flatMap(ref => {
      const record = store.get<Record<string, any>>(ref.id, ref.revision);
      if (!record || canonical(reference(record)) !== canonical(ref) || hashJson(record.value) !== record.hash)
        consumerInvalid(before.id, 'The original owner action lost a saved source');
      return record.kind === 'research-turn' && record.value.run === before.value.run
        && Number.isSafeInteger(record.value.number) && record.value.number < before.value.number ? [record] : [];
    }).sort((a, b) => a.value.number - b.value.number).slice(-8);
    const consulted = producer.value.basis.filter(ref => store.get(ref.id, ref.revision)?.kind === 'source');
    const hadPriorRead = prior.some(turn => ['search', 'read', 'read_source', 'read_bundle', 'read_context']
      .includes(String(turn.value.action?.action)));
    return { kind: 'premature-owner', consulted, hadPriorRead };
  }
  return null;
}
export function readResearchConsumerTurn(store: Store, ref: Ref): Revision<Record<string, any>> {
  if (!store || typeof store.get !== 'function' || !isRef(ref))
    consumerInvalid('research-turn', 'An exact saved turn reference is required');
  const saved = store.get<Record<string, any>>(ref.id, ref.revision);
  if (!saved || saved.kind !== 'research-turn' || canonical(reference(saved)) !== canonical(ref)
    || hashJson(saved.value) !== saved.hash || !object(saved.value))
    consumerInvalid(ref.id, 'The exact research turn is missing or changed');
  const managed = saved.id.startsWith('research-turn:v1:');
  if (!managed) {
    if (Object.hasOwn(saved.value, 'contract') && saved.value.contract === 'research-consumer-turn/v1'
      || Object.hasOwn(saved.value, 'consumerIntent') || Object.hasOwn(saved.value, 'acceptanceContract')
      || Object.hasOwn(saved.value, 'acceptanceBinding')
      || ['attemptContract', 'attempt', 'attemptBinding'].some(field => Object.hasOwn(saved.value, field)))
      consumerInvalid(saved.id, 'A legacy turn address cannot claim a new consumer producer');
    queuedChildLineage(store, saved);
    if (saved.value.action?.action === 'read_source' && object(saved.value.observation)
      && Object.hasOwn(saved.value.observation, 'contract')) {
      const before = store.get<Record<string, any>>(saved.id, saved.revision - 1);
      const sourceRef = saved.value.action.source;
      const source = isRef(sourceRef) ? store.get<Source>(sourceRef.id, sourceRef.revision) : null;
      const run = before && typeof before.value.run === 'string' ? store.get<{projectId: string}>(before.value.run, 1) : null;
      if (![SOURCE_READ_CONTRACT, SOURCE_READ_CONTRACT_V2, SOURCE_READ_CONTRACT_V3].includes(saved.value.observation.contract) || !before
        || before.kind !== 'research-turn' || hashJson(before.value) !== before.hash
        || !run || run.kind !== 'research-run' || hashJson(run.value) !== run.hash
        || !source || source.kind !== 'source' || canonical(reference(source)) !== canonical(sourceRef))
        consumerInvalid(saved.id, 'The queued source read lost its exact pending action and source');
      const parent = managedSearchParent(store, before);
      if (isRef(before.value.plannedBy) && !parent)
        consumerInvalid(saved.id, 'The source read lost its exact parent queue');
      if (parent) readResearchConsumerTurn(store, reference(parent.queued));
      try {
        const expected = projectSourceReadingTurn(before.value as ResearchTurn, run.value.projectId,
          { ref: reference(source), value: source.value }, saved.value.observation.contract);
        if (canonical(expected) !== canonical(saved.value)) consumerInvalid(saved.id, 'The queued read differs from its exact source result');
      } catch { consumerInvalid(saved.id, 'The queued source read cannot be derived from its original bytes'); }
    }
    if (saved.revision > 1 && saved.value.status === 'completed') {
      const first = store.get<Record<string, any>>(saved.id, 1);
      if (first && turnAction(first.value).action === 'search') {
        // The completion's pending basis is the revision it directly follows —
        // after a lawful retry that is the retried pending revision (P), never
        // the stored original ref (O). Finding the managed parent from P also
        // proves the O -> P retry chain through the shared derivation.
        const basis = store.get<Record<string, any>>(saved.id, saved.revision - 1);
        const pending = basis?.kind === 'research-turn' && basis.value.status === 'pending' ? basis : null;
        const parent = pending ? managedSearchParent(store, pending) : null;
        if (isRef(first.value.plannedBy) && !parent)
          consumerInvalid(saved.id, 'The planned search lost its exact managed parent queue');
        if (parent && pending) {
          if (saved.value.error === null) readManagedSearchCompletion(store, pending, saved, parent);
          else {
            // A lawful failed outcome keeps every pending-basis field and
            // changes only the completion payload — no capture is derived.
            const { status: _ps, assessment: _pa, observation: _po, error: _pe, ...pendingRest } = pending.value;
            const { status: _ss, assessment: _sa, observation: _so, error: _se, ...savedRest } = saved.value;
            if (canonical(pendingRest) !== canonical(savedRest))
              consumerInvalid(saved.id, 'The failed search changed its exact pending basis');
          }
        }
      }
    }
    return saved;
  }
  if (saved.value.contract !== 'research-consumer-turn/v1' || !isRef(saved.value.consumerIntent)
    || typeof saved.value.run !== 'string' || !saved.value.run
    || !Number.isSafeInteger(saved.value.number) || saved.value.number <= 0
    || saved.id !== managedTurnId(saved.value.run, saved.value.number))
    consumerInvalid(saved.id, 'The new turn lost its producer contract, intent or exact run address');
  const original = store.get<Record<string, any>>(saved.id, 1);
  if (!original || original.kind !== 'research-turn' || hashJson(original.value) !== original.hash
    || !object(original.value) || original.value.contract !== 'research-consumer-turn/v1'
    || canonical(original.value.consumerIntent) !== canonical(saved.value.consumerIntent))
    consumerInvalid(saved.id, 'The new turn changed its original consumer binding');
  // D8.4e: the acceptance era is the producer's own field on the original
  // turn. Its only lawful form is the binding contract; the field belongs to
  // O@1 and is carried unchanged by every later revision (checked below with
  // the other immutable fields). A record without it is the earlier era.
  if (Object.hasOwn(original.value, 'acceptanceContract')
    && original.value.acceptanceContract !== ACCEPTANCE_BINDING_CONTRACT)
    consumerInvalid(saved.id, 'The new turn names an unknown acceptance contract');
  if (original.value.status !== 'pending' || original.value.assessment !== null
    || original.value.observation !== null || original.value.error !== null
    || Object.hasOwn(original.value, 'acceptance') || Object.hasOwn(original.value, 'acceptanceBinding')
    || Object.hasOwn(original.value, 'attempt') || Object.hasOwn(original.value, 'attemptBinding'))
    consumerInvalid(saved.id, 'The original managed turn is not a plain pending paid turn');
  // DR3a3-K: the attempt era is the producer's own field on O@1, fixed together
  // with the subject — both present or both absent, only the known contract.
  // A missing or unknown marker on the new form never selects another branch.
  if (Object.hasOwn(original.value, 'attemptContract') !== Object.hasOwn(original.value, 'subject')
    || Object.hasOwn(original.value, 'attemptContract') && original.value.attemptContract !== ATTEMPT_BINDING_CONTRACT)
    consumerInvalid(saved.id, 'The new turn names an unknown attempt contract or lost its attempt subject');
  let turnSubject: V7PlanSubject | null = null;
  if (Object.hasOwn(original.value, 'subject')) {
    try { turnSubject = planSubjectOf({ subject: original.value.subject }); }
    catch { consumerInvalid(saved.id, 'The new turn carries a damaged attempt subject'); }
  }
  const originIntent = readResearchConsumerIntent(store, saved.value.consumerIntent);
  // The original turn is written either in the runner application at @3 or in
  // the synthesis handoff at @4. A later intent HEAD is not evidence for this
  // historical output.
  const candidates = (['synthesis', 'consolidation'].includes(originIntent.value.kind) ? [3, 4] : [3])
    .map(revision => store.get<ResearchConsumerIntent>(originIntent.id, revision))
    .filter((candidate): candidate is Revision<ResearchConsumerIntent> => !!candidate
      && candidate.value.state === 'applied' && !!candidate.value.outputs?.some(output =>
        canonical(output) === canonical(reference(original))));
  if (candidates.length !== 1) consumerInvalid(saved.id, 'No unique exact applied intent revision produced this turn');
  const intent = readResearchConsumerIntent(store, reference(candidates[0]!));
  if (!sameSubject(cursorSubject(intent.value, saved.id), turnSubject))
    consumerInvalid(saved.id, 'The turn attempt subject differs from the subject its producing intent fixed');
  const synthesis = intent.value.kind === 'synthesis' || intent.value.kind === 'consolidation';
  const directOutput = intent.value.outputs?.some(output => canonical(output) === canonical(reference(original))) ?? false;
  const sessionOutput = synthesis && intent.value.outputs?.find(output => output.id === intent.value.owner.id);
  const session = sessionOutput ? store.get<RecoverableContextSession>(sessionOutput.id, sessionOutput.revision) : null;
  const delivery = intent.value.cursor.delivery;
  const synthesisHandoff = synthesis && object(delivery)
    && delivery.run === saved.value.run && delivery.turn === saved.value.number
    && session && canonical(reference(session)) === canonical(sessionOutput)
    && synthesisTurnMatches(store, intent, session, original.value.action);
  if (intent.value.state !== 'applied' || !directOutput || synthesis && !synthesisHandoff
    || !synthesis && intent.value.owner.id !== saved.value.run)
    consumerInvalid(saved.id, 'The new turn is not the exact output of its accepted consumer intent');
  // DR3a3-S1: the second producer of O@1 — the handoff turn carries the
  // subject of the exact session its step produced (none for v2), which the
  // step intent and the turn already share above.
  if (synthesis && session?.kind === 'synthesis-session') {
    let bound: V7PlanSubject | null;
    try { bound = synthesisStepSubject(intent.value, session); }
    catch { consumerInvalid(saved.id, 'The handoff session and its step name different subjects'); }
    if (!sameSubject(bound!, turnSubject))
      consumerInvalid(saved.id, 'The handoff turn subject differs from the subject of its exact session');
  }
  // Every requested later revision must retain the paid action and binding.
  // The proof for a local owner refusal is deliberately distinct from the
  // later paid escalation assessor; an absent reviewer is not itself proof.
  for (let revision = 2; revision <= saved.revision; revision += 1) {
    const before = store.get<Record<string, any>>(saved.id, revision - 1);
    const after = store.get<Record<string, any>>(saved.id, revision);
    if (!before || !after || before.kind !== 'research-turn' || after.kind !== 'research-turn'
      || hashJson(before.value) !== before.hash || hashJson(after.value) !== after.hash)
      consumerInvalid(saved.id, 'A managed turn revision is missing or changed');
    const immutable = (value: Record<string, any>) => ({ contract: value.contract,
      consumerIntent: value.consumerIntent, run: value.run, number: value.number,
      question: value.question, action: value.action,
      ...(Object.hasOwn(value, 'dispatchMode') ? { dispatchMode: value.dispatchMode } : {}),
      ...(Object.hasOwn(value, 'acceptanceContract') ? { acceptanceContract: value.acceptanceContract } : {}),
      ...(Object.hasOwn(value, 'attemptContract') ? { attemptContract: value.attemptContract } : {}),
      ...(Object.hasOwn(value, 'subject') ? { subject: value.subject } : {}) });
    if (canonical(immutable(after.value)) !== canonical(immutable(original.value)))
      consumerInvalid(saved.id, 'A later turn rewrote its paid action or original binding');
    const proof = historicalTurnTransitionProof(store, intent, before, after);
    if (proof === 'checked-search') continue;
    if (!proof) consumerInvalid(saved.id, 'A managed turn acquired a transition without an exact producer proof');
    try { assertResearchTurnTransition(before.value as ManagedResearchTurn,
      after.value as ManagedResearchTurn, proof); }
    catch { consumerInvalid(saved.id, 'A later turn does not derive from its exact producer'); }
  }
  return saved;
}
function checkConsumerClaimOrigins(store: Store, projectId?: string, draftId?: string): void {
  for (const call of store.list<ModelCall>('model-call')) {
    if (projectId !== undefined && (call.value.projectId !== projectId || draftId !== undefined && call.value.draftId !== draftId)) continue;
    const managed = call.id.startsWith('model-call:consumer:v1:');
    const intentRef = (call.value as ModelCall & { consumerIntent?: Ref }).consumerIntent;
    if (!managed && intentRef === undefined) continue;
    if (!managed || !isRef(intentRef)) consumerInvalid(call.id, 'The physical producer era lost its exact consumer intent');
    const origin = readResearchConsumerIntent(store, intentRef);
    const head = store.get<ResearchConsumerIntent>(origin.id);
    if (!head) consumerInvalid(origin.id, 'The physical producer lost its current consumer intent');
    const intent = readResearchConsumerIntent(store, reference(head));
    if (intent.value.projectId !== call.value.projectId || intent.value.draft.id !== call.value.draftId
      || intent.value.call?.id !== call.id)
      consumerInvalid(call.id, 'The physical call is not owned by its declared consumer intent');
  }
}
export function findResearchConsumerIntent(store: Store, projectId: string, kind: ResearchConsumerKind, key: string, draftId?: string): Revision<ResearchConsumerIntent> | null {
  checkConsumerClaimOrigins(store, draftId ? projectId : undefined, draftId);
  const found = store.list<ResearchConsumerIntent>('research-consumer-intent')
    .filter(record => !draftId || record.value.projectId === projectId && record.value.draft.id === draftId
      && record.value.kind === kind && record.value.rootKey === key)
    .map(record => readResearchConsumerIntent(store, reference(record)))
    .filter(record => record.value.projectId === projectId && record.value.kind === kind && record.value.rootKey === key)
    .sort((a, b) => a.value.generation - b.value.generation);
  if (found.some((record, index) => record.value.generation !== index))
    consumerInvalid(key, 'The logical consumer operation has a missing generation');
  return found.at(-1) ?? null;
}
/** Capture only refusals proved before this public invocation began. Internal
 * resumes and child operations must reuse this snapshot, not collect a new one. */
export function captureResearchConsumerRetryPermits(store: Store, projectId: string, draftId?: string): Ref[] {
  if (!store || typeof store.list !== 'function' || typeof projectId !== 'string' || !projectId)
    consumerInvalid('research-consumer-intent', 'A retry permit needs its original project');
  checkConsumerClaimOrigins(store, draftId ? projectId : undefined, draftId);
  return store.list<ResearchConsumerIntent>('research-consumer-intent')
    .filter(record => !draftId || record.value.projectId === projectId && record.value.draft.id === draftId)
    .map(record => readResearchConsumerIntent(store, reference(record)))
    .filter(record => record.value.projectId === projectId && retryableResearchConsumerRefusal(store, record))
    .map(reference);
}
export function listPendingResearchConsumerIntents(store: Store, projectId: string, draftId: string): Revision<ResearchConsumerIntent>[] {
  if (!store || typeof store.list !== 'function' || typeof projectId !== 'string' || !projectId || typeof draftId !== 'string' || !draftId)
    consumerInvalid('research-consumer-intent', 'Pending lookup needs a project and original draft address');
  const scoped = earlyResearchStage(store.get<DiscoveryDraft>(draftId)?.value.stage);
  checkConsumerClaimOrigins(store, scoped ? projectId : undefined, scoped ? draftId : undefined);
  return store.list<ResearchConsumerIntent>('research-consumer-intent')
    .filter(record => !scoped || record.value.projectId === projectId && record.value.draft.id === draftId).map(record => readResearchConsumerIntent(store, reference(record)))
    .filter(record => record.value.projectId === projectId && record.value.draft.id === draftId
      && ['prepared', 'running'].includes(record.value.state));
}
export function listResearchConsumerIntents(store: Store, projectId: string, draftId: string): Revision<ResearchConsumerIntent>[] {
  if (!store || typeof store.list !== 'function' || typeof projectId !== 'string' || !projectId || typeof draftId !== 'string' || !draftId)
    consumerInvalid('research-consumer-intent', 'Intent lookup needs a project and original draft address');
  const scoped = earlyResearchStage(store.get<DiscoveryDraft>(draftId)?.value.stage);
  checkConsumerClaimOrigins(store, scoped ? projectId : undefined, scoped ? draftId : undefined);
  return store.list<ResearchConsumerIntent>('research-consumer-intent')
    .filter(record => !scoped || record.value.projectId === projectId && record.value.draft.id === draftId).map(record => readResearchConsumerIntent(store, reference(record)))
    .filter(record => record.value.projectId === projectId && record.value.draft.id === draftId);
}
export function findPendingResearchConsumerIntent(store: Store, projectId: string, kind: ResearchConsumerKind,
  ownerId: string, key?: string): Revision<ResearchConsumerIntent> | null {
  checkConsumerClaimOrigins(store);
  if (key !== undefined) {
    const record = findResearchConsumerIntent(store, projectId, kind, key);
    return record && record.value.owner.id === ownerId && ['prepared', 'running'].includes(record.value.state) ? record : null;
  }
  const found = store.list<ResearchConsumerIntent>('research-consumer-intent')
    .map(record => readResearchConsumerIntent(store, reference(record)))
    .filter(record => record.value.projectId === projectId && record.value.kind === kind
      && record.value.owner.id === ownerId && ['prepared', 'running'].includes(record.value.state));
  if (found.length > 1) consumerInvalid(ownerId, 'Several unfinished operations share this consumer address');
  return found[0] ?? null;
}
export function findPendingResearchConsumerIntentByRoot(store: Store, projectId: string, rootKey: string): Revision<ResearchConsumerIntent> | null {
  const found = listResearchConsumerIntentsByRoot(store, projectId, rootKey)
    .filter(record => ['prepared', 'running'].includes(record.value.state));
  if (found.length > 1) consumerInvalid(rootKey, 'Several unfinished reader children share one public request');
  return found[0] ?? null;
}
export function listResearchConsumerIntentsByRoot(store: Store, projectId: string, rootKey: string): Revision<ResearchConsumerIntent>[] {
  if (!store || typeof store.list !== 'function' || typeof projectId !== 'string' || !projectId
    || typeof rootKey !== 'string' || !rootKey) consumerInvalid('research-consumer-intent', 'Reader lineage lookup needs project and root key');
  checkConsumerClaimOrigins(store);
  return store.list<ResearchConsumerIntent>('research-consumer-intent')
    .map(record => readResearchConsumerIntent(store, reference(record)))
    .filter(record => record.value.projectId === projectId && record.value.kind === 'reader'
      && record.value.cursor.rootKey === rootKey);
}
/** Rebuild the declaration from the exact producer, never today's heads. */
export function consumerResultCapacity(store: Store, intent: ResearchConsumerIntent,
  /** DRS1a2: the producer's own not yet published context (the one origin of
   * its preparation); every saved intent reads its context by its contract. */
  pendingContext?: Record<string, any>) {
  const draft = store.get<DiscoveryDraft>(intent.draft.id, intent.draft.revision);
  const question = store.get<Question>(intent.question.id, intent.question.revision);
  const profile = intent.profile ? store.get<ReaderPilot>(intent.profile.id, intent.profile.revision) : null;
  requireCondition(draft && question && canonical(reference(draft)) === canonical(intent.draft)
    && canonical(reference(question)) === canonical(intent.question)
    && (!intent.profile || profile && canonical(reference(profile)) === canonical(intent.profile)),
  'research_capacity_invalid', 'Result capacity needs the exact draft, question and profile');
  const cursor = intent.cursor, context = pendingContext ?? consumerIntentContext(store, intent);
  return researchCapacityInput({ operation: intent.key, generation: intent.generation,
    bindings: { projectId: intent.projectId, draft: intent.draft, question: intent.question,
      inputsHash: hashJson(draft.value.inputs), basis: intent.basis, owner: intent.owner,
      // DR3a3-K: two plan-questions of one plan Question never share a declaration.
      ...(cursorSubject(intent) ? { subject: cursorSubject(intent) } : {}) },
    role: ['synthesis', 'consolidation'].includes(intent.kind) ? 'synthesizer'
      : intent.kind === 'escalation-assessor' ? 'assessor' : 'analyst',
    purpose: intent.kind, actionMode: intent.kind === 'consolidation' ? 'consolidation'
      : context.dispatchMode ?? cursor.mode ?? intent.kind,
    limit: researchResultEnvelopeLimit(intent.dispatch, profile?.value),
    physicalReplyLimit: profile?.value.physicalLimits?.maxReplyChars ?? null,
    prompt: cursor.resultCapacityPrompt ?? cursor.prompt ?? cursor.instruction, binding: intent.role, draft: draft.value,
    question: { id: question.id, value: question.value }, context,
    cursor: Object.fromEntries(['sessionId', 'offset', 'materialOffset', 'run', 'turn', 'pendingTurn', 'delivery',
      'previousProposalRef', 'contextContract'].filter(key => Object.hasOwn(cursor, key)).map(key => [key, cursor[key]])) });
}
export function consumerCapacityFailure(_store: Store, intent: Revision<ResearchConsumerIntent>, payload: unknown) {
  const cursor = intent.value.cursor;
  if (cursor.resultCapacityContract === undefined && cursor.resultCapacity === undefined) return null;
  // G5a (возврат 1): the saved admission is the commit — its capacity was
  // computed and proved once by the producer. A repeated answer check only
  // measures the NEW payload against that trusted declaration, never
  // recomputes it from today's rows.
  requireCondition(cursor.resultCapacityContract === RESULT_CAPACITY && cursor.resultCapacity !== undefined,
    'research_capacity_invalid', 'The new attempt lost its capacity era');
  return researchResultFailure(cursor.resultCapacity, payload);
}

/** One bounded correction, derived from the exact terminal producer and raw reply. */
export function consumerCapacityCorrection(store: Store, intent: Revision<ResearchConsumerIntent>) {
  if (intent.value.state !== 'refused' || intent.value.refusal?.code !== RESULT_CAPACITY_REFUSAL) return null;
  const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  const failure = paid.kind === 'response' ? consumerCapacityFailure(store, intent, paid.payload) : null;
  if (!failure || paid.kind !== 'response') consumerInvalid(intent.id, 'The capacity correction lost its original paid result');
  return { contract: RESULT_CAPACITY, code: failure.code, attempt: reference(intent),
    details: { ...(failure.details as Record<string, unknown>), response: paid.response },
    instruction: 'Return a smaller complete result of the same role; preserve sources and unresolved obligations.' };
}

/** DR3a3-K: the producer proves a declared attempt subject once, before the
 * intent exists: the Question basis is the real `plan` field Question of a v7
 * discovery draft at the exact revision answered by the subject's plan answer,
 * and the plan-question belongs to that proven plan edition. Readers trust the
 * saved subject afterwards (its form is checked with the intent shape). */
function requireIntentSubject(store: Store, value: ResearchConsumerIntent, id: string): void {
  const subject = cursorSubject(value, id);
  if (!subject) return;
  if (!SUBJECT_KINDS.includes(value.kind))
    consumerInvalid(id, 'Only a consumer that writes an original turn can name an attempt subject');
  const draft = store.get<DiscoveryDraft>(value.draft.id, value.draft.revision);
  const question = store.get<Question>(value.question.id, value.question.revision);
  if (!draft || !question || draft.kind !== 'discovery-draft' || question.kind !== 'question'
    || canonical(reference(draft)) !== canonical(value.draft) || canonical(reference(question)) !== canonical(value.question)
    || draft.value.projectId !== value.projectId || draft.value.stage !== 'discovery'
    || draft.value.contractVersion !== V7_CONTRACT_ERA
    || question.value.draftId !== draft.id || !draft.value.questions.includes(question.id)
    || question.value.spec.field !== 'plan' || question.value.status !== 'answered' || !isRef(question.value.answer)
    || canonical(question.value.answer) !== canonical(subject.planAnswer))
    consumerInvalid(id, 'The attempt subject is not a plan-question of the exact accepted plan its Question basis names');
  let planned: { planQuestionId: string }[];
  try { planned = provePlanQuestions(store, draft, subject.planAnswer); }
  catch (error) {
    if (error instanceof EngineError) consumerInvalid(id, `The attempt subject's plan edition is not proven: ${error.code}`);
    throw error;
  }
  if (!planned.some(item => item.planQuestionId === subject.planQuestionId))
    consumerInvalid(id, 'The attempt subject names a plan-question outside its proven plan edition');
}
export function prepareResearchConsumerIntent(store: Store, input: ResearchConsumerIntentInput,
  permits: readonly Ref[] = [],
  /** DRS1a2: a trusted parameter of the calling code (never a context field)
   * selecting the compact v2 storage for an analyst call. */
  options: { contextContract?: typeof CONTEXT_PREPARATION_CONTRACT } = {}): Revision<ResearchConsumerIntent> {
  if (!object(input)) consumerInvalid('research-consumer-intent', 'A complete consumer admission is required');
  if (!Array.isArray(permits) || !permits.every(isRef))
    consumerInvalid('research-consumer-intent', 'Retry permits must be exact saved terminal references');
  const scoped = earlyResearchStage(store.get<DiscoveryDraft>(input.draft.id, input.draft.revision)?.value.stage);
  const previous = findResearchConsumerIntent(store, input.projectId, input.kind, input.key, scoped ? input.draft.id : undefined);
  const replacing = !!previous && retryableResearchConsumerRefusal(store, previous)
    && permits.some(permit => canonical(permit) === canonical(reference(previous)));
  let currentRefusedCall: Ref | null = null;
  if (replacing) {
    const terminalRef = previous.value.refusal!.call;
    const terminal = store.get<ModelCall>(terminalRef.id, terminalRef.revision);
    const head = store.get<ModelCall>(terminalRef.id);
    const withoutRuntime = (value: ModelCall) => Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'runtime'));
    if (!terminal || !head || canonical(reference(terminal)) !== canonical(terminalRef)
      || head.revision < terminal.revision || hashJson(head.value) !== head.hash
      || canonical(withoutRuntime(head.value)) !== canonical(withoutRuntime(terminal.value)))
      consumerInvalid(previous.id, 'The refused physical call changed beyond runtime telemetry before retry admission');
    currentRefusedCall = reference(head);
  }
  const generation = replacing ? previous.value.generation + 1 : previous?.value.generation ?? 0;
  const value: ResearchConsumerIntent = { ...input, contract: 'research-consumer-intent/v1',
    rootKey: input.key, generation, previous: replacing ? reference(previous!) : previous?.value.previous ?? null,
    state: 'prepared', call: null, request: null, archive: null, outputs: null, refusal: null };
  requireIntentSubject(store, value, input.key);
  // Retain an existing attempt's era; a new external generation declares its
  // own admission. An old paid/unsent operation is never reclassified here.
  value.cursor = { ...input.cursor };
  // DRS1a2: the compact contract is chosen by the calling code for an analyst
  // call only (not in preview, which writes nothing). Its preparation is built
  // here from the one context this producer also declares capacity for, and is
  // published in the same batch as the intent that first names it.
  if (options.contextContract !== undefined)
    requireCondition(options.contextContract === CONTEXT_PREPARATION_CONTRACT && input.kind === 'analyst',
      'research_consumer_intent_invalid', 'Only an analyst call may select the compact context contract');
  const compact = options.contextContract === CONTEXT_PREPARATION_CONTRACT && !isResearchPreview();
  let context: Record<string, any> = value.cursor.context;
  let preparationWrites: Write[] = [], preparationGuards: Ref[] = [];
  const toCompact = () => {
    if (!compact) return;
    requireCondition(object(context), 'research_consumer_intent_invalid', 'The compact call needs its exact context object');
    const { context: _carried, ...cursor } = value.cursor;
    value.cursor = cursor;
    value.contract = CONSUMER_INTENT_V2;
    const prepared = prepareContextPreparation(store, preparationBinding(value, input.key), context);
    value.preparation = prepared.preparation;
    preparationWrites = prepared.writes; preparationGuards = prepared.guards;
  };
  toCompact();
  if (previous && !replacing && previous.value.state !== 'prepared') {
    if (previous.value.cursor.resultCapacityContract !== undefined) {
      value.cursor.resultCapacityContract = previous.value.cursor.resultCapacityContract;
      value.cursor.resultCapacity = previous.value.cursor.resultCapacity;
      value.cursor.resultCapacityPrompt = previous.value.cursor.resultCapacityPrompt;
    }
  } else {
    // G5a (возврат 1): an unchanged prepared admission returns its saved row
    // before the capacity builder runs — the declaration was proved once when
    // the producer wrote that revision. The builder below still runs for a
    // new admission, a retry generation or a lawful change of inputs.
    const same = !replacing && previous?.value.state === 'prepared' ? previous : null;
    if (same) {
      for (const field of ['resultCapacityContract', 'resultCapacity', 'resultCapacityPrompt'] as const)
        if (same.value.cursor[field] === undefined) delete value.cursor[field];
        else value.cursor[field] = same.value.cursor[field];
      if (canonical(same.value) === canonical(value)) return same;
      delete value.cursor.resultCapacityContract;
      delete value.cursor.resultCapacity;
      delete value.cursor.resultCapacityPrompt;
    }
    const correction = previous ? consumerCapacityCorrection(store, previous) : null;
    if (correction) {
      context = { ...context, failures: [correction] };
      if (compact) toCompact(); else value.cursor.context = context;
    }
    value.cursor.resultCapacityContract = RESULT_CAPACITY;
    const profile = value.profile ? store.get<ReaderPilot>(value.profile.id, value.profile.revision)! : undefined;
    for (let n = 0; n < 4; n += 1) {
      value.cursor.resultCapacity = declareResultCapacity(store, consumerResultCapacity(store, value, context));
      const actual = prepareResearchEnvelope(value.role, value.dispatch, value.cursor.prompt ?? value.cursor.instruction,
        context, { store, draftId: value.draft.id, questionId: value.question.id,
          purpose: ['synthesis', 'consolidation'].includes(value.kind) ? 'analyst' : value.kind, ...(profile ? { pilot: profile } : {}),
          ...(compact ? { contextContract: ARCHIVE_PARTS_CONTRACT } : {}) },
        value.cursor.resultCapacity);
      if (consumerResultCapacity(store, value, context).mandatoryEnvelope.prompt === actual.envelope.prompt) { value.cursor.resultCapacityPrompt = actual.envelope.prompt; break; }
      value.cursor.resultCapacityPrompt = actual.envelope.prompt;
      requireCondition(n < 3, 'research_capacity_configuration', 'The admission prompt has no stable packet projection');
    }
  }
  // The preflight above may have saved content-addressed parts the
  // preparation shares; its writes are derived again on the final store state
  // (the Ref is unchanged), so the batch writes only parts still absent.
  toCompact();
  consumerShape(value, 'research-consumer-intent');
  requireEscalationNeighbors(store, value, 'research-consumer-intent');
  if (previous && !sameLogicalConsumerStep(previous.value, value))
    consumerInvalid(previous.id, 'A retry generation changed the original logical step');
  const id = researchConsumerIntentId(value.projectId, value.kind, value.key, generation);
  if (previous && !replacing) {
    const checked = previous;
    const normalized = { ...checked.value, state: 'prepared' as const,
      call: null, request: null, archive: null, outputs: null, refusal: null };
    if (!samePreparedSubject(store, normalized, value))
      consumerInvalid(id, 'The operation key names a different saved admission');
    if (checked.value.state === 'prepared' && canonical(checked.value) !== canonical(value)) {
      if (isResearchPreview()) return { ...checked, revision: checked.revision + 1, hash: hashJson(value), value };
      return store.writeMany<ResearchConsumerIntent>([...preparationWrites, { id, kind: checked.kind, expected: checked.revision, value }],
        uniqueTransactionGuards([reference(checked), ...value.guards, ...preparationGuards])).at(-1)!;
    }
    return checked;
  }
  if (isResearchPreview()) return { id, kind: 'research-consumer-intent', revision: 1,
    hash: hashJson(value), value };
  // DRS1a2 (P2-04): one batch publishes the new parts, the preparation and the
  // intent — each new record expected:0 — and positively guards only records
  // that already exist; the intent's saved guards never name a record of
  // this batch.
  return store.writeMany<ResearchConsumerIntent>([...preparationWrites, { id, kind: 'research-consumer-intent', expected: 0, value }],
    uniqueTransactionGuards([...value.guards, ...preparationGuards, ...(replacing ? [reference(previous!), currentRefusedCall!] : []),
      { id, absent: true }])).at(-1)!;
}
export function prepareResearchConsumerReservation(store: Store, intentRef: Ref, call: Write,
  request: Ref, archive: Ref): { writes: Write[]; guards: TransactionGuard[] } {
  const intent = readResearchConsumerIntent(store, intentRef);
  if (intent.value.state !== 'prepared' || !object(call.value) || call.kind !== 'model-call' || call.expected !== 0
    || !isRef(request) || !isRef(archive) || !object(call.value.request) || !object(call.value.packet)
    || !isRef(call.value.request.record) || canonical(call.value.request.record) !== canonical(request)
    || !isRef(call.value.packet.archive) || canonical(call.value.packet.archive) !== canonical(archive)
    || !isRef(call.value.consumerIntent) || canonical(call.value.consumerIntent) !== canonical(reference(intent))
    || call.value.projectId !== intent.value.projectId || call.value.draftId !== intent.value.draft.id
    || !callAddressesSubject(call.value, intent.value.question, cursorSubject(intent.value, intent.id))
    || canonical(call.value.requested) !== canonical(intent.value.role)
    || canonical(call.value.profile ?? null) !== canonical(intent.value.profile)
    || call.value.purpose !== (intent.value.kind === 'synthesis' || intent.value.kind === 'consolidation'
      ? 'analyst' : intent.value.kind))
    consumerInvalid(intent.id, 'The pending physical claim is not the exact admitted consumer call');
  const runner = ['analyst', 'reading-planner', 'escalation-assessor'].includes(intent.value.kind);
  const expectedOwnerTurns = intent.value.kind === 'escalation-assessor'
    ? intent.value.cursor.turn : intent.value.cursor.turn - 1;
  const owner = store.get<{projectId:string;draftId:string;turns:number;status:string}>(intent.value.owner.id);
  if (!owner || canonical(reference(owner)) !== canonical(intent.value.owner) && !runner)
    consumerInvalid(intent.id, 'The original consumer cursor changed before physical reservation');
  if (runner && (owner.kind !== 'research-run' || !object(owner.value)
    || owner.value.projectId !== intent.value.projectId || owner.value.draftId !== intent.value.draft.id
    || owner.value.turns !== expectedOwnerTurns || owner.value.status !== 'running'))
    consumerInvalid(intent.id, 'The resumed run no longer owns the exact admitted turn');
  const write: Write = { id: intent.id, kind: 'research-consumer-intent', expected: intent.revision,
    value: { ...intent.value, state: 'running', call: pendingRef(call), request, archive } satisfies ResearchConsumerIntent };
  return { writes: [write], guards: uniqueTransactionGuards([reference(intent), reference(owner),
    ...intent.value.guards.filter(guard => !runner || guard.id !== intent.value.owner.id)]) };
}

/** The saved session producer selects the contract; a missing response field
 * cannot turn a new assessment into historical legacy execution. */
export function assessmentSessionEra(session: Revision<RecoverableContextSession>): boolean {
  requireCondition(isRef(session) && object(session.value), 'response_recovery_session_stale', 'An exact saved consumer session is required');
  if (session.kind !== 'assessment-session') return false;
  const current = session.id.startsWith('assessment-session:v1:')
    || session.id.startsWith('assessment-session:v2:');
  requireCondition(current
    ? session.value['contract'] === 'assessment-application/v1'
      && typeof session.value['application'] === 'string' && session.value['application'].length > 0
    : !Object.hasOwn(session.value, 'contract'),
  'response_recovery_session_stale', 'The assessment session must retain its producer contract and application identity');
  return current;
}

interface AssessmentReadEntry { id: string; revision: number | null; ref: Ref | null; absence?: { head: Ref | null } }
type AssessmentFileObservation = { kind: 'bytes'; path: string; bytes: string }
  | { kind: 'relocated'; path: string }
  | { kind: 'unavailable'; operation: 'realpath' | 'read'; path: string | null; code: string };
interface AssessmentFileSnapshot { source: Ref; observation: AssessmentFileObservation }
export interface AssessmentReadProof {
  contract: 'assessment-read/v1'; reads: AssessmentReadEntry[]; files: AssessmentFileSnapshot[];
}

/** One evaluation's semantic input view. The local owner-document projection
 * substitutes a captured filesystem observation for Evidence's live probe; it
 * is never a saved Source and must never be registered as transparent in S1. */
export function assessmentReadView(store: Store, savedProof?: AssessmentReadProof | null): {
  store: Store; proof: AssessmentReadProof; guards: TransactionGuard[]; readonly position: number; finish(): AssessmentReadProof;
} {
  let invalid: EngineError | null = null;
  function fail(message: string): never {
    invalid ??= new EngineError('research_context_read_proof_invalid', message);
    throw invalid;
  }
  const shape = (value: unknown, keys: string[]): value is Record<string, any> => object(value)
    && Object.keys(value).sort().join(',') === keys.sort().join(',');
  const ref = (value: unknown): value is Ref => shape(value, ['id', 'revision', 'hash']) && isRef(value);
  const knownError = (code: unknown): code is string => typeof code === 'string' && code.length > 0
    && Object.hasOwn(systemConstants.errno, code);
  function validate(proof: unknown): asserts proof is AssessmentReadProof {
    if (!shape(proof, ['contract', 'reads', 'files']) || proof.contract !== 'assessment-read/v1'
      || !Array.isArray(proof.reads) || !Array.isArray(proof.files)) fail('The assessment read proof must retain its complete declared shape');
    for (const entry of proof.reads) {
      if (!object(entry) || !shape(entry, entry.revision !== null && entry.ref === null
        ? ['id', 'revision', 'ref', 'absence'] : ['id', 'revision', 'ref']) || typeof entry.id !== 'string' || entry.id.length === 0
        || !(entry.revision === null || Number.isSafeInteger(entry.revision) && entry.revision > 0)
        || !(entry.ref === null || ref(entry.ref) && entry.ref.id === entry.id
          && (entry.revision === null || entry.ref.revision === entry.revision))) fail('A captured get must retain its exact selector and result');
      if (entry.revision !== null && entry.ref === null && (!shape(entry.absence, ['head'])
        || !(entry.absence.head === null || ref(entry.absence.head) && entry.absence.head.id === entry.id
          && entry.absence.head.revision < entry.revision))) fail('A missing exact revision must retain the prior append-only head');
    }
    const sources = new Set<string>();
    for (const file of proof.files) {
      if (!shape(file, ['source', 'observation']) || !ref(file.source)
        || !proof.reads.some((entry: AssessmentReadEntry) => entry.ref && canonical(entry.ref) === canonical(file.source)))
        fail('A file snapshot must belong to an exact Source read in this evaluation');
      const key = canonical(file.source);
      if (sources.has(key)) fail('A file source may have only one snapshot per evaluation');
      sources.add(key);
      const observation = file.observation;
      if (!object(observation)) fail('A file snapshot needs an explicit observed outcome');
      if (observation.kind === 'bytes') {
        if (!shape(observation, ['kind', 'path', 'bytes']) || typeof observation.path !== 'string' || observation.path.length === 0
          || typeof observation.bytes !== 'string' || Buffer.from(observation.bytes, 'base64').toString('base64') !== observation.bytes)
          fail('File bytes must retain their resolved path and canonical base64 encoding');
      } else if (observation.kind === 'relocated') {
        if (!shape(observation, ['kind', 'path']) || typeof observation.path !== 'string' || observation.path.length === 0)
          fail('A relocated source must retain its resolved path');
      } else if (observation.kind === 'unavailable') {
        if (!shape(observation, ['kind', 'operation', 'path', 'code']) || !knownError(observation.code)
          || !(observation.operation === 'realpath' && observation.path === null
            || observation.operation === 'read' && typeof observation.path === 'string' && observation.path.length > 0))
          fail('An unavailable file must retain the actual filesystem operation and errno');
      } else fail('The file snapshot has an unknown observed outcome');
    }
  }
  if (!store || typeof store.get !== 'function') fail('An assessment read view needs a readable Store');
  const replay = savedProof !== undefined && savedProof !== null;
  let proof: AssessmentReadProof;
  if (replay) {
    validate(savedProof);
    proof = JSON.parse(canonical(savedProof)) as AssessmentReadProof;
  } else proof = { contract: 'assessment-read/v1', reads: [], files: [] };
  const guards: TransactionGuard[] = [], usedFiles = new Set<string>();
  let position = 0, finished = false;
  const filesystem = (source: Ref, value: Source): AssessmentFileSnapshot => {
    const key = canonical(source);
    let snapshot = proof.files.find(file => canonical(file.source) === key);
    if (!snapshot && replay) fail('The captured file snapshot required by this Source is missing');
    if (!snapshot) {
      let observation: AssessmentFileObservation, path: string;
      try { path = realpathSync(value.origin.location); }
      catch (error) {
        const code = object(error) ? error.code : undefined;
        if (!knownError(code)) fail('The filesystem did not provide an attributable errno');
        snapshot = { source, observation: { kind: 'unavailable', operation: 'realpath', path: null, code } };
        proof.files.push(snapshot); usedFiles.add(key); return snapshot;
      }
      if (path !== value.origin.location) observation = { kind: 'relocated', path };
      else {
        try { observation = { kind: 'bytes', path, bytes: readFileSync(path).toString('base64') }; }
        catch (error) {
          const code = object(error) ? error.code : undefined;
          if (!knownError(code)) fail('The filesystem did not provide an attributable errno');
          observation = { kind: 'unavailable', operation: 'read', path, code };
        }
      }
      snapshot = { source, observation }; proof.files.push(snapshot);
    }
    usedFiles.add(key);
    return snapshot;
  };
  const get = <T>(id: string, revision?: number): Revision<T> | null => {
    if (invalid) throw invalid;
    if (finished) fail('An assessment read view cannot escape its finished evaluation');
    if (typeof id !== 'string' || id.length === 0 || revision !== undefined && (!Number.isSafeInteger(revision) || revision <= 0))
      fail('An assessment read must name a valid Store selector');
    let entry: AssessmentReadEntry, record: Revision<T> | null;
    if (replay) {
      const saved = proof.reads[position];
      if (!saved || saved.id !== id || saved.revision !== (revision ?? null)) fail('The historical evaluation read a different input sequence');
      entry = saved;
      try { record = entry.ref ? store.get<T>(entry.ref.id, entry.ref.revision) : null; }
      catch { fail('The exact captured Store revision could not be read'); }
      if (entry.ref && (!record || canonical(reference(record)) !== canonical(entry.ref))) fail('An exact captured revision is missing or foreign');
      if (entry.absence?.head) {
        const expected = entry.absence.head;
        let head: Revision | null;
        try { head = store.get(expected.id, expected.revision); }
        catch { fail('The exact head proving the missing revision could not be read'); }
        if (!head || canonical(reference(head)) !== canonical(expected) || hashJson(head.value) !== expected.hash)
          fail('The captured head does not prove the missing historical revision');
      }
    } else {
      try { record = store.get<T>(id, revision); }
      catch { fail('The assessment Store input could not be captured exactly'); }
      entry = { id, revision: revision ?? null, ref: record ? reference(record) : null };
      if (!record && revision !== undefined) {
        let head: Revision | null;
        try {
          head = store.get(id);
          // Capture the head before confirming absence. A concurrent append
          // either supplies this immutable revision or invalidates its guard.
          record = store.get<T>(id, revision);
        } catch { fail('The missing exact revision could not be captured with its head'); }
        if (record) entry.ref = reference(record);
        else {
          if (head && (head.id !== id || !ref(reference(head)) || hashJson(head.value) !== head.hash || head.revision >= revision))
            fail('A missing exact revision cannot precede an existing append-only head');
          entry.absence = { head: head ? reference(head) : null };
        }
      }
      proof.reads.push(entry);
    }
    position++;
    if (record) {
      let matches = false;
      try { matches = record.id === id && (revision === undefined || record.revision === revision)
        && ref(reference(record)) && hashJson(record.value) === record.hash; }
      catch { fail('The captured Store result is not a complete exact revision'); }
      if (!matches) fail('A captured Store result does not match its exact saved bytes');
    }
    if (revision === undefined) guards.push(entry.ref ?? { id, absent: true });
    else if (entry.ref === null) guards.push(entry.absence!.head ?? { id, absent: true });
    // Evidence.observe probes the Source head before checking the filesystem.
    // Exact archived reads retain the original Source, including /origin; the
    // local projection must not change any addressable historical value.
    if (revision === undefined && record?.kind === 'source' && object(record.value) && object(record.value.origin) && record.value.origin.kind === 'file') {
      const source = record.value as unknown as Source;
      if (typeof source.content !== 'string' || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256)
        || typeof source.origin.location !== 'string' || source.origin.location.length === 0) fail('A captured file Source is malformed');
      const snapshot = filesystem(reference(record), source), observed = snapshot.observation;
      if (observed.kind === 'relocated' && observed.path === source.origin.location
        || observed.kind === 'bytes' && observed.path !== source.origin.location
        || observed.kind === 'unavailable' && observed.operation === 'read' && observed.path !== source.origin.location)
        fail('The file snapshot contradicts its exact Source path');
      // This is the same predicate as sourceIsCurrent, evaluated from captured
      // external bytes instead of consulting today's filesystem during replay.
      if (digest(source.content) !== source.sha256 || observed.kind !== 'bytes'
        || digest(Buffer.from(observed.bytes, 'base64')) !== source.sha256)
        throw new EngineError('source_stale', 'The captured source file changed or could not be read during assessment');
      return { ...record, value: { ...source, origin: { ...source.origin, kind: 'owner-document' } } as T };
    }
    return record;
  };
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get') return get;
    const value = Reflect.get(target, key, target);
    if (typeof value === 'function') return () => fail('Assessment input views support only captured get reads');
    return value;
  } });
  return { store: view, proof, guards, get position() { return position; }, finish() {
    if (invalid) throw invalid;
    validate(proof);
    if (position !== proof.reads.length || usedFiles.size !== proof.files.length)
      fail('The historical evaluation must consume the complete read and filesystem proof');
    guards.splice(0, guards.length, ...uniqueTransactionGuards(guards));
    finished = true; return proof;
  } };
}

interface ResearchExecutionContext {
  call: Revision<ModelCall>; request: Ref; archive: Ref;
  body: Record<string, any>; subject: Record<string, any>; prompt: string; guards: Ref[];
}
export type ResearchExecution = ResearchExecutionContext & (
  { kind: 'response'; payload: unknown; response: Ref }
  | { kind: 'provider-failed'; response: Ref }
  | { kind: 'terminal'; code: 'run_stopped' | 'run_control_changed' | 'process_cancelled' | 'process_output_limit'; response: null });

/** The receipt records runProcess's close result, not an interpretation of its
 * status label. Both producers share the same physical proof. */
function physicalExecution(store: Store, call: Revision<ModelCall>, value: Record<string, any>,
  receiptName: 'assessmentExecution' | 'consumerExecution', claimName: 'assessmentApplication' | 'consumerIntent',
  contract: 'assessment-execution/v1' | 'research-consumer-execution/v1'): Ref[] {
  const receipt = value[receiptName];
  const fields = (record: Record<string, any>, names: string[]) => Object.keys(record).sort().join(',') === names.sort().join(',');
  const identity = (record: unknown): record is { pid: number; started: string } => object(record)
    && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.started === 'string' && record.started.length > 0;
  requireCondition(object(receipt) && fields(receipt, ['contract', 'call', 'dispatch', 'process'])
    && receipt.contract === contract && isRef(receipt.call) && isRef(receipt.dispatch)
    && object(receipt.process) && fields(receipt.process, ['exitCode', 'signal', 'stderr'])
    && (receipt.process.exitCode === null || Number.isSafeInteger(receipt.process.exitCode) && receipt.process.exitCode >= 0)
    && (receipt.process.signal === null || typeof receipt.process.signal === 'string' && receipt.process.signal.length > 0)
    && typeof receipt.process.stderr === 'string',
  'response_recovery_execution_invalid', 'The saved physical outcome needs its complete process receipt');
  const claim = store.get<ModelCall>(receipt.call.id, receipt.call.revision);
  const dispatch = store.get<ModelCall>(receipt.dispatch.id, receipt.dispatch.revision);
  requireCondition(claim?.kind === 'model-call' && dispatch?.kind === 'model-call' && object(claim.value) && object(dispatch.value)
    && canonical(reference(claim)) === canonical(receipt.call) && canonical(reference(dispatch)) === canonical(receipt.dispatch)
    && hashJson(claim.value) === claim.hash && hashJson(dispatch.value) === dispatch.hash
    && claim.id === call.id && dispatch.id === call.id && claim.revision === 1 && dispatch.revision === claim.revision + 1
    && call.revision > dispatch.revision && claim.value.status === 'running' && claim.value.finishedAt === null
    && claim.value.response === null && claim.value.error === null && isRef((claim.value as ModelCall & { assessmentApplication?: Ref; consumerIntent?: Ref })[claimName]),
  'response_recovery_execution_invalid', 'The physical receipt must name the original assessment claim and authorization');
  const before = claim.value.execution, authorized = dispatch.value.execution;
  requireCondition(before?.version === 'model-execution/v1' && before.phase === 'claimed' && identity(before.owner)
    && identity(claim.value.ownerProcess) && canonical(before.owner) === canonical(claim.value.ownerProcess)
    && before.provider === null && claim.value.providerProcess === undefined
    && authorized?.version === 'model-execution/v1' && authorized.phase === 'authorized' && identity(authorized.provider)
    && (authorized.provider.group === null || authorized.provider.group === authorized.provider.pid)
    && identity(authorized.owner) && canonical(authorized.owner) === canonical(before.owner) && identity(dispatch.value.providerProcess)
    && canonical(dispatch.value.providerProcess) === canonical({ pid: authorized.provider.pid, started: authorized.provider.started }),
  'response_recovery_execution_invalid', 'The physical receipt must follow an authorized assessment dispatch');
  const without = (record: ModelCall, excluded: string[]) => Object.fromEntries(Object.entries(record).filter(([key]) => !excluded.includes(key)));
  requireCondition(canonical(without(claim.value, ['execution', 'providerProcess'])) === canonical(without(dispatch.value, ['execution', 'providerProcess']))
    && canonical(without(dispatch.value, ['status', 'finishedAt', 'response', 'usage', 'usageSource', 'error', 'confirmed', 'runtime']))
      === canonical(without(call.value, ['status', 'finishedAt', 'response', 'usage', 'usageSource', 'error', 'confirmed', 'runtime']))
    && Number.isSafeInteger(call.value.finishedAt) && Number(call.value.finishedAt) >= call.value.startedAt,
  'response_recovery_execution_invalid', 'The terminal call changed its authorized physical identity');
  requireCondition(call.value.status === 'succeeded'
    ? call.value.error === null && receipt.process.exitCode === 0 && receipt.process.signal === null
    : call.value.status === 'failed',
  'response_recovery_execution_invalid', 'The saved status contradicts the physical process outcome');
  if (contract === 'research-consumer-execution/v1') {
    const profile = isRef(call.value.profile)
      ? store.get<import('./reader-pilot.js').ReaderPilot>(call.value.profile.id, call.value.profile.revision) : null;
    if (isRef(call.value.profile) && (!profile || canonical(reference(profile)) !== canonical(call.value.profile)))
      consumerInvalid(call.id, 'The physical reply lost its exact reader profile');
    const projected = projectResearchPhysicalReply(value.text, call.value.requestId,
      receipt.process.exitCode, receipt.process.stderr, profile?.value.physicalLimits?.maxReplyChars ?? null);
    requireCondition(call.value.status === projected.status && call.value.error === projected.error
      && canonical(call.value.usage) === canonical(projected.usage)
      && call.value.usageSource === projected.usageSource
      && canonical(call.value.confirmed) === canonical(projected.confirmed),
    'response_recovery_execution_invalid', 'The terminal status, error and usage must derive from the exact process and reply');
  }
  return [receipt.call, receipt.dispatch];
}
function assessmentExecution(store: Store, call: Revision<ModelCall>, value: Record<string, any>): Ref[] {
  return physicalExecution(store, call, value, 'assessmentExecution', 'assessmentApplication', 'assessment-execution/v1');
}

function assessmentControlTerminal(store: Store, call: Revision<ModelCall>): 'run_stopped' | 'run_control_changed' | 'process_cancelled' | 'process_output_limit' | null {
  const code = call.value.error;
  if (code === 'process_output_limit') { requireLimitedCallTerminal(store, call); return code; }
  // DRY6-02: a dispatched assessor call the common stop cancelled, proved by its saved stop link; the terminal must follow
  // its exact running dispatch with nothing else changed.
  if (call.value.status === 'failed' && call.value.response === null && code === 'process_cancelled') {
    if (!stopCancelledCall(store, call)) return null;
    const running = store.get<ModelCall>(call.id, call.revision - 1);
    const same = (value: ModelCall) => Object.fromEntries(Object.entries(value)
      .filter(([field]) => !['status', 'finishedAt', 'error', 'runtime'].includes(field)));
    requireCondition(running?.kind === 'model-call' && running.value.status === 'running' && running.value.response === null
      && running.value.error === null && canonical(same(running.value)) === canonical(same(call.value))
      && Number.isSafeInteger(call.value.finishedAt) && Number(call.value.finishedAt) >= call.value.startedAt,
    'response_recovery_execution_invalid', 'The stop-cancelled terminal must immediately follow its exact running dispatch');
    return 'process_cancelled';
  }
  if (call.value.status !== 'failed' || call.value.response !== null
    || !['run_stopped', 'run_control_changed'].includes(code ?? '')) return null;
  const before = store.get<ModelCall>(call.id, call.revision - 1), claim = store.get<ModelCall>(call.id, 1);
  const execution = executionOf(call.value);
  const excluding = (value: ModelCall) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !['status', 'finishedAt', 'error', 'runtime'].includes(field)));
  requireCondition(before?.kind === 'model-call' && claim?.kind === 'model-call'
    && before.value.status === 'running' && before.value.response === null && before.value.error === null
    && claim.value.status === 'running' && claim.value.response === null && claim.value.error === null
    && execution?.phase === 'claimed' && executionOf(before.value)?.phase === 'claimed'
    && executionOf(claim.value)?.phase === 'claimed'
    && canonical(excluding(before.value)) === canonical(excluding(call.value))
    && canonical(reference(claim)) === canonical(reference(before))
    && Number.isSafeInteger(call.value.finishedAt) && Number(call.value.finishedAt) >= call.value.startedAt,
  'response_recovery_execution_invalid', 'The control refusal must immediately follow its exact unsubmitted physical claim');
  return code as 'run_stopped' | 'run_control_changed';
}

export type ResearchConsumerExecution = {
  intent: Revision<ResearchConsumerIntent>; call: Revision<ModelCall>; request: Ref; archive: Ref;
  subject: Record<string, any>; prompt: string; guards: TransactionGuard[];
} & ({ kind: 'response'; payload: unknown; response: Ref }
  | { kind: 'provider-failed'; code: 'provider_failed_without_response'; response: Ref; envelope?: true }
  | { kind: 'terminal'; code: string; response: Ref | null });
/**
 * RS3 (№4414, №4426): a provider failure leaves no model response — the adapter wrote nothing, or only the envelope of its
 * own request. codex-stdio and devin-stdio print that envelope on EVERY failure, also after the model answered and the
 * answer could not be read; only the adapter's structured error line (the last line of its stderr) tells them apart. So
 * the envelope is a failure without a response only under provider_failed or provider_empty; under any other code, or
 * without the line, the model may have answered — the prior terminal. A response with research, a foreign request or
 * another field is an answer of its own kind.
 */
const NO_RESPONSE_ERRORS: readonly string[] = ['provider_failed', 'provider_empty'];
function adapterErrorCode(stderr: unknown): string | null {
  const last = typeof stderr === 'string' ? stderr.split('\n').map(line => line.trim()).filter(Boolean).at(-1) : undefined;
  if (!last) return null;
  try { const parsed: unknown = JSON.parse(last); return object(parsed) && typeof parsed.error === 'string' ? parsed.error : null; }
  catch { return null; }
}
function noModelResponse(text: string, protocol: unknown, requestId: unknown, stderr: unknown): 'empty' | 'envelope' | null {
  if (text === '') return 'empty';
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  return object(parsed) && Object.keys(parsed).every(key => ['protocol', 'requestId', 'usage'].includes(key))
    && parsed.protocol === protocol && parsed.requestId === requestId
    && (!Object.hasOwn(parsed, 'usage') || parsed.usage === null || object(parsed.usage))
    && NO_RESPONSE_ERRORS.includes(adapterErrorCode(stderr) ?? '') ? 'envelope' : null;
}
/**
 * A new external generation may answer a proved provider failure or an early
 * model reply error. The original refusal and its physical evidence stay terminal.
 * Pre-RS3 envelope-only failures retain their original representation.
 */
export function earlyResearchConsumerFailure(store: Store, intent: Revision<ResearchConsumerIntent>): EngineError | null {
  if (!['analyst', 'escalation-assessor'].includes(intent.value.kind)) return null;
  const draft = store.get<DiscoveryDraft>(intent.value.draft.id, intent.value.draft.revision);
  const question = store.get<Question>(intent.value.question.id, intent.value.question.revision);
  if (!draft || !question || canonical(reference(draft)) !== canonical(intent.value.draft)
    || canonical(reference(question)) !== canonical(intent.value.question))
    consumerInvalid(intent.id, 'The early reply lost its original draft or question');
  if (!earlyResearchStage(draft.value.stage)) return null;
  const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  if (paid.kind !== 'response') return null;
  // DR3a3-K (№7475 п.11): the FieldSpec/early answer checks of the plan field
  // never apply to an attempt subject — its reply is checked by the subject/end
  // contract, and a malformed paid end is a refusal without a second payment.
  if (cursorSubject(intent.value, intent.id)) return consumerCapacityFailure(store, intent, paid.payload);
  const context = consumerIntentContext(store, intent.value, intent.id);
  return consumerCapacityFailure(store, intent, paid.payload) ?? earlyResearchFailure(draft.value, question.value,
    intent.value.kind as 'analyst' | 'escalation-assessor', paid.payload,
    context?.discoveryContext ?? null, intentWebCapability(store, intent), earlyUnknownAdmission(store, intent, draft, question),
    context?.discoveryBasisCatalogue ?? null,
    deliveredConceptSections(context, draft.value),
    context?.prerequisites ?? null);
}
/** UNK1 (№4686 §3): the unknown-era admission of one early analyst call, from its saved cursor and original draft — null in
 * the DRY5FIX era, so an old need_research keeps its refusal. */
export function earlyUnknownAdmission(store: Store, intent: Revision<ResearchConsumerIntent>, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>) {
  return intent.value.kind === 'analyst' && earlyUnknownEra(intent.value.cursor)
    ? { questionId: question.id, targets: earlyUpstreamTargets(store, draft.value) } : null;
}
/**
 * UNK1 (№4686 §3): the one derivation of an early unknown turn — its producer, the exact draft and question of that producer,
 * the sources the run actually read before this turn, and the exact upstream stage the paid action names. The runner
 * completes the turn with it and the historical reader proves the completed turn with it.
 */
export function earlyUnknownProof(store: Store, producer: Revision<ResearchConsumerIntent>, turn: Revision<Record<string, any>>): TurnTransitionProof {
  const draft = store.get<DiscoveryDraft>(producer.value.draft.id, producer.value.draft.revision);
  const questionRef = turn.value.question;
  const question = isRef(questionRef) ? store.get<Question>(questionRef.id, questionRef.revision) : null;
  if (!draft || !question || canonical(reference(draft)) !== canonical(producer.value.draft)
    || canonical(reference(question)) !== canonical(questionRef))
    consumerInvalid(turn.id, 'The early unknown lost its exact original draft or question');
  let action: ResearchAction;
  try { action = turnAction(turn.value); }
  catch { consumerInvalid(turn.id, 'The early unknown lost its paid action'); }
  if (action.action !== 'need_research') consumerInvalid(turn.id, 'An early unknown completes a paid need_research');
  // The searched material is what each earlier turn's FIRST completed revision saved — the read source (ref), the fetched
  // page (source) or the web capture (capture). Immutable history: the writer and every later reader derive the same list.
  const read = store.list<ResearchTurn>('research-turn').filter(row => row.value.run === turn.value.run && row.value.number < turn.value.number)
    .sort((a, b) => a.value.number - b.value.number)
    .flatMap(row => {
      const completed = store.history<ResearchTurn>(row.id).find(item => item.value.status === 'completed');
      const seen = completed?.value.observation as { ref?: unknown; source?: unknown; capture?: unknown } | null | undefined;
      const ref = [seen?.ref, seen?.source, seen?.capture].find(isRef);
      return ref ? [ref] : [];
    });
  const searched = [...new Map(read.map(ref => [canonical(ref), { id: ref.id, revision: ref.revision, hash: ref.hash }])).values()];
  let upstream: { stage: Revision<StageArtifact>; field: string } | undefined;
  if (action.upstream) {
    const stage = store.get<StageArtifact>(action.upstream.stage.id, action.upstream.stage.revision);
    if (!stage || canonical(reference(stage)) !== canonical(action.upstream.stage))
      consumerInvalid(turn.id, 'The upstream address names no exact saved stage');
    upstream = { stage, field: action.upstream.field };
  }
  return { kind: 'early-unknown', draft, question, producer, searched, ...(upstream ? { upstream } : {}) };
}
export function retryableResearchConsumerRefusal(store: Store, intent: Revision<ResearchConsumerIntent>): boolean {
  const refusal = intent.value.state === 'refused' ? intent.value.refusal : null;
  if (!refusal) return false;
  if (refusal.kind === 'provider-failed') return true;
  if (refusal.code === RESULT_CAPACITY_REFUSAL) {
    const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
    return paid.kind === 'response' && consumerCapacityFailure(store, intent, paid.payload) !== null;
  }
  if (refusal.kind === 'consumer-invalid' && earlyResearchConsumerFailure(store, intent)) return true;
  if (refusal.kind === 'terminal' && ['run_stopped', 'run_control_changed'].includes(refusal.code)) {
    const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
    return paid.kind === 'terminal' && paid.response === null && paid.code === refusal.code
      && executionOf(paid.call.value)?.phase === 'claimed';
  }
  if (refusal.kind === 'terminal' && refusal.code === 'process_output_limit') {
    const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
    return paid.kind === 'terminal' && paid.response === null && paid.code === 'process_output_limit'
      && readLimitedCallRetryPermit(store, paid.call, paid.call.value.consumerIntent!) !== null;
  }
  if (refusal.kind === 'terminal' && refusal.code === 'process_cancelled') return cancelledCallRetryable(store, intent);
  if (refusal.kind !== 'terminal' || refusal.code !== 'research_provider_failed') return false;
  const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  return paid.kind === 'provider-failed' && paid.envelope === true;
}

/**
 * DRY6-02 (contract №4961 (b)): one new generation of a dispatched A/C attempt cancelled without a response — only after the
 * explicit resume of exactly the stop proved to have cancelled it, or by the explicit addressed permit of that exact call
 * for an older terminal without such a proof. A cancelled process has no physical result to receive (its run rejects before
 * close), so there is nothing to apply first; the earlier attempt keeps its record and its possible cost.
 */
function cancelledCallRetryable(store: Store, intent: Revision<ResearchConsumerIntent>): boolean {
  const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  if (paid.kind !== 'terminal' || paid.response !== null || paid.code !== 'process_cancelled') return false;
  const cancelled = stopCancelledCall(store, paid.call);
  if (cancelled) return liftedStop(store, intent.value.projectId, cancelled.stop) !== null;
  return readCallRetryPermit(store, paid.call, intent) !== null;
}

export const CALL_RETRY_PERMIT_KIND = 'call-retry-permit';
export const CALL_RETRY_PERMIT_CONTRACT = 'call-retry-permit/v1' as const;
export const callRetryPermitId = (call: string): string => `${CALL_RETRY_PERMIT_KIND}:${call}`;
export interface CallRetryPermit { contract: typeof CALL_RETRY_PERMIT_CONTRACT; projectId: string; call: Ref; intent: Ref; actor: string }
function readCallRetryPermit(store: Store, call: Revision<ModelCall>, intent: Revision<ResearchConsumerIntent>): Revision<CallRetryPermit> | null {
  const permit = store.get<CallRetryPermit>(callRetryPermitId(call.id));
  if (!permit) return null;
  const value = permit.value;
  requireCondition(permit.kind === CALL_RETRY_PERMIT_KIND && object(value) && value.contract === CALL_RETRY_PERMIT_CONTRACT
    && value.projectId === intent.value.projectId && canonical(value.call) === canonical(reference(call))
    && canonical(value.intent) === canonical(reference(intent)) && typeof value.actor === 'string' && value.actor.trim().length > 0,
  'call_retry_permit_invalid', `[${permit.id}] The permit names another call or intent`);
  return permit;
}
/**
 * DRY6-02: the explicit addressed door for an older dispatched A/C attempt cancelled without a response and without a saved
 * stop link: the caller permits ONE new attempt of that exact call. Nothing old is reinterpreted — the terminal, its intent
 * refusal and any possible cost stay; no new draft, no repeat of accepted questions. A repeat returns the same permit.
 */
export function permitCancelledCallRetry(store: Store, request: { project: string; call: Ref }, actor: string): Revision<CallRetryPermit> {
  const refuse = (code: string, message: string): never => {
    throw new EngineError(code, `[${isRef(request?.call) ? request.call.id : 'model-call'}] ${message}`, { call: request?.call ?? null });
  };
  if (!request || typeof request.project !== 'string' || !request.project || !isRef(request.call) || typeof actor !== 'string' || !actor.trim())
    refuse('call_retry_permit_invalid', 'The door names its project, the exact call and its actor');
  const call = store.get<ModelCall>(request.call.id);
  if (!call || call.kind !== 'model-call' || canonical(reference(call)) !== canonical(request.call) || call.value.projectId !== request.project)
    refuse('call_retry_permit_stale', 'The named call is not the current terminal of this project');
  if (call!.value.status !== 'failed' || call!.value.error !== 'process_cancelled' || call!.value.response !== null)
    refuse('call_retry_permit_invalid', 'Only a dispatched attempt cancelled without a response is permitted again');
  if (stopCancelledCall(store, call!)) refuse('call_retry_permit_unneeded', 'The common stop is proved for this call; its explicit resume permits the attempt');
  if (!isRef(call!.value.consumerIntent))
    refuse('call_retry_permit_unsupported', 'An assessor B attempt is recovered through the reopen door of its assessed question');
  // The call names the intent revision it was sent under; its refusal is that intent's current head.
  const sent = readResearchConsumerIntent(store, call!.value.consumerIntent!), now = store.get<ResearchConsumerIntent>(sent.id);
  const intent = now ? readResearchConsumerIntent(store, reference(now)) : sent;
  const head = findResearchConsumerIntent(store, request.project, intent.value.kind, intent.value.key, intent.value.draft.id);
  if (intent.value.state !== 'refused' || intent.value.refusal?.kind !== 'terminal' || intent.value.refusal.code !== 'process_cancelled'
    || canonical(intent.value.refusal.call) !== canonical(reference(call!)) || head?.id !== intent.id)
    refuse('call_retry_permit_stale', 'The call is not the refused current attempt of its work');
  const existing = readCallRetryPermit(store, call!, intent);
  if (existing) return existing;
  return store.writeMany<CallRetryPermit>([{ id: callRetryPermitId(call!.id), kind: CALL_RETRY_PERMIT_KIND, expected: 0,
    value: { contract: CALL_RETRY_PERMIT_CONTRACT, projectId: request.project, call: reference(call!), intent: reference(intent), actor } }],
  [reference(call!), reference(intent)])[0]!;
}

export const LIMITED_CALL_RETRY_PERMIT = 'limited-call-retry-permit/v1' as const;
export interface LimitedCallRetryPermit {
  contract: typeof LIMITED_CALL_RETRY_PERMIT; projectId: string; call: Ref; terminal: Ref; consumer: Ref; actor: string;
}
const limitedCallRetryPermitId = (call: string) => `limited-call-retry-permit:${call}`;

/** The runtime's own dispatched terminal proves loss of a complete response;
 * neither a partial stdout nor an arbitrary failed label grants another call. */
function requireLimitedCallTerminal(store: Store, call: Revision<ModelCall>): Revision<ModelCall> {
  const withoutRuntime = (value: ModelCall) => Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'runtime'));
  for (;;) {
    const prior = store.get<ModelCall>(call.id, call.revision - 1);
    if (!prior || prior.value.status !== 'failed' || canonical(withoutRuntime(prior.value)) !== canonical(withoutRuntime(call.value))) break;
    call = prior;
  }
  const before = store.get<ModelCall>(call.id, call.revision - 1);
  const unchanged = (value: ModelCall) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !['status', 'finishedAt', 'error', 'runtime'].includes(field)));
  requireCondition(call.kind === 'model-call' && call.value.status === 'failed' && call.value.error === 'process_output_limit'
    && call.value.response === null && executionOf(call.value)?.phase === 'authorized'
    && before?.kind === 'model-call' && before.value.status === 'running' && before.value.response === null
    && before.value.error === null && executionOf(before.value)?.phase === 'authorized'
    && canonical(unchanged(call.value)) === canonical(unchanged(before.value))
    && Number.isSafeInteger(call.value.finishedAt) && Number(call.value.finishedAt) >= call.value.startedAt,
  'limited_call_retry_invalid', `[${call.id}] Only the exact dispatched output-limit terminal without a usable response may be retried`);
  return call;
}

export function readLimitedCallRetryPermit(store: Store, call: Revision<ModelCall>, consumer: Ref): Revision<LimitedCallRetryPermit> | null {
  const terminal = requireLimitedCallTerminal(store, call);
  requireCondition(isRef(consumer) && [call.value.consumerIntent, call.value.assessmentApplication]
    .some(binding => canonical(binding ?? null) === canonical(consumer)),
  'limited_call_retry_invalid', `[${call.id}] Permission must name the exact dispatched operation`);
  const permit = store.get<LimitedCallRetryPermit>(limitedCallRetryPermitId(call.id));
  if (!permit) return null;
  const issuedFor = isRef(permit.value?.call) ? store.get<ModelCall>(permit.value.call.id, permit.value.call.revision) : null;
  requireCondition(issuedFor && canonical(reference(issuedFor)) === canonical(permit.value.call),
    'limited_call_retry_invalid', `[${call.id}] The exact call under which permission was issued is missing`);
  requireCondition(permit.kind === 'limited-call-retry-permit' && permit.value.contract === LIMITED_CALL_RETRY_PERMIT
    && permit.value.projectId === call.value.projectId && isRef(permit.value.call) && permit.value.call.id === call.id
    && canonical(permit.value.terminal) === canonical(reference(terminal))
    && canonical(reference(requireLimitedCallTerminal(store, issuedFor))) === canonical(reference(terminal))
    && canonical(permit.value.consumer) === canonical(consumer) && typeof permit.value.actor === 'string' && !!permit.value.actor.trim(),
  'limited_call_retry_invalid', `[${call.id}] The saved permission must bind this exact paid attempt and its original operation`);
  return permit;
}

export function permitLimitedCallRetry(store: Store, request: { project: string; call: Ref }, actor: string): Revision<LimitedCallRetryPermit> {
  requireCondition(request && typeof request.project === 'string' && !!request.project && isRef(request.call)
    && typeof actor === 'string' && !!actor.trim(), 'limited_call_retry_invalid', 'The door needs the project, exact call and actor');
  const call = store.get<ModelCall>(request.call.id);
  requireCondition(call?.kind === 'model-call' && call.value.projectId === request.project
    && canonical(reference(call)) === canonical(request.call), 'limited_call_retry_stale', 'The named call is not the current terminal of this project');
  const terminal = requireLimitedCallTerminal(store, call);
  let consumer: Ref, guards: TransactionGuard[];
  if (isRef(call.value.consumerIntent)) {
    const sent = readResearchConsumerIntent(store, call.value.consumerIntent), current = store.get<ResearchConsumerIntent>(sent.id)!;
    const intent = readResearchConsumerIntent(store, reference(current));
    const latest = findResearchConsumerIntent(store, request.project, intent.value.kind, intent.value.key, intent.value.draft.id);
    requireCondition(latest?.id === intent.id && intent.value.state === 'refused' && intent.value.refusal?.kind === 'terminal'
      && intent.value.refusal.code === 'process_output_limit' && canonical(intent.value.refusal.call) === canonical(reference(terminal)),
    'limited_call_retry_stale', `[${call.id}] This is no longer the refused current attempt of its operation`);
    const paid = readResearchConsumerExecutionFromIntent(store, request.project, intent);
    requireCondition(paid.kind === 'terminal' && paid.code === 'process_output_limit' && paid.response === null,
      'limited_call_retry_invalid', `[${call.id}] The exact paid operation does not prove an output-limit failure`);
    const draft = store.get<DiscoveryDraft>(intent.value.draft.id, intent.value.draft.revision)!;
    consumer = call.value.consumerIntent;
    guards = [reference(intent), intent.value.draft, intent.value.question, ...draft.value.inputs, ...intent.value.basis,
      { id: researchConsumerIntentId(request.project, intent.value.kind, intent.value.key, intent.value.generation + 1), absent: true }];
  } else {
    const scope = limitedAssessmentRetryScope(store, call);
    consumer = scope.consumer; guards = scope.guards;
  }
  requireCondition(transactionGuardsCurrent(store, guards), 'limited_call_retry_stale', `[${call.id}] The question, inputs or current operation changed`);
  requireCondition(!store.list<ModelCall>('model-call').some(other => other.value.projectId === request.project
    && other.value.draftId === call.value.draftId && other.value.questionId === call.value.questionId && other.value.status === 'running'),
  'limited_call_retry_busy', `[${call.id}] This question already has an active physical claim`);
  const existing = readLimitedCallRetryPermit(store, call, consumer);
  if (existing) return existing;
  try {
    return store.writeMany<LimitedCallRetryPermit>([{ id: limitedCallRetryPermitId(call.id), kind: 'limited-call-retry-permit', expected: 0,
      value: { contract: LIMITED_CALL_RETRY_PERMIT, projectId: request.project, call: reference(call), terminal: reference(terminal), consumer, actor } }],
    uniqueTransactionGuards([reference(call), ...guards]))[0]!;
  } catch (error) {
    if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)
      || !store.get(limitedCallRetryPermitId(call.id))) throw error;
    // Re-enter all current-scope checks before returning a concurrent permit.
    return permitLimitedCallRetry(store, request, actor);
  }
}

/** The same exact physical proof is used for recovery and ordinary retry.
 * A terminal label alone never authorizes interpretation of paid bytes. */
export function readResearchConsumerExecution(store: Store, projectId: string, intentRef: Ref): ResearchConsumerExecution {
  if (!isRef(intentRef) || typeof projectId !== 'string' || !projectId)
    consumerInvalid('research-consumer-intent', 'Execution needs the exact original intent and project');
  const original = readResearchConsumerIntent(store, intentRef);
  const head = store.get<ResearchConsumerIntent>(original.id);
  if (!head) consumerInvalid(original.id, 'The consumer intent disappeared');
  const intent = readResearchConsumerIntent(store, reference(head));
  return readResearchConsumerExecutionFromIntent(store, projectId, intent);
}
/** Terminalize the exact physical outcome. Retry eligibility is derived
 * separately from this immutable attempt by the common rule; saving the
 * refusal never grants another call inside the current invocation. */
export function refuseResearchConsumerIntent(store: Store, intentRef: Ref,
  expectedCode?: string): Revision<ResearchConsumerIntent> {
  const supplied = readResearchConsumerIntent(store, intentRef);
  const current = store.get<ResearchConsumerIntent>(supplied.id);
  if (!current) consumerInvalid(supplied.id, 'The selected consumer intent disappeared');
  const intent = readResearchConsumerIntent(store, reference(current));
  if (intent.value.state === 'refused') return intent;
  if (intent.value.state !== 'running')
    consumerInvalid(intent.id, 'Only a running paid operation can close as no-response refused');
  const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  const synthesisFamily = intent.value.kind === 'synthesis' || intent.value.kind === 'consolidation';
  if (paid.kind !== 'response' && expectedCode)
    consumerInvalid(intent.id, 'A physical refusal cannot claim a semantic selection failure');
  let refusalKind: NonNullable<ResearchConsumerIntent['refusal']>['kind'];
  let refusalCode: string;
  if (paid.kind === 'response' && intent.value.kind === 'reader') {
    if (expectedCode !== RESULT_CAPACITY_REFUSAL && expectedCode !== 'reader_response_invalid' && expectedCode !== 'reader_response_empty'
      && expectedCode !== 'reader_selection_foreign' && expectedCode !== 'reader_output_limit')
      consumerInvalid(intent.id, 'A received response needs its proved reader refusal');
    if (readerRefusalCode(intent, paid.payload) !== expectedCode)
      consumerInvalid(intent.id, 'The claimed reader refusal differs from the exact paid selection');
    refusalKind = 'reader-invalid'; refusalCode = expectedCode;
  } else if (paid.kind === 'response' && synthesisFamily) {
    const proved = synthesisTransitionRefusalCode(store, intent, paid);
    if (!proved) consumerInvalid(intent.id, 'A cleanly applying synthesis response cannot become a refusal');
    if (expectedCode !== undefined && expectedCode !== proved)
      consumerInvalid(intent.id, 'The claimed synthesis refusal differs from the exact paid transition');
    refusalKind = 'consumer-invalid'; refusalCode = proved;
  } else if (paid.kind === 'response') {
    // C13/C62: an analyst/planner/escalation reply that cannot become an
    // action or verdict ends as a typed terminal consumer refusal bound to
    // this exact response — never a fabricated action or a re-payment.
    const proved = actionResponseRefusalCode(store, intent, paid);
    if (!proved) consumerInvalid(intent.id, 'A validly formed paid response cannot become a semantic refusal');
    if (expectedCode !== undefined && expectedCode !== proved)
      consumerInvalid(intent.id, 'The claimed refusal differs from the exact paid response');
    refusalKind = 'consumer-invalid'; refusalCode = proved;
  } else { refusalKind = paid.kind; refusalCode = paid.code; }
  const refusal: NonNullable<ResearchConsumerIntent['refusal']> = {
    kind: refusalKind, code: refusalCode,
    call: reference(paid.call), request: paid.request, response: paid.response, archive: paid.archive,
    ...(refusalCode === RESULT_CAPACITY_REFUSAL && paid.kind === 'response'
      ? { capacity: consumerCapacityFailure(store, intent, paid.payload)!.details as Record<string, unknown> } : {}) };
  return store.writeMany<ResearchConsumerIntent>([{ id: intent.id, kind: intent.kind,
    expected: intent.revision, value: { ...intent.value, state: 'refused', refusal } }],
  uniqueTransactionGuards([reference(intent), reference(paid.call), paid.request,
    ...(paid.response ? [paid.response] : []), paid.archive,
    ...(refusalCode === RESULT_CAPACITY_REFUSAL ? intent.value.guards : [])]))[0]!;
}
/** A public retry may settle an interrupted physical claim, but never sends
 * another request for the same intent. A refused result stays terminal. */
export function resumeResearchConsumerExecution(store: Store, projectId: string, intentRef: Ref): ResearchConsumerExecution {
  const original = readResearchConsumerIntent(store, intentRef);
  const head = store.get<ResearchConsumerIntent>(original.id);
  if (!head) consumerInvalid(original.id, 'The selected consumer intent disappeared');
  const intent = readResearchConsumerIntent(store, reference(head));
  if (intent.value.projectId !== projectId || !intent.value.call)
    consumerInvalid(intent.id, 'The original physical claim is not bound');
  if (intent.value.state === 'refused')
    throw new EngineError('research_consumer_execution_refused', `[${intent.id}] The proved empty provider result is terminal`,
      intent.value.refusal);
  const call = store.get<ModelCall>(intent.value.call.id);
  if (!call) consumerInvalid(intent.id, 'The bound physical claim disappeared');
  if (call.value.status === 'running') {
    try { recoverModelCall(store, projectId, reference(call)); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'model_call_still_running') throw error;
      throw new EngineError('research_consumer_execution_running',
        `[${intent.id}] The original provider is still running; preserve its one physical call`,
        { intent: reference(intent), call: reference(call) });
    }
  }
  const paid = readResearchConsumerExecution(store, projectId, reference(intent));
  if (paid.kind !== 'response') {
    const refused = refuseResearchConsumerIntent(store, reference(intent));
    throw new EngineError('research_consumer_execution_refused', `[${intent.id}] The proved physical result is terminal`,
      refused.value.refusal);
  }
  return paid;
}
function readResearchConsumerExecutionFromIntent(store: Store, projectId: string,
  intent: Revision<ResearchConsumerIntent>): ResearchConsumerExecution {
  if (intent.value.projectId !== projectId || !intent.value.call || !intent.value.request || !intent.value.archive)
    consumerInvalid(intent.id, 'The intended physical call has not been bound');
  // A running intent needs the current physical outcome for a new application.
  // Completed history instead uses its own terminal transition: a later
  // runtime-only revision of the call cannot change the response it consumed.
  let terminal: Ref | null = intent.value.state === 'refused' ? intent.value.refusal?.call ?? null : null;
  if (intent.value.state === 'applied') {
    const claim = store.get<ModelCall>(intent.value.call.id, intent.value.call.revision);
    const response = claim ? store.get<Record<string, any>>(`model-response:${claim.value.requestId}`, 1) : null;
    const dispatchRef = response?.value.consumerExecution?.dispatch;
    if (!claim || canonical(reference(claim)) !== canonical(intent.value.call)
      || !response || response.kind !== 'model-response' || response.revision !== 1
      || hashJson(response.value) !== response.hash || !isRef(dispatchRef)
      || dispatchRef.id !== claim.id)
      consumerInvalid(intent.id, 'The applied consumer lost its exact physical response receipt');
    const issued = store.get<ModelCall>(claim.id, dispatchRef.revision + 1);
    if (!issued || issued.kind !== 'model-call' || !isRef(issued.value.response?.record)
      || canonical(issued.value.response.record) !== canonical(reference(response)))
      consumerInvalid(intent.id, 'The applied consumer lost its terminal call revision');
    terminal = reference(issued);
  }
  const call = store.get<ModelCall>(intent.value.call.id, terminal?.revision);
  const consumer = (call?.value as ModelCall & { consumerIntent?: Ref } | undefined)?.consumerIntent;
  // The physical claim names the latest prepared revision it was bound to; a
  // re-prepared (C69) intent moves that anchor past the original admission.
  let bound = store.get<ResearchConsumerIntent>(intent.id, 1);
  for (let revision = 2; bound && revision <= intent.revision; revision += 1) {
    const step = store.get<ResearchConsumerIntent>(intent.id, revision);
    if (!step || step.value.state !== 'prepared') break;
    bound = step;
  }
  if (!call || !call.id.startsWith('model-call:consumer:v1:') || call.kind !== 'model-call' || !object(call.value) || hashJson(call.value) !== call.hash
    || call.id !== intent.value.call.id || terminal && canonical(reference(call)) !== canonical(terminal)
    || call.value.projectId !== projectId
    || !bound || !isRef(consumer) || canonical(consumer) !== canonical(reference(bound))
    || call.value.draftId !== intent.value.draft.id
    || !callAddressesSubject(call.value as unknown as Record<string, unknown>, intent.value.question,
      cursorSubject(intent.value, intent.id))
    || canonical(call.value.requested) !== canonical(intent.value.role)
    || canonical(call.value.profile ?? null) !== canonical(intent.value.profile))
    consumerInvalid(intent.id, 'The terminal model call is missing or belongs to another consumer');
  const purpose = intent.value.kind === 'synthesis' || intent.value.kind === 'consolidation' ? 'analyst' : intent.value.kind;
  if (call.value.purpose !== purpose) consumerInvalid(intent.id, 'The paid purpose does not match its consumer variant');
  if (call.value.status === 'running')
    throw new EngineError('research_consumer_execution_running', `[${intent.id}] Preserve the bound physical call until its outcome is proved`);
  if (call.value.status === 'failed' && call.value.error === 'process_lost') {
    const recovered = readModelCallRecovery(store, projectId, reference(call));
    const late = readLateModelReceipt(store, projectId, reference(call));
    throw new EngineError('research_consumer_execution_refused', `[${intent.id}] The proven physical interruption cannot be resent or applied automatically`,
      { call: reference(call), recovery: reference(recovered.incident), late: late ? reference(late) : null });
  }
  if (call.value.status === 'failed' && call.value.response === null) {
    const allowed = ['process_timeout', 'process_cancelled', 'process_failed',
      'process_output_limit', 'process_record_failed', 'research_call_failed'];
    const before = store.get<ModelCall>(call.id, call.revision - 1);
    const claim = store.get<ModelCall>(call.id, 1);
    const controlRefusedBeforeDispatch = !!before
      && ['run_stopped', 'run_control_changed'].includes(String(call.value.error))
      && executionOf(call.value)?.phase === 'claimed' && executionOf(before.value)?.phase === 'claimed';
    const excluding = (value: ModelCall) => Object.fromEntries(Object.entries(value).filter(([key]) =>
      !['status', 'finishedAt', 'error', 'runtime'].includes(key)));
    if (!(allowed.includes(String(call.value.error)) || controlRefusedBeforeDispatch) || !before || !claim
      || before.value.status !== 'running' || before.value.response !== null
      || canonical(excluding(before.value)) !== canonical(excluding(call.value))
      || claim.value.status !== 'running' || claim.value.response !== null
      || executionOf(claim.value)?.phase !== 'claimed' || !executionOf(before.value)
      || canonical(reference(claim)) !== canonical(intent.value.call))
      consumerInvalid(intent.id, 'The no-response terminal does not follow its exact physical claim');
    const requestRef = call.value.request.record, archiveRef = call.value.packet?.archive;
    if (isRef(requestRef) && requestRef.id.startsWith("request-manifest:")) {
      let provenRequest: ReturnType<typeof readRequestWire>;
      try {
        provenRequest = readRequestWire(store, requestRef, {
          projectId,
          draftId: intent.value.draft.id,
          requestId: call.value.requestId,
        });
      } catch {
        consumerInvalid(intent.id, 'The no-response terminal lost its exact request or archive');
      }
      const archive = isRef(archiveRef) ? store.get<Record<string, any>>(archiveRef.id, archiveRef.revision) : null;
      if (!archive || archive.kind !== 'research-context'
        || canonical(requestRef) !== canonical(intent.value.request)
        || canonical(reference(archive)) !== canonical(intent.value.archive))
        consumerInvalid(intent.id, 'The no-response terminal lost its exact request or archive');
      if (digest(provenRequest.text) !== call.value.request.hash
        || provenRequest.text.length !== call.value.request.chars
        || Buffer.byteLength(provenRequest.text) !== call.value.request.bytes)
        consumerInvalid(intent.id, 'The no-response terminal request bytes differ from physical record');
      let envelope: any;
      try { envelope = JSON.parse(provenRequest.text); } catch { consumerInvalid(intent.id, 'The original request envelope is invalid'); }
      if (!object(envelope) || envelope.protocol !== 'omg-agent/v1' || envelope.mode !== 'research'
        || envelope.requestId !== call.value.requestId || !object(envelope.subject)
        || canonical(envelope.subject.working?.archive ?? null) !== canonical(archiveRef))
        consumerInvalid(intent.id, 'The no-response terminal belongs to another request');
      return { kind: 'terminal', code: call.value.error!, intent, call, request: requestRef,
        response: null, archive: archiveRef!, subject: envelope.subject, prompt: envelope.prompt,
        guards: uniqueTransactionGuards([reference(intent), reference(call), requestRef, archiveRef!, ...provenRequest.partGuards, ...intent.value.guards]) };
    }
    const request = isRef(requestRef) ? store.get<{projectId:string;draftId:string;text:string}>(requestRef.id, requestRef.revision) : null;
    const archive = isRef(archiveRef) ? store.get<Record<string,any>>(archiveRef.id, archiveRef.revision) : null;
    if (!request || !archive || request.kind !== 'model-request' || archive.kind !== 'research-context'
      || canonical(reference(request)) !== canonical(intent.value.request)
      || canonical(reference(archive)) !== canonical(intent.value.archive)
      || request.value.projectId !== projectId || request.value.draftId !== intent.value.draft.id
      || digest(request.value.text) !== call.value.request.hash)
      consumerInvalid(intent.id, 'The no-response terminal lost its exact request or archive');
    let envelope: any;
    try { envelope = JSON.parse(request.value.text); } catch { consumerInvalid(intent.id, 'The original request envelope is invalid'); }
    if (!object(envelope) || envelope.protocol !== 'omg-agent/v1' || envelope.mode !== 'research'
      || envelope.requestId !== call.value.requestId || !object(envelope.subject)
      || canonical(envelope.subject.working?.archive ?? null) !== canonical(archiveRef))
      consumerInvalid(intent.id, 'The no-response terminal belongs to another request');
    return { kind: 'terminal', code: call.value.error!, intent, call, request: requestRef!,
      response: null, archive: archiveRef!, subject: envelope.subject, prompt: envelope.prompt,
      guards: uniqueTransactionGuards([reference(intent), reference(call), requestRef!, archiveRef!, ...intent.value.guards]) };
  }
  const requestRef = call.value.request.record, responseRef = call.value.response?.record, archiveRef = call.value.packet?.archive;
  if (!isRef(requestRef) || !isRef(responseRef) || !isRef(archiveRef)
    || canonical(requestRef) !== canonical(intent.value.request) || canonical(archiveRef) !== canonical(intent.value.archive))
    consumerInvalid(intent.id, 'The paid request, response or original context archive is missing');
  let requestText: string;
  let partGuards: Ref[] = [];
  let response: Revision<Record<string, any>> | null;
  let archive: Revision<Record<string, any>> | null;
  if (requestRef.id.startsWith("request-manifest:")) {
    let provenRequest: ReturnType<typeof readRequestWire>;
    try {
      provenRequest = readRequestWire(store, requestRef, {
        projectId,
        draftId: intent.value.draft.id,
        requestId: call.value.requestId,
      });
    } catch {
      consumerInvalid(intent.id, 'The exact saved wire records or archive are missing or foreign');
    }
    response = store.get<Record<string, any>>(responseRef.id, responseRef.revision);
    archive = store.get<Record<string, any>>(archiveRef.id, archiveRef.revision);
    requestText = provenRequest.text;
    partGuards = provenRequest.partGuards;
  } else {
    const request = store.get<{projectId:string;draftId:string;text:string}>(requestRef.id, requestRef.revision);
    response = store.get<Record<string, any>>(responseRef.id, responseRef.revision);
    archive = store.get<Record<string, any>>(archiveRef.id, archiveRef.revision);
    if (!request || request.kind !== 'model-request' || canonical(reference(request)) !== canonical(requestRef)
      || hashJson(request.value) !== request.hash
      || request.value.projectId !== projectId
      || request.value.draftId !== intent.value.draft.id
      || typeof request.value.text !== 'string')
      consumerInvalid(intent.id, 'The exact saved wire records or archive are missing or foreign');
    requestText = request.value.text;
  }
  if (!response || response.kind !== 'model-response' || canonical(reference(response)) !== canonical(responseRef)
    || !archive || archive.kind !== 'research-context' || canonical(reference(archive)) !== canonical(archiveRef)
    || hashJson(response.value) !== response.hash || hashJson(archive.value) !== archive.hash
    || response.value.projectId !== projectId
    || response.value.draftId !== intent.value.draft.id
    || !object(archive.value) || !isRef(archive.value.draft) || !isRef(archive.value.question)
    || canonical(archive.value.draft) !== canonical(intent.value.draft)
    || canonical(archive.value.question) !== canonical(intent.value.question)
    || typeof response.value.text !== 'string')
    consumerInvalid(intent.id, 'The exact saved wire records or archive are missing or foreign');
  // DRS1a2: the archive body by the archive's own saved contract — the whole
  // body literally, archive-parts/v1 restored from its exact parts.
  let archived: { body: Record<string, any>; partGuards: Ref[] };
  try { archived = readArchiveBody(store, archive); }
  catch (error) {
    if (error instanceof EngineError) consumerInvalid(intent.id, `The exact saved wire records or archive are missing or foreign: ${error.code}`);
    throw error;
  }
  const archiveBody = archived.body;
  if (digest(requestText) !== call.value.request.hash || requestText.length !== call.value.request.chars
    || Buffer.byteLength(requestText) !== call.value.request.bytes
    || response.value.text.length !== call.value.response!.chars || Buffer.byteLength(response.value.text) !== call.value.response!.bytes)
    consumerInvalid(intent.id, 'The paid request or response bytes differ from their physical record');
  let envelope: unknown;
  try { envelope = JSON.parse(requestText); }
  catch { consumerInvalid(intent.id, 'The exact saved request envelope is invalid'); }
  if (!object(envelope) || !object(envelope.subject) || typeof envelope.prompt !== 'string'
    || envelope.protocol !== 'omg-agent/v1' || envelope.mode !== 'research' || envelope.requestId !== call.value.requestId
    || envelope.model !== intent.value.role.model || envelope.effort !== intent.value.role.effort
    || (envelope.speed ?? 'inherited') !== (intent.value.role.speed ?? 'inherited')
    || canonical(envelope.subject.working?.archive ?? null) !== canonical(archiveRef))
    consumerInvalid(intent.id, 'The saved request belongs to another physical consumer');
  requirePacketMaterialDelivery(envelope.subject, archiveRef,
    (record, pointer) => {
      const saved = store.get<Record<string, any>>(record.id, record.revision);
      requireCondition(saved?.kind === 'research-context' && canonical(reference(saved)) === canonical(record)
        && saved.value.projectId === archive.value.projectId
        && canonical(saved.value.draft) === canonical(archive.value.draft)
        && canonical(saved.value.question) === canonical(archive.value.question),
      'research_context_undelivered', 'The material address is not a saved original of this research question');
      return contextValue({ ...saved.value, body: readArchiveBody(store, saved).body }, pointer);
    });
  requirePlanningNavigation(envelope.subject, archiveRef, archiveBody);
  if (intent.value.cursor.resultCapacityContract !== undefined
    && (envelope.prompt !== intent.value.cursor.resultCapacityPrompt
      || canonical(envelope.subject.resultCapacity) !== canonical(intent.value.cursor.resultCapacity)
      || canonical(archiveBody.resultCapacity) !== canonical(intent.value.cursor.resultCapacity)))
    consumerInvalid(intent.id, 'The paid request or archive lost its exact result declaration');
  if (intent.value.kind === 'synthesis' || intent.value.kind === 'consolidation') {
    if (archiveBody.synthesisSession !== intent.value.owner.id
      || archiveBody.dispatchMode !== (intent.value.kind === 'consolidation' ? 'consolidation' : 'synthesis')
      || canonical(envelope.subject.synthesisState) !== canonical(archiveBody.synthesisState))
      consumerInvalid(intent.id, 'The paid synthesis page belongs to another saved session');
  } else if (intent.value.kind === 'reader' && envelope.subject.role !== 'reader')
    consumerInvalid(intent.id, 'The paid reader request belongs to another source selection');
  physicalExecution(store, call, response.value, 'consumerExecution', 'consumerIntent', 'research-consumer-execution/v1');
  const guards = uniqueTransactionGuards([reference(intent), reference(call), requestRef, responseRef, archiveRef,
    ...partGuards, ...archived.partGuards, ...intent.value.guards]);
  const base = { intent, call, request: requestRef, response: responseRef, archive: archiveRef,
    subject: envelope.subject, prompt: envelope.prompt, guards };
  if (call.value.status === 'failed') {
    const process = response.value.consumerExecution?.process;
    const normalFailure = call.value.error === 'research_provider_failed'
      && process?.signal === null && Number.isSafeInteger(process?.exitCode) && process.exitCode > 0;
    const absent = normalFailure ? noModelResponse(response.value.text, envelope.protocol, envelope.requestId, process.stderr) : null;
    if (absent) return { kind: 'provider-failed', code: 'provider_failed_without_response', ...(absent === 'envelope' ? { envelope: true as const } : {}), ...base };
    if (typeof call.value.error !== 'string' || !call.value.error)
      consumerInvalid(intent.id, 'A failed call needs its saved original error');
    return { kind: 'terminal', code: call.value.error, ...base };
  }
  if (response.value.text === '') return { kind: 'terminal', code: 'research_response_invalid', ...base };
  let result: unknown;
  try { result = JSON.parse(response.value.text); }
  catch { return { kind: 'terminal', code: 'research_response_invalid', ...base }; }
  const linked = object(result) && result.protocol === envelope.protocol && result.requestId === envelope.requestId
    && Object.hasOwn(result, 'research');
  if (linked) {
    if (call.value.status !== 'succeeded' || call.value.error !== null)
      consumerInvalid(intent.id, 'A linked response contradicts the terminal physical status');
    if (intent.value.kind === 'synthesis' || intent.value.kind === 'consolidation') {
      const session = store.get<RecoverableContextSession>(intent.value.owner.id, intent.value.owner.revision);
      const draft = store.get<DiscoveryDraft>(intent.value.draft.id, intent.value.draft.revision);
      const question = store.get<Question>(intent.value.question.id, intent.value.question.revision);
      if (!session || !draft || !question || canonical(reference(session)) !== canonical(intent.value.owner)
        || canonical(reference(draft)) !== canonical(intent.value.draft)
        || canonical(reference(question)) !== canonical(intent.value.question))
        consumerInvalid(intent.id, 'The exact synthesis cursor, draft or question is missing');
      const checked = researchExecution(store, projectId, reference(call), session, draft, question,
        intent.value.role, intent.value.profile, false);
      if (checked.kind !== 'response' || canonical(checked.request) !== canonical(requestRef)
        || canonical(checked.response) !== canonical(responseRef) || canonical(checked.archive) !== canonical(archiveRef)
        || canonical(checked.payload) !== canonical((result as Record<string, unknown>)['research']))
        consumerInvalid(intent.id, 'The paid synthesis page does not derive from its exact saved cursor');
    }
    return { kind: 'response', payload: (result as Record<string, unknown>)['research'], ...base };
  }
  return { kind: 'terminal', code: 'research_response_foreign', ...base };
}

/** WB1 (№4639): the web capability of one saved call — its exact draft's stage, its role and its saved dispatch. */
export function intentWebCapability(store: Store, intent: Revision<ResearchConsumerIntent>): boolean {
  const draft = store.get<DiscoveryDraft>(intent.value.draft.id, intent.value.draft.revision);
  return webResearchCapability(draft?.value.stage, intent.value.kind, intent.value.dispatch);
}
/** The action of a paid reply read by its own saved intent: the web capability of its dispatch (WB1) and the
 * early-actions era of its cursor (UNK1). One reader for the runner, the refusal code and the historical proof. */
export function intentResponseAction(store: Store, intent: Revision<ResearchConsumerIntent>, payload: unknown): ResearchAction {
  const failure = consumerCapacityFailure(store, intent, payload);
  if (failure) throw failure;
  return responseAction(payload, intentWebCapability(store, intent), earlyUnknownEra(intent.value.cursor),
    cursorSubject(intent.value, intent.id));
}

/** The terminal refusal code a paid analyst/planner/escalation payload
 * deterministically produces, or null when the payload is well formed. The
 * derivation uses only the saved intent and response — no mutable heads. */
function actionResponseRefusalCode(store: Store, intent: Revision<ResearchConsumerIntent>,
  paid: ResearchConsumerExecution): string | null {
  if (paid.kind !== 'response') consumerInvalid(intent.id, 'A semantic refusal needs its received response');
  if (intent.value.kind === 'escalation-assessor') {
    try { const failure = consumerCapacityFailure(store, intent, paid.payload); if (failure) throw failure; requireEscalationReply(paid.payload); return null; }
    catch (error) { if (error instanceof EngineError) return error.code; throw error; }
  }
  try { intentResponseAction(store, intent, paid.payload); return null; }
  catch (error) {
    if (error instanceof EngineError && ACTION_RESPONSE_REFUSAL_CODES.has(error.code)) return error.code;
    throw error;
  }
}

/** D8.4e: the common reader of K. It proves the whole chain from the record's
 * own exact references — O@1 and P through the managed turn reader, R under
 * its managed proof B (which must be the record's assessmentProof), the
 * adjacent draft/question pair, the answer — and re-derives the record with
 * the shared projection. The reader ends at P: it never consults the
 * completed turn, so a completed turn that references K has no cycle.
 * `null` only when no record exists at the address; every damaged or foreign
 * mandatory source is an addressed refusal with the exact ref and reason. */
export function readResearchAcceptanceBinding(store: Store, projectId: string, turnId: string): {
  binding: Revision<ResearchAcceptanceBinding>; turn: Revision<ManagedResearchTurn>;
  pending: Revision<ManagedResearchTurn>; intent: Revision<ResearchConsumerIntent>;
  assessment: Revision<ResearchAssessment>; inputs: AcceptedPaidAnswerInputs;
  proof: NonNullable<ReturnType<typeof matchAcceptedPaidAnswer>> } | null {
  requireCondition(store && typeof store.get === 'function' && typeof projectId === 'string' && projectId.trim()
    && typeof turnId === 'string' && turnId.trim(), 'research_acceptance_binding_invalid',
  'An acceptance record needs its exact project and turn');
  const id = acceptanceBindingId(projectId, turnId);
  const lost = (ref: unknown, reason: string): never => {
    throw new EngineError('research_acceptance_binding_invalid',
      `[${id}] The acceptance record or a mandatory exact source is missing, foreign or changed: ${reason}`,
      { ref, reason });
  };
  const saved = store.get<ResearchAcceptanceBinding>(id);
  if (!saved) return null;
  const value = saved.value;
  if (saved.kind !== 'research-acceptance-binding' || saved.revision !== 1 || !object(value)
    || hashJson(value) !== saved.hash
    || Object.keys(value).sort().join(',') !== [...ACCEPTANCE_BINDING_FIELDS].sort().join(',')
    || value.contract !== ACCEPTANCE_BINDING_CONTRACT || value.projectId !== projectId
    || !isRef(value.turn) || !isRef(value.pending) || !isRef(value.intent)
    || !isRef(value.draftBefore) || !isRef(value.draftAfter) || !isRef(value.questionBefore)
    || !isRef(value.questionAfter) || !isRef(value.answer) || !isRef(value.assessment)
    || !isRef(value.assessmentProof)
    || value.turn.id !== turnId || value.turn.revision !== 1 || value.pending.id !== turnId)
    lost(reference(saved), 'form');
  // O and P through the common managed-turn reader (their own refusals as is).
  // P is required to be a pending revision BEFORE the full reader runs: the
  // reader of a completed revision would prove its own completion through
  // this very record (T → K → T). A record naming a completed revision as
  // its P is refused here, so the reader of K always ends at a pending P.
  const rawPending = store.get<Record<string, any>>(value.pending.id, value.pending.revision);
  if (!rawPending || rawPending.kind !== 'research-turn' || !object(rawPending.value)
    || rawPending.value.status !== 'pending' || canonical(reference(rawPending)) !== canonical(value.pending))
    lost(value.pending, 'pending-turn');
  const turn = readResearchConsumerTurn(store, value.turn) as Revision<ManagedResearchTurn>;
  const pending = readResearchConsumerTurn(store, value.pending) as Revision<ManagedResearchTurn>;
  if (pending.value.status !== 'pending' || canonical(pending.value.consumerIntent) !== canonical(value.intent)
    || canonical(turn.value.consumerIntent) !== canonical(value.intent)
    || canonical(pending.value.question) !== canonical(value.questionBefore))
    lost(value.pending, 'pending-turn');
  const intent = readResearchConsumerIntent(store, value.intent);
  let action: ResearchAction;
  try { action = turnAction(pending.value); }
  catch { return lost(value.pending, 'action'); }
  if ((action.action !== 'answer' && action.action !== 'answer_delta') || action.question !== value.questionBefore.id)
    lost(value.pending, 'action');
  // R under its managed proof B; B is the record's own assessmentProof, and
  // its pending revision precedes P on the same lawful pending chain.
  const assessment = readResearchAssessmentAt(store, projectId, turnId, value.assessment);
  const proofRecord = store.get<{ pending: Ref }>(assessmentBindingId(projectId, turnId));
  if (!proofRecord || canonical(reference(proofRecord)) !== canonical(value.assessmentProof))
    return lost(value.assessmentProof, 'assessment-proof');
  const assessedPending = proofRecord.value.pending;
  if (!isRef(assessedPending) || assessedPending.id !== turnId || assessedPending.revision > pending.revision)
    lost(value.assessmentProof, 'assessment-pending');
  for (let revision = assessedPending.revision; revision < pending.revision; revision += 1) {
    const step = store.get<Record<string, any>>(turnId, revision);
    if (!step || step.kind !== 'research-turn' || step.value.status !== 'pending'
      || revision === assessedPending.revision && canonical(reference(step)) !== canonical(assessedPending))
      lost(value.assessmentProof, 'assessment-pending');
  }
  const load = <T extends Record<string, any>>(ref: Ref, kind: string): Revision<T> => {
    const record = store.get<T>(ref.id, ref.revision);
    if (!record || record.kind !== kind || hashJson(record.value) !== record.hash
      || canonical(reference(record)) !== canonical(ref)) lost(ref, kind);
    return record!;
  };
  const draftBefore = load<DiscoveryDraft>(value.draftBefore, 'discovery-draft');
  const draftAfter = load<DiscoveryDraft>(value.draftAfter, 'discovery-draft');
  const questionBefore = load<Question>(value.questionBefore, 'question');
  const questionAfter = load<Question>(value.questionAfter, 'question');
  const answer = load<ResearchAnswer>(value.answer, 'research-answer');
  let expandedProposal: unknown;
  if (action.action === 'answer_delta') {
    try { expandedProposal = expandLayerDelta(pinnedLayerDeltaStore(store, action), draftBefore, questionBefore, action); }
    catch (error) {
      if (error instanceof EngineError) lost(value.draftBefore, `delta:${error.code}`);
      throw error;
    }
  }
  const inputs: AcceptedPaidAnswerInputs = { projectId, draftBefore, draftAfter, questionBefore, questionAfter,
    answer, assessment, action, ...(action.action === 'answer_delta' ? { expandedProposal } : {}) };
  const expected = projectAcceptanceBinding(inputs, { turn: value.turn, pending: value.pending,
    intent: value.intent, assessmentProof: value.assessmentProof });
  if (canonical(expected) !== canonical(value)) lost(reference(saved), 'derivation');
  const proof = matchAcceptedPaidAnswer(inputs);
  if (!proof) lost(reference(saved), 'acceptance-formula');
  return { binding: saved, turn, pending, intent, assessment, inputs, proof: proof! };
}

/** DR3a3-K: the paid call of the intent revision that applied this original
 * turn (O@1) — the call an attempt of that turn must name. */
function appliedTurnCall(store: Store, intent: Revision<ResearchConsumerIntent>, original: Ref): Ref | null {
  for (let revision = 2; ; revision += 1) {
    const step = store.get<ResearchConsumerIntent>(intent.id, revision);
    if (!step) return null;
    if (step.value.state === 'applied' && step.value.outputs?.some(output => canonical(output) === canonical(original)))
      return isRef(step.value.call) ? step.value.call : null;
  }
}

/** DR3a3-K: the common reader of the attempt binding. It proves the record
 * from its own exact references — O@1 and P through the managed turn reader,
 * I@1 and its paid call, the attempt through the DR3a1 proof — and re-derives
 * the record with the shared projection. P must be a pending revision BEFORE
 * the full reader runs (T → binding → T is refused), so the reader always ends
 * at P. `null` only when no record exists at the address; every damaged or
 * foreign source is an addressed refusal research_attempt_binding_invalid. */
export function readResearchAttemptBinding(store: Store, projectId: string, turnId: string): {
  binding: Revision<ResearchAttemptBinding>; turn: Revision<ManagedResearchTurn>;
  pending: Revision<ManagedResearchTurn>; intent: Revision<ResearchConsumerIntent>;
  attempt: Revision<V7Attempt>; inputs: AttemptTurnInputs } | null {
  requireCondition(store && typeof store.get === 'function' && typeof projectId === 'string' && projectId.trim()
    && typeof turnId === 'string' && turnId.trim(), 'research_attempt_binding_invalid',
  'An attempt record needs its exact project and turn');
  const id = attemptBindingId(projectId, turnId);
  const lost = (ref: unknown, reason: string): never => {
    throw new EngineError('research_attempt_binding_invalid',
      `[${id}] The attempt record or a mandatory exact source is missing, foreign or changed: ${reason}`,
      { ref, reason });
  };
  const saved = store.get<ResearchAttemptBinding>(id);
  if (!saved) return null;
  const value = saved.value;
  if (saved.kind !== ATTEMPT_BINDING_KIND || saved.revision !== 1 || !object(value)
    || hashJson(value) !== saved.hash
    || Object.keys(value).sort().join(',') !== [...ATTEMPT_BINDING_FIELDS].sort().join(',')
    || value.contract !== ATTEMPT_BINDING_CONTRACT || value.projectId !== projectId
    || !isRef(value.turn) || !isRef(value.pending) || !isRef(value.intent) || !isRef(value.planAnswer)
    || !isRef(value.attempt) || typeof value.planQuestionId !== 'string' || !value.planQuestionId.trim()
    || value.turn.id !== turnId || value.turn.revision !== 1 || value.pending.id !== turnId)
    lost(reference(saved), 'form');
  const rawPending = store.get<Record<string, any>>(value.pending.id, value.pending.revision);
  if (!rawPending || rawPending.kind !== 'research-turn' || !object(rawPending.value)
    || rawPending.value.status !== 'pending' || canonical(reference(rawPending)) !== canonical(value.pending))
    lost(value.pending, 'pending-turn');
  const turn = readResearchConsumerTurn(store, value.turn) as Revision<ManagedResearchTurn>;
  const pending = readResearchConsumerTurn(store, value.pending) as Revision<ManagedResearchTurn>;
  if (pending.value.status !== 'pending' || attemptEraOf(pending.value) !== 'attempt'
    || canonical(pending.value.consumerIntent) !== canonical(value.intent)
    || canonical(turn.value.consumerIntent) !== canonical(value.intent))
    lost(value.pending, 'pending-turn');
  const intent = readResearchConsumerIntent(store, value.intent);
  if (intent.revision !== 1) lost(value.intent, 'intent');
  const call = appliedTurnCall(store, intent, value.turn);
  if (!call) lost(value.intent, 'call');
  let attempt: Revision<V7Attempt>;
  try { attempt = proveAttempt(store, value.attempt).attempt; }
  catch (error) {
    if (error instanceof EngineError) return lost(value.attempt, `attempt:${error.code}`);
    throw error;
  }
  const inputs: AttemptTurnInputs = { projectId, pending, intent, call: call!, attempt };
  const expected = projectAttemptBinding(inputs, { turn: value.turn });
  if (canonical(expected) !== canonical(value)) lost(reference(saved), 'derivation');
  return { binding: saved, turn, pending, intent, attempt, inputs };
}

/** DR3a3-K: the writes that complete one pending attempt turn — the attempt
 * binding (expected 0) and the completed turn (expected P.revision) — and the
 * guards of their one batch: the run head and the attempt (the pending turn
 * is held by its expected revision; the intent head is already applied and
 * immutable for this turn). A caller that writes more in the same
 * transaction merges these. */
export function prepareResearchAttemptCompletion(store: Store, projectId: string, pendingRef: Ref, attemptRef: Ref):
  { writes: Write[]; guards: TransactionGuard[]; binding: ResearchAttemptBinding; turn: ManagedResearchTurn } {
  requireCondition(store && typeof projectId === 'string' && projectId.trim() && isRef(pendingRef) && isRef(attemptRef),
    'research_attempt_binding_invalid', 'An attempt completion needs its project, pending turn and attempt');
  const pending = readResearchConsumerTurn(store, pendingRef) as Revision<ManagedResearchTurn>;
  requireCondition(pending.value.status === 'pending' && attemptEraOf(pending.value) === 'attempt',
    'research_attempt_binding_invalid',
    `[${pending.id}] Only a pending paid answer of the attempt era completes through an attempt record`);
  const original = store.get<ManagedResearchTurn>(pending.id, 1);
  if (!original) consumerInvalid(pending.id, 'The attempt turn lost its original revision');
  const intent = readResearchConsumerIntent(store, pending.value.consumerIntent);
  const call = appliedTurnCall(store, intent, reference(original));
  requireCondition(isRef(call), 'research_attempt_binding_invalid', `[${pending.id}] The attempt turn lost its paid call`);
  // The DR3a2 door's own proof; its attempt_invalid is kept as is.
  const attempt = proveAttempt(store, attemptRef).attempt;
  const inputs: AttemptTurnInputs = { projectId, pending, intent, call, attempt };
  const binding = projectAttemptBinding(inputs, { turn: reference(original) });
  const id = attemptBindingId(projectId, pending.id);
  const turn = projectResearchTurnRevision(pending.value, { kind: 'attempt-recorded', inputs,
    binding: { ref: { id, revision: 1, hash: hashJson(binding) }, value: binding } });
  const run = store.get<ResearchRun>(pending.value.run);
  requireCondition(run?.kind === 'research-run' && object(run.value) && run.value.projectId === projectId,
    'research_attempt_binding_invalid', `[${pending.id}] The attempt turn lost its research run`);
  return { binding, turn,
    writes: [{ id, kind: ATTEMPT_BINDING_KIND, expected: 0, value: binding },
      { id: pending.id, kind: 'research-turn', expected: pending.revision, value: turn }],
    // №7475 п.5: under the pending (expected) and run heads; the attempt is immutable.
    guards: uniqueTransactionGuards([reference(run), attemptRef]) };
}

/** DR3a3-K: complete one pending attempt turn in one batch. A concurrent or
 * repeated completion is answered by the saved records: the same pending
 * revision completed through this very attempt returns that turn without a
 * write (after a reopen or a cold Store alike); any other completion refuses.
 * A conflict leaves neither half — the batch is one transaction. */
export function completeResearchAttemptTurn(store: Store, projectId: string, pendingRef: Ref, attemptRef: Ref):
  { turn: Revision<ManagedResearchTurn>; binding: Revision<ResearchAttemptBinding>; repeated: boolean } {
  const repeat = () => {
    const head = isRef(pendingRef) ? store.get<ManagedResearchTurn>(pendingRef.id) : null;
    if (!head || head.revision <= pendingRef.revision) return null;
    const completed = store.get<ManagedResearchTurn>(pendingRef.id, pendingRef.revision + 1);
    const proven = readResearchAttemptBinding(store, projectId, pendingRef.id);
    if (!completed || !proven || canonical(reference(proven.pending)) !== canonical(pendingRef)
      || canonical(proven.binding.value.attempt) !== canonical(attemptRef)
      || canonical(completed.value.attemptBinding ?? null) !== canonical(reference(proven.binding)))
      throw new EngineError('research_attempt_binding_invalid',
        `[${pendingRef.id}] The turn already moved on without completing through this attempt`,
        { ref: pendingRef, reason: 'completed' });
    readResearchConsumerTurn(store, reference(completed));
    return { turn: completed as Revision<ManagedResearchTurn>, binding: proven.binding, repeated: true };
  };
  const earlier = repeat();
  if (earlier) return earlier;
  const prepared = prepareResearchAttemptCompletion(store, projectId, pendingRef, attemptRef);
  if (isResearchPreview()) {
    const [bindingWrite, turnWrite] = prepared.writes;
    return { repeated: false,
      binding: { id: bindingWrite!.id, kind: ATTEMPT_BINDING_KIND, revision: 1, hash: hashJson(prepared.binding),
        value: prepared.binding },
      turn: { id: turnWrite!.id, kind: 'research-turn', revision: pendingRef.revision + 1,
        hash: hashJson(prepared.turn), value: prepared.turn } };
  }
  try {
    const written = store.writeMany<Record<string, any>>(prepared.writes, prepared.guards);
    return { binding: written[0] as Revision<ResearchAttemptBinding>,
      turn: written[1] as Revision<ManagedResearchTurn>, repeated: false };
  } catch (error) {
    if (error instanceof EngineError && error.code === 'revision_conflict') {
      const landed = repeat();
      if (landed) return landed;
    }
    throw error;
  }
}

/** №1745-2: load the acceptance chain persisted on the completed turn. Every
 * named record must exist exactly as referenced, agree with the pending
 * turn's own question and paid assessment, and still satisfy the shared
 * matchAcceptedPaidAnswer formula. */
function storedAcceptedAnswerInputs(store: Store, before: Revision<Record<string, any>>,
  original: Revision<Question>, assessment: Revision<ResearchAssessment>,
  projectId: string, stored: unknown): AcceptedPaidAnswerInputs {
  if (!object(stored)) consumerInvalid(before.id, 'The accepted paid answer lost its saved chain');
  const chain = stored as Record<string, unknown>;
  const load = <T extends Record<string, any>>(refValue: unknown, kind: string): Revision<T> => {
    const record = isRef(refValue) ? store.get<T>(refValue.id, refValue.revision) : null;
    if (!record || record.kind !== kind || hashJson(record.value) !== record.hash
      || canonical(reference(record)) !== canonical(refValue))
      consumerInvalid(before.id, 'The saved accepted-answer chain is missing or changed');
    return record!;
  };
  const draftBefore = load<DiscoveryDraft>(chain.draftBefore, 'discovery-draft');
  const draftAfter = load<DiscoveryDraft>(chain.draftAfter, 'discovery-draft');
  const questionBefore = load<Question>(chain.questionBefore, 'question');
  const questionAfter = load<Question>(chain.questionAfter, 'question');
  const answer = load<ResearchAnswer>(chain.answer, 'research-answer');
  const checkedAssessment = load<ResearchAssessment>(chain.assessment, 'research-assessment');
  if (canonical(reference(questionBefore)) !== canonical(reference(original))
    || canonical(reference(checkedAssessment)) !== canonical(reference(assessment)))
    consumerInvalid(before.id, 'The saved accepted-answer chain names other records');
  const action = turnAction(before.value);
  let expandedProposal: unknown;
  if (action.action === 'answer_delta')
    expandedProposal = expandLayerDelta(pinnedLayerDeltaStore(store, action), draftBefore, original, action);
  const inputs: AcceptedPaidAnswerInputs = { projectId, draftBefore, draftAfter,
    questionBefore, questionAfter, answer, assessment: checkedAssessment, action,
    ...(action.action === 'answer_delta' ? { expandedProposal } : {}) };
  if (!matchAcceptedPaidAnswer(inputs))
    consumerInvalid(before.id, 'The saved accepted-answer chain does not derive');
  return inputs;
}

function readerRefusalCode(intent: Revision<ResearchConsumerIntent>, payload: unknown): string | null {
  const capacity = researchResultFailure(intent.value.cursor.resultCapacity, payload);
  if (capacity) return capacity.code;
  const sources = intent.value.cursor.context?.sources;
  if (!Array.isArray(sources) || !sources.every((source: any) => object(source)
    && isRef(source.ref) && Array.isArray(source.lines)
    && source.lines.every((line: unknown) => Array.isArray(line) && Number.isSafeInteger(line[0]))))
    consumerInvalid(intent.id, 'The refused reader lost its original source packet');
  try {
    projectReaderSelection(sources.map((source: any) => ({ ref: source.ref,
      lines: source.lines.map((line: [number, string]) => ({ line: line[0] })) })), payload);
    return null;
  } catch (error) { if (error instanceof EngineError) return error.code; throw error; }
}

/** Rebuild the synthesis transition inputs from the exact intent and its
 * proved physical execution. Used by both the refusal proof and the
 * application validator; the transition itself never reads a mutable head. */
function synthesisTransitionProofInput(store: Store, intent: Revision<ResearchConsumerIntent>,
  paid: ResearchConsumerExecution, beforeRevision?: number): SynthesisTransitionInput {
  const cursor = intent.value.cursor;
  const session = store.get<SynthesisSessionState>(intent.value.owner.id, beforeRevision ?? intent.value.owner.revision);
  // DR3a3-S1: the v3 transition (actions parsed by the saved subject) is
  // connected with its producer in S5; until then it is an addressed refusal.
  if (session?.kind === 'synthesis-session' && session.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX))
    throw new EngineError('research_v7_mode_unavailable',
      `[${intent.id}] The v3 synthesis transition is not connected yet`, { session: reference(session) });
  if (!session || session.kind !== 'synthesis-session' || !object(session.value)
    || hashJson(session.value) !== session.hash
    || (beforeRevision === undefined && canonical(reference(session)) !== canonical(intent.value.owner))
    || session.value.contract !== 'synthesis-session/v2')
    consumerInvalid(intent.id, 'The synthesis step lost its exact original session state');
  const archive = store.get<Record<string, any>>(paid.archive.id, paid.archive.revision);
  if (!archive || archive.kind !== 'research-context' || !object(archive.value) || !object(archive.value.body)
    || canonical(reference(archive)) !== canonical(paid.archive) || hashJson(archive.value) !== archive.hash)
    consumerInvalid(intent.id, 'The synthesis step lost its exact archived context');
  const pilot = intent.value.profile
    ? store.get<import('./reader-pilot.js').ReaderPilot>(intent.value.profile.id, intent.value.profile.revision) : null;
  if (intent.value.profile && (!pilot || pilot.kind !== 'reader-pilot'
    || canonical(reference(pilot)) !== canonical(intent.value.profile)))
    consumerInvalid(intent.id, 'The synthesis step lost its exact reader profile');
  return { store, projectId: intent.value.projectId,
    kind: intent.value.kind === 'consolidation' ? 'consolidation' : 'synthesis',
    sessionId: intent.value.owner.id, before: session.value, draft: intent.value.draft, question: intent.value.question,
    delivery: object(cursor.delivery) && typeof cursor.delivery.run === 'string' && Number.isSafeInteger(cursor.delivery.turn)
      ? { run: cursor.delivery.run, turn: cursor.delivery.turn } : null,
    subject: paid.subject, payload: paid.kind === 'response' ? paid.payload : null, archive: archive.value.body,
    readLimit: pilot?.value.maxRequestChars ?? 300000,
    // Origin proof is mandatory on every path through this proof input:
    // the write validator, the refusal proof and the historical reader alike.
    proveRecord: record => { readReaderResultAt(store, intent.value.projectId, reference(record)); } };
}

/** The saved refusal of a received synthesis reply is lawful only when the
 * common transition actually throws that typed refusal on the exact inputs. */
function synthesisTransitionRefusalCode(store: Store, intent: Revision<ResearchConsumerIntent>,
  paid: ResearchConsumerExecution): string | null {
  try {
    projectSynthesisTransition(synthesisTransitionProofInput(store, intent, paid));
    return null;
  } catch (error) {
    if (error instanceof EngineError && SYNTHESIS_TRANSITION_REFUSAL_CODES.has(error.code)) return error.code;
    throw error;
  }
}

/** The exact transition a paid synthesis-family step produced, re-derived for
 * the session chain reader and the application validator from one formula.
 * Proven history also proves every lookup record by its own general reader:
 * a session chain never stands on a record that reader rejects. */
export function projectPaidSynthesisTransition(store: Store, intent: Revision<ResearchConsumerIntent>) {
  const paid = readResearchConsumerExecution(store, intent.value.projectId, reference(intent));
  if (paid.kind !== 'response')
    consumerInvalid(intent.id, 'The applied synthesis step has no proved received response');
  // The transition was derived on the exact predecessor of the produced
  // revision — reservation-only steps in between belong to the same task.
  const produced = (intent.value.outputs ?? []).find(output => output.id === intent.value.owner.id);
  return projectSynthesisTransition(synthesisTransitionProofInput(store, intent, paid,
    produced ? produced.revision - 1 : undefined));
}

/** `mode` (D8.4e §4): a live 'application' must carry the producer's era
 * marker on its original turn; a 'historical' replay of a saved application
 * is checked by the form its own producer saved — a turn written before the
 * marker existed is the earlier era, never rewritten. */
function validateConsumerApplicationWrites(store: Store, intent: Revision<ResearchConsumerIntent>, writes: Write[],
  physical?: ResearchConsumerExecution, mode: 'application' | 'historical' = 'historical'): void {
  if (intent.value.kind === 'synthesis' || intent.value.kind === 'consolidation') {
    const paid = physical ?? readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
    if (paid.kind !== 'response') consumerInvalid(intent.id, 'An applied synthesis step needs the paid response');
    let transition: ReturnType<typeof projectSynthesisTransition>;
    try { transition = projectSynthesisTransition(synthesisTransitionProofInput(store, intent, paid)); }
    catch (error) {
      if (error instanceof EngineError) consumerInvalid(intent.id,
        `The applied synthesis session does not derive from its paid response: ${error.code}`);
      throw error;
    }
    const sessionWrite = writes.find(write => write.id === intent.value.owner.id);
    const rest = writes.filter(write => write.id !== intent.value.owner.id);
    if (!sessionWrite || sessionWrite.kind !== 'synthesis-session')
      consumerInvalid(intent.id, 'The session write does not derive from the exact paid response and cursor');
    // Reservation-only steps may sit between the step's owner and the applied
    // head (№1658 К2): the transition is then re-derived on the proven head.
    let beforeRevision = intent.value.owner.revision;
    for (let revision = intent.value.owner.revision + 1; revision <= sessionWrite!.expected; revision += 1) {
      const step = store.get<SynthesisSessionState>(intent.value.owner.id, revision);
      const prior = store.get<SynthesisSessionState>(intent.value.owner.id, revision - 1);
      if (!step || !prior || !isReservationOnlySessionStep(step.value, prior.value))
        consumerInvalid(intent.id, 'The session write does not derive from the exact paid response and cursor');
      beforeRevision = revision;
    }
    if (beforeRevision !== intent.value.owner.revision) {
      transition = projectSynthesisTransition(synthesisTransitionProofInput(store, intent, paid, beforeRevision));
    }
    if (canonical(sessionWrite!.value) !== canonical(transition.session))
      consumerInvalid(intent.id, 'The session write does not derive from the exact paid response and cursor');
    if (transition.checkpoint) {
      const checkpointWrite = rest.find(write => write.id === transition.checkpoint!.id);
      if (checkpointWrite) {
        if (checkpointWrite.kind !== 'research-checkpoint' || checkpointWrite.expected !== 0
          || canonical(checkpointWrite.value) !== canonical(transition.checkpoint.value))
          consumerInvalid(intent.id, 'The checkpoint write does not derive from the exact paid response');
      } else {
        const existing = store.get(transition.checkpoint.id);
        if (!existing || existing.kind !== 'research-checkpoint' || hashJson(existing.value) !== existing.hash
          || canonical(existing.value) !== canonical(transition.checkpoint.value))
          consumerInvalid(intent.id, 'The applied checkpoint is missing its exact saved record');
      }
      if (rest.length !== (checkpointWrite ? 1 : 0)) consumerInvalid(intent.id, 'The application carried foreign writes');
    } else if (rest.length) consumerInvalid(intent.id, 'The application carried foreign writes');
    return;
  }
  if (writes.some(write => write.id === intent.id || !Number.isSafeInteger(write.expected) || write.expected < 0)
    || new Set(writes.map(write => write.id)).size !== writes.length)
    consumerInvalid(intent.id, 'The application omitted its required consumer state or contains an invalid transition');
  const origin = store.get<ResearchConsumerIntent>(intent.id, 1);
  if (!origin || origin.kind !== 'research-consumer-intent')
    consumerInvalid(intent.id, 'The original consumer producer is missing');
  if (['analyst', 'reading-planner', 'escalation-assessor'].includes(intent.value.kind)) {
    const turnId = intent.value.kind === 'escalation-assessor' && isRef(intent.value.cursor.pendingTurn)
      ? intent.value.cursor.pendingTurn.id
      : managedTurnId(intent.value.owner.id, intent.value.cursor.turn);
    const run = writes.find(write => write.id === intent.value.owner.id);
    const turn = writes.find(write => write.id === turnId) ?? null;
    const previousTurn = turn?.expected ? store.get(turnId, turn.expected) : null;
    if (writes.length !== 2 || !run || run.kind !== 'research-run' || !object(run.value)
      || run.value.projectId !== intent.value.projectId || run.value.draftId !== intent.value.draft.id
      || !turn || turn.kind !== 'research-turn' || !object(turn.value)
      || turn.value.run !== intent.value.owner.id || turn.value.number !== intent.value.cursor.turn
      || (intent.value.kind === 'escalation-assessor'
        ? !isRef(intent.value.cursor.pendingTurn)
          || !previousTurn || canonical(intent.value.cursor.pendingTurn) !== canonical(reference(previousTurn))
          || turn.expected !== intent.value.cursor.pendingTurn.revision
          || turn.value.status !== 'completed' || run.value.turns !== intent.value.cursor.turn
        : turn.expected !== 0 || turn.value.contract !== 'research-consumer-turn/v1'
          || canonical(turn.value.consumerIntent) !== canonical(reference(origin))
          || turn.value.status !== 'pending' || run.value.turns !== intent.value.cursor.turn))
      consumerInvalid(intent.id, 'The runner may apply only its exact run and turn transition');
    try { validateRunnerApplicationWrites(store, intent, run, turn, origin, mode); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'research_consumer_intent_invalid') throw error;
      consumerInvalid(intent.id, 'The runner application cannot be derived from its exact paid response');
    }
    return;
  }
  if (intent.value.kind !== 'reader' || writes.length !== 1 || writes[0]?.kind !== 'reader-result'
    || writes[0].expected !== 0 || !object(writes[0].value))
    consumerInvalid(intent.id, 'Only the exact reader result can be applied by this family');
  const output = writes[0];
  const value = output.value as Record<string, any>;
  const paid = physical ?? readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  if (paid.kind !== 'response') consumerInvalid(intent.id, 'An applied reader result needs the paid response');
  const running = intent.value.state === 'running' ? intent
    : store.get<ResearchConsumerIntent>(intent.id, intent.revision - 1);
  if (!running || running.value.state !== 'running') consumerInvalid(intent.id, 'The applied reader lost its running source');
  const derived = derivePaidReaderResult(store, running, paid);
  if (output.id !== `reader-result:v2:${hashJson(value)}` || canonical(value) !== canonical(derived))
    consumerInvalid(intent.id, 'The reader result does not derive from its original selection');
}

function validateRunnerApplicationWrites(store: Store, intent: Revision<ResearchConsumerIntent>,
  runWrite: Write, turnWrite: Write, origin: Revision<ResearchConsumerIntent>,
  mode: 'application' | 'historical' = 'historical'): void {
  const priorRun = store.get<Record<string, any>>(runWrite.id, runWrite.expected);
  if (!priorRun || priorRun.kind !== 'research-run' || hashJson(priorRun.value) !== priorRun.hash
    || priorRun.id !== intent.value.owner.id || !object(priorRun.value)
    || priorRun.value.projectId !== intent.value.projectId || priorRun.value.draftId !== intent.value.draft.id
    || !object(runWrite.value) || !Number.isSafeInteger(runWrite.value.limit)
    || runWrite.value.limit < 1 || runWrite.value.limit > 100
    || !object(runWrite.value.owner) || !Number.isSafeInteger(runWrite.value.owner.pid)
    || runWrite.value.owner.pid <= 0 || typeof runWrite.value.owner.started !== 'string'
    || !runWrite.value.owner.started)
    consumerInvalid(intent.id, 'The runner application lost its exact predecessor or bounded invocation inputs');
  const paid = readResearchConsumerExecutionFromIntent(store, intent.value.projectId, intent);
  if (paid.kind !== 'response') consumerInvalid(intent.id, 'The runner application has no received response');
  let expectedRun: Record<string, any>, expectedTurn: Record<string, any>;
  if (intent.value.kind === 'escalation-assessor') {
    const pendingRef = intent.value.cursor.pendingTurn;
    const pending = isRef(pendingRef) ? store.get<Record<string, any>>(pendingRef.id, pendingRef.revision) : null;
    if (!pending || pending.kind !== 'research-turn' || canonical(reference(pending)) !== canonical(pendingRef)
      || turnWrite.expected !== pending.revision || pending.value.run !== priorRun.id
      || pending.value.number !== intent.value.cursor.turn || pending.value.status !== 'pending'
      || canonical(pending.value.question) !== canonical(intent.value.question))
      consumerInvalid(intent.id, 'Escalation lost its exact pending owner turn');
    let action: ResearchAction;
    try { action = turnAction(pending.value); }
    catch { consumerInvalid(intent.id, 'The pending owner action is invalid'); }
    const verdict = paid.payload;
    if (action.action !== 'need_owner' || !object(verdict) || typeof verdict.necessary !== 'boolean'
      || typeof verdict.reason !== 'string' || !verdict.reason.trim())
      consumerInvalid(intent.id, 'The escalation output does not derive from the paid verdict');
    const projected = projectPaidOwnerReview(priorRun.value as ResearchRun,
      pending.value as ManagedResearchTurn, verdict as { necessary: boolean; reason: string },
      runWrite.value.owner as ResearchRun['owner'], runWrite.value.limit);
    expectedRun = projected.run;
    expectedTurn = projected.turn;
  } else {
    let action: ResearchAction;
    try { action = intentResponseAction(store, intent, paid.payload); }
    catch { consumerInvalid(intent.id, 'The runner action does not parse from its paid response'); }
    if (!Number.isSafeInteger(priorRun.value.turns) || intent.value.cursor.turn !== priorRun.value.turns + 1
      || !Number.isSafeInteger(priorRun.value.requestChars) || priorRun.value.requestChars < 0)
      consumerInvalid(intent.id, 'The paid action does not follow the saved run counter');
    // A paid planner may name a prose or foreign question. Admission preserves
    // that exact action with a null selected question so the ordinary planner
    // records a rejected turn and can recover an audited archive plan later.
    // DR3a3-K: an attempt subject's action addresses its plan-question id; the
    // selected Question is still the subject's Question basis.
    const subject = cursorSubject(intent.value, intent.id);
    const selectedQuestion = 'question' in action
      && action.question !== addressedQuestionId(intent.value.question, subject)
      ? null : intent.value.question;
    const projected = projectPaidTurnAdmission(priorRun.value as ResearchRun, {
      runId: priorRun.id, intent: reference(origin), response: paid.payload,
      question: selectedQuestion, ...(subject ? { subject } : {}),
      owner: runWrite.value.owner as ResearchRun['owner'], limit: runWrite.value.limit,
      context: consumerIntentContext(store, intent.value, intent.id), ...(intent.value.cursor.mode ? { mode: intent.value.cursor.mode } : {}),
      ...(intentWebCapability(store, intent) ? { web: true } : {}), ...(earlyUnknownEra(intent.value.cursor) ? { unknown: true } : {}) });
    expectedRun = projected.run;
    // D8.4e: the era of a SAVED application is its own producer's form — a
    // turn written without the acceptance marker is the earlier era. A live
    // application is always the current producer's full projection.
    const { acceptanceContract: _marker, ...earlierEra } = projected.turn;
    expectedTurn = mode === 'historical' && !subject && object(turnWrite.value)
      && !Object.hasOwn(turnWrite.value, 'acceptanceContract') ? earlierEra : projected.turn;
  }
  if (canonical(runWrite.value) !== canonical(expectedRun)
    || canonical(turnWrite.value) !== canonical(expectedTurn))
    consumerInvalid(intent.id, 'The complete runner outputs do not derive from the prior run and paid response');
}

export function prepareResearchConsumerApplication(store: Store, intentRef: Ref, callRef: Ref,
  writes: Write[], guards: TransactionGuard[]): { writes: Write[]; guards: TransactionGuard[] } {
  if (!Array.isArray(writes) || !writes.length || !Array.isArray(guards) || !isRef(callRef))
    consumerInvalid('research-consumer-intent', 'Application needs exact consumer writes, a call and transaction guards');
  const paid = readResearchConsumerExecution(store, readResearchConsumerIntent(store, intentRef).value.projectId, intentRef);
  const intent = paid.intent;
  if (intent.value.state !== 'running' || paid.kind !== 'response' || canonical(reference(paid.call)) !== canonical(callRef))
    consumerInvalid(intent.id, 'Only one proved received response may be applied to this unfinished intent');
  validateConsumerApplicationWrites(store, intent, writes, paid, 'application');
  const currentOwner = store.get(intent.value.owner.id);
  if (!currentOwner || !guards.some(guard => canonical(guard) === canonical(reference(currentOwner)))
    || !writes.some(write => write.id === currentOwner.id && write.expected === currentOwner.revision)
      && intent.value.kind !== 'reader')
    consumerInvalid(intent.id, 'Application must guard the exact current consumer state');
  const currentReaderGuards = intent.value.kind === 'reader' ? readerApplicationAdmission(store, intent) : [];
  const refreshed = new Set(currentReaderGuards.map(guard => guard.id));
  // The dispatch-time basis stays immutable inside the intent, but the
  // application transaction takes today's admission heads for the same ids.
  for (const guard of guards) if (!('absent' in guard)) refreshed.add(guard.id);
  const original = intent.value.guards.filter(guard => guard.id !== intent.value.owner.id && !refreshed.has(guard.id));
  const required = uniqueTransactionGuards([...original, ...currentReaderGuards, ...guards, reference(intent), reference(paid.call),
    paid.request, paid.response, paid.archive]);
  const outputs = writes.map(pendingRef);
  const terminal: Write = { id: intent.id, kind: 'research-consumer-intent', expected: intent.revision,
    value: { ...intent.value, state: 'applied', outputs } satisfies ResearchConsumerIntent };
  return { writes: [...writes, terminal], guards: required };
}

/** Read only the exact physical outcome and its archived consumer state. Current
 * admission and operator authority are checked separately by the caller. */
function researchExecution(store: Store, project: string, callRef: Ref,
  session: Revision<RecoverableContextSession>, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  role: RoleBinding, profile: Ref | null, onlyResponse: boolean): ResearchExecution {
  requireCondition(store && typeof store.get === 'function' && typeof project === 'string' && project.length > 0
    && isRef(callRef) && isRef(session) && isRef(draft) && isRef(question) && object(role)
    && typeof role.actor === 'string' && typeof role.model === 'string' && typeof role.effort === 'string'
    && object(role.command) && typeof role.command.executable === 'string' && Array.isArray(role.command.args)
    && (profile === null || isRef(profile)), 'response_recovery_invalid', 'A saved response needs exact physical and consumer references');
  const exact = <T>(supplied: Revision<T>, kinds: string[], code: string): Revision<T> => {
    const saved = store.get<T>(supplied.id, supplied.revision);
    requireCondition(saved && kinds.includes(saved.kind) && saved.hash === supplied.hash && object(saved.value)
      && canonical(saved) === canonical(supplied), code, 'The supplied consumer revision must match its exact saved state');
    return saved;
  };
  session = exact(session, ['synthesis-session', 'assessment-session'], 'response_recovery_session_stale');
  const applicationEra = assessmentSessionEra(session);
  draft = exact(draft, ['discovery-draft'], 'response_recovery_binding_stale');
  question = exact(question, ['question'], 'response_recovery_binding_stale');
  const binding = responseSessionBinding(session);
  const inputs = uniqueRefs([binding.draft, binding.question, binding.environment, ...binding.inputs]);
  requireCondition(session.value.projectId === project && draft.value.projectId === project && question.value.projectId === project
    && canonical(reference(draft)) === canonical(binding.draft) && canonical(reference(question)) === canonical(binding.question)
    && question.value.draftId === draft.id && Array.isArray(draft.value.questions) && draft.value.questions.includes(question.id)
    && canonical(draft.value.inputs) === canonical(binding.inputs) && inputs.every(ref => {
      const saved = store.get(ref.id, ref.revision); return saved && saved.hash === ref.hash;
    }), 'response_recovery_binding_stale', 'The archived session must retain its exact research binding');
  const synthesis = session.kind === 'synthesis-session', purpose = synthesis ? 'analyst' : 'assessor';
  const call = store.get<ModelCall>(callRef.id, callRef.revision);
  requireCondition(call?.kind === 'model-call' && object(call.value) && canonical(reference(call)) === canonical(callRef)
    && (!onlyResponse || call.value.status === 'succeeded')
    && call.value.projectId === project && call.value.draftId === draft.id && call.value.questionId === question.id
    && call.value.purpose === purpose && object(call.value.requested) && canonical(call.value.requested) === canonical(role)
    && canonical(call.value.profile ?? null) === canonical(profile),
  'response_recovery_call_foreign', 'The succeeded call must belong to this exact consumer, profile and role');
  const controlTerminal = !onlyResponse && !synthesis ? assessmentControlTerminal(store, call) : null;
  requireCondition(object(call.value.request) && (controlTerminal ? call.value.response === null : object(call.value.response))
    && object(call.value.packet),
    'response_recovery_wire_missing', 'The complete paid request, response and context archive must exist');
  const requestRef = call.value.request.record,
    responseRef = controlTerminal ? null : call.value.response!.record,
    archiveRef = call.value.packet.archive;
  requireCondition(isRef(requestRef) && (controlTerminal || isRef(responseRef)) && isRef(archiveRef),
    'response_recovery_wire_missing', 'The complete paid request, response and context archive must exist');
  const read = (ref: Ref, kind: string) => {
    const record = store.get<Record<string, any>>(ref.id, ref.revision);
    requireCondition(record?.kind === kind && canonical(reference(record)) === canonical(ref) && object(record.value)
      && hashJson(record.value) === record.hash && record.value.projectId === project
      && record.value.draftId === draft.id && typeof record.value.text === 'string', 'response_recovery_wire_invalid', 'A saved wire identity is missing or foreign');
    return record.value;
  };
  let requestText: string;
  if (requestRef.id.startsWith("request-manifest:")) {
    const requestWire = readRequestWire(store, requestRef, {
      projectId: project,
      draftId: draft.id,
      requestId: call.value.requestId,
      errorCode: 'response_recovery_wire_invalid',
    });
    requestText = requestWire.text;
  } else {
    const requestValue = read(requestRef, 'model-request');
    requestText = requestValue.text as string;
  }
  const responseValue = controlTerminal ? null : read(responseRef!, 'model-response');
  const responseText = responseValue ? responseValue.text as string : null;
  requireCondition(digest(requestText) === call.value.request.hash && requestText.length === call.value.request.chars
    && Buffer.byteLength(requestText) === call.value.request.bytes
    && (controlTerminal || responseText !== null && responseText.length === call.value.response!.chars
      && Buffer.byteLength(responseText) === call.value.response!.bytes),
  'response_recovery_wire_invalid', 'Recovery cannot truncate or repair paid wire bytes');
  let request: Record<string, any>, response: unknown;
  try { request = JSON.parse(requestText); }
  catch { throw new EngineError('response_recovery_wire_invalid', 'Both saved envelopes must be complete JSON'); }
  try { response = responseText === null ? null : JSON.parse(responseText); }
  catch { if (onlyResponse) throw new EngineError('response_recovery_wire_invalid', 'Both saved envelopes must be complete JSON'); }
  requireCondition(object(request) && object(request.subject) && typeof request.prompt === 'string'
    && request.protocol === 'omg-agent/v1' && request.mode === 'research' && request.requestId === call.value.requestId
    && (!onlyResponse || object(response) && response.protocol === request.protocol && response.requestId === request.requestId && Object.hasOwn(response, 'research'))
    && request.model === role.model && request.effort === role.effort && (request.speed ?? 'inherited') === (role.speed ?? 'inherited')
    && canonical(request.subject?.working?.archive ?? null) === canonical(archiveRef),
  'response_recovery_wire_foreign', 'The raw envelopes must match the selected paid call');
  const savedArchive = store.get<Record<string, unknown>>(archiveRef.id, archiveRef.revision);
  requireCondition(savedArchive?.kind === 'research-context' && savedArchive.hash === archiveRef.hash && object(savedArchive.value)
    && isRef(savedArchive.value['draft']) && isRef(savedArchive.value['question']) && object(savedArchive.value['body']),
  'context_reference_foreign', 'The context archive must retain exact research references and a complete body');
  // archivedContext shares its existing archive formula. Only its unversioned
  // question lookup is pinned here; this is a separate semantic view, not a
  // transparent Store wrapper or permission to read the current question.
  const historical = { get: <T>(id: string, revision?: number): Revision<T> | null => {
    if (revision === undefined) {
      requireCondition(id === question.id, 'context_reference_foreign', 'Historical response reads must name exact research revisions');
      return question as Revision<T>;
    }
    return store.get<T>(id, revision);
  } } as Store;
  const archive = archivedContext(historical, draft, archiveRef), body = archive.body as Record<string, any>;
  requirePacketMaterialDelivery(request.subject, archiveRef,
    (record, pointer) => contextValue(archivedContext(historical, draft, record), pointer));
  requirePlanningNavigation(request.subject, archiveRef, body);
  const savedWorkspace = session.value.workspace;
  requireCondition(!savedWorkspace || object(savedWorkspace) && Array.isArray(savedWorkspace.entries)
    && savedWorkspace.entries.every(entry => object(entry) && object(entry.result)),
  'research_context_invalid', 'Saved context workspace is invalid');
  const workspace = contextWorkspace(session.value.workspace, session.value['focus']);
  requireCondition(synthesis ? Array.isArray(body.synthesisMaterials) : Array.isArray(body.observations) && Object.hasOwn(body, 'value'),
    'response_recovery_context_stale', 'Recovery needs the actual archived materials or candidate and observations');
  const state = synthesis ? { offset: session.value['offset'], materialOffset: session.value['materialOffset'] ?? 0 }
    : { offset: session.value['offset'], candidateOffset: session.value['candidateOffset'] ?? 0, total: JSON.stringify(body.observations).length };
  requireCondition(canonical(archive.draft) === canonical(binding.draft) && canonical(archive.question) === canonical(binding.question)
    && body[synthesis ? 'synthesisSession' : 'assessmentSession'] === session.id
    && object(body[synthesis ? 'synthesisState' : 'assessmentState']) && Array.isArray(body[synthesis ? 'synthesisNotes' : 'assessmentNotes'])
    && canonical(body[synthesis ? 'synthesisState' : 'assessmentState']) === canonical(state)
    && canonical(body[synthesis ? 'synthesisNotes' : 'assessmentNotes']) === canonical(session.value['notes'])
    && canonical(body.contextWorkspace ?? []) === canonical(workspace.entries.map(entry => entry.result))
    && !workspace.blocked,
  'response_recovery_cursor_stale', 'The archived cursor, notes, materials context or workspace was already changed');
  const consumerEra = call.id.startsWith('model-call:consumer:v1:');
  if (!consumerEra && Object.hasOwn(call.value, 'consumerIntent'))
    consumerInvalid(call.id, 'A legacy physical address cannot masquerade as the new consumer producer');
  let consumerIntent: Revision<ResearchConsumerIntent> | null = null;
  if (consumerEra) {
    const consumer = (call.value as ModelCall & { consumerIntent?: Ref }).consumerIntent;
    if (!isRef(consumer)) consumerInvalid(call.id, 'The new physical producer lost its exact consumer intent');
    const intent = readResearchConsumerIntent(store, consumer);
    if (!['synthesis', 'consolidation'].includes(intent.value.kind)
      || intent.value.projectId !== project || canonical(intent.value.owner) !== canonical(reference(session))
      || canonical(intent.value.draft) !== canonical(reference(draft))
      || canonical(intent.value.question) !== canonical(reference(question)))
      consumerInvalid(call.id, 'The new physical producer belongs to another synthesis cursor');
    consumerIntent = intent;
  }
  if (synthesis && body.dispatchMode === 'consolidation') {
    const bounded = request.subject?.consolidation?.deliveryContract === CONSOLIDATION_DELIVERY;
    const fragment = request.subject?.consolidation?.deliveryContract === CONSOLIDATION_FRAGMENT;
    if (bounded) consolidationPage(body.synthesisNotes, body.consolidation, request.subject?.consolidation);
    if (fragment) consolidationFragment(body.synthesisNotes, body.consolidation, request.subject);
    requireCondition(object(body.consolidation) && Number.isSafeInteger(body.consolidation.targetChars) && body.consolidation.targetChars > 0
      && request.subject.dispatchMode === 'consolidation'
      && canonical(request.subject.synthesisState) === canonical(state)
      && request.subject.synthesisSession === session.id
      && canonical(request.subject.question) === canonical({ id: question.id, ...question.value.spec })
      && (bounded || fragment || canonical(request.subject.consolidation) === canonical({...consolidationInput(body.synthesisNotes, body.consolidation.targetChars, body.consolidation.format === 2 ? 2 : 1),
        ...(body.consolidation.tightening?{tightening:body.consolidation.tightening}:{})}))
      && !request.subject.synthesisPage && !request.subject.materialPage && !request.subject.selectedContext && !request.subject.readings,
    'response_recovery_page_foreign', 'The consolidation must contain exactly the saved notes and contract, without claiming material progress');
  } else if (synthesis) {
    const page = request.subject.synthesisPage, materials = body.synthesisMaterials, fragment = request.subject.materialPage;
    requireCondition(Array.isArray(materials) && materials.every(object) && object(page) && page.offset === state.offset && Number.isSafeInteger(page.end)
      && page.end >= page.offset && page.end <= materials.length && page.total === materials.length
      && page.complete === (page.end === materials.length), 'response_recovery_page_foreign', 'The saved material page has a foreign cursor');
    if (fragment) {
      const savedMaterial: unknown = materials[page.offset];
      const encoded = consumerIntent ? consumerIntent.value.cursor.materialEncoding as string | null
        : JSON.stringify(materials[page.offset]?.value);
      let linkedMaterial: unknown;
      if (consumerIntent && typeof encoded === 'string') {
        try { linkedMaterial = JSON.parse(encoded); } catch { /* Rejected by the exact material proof below. */ }
      }
      requireCondition(typeof encoded === 'string' && object(fragment) && fragment.encoding === 'json-string-fragment'
        && (!consumerIntent || linkedMaterial !== undefined
          && object(savedMaterial) && Object.hasOwn(savedMaterial, 'value')
          && canonical(linkedMaterial) === canonical(savedMaterial.value))
        && fragment.index === page.offset && fragment.offset === (session.value['materialOffset'] ?? 0)
        && Number.isSafeInteger(fragment.end) && fragment.end > fragment.offset && fragment.end <= encoded.length
        && fragment.total === encoded.length && fragment.text === encoded.slice(fragment.offset, fragment.end)
        && canonical(fragment.original) === canonical({ record: archiveRef, pointer: `/body/synthesisMaterials/${page.offset}/value` })
        && (page.nextMaterialOffset ?? 0) === (fragment.end === encoded.length ? 0 : fragment.end)
        && page.end === (fragment.end === encoded.length ? page.offset + 1 : page.offset),
      'response_recovery_page_foreign', 'The recovered cursor must follow the exact original fragment');
    } else {
      const supplied = materials.slice(page.offset, page.end);
      requireCondition((session.value['materialOffset'] ?? 0) === 0 && (page.nextMaterialOffset ?? 0) === 0
        && canonical(request.subject.selectedContext ?? []) === canonical(supplied.filter((item: any) => item.kind !== 'reader').map((item: any) => item.value))
        && canonical(request.subject.readings ?? []) === canonical(supplied.filter((item: any) => item.kind === 'reader').map((item: any) => item.value)),
      'response_recovery_page_foreign', 'The complete material page must match its archived values');
    }
  } else {
    const evidence = request.subject.evidencePage, candidate = request.subject.candidatePage;
    const evidenceText = JSON.stringify(body.observations), candidateText = JSON.stringify(body.value);
    requireCondition(object(evidence) && object(candidate) && evidence.offset === session.value['offset'] && evidence.total === evidenceText.length
      && evidence.end >= evidence.offset && evidence.end <= evidence.total && evidence.complete === (evidence.end === evidence.total)
      && candidate.total === candidateText.length && (candidate.offset === (session.value['candidateOffset'] ?? 0) || candidate.offset === 0 && candidate.complete)
      && candidate.end >= candidate.offset && candidate.end <= candidate.total && candidate.complete === (candidate.end === candidate.total),
    'response_recovery_page_foreign', 'The assessment must retain both original cursors');
    requireCondition((evidence.text === undefined ? canonical(request.subject.observations) === canonical(body.observations)
      : evidence.text === evidenceText.slice(evidence.offset, evidence.end))
      && (candidate.encoding === 'json-string-fragment' ? candidate.text === candidateText.slice(candidate.offset, candidate.end)
        : canonical(request.subject.value) === canonical(body.value)),
    'response_recovery_page_foreign', 'Ambiguous serialized page order cannot be silently reconstructed');
  }
  const result: ResearchExecutionContext = { call, request: requestRef, archive: archiveRef, body,
    subject: request.subject as Record<string, any>, prompt: request.prompt as string,
    // Claim and authorization are immutable ancestors of the guarded terminal
    // call, not simultaneous current heads to put into writeMany's guards.
    guards: uniqueRefs([reference(session), callRef, requestRef, archiveRef, ...inputs, ...(profile ? [profile] : [])]) };
  if (controlTerminal) return { kind: 'terminal', code: controlTerminal, response: null, ...result };
  const linked = object(response) && response.protocol === request.protocol && response.requestId === request.requestId
    && Object.hasOwn(response, 'research');
  // RS3 (№4433): the one receipt this call's era proves carries every mark read from the process — the physical proof
  // below, its exit and signal, and the no-response mark of a failed call's own envelope. A sibling receipt is not read.
  const receiptName = applicationEra ? 'assessmentExecution' as const : consumerEra ? 'consumerExecution' as const : null;
  const executionReceipt = receiptName ? responseValue![receiptName] : null;
  const absent = call.value.status === 'failed' ? noModelResponse(responseText!, request.protocol, request.requestId,
    object(executionReceipt) && object(executionReceipt.process) ? executionReceipt.process.stderr : undefined) : null;
  requireCondition(!object(response) || !['protocol', 'requestId', 'research'].some(key => Object.hasOwn(response, key)) || linked
    || absent === 'envelope',
    'response_recovery_wire_foreign', 'A foreign or incomplete research envelope is not evidence of an absent response');
  const physicalProof = receiptName === 'assessmentExecution' ? assessmentExecution(store, call, responseValue!)
    : receiptName === 'consumerExecution' ? physicalExecution(store, call, responseValue!, receiptName, 'consumerIntent', 'research-consumer-execution/v1') : [];
  result.guards = uniqueRefs([...result.guards, responseRef!]);
  if (linked) {
    // Presence, not payload validity, distinguishes a received answer. Even a
    // null or malformed research value belongs to the application transition.
    requireCondition(call.value.status === 'succeeded' && call.value.error === null,
      'response_recovery_execution_invalid', 'A linked research response contradicts the saved failed or running outcome');
    return { kind: 'response', response: responseRef!, ...result, payload: (response as Record<string, unknown>)['research'] };
  }
  if (call.value.status === 'succeeded') throw new EngineError(object(response) ? 'response_recovery_wire_foreign' : 'response_recovery_wire_invalid',
    'The succeeded physical call must retain its own research response');
  requireCondition(call.value.status === 'failed' && call.value.error === 'research_provider_failed' && physicalProof.length > 0
    && object(executionReceipt) && object(executionReceipt.process)
    && Number.isSafeInteger(executionReceipt.process.exitCode) && executionReceipt.process.exitCode > 0
    && executionReceipt.process.signal === null
    && (!consumerEra || absent === 'envelope' || responseText === '' && call.value.response?.chars === 0 && call.value.response.bytes === 0),
  'response_recovery_execution_invalid', 'Only a proven completed provider failure without a linked research response permits retry');
  return { kind: 'provider-failed', response: responseRef!, ...result };
}

export function readResearchExecution(store: Store, project: string, callRef: Ref,
  session: Revision<RecoverableContextSession>, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  role: RoleBinding, profile: Ref | null): ResearchExecution {
  return researchExecution(store, project, callRef, session, draft, question, role, profile, false);
}

/** The operator's original succeeded-response contract and DTO stay exact. */
export function readResearchResponse(store: Store, project: string, callRef: Ref,
  session: Revision<RecoverableContextSession>, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  role: RoleBinding, profile: Ref | null) {
  const result = researchExecution(store, project, callRef, session, draft, question, role, profile, true);
  requireCondition(result.kind === 'response', 'response_recovery_call_foreign', 'The selected call has no succeeded research response');
  return { call: result.call, request: result.request, response: result.response, archive: result.archive, body: result.body,
    subject: result.subject, payload: result.payload, prompt: result.prompt, guards: result.guards };
}

/** Reprocess one saved succeeded response through the ordinary synthesis or
 * assessment consumer, stopping before any additional paid request. */
export async function recoverResearchResponse(store: Store, environments: Environments, project: string,
  callRef: Ref, sessionRef: Ref, declaredBy: string): Promise<Revision<ResponseRecovery>> {
  requireCondition(!current.getStore() && isRef(callRef) && isRef(sessionRef) && typeof declaredBy === 'string' && declaredBy.trim(),
    'response_recovery_invalid', 'Recovery needs exact references and its actual declaring operator');
  const id = `research-response-recovery:${hashJson([project, callRef, sessionRef])}`;
  const previous = store.get<ResponseRecovery>(id);
  if (previous) {
    requireCondition(previous.kind === 'research-response-recovery' && previous.revision === 1 && previous.value.projectId === project
      && previous.value.state === 'applied' && canonical(previous.value.call) === canonical(callRef)
      && canonical(previous.value.sessionBefore) === canonical(sessionRef), 'response_recovery_invalid', 'The recovery identity was replaced');
    return previous;
  }
  const session = store.get<RecoverableContextSession>(sessionRef.id), call = store.get<ModelCall>(callRef.id);
  const isV2Synthesis = !!session && session.kind === 'synthesis-session' && session.id.startsWith('synthesis-session:v2:');
  // DR3a3-S1: a v3 session takes the same exact-restoration path as v2, with its subject.
  const isV3Synthesis = !!session && session.kind === 'synthesis-session' && session.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX);
  requireCondition(session && ['synthesis-session', 'assessment-session'].includes(session.kind) && object(session.value)
    && session.value.projectId === project
    && (isV2Synthesis || isV3Synthesis || canonical(reference(session)) === canonical(sessionRef)),
  'response_recovery_session_stale', 'Recovery requires the current exact supported session');
  // №2000-11: a paid managed assessment session has no operator replay; its
  // recovery is the automatic managed path through the exact saved origin.
  requireCondition(!(session.kind === 'assessment-session' && session.id.startsWith('assessment-session:v2:')),
    'response_recovery_invalid', 'A paid managed assessment session recovers only through its exact origin, never operator replay');
  if (isV2Synthesis || isV3Synthesis) {
    // №1555 X27: v2 recovery is the exact restoration of the selected paid
    // step; sessionRef must name the proven pre-application state of that
    // step, never an arbitrary current head. An already lawful A is confirmed
    // once by a receipt-link to the proven sessionBefore/sessionAfter — never
    // a second application; a later session revision never stalemates it.
    const parsed = isV3Synthesis ? parseSynthesisSessionV3(session!.value) : parseSynthesisSessionV2(session!.value);
    requireCondition(parsed, 'response_recovery_binding_missing', 'The v2 session must retain its producer contract');
    const bound = listResearchConsumerIntents(store, project, parsed.binding.draft.id)
      .filter(intent => ['synthesis', 'consolidation'].includes(intent.value.kind)
        && intent.value.owner.id === session!.id && intent.value.call?.id === callRef.id);
    requireCondition(bound.length === 1, 'response_recovery_call_foreign',
      'The selected call is not bound to exactly one step of this session');
    const intent = bound[0]!;
    requireCondition(canonical(sessionRef) === canonical(intent.value.owner),
      'response_recovery_session_stale', 'The v2 recovery names the exact pre-application session of the selected step');
    if (intent.value.state === 'applied') {
      const sessionAfter = intent.value.outputs?.find(output => output.id === session!.id);
      requireCondition(sessionAfter, 'response_recovery_invalid', 'The applied step lost its exact session output');
      const paid = readResearchConsumerExecution(store, project, reference(intent));
      requireCondition(paid.kind === 'response' && paid.response,
        'response_recovery_call_foreign', 'The applied step lost its proven paid response');
      return store.writeMany<ResponseRecovery>([{ id, kind: 'research-response-recovery', expected: 0,
        value: { projectId: project, declaredBy, call: callRef, request: paid.request, response: paid.response,
          archive: paid.archive, sessionBefore: intent.value.owner, sessionAfter, state: 'applied' } satisfies ResponseRecovery }],
        uniqueTransactionGuards([reference(intent), reference(session!), callRef, paid.request, paid.response, paid.archive]))[0]!;
    }
  }
  const binding = responseSessionBinding(session);
  const draft = store.get<DiscoveryDraft>(binding.draft.id), question = store.get<Question>(binding.question.id);
  const inputs = uniqueRefs([binding.draft, binding.question, binding.environment, ...binding.inputs]);
  requireCondition(draft?.kind === 'discovery-draft' && question?.kind === 'question' && object(draft.value) && object(question.value) && draft.value.projectId === project
    && question.value.draftId === draft.id && ['open', 'unresolved'].includes(question.value.status)
    && canonical(draft.value.inputs) === canonical(binding.inputs) && session.value.result === null
    && inputs.every(ref => { const head = store.get(ref.id); return head && canonical(reference(head)) === canonical(ref); }),
  'response_recovery_binding_stale', 'The question, session result or research inputs changed');
  const effective = environments.effective(project), pilot = readerPilot(store, project);
  const dispatch = { ...(pilot ? pilotEnvironment(effective.environment.value, pilot.value) : effective.environment.value), workspace: effective.root };
  const synthesis = session.kind === 'synthesis-session', purpose = synthesis ? 'analyst' : 'assessor';
  requireCondition(!synthesis || pilot, 'response_recovery_profile_stale', 'Synthesis recovery requires its protected profile');
  const role = synthesis ? dispatch.implementer : dispatch.reviewer;
  requireCondition(call?.kind === 'model-call' && canonical(reference(call)) === canonical(callRef),
  'response_recovery_call_foreign', 'The succeeded call must belong to this exact consumer, profile and role');
  const paid = readResearchResponse(store, project, callRef, session, draft, question, role, pilot ? reference(pilot) : null);
  const { body, request: requestRef, response: responseRef, archive: archiveRef } = paid;
  requireCondition(!body.repositoryRoot || body.repositoryRoot === effective.root,
    'response_recovery_cursor_stale', 'The archived cursor, notes, materials context or workspace was already changed');
  if (isRef(body.graphBase)) {
    const graph = store.get(body.graphBase.id);
    requireCondition(graph && canonical(reference(graph)) === canonical(body.graphBase),
      'response_recovery_context_stale', 'The operation map changed after the paid request');
  }
  if (!synthesis) requireCondition(Array.isArray(body.observations) && body.observations.every((observation: any) =>
    observation.projectId === project && new Evidence(store).verify(observation)), 'response_recovery_evidence_stale', 'Assessment recovery requires its actual current evidence');
  // DR3a3-S1 (решение 5): the audited counter of the step's own scope — the
  // subject counter C writes for a v3 session, the Question counter otherwise.
  const counter = store.get(questionDispatchId(project, question.id,
    isV3Synthesis ? synthesisSessionSubject(session) : null));
  requireCondition(counter, 'response_recovery_binding_missing', 'Recovery requires the audited dispatch guard');
  const projectCounter = store.get(`project-dispatch:${hashJson(project)}`);
  const run = store.get<{ projectId: string; draftId: string; status: string; owner?: { pid: number; started: string } }>(`research-run:${hashJson([project, draft.id])}`);
  requireCondition(!run || run.kind === 'research-run' && run.value.projectId === project && run.value.draftId === draft.id,
    'response_recovery_binding_missing', 'The research owner record is foreign');
  if (run?.value.status === 'running') {
    const owner = run.value.owner;
    requireCondition(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.started === 'string' && owner.started.trim()
      && processStart(owner.pid) !== owner.started, 'response_recovery_consumer_running', 'The normal research consumer still owns this state');
  }
  requireCondition(!store.list<ModelCall>('model-call').some(record => record.value.projectId === project && record.value.status === 'running'),
    'response_recovery_call_running', 'Wait for active research calls before recovering a response');
  const scope: RecoveryScope = { store, id, project, draft: draft.id, question: question.id, purpose, role,
    profile: pilot ? reference(pilot) : null, session: sessionRef, archive: archiveRef, subject: paid.subject, payload: paid.payload,
    origin: { projectId: project, declaredBy, call: callRef, request: requestRef, response: responseRef, archive: archiveRef, sessionBefore: sessionRef },
    guards: uniqueRefs([sessionRef, callRef, requestRef, responseRef, archiveRef, reference(counter),
      ...(projectCounter ? [reference(projectCounter)] : []), ...(run ? [reference(run)] : []),
      ...inputs, ...effective.guards, ...(pilot ? [reference(pilot)] : [])]),
    delivered: false, applied: false };
  return current.run(scope, async () => {
    let failure: unknown = null;
    try {
      if (synthesis) await (await import('./synthesis-session.js')).synthesisSession(store, draft, question, effective.environment, dispatch, pilot!, body, paid.prompt);
      else await (await import('./assessment-session.js')).assessmentSession(store, draft, question, effective.environment, dispatch, pilot ?? undefined, body, paid.prompt);
    } catch (error) { failure = error; }
    const applied = store.get<ResponseRecovery>(id);
    if (applied) return applied;
    if (failure) throw failure;
    throw new EngineError('response_recovery_not_applied', 'The saved response did not produce a valid consumer state change');
  });
}

/* ==== D8.4c: exact historical readers for managed turns ==== */

export function historicalObservation(store: Store, projectId: string,
  citation: { source: Ref; selector: Selector }): Observation {
  const ref = citation.source, selector = citation.selector;
  const source = isRef(ref) ? store.get<Source>(ref.id, ref.revision) : null;
  if (!source || source.kind !== 'source' || canonical(reference(source)) !== canonical(ref)
    || source.value.projectId !== projectId || typeof source.value.content !== 'string'
    || typeof source.value.sha256 !== 'string' || digest(source.value.content) !== source.value.sha256
    || !object(selector)) consumerInvalid(ref?.id ?? 'source', 'A checkpoint citation lost its exact source bytes');
  let value: unknown;
  if (selector.kind === 'json-pointer') {
    if (source.value.mediaType !== 'application/json' || typeof selector.pointer !== 'string')
      consumerInvalid(source.id, 'A checkpoint citation has an invalid JSON selector');
    try { value = contextValue(JSON.parse(source.value.content), selector.pointer); }
    catch { consumerInvalid(source.id, 'A checkpoint citation cannot select its saved JSON value'); }
  } else if (selector.kind === 'text-range') {
    if (!Number.isSafeInteger(selector.start) || !Number.isSafeInteger(selector.end)
      || selector.start! < 0 || selector.end! <= selector.start! || selector.end! > source.value.content.length)
      consumerInvalid(source.id, 'A checkpoint citation has an invalid saved text range');
    value = source.value.content.slice(selector.start, selector.end);
  } else consumerInvalid(source.id, 'A checkpoint citation has an unknown selector');
  return { projectId, source: ref, selector, value: JSON.parse(canonical(value)) };
}

function historicalCheckpoint(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  action: Extract<ResearchAction, { action: 'checkpoint' }>) {
  const projected = { projectId: draft.value.projectId, draft: reference(draft), question: reference(question),
    status: 'unassessed' as const, proposal: action.value,
    observations: action.citations.map(citation => historicalObservation(store, draft.value.projectId, citation)),
    unresolved: action.unresolved };
  const value = JSON.parse(canonical(projected)) as typeof projected;
  const hash = hashJson(value);
  return { value, ref: { id: `research-checkpoint:${hash}`, revision: 1, hash } satisfies Ref };
}

/** Reconstruct an addressed read from its immutable record. Live application
 * already checks current evidence in readResearchContext; this proof must keep
 * working after that evidence later changes. */
export function readResearchContextRecordAt(store: Store, draft: Revision<DiscoveryDraft>,
  action: Extract<ResearchAction, { action: 'read_context' }>) {
  const ref = action.record, record = store.get<Record<string, any>>(ref.id, ref.revision);
  if (!record || canonical(reference(record)) !== canonical(ref) || hashJson(record.value) !== record.hash
    || !object(record.value)) consumerInvalid(ref.id, 'The addressed context record is missing or changed');
  if (record.kind === 'reader-result') {
    try { readReaderResultAt(store, draft.value.projectId, ref); }
    catch { consumerInvalid(ref.id, 'The addressed reader result does not derive from its exact producer'); }
    if (!/^\/observations\/(0|[1-9]\d*)(?:\/.*)?$/.test(action.pointer))
      consumerInvalid(ref.id, 'Prior reading access is limited to proved observations');
  } else if (record.kind === 'research-checkpoint') {
    const checkpointDraft = isRef(record.value.draft)
      ? store.get<DiscoveryDraft>(record.value.draft.id, record.value.draft.revision) : null;
    const checkpointQuestion = isRef(record.value.question)
      ? store.get<Question>(record.value.question.id, record.value.question.revision) : null;
    if (record.value.projectId !== draft.value.projectId
      || !checkpointDraft || !checkpointQuestion
      || canonical(reference(checkpointDraft)) !== canonical(record.value.draft)
      || canonical(reference(checkpointQuestion)) !== canonical(record.value.question)
      || checkpointDraft.value.projectId !== draft.value.projectId
      || checkpointDraft.id !== draft.id
      || checkpointQuestion.value.projectId !== draft.value.projectId
      || checkpointQuestion.value.draftId !== draft.id
      || !checkpointDraft.value.questions.includes(checkpointQuestion.id)
      || !draft.value.questions.includes(record.value.question.id)
      || !Array.isArray(record.value.observations)
      || record.value.observations.some((observation: any) =>
        !object(observation) || !isRef(observation.source)
        || canonical(observation) !== canonical(historicalObservation(store, draft.value.projectId,
          observation as { source: Ref; selector: Selector }))))
      consumerInvalid(ref.id, 'The addressed checkpoint belongs to another draft');
  } else if (record.kind === 'research-context') {
    const original = isRef(record.value.draft)
      ? store.get<DiscoveryDraft>(record.value.draft.id, record.value.draft.revision) : null;
    const sourceQuestion = isRef(record.value.question)
      ? store.get<Question>(record.value.question.id, record.value.question.revision) : null;
    if (record.value.projectId !== draft.value.projectId || !original || !sourceQuestion
      || canonical(reference(original)) !== canonical(record.value.draft)
      || canonical(reference(sourceQuestion)) !== canonical(record.value.question)
      || original.value.projectId !== draft.value.projectId
      || sourceQuestion.value.projectId !== draft.value.projectId
      || sourceQuestion.value.draftId !== draft.id
      || !draft.value.questions.includes(sourceQuestion.id)
      || canonical(original.value.inputs) !== canonical(draft.value.inputs))
      consumerInvalid(ref.id, 'The addressed archive belongs to another draft');
  } else if (!['stage', 'graph-layer', 'discovery-draft', 'research-scope'].includes(record.kind)
    || ![reference(draft), ...draft.value.inputs].some(allowed => canonical(allowed) === canonical(ref)))
    consumerInvalid(ref.id, 'The addressed context was outside the saved draft inputs');
  return record;
}

/** DRS1a2: the addressable value of an exact context record — a
 * research-context archive with its body by its own contract (a compact archive
 * keeps it in parts); any other record as saved. The saved Revision itself is
 * never rewritten with the restored body. */
export function contextRecordValue(store: Store, record: Revision<unknown>): unknown {
  return record.kind === 'research-context'
    ? { ...(record.value as Record<string, unknown>), body: readArchiveBody(store, record).body } : record.value;
}
export function readResearchContextOutcomeAt(store: Store, draft: Revision<DiscoveryDraft>, _question: Revision<Question>,
  action: Extract<ResearchAction, { action: 'read_context' }>, maxChars: number,
  mode: 'legacy' | 'bounded' = 'bounded') {
  const record = readResearchContextRecordAt(store, draft, action);
  return projectResearchContextRead(contextRecordValue(store, record), action.record, action.pointer, action.page, maxChars, mode);
}

function checkedContextIdentity(store: Store, projectId: string, draft: Revision<DiscoveryDraft>,
  question: Ref, action: Extract<ResearchAction, { action: 'read_context' }>,
  observation: unknown): ContextReadIdentityInput {
  const record = readResearchContextRecordAt(store, draft, action);
  const value = object(observation) && object(observation.value) && isRef(observation.value.ref)
    ? observation.value : observation;
  const nested = object(value) && isRef(value.ref) && value.ref.id.startsWith('reader-result:')
    ? readReaderResultAt(store, projectId, value.ref) : null;
  // DRS1a2: an archive's addressed original is its body by the archive's own
  // contract (a compact archive keeps it in parts, never as value.body).
  const recordValue = contextRecordValue(store, record);
  return { projectId, action, observation: observation as ContextReadIdentityInput['observation'],
    recordKind: record.kind, recordValue, question,
    ...(nested ? { readerResult: { ref: reference(nested), value: nested.value } } : {}) };
}

/** Exact prior turn sequence for the shared repeat projection. A later HEAD
 * may be read, but its own historical contract is checked before it becomes a
 * source; neither today's files nor a saved no-progress observation prove a
 * past context page. */
export function readContextTurnHistoryAt(store: Store, projectId: string,
  draft: Revision<DiscoveryDraft>, question: Ref, turns: Revision<ResearchTurn>[],
  beforeNumber: number): ContextTurnHistoryProof[] {
  const previous = turns.filter(turn => turn.value.number < beforeNumber)
    .sort((a, b) => a.value.number - b.value.number);
  if (previous.length !== beforeNumber - 1 || previous.some((turn, index) => turn.value.number !== index + 1))
    consumerInvalid(draft.id, 'The addressed read lost its complete earlier run history');
  return previous.map(turn => {
    const checked = readResearchConsumerTurn(store, reference(turn)) as Revision<ResearchTurn>;
    let context: ContextTurnHistoryProof['context'];
    let packet: ContextTurnHistoryProof['packet'];
    if (checked.value.status === 'completed' && checked.value.error === null
      && isRef(checked.value.question) && canonical(checked.value.question) === canonical(question)) {
      const origin = (checked.value as { consumerIntent?: unknown }).consumerIntent;
      if (isRef(origin)) {
        const paid = readResearchConsumerExecution(store, projectId, origin);
        if (paid.kind === 'response' && Array.isArray(paid.subject.contextWorkspace)
          && (paid.subject.contextDelivery || paid.subject.contextIndex))
          packet = paid.subject;
      }
      const action = turnAction(checked.value);
      if (action.action === 'read_context') {
        const { action: _action, observation: _observation, question: _question, ...source } =
          checkedContextIdentity(store, projectId, draft, question, action, checked.value.observation);
        context = source;
      }
    }
    return { turn: checked, ...(context ? { context } : {}), ...(packet ? { packet } : {}) };
  });
}

export function readContextIdentityAt(store: Store, projectId: string,
  draft: Revision<DiscoveryDraft>, question: Ref,
  action: Extract<ResearchAction, { action: 'read_context' }>, observation: unknown) {
  return checkedContextIdentity(store, projectId, draft, question, action, observation);
}
