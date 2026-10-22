import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { type Json } from '../src/canonical.js';
import { researchSetup, rand, hypothesis, produce, type Entry } from './discovery-v7-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, attemptAccountKey, claimContentKey } from '../src/discovery/v7-attempt-assessment.js';

async function setup(t: test.TestContext) {
  const f = await researchSetup(t), { v, project, environment, subject, prompt } = f;
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

import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { proveClaimAddress, resolveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';

type Setup = Awaited<ReturnType<typeof setup>>;
async function assess(f: Setup, entries:Entry[], options:{baseline?:ReturnType<typeof v7ProgressBaseline>;
  accept?:boolean; selected?:number[]; requirements?:boolean; question?:string; transition?:unknown; duplicates?:boolean; reverse?:boolean; methodology?:(claims:ClaimAddress[])=>unknown}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:options.question??'q-industry',entries});
  const baseline=options.baseline??v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.selected ? claims.filter((_,i)=>options.selected!.includes(i))
    :options.accept?(options.reverse?[...claims].reverse():claims):[];
  const newClaims=options.duplicates?accepted.slice(0,1):accepted;
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:newClaims.map(claim=>({claim,reason:'New basis'})),
    duplicates:options.duplicates?accepted.slice(1).map(claim=>({claim,of:accepted[0]!,reason:'Same content'})):[],
    noProgress:entries.filter(e=>!newClaims.some(c=>c.container.id===e.attempt.id)
      && !(options.transition as any)?.bases?.some((b:any)=>b.constraint?.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No new basis'})),
    transition:options.transition??null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:options.methodology?.(claims)??{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
const errorCode=(action:()=>unknown,code:string)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);

function inference(f: Setup, premise: ClaimAddress) {
  return {type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'deduction',kind:'inference',
    text:'Deduction from the saved premise',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
    scope:{variants:'common'},basis:{from:[premise],reasoning:'The named basis entails this deduction'}}]}};
}

test('P.4: paid accepted annotation without atomic application is not acceptance',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Not yet applied')),a=await assess(f,[entry],{accept:true});
  assert.equal(resolveClaimAddress(f.open(),a.claims[0]!).container.id,entry.attempt.id);
  const before=f.store.list(),wires=f.wires().length;
  assert.throws(()=>proveClaimAddress(f.open(),a.claims[0]!), (error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,'claim_attempt_not_accepted');
    assert.deepEqual(error.details,{address:a.claims[0]!});return true;
  });
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
});

test('P.4: applied rejection never accepts a resolvable claim',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Rejected')),a=await assess(f,[entry]);
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  assert.equal(resolveClaimAddress(f.open(),a.claims[0]!).container.id,entry.attempt.id);
  errorCode(()=>proveClaimAddress(f.open(),a.claims[0]!),'claim_attempt_not_accepted');
});

test('P.4: acceptance belongs to the exact pointer, not the whole attempt',async t=>{
  const f=await setup(t),end=hypothesis(f,'Rejected first');
  end.value.claims.push({...end.value.claims[0]!,id:'second',text:'Accepted second'});
  const entry=await produce(f,end),a=await assess(f,[entry],{selected:[1]});
  const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  errorCode(()=>proveClaimAddress(f.open(),a.claims[0]!),'claim_attempt_not_accepted');
  errorCode(()=>proveClaimAddress(f.open(),{...a.claims[1]!,pointer:'/claims/0'}),'claim_address_invalid');
  const proof=proveClaimAddress(f.open(),a.claims[1]!);assert.ok(proof.kind==='attempt');
  assert.deepEqual(proof.container,f.store.get(entry.attempt.id,entry.attempt.revision));
  assert.equal((proof.claim as Record<string,Json>).id,'second');
  assert.deepEqual(proof.assessment,a.paid);assert.deepEqual(proof.application,result.applications[0]);
  assert.equal(proof.answer,null);assert.equal(proof.binding,null);
});

test('P.4: accepted duplicate has its own proof and adds no content event',async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'Same content')),second=await produce(f,hypothesis(f,'Same content'));
  const a=await assess(f,[first,second],{accept:true,duplicates:true}),result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  assert.equal(result.state.value.summary.count,2);assert.equal(f.store.list('research-progress-event').length,1);
  assert.equal(f.store.list('v7-attempt-account').length,2);
  assert.equal(claimContentKey(f.open(),a.claims[0]!),claimContentKey(f.open(),a.claims[1]!));
  const before=f.store.list(),wires=f.wires().length;
  for(const claim of a.claims) {
    const proof=proveClaimAddress(f.open(),claim);assert.ok(proof.kind==='attempt');
    assert.deepEqual(proof.application,result.applications[0]);assert.deepEqual(proof.assessment,a.paid);
  }
  assert.equal(applyDiscoveryAssessment(f.open(),'p',reference(a.paid)).repeated,true);
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
});

test('P.4: common inference key proves the original accepted attempt premise',async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'Accepted premise')),a=await assess(f,[first],{accept:true});
  const one=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),second=await produce(f,inference(f,a.claims[0]!));
  const b=await assess(f,[second],{accept:true}),key=claimContentKey(f.open(),b.claims[0]!);
  const two=applyDiscoveryAssessment(f.store,'p',reference(b.paid));
  const premise=proveClaimAddress(f.open(),a.claims[0]!),deduction=proveClaimAddress(f.open(),b.claims[0]!);
  assert.ok(premise.kind==='attempt'&&deduction.kind==='attempt');
  assert.deepEqual(premise.application,one.applications[0]);assert.deepEqual(premise.assessment,a.paid);
  assert.deepEqual(deduction.application,two.applications[0]);assert.deepEqual(deduction.assessment,b.paid);
  assert.equal(claimContentKey(f.open(),b.claims[0]!),key);
});

for(const applied of [false,true]) test(`P.4: inference refuses an unaccepted premise; rejected applied=${applied}`,async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'Unaccepted premise')),a=await assess(f,[first],{accept:!applied});
  if(applied)applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const next=await produce(f,inference(f,a.claims[0]!));
  const claim:ClaimAddress={project:'p',container:next.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'deduction'};
  errorCode(()=>claimContentKey(f.open(),claim),'claim_attempt_not_accepted');
  errorCode(()=>proveClaimAddress(f.open(),claim),'claim_attempt_not_accepted');
});

test('P.4: missing, foreign and substituted address parts refuse without fallback',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Exact address')),a=await assess(f,[entry],{accept:true});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));const valid=a.claims[0]!;
  const mutations:Record<string,unknown>[]=['project','container','containerKind','pointer','claimId'].map(key=>{
    const value:Record<string,unknown>={...valid};delete value[key];return value;
  });
  mutations.push({...valid,project:'foreign'},{...valid,container:{...valid.container,hash:'0'.repeat(64)}},
    {...valid,container:{...valid.container,revision:2}},{...valid,pointer:'/claims/1'},
    {...valid,pointer:'/claims/00'},{...valid,claimId:'foreign'},{...valid,containerKind:'research-answer'});
  for(const address of mutations) errorCode(()=>proveClaimAddress(f.open(),address as unknown as ClaimAddress),'claim_address_invalid');
  assert.equal(proveClaimAddress(f.open(),valid).container.id,entry.attempt.id);
});

for(const deterministic of [false,true]) test(`P.4: copied account cannot accept another attempt; deterministic=${deterministic}`,async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'First')),a=await assess(f,[first],{accept:true});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const old=f.store.list<any>('v7-attempt-account')[0]!,next=await produce(f,hypothesis(f,'Unapplied second')),b=await assess(f,[next],{accept:true});
  // Explicit negative corruption: copy another application's account, changing only its claimed attempt and accepted pointer.
  const id=deterministic?attemptAccountKey(b.packet,next.attempt):'v7-attempt-account:negative-foreign-address';
  f.store.write({id,kind:'v7-attempt-account',expected:0,value:{...old.value,attempt:next.attempt,accepted:b.claims}});
  errorCode(()=>proveClaimAddress(f.open(),b.claims[0]!),deterministic?'discovery_progress_conflict':'claim_attempt_not_accepted');
  assert.equal(proveClaimAddress(f.open(),a.claims[0]!).container.id,first.attempt.id);
});

test('P.4: accepted exact claim survives a later corrupt attempt head',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Historical claim')),a=await assess(f,[entry],{accept:true});
  const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),original=f.store.get<any>(entry.attempt.id,entry.attempt.revision)!;
  // Explicit negative corruption of a later revision; the original remains fixed by its Ref.
  const corrupt=f.store.write({id:original.id,kind:original.kind,expected:original.revision,value:{...original.value,contract:'negative/corrupt'}});
  errorCode(()=>proveClaimAddress(f.open(),{...a.claims[0]!,container:reference(corrupt)}),'claim_address_invalid');
  const proof=proveClaimAddress(f.open(),a.claims[0]!);assert.ok(proof.kind==='attempt');
  assert.deepEqual(proof.container,original);assert.deepEqual(proof.application,result.applications[0]);assert.deepEqual(proof.assessment,a.paid);
});

for(const kind of ['v7-progress-application','v7-progress-state','research-progress-event','v7-attempt-account'])
  test(`P.4: public proof refuses a missing atomic ${kind}`,async t=>{
    const f=await setup(t),entry=await produce(f,hypothesis(f,'Atomic proof')),a=await assess(f,[entry],{accept:true});
    applyDiscoveryAssessment(f.store,'p',reference(a.paid));const selected=f.store.list(kind)[0]!,cold=f.open(),get=cold.get.bind(cold);
    cold.get=((...args:Parameters<Store['get']>)=>args[0]===selected.id&&(args[1]===undefined||args[1]===selected.revision)
      ?null:get(...args)) as Store['get'];
    errorCode(()=>proveClaimAddress(cold,a.claims[0]!),kind==='v7-attempt-account'?'claim_attempt_not_accepted':'discovery_progress_conflict');
  });
