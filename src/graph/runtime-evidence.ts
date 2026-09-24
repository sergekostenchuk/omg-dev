import { realpathSync } from 'node:fs';
import { canonical } from '../canonical.js';
import { Evidence, type Source, type Observation } from '../evidence/evidence.js';
import type { FieldSpec } from '../discovery/discovery.js';
import type { TechnicalReport } from './research-contracts.js';
import type { Store, TransactionGuard } from '../storage/store.js';
import { reference, isRef, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import type { ResearchScope } from './research-scope.js';
import { obligationAssignment, type ObligationAssignment } from './obligation-policy.js';
import { runtimeContext, runtimeCode, runtimeExecutableIdentity, runtimeSubjectPath, omRuntimeAssignment } from '../runtime/runtime-observation.js';
import { runtimeSource, type RuntimeObservation } from '../runtime/runtime-observation-model.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';

export interface RuntimeEvidence {
  obligation: string; document: string; observation: Ref; source: Ref; authorization: Ref; code: Ref[];
}

export function runtimeSupport(store:Store,project:string,assignment:ObligationAssignment,sourceRef:Ref){
  if(!assignment.runtimeCheck)return null;
  try{
    const source=store.get<Source>(sourceRef.id),ref=source?.value.provenance?.record;
    if(source?.kind!=='source'||source.value.projectId!==project||canonical(reference(source))!==canonical(sourceRef)
      ||source.value.provenance?.kind!=='runtime-observation'||!isRef(ref))return null;
    const record=store.get<RuntimeObservation>(ref.id);
    if(record?.kind!=='runtime-observation'||record.value.version!==1||record.value.projectId!==project||canonical(reference(record))!==canonical(ref)
      ||record.value.status!=='observed'||record.value.result?.signal!==null||!Number.isInteger(record.value.result.exitCode)
      ||canonical(record.value.check)!==canonical(assignment.runtimeCheck))return null;
    const expected=runtimeSource(record);
    if(source.id!==expected.id||canonical(source.value)!==canonical(expected.value))return null;
    if('scope' in assignment && isRef(assignment.scope) && assignment.scope.id.startsWith('om-obligations:')
      && canonical(assignment.scope)!==canonical(record.value.scope))return null;
    let declarationGuards:Ref[]=[];
    if(record.value.scope.id.startsWith('om-obligations:')){
      const declared=omRuntimeAssignment(store,project,record.value.scope,record.value.requestedFor,true);
      if(canonical(declared.assignment)!==canonical(assignment))return null;
      declarationGuards=declared.guards;
    }else{
      const authorization=store.get<ResearchScope>(record.value.scope.id,record.value.scope.revision);
      if(authorization?.kind!=='research-scope'||authorization.hash!==record.value.scope.hash||authorization.value.projectId!==project
        ||canonical(obligationAssignment(authorization.value,record.value.requestedFor)?.runtimeCheck)!==canonical(record.value.check))return null;
    }
    const current=runtimeContext(store,project);
    if(canonical(current.binding)!==canonical(record.value.runtimeBinding)||realpathSync(process.execPath)!==record.value.executable.path
      ||canonical(runtimeExecutableIdentity(record.value.executable.path))!==canonical(record.value.executable.identity))return null;
    const expectedSubjects=[...assignment.runtimeCheck.subjects.map(requested=>({requested,kind:'file'})),...assignment.runtimeCheck.executables.map(requested=>({requested,kind:'executable'}))];
    if(record.value.subjects.length!==expectedSubjects.length
      ||record.value.subjects.some((subject,i)=>subject.requested!==expectedSubjects[i]!.requested||subject.kind!==expectedSubjects[i]!.kind
        ||runtimeSubjectPath(current.root,subject.requested,subject.kind)!==subject.path
        ||canonical(runtimeExecutableIdentity(subject.path))!==canonical(subject.identity)))return null;
    const code=runtimeCode(store,project,record.value.check,record.value.codeRoot);
    const full=new Evidence(store).observe(project,sourceRef,{kind:'json-pointer',pointer:''});
    return {record,code,full,guards:uniqueRefs([reference(record),sourceRef,...declarationGuards,...current.guards,...code.map(o=>o.source)]),
      admissionGuards:current.admissionGuards};
  }catch{return null;} // Malformed, stale or foreign provenance never becomes runtime support.
}

export function collectRuntimeEvidence(store:Store,project:string,spec:FieldSpec,report:TechnicalReport,observations:Observation[]){
  const proofs:RuntimeEvidence[]=[],supporting:Observation[]=[],guards:Ref[]=[],admissionGuards:TransactionGuard[]=[];
  if(spec.obligationContract!=='evidence-v1')return {proofs,supporting,guards,admissionGuards};
  for(const obligation of spec.obligations??[]){
    const assignment=obligation.assignment,item=report.coverage?.find(c=>c.obligation===obligation.id);
    if(assignment?.kind!=='environment-confirmation'||!assignment.runtimeCheck||!item||!Array.isArray(item.designs))continue;
    const designs=report.designs.filter(d=>item.designs.includes(d.id)&&d.consumer===obligation.consumer);
    for(const document of report.documents??[]){
      if(document.kind!=='document-observation'||!document.designs.some(id=>designs.some(d=>d.id===id))
        ||!Number.isSafeInteger(document.citation)||document.citation<0)continue;
      const observation=observations[document.citation];if(!observation)continue;
      const found=runtimeSupport(store,project,assignment,observation.source);if(!found)continue;
      proofs.push({obligation:obligation.id,document:document.id,observation:reference(found.record),source:observation.source,
        authorization:found.record.value.scope,code:found.code.map(o=>o.source)});
      guards.push(...found.guards);
      admissionGuards.push(...found.admissionGuards);
      for(const extra of [found.full,...found.code]){
        const source=store.get<Source>(extra.source.id)!;
        if([...observations,...supporting].some(o=>canonical(o.source)===canonical(extra.source)
          &&(o.selector.kind==='json-pointer'&&o.selector.pointer===''||o.selector.kind==='text-range'&&o.selector.start===0&&o.selector.end===source.value.content.length)))continue;
        supporting.push(extra);
      }
    }
  }
  return {proofs,supporting,guards:uniqueRefs(guards),admissionGuards:uniqueTransactionGuards(admissionGuards)};
}

/** These are persistent evidence dependencies. Current runtime configuration
 * refs are admission guards, not a reason to reinterpret an old observation. */
export function runtimeEvidenceDependencies(proofs:RuntimeEvidence[]):Ref[]{
  return uniqueRefs(proofs.flatMap(proof=>[proof.observation,proof.source,...proof.code]));
}
