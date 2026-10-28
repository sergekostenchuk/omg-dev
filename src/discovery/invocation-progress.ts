import { withHistoricalReads } from '../history/proofs.js';
import type { VariantSubject } from './discovery-variants.js';
import { variantTransportSubject, requireVariantContext, packetVariantSubject, variantTransportGuards, variantTransportFields, variantCallMatches, assessmentSubjectKey, type AssessmentTransportSubject } from './continuation-packet.js';
import { callAddressesSubject, sameSubject, planSubjectOf, type V7PlanSubject } from './v7-managed-attempt.js';
import { AsyncLocalStorage } from "node:async_hooks";
import type { Store, ReadGuard, Revision, TransactionGuard } from '../storage/store.js';
import { provenStore } from '../storage/store-view.js';
import { canonical, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import {contextLookupKey} from './context-workspace.js';
import { decodeDeepPreparation, type DeepPreparation } from './deep-research.js';
import { readArchiveBody } from './request-parts.js';
import { readResearchConsumerExecution, readResearchConsumerIntent, readManagedDeepPreparation, requireDeepConsumerBinding } from './response-recovery.js';

/** Preserve the engine-owned progress identity for accounting. Distinct calls
 * are governed by their token budget, not a fixed invocation count. Repeated
 * delivered lookup keys are rejected by the context consumer. */
export function invocationProgress(store:Store,questionId:string,purpose:string,context:Record<string,any>,
  subject?:V7PlanSubject|null,actor?:string,assessmentSubject?:AssessmentTransportSubject|null,variantSubject?:null):{key:string;guards:ReadGuard[]};
export function invocationProgress(store:Store,questionId:string,purpose:string,context:Record<string,any>,
  subject:V7PlanSubject|null,actor:string|undefined,assessmentSubject:AssessmentTransportSubject|null,variantSubject:VariantSubject|null):{key:string;guards:TransactionGuard[]};
export function invocationProgress(store:Store,questionId:string,purpose:string,context:Record<string,any>,subject:V7PlanSubject|null=null,actor?:string,assessmentSubject:AssessmentTransportSubject|null=null,variantSubject:VariantSubject|null=null) {
  const question=store.get(questionId);
  requireCondition(question?.kind==='question','continuation_question_missing','Progress requires its bound question');
  variantSubject=variantTransportSubject(purpose,actor,variantSubject,subject,assessmentSubject);
  requireVariantContext(context,variantSubject);
  const draft=variantSubject?store.get((question.value as any).draftId):null;
  if(variantSubject) requireCondition(draft?.kind==='discovery-draft' && (draft.value as any).projectId===(question.value as any).projectId
    && (draft.value as any).questions.includes(questionId),'continuation_question_missing','Variant progress needs its actual project/draft/Question');
  if(variantSubject) {
    const fields=variantTransportFields((question.value as any).projectId,reference(draft!),reference(question),purpose,actor!,variantSubject);
    requireCondition(Object.entries(fields).every(([key,value])=>!Object.hasOwn(context,key)||canonical(context[key])===canonical(value)),
      'discovery_variant_subject_invalid','Progress cannot use another variant invocation context');
  }
  let step:unknown;
  const originals=(context.contextWorkspace??[]).map(contextLookupKey);
  if(variantSubject)step={originals};
  else if(context.dispatchMode==='consolidation')step={session:context.synthesisSession,cursor:context.synthesisState,operation:'consolidation',
    ...(context.consolidation?.format === 2 ? {format:2,notes:context.synthesisNotes?.map((n:any)=>n.checkpoint)??[]} : {})};
  else if(context.synthesisState)step={session:context.synthesisSession??null,cursor:context.synthesisState,originals,
    ...(context.contextControls?.mode === 'finalization' ? {mode:'finalization',notes:context.synthesisNotes?.map((n:any)=>n.checkpoint)??[]} : {})};
  else if(context.assessmentState)step={session:context.assessmentSession??null,cursor:context.assessmentState,originals};
  else if(purpose==='reader')step={sources:context.sources?.map((s:any)=>({ref:s.ref??null,range:s.visibleRange??null,content:hashJson(s)}))??[]};
  else {
    const evidence=['reader-result','pilot-reading'].flatMap(kind=>store.list<any>(kind))
      .filter(r=>(r.value.question===questionId||r.value.question?.id===questionId)
        && (!subject || r.value.projectId===(question.value as any).projectId && sameSubject(planSubjectOf(r.value),subject))).map(reference);
    step={evidence};
  }
  const key=hashJson(variantSubject ? {version:'variant/v1',projectId:(question.value as any).projectId,draft:reference(draft!),question:reference(question),variantSubject,purpose,actor,step} : assessmentSubject ? {version:3,projectId:(question.value as any).projectId,assessmentSubject,purpose,actor,step} : subject ? {version:2,projectId:(question.value as any).projectId,subject,purpose,actor,step}
    : {version:1,question:reference(question),purpose,step});
  const calls=store.list<ModelCall>('model-call').filter(c=>callAddressesSubject(c.value as unknown as Record<string,unknown>,reference(question),subject)
    && ((c.value as unknown as {assessmentKey?:string}).assessmentKey??null)===assessmentSubjectKey(assessmentSubject)
    && c.value.purpose===purpose && c.value.progressKey===key
    && (!variantSubject || c.value.draftId===draft!.id
      && !Object.hasOwn(c.value,'subject') && !Object.hasOwn(c.value,'assessmentSubject'))
    && (!(subject||assessmentSubject||variantSubject) || c.value.projectId===(question.value as any).projectId && c.value.requested.actor===actor)
    && canonical(packetVariantSubject(c.value))===canonical(variantSubject)
    && (!variantSubject || variantCallMatches(store,c,(question.value as any).projectId,reference(draft!),reference(question),purpose,actor!,variantSubject)));
  return {key,guards:[...calls.map(reference),...(variantSubject?variantTransportGuards((question.value as any).projectId,draft!.id,variantSubject):[])]};
}

interface InvocationAllowanceState { limit:number; remaining:number; used:number; parent?:InvocationAllowanceState }
export interface InvocationAllowanceReport<T> { value:T; limit:number; remaining:number; used:number }

const allowance=new AsyncLocalStorage<InvocationAllowanceState>();

function state(limit:number):InvocationAllowanceState {
 requireCondition(Number.isInteger(limit)&&limit>0,'research_call_allowance','The research call allowance must be a positive integer');
 return {limit,remaining:limit,used:0};
}

export function withInvocationAllowance<T>(limit:number,work:()=>Promise<T>):Promise<T>{
 return allowance.run(state(limit),work);
}

export async function withInvocationAllowanceReport<T>(limit:number,work:()=>Promise<T>):Promise<InvocationAllowanceReport<T>>{
 const current=state(limit);
 const value=await allowance.run(current,work);
 return {value,limit:current.limit,remaining:current.remaining,used:current.used};
}

/** A bounded sub-operation shares every durable physical claim with its caller. */
export function withChildInvocationAllowance<T>(limit:number,work:()=>Promise<T>):Promise<T>{
 const current=state(limit),parent=allowance.getStore();
 if(parent)current.parent=parent;
 return allowance.run(current,work);
}

/** Check before preparing a physical dispatch; consume only after its durable claim is written. */
export function requireInvocationAllowance(){
 for(let current=allowance.getStore();current;current=current.parent)
  requireCondition(current.remaining>0,'research_call_allowance','The research call allowance is exhausted; all inner-role invocations count');
}

export function consumeInvocationAllowance(){
 requireInvocationAllowance();
 for(let current=allowance.getStore();current;current=current.parent){current.remaining--;current.used++;}
}

// ---- 5.4 (codex-omg №12595, правки №12770): the separate identity progress of one deep step. ----

/** The exact saved deep preparation through the common historical proof of the main 5.2 —
 * its real scope, snapshot, set and member, not what the record alone claims. */
function provenDeepPreparation(store: Store, preparation: Ref) {
  const decoded = decodeDeepPreparation(isRef(preparation) ? (store.get<DeepPreparation>(preparation.id, preparation.revision)?.value ?? preparation) : preparation);
  const proof = readManagedDeepPreparation(store, decoded.cell.projectId, preparation);
  return { record: proof.preparation, decoded, proof };
}

/** The physical call and its immutable managed intent fix the deep era.
 * A broad call has no marker in either origin. Explicit null, a lost origin
 * or a changed identity is a typed refusal, never a broad fallback. */
function intentDeclaresDeep(store: Store, call: ModelCall): boolean {
  const ref = call.consumerIntent;
  const intent = isRef(ref) ? store.get<{ cursor?: Record<string, unknown> }>(ref.id, 1) : null;
  return Object.hasOwn(intent?.value.cursor ?? {}, 'deepPreparation');
}

export function callDeepPreparation(store: Store, call: Revision<ModelCall>): Ref | null {
  return withHistoricalReads(() => callDeepPreparationAt(store, call));
}
function callDeepPreparationAt(store: Store, call: Revision<ModelCall>): Ref | null {
  const first = store.get<ModelCall>(call.id, 1);
  requireCondition(call.kind === 'model-call' && first?.kind === 'model-call', 'discovery_deep_identity_invalid', 'A call lost its immutable origin');
  const origin = first.value, head = call.value;
  const declared = Object.hasOwn(origin, 'deepPreparation') || Object.hasOwn(head, 'deepPreparation')
    || intentDeclaresDeep(store, origin) || intentDeclaresDeep(store, head);
  // Classify by immutable physical identity. The archive is checked as a link,
  // never used to turn a broad call into a deep call.
  if (!declared) return null;
  const ref = (origin as unknown as Record<string, unknown>).deepPreparation;
  requireCondition(isRef(ref) && canonical((head as unknown as Record<string, unknown>).deepPreparation ?? null) === canonical(ref)
    && head.projectId === origin.projectId && head.purpose === origin.purpose
    && canonical(head.requested) === canonical(origin.requested)
    && canonical(head.consumerIntent ?? null) === canonical(origin.consumerIntent ?? null)
    && canonical(head.packet) === canonical(origin.packet) && canonical(head.request) === canonical(origin.request),
    'discovery_deep_identity_invalid', 'A deep call must keep its original preparation, actor, project, purpose, packet and request');
  requireCondition(isRef(origin.consumerIntent), 'discovery_deep_identity_invalid', 'Deep calls require their exact managed intent');
  const intent = readResearchConsumerIntent(store, origin.consumerIntent);
  const proof = requireDeepConsumerBinding(store, intent);
  requireCondition(proof && canonical(reference(proof.preparation)) === canonical(ref)
    && intent.value.projectId === origin.projectId && intent.value.kind === origin.purpose
    && canonical(intent.value.role) === canonical(origin.requested),
    'discovery_deep_identity_invalid', 'The immutable managed intent must prove this deep identity');
  const archiveRef = origin.packet?.archive;
  const archive = isRef(archiveRef) ? store.get<Record<string, any>>(archiveRef.id, archiveRef.revision) : null;
  requireCondition(archive?.kind === 'research-context' && canonical(reference(archive)) === canonical(archiveRef)
    && archive.hash === hashJson(archive.value)
    && canonical(readArchiveBody(store, archive).body.deepPreparation ?? null) === canonical(ref),
    'discovery_deep_identity_invalid', 'The saved archive must carry the original deep preparation');
  if (head.status !== 'running') {
    const paid = readResearchConsumerExecution(store, origin.projectId, origin.consumerIntent);
    requireCondition(head.status === paid.call.value.status && head.error === paid.call.value.error
      && canonical(head.response) === canonical(paid.call.value.response), 'discovery_deep_identity_invalid',
      'The deep call head must retain its exact managed physical outcome');
  }
  return ref;
}

/** 5.4: the saved calls of exactly one deep preparation identity. Candidates are classified
 * by their immutable first revisions — project, purpose and actor of the origin, and the
 * exact preparation its saved context names — never by the today's head; a head that
 * departed from its origin refuses the whole selection, including a foreign record that
 * declared itself this identity. */
export function deepIdentityCalls(store: Store, preparation: Ref, purpose: string, actor: string, intentRef?: Ref): Revision<ModelCall>[] {
  return withHistoricalReads(() => deepIdentityCallsAt(store, preparation, purpose, actor, intentRef));
}
function deepIdentityCallsAt(store: Store, preparation: Ref, purpose: string, actor: string, intentRef?: Ref): Revision<ModelCall>[] {
  const { record } = provenDeepPreparation(store, preparation), target = canonical(reference(record));
  let operation: string | undefined;
  if (intentRef !== undefined) {
    const intent = readResearchConsumerIntent(store, intentRef), proof = requireDeepConsumerBinding(store, intent);
    requireCondition(proof && canonical(reference(proof.preparation)) === target
      && intent.value.projectId === record.value.cell.projectId && intent.value.kind === purpose
      && intent.value.role.actor === actor, 'discovery_deep_identity_invalid', 'Progress needs its exact managed deep operation');
    operation = intent.id;
  }
  const mentions = (call: ModelCall | undefined) => {
    if (!call) return false;
    if (canonical((call as unknown as Record<string, unknown>).deepPreparation ?? null) === target) return true;
    const ref = call.consumerIntent;
    const intent = isRef(ref) ? store.get<{ cursor?: Record<string, unknown> }>(ref.id, 1) : null;
    return canonical(intent?.value.cursor?.deepPreparation ?? null) === target;
  };
  const candidates = new Map(store.list<ModelCall>('model-call').map(call => [call.id, call]));
  for (const { id } of (provenStore(store) ?? store).identities('prefix', 'model-call:consumer:v1:')) {
    if (candidates.has(id)) continue;
    const first = store.get<ModelCall>(id, 1), head = store.get<ModelCall>(id);
    if (!mentions(first?.value) && !mentions(head?.value)) continue;
    requireCondition(head, 'discovery_deep_identity_invalid', 'A managed deep call lost its head');
    candidates.set(id, head);
  }
  return [...candidates.values()].filter(call => {
    const first = store.get<ModelCall>(call.id, 1);
    if (!mentions(call.value) && !mentions(first?.value)) return false;
    const classified = callDeepPreparation(store, call);
    return first!.value.projectId === record.value.cell.projectId && first!.value.purpose === purpose
      && first!.value.requested?.actor === actor && canonical(classified) === target
      && (!operation || first!.value.consumerIntent?.id === operation);
  });
}

/** The shared managed reader proves the immutable intent and complete wire chain. */
export function readDeepPaidCall(store: Store, call: Revision<ModelCall>) {
  requireCondition(callDeepPreparation(store, call), 'discovery_deep_identity_invalid', 'Expected a managed deep call');
  const first = store.get<ModelCall>(call.id, 1)!;
  return readResearchConsumerExecution(store, first.value.projectId, first.value.consumerIntent!);
}

/** 5.4: the progress identity of one deep step. The full preparation identity — the whole
 * cell and its scope, content-addressed by the 5.2-F form — together with the project, the
 * plan subject of the cell, the purpose and the actor tells deep from broad and from any
 * other cell or scope: another scope of the same cell is another preparation, another
 * progress and never this one's answer. */
export function deepInvocationProgress(store: Store, preparation: Ref, purpose: string, actor: string, intentRef?: Ref): { key: string; guards: ReadGuard[] } {
  return withHistoricalReads(() => deepInvocationProgressAt(store, preparation, purpose, actor, intentRef));
}
function deepInvocationProgressAt(store: Store, preparation: Ref, purpose: string, actor: string, intentRef?: Ref): { key: string; guards: ReadGuard[] } {
  const { record, decoded } = provenDeepPreparation(store, preparation);
  const calls = deepIdentityCalls(store, preparation, purpose, actor, intentRef);
  const ids = new Set(calls.map(call => store.get<ModelCall>(call.id, 1)!.value.consumerIntent!.id));
  const id = intentRef?.id ?? (ids.size === 1 ? [...ids][0] : undefined);
  const operation = id ? reference(readResearchConsumerIntent(store, reference(store.get(id, 1)!))) : null;
  return { key: hashJson({ version: 'deep/v1', projectId: decoded.cell.projectId, preparation: reference(record),
    subject: decoded.cell.subject, purpose, actor, operation }), guards: [reference(record), ...calls.map(reference)] };
}
