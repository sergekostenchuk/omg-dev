import { hashJson } from '../src/canonical.js';
import { discoveryAcceptanceActId, type DiscoveryAcceptanceAct } from '../src/discovery/v7-contracts.js';
import { assessAnswer, assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { V7_AXES } from '../src/discovery/v7-contracts.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { researchSetup, acceptPlan as acceptPlanOnce, planQuestion, rand, hypothesis, produce, type PlanQuestion, type DiscoveryFixture, type Entry } from './discovery-v7-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';

/** A second plan in one project cannot write the source `basis` again (revision_conflict): every base draft names its own. */
const acceptPlan = (f: Pick<DiscoveryFixture, 'store' | 'engine' | 'discovery'>, project: string, questions: PlanQuestion[]) =>
  acceptPlanOnce(f, project, questions, { sourceKey: 'per-draft' });
async function setup(t: test.TestContext) {
  const f = await researchSetup(t, { prefix: 'omg-6-2-d-', sourceKey: 'per-draft' }), { v, project, environment, subject, prompt } = f;
  let runId: string | undefined;
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:context.dispatchMode==='planning'?'reading-planner' as const:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,...(context.dispatchMode?{mode:context.dispatchMode}:{}),instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:context.dispatchMode==='planning'?'reading-planner':'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  return {...f,prepare};
}

import { applyDiscoveryAssessment, v7ProgressBaseline, proveAppliedAttemptClassification } from '../src/discovery/v7-progress.js';
import { proveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';

type Setup = Awaited<ReturnType<typeof setup>>;
async function assess(f: Setup, entries:Entry[], options:{accept?:boolean; selected?:number[]; requirements?:boolean}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:'q-industry',entries});
  const baseline=v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.selected ? claims.filter((_,i)=>options.selected!.includes(i))
    :options.accept?claims:[];
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:accepted.map(claim=>({claim,reason:'New basis'})),
    duplicates:[],
    noProgress:entries.filter(e=>!accepted.some(c=>c.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No new basis'})),
    transition:null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}


import { projectDossierManifest, readDossierManifestStructural, readDossierContradictionsAt,
  DOSSIER_MANIFEST_CONTRACT, DOSSIER_MANIFEST_KIND, type DossierManifest } from '../src/discovery/dossier-manifest.js';
import type { DossierContradiction, DossierResolution, DossierContradictionSide } from '../src/discovery/dossier-contradictions.js';

const side = (claim:ClaimAddress,status:DossierContradictionSide['status'],assessment:Ref|null):DossierContradictionSide=>({claim,status,assessment});
const contradiction = (sides:DossierContradictionSide[],resolution:DossierResolution={state:'open'},relation:DossierContradiction['relation']='contradicts'):DossierContradiction=>({
  id:'c',relation,sides:sides as DossierContradiction['sides'],reason:'The two claims disagree about the requirement',
  planQuestionIds:['q-industry'],blocking:false,resolution});
function snapshot(f:Setup,claims:ClaimAddress[],contradictions:DossierContradiction[]):DossierManifest {
  return {contract:DOSSIER_MANIFEST_CONTRACT,projectId:'p',draft:reference(f.v.draft),frame:f.v.frameRef,plan:f.v.planAnswer,
    completeness:'partial',reasons:[{code:'stall',message:'Other axes remain open',grounds:[f.v.planAnswer]}],
    axes:Object.fromEntries(V7_AXES.map(axis=>[axis,axis==='industry'?{depth:'deep',reason:null,claims}
      :{depth:'inapplicable',reason:'Outside this snapshot',claims:[]}])) as DossierManifest['axes'],unknowns:[],contradictions};
}
function save(f:Setup,value:DossierManifest) {
  const p=projectDossierManifest(value);
  return reference(f.store.get(p.id)??f.store.write({id:p.id,kind:DOSSIER_MANIFEST_KIND,expected:0,value:p.value}));
}
function refused(action:()=>unknown,field?:string) {
  assert.throws(action,(error:unknown)=>{
    assert.ok(error instanceof EngineError, String(error));
    assert.ok(error.details && typeof error.details==='object','The refusal is addressed');
    if(field)assert.equal((error.details as any).field,field,error.message);
    return true;
  });
}
async function pair(f:Setup,options:{apply?:boolean;both?:boolean;link?:'refutedBy'|'contradicts';scoped?:boolean;requirements?:boolean}={}) {
  const one=hypothesis(f,'Grounded requirement A');
  if(options.scoped)Object.assign(one.value.claims[0]!.scope,{region:'North'});
  const a=await produce(f,one),aClaim:ClaimAddress={project:'p',container:a.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const two=hypothesis(f,'Counterargument B');
  if(options.link)(two.value.claims[0] as any)[options.link]=[aClaim];
  if(options.scoped)Object.assign(two.value.claims[0]!.scope,{region:'South'});
  const b=await produce(f,two),judged=await assess(f,[a,b],{selected:options.both?[0,1]:[0],requirements:options.requirements??true});
  const applied=options.apply===false?null:applyDiscoveryAssessment(f.store,'p',reference(judged.paid));
  return {...judged,a,b,applied,refs:[reference(judged.paid)]};
}

test('6.2-D: real first application proves accepted and rejected sides; accepted keeps its public P.4 proof',async t=>{
  const f=await setup(t),p=await pair(f),sides=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const manifest=save(f,snapshot(f,p.claims,[contradiction(sides,{state:'side',holds:0,reason:'The applied original assessment supports A',grounds:p.refs})]));
  const before=f.store.list(),wires=f.wires().length,cold=f.open();
  cold.list=()=>assert.fail('No global Store scan belongs to contradiction proof');
  const result=readDossierContradictionsAt(cold,'p',manifest,{assessments:p.refs});
  assert.equal(result.verification,'contradictions');assert.deepEqual(result.manifestRef,manifest);assert.deepEqual(result.assessments,p.refs);
  assert.deepEqual(result.contradictions[0]!.sides.map(s=>s.status),['accepted','rejected']);
  assert.deepEqual(result.contradictions[0]!.sides.map(s=>s.application),[reference(p.applied!.applications[0]!),reference(p.applied!.applications[0]!)]);
  assert.equal(proveAppliedAttemptClassification(f.open(),p.claims[1]!).status,'rejected');
  assert.equal(proveClaimAddress(f.open(),p.claims[0]!).kind,'attempt');
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
});

test('6.2-D: paid classification without application cannot produce accepted, rejected or unassessed',async t=>{
  const f=await setup(t),p=await pair(f,{apply:false});
  for(const status of ['accepted','rejected','unassessed'] as const) {
    const sides=[side(p.claims[status==='rejected'?1:0]!,status,status==='unassessed'?null:p.refs[0]!),
      side(p.claims[status==='rejected'?0:1]!,'unassessed',null)];
    const m=save(f,snapshot(f,p.claims,[contradiction(sides)]));
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}));
  }
});

test('6.2-D: the explicit snapshot set is required; [] differs from classified sets for the same manifest',async t=>{
  const f=await setup(t),p=await pair(f);
  const m=save(f,snapshot(f,p.claims,[contradiction(p.claims.map(c=>side(c,'unassessed',null)))]));
  refused(()=>readDossierContradictionsAt(f.open(),'p',m,undefined as never),'grounds');
  for(const input of [{},{assessments:null},{assessments:new Array(1)},{assessments:[p.refs[0],p.refs[0]]},{assessments:[f.v.planAnswer]},
    {assessments:[{...p.refs[0]!,hash:'0'.repeat(64)}]},{assessments:['not-a-ref']}])
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,input as never));
  for(const damage of [{projectId:'another-project'},{contract:'unknown-assessment-version'}]) {
    const forged=f.store.write({id:`forged-assessment:${hashJson(damage)}`,kind:'discovery-assessment',expected:0,value:{...p.paid.value,...damage}});
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:[reference(forged)]}),'grounds.assessments.0');
  }
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:[]}).assessments,[]);
  refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}),'contradictions.0.sides.0.status');
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:[]}).assessments,[],'proof must not cache by manifest alone');
  for(const [i,value] of [null,{}, {projectId:'p',question:null}].entries()) {
    const malformed=f.store.write({id:`malformed-historical:${i}`,kind:'research-assessment',expected:0,value});
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:[reference(malformed)]}));
  }
  const oldAnswer=f.store.get<any>(f.v.frameRef.id,f.v.frameRef.revision)!;
  const historicRef=oldAnswer.value.assessment as Ref;
  const own=readDossierContradictionsAt(f.open(),'p',m,{assessments:[historicRef]});
  assert.deepEqual(own.assessments,[historicRef],'a historical answer assessment keeps its own contract, without attempt v3 requirements');
  assert.deepEqual(own.contradictions[0]!.sides.map(s=>s.status),['unassessed','unassessed']);

});

test('6.2-D: late favorable paid assessment cannot rename the exact first applied rejection',async t=>{
  const f=await setup(t),p=await pair(f),later=await assess(f,[p.a,p.b],{accept:true,requirements:true});
  const refs=[...p.refs,reference(later.paid)];
  const original=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const m=save(f,snapshot(f,p.claims,[contradiction(original)]));
  assert.equal(readDossierContradictionsAt(f.open(),'p',m,{assessments:refs}).contradictions[0]!.sides[1].status,'rejected');
  const changed=structuredClone(original);changed[1]=side(p.claims[1]!,'accepted',reference(later.paid));
  const renamed=save(f,snapshot(f,p.claims,[contradiction(changed)]));
  refused(()=>readDossierContradictionsAt(f.open(),'p',renamed,{assessments:refs}),'contradictions.0.sides.1.assessment');
  const unrelatedResolution=save(f,snapshot(f,p.claims,[contradiction(original,{state:'side',holds:0,
    reason:'A later favorable assessment is not the applied ground',grounds:[reference(later.paid)]})]));
  refused(()=>readDossierContradictionsAt(f.open(),'p',unrelatedResolution,{assessments:refs}),'contradictions.0.resolution.grounds.0');
  const unassessed=save(f,snapshot(f,p.claims,[contradiction(p.claims.map(c=>side(c,'unassessed',null)))]));
  assert.equal(readDossierContradictionsAt(f.open(),'p',unassessed,{assessments:[]}).contradictions[0]!.sides[1].status,'unassessed',
    'a later assessment outside the fixed set does not reinterpret it');
  refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:[reference(later.paid)]}),'contradictions.0.sides.0.assessment');
});

test('6.2-D: full claim address, original assessment and declared status cannot be substituted',async t=>{
  const f=await setup(t),p=await pair(f);
  const value=snapshot(f,p.claims,[contradiction([side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)])]);
  for(const damage of [
    (v:DossierManifest)=>{v.contradictions[0]!.sides[0].status='rejected';},
    (v:DossierManifest)=>{v.contradictions[0]!.sides[1].status='accepted';},
    (v:DossierManifest)=>{v.contradictions[0]!.sides[0].assessment=f.v.planAnswer;},
    (v:DossierManifest)=>{v.axes.industry.claims[0]!.claimId='other';v.contradictions[0]!.sides[0].claim.claimId='other';},
    (v:DossierManifest)=>{v.axes.industry.claims[0]!.containerKind='research-answer';v.contradictions[0]!.sides[0].claim.containerKind='research-answer';},
    (v:DossierManifest)=>{v.contradictions[0]!.planQuestionIds=['absent'];},
    (v:DossierManifest)=>{v.frame={...f.v.frameRef,revision:2};},
    (v:DossierManifest)=>{v.plan=f.v.frameRef;},
    (v:DossierManifest)=>{v.draft={...v.draft,hash:'0'.repeat(64)};}
  ]) {
    const v=structuredClone(value);damage(v);const m=save(f,v);
    refused(()=>readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}));
  }
});

test('6.2-D: refutedBy preserves directed [refuter,target], rejected counterargument and explicit-link completeness',async t=>{
  const f=await setup(t),p=await pair(f,{link:'refutedBy'});
  const sides=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const v=snapshot(f,p.claims,[contradiction(sides,{state:'open'},'refutes')]);
  const m=save(f,v),proof=readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs});
  assert.equal(proof.contradictions[0]!.sides[1].status,'rejected');
  for(const mode of ['omitted','reversed','lost-target'] as const) {
    const changed=structuredClone(v);
    if(mode==='omitted')changed.contradictions=[];
    else if(mode==='reversed')changed.contradictions[0]!.sides.reverse();
    else {changed.axes.industry.claims=[p.claims[1]!];changed.contradictions=[];}
    const ref=save(f,changed);refused(()=>readDossierContradictionsAt(f.open(),'p',ref,{assessments:p.refs}));
  }
});

test('6.2-D: contradicts is symmetric, exact links are mandatory even with no classified sides',async t=>{
  const f=await setup(t),p=await pair(f,{link:'contradicts'});
  const sides=p.claims.map(c=>side(c,'unassessed',null)).reverse();
  const v=snapshot(f,p.claims,[contradiction(sides)]),m=save(f,v);
  assert.equal(readDossierContradictionsAt(f.open(),'p',m,{assessments:[]}).contradictions.length,1);
  const omitted=save(f,{...v,contradictions:[]});refused(()=>readDossierContradictionsAt(f.open(),'p',omitted,{assessments:[]}));
});

test('6.2-D: scoped resolution uses proven grounds for both sides, never declares a winner from a region',async t=>{
  const f=await setup(t),p=await pair(f,{both:true,scoped:true});
  const sides=p.claims.map(c=>side(c,'accepted',p.refs[0]!));
  const resolution:DossierResolution={state:'scoped',dimension:'region',reason:'Independent applied claims concern North and South',grounds:p.refs};
  const v=snapshot(f,p.claims,[contradiction(sides,resolution)]),m=save(f,v);
  const proof=readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs});
  assert.deepEqual(proof.contradictions[0]!.sides.map(s=>s.status),['accepted','accepted']);
  assert.equal('holds' in proof.contradictions[0]!.contradiction.resolution,false);
  for(const dimension of ['apiVersion','asOf'] as const) {
    const changed=structuredClone(v);(changed.contradictions[0]!.resolution as any).dimension=dimension;
    refused(()=>readDossierContradictionsAt(f.open(),'p',save(f,changed),{assessments:p.refs}),'contradictions.0.resolution.dimension');
  }
});

test('6.2-D: arbitrary, unrelated, missing or changed resolution refs do not become grounds',async t=>{
  const f=await setup(t),p=await pair(f);
  const sides=[side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)];
  const resolve=(grounds:Ref[])=>save(f,snapshot(f,p.claims,[contradiction(sides,{state:'side',holds:0,reason:'A stands on a proven origin',grounds})]));
  assert.equal(readDossierContradictionsAt(f.open(),'p',resolve([p.claims[0]!.container]),{assessments:p.refs}).contradictions.length,1);
  for(const ground of [f.v.frameRef,f.v.planAnswer,p.claims[1]!.container,
    {...p.refs[0]!,hash:'0'.repeat(64)},{id:'absent',revision:1,hash:hashJson('absent')}])
    refused(()=>readDossierContradictionsAt(f.open(),'p',resolve([ground]),{assessments:p.refs}));
});

test('6.2-D: cold exact proof survives damaged later heads; losing pinned grounds refuses without writes or spend',async t=>{
  const f=await setup(t),p=await pair(f),v=snapshot(f,p.claims,[contradiction([
    side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)])]),m=save(f,v);
  const original=readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs});
  const account=f.store.list('v7-attempt-account')[0]!,turn=f.store.list('research-turn')[0]!;
  for(const row of [account,turn,p.paid])f.store.write({id:row.id,kind:row.kind,expected:row.revision,value:{broken:true}});
  const before=f.store.list(),wires=f.wires().length;
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}),original);
  const lost=f.open(),get=lost.get.bind(lost);
  lost.get=((id:string,rev?:number)=>id===p.paid.id&&rev===p.paid.revision?null:get(id,rev)) as typeof lost.get;
  refused(()=>readDossierContradictionsAt(lost,'p',m,{assessments:p.refs}));
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
  assert.equal(readDossierManifestStructural(f.open(),'p',m).verification,'structural');
});


test('6.2-D: applied v2 classifications keep their own contract beside v3',async t=>{
  const f=await setup(t),p=await pair(f,{requirements:false});
  assert.equal(p.paid.value.contract,'discovery-assessment/v2');
  const m=save(f,snapshot(f,p.claims,[contradiction([
    side(p.claims[0]!,'accepted',p.refs[0]!),side(p.claims[1]!,'rejected',p.refs[0]!)])]));
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,{assessments:p.refs}).contradictions[0]!.sides.map(s=>s.status),['accepted','rejected']);
});


test('6.2-D-01: historical grounds retain exact draft membership after corrupt later heads, including another draft',async t=>{
  const f=await setup(t),other=acceptPlan(f,'p',[planQuestion('other-question','industry')]);
  const m=save(f,snapshot(f,[],[]));
  const answers=[f.v.frameRef,other.frameRef];
  const grounds={assessments:answers.map(a=>f.store.get<any>(a.id,a.revision)!.value.assessment as Ref)};
  const before=readDossierContradictionsAt(f.open(),'p',m,grounds);
  for(const draft of [f.v.draft,other.draft]) {
    const head=f.store.get<DiscoveryDraft>(draft.id)!;
    f.store.write({id:head.id,kind:head.kind,expected:head.revision,value:{...head.value,questions:[]}});
  }
  const frame=f.store.get<any>(f.v.frameRef.id,f.v.frameRef.revision)!;
  const q=f.store.get<any>(frame.value.question)!;
  const actId=discoveryAcceptanceActId('p',f.v.draft.id,q.value.spec.field,f.v.frameRef);
  const act=f.store.get<DiscoveryAcceptanceAct>(actId,1)!;
  f.store.write({id:act.id,kind:act.kind,expected:act.revision,value:{broken:true}});
  const records=f.store.list(),calls=f.wires().length;
  assert.equal(readDossierManifestStructural(f.open(),'p',m).verification,'structural');
  assert.deepEqual(readDossierContradictionsAt(f.open(),'p',m,grounds),before);
  assert.deepEqual(f.store.list(),records);assert.equal(f.wires().length,calls);
  for(const mode of ['missing-draft','substituted-draft','missing-act'] as const) {
    const cold=f.open(),get=cold.get.bind(cold),link=act.value.draftBefore;
    cold.get=((id:string,revision?:number)=>{
      if(mode==='missing-act' && id===act.id && revision===1)return null;
      if(id===link.id && revision===link.revision) {
        if(mode==='missing-draft')return null;
        if(mode==='substituted-draft')return {...get(id,revision)!,hash:hashJson('substituted')};
      }
      return get(id,revision);
    }) as typeof cold.get;
    refused(()=>readDossierContradictionsAt(cold,'p',m,grounds));
  }
  assert.deepEqual(f.store.list(),records);assert.equal(f.wires().length,calls);
});


test('6.2-D-02: a real paid legacy assessment keeps its own draft issuance outside the v7 dossier',async t=>{
  const f=await setup(t);
  const legacy=f.discovery.create('p','discovery','R0','concept',[
    {field:'probe',kind:'fact',prompt:'Historical question',risk:'unknown',schema:{type:'object'}}],[],4);
  const question=f.store.get<Question>(legacy.value.questions[0]!)!;
  const source=f.discovery.evidence.document('p','legacy-source','Actual old basis','text/plain',0);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{verdict:'supported',reasons:[]}}));
  const paid=await assessAnswer(f.store,question,{action:'answer',question:question.id,value:{historical:'supported'},
    citations:[{source:reference(source),selector:{kind:'text-range',start:0,end:source.value.content.length}}]},f.environment,f.root);
  f.discovery.researched(question.id,question.revision,reference(paid));
  const answerRef=f.store.get<Question>(question.id)!.value.answer!;
  assert.notEqual(legacy.id,f.v.draft.id);assert.equal(legacy.value.contractVersion,4);
  assert.equal(f.store.get(discoveryAcceptanceActId('p',legacy.id,'probe',answerRef)),null);
  const m=save(f,snapshot(f,[],[])),grounds={assessments:[reference(paid)]};
  const before=readDossierContradictionsAt(f.open(),'p',m,grounds);
  assert.deepEqual(before.assessments,grounds.assessments);
  for(const id of [legacy.id,question.id,answerRef.id,paid.id]) {
    const head=f.store.get<any>(id)!;
    f.store.write({id,kind:head.kind,expected:head.revision,value:id===legacy.id?{...head.value,questions:[]}:{broken:true}});
  }
  const records=f.store.list(),calls=f.wires().length,cold=f.open(),get=cold.get.bind(cold);
  const legacyIds=new Set([legacy.id,question.id,answerRef.id,paid.id]);
  cold.get=((id:string,revision?:number)=>{
    if(legacyIds.has(id))assert.notEqual(revision,undefined,'Historical legacy proof must not read a current head');
    return get(id,revision);
  }) as typeof cold.get;
  assert.deepEqual(readDossierContradictionsAt(cold,'p',m,grounds),before);
  for(const mode of ['missing-draft','substituted-draft','missing-question'] as const) {
    const lost=f.open(),read=lost.get.bind(lost);
    lost.get=((id:string,revision?:number)=>{
      if(mode==='missing-question' && id===question.id && revision===question.revision)return null;
      if(id===legacy.id && revision===legacy.revision) {
        if(mode==='missing-draft')return null;
        if(mode==='substituted-draft')return {...read(id,revision)!,hash:hashJson('substituted legacy issuance')};
      }
      return read(id,revision);
    }) as typeof lost.get;
    refused(()=>readDossierContradictionsAt(lost,'p',m,grounds));
  }
  assert.deepEqual(f.store.list(),records);assert.equal(f.wires().length,calls);
});
