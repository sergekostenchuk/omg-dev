import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { canonical, hashJson } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { stopRun, resumeStoppedRun } from '../src/om/run-control.js';
import { stageDiscoveryFinalEnvelope } from '../src/discovery/discovery-final-packing.js';
import { prepareDiscoveryFinalSession, readDiscoveryFinalSessionAt, DISCOVERY_FINAL_SESSION, DISCOVERY_FINAL_SESSION_KIND } from '../src/discovery/discovery-final-session.js';
import { runDiscoveryFinalExecution } from '../src/discovery/discovery-final-execution.js';
import { finalCandidate, finalPaid } from './discovery-v7-final-paid-seed.js';

async function world(t:test.TestContext){
  const f=await finalPaid(t);
  f.reply({action:'answer',question:'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'Calibration'},citations:[]});
  await researchCall(f.environment.value.implementer,f.environment.value,'Measure recovery final',{},undefined,
    {store:f.store,draftId:f.data.calibration.draft.id,questionId:f.data.calibration.question.id,purpose:'assessor'});
  return f;
}
const money=(f:Awaited<ReturnType<typeof finalPaid>>)=>canonical(f.store.list().filter(r=>['model-call','research-budget-ledger'].includes(r.kind)).flatMap(r=>f.store.history(r.id)));

test('L34 a paid page survives a cut; cold restore and stop buy nothing, resumed pages never repeat the covered prefix',{timeout:60000},async t=>{
  const f=await world(t),prepared=await prepareDiscoveryFinalSession(f.store,'p',f.packet.subject,{prompt:'Recover bounded final pages',packetChars:90000,
    limitChars:500000,resultLimitChars:500000,environment:reference(f.environment),role:f.environment.value.implementer});
  f.reply(finalCandidate(f.packet,'go'));const start=f.wires().length;
  let cut=false;
  const writeMany=f.store.writeMany;
  f.store.writeMany=((writes:Parameters<typeof writeMany>[0],guards:Parameters<typeof writeMany>[1])=>{
    if(!cut&&writes.some(w=>w.kind==='discovery-final-execution'&&w.expected===1)){cut=true;throw new EngineError('test_cut','Paid before projection');}
    return writeMany.call(f.store,writes,guards);
  }) as typeof writeMany;
  try {await assert.rejects(()=>runDiscoveryFinalExecution(f.store,'p',reference(prepared),{profile:f.profile}),{code:'test_cut'});}
  finally {f.store.writeMany=writeMany;}
  assert.equal(f.wires().length-start,1);const cost=money(f);
  const restored=await runDiscoveryFinalExecution(f.reopen(),'p',reference(prepared),{restoreOnly:true});
  assert.equal(restored.session.value.step,1);assert.equal(restored.result,null);assert.equal(money(f),cost);
  assert.ok(stopRun(f.store,{project:'p'}).ok);
  await assert.rejects(()=>runDiscoveryFinalExecution(f.store,'p',reference(prepared)),{code:'run_stopped'});
  assert.equal(money(f),cost);assert.equal(f.wires().length-start,1);
  const stop=f.store.get<any>('om-run-control:p')!.value.stop.token;assert.ok(resumeStoppedRun(f.store,{project:'p',stop}).ok);
  const done=await runDiscoveryFinalExecution(f.store,'p',reference(prepared));assert.ok(done.result);
  const ends=new Map<string,number>();
  for(const wire of f.wires().slice(start) as any[]){
    assert.ok(JSON.stringify(wire).length<=500000);
    for(const fragment of wire.subject.materialDelivery??[]){const key=hashJson([fragment.original.record,fragment.original.pointer]);
      assert.ok(fragment.served.offset>=(ends.get(key)??0),'covered automatic pages must not restart');ends.set(key,fragment.served.end);}
  }
});

test('L34 early terminal cannot complete an unread claim page',async t=>{
  const f=await world(t),prepared=await prepareDiscoveryFinalSession(f.store,'p',f.packet.subject,{prompt:'No unread terminal',packetChars:45000,
    limitChars:500000,resultLimitChars:500000,environment:reference(f.environment),role:f.environment.value.implementer});
  // The local adapter deliberately ignores addresses, exercising the product refusal.
  writeFileSync(f.root+'/adapter.mjs',`import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:${JSON.stringify(finalCandidate(f.packet,'go'))},usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  await assert.rejects(()=>runDiscoveryFinalExecution(f.store,'p',reference(prepared),{profile:f.profile}),{code:'research_context_incomplete'});
  assert.equal(f.store.list<any>('discovery-final-paid-result').filter(r=>r.value.prepared.id===prepared.id).length,0);
});

test('L34 a markerless immutable preparation uses its original capacity and paid transport after the new era ships',async t=>{
  const f=await world(t),input={prompt:'Historical final preparation',packetChars:8000000,limitChars:9000000,resultLimitChars:10000000,
    environment:reference(f.environment),role:f.environment.value.implementer};
  const staged=await stageDiscoveryFinalEnvelope(f.store,'p',f.packet.subject,input);
  // Reproduce the old producer with the common staged archive, never a paid/result shortcut.
  const value={contract:DISCOVERY_FINAL_SESSION,project:'p',subject:staged.envelope.subject,archive:staged.envelope.archive,
    environment:reference(staged.environment),role:input.role,input,envelope:staged.envelope,state:'prepared',cursor:{offset:0},result:null};
  const id=`${DISCOVERY_FINAL_SESSION_KIND}:p:${hashJson(value)}`;
  const saved=f.store.writeMany([...staged.writes,{id,kind:DISCOVERY_FINAL_SESSION_KIND,expected:0,value}],staged.guards).find(r=>r.id===id)!;
  assert.equal(Object.hasOwn((await readDiscoveryFinalSessionAt(f.store,'p',reference(saved))).value.input,'materialContract'),false);
  assert.equal('archive' in staged.envelope.capacity.mandatory&&staged.envelope.capacity.mandatory.archive.pointer,'/body/request');
  f.reply(finalCandidate(f.packet,'go'));
  const paid=await runDiscoveryFinalExecution(f.store,'p',reference(saved),{profile:f.profile});assert.ok(paid.output);
  const cost=money(f),count=f.wires().length;
  assert.deepEqual(reference((await runDiscoveryFinalExecution(f.reopen(),'p',reference(saved),{restoreOnly:true,allowance:0})).output!),reference(paid.output));
  assert.equal(money(f),cost);assert.equal(f.wires().length,count);
});
