import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { FINAL_MATERIAL_CONTRACT } from '../src/discovery/final-material.js';
import { prepareDiscoveryFinalAssessmentSubject } from '../src/discovery/discovery-final-assessment-subject.js';
import { prepareDiscoveryFinalAssessmentSession } from '../src/discovery/discovery-final-assessment-session.js';
import { runDiscoveryFinalAssessmentExecution } from '../src/discovery/discovery-final-assessment-execution.js';
import { finalPaid } from './discovery-v7-final-paid-seed.js';

test('L34 independent final assessment keeps the complete candidate and assessed dossier, pages within 500k and replays cold',async t=>{
  const f=await finalPaid(t);
  const packet=await prepareDiscoveryFinalAssessmentSubject(f.store,'p',f.d6,f.result.value.projection.result.bundle);
  f.reply({action:'answer',question:'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'Calibration'},citations:[]});
  await researchCall(f.environment.value.reviewer,f.environment.value,'Measure bounded final assessor',{},undefined,
    {store:f.store,draftId:f.data.calibration.draft.id,questionId:f.data.calibration.question.id,purpose:'assessor'});
  const prepared=await prepareDiscoveryFinalAssessmentSession(f.store,'p',packet.subject,{prompt:'Review the complete final candidate',packetChars:490000,
    limitChars:500000,resultLimitChars:500000,environment:reference(f.environment),role:f.environment.value.reviewer});
  f.reply({contract:'discovery-final-assessment-result/v1',subject:packet.subject,verdict:'supported',reasons:['Read the complete candidate and exact dossier'],
    bases:[{candidate:'/verdict'}],return:null});
  const start=f.wires().length;
  const result=await runDiscoveryFinalAssessmentExecution(f.store,'p',f.paidResult,reference(prepared),{profile:f.profile});
  assert.ok(result.result&&result.output);assert.deepEqual(result.result.packet,packet);
  assert.equal(prepared.value.input.materialContract,FINAL_MATERIAL_CONTRACT);
  const wires=f.wires().slice(start) as any[];
  assert.ok(wires.length>0);for(const wire of wires)assert.ok(JSON.stringify(wire).length<=500000);
  const money=f.store.list('research-budget-ledger').map(reference),calls=f.store.list('model-call').map(reference);
  const cold=f.reopen(),restored=await runDiscoveryFinalAssessmentExecution(cold,'p',f.paidResult,reference(prepared),{restoreOnly:true,allowance:0});
  assert.deepEqual(reference(restored.output!),reference(result.output));assert.deepEqual(cold.list('research-budget-ledger').map(reference),money);
  assert.deepEqual(cold.list('model-call').map(reference),calls);
  t.diagnostic(JSON.stringify({role:'final-assessor',calls:wires.length,chars:wires.reduce((n,w)=>n+JSON.stringify(w).length,0),fullPacket:JSON.stringify(packet).length}));
});
