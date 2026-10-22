import { hashJson } from '../src/canonical.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { Store, storeReads, storeBodyCache, observeStore, type StoreObserver } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { researchSetup, rand, hypothesis, produce, type Entry } from './discovery-v7-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, attemptAccountKey } from '../src/discovery/v7-attempt-assessment.js';

async function setup(t: test.TestContext) {
  const f = await researchSetup(t, { prefix: 'omg-p5-' }), { v, project, environment, subject, prompt } = f;
  let runId: string | undefined;
  const prepare=(selected=subject())=>{
    const context={history:[],readings:[]};
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=()=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  return {...f,prepare};
}

import { applyDiscoveryAssessment, readV7ProgressStateAt, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { proveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';

type Setup = Awaited<ReturnType<typeof setup>>;
async function assess(f: Setup, entries:Entry[], options:{baseline?:ReturnType<typeof v7ProgressBaseline>;
  accept?:boolean; requirements?:boolean}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:'q-industry',entries});
  const baseline=options.baseline??v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.accept?claims:[];
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:accepted.map(claim=>({claim,reason:'New basis'})),duplicates:[],
    noProgress:entries.filter(e=>!accepted.some(c=>c.container.id===e.attempt.id))
      .map(e=>({attempt:e.attempt,reason:'No new basis'})),transition:null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
const errorCode=(action:()=>unknown,code:string)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);

const snapshot=(store:Store)=>store.list().flatMap(row=>store.history(row.id));
function replay(f:Setup,a:Awaited<ReturnType<typeof assess>>,db:Store) {
  return (a.paid.value.contract==='discovery-assessment/v3'?assessAttemptsWithRequirements:assessAttempts)(
    db,a.packet,a.baseline,f.environment,f.root);
}

for(const requirements of [false,true]) {
  test(`P.5: paid ${requirements?'v3':'v2'} replay stays free across actual absent→state and state→next`,async t=>{
    const f=await setup(t),one=await produce(f,hypothesis(f,'First accepted basis')),
      a=await assess(f,[one],{accept:true,requirements});
    assert.equal(a.baseline.state.kind,'absent');
    const first=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
    let records=snapshot(f.store),sent=f.wires().length;
    assert.deepEqual(await replay(f,a,f.open()),a.paid);
    assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
    const two=await produce(f,hypothesis(f,'Second accepted basis')),
      b=await assess(f,[two],{accept:true,requirements});
    assert.deepEqual(b.baseline.state,{kind:'state',ref:reference(first.state)});
    const second=applyDiscoveryAssessment(f.store,'p',reference(b.paid));
    assert.equal(second.state.revision,first.state.revision+1);
    assert.equal(second.state.value.summary.count,2);
    records=snapshot(f.store);sent=f.wires().length;
    for(const saved of [a,b]) {
      assert.deepEqual(await replay(f,saved,f.open()),saved.paid);
      assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved.paid)),saved.paid);
      const repeated=applyDiscoveryAssessment(f.open(),'p',reference(saved.paid));
      assert.equal(repeated.repeated,true);assert.deepEqual(repeated.state,second.state);
      assert.equal(repeated.applications.length,1);
      assert.deepEqual(repeated.applications[0]!.value.assessment,reference(saved.paid));
    }
    assert.deepEqual(readV7ProgressStateAt(f.open(),reference(first.state)),first.state);
    assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
  });
}

for(const initialState of [false,true]) {
  test(`P.5: stale ${initialState?'revision':'absent'} result reuses covered attempts and refuses fresh remainder atomically`,async t=>{
    const f=await setup(t);
    if(initialState) {
      const seed=await assess(f,[await produce(f)]);
      applyDiscoveryAssessment(f.store,'p',reference(seed.paid));
    }
    const entries=[await produce(f),await produce(f)],
      baseline=v7ProgressBaseline(f.store,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}),
      a=await assess(f,[entries[0]!],{baseline}),both=await assess(f,entries,{baseline});
    const applied=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),records=snapshot(f.store),sent=f.wires().length;
    assert.equal(applyDiscoveryAssessment(f.open(),'p',reference(a.paid)).repeated,true);
    for(let repeat=0;repeat<2;repeat++) {
      assert.throws(()=>applyDiscoveryAssessment(f.open(),'p',reference(both.paid)),(error:unknown)=>{
        assert.ok(error instanceof EngineError);assert.equal(error.code,'discovery_progress_stale');
        assert.equal((error.details as {field?:string})?.field,'baseline.state');return true;
      });
      assert.deepEqual(await replay(f,both,f.open()),both.paid);
    }
    assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
    assert.equal(f.store.get(attemptAccountKey(both.packet,entries[1]!.attempt),1),null);
    assert.deepEqual(readV7ProgressStateAt(f.open(),reference(applied.state)),applied.state);
  });
}

test('P.5: a stale fresh dispatch refuses before payment while the exact paid packet still replays',async t=>{
  const f=await setup(t),a=await assess(f,[await produce(f)],{requirements:true});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const next=await produce(f),packet=projectAttemptPacket(f.store,{...a.packet,entries:[next]}),sent=f.wires().length;
  const protectedHistory=()=>['model-call','research-budget-ledger','assessment-session','assessment-application',
    'discovery-assessment','v7-progress-state','v7-progress-application','v7-attempt-account','research-progress-event']
    .flatMap(kind=>f.store.list(kind).flatMap(row=>f.store.history(row.id)));
  const before=protectedHistory();
  await assert.rejects(assessAttemptsWithRequirements(f.open(),packet,a.baseline,f.environment,f.root),{code:'input_stale'});
  assert.deepEqual(protectedHistory(),before);assert.equal(f.wires().length,sent);
  const afterRefusal=snapshot(f.store);
  assert.deepEqual(await replay(f,a,f.open()),a.paid);
  assert.deepEqual(snapshot(f.store),afterRefusal);
});

test('P.5: paid replay, stale apply and exact accepted proof read no additional unrelated records',async t=>{
  const f=await setup(t),entries=[await produce(f,hypothesis(f,'Covered claim')),await produce(f)],
    a=await assess(f,[entries[0]!],{accept:true}),both=await assess(f,entries,{accept:true,baseline:a.baseline});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  type Cost={calls:number;rows:number;bodies:number;foreign:string[]};
  const measure=async(db:Store,scan=false)=>{
    const costs:Cost[]=[],actions=[
      async()=>assert.deepEqual(await replay(f,a,db),a.paid),
      ()=>assert.equal(applyDiscoveryAssessment(db,'p',reference(a.paid)).repeated,true),
      ()=>errorCode(()=>applyDiscoveryAssessment(db,'p',reference(both.paid)),'discovery_progress_stale'),
      ()=>proveClaimAddress(db,a.claims[0]!)];
    for(const action of actions) {
      const beforeCalls=storeReads(),beforeBodies=storeBodyCache().parses;
      let rows=0,previous:StoreObserver|null=null;
      const foreign=new Set<string>();
      // Keep the historical proof observer and its own begin/end tokens intact.
      // Count identities as well as materialized records: one list/history call
      // may select arbitrarily many rows even when calls stays constant.
      previous=observeStore({
        begin(source) { return {previous:previous?.begin(source)}; },
        end(token,source,method,mode,id,revision,selected) {
          if(source===db) {
            rows+=selected.length;
            for(const row of selected) if(row.id.startsWith('unrelated:')) foreign.add(row.id);
          }
          const delegated=(token as {previous?:object}).previous;
          if(delegated) previous?.end(delegated,source,method,mode,id,revision,selected);
        },
        write(source) { previous?.write(source); },
        untraced() { previous?.untraced(); }
      });
      try {
        if(scan) db.list('discovery-assessment'); // Deliberate full-scan control.
        await action();
      } finally { observeStore(previous); }
      costs.push({calls:storeReads()-beforeCalls,rows,bodies:storeBodyCache().parses-beforeBodies,
        foreign:[...foreign].sort()});
    }
    return costs;
  };
  // Identical database images give each measurement the same cold cache;
  // measuring successive connections to one DB would warm persisted proofs.
  const image=await f.store.snapshot(join(f.root,'measurement-image')),sent=f.wires().length;
  const assertUnchanged=(measured:Cost[],baseline:Cost[])=>{
    assert.deepEqual(measured,baseline,'calls, selected rows and decoded bodies stay independent of unrelated history');
    for(const cost of measured) assert.deepEqual(cost.foreign,[],'No unrelated row may be selected');
  };
  let baseline:Cost[]|undefined,scanBaseline:Cost[]|undefined;
  for(const size of [0,10,100]) for(const scan of [false,true]) {
    const path=join(f.root,`measurement-${size}-${scan}.sqlite`);copyFileSync(image.path,path);
    const db=new Store(path);
    try {
      // Explicit irrelevant negative records, including tempting same-kind heads:
      // none is a real paid/accepted record or may be selected by these exact APIs.
      db.writeMany(Array.from({length:size},(_,i)=>({id:`unrelated:${size}:${i}`,expected:0,
        kind:['research-turn','discovery-assessment','v7-attempt-account','v7-progress-state','research-progress-event'][i%5]!,
        value:{projectId:i%2?'p':'foreign',planQuestionId:'unrelated',invalid:true,i}})),[]);
      const measured=await measure(db,scan);
      if(!scan) {
        if(baseline) assertUnchanged(measured,baseline);
        else { baseline=measured;assert.ok(measured.every(cost=>cost.calls>0&&cost.rows>0&&cost.bodies>0)); }
      } else if(!scanBaseline) scanBaseline=measured;
      else {
        // The former call-only criterion passes this bad implementation.
        assert.deepEqual(measured.map(cost=>cost.calls),scanBaseline.map(cost=>cost.calls));
        for(const [index,cost] of measured.entries()) {
          assert.ok(cost.rows>scanBaseline[index]!.rows);
          assert.ok(cost.bodies>scanBaseline[index]!.bodies);
          assert.equal(cost.foreign.length,size/5);
          assert.throws(()=>assertUnchanged([cost],[scanBaseline![index]!]),assert.AssertionError);
        }
      }
    } finally { db.close(); }
  }
  t.diagnostic(`cold costs (calls/rows/bodies): ${baseline!.map(cost=>`${cost.calls}/${cost.rows}/${cost.bodies}`).join(' | ')}; unrelated +10/+100 = +0; full-list controls refused for all four operations`);
  assert.equal(f.wires().length,sent);
});

test('P.5: replay never substitutes a missing exact baseline with a later valid head',async t=>{
  const f=await setup(t),a=await assess(f,[await produce(f)]),first=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),
    b=await assess(f,[await produce(f)]),second=applyDiscoveryAssessment(f.store,'p',reference(b.paid));
  const sent=f.wires().length;
  // Explicit negative read boundary: only the pinned predecessor is absent;
  // its newer valid head remains available and must never substitute for it.
  const cold=f.open(),get=cold.get.bind(cold);
  cold.get=((...args:Parameters<Store['get']>)=>args[0]===first.state.id&&args[1]===first.state.revision
    ?null:get(...args)) as Store['get'];
  const records=snapshot(f.store);
  await assert.rejects(replay(f,b,cold),{code:'discovery_assessment_subject_invalid'});
  assert.throws(()=>applyDiscoveryAssessment(cold,'p',reference(b.paid)),(error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,'research_context_application_invalid');
    assert.match(error.message,/Physical outcome is not proved: discovery_assessment_subject_invalid/);return true;
  });
  assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
  assert.equal(f.store.get(second.state.id)!.revision,second.state.revision);
});
