import test, {after, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {finalizationWorld, finalizationAdapter} from './discovery-v7-b1-finalization-fixture.js';
import {modeOf} from './discovery-v7-dossier-seed.js';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference} from '../src/pipeline/contracts.js';
import {readResearchRun} from '../src/discovery/projection-reader.js';
import {readRunnerFinalizationAt} from '../src/discovery/discovery-finalization-runner.js';
import type {DiscoveryDraft} from '../src/discovery/discovery.js';
import {ProducerPolicySessions, issueProducerPolicyInvitation, setProjectProducerPolicy} from '../src/product/producer-policy-authority.js';

// Each paid phase is built once inside its measured test; later phases receive separate SQLite copies.
const cleanup: (()=>unknown)[]=[];
after(()=>{for(const f of cleanup.reverse())f();});
function checkpoint<T extends Awaited<ReturnType<typeof finalizationWorld>>>(build:(t:TestContext)=>Promise<T>) {
  let saved:Promise<T>|undefined;
  return async(t:TestContext)=>{
    const owner=new Proxy(t,{get(target,key){if(key==='after')return(f:()=>unknown)=>cleanup.push(f);
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const source=await(saved??=build(owner)), root=mkdtempSync(join(tmpdir(),'omg-live-checkpoint-')), path=join(root,'state.sqlite');
    const database=new DatabaseSync(source.store.path);
    try{database.exec(`VACUUM INTO '${path.replaceAll("'","''")}'`);}finally{database.close();}
    const stores:Store[]=[],open=()=>{const store=new Store(path);stores.push(store);return store;};
    const store=open(),engine=new ProductEngine(store);
    t.after(()=>{for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});});
    return {...source,store,engine,discovery:engine.discovery,open};
  };
}
const d6=checkpoint(async t=>{
  const f=await finalizationWorld(t); modeOf(f.store,'bypass');
  const scope={project:'p',discovery:7 as const,previous:null}, sessions=new ProducerPolicySessions(f.store);
  const opened=sessions.exchange(issueProducerPolicyInvitation(f.store,scope));
  const permit=setProjectProducerPolicy(f.store,scope,opened.authority).record; sessions.revoke(opened.bearer);
  await finalizationAdapter(f,'go');
  const source=f.discovery.evidence.document('p','concept-instruction','The accepted ledger serves an operator who records transactions.','text/plain',0);
  const citations=[{source:reference(source),selector:{kind:'text-range',start:0,end:source.value.content.length}}];
  const path=join(f.root,'adapter.mjs'), output='console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,';
  const script=readFileSync(path,'utf8');assert.ok(script.includes(output));
  writeFileSync(path,script.replace(output,`if(r.subject.stage==='concept'||r.subject.question?.field==='audience'){
if(r.subject.role==='assess-answer')research={verdict:'supported',reasons:[]};
else research={action:'answer',question:r.subject.question.id,value:'Operator of the accepted ledger',citations:${JSON.stringify(citations)}};}
${output}`));
  return {...f,permit:reference(permit)};
});
test('LIVE continuation: real paid D6 remains readable after the project opt-in', {timeout:60000},async t=>{
  const f=await d6(t);
  assert.ok(f.d6); assert.ok(f.store.get(f.d6.id,f.d6.revision));
});
const authored=checkpoint(async t=>{
  const f=await d6(t), before=f.store.list('model-call').length;
  const result=await f.engine.execute({type:'early-stage-run',project:'p',draftId:f.packet.subject.basis.draft.id,maxTurns:8,maxCalls:1});
  const run=readResearchRun(f.store,'p',f.packet.subject.basis.draft.id)!;
  const final=await readRunnerFinalizationAt(f.store,'p',reference(run));
  return {...f,result,final,before};
});
test('LIVE continuation: ordinary Driver buys D7 with the saved policy and one physical call', {timeout:60000},async t=>{
  const f=await authored(t);
  assert.equal(f.final.status,'assessing',JSON.stringify(f.result));assert.ok(f.final.final);
  const calls=f.store.list<any>('model-call');assert.equal(calls.length-f.before,1);
  const paid=calls.find(c=>c.value.purpose==='discovery-final'); assert.ok(paid);
  assert.deepEqual(paid.value.producerPolicy,f.permit);
});
const assessed=checkpoint(async t=>{
  const f=await authored(t), engine=new ProductEngine(f.open());
  const result=await engine.execute({type:'early-stage-run',project:'p',draftId:f.packet.subject.basis.draft.id,maxTurns:8,maxCalls:1});
  const run=readResearchRun(engine.store,'p',f.packet.subject.basis.draft.id)!;
  const final=await readRunnerFinalizationAt(engine.store,'p',reference(run));
  return {...f,result,final};
});
test('LIVE continuation: cold ordinary Driver independently assesses and accepts D7', {timeout:60000},async t=>{
  const f=await assessed(t);
  assert.equal(f.final.status,'accepted',JSON.stringify(f.result)); assert.equal(f.final.view.next,'concept');
});
test('LIVE continuation: ordinary Driver enters exactly one pinned concept and restores paid D7 for free', {timeout:60000},async t=>{
  const f=await assessed(t), engine=new ProductEngine(f.open()), before=engine.store.list('model-call').length;
  const result=await engine.execute({type:'early-stage-run',project:'p',draftId:f.packet.subject.basis.draft.id,maxTurns:8,maxCalls:1});
  const concepts=engine.store.list<DiscoveryDraft>('discovery-draft').filter(d=>d.value.stage==='concept');
  assert.equal(concepts.length,1,JSON.stringify(result));assert.deepEqual(concepts[0]!.value.discoveryHandoff!.manifest,f.final.view.manifest);
  assert.equal(engine.store.list('model-call').length-before,1);
  const calls=engine.store.list('model-call').length;
  await engine.researcher.run('p',f.packet.subject.basis.draft.id,1,undefined,{restoreOnly:true});
  assert.equal(engine.store.list('model-call').length,calls);
});
