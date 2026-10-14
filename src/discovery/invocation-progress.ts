import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from '../storage/store.js';
import { hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { reference } from '../pipeline/contracts.js';
import {contextLookupKey} from './context-workspace.js';

/** Preserve the engine-owned progress identity for accounting. Distinct calls
 * are governed by their token budget, not a fixed invocation count. Repeated
 * delivered lookup keys are rejected by the context consumer. */
export function invocationProgress(store:Store,questionId:string,purpose:string,context:Record<string,any>) {
  const question=store.get(questionId);
  requireCondition(question?.kind==='question','continuation_question_missing','Progress requires its bound question');
  let step:unknown;
  const originals=(context.contextWorkspace??[]).map(contextLookupKey);
  if(context.dispatchMode==='consolidation')step={session:context.synthesisSession,cursor:context.synthesisState,operation:'consolidation',
    ...(context.consolidation?.format === 2 ? {format:2,notes:context.synthesisNotes?.map((n:any)=>n.checkpoint)??[]} : {})};
  else if(context.synthesisState)step={session:context.synthesisSession??null,cursor:context.synthesisState,originals,
    ...(context.contextControls?.mode === 'finalization' ? {mode:'finalization',notes:context.synthesisNotes?.map((n:any)=>n.checkpoint)??[]} : {})};
  else if(context.assessmentState)step={session:context.assessmentSession??null,cursor:context.assessmentState,originals};
  else if(purpose==='reader')step={sources:context.sources?.map((s:any)=>({ref:s.ref??null,range:s.visibleRange??null,content:hashJson(s)}))??[]};
  else {
    const evidence=['reader-result','pilot-reading'].flatMap(kind=>store.list<any>(kind))
      .filter(r=>r.value.question===questionId||r.value.question?.id===questionId).map(reference);
    step={evidence};
  }
  const key=hashJson({version:1,question:reference(question),purpose,step});
  const calls=store.list<ModelCall>('model-call').filter(c=>c.value.questionId===questionId&&c.value.purpose===purpose&&c.value.progressKey===key);
  return {key,guards:calls.map(reference)};
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
