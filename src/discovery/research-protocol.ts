import { FINAL_SYNTHESIS_INSTRUCTION } from './synthesis-controls.js';
import { CONSOLIDATION_INSTRUCTION, COMPACT_CHECKPOINT_INSTRUCTION, TIGHTENING_INSTRUCTION } from './conclusion-consolidation.js';
import { physicalClaim, authorizeModelDispatch, prepareLateModelReceipt, executionOf } from './model-call-recovery.js';
import { invocationProgress, consumeInvocationAllowance } from "./invocation-progress.js";
import { requireContextDelivery } from "./context-workspace.js";
import { interceptResearchPreview, isResearchPreview } from './research-preview.js';
import type { RuntimeObservation } from '../runtime/runtime-observation-model.js';
import { continuationState, continuationDispatch, continuationMetadata, continuationPrompt } from "./continuation-packet.js";
import { estimateCliCall } from "../adapters/codex-estimate.js";
import { assertPilotBoundary, readerPilot } from "./reader-pilot.js";
import { phasePolicy } from "./phase-policy.js";
import { budgetSegment, budgetUsage, budgetGroups, assertQuestionBudget, reserveResearchCall } from "../runtime/research-budget.js";
import { planningForQuestion } from "./research-routing.js";
import { researchScope } from "../graph/research-scope.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { randomUUID } from "node:crypto";
import { runProcess } from "../runtime/process.js";
import { isProcessStopRefusal, writeProcessStopWitness } from "../runtime/process-identity.js";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import { uniqueTransactionGuards } from '../runtime/environment.js';
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

export { researchAction } from './research-consumer-transition.js';

interface ResearchCallAudit {
  store: Store; draftId: string; purpose: string; questionId?: string; pilot?: Revision<ReaderPilot>;
  session?: Ref; onContext?: (context: Record<string, any>) => void;
  application?: Ref; prepareCall?: (call: Write) => { writes: Write[]; guards: TransactionGuard[] };
  consumerIntent?: Ref;
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

export async function researchCall(role: RoleBinding, environment: Environment, prompt: string, context: unknown, signal?: AbortSignal,
  audit?: ResearchCallAudit): Promise<unknown> {
  recoveryDispatchBoundary();
  let consumerIntent: Revision<ResearchConsumerIntent> | null = null;
  // Preview bypasses only the unsaved intent it synthesized for a prospective
  // request. A durable intent may already own a paid reply, which must be
  // replayed before preview reaches the next provider boundary.
  const durableConsumerIntent = audit?.consumerIntent
    ? audit.store.get<ResearchConsumerIntent>(audit.consumerIntent.id, audit.consumerIntent.revision)
    : null;
  if (audit?.consumerIntent && (!isResearchPreview() || durableConsumerIntent)) {
    if (audit.application || audit.prepareCall || !audit.store) applicationAuditInvalid('A consumer intent cannot share an assessment reservation callback');
    const supplied = readResearchConsumerIntent(audit.store, audit.consumerIntent);
    const head = audit.store.get<ResearchConsumerIntent>(supplied.id);
    requireCondition(head, 'research_consumer_intent_invalid', 'The selected consumer intent disappeared');
    consumerIntent = readResearchConsumerIntent(audit.store, reference(head));
    requireCondition(consumerIntent.value.projectId === environment.projectId && consumerIntent.value.draft.id === audit.draftId
      && consumerIntent.value.question.id === audit.questionId && canonical(consumerIntent.value.role) === canonical(role)
      && canonical(consumerIntent.value.dispatch) === canonical(environment)
      && canonical(consumerIntent.value.profile) === canonical(audit.pilot ? reference(audit.pilot) : null),
    'research_consumer_intent_invalid', 'The saved consumer operation differs from the selected role, project, question or environment');
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
  const assessment = assessmentReservation(audit, role, environment, context);
  const draft = audit?.store.get<DiscoveryDraft>(audit.draftId);
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
  const packetState = audit?.questionId && draft ? continuationState(audit.store, environment.projectId, audit.draftId,
    audit.questionId, audit.purpose, role.actor) : null;
  const requestId = randomUUID();
  const callId = consumerIntent ? `model-call:consumer:v1:${requestId}` : `model-call:${requestId}`;
  const consolidating = (context as any)?.dispatchMode === 'consolidation';
  const controls = (context as any)?.contextControls;
  const finalizing = !consolidating && controls?.mode === 'finalization';
  const envelope = { protocol: "omg-agent/v1", requestId, mode: "research", model: role.model,
    effort: role.effort, ...(role.speed ? { speed: role.speed } : {}), prompt: consolidating ? ((context as any)?.consolidation?.tightening ? TIGHTENING_INSTRUCTION : '') + CONSOLIDATION_INSTRUCTION : finalizing ? FINAL_SYNTHESIS_INSTRUCTION : packetState && !packetState.initial ? continuationPrompt(audit!.purpose) + (audit!.purpose === 'analyst' ? COMPACT_CHECKPOINT_INSTRUCTION : '') : prompt };
  const requestLimit = audit?.pilot?.value.maxRequestChars ?? 300000;
  const overhead = Math.max(JSON.stringify({ ...envelope, subject: {} }).length,
    controls?.version === 2 && !consolidating ? JSON.stringify({...envelope,prompt:FINAL_SYNTHESIS_INSTRUCTION,subject:{}}).length : 0) + (packetState ? 4000 : 0);
  const subject = packetState ? workingContext(audit!.store, environment.projectId, audit!.draftId, audit!.questionId!, context,
    requestLimit - overhead, { common: true, continuation: !packetState.initial, ...(packetState.latest ? {previous:packetState.latest} : {}),
      ...(audit!.pilot?{contextChars:audit!.pilot.value.maxRequestChars}:{}),
      ...(audit!.pilot?{extractedChars:audit!.pilot.value.maxRequestChars}:{}) }) : context;
  if (packetState) (subject as any).continuation = continuationMetadata(packetState, (subject as any).working.archive);
  if (!consolidating && context && typeof context==='object' && Object.hasOwn(context,'contextWorkspace'))
    requireContextDelivery((context as any).contextWorkspace,subject as Record<string,any>);
  audit?.onContext?.(subject as Record<string, any>);
  if (!consolidating && (subject as any)?.contextControls?.mode === 'finalization') envelope.prompt = FINAL_SYNTHESIS_INSTRUCTION;
  const input = JSON.stringify({ ...envelope, subject });
  requireCondition(input.length <= requestLimit, packetState?.initial === false ? "continuation_packet_limit" : "pilot_request_limit", "Full envelope exceeds its fixed transport budget; split the piece, never raise the ceiling");
  requireCondition(!audit?.pilot?.value.physicalLimits || input.length <= audit.pilot.value.physicalLimits.maxRequestChars,
    "budget_transport_limit", "The full envelope exceeds the declared physical transport capacity; split the material before dispatch");
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
  const progressContext = (subject as any)?.contextControls ? {...context as Record<string,any>,contextControls:(subject as any).contextControls} : context;
  const progress=packetState?invocationProgress(audit!.store,audit!.questionId!,audit!.purpose,progressContext as Record<string,any>):null;
  const runtime = audit && draft ? await captureCallRuntime(audit.store, draft.value, role, environment, digest(input), signal) : null;
  const reservation = !segment && audit?.pilot ? pilotDispatch(audit.store, audit.pilot, callId, input.length) : { writes: [], guards: [] };
  const estimate = segment && audit ? estimateCliCall(audit.store, environment.projectId, role, audit.purpose, input.length, packetState?.initial === false ? "continuation" : "initial") : null;
  if (segment && audit && estimate) {
    requireCondition(input.length <= requestLimit!, "pilot_request_limit", "Complete envelope exceeds its working limit");
    const reserved = reserveResearchCall(audit.store, segment, callId, groups, estimate);
    reservation.writes.push(...reserved.writes);
    reservation.guards.push(...reserved.guards, reference(policy!), reference(audit.pilot!), reference(draft!), reference(protectedQuestion!), ...draft!.value.inputs);
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
  if (packetState) {
    const questionCounterId=`question-dispatch:${hashJson(audit!.questionId!)}`;
    const questionCounter=audit!.store.get<{projectId:string;question:string;serial:number}>(questionCounterId);
    requireCondition(!questionCounter||(questionCounter.kind==='question-dispatch'&&questionCounter.value.projectId===environment.projectId
      &&questionCounter.value.question===audit!.questionId&&Number.isSafeInteger(questionCounter.value.serial)&&questionCounter.value.serial>=0),
    'research_dispatch_invalid','Invalid question dispatch counter');
    reservation.writes.push({id:questionCounterId,kind:'question-dispatch',expected:questionCounter?.revision??0,
      value:{projectId:environment.projectId,question:audit!.questionId,serial:(questionCounter?.value.serial??0)+1}});
    if(questionCounter) reservation.guards.push(reference(questionCounter));
    if(audit!.session) reservation.guards.push(audit!.session);
    const dispatch = continuationDispatch(packetState, callId);
    reservation.writes.push(...dispatch.writes); reservation.guards.push(...dispatch.guards,...(progress?.guards??[]));
    reservation.writes.push({id:`model-request:${requestId}`,kind:"model-request",expected:0,
      value:{projectId:environment.projectId,draftId:audit!.draftId,text:input}});
  }
  const ownership = audit ? physicalClaim() : null;
  consumeInvocationAllowance();
  const callWrite: Write = { id: callId, kind: "model-call", expected: 0,
    value: { projectId: environment.projectId, draftId: audit?.draftId ?? "", purpose: audit?.purpose ?? "", requestId,
      ...(segment && estimate ? { budget: { segment: reference(segment), groups, estimate } } : {}),
      ...(progress?{progressKey:progress.key}:{}),
      ...(ownership ?? {}),
      ...(audit?.application ? { assessmentApplication: audit.application } : {}),
      ...(consumerIntent ? { consumerIntent: reference(consumerIntent) } : {}),
      profile: audit?.pilot ? reference(audit.pilot) : null,
      questionId: audit?.questionId ?? null,
      startedAt: Date.now(), finishedAt: null, status: "running", requested: role,
      ...(runtime ? { runtime } : {}),
      confirmed: { model: null, effort: null, speed: null }, request: { chars: input.length, bytes: Buffer.byteLength(input), hash: digest(input), ...(packetState ? {record:{id:`model-request:${requestId}`,revision:1,
        hash:hashJson({projectId:environment.projectId,draftId:audit!.draftId,text:input})}} : {}) },
      ...(packetState ? {packet:{archive:(subject as any).working.archive,kind:packetState.initial?"initial":"continuation",maxChars:requestLimit}} : {}),
      response: null, usage: null, usageSource: "unavailable", error: null } };
  const originalCall = assessment ? canonical(callWrite) : '';
  const application = audit?.prepareCall?.(callWrite);
  preparedAssessmentCall(assessment, callWrite, originalCall, application);
  const consumerReservation = consumerIntent ? prepareResearchConsumerReservation(audit!.store, reference(consumerIntent), callWrite,
    (callWrite.value as ModelCall).request.record!, (callWrite.value as ModelCall).packet!.archive) : null;
  let call: Revision<ModelCall> | null = audit ? audit.store.writeMany<ModelCall>([callWrite, ...reservation.writes,
    ...(application?.writes ?? []), ...(consumerReservation?.writes ?? [])],
    [...reservation.guards, ...(application?.guards ?? []), ...(consumerReservation?.guards ?? [])])[0]! : null;
  const claimed = call ? reference(call) : null;
  let patch: Partial<ModelCall> = {};
  let rawResponse: string | null = null;
  let physicalResult: import('../runtime/process.js').ProcessResult | null = null;
  let stopRefusal: EngineError | null = null;
  let heldSpawn: EngineError | null = null;
  let spawnedPid: number | null = null;
  try {
    const result = await runProcess(role.command, environment.workspace, input, environment.timeoutMs, signal, true, pid=>{
      spawnedPid = pid;
      if(call&&audit) call = authorizeModelDispatch(audit.store, reference(call), pid);
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
    // An unproven stop is not a terminal model failure: the running claim, the
    // reserved call and the physical witness survive; only the witness is
    // appended — no failed/finishedAt, no intent refusal, no finalization.
    if (isProcessStopRefusal(error)) { stopRefusal = error as EngineError; throw error; }
    // A spawned provider whose authorization or identity capture was refused
    // before the dispatch commit leaves no providerProcess and no readable
    // no-response terminal. The running claim stays open — the witness holds
    // the spawned pid so recovery can prove its end instead.
    if (call && audit && spawnedPid !== null && executionOf(call.value)?.phase === 'claimed') {
      heldSpawn = error instanceof EngineError ? error
        : new EngineError('process_record_failed', error instanceof Error ? error.message : 'The spawned provider was not durably recorded');
      throw error;
    }
    patch.status = "failed"; patch.error = error instanceof EngineError ? error.code : "research_call_failed"; throw error;
  } finally {
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
        call = audit.store.writeMany<ModelCall>([{ id: call.id, kind: call.kind, expected: call.revision,
          value: { ...call.value, ...patch, finishedAt: Date.now(), ...(runtime?.status === 'captured'
            ? { runtime: { ...runtime, status: 'unavailable', error: 'call_runtime_finalize_pending' } } : {}) } }, ...responseWrites])[0]!;
      } catch (error) {
        if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code) || !physicalResult) throw error;
        // A recovery may win the runtime CAS. Keep the observed physical bytes
        // under the same authorized dispatch instead of dropping paid evidence.
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
