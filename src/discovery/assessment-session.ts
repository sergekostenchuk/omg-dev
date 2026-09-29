import { Evidence } from '../evidence/evidence.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { Environments, uniqueTransactionGuards, transactionGuardsCurrent } from '../runtime/environment.js';
import { prepareModelCallRecovery, readModelCallRecovery } from './model-call-recovery.js';
import { contextWorkspace, addContextLookup, contextProgress, type ContextWorkspace } from "./context-workspace.js";
import type { Store, Revision, Write, TransactionGuard } from "../storage/store.js";
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
import { researchAction, researchCall } from "./research-protocol.js";
import { readResearchContext, requireCurrentPriorContext } from "./research-limits.js";
import { recoveredResponseBoundary, recoveryAssessmentSessionId, recoverySessionWrites, markRecoveredSessionWritten,
  readResearchExecution, isResponseRecovery, markApplicationResponseRecovered, assessmentReadView, assessmentSessionEra,
  proposalRefusalId, type AssessmentReadProof } from './response-recovery.js';

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

function advanceAssessment(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, pilot: Revision<ReaderPilot> | undefined,
  current: Session, context: Record<string, any>, sent: Record<string, any> | undefined, response: any): { value: Session; failure?: unknown } {
  const workspace = contextWorkspace(current.workspace, current.focus);
  requireCondition(sent?.evidencePage && sent.evidencePage.offset === current.offset,
    "assessment_invalid", "Assessment did not receive its expected evidence continuation");
  const offset = sent.evidencePage.end, candidate = sent.candidatePage;
  requireCondition(candidate && candidate.total === JSON.stringify(context.value).length
    && (candidate.offset === (current.candidateOffset ?? 0) || candidate.offset === 0 && candidate.complete),
    'assessment_invalid', 'Candidate must be fully supplied through the saved assessment cursor');
  const candidateOffset = candidate.end;
  if (response?.action === "read_context") {
    const action = researchAction(response);
    requireCondition(action.action === "read_context", "assessment_invalid", "Expected an addressed read");
    try {
      const result = readResearchContext(store, draft, question.id, pilot, action.record, action.pointer, action.page);
      return { value: { ...current, focus: null, workspace: addContextLookup(workspace, result, sent.contextWorkspace, pilot?.value.contextLimits?.maxLookups) } };
    } catch (error) {
      return { value: { ...current, workspace: { ...workspace, blocked: error instanceof Error ? error.message : 'Context lookup refused' } }, failure: error };
    }
  }
  if (response?.action === "assessment_checkpoint") {
    requireCondition(Object.keys(response).sort().join(",") === "action,notes" && Array.isArray(response.notes)
      && response.notes.every((n: unknown) => typeof n === "string"), "assessment_invalid", "Assessment checkpoint needs explicit notes");
  } else {
    requireCondition(response && ["supported", "insufficient", "conflicting"].includes(response.verdict)
      && Array.isArray(response.reasons) && response.reasons.every((r: unknown) => typeof r === "string")
      && (response.verdict === "supported" || response.reasons.length > 0), "assessment_invalid", "Expected an assessment verdict or continuation");
    if (offset === sent.evidencePage.total && candidate.complete) return { value: {
      ...current, offset, candidateOffset, focus: null, workspace: contextProgress(workspace), result: response } };
  }
  return { value: { ...current, offset, candidateOffset, focus: null, workspace: contextProgress(workspace), notes: [...current.notes,
    { packet: sent.working.archive, evidence: { offset: current.offset, end: offset }, response } as Json] } };
}

const APPLICATION = 'assessment-application/v1' as const;
const PAID_ORIGIN = 'assessment-paid-origin/v1' as const;
export interface AssessmentPaidOriginInput {
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
  contract: typeof PAID_ORIGIN;
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
  state: 'prepared' | 'running' | 'applied' | 'refused' | 'retryable' | 'renewed'; call: Ref | null; after: Ref | null; received: Ref | null; refusal: ApplicationRefusal | null;
}
interface AssessmentBarrier { contract: 'assessment-barrier/v1'; projectId: string; question: Ref; refusal: Ref }
interface ApplicationSession extends Session { contract: typeof APPLICATION; application: string }
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const pendingRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
const managedSessionId = (question: Ref, context: Record<string, any>): string =>
  recoveryAssessmentSessionId(`assessment-session:v1:${hashJson([question, JSON.parse(JSON.stringify(context))])}`);
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
  if (!value || !object(value.value) || value.kind !== kind || !same(reference(value), ref) || hashJson(value.value) !== ref.hash)
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
    || value.contract !== PAID_ORIGIN || value.projectId !== projectId || value.session !== sessionId
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
function readApplication(store: Store, session: Revision<ApplicationSession>, saved?: Ref): Revision<Application> {
  const value = session.value;
  if (!object(value) || value.contract !== APPLICATION || typeof value.application !== 'string') applicationInvalid(session.id, 'The new session must retain its application contract');
  const record = saved ? exact<Application>(store, saved, 'assessment-application') : store.get<Application>(value.application);
  if (!record || !object(record.value) || record.kind !== 'assessment-application' || hashJson(record.value) !== record.hash) applicationInvalid(value.application, 'The required application state is missing');
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
    || !['prepared', 'running', 'applied', 'refused', 'retryable', 'renewed'].includes(app.state)) applicationInvalid(record.id, 'Malformed application identity or dependencies');
  const immutable = (v: Application) => ({ contract: v.contract, projectId: v.projectId, session: v.session, context: v.context,
    prompt: v.prompt, role: v.role, dispatch: v.dispatch, profile: v.profile, guards: v.guards, previous: v.previous,
    origin: v.origin ?? null });
  if (origin.value.state !== 'prepared' || origin.value.call !== null || origin.value.after !== null || origin.value.received !== null || origin.value.refusal !== null || origin.value.resolution !== null
    || !same(immutable(app), immutable(origin.value))) applicationInvalid(record.id, 'The original application admission changed');
  const before = exact<ApplicationSession>(store, app.session, 'assessment-session');
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
    || !app.guards.some(guard => same(guard, barrierGuard(app.projectId, before.value.binding!.question))))
    applicationInvalid(record.id, 'The original session and question admission must be preserved');
  proveSessionOrigin(store, record, before);
  if (app.state === 'prepared' ? app.call !== null || app.after !== null || app.received !== null || app.refusal !== null
    : app.state === 'running' ? !isRef(app.call) || app.after !== null || app.received !== null || app.refusal !== null
    : app.state === 'applied' ? !isRef(app.call) || !isRef(app.after) || !isRef(app.received) || !app.resolution || app.refusal !== null
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
  if (app.state === 'retryable' || app.state === 'renewed' && app.call) requireRetryable(store, app);
  if (app.state === 'renewed') {
    const prior = store.get<Application>(record.id, record.revision - 1);
    if (!prior || !same({ ...prior.value, state: 'renewed', after: app.after }, app)
      || (app.call === null ? prior.value.state !== 'prepared' || prior.value.call !== null : prior.value.state !== 'retryable'))
      applicationInvalid(record.id, 'Renewal must consume the exact unsent intent or proved failed attempt');
  }
  return record;
}
function validateRefusal(store: Store, record: Revision<Application>): void {
  const prior = store.get<Application>(record.id, record.revision - 1);
  if (!prior || !['prepared', 'running', 'retryable'].includes(prior.value.state))
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
      if (prior.value.state !== 'retryable') applicationInvalid(record.id, 'A bound dependency refusal must retain its exact physical outcome');
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
function throwApplicationRefusal(record: Revision<Application>): never {
  const reason = record.value.refusal;
  const code = reason?.kind === 'response' && (reason.code === 'research_no_progress' || reason.code.startsWith('research_context_'))
    ? reason.code : 'research_context_application_refused';
  throw new EngineError(code, `[${record.id}] Original assessment admission cannot be applied; reopen this question explicitly`,
    { application: reference(record), refusal: record.value.refusal });
}
function barrierGuard(project: string, question: Ref): TransactionGuard {
  return { id: `assessment-barrier:${hashJson([project, question])}`, absent: true };
}
function readBarrier(store: Store, project: string, question: Ref): Revision<AssessmentBarrier> | null {
  const guard = barrierGuard(project, question), barrier = store.get<AssessmentBarrier>(guard.id);
  if (!barrier) return null;
  const value = barrier.value;
  if (!object(value) || barrier.kind !== 'assessment-barrier' || barrier.revision !== 1 || hashJson(value) !== barrier.hash
    || value.contract !== 'assessment-barrier/v1' || value.projectId !== project || !same(value.question, question) || !isRef(value.refusal))
    applicationInvalid(guard.id, 'The question barrier has a foreign contract or origin');
  const refused = exact<Application>(store, value.refusal, 'assessment-application');
  const before = exact<ApplicationSession>(store, refused.value.session, 'assessment-session');
  const proof = readApplication(store, before, value.refusal);
  if (proof.value.state !== 'refused' || !isRef(proof.value.received) || proof.value.projectId !== project || !same(before.value.binding?.question, question)
    || proof.value.refusal?.kind === 'dependency' && proof.value.refusal.expected.id === barrier.id)
    applicationInvalid(barrier.id, 'The barrier must originate in a proved refusal of this exact question');
  return barrier;
}
function barrierRefusal(store: Store, barrier: Revision<AssessmentBarrier>): never {
  throwApplicationRefusal(exact<Application>(store, barrier.value.refusal, 'assessment-application'));
}
function refuseApplication(store: Store, record: Revision<Application>, reason: ApplicationRefusal, guards: TransactionGuard[], writes: Write[] = [], resolution: AssessmentReadProof | null = null, received: Ref | null = null): never {
  if (reason.kind === 'dependency' && record.value.call !== null && received === null && record.value.state !== 'retryable')
    throw new EngineError('research_context_application_running', `[${record.id}] Preserve the bound call until its physical outcome is proved`);
  const before = exact<ApplicationSession>(store, record.value.session, 'assessment-session'), question = before.value.binding!.question;
  const write: Write = { id: record.id, kind: record.kind, expected: record.revision, value: { ...record.value, state: 'refused', refusal: reason, resolution, received } };
  for (;;) {
    const barrier = readBarrier(store, record.value.projectId, question), absent = barrierGuard(record.value.projectId, question);
    try {
      const saved = store.writeMany<Application>([write, ...writes, ...(!barrier && received ? [{ id: absent.id, kind: 'assessment-barrier', expected: 0,
        value: { contract: 'assessment-barrier/v1', projectId: record.value.projectId, question, refusal: pendingRef(write) } satisfies AssessmentBarrier }] : [])],
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
function applicationWrite(session: Write, context: Record<string, any>, prompt: string, role: RoleBinding, dispatch: Environment, profile: Ref | null,
  guards: TransactionGuard[], previous: Ref | null = null, origin?: Ref): Write {
  const ref = pendingRef(session), value: Application = { contract: APPLICATION, projectId: (session.value as Session).projectId,
    session: ref, context: JSON.parse(JSON.stringify(context)), prompt, role: JSON.parse(JSON.stringify(role)), dispatch: JSON.parse(JSON.stringify(dispatch)), profile,
    guards: uniqueTransactionGuards(guards), previous, ...(origin ? { origin } : {}),
    resolution: null, state: 'prepared', call: null, after: null, received: null, refusal: null };
  return { id: (session.value as ApplicationSession).application, kind: 'assessment-application', expected: 0, value };
}

function paidOriginWrite(store: Store, id: string, input: AssessmentPaidOriginInput, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, context: Record<string, any>, prompt: string, dispatch: Environment,
  profile: Ref | null, guards: TransactionGuard[]): Write {
  const value: AssessmentPaidOrigin = { contract: PAID_ORIGIN, projectId: draft.value.projectId, session: id,
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
  context: Record<string, any>, extraGuards: TransactionGuard[]): TransactionGuard[] {
  const effective = new Environments(store).effective(draft.value.projectId), configured = store.get(`reader-pilot:${draft.value.projectId}`);
  return uniqueTransactionGuards([barrierGuard(draft.value.projectId, reference(question)), ...effective.guards, ...effective.admissionGuards,
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
    if (!Object.keys(app.context).every(key => Object.hasOwn(outcome.body, key) && same(outcome.body[key], app.context[key])))
      applicationInvalid(session.id, 'The exact execution has a foreign original context');
    return outcome;
  } catch (error) {
    if (error instanceof EngineError) applicationInvalid(session.id, `Physical outcome is not proved: ${error.code}`);
    throw error;
  }
}
function requireRetryable(store: Store, app: Application) {
  if (!app.received) applicationInvalid(app.session.id, 'A failed attempt needs its exact physical outcome');
  const outcome = executionOutcome(store, app, app.received);
  if (outcome.kind !== 'provider-failed') applicationInvalid(app.session.id, 'A response cannot be retried as a provider failure');
  return outcome;
}
function renewApplication(store: Store, record: Revision<Application>, session: Revision<ApplicationSession>, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined,
  context: Record<string, any>, prompt: string, extraGuards: TransactionGuard[]): void {
  const app = record.value, profile = pilot ? reference(pilot) : null, before = session.value.binding!;
  const barrier = readBarrier(store, app.projectId, before.question);
  if (barrier) barrierRefusal(store, barrier);
  if (!same([app.context, app.prompt, before.draft, before.question, before.inputs],
    [context, prompt, reference(draft), reference(question), draft.value.inputs]))
    applicationInvalid(record.id, 'Renewal cannot carry a cursor across different candidate, sources or context');
  const unsent = app.state === 'prepared' && app.call === null;
  const retained = unsent ? app.guards.filter(guard => guard.id !== app.profile?.id) : [];
  if (unsent) {
    if (!increasedPilot(store, app.profile, profile) || !same([app.role, app.dispatch, before.environment], [dispatch.reviewer, dispatch, reference(environment)]))
      applicationInvalid(record.id, 'Only a compatible explicit limit increase can replace an unsent intent');
  } else if (app.state !== 'retryable') applicationInvalid(record.id, 'Only an unsent intent or proved provider failure may be renewed');
  const physical = unsent ? null : requireRetryable(store, app);
  const guards = uniqueTransactionGuards([...currentAdmission(store, draft, question, environment, context, extraGuards), ...retained]);
  if (pilot && !guards.some(guard => same(guard, reference(pilot)))) applicationInvalid(record.id, 'The new profile must be the currently configured admission');
  const checked = evaluateWorkspace(store, session);
  if (checked.failure) throw checked.failure;
  const evidence = assessmentReadView(store);
  for (const observation of context.observations) requireCondition(new Evidence(evidence.store).verify(observation),
    'research_context_application_source_stale', 'Renewal must preserve the exact supported observations');
  evidence.finish();
  const admitted = uniqueTransactionGuards([...guards, ...checked.guards, ...evidence.guards]);
  const next: Write = { id: session.id, kind: session.kind, expected: session.revision, value: { ...session.value,
    application: applicationId(session.id, session.revision + 1), binding: { draft: reference(draft), question: reference(question), environment: reference(environment), inputs: draft.value.inputs } } };
  const renewed: Write = { id: record.id, kind: record.kind, expected: record.revision, value: { ...app, state: 'renewed', after: pendingRef(next) } };
  store.writeMany([next, renewed, applicationWrite(next, context, prompt, dispatch.reviewer, dispatch, profile, admitted, pendingRef(renewed), app.origin)],
    uniqueTransactionGuards([reference(record), reference(session), ...admitted, ...(physical ? [reference(physical.call)] : [])]));
}

async function assessmentSessionInternal(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  environment: Revision<Environment>, dispatch: Environment, pilot: Revision<ReaderPilot> | undefined, context: Record<string, any>,
  prompt: string, signal?: AbortSignal, extraGuards: TransactionGuard[] = [], paidInput?: AssessmentPaidOriginInput): Promise<{
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
  const basis = JSON.parse(JSON.stringify(context));
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
    const barrier = readBarrier(store, draft.value.projectId, reference(question));
    if (barrier) barrierRefusal(store, barrier);
    const guards = uniqueTransactionGuards([...currentAdmission(store, draft, question, environment, context, extraGuards),
      ...(paidInput ? [paidInput.pending, ...(paidInput.graph ? [paidInput.graph] : []),
        ...paidInput.runtime.guards, ...paidInput.runtime.admissionGuards] : [])]);
    const write: Write = { id, kind: 'assessment-session', expected: 0, value: { projectId: draft.value.projectId,
      offset: 0, notes: [], focus: null, result: null, contract: APPLICATION, application: applicationId(id, 1),
      binding: { draft: reference(draft), question: reference(question), environment: reference(environment), inputs: draft.value.inputs } } };
    const originWrite = paidInput ? paidOriginWrite(store, id, paidInput, draft, question, environment, basis, prompt, dispatch,
      pilot ? reference(pilot) : null, guards) : null;
    // M+S1/A1 are written atomically under the absence of this turn's technical
    // refusal; the refusal write carries the symmetric absence of M (№2000-10).
    try { store.writeMany([write, applicationWrite(write, basis, prompt, dispatch.reviewer, dispatch,
      pilot ? reference(pilot) : null, guards, null, originWrite ? pendingRef(originWrite) : undefined),
      ...(originWrite ? [originWrite] : [])],
      uniqueTransactionGuards([...guards, ...(originWrite ? [{ id: proposalRefusalId(draft.value.projectId, paidInput!.pending.id), absent: true as const }] : [])])); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'revision_conflict' || !store.get(id)) throw error;
    }
    session = store.get<ApplicationSession>(id)!;
  }
  for (;;) {
    recoveredResponseBoundary();
    session = store.get<ApplicationSession>(id)!;
    if (!session) applicationInvalid(id, 'The session disappeared');
    const application = readApplication(store, session), app = application.value;
    if (app.state === 'refused') throwApplicationRefusal(application);
    if (app.state === 'applied') {
      if (!session.value.result) applicationInvalid(id, 'An applied terminal session has no result');
      proveAppliedAssessment(store, application, session);
      return { result: session.value.result, terminal: reference(session), applied: reference(application) };
    }
    try {
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
        const workspace = contextWorkspace(session.value.workspace, session.value.focus);
        const checked = evaluateWorkspace(store, session);
        if (checked.failure) {
          if (!(checked.failure instanceof EngineError)) throw checked.failure;
          refuseApplication(store, application, { kind: 'workspace', code: checked.failure.code }, checked.guards, [], checked.proof);
        }
        const before = session.value;
        try {
          await researchCall(app.role, app.dispatch, app.prompt + '\n' + instruction,
            { ...app.context, assessmentSession: id, assessmentState: { offset: before.offset, candidateOffset: before.candidateOffset ?? 0,
              total: JSON.stringify(app.context.observations).length }, assessmentNotes: before.notes,
              contextWorkspace: workspace.entries.map(entry => entry.result), focus: null }, signal,
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
        if (['process_timeout', 'process_cancelled'].includes(call.value.error ?? '') && !call.value.response)
          refuseApplication(store, application, { kind: 'call', call: reference(call), code: call.value.error! }, [reference(call)]);
        const outcome = executionOutcome(store, app, reference(call));
        if (outcome.kind === 'provider-failed') {
          store.writeMany([{ id: application.id, kind: application.kind, expected: application.revision,
            value: { ...app, state: 'retryable', received: reference(call) } }],
          // Recording the exact physical failure is independent of today's
          // admission. Renewal checks the fresh context before the next call.
          uniqueTransactionGuards([reference(application), reference(session), reference(outcome.call)]));
          throw new EngineError('research_provider_failed', `[${call.id}] Provider failed without a research response; the exact attempt is preserved`);
        }
        applicationInvalid(call.id, 'A failed label contradicts the saved response');
      }
      const binding = session.value.binding!;
      const sourceDraft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft'), sourceQuestion = exact<Question>(store, binding.question, 'question');
      const response = applicationResponse(store, app, reference(call));
      const changed = changedDependency(store, app.guards);
      if (changed) refuseApplication(store, application, changed.reason, [...changed.guards, reference(call)], [], null, reference(call));
      const advanced = evaluateApplication(store, app, session, sourceDraft, sourceQuestion, response);
      if (advanced.failure && !(advanced.failure instanceof EngineError)) throw advanced.failure;
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
      store.writeMany([write, applied,
        ...(!terminal ? [applicationWrite(write, app.context, app.prompt, app.role, app.dispatch, app.profile, uniqueTransactionGuards([...app.guards, ...advanced.guards]), pendingRef(applied), app.origin)] : []), ...recovered.writes],
      uniqueTransactionGuards([reference(session), reference(application), ...app.guards, ...response.guards, ...advanced.guards, ...recovered.guards]));
      markRecoveredSessionWritten(recovered);
      if (terminal) return { result: nextValue.result, terminal: pendingRef(write), applied: pendingRef(applied) };
    } catch (error) {
      if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
      const latest = store.get<Application>(application.id), currentSession = store.get(id);
      if (latest && (!same(reference(latest), reference(application)) || currentSession && !same(reference(currentSession), reference(session)))) continue;
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

/** Exact terminal proof for a managed assessor session; no current session/application head is consulted. */
export function readAssessmentSessionOutcomeAt(store: Store, projectId: string, terminal: Ref, applied: Ref): {
  result: unknown; session: Ref; application: Ref; draft: Ref; question: Ref; environment: Ref; inputs: Ref[]; received: Ref;
  context: Record<string, any>; prompt: string; role: RoleBinding; dispatch: Environment; profile: Ref | null;
  origin: Ref | null;
} {
  if (!store || typeof store.get !== 'function' || typeof projectId !== 'string' || !projectId.trim()
    || !isRef(terminal) || !isRef(applied)) applicationInvalid('assessment-session', 'Exact terminal proof needs project, session and application');
  const session = exact<ApplicationSession>(store, terminal, 'assessment-session');
  if (session.value.projectId !== projectId || session.value.contract !== APPLICATION || session.value.result === null
    || !session.value.binding || !isRef(session.value.binding.question))
    applicationInvalid(terminal.id, 'The exact managed session has no terminal result or question');
  const application = readApplication(store, session, applied);
  if (application.value.state !== 'applied' || !same(application.value.after, terminal)
    || !isRef(application.value.received))
    applicationInvalid(applied.id, 'The exact application did not produce this terminal result');
  proveAppliedAssessment(store, application, session);
  return { result: session.value.result, session: terminal, application: applied,
    draft: session.value.binding.draft, question: session.value.binding.question,
    environment: session.value.binding.environment, inputs: session.value.binding.inputs,
    received: application.value.received,
    context: application.value.context, prompt: application.value.prompt, role: application.value.role,
    origin: application.value.origin ?? null,
    dispatch: application.value.dispatch, profile: application.value.profile };
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
function evaluateApplication(store: Store, app: Application, before: Revision<ApplicationSession>, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>, paid: ReturnType<typeof applicationResponse>, proof?: AssessmentReadProof) {
  const inputs = assessmentReadView(store, proof);
  let value: Session | undefined, failure: unknown;
  try {
    for (const observation of app.context.observations) requireCondition(new Evidence(inputs.store).verify(observation),
      'research_context_application_source_stale', 'An original observation is no longer supported by its source');
    const pilot = app.profile ? exact<ReaderPilot>(store, app.profile, 'reader-pilot') : undefined;
    const advanced = advanceAssessment(inputs.store, draft, question, pilot, before.value, app.context, paid.subject, paid.payload);
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
function proveSessionOrigin(store: Store, record: Revision<Application>, before: Revision<ApplicationSession>): void {
  const app = record.value;
  if (app.previous === null) {
    const expected = { projectId: app.projectId, offset: 0, notes: [], focus: null, result: null, contract: APPLICATION,
      application: record.id, binding: before.value.binding };
    const expectedId = app.origin
      ? paidSessionId(app.projectId, exact<AssessmentPaidOrigin>(store, app.origin, 'assessment-paid-origin').value.pending.id)
      : `assessment-session:v1:${hashJson([before.value.binding!.question, app.context])}`;
    if (before.revision !== 1 || before.id !== expectedId
      || !same(before.value, expected)) applicationInvalid(record.id, 'The initial session is not the declared initial cursor');
    return;
  }
  if (!isRef(app.previous)) applicationInvalid(record.id, 'A continuation needs its exact previous application');
  const previous = exact<Application>(store, app.previous, 'assessment-application');
  if (previous.value.state === 'renewed') {
    if (!same(previous.value.after, reference(before)) || previous.value.session.id !== before.id
      || previous.value.session.revision !== before.revision - 1)
      applicationInvalid(record.id, 'The renewal must preserve one exact preceding cursor');
    readApplication(store, before, app.previous);
    const prior = exact<ApplicationSession>(store, previous.value.session, 'assessment-session'), binding = prior.value.binding!;
    const expected = { ...prior.value, application: record.id, binding: before.value.binding };
    if (!same(before.value, expected) || before.value.result !== null
      || !same([previous.value.context, previous.value.prompt, binding.draft, binding.question, binding.inputs],
        [app.context, app.prompt, before.value.binding!.draft, before.value.binding!.question, before.value.binding!.inputs]))
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
    || !same([previous.value.context, previous.value.prompt, previous.value.role, previous.value.dispatch, previous.value.profile],
      [app.context, app.prompt, app.role, app.dispatch, app.profile]))
    applicationInvalid(record.id, 'The prior application does not derive this exact continuation');
  readApplication(store, before, app.previous);
  const prior = proveAppliedAssessment(store, previous, before);
  if (!same(app.guards, uniqueTransactionGuards([...previous.value.guards, ...prior.guards])))
    applicationInvalid(record.id, 'The continuation lost the inputs read by its prior application');
}
