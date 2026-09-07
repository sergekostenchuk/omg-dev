import type {Store} from '../storage/store.js';
import type {ModelCall} from '../runtime/model-usage.js';
import {isRef,reference,type Ref} from '../pipeline/contracts.js';
import {processStart} from '../runtime/process-identity.js';
import {requireCondition} from '../errors.js';

/** Recovery records an observed lost process. It never invents usage, releases
 * unknown token reservations, or stops a live owner/provider on an assumption. */
export function recoverModelCall(store:Store,project:string,ref:Ref){
 requireCondition(isRef(ref),'model_call_ref_invalid','Recovery needs an exact call reference');
 const call=store.get<ModelCall>(ref.id);
 requireCondition(call?.kind==='model-call'&&call.value.projectId===project&&call.hash===ref.hash&&call.revision===ref.revision,
  'model_call_foreign','Recovery must bind the current call of this project');
 requireCondition(call.value.status==='running','model_call_not_running','Only an interrupted running call needs recovery');
 const owner=call.value.ownerProcess;
 requireCondition(owner&&Number.isSafeInteger(owner.pid)&&typeof owner.started==='string'&&owner.started.length>0,
  'model_call_identity_missing','The legacy call has no provable owner identity; do not guess that its provider stopped');
 requireCondition(processStart(owner.pid)!==owner.started,'model_call_still_running','The research owner is still alive');
 const child=call.value.providerProcess;
 requireCondition(child&&Number.isSafeInteger(child.pid)&&typeof child.started==='string'&&child.started.length>0,
  'model_call_identity_missing','Provider identity was not saved; its termination cannot be inferred from the owner exit');
 requireCondition(processStart(child.pid)!==child.started,'model_call_still_running','The recorded provider is still alive');
 const incident={projectId:project,call:ref,reason:'Recorded owner and provider processes no longer exist with their original identities',usageKnown:call.value.usage!==null};
 return store.writeMany<ModelCall>([{id:call.id,kind:call.kind,expected:call.revision,value:{...call.value,status:'failed',finishedAt:Date.now(),error:'process_lost'}},
  {id:`model-call-recovery:${call.value.requestId}`,kind:'model-call-recovery',expected:0,value:incident}],[reference(call)])[0]!;
}
