import { reference, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import { readDiscoveryFinalResponseCorrection, readDiscoveryFinalDispatchLeaf,
  readDiscoveryFinalExecutionAt, runDiscoveryFinalExecution } from './discovery-final-execution.js';
import { readDiscoveryFinalAssessmentResponseCorrection, readDiscoveryFinalAssessmentDispatchLeaf,
  readDiscoveryFinalAssessmentExecutionAt, runDiscoveryFinalAssessmentExecution } from './discovery-final-assessment-execution.js';
import { readConditionEvidenceResponseCorrection, readConditionEvidenceDispatchLeaf,
  readConditionEvidenceExecutionAt, runConditionEvidenceExecution } from './discovery-condition-evidence-execution.js';

/** The command selects an existing original-role application. Each adapter
 * keeps its own subject proof, native producer, physical claim and projector. */
export async function retryFinalRoleResponse(store:Store,project:string,root:Ref,restoreOnly:boolean) {
  const kind=store.get(root.id,root.revision)?.kind;
  if(kind==='discovery-final-application') {
    const correction=await readDiscoveryFinalResponseCorrection(store,project,root);
    const head=store.get<any>(correction.latest.id)!;
    if(head.value.state==='applied') return output(root,await readDiscoveryFinalExecutionAt(store,project,head.value.after));
    if(restoreOnly && (correction.retry || !correction.paid)) return {kind:'pending' as const,root,application:reference(correction.latest)};
    const {session}=readDiscoveryFinalDispatchLeaf(store,root);
    return output(root,await runDiscoveryFinalExecution(store,project,session.value.prepared,
      {responseCorrection:root,restoreOnly,allowance:1}));
  }
  if(kind==='discovery-final-assessment-application') {
    const correction=await readDiscoveryFinalAssessmentResponseCorrection(store,project,root);
    const head=store.get<any>(correction.latest.id)!;
    if(head.value.state==='applied') return output(root,await readDiscoveryFinalAssessmentExecutionAt(store,project,head.value.after));
    if(restoreOnly && (correction.retry || !correction.paid)) return {kind:'pending' as const,root,application:reference(correction.latest)};
    const {session}=readDiscoveryFinalAssessmentDispatchLeaf(store,root);
    return output(root,await runDiscoveryFinalAssessmentExecution(store,project,session.value.source,session.value.prepared,
      {responseCorrection:root,restoreOnly,allowance:1}));
  }
  const correction=await readConditionEvidenceResponseCorrection(store,project,root);
  const head=store.get<any>(correction.latest.id)!;
  if(head.value.state==='applied') return output(root,await readConditionEvidenceExecutionAt(store,project,head.value.after));
  if(restoreOnly && (correction.retry || !correction.paid)) return {kind:'pending' as const,root,application:reference(correction.latest)};
  const {session}=readConditionEvidenceDispatchLeaf(store,root);
  return output(root,await runConditionEvidenceExecution(store,project,session.value.source,session.value.prepared,
    {responseCorrection:root,restoreOnly,allowance:1}));
}

function output(root:Ref,result:{session:{id:string;revision:number;hash:string};result:unknown}) {
  const {id,revision,hash}=result.session;
  return {kind:result.result?'applied' as const:'pending' as const,root,session:{id,revision,hash}};
}
