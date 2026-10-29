import { DOSSIER_MATERIAL_CONTRACT, dossierMaterialEra, dossierMaterialProjection, pendingDossierWorkspace } from './dossier-material.js';
import { readResponseCorrectionChain } from './response-correction.js';
import { requireDossierAssessmentSubject } from './dossier-assessment.js';
import { correctingApplicationLeaf, latestResponseApplication, readApplicationResponseCorrection,
  responseCorrectionApplicationWrite, type ApplicationResponseCorrection } from './application-response-correction.js';
import { requireDossierReplyCapacity, dossierSessionTransport, dossierTransportDelivery, DOSSIER_SESSION_TRANSPORT, DOSSIER_RESULT_TRANSPORT } from './continuation-packet.js';
import { resumeDossierResearchCall, prepareDossierResearchEnvelope } from './research-protocol.js';
import { readCapacityProjection, checkDossierResearchReply } from './early-research-outcome.js';
import { resolveRoleMode } from '../runtime/environment.js';
import type { DossierAssessmentSubject, DossierAssessmentProjection } from './research-model.js';
import { packetAssessmentSubject, assessmentQuestionContract, type AssessmentTransportSubject } from './continuation-packet.js';
import { proveAttemptPacket, checkDiscoveryAssessmentForm } from './v7-attempt-assessment.js';
import { prepareResearchEnvelope } from './research-protocol.js';
import { researchCapacityInput, declareResultCapacity, researchResultFailure, researchResultEnvelopeLimit,
  withoutResultCapacity, RESULT_CAPACITY, RESULT_CAPACITY_REFUSAL } from './early-research-outcome.js';
import { STAGE_NEIGHBOR_CONTEXT } from './stage-neighbors.js';
import { earlyResearchFailure, earlyResearchCorrection, requireAssessmentReply, requireAttemptsAssessmentReply, EARLY_RESEARCH_OUTCOME } from './early-research-outcome.js';
import { Evidence } from '../evidence/evidence.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { Environments, uniqueTransactionGuards, transactionGuardsCurrent } from '../runtime/environment.js';
import { prepareModelCallRecovery, readModelCallRecovery } from './model-call-recovery.js';
import { contextWorkspace, addContextLookup, contextProgress, requireCompleteContextPacket, type ContextWorkspace } from "./context-workspace.js";
import { checkTransactionGuards, type Store, type Revision, type Write, type TransactionGuard } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import type { ReaderPilot } from "./reader-pilot.js";
import { readRuntimeEvidenceAt, checkRuntimeAdmissionCurrent, RUNTIME_ADMISSION, type collectRuntimeEvidence, type RuntimeAdmission } from '../graph/runtime-evidence.js';
import type { TechnicalReport } from '../graph/research-contracts.js';
import type { Observation } from '../evidence/evidence.js';
import { canonical, hashJson, type Json } from "../canonical.js";
import { isAbsolute, normalize } from 'node:path';
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";
import { stopCancelledCall } from "../om/run-control.js";
import { researchAction, researchCall } from "./research-protocol.js";
import { readResearchContext, researchContextReadEra, requireCurrentPriorContext } from "./research-limits.js";
import { recoveredResponseBoundary, recoveryAssessmentSessionId, recoverySessionWrites, markRecoveredSessionWritten,
  readResearchExecution, readResearchContextOutcomeAt, isResponseRecovery, markApplicationResponseRecovered, assessmentReadView, assessmentSessionEra,
  proposalRefusalId, readLimitedCallRetryPermit, readResearchConsumerIntent, type AssessmentReadProof } from './response-recovery.js';

/** The packet's producers are the proven K intents, never the current implementer
 * setting or only the first entry. Shared by admission and the historical reader. */
function requireAttemptsAssessorIndependence(store: Store, context: unknown, actor: string): AssessmentTransportSubject | null {
  const subject = packetAssessmentSubject(context);
  if (!subject?.assessment) return null; // Original T keeps the contract of its era.
  const packet = proveAttemptPacket(store, subject.packet);
  for (const entry of packet.entries) {
    const intent = readResearchConsumerIntent(store, entry.binding.value.intent);
    requireCondition(typeof actor === 'string' && actor.length > 0 && intent.value.role.actor !== actor,
      'assessor_not_independent', `[${entry.attempt.attempt.id}] The assessor must differ from every attempt producer`);
  }
  return subject;
}

export function assessmentRolePrompt(prompt: string): string { return prompt + '\n' + instruction; }

interface Session { [key: string]: unknown; projectId: string; offset: number; candidateOffset?:number; notes: Json[]; focus: unknown; workspace?: ContextWorkspace; result: unknown;
  binding?: { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] } }
const instruction = "candidatePage may contain an exact serialized fragment of the candidate; compare it with saved judgments and evidence. Do not issue a final verdict until both candidatePage and evidencePage are complete. Evidence is sent in bounded pages. evidencePage.text is a fragment of the JSON-serialized COMPLETE observations array, at UTF-16 offsets; it is not a complete quote. observations, when populated, contains the whole array. All exact originals are in working.archive; you may request read_context with record,pointer,page. Keep intermediate judgments as {action:'assessment_checkpoint',notes:[string]} with source/requirement references in each note. Notes are unassessed judgments, not source substitutes. You may revisit any earlier page. A terminal verdict is accepted only after every evidence character has been supplied; examine applicable exceptions, global constraints and cross-page contradictions before the final judgment.";

async function legacyAssessmentSession(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined, context: Record<string, any>,
  prompt: string, signal?: AbortSignal, extraGuards:TransactionGuard[]=[]): Promise<unknown> {
  // Additional readings and contradictions can change a verdict even when the
  // proposed value and its citations did not change.
  const basis = JSON.parse(JSON.stringify(context));
  const id = recoveryAssessmentSessionId(`assessment-session:${hashJson([reference(question), reference(environment), draft.value.inputs, basis])}`);
  let session = store.get<Session>(id);
  const guards = [reference(question), reference(environment), ...draft.value.inputs, ...context.observations.map((o: any) => o.source),...extraGuards];
  const save = (value: Session) => {
    const write: Write = { id, kind: 'assessment-session', expected: session?.revision ?? 0,
      value: { ...value, binding: { draft: reference(draft), question: reference(question), environment: reference(environment), inputs: draft.value.inputs } } };
    const recovery = recoverySessionWrites(write);
    session = store.writeMany<Session>([write, ...recovery.writes], [...guards, ...recovery.guards])[0]!;
    markRecoveredSessionWritten(recovery); return session;
  };
  if (!session) save({ projectId: draft.value.projectId, offset: 0, notes: [], focus: null, result: null });
  if (session!.value.result) return session!.value.result;
  for (;;) {
    recoveredResponseBoundary();
    const current = session!.value;
    const workspace=contextWorkspace(current.workspace,current.focus);
    for(const entry of workspace.entries)requireCurrentPriorContext(store,draft,entry.result);
    requireCondition(!workspace.blocked,'research_no_progress',workspace.blocked??'Saved assessment is blocked');
    let sent: Record<string, any> | undefined;
    const response = await researchCall(dispatch.reviewer, dispatch, prompt + "\n" + instruction,
      { ...context, assessmentSession:id, assessmentState: { offset: current.offset, candidateOffset:current.candidateOffset??0, total: JSON.stringify(context.observations).length },
        assessmentNotes: current.notes, contextWorkspace:workspace.entries.map(e=>e.result), focus:null }, signal,
      { store, draftId: draft.id, questionId: question.id, purpose: "assessor", ...(pilot?{pilot}:{}), session:reference(session!), onContext: packet => { sent = packet; } }).catch(error=>{
        if(error instanceof EngineError&&error.code==='research_context_undelivered')save({...current,workspace:{...workspace,blocked:error.message}});
        throw error;
      }) as any;
    const advanced = advanceAssessment(store, draft, question, pilot, current, context, sent, response);
    save(advanced.value);
    if (advanced.failure) throw advanced.failure;
    if (session!.value.result) return session!.value.result;
  }
}

export function assessmentPacket(current: Session, context: Record<string, any>, sent: Record<string, any> | undefined) {
  requireCondition(sent?.evidencePage && sent.evidencePage.offset === current.offset,
    "assessment_invalid", "Assessment did not receive its expected evidence continuation");
  const offset = sent.evidencePage.end, candidate = sent.candidatePage;
  requireCondition(candidate && candidate.total === JSON.stringify(context.value).length
    && (candidate.offset === (current.candidateOffset ?? 0) || candidate.offset === 0 && candidate.complete),
    'assessment_invalid', 'Candidate must be fully supplied through the saved assessment cursor');
  const candidateOffset = candidate.end;
  return { offset, candidate, candidateOffset };
}

function advanceAssessment(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, pilot: Revision<ReaderPilot> | undefined,
  current: Session, context: Record<string, any>, sent: Record<string, any> | undefined, response: any,
  historicalReadEra?: 'legacy'): { value: Session; failure?: unknown } {
  const workspace = contextWorkspace(current.workspace, current.focus);
  const { offset, candidate, candidateOffset } = assessmentPacket(current, context, sent);
  const assessmentSubject = packetAssessmentSubject(context);
  if (assessmentSubject?.assessment) requireAttemptsAssessmentReply(response, assessmentSubject);
  else requireAssessmentReply(response);
  if (response?.action === "read_context") {
    const action = researchAction(response);
    requireCondition(action.action === "read_context", "assessment_invalid", "Expected an addressed read");
    try {
      const mode = historicalReadEra ?? researchContextReadEra(store, sent);
      // Applying a paid attempts read uses the common historical material
      // reader (archive parts, exact producer and source bytes), never today's
      // Question or filesystem admission. The next dispatch checks its guards.
      const result = assessmentSubject?.assessment
        ? readResearchContextOutcomeAt(store, draft, question, action, pilot?.value.maxRequestChars ?? 300000, mode)
        : readResearchContext(store, draft, question.id, pilot, action.record, action.pointer, action.page, mode);
      return { value: { ...current, focus: null, workspace: addContextLookup(workspace, result, sent!.contextWorkspace, pilot?.value.contextLimits?.maxLookups, sent) } };
    } catch (error) {
      return { value: { ...current, workspace: { ...workspace, blocked: error instanceof Error ? error.message : 'Context lookup refused' } }, failure: error };
    }
  }
  if (response?.action !== "assessment_checkpoint" && offset === sent!.evidencePage.total && candidate.complete) {
    requireCompleteContextPacket(workspace, sent!);
    return { value: { ...current, offset, candidateOffset, focus: null, workspace: contextProgress(workspace, sent), result: response } };
  }
  return { value: { ...current, offset, candidateOffset, focus: null, workspace: contextProgress(workspace, sent), notes: [...current.notes,
    { packet: sent!.working.archive, evidence: { offset: current.offset, end: offset }, response } as Json] } };
}

/** An otherwise valid final B reply cannot claim material that its own paid
 * packet only delivered in part. Re-derive this from that packet on write and
 * historical read, never from the current draft or an error label. */
function correctableAssessmentReply(draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  before: Session, context: Record<string, any>, subject: Record<string, any>, payload: unknown): EngineError | null {
  const assessmentSubject = packetAssessmentSubject(context);
  if (assessmentSubject?.assessment) {
    try { requireAttemptsAssessmentReply(payload, assessmentSubject); }
    catch (error) { if (error instanceof EngineError) return error; throw error; }
  } else {
    const invalid = earlyResearchFailure(draft.value, question.value, 'assessor', payload);
    if (invalid) return invalid;
  }
  if (subject.working?.deliveryContract !== 'research-delivery/v1') return null;
  const page = assessmentPacket(before, context, subject);
  if ((payload as {action?: unknown})?.action === 'assessment_checkpoint'
    || page.offset !== subject.evidencePage.total || !page.candidate.complete) return null;
  try { requireCompleteContextPacket(contextWorkspace(before.workspace, before.focus), subject); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'research_context_incomplete') return error;
    throw error;
  }
  return null;
}

const APPLICATION = 'assessment-application/v1' as const;
const PAID_ORIGIN = 'assessment-paid-origin/v1' as const;
const NEIGHBOR_ORIGIN = 'assessment-paid-origin/v2' as const;
export interface AssessmentPaidOriginInput {
  materialContract?: typeof STAGE_NEIGHBOR_CONTEXT;
  pending: Ref;
  root: string;
  graph: Ref | null;
  legacyPaths: { path: string; resolved: string }[];
  reads: AssessmentReadProof;
  runtime: ReturnType<typeof collectRuntimeEvidence>;
  /** D8.4d (№2141): the admission material the runtime result was derived from — saved with M, proved before it. */
  runtimeAdmission: RuntimeAdmission;
}
export interface AssessmentPaidOrigin extends AssessmentPaidOriginInput {
  contract: typeof PAID_ORIGIN | typeof NEIGHBOR_ORIGIN;
  projectId: string;
  session: string;
  application: string;
  draft: Ref;
  question: Ref;
  environment: Ref;
  inputs: Ref[];
  context: Record<string, any>;
  prompt: string;
  role: RoleBinding;
  dispatch: Environment;
  profile: Ref | null;
  guards: TransactionGuard[];
}
type ApplicationRefusal = { kind: 'dependency'; expected: TransactionGuard; actual: Ref | null }
  | { kind: 'call'; call: Ref; code: string }
  | { kind: 'response'; call: Ref; code: string }
  | { kind: 'workspace'; code: string };
interface Application {
  contract: typeof APPLICATION; projectId: string; session: Ref; context: Record<string, any>; prompt: string;
  role: RoleBinding; dispatch: Environment; profile: Ref | null; guards: TransactionGuard[]; previous: Ref | null; resolution: AssessmentReadProof | null;
  origin?: Ref;
  recoveredRead?: { contract: 'assessment-read-recovery/v1'; refusal: Ref; call: Ref };
  replyOutcomeContract?: typeof EARLY_RESEARCH_OUTCOME;
  resultCapacityRefusal?: Record<string, unknown>;
  state: 'prepared' | 'running' | 'applied' | 'refused' | 'retryable' | 'model-refused' | 'renewed'; call: Ref | null; after: Ref | null; received: Ref | null; refusal: ApplicationRefusal | null;
}
// Completion names the applied negative correction; later candidates retain this exact admission in their guards.
interface AssessmentBarrier { contract: 'assessment-barrier/v1'; projectId: string; question: Ref; refusal: Ref; completion?: Ref }
interface ApplicationSession extends Session { contract: typeof APPLICATION; application: string }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const pendingRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
const managedSessionId = (question: Ref, context: Record<string, any>): string =>
  recoveryAssessmentSessionId(`assessment-session:v1:${hashJson([question, JSON.parse(JSON.stringify(withoutResultCapacity(context)))])}`);
export function paidOriginId(projectId: string, turnId: string): string {
  return `assessment-paid-origin:v1:${hashJson({ projectId, turnId })}`;
}
export function paidSessionId(projectId: string, turnId: string): string {
  return `assessment-session:v2:${hashJson({ projectId, turnId })}`;
}

/** Whether the paid assessor step for this pending turn already produced a
 * proven terminal: its session carries a result and its head application is
 * applied onto that exact session revision with a recorded response. Only the
 * restore-vs-admit selector — the full S/A/B/M chain is re-derived and
 * re-validated by the actual restore (№2000-8/№2000-12). */
export function paidAssessmentTerminal(store: Store, projectId: string, pending: Ref): boolean {
  const session = store.get<ApplicationSession>(recoveryAssessmentSessionId(paidSessionId(projectId, pending.id)));
  if (session?.kind !== 'assessment-session' || session.value.projectId !== projectId
    || session.value.result === null || session.value.result === undefined) return false;
  const application = store.get<Application>(session.value.application);
  return application?.kind === 'assessment-application' && application.value.state === 'applied'
    && isRef(application.value.received)
    && !!application.value.after && same(application.value.after, reference(session));
}
function applicationInvalid(id: string, message: string): never {
  throw new EngineError('research_context_application_invalid', `[${id}] ${message}`);
}
function applicationId(session: string, revision: number): string { return `assessment-application:${hashJson([session, revision])}`; }
function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  if (!isRef(ref)) applicationInvalid(kind, 'An exact reference is required');
  const value = store.get<T>(ref.id, ref.revision);
  if (!value || !object(value.value) || value.kind !== kind || !same(reference(value), ref))
    applicationInvalid(ref.id, 'The exact source is missing, foreign or changed');
  return value;
}

/** Structural screening; the exact subject-matter proof is read against the
 * original question, report and citations by readRuntimeEvidenceAt. */
export function checkAssessmentRuntimeMaterials(_store: Store, projectId: string,
  runtime: ReturnType<typeof collectRuntimeEvidence>, originId: string): void {
  if (!object(runtime) || Object.keys(runtime).sort().join(',') !== 'admissionGuards,guards,proofs,supporting'
    || !Array.isArray(runtime.proofs) || !Array.isArray(runtime.supporting)
    || !Array.isArray(runtime.guards) || !Array.isArray(runtime.admissionGuards)
    || !runtime.guards.every(guard => isRef(guard) && Object.keys(guard).sort().join(',') === 'hash,id,revision')
    || !same(runtime.guards, [...new Map(runtime.guards.map(guard => [canonical(guard), guard])).values()]
      .sort((left, right) => `${left.id}:${left.revision}:${left.hash}`.localeCompare(`${right.id}:${right.revision}:${left.hash}`)))
    || !runtime.admissionGuards.every(guard => object(guard)
      && ('absent' in guard ? Object.keys(guard).sort().join(',') === 'absent,id'
        && typeof guard.id === 'string' && guard.id.length > 0 && guard.absent === true
        : isRef(guard) && Object.keys(guard).sort().join(',') === 'hash,id,revision'))
    || !same(runtime.admissionGuards, uniqueTransactionGuards(runtime.admissionGuards)))
    applicationInvalid(originId, 'The original runtime result is incomplete or duplicated');
  for (const proof of runtime.proofs) {
    if (!object(proof) || Object.keys(proof).sort().join(',') !== 'authorization,code,document,obligation,observation,source'
      || typeof proof.obligation !== 'string' || !proof.obligation || typeof proof.document !== 'string' || !proof.document
      || !isRef(proof.observation) || !isRef(proof.source) || !isRef(proof.authorization)
      || !Array.isArray(proof.code) || !proof.code.every(isRef))
      applicationInvalid(originId, 'A saved runtime proof lost its exact sources');
  }
  for (const observation of runtime.supporting) {
    if (!object(observation) || Object.keys(observation).sort().join(',') !== 'projectId,selector,source,value'
      || observation.projectId !== projectId || !isRef(observation.source)
      || !object(observation.selector) || !Object.hasOwn(observation, 'value'))
      applicationInvalid(originId, 'A supporting runtime observation is incomplete or foreign');
  }
}

/** Structural screening of the admission material (№2141); its subject-matter
 * proof is the derivation of the selection from it by readRuntimeEvidenceAt. */
export function checkRuntimeAdmissionShape(admission: RuntimeAdmission, originId: string): void {
  const basisOk = (basis: unknown) => object(basis) && Object.keys(basis).sort().join(',') === 'binding,executable,subjects'
    && object(basis.executable) && typeof basis.executable.path === 'string' && Array.isArray(basis.subjects);
  if (!object(admission) || Object.keys(admission).sort().join(',') !== 'candidates,contract,references'
    || admission.contract !== RUNTIME_ADMISSION || !Array.isArray(admission.references) || !Array.isArray(admission.candidates)
    || !admission.references.every(item => object(item) && Object.keys(item).sort().join(',') === 'basis,check,unresolved'
      && object(item.check) && (item.basis === null ? typeof item.unresolved === 'string' && item.unresolved.length > 0
        : basisOk(item.basis) && item.unresolved === null))
    || !admission.candidates.every(item => object(item)
      && Object.keys(item).sort().join(',') === 'admitted,basis,citation,document,mismatch,obligation,observation,source'
      && typeof item.obligation === 'string' && !!item.obligation && typeof item.document === 'string' && !!item.document
      && Number.isSafeInteger(item.citation) && item.citation >= 0 && isRef(item.observation) && isRef(item.source)
      && basisOk(item.basis) && typeof item.admitted === 'boolean' && Array.isArray(item.mismatch)
      && item.mismatch.every(part => typeof part === 'string' && part.length > 0) && item.admitted === (item.mismatch.length === 0)))
    applicationInvalid(originId, 'The runtime admission material is incomplete or malformed');
}

function checkAssessmentRuntimeOrigin(store: Store, projectId: string, pending: Ref, question: Revision<Question>,
  context: Record<string, any>, runtime: ReturnType<typeof collectRuntimeEvidence>, admission: RuntimeAdmission, originId: string,
  current: boolean): void {
  checkAssessmentRuntimeMaterials(store, projectId, runtime, originId);
  checkRuntimeAdmissionShape(admission, originId);
  let cited: Observation[] = [];
  try {
    const first = store.get<Record<string, any>>(pending.id, 1);
    if (!first || first.kind !== 'research-turn' || hashJson(first.value) !== first.hash
      || !object(context) || !Array.isArray(context.observations)) throw new Error('The original paid citation set is missing');
    const paid = researchAction(first.value.action);
    if ((paid.action !== 'answer' && paid.action !== 'answer_delta') || paid.question !== question.id)
      throw new Error('The paid turn belongs to another answer');
    if (runtime.proofs.length ? !same(context.runtimeProofs, runtime.proofs)
      : Object.hasOwn(context, 'runtimeProofs'))
      throw new Error('The assessor packet lost its exact runtime proofs');
    if (question.value.spec.obligationContract === 'evidence-v1'
      && (paid.action !== 'answer' || !same(paid.value, context.value) || !same(context.question, question.value.spec)))
      throw new Error('The runtime proof belongs to another proposed report or question');
    cited = context.observations.slice(0, paid.citations.length) as Observation[];
    if (!same(cited.map(item => ({ source: item.source, selector: item.selector })), paid.citations)
      || !same(context.observations.slice(paid.citations.length), runtime.supporting))
      throw new Error('The assessor packet lost its original citations');
    // The selected and the excluded candidates derive from the saved admission material alone (№2141).
    readRuntimeEvidenceAt(store, projectId, question.value.spec, context.value as TechnicalReport, cited, runtime, admission);
  } catch {
    applicationInvalid(originId, 'The original runtime result does not derive from its exact observation, authority and citations');
  }
  // Before the first write of M the material must be today's admission: the full live derivation reproduces it and the
  // result exactly, so a stale, foreign or empty caller-supplied result never becomes a paid origin (R6, №2141).
  if (current) {
    try { checkRuntimeAdmissionCurrent(store, projectId, question.value.spec, context.value as TechnicalReport, cited, runtime, admission); }
    catch { applicationInvalid(originId, 'The runtime admission material is not the current admission of this report'); }
  }
}

/** The paid turn locates its original materials without rebuilding today's
 * proposal, filesystem view or assessor packet. Absence is allowed only before
 * the first atomic session/application/origin write. */
export function readAssessmentPaidOrigin(store: Store, projectId: string, pending: Ref): Revision<AssessmentPaidOrigin> | null {
  if (!store || typeof store.get !== 'function' || typeof projectId !== 'string' || !projectId || !isRef(pending))
    applicationInvalid('assessment-paid-origin', 'An exact paid turn and project are required');
  const id = paidOriginId(projectId, pending.id), sessionId = paidSessionId(projectId, pending.id);
  const record = store.get<AssessmentPaidOrigin>(id);
  if (!record) {
    if (store.get(sessionId) || store.get(applicationId(sessionId, 1)))
      applicationInvalid(id, 'A paid assessor session lost its mandatory origin');
    return null;
  }
  const value = record.value;
  const fields = ['contract', 'projectId', 'session', 'application', 'pending', 'root', 'graph', 'legacyPaths', 'reads', 'runtime', 'runtimeAdmission', 'draft', 'question',
    'environment', 'inputs', 'context', 'prompt', 'role', 'dispatch', 'profile', 'guards'];
  if (record.kind !== 'assessment-paid-origin' || record.revision !== 1 || !object(value)
    || record.hash !== hashJson(value)
    || Object.keys(value).sort().join(',') !== fields.sort().join(',')
    || ![PAID_ORIGIN, NEIGHBOR_ORIGIN].includes(value.contract) || value.projectId !== projectId || value.session !== sessionId
    || value.application !== applicationId(sessionId, 1)
    || !same(value.pending, pending) || !isRef(value.draft) || !isRef(value.question) || !isRef(value.environment)
    || !Array.isArray(value.inputs) || !value.inputs.every(isRef)
    || typeof value.root !== 'string' || !isAbsolute(value.root) || normalize(value.root) !== value.root
    || !(value.graph === null || isRef(value.graph) && value.graph.id === `graph:${projectId}`)
    || !Array.isArray(value.legacyPaths) || !value.legacyPaths.every(item => object(item)
      && Object.keys(item).sort().join(',') === 'path,resolved' && typeof item.path === 'string' && item.path.length > 0
      && typeof item.resolved === 'string' && isAbsolute(item.resolved) && normalize(item.resolved) === item.resolved)
    || !object(value.reads) || value.reads.contract !== 'assessment-read/v1'
    || !Array.isArray(value.reads.reads) || !Array.isArray(value.reads.files)
    || !object(value.context) || !Array.isArray(value.context.observations)
    || typeof value.prompt !== 'string' || !object(value.role) || !object(value.dispatch)
    || value.dispatch.projectId !== projectId || value.dispatch.workspace !== value.root
    || !(value.profile === null || isRef(value.profile)) || !Array.isArray(value.guards)
    || !same(value.guards, uniqueTransactionGuards(value.guards)))
    applicationInvalid(id, 'Malformed immutable paid assessment origin');
  if (value.contract === NEIGHBOR_ORIGIN && value.context.assessmentContextContract !== STAGE_NEIGHBOR_CONTEXT)
    applicationInvalid(id, 'The new paid origin lost its explicit stage material contract');
  exact(store, pending, 'research-turn');
  exact(store, value.draft, 'discovery-draft');
  const originalQuestion = exact<Question>(store, value.question, 'question');
  exact(store, value.environment, 'environment');
  for (const input of value.inputs) exact(store, input, store.get(input.id, input.revision)?.kind ?? '');
  if (value.graph) exact(store, value.graph, 'graph');
  if (value.profile) exact(store, value.profile, 'reader-pilot');
  checkAssessmentRuntimeOrigin(store, projectId, pending, originalQuestion, value.context, value.runtime, value.runtimeAdmission, id, false);
  if (!value.guards.some(guard => same(guard, value.pending))
    || value.graph && !value.guards.some(guard => same(guard, value.graph))
    || [...value.runtime.guards, ...value.runtime.admissionGuards]
      .some(required => !value.guards.some(guard => same(guard, required))))
    applicationInvalid(id, 'The paid origin lost an original transaction dependency');
  return record;
}
function applicationPointer(session: Revision<ApplicationSession>): string {
  const value = session.value;
  if (!object(value) || value.contract !== APPLICATION || typeof value.application !== 'string' || !value.application)
    applicationInvalid(session.id, 'The new session must retain its application contract');
  return value.application;
}
function readApplication(store: Store, session: Revision<ApplicationSession>, saved: undefined, allowMissing: true): Revision<Application> | null;
function readApplication(store: Store, session: Revision<ApplicationSession>, saved?: Ref): Revision<Application>;
function readApplication(store: Store, session: Revision<ApplicationSession>, saved?: Ref, allowMissing = false): Revision<Application> | null {
  const value = session.value, pointer = applicationPointer(session);
  const record = saved ? exact<Application>(store, saved, 'assessment-application') : store.get<Application>(pointer);
  if (!record && allowMissing) return null;
  if (!record || !object(record.value) || record.kind !== 'assessment-application') applicationInvalid(value.application, 'The required application state is missing');
  const app = record.value, origin = exact<Application>(store, { id: record.id, revision: 1, hash: store.get(record.id, 1)?.hash ?? '' }, record.kind);
  const paid = session.id.startsWith('assessment-session:v2:');
  const fields = ['contract', 'projectId', 'session', 'context', 'prompt', 'role', 'dispatch', 'profile', 'guards', 'previous',
    'resolution', 'state', 'call', 'after', 'received', 'refusal'];
  if (!fields.every(field => Object.hasOwn(app, field))
    || (paid ? !isRef(app.origin) : Object.hasOwn(app, 'origin'))
    || app.contract !== APPLICATION || app.projectId !== value.projectId || !isRef(app.session)
    || record.id !== applicationId(session.id, app.session.revision) || app.session.id !== session.id
    || !app.context || !Array.isArray(app.context.observations) || typeof app.prompt !== 'string' || !object(app.role) || !object(app.dispatch) || !Array.isArray(app.guards)
    || !same(app.guards, uniqueTransactionGuards(app.guards)) || !(app.profile === null || isRef(app.profile))
    || !(app.received === null || isRef(app.received)) || !(app.resolution === null || object(app.resolution))
    || !['prepared', 'running', 'applied', 'refused', 'retryable', 'model-refused', 'renewed'].includes(app.state)) applicationInvalid(record.id, 'Malformed application identity or dependencies');
  const immutable = (v: Application) => ({ contract: v.contract, projectId: v.projectId, session: v.session, context: v.context,
    prompt: v.prompt, role: v.role, dispatch: v.dispatch, profile: v.profile, guards: v.guards, previous: v.previous,
    origin: v.origin ?? null, recoveredRead: v.recoveredRead ?? null });
  if (origin.value.state !== 'prepared' || origin.value.call !== null || origin.value.after !== null || origin.value.received !== null || origin.value.refusal !== null || origin.value.resolution !== null
    || !same(immutable(app), immutable(origin.value))) applicationInvalid(record.id, 'The original application admission changed');
  const before = exact<ApplicationSession>(store, app.session, 'assessment-session');
  if (app.context.resultCapacityContract !== undefined || app.context.resultCapacity !== undefined) {
    requireCondition(app.context.resultCapacityContract === RESULT_CAPACITY, 'research_capacity_invalid', 'The assessment lost its declared era');
    const capacity = app.context.resultCapacity;
    if (!capacity || typeof capacity !== 'object' || (capacity as any).contract !== RESULT_CAPACITY)
      applicationInvalid(record.id, 'The saved result admission differs from its exact producer');
  }
  if (paid) {
    const paidOrigin = exact<AssessmentPaidOrigin>(store, app.origin!, 'assessment-paid-origin');
    const checked = readAssessmentPaidOrigin(store, app.projectId, paidOrigin.value.pending);
    const initial = store.get<Application>(paidOrigin.value.application, 1);
    const initialSession = store.get<ApplicationSession>(paidOrigin.value.session, 1);
    if (!checked || !same(reference(checked), app.origin) || paidOrigin.value.session !== session.id
      || !initial || initial.kind !== 'assessment-application' || initial.hash !== hashJson(initial.value)
      || !initialSession || initialSession.kind !== 'assessment-session' || initialSession.hash !== hashJson(initialSession.value)
      || !same(initial.value.origin, app.origin)
      || !same([paidOrigin.value.draft, paidOrigin.value.question, paidOrigin.value.environment, paidOrigin.value.inputs,
        paidOrigin.value.context, paidOrigin.value.prompt, paidOrigin.value.role, paidOrigin.value.dispatch,
        paidOrigin.value.profile, paidOrigin.value.guards],
      [initialSession.value.binding?.draft, initialSession.value.binding?.question, initialSession.value.binding?.environment,
        initialSession.value.binding?.inputs, initial.value.context, initial.value.prompt, initial.value.role,
        initial.value.dispatch, initial.value.profile, initial.value.guards]))
      applicationInvalid(record.id, 'The application lost its exact paid origin and original materials');
  }
  if (before.value.application !== record.id || !before.value.binding || app.state !== 'renewed' && !same(before.value.binding, value.binding)
    || !app.guards.some(guard => same(guard, barrierGuard(app.projectId, before.value.binding!.question))
      || isRef(guard) && guard.id === barrierGuard(app.projectId, before.value.binding!.question).id
        && permitsAssessmentCorrection(store, exact<AssessmentBarrier>(store, guard, 'assessment-barrier'), app)))
    applicationInvalid(record.id, 'The original session and question admission must be preserved');
  proveSessionOrigin(store, record, before);
  if (app.state === 'prepared' ? app.call !== null || app.after !== null || app.received !== null || app.refusal !== null
    : app.state === 'running' ? !isRef(app.call) || app.after !== null || app.received !== null || app.refusal !== null
    : app.state === 'applied' ? !isRef(app.call) || !isRef(app.after) || !isRef(app.received) || !app.resolution || app.refusal !== null
    : app.state === 'model-refused' ? !isRef(app.call) || !isRef(app.received) || !app.resolution || app.after !== null || app.refusal !== null
    : app.state === 'retryable' ? !isRef(app.call) || !isRef(app.received) || app.after !== null || app.refusal !== null
    : app.state === 'renewed' ? !isRef(app.after) || app.refusal !== null || !(app.call === null && app.received === null || isRef(app.call) && isRef(app.received))
    : app.after !== null || !app.refusal || !(app.call === null || isRef(app.call))) applicationInvalid(record.id, 'Incomplete application state');
  if (app.state === 'applied' || app.state === 'renewed') {
    if (!same(app.after, reference(session))) applicationInvalid(record.id, 'The terminal session is not the exact applied state');
  } else if (!same(app.session, reference(session))) applicationInvalid(record.id, 'The current cursor is not owned by this application');
  if (app.call) {
    const bound = store.get<Application>(record.id, 2);
    if (bound?.value.state !== 'running' || !same(bound.value.call, app.call)) applicationInvalid(record.id, 'The original physical call binding changed');
    const admission = exact<ModelCall>(store, app.call, 'model-call');
    if (!same((admission.value as ModelCall & { assessmentApplication?: Ref }).assessmentApplication, reference(origin))
      || admission.revision !== 1 || admission.value.status !== 'running' || admission.value.projectId !== app.projectId
      || admission.value.purpose !== 'assessor' || admission.value.draftId !== value.binding?.draft.id
      || admission.value.questionId !== value.binding?.question.id || !same(admission.value.requested, app.role)
      || !same(admission.value.profile, app.profile)) applicationInvalid(record.id, 'The physical call has a foreign admission');
  }
  if (app.state === 'refused') validateRefusal(store, record);
  if (app.state === 'retryable' || app.state === 'model-refused' || app.state === 'renewed' && app.call) requireRetryable(store, app);
  if (app.state === 'renewed') {
    const prior = store.get<Application>(record.id, record.revision - 1);
    if (!prior || !same({ ...prior.value, state: 'renewed', after: app.after }, app)
      || (app.call === null ? prior.value.state !== 'prepared' || prior.value.call !== null : !['retryable', 'model-refused'].includes(prior.value.state)))
      applicationInvalid(record.id, 'Renewal must consume the exact unsent intent or proved failed attempt');
  }
  return record;
}
function validateRefusal(store: Store, record: Revision<Application>): void {
  const prior = store.get<Application>(record.id, record.revision - 1);
  if (!prior || !['prepared', 'running', 'retryable', 'model-refused'].includes(prior.value.state))
    applicationInvalid(record.id, 'A refusal must consume its exact unfinished application once');
  const reason = record.value.refusal!;
  if (reason.kind === 'dependency') {
    uniqueTransactionGuards([reason.expected]);
    if (record.value.resolution !== null || !record.value.guards.some(guard => same(guard, reason.expected)) || !(reason.actual === null || isRef(reason.actual))
      || reason.actual && reason.actual.id !== reason.expected.id
      || ('absent' in reason.expected ? reason.actual === null : same(reason.expected, reason.actual)))
      applicationInvalid(record.id, 'The refusal does not prove a changed original dependency');
    if (reason.actual) exact(store, reason.actual, store.get(reason.actual.id, reason.actual.revision)?.kind ?? '');
    if (record.value.received !== null) {
      applicationResponse(store, record.value, record.value.received);
    } else if (record.value.call !== null) {
      if (!['retryable', 'model-refused'].includes(prior.value.state)) applicationInvalid(record.id, 'A bound dependency refusal must retain its exact physical outcome');
      requireRetryable(store, prior.value);
    }
  } else if (reason.kind === 'call' || reason.kind === 'response') {
    if (!isRef(reason.call) || reason.call.id !== record.value.call?.id || typeof reason.code !== 'string') applicationInvalid(record.id, 'The refusal has a foreign physical outcome');
    const call = exact<ModelCall>(store, reason.call, 'model-call');
    requirePhysicalIdentity(exact<ModelCall>(store, record.value.call!, 'model-call'), call);
    if (reason.kind === 'call' && (record.value.received !== null || record.value.resolution !== null
      || call.value.status !== 'failed' || call.value.error !== reason.code)) applicationInvalid(record.id, 'The call does not prove this refusal');
    if (reason.code === 'process_lost') readModelCallRecovery(store, record.value.projectId, reason.call);
    if (reason.kind === 'response') {
      const before = exact<ApplicationSession>(store, record.value.session, 'assessment-session'), binding = before.value.binding!;
      const draft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft'), question = exact<Question>(store, binding.question, 'question');
      const paid = applicationResponse(store, record.value, reason.call);
      if (!same(record.value.received, reason.call) || !record.value.resolution) applicationInvalid(record.id, 'The refused transition needs its exact response and frozen inputs');
      const evaluated = evaluateApplication(store, record.value, before, draft, question, paid, record.value.resolution);
      if (!(evaluated.failure instanceof EngineError) || evaluated.failure.code !== reason.code)
        applicationInvalid(record.id, 'The exact response and original inputs do not produce this refusal');
    }
  } else if (reason.kind === 'workspace') {
    const before = exact<ApplicationSession>(store, record.value.session, 'assessment-session');
    if (record.value.call !== null || record.value.received !== null || !record.value.resolution) applicationInvalid(record.id, 'A pre-dispatch refusal needs its exact lookup proof');
    const checked = evaluateWorkspace(store, before, record.value.resolution);
    if (!(checked.failure instanceof EngineError) || checked.failure.code !== reason.code)
      applicationInvalid(record.id, 'The original workspace does not derive this refusal');
  } else applicationInvalid(record.id, 'Unknown refusal witness');
}
function changedDependency(store: Store, guards: TransactionGuard[]): { reason: ApplicationRefusal; guards: TransactionGuard[] } | null {
  if (transactionGuardsCurrent(store, guards)) return null;
  for (const expected of guards) {
    const head = store.get(expected.id), actual = head ? reference(head) : null;
    if ('absent' in expected ? actual !== null : !same(expected, actual)) return {
      reason: { kind: 'dependency', expected, actual }, guards: actual ? [actual] : [{ id: expected.id, absent: true }] };
  }
  return null;
}
function applicationRefusalCode(record: Revision<Application>): string {
  const reason = record.value.refusal;
  return reason?.kind === 'response' && (reason.code === 'research_no_progress' || reason.code.startsWith('research_context_'))
    ? reason.code : 'research_context_application_refused';
}
function throwApplicationRefusal(record: Revision<Application>): never {
  throw new EngineError(applicationRefusalCode(record), `[${record.id}] Original assessment admission cannot be applied; reopen this question explicitly`,
    { application: reference(record), refusal: record.value.refusal });
}

/**
 * DRY6-01 (contract №4961 (b)): the exact recovery door of a refused original assessment, derived from the saved application
 * alone — old ones included — by its readers; the refusal itself is thrown exactly as before. The address is the assessed question of the application's session binding, never the changed
 * dependency; the command's CAS basis is that question's head now. What changed is named by its own record kind, so a Source
 * or environment change is not presented as a neighbour. A technical recovery action, not an owner decision.
 */
export const ASSESSMENT_REFUSAL_DOOR = 'assessment-refusal-door/v1' as const;
export interface AssessmentRefusalDoor {
  contract: typeof ASSESSMENT_REFUSAL_DOOR; code: string; application: Ref; question: Ref; current: Ref;
  changed: { expected: TransactionGuard; actual: Ref | null; kind: string | null } | null;
  command: { type: 'reopen-question'; question: string; expected: number };
}
export function assessmentRefusalDoor(store: Store, saved: Revision<Application>): AssessmentRefusalDoor {
  if (saved.kind !== 'assessment-application' || saved.value.state !== 'refused' || !saved.value.refusal)
    throw new EngineError('assessment_refusal_door_invalid', `[${saved.id}] Only a refused assessment application names a recovery door`,
      { application: reference(saved) });
  // The common reader of the producer: identity, unchanged admission and the refusal proof — the door trusts nothing else.
  const session = isRef(saved.value.session) ? store.get<ApplicationSession>(saved.value.session.id) : null;
  if (!session || session.kind !== 'assessment-session') applicationInvalid(saved.id, 'The refused application lost its session');
  const record = readApplication(store, session, reference(saved)), refusal = record.value.refusal!;
  const binding = exact<ApplicationSession>(store, record.value.session, 'assessment-session').value.binding;
  const current = binding && isRef(binding.question) && isRef(binding.draft) ? store.get<Question>(binding.question.id) : null;
  if (!binding || !current || current.kind !== 'question' || current.value.projectId !== record.value.projectId
    || current.value.draftId !== binding.draft.id)
    throw new EngineError('assessment_refusal_door_invalid',
      `[${record.id}] The refused assessment names no current question of its own draft to reopen`,
      { application: reference(record), question: binding?.question ?? null });
  return { contract: ASSESSMENT_REFUSAL_DOOR, code: applicationRefusalCode(record), application: reference(record),
    question: binding.question, current: reference(current),
    changed: refusal.kind === 'dependency' ? { expected: refusal.expected, actual: refusal.actual, kind: store.get(refusal.expected.id)?.kind ?? null } : null,
    command: { type: 'reopen-question', question: current.id, expected: current.revision } };
}
/**
 * DRY6-01: the door of a research run paused by the refused original assessment of one of its pending paid turns — the
 * refusal the runner restores on every entry: the CURRENT application of the turn's exact paid session (a continuation
 * after a lookup or a checkpoint has its own application; the origin names only the first), read by the common reader,
 * or the barrier of the turn's question where one lawfully exists — matched to the run's own pause code. Read only; the
 * run record keeps its form. Two distinct candidates are an addressed ambiguity.
 */
export function runAssessmentRefusalDoor(store: Store, projectId: string,
  run: Revision<{ status: string; pauseCode?: string | null }>): AssessmentRefusalDoor | null {
  if (run.value.status !== 'paused' || !run.value.pauseCode) return null;
  const refused = new Map<string, Revision<Application>>();
  for (const turn of store.list<{ run: string; status: string; question: Ref | null }>('research-turn')) {
    if (turn.value.run !== run.id || turn.value.status !== 'pending') continue;
    const origin = readAssessmentPaidOrigin(store, projectId, reference(turn));
    const session = origin ? store.get<ApplicationSession>(origin.value.session) : null;
    if (origin && (!session || session.kind !== 'assessment-session'))
      applicationInvalid(origin.id, 'The paid assessor session of this turn is missing');
    const barrier = isRef(turn.value.question) ? readBarrier(store, projectId, turn.value.question) : null;
    for (const application of [session ? readApplication(store, session) : null,
      barrier && !barrier.value.completion ? exact<Application>(store, barrier.value.refusal, 'assessment-application') : null])
      if (application?.kind === 'assessment-application' && application.value.state === 'refused'
        && applicationRefusalCode(application) === run.value.pauseCode) refused.set(application.id, application);
  }
  if (refused.size > 1) throw new EngineError('assessment_refusal_door_invalid', `[${run.id}] Several refused assessments claim this pause`,
    { run: reference(run), applications: [...refused.values()].map(reference) });
  const [only] = refused.values();
  return only ? assessmentRefusalDoor(store, only) : null;
}
function barrierGuard(project: string, question: Ref): TransactionGuard {
  return { id: `assessment-barrier:${hashJson([project, question])}`, absent: true };
}
function readBarrier(store: Store, project: string, question: Ref): Revision<AssessmentBarrier> | null {
  const barrier = store.get<AssessmentBarrier>(barrierGuard(project, question).id);
  return barrier ? readBarrierAt(store, barrier) : null;
}
function readBarrierAt(store: Store, barrier: Revision<AssessmentBarrier>): Revision<AssessmentBarrier> {
  const value = barrier.value;
  if (!object(value) || barrier.kind !== 'assessment-barrier' || barrier.revision < 1 || hashJson(value) !== barrier.hash
    || value.contract !== 'assessment-barrier/v1' || !isRef(value.question) || !isRef(value.refusal)
    || barrier.id !== barrierGuard(value.projectId, value.question).id
    || Object.hasOwn(value, 'completion') && !isRef(value.completion))
    applicationInvalid(barrier.id, 'The question barrier has a foreign contract or origin');
  const refused = exact<Application>(store, value.refusal, 'assessment-application');
  const before = exact<ApplicationSession>(store, refused.value.session, 'assessment-session');
  const proof = readApplication(store, before, value.refusal);
  if (!['refused', 'model-refused'].includes(proof.value.state) || !isRef(proof.value.received) || proof.value.projectId !== value.projectId
    || !same(before.value.binding?.question, value.question)
    || proof.value.refusal?.kind === 'dependency' && proof.value.refusal.expected.id === barrier.id)
    applicationInvalid(barrier.id, 'The barrier must originate in a proved refusal of this exact question');
  const previous = barrier.revision > 1 ? store.get<AssessmentBarrier>(barrier.id, barrier.revision - 1) : null;
  if (value.completion) {
    const applied = exact<Application>(store, value.completion, 'assessment-application');
    if (proof.value.state !== 'model-refused' || applied.value.state !== 'applied' || !isRef(applied.value.after)
      || applied.value.session.id !== before.id || applied.value.session.revision <= before.revision
      || !previous || previous.value.completion || !same(value, { ...previous.value, completion: value.completion })
      || !applied.value.guards.some(guard => same(guard, reference(previous))))
      applicationInvalid(barrier.id, 'Only the completed correction of this refusal may release its candidate');
    const after = exact<ApplicationSession>(store, applied.value.after, 'assessment-session');
    readApplication(store, after, value.completion);
    proveAppliedAssessment(store, applied, after);
    if (!same(after.value.binding?.question, value.question) || !object(after.value.result)
      || !['insufficient', 'conflicting'].includes(after.value.result.verdict))
      applicationInvalid(barrier.id, 'A new candidate requires the corrected negative assessment of this exact question');
  } else if (barrier.revision > 1) {
    if (!previous?.value.completion || !same(value, { contract: previous.value.contract, projectId: previous.value.projectId,
      question: previous.value.question, refusal: value.refusal })
      || !proof.value.guards.some(guard => same(guard, reference(previous))))
      applicationInvalid(barrier.id, 'A subsequent refusal must follow the exact completed correction admission');
  }
  return barrier;
}
function permitsAssessmentCorrection(store: Store, barrier: Revision<AssessmentBarrier>, app: Application): boolean {
  const checked = readBarrierAt(store, barrier);
  if (checked.value.projectId !== app.projectId) return false;
  if (checked.value.completion) return true;
  const refused = exact<Application>(store, barrier.value.refusal, 'assessment-application');
  if (refused.value.state === 'refused' && refused.value.refusal?.kind === 'response'
    && refused.value.refusal.code === 'context_read_limit'
    && refused.value.session.id === app.session.id
    && app.guards.some(guard => same(guard, reference(checked)))
    && same([app.origin ?? null, withoutResultCapacity(app.context), app.prompt],
      [refused.value.origin ?? null, withoutResultCapacity(refused.value.context), refused.value.prompt])) return true;
  return refused.value.state === 'model-refused' && refused.value.session.id === app.session.id
    && same(withoutResultCapacity(refused.value.context), withoutResultCapacity(app.context));
}
// Renew protection for a later candidate without changing any earlier refusal or completion revision.
function refusalBarrierWrite(barrier: Revision<AssessmentBarrier> | null, app: Application, question: Ref, refused: Write): Write[] {
  if (barrier && (!barrier.value.completion || !app.guards.some(guard => same(guard, reference(barrier))))) return [];
  return [{ id: barrierGuard(app.projectId, question).id, kind: 'assessment-barrier', expected: barrier?.revision ?? 0,
    value: { contract: 'assessment-barrier/v1', projectId: app.projectId, question,
      refusal: pendingRef(refused) } satisfies AssessmentBarrier }];
}
function barrierRefusal(store: Store, barrier: Revision<AssessmentBarrier>): never {
  throwApplicationRefusal(exact<Application>(store, barrier.value.refusal, 'assessment-application'));
}
function refuseApplication(store: Store, record: Revision<Application>, reason: ApplicationRefusal, guards: TransactionGuard[], writes: Write[] = [], resolution: AssessmentReadProof | null = null, received: Ref | null = null): never {
  if (reason.kind === 'dependency' && record.value.call !== null && received === null && !['retryable', 'model-refused'].includes(record.value.state))
    throw new EngineError('research_context_application_running', `[${record.id}] Preserve the bound call until its physical outcome is proved`);
  const before = exact<ApplicationSession>(store, record.value.session, 'assessment-session'), question = before.value.binding!.question;
  const write: Write = { id: record.id, kind: record.kind, expected: record.revision, value: { ...record.value, state: 'refused', refusal: reason, resolution, received } };
  for (;;) {
    const barrier = readBarrier(store, record.value.projectId, question), absent = barrierGuard(record.value.projectId, question);
    try {
      const saved = store.writeMany<Application>([write, ...writes, ...(received ? refusalBarrierWrite(barrier, record.value, question, write) : [])],
      uniqueTransactionGuards([reference(record), record.value.session, ...guards, barrier ? reference(barrier) : absent]))[0]!;
      throwApplicationRefusal(saved);
    } catch (error) {
      if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code) || barrier
        || !readBarrier(store, record.value.projectId, question)) throw error;
      // A concurrent refusal owns the barrier. Preserve its origin and retry only
      // this application's original refusal and witnesses under its new guard.
    }
  }
}
function applicationCapacityInput(store: Store, session: { id: string; revision: number; value: ApplicationSession },
  context: Record<string, any>, prompt: string, role: RoleBinding, dispatch: Environment, profile: Ref | null) {
  const binding = session.value.binding!;
  const draft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft');
  const question = exact<Question>(store, binding.question, 'question');
  const pilot = profile ? exact<ReaderPilot>(store, profile, 'reader-pilot') : null;
  return researchCapacityInput({ operation: applicationId(session.id, session.revision), generation: session.revision - 1,
    bindings: { projectId: session.value.projectId, session: session.id, draft: binding.draft,
      question: binding.question, inputsHash: hashJson(binding.inputs), application: applicationId(session.id, session.revision) },
    role: 'assessor', purpose: 'assessor', actionMode: 'assess-answer',
    limit: researchResultEnvelopeLimit(dispatch, pilot?.value),
    physicalReplyLimit: pilot?.value.physicalLimits?.maxReplyChars ?? null,
    prompt: context.resultCapacityPrompt ?? assessmentRolePrompt(prompt), binding: role, draft: draft.value,
    question: { id: question.id, value: question.value }, context: context.resultCapacityCorrection ? { ...context, failures: [context.resultCapacityCorrection] } : context,
    cursor: { offset: session.value.offset, candidateOffset: session.value.candidateOffset ?? 0,
      candidateTotal: JSON.stringify(context.value).length, evidenceTotal: JSON.stringify(context.observations).length,
      completeBeforeVerdict: true } });
}
function assessmentDispatchContext(before: Session, id: string, context: Record<string, any>, correction?: Record<string, unknown> | null) {
  const workspace = contextWorkspace(before.workspace, before.focus);
  const feedback = context.resultCapacityCorrection ?? correction;
  return { ...context, ...(feedback ? { failures: [feedback] } : {}), assessmentSession: id,
    assessmentState: { offset: before.offset, candidateOffset: before.candidateOffset ?? 0,
      total: JSON.stringify(context.observations).length }, assessmentNotes: before.notes,
    contextWorkspace: workspace.entries.map(entry => entry.result), focus: null };
}
function admittedAssessmentContext(store: Store, session: Write, context: Record<string, any>, prompt: string,
  role: RoleBinding, dispatch: Environment, profile: Ref | null, previous: Revision<Application> | null = null) {
  const plain = withoutResultCapacity(context);
  const admitted: Record<string, any> = { ...plain, resultCapacityContract: RESULT_CAPACITY };
  if (previous) {
    const prior = exact<Application>(store, reference(previous), 'assessment-application');
    if (prior.value.resultCapacityRefusal && prior.value.received) {
      const outcome = applicationResponse(store, prior.value, prior.value.received);
      admitted.resultCapacityCorrection = { contract: RESULT_CAPACITY, attempt: reference(prior), code: RESULT_CAPACITY_REFUSAL,
        details: { ...prior.value.resultCapacityRefusal, response: outcome.response },
        instruction: 'Correct this assessment only; preserve the same candidate and evidence cursor.' };
    }
  }
  const saved = { id: session.id, revision: session.expected + 1, value: session.value as ApplicationSession };
  const pilot = profile ? exact<ReaderPilot>(store, profile, 'reader-pilot') : undefined;
  for (let n = 0; n < 4; n += 1) {
    admitted.resultCapacity = declareResultCapacity(store, applicationCapacityInput(store, saved, admitted, prompt, role, dispatch, profile));
    const actual = prepareResearchEnvelope(role, dispatch, assessmentRolePrompt(prompt),
      assessmentDispatchContext(saved.value, session.id, admitted), { store, draftId: saved.value.binding!.draft.id,
        questionId: saved.value.binding!.question.id, purpose: 'assessor', ...(pilot ? { pilot } : {}) }, admitted.resultCapacity);
    if (applicationCapacityInput(store, saved, admitted, prompt, role, dispatch, profile).mandatoryEnvelope.prompt === actual.envelope.prompt) {
      admitted.resultCapacityPrompt = actual.envelope.prompt; break;
    }
    admitted.resultCapacityPrompt = actual.envelope.prompt;
    requireCondition(n < 3, 'research_capacity_configuration', 'The assessment admission has no stable prompt');
  }
  return admitted;
}
export function assessmentReplyFailure(store: Store, app: Application, payload: unknown) {
  const context = app.context;
  if (context.resultCapacityContract === undefined && context.resultCapacity === undefined) return null;
  requireCondition(context.resultCapacityContract === RESULT_CAPACITY, 'research_capacity_invalid', 'The assessment lost its capacity era');
  const saved = context.resultCapacity;
  if (!saved || typeof saved !== 'object' || (saved as any).contract !== RESULT_CAPACITY)
    throw new EngineError('research_capacity_invalid', 'The assessment lost its declared result capacity');
  const capacityFailure = researchResultFailure(saved, payload);
  if (capacityFailure) return capacityFailure;
  const subject = packetAssessmentSubject(context);
  if (subject?.assessment && object(payload) && !Object.hasOwn(payload,'action')) {
    try {
      requireAttemptsAssessmentReply(payload, subject);
      const session = exact<ApplicationSession>(store, app.session, 'assessment-session');
      const application = store.get<Application>(applicationId(app.session.id, app.session.revision), 1);
      if (!application || application.kind !== 'assessment-application')
        applicationInvalid(app.session.id, 'The assessment reply lost its original application');
      // This is M2's structural/evidence check, not P's semantic acceptance.
      // Exact sources are captured by evaluateApplication's shared read view.
      checkDiscoveryAssessmentForm(store, {...payload,contract:subject.assessment.contract,projectId:app.projectId,
        subject:{kind:'attempts',packet:subject.packet},baseline:subject.baseline,
        session:app.session,application:reference(application),environment:session.value.binding!.environment,assessor:app.role.actor});
    } catch(error) { if(error instanceof EngineError) return error; throw error; }
  }
  return null;
}

function applicationWrite(store: Store, session: Write, context: Record<string, any>, prompt: string, role: RoleBinding, dispatch: Environment, profile: Ref | null,
  guards: TransactionGuard[], previous: Ref | null = null, origin?: Ref, prior: Revision<Application> | null = null,
  recoveredRead?: Application['recoveredRead']): Write {
  context = admittedAssessmentContext(store, session, context, prompt, role, dispatch, profile, prior);
  const ref = pendingRef(session), value: Application = { contract: APPLICATION, projectId: (session.value as Session).projectId,
    session: ref, context: JSON.parse(JSON.stringify(context)), prompt, role: JSON.parse(JSON.stringify(role)), dispatch: JSON.parse(JSON.stringify(dispatch)), profile,
    guards: uniqueTransactionGuards(guards), previous, ...(origin ? { origin } : {}),
    ...(recoveredRead ? { recoveredRead } : {}),
    resolution: null, state: 'prepared', call: null, after: null, received: null, refusal: null };
  return { id: (session.value as ApplicationSession).application, kind: 'assessment-application', expected: 0, value };
}

function paidOriginWrite(store: Store, id: string, input: AssessmentPaidOriginInput, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, context: Record<string, any>, prompt: string, dispatch: Environment,
  profile: Ref | null, guards: TransactionGuard[]): Write {
  const value: AssessmentPaidOrigin = { contract: input.materialContract === STAGE_NEIGHBOR_CONTEXT ? NEIGHBOR_ORIGIN : PAID_ORIGIN, projectId: draft.value.projectId, session: id,
    application: applicationId(id, 1),
    pending: input.pending, root: input.root, graph: input.graph, legacyPaths: JSON.parse(canonical(input.legacyPaths)),
    reads: JSON.parse(canonical(input.reads)), runtime: JSON.parse(canonical(input.runtime)),
    runtimeAdmission: JSON.parse(canonical(input.runtimeAdmission)),
    draft: reference(draft), question: reference(question),
    environment: reference(environment), inputs: draft.value.inputs, context: JSON.parse(canonical(context)), prompt,
    role: JSON.parse(canonical(dispatch.reviewer)), dispatch: JSON.parse(canonical(dispatch)), profile,
    guards: uniqueTransactionGuards(guards) };
  checkAssessmentRuntimeOrigin(store, value.projectId, input.pending, question, value.context, value.runtime, value.runtimeAdmission, id, true);
  return { id: paidOriginId(draft.value.projectId, input.pending.id), kind: 'assessment-paid-origin', expected: 0, value };
}

function currentAdmission(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, environment: Revision<Environment>,
  context: Record<string, any>, extraGuards: TransactionGuard[], correctionBarrier?: Ref): TransactionGuard[] {
  const effective = new Environments(store).effective(draft.value.projectId), configured = store.get(`reader-pilot:${draft.value.projectId}`);
  return uniqueTransactionGuards([correctionBarrier ?? barrierGuard(draft.value.projectId, reference(question)), ...effective.guards, ...effective.admissionGuards,
    ...(configured ? [reference(configured)] : [{ id: `reader-pilot:${draft.value.projectId}`, absent: true } as const]),
    reference(draft), reference(question), reference(environment), ...draft.value.inputs, ...context.observations.map((o: any) => o.source), ...extraGuards]);
}
function increasedPilot(store: Store, oldRef: Ref | null, next: Ref | null): boolean {
  if (!oldRef || !next || oldRef.id !== next.id || oldRef.revision >= next.revision) return false;
  const before = exact<ReaderPilot>(store, oldRef, 'reader-pilot').value, after = exact<ReaderPilot>(store, next, 'reader-pilot').value;
  const limits = ['maxCalls', 'maxReportedTokens', 'maxRequestChars', 'maxReadChars', 'maxReplyChars', 'maxExtractedChars', 'maxContinuationChars', 'callTimeoutMs'];
  const fixed = (value: ReaderPilot) => Object.fromEntries(Object.entries(value).filter(([key]) => !limits.includes(key)));
  if (!same(fixed(before), fixed(after))) return false;
  let increased = false;
  for (const key of limits) {
    const a = (before as unknown as Record<string, unknown>)[key], b = (after as unknown as Record<string, unknown>)[key];
    if (a === undefined && b === undefined) continue;
    if (typeof a !== 'number' || typeof b !== 'number' || b < a) return false;
    if (b > a) increased = true;
  }
  return increased;
}
function executionOutcome(store: Store, app: Application, call: Ref) {
  const session = exact<ApplicationSession>(store, app.session, 'assessment-session'), binding = session.value.binding!;
  try {
    const outcome = readResearchExecution(store, app.projectId, call, session,
      exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft'), exact<Question>(store, binding.question, 'question'), app.role, app.profile);
    requirePhysicalIdentity(exact<ModelCall>(store, app.call!, 'model-call'), outcome.call);
    const bounded = outcome.subject.working?.deliveryContract === 'research-delivery/v1';
    const correction = bounded && app.previous ? assessmentCorrection(store, app, session.value,
      exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft'),
      exact<Question>(store, binding.question, 'question')) : null;
    const feedback = app.context.resultCapacityCorrection ?? correction;
    const expectsFailures = feedback !== null || Object.hasOwn(app.context, 'failures');
    if (!Object.keys(app.context).filter(key => !bounded || key !== 'failures')
      .every(key => Object.hasOwn(outcome.body, key) && same(outcome.body[key], app.context[key]))
      || bounded && (Object.hasOwn(outcome.body, 'failures') !== expectsFailures
        || expectsFailures && !same(outcome.body.failures, feedback ? [feedback] : app.context.failures)))
      applicationInvalid(session.id, 'The exact execution has a foreign original context');
    if (app.context.resultCapacityContract !== undefined && outcome.kind === 'response'
      && (!same(outcome.subject.resultCapacity, app.context.resultCapacity)
        || !same(outcome.body.resultCapacity, app.context.resultCapacity)))
      applicationInvalid(session.id, 'The assessment request lost its saved capacity');
    return outcome;
  } catch (error) {
    if (error instanceof EngineError) applicationInvalid(session.id, `Physical outcome is not proved: ${error.code}`);
    throw error;
  }
}

/** Derive the next correction from saved predecessor applications. The paid
 * wire reader and the dispatcher use the same proof, including the exact
 * refused call and context coverage that produced the feedback. */
function assessmentCorrection(store: Store, app: Application, before: Session,
  sourceDraft: Revision<DiscoveryDraft>, sourceQuestion: Revision<Question>): Record<string, unknown> | null {
  let predecessor = app.previous;
  while (predecessor) {
    const previous = exact<Application>(store, predecessor, 'assessment-application');
    if (previous.value.state === 'refused' && app.recoveredRead?.contract === 'assessment-read-recovery/v1'
      && same(app.recoveredRead.refusal, predecessor)) {
      const reason = previous.value.refusal;
      if (reason?.kind !== 'response' || reason.code !== 'context_read_limit')
        applicationInvalid(previous.id, 'The corrected read lost its exact size refusal');
      const old = applicationResponse(store, previous.value, reason.call);
      const requested = researchAction(old.payload);
      if (requested.action !== 'read_context')
        applicationInvalid(previous.id, 'Only an addressed read has this recovery door');
      const configured = app.profile ? exact<ReaderPilot>(store, app.profile, 'reader-pilot') : null;
      return { contract: 'assessment-read-correction/v1', role: 'assessor',
        attempt: predecessor, call: reason.call, code: reason.code, requested,
        envelopeLimitChars: configured?.value.maxRequestChars ?? 300000,
        instruction: 'Read the same exact record and pointer with a smaller page. For an object use page encoding canonical-json; continue at page.next. The earlier call and candidate are saved.' };
    }
    if (previous.value.state !== 'renewed') break;
    if (previous.value.call && previous.value.resolution) {
      const outcome = requireRetryable(store, previous.value);
      if (outcome.kind === 'response') {
        const failure = assessmentReplyFailure(store, previous.value, outcome.payload)
          ?? correctableAssessmentReply(sourceDraft, sourceQuestion, before, app.context,
            outcome.subject, outcome.payload);
        if (failure) {
          if (failure.code === 'research_context_incomplete') return { contract: 'assessment-context-correction/v1', role: 'assessor',
            attempt: predecessor, call: previous.value.received, code: failure.code,
            details: failure.details, instruction: 'The previous final verdict did not receive all saved context. Read the exact record and pointer at next, using a smaller addressed page. The candidate and prior call remain saved.' };
          const correction = earlyResearchCorrection('assessor', failure, predecessor, sourceQuestion.value);
          const subject = packetAssessmentSubject(app.context);
          if (subject?.assessment) correction.responseContract = {
            schema: assessmentQuestionContract(subject).schema,
            instruction: 'Correct only the attempts assessment reply, including novelty and methodology; preserve the exact packet, baseline and supplied material cursor.' };
          return correction;
        }
      }
    }
    predecessor = previous.value.previous;
  }
  return null;
}
/** Dispatch and physical replay share the exact prepared application, including
 * predecessor feedback and independence from every proven packet producer. */
export function readAssessmentDispatchAdmission(store: Store, applicationRef: Ref) {
  const raw = exact<Application>(store, applicationRef, 'assessment-application');
  const session = exact<ApplicationSession>(store, raw.value.session, 'assessment-session');
  const application = readApplication(store, session, applicationRef), app = application.value;
  if (application.revision !== 1 || app.state !== 'prepared')
    applicationInvalid(application.id, 'Dispatch admission needs its exact original prepared application');
  requireAttemptsAssessorIndependence(store, app.context, app.role.actor);
  const binding = session.value.binding!;
  const correction = assessmentCorrection(store, app, session.value,
    exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft'),
    exact<Question>(store, binding.question, 'question'));
  return { application, session, environment: binding.environment, role: app.role, dispatch: app.dispatch,
    profile: app.profile, prompt: assessmentRolePrompt(app.prompt),
    context: assessmentDispatchContext(session.value, session.id, app.context, correction) };
}
function requireRetryable(store: Store, app: Application) {
  if (!app.received) applicationInvalid(app.session.id, 'A failed attempt needs its exact physical outcome');
  const outcome = executionOutcome(store, app, app.received);
  if (outcome.kind === 'provider-failed') return outcome;
  if (outcome.kind === 'terminal' && outcome.code === 'process_output_limit') {
    if (app.state === 'renewed' && !readLimitedCallRetryPermit(store, outcome.call, reference(exact(store, outcome.call.value.assessmentApplication!, 'assessment-application'))))
      applicationInvalid(app.session.id, 'An output-limit renewal needs its exact explicit permission');
    return outcome;
  }
  if (outcome.kind === 'terminal'
    && ['run_stopped', 'run_control_changed', 'process_cancelled'].includes(outcome.code)) return outcome;
  if (outcome.kind === 'response' && ['model-refused', 'renewed'].includes(app.state)
    && app.replyOutcomeContract === EARLY_RESEARCH_OUTCOME && app.resolution) {
    const before = exact<ApplicationSession>(store, app.session, 'assessment-session'), binding = before.value.binding!;
    const draft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft');
    const question = exact<Question>(store, binding.question, 'question');
    assessmentPacket(before.value, app.context, outcome.subject);
    const failure = assessmentReplyFailure(store, app, outcome.payload) ?? correctableAssessmentReply(draft, question, before.value, app.context,
      outcome.subject, outcome.payload);
    const derived = evaluateApplication(store, app, before, draft, question, outcome, app.resolution);
    if (failure && derived.failure instanceof EngineError
      && same([failure.code, failure.message, failure.details ?? null],
        [derived.failure.code, derived.failure.message, derived.failure.details ?? null])) return outcome;
  }
  applicationInvalid(app.session.id, 'The exact physical outcome does not prove a retryable failure');
}
function renewApplication(store: Store, record: Revision<Application>, session: Revision<ApplicationSession>, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined,
  context: Record<string, any>, prompt: string, extraGuards: TransactionGuard[]): void {
  const app = record.value, profile = pilot ? reference(pilot) : null, before = session.value.binding!;
  const barrier = readBarrier(store, app.projectId, before.question);
  if (barrier && !permitsAssessmentCorrection(store, barrier, app)) barrierRefusal(store, barrier);
  if (!same([withoutResultCapacity(app.context), app.prompt, before.draft, before.question, before.inputs],
    [withoutResultCapacity(context), prompt, reference(draft), reference(question), draft.value.inputs]))
    applicationInvalid(record.id, 'Renewal cannot carry a cursor across different candidate, sources or context');
  const unsent = app.state === 'prepared' && app.call === null;
  const retained = unsent ? app.guards.filter(guard => guard.id !== app.profile?.id) : [];
  if (unsent) {
    if (!increasedPilot(store, app.profile, profile) || !same([app.role, app.dispatch, before.environment], [dispatch.reviewer, dispatch, reference(environment)]))
      applicationInvalid(record.id, 'Only a compatible explicit limit increase can replace an unsent intent');
  } else if (!['retryable', 'model-refused'].includes(app.state)) applicationInvalid(record.id, 'Only an unsent intent or proved provider failure may be renewed');
  const physical = unsent ? null : requireRetryable(store, app);
  const limitedPermit = physical?.kind === 'terminal' && physical.code === 'process_output_limit'
    ? readLimitedCallRetryPermit(store, physical.call, physical.call.value.assessmentApplication!) : null;
  if (physical?.kind === 'terminal' && physical.code === 'process_output_limit' && !limitedPermit)
    throw new EngineError('process_output_limit', `[${physical.call.id}] Permit one new bounded attempt with permit-limited-call-retry`, { call: reference(physical.call) });
  const guards = uniqueTransactionGuards([...currentAdmission(store, draft, question, environment, context, extraGuards, barrier ? reference(barrier) : undefined), ...retained]);
  if (pilot && !guards.some(guard => same(guard, reference(pilot)))) applicationInvalid(record.id, 'The new profile must be the currently configured admission');
  // DRY6-02 returns 1–2: an attempt whose original basis moved is never renewed on the old basis, whichever renewable
  // state it is in; the moved record is the proved dependency refusal of this exact application, and so carries its
  // recovery door. The basis is the transitive one of the check that failed: every record that check itself read at its
  // head — the Source an observation cites, the Source of a prior reader-result's observation behind an immutable
  // container — matched against the application's original guards. A correction barrier, a raised profile or a
  // reconfigured environment of a retry is not read by these checks and is never named. No moved basis record — the
  // check's own failure stands (bytes changed on disk under the same Source record invent no witness).
  const refuseMoved = (read: TransactionGuard[]) => {
    const basis = new Set(read.map(guard => guard.id));
    const changed = changedDependency(store, app.guards.filter(guard => basis.has(guard.id)));
    if (changed) refuseApplication(store, record, changed.reason, changed.guards);
  };
  const checked = evaluateWorkspace(store, session);
  if (checked.failure) { refuseMoved(checked.guards); throw checked.failure; }
  const evidence = assessmentReadView(store);
  for (const observation of context.observations) if (!new Evidence(evidence.store).verify(observation)) {
    evidence.finish(); refuseMoved(evidence.guards);
    throw new EngineError('research_context_application_source_stale', 'Renewal must preserve the exact supported observations');
  }
  evidence.finish();
  const admitted = uniqueTransactionGuards([...guards, ...checked.guards, ...evidence.guards]);
  const next: Write = { id: session.id, kind: session.kind, expected: session.revision, value: { ...session.value,
    application: applicationId(session.id, session.revision + 1), binding: { draft: reference(draft), question: reference(question), environment: reference(environment), inputs: draft.value.inputs } } };
  const renewed: Write = { id: record.id, kind: record.kind, expected: record.revision, value: { ...app, state: 'renewed', after: pendingRef(next) } };
  store.writeMany([next, renewed, applicationWrite(store, next, context, prompt, dispatch.reviewer, dispatch, profile, admitted, pendingRef(renewed), app.origin, record)],
    uniqueTransactionGuards([reference(record), reference(session), ...admitted, ...(physical ? [reference(physical.call)] : []), ...(limitedPermit ? [reference(limitedPermit)] : [])]));
}

/** Read-only scope for the operator's physical retry door. The normal
 * application reader supplies identity, cursor and paid-origin proofs. */
export function limitedAssessmentRetryScope(store: Store, call: Revision<ModelCall>): { consumer: Ref; guards: TransactionGuard[] } {
  requireCondition(isRef(call.value.assessmentApplication), 'limited_call_retry_invalid', `[${call.id}] The call has no bound assessment operation`);
  const origin = exact<Application>(store, call.value.assessmentApplication, 'assessment-application');
  const session = store.get<ApplicationSession>(origin.value.session.id);
  requireCondition(session?.kind === 'assessment-session' && session.value.application === origin.id,
    'limited_call_retry_stale', `[${call.id}] The assessment cursor has advanced`);
  const app = readApplication(store, session);
  requireCondition(['running', 'retryable'].includes(app.value.state) && app.value.call?.id === call.id,
    'limited_call_retry_stale', `[${call.id}] The assessed candidate is no longer the current attempt`);
  const outcome = executionOutcome(store, app.value, reference(call)), binding = session.value.binding!;
  requireCondition(outcome.kind === 'terminal' && outcome.code === 'process_output_limit' && outcome.response === null,
    'limited_call_retry_invalid', `[${call.id}] The bound operation has no proved output-limit terminal`);
  return { consumer: reference(origin), guards: uniqueTransactionGuards([reference(app), reference(session), binding.draft, binding.question, ...binding.inputs, ...app.value.guards]) };
}

/** A historical paid read that exceeded the declared B reading limit keeps
 * its refused terminal. A new B application follows the same cursor and
 * candidate; no analyst answer or old assessor call is dispatched again. */
function continueRefusedAssessmentRead(store: Store, record: Revision<Application>,
  session: Revision<ApplicationSession>): boolean {
  const app = record.value, refusal = app.refusal;
  if (app.state !== 'refused' || refusal?.kind !== 'response'
    || refusal.code !== 'context_read_limit') return false;
  const barrier = readBarrier(store, app.projectId, session.value.binding!.question);
  if (!barrier || !same(barrier.value.refusal, reference(record)) || barrier.value.completion)
    return false;
  const paid = applicationResponse(store, app, refusal.call);
  const action = researchAction(paid.payload);
  if (action.action !== 'read_context') return false;
  const guards = uniqueTransactionGuards([...app.guards.filter(guard => guard.id !== barrier.id),
    reference(barrier), reference(record), refusal.call]);
  const next: Write = { id: session.id, kind: session.kind, expected: session.revision,
    value: { ...session.value, application: applicationId(session.id, session.revision + 1) } };
  const successor = applicationWrite(store, next, app.context, app.prompt, app.role, app.dispatch,
    app.profile, guards, reference(record), app.origin, record,
    { contract: 'assessment-read-recovery/v1', refusal: reference(record), call: refusal.call });
  store.writeMany([next, successor], uniqueTransactionGuards([reference(session), reference(record),
    reference(barrier), ...guards]));
  return true;
}

type DirectAssessmentMaterials = { context: Record<string, any>; prompt: string; guards: TransactionGuard[] };

/** A direct caller has no paid-origin. Its existing application owns the material era and original context. */
export function readDirectAssessmentMaterials(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, basis: Record<string, any>, legacyPrompt: string): DirectAssessmentMaterials | null {
  const legacyId = `assessment-session:${hashJson([reference(question), reference(environment), draft.value.inputs, basis])}`;
  const legacy = store.get<Session>(legacyId);
  if (legacy && !assessmentSessionEra(legacy) && !legacy.value.result)
    return { context: basis, prompt: legacyPrompt, guards: [reference(draft)] };
  const matches = store.list<ApplicationSession>('assessment-session').filter(session => {
    const binding = session.value.binding;
    return session.id.startsWith('assessment-session:v1:') && isRef(binding?.draft) && binding.draft.id === draft.id
      && same(binding.question, reference(question)) && same(binding.environment, reference(environment))
      && same(binding.inputs, draft.value.inputs);
  }).flatMap<DirectAssessmentMaterials>(session => {
    const current = readApplication(store, session, undefined, true);
    if (!current) { pendingAttemptsContinuation(store, session); return []; }
    const app = current.value;
    // Only an unfinished attempt can select the recovery branch. Completed
    // applications are selected by the caller's full current context instead.
    if (app.state === 'applied') return [];
    const { assessmentContextContract, stageNeighbors: _neighbors, ...original } = withoutResultCapacity(app.context);
    if (!same(original, basis)) return [];
    if (assessmentContextContract !== undefined && assessmentContextContract !== STAGE_NEIGHBOR_CONTEXT)
      applicationInvalid(session.id, 'The direct producer names an unknown assessment material contract');
    if (assessmentContextContract === STAGE_NEIGHBOR_CONTEXT && !object(app.context.stageNeighbors))
      applicationInvalid(session.id, 'The direct producer lost its declared neighbor material');
    return [{ context: app.context, prompt: app.prompt, guards: app.guards }];
  });
  if (matches.length > 1) applicationInvalid(question.id, 'Several direct sessions claim this exact question, candidate and basis');
  return matches[0] ?? null;
}

async function assessmentSessionInternal(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined, context: Record<string, any>,
  prompt: string, signal?: AbortSignal, extraGuards: TransactionGuard[] = [], paidInput?: AssessmentPaidOriginInput, stopAfterPaid = false): Promise<{
    result: unknown; terminal: Ref | null; applied: Ref | null;
  }> {
  const savedOrigin = paidInput && draft?.value?.projectId
    ? readAssessmentPaidOrigin(store, draft.value.projectId, paidInput.pending) : null;
  if (savedOrigin) {
    const saved = savedOrigin.value;
    draft = exact<DiscoveryDraft>(store, saved.draft, 'discovery-draft');
    question = exact<Question>(store, saved.question, 'question');
    environment = exact<Environment>(store, saved.environment, 'environment');
    dispatch = saved.dispatch;
    // The caller's current profile is needed only for the existing compatible
    // unsent-limit renewal. Every paid response and historical application uses
    // app.profile, never this fresh profile or a rebuilt candidate context.
    context = saved.context;
    prompt = saved.prompt;
    paidInput = saved;
  }
  if (!store || typeof store.get !== 'function' || !isRef(draft) || !draft.value || !isRef(question) || !question.value
    || !isRef(environment) || !environment.value || !dispatch?.reviewer || !context || !Array.isArray(context.observations)
    || !Object.hasOwn(context, 'value') || typeof prompt !== 'string' || !Array.isArray(extraGuards) || pilot !== undefined && !isRef(pilot)
    || !Array.isArray(draft.value.inputs) || !draft.value.inputs.every(isRef) || !Array.isArray(draft.value.questions)
    || question.value.draftId !== draft.id || !draft.value.questions.includes(question.id)
    || environment.value.projectId !== draft.value.projectId || question.value.projectId !== draft.value.projectId
    || !context.observations.every((observation: unknown) => object(observation) && isRef(observation.source)
      && object(observation.selector) && Object.hasOwn(observation, 'value') && observation.projectId === draft.value.projectId))
    applicationInvalid('assessment-session', 'Complete session sources, context and transaction dependencies are required');
  uniqueTransactionGuards(extraGuards);
  if (paidInput) {
    if (!isRef(paidInput.pending) || typeof paidInput.root !== 'string' || !isAbsolute(paidInput.root)
      || normalize(paidInput.root) !== paidInput.root || !(paidInput.graph === null || isRef(paidInput.graph))
      || dispatch.workspace !== paidInput.root
      || !Array.isArray(paidInput.legacyPaths) || !paidInput.legacyPaths.every(item => object(item)
        && typeof item.path === 'string' && item.path.length > 0 && typeof item.resolved === 'string'
        && isAbsolute(item.resolved) && normalize(item.resolved) === item.resolved)
      || !object(paidInput.reads) || paidInput.reads.contract !== 'assessment-read/v1'
      || !Array.isArray(paidInput.reads.reads) || !Array.isArray(paidInput.reads.files)
      || !object(paidInput.runtime) || !Array.isArray(paidInput.runtime.proofs)
      || !Array.isArray(paidInput.runtime.supporting) || !Array.isArray(paidInput.runtime.guards)
      || !Array.isArray(paidInput.runtime.admissionGuards)
      || !object(paidInput.runtimeAdmission) || paidInput.runtimeAdmission.contract !== RUNTIME_ADMISSION)
      applicationInvalid('assessment-paid-origin', 'Complete frozen paid assessment materials are required');
    exact(store, paidInput.pending, 'research-turn');
    if (paidInput.graph) exact(store, paidInput.graph, 'graph');
  }
  const basis = JSON.parse(JSON.stringify(withoutResultCapacity(context)));
  const legacyId = `assessment-session:${hashJson([reference(question), reference(environment), draft.value.inputs, basis])}`;
  const id = paidInput
    ? recoveryAssessmentSessionId(paidSessionId(draft.value.projectId, paidInput.pending.id))
    : managedSessionId(reference(question), basis);
  const existing = store.get<Session>(isResponseRecovery() ? id : legacyId);
  if (!paidInput && existing && !assessmentSessionEra(existing))
    return { result: await legacyAssessmentSession(store, draft, question, environment, dispatch, pilot,
      context, prompt, signal, extraGuards), terminal: null, applied: null };
  let session = store.get<ApplicationSession>(id);
  if (!session) {
    if (isResponseRecovery()) applicationInvalid(id, 'The selected recovery session is missing');
    requireAttemptsAssessorIndependence(store, basis, dispatch.reviewer.actor);
    const barrier = readBarrier(store, draft.value.projectId, reference(question));
    if (barrier && !barrier.value.completion) barrierRefusal(store, barrier);
    const guards = uniqueTransactionGuards([...currentAdmission(store, draft, question, environment, context, extraGuards, barrier ? reference(barrier) : undefined),
      ...(paidInput ? [paidInput.pending, ...(paidInput.graph ? [paidInput.graph] : []),
        ...paidInput.runtime.guards, ...paidInput.runtime.admissionGuards] : [])]);
    const write: Write = { id, kind: 'assessment-session', expected: 0, value: { projectId: draft.value.projectId,
      offset: 0, notes: [], focus: null, result: null, contract: APPLICATION, application: applicationId(id, 1),
      binding: { draft: reference(draft), question: reference(question), environment: reference(environment), inputs: draft.value.inputs } } };
    // Prove the supplied paid materials before the real packer reads them. Admission
    // metadata cannot turn a foreign report/question into a packet-format failure.
    const originWrite = paidInput ? paidOriginWrite(store, id, paidInput, draft, question, environment, basis, prompt, dispatch,
      pilot ? reference(pilot) : null, guards) : null;
    const admittedBasis = admittedAssessmentContext(store, write, basis, prompt, dispatch.reviewer, dispatch, pilot ? reference(pilot) : null);
    if (originWrite) (originWrite.value as AssessmentPaidOrigin).context = JSON.parse(canonical(admittedBasis));
    // M+S1/A1 are written atomically under the absence of this turn's technical
    // refusal; the refusal write carries the symmetric absence of M (№2000-10).
    try { store.writeMany([write, applicationWrite(store, write, admittedBasis, prompt, dispatch.reviewer, dispatch,
      pilot ? reference(pilot) : null, guards, null, originWrite ? pendingRef(originWrite) : undefined),
      ...(originWrite ? [originWrite] : [])],
      uniqueTransactionGuards([...guards, ...(originWrite ? [{ id: proposalRefusalId(draft.value.projectId, paidInput!.pending.id), absent: true as const }] : [])])); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'revision_conflict' || !store.get(id)) throw error;
    }
    session = store.get<ApplicationSession>(id)!;
  }
  const admittedApplication = readApplication(store, session, undefined, true);
  const modelRetryPermit = admittedApplication?.value.state === 'model-refused' ? reference(admittedApplication) : null;
  for (;;) {
    recoveredResponseBoundary();
    session = store.get<ApplicationSession>(id)!;
    if (!session) applicationInvalid(id, 'The session disappeared');
    const application = readApplication(store, session, undefined, true);
    if (!application) {
      prepareAttemptsContinuation(store, session);
      continue;
    }
    const app = application.value;
    if (app.state === 'refused') {
      if (continueRefusedAssessmentRead(store, application, session)) continue;
      throwApplicationRefusal(application);
    }
    if (app.state === 'applied') {
      if (!session.value.result) applicationInvalid(id, 'An applied terminal session has no result');
      proveAppliedAssessment(store, application, session);
      return { result: session.value.result, terminal: reference(session), applied: reference(application) };
    }
    try {
      if (app.state === 'model-refused') {
        if (!modelRetryPermit || !same(modelRetryPermit, reference(application)))
          throw new EngineError('assessment_invalid', `[${application.id}] The erroneous reply needs a new external invocation`);
        renewApplication(store, application, session, draft, question, environment, dispatch, pilot, context, prompt, extraGuards);
        continue;
      }
      if (app.state === 'retryable') {
        renewApplication(store, application, session, draft, question, environment, dispatch, pilot, context, prompt, extraGuards);
        continue;
      }
      if (app.state === 'prepared') {
        const changed = changedDependency(store, app.guards);
        if (changed) {
          if (app.call === null && increasedPilot(store, app.profile, pilot ? reference(pilot) : null)) {
            renewApplication(store, application, session, draft, question, environment, dispatch, pilot, context, prompt, extraGuards);
            continue;
          }
          refuseApplication(store, application, changed.reason, changed.guards);
        }
        const binding = session.value.binding!;
        const sourceDraft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft');
        const sourceQuestion = exact<Question>(store, binding.question, 'question');
        const checked = evaluateWorkspace(store, session);
        if (checked.failure) {
          if (!(checked.failure instanceof EngineError)) throw checked.failure;
          refuseApplication(store, application, { kind: 'workspace', code: checked.failure.code }, checked.guards, [], checked.proof);
        }
        const before = session.value;
        const correction = assessmentCorrection(store, app, before, sourceDraft, sourceQuestion);
        try {
          await researchCall(app.role, app.dispatch, assessmentRolePrompt(app.prompt),
            assessmentDispatchContext(before, id, app.context, correction), signal,
            { store, draftId: sourceDraft.id, questionId: sourceQuestion.id, purpose: 'assessor', ...(app.profile ? { pilot: exact<ReaderPilot>(store, app.profile, 'reader-pilot') } : {}), session: reference(session),
              application: reference(application),
              prepareCall: call => ({ writes: [{ id: application.id, kind: application.kind, expected: application.revision,
                value: { ...app, state: 'running', call: pendingRef(call) } }], guards: uniqueTransactionGuards([reference(application), reference(session!), ...app.guards, ...checked.guards]) }) });
        } catch (error) {
          const latest = store.get<Application>(application.id);
          if (!latest?.value.call) throw error;
          const physical = store.get<ModelCall>(latest.value.call.id);
          if (!physical || physical.value.status !== 'failed') throw error;
          // Receipt/failed execution is reconciled below, never dispatched again.
        }
        const latest = store.get<Application>(application.id);
        if (latest?.value.state === 'prepared') applicationInvalid(application.id, 'Transport returned without binding the physical call');
        continue;
      }
      const initial = exact<ModelCall>(store, app.call!, 'model-call'), call = store.get<ModelCall>(initial.id);
      if (!call) applicationInvalid(initial.id, 'The bound physical call is missing');
      requirePhysicalIdentity(initial, call);
      if (call.value.status === 'running') {
        try {
          const recovery = prepareModelCallRecovery(store, app.projectId, reference(call)), after = pendingRef(recovery.writes[0]!);
          refuseApplication(store, application, { kind: 'call', call: after, code: 'process_lost' }, recovery.guards, recovery.writes);
        } catch (error) {
          if (error instanceof EngineError && ['model_call_still_running', 'model_call_process_uncertain', 'model_call_identity_missing'].includes(error.code))
            throw new EngineError('research_context_application_running', `[${application.id}] ${error.message}`, { call: reference(call), cause: error.code });
          throw error;
        }
      }
      if (call.value.status === 'failed') {
        if (call.value.error === 'process_lost') {
          readModelCallRecovery(store, app.projectId, reference(call));
          refuseApplication(store, application, { kind: 'call', call: reference(call), code: 'process_lost' }, [reference(call)]);
        }
        // DRY6-02: a dispatched attempt the common stop cancelled (its saved stop link) is retryable — the next attempt is
        // admitted only after the explicit resume of that stop; any other cancellation or timeout stays a refusal.
        if (['process_timeout', 'process_cancelled'].includes(call.value.error ?? '') && !call.value.response
          && !(call.value.error === 'process_cancelled' && stopCancelledCall(store, call)))
          refuseApplication(store, application, { kind: 'call', call: reference(call), code: call.value.error! }, [reference(call)]);
        const outcome = executionOutcome(store, app, reference(call));
        if (outcome.kind === 'provider-failed' || outcome.kind === 'terminal') {
          store.writeMany([{ id: application.id, kind: application.kind, expected: application.revision,
            value: { ...app, state: 'retryable', received: reference(call) } }],
          // Recording the exact physical failure is independent of today's
          // admission. Renewal checks the fresh context before the next call.
          uniqueTransactionGuards([reference(application), reference(session), reference(outcome.call)]));
          throw new EngineError(outcome.kind === 'terminal' ? outcome.code : 'research_provider_failed',
            outcome.kind === 'terminal' && outcome.code === 'process_output_limit'
              ? `[${call.id}] Output exceeded the physical limit; permit-limited-call-retry admits one bounded attempt`
              : outcome.kind === 'terminal' && outcome.code === 'process_cancelled'
              ? `[${call.id}] The common stop cancelled the dispatched attempt; the explicit resume of that stop admits one new attempt`
              : outcome.kind === 'terminal'
              ? `[${call.id}] Control refused the request before dispatch; the exact unsubmitted attempt is preserved`
              : `[${call.id}] Provider failed without a research response; the exact attempt is preserved`);
        }
        applicationInvalid(call.id, 'A failed label contradicts the saved response');
      }
      const binding = session.value.binding!;
      const sourceDraft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft'), sourceQuestion = exact<Question>(store, binding.question, 'question');
      const response = applicationResponse(store, app, reference(call));
      // A paid attempts step judges or reads immutable packet/baseline bytes.
      // Today's admission controls another dispatch and P, not retention of this paid result.
      const attempts = packetAssessmentSubject(app.context)?.assessment !== undefined;
      const changed = attempts ? null : changedDependency(store, app.guards);
      if (changed) refuseApplication(store, application, changed.reason, [...changed.guards, reference(call)], [], null, reference(call));
      const advanced = evaluateApplication(store, app, session, sourceDraft, sourceQuestion, response);
      if (advanced.failure && !(advanced.failure instanceof EngineError)) throw advanced.failure;
      if (advanced.failure instanceof EngineError) {
        // Packet defects throw here before payload classification, rather than authorizing another model call.
        assessmentPacket(session.value, app.context, response.subject);
        const failure = assessmentReplyFailure(store, app, response.payload) ?? correctableAssessmentReply(sourceDraft, sourceQuestion, session.value, app.context,
          response.subject, response.payload);
        if (failure && same([failure.code, failure.message, failure.details ?? null],
          [advanced.failure.code, advanced.failure.message, advanced.failure.details ?? null])) {
          const refused: Write = { id: application.id, kind: application.kind, expected: application.revision,
            value: { ...app, state: 'model-refused', replyOutcomeContract: EARLY_RESEARCH_OUTCOME, received: reference(call), resolution: advanced.proof,
              ...(failure.code === RESULT_CAPACITY_REFUSAL ? { resultCapacityRefusal: failure.details as Record<string, unknown> } : {}) } };
          const barrier = readBarrier(store, app.projectId, binding.question), absent = barrierGuard(app.projectId, binding.question);
          if (barrier && !permitsAssessmentCorrection(store, barrier, app)) barrierRefusal(store, barrier);
          store.writeMany([refused, ...refusalBarrierWrite(barrier, app, binding.question, refused)],
          uniqueTransactionGuards([reference(application), reference(session), reference(call), ...advanced.guards,
            barrier ? reference(barrier) : absent]));
          throw new EngineError(failure.code, `[${application.id}] ${failure.message}`, { call: reference(call) });
        }
      }
      if (advanced.failure) refuseApplication(store, application, { kind: 'response', call: reference(call),
        code: advanced.failure instanceof EngineError ? advanced.failure.code : 'assessment_invalid' },
        [reference(call), ...advanced.guards], [], advanced.proof, reference(call));
      const terminal = Boolean(advanced.value!.result), nextValue: ApplicationSession = { ...advanced.value!, contract: APPLICATION,
        application: terminal ? application.id : applicationId(id, session.revision + 1) };
      const write: Write = { id, kind: session.kind, expected: session.revision, value: nextValue };
      markApplicationResponseRecovered(reference(call), reference(session));
      const recovered = recoverySessionWrites(write);
      const applied: Write = { id: application.id, kind: application.kind, expected: application.revision,
        value: { ...app, state: 'applied', after: pendingRef(write), received: reference(call), resolution: advanced.proof } };
      const barrier = terminal ? readBarrier(store, app.projectId, binding.question) : null;
      const release = barrier && !barrier.value.completion && object(nextValue.result)
        && (['insufficient', 'conflicting'].includes(nextValue.result.verdict) || attempts && nextValue.result.verdict === 'return')
        && permitsAssessmentCorrection(store, barrier, app)
        ? [{ id: barrier.id, kind: barrier.kind, expected: barrier.revision,
          value: { ...barrier.value, completion: pendingRef(applied) } } satisfies Write] : [];
      store.writeMany([write, applied, ...release,
        ...(!terminal && !attempts ? [applicationWrite(store, write, app.context, app.prompt, app.role, app.dispatch, app.profile, uniqueTransactionGuards([...app.guards, ...advanced.guards]), pendingRef(applied), app.origin, application)] : []), ...recovered.writes],
      uniqueTransactionGuards([reference(session), reference(application),
        ...(attempts ? [reference(call)] : [...app.guards, ...response.guards]),
        ...advanced.guards, ...recovered.guards]));
      markRecoveredSessionWritten(recovered);
      if (terminal || stopAfterPaid) return { result: nextValue.result, terminal: pendingRef(write), applied: pendingRef(applied) };
    } catch (error) {
      if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
      const latest = store.get<Application>(application.id), currentSession = store.get(id);
      if (latest && (!same(reference(latest), reference(application)) || currentSession && !same(reference(currentSession), reference(session)))) continue;
      // A failed application CAS must not turn a paid attempts response into
      // a refusal merely because today's admission changed. Retry only an
      // observed cursor change above; otherwise retain the exact paid step.
      if (packetAssessmentSubject(app.context)?.assessment && app.state === 'running') throw error;
      const changed = changedDependency(store, app.guards);
      if (changed) {
        const call = app.call ? store.get<ModelCall>(app.call.id) : null;
        if (call?.value.status === 'succeeded') {
          executionOutcome(store, app, reference(call));
          refuseApplication(store, application, changed.reason, [...changed.guards, reference(call)], [], null, reference(call));
        }
        // A concurrent reservation may have consumed the unsent intent; its
        // exact application revision, never a null label alone, chooses retry.
        refuseApplication(store, application, changed.reason, changed.guards);
      }
      throw error;
    }
  }
}

export async function assessmentSession(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined, context: Record<string, any>,
  prompt: string, signal?: AbortSignal, extraGuards: TransactionGuard[] = []): Promise<unknown> {
  return (await assessmentSessionInternal(store, draft, question, environment, dispatch, pilot, context, prompt,
    signal, extraGuards)).result;
}

/** The existing attempts carrier already saves native renewed applications
 * and exact refusal feedback. The addressed door only limits that same chain;
 * a successful page or a second malformed answer ends this correction. */
export function readAttemptAssessmentResponseCorrection(store:Store,project:string,rootRef:Ref) {
  const read=(ref:Ref):Revision<Application>=>{
    const row=exact<Application>(store,ref,'assessment-application');
    requireCondition(row.value.projectId===project && row.value.contract===APPLICATION,
      'research_response_retry_invalid','Select an attempts application of this project');
    const cursor=['applied','renewed'].includes(row.value.state)?row.value.after:row.value.session;
    requireCondition(isRef(cursor),'research_response_retry_invalid','The assessment lost its exact native cursor');
    return readApplication(store,exact<ApplicationSession>(store,cursor,'assessment-session'),ref);
  };
  const normalized=(ref:Ref):Revision<Application>=>{
    const row=read(ref);
    return row.value.state==='renewed'?read(reference(exact<Application>(store,
      {id:row.id,revision:row.revision-1,hash:store.get(row.id,row.revision-1)?.hash??''},'assessment-application'))):row;
  };
  const root=read(rootRef);
  requireCondition(root.value.state==='model-refused','research_response_retry_invalid',
    'Select the original paid form refusal of the attempts assessor');
  const outcome=(row:Revision<Application>)=>{
    if(!row.value.call)return null;
    const call=store.get<ModelCall>(row.value.call.id);
    return !call || call.value.status==='running'?null:executionOutcome(store,row.value,reference(call));
  };
  const failure=(row:Revision<Application>):EngineError|null=>{
    if(row.value.state!=='model-refused')return null;
    const paid=outcome(row);if(paid?.kind!=='response')return null;
    const before=exact<ApplicationSession>(store,row.value.session,'assessment-session'),binding=before.value.binding!;
    return assessmentReplyFailure(store,row.value,paid.payload)??correctableAssessmentReply(
      exact<DiscoveryDraft>(store,binding.draft,'discovery-draft'),exact<Question>(store,binding.question,'question'),
      before.value,row.value.context,paid.subject,paid.payload);
  };
  const session=store.get<ApplicationSession>(root.value.session.id);
  requireCondition(session?.kind==='assessment-session','research_response_retry_invalid','The native assessor session disappeared');
  const current=readApplication(store,session,undefined,true)??pendingAttemptsContinuation(store,session).previous;
  let latest=normalized(reference(current));
  const descendants:Revision<Application>[]=[];
  for(let row=latest;;) {
    descendants.push(row);
    if(row.id===root.id)break;
    requireCondition(row.value.previous && descendants.every(prior=>prior.id!==row.value.previous!.id),
      'research_response_retry_invalid','The selected refusal is not an ancestor of this assessor position');
    row=normalized(row.value.previous);
  }
  // Ordinary continuation may have advanced after the paid correction. Its
  // later applications cannot be bought or re-applied by this addressed door.
  latest=descendants.reverse().slice(1).find(row=>outcome(row)?.kind==='response')??latest;
  const chain=readResponseCorrectionChain(rootRef,{
    read,latest:()=>latest,
    previous:value=>value.previous?reference(normalized(value.previous)):null,
    follows:(before,after)=>before.session.id===after.session.id && same(
      [withoutResultCapacity(before.context),before.prompt,before.role,before.dispatch,before.profile],
      [withoutResultCapacity(after.context),after.prompt,after.role,after.dispatch,after.profile]),
    formFailure:failure,responseFreeFailure:row=>outcome(row)?.kind==='provider-failed',
  });
  return {...chain,latestFailure:failure(chain.latest)};
}

export async function retryAttemptAssessmentResponse(store:Store,project:string,root:Ref,restoreOnly:boolean) {
  const correction=readAttemptAssessmentResponseCorrection(store,project,root),app=correction.latest.value;
  if(!correction.retry) {
    if(app.state==='model-refused')throw correction.latestFailure??correction.failure;
    const terminal=app.after?exact<ApplicationSession>(store,app.after,'assessment-session').value.result:null;
    return {kind:terminal?'applied' as const:'pending' as const,root,application:reference(correction.latest),session:app.after??app.session};
  }
  if(restoreOnly)return {kind:'pending' as const,root,application:reference(correction.latest),session:app.session};
  const session=exact<ApplicationSession>(store,app.session,'assessment-session'),binding=session.value.binding!;
  const environment=exact<Environment>(store,binding.environment,'environment');
  const origin=app.origin?exact<AssessmentPaidOrigin>(store,app.origin,'assessment-paid-origin').value:undefined;
  const result=await assessmentSessionInternal(store,exact<DiscoveryDraft>(store,binding.draft,'discovery-draft'),
    exact<Question>(store,binding.question,'question'),environment,app.dispatch,
    app.profile?exact<ReaderPilot>(store,app.profile,'reader-pilot'):undefined,app.context,app.prompt,undefined,
    app.guards.filter(guard=>guard.id!==barrierGuard(project,binding.question).id),origin,true);
  const updated=readAttemptAssessmentResponseCorrection(store,project,root).latest;
  return {kind:result.result?'applied' as const:'pending' as const,root,application:reference(updated),session:updated.value.after??updated.value.session};
}

/** Prove one exact applied step; checkpoint and terminal steps share the same origin. */
export function readAssessmentApplicationOutcomeAt(store: Store, projectId: string, terminal: Ref, applied: Ref): {
  result: unknown; session: Ref; application: Ref; draft: Ref; question: Ref; environment: Ref; inputs: Ref[]; received: Ref;
  context: Record<string, any>; prompt: string; role: RoleBinding; dispatch: Environment; profile: Ref | null;
  origin: Ref | null;
} {
  if (!store || typeof store.get !== 'function' || typeof projectId !== 'string' || !projectId.trim()
    || !isRef(terminal) || !isRef(applied)) applicationInvalid('assessment-session', 'Exact terminal proof needs project, session and application');
  const session = exact<ApplicationSession>(store, terminal, 'assessment-session');
  if (session.value.projectId !== projectId || session.value.contract !== APPLICATION
    || !session.value.binding || !isRef(session.value.binding.question))
    applicationInvalid(terminal.id, 'The exact managed session has no application contract or question');
  const application = readApplication(store, session, applied);
  if (application.value.state !== 'applied' || !same(application.value.after, terminal)
    || !isRef(application.value.received))
    applicationInvalid(applied.id, 'The exact application did not produce this terminal result');
  proveAppliedAssessment(store, application, session);
  requireAttemptsAssessorIndependence(store, application.value.context, application.value.role.actor);
  return { result: session.value.result, session: terminal, application: applied,
    draft: session.value.binding.draft, question: session.value.binding.question,
    environment: session.value.binding.environment, inputs: session.value.binding.inputs,
    received: application.value.received,
    context: application.value.context, prompt: application.value.prompt, role: application.value.role,
    origin: application.value.origin ?? null,
    dispatch: application.value.dispatch, profile: application.value.profile };
}

/** Exact terminal proof; historical callers still require a completed result. */
export function readAssessmentSessionOutcomeAt(store: Store, projectId: string, terminal: Ref, applied: Ref) {
  const proof = readAssessmentApplicationOutcomeAt(store, projectId, terminal, applied);
  if (proof.result === null) applicationInvalid(terminal.id, 'The exact managed session has no terminal result');
  return proof;
}

/** Preserve the public result API while exposing the exact physical application to new managed producers. */
export async function assessmentSessionWithProof(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined,
  context: Record<string, any>, prompt: string, signal?: AbortSignal, extraGuards: TransactionGuard[] = [],
  origin?: AssessmentPaidOriginInput): Promise<{
    result: unknown; proof: ReturnType<typeof readAssessmentSessionOutcomeAt> | null;
  }> {
  const completed = await assessmentSessionInternal(store, draft, question, environment, dispatch, pilot,
    context, prompt, signal, extraGuards, origin);
  if (!completed.terminal || !completed.applied)
    return { result: completed.result, proof: null }; // A historical standalone session keeps its prior contract.
  const proof = readAssessmentSessionOutcomeAt(store, draft.value.projectId, completed.terminal, completed.applied);
  if (!same(proof.result, completed.result)) applicationInvalid(completed.terminal.id,
    'The terminal proof differs from the returned assessor result');
  return { result: completed.result, proof };
}

function applicationResponse(store: Store, app: Application, call: Ref) {
  const response = executionOutcome(store, app, call);
  if (response.kind !== 'response') applicationInvalid(app.session.id, 'A provider failure is not a received research response');
  return response;
}

function requirePhysicalIdentity(initial: Revision<ModelCall>, received: Revision<ModelCall>): void {
  const immutable = (value: ModelCall) => [value.projectId, value.draftId, value.purpose, value.requestId,
    value.profile, value.questionId, value.requested, value.request, value.packet];
  if (initial.id !== received.id || !same(immutable(initial.value), immutable(received.value)))
    applicationInvalid(initial.id, 'The physical call identity changed');
}
function evaluateWorkspace(store: Store, session: Revision<ApplicationSession>, proof?: AssessmentReadProof) {
  const inputs = assessmentReadView(store, proof);
  let failure: unknown;
  try {
    const draft = exact<DiscoveryDraft>(store, session.value.binding!.draft, 'discovery-draft');
    const workspace = contextWorkspace(session.value.workspace, session.value.focus);
    for (const entry of workspace.entries) requireCurrentPriorContext(inputs.store, draft, entry.result);
    requireCondition(!workspace.blocked, 'research_no_progress', workspace.blocked ?? 'Saved assessment is blocked');
  } catch (error) { failure = error; }
  inputs.finish();
  return { failure, proof: inputs.proof, guards: inputs.guards };
}
/** Markerless paid packets have two legal application eras. The frozen read
 * sequence, after the observation reads already consumed, identifies whether
 * that application read the paid archive's era discriminator. Select before
 * evaluation; neither failed replay nor today's archive head selects an era. */
function historicalAssessmentReadEra(paid: ReturnType<typeof applicationResponse>,
  inputs: ReturnType<typeof assessmentReadView>, saved: boolean): 'legacy' | undefined {
  if (!saved || paid.body.contextReadContract !== undefined || !object(paid.payload)
    || paid.payload.action !== 'read_context') return undefined;
  const archive = paid.subject.working?.archive, requested = paid.payload.record;
  if (!isRef(archive) || !isRef(requested)) return undefined;
  const reads = inputs.proof.reads.slice(inputs.position);
  const exactArchive = (entry: AssessmentReadProof['reads'][number]) => entry.id === archive.id
    && entry.revision === archive.revision && same(entry.ref, archive);
  // readPilotContext probes its target archive three times (checkpoint kind,
  // context kind, exact body). Only the transitional era adds a fourth probe
  // before them. For a different target the discriminator is the first read.
  const probes = requested.id === archive.id && requested.revision === archive.revision ? 4 : 1;
  const hasDiscriminator = reads.length >= probes && reads.slice(0, probes).every(exactArchive);
  return hasDiscriminator ? undefined : 'legacy';
}

function evaluateApplication(store: Store, app: Application, before: Revision<ApplicationSession>, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, paid: ReturnType<typeof applicationResponse>, proof?: AssessmentReadProof) {
  const inputs = assessmentReadView(store, proof);
  let value: Session | undefined, failure: unknown;
  try {
    for (const observation of app.context.observations) requireCondition(new Evidence(inputs.store).verify(observation),
      'research_context_application_source_stale', 'An original observation is no longer supported by its source');
    const pilot = app.profile ? exact<ReaderPilot>(store, app.profile, 'reader-pilot') : undefined;
    const capacityFailure = assessmentReplyFailure(inputs.store, app, paid.payload);
    if (capacityFailure) throw capacityFailure;
    const historicalReadEra = historicalAssessmentReadEra(paid, inputs, proof !== undefined);
    const advanced = advanceAssessment(inputs.store, draft, question, pilot, before.value, app.context, paid.subject, paid.payload,
      historicalReadEra);
    value = advanced.value; failure = advanced.failure;
  } catch (error) { failure = error; }
  inputs.finish();
  return { value, failure, proof: inputs.proof, guards: inputs.guards };
}
function proveAppliedAssessment(store: Store, application: Revision<Application>, after: Revision<ApplicationSession>) {
  const app = application.value, before = exact<ApplicationSession>(store, app.session, 'assessment-session'), binding = before.value.binding!;
  const draft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft'), question = exact<Question>(store, binding.question, 'question');
  const paid = applicationResponse(store, app, app.received!);
  if (!app.resolution) applicationInvalid(application.id, 'The applied transition has no frozen inputs');
  const advanced = evaluateApplication(store, app, before, draft, question, paid, app.resolution);
  const next = advanced.value && { ...advanced.value, contract: APPLICATION,
    application: advanced.value.result ? application.id : applicationId(after.id, after.revision) };
  if (advanced.failure || !next || !same(after.value, next))
    applicationInvalid(application.id, 'The saved result differs from the exact paid response');
  return advanced;
}
/** A paid intermediate attempts step commits before admitting another request.
 * Absence of the next application is legal only with this exact proven parent;
 * a missing initial application or an invented cursor remains a typed refusal. */
function pendingAttemptsContinuation(store: Store, session: Revision<ApplicationSession>) {
  if (session.kind !== 'assessment-session' || session.revision < 2 || !object(session.value) || session.value.contract !== APPLICATION
    || session.value.result !== null || session.value.application !== applicationId(session.id, session.revision))
    applicationInvalid(session.id, 'The missing application is not a pending attempts continuation');
  const previous = store.get<Application>(applicationId(session.id, session.revision - 1));
  if (!previous || !object(previous.value) || previous.value.state !== 'applied' || !packetAssessmentSubject(previous.value.context)?.assessment)
    applicationInvalid(session.id, 'The pending continuation lost its exact paid attempts parent');
  readApplication(store, session, reference(previous));
  const advanced = proveAppliedAssessment(store, previous, session);
  return { previous, guards: uniqueTransactionGuards([...previous.value.guards, ...advanced.guards]) };
}
function prepareAttemptsContinuation(store: Store, session: Revision<ApplicationSession>): void {
  const { previous, guards } = pendingAttemptsContinuation(store, session), app = previous.value;
  // Fresh admission is separate from paid application. Both this early check
  // and the atomic write protect the original plan/baseline; stale admission
  // never rewrites the preceding paid application or sends another call.
  requireCondition(transactionGuardsCurrent(store, guards), 'input_stale',
    `[${session.id}] The next assessment request needs its current original plan and baseline`);
  // applicationWrite uses this already-proven cursor for preflight only; the
  // existing session is neither reconstructed as authority nor written again.
  const cursor: Write = { id: session.id, kind: session.kind, expected: session.revision - 1, value: session.value };
  const next = applicationWrite(store, cursor, app.context, app.prompt, app.role, app.dispatch, app.profile,
    guards, reference(previous), app.origin, previous);
  store.writeMany([next], uniqueTransactionGuards([reference(session), reference(previous),
    { id: next.id, absent: true }, ...guards]));
}
function proveSessionOrigin(store: Store, record: Revision<Application>, before: Revision<ApplicationSession>): void {
  const app = record.value;
  if (app.previous === null) {
    const expected = { projectId: app.projectId, offset: 0, notes: [], focus: null, result: null, contract: APPLICATION,
      application: record.id, binding: before.value.binding };
    const expectedId = app.origin
      ? paidSessionId(app.projectId, exact<AssessmentPaidOrigin>(store, app.origin, 'assessment-paid-origin').value.pending.id)
      : `assessment-session:v1:${hashJson([before.value.binding!.question, withoutResultCapacity(app.context)])}`;
    if (before.revision !== 1 || before.id !== expectedId
      || !same(before.value, expected)) applicationInvalid(record.id, 'The initial session is not the declared initial cursor');
    return;
  }
  if (!isRef(app.previous)) applicationInvalid(record.id, 'A continuation needs its exact previous application');
  const previous = exact<Application>(store, app.previous, 'assessment-application');
  if (app.recoveredRead) {
    const recovery = app.recoveredRead, refusal = previous.value.refusal;
    const prior = exact<ApplicationSession>(store, previous.value.session, 'assessment-session');
    readApplication(store, prior, app.previous);
    const barrierRef = app.guards.find(guard => isRef(guard)
      && guard.id === barrierGuard(app.projectId, prior.value.binding!.question).id);
    const barrier = barrierRef && isRef(barrierRef)
      ? exact<AssessmentBarrier>(store, barrierRef, 'assessment-barrier') : null;
    const paid = refusal?.kind === 'response' ? applicationResponse(store, previous.value, refusal.call) : null;
    const action = paid ? researchAction(paid.payload) : null;
    const expectedGuards = barrier && refusal?.kind === 'response'
      ? uniqueTransactionGuards([...previous.value.guards.filter(guard => guard.id !== barrier.id),
        reference(barrier), app.previous, refusal.call]) : [];
    if (recovery.contract !== 'assessment-read-recovery/v1'
      || previous.value.state !== 'refused' || refusal?.kind !== 'response'
      || refusal.code !== 'context_read_limit' || action?.action !== 'read_context'
      || !same(recovery.refusal, app.previous) || !same(recovery.call, refusal.call)
      || !barrier || !same(barrier.value.refusal, app.previous) || barrier.value.completion
      || !same(before.value, { ...prior.value, application: record.id })
      || before.revision !== prior.revision + 1 || before.value.result !== null
      || !same([withoutResultCapacity(app.context), app.prompt, app.role, app.dispatch, app.profile, app.origin ?? null],
        [withoutResultCapacity(previous.value.context), previous.value.prompt, previous.value.role,
          previous.value.dispatch, previous.value.profile, previous.value.origin ?? null])
      || !same(app.guards, expectedGuards))
      applicationInvalid(record.id, 'The recovered read does not continue its exact refused assessment');
    return;
  }
  if (previous.value.state === 'renewed') {
    if (!same(previous.value.after, reference(before)) || previous.value.session.id !== before.id
      || previous.value.session.revision !== before.revision - 1)
      applicationInvalid(record.id, 'The renewal must preserve one exact preceding cursor');
    readApplication(store, before, app.previous);
    const prior = exact<ApplicationSession>(store, previous.value.session, 'assessment-session'), binding = prior.value.binding!;
    const expected = { ...prior.value, application: record.id, binding: before.value.binding };
    if (!same(before.value, expected) || before.value.result !== null
      || !same([withoutResultCapacity(previous.value.context), previous.value.prompt, binding.draft, binding.question, binding.inputs],
        [withoutResultCapacity(app.context), app.prompt, before.value.binding!.draft, before.value.binding!.question, before.value.binding!.inputs]))
      applicationInvalid(record.id, 'The renewed cursor changed applied pages or their original materials');
    if (previous.value.call === null) {
      if (!increasedPilot(store, previous.value.profile, app.profile)
        || !same([previous.value.role, previous.value.dispatch, binding.environment], [app.role, app.dispatch, before.value.binding!.environment])
        || previous.value.guards.filter(guard => guard.id !== previous.value.profile?.id)
          .some(guard => !app.guards.some(current => same(current, guard))))
        applicationInvalid(record.id, 'The unsent renewal must preserve all admission except its explicit increased limit');
    } else requireRetryable(store, previous.value);
    return;
  }
  if (previous.value.state !== 'applied' || !same(previous.value.after, reference(before))
    || previous.value.session.id !== before.id || previous.value.session.revision !== before.revision - 1
    || !same([withoutResultCapacity(previous.value.context), previous.value.prompt, previous.value.role, previous.value.dispatch, previous.value.profile],
      [withoutResultCapacity(app.context), app.prompt, app.role, app.dispatch, app.profile]))
    applicationInvalid(record.id, 'The prior application does not derive this exact continuation');
  readApplication(store, before, app.previous);
  const prior = proveAppliedAssessment(store, previous, before);
  if (!same(app.guards, uniqueTransactionGuards([...previous.value.guards, ...prior.guards])))
    applicationInvalid(record.id, 'The continuation lost the inputs read by its prior application');
}


/** A saved dossier is its own assessor subject; this era never enters the attempts state machine. */
export const DOSSIER_SESSION = 'dossier-session/v1' as const;
export const DOSSIER_APPLICATION = 'dossier-application/v1' as const;
const DOSSIER_PROMPT='Assess the exact saved dossier using its dossier-assessment-result/v1 schema. Read every required original and both sides; return supported or an addressed return, or read_context/assessment_checkpoint.';
export interface DossierAssessmentSession {
  [key:string]:unknown;
  contract:typeof DOSSIER_SESSION; projectId:string; subject:DossierAssessmentSubject;
  binding:{draft:Ref;question:Ref;environment:Ref;inputs:Ref[]}; role:RoleBinding; dispatch:Environment;
  profile:Ref|null; prompt:string; step:number; offset:0; notes:Json[]; workspace:ContextWorkspace;
  previous:Ref|null; application:string; result:DossierAssessmentProjection|null;
}
export interface DossierAssessmentApplication {
  [key:string]:unknown;
  contract:typeof DOSSIER_APPLICATION; projectId:string; session:Ref; context:Record<string,any>;
  prompt:string; role:RoleBinding; dispatch:Environment; profile:Ref|null; guards:TransactionGuard[];
  state:'prepared'|'running'|'applied'; call:Ref|null; received:Ref|null; after:Ref|null;
  dispatchGuards?: TransactionGuard[];
  responseCorrection?: ApplicationResponseCorrection;
}
const dossierSessionId=(subject:DossierAssessmentSubject)=>`dossier-session:v1:${hashJson([DOSSIER_SESSION,subject])}`;
const dossierApplicationId=(session:Ref)=>`dossier-application:v1:${hashJson([session.id,session.revision])}`;
function dossierRequire(condition:unknown,message:string):asserts condition { requireCondition(condition,'discovery_dossier_session_invalid',message); }
function dossierExact<T>(store:Store,ref:Ref,kind:string):Revision<T> {
  const row=exact<T>(store,ref,kind);
  dossierRequire(hashJson(row.value as never)===row.hash,'The exact dossier source body changed');
  return row;
}
function dossierMarker(session:Ref) {
  return {contract:DOSSIER_SESSION_TRANSPORT,session,application:dossierApplicationId(session),step:session.revision-1};
}
function dossierContext(session:Revision<DossierAssessmentSession>) {
  return {dossierSubject:session.value.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,
    ...(dossierMaterialEra(session.value) ? {dossierMaterialContract:DOSSIER_MATERIAL_CONTRACT} : {}),
    managedDossier:dossierMarker(reference(session)),dossierNotes:session.value.notes,
    contextWorkspace:(dossierMaterialEra(session.value) ? pendingDossierWorkspace(session.value.workspace) : session.value.workspace).entries.map(entry=>entry.result)};
}
/** Leaf proof shared with the physical reader. It never calls that reader or the full session history. */
function readOriginalDossierDispatchAdmission(store:Store, applicationRef:Ref) {
  const application=dossierExact<DossierAssessmentApplication>(store,applicationRef,'assessment-application'),app=application.value;
  dossierRequire(application.revision===1 && app.contract===DOSSIER_APPLICATION && isRef(app.session),
    'The dossier application needs its immutable prepared origin');
  const session=dossierExact<DossierAssessmentSession>(store,app.session,'assessment-session'),value=session.value;
  dossierRequire(value.contract===DOSSIER_SESSION && value.projectId===app.projectId && value.result===null && object(value.subject)
    && session.id===dossierSessionId(value.subject) && value.application===application.id
    && application.id===dossierApplicationId(reference(session)) && value.step===session.revision-1
    && value.offset===0 && Array.isArray(value.notes) && object(value.workspace)
    && Array.isArray(value.workspace.entries), 'The dossier session lost its own exact cursor');
  const dictionaryEra = dossierMaterialEra(value);
  dossierRequire(dictionaryEra === dossierMaterialEra(app.context), 'The dossier material era changed');
  const packet=app.context?.dossierPacket;
  dossierRequire(object(packet) && object(packet.basis) && object(packet.basis.draft) && isRef(packet.basis.draft.ref) && same(packet.subject,value.subject),'The dossier admission lost its saved complete packet');
  const first=dossierExact<DossierAssessmentSession>(store,{id:session.id,revision:1,hash:store.get(session.id,1)?.hash??''},'assessment-session');
  for(const key of ['contract','projectId','subject','binding','role','dispatch','profile','prompt'])
    dossierRequire(same(value[key],first.value[key]),'The original dossier runtime or subject changed');
  dossierRequire(first.value.step===0 && first.value.previous===null && first.value.result===null
    && same(first.value.notes,[]) && same(first.value.workspace,contextWorkspace()),'The dossier origin is not an initial session');
  dossierRequire(dictionaryEra === dossierMaterialEra(first.value), 'The original dossier material era changed');
  const binding=value.binding;
  dossierRequire(object(binding) && isRef(binding.draft) && isRef(binding.question) && isRef(binding.environment)
    && Array.isArray(binding.inputs) && binding.inputs.every(isRef),'The dossier lost its exact research binding');
  const draft=dossierExact<DiscoveryDraft>(store,binding.draft,'discovery-draft'),question=dossierExact<Question>(store,binding.question,'question');
  const environment=dossierExact<Environment>(store,binding.environment,'environment');
  const profile=value.profile===null?undefined:dossierExact<ReaderPilot>(store,value.profile,'reader-pilot');
  dossierRequire(draft.id===packet.basis.draft.ref.id && draft.value.projectId===app.projectId
    && question.id===packet.basis.plan?.value?.question && question.value.projectId===app.projectId && question.value.draftId===draft.id && draft.value.questions.includes(question.id)
    && same(draft.value.inputs,binding.inputs) && environment.value.projectId===app.projectId
    && same(value.dispatch,environment.value) && same(value.role,resolveRoleMode('reviewer',environment.value.reviewer,'research'))
    && (!profile || profile.value.projectId===app.projectId)
    && same(app.role,value.role) && same(app.dispatch,value.dispatch) && same(app.profile,value.profile)
    && app.prompt===value.prompt && app.state==='prepared' && app.call===null && app.received===null && app.after===null
    && Array.isArray(app.guards) && same(uniqueTransactionGuards(app.guards),app.guards),
    'The dossier application differs from its admitted project, runtime or profile');
  dossierRequire([binding.draft,binding.question,binding.environment,...binding.inputs,...(value.profile?[value.profile]:[])]
    .every(ref=>app.guards.some(guard=>same(guard,ref))),'The dossier admission lost a mandatory original guard');
  const marker=dossierSessionTransport(app.context);
  dossierRequire(marker && same(marker,dossierMarker(reference(session))) && same(app.context.dossierSubject,value.subject)
    && same(app.context.dossierPacket,packet) && same(app.context.dossierNotes,value.notes)
    && same(app.context.contextWorkspace??[],dossierContext(session).contextWorkspace)
    && (!dictionaryEra || same(app.context.dossierMaterial,dossierMaterialProjection(packet as any)))
    && same(app.context.assessmentDelivery,dossierTransportDelivery(app.context)),
    'The dossier application lost its exact subject, material or delivery cursor');
  // One accepted reply checker proves the entire saved capacity, not a caller declaration.
  requireDossierReplyCapacity(packet as any,app.context.resultCapacity,(record,pointer)=>readCapacityProjection(store,record,pointer));
  dossierRequire(same(app.context.resultCapacity.bindings.managedDossier,marker),
    'Dossier capacity must retain this exact managed cursor');
  return {application,session,packet,draft,question,environment,profile,context:app.context,
    role:value.role,dispatch:value.dispatch,prompt:value.prompt};
}
export function readDossierDispatchAdmission(store:Store,applicationRef:Ref):ReturnType<typeof readOriginalDossierDispatchAdmission> {
  const application=dossierExact<DossierAssessmentApplication>(store,applicationRef,'assessment-application');
  return correctingApplicationLeaf(store,application,ref=>readOriginalDossierDispatchAdmission(store,ref))
    ?? readOriginalDossierDispatchAdmission(store,applicationRef);
}
/** Saved new-send witnesses survive a caller retry without options. Historical proof
 * checks their form and binding, never their current heads. */
export function readDossierReservationAt(store: Store, applicationRef: Ref) {
  const admission = readDossierDispatchAdmission(store, applicationRef), application = admission.application;
  const running = dossierExact<DossierAssessmentApplication>(store,
    {id:application.id,revision:2,hash:store.get(application.id,2)?.hash??''},'assessment-application');
  dossierRequire(object(running.value), 'The dossier reservation must be a record');
  const additional = Object.hasOwn(running.value, 'dispatchGuards')
    ? uniqueTransactionGuards(checkTransactionGuards(running.value.dispatchGuards)) : [];
  dossierRequire(!Object.hasOwn(running.value, 'dispatchGuards') || same(additional, running.value.dispatchGuards),
    'The dossier reservation lost its normalized dispatch guards');
  dossierRequire(isRef(running.value.call) && same(running.value, {...application.value,state:'running',call:running.value.call,
    ...(Object.hasOwn(running.value,'dispatchGuards') ? {dispatchGuards:additional} : {})}),
    'The dossier reservation did not bind one exact physical call');
  return {running,guards:uniqueTransactionGuards([...application.value.guards,...additional])};
}
async function dossierPhysicalOutcome(store:Store, admission:Awaited<ReturnType<typeof readDossierDispatchAdmission>>, received:Ref) {
  const {session,draft,question,application}=admission;
  const {running}=readDossierReservationAt(store,reference(application));
  const initial=dossierExact<ModelCall>(store,running.value.call!,'model-call');
  const outcome=readResearchExecution(store,session.value.projectId,received,session,draft,question,admission.role,session.value.profile);
  requirePhysicalIdentity(initial,outcome.call);
  dossierRequire(outcome.kind==='response','A non-response cannot evaluate a dossier');
  if (dossierMaterialEra(session.value)) {
    const wire=outcome.subject;
    dossierRequire(dossierMaterialEra(wire) && !Object.hasOwn(wire,'dossierPacket')
      && (Object.hasOwn(wire,'dossierMaterial') ? same(wire.dossierMaterial,admission.context.dossierMaterial)
        : wire.working?.materialAddresses?.some((address:any) => address.field === 'dossierMaterial'
          && address.pointer === '/body/dossierMaterial' && address.valueHash === hashJson(admission.context.dossierMaterial))),
      'The paid packet lost its exact dictionary delivery');
  }
  return outcome;
}
async function projectDossierSession(store:Store,admission:Awaited<ReturnType<typeof readDossierDispatchAdmission>>,
  paid:Awaited<ReturnType<typeof dossierPhysicalOutcome>>) {
  const {session,application,draft,question}=admission,current=session.value;
  const checked=await checkDossierResearchReply(store,current.projectId,current.subject,application.value.context.resultCapacity,paid.payload);
  const dictionaryEra = dossierMaterialEra(current);
  let workspace=dictionaryEra ? pendingDossierWorkspace(current.workspace) : current.workspace,notes=current.notes,result:DossierAssessmentProjection|null=null;
  if(checked.terminal) {
    requireCompleteContextPacket(workspace,paid.subject);
    result=checked.projection;
    workspace=contextProgress(workspace,paid.subject);
  } else if(checked.kind==='read_context') {
    const action=researchAction(checked.normalized);
    dossierRequire(action.action==='read_context','A dossier lookup must retain its exact address');
    const addresses=paid.subject.working?.materialAddresses??[];
    dossierRequire((same(action.record,paid.archive) && (action.pointer==='/body/dossierPacket'
      || action.pointer==='/body/dossierReplyContract'
      || dictionaryEra && application.value.context.dossierMaterial.records.some((row:any) => row.technical
        && (action.pointer === row.technical.pointer || action.pointer.startsWith(row.technical.pointer+'/')))) || addresses.some((address:any)=>same(address.record,action.record)
        && (action.pointer===address.pointer || action.pointer.startsWith(address.pointer+'/')))),
      'The requested page is not an address of this paid dossier');
    const lookup=readResearchContextOutcomeAt(store,draft,question,action,admission.profile?.value.maxRequestChars??300000,'bounded');
    workspace=addContextLookup(workspace,lookup,paid.subject.contextWorkspace,undefined,paid.subject);
  } else {
    notes=[...notes,{archive:paid.archive,response:checked.normalized} as unknown as Json];
    workspace=contextProgress(workspace,paid.subject);
  }
  if (dictionaryEra) workspace = {...workspace, entries:[...current.workspace.entries,
    ...workspace.entries.filter(entry => !current.workspace.entries.some(prior => prior.key === entry.key))]};
  return {...current,step:current.step+1,workspace,notes,result,previous:reference(application),
    application:result?application.id:dossierApplicationId({id:session.id,revision:session.revision+1,hash:''})} satisfies DossierAssessmentSession;
}
/** Historical proof of every application in the saved chain, using the same projector as live application. */
async function advanceDossierSession(store:Store,admission:ReturnType<typeof readDossierDispatchAdmission>,
  paid:Awaited<ReturnType<typeof dossierPhysicalOutcome>>) {
  const root=admission.application.value.responseCorrection?.root;
  if(root) await readDossierResponseCorrection(store,admission.session.value.projectId,root);
  return projectDossierSession(store,admission,paid);
}

export async function readDossierResponseCorrection(store:Store,project:string,root:Ref) {
  return readApplicationResponseCorrection(store,project,root,{
    read:ref=>readDossierDispatchAdmission(store,ref).application,
    outcome:async application=>{
      const admission=readDossierDispatchAdmission(store,reference(application));
      const running=store.get<DossierAssessmentApplication>(application.id,2);
      if(!running) return null;
      const reserved=readDossierReservationAt(store,reference(application));
      const head=store.get<ModelCall>(reserved.running.value.call!.id);
      dossierRequire(head,'The correcting dossier call disappeared');
      if(head.value.status==='running') return null;
      return readResearchExecution(store,project,reference(head),admission.session,admission.draft,
        admission.question,admission.role,admission.session.value.profile);
    },
    project:async(application,paid)=>{
      dossierRequire(paid.kind==='response','Only a paid response has a dossier form');
      return projectDossierSession(store,readDossierDispatchAdmission(store,reference(application)),
        paid as Awaited<ReturnType<typeof dossierPhysicalOutcome>>);
    },
    // The native projector also proves a paid read_context that repeats an
    // already delivered page. This is one correcting reply, not a progress reset.
    formCodes:['discovery_dossier_result_invalid','research_response_invalid','assessment_invalid','research_no_progress'],
  });
}

export async function retryDossierResponse(store:Store,project:string,root:Ref,restoreOnly:boolean) {
  const correction=await readDossierResponseCorrection(store,project,root);
  const head=store.get<DossierAssessmentApplication>(correction.latest.id)!;
  if(head.value.state==='applied') {
    const result=await readDossierAssessmentSessionAt(store,project,head.value.after!);
    return {kind:result.result?'applied' as const:'pending' as const,root,session:reference(result.session),
      application:result.application};
  }
  if(correction.retry && restoreOnly) return {kind:'pending' as const,root,application:reference(correction.latest)};
  if(correction.retry) {
    const write=responseCorrectionApplicationWrite(correction);
    try { store.writeMany([write],[correction.root.value.session,reference(correction.paid!.call),
      {id:write.id,absent:true}]); }
    catch(error) {
      if(!(error instanceof EngineError) || !['input_stale','revision_conflict'].includes(error.code)
        || !store.get(write.id)) throw error;
    }
  }
  const session=dossierExact<DossierAssessmentSession>(store,correction.root.value.session,'assessment-session');
  const result=await runDossierAssessmentSession(store,project,session.value.subject,undefined,undefined,undefined,
    {restoreOnly,allowance:1,responseCorrection:root});
  return {kind:result.result?'applied' as const:'pending' as const,root,session:reference(result.session),
    application:result.application};
}

export async function readDossierAssessmentSessionAt(store:Store,project:string,sessionRef:Ref) {
  const session=dossierExact<DossierAssessmentSession>(store,sessionRef,'assessment-session');
  dossierRequire(session.value.projectId===project && session.value.contract===DOSSIER_SESSION
    && session.id===dossierSessionId(session.value.subject),'The dossier session is foreign or unknown');
  let previous=dossierExact<DossierAssessmentSession>(store,{id:session.id,revision:1,hash:store.get(session.id,1)?.hash??''},'assessment-session');
  const origin=previous.value;
  dossierRequire(origin.result===null && origin.previous===null && origin.step===0 && origin.offset===0
    && same(origin.notes,[]) && same(origin.workspace,contextWorkspace()) && origin.application===dossierApplicationId(reference(previous))
    && object(origin.binding) && isRef(origin.binding.environment) && isRef(origin.binding.draft) && isRef(origin.binding.question),
    'The dossier origin is not its declared initial state');
  const runtime=dossierExact<Environment>(store,origin.binding.environment,'environment');
  const draft=dossierExact<DiscoveryDraft>(store,origin.binding.draft,'discovery-draft');
  const question=dossierExact<Question>(store,origin.binding.question,'question');
  dossierRequire(runtime.value.projectId===project && draft.value.projectId===project && question.value.projectId===project
    && question.value.draftId===draft.id && draft.value.questions.includes(question.id) && same(origin.binding.inputs,draft.value.inputs)
    && same(origin.dispatch,runtime.value) && same(origin.role,resolveRoleMode('reviewer',runtime.value.reviewer,'research'))
    && origin.prompt===DOSSIER_PROMPT
    && (origin.profile===null || isRef(origin.profile)),'The original dossier runtime or binding is foreign');
  if(origin.profile) dossierExact<ReaderPilot>(store,origin.profile,'reader-pilot');
  const initial=readDossierDispatchAdmission(store,reference(dossierExact<DossierAssessmentApplication>(store,
    {id:origin.application,revision:1,hash:store.get(origin.application,1)?.hash??''},'assessment-application')));
  const steps:{after:Revision<DossierAssessmentSession>;applied:Revision<DossierAssessmentApplication>;
    admission:ReturnType<typeof readDossierDispatchAdmission>;paid:Awaited<ReturnType<typeof dossierPhysicalOutcome>>}[]=[];
  for(let revision=2;revision<=session.revision;revision++) {
    const after=dossierExact<DossierAssessmentSession>(store,{id:session.id,revision,hash:store.get(session.id,revision)?.hash??''},'assessment-session');
    dossierRequire(isRef(after.value.previous),'The dossier session lost an applied predecessor');
    const prepared=dossierExact<DossierAssessmentApplication>(store,after.value.previous,'assessment-application');
    const applied=dossierExact<DossierAssessmentApplication>(store,{id:prepared.id,revision:3,hash:store.get(prepared.id,3)?.hash??''},'assessment-application');
    const admission=await readDossierDispatchAdmission(store,reference(dossierExact<DossierAssessmentApplication>(store,
      {id:applied.id,revision:1,hash:store.get(applied.id,1)?.hash??''},'assessment-application')));
    dossierRequire(same(admission.session,previous) && applied.revision===3 && applied.value.state==='applied'
      && isRef(applied.value.received) && same(applied.value.after,reference(after)),
      'The session revision is not the exact result of its physical application');
    const paid=await dossierPhysicalOutcome(store,admission,applied.value.received);
    steps.push({after,applied,admission,paid});
    previous=after;
  }
  const packet=await requireDossierAssessmentSubject(store,project,origin.subject);
  dossierRequire(origin.binding.draft.id===packet.basis.draft.ref.id
    && question.id===(packet.basis.plan.value as any).question && same(initial.packet,packet),
    'The initial dossier application lost its proven packet or binding');
  // Establish every required physical origin before reprojecting any prefix.
  // Missing late sources cannot trigger repeated replay of an otherwise valid prefix.
  for(const {after,applied,admission,paid} of steps) {
    const value=await advanceDossierSession(store,admission,paid);
    const running=dossierExact<DossierAssessmentApplication>(store,{id:applied.id,revision:2,hash:store.get(applied.id,2)?.hash??''},'assessment-application');
    dossierRequire(same(after.value,value) && same(applied.value,{...running.value,state:'applied',
      after:reference(after),received:reference(paid.call)}),'The saved dossier projection differs from its exact paid response');
  }
  const application=session.value.previous?store.get<DossierAssessmentApplication>(session.value.previous.id,3):null;
  return {session,result:session.value.result,application:application?reference(application):null};
}
export async function proveDossierDispatchAdmission(store:Store,applicationRef:Ref) {
  const admission=readDossierDispatchAdmission(store,applicationRef);
  if(admission.application.value.responseCorrection)
    await readDossierResponseCorrection(store,admission.session.value.projectId,admission.application.value.responseCorrection.root);
  const packet=await requireDossierAssessmentSubject(store,admission.session.value.projectId,admission.session.value.subject);
  dossierRequire(same(packet,admission.packet),'The saved dossier packet differs from its producer');
  await readDossierAssessmentSessionAt(store,admission.session.value.projectId,reference(admission.session));
  return admission;
}
/** One public managed door. Saved positions restore before consulting today's role or profile. */
export async function runDossierAssessmentSession(store:Store,project:string,subject:unknown,
  environment?:Revision<Environment>,pilot?:Revision<ReaderPilot>,signal?:AbortSignal,options:{restoreOnly?:boolean;allowance?:number;admissionGuards?:TransactionGuard[];responseCorrection?:Ref}={}) {
  const {restoreOnly,allowance,admissionGuards:additional}=options;
  const dispatchGuards=uniqueTransactionGuards(checkTransactionGuards(additional===undefined?[]:additional));
  const packet=await requireDossierAssessmentSubject(store,project,subject),id=dossierSessionId(packet.subject);
  dossierRequire(allowance===undefined || Number.isSafeInteger(allowance) && allowance>=0,'The dossier allowance must be a nonnegative integer');
  let used=0;
  let session=store.get<DossierAssessmentSession>(id);
  if(restoreOnly) dossierRequire(session,'There is no saved dossier position to restore');
  if(!session) {
    requireCondition(allowance!==0,'research_call_allowance','No new dossier call is allowed');
    dossierRequire(environment && object(environment.value) && environment.value.projectId===project,'A new dossier session needs its exact runtime');
    environment=dossierExact<Environment>(store,reference(environment),'environment');
    const draft=store.get<DiscoveryDraft>(packet.basis.draft.ref.id),question=store.get<Question>((packet.basis.plan.value as any).question);
    dossierRequire(draft?.kind==='discovery-draft' && question?.kind==='question','The dossier needs its current saved research binding');
    const profile=pilot?dossierExact<ReaderPilot>(store,reference(pilot),'reader-pilot'):undefined;
    dossierRequire(!profile || object(profile.value) && profile.value.projectId===project,
      'A new dossier session needs an exact profile of its own project');
    const role=resolveRoleMode('reviewer',environment.value.reviewer,'research');
    const value:DossierAssessmentSession={contract:DOSSIER_SESSION,projectId:project,subject:packet.subject,
      dossierMaterialContract:DOSSIER_MATERIAL_CONTRACT,
      binding:{draft:reference(draft),question:reference(question),environment:reference(environment),inputs:draft.value.inputs},
      role,dispatch:environment.value,profile:profile?reference(profile):null,
      prompt:DOSSIER_PROMPT,
      step:0,offset:0,notes:[],workspace:contextWorkspace(),previous:null,application:'',result:null};
    value.application=dossierApplicationId({id,revision:1,hash:''});
    session={id,kind:'assessment-session',revision:1,hash:hashJson(value as never),value};
  }
  for(;;) {
    const saved=store.get<DossierAssessmentSession>(id);
    session=saved??session!;
    if(saved) {
      const historical=await readDossierAssessmentSessionAt(store,project,reference(saved));
      if(historical.result) return historical;
    }
    let application=store.get<DossierAssessmentApplication>(session.value.application);
    if(application) {
      const origin=dossierExact<DossierAssessmentApplication>(store,
        {id:application.id,revision:1,hash:store.get(application.id,1)?.hash??''},'assessment-application');
      const selected=latestResponseApplication(store,origin);
      application=store.get<DossierAssessmentApplication>(selected.id)!;
    }
    if(application) application=dossierExact<DossierAssessmentApplication>(store,reference(application),'assessment-application');
    if(restoreOnly && (!application || application.value.state==='prepared'
      || application.value.state==='running' && application.value.call && store.get<ModelCall>(application.value.call.id)?.value.status==='running'))
      return readDossierAssessmentSessionAt(store,project,reference(session));
    if(!application) {
      requireCondition(allowance===undefined || used<allowance,'research_call_allowance','No new dossier call is allowed');
      const value=session.value,binding=value.binding;
      const draft=dossierExact<DiscoveryDraft>(store,binding.draft,'discovery-draft'),question=dossierExact<Question>(store,binding.question,'question');
      const runtime=dossierExact<Environment>(store,binding.environment,'environment');
      const profile=value.profile?dossierExact<ReaderPilot>(store,value.profile,'reader-pilot'):undefined;
      const effective=new Environments(store).effective(project);
      const inherited=value.previous?readDossierReservationAt(store,value.previous).guards:[];
      const guards=uniqueTransactionGuards([...inherited,...dispatchGuards,...effective.guards,...effective.admissionGuards,reference(draft),reference(question),
        reference(runtime),...draft.value.inputs,...(profile?[reference(profile)]:[])]);
      const built=await prepareDossierResearchEnvelope(value.role,value.dispatch,value.prompt,dossierContext(session),
        {store,draftId:draft.id,questionId:question.id,purpose:'dossier-assessor',...(profile?{pilot:profile}:{})},undefined,undefined,true, dossierMaterialEra(value)
          ? {contract:DOSSIER_MATERIAL_CONTRACT,coverage:value.workspace.deliveryCoverage ?? []} : undefined);
      const archive=built.archives.records.get(built.subject.working.archive.id)??dossierExact<any>(store,built.subject.working.archive,'research-context');
      const app:DossierAssessmentApplication={contract:DOSSIER_APPLICATION,projectId:project,session:reference(session),
        context:archive.value.body,prompt:value.prompt,role:value.role,dispatch:value.dispatch,profile:value.profile,
        guards,state:'prepared',call:null,received:null,after:null};
      store.writeMany([...(saved?[]:[{id:session.id,kind:session.kind,expected:0,value:session.value}]),
        ...built.archives.writes,{id:session.value.application,kind:'assessment-application',expected:0,value:app}],
        uniqueTransactionGuards([...(saved?[reference(session)]:[]),...guards,...built.archives.guards]));
      application=store.get<DossierAssessmentApplication>(session.value.application)!;
    }
    const admission=await proveDossierDispatchAdmission(store,reference(dossierExact<DossierAssessmentApplication>(store,
      {id:application.id,revision:1,hash:store.get(application.id,1)?.hash??''},'assessment-application')));
    if(application.value.state==='prepared') {
      requireCondition(allowance===undefined || used<allowance,'research_call_allowance','No new dossier call is allowed');
      await researchCall(admission.role,admission.dispatch,admission.prompt,admission.context,signal,
        {store,draftId:admission.draft.id,questionId:admission.question.id,purpose:'dossier-assessor',session:reference(session),
          application:reference(application),...(admission.profile?{pilot:admission.profile}:{}),
          prepareCall:call=>({writes:[{id:application!.id,kind:application!.kind,expected:application!.revision,
            value:{...application!.value,state:'running',call:pendingRef(call),...(dispatchGuards.length?{dispatchGuards}: {})}}],
            guards:uniqueTransactionGuards([reference(session!),reference(application!),...application!.value.guards,...dispatchGuards])})});
      used++;
      continue;
    }
    dossierRequire(application.value.state==='running' && isRef(application.value.call),'The dossier application lost its reserved position');
    const head=store.get<ModelCall>(application.value.call.id);
    dossierRequire(head,'The reserved dossier call disappeared');
    const call=dossierExact<ModelCall>(store,reference(head),'model-call');
    if(call.value.status==='running') {
      requireCondition(allowance===undefined || used<allowance,'research_call_allowance','No new dossier call is allowed');
      await resumeDossierResearchCall(store,reference(admission.application),signal,dispatchGuards);
      used++;
      continue;
    }
    const paid=await dossierPhysicalOutcome(store,admission,reference(call));
    const value=await advanceDossierSession(store,admission,paid),write:Write={id:session.id,kind:session.kind,expected:session.revision,value};
    const applied:Write={id:application.id,kind:application.kind,expected:application.revision,
      value:{...application.value,state:'applied',after:pendingRef(write),received:reference(paid.call)}};
    // Historical source revisions are immutable proof, not today's admission heads.
    // Only the owned position and the selected physical receipt may race this application.
    store.writeMany([write,applied],uniqueTransactionGuards([reference(session),reference(application),reference(call),paid.request,
      paid.response!,paid.archive]));
    if(options.responseCorrection) return readDossierAssessmentSessionAt(store,project,pendingRef(write));
  }
}
