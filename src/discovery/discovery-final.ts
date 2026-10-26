import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Store, Revision } from '../storage/store.js';
import type { Observation, Source, Selector } from '../evidence/evidence.js';
import { historicalObservation } from './response-recovery.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { DossierAssessmentSession, DossierAssessmentApplication } from './assessment-session.js';
import { readRequestWire, type ReadRequestWireResult } from './request-parts.js';
import type { DiscoveryDraft, Question, Fact } from './discovery.js';
import { readDraftExact, proveIssuedAnswer, savedAcceptanceAct } from './projection-reader.js';
import { DISCOVERY_ACCEPTANCE_ACT_KIND, discoveryAcceptanceActId, type DiscoveryAcceptanceAct } from './v7-contracts.js';
import { readDossierAssessmentAt } from './research-assessment.js';
import type { PaidDossierAssessment } from './dossier-manifest.js';
import type { DossierAssessmentPacket, DossierAssessmentSubject } from './research-model.js';

export const DISCOVERY_FINAL_SUBJECT = 'discovery-final-subject/v1' as const;
export const DISCOVERY_FINAL_PACKET = 'discovery-final-packet/v1' as const;
export interface DiscoveryFinalSubject {
  contract:typeof DISCOVERY_FINAL_SUBJECT; kind:'final'; identity:string; projectId:string;
  dossier:DossierAssessmentSubject;
  basis:{assessment:Ref; draft:Ref; frame:Ref; plan:Ref; session:Ref; application:Ref; call:Ref; request:Ref; response:Ref;
    brief:{question:Ref; fact:Ref; acceptance:Ref; source:Ref; selector:Selector}};
}
export interface DiscoveryFinalPacket {
  contract:typeof DISCOVERY_FINAL_PACKET; subject:DiscoveryFinalSubject;
  assessment:Revision<PaidDossierAssessment>; dossier:DossierAssessmentPacket; basis:DossierAssessmentPacket['basis'];
  terminal:{session:Revision<DossierAssessmentSession>;application:Revision<DossierAssessmentApplication>;
    call:Revision<ModelCall>;request:ReadRequestWireResult;response:Revision<Record<string,Json>>};
  brief:{question:Revision<Question>; fact:Revision<Fact>; acceptance:Revision<DiscoveryAcceptanceAct>;
    source:Revision<Source>; observation:Observation; text:string};
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const object=(value:unknown):value is Record<string,any>=>!!value && typeof value==='object' && !Array.isArray(value);
function requireFinal(condition:unknown,message:string):asserts condition {
  if(!condition)throw new EngineError('discovery_final_subject_invalid',message);
}
function shape(value:unknown,keys:string[]):asserts value is Record<string,any> {
  requireFinal(object(value)&&same(Object.keys(value).sort(),[...keys].sort()),'Missing, mixed or unknown final fields');
}
function exactRef(value:unknown):asserts value is Ref {
  shape(value,['id','revision','hash']);requireFinal(isRef(value),'An exact non-null final ground is required');
}
function exact<T>(store:Store,at:Ref,kind:string):Revision<T> {
  exactRef(at);const row=store.get<T>(at.id,at.revision);
  requireFinal(row?.kind===kind && same(reference(row),at) && hashJson(row.value as never)===at.hash,
    'An exact final ground is missing, foreign or changed');
  return row;
}
function identity(basis:Omit<DiscoveryFinalSubject,'identity'>) {return `discovery-final:${hashJson(basis as unknown as Json)}`;}
function decodeSubject(input:unknown):DiscoveryFinalSubject {
  shape(input,['contract','kind','identity','projectId','dossier','basis']);
  requireFinal(input.contract===DISCOVERY_FINAL_SUBJECT && input.kind==='final' && typeof input.projectId==='string' && input.projectId.length>0,
    'Unknown final subject contract');
  shape(input.basis,['assessment','draft','frame','plan','session','application','call','request','response','brief']);
  for(const field of ['assessment','draft','frame','plan','session','application','call','request','response'])exactRef(input.basis[field]);
  shape(input.basis.brief,['question','fact','acceptance','source','selector']);
  for(const field of ['question','fact','acceptance','source'])exactRef(input.basis.brief[field]);
  const {identity:presented,...basis}=input;
  requireFinal(presented===identity(basis as unknown as Omit<DiscoveryFinalSubject,'identity'>),'The final identity differs from its exact grounds');
  return structuredClone(input) as DiscoveryFinalSubject;
}
/** Events select the historical question only; the shared field/acceptance readers
 * below prove its answer. A later current head never supplies this brief. */
function draftBoundary(store:Store,draft:Revision<DiscoveryDraft>):number {
  const end=store.lastEvent();let from=0;
  while(from<end){
    const page=store.eventsPage(from,end,256);requireFinal(page.length>0,'The saved draft has no committed boundary');
    for(const event of page)if(event.id===draft.id && event.revision===draft.revision){
      requireFinal(same(store.getAtEvent(event.sequence,draft.id,draft.revision),draft),'The saved draft boundary changed');
      return event.sequence;
    }
    from=page.at(-1)!.sequence;
  }
  throw new EngineError('discovery_final_subject_invalid','The saved draft has no committed boundary');
}
function originalBrief(store:Store,project:string,draft:Revision<DiscoveryDraft>):DiscoveryFinalPacket['brief'] {
  requireFinal(draft.kind==='discovery-draft' && object(draft.value) && object(draft.value.fields)
    && Array.isArray(draft.value.questions) && draft.value.questions.every(id=>typeof id==='string')
    && draft.value.projectId===project && typeof draft.value.fields.brief==='string'
    && draft.value.fields.brief.length>0,'The saved draft has no original accepted brief');
  const boundary=draftBoundary(store,draft);
  let candidates=draft.value.questions.map(id=>store.getAtEvent<Question>(boundary,id)).filter(row=>row?.value?.spec?.field==='brief');
  // The draft write can precede its question-after in the same atomic acceptance.
  // Only the canonical act can name that after-revision. The shared reader below
  // must prove this same act and its transition, bounded by the saved draft.
  const sameBatch=store.list<DiscoveryAcceptanceAct>(DISCOVERY_ACCEPTANCE_ACT_KIND).filter(row=>
    row.value?.projectId===project && row.value.draftId===draft.id && row.value.field==='brief'
    && row.revision===1 && isRef(row.value.answer)
    && row.id===discoveryAcceptanceActId(project,draft.id,'brief',row.value.answer)
    && same(row.value.draftAfter,reference(draft)));
  requireFinal(sameBatch.length<=1,'The original brief has mixed acceptances');
  if(sameBatch.length){
    const act=exact<DiscoveryAcceptanceAct>(store,reference(sameBatch[0]!),DISCOVERY_ACCEPTANCE_ACT_KIND);
    requireFinal(isRef(act.value.questionAfter),'The brief acceptance lost its question');
    candidates=[exact<Question>(store,act.value.questionAfter,'question')];
  }
  requireFinal(candidates.length===1 && candidates[0],'The saved draft needs exactly one brief question');
  const question=exact<Question>(store,reference(candidates[0]),'question'),q=question.value;
  requireFinal(object(q) && object(q.spec) && q.projectId===project && q.draftId===draft.id && draft.value.questions.includes(question.id)
    && q.spec.field==='brief' && q.spec.kind==='fact' && q.status==='answered' && isRef(q.answer),
    'The original brief question is absent, foreign or unanswered');
  const fact=exact<Fact>(store,q.answer,'fact');
  requireFinal(object(fact.value) && object(fact.value.observation) && typeof fact.value.observation.value==='string'
    && isRef(fact.value.observation.source) && object(fact.value.observation.selector),'The original brief lost its observation');
  const proven=proveIssuedAnswer(store,draft,{question,foreign:false,answered:true,answerRef:q.answer,field:'brief'},
    fact as unknown as Revision<Record<string,unknown>>);
  requireFinal(proven.ok && proven.proof.namespaced && proven.proof.matchesSpec && proven.proof.reproduces
    && proven.proof.provenance.kind==='fact' && savedAcceptanceAct(store,draft,question,'brief',q.answer,proven.proof.value),
    'The original brief has no proven saved field acceptance');
  const acceptanceId=discoveryAcceptanceActId(project,draft.id,'brief',q.answer);
  const saved=store.get<DiscoveryAcceptanceAct>(acceptanceId,1);requireFinal(saved,'The original brief acceptance is missing');
  const acceptance=exact<DiscoveryAcceptanceAct>(store,reference(saved),DISCOVERY_ACCEPTANCE_ACT_KIND);
  requireFinal(same(acceptance.value.questionAfter,reference(question))
    && isRef(acceptance.value.draftAfter) && acceptance.value.draftAfter.id===draft.id
    && acceptance.value.draftAfter.revision<=draft.revision
    && (acceptance.value.draftAfter.revision<draft.revision || same(acceptance.value.draftAfter,reference(draft)))
    && (!sameBatch.length || same(reference(acceptance),reference(sameBatch[0]!))),
    'The original brief acceptance does not prove this question before the saved draft');
  const observation=proven.proof.provenance.observation;
  requireFinal(observation.projectId===project,'The brief observation belongs to another project');
  const source=exact<Source>(store,observation.source,'source');
  const extracted=historicalObservation(store,project,{source:observation.source,selector:observation.selector});
  requireFinal(same(extracted,observation) && typeof extracted.value==='string' && extracted.value.length>0,
    'The original brief selector does not reproduce the saved bytes');
  return {question,fact,acceptance,source,observation:extracted,text:extracted.value};
}
/** Read-only D7 input. The paid D6 chain is proved exactly once in this call. */
export async function prepareDiscoveryFinalSubject(store:Store,project:string,assessmentRef:unknown):Promise<DiscoveryFinalPacket> {
  requireFinal(typeof project==='string'&&project.length>0,'A final subject needs its project');exactRef(assessmentRef);
  const assessment=await readDossierAssessmentAt(store,project,assessmentRef),value=assessment.value,dossier=value.result.packet;
  // The shared D6 reader above has already proved these exact paid grounds.
  // Load their complete records/wire for the final input without replaying that chain.
  const session=exact<DossierAssessmentSession>(store,value.session,'assessment-session');
  const application=exact<DossierAssessmentApplication>(store,value.application,'assessment-application');
  const call=exact<ModelCall>(store,value.call,'model-call');
  const request=readRequestWire(store,value.request,{projectId:project,draftId:call.value.draftId,
    requestId:call.value.requestId,errorCode:'discovery_final_subject_invalid'});
  const response=exact<Record<string,Json>>(store,value.response,'model-response');
  const terminal={session,application,call,request,response};
  const draft=readDraftExact(store,dossier.basis.draft.ref);
  requireFinal(draft && draft.kind==='discovery-draft' && hashJson(draft.value as never)===draft.hash,'The saved dossier draft is missing or changed');
  const brief=originalBrief(store,project,draft);
  const base:Omit<DiscoveryFinalSubject,'identity'>={contract:DISCOVERY_FINAL_SUBJECT,kind:'final',projectId:project,dossier:value.subject,
    basis:{assessment:reference(assessment),draft:reference(draft),frame:dossier.basis.frame.ref,plan:dossier.basis.plan.ref,
      session:value.session,application:value.application,call:value.call,request:value.request,response:value.response,
      brief:{question:reference(brief.question),fact:reference(brief.fact),acceptance:reference(brief.acceptance),source:reference(brief.source),selector:brief.observation.selector}}};
  return structuredClone({contract:DISCOVERY_FINAL_PACKET,subject:{...base,identity:identity(base)},assessment,dossier,basis:dossier.basis,brief,terminal});
}
export async function requireDiscoveryFinalSubject(store:Store,project:string,input:unknown):Promise<DiscoveryFinalPacket> {
  const subject=decodeSubject(input);requireFinal(subject.projectId===project,'The final subject belongs to another project');
  const packet=await prepareDiscoveryFinalSubject(store,project,subject.basis.assessment);
  requireFinal(same(subject,packet.subject),'The final subject differs from its proven saved input');return packet;
}
export async function requireDiscoveryFinalPacket(store:Store,project:string,input:unknown):Promise<DiscoveryFinalPacket> {
  shape(input,['contract','subject','assessment','dossier','basis','brief','terminal']);
  requireFinal(input.contract===DISCOVERY_FINAL_PACKET,'Unknown final packet contract');
  const packet=await requireDiscoveryFinalSubject(store,project,input.subject);
  requireFinal(same(input,packet),'The final packet omits or substitutes original material');return packet;
}
