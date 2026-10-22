// MR.5: real producer, historical paid recovery, and managed-search proof.
import { referenceSites } from '../src/storage/reference-sites.js';
import { execFileSync } from 'node:child_process';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { researchSetup, rand } from './discovery-v7-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution, completeResearchAttemptTurn, recoverResearchResponse, readResearchConsumerTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { requirementsAssessmentTransport, ATTEMPTS_REQUIREMENTS_INSTRUCTION, type AssessmentTransportSubject } from '../src/discovery/continuation-packet.js';

async function setup(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'archive' }), { v, project, environment, subject, prompt } = f;
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

async function nextPacket(f: Omit<Awaited<ReturnType<typeof setup>>, 'subject'>) {
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
  return {m,subject};
}
async function packetFixture(t: test.TestContext) {
  const f=await setup(t);
  return {...f,...await nextPacket(f)};
}

function assessmentReply(f: Awaited<ReturnType<typeof packetFixture>>) {
  const attempt=f.subject.packet.entries[0]!.attempt;
  return {verdict:'return',reasons:['No sufficient material'],return:{target:{attempt},reason:'Continue research'},
    novelty:{attempts:[{attempt,reason:'No sufficient material'}],accepted:[],rejected:[],newContent:[],duplicates:[],
      noProgress:[{attempt,reason:'No new content'}],transition:null},
    methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[]}};
}

function replyFor(f:Awaited<ReturnType<typeof packetFixture>>,version:'v2'|'v3') {
  const reply=assessmentReply(f);
  reply.methodology.policy=`assessment-methodology-policy/${version==='v3'?'v2':'v1'}`;
  return reply;
}
function request(f:Awaited<ReturnType<typeof packetFixture>>,version:'v2'|'v3',db=f.store) {
  return (version==='v3'?assessAttemptsWithRequirements:assessAttempts)(db,f.subject.packet,f.subject.baseline,f.environment,f.root);
}
async function paidStep(f:Awaited<ReturnType<typeof packetFixture>>,version:'v2'|'v3',action:'terminal'|'assessment_checkpoint'|'read_context') {
  writeFileSync(f.settings,JSON.stringify({tokens:10,...(action==='read_context'?{readArchive:true}:
    {reply:action==='terminal'?replyFor(f,version):{action,notes:['Exact subject continues']}})}));
  const write=f.store.writeMany.bind(f.store),stop=new Error('MR paid boundary');let hit=false;
  f.store.writeMany=((writes,guards=[])=>{
    const result=write(writes,guards);
    if(!hit&&writes.some(w=>w.kind==='model-call'&&(w.value as any).purpose==='assessor'&&(w.value as any).status==='succeeded')){
      hit=true;throw stop;
    }return result;
  }) as typeof f.store.writeMany;
  try {await assert.rejects(request(f,version),error=>error===stop);}finally{f.store.writeMany=write;}
  assert.ok(hit);
  const call=f.store.list<any>('model-call').find(row=>row.value.purpose==='assessor'&&row.value.draftId===f.m.draft.id)!;
  const claim=f.store.get<any>(call.id,1)!,application=f.store.get<any>(claim.value.assessmentApplication.id,1)!;
  const session=f.store.get<any>(application.value.session.id,application.value.session.revision)!;
  return {call,application,session};
}

for(const version of ['v2','v3'] as const) for(const action of ['terminal','assessment_checkpoint','read_context'] as const) {
  test(`MR.5: selected paid ${version} ${action} recovers after reopen under the original declaration without dispatch`,async t=>{
    const f=await packetFixture(t),selected=await paidStep(f,version,action);
    // The new factory is available, but recovering an already selected physical
    // receipt must use its persisted version rather than the new default.
    assert.equal(requirementsAssessmentTransport().contract,'discovery-assessment/v3');
    const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
    f.discovery.reopen(f.m.question.id,f.m.question.revision);
    const receipt=await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner');
    const after=f.store.get<any>(receipt.value.sessionAfter.id,receipt.value.sessionAfter.revision)!;
    assert.equal(f.store.get<any>(selected.application.id)!.value.state,'applied');
    assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
    assert.equal(f.store.list('assessment-session').length,1);
    if(action==='terminal') {
      const saved=f.store.list<any>('discovery-assessment')[0]!;
      assert.equal(saved.value.contract,`discovery-assessment/${version}`);
      assert.equal(saved.value.methodology.policy,`assessment-methodology-policy/${version==='v3'?'v2':'v1'}`);
      assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
      assert.deepEqual(await request(f,version,f.open()),saved);
    } else {
      assert.equal(after.value.result,null);
      if(action==='assessment_checkpoint') assert.equal(after.value.notes.length,1);
      else assert.equal(after.value.workspace.entries.length,1);
      writeFileSync(f.settings,JSON.stringify({tokens:10,reply:replyFor(f,version)}));
      await assert.rejects(request(f,version,f.open()),{code:'input_stale'});
    }
    const snapshot=f.store.list().flatMap(row=>f.store.history(row.id));
    assert.deepEqual(await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner'),receipt);
    assert.deepEqual(f.store.list().flatMap(row=>f.store.history(row.id)),snapshot);
    assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  });
}
for(const action of ['assessment_checkpoint','read_context'] as const) {
  test(`MR.5: cold v3 resume applies ${action} historically then sends only the guarded continuation`,async t=>{
    const f=await packetFixture(t),selected=await paidStep(f,'v3',action),sent=f.wires().length;
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply:replyFor(f,'v3')}));
    const saved=await request(f,'v3',f.open());
    assert.equal(saved.value.contract,'discovery-assessment/v3');
    assert.equal(f.wires().length,sent+1);
    assert.equal(f.store.list('assessment-session').length,1);
    assert.equal(f.store.get<any>(selected.application.id)!.value.state,'applied');
    assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
  });
}

test('MR.5: activation of a real v3 assessment cannot upgrade or redispatch an already selected paid v2 terminal',async t=>{
  const f=await packetFixture(t),selected=await paidStep(f,'v2','terminal');
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:replyFor(f,'v3')}));
  const current=await request(f,'v3');assert.equal(current.value.contract,'discovery-assessment/v3');
  const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  f.discovery.reopen(f.m.question.id,f.m.question.revision);
  await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner');
  const historical=f.store.list<any>('discovery-assessment').find(row=>row.value.contract==='discovery-assessment/v2')!;
  assert.ok(historical);assert.equal(historical.value.methodology.policy,'assessment-methodology-policy/v1');
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(historical)),historical);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(current)),current);
  assert.deepEqual(await request(f,'v2',f.open()),historical);
  assert.equal(f.store.list('assessment-session').length,2);
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});
async function factPacketFixture(t: test.TestContext, fact = true) {
  const f=await setup(t);
  const source=fact?f.discovery.evidence.document('p','measurement',JSON.stringify({fact:'Measured throughput is 42',published:'2026-10-20',version:'2.1'}),'application/json',0):null;
  if(source) writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'answer',question:'q-industry',citations:[],
    value:{type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'fact-throughput',kind:'fact',
      text:'Measured throughput is 42',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
      scope:{variants:'common'},basis:{source:{ref:reference(source),range:{start:0,end:source.value.content.length},valueHash:hashJson(source.value.content)},
        limit:'Measured deployment',asOf:'2026-10'}}]}}}}));
  return {...f,...await nextPacket(f),source};
}

function closedReply(f: Awaited<ReturnType<typeof factPacketFixture>>) {
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

function assessmentRequest(f:Awaited<ReturnType<typeof factPacketFixture>>,db=f.store) {
  return assessAttemptsWithRequirements(db,f.subject.packet,f.subject.baseline,f.environment,f.root);
}
test('MR.5: requirements survive real adapter, paid application and cold exact reader without applying progress',async t=>{
  const f=await factPacketFixture(t,true),reply=closedReply(f);
  writeFileSync(f.settings,JSON.stringify({tokens:10,readSource:true,reply}));
  const saved=await assessmentRequest(f);
  assert.equal(saved.value.contract,'discovery-assessment/v3');
  assert.deepEqual(saved.value.novelty.transition,reply.novelty.transition);
  assert.deepEqual(saved.value.methodology,reply.methodology);
  assert.deepEqual(referenceSites('discovery-assessment',saved.value).find(site=>
    site.field==='novelty.transition.sufficiency.methodologyRequirements[0].claim.container')?.ref,
    reply.novelty.transition.sufficiency.methodologyRequirements[0]!.claim.container);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
  const request=f.wires().at(-1);
  assert.equal(request.subject.assessmentSubject.assessment.contract,'discovery-assessment/v3');
  assert.equal(request.subject.assessmentSubject.assessment.policy,'assessment-methodology-policy/v2');
  assert.ok(request.prompt.includes(ATTEMPTS_REQUIREMENTS_INSTRUCTION));
  const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  assert.deepEqual(await assessmentRequest(f,f.open()),saved);
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.store.list('v7-progress-state').length,0);
});
async function performedSearch(f:Awaited<ReturnType<typeof factPacketFixture>>) {
  execFileSync('git',['init','--quiet',f.root]);
  writeFileSync(join(f.root,'original.txt'),'Original measurement only.');
  execFileSync('git',['-C',f.root,'add','original.txt']);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'search',query:'counterargument'}}));
  const m=f.prepare(),response=await m.invoke(),execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:1,context:m.context,subject:m.selected});
  const id=managedTurnId(m.run.id,1),application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const turn=f.store.get<any>(id)!,result=new ResearchSources(f.store,'p',f.environment.value.workspace).searchCaptured('counterargument',turn);
  f.store.writeMany([result.capture,{id,kind:'research-turn',expected:turn.revision,value:result.turn}],result.guards);
  return {turn:reference(f.store.get(id)!),capture:result.captureRef};
}
test('MR.5: a real performed search remains provable inside captured paid assessment reads and after filesystem changes',async t=>{
  const f=await factPacketFixture(t,true),trace=await performedSearch(f),reply:any=closedReply(f);
  reply.methodology.facts[0]!.refutation={status:'performed',reason:'Executed the declared local search',traces:[trace],counterarguments:[],limitations:[]};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const saved=await assessmentRequest(f),sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  writeFileSync(join(f.root,'original.txt'),'New filesystem bytes after payment');
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
  assert.deepEqual(await assessmentRequest(f,f.open()),saved);
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

test('MR.5: forged exact search/capture links are refused before saving a v3 assessment', async t=>{
  const f=await factPacketFixture(t),trace=await performedSearch(f),reply=closedReply(f);
  const valid:any=JSON.parse(JSON.stringify(reply));
  valid.methodology.facts[0].refutation={status:'performed',reason:'Actual saved search',traces:[trace],counterarguments:[],limitations:[]};
  for(const field of ['turn','capture']) {
    const invalid=JSON.parse(JSON.stringify(valid));
    invalid.methodology.facts[0].refutation.traces[0][field].hash='0'.repeat(64);
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply:invalid}));
    await assert.rejects(assessmentRequest(f),(error:any)=>{
      assert.equal(error.code,field==='turn'?'research_consumer_intent_invalid':'discovery_novelty_invalid');
      assert.ok(error.message.includes(field==='turn'?trace.turn.id:'methodology.facts.0.refutation.traces.0.capture'));
      return true;
    });
    assert.equal(f.store.list('discovery-assessment').length,0);
  }
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:valid}));
  const saved=await assessmentRequest(f),sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
  assert.deepEqual(await assessmentRequest(f,f.open()),saved);
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

// Negative-only views of genuine saved search bytes. They do not create a paid
// planner/child; a positive v7 child belongs to the real runner in S6.4.
test('MR.5: a masqueraded queued search with a changed parent or missing queue refuses without scanning heads', async t=>{
  const f=await factPacketFixture(t),search=await performedSearch(f);
  const completed=f.store.get<any>(search.turn.id,search.turn.revision)!,original=f.store.get<any>(search.turn.id,1)!;
  const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  for(const mode of ['changed parent','missing queue','malformed parent']) {
    const parentValue={...original.value};delete parentValue.subject;
    const parent={...original,value:parentValue,hash:hashJson(parentValue)};
    const plannedBy:any={...reference(parent),...(mode==='changed parent'?{hash:'0'.repeat(64)}:{})};
    if(mode==='malformed parent') delete plannedBy.hash;
    const id=`negative-queued-search:${mode}`;
    const value:any={...original.value,plannedBy};
    for(const field of ['contract','subject','consumerIntent','acceptanceContract','acceptanceBinding','attemptContract','attempt','attemptBinding']) delete value[field];
    const pending={...original,id,value,hash:hashJson(value)};
    const doneValue={...value,status:'completed',observation:completed.value.observation,error:null};
    const done={...completed,id,value:doneValue,hash:hashJson(doneValue)};
    let scans=0;
    const view={get:(key:string,revision?:number)=>key===id?(revision===1?pending:done)
      :key===parent.id?(revision===1?parent:null):f.store.get(key,revision),
      list:()=>{scans++;throw new Error('No head scan may prove this queued parent');}} as unknown as Store;
    assert.throws(()=>readResearchConsumerTurn(view,reference(done)),(error:any)=>{
      assert.equal(error.code,'research_consumer_intent_invalid');
      assert.ok(error.message.includes('The planned search lost its exact managed queue'));return true;
    });
    assert.equal(scans,0);
  }
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});
