import type { Store, Revision } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { Evidence } from '../evidence/evidence.js';
import { canonical } from '../canonical.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import { requireCondition } from '../errors.js';
interface SavedSynthesis { projectId: string; question: Ref; inputs: Ref[]; checkpoints: Ref[] }
export function configureSavedSynthesis(store: Store, questionId: string, expected: number) {
  const question=store.get<Question>(questionId),draft=question && store.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(question?.kind==='question' && draft?.kind==='discovery-draft' && question.value.status!=='answered',
    'research_question_foreign','Saved recovery needs its open question');
  const checkpoints=store.list<any>('research-checkpoint').filter(c=>c.value.projectId===draft.value.projectId
    && canonical(c.value.question)===canonical(reference(question)));
  requireCondition(checkpoints.length>0,'saved_synthesis_missing','No paid checkpoint exists for this exact question');
  const evidence=new Evidence(store);
  requireCondition(checkpoints.every(c=>c.value.observations.every((o:any)=>evidence.verify(o))),
    'synthesis_evidence_stale','Saved checkpoint source versions must still be available');
  return store.writeMany<SavedSynthesis>([{id:`saved-synthesis:${questionId}`,kind:'saved-synthesis',expected,
    value:{projectId:draft.value.projectId,question:reference(question),inputs:draft.value.inputs,checkpoints:checkpoints.map(reference)}}],
    [reference(question),reference(draft),...draft.value.inputs,...checkpoints.map(reference)])[0]!;
}
export function savedSynthesisMaterials(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>) {
  const saved=store.get<SavedSynthesis>(`saved-synthesis:${question.id}`);
  if(!saved)return null;
  requireCondition(saved.kind==='saved-synthesis' && saved.value.projectId===draft.value.projectId
    && canonical(saved.value.question)===canonical(reference(question)) && canonical(saved.value.inputs)===canonical(draft.value.inputs),
    'saved_synthesis_stale','Recovery cannot use checkpoints of a different question or basis');
  return saved.value.checkpoints.map(ref=>{
    const record=store.get<any>(ref.id,ref.revision);
    requireCondition(record?.kind==='research-checkpoint' && record.hash===ref.hash
      && record.value.observations.every((o:any)=>new Evidence(store).verify(o)), 'synthesis_evidence_stale','Saved findings lost their original evidence');
    return {kind:'saved-findings',value:{checkpoint:ref,proposal:record.value.proposal,unresolved:record.value.unresolved,
      evidence:record.value.observations.map((o:any,index:number)=>({source:o.source,selector:o.selector,original:{record:ref,pointer:`/observations/${index}`}})),
      instruction:'Already paid proposed findings; reconcile all saved pieces. Page-pending notices are not new research questions.'}};
  });
}
