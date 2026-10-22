import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { uniqueTransactionGuards, type Environment, type RoleBinding } from '../runtime/environment.js';
import type { Store, Revision } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { decodeVariantExecutionSession, decodeVariantSubject, VARIANT_SESSION_CONTRACT,
  type VariantExecutionSession, type VariantSubject } from './discovery-variants.js';
import { variantTransportFields, variantTransportGuards } from './continuation-packet.js';
import { readVariantSnapshot } from './variant-snapshot.js';
import { researchCall } from './research-protocol.js';
import { findResearchConsumerIntent, prepareResearchConsumerIntent, prepareResearchConsumerApplication,
  readResearchConsumerIntent, readResearchConsumerExecution, type ResearchConsumerIntent } from './response-recovery.js';
import { projectPaidVariantSession, variantExecutionSessionId } from './research-consumer-transition.js';

export { variantExecutionSessionId } from './research-consumer-transition.js';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function invalid(reason:string):never {throw new EngineError('discovery_variant_session_invalid',reason);}
function exact<T>(store:Store,ref:Ref,kind:string):Revision<T> {
  if(!isRef(ref)) invalid(`Missing exact ${kind}`);
  const row=store.get<T>(ref.id,ref.revision);
  if(!row || row.kind!==kind || !same(reference(row),ref) || row.hash!==hashJson(row.value)) invalid(`Missing exact ${kind}`);
  return row;
}

/** Historical proof of execution only. It neither accepts Discovery nor publishes a set/selection. */
export function readVariantExecutionSession(store:Store,project:string,ref:Ref):Revision<VariantExecutionSession> {
  const row=exact<VariantExecutionSession>(store,ref,'discovery-variant-session');
  const v=decodeVariantExecutionSession(row.value);
  if(v.projectId!==project || row.id!==variantExecutionSessionId(v) || row.revision!==v.cursor+1)
    invalid('The execution session differs from its full identity or cursor');
  const draft=exact<DiscoveryDraft>(store,v.draft,'discovery-draft'),question=exact<Question>(store,v.question,'question');
  if(draft.value.projectId!==project || question.value.projectId!==project || question.value.draftId!==draft.id
    || !draft.value.questions.includes(question.id)) invalid('The execution session has foreign draft/Question');
  if(v.variantSubject.kind==='proposal') {
    const basis=readVariantSnapshot(store,project,v.variantSubject.snapshot);
    if(!same(basis.value.draft,v.draft) || !basis.value.questions.some(q=>same(q.question,v.question)))
      invalid('The session Question is not the exact Question of its snapshot');
  }
  if(v.cursor===1) {
    const running=readResearchConsumerIntent(store,v.result!.intent);
    const paid=readResearchConsumerExecution(store,project,reference(running));
    if(paid.kind!=='response' || paid.intent.value.state!=='applied'
      || paid.intent.value.outputs?.length!==1 || !same(paid.intent.value.outputs[0],ref)) invalid('The execution receipt has no atomic managed application');
    const initial=exact<VariantExecutionSession>(store,running.value.owner,'discovery-variant-session');
    const projected=projectPaidVariantSession(initial,running,{call:reference(paid.call),response:paid.response,payload:paid.payload});
    if(!same(projected,v) || paid.intent.revision!==running.revision+1
      || !same(paid.intent.value,{...running.value,state:'applied',outputs:paid.intent.value.outputs}))
      invalid('The execution receipt differs from its exact paid application');
  }
  return row;
}

export interface VariantSessionInput {
  projectId:string; variantSubject:VariantSubject; environment:Revision<Environment>; role:RoleBinding; prompt:string;
}
/** Prepare execution before the first intent. A saved paid operation is resumed by its original identity;
 * today's mode/state are guards only for a new physical reservation, never a prerequisite of paid recovery. */
export function prepareVariantSession(store:Store,input:VariantSessionInput):{
  session:Revision<VariantExecutionSession>;intent:Revision<ResearchConsumerIntent>;
} {
  requireCondition(input && typeof input.projectId==='string' && input.projectId.length>0
    && input.environment && isRef(input.environment) && input.role && typeof input.role.actor==='string'
    && typeof input.prompt==='string' && input.prompt.trim().length>0,
    'discovery_variant_session_invalid','A variant session needs its explicit project, environment, actor and instruction');
  const subject=decodeVariantSubject(input.variantSubject);
  if(subject.kind==='decision') throw new EngineError('discovery_variant_set_not_ready',
    'A decision producer requires the proven set published by 4B.1');
  const snapshot=readVariantSnapshot(store,input.projectId,subject.snapshot);
  const question=snapshot.value.questions[0]?.question;
  if(!question) invalid('A variant dispatch needs its actual plan Question');
  const initial:VariantExecutionSession={contract:VARIANT_SESSION_CONTRACT,projectId:input.projectId,
    draft:snapshot.value.draft,question,variantSubject:subject,purpose:'variant-proposal',actor:input.role.actor,cursor:0,result:null};
  decodeVariantExecutionSession(initial);
  const mode=store.get<Record<string,unknown>>(subject.mode.id,subject.mode.revision);
  if(!mode || !same(reference(mode),subject.mode) || mode.value.projectId!==input.projectId) invalid('The variant mode basis is missing or foreign');
  const id=variantExecutionSessionId(initial),existing=store.get<VariantExecutionSession>(id);
  let session=existing?readVariantExecutionSession(store,input.projectId,reference(existing)):null;
  const previous=session?findResearchConsumerIntent(store,input.projectId,initial.purpose,id,initial.draft.id):null;
  if(previous) return {session:session!,intent:readResearchConsumerIntent(store,reference(previous))};
  // Every NEW intent needs a proven admission, including a session-only recovery.
  // A saved intent above retains its own dispatch and role for paid recovery.
  const environment=exact<Environment>(store,reference(input.environment),'environment');
  if(environment.value.projectId!==input.projectId || !same(environment.value,input.environment.value)
    || ![environment.value.implementer,environment.value.reviewer].some(role=>same(role,input.role)))
    invalid('The variant actor/role needs its exact project environment');
  if(!session) session=store.writeMany<VariantExecutionSession>([{id,kind:'discovery-variant-session',expected:0,value:initial}],
    uniqueTransactionGuards([initial.draft,question,reference(environment),...variantTransportGuards(input.projectId,initial.draft.id,subject),{id,absent:true}]))[0]!;
  if(session.value.cursor!==0) invalid('A completed variant session lost its original intent');
  const context={...variantTransportFields(input.projectId,initial.draft,question,initial.purpose,initial.actor,subject),
    snapshot:snapshot.value,history:[]};
  const basis=[subject.snapshot,subject.mode,...(subject.expectedSelection?[subject.expectedSelection]:[])];
  const intent=prepareResearchConsumerIntent(store,{projectId:input.projectId,kind:initial.purpose,key:id,
    owner:reference(session),draft:initial.draft,question,role:input.role,dispatch:environment.value,profile:null,
    cursor:{sessionId:id,offset:0,variantSubject:subject,prompt:input.prompt,context},basis,
    guards:uniqueTransactionGuards([reference(session),initial.draft,question,reference(input.environment),
      ...variantTransportGuards(input.projectId,initial.draft.id,subject)])});
  return {session,intent};
}

/** The same application preparer used by every managed consumer writes the execution
 * receipt and terminal intent atomically. 4B adds its product projection to this lifecycle. */
export function applyVariantSession(store:Store,project:string,intentRef:Ref):Revision<VariantExecutionSession> {
  const intent=readResearchConsumerIntent(store,intentRef);
  if(!['variant-proposal','variant-decision'].includes(intent.value.kind) || intent.value.projectId!==project)
    invalid('The selected intent is not this project\'s variant execution');
  if(intent.value.state==='applied') {
    const output=intent.value.outputs?.find(ref=>ref.id===intent.value.owner.id);
    if(!output) invalid('The completed variant intent lost its execution output');
    return readVariantExecutionSession(store,project,output);
  }
  const paid=readResearchConsumerExecution(store,project,intentRef);
  if(paid.kind!=='response') throw new EngineError('research_consumer_execution_refused','The original variant execution has no response');
  const owner=readVariantExecutionSession(store,project,paid.intent.value.owner);
  const value=projectPaidVariantSession(owner,paid.intent,{call:reference(paid.call),response:paid.response,payload:paid.payload});
  const batch=prepareResearchConsumerApplication(store,reference(paid.intent),reference(paid.call),[
    {id:owner.id,kind:owner.kind,expected:owner.revision,value}],[reference(owner)]);
  return store.writeMany<VariantExecutionSession>(batch.writes,batch.guards)[0]!;
}
export async function runVariantSession(store:Store,input:VariantSessionInput):Promise<Revision<VariantExecutionSession>> {
  const prepared=prepareVariantSession(store,input),saved=prepared.intent;
  if(saved.value.state==='applied') return applyVariantSession(store,input.projectId,reference(saved));
  const v=saved.value;
  await researchCall(v.role,v.dispatch,v.cursor.prompt,v.cursor.context,undefined,
    {store,draftId:v.draft.id,questionId:v.question.id,purpose:v.kind,consumerIntent:reference(saved),session:v.owner});
  const head=store.get<ResearchConsumerIntent>(saved.id)!;
  return applyVariantSession(store,input.projectId,reference(head));
}
