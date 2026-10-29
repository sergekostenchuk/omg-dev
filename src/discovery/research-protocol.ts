import { producerDispatchPolicy, producerDispatchGuards } from './project-producer-policy.js';
import { isInterpretationConsumer, requireInterpretationConsumer, requireInterpretationNewDispatch } from './interpretation-execution.js';
import { dossierSessionTransport, dossierTransportDelivery, packetDossierSubject, requireDossierTransportContext } from './continuation-packet.js';
import { prepareDossierContextPacker } from './working-context.js';
import { requireDossierTransportArchive } from './continuation-packet.js';
import { readArchiveBody } from './request-parts.js';
import { contextValue } from './working-context.js';
import { requirePacketMaterialDelivery } from './research-delivery.js';
import { researchCapacityInput, resultCapacityFrom, requireResultCapacity, researchResultEnvelopeLimit } from './early-research-outcome.js';
import { baselineGuards } from './v7-attempt-assessment.js';
import { planSubjectOf, sameSubject, type V7PlanSubject } from './v7-managed-attempt.js';
import { proveDossierDispatchAdmission, readDossierReservationAt, assessmentRolePrompt, readAssessmentDispatchAdmission } from './assessment-session.js';
import { FINAL_SYNTHESIS_INSTRUCTION } from './synthesis-controls.js';

/** DR3a3-S2 (codex-omg №7690 решение 2): the final synthesis of a v7
 * plan-question returns the end of its attempt (K) — never answer_delta and
 * never an answer judged by the plan field's own citations; every other rule
 * of the final page is the same. */
const ATTEMPT_END_SENTENCE = 'Return answer/answer_delta only with sufficient valid citations and required evidence.';
export const V7_FINAL_SYNTHESIS_INSTRUCTION = FINAL_SYNTHESIS_INSTRUCTION.replace(ATTEMPT_END_SENTENCE,
  'Return the end of this plan-question attempt as {action:"answer",question:subject.question.id,value:<one end of subject.question.schema>,citations:[]}: a submitted end carries every claim with its basis inside value, refused or impossible name their evidence, duplicate names its exact original. An attempt has no answer_delta.');
if (V7_FINAL_SYNTHESIS_INSTRUCTION === FINAL_SYNTHESIS_INSTRUCTION)
  throw new Error('The v7 final synthesis instruction lost its attempt-end sentence');

/** DR3a3-S2: the roles of a v7 plan-question and how each packet declares
 * itself — the saved result admission's purpose, the caller purpose and the
 * dispatch context must name the same role. */
function planSubjectRole(capacityPurpose: unknown, auditPurpose: unknown, context: unknown): boolean {
  const c = (context && typeof context === 'object' && !Array.isArray(context) ? context : {}) as Record<string, any>;
  const session = typeof c.synthesisSession === 'string', mode = c.dispatchMode;
  const finalizing = c.contextControls?.mode === 'finalization';
  switch (capacityPurpose) {
    case 'analyst': return auditPurpose === 'analyst' && !session && !['planning', 'consolidation'].includes(mode) && !finalizing;
    // The final page belongs to synthesis alone: a planner never receives the attempt-end instruction.
    case 'reading-planner': return auditPurpose === 'reading-planner' && mode === 'planning' && !session && !finalizing;
    case 'synthesis': return auditPurpose === 'analyst' && session && !['planning', 'consolidation'].includes(mode);
    case 'consolidation': return auditPurpose === 'analyst' && session && mode === 'consolidation';
    default: return false;
  }
}
import { CONSOLIDATION_INSTRUCTION, COMPACT_CHECKPOINT_INSTRUCTION, TIGHTENING_INSTRUCTION } from './conclusion-consolidation.js';
import { physicalClaim, authorizeModelDispatch, prepareLateModelReceipt, readModelCallRecovery, executionOf } from './model-call-recovery.js';
import { invocationProgress, deepInvocationProgress, consumeInvocationAllowance, requireInvocationAllowance } from "./invocation-progress.js";
import { requireContextDelivery } from './context-workspace.js';
import { interceptResearchPreview, isResearchPreview } from './research-preview.js';
import type { RuntimeObservation } from '../runtime/runtime-observation-model.js';
import { assessmentTransportPrompt, packetAssessmentSubject, sameAssessmentSubject, proveAssessmentTransportSubject, assessmentSubjectKey, continuationState, continuationDispatch, continuationMetadata, continuationPrompt, packetPlanSubject, packetVariantSubject, requireVariantContext, variantTransportSubject, packetDeepPreparation } from "./continuation-packet.js";
import { requireCurrentDeepPreparation } from "./deep-research.js";
import { estimateCliCall } from "../adapters/codex-estimate.js";
import { assertPilotBoundary } from "./reader-pilot.js";
import { phasePolicy } from "./phase-policy.js";
import { budgetUsage, reserveResearchCall, type BudgetSegment, type CallEstimate } from "../runtime/research-budget.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from 'node:async_hooks';
import { runProcess } from "../runtime/process.js";
import { processStart, evaluateProcessStopWitnesses, isProcessStopRefusal, writeProcessStopWitness } from "../runtime/process-identity.js";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import { Environments, resolveRoleMode, uniqueTransactionGuards, transactionGuardsCurrent } from '../runtime/environment.js';
import { EngineError, requireCondition } from "../errors.js";
import { checkTransactionGuards, type Store, type Revision, type Write, type TransactionGuard } from "../storage/store.js";
import type { ModelCall } from "../runtime/model-usage.js";
import { canonical, digest, hashJson } from "../canonical.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { pilotDispatch } from "./pilot-budget.js";
import type { ReaderPilot } from "./reader-pilot.js";
import { workingContext } from "./working-context.js";
import { replayAssessmentApplication, replayVariantResponse, variantIdentityCalls, variantCallManaged } from "./response-replay.js";
import { decodeVariantGeneration, decodeVariantDecisionAnswer, decodeVariantExecutionSession, VARIANT_SESSION_KIND, type VariantSubject } from "./discovery-variants.js";
import { recoveryDispatchBoundary, operatorReplayedResponse, assessmentSessionEra, isResponseRecovery,
  readResearchConsumerIntent, resumeResearchConsumerExecution,
  refuseResearchConsumerIntent, prepareResearchConsumerReservation, consumerIntentContext, CONSUMER_INTENT_V2,
  requireDeepConsumerBinding, type ResearchConsumerIntent } from './response-recovery.js';
import { ARCHIVE_PARTS_CONTRACT } from './request-parts.js';
import type { RecoverableContextSession } from './context-recovery.js';
import { projectResearchPhysicalReply, SYNTHESIS_SESSION_V3_PREFIX } from './research-consumer-transition.js';
import { earlyResearchStage, researchCapacityProjection, researchResponseOutputLimit, DEFAULT_RESEARCH_REQUEST_CHARS, RESULT_CAPACITY } from './early-research-outcome.js';
import { RunControlGate, RunControlLost, RUN_CONTROL_MOVED, callStopCancelWrite, type RunControlHold } from '../om/run-control.js';
import { REQUEST_MANIFEST_CONTRACT, prepareRequestPartsAndManifest, partitionResearchWire } from './request-parts.js';

import { isDiscoveryV7Draft } from './v7-contracts.js';
import { stageBudgetPlan, DISCOVERY_V7_STAGE_BUDGET_KEY } from './stage-token-budget.js';
import { currentDiscoveryFinalGuards, prepareDiscoveryFinalContextPacker,
  readDiscoveryFinalDispatchAdmission } from './discovery-final-execution.js';
import { currentDiscoveryFinalAssessmentGuards, prepareDiscoveryFinalAssessmentContextPacker,
  readDiscoveryFinalAssessmentDispatchAdmission } from './discovery-final-assessment-execution.js';
import { currentConditionEvidenceGuards, prepareConditionEvidenceContextPacker,
  readConditionEvidenceDispatchAdmission } from './discovery-condition-evidence-execution.js';
import { pendingOverlay, storeView } from '../storage/store-view.js';

export { researchAction } from './research-consumer-transition.js';

interface ResearchControlScope {
  readonly store: Store;
  readonly project: string;
  readonly hold: RunControlHold;
  active: boolean;
}
const researchControl = new AsyncLocalStorage<ResearchControlScope>();

/** An invocation's original control follows its new sends, never its paid
 * returns or receipts. The snapshot cannot be replaced by a nested caller. */
export async function withResearchRunControl<T>(store: Store, project: string, hold: RunControlHold,
  work: () => Promise<T>): Promise<T> {
  requireCondition(recordValue(hold) && Object.keys(hold).length === 2 && hold.project === project
    && (hold.control === null || isRef(hold.control)),
    'run_control_request_invalid', 'Research control requires the original project hold');
  const snapshot: RunControlHold = Object.freeze({ project, control: hold.control === null ? null : Object.freeze({ ...hold.control }) });
  const outer = researchControl.getStore();
  if (outer) {
    requireCondition(outer.active && outer.store === store && outer.project === project && canonical(outer.hold) === canonical(snapshot),
      'run_control_changed', 'A nested research invocation cannot replace its original control');
    return work();
  }
  const scope: ResearchControlScope = { store, project, hold: snapshot, active: true };
  try { return await researchControl.run(scope, work); }
  finally { scope.active = false; }
}

function researchControlScope(store: Store | undefined, project: string): ResearchControlScope | undefined {
  const scope = researchControl.getStore();
  if (scope) {
    requireCondition(scope.active && scope.store === store && scope.project === project,
      'run_control_changed', 'A research send must retain its invocation Store, project and live control scope');
  }
  return scope;
}
function researchDispatchControl(store: Store | undefined, project: string, early: boolean): RunControlGate | null {
  const scope = researchControlScope(store, project);
  if (scope) return new RunControlGate(scope.store, project, scope.hold);
  return store && early ? new RunControlGate(store, project) : null;
}

export interface ResearchCallAudit {
  store: Store; draftId: string; purpose: string; questionId?: string; pilot?: Revision<ReaderPilot>;
  session?: Ref; onContext?: (context: Record<string, any>) => void;
  application?: Ref; prepareCall?: (call: Write) => { writes: Write[]; guards: TransactionGuard[] };
  /** Final's immutable prepared application and, for its first step, origin
   * are staged into the same transaction as its physical claim. */
  finalPending?: { session?: Write; application: Write };
  /** Independent D7 assessment: its own cursor and application, never the
   * immutable prepared session or the original D7 producer application. */
  finalAssessmentPending?: { session?: Write; application: Write };
  /** OMG-V7-B3: the evidence assessment of one condition — its own cursor and application. */
  conditionEvidencePending?: { session?: Write; application: Write };
  consumerIntent?: Ref;
  /** Trusted caller dependencies for a new physical send only. They augment
   * the reservation, never the saved intent, wire or a paid replay. */
  consumerDispatchGuards?: TransactionGuard[];
  /** Virtual producer only inside the no-dispatch preview scope. */
  previewIntent?: Revision<ResearchConsumerIntent>;
  requestContract?: string;
  /** DRS1a2: the archive contract of the packer — set only by trusted code: the
   * intent producer's preflight, and researchCall from the saved intent. */
  contextContract?: typeof ARCHIVE_PARTS_CONTRACT;
}
type AssessmentReservation = { kind: 'replay-only' } | {
  kind: 'application' | 'dossier'; session: Revision<RecoverableContextSession>; application: Revision<Record<string, any>>;
} | {
  kind: 'final'; session: Revision<RecoverableContextSession>; application: Revision<Record<string, any>>;
  admission: Awaited<ReturnType<typeof readDiscoveryFinalDispatchAdmission>>;
  writes: Write[]; guards: TransactionGuard[];
} | {
  kind: 'final-assessment'; session: Revision<RecoverableContextSession>; application: Revision<Record<string, any>>;
  admission: Awaited<ReturnType<typeof readDiscoveryFinalAssessmentDispatchAdmission>>;
  writes: Write[]; guards: TransactionGuard[];
} | {
  kind: 'condition-evidence'; session: Revision<RecoverableContextSession>; application: Revision<Record<string, any>>;
  admission: Awaited<ReturnType<typeof readConditionEvidenceDispatchAdmission>>;
  writes: Write[]; guards: TransactionGuard[];
};
const recordValue = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function applicationAuditInvalid(message: string): never {
  throw new EngineError('research_context_application_invalid', message);
}

/** This is the atomic transport seam, not another assessment state machine.
 * The saved session selects the era before optional callback fields can do so. */
async function dossierAssessmentReservation(audit: ResearchCallAudit | undefined, role: RoleBinding, environment: Environment, context: unknown): Promise<AssessmentReservation> {
  const managed=dossierSessionTransport(context);
  requireCondition(managed && audit && isRef(audit.session) && isRef(audit.application)
    && typeof audit.prepareCall==='function' && !audit.consumerIntent && !audit.previewIntent
    && audit.purpose==='dossier-assessor','discovery_dossier_dispatch_unavailable',
    'A dossier send requires its exact managed session and application');
  const admission=await proveDossierDispatchAdmission(audit.store,audit.application);
  requireCondition(canonical(reference(admission.session))===canonical(audit.session)
    && canonical(admission.context)===canonical(context) && canonical(admission.role)===canonical(role)
    && canonical(admission.dispatch)===canonical(environment) && admission.draft.id===audit.draftId
    && admission.question.id===audit.questionId && canonical(admission.session.value.profile)===canonical(audit.pilot?reference(audit.pilot):null),
    'discovery_dossier_session_invalid','The dispatch must preserve its original dossier admission');
  const current=new Environments(audit.store).effective(environment.projectId);
  requireCondition([...current.guards,...current.admissionGuards].every(guard=>admission.application.value.guards.some(saved=>canonical(saved)===canonical(guard))),
    'discovery_dossier_session_invalid','The new dossier send lost its mandatory current runtime guards');
  return {kind:'dossier',session:admission.session,application:admission.application};
}
/** A prepared D7 packet is not permission to spend: only its separate saved
 * application and current exact guards can reserve a physical call. */
async function finalReservation(audit: ResearchCallAudit | undefined, role: RoleBinding,
  environment: Environment, prompt: string, context: unknown): Promise<AssessmentReservation> {
  requireCondition(audit && audit.purpose === 'discovery-final' && isRef(audit.session)
    && isRef(audit.application) && !audit.prepareCall && !audit.finalAssessmentPending && !audit.conditionEvidencePending && recordValue(audit.finalPending)
    && !audit.consumerIntent && !audit.previewIntent,
  'discovery_final_dispatch_unavailable', 'A final call requires its own exact session and application');
  const pending = audit.finalPending;
  const writes = [...(pending.session ? [pending.session] : []), pending.application];
  requireCondition(writes.every(write => recordValue(write) && typeof write.id === 'string'
    && typeof write.kind === 'string' && write.expected === 0 && recordValue(write.value)
    && !audit.store.get(write.id)) && pending.application.kind === 'discovery-final-application'
    && (!pending.session || pending.session.kind === 'discovery-final-execution')
    && new Set(writes.map(write => write.id)).size === writes.length,
  'discovery_final_dispatch_unavailable', 'The final claim needs fresh exact staged records');
  const rows = writes.map(write => ({ id: write.id, kind: write.kind, revision: 1,
    hash: hashJson(write.value as never), value: write.value }));
  // The common pending layer owns frozen snapshots and traces every read back
  // to its genuine source; an arbitrary Proxy would lose that proof chain.
  const view = pendingOverlay(audit.store, rows);
  const admission = await readDiscoveryFinalDispatchAdmission(view, audit.application);
  const current = currentDiscoveryFinalGuards(audit.store, environment.projectId, admission);
  requireCondition(canonical(reference(admission.session)) === canonical(audit.session)
    && canonical(reference(admission.application)) === canonical(audit.application)
    && canonical(pending.application.value) === canonical(admission.application.value)
    && (!pending.session || canonical(pending.session.value) === canonical(admission.session.value))
    && canonical(admission.context) === canonical(context) && canonical(admission.role) === canonical(role)
    && canonical(admission.dispatch) === canonical(environment) && admission.prompt === prompt
    && admission.draft.id === audit.draftId && admission.question.id === audit.questionId
    && canonical(admission.session.value.profile) === canonical(audit.pilot ? reference(audit.pilot) : null)
    && current.every(guard => admission.application.value.guards.some(saved => canonical(saved) === canonical(guard))),
  'discovery_final_dispatch_unavailable', 'The final call differs from its current proved admission');
  const guards: TransactionGuard[] = [pending.session ? { id: pending.session.id, absent: true } : audit.session,
    { id: pending.application.id, absent: true }, ...admission.application.value.guards];
  return { kind: 'final', session: admission.session, application: admission.application, admission,
    writes, guards: uniqueTransactionGuards(guards) };
}
/** An assessment cannot acquire a physical reservation from an unproven
 * candidate or from preparation alone. Both source and session are re-read
 * inside the common pending-overlay admission. */
async function finalAssessmentReservation(audit: ResearchCallAudit | undefined, role: RoleBinding,
  environment: Environment, prompt: string, context: unknown): Promise<AssessmentReservation> {
  requireCondition(audit && audit.purpose === 'discovery-final-assessment' && isRef(audit.session)
    && isRef(audit.application) && !audit.prepareCall && !audit.finalPending && !audit.conditionEvidencePending && recordValue(audit.finalAssessmentPending)
    && !audit.consumerIntent && !audit.previewIntent,
  'discovery_final_assessment_dispatch_unavailable', 'An assessment call needs its exact session and application');
  const pending = audit.finalAssessmentPending;
  const writes = [...(pending.session ? [pending.session] : []), pending.application];
  requireCondition(writes.every(write => recordValue(write) && typeof write.id === 'string'
    && typeof write.kind === 'string' && write.expected === 0 && recordValue(write.value)
    && !audit.store.get(write.id)) && pending.application.kind === 'discovery-final-assessment-application'
    && (!pending.session || pending.session.kind === 'discovery-final-assessment-execution')
    && new Set(writes.map(write => write.id)).size === writes.length,
  'discovery_final_assessment_dispatch_unavailable', 'The assessment claim needs fresh exact staged records');
  const rows = writes.map(write => ({ id: write.id, kind: write.kind, revision: 1,
    hash: hashJson(write.value as never), value: write.value }));
  const admission = await readDiscoveryFinalAssessmentDispatchAdmission(pendingOverlay(audit.store, rows), audit.application);
  const current = currentDiscoveryFinalAssessmentGuards(audit.store, environment.projectId, admission);
  requireCondition(canonical(reference(admission.session)) === canonical(audit.session)
    && canonical(reference(admission.application)) === canonical(audit.application)
    && canonical(pending.application.value) === canonical(admission.application.value)
    && (!pending.session || canonical(pending.session.value) === canonical(admission.session.value))
    && canonical(admission.context) === canonical(context) && canonical(admission.role) === canonical(role)
    && canonical(admission.dispatch) === canonical(environment) && admission.prompt === prompt
    && admission.draft.id === audit.draftId && admission.question.id === audit.questionId
    && canonical(admission.session.value.profile) === canonical(audit.pilot ? reference(audit.pilot) : null)
    && current.every(guard => admission.application.value.guards.some(saved => canonical(saved) === canonical(guard))),
  'discovery_final_assessment_dispatch_unavailable', 'The assessment call differs from its proven paid admission');
  return { kind: 'final-assessment', session: admission.session, application: admission.application, admission, writes,
    guards: uniqueTransactionGuards([pending.session ? { id: pending.session.id, absent: true } : audit.session,
      { id: pending.application.id, absent: true }, ...admission.application.value.guards]) };
}
/** OMG-V7-B3: an evidence call reserves physically only from its own fresh staged cursor and application, proven again
 * — the whole evidence subject and its preparation — inside the common pending-overlay admission. */
async function conditionEvidenceReservation(audit: ResearchCallAudit | undefined, role: RoleBinding,
  environment: Environment, prompt: string, context: unknown): Promise<AssessmentReservation> {
  requireCondition(audit && audit.purpose === 'discovery-condition-evidence' && isRef(audit.session)
    && isRef(audit.application) && !audit.prepareCall && !audit.finalPending && !audit.finalAssessmentPending
    && recordValue(audit.conditionEvidencePending) && !audit.consumerIntent && !audit.previewIntent,
  'discovery_condition_evidence_dispatch_unavailable', 'An evidence call needs its exact session and application');
  const pending = audit.conditionEvidencePending;
  const writes = [...(pending.session ? [pending.session] : []), pending.application];
  requireCondition(writes.every(write => recordValue(write) && typeof write.id === 'string'
    && typeof write.kind === 'string' && write.expected === 0 && recordValue(write.value)
    && !audit.store.get(write.id)) && pending.application.kind === 'discovery-condition-evidence-application'
    && (!pending.session || pending.session.kind === 'discovery-condition-evidence-execution')
    && new Set(writes.map(write => write.id)).size === writes.length,
  'discovery_condition_evidence_dispatch_unavailable', 'The evidence claim needs fresh exact staged records');
  const rows = writes.map(write => ({ id: write.id, kind: write.kind, revision: 1, hash: hashJson(write.value as never), value: write.value }));
  const admission = await readConditionEvidenceDispatchAdmission(pendingOverlay(audit.store, rows), audit.application);
  const current = currentConditionEvidenceGuards(audit.store, environment.projectId, admission);
  requireCondition(canonical(reference(admission.session)) === canonical(audit.session)
    && canonical(reference(admission.application)) === canonical(audit.application)
    && canonical(pending.application.value) === canonical(admission.application.value)
    && (!pending.session || canonical(pending.session.value) === canonical(admission.session.value))
    && canonical(admission.context) === canonical(context) && canonical(admission.role) === canonical(role)
    && canonical(admission.dispatch) === canonical(environment) && admission.prompt === prompt
    && admission.draft.id === audit.draftId && admission.question.id === audit.questionId
    && canonical(admission.session.value.profile) === canonical(audit.pilot ? reference(audit.pilot) : null)
    && current.every(guard => admission.application.value.guards.some(saved => canonical(saved) === canonical(guard))),
  'discovery_condition_evidence_dispatch_unavailable', 'The evidence call differs from its proven admission');
  return { kind: 'condition-evidence', session: admission.session, application: admission.application, admission, writes,
    guards: uniqueTransactionGuards([pending.session ? { id: pending.session.id, absent: true } : audit.session,
      { id: pending.application.id, absent: true }, ...admission.application.value.guards]) };
}
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
    if (session.kind !== 'assessment-session') {
      if (explicit || namesNewSession) applicationAuditInvalid('Application reservation fields require the declared assessment session era');
      return null;
    }
    // LG62: an assessment session without the declared era prefix is no longer dispatched.
    if (!assessmentSessionEra(session)) applicationAuditInvalid('An assessment session without its declared era is not dispatched');
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
    const assessmentSubject = packetAssessmentSubject(app.context);
    requireCondition(sameAssessmentSubject(app.context, context)
      && sameAssessmentSubject(app.context, app.context.resultCapacity?.bindings ?? {}),
      'discovery_assessment_subject_invalid', 'Application, capacity and dispatch must name the same packet and baseline');
    if (assessmentSubject) {
      requireCondition(baselineGuards(assessmentSubject.baseline).every(guard => app.guards.some((saved:unknown)=>canonical(saved)===canonical(guard))),
        'discovery_assessment_subject_invalid', 'The prepared application must guard its original baseline');
      requireCondition(!Object.hasOwn(app.context, 'subject') && !Object.hasOwn(app.context.resultCapacity.bindings, 'subject'),
        'discovery_assessment_subject_invalid', 'An assessor cannot masquerade as an analyst plan subject');
      const expected = readAssessmentDispatchAdmission(audit.store, reference(application)).context;
      requireCondition(canonical(context)===canonical(expected), 'discovery_assessment_subject_invalid',
        'The dispatch context must be the exact prepared application and session cursor');
      // Historical paid recovery does not depend on live plan or baseline heads.
      // Only the new-send branch below proves M and current transaction guards.
    }
    return { kind: 'application', session, application };
  } catch (error) {
    if (error instanceof EngineError && ['research_context_application_invalid','discovery_assessment_subject_invalid'].includes(error.code)) throw error;
    applicationAuditInvalid('The assessment reservation has an invalid saved admission');
  }
}

function preparedAssessmentCall(reservation: AssessmentReservation | null, call: Write, original: string,
  prepared: { writes: Write[]; guards: TransactionGuard[] } | undefined): void {
  if (!reservation) return;
  if (reservation.kind !== 'application' && reservation.kind !== 'dossier' && reservation.kind !== 'final'
    && reservation.kind !== 'final-assessment' && reservation.kind !== 'condition-evidence') applicationAuditInvalid('Operator recovery cannot reserve another physical call');
  if (reservation.kind === 'final' || reservation.kind === 'final-assessment' || reservation.kind === 'condition-evidence') {
    if (prepared !== undefined || canonical(call) !== original)
      applicationAuditInvalid('The final claim cannot use an assessment transition callback');
    return;
  }
  try {
    if (!recordValue(prepared) || !Array.isArray(prepared.writes) || !Array.isArray(prepared.guards)
      || prepared.writes.length !== 1 || canonical(call) !== original)
      applicationAuditInvalid('The assessment callback must preserve the call and supply its atomic transition and guards');
    const { application, session } = reservation;
    const extra = reservation.kind === 'dossier' && Object.hasOwn(prepared.writes[0]?.value ?? {}, 'dispatchGuards')
      ? uniqueTransactionGuards(checkTransactionGuards((prepared.writes[0]!.value as any).dispatchGuards)) : undefined;
    const expected = { id: application.id, kind: application.kind, expected: application.revision,
      value: { ...application.value, ...(extra===undefined?{}:{dispatchGuards:extra}), state: 'running', call: { id: call.id, revision: call.expected + 1, hash: hashJson(call.value) } } };
    if (canonical(prepared.writes[0]) !== canonical(expected))
      applicationAuditInvalid('The reservation must atomically bind this prepared application to this exact pending call');
    const guards = uniqueTransactionGuards(prepared.guards);
    const required = uniqueTransactionGuards([reference(session), reference(application), ...application.value.guards,...(extra??[])]);
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
  context: unknown, audit?: Pick<ResearchCallAudit, 'store' | 'draftId' | 'questionId' | 'purpose' | 'pilot' | 'contextContract'>,
  capacity?: Record<string, any>, requestId = '00000000-0000-0000-0000-000000000000',
  requestContract?: string, requestLimitChars?: number) {
  requireCondition(!packetDossierSubject(context) && !packetDossierSubject(capacity?.bindings)
    && audit?.purpose !== 'dossier-assessor', 'discovery_dossier_transport_invalid',
  'A dossier needs the asynchronous envelope preflight');
  requireCondition(requestLimitChars === undefined || Number.isSafeInteger(requestLimitChars) && requestLimitChars > 0,
    'research_request_limit_invalid', 'A separate physical request limit must be a positive safe integer');
  return buildResearchEnvelope(role, environment, prompt, context, audit, capacity, requestId, requestContract,
    undefined, requestLimitChars);
}

/** Callable dossier preflight: accepted async proof, ordinary capacity arithmetic,
 * and the same measured wire builder and addressed material delivery. */
export async function prepareDossierResearchEnvelope(role: RoleBinding, environment: Environment, prompt: string,
  context: unknown, audit: Pick<ResearchCallAudit, 'store' | 'draftId' | 'questionId' | 'purpose' | 'pilot'>,
  capacity?: Record<string, any>, requestId = '00000000-0000-0000-0000-000000000000', stageArchives = false) {
  requireCondition(audit?.store && audit.purpose === 'dossier-assessor' && audit.questionId,
    'discovery_dossier_transport_invalid', 'Dossier preflight needs its explicitly separate audited purpose');
  const prepared = await prepareDossierContextPacker(audit.store, environment.projectId, context);
  const draft = audit.store.get<DiscoveryDraft>(audit.draftId), question = audit.store.get<Question>(audit.questionId);
  requireCondition(draft?.kind === 'discovery-draft' && question?.kind === 'question'
    && draft.value.projectId === environment.projectId && question.value.projectId === environment.projectId
    && question.value.draftId === draft.id && draft.value.questions.includes(question.id)
    && prepared.packet.basis.draft.ref.id === draft.id,
  'discovery_dossier_transport_invalid', 'Dossier preflight must retain its project and draft basis');
  const input = researchCapacityInput({ operation:prepared.packet.subject.identity, generation:0,
    bindings: { projectId:environment.projectId, draft:reference(draft), question:reference(question),
      dossierSubject:prepared.packet.subject }, role:'assessor', purpose:'dossier-assessor', actionMode:'dossier-preflight',
    limit:researchResultEnvelopeLimit(environment,audit.pilot?.value), physicalReplyLimit:audit.pilot?.value.physicalLimits?.maxReplyChars ?? null,
    prompt, binding:role, draft:draft.value,
    question, context:prepared.context });
  const managed=dossierSessionTransport(prepared.context);
  if(managed) {
    input.bindings={...input.bindings,managedDossier:managed};
    const minimum=input.mandatoryEnvelope.subject as Record<string,unknown>;
    minimum.managedDossier=managed;
    minimum.assessmentDelivery=dossierTransportDelivery(prepared.context);
  }
  const admitted = capacity === undefined ? resultCapacityFrom(input) : requireResultCapacity(capacity, input, audit.store);
  requireCondition(!Object.hasOwn(context as object, 'resultCapacity')
    || canonical((context as any).resultCapacity) === canonical(admitted),
  'discovery_dossier_transport_invalid', 'Caller context cannot substitute the exact dossier capacity');
  const built = buildResearchEnvelope(role, environment, prompt, prepared.context, audit, admitted, requestId, undefined, prepared);
  requireCondition(recordValue(built.subject), 'discovery_dossier_transport_invalid', 'Dossier envelope needs a structured subject');
  if (!stageArchives) prepared.commit();
  return { ...built, subject:built.subject, archives:prepared.staged() };
}

function buildResearchEnvelope(role: RoleBinding, environment: Environment, prompt: string,
  context: unknown, audit?: Pick<ResearchCallAudit, 'store' | 'draftId' | 'questionId' | 'purpose' | 'pilot' | 'contextContract'>,
  capacity?: Record<string, any>, requestId = '00000000-0000-0000-0000-000000000000',
  requestContract?: string, dossier?: Awaited<ReturnType<typeof prepareDossierContextPacker>>,
  requestLimitChars?: number, final?: ReturnType<typeof prepareDiscoveryFinalContextPacker>) {
  const draft = audit?.store.get<DiscoveryDraft>(audit.draftId);
  const planSubject = final ? null : packetPlanSubject(capacity?.bindings ?? {});
  const assessmentSubject = packetAssessmentSubject(context);
  requireCondition(sameAssessmentSubject(context,capacity?.bindings ?? {}),
    'discovery_assessment_subject_invalid', 'Capacity must bind the complete assessment packet and baseline');
  if (assessmentSubject) {
    requireCondition(audit && draft && audit.questionId && audit.purpose === 'assessor' && capacity?.purpose === 'assessor'
      && !planSubject, 'discovery_assessment_subject_invalid', 'An attempts packet needs its assessor admission');
    const basis = audit.store.get<Question>(audit.questionId);
    requireCondition(basis, 'discovery_assessment_subject_invalid', 'The assessment Question is missing');
    proveAssessmentTransportSubject(audit.store,context,environment.projectId,reference(basis));
    prompt = assessmentTransportPrompt(prompt,assessmentRolePrompt(''),assessmentSubject);
  }
  // DR3a3-S2: the packer and its proof carry one exact plan subject for every
  // role of a v7 plan-question — analyst, reading planner, synthesis and
  // consolidation — each declared consistently; no other role carries one.
  // The paid admission of the roles not yet connected stays closed in researchCall.
  if (planSubject) {
    requireCondition(['analyst', 'reading-planner', 'synthesis', 'consolidation'].includes(capacity?.purpose),
      'research_v7_mode_unavailable', 'Only the roles of a v7 plan-question carry a plan subject');
    requireCondition(planSubjectRole(capacity?.purpose, audit?.purpose, context), 'research_capacity_invalid',
      'The packet role differs from the role its saved result admission declares');
  }
  requireCondition(!planSubject || audit?.questionId && draft, 'research_plan_subject_invalid',
    'A plan subject requires the common saved-question packet');
  // 4T.3: the variant subject travels on its own transport branch of the common packer (4T.2-T).
  const variantSubject = packetVariantSubject(context);
  // 5.3: the deep step carries one exact saved preparation on the analyst plan-subject branch; the
  // saved capacity must bind the same Ref, and the packer proves the record through the shared 5.2 admission.
  const deepPreparation = packetDeepPreparation(context);
  if (deepPreparation && capacity !== undefined) requireCondition(canonical(packetDeepPreparation(capacity.bindings ?? {})) === canonical(deepPreparation),
    'research_deep_subject_invalid', 'The saved capacity must bind its exact deep preparation');
  const managedDossier=dossierSessionTransport(context);
  const packetState = (!dossier || managedDossier) && audit?.questionId && draft ? continuationState(audit.store, environment.projectId, audit.draftId,
    audit.questionId, audit.purpose, role.actor, planSubject, assessmentSubject, variantSubject, deepPreparation,
      managedDossier?{subject:dossier!.packet.subject,session:managedDossier.session.id}:undefined,
      final ? (context as any).finalContinuation : undefined, (context as any)?.interpretationExecution?.id) : null;
  const consolidating = (context as any)?.dispatchMode === 'consolidation';
  const controls = (context as any)?.contextControls;
  const finalizing = !consolidating && controls?.mode === 'finalization';
  const finalInstruction = planSubject ? V7_FINAL_SYNTHESIS_INSTRUCTION : FINAL_SYNTHESIS_INSTRUCTION;
  const envelope = { protocol: "omg-agent/v1", requestId, mode: "research", model: role.model,
    effort: role.effort, ...(role.speed ? { speed: role.speed } : {}), prompt: consolidating ? ((context as any)?.consolidation?.tightening ? TIGHTENING_INSTRUCTION : '') + CONSOLIDATION_INSTRUCTION : finalizing ? finalInstruction : packetState && !packetState.initial && !dossier ? continuationPrompt(audit!.purpose, prompt) + (audit!.purpose === 'analyst' && !planSubject ? COMPACT_CHECKPOINT_INSTRUCTION : '') : prompt };
  const packingContext = capacity === undefined ? context : { ...context as Record<string, unknown>, resultCapacity: capacity };
  const requestLimit = requestLimitChars === undefined
    ? (capacity === undefined ? audit?.pilot?.value.maxRequestChars ?? DEFAULT_RESEARCH_REQUEST_CHARS : capacity.envelopeLimitChars)
    : Math.min(requestLimitChars, audit?.pilot?.value.maxRequestChars ?? requestLimitChars);
  const outputLimit = researchResponseOutputLimit(audit?.pilot?.value.physicalLimits?.maxReplyChars ?? null);
  const overhead = JSON.stringify(outputLimit).length + 32 + Math.max(JSON.stringify({ ...envelope, subject: {} }).length,
    controls && !consolidating ? JSON.stringify({...envelope,prompt:finalInstruction,subject:{}}).length : 0) + (packetState ? 4000 : 0);
  const subjectFor = (limit: number) => {
    const packed = final ? final.pack(limit) : dossier ? dossier.pack(audit!.draftId, audit!.questionId!, packingContext, limit,
      { common:true, purpose:audit!.purpose }) : packetState ? workingContext(audit!.store, environment.projectId, audit!.draftId, audit!.questionId!, packingContext,
      limit, { common: true, purpose: audit!.purpose, ...(planSubject?{subject:planSubject}:{}), ...(assessmentSubject?{assessmentSubject}:{}),
        ...(variantSubject?{variantSubject,actor:role.actor}:{}), ...(deepPreparation?{deepPreparation}:{}), continuation: !packetState.initial,
        ...(packetState.latest ? { previous: packetState.latest } : {}),
        ...(audit!.pilot ? { contextChars: audit!.pilot.value.maxRequestChars } : {}),
        ...(audit!.pilot ? { extractedChars: audit!.pilot.value.maxRequestChars } : {}),
        ...(audit!.contextContract ? { contextContract: audit!.contextContract } : {}) })
      : packingContext && typeof packingContext === 'object' && !Array.isArray(packingContext) ? { ...packingContext } : packingContext;
    if (packetState) (packed as any).continuation = continuationMetadata(packetState, (packed as any).working.archive,
      final?.view ?? audit!.store, final?.staged().records ?? dossier?.staged().records);
    if (packed && typeof packed === 'object') (packed as Record<string, unknown>).responseOutputLimit = outputLimit;
    return packed;
  };
  let subjectLimit = requestLimit - overhead;
  let subject = subjectFor(subjectLimit);
  const physicalLimit = Math.min(requestLimit, audit?.pilot?.value.physicalLimits?.maxRequestChars ?? requestLimit);
  if (!consolidating && (subject as any)?.contextControls?.mode === 'finalization') envelope.prompt = finalInstruction;
  const canonicalWire = JSON.stringify({ ...envelope, subject });
  let input = canonicalWire;
  if (requestContract === REQUEST_MANIFEST_CONTRACT) {
    requireCondition(partitionResearchWire(envelope, subject).join('') === canonicalWire,
      'request_manifest_invalid', 'The wire manifest parts must match the canonical envelope');
  }
  // Keep RD2b's measured transport adjustment in the single real builder used
  // by both preflight and dispatch; the result marker is already in subject.
  for (let attempt = 0; (packetState || dossier) && input.length > physicalLimit && attempt < 4; attempt += 1) {
    subjectLimit -= input.length - physicalLimit + 128;
    subject = subjectFor(subjectLimit);
    if (!consolidating && (subject as any)?.contextControls?.mode === 'finalization') envelope.prompt = finalInstruction;
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

/** 4T.4 (codex-worker №11290): the exact saved intent of a managed variant call — its own kind, exactly this subject, its
 * single step of its owner session — and that owner: the exact variant execution session naming this project, draft,
 * Question, purpose, actor and subject. Read raw by the exact Ref, before any other reader of the intent. */
function requireVariantIntent(store: Store, ref: Ref, projectId: string, draftId: string, questionId: string | undefined,
  purpose: string, actor: string, variant: VariantSubject): void {
  const fail = (condition: unknown, message: string) => requireCondition(condition, 'discovery_variant_subject_invalid', message);
  const intent = isRef(ref) ? store.get<Record<string, any>>(ref.id, ref.revision) : null;
  fail(intent?.kind === 'research-consumer-intent' && intent.hash === ref.hash && intent.hash === hashJson(intent.value),
    'A managed variant call needs its exact saved intent');
  const value = intent!.value;
  fail(value.kind === purpose && value.projectId === projectId && isRef(value.owner) && isRef(value.draft) && isRef(value.question)
    && value.draft.id === draftId && value.question.id === questionId,
    'Only a variant intent of the same kind, project, draft and Question admits a variant call');
  fail(canonical(value.cursor?.variantSubject ?? null) === canonical(variant) && value.cursor?.sessionId === value.owner.id
    && value.cursor?.offset === 0, 'The intent carries exactly this subject at the single step of its owner session');
  const owner = store.get<Record<string, unknown>>(value.owner.id, value.owner.revision);
  fail(owner?.kind === VARIANT_SESSION_KIND && owner.hash === value.owner.hash, 'The intent is owned by an exact variant execution session');
  const session = decodeVariantExecutionSession(owner!.value);
  fail(session.projectId === projectId && session.purpose === purpose && session.actor === actor
    && canonical(session.variantSubject) === canonical(variant)
    && canonical(session.draft) === canonical(value.draft) && canonical(session.question) === canonical(value.question),
    'The owner session names another project, draft, Question, purpose, actor or subject');
}

/** 4T.3: a variant generation answer — new or replayed — leaves the transport only in its closed form. The paid call is
 * saved before the check, so an off-form answer is a typed refusal on every reading and never a second payment. */
export async function researchCall(role: RoleBinding, environment: Environment, prompt: string, context: unknown, signal?: AbortSignal,
  audit?: ResearchCallAudit): Promise<unknown> {
  const purpose = audit?.purpose;
  const finalInput = recordValue(context) && Object.hasOwn(context, 'finalContinuation')
    || purpose === 'discovery-final' || purpose === 'discovery-final-assessment' || purpose === 'discovery-condition-evidence';
  if (finalInput) {
    // Capture caller-owned data once, before proof can yield or callbacks run.
    // The Store, AbortSignal and callbacks remain live capabilities.
    try {
      const data = <T>(value: T): T => JSON.parse(canonical(value)) as T;
      role = data(role);
      environment = data(environment);
      context = data(context);
      if (audit) {
        const { store, draftId, questionId, pilot, session, onContext, application,
          prepareCall, finalPending, finalAssessmentPending, conditionEvidencePending, consumerIntent, consumerDispatchGuards, previewIntent,
          requestContract, contextContract } = audit;
        audit = { store, draftId, purpose: purpose!,
          ...(questionId === undefined ? {} : { questionId }),
          ...(pilot === undefined ? {} : { pilot: data(pilot) }),
          ...(session === undefined ? {} : { session: data(session) }),
          ...(onContext === undefined ? {} : { onContext }),
          ...(application === undefined ? {} : { application: data(application) }),
          ...(prepareCall === undefined ? {} : { prepareCall }),
          ...(finalPending === undefined ? {} : { finalPending: data(finalPending) }),
          ...(finalAssessmentPending === undefined ? {} : { finalAssessmentPending: data(finalAssessmentPending) }),
          ...(conditionEvidencePending === undefined ? {} : { conditionEvidencePending: data(conditionEvidencePending) }),
          ...(consumerIntent === undefined ? {} : { consumerIntent: data(consumerIntent) }),
          ...(consumerDispatchGuards === undefined ? {} : { consumerDispatchGuards: data(consumerDispatchGuards) }),
          ...(previewIntent === undefined ? {} : { previewIntent: data(previewIntent) }),
          ...(requestContract === undefined ? {} : { requestContract }),
          ...(contextContract === undefined ? {} : { contextContract }) };
      }
    } catch {
      throw new EngineError('discovery_final_dispatch_unavailable', 'A final dispatch needs stable data inputs');
    }
  }
  const answer = await dispatchResearchCall(role, environment, prompt, context, signal, audit);
  if (audit?.purpose === 'variant-proposal' && packetVariantSubject(context)?.kind === 'proposal') decodeVariantGeneration(answer);
  else if (audit?.purpose === 'variant-decision' && audit.consumerIntent && packetVariantSubject(context)?.kind === 'decision') decodeVariantDecisionAnswer(answer);
  return answer;
}

async function dispatchResearchCall(role: RoleBinding, environment: Environment, prompt: string, context: unknown, signal?: AbortSignal,
  audit?: ResearchCallAudit): Promise<unknown> {
  recoveryDispatchBoundary();
  const finalMarker = recordValue(context) && Object.hasOwn(context, 'finalContinuation');
  requireCondition(!finalMarker || audit?.purpose === 'discovery-final' || audit?.purpose === 'discovery-final-assessment'
    || audit?.purpose === 'discovery-condition-evidence', 'discovery_final_dispatch_unavailable',
    'A final continuation cannot travel on another research branch');
  const dossier = requireDossierTransportContext(context, audit?.purpose === 'dossier-assessor');
  const capacityDossier = packetDossierSubject((context as any)?.resultCapacity?.bindings);
  requireCondition(!capacityDossier || dossier && dossierSessionTransport(context) && audit, 'discovery_dossier_dispatch_unavailable',
    'Dossier result admission cannot authorize a raw physical call');
  requireCondition(!dossier || dossierSessionTransport(context) && audit?.application && audit?.session, 'discovery_dossier_dispatch_unavailable',
    'Dossier transport preflight does not authorize a physical call before managed dossier session/application');
  requireCondition(!packetAssessmentSubject(context) || !audit?.consumerIntent,
    'discovery_assessment_subject_invalid', 'An analyst intent cannot authorize or replay an attempts assessment');
  const roleName = role.actor === environment.implementer.actor ? 'implementer'
    : role.actor === environment.reviewer.actor ? 'reviewer' : 'reader';
  role = resolveRoleMode(roleName, role, 'research');
  // 4T.3 (№11174 4T3-02): the variant branch and its purpose are told apart before EVERY early return — a paid consumer
  // intent, a paid assessment application and a paid variant replay alike. The checks are pure: a free replay of a
  // historical identity needs no head of today's mode or state.
  const interpretation = (context as any)?.interpretationExecution;
  if (interpretation !== undefined || audit?.purpose === 'frame-interpretation-request' || audit?.purpose === 'frame-interpretation-choice') {
    requireCondition(audit?.consumerIntent && isRef(interpretation), 'interpretation_execution_invalid',
      'Interpretations travel only through their exact managed execution');
    const own = readResearchConsumerIntent(audit.store, audit.consumerIntent);
    requireCondition(isInterpretationConsumer(own.value) && own.value.kind === audit.purpose
      && canonical(own.value.owner) === canonical(interpretation), 'interpretation_execution_invalid', 'Foreign interpretation dispatch');
    requireInterpretationConsumer(audit.store, own.value);
  }
  const contextVariant = packetVariantSubject(context);
  // 5.3: the deep step is its own analyst branch — no assessment reservation, no virtual producer, no variant mixing.
  const contextDeep = packetDeepPreparation(context);
  if (contextDeep) requireCondition(audit && !audit.previewIntent && !audit.application && !audit.prepareCall,
    'research_deep_subject_invalid', 'A deep call travels on its own analyst branch, without an assessment reservation');
  if (contextVariant || audit?.purpose === 'variant-proposal' || audit?.purpose === 'variant-decision') {
    requireCondition(audit && !audit.previewIntent && !audit.application && !audit.prepareCall,
      'discovery_variant_subject_invalid', 'A variant call travels on its own branch, without an assessment reservation');
    const variant = variantTransportSubject(audit.purpose, role.actor, contextVariant, null, null)!;
    requireVariantContext(context, variant);
    // 4T.4 (№11290): a managed variant call is admitted only by an intent of exactly its own kind, owned by the exact
    // execution session of this very identity; the saved session decides, not the caller's context. Any other intent
    // carrying a variant subject stays refused here, before every early return.
    if (audit.consumerIntent) requireVariantIntent(audit.store, audit.consumerIntent, environment.projectId, audit.draftId,
      audit.questionId, audit.purpose, role.actor, variant);
  }
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
      // New dispatch/replay classifies deep by immutable admission before any
      // packing side effect; a masked prepared head cannot enter broad transport.
      requireDeepConsumerBinding(audit.store, consumerIntent);
    }
    requireCondition(consumerIntent.value.projectId === environment.projectId && consumerIntent.value.draft.id === audit.draftId
      && consumerIntent.value.question.id === audit.questionId && canonical(consumerIntent.value.role) === canonical(role)
      && canonical(consumerIntent.value.dispatch) === canonical(environment)
      && canonical(consumerIntent.value.profile) === canonical(audit.pilot ? reference(audit.pilot) : null),
    'research_consumer_intent_invalid', 'The saved consumer operation differs from the selected role, project, question or environment');
    // The paid early-return door retains the immutable deep subject too.
    // Supplying or dropping a marker cannot replay another era's answer.
    const savedDeep = packetDeepPreparation(consumerIntent.value.cursor);
    requireCondition(canonical(savedDeep) === canonical(contextDeep), 'research_deep_subject_invalid',
      'The dispatch and saved intent must declare the same deep preparation before replay');
    if (savedDeep) {
      const saved = consumerIntentContext(audit.store, consumerIntent.value, consumerIntent.id);
      requireCondition(recordValue(context) && canonical(context.deepResearchContract ?? null) === canonical(saved.deepResearchContract ?? null),
        'research_deep_subject_invalid', 'Paid deep replay retains its saved execution contract');
      requireCondition(['deepPreparation', 'deepCell', 'deepScope'].every(key =>
        recordValue(context) && Object.hasOwn(context, key) && canonical(context[key]) === canonical(saved[key])),
        'research_deep_subject_invalid', 'Paid deep replay retains its complete saved cell and scope');
    }
    planSubject = planSubjectOf(consumerIntent.value.cursor);
    // DR3a3-S5: a plan subject travels only with the role its intent fixed — the
    // analyst and the reading planner by their own purpose, a synthesis or
    // consolidation step as the analyst call of exactly its own v3 session.
    // Any other consumer, purpose or session with a subject stays closed.
    const stepOfOwnV3Session = ['synthesis', 'consolidation'].includes(consumerIntent.value.kind)
      && audit.purpose === 'analyst' && isRef(audit.session) && audit.session.id === consumerIntent.value.owner.id
      && audit.session.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX);
    requireCondition(!planSubject || consumerIntent.value.kind === 'analyst' && audit.purpose === 'analyst'
      || consumerIntent.value.kind === 'reading-planner' && audit.purpose === 'reading-planner' || stepOfOwnV3Session,
      'research_v7_mode_unavailable', 'A plan subject travels only with its own connected v7 role');
    if (consumerIntent.value.state !== 'prepared' && !isResponseRecovery()) {
      if (consumerIntent.value.state === 'applied') throw new EngineError('research_consumer_intent_applied', 'The completed consumer operation must return its saved output');
      const paid = resumeResearchConsumerExecution(audit.store, environment.projectId, reference(consumerIntent));
      if (paid.kind !== 'response') throw new EngineError('research_consumer_execution_refused', 'The saved physical result did not contain a research answer');
      audit.onContext?.(paid.subject);
      return paid.payload;
    }
    if (consumerIntent.value.state === 'prepared') {
      const savedPrompt = consumerIntent.value.cursor.prompt ?? consumerIntent.value.cursor.instruction;
      // DRS1a2: the saved context by the intent's own contract (v2: its preparation).
      requireCondition(typeof savedPrompt === 'string' && canonical(savedPrompt) === canonical(prompt)
        && canonical(consumerIntentContext(audit.store, consumerIntent.value, consumerIntent.id)) === canonical(context),
      'research_consumer_intent_invalid', 'The unsent intent must preserve its exact original prompt and consumer context');
    }
  }
  // Preserve the synchronous legacy admission boundary: yielding here lets a
  // competing legacy call reach its continuation barrier before its owner CAS.
  const assessment = audit?.purpose === 'discovery-condition-evidence'
    ? await conditionEvidenceReservation(audit, role, environment, prompt, context)
    : audit?.purpose === 'discovery-final-assessment'
    ? await finalAssessmentReservation(audit, role, environment, prompt, context)
    : finalMarker || audit?.purpose === 'discovery-final'
    ? await finalReservation(audit, role, environment, prompt, context)
    : dossier || dossierSessionTransport(context) || audit?.purpose==='dossier-assessor'
      ? await dossierAssessmentReservation(audit,role,environment,context)
      : assessmentReservation(audit,role,environment,context);
  const assessmentSubject = packetAssessmentSubject(context);
  requireCondition(!assessmentSubject || assessment?.kind === 'application' && !consumerIntent,
    'discovery_assessment_subject_invalid', 'Attempts assessment dispatch needs its exact saved application');
  if (assessmentSubject && assessment?.kind === 'application') {
    requireCondition(prompt === assessment.application.value.prompt || prompt === assessmentRolePrompt(assessment.application.value.prompt),
      'discovery_assessment_subject_invalid', 'The assessment cannot substitute another prepared prompt');
    const paid = replayAssessmentApplication(audit!.store,assessment.session,assessment.application);
    if (paid) { audit?.onContext?.(paid.subject); return paid.payload; }
  }
  const requestContract = audit?.requestContract ?? (assessmentSubject ? REQUEST_MANIFEST_CONTRACT : undefined);
  if (requestContract !== undefined) {
    requireCondition(
      requestContract === REQUEST_MANIFEST_CONTRACT,
      'request_contract_invalid',
      `Unsupported or unknown request contract: ${String(requestContract)}`
    );
    requireCondition(
      consumerIntent !== null && (consumerIntent.value.kind === 'analyst' || planSubject !== null)
        || assessmentSubject !== null && assessment?.kind === 'application',
      'request_contract_unsupported',
      'The wire manifest requires a managed analyst or an exact assessment application'
    );
  }
  const useWireManifest = requestContract === REQUEST_MANIFEST_CONTRACT;
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
    // DR3a3-S5: on a v7 draft the planner, synthesis and consolidation roles are
    // admitted only through their proven subject intent (checked above); an
    // unmanaged or subject-less call of these roles stays closed.
    const plannerOrSynthesis = ['reading-planner','synthesis','consolidation'].includes(consumerIntent?.value.kind ?? audit!.purpose)
      || Boolean((context as any)?.synthesisSession) || ['planning','consolidation'].includes((context as any)?.dispatchMode);
    requireCondition(!plannerOrSynthesis || consumerIntent !== null && planSubject !== null,
      'research_v7_mode_unavailable', 'The v7 planner and synthesis roles need their proven subject intent');
    const question = audit!.questionId ? audit!.store.get<Question>(audit!.questionId) : null;
    requireCondition(!(audit!.purpose === 'analyst' && question?.value.spec.field === 'plan' && question.value.status === 'answered') || planSubject,
      'research_plan_subject_invalid', 'An accepted plan needs its exact saved plan-question subject');
  }
  const policy = audit ? phasePolicy(audit.store, environment.projectId) : null;
  if (audit && draft?.value.stage === "om-g2") {
    const phase = draft.value.consumer !== "compilation" && draft.value.level === "R2" ? "L3" : draft.value.level;
    assertPilotBoundary(audit.store, environment.projectId, phase);
  }
  requireCondition(!draft || Boolean(audit?.questionId), "continuation_question_missing", "A saved research draft cannot bypass the common packer by omitting its question");
  // 4T.3: a variant call travels on its own branch — no consumer intent, assessment or plan subject; it creates no
  // attempt, progress or assessor. Its paid answer of exactly this saved identity returns before packing or payment.
  const variantSubject = packetVariantSubject(context);
  if (variantSubject) {
    requireCondition(audit && draft && audit.questionId && (!consumerIntent || consumerIntent.value.kind as string === audit.purpose)
      && !assessment && !assessmentSubject && !planSubject,
      'discovery_variant_subject_invalid', 'A variant call needs its saved draft and Question, without another intent, assessment or plan subject');
    // The managed and the direct path of one identity never mix: a managed send never stands beside a direct call of this
    // identity, and the direct replay never returns or pays beside a managed one (replayVariantResponse).
    if (consumerIntent) requireCondition(!variantIdentityCalls(audit.store, environment.projectId, audit.draftId, audit.questionId,
      audit.purpose, role.actor, variantSubject).map(call => variantCallManaged(audit.store, call)).includes(false),
    'discovery_variant_managed', 'This variant identity already has a direct call; a managed send would pay it twice');
    else {
      const paid = replayVariantResponse(audit.store, environment.projectId, audit.draftId, audit.questionId, audit.purpose,
        role.actor, variantSubject);
      if (paid) { audit.onContext?.(paid.subject); return paid.research; }
      // New v7 decisions use the managed door. An original paid transport return keeps its own historical contract.
      requireCondition(variantSubject.kind !== 'decision' || !isDiscoveryV7Draft(draft.value), 'discovery_variant_managed',
        'A model decision is bought only by its managed execution, which proves its set, mode and selection');
    }
  }
  const requestId = randomUUID();
  const callId = assessment?.kind === 'condition-evidence' ? `model-call:condition-evidence:v1:${hashJson(audit!.application)}`
    : assessment?.kind === 'final-assessment' ? `model-call:final-assessment:v1:${hashJson(audit!.application)}`
    : assessment?.kind === 'final' ? `model-call:final:v1:${hashJson(audit!.application)}`
    : consumerIntent ? `model-call:consumer:v1:${requestId}` : `model-call:${requestId}`;
  const capacity = consumerIntent?.value.cursor.resultCapacity
    ?? (assessment?.kind === 'application' || assessment?.kind === 'dossier' || assessment?.kind === 'final' || assessment?.kind === 'final-assessment'
      || assessment?.kind === 'condition-evidence'
      ? assessment.application.value.context.resultCapacity : undefined);
  // G5a (№6218): the saved admission is trusted — its capacity was computed and
  // proved once when the producer wrote the prepared revision. The actual prompt
  // is still compared to that saved declaration below; nothing is recomputed.
  if (consumerIntent?.value.cursor.resultCapacityContract !== undefined)
    requireCondition(consumerIntent.value.cursor.resultCapacityContract === RESULT_CAPACITY
      && consumerIntent.value.cursor.resultCapacity !== undefined,
      'research_capacity_invalid', 'The saved consumer admission lost its declared capacity');
  requireCondition(assessment?.kind === 'final' || assessment?.kind === 'final-assessment' || assessment?.kind === 'condition-evidence'
    || sameSubject(packetPlanSubject(capacity?.bindings ?? {}),planSubject),
    'research_plan_subject_invalid', 'The packet binding must equal the saved consumer subject');
  requireCondition(sameAssessmentSubject(context, capacity?.bindings ?? {}),
    'discovery_assessment_subject_invalid', 'The saved capacity must preserve its assessment subject');
  // 5.3: the deep dispatch is admitted only by the shared 5.2 current-proof of its saved preparation — the
  // carrier never substitutes its own guard list; the intent must carry exactly this preparation, and the
  // existing plan subject must equal the proven cell subject.
  let deepAdmission: ReturnType<typeof requireCurrentDeepPreparation> | null = null;
  if (contextDeep) {
    requireCondition(planSubject !== null && !contextVariant && !assessmentSubject && audit?.purpose === 'analyst'
      && consumerIntent?.value.kind === 'analyst',
      'research_deep_subject_invalid', 'A deep dispatch needs its own analyst intent and plan subject, without a variant or assessment subject');
    requireCondition(canonical(packetDeepPreparation(consumerIntentContext(audit!.store, consumerIntent!.value, consumerIntent!.id))) === canonical(contextDeep),
      'research_deep_subject_invalid', 'The saved intent must carry the exact deep preparation of this dispatch');
    deepAdmission = requireCurrentDeepPreparation(audit!.store, environment.projectId, contextDeep);
    requireCondition(sameSubject(planSubject, deepAdmission.preparation.value.cell.subject),
      'research_deep_subject_invalid', 'The deep dispatch plan subject must equal the proven preparation cell subject');
  }
  // DRS1a2: the archive contract follows the saved intent only — a v2 analyst
  // call packs the compact archive; every other call keeps the whole body.
  let packAudit = audit;
  if (audit) {
    const { contextContract: _caller, ...rest } = audit;
    packAudit = consumerIntent?.value.contract === CONSUMER_INTENT_V2 ? { ...rest, contextContract: ARCHIVE_PARTS_CONTRACT } : rest;
  }
  const dossierEnvelope=dossier
    ? await prepareDossierResearchEnvelope(role,environment,prompt,context,packAudit!,capacity,requestId,true) : null;
  const finalPacker = assessment?.kind === 'final' ? prepareDiscoveryFinalContextPacker(audit!.store, assessment.admission)
    : assessment?.kind === 'final-assessment' ? prepareDiscoveryFinalAssessmentContextPacker(audit!.store, assessment.admission)
    : assessment?.kind === 'condition-evidence' ? prepareConditionEvidenceContextPacker(audit!.store, assessment.admission) : null;
  const { packetState, subject, envelope, input, requestLimit } = dossierEnvelope
    ?? (finalPacker ? buildResearchEnvelope(role, environment, prompt, context, packAudit, capacity, requestId,
      requestContract, undefined, assessment!.kind === 'final' || assessment!.kind === 'final-assessment' || assessment!.kind === 'condition-evidence'
        ? assessment!.admission.prepared.value.input.limitChars : undefined,
      finalPacker)
      : prepareResearchEnvelope(role, environment,prompt,context,packAudit,capacity,requestId,requestContract));
  if (capacity !== undefined && assessment?.kind !== 'final' && assessment?.kind !== 'final-assessment' && assessment?.kind !== 'condition-evidence') requireCondition(researchCapacityProjection(capacity, audit?.store).prompt === envelope.prompt,
    'research_capacity_invalid', 'The actual role prompt differs from its predeclared result admission');
  if (audit?.onContext) audit.onContext(assessment?.kind === 'final' || assessment?.kind === 'final-assessment' || assessment?.kind === 'condition-evidence'
    ? structuredClone(subject as Record<string, any>) : subject as Record<string, any>);
  const recovered = operatorReplayedResponse(role, input, audit);
  if (recovered) { audit?.onContext?.(recovered.subject); return recovered.research; }
  if (assessment?.kind === 'replay-only') applicationAuditInvalid('The operator recovery did not consume its selected response');
  interceptResearchPreview(input,{limit:requestLimit,draft:audit?.draftId??'',question:audit?.questionId??'',purpose:audit?.purpose??''});
  requireInterpretationNewDispatch();
  // Budget admission is only for a NEW send: every paid-return path above is free.
  const originalDraft = audit && draft ? audit.store.get<DiscoveryDraft>(draft.id, 1) : null;
  const stageV7 = isDiscoveryV7Draft(draft?.value) || isDiscoveryV7Draft(originalDraft?.value);
  const stagePlan = stageV7 && audit && draft ? stageBudgetPlan(audit.store, draft) : null;
  let stageSegment: Revision<BudgetSegment> | null = null;
  let stageEstimate: CallEstimate | null = null;
  let stageRemaining = 0;
  // DR6: only the proven managed dossier admission (its exact session, application and subject, proved above by
  // proveDossierDispatchAdmission) spends the completion reserve. No caller field — purpose, role, actor,
  // finalization mode, context marker or answer form — selects the class; every other send stays research.
  const stageClass: 'research' | 'completion' = assessment?.kind === 'dossier' ? 'completion' : 'research';
  const stageAvailable = (segment: Revision<BudgetSegment>, usage: { measured: number; reserved: number }) =>
    segment.value.limit - (stageClass === 'completion' ? 0 : segment.value.completionReserve!) - usage.measured - usage.reserved;
  // `cause` keeps the shared reservation's own reason visible: a working group limit is not an exhausted stage.
  const stageFailure = (code: string, message: string, cause?: string): never => {
    throw new EngineError(code, message, { segment: stageSegment ? reference(stageSegment) : null,
      class: stageClass, remaining: stageRemaining, estimate: stageEstimate, ...(cause ? { cause } : {}) });
  };
  if (stagePlan && audit && draft) {
    requireCondition(isDiscoveryV7Draft(draft.value), 'discovery_draft_invalid', 'A v7 draft cannot lose its era');
    requireCondition(typeof audit.purpose === 'string' && audit.purpose.length > 0 && packetState !== null,
      'discovery_draft_invalid', 'A v7 send needs its saved question and purpose');
    stageSegment = 'saved' in stagePlan.target ? stagePlan.target.saved : {
      id: stagePlan.writes[0]!.id, kind: 'research-budget', revision: 1,
      value: stagePlan.target.creating, hash: hashJson(stagePlan.target.creating) };
    const usage = stagePlan.isNew ? { measured: 0, reserved: 0 } : budgetUsage(audit.store, stageSegment);
    stageRemaining = stageAvailable(stageSegment, usage);
    if (usage.measured > stageSegment.value.limit)
      stageFailure('discovery_budget_overrun', 'Actual stage usage forbids another paid send');
    try {
      try { stageEstimate=estimateCliCall(audit.store,environment.projectId,role,audit.purpose,input.length,
        packetState?.initial===false?'continuation':'initial'); }
      catch(error) {
        if((!consumerIntent || !isInterpretationConsumer(consumerIntent.value)) && (assessment?.kind!=='dossier' && assessment?.kind!=='final' && assessment?.kind!=='final-assessment' && assessment?.kind!=='condition-evidence')
          || !(error instanceof EngineError) || error.code!=='budget_estimate_missing') throw error;
        stageEstimate=estimateCliCall(audit.store,environment.projectId,role,consumerIntent && isInterpretationConsumer(consumerIntent.value) ? 'analyst' : 'assessor',input.length,
          packetState?.initial===false?'continuation':'initial');
        stageEstimate={...stageEstimate,explanation:
          (consumerIntent && isInterpretationConsumer(consumerIntent.value) ? 'Managed interpretation bootstrap from measured analyst calls. '
            : `Managed ${assessment?.kind === 'final' ? 'final' : assessment?.kind === 'final-assessment' ? 'final assessment' : assessment?.kind === 'condition-evidence' ? 'condition evidence' : 'dossier'} bootstrap from measured assessor calls. `)
          + stageEstimate.explanation};
      }
    }
    catch (error) {
      if (error instanceof EngineError && error.code === 'budget_estimate_missing') stageFailure(error.code, error.message);
      throw error;
    }
  }
  const control = researchDispatchControl(audit?.store, environment.projectId, !!draft && earlyResearchStage(draft.value.stage));
  try { control?.admit(); }
  catch (error) {
    if (error instanceof RunControlLost) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
    throw error;
  }
  const progressContext = (subject as any)?.contextControls ? {...context as Record<string,any>,contextControls:(subject as any).contextControls} : context;
  const progress=packetState&&!dossier&&!finalPacker?(contextDeep?deepInvocationProgress(audit!.store,contextDeep,audit!.purpose,role.actor,reference(consumerIntent!))
    :invocationProgress(audit!.store,audit!.questionId!,audit!.purpose,progressContext as Record<string,any>,planSubject,role.actor,assessmentSubject,variantSubject)):null;
  const reservation: { writes: Write[]; guards: TransactionGuard[] } = !stagePlan && audit?.pilot
    ? pilotDispatch(audit.store, audit.pilot, callId, input.length) : { writes: [], guards: [] };
  if(dossierEnvelope) {
    reservation.writes.push(...dossierEnvelope.archives.writes);
    reservation.guards.push(...dossierEnvelope.archives.guards);
  }
  if (finalPacker) {
    reservation.writes.push(...finalPacker.staged().writes);
    reservation.guards.push(...finalPacker.staged().guards);
  }
  if (assessment?.kind === 'final' || assessment?.kind === 'final-assessment' || assessment?.kind === 'condition-evidence') {
    reservation.writes.push(...assessment.writes);
    reservation.guards.push(...assessment.guards);
  }
  if (stagePlan && stageEstimate && audit && draft) {
    // The one closing kind is the proven dossier admission (stageClass above); the shared reservation applies it.
    try {
      const reserved = reserveResearchCall(audit.store, stagePlan.target, callId,
        [DISCOVERY_V7_STAGE_BUDGET_KEY], stageEstimate, stageClass);
      reservation.writes.push(...reserved.writes);
      reservation.guards.push(...reserved.guards, reference(draft), ...draft.value.inputs);
    } catch (error) {
      if (error instanceof EngineError && ['budget_segment_exhausted', 'budget_question_limit', 'budget_owner_group_limit'].includes(error.code)) {
        const latest = stagePlan.isNew ? { measured: 0, reserved: 0 } : budgetUsage(audit.store, stageSegment!);
        stageRemaining = stageAvailable(stageSegment!, latest);
        stageFailure(latest.measured > stageSegment!.value.limit ? 'discovery_budget_overrun' : 'discovery_budget_reserve', error.message, error.code);
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
    const questionCounterId=`question-dispatch:${hashJson(finalPacker ? [assessment?.kind === 'final-assessment' ? 'discovery-final-assessment/v1' : assessment?.kind === 'condition-evidence' ? 'discovery-condition-evidence/v1' : 'discovery-final/v1',environment.projectId,(context as any).finalContinuation,role.actor] : dossier ? ['dossier/v1',environment.projectId,dossier,dossierSessionTransport(context)!.session.id] : variantSubject ? ['variant/v1',environment.projectId,audit!.draftId,audit!.questionId!,variantSubject,audit!.purpose,role.actor] : assessmentSubject ? [environment.projectId,assessmentSubject] : planSubject ? (contextDeep ? [environment.projectId,planSubject,'deep/v1',contextDeep] : [environment.projectId,planSubject]) : audit!.questionId!)}`;
    const questionCounter=audit!.store.get<{projectId:string;question:string;serial:number;subject?:V7PlanSubject;assessmentKey?:string}>(questionCounterId);
    requireCondition(!questionCounter||(questionCounter.kind==='question-dispatch'&&questionCounter.value.projectId===environment.projectId
      &&questionCounter.value.question===audit!.questionId&&(questionCounter.value.assessmentKey??null)===assessmentSubjectKey(assessmentSubject)&&sameSubject(packetPlanSubject(questionCounter.value),planSubject)
      &&canonical(packetVariantSubject(questionCounter.value))===canonical(variantSubject)
      &&canonical(packetDeepPreparation(questionCounter.value))===canonical(contextDeep)&&Number.isSafeInteger(questionCounter.value.serial)&&questionCounter.value.serial>=0),
    'research_dispatch_invalid','Invalid question dispatch counter');
    reservation.writes.push({id:questionCounterId,kind:'question-dispatch',expected:questionCounter?.revision??0,
      value:{projectId:environment.projectId,question:audit!.questionId,...(assessmentSubject?{assessmentKey:assessmentSubjectKey(assessmentSubject)}:{}),...(planSubject?{subject:planSubject}:{}),...(variantSubject?{variantSubject}:{}),...(contextDeep?{deepPreparation:contextDeep}:{}),serial:(questionCounter?.value.serial??0)+1}});
    if(questionCounter) reservation.guards.push(reference(questionCounter));
    if(audit!.session && !(assessment?.kind === 'final' && audit!.finalPending?.session)
      && !(assessment?.kind === 'final-assessment' && audit!.finalAssessmentPending?.session)
      && !(assessment?.kind === 'condition-evidence' && audit!.conditionEvidencePending?.session)) reservation.guards.push(audit!.session);
    const dispatch = continuationDispatch(packetState, callId);
    reservation.writes.push(...dispatch.writes); reservation.guards.push(...dispatch.guards,...(progress?.guards??[]),
      ...(deepAdmission?deepAdmission.guards:[]));
    if (!useWireManifest) {
      reservation.writes.push({id:`model-request:${requestId}`,kind:"model-request",expected:0,
        value:{projectId:environment.projectId,draftId:audit!.draftId,text:input}});
    }
  }
  const permission = audit && draft && isDiscoveryV7Draft(draft.value)
    ? producerDispatchPolicy(audit.store, environment.projectId, audit.draftId) : null;
  const ownership = audit ? physicalClaim() : null;
  const callWrite: Write = { id: callId, kind: "model-call", expected: 0,
    value: { ...(permission ? { producerPolicy: permission } : {}), projectId: environment.projectId, draftId: audit?.draftId ?? "", purpose: audit?.purpose ?? "", requestId,
      ...(stageSegment && stageEstimate ? { budget: { segment: reference(stageSegment),
        groups: [DISCOVERY_V7_STAGE_BUDGET_KEY], estimate: stageEstimate } } : {}),
      ...(progress?{progressKey:progress.key}:{}),
      ...(assessmentSubject?{assessmentKey:assessmentSubjectKey(assessmentSubject)}:{}),
      ...(variantSubject?{variantSubject}:{}),
      ...(interpretation ? {interpretationExecution:interpretation.id} : {}),
      ...(contextDeep?{deepPreparation:contextDeep}:{}),
      ...(dossier?{dossierSubject:dossier,managedDossier:dossierSessionTransport(context)}:{}),
      ...(ownership ?? {}),
      ...(assessment?.kind === 'final-assessment' ? { finalAssessmentApplication: audit!.application,
        finalContinuation: (context as any).finalContinuation }
        : assessment?.kind === 'condition-evidence' ? { conditionEvidenceApplication: audit!.application,
        finalContinuation: (context as any).finalContinuation }
        : assessment?.kind === 'final' ? { finalApplication: audit!.application,
        finalContinuation: (context as any).finalContinuation } : audit?.application ? { assessmentApplication: audit.application } : {}),
      ...(consumerIntent ? { consumerIntent: reference(consumerIntent) } : {}),
      profile: audit?.pilot ? reference(audit.pilot) : null,
      questionId: planSubject?.planQuestionId ?? audit?.questionId ?? null,
      ...(planSubject ? { planAnswer:planSubject.planAnswer } : {}),
      startedAt: Date.now(), finishedAt: null, status: "running", requested: role,
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
      [...(audit ? producerDispatchGuards(audit.store, environment.projectId, permission) : []), ...reservation.guards, ...(application?.guards ?? []), ...(consumerReservation?.guards ?? []), ...(audit?.consumerDispatchGuards ?? [])])[0]! : null;
  } catch (error) {
    if (error instanceof RunControlLost) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at);
    throw error;
  }
  return executeResearchPhysicalCall(role,environment,input,requestId,call,signal,audit,control,stageSegment,consumerIntent);
}

/** One physical implementation for a fresh reservation and an original owner's exact claimed dossier. */
async function executeResearchPhysicalCall(role:RoleBinding, environment:Environment, input:string, requestId:string,
  call:Revision<ModelCall>|null, signal:AbortSignal|undefined, audit:ResearchCallAudit|undefined,
  control:RunControlGate|null, stageSegment:Revision<BudgetSegment>|null,
  consumerIntent:ReturnType<typeof readResearchConsumerIntent>|null) {
  const claimed = call ? reference(call) : null;
  const permission = (call?.value as (ModelCall & {producerPolicy?: Ref}) | undefined)?.producerPolicy;
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
    researchControlScope(audit?.store, environment.projectId);
    control?.assertCurrent();
    if (audit) producerDispatchGuards(audit.store, environment.projectId, permission);
    const result = await runProcess(role.command, environment.workspace, input, environment.timeoutMs, dispatchSignal, true, pid=>{
      spawnedPid = pid;
      try {
        researchControlScope(audit?.store, environment.projectId);
        if (call && audit) {
          let writer = control?.view() ?? audit.store;
          if (audit.purpose === 'dossier-assessor' || audit.purpose === 'discovery-final' || audit.purpose === 'discovery-final-assessment'
            || audit.purpose === 'discovery-condition-evidence') {
            const at = audit.application;
            requireCondition(isRef(at), 'discovery_final_dispatch_unavailable',
              'The final dispatch needs its exact saved application');
            const application = audit.store.get<Record<string, any>>(at.id, at.revision);
            const applicationKind = audit.purpose === 'dossier-assessor' ? 'assessment-application'
              : audit.purpose === 'discovery-final-assessment' ? 'discovery-final-assessment-application'
              : audit.purpose === 'discovery-condition-evidence' ? 'discovery-condition-evidence-application' : 'discovery-final-application';
            requireCondition(application?.kind === applicationKind && recordValue(application.value)
              && canonical(reference(application)) === canonical(at) && hashJson(application.value) === application.hash
              && Array.isArray(application.value.guards), 'discovery_final_dispatch_unavailable',
            'The final dispatch lost its exact saved application or guards');
            const dossier = audit.purpose === 'dossier-assessor' ? readDossierReservationAt(audit.store, at) : null;
            const guards = uniqueTransactionGuards([reference(dossier?dossier.running:application), ...(dossier?dossier.guards:application.value.guards)]);
            const controlled = writer;
            // The admission may move after reservation or a resumed-claim
            // check. Recheck its saved guards in the authorization CAS, before
            // runProcess can transfer any request bytes to the provider.
            writer = storeView(controlled, { write: (writes, own) =>
              controlled.writeMany(writes, uniqueTransactionGuards([...own, ...guards])) });
          }
          if (permission) {
            const policyWriter = writer;
            writer = storeView(policyWriter, {write: (writes, guards) => {
              try { return policyWriter.writeMany(writes,
                [...guards, ...producerDispatchGuards(audit.store, environment.projectId, permission)]); }
              catch (error) { producerDispatchGuards(audit.store, environment.projectId, permission); throw error; }
            }});
          }
          call = authorizeModelDispatch(writer, reference(call), pid);
        }
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
      && ['run_stopped', 'run_control_changed', 'producer_policy_changed'].includes(failure.code);
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
            ...(audit.application && audit.purpose === 'discovery-condition-evidence' && physicalResult ? { conditionEvidenceExecution: {
              contract: 'discovery-condition-evidence-execution-receipt/v1', call: claimed, dispatch: reference(call),
              process: { exitCode: physicalResult.exitCode, signal: physicalResult.signal, stderr: physicalResult.stderr } } }
              : audit.application && audit.purpose === 'discovery-final-assessment' && physicalResult ? { finalAssessmentExecution: {
              contract: 'discovery-final-assessment-execution-receipt/v1', call: claimed, dispatch: reference(call),
              process: { exitCode: physicalResult.exitCode, signal: physicalResult.signal, stderr: physicalResult.stderr } } }
              : audit.application && audit.purpose === 'discovery-final' && physicalResult ? { finalExecution: {
              contract: 'discovery-final-execution-receipt/v1', call: claimed, dispatch: reference(call),
              process: { exitCode: physicalResult.exitCode, signal: physicalResult.signal, stderr: physicalResult.stderr } } }
              : audit.application && physicalResult ? { assessmentExecution: { contract: 'assessment-execution/v1',
              call: claimed, dispatch: reference(call), process: { exitCode: physicalResult.exitCode,
                signal: physicalResult.signal, stderr: physicalResult.stderr } } } : {}) } };
        if (consumerIntent && physicalResult) (saved.value as Record<string, unknown>)['consumerExecution'] = {
          contract: 'research-consumer-execution/v1', call: claimed, dispatch: reference(call),
          process: { exitCode: physicalResult.exitCode, signal: physicalResult.signal, stderr: physicalResult.stderr } };
        responseWrites.push(saved);
        patch.response = { ...patch.response!, record: { id: saved.id, revision: 1, hash: hashJson(saved.value) } };
      }
      try {
        const terminal: ModelCall = { ...call.value, ...patch, finishedAt: Date.now() };
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
    }
  }
}

/** Resume only an exact un-authorized reservation of this still-live owner. A different process never inherits it. */
export async function resumeDossierResearchCall(store:Store,applicationRef:Ref,signal?:AbortSignal,admissionGuards:TransactionGuard[]=[]) {
  const additional=uniqueTransactionGuards(checkTransactionGuards(admissionGuards));
  recoveryDispatchBoundary();
  const admitted=await proveDossierDispatchAdmission(store,applicationRef);
  const reserved=readDossierReservationAt(store,applicationRef);
  requireCondition(additional.every(guard=>reserved.guards.some(saved=>canonical(saved)===canonical(guard))),
    'discovery_dossier_session_invalid','A claimed dossier cannot discard newly supplied admission grounds');
  requireCondition(transactionGuardsCurrent(store,reserved.guards),'input_stale',
    'The claimed dossier lost its saved current admission grounds');
  const app=reserved.running,claim=recordValue(app?.value)&&isRef(app.value.call)?store.get<ModelCall>(app.value.call.id,app.value.call.revision):null;
  requireCondition(app?.kind==='assessment-application' && recordValue(app.value) && hashJson(app.value)===app.hash && claim && recordValue(claim.value)
    && canonical(reference(claim))===canonical(app.value.call) && hashJson(claim.value as never)===claim.hash
    && store.get(claim.id) !== null && canonical(reference(store.get(claim.id)!))===canonical(reference(claim))
    && claim.value.status==='running' && executionOf(claim.value)?.phase==='claimed'
    && claim.value.ownerProcess?.pid===process.pid && claim.value.ownerProcess.started===processStart(process.pid)
    && canonical(executionOf(claim.value)!.owner)===canonical(claim.value.ownerProcess)
    && canonical(claim.value.requested)===canonical(admitted.role)
    && canonical(claim.value.profile??null)===canonical(admitted.session.value.profile)
    && canonical(claim.value.assessmentApplication)===canonical(applicationRef)
    && canonical((claim.value as any).managedDossier)===canonical(admitted.context.managedDossier)
    && canonical((claim.value as any).dossierSubject)===canonical(admitted.session.value.subject)
    && claim.value.projectId===admitted.session.value.projectId && claim.value.draftId===admitted.draft.id
    && claim.value.questionId===admitted.question.id && claim.value.purpose==='dossier-assessor',
    'discovery_dossier_session_invalid','Only the original live owner may resume its exact un-authorized dossier reservation');
  for(const witness of evaluateProcessStopWitnesses(store,claim.id))
    requireCondition(witness.state==='ended','model_call_process_uncertain','An unresolved spawned provider prevents a dossier retry');
  const ref=claim.value.request.record;
  const request=isRef(ref)?store.get<any>(ref.id,ref.revision):null;
  requireCondition(request?.kind==='model-request' && canonical(reference(request))===canonical(ref)
    && request.hash===hashJson(request.value) && request.value.projectId===claim.value.projectId
    && request.value.draftId===claim.value.draftId && typeof request.value.text==='string'
    && digest(request.value.text)===claim.value.request.hash && request.value.text.length===claim.value.request.chars
    && Buffer.byteLength(request.value.text)===claim.value.request.bytes && isRef(claim.value.packet?.archive),
    'response_recovery_wire_invalid','The dossier reservation lost its exact request and archive');
  const archive=await requireDossierTransportArchive(store,claim.value.projectId,claim.value.packet!.archive,admitted.session.value.subject);
  const body=readArchiveBody(store,store.get<any>(claim.value.packet!.archive.id,claim.value.packet!.archive.revision)!).body;
  requireCondition(canonical(body)===canonical(admitted.context),'discovery_dossier_session_invalid','The reserved archive changed its admitted body');
  let wire:any;try{wire=JSON.parse(request.value.text);}catch{throw new EngineError('response_recovery_wire_invalid','The saved dossier request must be complete JSON');}
  requireCondition(recordValue(wire) && wire.protocol==='omg-agent/v1' && wire.requestId===claim.value.requestId && wire.mode==='research'
    && wire.prompt===admitted.prompt && wire.model===admitted.role.model && wire.effort===admitted.role.effort
    && (wire.speed??'inherited')===(admitted.role.speed??'inherited')
    && canonical(wire.subject?.working?.archive)===canonical(claim.value.packet!.archive)
    && ['managedDossier','dossierSubject','resultCapacity','assessmentDelivery'].every(key=>canonical(wire.subject[key])===canonical(admitted.context[key]))
    && request.value.text.length<=admitted.context.resultCapacity.envelopeLimitChars
    && (!admitted.profile?.value.physicalLimits || request.value.text.length<=admitted.profile.value.physicalLimits.maxRequestChars)
    && canonical(wire.subject.responseOutputLimit)===canonical(researchCapacityProjection(admitted.context.resultCapacity,store).subject.responseOutputLimit)
    && archive,
    'response_recovery_wire_foreign','The saved dossier request no longer matches its exact admitted runtime or limits');
  requirePacketMaterialDelivery(wire.subject,claim.value.packet!.archive,(ref,pointer)=>{
    const row=store.get<any>(ref.id,ref.revision);
    requireCondition(row?.kind==='research-context' && canonical(reference(row))===canonical(ref)
      && hashJson(row.value)===row.hash && row.value.projectId===claim.value.projectId
      && canonical(row.value.draft)===canonical(admitted.session.value.binding.draft)
      && canonical(row.value.question)===canonical(admitted.session.value.binding.question),
      'context_reference_foreign','A reserved dossier page lost its exact research binding');
    return contextValue({body:readArchiveBody(store,row).body},pointer);
  });
  requireContextDelivery(admitted.context.contextWorkspace,wire.subject);
  requireInvocationAllowance();
  const control=researchDispatchControl(store,claim.value.projectId,earlyResearchStage(admitted.draft.value.stage));
  try{control?.admit();}catch(error){if(error instanceof RunControlLost)throw new EngineError(error.refusal.code,error.refusal.message,error.refusal.at);throw error;}
  const segmentRef=claim.value.budget?.segment;
  const segment=isRef(segmentRef)?store.get<BudgetSegment>(segmentRef.id,segmentRef.revision):null;
  requireCondition(!segmentRef || segment?.kind==='research-budget' && canonical(reference(segment))===canonical(segmentRef),
    'research_budget_invalid','The existing dossier reservation lost its budget segment');
  return executeResearchPhysicalCall(admitted.role,admitted.dispatch,request.value.text,claim.value.requestId,claim,signal,
    {store,draftId:admitted.draft.id,questionId:admitted.question.id,purpose:'dossier-assessor',session:reference(admitted.session),
      application:applicationRef,...(admitted.profile?{pilot:admitted.profile}:{})},control,segment,null);
}

/** A final reservation can be resumed only by its original still-live owner,
 * before authorization. An authorized or uncertain provider is never sent a
 * second request. */
export async function resumeDiscoveryFinalResearchCall(store: Store, applicationRef: Ref, signal?: AbortSignal) {
  return resumeFinalResearchCall(store, applicationRef, 'final', signal);
}
export async function resumeDiscoveryFinalAssessmentResearchCall(store: Store, applicationRef: Ref, signal?: AbortSignal) {
  return resumeFinalResearchCall(store, applicationRef, 'final-assessment', signal);
}
/** OMG-V7-B3: the evidence assessment resumes on its own claim exactly like the D7 assessment. */
export async function resumeConditionEvidenceResearchCall(store: Store, applicationRef: Ref, signal?: AbortSignal) {
  return resumeFinalResearchCall(store, applicationRef, 'condition-evidence', signal);
}
async function resumeFinalResearchCall(store: Store, applicationRef: Ref, kind: 'final' | 'final-assessment' | 'condition-evidence',
  signal?: AbortSignal) {
  const assessment = kind !== 'final';
  recoveryDispatchBoundary();
  let stableApplication: unknown;
  try { stableApplication = JSON.parse(canonical(applicationRef)); }
  catch { throw new EngineError('discovery_final_dispatch_unavailable', 'The final application needs a stable exact reference'); }
  requireCondition(isRef(stableApplication) && recordValue(stableApplication)
    && Object.keys(stableApplication).sort().join(',') === 'hash,id,revision',
  'discovery_final_dispatch_unavailable', 'The final application needs a stable exact reference');
  applicationRef = stableApplication;
  const admitted = kind === 'condition-evidence' ? await readConditionEvidenceDispatchAdmission(store, applicationRef)
    : assessment ? await readDiscoveryFinalAssessmentDispatchAdmission(store, applicationRef)
    : await readDiscoveryFinalDispatchAdmission(store, applicationRef);
  const purpose = kind === 'condition-evidence' ? 'discovery-condition-evidence' : assessment ? 'discovery-final-assessment' : 'discovery-final';
  const callId = `model-call:${kind}:v1:${hashJson(applicationRef)}`;
  const claimField = kind === 'condition-evidence' ? 'conditionEvidenceApplication' : assessment ? 'finalAssessmentApplication' : 'finalApplication';
  const claim = store.get<ModelCall>(callId, 1), head = store.get<ModelCall>(callId);
  requireCondition(claim?.kind === 'model-call' && recordValue(claim.value) && head && recordValue(head.value)
    && canonical(reference(head)) === canonical(reference(claim))
    && claim.hash === hashJson(claim.value as never) && claim.value.status === 'running'
    && executionOf(claim.value)?.phase === 'claimed' && claim.value.ownerProcess?.pid === process.pid
    && claim.value.ownerProcess.started === processStart(process.pid)
    && canonical(executionOf(claim.value)!.owner) === canonical(claim.value.ownerProcess)
    && canonical((claim.value as unknown as Record<string, unknown>)[claimField]) === canonical(applicationRef)
    && canonical((claim.value as unknown as Record<string, unknown>).finalContinuation) === canonical(admitted.context.finalContinuation)
    && canonical(claim.value.requested) === canonical(admitted.role)
    && canonical(claim.value.profile ?? null) === canonical(admitted.session.value.profile)
    && claim.value.projectId === admitted.session.value.projectId && claim.value.draftId === admitted.draft.id
    && claim.value.questionId === admitted.question.id && claim.value.purpose === purpose,
  'model_call_process_uncertain', 'Only the original live owner can resume an un-authorized final claim');
  for (const witness of evaluateProcessStopWitnesses(store, claim.id))
    requireCondition(witness.state === 'ended', 'model_call_process_uncertain', 'An unresolved provider prevents final retry');
  const requestRef = claim.value.request?.record, archiveRef = claim.value.packet?.archive;
  const request = isRef(requestRef) ? store.get<Record<string, any>>(requestRef.id, requestRef.revision) : null;
  const archive = isRef(archiveRef) ? store.get<Record<string, any>>(archiveRef.id, archiveRef.revision) : null;
  requireCondition(recordValue(claim.value.packet) && ['initial', 'continuation'].includes(claim.value.packet.kind)
    && request?.kind === 'model-request' && canonical(reference(request)) === canonical(requestRef)
    && hashJson(request.value) === request.hash && request.value.projectId === claim.value.projectId
    && request.value.draftId === claim.value.draftId && typeof request.value.text === 'string'
    && digest(request.value.text) === claim.value.request.hash && request.value.text.length === claim.value.request.chars
    && Buffer.byteLength(request.value.text) === claim.value.request.bytes
    && archive?.kind === 'research-context' && canonical(reference(archive)) === canonical(archiveRef)
    && canonical(readArchiveBody(store, archive).body) === canonical(admitted.context),
  'response_recovery_wire_invalid', 'The final claim lost its exact request or original archive');
  let wire: any;
  try { wire = JSON.parse(request.value.text); }
  catch { throw new EngineError('response_recovery_wire_invalid', 'The saved final request must be complete JSON'); }
  requireCondition(recordValue(wire) && wire.protocol === 'omg-agent/v1' && wire.requestId === claim.value.requestId
    && wire.mode === 'research' && wire.model === admitted.role.model && wire.effort === admitted.role.effort
    && (wire.speed ?? 'inherited') === (admitted.role.speed ?? 'inherited')
    && wire.prompt === (claim.value.packet!.kind === 'continuation'
      ? continuationPrompt(purpose, admitted.prompt) : admitted.prompt)
    && canonical(wire.subject?.working?.archive) === canonical(archiveRef)
    && canonical(wire.subject?.finalContinuation) === canonical(admitted.context.finalContinuation)
    && canonical(wire.subject?.continuation?.finalContinuation) === canonical(admitted.context.finalContinuation)
    && canonical(wire.subject?.subject) === canonical(admitted.session.value.subject)
    && canonical(wire.subject?.schema) === canonical(admitted.context.schema)
    && canonical(wire.subject?.resultCapacity) === canonical(admitted.context.resultCapacity)
    && canonical(wire.subject?.responseOutputLimit) === canonical(researchResponseOutputLimit(admitted.profile?.value.physicalLimits?.maxReplyChars ?? null))
    && request.value.text.length <= admitted.prepared.value.input.limitChars
    && (!admitted.profile || request.value.text.length <= admitted.profile.value.maxRequestChars)
    && (!admitted.profile?.value.physicalLimits || request.value.text.length <= admitted.profile.value.physicalLimits.maxRequestChars),
  'response_recovery_wire_foreign', 'The saved final request differs from its original admission or bounds');
  requirePacketMaterialDelivery(wire.subject, archiveRef!, (ref, pointer) => {
    const row = store.get<Record<string, any>>(ref.id, ref.revision);
    requireCondition(row?.kind === 'research-context' && canonical(reference(row)) === canonical(ref)
      && hashJson(row.value) === row.hash && row.value.projectId === claim.value.projectId
      && canonical(row.value.draft) === canonical(admitted.session.value.binding.draft)
      && canonical(row.value.question) === canonical(admitted.session.value.binding.question),
    'context_reference_foreign', 'A final page lost its exact original binding');
    return contextValue({ body: readArchiveBody(store, row).body }, pointer);
  });
  requireContextDelivery(admitted.context.contextWorkspace, wire.subject);
  const current = kind === 'condition-evidence'
    ? currentConditionEvidenceGuards(store, claim.value.projectId, admitted as Awaited<ReturnType<typeof readConditionEvidenceDispatchAdmission>>)
    : assessment
    ? currentDiscoveryFinalAssessmentGuards(store, claim.value.projectId,
      admitted as Awaited<ReturnType<typeof readDiscoveryFinalAssessmentDispatchAdmission>>)
    : currentDiscoveryFinalGuards(store, claim.value.projectId,
      admitted as Awaited<ReturnType<typeof readDiscoveryFinalDispatchAdmission>>);
  requireCondition(current.every(guard => admitted.application.value.guards.some(saved => canonical(saved) === canonical(guard))),
    'discovery_final_dispatch_unavailable', 'The final claim is no longer current');
  requireInvocationAllowance();
  const control = researchDispatchControl(store, claim.value.projectId, earlyResearchStage(admitted.draft.value.stage));
  try { control?.admit(); }
  catch (error) { if (error instanceof RunControlLost) throw new EngineError(error.refusal.code, error.refusal.message, error.refusal.at); throw error; }
  const segmentRef = claim.value.budget?.segment;
  const segment = isRef(segmentRef) ? store.get<BudgetSegment>(segmentRef.id, segmentRef.revision) : null;
  requireCondition(!segmentRef || segment?.kind === 'research-budget' && canonical(reference(segment)) === canonical(segmentRef),
    'research_budget_invalid', 'The final claim lost its original budget reservation');
  return executeResearchPhysicalCall(admitted.role, admitted.dispatch, request.value.text, claim.value.requestId, claim, signal,
    { store, draftId: admitted.draft.id, questionId: admitted.question.id, purpose,
      session: reference(admitted.session), application: applicationRef,
      ...(admitted.profile ? { pilot: admitted.profile } : {}) }, control, segment, null);
}
