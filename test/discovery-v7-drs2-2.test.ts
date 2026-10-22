import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, digest, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, observeStore, storeEvents, storeReads, type StoreObserver } from '../src/storage/store.js';
import { readDiscoveryIndexAt, discoveryTraversal, type DiscoveryDraft, type Question, type ResearchRun,
  type DiscoveryIndexRead } from '../src/discovery/projection-reader.js';
import { buildDiscoveryIndexAt, discoveryIndexCursor } from '../src/discovery/discovery-index.js';
import { researchSetup, produce, hypothesis, rand, acceptPlan, planQuestion, validPlan, type Entry } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';

async function setup(t:test.TestContext) {
  const f=await researchSetup(t,{prefix:'omg-drs22-',sourceKey:'per-draft'});
  let runId:string|undefined;
  const prepare=(selected=f.subject())=>{
    const context={history:[],readings:[]},draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!,question=f.store.get<Question>(f.v.plan.id)!;
    const run=runId?f.store.get<ResearchRun>(runId)!:f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:'p',draftId:draft.id,environment:reference(f.environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id;const number=run.value.turns+1;
    const intent=prepareResearchConsumerIntent(f.store,{projectId:'p',kind:'analyst',key:hashJson([run.id,number,'analyst']),owner:reference(run),
      draft:reference(draft),question:reference(question),role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,
      cursor:{run:run.id,turn:number,instruction:f.prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(f.environment)])});
    const invoke=()=>researchCall(f.environment.value.implementer,f.environment.value,f.prompt,context,undefined,
      {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
    return {run,number,intent,question,context,selected,invoke};
  };
  return {...f,prepare};
}
type Setup=Awaited<ReturnType<typeof setup>>;
async function assessAndApply(f:Setup,entry:Entry) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'q-industry',entries:[entry]});
  const baseline=v7ProgressBaseline(f.store,packet);
  const claim={project:'p',container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const reply={verdict:'supported',reasons:['Exact packet'],return:null,novelty:{
    attempts:[{attempt:entry.attempt,reason:'Exact completed K'}],accepted:[{claim,reason:'Supported hypothesis'}],rejected:[],
    newContent:[{claim,reason:'New basis'}],duplicates:[],noProgress:[],transition:null},
    methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await assessAttempts(f.store,packet,baseline,f.environment,f.root);
  return {paid,...applyDiscoveryAssessment(f.store,'p',reference(paid))};
}
const snapshot=(s:Store)=>s.list().flatMap(row=>s.history(row.id));
const scopeKey=(s:Store,plan:Ref)=>digest(canonical({contract:'discovery-index/v1',databaseId:s.databaseId,project:'p',plan}));
const invalid=(action:()=>unknown)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code==='discovery_index_invalid');
function measured<T>(action:()=>T) {
  const methods:string[]=[],ids:string[]=[];let calls=0,rows=0,bodies=0,writes=0;
  const start=storeReads(),events=storeEvents();let previous:StoreObserver|null=null;
  previous=observeStore({
    begin(store){return {prior:previous?.begin(store)};},
    end(token,store,method,mode,id,revision,selected){
      const prior=(token as {prior?:object}).prior;
      if(prior)previous!.end(prior,store,method,mode,id,revision,selected);
      calls++;rows+=selected.length;bodies+=selected.filter(row=>Object.hasOwn(row,'value')).length;
      methods.push(mode);ids.push(...selected.map(row=>row.id));
    },
    write(store){writes++;previous?.write(store);},untraced(){previous?.untraced();}
  });
  try {
    const value=action(),after=storeEvents();
    return {value,calls,rows,bodies,writes,methods,ids,reads:storeReads()-start,ranges:after.ranges-events.ranges,rangeEvents:after.rangeEvents-events.rangeEvents};
  } finally {observeStore(previous);}
}
function bounded(sample:ReturnType<typeof measured>,normal?:ReturnType<typeof measured>) {
  assert.equal(sample.writes,0);assert.equal(sample.ranges,0);assert.equal(sample.rangeEvents,0);
  assert.equal(sample.ids.some(id=>id.startsWith('unrelated:')),false);
  assert.equal(sample.methods.some(mode=>mode!=='get'),false,'cold projection uses exact addressed reads');
  if(normal)assert.deepEqual([sample.calls,sample.rows,sample.bodies,sample.reads],[normal.calls,normal.rows,normal.bodies,normal.reads]);
}

test('DRS2.2 public boundary reads a genuine indexed K/paid assessment/P at the requested exact basis without changing R.3',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Proved basis')),applied=await assessAndApply(f,entry);
  const cursor=discoveryIndexCursor(f.store),projection=buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor);
  const grounds=[f.v.planAnswer,entry.attempt,reference(applied.paid),reference(applied.applications.at(-1)!),reference(applied.state)];
  const traversal=discoveryTraversal(f.store,f.v.draft),before=snapshot(f.store),wires=f.wires(),stamp=f.store.changeStamp();
  const sample=measured(()=>readDiscoveryIndexAt(f.open(),'p',f.v.planAnswer,cursor,{basis:grounds}));
  assert.equal(sample.value.status,'indexed');assert.equal(sample.value.reason,null);assert.deepEqual(sample.value.missingBasis,[]);
  assert.deepEqual(sample.value.basis,grounds);assert.deepEqual(sample.value.projection,projection);
  assert.equal(sample.value.projection!.coverage.complete,false);
  assert.equal(sample.value.projection!.coverage.reason,'deep-coverage-unavailable');
  assert.deepEqual(discoveryTraversal(f.store,f.v.draft),traversal);
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);assert.equal(f.store.changeStamp(),stamp);bounded(sample);
});

test('DRS2.2 absent, behind and empty-but-advanced indices stay explicitly incomplete; reading does not catch up',async t=>{
  const f=await setup(t),cursor=discoveryIndexCursor(f.store),before=snapshot(f.store),wires=f.wires();
  const absent=measured(()=>readDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{basis:[]}));
  assert.equal(absent.value.reason,'index_absent');assert.equal(absent.value.status,'incomplete');assert.equal(absent.value.projection,null);bounded(absent);
  const db=new DatabaseSync(f.path);assert.equal(db.prepare('SELECT count(*) AS n FROM event_index_scopes').get()!['n'],0);
  const partial=buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{maxEvents:1});
  const behind=measured(()=>readDiscoveryIndexAt(f.open(),'p',f.v.planAnswer,cursor,{basis:[f.v.planAnswer]}));
  assert.equal(behind.value.reason,'index_behind');assert.equal(behind.value.projection,null);
  assert.equal(behind.value.indexedThrough,partial.indexedThrough);bounded(behind);
  assert.equal(f.store.eventIndexRead(scopeKey(f.store,f.v.planAnswer),cursor.sequence)!.cursor,partial.indexedThrough);
  buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor);
  assert.equal(readDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{basis:[]}).status,'indexed');
  db.prepare('DELETE FROM event_index_rows WHERE scope_key=?').run(scopeKey(f.store,f.v.planAnswer));db.close();
  const empty=readDiscoveryIndexAt(f.open(),'p',f.v.planAnswer,cursor,{basis:[]});
  assert.equal(empty.status,'incomplete');assert.equal(empty.reason,'basis_missing');assert.equal(empty.projection,null);
  assert.ok(empty.missingBasis.some(at=>canonical(at)===canonical(f.v.planAnswer)));
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);
});

test('DRS2.2 each requested ground is checked anew; another basis cannot reuse a previous index read',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Indexed claim')),applied=await assessAndApply(f,entry);
  const cursor=discoveryIndexCursor(f.store);buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor);
  assert.equal(readDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{basis:[]}).status,'indexed');
  const db=new DatabaseSync(f.path),event=f.store.events(0,cursor.sequence).find(row=>row.id===entry.attempt.id&&row.revision===entry.attempt.revision)!;
  db.prepare('DELETE FROM event_index_rows WHERE scope_key=? AND sequence=?').run(scopeKey(f.store,f.v.planAnswer),event.sequence);db.close();
  const missing=readDiscoveryIndexAt(f.open(),'p',f.v.planAnswer,cursor,{basis:[entry.attempt]});
  assert.equal(missing.reason,'basis_missing');assert.equal(missing.projection,null);assert.deepEqual(missing.missingBasis,[entry.attempt]);
  assert.equal(readDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{basis:[reference(applied.state)]}).status,'indexed');
  for(const request of [undefined,{}, {basis:null},{basis:[null]},{basis:[entry.attempt,entry.attempt]},
    {basis:[{...entry.attempt,hash:'a'.repeat(64)}]},{basis:[{...entry.attempt,revision:1000}]}])
    invalid(()=>readDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,request as any));
});

test('DRS2.2 rejects foreign database/project/plan/cursor/basis and substituted index metadata',async t=>{
  const f=await setup(t),oldPlan=f.v.planAnswer,oldQuestion=f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(oldQuestion.id,oldQuestion.revision);
  const source=f.discovery.evidence.document('p','edition-two','New plan edition','text/plain',0);
  answerDiscoveryFixture(f.engine,'p',f.store.get<DiscoveryDraft>(f.v.draft.id)!,f.store.get<Question>(oldQuestion.id)!,
    validPlan(f.v.frameRef,[planQuestion('q-industry','industry','blocking'),planQuestion('q-market','market')],2,oldPlan),source);
  const otherPlan=f.store.get<Question>(oldQuestion.id)!.value.answer!;
  const foreign=acceptPlan(f,'other',[planQuestion('foreign','industry')],{sourceKey:'per-draft'});
  const cursor=discoveryIndexCursor(f.store);buildDiscoveryIndexAt(f.store,'p',oldPlan,cursor);
  const otherDb=new Store(join(f.root,'other.sqlite'));t.after(()=>otherDb.close());
  for(const bad of [undefined,{run:'r',number:1},{...cursor,databaseId:otherDb.databaseId},
    {...cursor,sequence:cursor.sequence+100000},{...cursor,tail:{...cursor.tail,hash:'b'.repeat(64)}}])
    invalid(()=>readDiscoveryIndexAt(f.store,'p',oldPlan,bad as any,{basis:[]}));
  invalid(()=>readDiscoveryIndexAt(otherDb,'p',oldPlan,cursor,{basis:[]}));
  invalid(()=>readDiscoveryIndexAt(f.store,'other',oldPlan,cursor,{basis:[]}));
  invalid(()=>readDiscoveryIndexAt(f.store,'p',{...oldPlan,hash:'c'.repeat(64)},cursor,{basis:[]}));
  for(const ref of [otherPlan,foreign.planAnswer])invalid(()=>readDiscoveryIndexAt(f.store,'p',oldPlan,cursor,{basis:[ref]}));
  const db=new DatabaseSync(f.path),key=scopeKey(f.store,oldPlan);
  db.prepare('UPDATE event_index_scopes SET scope=? WHERE key=?').run(canonical({project:'other'}),key);
  invalid(()=>readDiscoveryIndexAt(f.store,'p',oldPlan,cursor,{basis:[]}));db.close();
});

test('DRS2.2 historical requested basis survives late heads, a new cursor publication and cold reopen',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Historical basis')),applied=await assessAndApply(f,entry);
  const cursor=discoveryIndexCursor(f.store),basis=[entry.attempt,reference(applied.state)];
  buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor);
  const first=readDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{basis});
  for(const ref of [f.v.draft,f.v.plan]) {
    const row=f.store.get<any>(ref.id)!;
    f.store.write({id:row.id,kind:row.kind,expected:row.revision,value:{...row.value,...(row.kind==='question'?{answer:null,status:'open'}:{questions:[]})}});
  }
  f.store.write({id:'late-source',kind:'test',expected:0,value:{projectId:'p'}});
  const later=discoveryIndexCursor(f.store);buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,later);
  const before=snapshot(f.store),wires=f.wires();
  const cold=readDiscoveryIndexAt(f.open(),'p',f.v.planAnswer,cursor,{basis});
  assert.deepEqual(cold,first);assert.equal(cold.indexedThrough,cursor.sequence);
  const future=f.store.get('late-source')!;
  invalid(()=>readDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{basis:[reference(future)]}));
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);
});

test('DRS2.2 cold reads select no unrelated history at +0/+10/+100; the same metric rejects a full-list control',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Measured basis')),applied=await assessAndApply(f,entry);
  const basis=[entry.attempt,reference(applied.state)];
  buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,discoveryIndexCursor(f.store));
  let normal:ReturnType<typeof measured<DiscoveryIndexRead>>|undefined;
  for(const count of [0,10,100]) {
    const path=join(f.root,`copy-${count}.sqlite`),db=new DatabaseSync(f.path);
    db.prepare('VACUUM INTO ?').run(path);db.close();
    const writer=new Store(path);
    for(let i=0;i<count;i++)writer.write({id:`unrelated:${i}`,kind:'discovery-assessment',expected:0,
      value:{projectId:'other',payload:'Unrelated old assessment'}});
    const cursor=discoveryIndexCursor(writer);buildDiscoveryIndexAt(writer,'p',f.v.planAnswer,cursor);writer.close();
    const cold=new Store(path);t.after(()=>cold.close());
    const sample=measured(()=>readDiscoveryIndexAt(cold,'p',f.v.planAnswer,cursor,{basis}));
    assert.equal(sample.value.status,'indexed');bounded(sample,normal);normal??=sample;
    const control=measured(()=>{cold.list('discovery-assessment');return readDiscoveryIndexAt(cold,'p',f.v.planAnswer,cursor,{basis});});
    if(count) {
      assert.ok(control.rows>sample.rows);assert.ok(control.bodies>sample.bodies);
      assert.throws(()=>bounded(control,normal),'the actual no-scan criterion catches a full list');
    }
  }
});
