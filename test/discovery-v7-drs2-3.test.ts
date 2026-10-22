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
  type DiscoveryIndexCursor } from '../src/discovery/projection-reader.js';
import { buildDiscoveryIndexAt, discoveryIndexCursor } from '../src/discovery/discovery-index.js';
import { researchSetup, produce, hypothesis, rand, acceptPlan, planQuestion, validPlan, type Entry } from './discovery-v7-fixture.js';
import { stageSummary, renderStageSummary, type DiscoveryIndexSummaryRequest, type DiscoveryIndexStageSummary } from '../src/product/stage-summary.js';
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
  const f=await researchSetup(t,{prefix:'omg-drs23-',sourceKey:'per-draft'});
  f.engine.execute({type:'create-project',project:'p',title:'P'});
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
const invalid=(action:()=>unknown,code='discovery_index_invalid')=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);
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

const request=(plan:Ref,cursor:DiscoveryIndexCursor,basis:Ref[]):DiscoveryIndexSummaryRequest=>({section:'v7-index',plan,cursor,basis});
const summary=(f:Setup,req:DiscoveryIndexSummaryRequest,db=f.store)=>stageSummary(db,'p','discovery',req);

test('DRS2.3 stageSummary renders exact genuine K/MR/P and structural limitations without changing the previous summary or R.3',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Rendered paid basis')),applied=await assessAndApply(f,entry);
  const cursor=discoveryIndexCursor(f.store),basis=[f.v.planAnswer,entry.attempt,reference(applied.paid),reference(applied.applications.at(-1)!),reference(applied.state)];
  buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor);
  const req=request(f.v.planAnswer,cursor,basis),old=stageSummary(f.store,'p','discovery',f.v.draft.id),oldText=renderStageSummary(old);
  const traversal=discoveryTraversal(f.store,f.v.draft),before=snapshot(f.store),wires=f.wires(),stamp=f.store.changeStamp();
  const measuredRead=measured(()=>summary(f,req,f.open())),result=measuredRead.value,text=renderStageSummary(result);
  assert.equal(result.contract,'stage-summary/discovery-index/v1');assert.equal(result.stage,'discovery');assert.equal(result.project,'p');
  assert.deepEqual(result.index,readDiscoveryIndexAt(f.store,'p',req.plan,req.cursor,{basis}));
  assert.equal(result.index.status,'indexed');assert.deepEqual(result.index.basis,basis);
  assert.ok(result.index.projection!.sources.some(source=>canonical(reference(source.record))===canonical(reference(applied.paid))));
  assert.ok(result.index.projection!.claims.some(claim=>canonical(claim.address.container)===canonical(entry.attempt)));
  assert.ok(result.index.projection!.progress.some(progress=>canonical(progress.state)===canonical(reference(applied.state))));
  assert.equal(result.index.projection!.coverage.complete,false);
  for(const at of basis)assert.ok(text.includes(`${at.id}@${at.revision}#${at.hash}`));
  assert.ok(text.includes(cursor.databaseId));assert.ok(text.includes(`Граница событий: ${cursor.sequence}`));
  assert.match(text,/Claims \(структурные данные\)/);assert.match(text,/Применённый прогресс P/);
  assert.match(text,/Rendered paid basis/);assert.match(text,/deep-coverage-unavailable/);
  assert.match(text,/Индекс не устанавливает достаточность, отсутствие блокировок или принятие Discovery/);
  assert.equal(Object.hasOwn(result,'accepted'),false,'this section makes no unqueried stage acceptance statement');
  assert.deepEqual(stageSummary(f.store,'p','discovery',f.v.draft.id),old);assert.equal(renderStageSummary(old),oldText);
  assert.deepEqual(discoveryTraversal(f.store,f.v.draft),traversal);bounded(measuredRead);
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);assert.equal(f.store.changeStamp(),stamp);
});

test('DRS2.3 index_absent/index_behind/basis_missing remain visible and do not become empty success or catch-up',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Hidden until indexed')),applied=await assessAndApply(f,entry);
  const cursor=discoveryIndexCursor(f.store),req=request(f.v.planAnswer,cursor,[entry.attempt,reference(applied.state)]);
  const before=snapshot(f.store),wires=f.wires();
  const absent=measured(()=>summary(f,req));assert.equal(absent.value.index.status,'incomplete');
  assert.equal(absent.value.index.reason,'index_absent');assert.equal(absent.value.index.projection,null);bounded(absent);
  assert.match(renderStageSummary(absent.value),/Неполнота: index_absent/);
  const db=new DatabaseSync(f.path);assert.equal(db.prepare('SELECT count(*) AS n FROM event_index_scopes').get()!['n'],0);
  const partial=buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor,{maxEvents:1});
  const behind=summary(f,req,f.open());assert.equal(behind.index.reason,'index_behind');assert.equal(behind.index.projection,null);
  assert.equal(behind.index.indexedThrough,partial.indexedThrough);assert.match(renderStageSummary(behind),/Неполнота: index_behind/);
  assert.equal(f.store.eventIndexRead(scopeKey(f.store,f.v.planAnswer),cursor.sequence)!.cursor,partial.indexedThrough);
  buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor);
  const event=f.store.events(0,cursor.sequence).find(row=>row.id===entry.attempt.id&&row.revision===entry.attempt.revision)!;
  db.prepare('DELETE FROM event_index_rows WHERE scope_key=? AND sequence=?').run(scopeKey(f.store,f.v.planAnswer),event.sequence);
  const missing=summary(f,req,f.open());assert.equal(missing.index.status,'incomplete');assert.equal(missing.index.reason,'basis_missing');
  assert.equal(missing.index.projection,null);assert.deepEqual(missing.index.missingBasis,[entry.attempt]);
  const text=renderStageSummary(missing);assert.match(text,/Неполнота: basis_missing/);assert.ok(text.includes(entry.attempt.id));
  assert.doesNotMatch(text,/Применённый прогресс P|Hidden until indexed|Запрошенный диапазон и основания проиндексированы/);
  db.prepare('DELETE FROM event_index_rows WHERE scope_key=?').run(scopeKey(f.store,f.v.planAnswer));db.close();
  const empty=summary(f,request(req.plan,cursor,[]),f.open());
  assert.equal(empty.index.reason,'basis_missing');assert.equal(empty.index.projection,null);
  assert.match(renderStageSummary(empty),/Явный пустой набор/);assert.match(renderStageSummary(empty),/Неполнота: basis_missing/);
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);
});

test('DRS2.3 foreign edition/database/project and malformed or damaged grounds refuse the section instead of hiding the error',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Exact grounds')),oldPlan=f.v.planAnswer,q=f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(q.id,q.revision);
  const src=f.discovery.evidence.document('p','edition-two','New edition','text/plain',0);
  answerDiscoveryFixture(f.engine,'p',f.store.get<DiscoveryDraft>(f.v.draft.id)!,f.store.get<Question>(q.id)!,
    validPlan(f.v.frameRef,[planQuestion('q-industry','industry','blocking')],2,oldPlan),src);
  const next=f.store.get<Question>(q.id)!.value.answer!,foreign=acceptPlan(f,'other',[planQuestion('foreign','industry')],{sourceKey:'per-draft'});
  const cursor=discoveryIndexCursor(f.store);buildDiscoveryIndexAt(f.store,'p',oldPlan,cursor);
  const req=request(oldPlan,cursor,[entry.attempt]),before=snapshot(f.store),wires=f.wires();
  for(const basis of [undefined,null,[null],[entry.attempt,entry.attempt],[next],[foreign.planAnswer],
    [{...entry.attempt,hash:'b'.repeat(64)}],[{...entry.attempt,revision:10000}]])
    invalid(()=>summary(f,{...req,basis} as any));
  for(const plan of [undefined,null,{...req.plan,hash:'c'.repeat(64)}])invalid(()=>summary(f,{...req,plan} as any));
  for(const bad of [undefined,null,{run:'r',number:1},{...cursor,databaseId:'foreign'}])invalid(()=>summary(f,{...req,cursor:bad} as any));
  for(const bad of [null,{}, {...req,section:'unknown'}])
    invalid(()=>stageSummary(f.store,'p','discovery',bad as any),'stage_summary_index_request_invalid');
  invalid(()=>stageSummary(f.store,'other','discovery',req));
  invalid(()=>stageSummary(f.store,'p','concept',req as any),'stage_summary_index_request_invalid');
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);
  const db=new DatabaseSync(f.path);
  db.exec('DROP TRIGGER revisions_no_update');
  db.prepare('UPDATE revisions SET sha256=? WHERE entity_id=? AND revision=?').run('d'.repeat(64),entry.attempt.id,entry.attempt.revision);db.close();
  invalid(()=>summary(f,req,f.open()));
});

test('DRS2.3 the same cold historical section and text survive later heads and C2 publication without primary writes',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Historical summary')),applied=await assessAndApply(f,entry);
  const cursor=discoveryIndexCursor(f.store),req=request(f.v.planAnswer,cursor,[entry.attempt,reference(applied.state)]);
  buildDiscoveryIndexAt(f.store,'p',req.plan,cursor);
  const first=summary(f,req),text=renderStageSummary(first);
  for(const ref of [f.v.draft,f.v.plan]) {
    const row=f.store.get<any>(ref.id)!;
    f.store.write({id:row.id,kind:row.kind,expected:row.revision,value:{...row.value,...(row.kind==='question'?{answer:null,status:'open'}:{questions:[]})}});
  }
  f.store.write({id:'late-source',kind:'test',expected:0,value:{projectId:'p'}});
  const later=discoveryIndexCursor(f.store);buildDiscoveryIndexAt(f.store,'p',req.plan,later);
  const before=snapshot(f.store),wires=f.wires(),stamp=f.store.changeStamp();
  const cold=measured(()=>summary(f,req,f.open()));assert.deepEqual(cold.value,first);assert.equal(renderStageSummary(cold.value),text);
  assert.equal(cold.value.index.indexedThrough,cursor.sequence);bounded(cold);
  invalid(()=>summary(f,{...req,basis:[reference(f.store.get('late-source')!)]},f.open()));
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);assert.equal(f.store.changeStamp(),stamp);
});

test('DRS2.3 cold summary work does not grow at +0/+10/+100 unrelated assessments; full-list control fails the same bound',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Measured summary')),applied=await assessAndApply(f,entry);
  const basis=[entry.attempt,reference(applied.state)];
  buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,discoveryIndexCursor(f.store));
  let normal:ReturnType<typeof measured<DiscoveryIndexStageSummary>>|undefined;
  for(const count of [0,10,100]) {
    const path=join(f.root,`summary-${count}.sqlite`),db=new DatabaseSync(f.path);db.prepare('VACUUM INTO ?').run(path);db.close();
    const writer=new Store(path);
    for(let i=0;i<count;i++)writer.write({id:`unrelated:${i}`,kind:'discovery-assessment',expected:0,value:{projectId:'other',payload:'Unrelated'}});
    const cursor=discoveryIndexCursor(writer);buildDiscoveryIndexAt(writer,'p',f.v.planAnswer,cursor);writer.close();
    const cold=new Store(path);t.after(()=>cold.close());const req=request(f.v.planAnswer,cursor,basis);
    const sample=measured(()=>summary(f,req,cold));assert.equal(sample.value.index.status,'indexed');bounded(sample,normal);normal??=sample;
    const control=measured(()=>{cold.list('discovery-assessment');return summary(f,req,cold);});
    if(count) {
      assert.ok(control.rows>sample.rows);assert.ok(control.bodies>sample.bodies);
      assert.throws(()=>bounded(control,normal),'the bound measures selected records, not just SQL call count');
    }
  }
});
