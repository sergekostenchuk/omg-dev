import { conditionEvidenceResponseContract } from './discovery-response-contract.js';
import { canonical, digest, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Environment, RoleBinding } from '../runtime/environment.js';
import type { Revision, Store, TransactionGuard, Write } from '../storage/store.js';
import { pendingOverlay } from '../storage/store-view.js';
import type { ContextWorkspace } from './context-workspace.js';
import { addContextLookup, contextProgress, contextWorkspace, packContextWorkspace,
  requireCompleteContextPacket } from './context-workspace.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { CONDITION_EVIDENCE_SESSION, CONDITION_EVIDENCE_SESSION_KIND, readConditionEvidenceSessionAt,
  type ConditionEvidenceSession } from './discovery-condition-evidence-session.js';
import { CONDITION_EVIDENCE_PURPOSE, CONDITION_EVIDENCE_RESULT, checkConditionEvidenceReply, requireConditionEvidenceSubject,
  type ConditionEvidencePacket, type ConditionEvidenceProjection, type ConditionEvidenceSubject } from './discovery-condition-evidence-subject.js';
import type { ReaderPilot } from './reader-pilot.js';
import { readFinalCapacityProjection } from './early-research-outcome.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import type { ConditionEvidenceContinuation } from './continuation-packet.js';
import { prepareArchiveParts, readArchiveBody } from './request-parts.js';
import { contextValue } from './working-context.js';
import { addressArchivedMaterials, requirePacketMaterialDelivery, serveArchivedMaterial } from './research-delivery.js';
import { readConditionEvidenceResearchExecution, readResearchContextOutcomeAt } from './response-recovery.js';
import { researchAction, researchCall, resumeConditionEvidenceResearchCall } from './research-protocol.js';
import type { ModelCall } from '../runtime/model-usage.js';

/** OMG-V7-B3 (codex-omg2 №16508): the paid evidence assessment runs through the common transport exactly like the D7
 * assessment — its own cursor, applications, physical claims, bounded pages, continuation and paid result. The prepared
 * session is immutable and is never itself permission to spend; the cursor binds it to the exact accepted edition the
 * subject names. A paid outcome is applied before any current head, budget or allowance is checked; nothing here
 * resolves the condition — the producer of resolutions reads this paid result. */
export const CONDITION_EVIDENCE_EXECUTION = 'discovery-condition-evidence-execution/v1' as const;
export const CONDITION_EVIDENCE_APPLICATION = 'discovery-condition-evidence-application/v1' as const;
export const CONDITION_EVIDENCE_PAID_RESULT = 'discovery-condition-evidence-paid-result/v1' as const;
export const CONDITION_EVIDENCE_EXECUTION_KIND = 'discovery-condition-evidence-execution' as const;
export const CONDITION_EVIDENCE_APPLICATION_KIND = 'discovery-condition-evidence-application' as const;
export const CONDITION_EVIDENCE_PAID_RESULT_KIND = 'discovery-condition-evidence-paid-result' as const;

export interface ConditionEvidenceExecution {
  [key: string]: unknown;
  contract: typeof CONDITION_EVIDENCE_EXECUTION;
  projectId: string;
  source: Ref;
  prepared: Ref;
  subject: ConditionEvidenceSubject;
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

export interface ConditionEvidenceApplication {
  [key: string]: unknown;
  contract: typeof CONDITION_EVIDENCE_APPLICATION;
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
}

export interface ConditionEvidencePaidResult {
  contract: typeof CONDITION_EVIDENCE_PAID_RESULT;
  projectId: string;
  source: Ref;
  prepared: Ref;
  subject: ConditionEvidenceSubject;
  session: Ref;
  application: Ref;
  call: Ref;
  request: Ref;
  response: Ref;
  projection: ConditionEvidenceProjection;
}

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const object = (value: unknown): value is Record<string, any> => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, names: readonly string[]) => object(value)
  && same(Object.keys(value).sort(), [...names].sort());
function valid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'discovery_condition_evidence_execution_invalid', message);
}
function snapshotRef(ref: unknown): Ref {
  let snapshot: unknown;
  try { snapshot = JSON.parse(canonical(ref)); }
  catch { throw new EngineError('discovery_condition_evidence_execution_invalid', 'An exact immutable reference is required'); }
  valid(isRef(snapshot) && keys(snapshot, ['id', 'revision', 'hash']), 'An exact immutable reference is required');
  return snapshot;
}
function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  const at = snapshotRef(ref), row = store.get<T>(at.id, at.revision);
  valid(row?.kind === kind && same(reference(row), at) && hashJson(row.value as never) === row.hash,
    'An exact evidence ground is missing, foreign or changed');
  return row;
}

export const conditionEvidenceExecutionId = (source: Ref, prepared: Ref) =>
  `discovery-condition-evidence-execution:${hashJson([CONDITION_EVIDENCE_EXECUTION, source, prepared])}`;
export const conditionEvidenceApplicationId = (session: Ref) =>
  `discovery-condition-evidence-application:${hashJson([CONDITION_EVIDENCE_APPLICATION, session.id, session.revision])}`;

/** The immutable origin, not today's execution head, identifies every call. */
export function conditionEvidenceContinuation(store: Store,
  session: Revision<ConditionEvidenceExecution>): ConditionEvidenceContinuation {
  const origin = store.get<ConditionEvidenceExecution>(session.id, 1);
  valid(object(session.value) && origin?.kind === CONDITION_EVIDENCE_EXECUTION_KIND
    && object(origin.value) && hashJson(origin.value as never) === origin.hash
    && origin.value.contract === CONDITION_EVIDENCE_EXECUTION
    && same(origin.value.source, session.value.source) && same(origin.value.prepared, session.value.prepared)
    && same(origin.value.subject, session.value.subject), 'The assessment execution lost its immutable origin');
  return { source: structuredClone(origin.value.source), prepared: structuredClone(origin.value.prepared),
    subject: structuredClone(origin.value.subject), execution: reference(origin) };
}

function readEvidenceRequestArchive(store: Store, prepared: Revision<ConditionEvidenceSession>) {
  const capacity = prepared.value.envelope?.capacity;
  valid(object(capacity) && object(capacity.mandatory) && 'archive' in capacity.mandatory
    && object(capacity.mandatory.archive)
    && isRef(capacity.mandatory.archive.record) && typeof capacity.mandatory.archive.pointer === 'string'
    && typeof capacity.mandatory.archive.hash === 'string'
    && same(capacity.mandatory.archive.record, prepared.value.archive),
  'The assessment admission lost its exact archive');
  const address = capacity.mandatory.archive;
  const original = readFinalCapacityProjection(store, address.record, address.pointer);
  const originalText = canonical(original);
  valid(digest(originalText) === address.hash, 'The assessment archive differs from its exact hash');
  return { capacity, original, originalText };
}

/** Synchronous physical leaf. It validates immutable associations, but is not the public authority to send: admission
 * separately proves the whole evidence subject and the prepared session before a reservation. */
export function readConditionEvidenceDispatchLeaf(store: Store, applicationRef: Ref) {
  const application = exact<ConditionEvidenceApplication>(store, applicationRef,
    CONDITION_EVIDENCE_APPLICATION_KIND);
  const app = application.value;
  valid(application.revision === 1 && object(app) && app.contract === CONDITION_EVIDENCE_APPLICATION
    && isRef(app.session), 'The assessment application needs its immutable origin');
  const session = exact<ConditionEvidenceExecution>(store, app.session,
    CONDITION_EVIDENCE_EXECUTION_KIND);
  const value = session.value;
  valid(keys(value, ['contract', 'projectId', 'source', 'prepared', 'subject', 'binding', 'role', 'dispatch',
    'profile', 'prompt', 'step', 'offset', 'notes', 'workspace', 'previous', 'application', 'result'])
    && keys(app, ['contract', 'projectId', 'session', 'context', 'prompt', 'role', 'dispatch', 'profile',
      'guards', 'state', 'call', 'received', 'after'])
    && value.contract === CONDITION_EVIDENCE_EXECUTION && value.projectId === app.projectId
    && isRef(value.source) && isRef(value.prepared)
    && session.id === conditionEvidenceExecutionId(value.source, value.prepared)
    && value.application === application.id && application.id === conditionEvidenceApplicationId(reference(session))
    && value.step === session.revision - 1 && value.offset === 0 && Array.isArray(value.notes)
    && object(value.subject) && object(value.subject.final) && object(value.subject.final.basis)
    && object(value.subject.final.basis.brief) && object(value.workspace) && Array.isArray(value.workspace.entries)
    && value.workspace.entries.every(entry => object(entry) && object(entry.result))
    && value.result === null, 'The assessment cursor is foreign or incomplete');
  const origin = store.get<ConditionEvidenceExecution>(session.id, 1);
  valid(origin?.kind === CONDITION_EVIDENCE_EXECUTION_KIND && object(origin.value)
    && hashJson(origin.value as never) === origin.hash, 'The assessment cursor lost its origin');
  for (const key of ['contract', 'projectId', 'source', 'prepared', 'subject', 'binding', 'role', 'dispatch', 'profile', 'prompt'] as const)
    valid(same(value[key], origin.value[key]), 'The assessment execution identity changed');
  valid(origin.value.step === 0 && origin.value.previous === null && origin.value.result === null
    && same(origin.value.notes, []) && same(origin.value.workspace, contextWorkspace()),
  'The assessment origin is not an initial cursor');
  const source = exact<Record<string, any>>(store, value.source, 'discovery-manifest');
  const prepared = exact<ConditionEvidenceSession>(store, value.prepared, CONDITION_EVIDENCE_SESSION_KIND);
  valid(prepared.revision === 1 && object(prepared.value) && prepared.value.contract === CONDITION_EVIDENCE_SESSION
    && prepared.value.project === value.projectId && prepared.value.state === 'prepared'
    && object(prepared.value.input) && object(prepared.value.envelope) && object(prepared.value.envelope.packet)
    && same(prepared.value.subject, value.subject) && object(source.value) && source.value.projectId === value.projectId
    && same(value.subject.manifest, value.source),
  'The evidence assessment lost its exact edition or immutable preparation');
  const { original, originalText } = readEvidenceRequestArchive(store, prepared);
  const binding = value.binding;
  valid(object(binding) && isRef(binding.draft) && isRef(binding.question) && isRef(binding.environment)
    && Array.isArray(binding.inputs) && binding.inputs.every(isRef), 'The assessment research binding is incomplete');
  const draft = exact<DiscoveryDraft>(store, binding.draft, 'discovery-draft');
  const question = exact<Question>(store, binding.question, 'question');
  const environment = exact<Environment>(store, binding.environment, 'environment');
  const profile = value.profile === null ? undefined : exact<ReaderPilot>(store, value.profile, 'reader-pilot');
  const final = value.subject.final;
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
  const marker = conditionEvidenceContinuation(store, session);
  valid(keys(app.context, ['finalContinuation', 'request', 'schema', 'resultCapacity', 'contextWorkspace'])
    && same(app.context.finalContinuation, marker) && canonical(app.context.request) === originalText
    && same(app.context.schema, prepared.value.envelope.packet.schema)
    && same(app.context.resultCapacity, prepared.value.envelope.capacity)
    && same(app.context.contextWorkspace, value.workspace.entries.map(entry => entry.result))
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

/** The only authority for a new physical send: prove the whole evidence subject again from its own input — the
 * edition, the saved bundle and condition, every offered claim — and the prepared session, then compare the request. */
export async function readConditionEvidenceDispatchAdmission(store: Store, applicationRef: Ref) {
  const leaf = readConditionEvidenceDispatchLeaf(store, applicationRef);
  // A later cursor is authority only if every prior page has its exact physical proof; resume calls this directly.
  const history = leaf.session.revision > 1
    ? await readConditionEvidenceExecutionAt(store, leaf.session.value.projectId, reference(leaf.session))
    : null;
  const source = history?.source ?? requireConditionEvidenceSubject(store, leaf.session.value.projectId, leaf.session.value.subject);
  const prepared = history?.prepared ?? readConditionEvidenceSessionAt(store, leaf.session.value.projectId, leaf.session.value.prepared);
  const request = leaf.original;
  valid(same(source.subject.manifest, reference(leaf.source)) && same(reference(prepared), reference(leaf.prepared))
    && same(source.subject, prepared.value.subject) && same(source.subject, leaf.session.value.subject)
    && object(request) && request.contract === CONDITION_EVIDENCE_RESULT && object(request.packet)
    && same(request.subject, source.subject) && same(request.packet, source)
    && same(request.schema, prepared.value.envelope.packet.schema),
  'The evidence preparation is not the complete packet of this exact subject');
  return { ...leaf, source, prepared, proven: source };
}

/** The guards of a send: the exact research binding, the edition, its bundle, the containers of the offered material
 * and the prepared session — the grounds the paid answer is about. */
export function currentConditionEvidenceGuards(_store: Store, _project: string,
  admission: Awaited<ReturnType<typeof readConditionEvidenceDispatchAdmission>>): TransactionGuard[] {
  const binding = admission.session.value.binding;
  return uniqueTransactionGuards([binding.draft, binding.question, binding.environment, ...binding.inputs,
    ...(admission.session.value.profile ? [admission.session.value.profile] : []), admission.proven.subject.manifest,
    admission.proven.subject.bundle, ...admission.proven.material.map(item => item.container), reference(admission.prepared)]);
}

/** Stage the physical archive for this cursor. All omitted material remains
 * addressable through the shared bounded-delivery and workspace machinery. */
export function prepareConditionEvidenceContextPacker(store: Store,
  admission: Awaited<ReturnType<typeof readConditionEvidenceDispatchAdmission>>) {
  const { session, prepared, context } = admission;
  const staged = prepareArchiveParts(store, { projectId: session.value.projectId,
    draft: session.value.binding.draft, question: session.value.binding.question }, structuredClone(context));
  // This small supplement stays inline: the paid archive retains its historical context exactly.
  const discoveryResponseContract = conditionEvidenceResponseContract();
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
      const packet: Record<string, any> = { contract: 'discovery-condition-evidence-envelope/v1',
        subject: structuredClone(session.value.subject), schema: structuredClone(context.schema), discoveryResponseContract,
        request: structuredClone(context.request), finalContinuation: structuredClone(context.finalContinuation),
        resultCapacity: structuredClone(context.resultCapacity), contextWorkspace: structuredClone(context.contextWorkspace),
        working: { archive, deliveryContract: 'research-delivery/v1',
          instruction: 'Read each exact omitted address with read_context and continue through every page before returning a final result.' } };
      const originals = addressArchivedMaterials(packet, archive, ['request'], packetLimit,
        () => prepared.value.archive, 2048);
      // Leave room for a positive original fragment after the newest context
      // page. Otherwise the context packer may consume the whole packet and
      // make the shared material delivery fail on the next paid turn.
      packContextWorkspace(packet, packetLimit, packetLimit, undefined, originals.length ? 8192 : 1024);
      serveArchivedMaterial(packet, originals, packetLimit, 512);
      requirePacketMaterialDelivery(packet, archive, resolve);
      valid(JSON.stringify(packet).length <= packetLimit, 'The assessment transport packet exceeds its saved limit');
      return packet;
    },
    staged: () => ({ writes: staged.writes, guards: staged.guards, records }),
  };
}

const pendingRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1,
  hash: hashJson(write.value as never) });
const evidenceCallId = (application: Ref) => `model-call:condition-evidence:v1:${hashJson(application)}`;
const evidenceResultId = (application: Ref) => `discovery-condition-evidence-paid-result:${hashJson(application)}`;

async function physicalEvidenceOutcome(store: Store, project: string, application: Ref, received: Ref) {
  const { admission, paid } = readConditionEvidenceResearchExecution(store, project, received, application);
  const claim = store.get<ModelCall>(evidenceCallId(reference(admission.application)), 1);
  valid(claim?.kind === 'model-call' && object(claim.value) && hashJson(claim.value as never) === claim.hash
    && same((claim.value as unknown as Record<string, unknown>).conditionEvidenceApplication,
      reference(admission.application)), 'The assessment application lost its unique reservation');
  valid(paid.call.id === claim.id && paid.kind === 'response',
    'Only this exact physical assessment response can advance its cursor');
  return { admission, paid };
}

/** Application and historical reading share exactly this projector. Neither
 * an answer's own verdict nor a structural packet can impersonate payment. */
async function projectEvidenceStep(store: Store, admission: ReturnType<typeof readConditionEvidenceDispatchLeaf>,
  paid: Awaited<ReturnType<typeof physicalEvidenceOutcome>>['paid']) {
  const { session, application, draft, question } = admission;
  let workspace = contextWorkspace(session.value.workspace), result: Ref | null = null, output: Write | null = null;
  const response = paid.payload;
  if (object(response) && response.action === 'read_context') {
    const action = researchAction(response);
    valid(action.action === 'read_context', 'An assessment lookup must retain its exact address');
    const addresses = paid.subject.working?.materialAddresses;
    valid(Array.isArray(addresses) && addresses.some((address: Record<string, any>) =>
      same(address.record, action.record)
      && (action.pointer === address.pointer || action.pointer.startsWith(`${address.pointer}/`))),
    'An assessment lookup must address material of this exact paid packet');
    const lookup = readResearchContextOutcomeAt(store, draft, question, action,
      admission.profile?.value.maxRequestChars ?? 300000, 'bounded');
    workspace = addContextLookup(workspace, lookup, paid.subject.contextWorkspace, undefined, paid.subject);
  } else {
    requireCompleteContextPacket(workspace, paid.subject);
    const checked = checkConditionEvidenceReply(store, session.value.projectId, session.value.subject,
      admission.prepared.value.input.resultLimitChars, admission.context.resultCapacity, response);
    workspace = contextProgress(workspace, paid.subject);
    const value: ConditionEvidencePaidResult = { contract: CONDITION_EVIDENCE_PAID_RESULT,
      projectId: session.value.projectId, source: session.value.source, prepared: session.value.prepared,
      subject: session.value.subject, session: reference(session), application: reference(application),
      call: reference(paid.call), request: paid.request, response: paid.response, projection: checked.projection };
    output = { id: evidenceResultId(reference(application)), kind: CONDITION_EVIDENCE_PAID_RESULT_KIND,
      expected: 0, value };
    result = pendingRef(output);
  }
  const after: ConditionEvidenceExecution = { ...session.value, step: session.value.step + 1,
    workspace, previous: reference(application), result,
    application: result ? application.id : conditionEvidenceApplicationId({
      id: session.id, revision: session.revision + 1, hash: '' }) };
  return { after, output };
}

/** Historical reader: prove the exact evidence subject, the immutable preparation and
 * every physical assessment step. Today's heads and allowance are irrelevant. */
export async function readConditionEvidenceExecutionAt(store: Store, project: string, at: Ref) {
  const targetRef = snapshotRef(at);
  const target = exact<ConditionEvidenceExecution>(store, targetRef, CONDITION_EVIDENCE_EXECUTION_KIND);
  valid(object(target.value) && target.value.projectId === project && isRef(target.value.source)
    && isRef(target.value.prepared)
    && target.id === conditionEvidenceExecutionId(target.value.source, target.value.prepared),
  'The assessment execution belongs to another source');
  const first = store.get<ConditionEvidenceExecution>(target.id, 1);
  valid(first?.kind === CONDITION_EVIDENCE_EXECUTION_KIND, 'The assessment execution has no origin');
  let previous = exact<ConditionEvidenceExecution>(store, reference(first), CONDITION_EVIDENCE_EXECUTION_KIND);
  valid(object(previous.value) && isRef(previous.value.prepared) && isRef(previous.value.source),
    'The assessment origin has no exact preparation and paid source');
  const prepared = readConditionEvidenceSessionAt(store, project, previous.value.prepared);
  const source: ConditionEvidencePacket = requireConditionEvidenceSubject(store, project, prepared.value.subject);
  valid(same(source.subject.manifest, previous.value.source) && same(previous.value.subject, prepared.value.subject)
    && previous.value.step === 0 && previous.value.previous === null && previous.value.result === null
    && previous.value.application === conditionEvidenceApplicationId(reference(previous)),
  'The assessment origin is not bound to its exact paid source and preparation');
  const firstApplication = store.get<ConditionEvidenceApplication>(previous.value.application, 1);
  valid(firstApplication, 'The assessment execution has no origin application');
  if (target.revision === 1) {
    const admission = readConditionEvidenceDispatchLeaf(store, reference(firstApplication));
    valid(same(reference(admission.session), reference(previous)), 'The assessment origin application is foreign');
  }
  let output: Revision<ConditionEvidencePaidResult> | null = null;
  for (let revision = 2; revision <= target.revision; revision++) {
    const row = store.get<ConditionEvidenceExecution>(target.id, revision);
    valid(row, 'The assessment execution lost a cursor revision');
    const after = exact<ConditionEvidenceExecution>(store, reference(row), CONDITION_EVIDENCE_EXECUTION_KIND);
    valid(object(after.value) && isRef(after.value.previous), 'The assessment cursor lost its prior application');
    const application = exact<ConditionEvidenceApplication>(store, after.value.previous,
      CONDITION_EVIDENCE_APPLICATION_KIND);
    const applied = store.get<ConditionEvidenceApplication>(application.id, 2);
    valid(applied?.kind === CONDITION_EVIDENCE_APPLICATION_KIND && object(applied.value)
      && hashJson(applied.value as never) === applied.hash && isRef(applied.value.call) && isRef(applied.value.received)
      && same(applied.value.after, reference(after)) && same(applied.value, { ...application.value, state: 'applied',
        call: applied.value.call, received: applied.value.received, after: reference(after) }),
    'The assessment cursor is not its exact applied application');
    if (revision === 2) valid(same(reference(application), reference(firstApplication)),
      'The assessment execution does not use its origin application');
    const { admission, paid } = await physicalEvidenceOutcome(store, project, reference(application), applied.value.received);
    valid(same(reference(admission.session), reference(previous)), 'An assessment application belongs to another cursor');
    const claim = store.get<ModelCall>(paid.call.id, 1);
    valid(claim && same(applied.value.call, reference(claim)), 'The assessment names a different physical claim');
    const projected = await projectEvidenceStep(store, admission, paid);
    valid(same(after.value, projected.after), 'The assessment cursor differs from its paid projection');
    if (projected.output) {
      output = exact<ConditionEvidencePaidResult>(store, pendingRef(projected.output),
        CONDITION_EVIDENCE_PAID_RESULT_KIND);
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
export async function readConditionEvidencePaidResultAt(store: Store, project: string, at: Ref) {
  const result = exact<ConditionEvidencePaidResult>(store, snapshotRef(at),
    CONDITION_EVIDENCE_PAID_RESULT_KIND);
  valid(object(result.value) && result.value.contract === CONDITION_EVIDENCE_PAID_RESULT
    && result.value.projectId === project && isRef(result.value.application) && isRef(result.value.session),
  'The paid assessment is foreign or incomplete');
  const application = exact<ConditionEvidenceApplication>(store, result.value.application,
    CONDITION_EVIDENCE_APPLICATION_KIND);
  valid(application.revision === 1 && object(application.value) && same(application.value.session, result.value.session),
    'The paid assessment names another application');
  const applied = store.get<ConditionEvidenceApplication>(application.id, 2);
  valid(applied?.kind === CONDITION_EVIDENCE_APPLICATION_KIND && object(applied.value)
    && hashJson(applied.value as never) === applied.hash && applied.value.state === 'applied'
    && isRef(applied.value.after) && same(applied.value.received, result.value.call),
  'The paid assessment application was not applied');
  const execution = await readConditionEvidenceExecutionAt(store, project, applied.value.after);
  valid(execution.output && same(reference(execution.output), reference(result)) && same(execution.output.value, result.value),
    'The terminal execution does not prove this exact paid assessment');
  return { ...execution, output: result };
}

export interface RunConditionEvidenceOptions {
  profile?: Revision<ReaderPilot>;
  signal?: AbortSignal;
  restoreOnly?: boolean;
  allowance?: number;
}

/** Start or restore one evidence assessment of an exact edition. Its first origin,
 * application and physical claim commit together; paid outcomes apply before
 * checking any current heads, budget or caller allowance. */
export async function runConditionEvidenceExecution(store: Store, project: string, manifestRef: Ref,
  preparedRef: Ref, options: RunConditionEvidenceOptions = {}) {
  const exactSource = snapshotRef(manifestRef), exactPrepared = snapshotRef(preparedRef);
  const { profile: suppliedProfile, signal, restoreOnly, allowance } = options;
  const suppliedProfileRef = suppliedProfile ? reference(suppliedProfile) : undefined;
  valid(allowance === undefined || Number.isSafeInteger(allowance) && allowance >= 0,
    'The assessment allowance must be a nonnegative integer');
  const id = conditionEvidenceExecutionId(exactSource, exactPrepared);
  let used = 0;
  for (;;) {
    let saved = store.get<ConditionEvidenceExecution>(id);
    let prepared: Revision<ConditionEvidenceSession>;
    let source: ConditionEvidencePacket;
    let historical: Awaited<ReturnType<typeof readConditionEvidenceExecutionAt>> | undefined;
    if (saved) {
      historical = await readConditionEvidenceExecutionAt(store, project, reference(saved));
      valid(same(reference(historical.prepared), exactPrepared) && same(historical.source.subject.manifest, exactSource),
        'The saved assessment names another source or preparation');
      prepared = historical.prepared;
      source = historical.source;
      if (historical.result) return historical;
      saved = historical.session;
    } else {
      prepared = readConditionEvidenceSessionAt(store, project, exactPrepared);
      source = requireConditionEvidenceSubject(store, project, prepared.value.subject);
      valid(same(source.subject.manifest, exactSource), 'The prepared evidence assessment is not about this exact edition');
      if (restoreOnly) throw new EngineError('discovery_condition_evidence_execution_invalid', 'There is no saved assessment to restore');
    }
    let session: Revision<ConditionEvidenceExecution>;
    let createSession: Write | undefined;
    if (saved) session = saved;
    else {
      requireCondition(allowance !== 0, 'research_call_allowance', 'No new assessment call is allowed');
      const final = prepared.value.subject.final;
      const draft = exact<DiscoveryDraft>(store, final.basis.draft, 'discovery-draft');
      const environment = exact<Environment>(store, prepared.value.environment, 'environment');
      const profile = suppliedProfileRef ? exact<ReaderPilot>(store, suppliedProfileRef, 'reader-pilot') : undefined;
      valid(!profile || object(profile.value) && profile.value.projectId === project,
        'An assessment profile belongs to another project or is incomplete');
      const value: ConditionEvidenceExecution = { contract: CONDITION_EVIDENCE_EXECUTION,
        projectId: project, source: exactSource, prepared: reference(prepared), subject: prepared.value.subject,
        binding: { draft: reference(draft), question: final.basis.brief.question,
          environment: reference(environment), inputs: draft.value.inputs },
        role: prepared.value.role, dispatch: environment.value, profile: profile ? reference(profile) : null,
        prompt: prepared.value.input.prompt, step: 0, offset: 0, notes: [], workspace: contextWorkspace(),
        previous: null, application: conditionEvidenceApplicationId({ id, revision: 1, hash: '' }), result: null };
      createSession = { id, kind: CONDITION_EVIDENCE_EXECUTION_KIND, expected: 0, value };
      session = { ...pendingRef(createSession), kind: createSession.kind, value };
    }
    const applicationId = session.value.application;
    const existing = store.get<ConditionEvidenceApplication>(applicationId, 1);
    if (existing) {
      const application = exact<ConditionEvidenceApplication>(store, reference(existing), CONDITION_EVIDENCE_APPLICATION_KIND);
      valid(historical, 'An assessment application cannot exist without its proven execution');
      const call = store.get<ModelCall>(evidenceCallId(reference(application)));
      valid(call?.kind === 'model-call' && object(call.value), 'The assessment application has no physical reservation');
      if (call.value.status === 'running') {
        const admission = readConditionEvidenceDispatchLeaf(store, reference(application));
        valid(same(reference(admission.session), reference(session))
          && same(reference(admission.prepared), reference(historical.prepared)), 'The assessment application names another cursor');
        if (restoreOnly) return historical;
        requireCondition(allowance === undefined || used < allowance, 'research_call_allowance', 'No new assessment call is allowed');
        await resumeConditionEvidenceResearchCall(store, reference(application), signal);
        used++;
        continue;
      }
      const { admission, paid } = await physicalEvidenceOutcome(store, project, reference(application), reference(call));
      valid(same(reference(admission.session), reference(session))
        && same(reference(admission.prepared), reference(historical.prepared)), 'The assessment application names another cursor');
      const projected = await projectEvidenceStep(store, admission, paid);
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
        const winner = store.get<ConditionEvidenceExecution>(id);
        if (!winner || winner.revision <= session.revision) throw error;
      }
      continue;
    }
    if (restoreOnly && saved) return historical!;
    requireCondition(allowance === undefined || used < allowance, 'research_call_allowance', 'No new assessment call is allowed');
    const draft = exact<DiscoveryDraft>(store, session.value.binding.draft, 'discovery-draft');
    const question = exact<Question>(store, session.value.binding.question, 'question');
    const environment = exact<Environment>(store, session.value.binding.environment, 'environment');
    const profile = session.value.profile ? exact<ReaderPilot>(store, session.value.profile, 'reader-pilot') : undefined;
    const { capacity, original } = readEvidenceRequestArchive(store, prepared);
    valid(object(original) && original.contract === CONDITION_EVIDENCE_RESULT && object(original.packet)
      && same(original.subject, session.value.subject) && same(original.packet, source)
      && same(original.schema, prepared.value.envelope.packet.schema), 'The assessment invocation lost its proven request');
    const origin = createSession ? session : store.get<ConditionEvidenceExecution>(id, 1);
    valid(origin, 'The assessment execution lost its original cursor');
    const marker: ConditionEvidenceContinuation = { subject: session.value.subject, source: exactSource,
      prepared: reference(prepared), execution: createSession ? reference(origin) : reference(exact<ConditionEvidenceExecution>(
        store, reference(origin), CONDITION_EVIDENCE_EXECUTION_KIND)) };
    const context = { finalContinuation: marker, request: original, schema: prepared.value.envelope.packet.schema,
      resultCapacity: capacity, contextWorkspace: session.value.workspace.entries.map(entry => entry.result) };
    const partial = { session, source, prepared, proven: source, draft, question, environment, profile };
    const guards = currentConditionEvidenceGuards(store, project,
      partial as unknown as Awaited<ReturnType<typeof readConditionEvidenceDispatchAdmission>>);
    const value: ConditionEvidenceApplication = { contract: CONDITION_EVIDENCE_APPLICATION,
      projectId: project, session: reference(session), context, prompt: session.value.prompt, role: session.value.role,
      dispatch: session.value.dispatch, profile: session.value.profile, guards,
      state: 'prepared', call: null, received: null, after: null };
    const application: Write = { id: applicationId, kind: CONDITION_EVIDENCE_APPLICATION_KIND, expected: 0, value };
    try {
      await researchCall(session.value.role, session.value.dispatch, session.value.prompt, context, signal,
        { store, draftId: draft.id, questionId: question.id, purpose: CONDITION_EVIDENCE_PURPOSE,
          session: reference(session), application: pendingRef(application),
          conditionEvidencePending: { ...(createSession ? { session: createSession } : {}), application },
          ...(profile ? { pilot: profile } : {}) });
      used++;
    } catch (error) {
      if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
      const winner = store.get<ConditionEvidenceApplication>(applicationId, 1);
      if (!winner || !same(winner.value, value)) throw error;
    }
  }
}
