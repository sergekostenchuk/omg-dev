import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { canonical, hashJson } from '../src/canonical.js';
import { dossierDeliveryWorld } from './discovery-v7-dossier-delivery-fixture.js';
import { dossierMaterialDictionary, restoreDossierMaterial, dossierMaterialProjection } from '../src/discovery/dossier-material.js';
import { runDossierAssessmentSession, readDossierAssessmentSessionAt } from '../src/discovery/assessment-session.js';
import { money } from './discovery-v7-dossier-seed.js';
import { storeView } from '../src/storage/store-view.js';
import { EngineError } from '../src/errors.js';
import { stopRun, resumeStoppedRun } from '../src/om/run-control.js';

test('L29 real dossier: paid cut, cold paging, exact technical addresses, complete terminal and free replay', async t=>{
  const f=await dossierDeliveryWorld(t),dictionary=dossierMaterialDictionary(f.packet),projection=dossierMaterialProjection(f.packet);
  assert.deepEqual(restoreDossierMaterial(dictionary),f.packet);
  assert.ok(canonical(projection).length<canonical(f.packet).length);
  let cut=false;
  const view=storeView(f.store,{write:(writes,guards)=>{
    if(!cut && writes.some(w=>w.kind==='assessment-session' && w.expected===1)){cut=true;throw new EngineError('test_cut','Paid before projection');}
    return f.store.writeMany(writes,guards);
  }});
  await assert.rejects(()=>runDossierAssessmentSession(view,'p',f.packet.subject,f.environment,f.profile),{code:'test_cut'});
  assert.equal(f.sent().length,1);const cost=money(f.store);
  const cold=f.open();
  const restored=await runDossierAssessmentSession(cold,'p',f.packet.subject,undefined,undefined,undefined,{restoreOnly:true});
  assert.equal(restored.session.value.step,1);assert.deepEqual(money(cold),cost);assert.equal(f.sent().length,1);
  const result=await runDossierAssessmentSession(cold,'p',f.packet.subject);
  assert.equal(result.result?.result.verdict,'return');assert.deepEqual(result.result!.packet,f.packet);
  const seen=new Map<string,number>();
  for(const wire of f.sent()) {
    assert.ok(!Object.hasOwn(wire.subject,'dossierPacket'));
    assert.ok(JSON.stringify(wire).length<=500000);
    for(const fragment of wire.subject.materialDelivery??[]) {
      assert.ok(JSON.stringify(fragment).length<=fragment.deliveryLimitChars);
      const key=hashJson([fragment.original.record,fragment.original.pointer]);
      assert.equal(fragment.served.offset,seen.get(key)??0);seen.set(key,fragment.served.end);
    }
  }
  assert.equal(f.sent().length,2,'the new transport must not add calls for the same large dossier');
  const call=cold.list<any>('model-call').find(row=>row.value.purpose==='dossier-assessor')!;
  const body=cold.get<any>(call.value.packet.archive.id,1)!.value.body;
  for (const technical of body.dossierMaterial.records.filter((row:any)=>row.technical)) {
    const index=Number(technical.technical.pointer.split('/').at(-1));
    assert.deepEqual(body.dossierPacket.grounds[index].ref,technical.ref);
    assert.ok(body.dossierPacket.grounds[index].value);
  }
  const before=money(cold),count=f.sent().length;
  assert.deepEqual((await readDossierAssessmentSessionAt(cold,'p',reference(result.session))).result,result.result);
  assert.deepEqual((await runDossierAssessmentSession(f.open(),'p',f.packet.subject)).result,result.result);
  assert.deepEqual(money(cold),before);assert.equal(f.sent().length,count);
  t.diagnostic(JSON.stringify({fullPacket:canonical(f.packet).length,dictionary:canonical(dictionary).length,
    material:canonical(projection).length,calls:count,deliveredChars:f.sent().reduce((sum,w)=>sum+JSON.stringify(w).length,0)}));
});

test('L29 real dossier: early terminal refuses unpaid remainder; required material remains full',async t=>{
  const f=await dossierDeliveryWorld(t);f.settingsChange({early:true});
  await assert.rejects(()=>runDossierAssessmentSession(f.store,'p',f.packet.subject,f.environment,f.profile),{code:'research_context_incomplete'});
  assert.equal(f.sent().length,1);
  const session=f.store.list<any>('assessment-session').find(row=>row.value.contract==='dossier-session/v1')!;
  assert.equal(session.value.result,null);
  assert.equal(session.value.dossierMaterialContract,'dossier-material-dictionary/v1');
});

test('L29 explicit read_context and stop: pending page delivered once, stop buys no new call',async t=>{
  const f=await dossierDeliveryWorld(t);f.settingsChange({read:true});
  await assert.rejects(()=>runDossierAssessmentSession(f.store,'p',f.packet.subject,f.environment,f.profile,undefined,{allowance:1}),{code:'research_call_allowance'});
  const count=f.sent().length,cost=money(f.store);
  const stopped=stopRun(f.store,{project:'p'});assert.ok(stopped.ok);
  await assert.rejects(()=>runDossierAssessmentSession(f.open(),'p',f.packet.subject),{code:'run_stopped'});
  assert.equal(f.sent().length,count);assert.deepEqual(money(f.store),cost);
  const token=f.store.get<any>('om-run-control:p')!.value.stop.token;
  assert.ok(resumeStoppedRun(f.store,{project:'p',stop:token}).ok);
  const result=await runDossierAssessmentSession(f.open(),'p',f.packet.subject);
  assert.ok(result.result);assert.ok(f.sent().some(w=>w.subject.contextWorkspace?.length));
  const slices=f.sent().flatMap(w=>w.subject.materialDelivery??[]);
  for(let i=1;i<slices.length;i++)if(slices[i].original.pointer===slices[i-1].original.pointer)
    assert.ok(slices[i].served.offset>=slices[i-1].served.end);
});
