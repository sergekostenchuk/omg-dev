import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { FINAL_MATERIAL_CONTRACT } from '../src/discovery/final-material.js';
import { prepareDiscoveryFinalSession, readDiscoveryFinalSessionAt } from '../src/discovery/discovery-final-session.js';
import { runDiscoveryFinalExecution } from '../src/discovery/discovery-final-execution.js';
import { prepareDiscoveryFinalResultTransport } from '../src/discovery/discovery-final-result.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { finalPaid, finalCandidate } from './discovery-v7-final-paid-seed.js';

test('L34 ordinary paid final uses content pages within 500k, restores cold without payment and keeps the complete archive', async t=>{
  const f=await finalPaid(t);
  f.reply({action:'answer',question:'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'Calibration'},citations:[]});
  await researchCall(f.environment.value.implementer,f.environment.value,'Measure bounded final',{},undefined,
    {store:f.store,draftId:f.data.calibration.draft.id,questionId:f.data.calibration.question.id,purpose:'assessor'});
  await assert.rejects(()=>prepareDiscoveryFinalResultTransport(f.store,'p',f.packet.subject,500000),{code:'research_capacity_configuration'});
  const prepared=await prepareDiscoveryFinalSession(f.store,'p',f.packet.subject,{prompt:'L34 bounded final',packetChars:490000,limitChars:500000,
    resultLimitChars:500000,environment:reference(f.environment),role:f.environment.value.implementer});
  assert.equal(prepared.value.input.materialContract,FINAL_MATERIAL_CONTRACT);
  assert.ok(prepared.value.envelope.capacity.forms[0]!.minimumChars<500000);
  assert.equal('archive' in prepared.value.envelope.capacity.mandatory && prepared.value.envelope.capacity.mandatory.archive.pointer,'/body/admission');
  f.reply(finalCandidate(f.packet,'go'));
  const start=f.wires().length;
  const result=await runDiscoveryFinalExecution(f.store,'p',reference(prepared),{profile:f.profile});
  assert.ok(result.output && result.result);
  const wires=f.wires().slice(start) as any[];
  assert.ok(wires.length>0);
  for(const wire of wires){assert.ok(JSON.stringify(wire).length<=500000);assert.ok(wire.subject.request.materialContract===FINAL_MATERIAL_CONTRACT);}
  t.diagnostic(JSON.stringify({calls:wires.length,chars:wires.reduce((n,w)=>n+JSON.stringify(w).length,0),fullPacketChars:JSON.stringify(f.packet).length}));
  const calls=f.store.list('model-call').length,ledger=f.store.list('research-budget-ledger').map(row=>reference(row));
  const cold=f.reopen();
  assert.deepEqual((await readDiscoveryFinalSessionAt(cold,'p',reference(prepared))).value,prepared.value);
  const restored=await runDiscoveryFinalExecution(cold,'p',reference(prepared),{restoreOnly:true});
  assert.deepEqual(reference(restored.output!),reference(result.output!));
  assert.equal(cold.list('model-call').length,calls);assert.deepEqual(cold.list('research-budget-ledger').map(row=>reference(row)),ledger);
});
