import { planSubjectOf, sameSubject, type V7PlanSubject } from './v7-managed-attempt.js';
import { assessmentRolePrompt } from './assessment-session.js';
import { FINAL_SYNTHESIS_INSTRUCTION } from './synthesis-controls.js';
import { CONSOLIDATION_INSTRUCTION, COMPACT_CHECKPOINT_INSTRUCTION, TIGHTENING_INSTRUCTION } from './conclusion-consolidation.js';
import { physicalClaim, authorizeModelDispatch, prepareLateModelReceipt, readModelCallRecovery, executionOf } from './model-call-recovery.js';
import { invocationProgress, consumeInvocationAllowance, requireInvocationAllowance } from "./invocation-progress.js";
import { requireContextDelivery } from "./context-workspace.js";
import { interceptResearchPreview, isResearchPreview } from './research-preview.js';
import type { RuntimeObservation } from '../runtime/runtime-observation-model.js';
import { continuationState, continuationDispatch, continuationMetadata, continuationPrompt, packetPlanSubject } from "./continuation-packet.js";
import { estimateCliCall } from "../adapters/codex-estimate.js";
import { assertPilotBoundary, readerPilot } from "./reader-pilot.js";
import { phasePolicy } from "./phase-policy.js";
import { budgetSegment, budgetUsage, budgetGroups, assertQuestionBudget, reserveResearchCall, type BudgetSegment, type CallEstimate } from "../runtime/research-budget.js";
import { planningForQuestion } from "./research-routing.js";
import { researchScope } from "../graph/research-scope.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { randomUUID } from "node:crypto";
import { runProcess } from "../runtime/process.js";
import { isProcessStopRefusal, writeProcessStopWitness } from "../runtime/process-identity.js";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import { resolveRoleMode, uniqueTransactionGuards } from '../runtime/environment.js';
import { EngineError, requireCondition } from "../errors.js";
import type { Store, Revision, Write, TransactionGuard } from "../storage/store.js";
import type { ModelCall } from "../runtime/model-usage.js";
import { canonical, digest, hashJson } from "../canonical.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { pilotDispatch } from "./pilot-budget.js";
import type { ReaderPilot } from "./reader-pilot.js";
import { workingContext } from "./working-context.js";
import { replayLimitedResponse } from "./response-replay.js";
import { captureCallRuntime, finishCallRuntime } from '../runtime/call-runtime.js';
import { recoveryDispatchBoundary, operatorReplayedResponse, assessmentSessionEra, isResponseRecovery,
  readResearchConsumerIntent, resumeResearchConsumerExecution,
  refuseResearchConsumerIntent, prepareResearchConsumerReservation,
  type ResearchConsumerIntent } from './response-recovery.js';
import type { RecoverableContextSession } from './context-recovery.js';
import { projectResearchPhysicalReply } from './research-consumer-transition.js';
import { earlyResearchStage, researchCapacityProjection, researchResponseOutputLimit, DEFAULT_RESEARCH_REQUEST_CHARS, RESULT_CAPACITY } from './early-research-outcome.js';
import { RunControlGate, RunControlLost, RUN_CONTROL_MOVED, callStopCancelWrite } from '../om/run-control.js';
import { REQUEST_MANIFEST_CONTRACT, prepareRequestPartsAndManifest, partitionResearchWire } from './request-parts.js';

import { isDiscoveryV7Draft } from './v7-contracts.js';
import { stageBudgetPlan, DISCOVERY_V7_STAGE_BUDGET_KEY } from './stage-token-budget.js';

export { researchAction } from './research-consumer-transition.js';

export interface ResearchCallAudit {
  store: Store; draftId: string; purpose: string; questionId?: string; pilot?: Revision<ReaderPilot>;
  session?: Ref; onContext?: (context: Record<string, any>) => void;
  application?: Ref; prepareCall?: (call: Write) => { writes: Write[]; guards: TransactionGuard[] };
  consumerIntent?: Ref;
  /** Virtual producer only inside the no-dispatch preview scope. */
  previewIntent?: Revision<ResearchConsumerIntent>;
  requestContract?: string;
}
type AssessmentReservation = { kind: 'replay-only' } | {
  kind: 'application'; session: Revision<RecoverableContextSession>; application: Revision<Record<string, any>>;
};
const recordValue = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function applicationAuditInvalid(message: string): never {
  throw new EngineError('research_context_application_invalid', message);
}

/** This is the atomic transport seam, not another assessment state machine.
 * The saved session selects the era before optional callback fields can do so. */
function assessmentReservation(audit: ResearchCallAudit | undefined, role: RoleBinding, environment: Environment, context: unknown): AssessmentReservation | null {
  const namedSession = recordValue(context) ? context.assessmentSession : undefined;
  const namesNewSession = typeof namedSession === 'string'
    && (namedSession.startsWith('assessment-session:v1:') || namedSession.startsWith('assessment-session:v2:'));
  if (!audit) {
    if (namesNewSession) applicationAuditInvalid('A new assessment context needs its exact audited session');
    return null;
  }
  const explicit = Object.hasOwn(audit, 'application') || Object.hasOwn(audit, 'prepareCall');
  if (audit.session === undefined && !explicit && !namesNewSession) return null;
  try {
    if (!isRef(audit.session)) applicationAuditInvalid('An assessment reservation needs its exact saved session');
    const session = audit.store.get<RecoverableContextSession>(audit.session.id, audit.session.revision);
    if (!session || !recordValue(session.value) || canonical(reference(session)) !== canonical(audit.session)
      || hashJson(session.value) !== session.hash) applicationAuditInvalid('The reservation session is missing, foreign or changed');
    const currentEra = session.kind === 'assessment-session' && assessmentSessionEra(session);
    if (!currentEra) {
      if (explicit || namesNewSession) applicationAuditInvalid('Application reservation fields require the declared assessment session era');
      return null;
    }
    if (namedSession !== session.id) applicationAuditInvalid('The assessment context must name its exact audited session');
    // The explicit operator replay predates the reservation callback and never
    // sends a new call. It must consume its selected response below or refuse.
    if (!explicit && isResponseRecovery()) return { kind: 'replay-only' };
    if (!isRef(audit.application) || typeof audit.prepareCall !== 'function' || audit.purpose !== 'assessor')
      applicationAuditInvalid('A new assessment reservation needs both its exact application and transition callback');
    const application = audit.store.get<Record<string, any>>(audit.application.id, audit.application.revision);
    if (!application || application.kind !== 'assessment-application' || application.revision !== 1 || !recordValue(application.value)
      || canonical(reference(application)) !== canonical(audit.application) || hashJson(application.value) !== application.hash)
      applicationAuditInvalid('The prepared assessment application is missing, foreign or changed');
    const app = application.value, binding = session.value.binding;
    if (!recordValue(binding) || !isRef(binding.draft) || !isRef(binding.question) || !isRef(binding.environment)
      || !Array.isArray(binding.inputs) || !binding.inputs.every(isRef)
      || app.contract !== 'assessment-application/v1' || app.projectId !== environment.projectId
      || session.value.projectId !== environment.projectId || session.value.application !== application.id
      || !isRef(app.session) || canonical(app.session) !== canonical(audit.session)
      || application.id !== `assessment-application:${hashJson([session.id, session.revision])}`
      || app.state !== 'prepared' || app.call !== null || app.after !== null || app.received !== null
      || app.refusal !== null || app.resolution !== null || !recordValue(app.role) || canonical(app.role) !== canonical(role)
      || !recordValue(app.dispatch) || canonical(app.dispatch) !== canonical(environment)
      || !(app.profile === null || isRef(app.profile)) || !Array.isArray(app.guards)
      || audit.draftId !== binding.draft.id || audit.questionId !== binding.question.id)
      applicationAuditInvalid('The reservation must preserve the prepared session, source identities, role and runtime');
    const profile = audit.pilot ? reference(audit.pilot) : null;
    if (canonical(app.profile) !== canonical(profile)) applicationAuditInvalid('The reservation profile differs from its original admission');
    if (audit.pilot) {
      const pilot = audit.store.get<ReaderPilot>(audit.pilot.id, audit.pilot.revision);
      if (!pilot || pilot.kind !== 'reader-pilot' || canonical(pilot) !== canonical(audit.pilot))
        applicationAuditInvalid('The reservation profile is not its exact saved producer');
    }
    const draft = audit.store.get<DiscoveryDraft>(binding.draft.id, binding.draft.revision);
    const question = audit.store.get<Question>(binding.question.id, binding.question.revision);
    if (!draft || draft.kind !== 'discovery-draft' || !recordValue(draft.value) || canonical(reference(draft)) !== canonical(binding.draft)
      || !question || question.kind !== 'question' || !recordValue(question.value) || canonical(reference(question)) !== canonical(binding.question)
      || draft.value.projectId !== environment.projectId || question.value.projectId !== environment.projectId
      || question.value.draftId !== draft.id || !Array.isArray(draft.value.questions) || !draft.value.questions.includes(question.id)
      || canonical(draft.value.inputs) !== canonical(binding.inputs))
      applicationAuditInvalid('The application must bind the exact project draft and its question');
    if (canonical(uniqueTransactionGuards(app.guards)) !== canonical(app.guards))
      applicationAuditInvalid('The prepared application needs its complete normalized transaction guards');
    return { kind: 'application', session, application };
  } catch (error) {
    if (error instanceof EngineError && error.code === 'research_context_application_invalid') throw error;
    applicationAuditInvalid('The assessment reservation has an invalid saved admission');
  }
}

function preparedAssessmentCall(reservation: AssessmentReservation | null, call: Write, original: string,
  prepared: { writes: Write[]; guards: TransactionGuard[] } | undefined): void {
  if (!reservation) return;
  if (reservation.kind !== 'application') applicationAuditInvalid('Operator recovery cannot reserve another physical call');
  try {
    if (!recordValue(prepared) || !Array.isArray(prepared.writes) || !Array.isArray(prepared.guards)
      || prepared.writes.length !== 1 || canonical(call) !== original)
      applicationAuditInvalid('The assessment callback must preserve the call and supply its atomic transition and guards');
    const { application, session } = reservation;
    const expected = { id: application.id, kind: application.kind, expected: application.revision,
      value: { ...application.value, state: 'running', call: { id: call.id, revision: call.expected + 1, hash: hashJson(call.value) } } };
    if (canonical(prepared.writes[0]) !== canonical(expected))
      applicationAuditInvalid('The reservation must atomically bind this prepared application to this exact pending call');
    const guards = uniqueTransactionGuards(prepared.guards);
    const required = uniqueTransactionGuards([reference(session), reference(application), ...application.value.guards]);
    if (!required.every(guard => guards.some(candidate => canonical(candidate) === canonical(guard))))
      applicationAuditInvalid('The reservation cannot omit any original application or session guard');
  } catch (error) {
    if (error instanceof EngineError && error.code === 'research_context_application_invalid') throw error;
    applicationAuditInvalid('The assessment callback returned an invalid atomic reservation');
  }
}

/** The same real packet builder declares admission and later dispatches it.
 * Preflight may save a content-addressed archive, never a call or usage. */
export function prepareResearchEnvelope(role: RoleBinding, environment: Environment, prompt: string,
  context: unknown, audit?: Pick<ResearchCallAudit, 'store' | 'draftId' | 'questionId' | 'purpose' | 'pilot'>,
  capacity?: Record<string, any>, requestId = '00000000-0000-0000-0000-000000000000',
  requestContract?: string) {
  const draft = audit?.store.get<DiscoveryDraft>(audit.draftId);
  const planSubject = packetPlanSubject(capacity?.bindings ?? {});
  requireCondition(!planSubject || audit?.purpose === 'analyst' && capacity?.purpose === 'analyst'
    && !['planning','consolidation'].includes((context as any)?.dispatchMode) && !(context as any)?.synthesisSession
    && (context as any)?.contextControls?.mode !== 'finalization',
    'research_v7_mode_unavailable', 'Only the analyst plan-question path is connected');
  requireCondition(!planSubject || audit?.questionId && draft, 'research_plan_subject_invalid',
    'A plan subject requires the common saved-question packet');
  const packetState = audit?.questionId && draft ? continuationState(audit.store, environment.projectId, audit.draftId,
    audit.questionId, audit.purpose, role.actor, planSubject) : null;
  const consolidating = (context as any)?.dispatchMode === 'consolidation';
  const controls = (context as any)?.contextControls;
  const finalizing = !consolidating && controls?.mode === 'finalization';
  const envelope = { protocol: "omg-agent/v1", requestId, mode: "research", model: role.model,
    effort: role.effort, ...(role.speed ? { speed: role.speed } : {}), prompt: consolidating ? ((context as any)?.consolidation?.tightening ? TIGHTENING_INSTRUCTION : '') + CONSOLIDATION_INSTRUCTION : finalizing ? FINAL_SYNTHESIS_INSTRUCTION : packetState && !packetState.initial ? continuationPrompt(audit!.purpose, prompt) + (audit!.purpose === 'analyst' && !planSubject ? COMPACT_CHECKPOINT_INSTRUCTION : '') : prompt };
  const packingContext = capacity === undefined ? context : { ...context as Record<string, unknown>, resultCapacity: capacity };
  const requestLimit = capacity === undefined ? audit?.pilot?.value.maxRequestChars ?? DEFAULT_RESEARCH_REQUEST_CHARS
    : capacity.envelopeLimitChars;
  const outputLimit = researchResponseOutputLimit(audit?.pilot?.value.physicalLimits?.maxReplyChars ?? null);
  const overhead = JSON.stringify(outputLimit).length + 32 + Math.max(JSON.stringify({ ...envelope, subject: {} }).length,
    controls?.version === 2 && !consolidating ? JSON.stringify({...envelope,prompt:FINAL_SYNTHESIS_INSTRUCTION,subject:{}}).length : 0) + (packetState ? 4000 : 0);
  const subjectFor = (limit: number) => {
    const packed = packetState ? workingContext(audit!.store, environment.projectId, audit!.draftId, audit!.questionId!, packingContext,
      limit, { common: true, purpose: audit!.purpose, ...(planSubject?{subject:planSubject}:{}), continuation: !packetState.initial,
        ...(packetState.latest ? { previous: packetState.latest } : {}),
        ...(audit!.pilot ? { contextChars: audit!.pilot.value.maxRequestChars } : {}),
        ...(audit!.pilot ? { extractedChars: audit!.pilot.value.maxRequestChars } : {}) })
      : packingContext && typeof packingContext === 'object' && !Array.isArray(packingContext) ? { ...packingContext } : packingContext;
    if (packetState) (packed as any).continuation = continuationMetadata(packetState, (packed as any).working.archive, audit!.store);
    if (packed && typeof packed === 'object') (packed as Record<string, unknown>).responseOutputLimit = outputLimit;
    return packed;
  };
  let subjectLimit = requestLimit - overhead;
  let subject = subjectFor(subjectLimit);
  const physicalLimit = Math.min(requestLimit, audit?.pilot?.value.physicalLimits?.maxRequestChars ?? requestLimit);
  if (!consolidating && (subject as any)?.contextControls?.mode === 'finalization') envelope.prompt = FINAL_SYNTHESIS_INSTRUCTION;
  const canonicalWire = JSON.stringify({ ...envelope, subject });
  let input = canonicalWire;
  if (requestContract === REQUEST_MANIFEST_CONTRACT) {
    requireCondition(partitionResearchWire(envelope, subject).join('') === canonicalWire,
      'request_manifest_invalid', 'The wire manifest parts must match the canonical envelope');
  }
  // Keep RD2b's measured transport adjustment in the single real builder used
  // by both preflight and dispatch; the result marker is already in subject.
  for (let attempt = 0; packetState && input.length > physicalLimit && attempt < 4; attempt += 1) {
    subjectLimit -= input.length - physicalLimit + 128;
    subject = subjectFor(subjectLimit);
    if (!consolidating && (subject as any)?.contextControls?.mode === 'finalization') envelope.prompt = FINAL_SYNTHESIS_INSTRUCTION;
    input = JSON.stringify({ ...envelope, subject });
    if (requestContract === REQUEST_MANIFEST_CONTRACT) {
      requireCondition(partitionResearchWire(envelope, subject).join('') === input,
        'request_manifest_invalid', 'The wire manifest parts must match the canonical envelope');
    }
  }
  if (capacity !== undefined) requireCondition(recordValue(subject) && Object.hasOwn(subject, 'resultCapacity')
    && canonical(subject.resultCapacity) === canonical(capacity),
  'research_capacity_invalid', 'The packed request must preserve its exact saved result admission');
  if (!consolidating && context && typeof context === 'object' && Object.hasOwn(context, 'contextWorkspace'))
    requireContextDelivery((context as any).contextWorkspace, subject as Record<string, any>);
  requireCondition(input.length <= requestLimit, packetState?.initial === false ? "continuation_packet_limit" : "pilot_request_limit", "Full envelope exceeds its fixed transport budget; split the piece, never raise the ceiling");
  requireCondition(!audit?.pilot?.value.physicalLimits || input.length <= audit.pilot.value.physicalLimits.maxRequestChars,
    "budget_transport_limit", "The full envelope exceeds the declared physical transport capacity; split the material before dispatch");
  return { packetState, subject, envelope, input, requestLimit };
}

export async function researchCall(role: RoleBinding, environment: Environment, prompt: string, context: unknown, signal?: AbortSignal,
  audit?: ResearchCallAudit): Promise<unknown> {
  recoveryDispatchBoundary();
  const roleName = role.actor === environment.implementer.actor ? 'implementer'
    : role.actor === environment.reviewer.actor ? 'reviewer' : 'reader';
  role = resolveRoleMode(roleName, role, 'research');
  let consumerIntent: Revision<ResearchConsumerIntent> | null = null;
  let planSubject: V7PlanSubject | null = null;
  // Preview bypasses only the unsaved intent it synthesized for a prospective
  // request. A durable intent may already own a paid reply, which must be
  // replayed before preview reaches the next provider boundary.
  const durableConsumerIntent = audit?.consumerIntent
    ? audit.store.get<ResearchConsumerIntent>(audit.consumerIntent.id, audit.consumerIntent.revision)
    : null;
  if (audit?.previewIntent) requireCondition(isResearchPreview(), 'research_preview_unbound',
    'A virtual consumer cannot authorize an actual dispatch');
  if (audit?.consumerIntent) {
    if (audit.application || audit.prepareCall || !audit.store) applicationAuditInvalid('A consumer intent cannot share an assessment reservation callback');
    const virtual = isResearchPreview() && !durableConsumerIntent;
    if (virtual) {
      const prepared = audit.previewIntent;
      requireCondition(prepared?.kind === 'research-consumer-intent' && prepared.value.state === 'prepared'
        && prepared.hash === hashJson(prepared.value)
        && canonical(reference(prepared)) === canonical(audit.consumerIntent),
      'research_consumer_intent_invalid', 'Preview needs its exact unsent virtual producer');
      consumerIntent = prepared;
    } else {
      const supplied = readResearchConsumerIntent(audit.store, audit.consumerIntent);
      const head = audit.store.get<ResearchConsumerIntent>(supplied.id);
      requireCondition(head, 'research_consumer_intent_invalid', 'The selected consumer intent disappeared');
      consumerIntent = readResearchConsumerIntent(audit.store, reference(head));
    }
    requireCondition(consumerIntent.value.projectId === environment.projectId && consumerIntent.value.draft.id === audit.draftId
      && consumerIntent.value.question.id === audit.questionId && canonical(consumerIntent.value.role) === canonical(role)
      && canonical(consumerIntent.value.dispatch) === canonical(environment)
      && canonical(consumerIntent.value.profile) === canonical(audit.pilot ? reference(audit.pilot) : null),
    'research_consumer_intent_invalid', 'The saved consumer operation differs from the selected role, project, question or environment');
    planSubject = planSubjectOf(consumerIntent.value.cursor);
    requireCondition(!planSubject || consumerIntent.value.kind === 'analyst' && audit.purpose === 'analyst',
      'research_v7_mode_unavailable', 'The v7 planner and synthesis consumers are not connected');
    if (consumerIntent.value.state !== 'prepared' && !isResponseRecovery()) {
      if (consumerIntent.value.state === 'applied') throw new EngineError('research_consumer_intent_applied', 'The completed consumer operation must return its saved output');
      const paid = resumeResearchConsumerExecution(audit.store, environment.projectId, reference(consumerIntent));
      if (paid.kind !== 'response') throw new EngineError('research_consumer_execution_refused', 'The saved physical result did not contain a research answer');
      audit.onContext?.(paid.subject);
      return paid.payload;
    }
    if (consumerIntent.value.state === 'prepared') {
      const savedPrompt = consumerIntent.value.cursor.prompt ?? consumerIntent.value.cursor.instruction;
      requireCondition(typeof savedPrompt === 'string' && canonical(savedPrompt) === canonical(prompt)
        && Object.hasOwn(consumerIntent.value.cursor, 'context')
        && canonical(consumerIntent.value.cursor.context) === canonical(context),
      'research_consumer_intent_invalid', 'The unsent intent must preserve its exact original prompt and consumer context');
    }
  }
  const requestContract = audit?.requestContract;
  if (requestContract !== undefined) {
    requireCondition(
      requestContract === REQUEST_MANIFEST_CONTRACT,
      'request_contract_invalid',
      `Unsupported or unknown request contract: ${String(requestContract)}`
    );
    requireCondition(
      consumerIntent !== null && consumerIntent.value.kind === 'analyst',
      'request_contract_unsupported',
      'The wire manifest contract is only supported for analyst consumer intents'
    );
  }
  const useWireManifest = requestContract === REQUEST_MANIFEST_CONTRACT;
  const assessment = assessmentReservation(audit, role, environment, context);
  // Direct callers may pass the saved base prompt. A new admission still sends
  // the same complete assessor instructions declared by the producer.
  if (assessment?.kind === 'application' && assessment.application.value.context.resultCapacityContract !== undefined
    && prompt === assessment.application.value.prompt) prompt = assessmentRolePrompt(prompt);
  const draft = audit?.store.get<DiscoveryDraft>(audit.draftId);
  // Unbound audit labels belong to the general transport API. A saved question
  // or a producer's Discovery address must never lose its draft and dispatch free.
  if (audit && (draft || audit.questionId || audit.draftId.startsWith('discovery:')))
    requireCondition(draft?.kind === 'discovery-draft' && recordValue(draft.value)
      && draft.value.projectId === environment.projectId && Array.isArray(draft.value.questions)
      && Array.isArray(draft.value.inputs), 'discovery_draft_invalid', 'The call needs its saved project draft');
  if (draft && isDiscoveryV7Draft(draft.value)) {
    requireCondition(!['reading-planner','synthesis','consolidation'].includes(consumerIntent?.value.kind ?? audit!.purpose)
      && !(context as any)?.synthesisSession && !['planning','consolidation'].includes((context as any)?.dispatchMode),
      'research_v7_mode_unavailable', 'The v7 planner and synthesis consumers are not connected');
    const question = audit!.questionId ? audit!.store.get<Question>(audit!.questionId) : null;
    requireCondition(!(audit!.purpose === 'analyst' && question?.value.spec.field === 'plan' && question.value.status === 'answered') || planSubject,
      'research_plan_subject_invalid', 'An accepted plan needs its exact saved plan-question subject');
  }
  const policy = audit ? phasePolicy(audit.store, environment.projectId) : null;
  let segment = null;
  let groups: string[] = [];
  let protectedQuestion: Revision<Question> | null = null;
  if (audit && draft?.value.stage === "om-g2") {
    const phase = draft.value.consumer !== "compilation" && draft.value.level === "R2" ? "L3" : draft.value.level;
    assertPilotBoundary(audit.store, environment.projectId, phase);
    if (draft.value.level === "R2" && policy) {
      const current = readerPilot(audit.store, environment.projectId);
      requireCondition(current && audit.pilot && hashJson(reference(current)) === hashJson(reference(audit.pilot)),
        "phase_protections_missing", "Every R2 role must use the current protected preset");
      const question = audit.store.get<Question>(audit.questionId ?? "");
      requireCondition(question, "budget_question_missing", "Every R2 role needs its logical question");
      protectedQuestion = question;
      planningForQuestion(audit.store, draft, question, current);
      const scope = researchScope(audit.store, environment.projectId);
      requireCondition(scope && draft.value.inputs.some(ref => hashJson(ref) === hashJson(reference(scope))),
        "research_scope_stale", "R2 requires its current explicit research scope");
      segment = budgetSegment(audit.store, environment.projectId, policy.value.budgetSegment!);
      groups = budgetGroups(audit.store, draft.id, question.id);
      assertQuestionBudget(audit.store, segment, groups);
      requireCondition(budgetUsage(audit.store, segment).measured <= segment.value.limit, "budget_actual_overrun", "An actual segment overrun requires an owner decision before continuation, including replay");
    }
  }
  requireCondition(!draft || Boolean(audit?.questionId), "continuation_question_missing", "A saved research draft cannot bypass the common packer by omitting its question");
  const requestId = randomUUID();
  const callId = consumerIntent ? `model-call:consumer:v1:${requestId}` : `model-call:${requestId}`;
  const capacity = consumerIntent?.value.cursor.resultCapacity
    ?? (assessment?.kind === 'application' ? assessment.application.value.context.resultCapacity : undefined);
  // G5a (№6218): the saved admission is trusted — its capacity was computed and
  // proved once when the producer wrote the prepared revision. The actual prompt
  // is still compared to that saved declaration below; nothing is recomputed.
  if (consumerIntent?.value.cursor.resultCapacityContract !== undefined)
    requireCondition(consumerIntent.value.cursor.resultCapacityContract === RESULT_CAPACITY
      && consumerIntent.value.cursor.resultCapacity !== undefined,
      'research_capacity_invalid', 'The saved consumer admission lost its declared capacity');
  requireCondition(sameSubject(packetPlanSubject(capacity?.bindings ?? {}),planSubject),
    'research_plan_subject_invalid', 'The packet binding must equal the saved consumer subject');
  const { packetState, subject, envelope, input, requestLimit } = prepareResearchEnvelope(role, environment,
    prompt, context, audit, capacity, requestId, requestContract);
  if (capacity !== undefined) requireCondition(researchCapacityProjection(capacity, audit?.store).prompt === envelope.prompt,
    'research_capacity_invalid', 'The actual role prompt differs from its predeclared result admission');
  audit?.onContext?.(subject as Record<string, any>);
  const recovered = operatorReplayedResponse(role, input, audit);
  if (recovered) { audit?.onContext?.(recovered.subject); return recovered.research; }
  if (assessment?.kind === 'replay-only') applicationAuditInvalid('The operator recovery did not consume its selected response');
  interceptResearchPreview(input,{limit:requestLimit,draft:audit?.draftId??'',question:audit?.questionId??'',purpose:audit?.purpose??''});
  if (!consumerIntent && audit?.pilot && packetState) {
    const previous = audit.store.list<ModelCall>("model-call").filter(c => c.value.status === "failed" && c.value.error === "pilot_reply_limit"
      && c.value.questionId === audit.questionId && c.value.purpose === audit.purpose && c.value.requested.actor === role.actor
      && c.value.packet?.archive.hash === (subject as any).working.archive.hash && c.value.request.record);
    for (const call of previous) {
      const ref = call.value.request.record!;
      const saved = audit.store.get<{text:string}>(ref.id, ref.revision);
      requireCondition(saved?.hash === ref.hash, "research_replay_invalid", "Saved request bytes are unavailable");
      const paid = replayLimitedResponse(audit.store, audit.pilot, role, audit.draftId, audit.questionId, audit.purpose, saved.value.text);
      if (paid) { audit.onContext?.(JSON.parse(saved.value.text).subject); return paid.research; }
    }
  }
  const replay = !consumerIntent && audit?.pilot ? replayLimitedResponse(audit.store, audit.pilot, role, audit.draftId,
    audit.questionId, audit.purpose, input) : null;
  if (replay) return replay.research;
  // Budget admission is only for a NEW send: every paid-return path above is free.
  const originalDraft = audit && draft ? audit.store.get<DiscoveryDraft>(draft.id, 1) : null;
  const stageV7 = isDiscoveryV7Draft(draft?.value) || isDiscoveryV7Draft(originalDraft?.value);
  const stagePlan = stageV7 && audit && draft ? stageBudgetPlan(audit.store, draft) : null;
  let stageSegment: Revision<BudgetSegment> | null = null;
  let stageEstimate: CallEstimate | null = null;
  let stageRemaining = 0;
  const stageFailure = (code: string, message: string): never => {
    throw new EngineError(code, message, { segment: stageSegment ? reference(stageSegment) : null,
      class: 'research', remaining: stageRemaining, estimate: stageEstimate });
  };
  if (stagePlan && audit && draft) {
    requireCondition(isDiscoveryV7Draft(draft.value), 'discovery_draft_invalid', 'A v7 draft cannot lose its era');
    requireCondition(typeof audit.purpose === 'string' && audit.purpose.length > 0 && packetState !== null,
      'discovery_draft_invalid', 'A v7 send needs its saved question and purpose');
    stageSegment = 'saved' in stagePlan.target ? stagePlan.target.saved : {
      id: stagePlan.writes[0]!.id, kind: 'research-budget', revision: 1,
      value: stagePlan.target.creating, hash: hashJson(stagePlan.target.creating) };
    const usage = stagePlan.isNew ? { measured: 0, reserved: 0 } : budgetUsage(audit.store, stageSegment);
    stageRemaining = stageSegment.value.limit - stageSegment.value.completionReserve! - usage.measured - usage.reserved;
    if (usage.measured > stageSegment.value.limit)
      stageFailure('discovery_budget_overrun', 'Actual stage usage forbids another paid send');
    try { stageEstimate = estimateCliCall(audit.store, environment.projectId, role, audit.purpose, input.length,
      packetState?.initial === false ? 'continuation' : 'initial'); }
    catch (error) {
      if (error instanceof EngineError && error.code === 'budget_estimate_missing') stageFailure(error.code, error.message);
      throw error;
    }
  }
  const control = audit && draft && earlyResearchStage(draft.value.stage)
    ? new RunControlGate(audit.store, environment.projectId) : null;
  try { control?.admit(); }
  catch (error) {
    if (error instanceof RunControlLost) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
    throw error;
  }
  const progressContext = (subject as any)?.contextControls ? {...context as Record<string,any>,contextControls:(subject as any).contextControls} : context;
  const progress=packetState?invocationProgress(audit!.store,audit!.questionId!,audit!.purpose,progressContext as Record<string,any>,planSubject,role.actor):null;
  const runtime = audit && draft ? await captureCallRuntime(audit.store, draft.value, role, environment, digest(input), signal) : null;
  const reservation = !segment && !stagePlan && audit?.pilot ? pilotDispatch(audit.store, audit.pilot, callId, input.length) : { writes: [], guards: [] };
  const estimate = segment && audit ? estimateCliCall(audit.store, environment.projectId, role, audit.purpose, input.length, packetState?.initial === false ? "continuation" : "initial") : null;
  if (segment && audit && estimate) {
    requireCondition(input.length <= requestLimit!, "pilot_request_limit", "Complete envelope exceeds its working limit");
    const reserved = reserveResearchCall(audit.store, segment, callId, groups, estimate);
    reservation.writes.push(...reserved.writes);
    reservation.guards.push(...reserved.guards, reference(policy!), reference(audit.pilot!), reference(draft!), reference(protectedQuestion!), ...draft!.value.inputs);
  }
  if (stagePlan && stageEstimate && audit && draft) {
    // The closing-kind whitelist is empty until DR6/DR7. No caller/model field
    // (role, purpose, finalization mode or attempt end) grants completion funds.
    try {
      const reserved = reserveResearchCall(audit.store, stagePlan.target, callId,
        [DISCOVERY_V7_STAGE_BUDGET_KEY], stageEstimate, 'research');
      reservation.writes.push(...reserved.writes);
      reservation.guards.push(...reserved.guards, reference(draft), ...draft.value.inputs);
    } catch (error) {
      if (error instanceof EngineError && ['budget_segment_exhausted', 'budget_question_limit', 'budget_owner_group_limit'].includes(error.code)) {
        const latest = stagePlan.isNew ? { measured: 0, reserved: 0 } : budgetUsage(audit.store, stageSegment!);
        stageRemaining = stageSegment!.value.limit - stageSegment!.value.completionReserve! - latest.measured - latest.reserved;
        stageFailure(latest.measured > stageSegment!.value.limit ? 'discovery_budget_overrun' : 'discovery_budget_reserve', error.message);
      }
      throw error;
    }
  }
  if(audit){
    const projectCounterId=`project-dispatch:${hashJson(environment.projectId)}`;
    const projectCounter=audit.store.get<{projectId:string;serial:number}>(projectCounterId);
    requireCondition(!audit.store.list<RuntimeObservation>('runtime-observation').some(observation=>observation.value.projectId===environment.projectId&&observation.value.status==='running'),
      'runtime_observation_busy','Wait for the declared runtime observation before spending another model call');
    requireCondition(!projectCounter||(projectCounter.kind==='project-dispatch'&&projectCounter.value.projectId===environment.projectId
      &&Number.isSafeInteger(projectCounter.value.serial)&&projectCounter.value.serial>=0),
    'research_dispatch_invalid','Invalid project dispatch counter');
    reservation.writes.push({id:projectCounterId,kind:'project-dispatch',expected:projectCounter?.revision??0,
      value:{projectId:environment.projectId,serial:(projectCounter?.value.serial??0)+1}});
    if(projectCounter)reservation.guards.push(reference(projectCounter));
    if(policy)reservation.guards.push(reference(policy));
  }
  let manifestReservationResult: ReturnType<typeof prepareRequestPartsAndManifest> | null = null;
  if (useWireManifest) {
    manifestReservationResult = prepareRequestPartsAndManifest({
      store: audit!.store,
      projectId: environment.projectId,
      draftId: audit!.draftId,
      requestId,
      envelope,
      subject,
      ...(consumerIntent ? { intentRef: reference(consumerIntent) } : {}),
    });
    reservation.writes.push(...manifestReservationResult.writes);
    reservation.guards.push(...manifestReservationResult.guards);
  }
  if (packetState) {
    const questionCounterId=`question-dispatch:${hashJson(planSubject ? [environment.projectId,planSubject] : audit!.questionId!)}`;
    const questionCounter=audit!.store.get<{projectId:string;question:string;serial:number;subject?:V7PlanSubject}>(questionCounterId);
    requireCondition(!questionCounter||(questionCounter.kind==='question-dispatch'&&questionCounter.value.projectId===environment.projectId
      &&questionCounter.value.question===audit!.questionId&&sameSubject(packetPlanSubject(questionCounter.value),planSubject)&&Number.isSafeInteger(questionCounter.value.serial)&&questionCounter.value.serial>=0),
    'research_dispatch_invalid','Invalid question dispatch counter');
    reservation.writes.push({id:questionCounterId,kind:'question-dispatch',expected:questionCounter?.revision??0,
      value:{projectId:environment.projectId,question:audit!.questionId,...(planSubject?{subject:planSubject}:{}),serial:(questionCounter?.value.serial??0)+1}});
    if(questionCounter) reservation.guards.push(reference(questionCounter));
    if(audit!.session) reservation.guards.push(audit!.session);
    const dispatch = continuationDispatch(packetState, callId);
    reservation.writes.push(...dispatch.writes); reservation.guards.push(...dispatch.guards,...(progress?.guards??[]));
    if (!useWireManifest) {
      reservation.writes.push({id:`model-request:${requestId}`,kind:"model-request",expected:0,
        value:{projectId:environment.projectId,draftId:audit!.draftId,text:input}});
    }
  }
  const ownership = audit ? physicalClaim() : null;
  const callWrite: Write = { id: callId, kind: "model-call", expected: 0,
    value: { projectId: environment.projectId, draftId: audit?.draftId ?? "", purpose: audit?.purpose ?? "", requestId,
      ...(segment && estimate ? { budget: { segment: reference(segment), groups, estimate } } : {}),
      ...(stageSegment && stageEstimate ? { budget: { segment: reference(stageSegment),
        groups: [DISCOVERY_V7_STAGE_BUDGET_KEY], estimate: stageEstimate } } : {}),
      ...(progress?{progressKey:progress.key}:{}),
      ...(ownership ?? {}),
      ...(audit?.application ? { assessmentApplication: audit.application } : {}),
      ...(consumerIntent ? { consumerIntent: reference(consumerIntent) } : {}),
      profile: audit?.pilot ? reference(audit.pilot) : null,
      questionId: planSubject?.planQuestionId ?? audit?.questionId ?? null,
      ...(planSubject ? { planAnswer:planSubject.planAnswer } : {}),
      startedAt: Date.now(), finishedAt: null, status: "running", requested: role,
      ...(runtime ? { runtime } : {}),
      confirmed: { model: null, effort: null, speed: null }, request: { chars: input.length, bytes: Buffer.byteLength(input), hash: digest(input), ...(useWireManifest
        ? { record: manifestReservationResult!.manifestRef }
        : packetState
          ? { record: { id: `model-request:${requestId}`, revision: 1, hash: hashJson({ projectId: environment.projectId, draftId: audit!.draftId, text: input }) } }
          : {}) },
      ...(packetState ? {packet:{archive:(subject as any).working.archive,kind:packetState.initial?"initial":"continuation",maxChars:requestLimit}} : {}),
      response: null, usage: null, usageSource: "unavailable", error: null } };
  const originalCall = assessment ? canonical(callWrite) : '';
  const application = audit?.prepareCall?.(callWrite);
  preparedAssessmentCall(assessment, callWrite, originalCall, application);
  const consumerReservation = consumerIntent ? prepareResearchConsumerReservation(audit!.store, reference(consumerIntent), callWrite,
    (callWrite.value as ModelCall).request.record!, (callWrite.value as ModelCall).packet!.archive) : null;
  requireInvocationAllowance();
  let call: Revision<ModelCall> | null;
  try {
    const writer = audit ? control?.view() ?? audit.store : null;
    call = writer ? writer.writeMany<ModelCall>([callWrite, ...reservation.writes,
      ...(application?.writes ?? []), ...(consumerReservation?.writes ?? [])],
      [...reservation.guards, ...(application?.guards ?? []), ...(consumerReservation?.guards ?? [])])[0]! : null;
  } catch (error) {
    if (error instanceof RunControlLost) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
    throw error;
  }
  const claimed = call ? reference(call) : null;
  let patch: Partial<ModelCall> = {};
  let rawResponse: string | null = null;
  let physicalResult: import('../runtime/process.js').ProcessResult | null = null;
  let stopRefusal: EngineError | null = null;
  let heldSpawn: EngineError | null = null;
  let stopCancel: ReturnType<RunControlGate['cancelledBy']> = null;
  let spawnedPid: number | null = null;
  const controlAbort = control ? new AbortController() : null;
  const forwardAbort = () => controlAbort?.abort();
  if (controlAbort && signal) {
    if (signal.aborted) controlAbort.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  const stopWatching = controlAbort ? control!.watch(controlAbort) : null;
  const dispatchSignal = controlAbort?.signal ?? signal;
  try {
    control?.assertCurrent();
    const result = await runProcess(role.command, environment.workspace, input, environment.timeoutMs, dispatchSignal, true, pid=>{
      spawnedPid = pid;
      try {
        if(call&&audit) call = authorizeModelDispatch(control?.view() ?? audit.store, reference(call), pid);
        consumeInvocationAllowance();
      } catch (error) {
        if (error instanceof RunControlLost)
          throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
        throw error;
      }
    });
    physicalResult = result;
    rawResponse = result.stdout;
    patch.response = { chars: result.stdout.length, bytes: Buffer.byteLength(result.stdout) };
    const outcome = projectResearchPhysicalReply(result.stdout, requestId, result.exitCode, result.stderr,
      audit?.pilot?.value.physicalLimits?.maxReplyChars ?? null);
    patch = { ...patch, status: outcome.status, error: outcome.error, usage: outcome.usage,
      usageSource: outcome.usageSource, confirmed: outcome.confirmed };
    if (outcome.error) throw new EngineError(outcome.error, outcome.message ?? 'Research call failed');
    return outcome.payload;
  } catch (error) {
    const failure = error instanceof RunControlLost
      ? new EngineError(error.refusal.code, error.refusal.message, error.refusal.at) : error;
    // An unproven stop is not a terminal model failure: the running claim, the
    // reserved call and the physical witness survive; only the witness is
    // appended — no failed/finishedAt, no intent refusal, no finalization.
    if (isProcessStopRefusal(failure)) { stopRefusal = failure as EngineError; throw failure; }
    const dispatchRefused = failure instanceof EngineError
      && ['run_stopped', 'run_control_changed'].includes(failure.code);
    // A control refusal before authorization proves that no request crossed
    // stdin; other ownership failures still need the spawned-process witness.
    if (call && audit && spawnedPid !== null && executionOf(call.value)?.phase === 'claimed' && !dispatchRefused) {
      heldSpawn = failure instanceof EngineError ? failure
        : new EngineError('process_record_failed', failure instanceof Error ? failure.message : 'The spawned provider was not durably recorded');
      throw failure;
    }
    // DRY6-02: a cancellation is linked to the common stop only when this call's own watch aborted it for a stop of its
    // admitted generation; an external signal, a timeout or any other end gains no such proof.
    if (failure instanceof EngineError && failure.code === 'process_cancelled' && controlAbort?.signal.reason === RUN_CONTROL_MOVED) {
      try { stopCancel = control!.cancelledBy(); } catch (lostControl) { if (!(lostControl instanceof RunControlLost)) throw lostControl; }
    }
    patch.status = "failed"; patch.error = failure instanceof EngineError ? failure.code : "research_call_failed"; throw failure;
  } finally {
    stopWatching?.();
    if (controlAbort && signal) signal.removeEventListener('abort', forwardAbort);
    if (call && audit && (stopRefusal || heldSpawn))
      writeProcessStopWitness(audit.store, reference(call),
        { owner: call.value.ownerProcess ?? null, child: call.value.providerProcess ?? null, pid: spawnedPid }, stopRefusal ?? heldSpawn);
    else if (call && audit) {
      const responseWrites = [];
      if (rawResponse !== null) {
        const saved = { id: `model-response:${requestId}`, kind: "model-response", expected: 0,
          value: { projectId: environment.projectId, draftId: audit.draftId, text: rawResponse,
            ...(audit.application && physicalResult ? { assessmentExecution: { contract: 'assessment-execution/v1',
              call: claimed, dispatch: reference(call), process: { exitCode: physicalResult.exitCode,
                signal: physicalResult.signal, stderr: physicalResult.stderr } } } : {}) } };
        if (consumerIntent && physicalResult) (saved.value as Record<string, unknown>)['consumerExecution'] = {
          contract: 'research-consumer-execution/v1', call: claimed, dispatch: reference(call),
          process: { exitCode: physicalResult.exitCode, signal: physicalResult.signal, stderr: physicalResult.stderr } };
        responseWrites.push(saved);
        patch.response = { ...patch.response!, record: { id: saved.id, revision: 1, hash: hashJson(saved.value) } };
      }
      try {
        const terminal: ModelCall = { ...call.value, ...patch, finishedAt: Date.now(), ...(runtime?.status === 'captured'
          ? { runtime: { ...runtime, status: 'unavailable', error: 'call_runtime_finalize_pending' } } : {}) };
        const linked = stopCancel && patch.status === 'failed' && patch.error === 'process_cancelled'
          ? [callStopCancelWrite(environment.projectId, { id: call.id, revision: call.revision + 1, hash: hashJson(terminal) }, stopCancel)] : [];
        // A terminal snapshot includes every charged call and the ledger head.
        // A competing accounting revision only invalidates this snapshot. Keep
        // the paid bytes until a coherent batch commits; it cannot turn a live
        // dispatch into process_lost by exhausting an arbitrary retry count.
        for (;;) {
          const incident: Write[] = [], guards: TransactionGuard[] = [];
          if (stageSegment) {
            const usage = budgetUsage(audit.store, stageSegment);
            const used = (value: ModelCall) => value.usage ? value.usage.inputTokens + value.usage.outputTokens : 0;
            const measured = usage.measured - used(call.value) + used(terminal);
            guards.push(...usage.guards, ...(usage.ledger ? [reference(usage.ledger)] : []));
            if (measured > stageSegment.value.limit) incident.push({ id: `budget-incident:${requestId}`,
              kind: 'budget-incident', expected: 0, value: { projectId: environment.projectId,
                segment: reference(stageSegment), call: { id: call.id, revision: call.revision + 1, hash: hashJson(terminal) },
                reason: 'Actual stage usage exceeded the budget; subsequent paid sends are forbidden' } });
          }
          try {
            call = audit.store.writeMany<ModelCall>([{ id: call.id, kind: call.kind, expected: call.revision, value: terminal },
              ...responseWrites, ...linked, ...incident], guards)[0]!;
            break;
          } catch (error) {
            if (!stageSegment || !(error instanceof EngineError) || error.code !== 'input_stale') throw error;
            const changed = audit.store.headsMatch(guards).mismatches, ownId = call.id;
            // Only other charged calls / the ledger may move. A changed own
            // dispatch or segment is a different conflict, never this retry.
            if (!changed.length || changed.some(item => item.id === ownId || item.id === stageSegment.id)) throw error;
          }
        }
      } catch (error) {
        if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code) || !physicalResult) throw error;
        // A recovery may win the runtime CAS. Keep the observed physical bytes
        // under the same authorized dispatch instead of dropping paid evidence.
        if (stageSegment) {
          const head = audit.store.get<ModelCall>(call.id);
          if (head?.value.status !== 'failed' || head.value.error !== 'process_lost' || !head.value.recovery) throw error;
          const recovered = readModelCallRecovery(audit.store, environment.projectId, reference(head));
          if (canonical(reference(recovered.original)) !== canonical(reference(call))) throw error;
        }
        const late = prepareLateModelReceipt(audit.store, environment.projectId, reference(call), { process: physicalResult, launchError: null });
        audit.store.writeMany(late.writes, late.guards);
        throw error;
      }
      if (consumerIntent && patch.status === 'failed' && patch.error !== 'process_lost')
        refuseResearchConsumerIntent(audit.store, reference(consumerIntent));
      if (segment && budgetUsage(audit.store, segment).measured > segment.value.limit) {
        audit.store.write({ id: `budget-incident:${requestId}`, kind: "budget-incident", expected: 0,
          value: { projectId: environment.projectId, segment: reference(segment), call: reference(call), reason: "Actual provider usage exceeded the experimental forecast and the owner budget; further calls are forbidden" } });
        throw new EngineError("budget_actual_overrun", "Actual usage exceeded the owner budget; the incident is recorded and further calls are blocked");
      }
      if (segment) assertQuestionBudget(audit.store, segment, groups);
      // Persist the paid response and usage before hashing runtime files. If
      // telemetry is interrupted, accounting survives and R3 sees explicit
      // unavailable evidence; it must never trigger another paid invocation.
      if (runtime?.status === 'captured') {
        const measured = await finishCallRuntime(audit.store, environment.projectId, runtime);
        try { call = audit.store.write<ModelCall>({ id: call.id, kind: call.kind, expected: call.revision,
          value: { ...call.value, runtime: measured } }); }
        catch (error) {
          if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
          // A concurrent record update wins; the already saved paid result is
          // not repeated solely to complete runtime telemetry.
        }
      }
    }
  }
}
