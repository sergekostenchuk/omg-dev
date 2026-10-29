import { pendingContextWorkspace } from './context-workspace.js';
import { finalMaterialAdmission, finalMaterialProjection, finalMaterialEra, finalWorkspace, packFinalMaterial, recordFinalMaterialWorkspace, finalTechnicalLookup } from './final-material.js';
import { correctingApplicationLeaf, latestResponseApplication, readApplicationResponseCorrection,
  responseCorrectionApplicationWrite, type ApplicationResponseCorrection } from './application-response-correction.js';
import { finalResponseContract } from './discovery-response-contract.js';
import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Environment, RoleBinding } from '../runtime/environment.js';
import type { Revision, Store, TransactionGuard, Write } from '../storage/store.js';
import { pendingOverlay } from '../storage/store-view.js';
import type { ContextWorkspace } from './context-workspace.js';
import { addContextLookup, contextProgress, contextWorkspace, packContextWorkspace,
  requireCompleteContextPacket } from './context-workspace.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { DISCOVERY_FINAL_ASSESSMENT_SESSION, DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND, readDiscoveryFinalAssessmentSessionAt,
  type DiscoveryFinalAssessmentSession } from './discovery-final-assessment-session.js';
import { DISCOVERY_FINAL_ASSESSMENT_RESULT } from './discovery-final-assessment-result.js';
import type { ReaderPilot } from './reader-pilot.js';
import { readFinalCapacityProjection } from './early-research-outcome.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import type { FinalAssessmentContinuation } from './continuation-packet.js';
import { readDiscoveryFinalAssessmentSourceAt } from './discovery-final-assessment-source.js';
import { currentDiscoveryFinalGuards, type readDiscoveryFinalDispatchAdmission } from './discovery-final-execution.js';
import { prepareArchiveParts, readArchiveBody } from './request-parts.js';
import { contextValue } from './working-context.js';
import { addressArchivedMaterials, requirePacketMaterialDelivery, serveArchivedMaterial } from './research-delivery.js';
import { checkDiscoveryFinalAssessmentReply } from './discovery-final-assessment-request.js';
import { readDiscoveryFinalAssessmentResearchExecution, readResearchContextOutcomeAt } from './response-recovery.js';
import { researchAction, researchCall, resumeDiscoveryFinalAssessmentResearchCall } from './research-protocol.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { DiscoveryFinalAssessmentSubject } from './discovery-final-assessment-subject.js';
import type { DiscoveryFinalAssessmentProjection } from './discovery-final-assessment-result.js';

/** The prepared assessment is immutable and is never itself permission to
 * spend. A separate cursor binds it to one proved, paid D7 result. */
export const DISCOVERY_FINAL_ASSESSMENT_EXECUTION = 'discovery-final-assessment-execution/v1' as const;
export const DISCOVERY_FINAL_ASSESSMENT_APPLICATION = 'discovery-final-assessment-application/v1' as const;
export const DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT = 'discovery-final-assessment-paid-result/v1' as const;
export const DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND = 'discovery-final-assessment-execution' as const;
export const DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND = 'discovery-final-assessment-application' as const;
export const DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT_KIND = 'discovery-final-assessment-paid-result' as const;

export interface DiscoveryFinalAssessmentExecution {
  [key: string]: unknown;
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_EXECUTION;
  projectId: string;
  source: Ref;
  prepared: Ref;
  subject: DiscoveryFinalAssessmentSubject;
  binding: { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] };
  role: RoleBinding;
  dispatch: Environment;
  profile: Ref | null;
  prompt: string;
  step: number;
  offset: 0;
  notes: unknown[];
  workspace: ContextWorkspace;
  previous: Ref | null;
  application: string;
  result: Ref | null;
}

export interface DiscoveryFinalAssessmentApplication {
  [key: string]: unknown;
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_APPLICATION;
  projectId: string;
  session: Ref;
  context: Record<string, any>;
  prompt: string;
  role: RoleBinding;
  dispatch: Environment;
  profile: Ref | null;
  guards: TransactionGuard[];
  state: 'prepared' | 'applied';
  call: Ref | null;
  received: Ref | null;
  after: Ref | null;
  responseCorrection?: ApplicationResponseCorrection;
}

export interface DiscoveryFinalAssessmentPaidResult {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT;
  projectId: string;
  source: Ref;
  prepared: Ref;
  subject: DiscoveryFinalAssessmentSubject;
  session: Ref;
  application: Ref;
  call: Ref;
  request: Ref;
  response: Ref;
  projection: DiscoveryFinalAssessmentProjection;
}

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const object = (value: unknown): value is Record<string, any> => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, names: readonly string[]) => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
function valid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'discovery_final_assessment_execution_invalid', message);
}
function snapshotRef(ref: unknown): Ref {
  let snapshot: unknown;
  try { snapshot = JSON.parse(canonical(ref)); }
  catch { throw new EngineError('discovery_final_assessment_execution_invalid', 'An exact immutable reference is required'); }
  valid(isRef(snapshot) && keys(snapshot, ['id', 'revision', 'hash']), 'An exact immutable reference is required');
  return snapshot;
}
function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  const at = snapshotRef(ref), row = store.get<T>(at.id, at.revision);
  valid(row?.kind === kind && same(reference(row), at) && hashJson(row.value as never) === row.hash,
    'An exact final assessment ground is missing, foreign or changed');
  return row;
}

export const discoveryFinalAssessmentExecutionId = (source: Ref, prepared: Ref) =>
  `discovery-final-assessment-execution:${hashJson([DISCOVERY_FINAL_ASSESSMENT_EXECUTION, source, prepared])}`;
export const discoveryFinalAssessmentApplicationId = (session: Ref) =>
  `discovery-final-assessment-application:${hashJson([DISCOVERY_FINAL_ASSESSMENT_APPLICATION, session.id, session.revision])}`;

/** The immutable origin, not today's execution head, identifies every call. */
export function finalAssessmentContinuation(store: Store,
  session: Revision<DiscoveryFinalAssessmentExecution>): FinalAssessmentContinuation {
  const origin = store.get<DiscoveryFinalAssessmentExecution>(session.id, 1);
  valid(object(session.value) && origin?.kind === DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND
    && object(origin.value) && hashJson(origin.value as never) === origin.hash
    && origin.value.contract === DISCOVERY_FINAL_ASSESSMENT_EXECUTION
    && same(origin.value.source, session.value.source) && same(origin.value.prepared, session.value.prepared)
    && same(origin.value.subject, session.value.subject), 'The assessment execution lost its immutable origin');
  return { source: structuredClone(origin.value.source), prepared: structuredClone(origin.value.prepared),
    subject: structuredClone(origin.value.subject), execution: reference(origin) };
}

function readAssessmentRequestArchive(store: Store, prepared: Revision<DiscoveryFinalAssessmentSession>) {
  const capacity = prepared.value.envelope?.capacity;
  valid(object(capacity) && object(capacity.mandatory) && 'archive' in capacity.mandatory
    && object(capacity.mandatory.archive)
    && isRef(capacity.mandatory.archive.record) && typeof capacity.mandatory.archive.pointer === 'string'
    && typeof capacity.mandatory.archive.hash === 'string'
    && same(capacity.mandatory.archive.record, prepared.value.archive),
  'The assessment admission lost its exact archive');
  const address = capacity.mandatory.archive;
  const minimum = readFinalCapacityProjection(store, address.record, address.pointer);
  const original = address.pointer === '/body/admission' ? readFinalCapacityProjection(store, address.record, '/body/request') : minimum;
  const originalText = canonical(original);
  valid(hashJson(minimum as never) === address.hash
    && (address.pointer !== '/body/admission' || same(minimum, finalMaterialAdmission(original))), 'The assessment archive differs from its exact hash');
  return { capacity, original, originalText };
}

/** Synchronous physical leaf. It validates immutable associations, but is not
 * the public authority to send: admission separately proves paid D7 and the
 * prepared assessment before a reservation. */
function readDiscoveryFinalAssessmentDispatchLeafOriginal(store: Store, applicationRef: Ref) {
  const application = exact<DiscoveryFinalAssessmentApplication>(store, applicationRef,
    DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND);
  const app = application.value;
  valid(application.revision === 1 && object(app) && app.contract === DISCOVERY_FINAL_ASSESSMENT_APPLICATION
    && isRef(app.session), 'The assessment application needs its immutable origin');
  const session = exact<DiscoveryFinalAssessmentExecution>(store, app.session,
    DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND);
  const value = session.value;
  valid(keys(value, ['contract', 'projectId', 'source', 'prepared', 'subject', 'binding', 'role', 'dispatch',
    'profile', 'prompt', 'step', 'offset', 'notes', 'workspace', 'previous', 'application', 'result'])
    && keys(app, ['contract', 'projectId', 'session', 'context', 'prompt', 'role', 'dispatch', 'profile',
      'guards', 'state', 'call', 'received', 'after'])
    && value.contract === DISCOVERY_FINAL_ASSESSMENT_EXECUTION && value.projectId === app.projectId
    && isRef(value.source) && isRef(value.prepared)
    && session.id === discoveryFinalAssessmentExecutionId(value.source, value.prepared)
    && value.application === application.id && application.id === discoveryFinalAssessmentApplicationId(reference(session))
    && value.step === session.revision - 1 && value.offset === 0 && Array.isArray(value.notes)
    && object(value.subject) && object(value.subject.subject) && object(value.subject.subject.basis)
    && object(value.subject.subject.basis.brief) && object(value.workspace) && Array.isArray(value.workspace.entries)
    && value.workspace.entries.every(entry => object(entry) && object(entry.result))
    && value.result === null, 'The assessment cursor is foreign or incomplete');
  const origin = store.get<DiscoveryFinalAssessmentExecution>(session.id, 1);
  valid(origin?.kind === DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND && object(origin.value)
    && hashJson(origin.value as never) === origin.hash, 'The assessment cursor lost its origin');
  for (const key of ['contract', 'projectId', 'source', 'prepared', 'subject', 'binding', 'role', 'dispatch', 'profile', 'prompt'] as const)
    valid(same(value[key], origin.value[key]), 'The assessment execution identity changed');
  valid(origin.value.step === 0 && origin.value.previous === null && origin.value.result === null
    && same(origin.value.notes, []) && same(origin.value.workspace, contextWorkspace()),
  'The assessment origin is not an initial cursor');
  const source = exact<Record<string, any>>(store, value.source, 'discovery-final-paid-result');
  const prepared = exact<DiscoveryFinalAssessmentSession>(store, value.prepared, DISCOVERY_FINAL_ASSESSMENT_SESSION_KIND);
  valid(prepared.revision === 1 && object(prepared.value) && prepared.value.contract === DISCOVERY_FINAL_ASSESSMENT_SESSION
    && prepared.value.project === value.projectId && prepared.value.state === 'prepared'
    && object(prepared.value.input) && object(prepared.value.envelope) && object(prepared.value.envelope.packet)
    && same(prepared.value.subject, value.subject) && object(source.value) && source.value.projectId === value.projectId,
  'The assessment lost its paid source or immutable preparation');
  const { original, originalText } = readAssessmentRequestArchive(store, prepared);
  const binding = value.binding;
  valid(object(binding) && isRef(binding.draft) && isRef(binding.question) && isRef(binding.environment)
    && Array.isArray(binding.inputs) && binding.inputs.every(isRef), 'The assessment research binding is incomplete');
  const draft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft');
  const question = exact<Question>(store, binding.question, 'question');
  const environment = exact<Environment>(store, binding.environment, 'environment');
  const profile = value.profile === null ? undefined : exact<ReaderPilot>(store, value.profile, 'reader-pilot');
  const final = value.subject.subject;
  valid(object(draft.value) && object(question.value) && object(environment.value) && (!profile || object(profile.value))
    && Array.isArray(draft.value.questions) && Array.isArray(draft.value.inputs)
    && same(reference(draft), final.basis.draft) && same(reference(question), final.basis.brief.question)
    && draft.value.projectId === value.projectId && question.value.projectId === value.projectId
    && question.value.draftId === draft.id && draft.value.questions.includes(question.id)
    && same(draft.value.inputs, binding.inputs) && same(reference(environment), prepared.value.environment)
    && environment.value.projectId === value.projectId && same(value.dispatch, environment.value)
    && same(value.role, prepared.value.role) && value.prompt === prepared.value.input.prompt
    && (!profile || profile.value.projectId === value.projectId),
  'The assessment runtime or exact grounds differ from its preparation');
  const marker = finalAssessmentContinuation(store, session);
  valid(keys(app.context, ['finalContinuation', 'request', 'schema', 'resultCapacity', 'contextWorkspace',
    ...(finalMaterialEra(prepared.value.input) ? ['finalMaterial'] : [])])
    && (!finalMaterialEra(prepared.value.input) || same(app.context.finalMaterial,finalMaterialProjection(original.packet)))
    && same(app.context.finalContinuation, marker) && canonical(app.context.request) === originalText
    && same(app.context.schema, prepared.value.envelope.packet.schema)
    && same(app.context.resultCapacity, prepared.value.envelope.capacity)
    && same(app.context.contextWorkspace, finalWorkspace(prepared.value.input, value.workspace))
    && app.prompt === value.prompt && same(app.role, value.role) && same(app.dispatch, value.dispatch)
    && same(app.profile, value.profile) && app.state === 'prepared' && app.call === null
    && app.received === null && app.after === null && Array.isArray(app.guards)
    && same(app.guards, uniqueTransactionGuards(app.guards)),
  'The assessment application differs from its complete saved request or cursor');
  valid([binding.draft, binding.question, binding.environment, ...binding.inputs, ...(value.profile ? [value.profile] : [])]
    .every(ref => app.guards.some(guard => same(guard, ref))), 'The assessment application lost an original guard');
  return { application, session, source, prepared, draft, question, environment, profile, original,
    context: app.context, role: value.role, dispatch: value.dispatch, prompt: value.prompt };
}

/** The only authority for a new physical send: reconstruct both the paid D7
 * source and the prepared assessment, then compare their complete subject and
 * candidate. A caller's cached projection is never an authority here. */
export function readDiscoveryFinalAssessmentDispatchLeaf(store: Store, applicationRef: Ref): ReturnType<typeof readDiscoveryFinalAssessmentDispatchLeafOriginal> {
  const application=exact<DiscoveryFinalAssessmentApplication>(store,applicationRef,DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND);
  return correctingApplicationLeaf(store,application,ref=>readDiscoveryFinalAssessmentDispatchLeafOriginal(store,ref))
    ?? readDiscoveryFinalAssessmentDispatchLeafOriginal(store,applicationRef);
}

export async function readDiscoveryFinalAssessmentDispatchAdmission(store: Store, applicationRef: Ref) {
  const leaf = readDiscoveryFinalAssessmentDispatchLeaf(store, applicationRef);
  if(leaf.application.value.responseCorrection)
    await readDiscoveryFinalAssessmentResponseCorrection(store,leaf.session.value.projectId,leaf.application.value.responseCorrection.root);
  // A later cursor is authority only if every prior assessment page has its
  // exact physical proof. This admission is also called directly by resume,
  // which must not rely on the runner having performed that check first.
  const history = leaf.session.revision > 1
    ? await readDiscoveryFinalAssessmentExecutionAt(store, leaf.session.value.projectId, reference(leaf.session))
    : null;
  const source = history?.source
    ?? await readDiscoveryFinalAssessmentSourceAt(store, leaf.session.value.projectId, leaf.session.value.source);
  const prepared = history?.prepared
    ?? await readDiscoveryFinalAssessmentSessionAt(store, leaf.session.value.projectId, leaf.session.value.prepared);
  const request = leaf.original;
  valid(same(reference(source.paid), reference(leaf.source)) && same(reference(prepared), reference(leaf.prepared))
    && same(source.packet.subject, prepared.value.subject) && same(source.packet.subject, leaf.session.value.subject)
    && object(request) && request.contract === DISCOVERY_FINAL_ASSESSMENT_RESULT && object(request.packet)
    && same(request.subject, source.packet.subject) && same(request.packet, source.packet)
    && same(request.schema, prepared.value.envelope.packet.schema),
  'The assessment preparation is not the complete packet of this exact paid D7');
  return { ...leaf, source, prepared, proven: source.packet };
}

/** Reuse the accepted D7 current-choice/runtime guard rather than maintaining
 * a second interpretation of current plan and selection. The projected view
 * is assembled only from this invocation's freshly proved paid source. */
export function currentDiscoveryFinalAssessmentGuards(store: Store, project: string,
  admission: Awaited<ReturnType<typeof readDiscoveryFinalAssessmentDispatchAdmission>>): TransactionGuard[] {
  const session = { ...admission.session, value: { ...admission.session.value,
    subject: admission.proven.subject.subject } };
  const finalAdmission = { ...admission, session, proven: { packet: admission.proven.final } };
  const shared = currentDiscoveryFinalGuards(store, project,
    finalAdmission as unknown as Awaited<ReturnType<typeof readDiscoveryFinalDispatchAdmission>>);
  return uniqueTransactionGuards([...shared, reference(admission.source.paid), reference(admission.prepared)]);
}

/** Stage the physical archive for this cursor. All omitted material remains
 * addressable through the shared bounded-delivery and workspace machinery. */
export function prepareDiscoveryFinalAssessmentContextPacker(store: Store,
  admission: Awaited<ReturnType<typeof readDiscoveryFinalAssessmentDispatchAdmission>>) {
  const { session, prepared, context } = admission;
  // This small supplement stays inline: the paid archive retains its historical context exactly.
  const discoveryResponseContract = finalResponseContract(true);
  const staged = prepareArchiveParts(store, { projectId: session.value.projectId,
    draft: session.value.binding.draft, question: session.value.binding.question }, structuredClone(context));
  const records = new Map<string, Revision<any>>();
  for (const write of staged.writes as Write[]) records.set(write.id, { id: write.id, kind: write.kind,
    revision: write.expected + 1, hash: hashJson(write.value as never), value: write.value });
  const view = pendingOverlay(store, [...records.values()]), archive = staged.archive;
  const resolve = (record: Ref, pointer: string) => {
    const row = view.get(record.id, record.revision);
    valid(row?.kind === 'research-context' && same(reference(row), record),
      'An assessment material address is not an exact archive');
    return contextValue({ body: readArchiveBody(view, row).body }, pointer);
  };
  return {
    view,
    pack(limit: number): Record<string, any> {
      const packetLimit = Math.min(limit, prepared.value.input.packetChars);
      const packet: Record<string, any> = { contract: 'discovery-final-assessment-envelope/v1',
        subject: structuredClone(session.value.subject), schema: structuredClone(context.schema), discoveryResponseContract,
        request: structuredClone(context.request), finalContinuation: structuredClone(context.finalContinuation),
        resultCapacity: structuredClone(context.resultCapacity), contextWorkspace: structuredClone(context.contextWorkspace),
        ...(context.failures ? {failures:structuredClone(context.failures)} : {}),
        working: { archive, deliveryContract: 'research-delivery/v1',
          instruction: 'Read each exact omitted address with read_context and continue through every page before returning a final result.' } };
      if (finalMaterialEra(prepared.value.input))
        packFinalMaterial(packet, context.request, archive, prepared.value.archive, packetLimit, session.value.workspace);
      else {
      const originals = addressArchivedMaterials(packet, archive, ['request'], packetLimit,
        () => prepared.value.archive, 2048);
      // Leave room for a positive original fragment after the newest context
      // page. Otherwise the context packer may consume the whole packet and
      // make the shared material delivery fail on the next paid turn.
      packContextWorkspace(packet, packetLimit, packetLimit, undefined, originals.length ? 8192 : 1024);
      serveArchivedMaterial(packet, originals, packetLimit, 512);
      }
      requirePacketMaterialDelivery(packet, archive, resolve);
      valid(JSON.stringify(packet).length <= packetLimit, 'The assessment transport packet exceeds its saved limit');
      return packet;
    },
    staged: () => ({ writes: staged.writes, guards: staged.guards, records }),
  };
}

const pendingRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1,
  hash: hashJson(write.value as never) });
const assessmentCallId = (application: Ref) => `model-call:final-assessment:v1:${hashJson(application)}`;
const assessmentResultId = (application: Ref) => `discovery-final-assessment-paid-result:${hashJson(application)}`;

async function physicalAssessmentOutcome(store: Store, project: string, application: Ref, received: Ref) {
  const { admission, paid } = readDiscoveryFinalAssessmentResearchExecution(store, project, received, application);
  const claim = store.get<ModelCall>(assessmentCallId(reference(admission.application)), 1);
  valid(claim?.kind === 'model-call' && object(claim.value) && hashJson(claim.value as never) === claim.hash
    && same((claim.value as unknown as Record<string, unknown>).finalAssessmentApplication,
      reference(admission.application)), 'The assessment application lost its unique reservation');
  valid(paid.call.id === claim.id && paid.kind === 'response',
    'Only this exact physical assessment response can advance its cursor');
  return { admission, paid };
}

/** Application and historical reading share exactly this projector. Neither
 * an answer's own verdict nor a structural packet can impersonate payment. */
async function projectAssessmentStepUnchecked(store: Store, admission: ReturnType<typeof readDiscoveryFinalAssessmentDispatchLeaf>,
  paid: Awaited<ReturnType<typeof physicalAssessmentOutcome>>['paid']) {
  const { session, application, draft, question } = admission;
  const materialEra = finalMaterialEra(admission.prepared.value.input);
  let workspace = contextWorkspace(materialEra ? recordFinalMaterialWorkspace(session.value.workspace, paid.subject) : session.value.workspace), result: Ref | null = null, output: Write | null = null;
  const response = paid.payload;
  if (object(response) && response.action === 'read_context') {
    const action = researchAction(response);
    valid(action.action === 'read_context', 'An assessment lookup must retain its exact address');
    const addresses = paid.subject.working?.materialAddresses;
    valid((finalMaterialEra(admission.prepared.value.input) && finalTechnicalLookup(paid.subject, admission.context.request, action))
      || Array.isArray(addresses) && addresses.some((address: Record<string, any>) =>
      same(address.record, action.record)
      && (action.pointer === address.pointer || action.pointer.startsWith(`${address.pointer}/`))),
    'An assessment lookup must address material of this exact paid packet');
    const lookup = readResearchContextOutcomeAt(store, draft, question, action,
      admission.profile?.value.maxRequestChars ?? 300000, 'bounded');
    workspace = addContextLookup(workspace, lookup, paid.subject.contextWorkspace, undefined, materialEra ? undefined : paid.subject);
  } else {
    requireCompleteContextPacket(materialEra ? pendingContextWorkspace(session.value.workspace) : workspace, paid.subject);
    const checked = await checkDiscoveryFinalAssessmentReply(store, session.value.projectId, session.value.subject,
      admission.prepared.value.input.resultLimitChars, admission.context.resultCapacity, response);
    workspace = contextProgress(workspace, materialEra ? undefined : paid.subject);
    const value: DiscoveryFinalAssessmentPaidResult = { contract: DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT,
      projectId: session.value.projectId, source: session.value.source, prepared: session.value.prepared,
      subject: session.value.subject, session: reference(session), application: reference(application),
      call: reference(paid.call), request: paid.request, response: paid.response, projection: checked.projection };
    output = { id: assessmentResultId(reference(application)), kind: DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT_KIND,
      expected: 0, value };
    result = pendingRef(output);
  }
  const after: DiscoveryFinalAssessmentExecution = { ...session.value, step: session.value.step + 1,
    workspace, previous: reference(application), result,
    application: result ? application.id : discoveryFinalAssessmentApplicationId({
      id: session.id, revision: session.revision + 1, hash: '' }) };
  return { after, output };
}

/** Historical reader: prove the original paid D7, immutable preparation and
 * every physical assessment step. Today's heads and allowance are irrelevant. */
export async function readDiscoveryFinalAssessmentResponseCorrection(store:Store,project:string,root:Ref) {
  return readApplicationResponseCorrection(store,project,root,{
    read:ref=>readDiscoveryFinalAssessmentDispatchLeaf(store,ref).application,
    outcome:async application=>{
      const head=store.get<ModelCall>(assessmentCallId(reference(application)));
      if(!head || head.value.status==='running') return null;
      return readDiscoveryFinalAssessmentResearchExecution(store,project,reference(head),reference(application)).paid;
    },
    project:async(application,paid)=>{
      valid(paid.kind==='response','Only a paid response has a closed role form');
      return projectAssessmentStepUnchecked(store,readDiscoveryFinalAssessmentDispatchLeaf(store,reference(application)),
        paid as Awaited<ReturnType<typeof physicalAssessmentOutcome>>['paid']);
    },
    formCodes:['discovery_final_assessment_result_invalid','research_response_invalid','research_context_incomplete'],
  });
}

async function projectAssessmentStep(store:Store,admission:ReturnType<typeof readDiscoveryFinalAssessmentDispatchLeaf>,
  paid:Awaited<ReturnType<typeof physicalAssessmentOutcome>>['paid']) {
  if(admission.application.value.responseCorrection)
    await readDiscoveryFinalAssessmentResponseCorrection(store,admission.session.value.projectId,admission.application.value.responseCorrection.root);
  return projectAssessmentStepUnchecked(store,admission,paid);
}

export async function readDiscoveryFinalAssessmentExecutionAt(store: Store, project: string, at: Ref) {
  const targetRef = snapshotRef(at);
  const target = exact<DiscoveryFinalAssessmentExecution>(store, targetRef, DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND);
  valid(object(target.value) && target.value.projectId === project && isRef(target.value.source)
    && isRef(target.value.prepared)
    && target.id === discoveryFinalAssessmentExecutionId(target.value.source, target.value.prepared),
  'The assessment execution belongs to another source');
  const first = store.get<DiscoveryFinalAssessmentExecution>(target.id, 1);
  valid(first?.kind === DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND, 'The assessment execution has no origin');
  let previous = exact<DiscoveryFinalAssessmentExecution>(store, reference(first), DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND);
  valid(object(previous.value) && isRef(previous.value.prepared) && isRef(previous.value.source),
    'The assessment origin has no exact preparation and paid source');
  const source = await readDiscoveryFinalAssessmentSourceAt(store, project, previous.value.source);
  const prepared = await readDiscoveryFinalAssessmentSessionAt(store, project, previous.value.prepared);
  valid(same(source.packet.subject, prepared.value.subject) && same(previous.value.subject, prepared.value.subject)
    && previous.value.step === 0 && previous.value.previous === null && previous.value.result === null
    && previous.value.application === discoveryFinalAssessmentApplicationId(reference(previous)),
  'The assessment origin is not bound to its exact paid source and preparation');
  const firstApplication = store.get<DiscoveryFinalAssessmentApplication>(previous.value.application, 1);
  valid(firstApplication, 'The assessment execution has no origin application');
  if (target.revision === 1) {
    const admission = readDiscoveryFinalAssessmentDispatchLeaf(store, reference(firstApplication));
    valid(same(reference(admission.session), reference(previous)), 'The assessment origin application is foreign');
  }
  let output: Revision<DiscoveryFinalAssessmentPaidResult> | null = null;
  for (let revision = 2; revision <= target.revision; revision++) {
    const row = store.get<DiscoveryFinalAssessmentExecution>(target.id, revision);
    valid(row, 'The assessment execution lost a cursor revision');
    const after = exact<DiscoveryFinalAssessmentExecution>(store, reference(row), DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND);
    valid(object(after.value) && isRef(after.value.previous), 'The assessment cursor lost its prior application');
    const application = exact<DiscoveryFinalAssessmentApplication>(store, after.value.previous,
      DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND);
    const applied = store.get<DiscoveryFinalAssessmentApplication>(application.id, 2);
    valid(applied?.kind === DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND && object(applied.value)
      && hashJson(applied.value as never) === applied.hash && isRef(applied.value.call) && isRef(applied.value.received)
      && same(applied.value.after, reference(after)) && same(applied.value, { ...application.value, state: 'applied',
        call: applied.value.call, received: applied.value.received, after: reference(after) }),
    'The assessment cursor is not its exact applied application');
    if (revision === 2) valid(same(application.value.responseCorrection?.root ?? reference(application), reference(firstApplication)),
      'The assessment execution does not use its origin application');
    const { admission, paid } = await physicalAssessmentOutcome(store, project, reference(application), applied.value.received);
    valid(same(reference(admission.session), reference(previous)), 'An assessment application belongs to another cursor');
    const claim = store.get<ModelCall>(paid.call.id, 1);
    valid(claim && same(applied.value.call, reference(claim)), 'The assessment names a different physical claim');
    const projected = await projectAssessmentStep(store, admission, paid);
    valid(same(after.value, projected.after), 'The assessment cursor differs from its paid projection');
    if (projected.output) {
      output = exact<DiscoveryFinalAssessmentPaidResult>(store, pendingRef(projected.output),
        DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT_KIND);
      valid(same(output.value, projected.output.value), 'The paid assessment differs from its checked response');
    }
    previous = after;
  }
  valid(same(reference(previous), targetRef) && (target.value.result === null ? output === null
    : output && same(reference(output), target.value.result)), 'The paid assessment output is missing or foreign');
  return { session: target, source, prepared, output, result: output?.value.projection ?? null };
}

/** A direct result Ref is not self-authenticating. Its applied application
 * selects the terminal cursor, which must re-produce this exact paid result. */
export async function readDiscoveryFinalAssessmentPaidResultAt(store: Store, project: string, at: Ref) {
  const result = exact<DiscoveryFinalAssessmentPaidResult>(store, snapshotRef(at),
    DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT_KIND);
  valid(object(result.value) && result.value.contract === DISCOVERY_FINAL_ASSESSMENT_PAID_RESULT
    && result.value.projectId === project && isRef(result.value.application) && isRef(result.value.session),
  'The paid assessment is foreign or incomplete');
  const application = exact<DiscoveryFinalAssessmentApplication>(store, result.value.application,
    DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND);
  valid(application.revision === 1 && object(application.value) && same(application.value.session, result.value.session),
    'The paid assessment names another application');
  const applied = store.get<DiscoveryFinalAssessmentApplication>(application.id, 2);
  valid(applied?.kind === DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND && object(applied.value)
    && hashJson(applied.value as never) === applied.hash && applied.value.state === 'applied'
    && isRef(applied.value.after) && same(applied.value.received, result.value.call),
  'The paid assessment application was not applied');
  const execution = await readDiscoveryFinalAssessmentExecutionAt(store, project, applied.value.after);
  valid(execution.output && same(reference(execution.output), reference(result)) && same(execution.output.value, result.value),
    'The terminal execution does not prove this exact paid assessment');
  return { ...execution, output: result };
}

export interface RunDiscoveryFinalAssessmentOptions {
  profile?: Revision<ReaderPilot>;
  signal?: AbortSignal;
  restoreOnly?: boolean;
  allowance?: number;
  responseCorrection?: Ref;
}

/** Start or restore one assessment of an exact paid D7. Its first origin,
 * application and physical claim commit together; paid outcomes apply before
 * checking any current heads, budget or caller allowance. */
export async function runDiscoveryFinalAssessmentExecution(store: Store, project: string, paidResultRef: Ref,
  preparedRef: Ref, options: RunDiscoveryFinalAssessmentOptions = {}) {
  const exactSource = snapshotRef(paidResultRef), exactPrepared = snapshotRef(preparedRef);
  const { profile: suppliedProfile, signal, restoreOnly, allowance } = options;
  const suppliedProfileRef = suppliedProfile ? reference(suppliedProfile) : undefined;
  valid(allowance === undefined || Number.isSafeInteger(allowance) && allowance >= 0,
    'The assessment allowance must be a nonnegative integer');
  const id = discoveryFinalAssessmentExecutionId(exactSource, exactPrepared);
  let used = 0;
  for (;;) {
    let saved = store.get<DiscoveryFinalAssessmentExecution>(id);
    let prepared: Revision<DiscoveryFinalAssessmentSession>;
    let source: Awaited<ReturnType<typeof readDiscoveryFinalAssessmentSourceAt>>;
    let historical: Awaited<ReturnType<typeof readDiscoveryFinalAssessmentExecutionAt>> | undefined;
    if (saved) {
      historical = await readDiscoveryFinalAssessmentExecutionAt(store, project, reference(saved));
      valid(same(reference(historical.prepared), exactPrepared) && same(reference(historical.source.paid), exactSource),
        'The saved assessment names another source or preparation');
      prepared = historical.prepared;
      source = historical.source;
      if (historical.result) return historical;
      saved = historical.session;
    } else {
      source = await readDiscoveryFinalAssessmentSourceAt(store, project, exactSource);
      prepared = await readDiscoveryFinalAssessmentSessionAt(store, project, exactPrepared);
      valid(same(source.packet.subject, prepared.value.subject),
        'The prepared assessment is not the subject of this exact paid D7');
      if (restoreOnly) throw new EngineError('discovery_final_assessment_execution_invalid', 'There is no saved assessment to restore');
    }
    let session: Revision<DiscoveryFinalAssessmentExecution>;
    let createSession: Write | undefined;
    if (saved) session = saved;
    else {
      requireCondition(allowance !== 0, 'research_call_allowance', 'No new assessment call is allowed');
      const final = prepared.value.subject.subject;
      const draft = exact<DiscoveryDraft>(store, final.basis.draft, 'discovery-draft');
      const environment = exact<Environment>(store, prepared.value.environment, 'environment');
      const profile = suppliedProfileRef ? exact<ReaderPilot>(store, suppliedProfileRef, 'reader-pilot') : undefined;
      valid(!profile || object(profile.value) && profile.value.projectId === project,
        'An assessment profile belongs to another project or is incomplete');
      const value: DiscoveryFinalAssessmentExecution = { contract: DISCOVERY_FINAL_ASSESSMENT_EXECUTION,
        projectId: project, source: exactSource, prepared: reference(prepared), subject: prepared.value.subject,
        binding: { draft: reference(draft), question: final.basis.brief.question,
          environment: reference(environment), inputs: draft.value.inputs },
        role: prepared.value.role, dispatch: environment.value, profile: profile ? reference(profile) : null,
        prompt: prepared.value.input.prompt, step: 0, offset: 0, notes: [], workspace: contextWorkspace(),
        previous: null, application: discoveryFinalAssessmentApplicationId({ id, revision: 1, hash: '' }), result: null };
      createSession = { id, kind: DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND, expected: 0, value };
      session = { ...pendingRef(createSession), kind: createSession.kind, value };
    }
    const originalApplication=store.get<DiscoveryFinalAssessmentApplication>(session.value.application,1);
    const correction=options.responseCorrection ? await readDiscoveryFinalAssessmentResponseCorrection(store,project,options.responseCorrection) : null;
    const correctionWrite=correction?.retry && !restoreOnly ? responseCorrectionApplicationWrite(correction) : null;
    const existing=correctionWrite ? null : originalApplication ? latestResponseApplication(store,originalApplication) : null;
    const applicationId=correctionWrite?.id ?? existing?.id ?? session.value.application;
    if (existing) {
      const application = exact<DiscoveryFinalAssessmentApplication>(store, reference(existing), DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND);
      valid(historical, 'An assessment application cannot exist without its proven execution');
      const call = store.get<ModelCall>(assessmentCallId(reference(application)));
      valid(call?.kind === 'model-call' && object(call.value), 'The assessment application has no physical reservation');
      if (call.value.status === 'running') {
        const admission = readDiscoveryFinalAssessmentDispatchLeaf(store, reference(application));
        valid(same(reference(admission.session), reference(session))
          && same(reference(admission.prepared), reference(historical.prepared)), 'The assessment application names another cursor');
        if (restoreOnly) return historical;
        requireCondition(allowance === undefined || used < allowance, 'research_call_allowance', 'No new assessment call is allowed');
        await resumeDiscoveryFinalAssessmentResearchCall(store, reference(application), signal);
        used++;
        continue;
      }
      const { admission, paid } = await physicalAssessmentOutcome(store, project, reference(application), reference(call));
      valid(same(reference(admission.session), reference(session))
        && same(reference(admission.prepared), reference(historical.prepared)), 'The assessment application names another cursor');
      const projected = await projectAssessmentStep(store, admission, paid);
      const after: Write = { id: session.id, kind: session.kind, expected: session.revision, value: projected.after };
      const claim = store.get<ModelCall>(call.id, 1);
      valid(claim, 'The assessment application lost its reservation claim');
      const applied: Write = { id: application.id, kind: application.kind, expected: 1,
        value: { ...application.value, state: 'applied', call: reference(claim), received: reference(paid.call), after: pendingRef(after) } };
      try {
        store.writeMany([after, applied, ...(projected.output ? [projected.output] : [])],
          uniqueTransactionGuards([reference(session), reference(application), reference(call), paid.request, paid.response, paid.archive]));
      } catch (error) {
        if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
        const winner = store.get<DiscoveryFinalAssessmentExecution>(id);
        if (!winner || winner.revision <= session.revision) throw error;
      }
      if(options.responseCorrection) return readDiscoveryFinalAssessmentExecutionAt(store,project,pendingRef(after));
      continue;
    }
    if (restoreOnly && saved) return historical!;
    requireCondition(allowance === undefined || used < allowance, 'research_call_allowance', 'No new assessment call is allowed');
    const draft = exact<DiscoveryDraft>(store, session.value.binding.draft, 'discovery-draft');
    const question = exact<Question>(store, session.value.binding.question, 'question');
    const environment = exact<Environment>(store, session.value.binding.environment, 'environment');
    const profile = session.value.profile ? exact<ReaderPilot>(store, session.value.profile, 'reader-pilot') : undefined;
    const { capacity, original } = readAssessmentRequestArchive(store, prepared);
    valid(object(original) && original.contract === DISCOVERY_FINAL_ASSESSMENT_RESULT && object(original.packet)
      && same(original.subject, session.value.subject) && same(original.packet, source.packet)
      && same(original.schema, prepared.value.envelope.packet.schema), 'The assessment invocation lost its proven request');
    const origin = createSession ? session : store.get<DiscoveryFinalAssessmentExecution>(id, 1);
    valid(origin, 'The assessment execution lost its original cursor');
    const marker: FinalAssessmentContinuation = { subject: session.value.subject, source: exactSource,
      prepared: reference(prepared), execution: createSession ? reference(origin) : reference(exact<DiscoveryFinalAssessmentExecution>(
        store, reference(origin), DISCOVERY_FINAL_ASSESSMENT_EXECUTION_KIND)) };
    const context = { ...(finalMaterialEra(prepared.value.input) ? {finalMaterial:finalMaterialProjection(original.packet)} : {}),
      finalContinuation: marker, request: original, schema: prepared.value.envelope.packet.schema,
      resultCapacity: capacity, contextWorkspace: finalWorkspace(prepared.value.input, session.value.workspace) };
    const partial = { session, source, prepared, proven: source.packet, draft, question, environment, profile };
    const guards = currentDiscoveryFinalAssessmentGuards(store, project,
      partial as unknown as Awaited<ReturnType<typeof readDiscoveryFinalAssessmentDispatchAdmission>>);
    const value: DiscoveryFinalAssessmentApplication = { contract: DISCOVERY_FINAL_ASSESSMENT_APPLICATION,
      projectId: project, session: reference(session), context, prompt: session.value.prompt, role: session.value.role,
      dispatch: session.value.dispatch, profile: session.value.profile, guards,
      state: 'prepared', call: null, received: null, after: null };
    const application: Write = { id: applicationId, kind: DISCOVERY_FINAL_ASSESSMENT_APPLICATION_KIND, expected: 0, value };
    if(correctionWrite) application.value=correctionWrite.value;
    try {
      await researchCall(session.value.role, session.value.dispatch, session.value.prompt, (application.value as DiscoveryFinalAssessmentApplication).context, signal,
        { store, draftId: draft.id, questionId: question.id, purpose: 'discovery-final-assessment',
          session: reference(session), application: pendingRef(application),
          finalAssessmentPending: { ...(createSession ? { session: createSession } : {}), application },
          ...(profile ? { pilot: profile } : {}) });
      used++;
    } catch (error) {
      if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
      const winner = store.get<DiscoveryFinalAssessmentApplication>(applicationId, 1);
      if (!winner || !same(winner.value, application.value)) throw error;
    }
  }
}
