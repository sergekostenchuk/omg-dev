// MR.4 derives a form from the shared producer's exact paid application.
// It does not persist a discovery assessment or apply progress (MR.5/P).
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
import { projectAttemptPacket, v7ProgressStateId, checkDiscoveryAssessmentForm } from '../src/discovery/v7-attempt-assessment.js';
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
import { methodologyAssessmentTransport, requirementsAssessmentTransport, assessmentQuestionContract, assessmentSubjectKey } from '../src/discovery/continuation-packet.js';
import { projectPaidAttemptsAssessment, discoveryAssessmentId } from '../src/discovery/research-consumer-transition.js';
import { baselineGuards } from '../src/discovery/v7-attempt-assessment.js';
function assessmentReply(f: Awaited<ReturnType<typeof packetFixture>>) {
  const attempt=f.subject.packet.entries[0]!.attempt;
  return {verdict:'return',reasons:['No sufficient material'],return:{target:{attempt},reason:'Continue research'},
    novelty:{attempts:[{attempt,reason:'No sufficient material'}],accepted:[],rejected:[],newContent:[],duplicates:[],
      noProgress:[{attempt,reason:'No new content'}],transition:null},
    methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}function closedReply(f: Awaited<ReturnType<typeof packetFixture>>) {
  const source=f.source!,attempt=f.subject.packet.entries[0]!.attempt;
  const claim={project:'p',container:attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'fact-throughput'};
  const evidence=(pointer:string)=>({source:reference(source),selector:{kind:'json-pointer',pointer}});
  return {verdict:'supported',reasons:['Measured evidence'],return:null,
    novelty:{attempts:[{attempt,reason:'Reviewed'}],accepted:[{claim,reason:'Measurement'}],rejected:[],
      newContent:[{claim,reason:'New measurement'}],duplicates:[],noProgress:[],
      transition:{outcome:'closed',bases:[{claim}],reason:'Measurement addresses the saved criterion',
        sufficiency:{criterion:f.questions[0]!.criterion,requiredDepth:f.questions[0]!.requiredDepth,reason:'Measured deployment',
          methodologyRequirements:[{claim,dated:true,versioned:true,independentConfirmation:false,
            reason:'This criterion concerns this dated version of the original deployment'}]}}},
    methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[{
      claim,significance:{kind:'blocking',reason:'Required measurement'},sources:[{source:reference(source),role:'primary',reason:'Original measurement',
        evidence:[evidence('/fact')],original:reference(source),originalReason:'Original report',limitation:null,
        publicationDate:{status:'known',value:'2026-10-20',evidence:[evidence('/published')]},
        eventDate:{status:'unknown',reason:'Event day unreported'},version:{status:'known',value:'2.1',evidence:[evidence('/version')]},retrievedAt:null}],
      temporalApplicability:{status:'established',scope:'Measured deployment',reason:'Dated measurement',evidence:[evidence('/published')]},
      corroboration:{status:'single_confirmation',reason:'One original',limitation:'Independent confirmation unavailable'},
      refutation:{status:'not_performed',reason:'Search not yet performed',traces:[],counterarguments:[],limitations:['Search remains']}}]}};
}

async function paidProjection(f: Awaited<ReturnType<typeof packetFixture>>, declaration=requirementsAssessmentTransport() as
  ReturnType<typeof requirementsAssessmentTransport>|ReturnType<typeof methodologyAssessmentTransport>) {
  const subject={...f.subject,assessment:declaration};
  const out=await assessmentSessionWithProof(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
    {assessmentSubject:subject,value:{attempts:f.subject.packet.entries},observations:[]},assessmentQuestionContract(subject).prompt,
    undefined,baselineGuards(f.subject.baseline));
  assert.ok(out.proof);
  const input={subject,session:out.proof.session,application:out.proof.application,environment:out.proof.environment,
    assessor:out.proof.role.actor,result:out.result};
  return {input, projected:projectPaidAttemptsAssessment(input), proof:out.proof};
}

test('MR.4: exact paid application projects the same v3 requirements and address on repeated reads', async t=>{
  const f=await packetFixture(t,true),reply=closedReply(f);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const {input,projected,proof}=await paidProjection(f);
  assert.equal(projected.value.contract,'discovery-assessment/v3');
  assert.deepEqual(projected.value.novelty.transition,reply.novelty.transition);
  assert.deepEqual(projected.value.methodology,reply.methodology);
  assert.deepEqual(projected.value.session,proof.session);assert.deepEqual(projected.value.application,proof.application);
  assert.deepEqual(projected.value.environment,proof.environment);assert.equal(projected.value.assessor,proof.role.actor);
  assert.equal(projected.id,discoveryAssessmentId(projected.value));assert.ok(projected.id.startsWith('discovery-assessment:v3:'));
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store,projected.value).value,projected.value);
  const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  assert.deepEqual(projectPaidAttemptsAssessment(input),projected);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,sent);
  assert.equal(f.store.list('discovery-assessment').length,0);assert.equal(f.store.list('v7-progress-state').length,0);
  const mixed:any=JSON.parse(JSON.stringify(input));mixed.result.methodology.policy='assessment-methodology-policy/v1';
  assert.throws(()=>projectPaidAttemptsAssessment(mixed),{code:'discovery_novelty_invalid'});
  const incomplete:any=JSON.parse(JSON.stringify(input));delete incomplete.result.novelty.transition.sufficiency.methodologyRequirements;
  assert.throws(()=>projectPaidAttemptsAssessment(incomplete),{code:'discovery_novelty_invalid'});
});

test('MR.4: correction of incomplete requirements retains the exact original subject', async t=>{
  const f=await packetFixture(t,true),valid=closedReply(f),invalid:any=JSON.parse(JSON.stringify(valid));
  delete invalid.novelty.transition.sufficiency.methodologyRequirements[0].dated;
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:invalid}));
  const sent=f.wires().length;
  await assert.rejects(paidProjection(f),{code:'discovery_novelty_invalid'});
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:valid}));
  const {input,projected}=await paidProjection(f);
  assert.deepEqual(projected.value.novelty.transition,valid.novelty.transition);
  const requests=f.wires().slice(sent);assert.equal(requests.length,2);
  for(const request of requests) assert.deepEqual(request.subject.assessmentSubject,input.subject);
  assert.equal(requests[1].subject.failures[0].code,'discovery_novelty_invalid');
  assert.equal(assessmentSubjectKey(requests[0].subject.assessmentSubject),assessmentSubjectKey(input.subject));
  assert.equal(assessmentSubjectKey(requests[1].subject.assessmentSubject),assessmentSubjectKey(input.subject));
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store,projected.value).value,projected.value);
});

test('MR.4: historical v2 paid projection keeps its old contract, policy and deterministic address', async t=>{
  const f=await packetFixture(t),reply=assessmentReply(f);reply.methodology.policy='assessment-methodology-policy/v1';
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const {projected}=await paidProjection(f,methodologyAssessmentTransport());
  assert.equal(projected.value.contract,'discovery-assessment/v2');
  assert.equal(projected.value.methodology.policy,'assessment-methodology-policy/v1');
  assert.equal(projected.id,`discovery-assessment:v2:${hashJson({projectId:'p',session:projected.value.session,application:projected.value.application})}`);
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store,projected.value).value,projected.value);
});
