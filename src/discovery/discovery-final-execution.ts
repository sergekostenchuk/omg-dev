import { pendingContextWorkspace } from './context-workspace.js';
import { finalMaterialAdmission, finalMaterialProjection, finalMaterialEra, finalWorkspace, packFinalMaterial, recordFinalMaterialWorkspace, finalTechnicalLookup } from './final-material.js';
import { correctingApplicationLeaf, latestResponseApplication, readApplicationResponseCorrection,
  responseCorrectionApplicationWrite, type ApplicationResponseCorrection } from './application-response-correction.js';
import { finalResponseContract } from './discovery-response-contract.js';
import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Environments, transactionGuardsCurrent, uniqueTransactionGuards,
  type Environment, type RoleBinding } from '../runtime/environment.js';
import type { Revision, Store, TransactionGuard, Write } from '../storage/store.js';
import { pendingOverlay } from '../storage/store-view.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { addContextLookup, contextProgress, contextWorkspace, packContextWorkspace,
  requireCompleteContextPacket, type ContextWorkspace } from './context-workspace.js';
import type { FinalContinuation } from './continuation-packet.js';
import { V7_FINAL_CONTRACT } from './v7-final-contracts.js';
import { DISCOVERY_FINAL_RESULT, checkDiscoveryFinalResearchReply,
  type DiscoveryFinalResultProjection } from './discovery-final-result.js';
import { DISCOVERY_FINAL_SESSION, DISCOVERY_FINAL_SESSION_KIND, readDiscoveryFinalSessionAt,
  type DiscoveryFinalSession } from './discovery-final-session.js';
import type { DiscoveryFinalPacket, DiscoveryFinalSubject } from './discovery-final.js';
import type { ReaderPilot } from './reader-pilot.js';
import { readFinalCapacityProjection } from './early-research-outcome.js';
import { currentPlan } from './v7-plan-questions.js';
import { readCurrentVariantScope } from './variant-scope.js';
import { variantStateId, type VariantHandoff } from './variant-decision.js';
import { readVariantGeneration, readVariantModelDecision } from './variant-session.js';
import { readVariantOwnerDecision } from './discovery-decision.js';
import { readProjectMode } from '../product/project-mode.js';
import { prepareArchiveParts, readArchiveBody } from './request-parts.js';
import { contextValue } from './working-context.js';
import { addressArchivedMaterials, requirePacketMaterialDelivery, serveArchivedMaterial } from './research-delivery.js';
import { readDiscoveryFinalResearchExecution, readResearchContextOutcomeAt } from './response-recovery.js';
import { researchAction, researchCall, resumeDiscoveryFinalResearchCall } from './research-protocol.js';
import type { ModelCall } from '../runtime/model-usage.js';

export const DISCOVERY_FINAL_EXECUTION = 'discovery-final-execution/v1' as const;
export const DISCOVERY_FINAL_APPLICATION = 'discovery-final-application/v1' as const;
export const DISCOVERY_FINAL_EXECUTION_KIND = 'discovery-final-execution' as const;
export const DISCOVERY_FINAL_APPLICATION_KIND = 'discovery-final-application' as const;
export const DISCOVERY_FINAL_PAID_RESULT = 'discovery-final-paid-result/v1' as const;
export const DISCOVERY_FINAL_PAID_RESULT_KIND = 'discovery-final-paid-result' as const;

/** The mutable physical cursor is a different contract from the immutable
 * prepared session. A result here is paid, not assessed or accepted. */
export interface DiscoveryFinalExecution {
  [key: string]: unknown;
  contract: typeof DISCOVERY_FINAL_EXECUTION;
  projectId: string;
  prepared: Ref;
  subject: DiscoveryFinalSubject;
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

export interface DiscoveryFinalPaidResult {
  contract: typeof DISCOVERY_FINAL_PAID_RESULT;
  projectId: string;
  prepared: Ref;
  subject: DiscoveryFinalSubject;
  session: Ref;
  application: Ref;
  call: Ref;
  request: Ref;
  response: Ref;
  projection: DiscoveryFinalResultProjection;
}

export interface DiscoveryFinalApplication {
  [key: string]: unknown;
  contract: typeof DISCOVERY_FINAL_APPLICATION;
  projectId: string;
  session: Ref;
  context: Record<string, any>;
  prompt: string;
  role: RoleBinding;
  dispatch: Environment;
  profile: Ref | null;
  guards: TransactionGuard[];
  state: 'prepared' | 'running' | 'applied';
  call: Ref | null;
  received: Ref | null;
  after: Ref | null;
  responseCorrection?: ApplicationResponseCorrection;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const object = (value: unknown): value is Record<string, any> => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, names: string[]) => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
function valid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'discovery_final_execution_invalid', message);
}
function snapshotRef(ref: Ref): Ref {
  let snapshot: unknown;
  try { snapshot = JSON.parse(canonical(ref)); }
  catch { throw new EngineError('discovery_final_execution_invalid', 'A final execution needs an exact immutable reference'); }
  valid(isRef(snapshot) && object(snapshot) && Object.keys(snapshot).sort().join(',') === 'hash,id,revision',
    'A final execution needs an exact immutable reference');
  return snapshot;
}
function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  const snapshot = snapshotRef(ref);
  const row = store.get<T>(snapshot.id, snapshot.revision);
  valid(row?.kind === kind && same(reference(row), snapshot) && hashJson(row.value as never) === row.hash,
    'A final execution source is missing, foreign or changed');
  return row;
}

export const discoveryFinalExecutionId = (prepared: Ref) =>
  `discovery-final-execution:${hashJson([DISCOVERY_FINAL_EXECUTION, prepared])}`;
export const discoveryFinalApplicationId = (session: Ref) =>
  `discovery-final-application:${hashJson([DISCOVERY_FINAL_APPLICATION, session.id, session.revision])}`;

/** This marker contains the immutable origin, not the changing cursor. */
export function finalContinuation(store: Store, session: Revision<DiscoveryFinalExecution>): FinalContinuation {
  const origin = store.get<DiscoveryFinalExecution>(session.id, 1);
  valid(object(session.value) && origin && origin.kind === DISCOVERY_FINAL_EXECUTION_KIND && object(origin.value)
    && hashJson(origin.value as never) === origin.hash
    && origin.value.contract === DISCOVERY_FINAL_EXECUTION && same(origin.value.prepared, session.value.prepared)
    && same(origin.value.subject, session.value.subject), 'The final execution has no exact origin');
  return { subject: structuredClone(origin.value.subject), prepared: structuredClone(origin.value.prepared),
    execution: reference(origin) };
}

/** Read this preparation's exact archived result declaration once. The caller
 * must separately prove the prepared session and its underlying D6. */
function readFinalRequestArchive(store: Store, prepared: Revision<DiscoveryFinalSession>) {
  const capacity = prepared.value.envelope?.capacity;
  valid(capacity?.mandatory && 'archive' in capacity.mandatory
    && same(capacity.mandatory.archive.record, prepared.value.archive), 'The final result capacity lost its archive');
  const archive = capacity.mandatory.archive;
  const minimum = readFinalCapacityProjection(store, archive.record, archive.pointer);
  const original = archive.pointer === '/body/admission' ? readFinalCapacityProjection(store, archive.record, '/body/request') : minimum;
  // One snapshot establishes both its saved hash and exact comparison.
  const originalText = canonical(original);
  valid(hashJson(minimum as never) === archive.hash
    && (archive.pointer !== '/body/admission' || same(minimum, finalMaterialAdmission(original))), 'The final capacity archive differs from its exact hash');
  return { capacity, original, originalText };
}

/** Historical leaf admission. Current heads and budget are deliberately not
 * read here: a paid response must remain provable after they have moved. */
function readDiscoveryFinalDispatchLeafOriginal(store: Store, applicationRef: Ref) {
  const application = exact<DiscoveryFinalApplication>(store, applicationRef, DISCOVERY_FINAL_APPLICATION_KIND);
  const app = application.value;
  valid(application.revision === 1 && object(app) && app.contract === DISCOVERY_FINAL_APPLICATION && isRef(app.session),
    'The final application needs its immutable prepared origin');
  const session = exact<DiscoveryFinalExecution>(store, app.session, DISCOVERY_FINAL_EXECUTION_KIND);
  const value = session.value;
  valid(keys(value, ['contract', 'projectId', 'prepared', 'subject', 'binding', 'role', 'dispatch', 'profile',
    'prompt', 'step', 'offset', 'notes', 'workspace', 'previous', 'application', 'result'])
    && keys(app, ['contract', 'projectId', 'session', 'context', 'prompt', 'role', 'dispatch', 'profile',
      'guards', 'state', 'call', 'received', 'after'])
    && value.contract === DISCOVERY_FINAL_EXECUTION && value.projectId === app.projectId
    && isRef(value.prepared) && session.id === discoveryFinalExecutionId(value.prepared)
    && value.application === application.id && application.id === discoveryFinalApplicationId(reference(session))
    && value.step === session.revision - 1 && value.offset === 0 && Array.isArray(value.notes)
    && object(value.workspace) && value.result === null, 'The final cursor is foreign or incomplete');
  const origin = store.get<DiscoveryFinalExecution>(session.id, 1);
  valid(origin && origin.kind === DISCOVERY_FINAL_EXECUTION_KIND && object(origin.value)
    && hashJson(origin.value as never) === origin.hash,
    'The final execution lost its origin');
  for (const key of ['contract', 'projectId', 'prepared', 'subject', 'binding', 'role', 'dispatch', 'profile', 'prompt'] as const)
    valid(same(value[key], origin.value[key]), 'The original final execution identity changed');
  valid(origin.value.step === 0 && origin.value.previous === null && origin.value.result === null
    && same(origin.value.notes, []) && same(origin.value.workspace, contextWorkspace()),
    'The final execution origin is not an initial cursor');
  const prepared = exact<DiscoveryFinalSession>(store, value.prepared, DISCOVERY_FINAL_SESSION_KIND);
  valid(prepared.revision === 1 && object(prepared.value) && prepared.value.contract === DISCOVERY_FINAL_SESSION
    && prepared.value.project === value.projectId && prepared.value.state === 'prepared'
    && prepared.value.result === null && same(prepared.value.cursor, { offset: 0 })
    && same(prepared.value.subject, value.subject), 'The final execution lost its immutable preparation');
  const { original, originalText } = readFinalRequestArchive(store, prepared);
  const binding = value.binding;
  valid(object(binding) && isRef(binding.draft) && isRef(binding.question) && isRef(binding.environment)
    && Array.isArray(binding.inputs) && binding.inputs.every(isRef), 'The final research binding is incomplete');
  const draft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft');
  const question = exact<Question>(store, binding.question, 'question');
  const environment = exact<Environment>(store, binding.environment, 'environment');
  const profile = value.profile === null ? undefined : exact<ReaderPilot>(store, value.profile, 'reader-pilot');
  valid(object(draft.value) && object(question.value) && object(environment.value)
    && (!profile || object(profile.value)) && same(value.subject, prepared.value.subject)
    && same(reference(draft), value.subject.basis.draft)
    && same(reference(question), value.subject.basis.brief.question)
    && draft.value.projectId === value.projectId && question.value.projectId === value.projectId
    && question.value.draftId === draft.id && draft.value.questions.includes(question.id)
    && same(draft.value.inputs, binding.inputs) && same(reference(environment), prepared.value.environment)
    && environment.value.projectId === value.projectId && same(value.dispatch, environment.value)
    && same(value.role, prepared.value.role) && value.prompt === prepared.value.input.prompt
    && (!profile || profile.value.projectId === value.projectId),
  'The final execution runtime or exact research grounds differ from its preparation');
  const marker = finalContinuation(store, session);
  valid(keys(app.context, ['finalContinuation', 'request', 'schema', 'resultCapacity', 'contextWorkspace',
    ...(finalMaterialEra(prepared.value.input) ? ['finalMaterial'] : [])])
    && (!finalMaterialEra(prepared.value.input) || same(app.context.finalMaterial,finalMaterialProjection(original.packet)))
    && same(app.context.finalContinuation, marker)
    && canonical(app.context.request) === originalText
    && same(app.context.schema, prepared.value.envelope.packet.schema)
    && same(app.context.resultCapacity, prepared.value.envelope.capacity)
    && same(app.context.contextWorkspace, finalWorkspace(prepared.value.input, value.workspace))
    && app.prompt === value.prompt && same(app.role, value.role) && same(app.dispatch, value.dispatch)
    && same(app.profile, value.profile) && app.state === 'prepared' && app.call === null
    && app.received === null && app.after === null && Array.isArray(app.guards)
    && same(app.guards, uniqueTransactionGuards(app.guards)),
  'The final application differs from its complete saved subject, runtime or cursor');
  valid([binding.draft, binding.question, binding.environment, ...binding.inputs, ...(value.profile ? [value.profile] : [])]
    .every(ref => app.guards.some(guard => same(guard, ref))), 'The final application lost an original guard');
  return { application, session, prepared, draft, question, environment, profile, original,
    context: app.context, role: value.role, dispatch: value.dispatch, prompt: value.prompt };
}

/** The leaf authenticates the physical association; the producer additionally
 * proves the original paid D6 and full result declaration before using it. */
export function readDiscoveryFinalDispatchLeaf(store: Store, applicationRef: Ref): ReturnType<typeof readDiscoveryFinalDispatchLeafOriginal> {
  const application=exact<DiscoveryFinalApplication>(store,applicationRef,DISCOVERY_FINAL_APPLICATION_KIND);
  return correctingApplicationLeaf(store,application,ref=>readDiscoveryFinalDispatchLeafOriginal(store,ref))
    ?? readDiscoveryFinalDispatchLeafOriginal(store,applicationRef);
}

export async function readDiscoveryFinalDispatchAdmission(store: Store, applicationRef: Ref) {
  const leaf = readDiscoveryFinalDispatchLeaf(store, applicationRef);
  if(leaf.application.value.responseCorrection)
    await readDiscoveryFinalResponseCorrection(store,leaf.session.value.projectId,leaf.application.value.responseCorrection.root);
  // A later cursor's historical reader already re-proves the same prepared
  // session while checking every prior paid step. Do that once; an origin
  // without prior steps still uses the session reader directly.
  const historical = leaf.session.revision > 1
    ? await readDiscoveryFinalExecutionAt(store, leaf.session.value.projectId, reference(leaf.session)) : null;
  const prepared = historical ? historical.prepared
    : await readDiscoveryFinalSessionAt(store, leaf.session.value.projectId, leaf.session.value.prepared);
  valid(!historical || same(reference(historical.session), reference(leaf.session)),
    'The final admission names another historical cursor');
  // The session reader has just rebuilt the final subject, capacity and schema
  // from the paid D6, compared the entire prepared cell and proved the exact
  // saved archive. The leaf independently read that same capacity archive and
  // checked its hash before comparing it with the application context. Reuse
  // that proven archive in this admission instead of unfolding the same D6 a
  // second time; nothing is cached across calls or across Store mutations.
  const request = leaf.original;
  valid(same(reference(leaf.prepared), reference(prepared)) && object(request)
    && request.contract === DISCOVERY_FINAL_RESULT && object(request.packet)
    && same(request.subject, prepared.value.subject)
    && same(leaf.context.request, request)
    && same(leaf.context.schema, request.schema)
    && same(leaf.context.schema, prepared.value.envelope.packet.schema),
  'The final admission differs from its proven D6 and schema');
  const proven = { packet: request.packet as DiscoveryFinalPacket };
  return { ...leaf, prepared, proven };
}

/** Stage the actual invocation archive without publishing it. The archive
 * contains the complete proven request and cursor, while the packet uses the
 * common addressed-material and workspace delivery mechanisms. */
export function prepareDiscoveryFinalContextPacker(store: Store,
  admission: Awaited<ReturnType<typeof readDiscoveryFinalDispatchAdmission>>) {
  const { session, prepared, context } = admission;
  // This small supplement stays inline: the paid archive retains its historical context exactly.
  const discoveryResponseContract = finalResponseContract(false);
  const staged = prepareArchiveParts(store, {
    projectId: session.value.projectId, draft: session.value.binding.draft,
    question: session.value.binding.question,
  }, structuredClone(context));
  const records = new Map<string, Revision<any>>();
  for (const write of staged.writes as Write[]) records.set(write.id, {
    id: write.id, kind: write.kind, revision: write.expected + 1,
    hash: hashJson(write.value as never), value: write.value,
  });
  // This read-only overlay exists only to measure the exact pending archive;
  // none of its synthetic revisions can authorize an application or call.
  const view = pendingOverlay(store, [...records.values()]);
  const archive = staged.archive;
  const resolve = (record: Ref, pointer: string) => {
    const row = view.get(record.id, record.revision);
    valid(row?.kind === 'research-context' && same(reference(row), record),
      'The final packet address is not an exact archive');
    return contextValue({ body: readArchiveBody(view, row).body }, pointer);
  };
  return {
    view,
    pack(limit: number): Record<string, any> {
      const packetLimit = Math.min(limit, prepared.value.input.packetChars);
      const packet: Record<string, any> = {
        contract: 'discovery-final-envelope/v1', subject: structuredClone(session.value.subject),
        schema: structuredClone(context.schema), discoveryResponseContract, request: structuredClone(context.request),
        finalContinuation: structuredClone(context.finalContinuation),
        resultCapacity: structuredClone(context.resultCapacity),
        contextWorkspace: structuredClone(context.contextWorkspace),
        ...(context.failures ? {failures:structuredClone(context.failures)} : {}),
        working: { archive, deliveryContract: 'research-delivery/v1',
          instruction: 'Read each exact omitted address with read_context and continue through every page before returning a final result.' },
      };
      if (finalMaterialEra(prepared.value.input))
        packFinalMaterial(packet, context.request, archive, prepared.value.archive, packetLimit, session.value.workspace);
      else {
      const originals = addressArchivedMaterials(packet, archive, ['request'], packetLimit,
        () => prepared.value.archive, 2048);
      packContextWorkspace(packet, packetLimit, packetLimit, undefined, 1024);
      serveArchivedMaterial(packet, originals, packetLimit, 512);
      }
      requirePacketMaterialDelivery(packet, archive, resolve);
      valid(JSON.stringify(packet).length <= packetLimit, 'The final transport packet exceeds its saved limit');
      return packet;
    },
    staged: () => ({ writes: staged.writes, guards: staged.guards, records }),
  };
}

/** New sends alone require current choices, plan, environment and controls.
 * The returned guards are carried into the common atomic reservation. */
export function currentDiscoveryFinalGuards(store: Store, project: string,
  admission: Awaited<ReturnType<typeof readDiscoveryFinalDispatchAdmission>>): TransactionGuard[] {
  const { session, prepared, proven, draft, question, environment, profile } = admission;
  const plan = currentPlan(store, project), effective = new Environments(store).effective(project);
  valid(session.value.projectId === project && same(reference(plan.draft), reference(draft))
    && same(plan.planAnswer, session.value.subject.basis.plan)
    && same(reference(effective.environment), reference(environment)),
  'The final draft, plan or runtime is no longer current');
  const frameAnswer = proven.packet.basis.frame.value as Record<string, any>;
  const frame = typeof frameAnswer?.question === 'string' ? store.get<Question>(frameAnswer.question) : null;
  valid(frame?.kind === 'question' && frame.value.projectId === project && frame.value.draftId === draft.id
    && frame.value.spec?.field === 'frame' && frame.value.status === 'answered'
    && same(frame.value.answer, session.value.subject.basis.frame), 'The saved final frame is no longer current');
  const guards: TransactionGuard[] = [reference(draft), reference(question), reference(plan.question), reference(frame),
    session.value.subject.basis.plan, session.value.subject.basis.frame, reference(environment), ...draft.value.inputs,
    ...effective.guards, ...effective.admissionGuards, ...(profile ? [reference(profile)] : [])];
  const route = proven.packet.dossier.route;
  if (route.scope) {
    const selected = readCurrentVariantScope(store, project, reference(draft));
    valid(same(reference(selected.scope), route.scope.ref), 'The selected dossier is no longer the current choice');
    guards.push(reference(selected.scope), reference(selected.state), readProjectMode(store, project).ref);
  } else if (route.handoff) {
    const handoff = route.handoff.value as unknown as VariantHandoff;
    let selection: Ref | null = null, mode: Ref | null = null;
    if (handoff.result) {
      const generation = readVariantGeneration(store, project, handoff.result);
      selection = generation.state; mode = generation.session.value.variantSubject.mode;
    }
    if (handoff.decision) {
      const row = store.get(handoff.decision.id, handoff.decision.revision);
      valid(row, 'The final handoff decision is missing');
      if (row.kind === 'discovery-variant-owner-decision') {
        const choice = readVariantOwnerDecision(store, project, handoff.decision);
        selection = reference(choice.state); mode = choice.decision.value.mode;
      } else {
        const choice = readVariantModelDecision(store, project, handoff.decision);
        selection = choice.state; mode = choice.decision.value.mode;
      }
    }
    const modeId = `project-mode:${project}`;
    const noMode = handoff.reason === 'early_limit' && handoff.result === null && store.history(modeId).length === 0;
    const currentMode = noMode ? null : readProjectMode(store, project);
    valid(!mode || currentMode && same(mode, currentMode.ref), 'The final handoff mode is no longer current');
    const stateId = variantStateId(project, draft.id), state = store.get(stateId);
    valid(selection ? state && same(reference(state), selection) : !state && !store.history(stateId).length,
      'The final handoff selection is no longer current');
    guards.push(route.handoff.ref, ...(handoff.stop?.grounds ?? []),
      ...[handoff.snapshot, handoff.result, handoff.decision].filter((ref): ref is Ref => ref !== null),
      currentMode ? currentMode.ref : { id: modeId, absent: true },
      state ? reference(state) : { id: stateId, absent: true });
  }
  valid(same(reference(prepared), session.value.prepared), 'The final preparation changed');
  const complete = uniqueTransactionGuards(guards);
  valid(transactionGuardsCurrent(store, complete), 'The current final admission moved before dispatch');
  return complete;
}

const pendingRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1,
  hash: hashJson(write.value as never) });
const finalCallId = (application: Ref) => `model-call:final:v1:${hashJson(application)}`;
const finalResultId = (application: Ref) => `discovery-final-paid-result:${hashJson(application)}`;

async function physicalFinalOutcome(store: Store, project: string, application: Ref, received: Ref) {
  // The shared reader re-reads this exact leaf itself and uses it for the
  // physical proof; no caller-supplied admission crosses that boundary.
  const { admission, paid } = readDiscoveryFinalResearchExecution(store, project, received, application);
  const claim = store.get<ModelCall>(finalCallId(reference(admission.application)), 1);
  valid(claim && claim.kind === 'model-call' && object(claim.value)
    && hashJson(claim.value as never) === claim.hash
    && same((claim.value as unknown as Record<string, unknown>).finalApplication,
    reference(admission.application)), 'The final application lost its unique reservation');
  valid(paid.call.id === claim.id && paid.kind === 'response',
    'Only this exact physical final response can advance the cursor');
  return { admission, paid };
}

/** One projector is used both when applying an answer and when checking every
 * historical cursor revision. It never treats a paid result as acceptance. */
async function projectFinalStepUnchecked(store: Store, admission: ReturnType<typeof readDiscoveryFinalDispatchLeaf>,
  paid: Awaited<ReturnType<typeof physicalFinalOutcome>>['paid']) {
  const { session, application, draft, question } = admission;
  const materialEra = finalMaterialEra(admission.prepared.value.input);
  let workspace = contextWorkspace(materialEra ? recordFinalMaterialWorkspace(session.value.workspace, paid.subject) : session.value.workspace);
  let result: Ref | null = null;
  let output: Write | null = null;
  const response = paid.payload;
  if (object(response) && response.action === 'read_context') {
    const action = researchAction(response);
    valid(action.action === 'read_context', 'A final lookup must retain its exact address');
    const addresses = paid.subject.working?.materialAddresses;
    valid((finalMaterialEra(admission.prepared.value.input) && finalTechnicalLookup(paid.subject, admission.context.request, action))
      || Array.isArray(addresses) && addresses.some((address: Record<string, any>) =>
      same(address.record, action.record)
      && (action.pointer === address.pointer || action.pointer.startsWith(`${address.pointer}/`))),
    'A final lookup must address material of this exact paid packet');
    const lookup = readResearchContextOutcomeAt(store, draft, question, action,
      admission.profile?.value.maxRequestChars ?? 300000, 'bounded');
    workspace = addContextLookup(workspace, lookup, paid.subject.contextWorkspace, undefined, materialEra ? undefined : paid.subject);
  } else {
    requireCompleteContextPacket(materialEra ? pendingContextWorkspace(session.value.workspace) : workspace, paid.subject);
    const checked = await checkDiscoveryFinalResearchReply(store, session.value.projectId,
      admission.context.request.packet, admission.prepared.value.input.resultLimitChars,
      admission.context.resultCapacity, response, admission.prepared.value.input.form ?? V7_FINAL_CONTRACT);
    workspace = contextProgress(workspace, materialEra ? undefined : paid.subject);
    const value: DiscoveryFinalPaidResult = { contract: DISCOVERY_FINAL_PAID_RESULT,
      projectId: session.value.projectId, prepared: session.value.prepared,
      subject: session.value.subject, session: reference(session), application: reference(application),
      call: reference(paid.call), request: paid.request, response: paid.response, projection: checked.projection };
    output = { id: finalResultId(reference(application)), kind: DISCOVERY_FINAL_PAID_RESULT_KIND,
      expected: 0, value };
    result = pendingRef(output);
  }
  const after: DiscoveryFinalExecution = { ...session.value, step: session.value.step + 1,
    workspace, previous: reference(application), result,
    application: result ? application.id : discoveryFinalApplicationId({
      id: session.id, revision: session.revision + 1, hash: '' }) };
  return { after, output };
}

export async function readDiscoveryFinalResponseCorrection(store:Store,project:string,root:Ref) {
  return readApplicationResponseCorrection(store,project,root,{
    read:ref=>readDiscoveryFinalDispatchLeaf(store,ref).application,
    outcome:async application=>{
      const head=store.get<ModelCall>(finalCallId(reference(application)));
      if(!head || head.value.status==='running') return null;
      return readDiscoveryFinalResearchExecution(store,project,reference(head),reference(application)).paid;
    },
    project:async(application,paid)=>{
      valid(paid.kind==='response','Only a paid response has a closed role form');
      return projectFinalStepUnchecked(store,readDiscoveryFinalDispatchLeaf(store,reference(application)),
        paid as Awaited<ReturnType<typeof physicalFinalOutcome>>['paid']);
    },
    formCodes:['discovery_final_result_invalid','research_response_invalid','research_context_incomplete'],
  });
}

async function projectFinalStep(store:Store,admission:ReturnType<typeof readDiscoveryFinalDispatchLeaf>,
  paid:Awaited<ReturnType<typeof physicalFinalOutcome>>['paid']) {
  if(admission.application.value.responseCorrection)
    await readDiscoveryFinalResponseCorrection(store,admission.session.value.projectId,admission.application.value.responseCorrection.root);
  return projectFinalStepUnchecked(store,admission,paid);
}

/** Prove the complete paid chain against its immutable origins, without
 * consulting today's heads, allowances, current budget or runtime. */
export async function readDiscoveryFinalExecutionAt(store: Store, project: string, at: Ref) {
  const targetRef = snapshotRef(at);
  const target = exact<DiscoveryFinalExecution>(store, targetRef, DISCOVERY_FINAL_EXECUTION_KIND);
  valid(object(target.value) && target.value.projectId === project && isRef(target.value.prepared)
    && target.id === discoveryFinalExecutionId(target.value.prepared), 'The final execution belongs to another subject');
  const first = store.get<DiscoveryFinalExecution>(target.id, 1);
  valid(first && first.kind === DISCOVERY_FINAL_EXECUTION_KIND, 'The final execution has no origin');
  let previous = exact<DiscoveryFinalExecution>(store, reference(first), DISCOVERY_FINAL_EXECUTION_KIND);
  valid(object(previous.value) && isRef(previous.value.prepared), 'The final execution origin has no preparation');
  const prepared = await readDiscoveryFinalSessionAt(store, project, previous.value.prepared);
  valid(previous.value.step === 0 && previous.value.previous === null && previous.value.result === null
    && previous.value.application === discoveryFinalApplicationId(reference(previous))
    && same(previous.value.subject, prepared.value.subject), 'The final execution origin is invalid');
  const firstApplication = store.get<DiscoveryFinalApplication>(previous.value.application, 1);
  valid(firstApplication, 'The final execution has no exact origin application');
  if (target.revision === 1) {
    const admission = readDiscoveryFinalDispatchLeaf(store, reference(firstApplication));
    valid(same(reference(admission.session), reference(previous)), 'The final execution has no exact origin application');
  }
  let output: Revision<DiscoveryFinalPaidResult> | null = null;
  for (let revision = 2; revision <= target.revision; revision++) {
    const row = store.get<DiscoveryFinalExecution>(target.id, revision);
    valid(row, 'The final execution lost a cursor revision');
    const after = exact<DiscoveryFinalExecution>(store, reference(row), DISCOVERY_FINAL_EXECUTION_KIND);
    valid(object(after.value) && isRef(after.value.previous), 'The final cursor lost its prior application');
    const application = exact<DiscoveryFinalApplication>(store, after.value.previous, DISCOVERY_FINAL_APPLICATION_KIND);
    const applied = store.get<DiscoveryFinalApplication>(application.id, 2);
    valid(applied && applied.kind === DISCOVERY_FINAL_APPLICATION_KIND && object(applied.value)
      && hashJson(applied.value as never) === applied.hash
      && isRef(applied.value.call) && isRef(applied.value.received) && same(applied.value.after, reference(after))
      && same(applied.value, { ...application.value, state: 'applied', call: applied.value.call,
        received: applied.value.received, after: reference(after) }), 'The final cursor is not its exact application');
    if (revision === 2) valid(same(application.value.responseCorrection?.root ?? reference(application), reference(firstApplication)),
      'The final execution does not use its exact origin application');
    const { admission, paid } = await physicalFinalOutcome(store, project, reference(application), applied.value.received);
    valid(same(reference(admission.session), reference(previous)), 'A final application belongs to another cursor');
    const claim = store.get<ModelCall>(paid.call.id, 1);
    valid(claim && same(applied.value.call, reference(claim)), 'The application names a different physical claim');
    const projected = await projectFinalStep(store, admission, paid);
    valid(same(after.value, projected.after), 'The final cursor differs from its paid projection');
    if (projected.output) {
      output = exact<DiscoveryFinalPaidResult>(store, pendingRef(projected.output), DISCOVERY_FINAL_PAID_RESULT_KIND);
      valid(same(output.value, projected.output.value), 'The final paid output differs from the checked reply');
    }
    previous = after;
  }
  valid(same(reference(previous), targetRef) && (target.value.result === null ? output === null
    : output && same(reference(output), target.value.result)), 'The final paid output is missing or foreign');
  return { session: target, prepared, output, result: output?.value.projection ?? null };
}

export interface RunDiscoveryFinalOptions {
  profile?: Revision<ReaderPilot>;
  signal?: AbortSignal;
  restoreOnly?: boolean;
  allowance?: number;
  responseCorrection?: Ref;
}

/** Start or restore exactly one paid D7 execution. New claim/session/application
 * writes share the common physical reservation transaction. */
export async function runDiscoveryFinalExecution(store: Store, project: string, preparedRef: Ref,
  options: RunDiscoveryFinalOptions = {}) {
  const exactPrepared = snapshotRef(preparedRef);
  // Capture caller-owned options before any await. AbortSignal remains live,
  // but no getter can change admission, allowance or profile between checks.
  const { profile: suppliedProfile, signal, restoreOnly, allowance } = options;
  const suppliedProfileRef = suppliedProfile ? reference(suppliedProfile) : undefined;
  valid(allowance === undefined || Number.isSafeInteger(allowance) && allowance >= 0,
    'The final allowance must be a nonnegative integer');
  const id = discoveryFinalExecutionId(exactPrepared);
  let used = 0;
  for (;;) {
    let saved = store.get<DiscoveryFinalExecution>(id);
    let prepared: Revision<DiscoveryFinalSession>;
    let historical: Awaited<ReturnType<typeof readDiscoveryFinalExecutionAt>> | undefined;
    if (saved) {
      historical = await readDiscoveryFinalExecutionAt(store, project, reference(saved));
      valid(same(reference(historical.prepared), exactPrepared),
        'The saved final execution names another preparation');
      prepared = historical.prepared;
      if (historical.result) return historical;
      saved = historical.session;
    } else {
      prepared = await readDiscoveryFinalSessionAt(store, project, exactPrepared);
      if (restoreOnly) throw new EngineError('discovery_final_execution_invalid', 'There is no saved final execution to restore');
    }
    let session: Revision<DiscoveryFinalExecution>;
    let createSession: Write | undefined;
    if (saved) session = saved;
    else {
      requireCondition(allowance !== 0, 'research_call_allowance', 'No new final call is allowed');
      const draft = exact<DiscoveryDraft>(store, prepared.value.subject.basis.draft, 'discovery-draft');
      const environment = exact<Environment>(store, prepared.value.environment, 'environment');
      const profile = suppliedProfileRef ? exact<ReaderPilot>(store, suppliedProfileRef, 'reader-pilot') : undefined;
      valid(!profile || profile.value.projectId === project, 'A final profile belongs to another project');
      const value: DiscoveryFinalExecution = { contract: DISCOVERY_FINAL_EXECUTION, projectId: project,
        prepared: reference(prepared), subject: prepared.value.subject,
        binding: { draft: reference(draft), question: prepared.value.subject.basis.brief.question,
          environment: reference(environment), inputs: draft.value.inputs },
        role: prepared.value.role, dispatch: environment.value, profile: profile ? reference(profile) : null,
        prompt: prepared.value.input.prompt, step: 0, offset: 0, notes: [], workspace: contextWorkspace(),
        previous: null, application: discoveryFinalApplicationId({ id, revision: 1, hash: '' }), result: null };
      createSession = { id, kind: DISCOVERY_FINAL_EXECUTION_KIND, expected: 0, value };
      session = { ...pendingRef(createSession), kind: createSession.kind, value };
    }
    const originalApplication=store.get<DiscoveryFinalApplication>(session.value.application,1);
    const correction=options.responseCorrection ? await readDiscoveryFinalResponseCorrection(store,project,options.responseCorrection) : null;
    const correctionWrite=correction?.retry && !restoreOnly ? responseCorrectionApplicationWrite(correction) : null;
    const existing=correctionWrite ? null : originalApplication ? latestResponseApplication(store,originalApplication) : null;
    const applicationId=correctionWrite?.id ?? existing?.id ?? session.value.application;
    if (existing) {
      const application = exact<DiscoveryFinalApplication>(store, reference(existing), DISCOVERY_FINAL_APPLICATION_KIND);
      // The historical reader immediately above already re-proved this exact
      // cursor, its preparation and every paid prior step. The application
      // leaf independently binds its immutable archive to that preparation;
      // do not unfold the same history again merely to apply this response.
      // New physical dispatch still enters the public admission door below.
      valid(historical, 'A final application cannot exist without its proven execution');
      const call = store.get<ModelCall>(finalCallId(reference(application)));
      valid(call?.kind === 'model-call' && object(call.value), 'The final application has no valid physical reservation');
      if (call.value.status === 'running') {
        const admission = readDiscoveryFinalDispatchLeaf(store, reference(application));
        valid(same(reference(admission.session), reference(session))
          && same(reference(admission.prepared), reference(historical.prepared)),
        'The final application names another cursor or preparation');
        if (restoreOnly) return readDiscoveryFinalExecutionAt(store, project, reference(session));
        requireCondition(allowance === undefined || used < allowance,
          'research_call_allowance', 'No new final call is allowed');
        await resumeDiscoveryFinalResearchCall(store, reference(application), signal);
        used++;
        continue;
      }
      const { admission, paid } = await physicalFinalOutcome(store, project, reference(application), reference(call));
      valid(same(reference(admission.session), reference(session))
        && same(reference(admission.prepared), reference(historical.prepared)),
      'The final application names another cursor or preparation');
      const projected = await projectFinalStep(store, admission, paid);
      const after: Write = { id: session.id, kind: session.kind, expected: session.revision, value: projected.after };
      const claim = store.get<ModelCall>(call.id, 1);
      valid(claim, 'The final application lost its reservation claim');
      const applied: Write = { id: application.id, kind: application.kind, expected: 1,
        value: { ...application.value, state: 'applied', call: reference(claim), received: reference(paid.call),
          after: pendingRef(after) } };
      try {
        store.writeMany([after, applied, ...(projected.output ? [projected.output] : [])],
          uniqueTransactionGuards([reference(session), reference(application), reference(call), paid.request,
            paid.response, paid.archive]));
      } catch (error) {
        if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
        const winner = store.get<DiscoveryFinalExecution>(id);
        if (!winner || winner.revision <= session.revision) throw error;
      }
      if(options.responseCorrection) return readDiscoveryFinalExecutionAt(store,project,pendingRef(after));
      continue;
    }
    if (restoreOnly && saved) return readDiscoveryFinalExecutionAt(store, project, reference(session));
    requireCondition(allowance === undefined || used < allowance,
      'research_call_allowance', 'No new final call is allowed');
    const draft = exact<DiscoveryDraft>(store, session.value.binding.draft, 'discovery-draft');
    const question = exact<Question>(store, session.value.binding.question, 'question');
    const environment = exact<Environment>(store, session.value.binding.environment, 'environment');
    const profile = session.value.profile ? exact<ReaderPilot>(store, session.value.profile, 'reader-pilot') : undefined;
    // The exact prepared session was just independently re-proved at entry
    // or by the historical reader in this iteration. Read its unchanged
    // archive rather than rebuilding D6 once more to stage an application.
    // researchCall still proves the entire pending admission before its
    // atomic reservation, including current guards and the paid D6.
    const { capacity, original } = readFinalRequestArchive(store, prepared);
    valid(object(original) && original.contract === DISCOVERY_FINAL_RESULT && object(original.packet)
      && same(original.subject, session.value.subject)
      && same(original.schema, prepared.value.envelope.packet.schema),
    'The final invocation lost its complete original request');
    const proven = { packet: original.packet as DiscoveryFinalPacket };
    const origin = createSession ? session : store.get<DiscoveryFinalExecution>(id, 1);
    valid(origin, 'The final execution lost its original cursor');
    const marker = { subject: session.value.subject, prepared: reference(prepared),
      execution: createSession ? reference(origin) : reference(exact<DiscoveryFinalExecution>(store,
        reference(origin), DISCOVERY_FINAL_EXECUTION_KIND)) };
    const context = { ...(finalMaterialEra(prepared.value.input) ? {finalMaterial:finalMaterialProjection(original.packet)} : {}),
      finalContinuation: marker, request: original, schema: prepared.value.envelope.packet.schema,
      resultCapacity: capacity, contextWorkspace: finalWorkspace(prepared.value.input, session.value.workspace) };
    const partial = { session, prepared, proven, draft, question, environment, profile };
    const guards = currentDiscoveryFinalGuards(store, project,
      partial as unknown as Awaited<ReturnType<typeof readDiscoveryFinalDispatchAdmission>>);
    const value: DiscoveryFinalApplication = { contract: DISCOVERY_FINAL_APPLICATION, projectId: project,
      session: reference(session), context, prompt: session.value.prompt, role: session.value.role,
      dispatch: session.value.dispatch, profile: session.value.profile, guards,
      state: 'prepared', call: null, received: null, after: null };
    const application: Write = { id: applicationId, kind: DISCOVERY_FINAL_APPLICATION_KIND, expected: 0, value };
    if(correctionWrite) application.value=correctionWrite.value;
    try {
      await researchCall(session.value.role, session.value.dispatch, session.value.prompt, (application.value as DiscoveryFinalApplication).context, signal,
        { store, draftId: draft.id, questionId: question.id, purpose: 'discovery-final',
          session: reference(session), application: pendingRef(application),
          finalPending: { ...(createSession ? { session: createSession } : {}), application },
          ...(profile ? { pilot: profile } : {}) });
      used++;
    } catch (error) {
      if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
      const winner = store.get<DiscoveryFinalApplication>(applicationId, 1);
      if (!winner || !same(winner.value, application.value)) throw error;
    }
  }
}
