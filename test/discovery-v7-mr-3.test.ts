// MR.3 uses a real managed packet and shared assessment-session producer.
// It proves wire/capacity/session identity; the final assessment projector belongs to MR.4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson } from '../src/canonical.js';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { reference } from '../src/pipeline/contracts.js';
import { researchSetup, rand } from './discovery-v7-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution, completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { type ResearchRun, V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { type AssessmentTransportSubject } from '../src/discovery/continuation-packet.js';

async function setup(t: test.TestContext) {
  const f = await researchSetup(t), { v, project, environment, subject, prompt } = f;
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:1,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    const input={projectId:project,kind:'analyst' as const,key:run.id,owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:1,instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,intent,input,invoke,question,draft,selected,context};
  };
  return {...f,prepare};
}

async function packetFixture(t: test.TestContext, fact = false) {
  const f=await setup(t);
  const source=fact?f.discovery.evidence.document('p','measurement',JSON.stringify({fact:'Measured throughput is 42',published:'2026-10-20',version:'2.1'}),'application/json',0):null;
  if(source) writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'answer',question:'q-industry',citations:[],
    value:{type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'fact-throughput',kind:'fact',
      text:'Measured throughput is 42',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
      scope:{variants:'common'},basis:{source:{ref:reference(source),range:{start:0,end:source.value.content.length},valueHash:hashJson(source.value.content)},
        limit:'Measured deployment',asOf:'2026-10'}}]}}}}));
  const m=f.prepare(), response=await m.invoke();
  const execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:1,context:m.context,subject:m.selected});
  const turnId=managedTurnId(m.run.id,1);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id:turnId,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const call=f.store.get<ResearchConsumerIntent>(m.intent.id)!.value.call!;
  const recorded=recordV7Attempt(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:'q-industry',
    call,end:attemptEndOfAction(response,m.selected)});
  const done=completeResearchAttemptTurn(f.store,'p',reference(f.store.get(turnId)!),reference(recorded.attempt));
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:'q-industry',
    entries:[{attempt:reference(recorded.attempt),binding:reference(done.binding)}]});
  const subject:AssessmentTransportSubject={kind:'attempts',packet,
    baseline:{contract:V7_PROGRESS_BASELINE_CONTRACT,state:{kind:'absent',id:v7ProgressStateId(packet)},materials:[]}};
  return {...f,m,subject,source};
}

import { assessmentSessionWithProof } from '../src/discovery/assessment-session.js';
import { methodologyAssessmentTransport, requirementsAssessmentTransport, assessmentQuestionContract, packetAssessmentSubject, assessmentResponseContract, assessmentTransportPrompt, assessmentSubjectKey, ATTEMPTS_REQUIREMENTS_INSTRUCTION } from '../src/discovery/continuation-packet.js';
import { baselineGuards } from '../src/discovery/v7-attempt-assessment.js';
import { researchCapacityInput, resultCapacityFrom, requireResultCapacity } from '../src/discovery/early-research-outcome.js';
function assessmentReply(f: Awaited<ReturnType<typeof packetFixture>>) {
  const attempt=f.subject.packet.entries[0]!.attempt;
  return {verdict:'return',reasons:['No sufficient material'],return:{target:{attempt},reason:'Continue research'},
    novelty:{attempts:[{attempt,reason:'No sufficient material'}],accepted:[],rejected:[],newContent:[],duplicates:[],
      noProgress:[{attempt,reason:'No new content'}],transition:null},
    methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}test('MR.3: explicit v3 declaration has separate identity, cached schema and one requirements instruction; v2 stays unchanged',async t=>{
  const f=await packetFixture(t),v2={...f.subject,assessment:methodologyAssessmentTransport()},v3={...f.subject,assessment:requirementsAssessmentTransport()};
  assert.equal(methodologyAssessmentTransport().contract,'discovery-assessment/v2');
  assert.equal(requirementsAssessmentTransport().policy,'assessment-methodology-policy/v2');
  assert.notEqual(assessmentSubjectKey(v2),assessmentSubjectKey(v3));
  assert.deepEqual(packetAssessmentSubject({assessmentSubject:v3}),v3);
  assert.equal(assessmentResponseContract(v3),assessmentResponseContract(v3));
  assert.notEqual(assessmentResponseContract(v2),assessmentResponseContract(v3));
  const old=assessmentQuestionContract(v2),current=assessmentQuestionContract(v3);
  assert.ok(!old.prompt.includes(ATTEMPTS_REQUIREMENTS_INSTRUCTION));
  assert.ok(current.prompt.includes(ATTEMPTS_REQUIREMENTS_INSTRUCTION));
  assert.equal(assessmentTransportPrompt(current.prompt+'single-answer-suffix','single-answer-suffix',v3),current.prompt);
  assert.ok(JSON.stringify(current.schema).includes('methodologyRequirements'));
  assert.ok(!JSON.stringify(old.schema).includes('methodologyRequirements'));
  const capacityInput=(assessmentSubject:AssessmentTransportSubject)=>researchCapacityInput({
    operation:'mr3-assessment',generation:0,role:'assessor',purpose:'assessor',actionMode:'assess-attempts',limit:200000,
    bindings:{projectId:'p',draft:reference(f.m.draft),question:reference(f.m.question),assessmentSubject},
    prompt:assessmentQuestionContract(assessmentSubject).prompt,binding:f.environment.value.reviewer,
    draft:f.m.draft.value,question:f.m.question,context:{assessmentSubject}});
  const c2=capacityInput(v2),c3=capacityInput(v3),admission=resultCapacityFrom(c3);
  assert.deepEqual(admission.bindings.assessmentSubject,v3);
  assert.deepEqual((c3.mandatoryEnvelope as any).subject.assessmentSubject,v3);
  assert.equal((c3.mandatoryEnvelope as any).prompt.split(ATTEMPTS_REQUIREMENTS_INSTRUCTION).length,2);
  assert.throws(()=>requireResultCapacity(admission,c2),{code:'research_capacity_invalid'});
  assert.throws(()=>requireResultCapacity(resultCapacityFrom(c2),c3),{code:'research_capacity_invalid'});
  for(const [contract,policy] of [['discovery-assessment/v2','assessment-methodology-policy/v2'],
    ['discovery-assessment/v3','assessment-methodology-policy/v1'],['discovery-assessment/v4','assessment-methodology-policy/v2']]) {
    assert.throws(()=>packetAssessmentSubject({assessmentSubject:{...v3,assessment:{...v3.assessment,contract,policy}}}),
      {code:'discovery_assessment_subject_invalid'});
  }
});
test('MR.3: mixed declarations refuse in the actual session producer before adapter or ledger',async t=>{
  const f=await packetFixture(t),sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  for(const contract of ['discovery-assessment/v2','discovery-assessment/v3']) {
    const subject={...f.subject,assessment:{...requirementsAssessmentTransport(),contract,
      policy:contract==='discovery-assessment/v3'?'assessment-methodology-policy/v1':'assessment-methodology-policy/v2'}};
    await assert.rejects(assessmentSessionWithProof(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
      {assessmentSubject:subject,value:null,observations:[]},'Assess exactly the selected subject',undefined,baselineGuards(f.subject.baseline)),
      {code:'discovery_assessment_subject_invalid'});
  }
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.store.list('assessment-session').length,0);
});

test('MR.3: a paid checkpoint continuation retains the declared v2 or v3 without upgrading the saved subject', async t=>{
  for(const declaration of [methodologyAssessmentTransport(),requirementsAssessmentTransport()]) await t.test(declaration.contract,async t=>{
    const f=await packetFixture(t),reply=assessmentReply(f);
    reply.methodology.policy=declaration.policy;
    writeFileSync(f.settings,JSON.stringify({tokens:10,replies:[{action:'assessment_checkpoint',notes:['Continue this exact assessment']},reply]}));
    const assessmentSubject={...f.subject,assessment:declaration},sent=f.wires().length;
    const out=await assessmentSessionWithProof(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
      {assessmentSubject,value:{attempts:f.subject.packet.entries},observations:[]},assessmentQuestionContract(assessmentSubject).prompt,
      undefined,baselineGuards(f.subject.baseline));
    assert.ok(out.proof);assert.deepEqual(out.result,reply);
    const requests=f.wires().slice(sent);assert.equal(requests.length,2);
    for(const request of requests) assert.deepEqual(request.subject.assessmentSubject.assessment,declaration);
    assert.deepEqual(out.proof.context.assessmentSubject,assessmentSubject);
    const calls=f.store.list<any>('model-call').filter(row=>row.value.purpose==='assessor'&&row.value.questionId===f.m.question.id);
    assert.equal(calls.length,2);assert.ok(calls.every(row=>row.value.status==='succeeded'));
    assert.ok(calls.every(row=>row.value.assessmentKey===assessmentSubjectKey(assessmentSubject)));
    assert.equal(f.store.list('discovery-assessment').length,0);
  });
});
