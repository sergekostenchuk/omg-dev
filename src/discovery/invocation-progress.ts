import type { VariantSubject } from './discovery-variants.js';
import { variantTransportSubject, requireVariantContext, packetVariantSubject, variantTransportGuards, variantTransportFields, requireVariantArchive, assessmentSubjectKey, type AssessmentTransportSubject } from './continuation-packet.js';
import { callAddressesSubject, sameSubject, planSubjectOf, type V7PlanSubject } from './v7-managed-attempt.js';
import { AsyncLocalStorage } from "node:async_hooks";
import type { Store, ReadGuard, TransactionGuard } from '../storage/store.js';
import { canonical, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { reference } from '../pipeline/contracts.js';
import {contextLookupKey} from './context-workspace.js';

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
    && canonical(packetVariantSubject(c.value))===canonical(variantSubject)
    && (!(subject||assessmentSubject||variantSubject) || c.value.projectId===(question.value as any).projectId && c.value.requested.actor===actor));
  if(variantSubject) for(const call of calls) {
    requireCondition(call.value.draftId===draft!.id && !!call.value.packet,'continuation_foreign','Variant progress needs its exact saved archive');
    requireVariantArchive(store,call.value.packet!.archive,(question.value as any).projectId,reference(draft!),reference(question),purpose,actor!,variantSubject);
  }
  return {key,guards:[...calls.map(reference),...(variantSubject?variantTransportGuards((question.value as any).projectId,draft!.id,variantSubject):[])]};
}

interface InvocationAllowanceState { limit:number; remaining:number; used:number }
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

/** Check before preparing a physical dispatch; consume only after its durable claim is written. */
export function requireInvocationAllowance(){
 const current=allowance.getStore();if(!current)return;
 requireCondition(current.remaining>0,'research_call_allowance','The research call allowance is exhausted; all inner-role invocations count');
}

export function consumeInvocationAllowance(){
 const current=allowance.getStore();if(!current)return;
 requireInvocationAllowance();current.remaining--;current.used++;
}
