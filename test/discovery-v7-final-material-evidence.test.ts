import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { FINAL_MATERIAL_CONTRACT } from '../src/discovery/final-material.js';
import { proveClaimAddress } from '../src/discovery/claim-address.js';
import { prepareConditionEvidenceSubject } from '../src/discovery/discovery-condition-evidence-subject.js';
import { prepareConditionEvidenceSession } from '../src/discovery/discovery-condition-evidence-session.js';
import { runConditionEvidenceExecution } from '../src/discovery/discovery-condition-evidence-execution.js';
import { acceptedAssessmentPaid } from './discovery-v7-final-assessment-seed.js';

test('L34 condition evidence preserves exact claims, full condition and criterion through the common transport and cold replay',async t=>{
  const f=await acceptedAssessmentPaid(t,{outcome:'conditional'}),manifest=f.data.accepted.manifest;
  const claim=f.packet.final.dossier.materials.map(x=>x.address).find(address=>{try{proveClaimAddress(f.store,address);return true;}catch{return false;}});
  assert.ok(claim);
  const packet=prepareConditionEvidenceSubject(f.store,'p',{manifest,conditionId:'evidence-1',claims:[claim]});
  f.reply({action:'answer',question:'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'Calibration'},citations:[]});
  await researchCall(f.environment.value.reviewer,f.environment.value,'Measure bounded evidence assessor',{},undefined,
    {store:f.store,draftId:f.data.calibration.draft.id,questionId:f.data.calibration.question.id,purpose:'assessor'});
  const prepared=prepareConditionEvidenceSession(f.store,'p',packet.subject,{prompt:'Assess complete evidence against the exact criterion',packetChars:490000,
    limitChars:500000,resultLimitChars:500000,environment:reference(f.environment),role:f.environment.value.reviewer});
  f.reply({contract:'discovery-condition-evidence-result/v1',subject:packet.subject,verdict:'supported',reasons:['The offered claim meets the criterion'],
    bases:[{claim},{criterion:true}],return:null});
  const start=f.wires().length,result=await runConditionEvidenceExecution(f.store,'p',manifest,reference(prepared),{profile:f.profile});
  assert.ok(result.output&&result.result);assert.deepEqual(result.result.packet,packet);
  assert.equal(prepared.value.input.materialContract,FINAL_MATERIAL_CONTRACT);
  const wires=f.wires().slice(start) as any[];assert.ok(wires.length>0);
  for(const wire of wires)assert.ok(JSON.stringify(wire).length<=500000);
  const calls=f.store.list('model-call').map(reference),ledger=f.store.list('research-budget-ledger').map(reference);
  const cold=f.reopen(),restored=await runConditionEvidenceExecution(cold,'p',manifest,reference(prepared),{restoreOnly:true,allowance:0});
  assert.deepEqual(reference(restored.output!),reference(result.output));assert.deepEqual(cold.list('model-call').map(reference),calls);
  assert.deepEqual(cold.list('research-budget-ledger').map(reference),ledger);
  t.diagnostic(JSON.stringify({role:'condition-evidence',calls:wires.length,chars:wires.reduce((n,w)=>n+JSON.stringify(w).length,0),fullPacket:JSON.stringify(packet).length}));
});
