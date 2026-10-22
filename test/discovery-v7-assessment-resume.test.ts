import { assessAttempts, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { reference } from '../src/pipeline/contracts.js';
import { researchSetup, rand } from './discovery-v7-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution, completeResearchAttemptTurn, recoverResearchResponse, readResearchResponse, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT, readArchiveBody } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { type AssessmentTransportSubject } from '../src/discovery/continuation-packet.js';

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
function assessmentRequest(f:Awaited<ReturnType<typeof packetFixture>>,db=f.store) {
  return assessAttempts(db,f.subject.packet,f.subject.baseline,f.environment,f.root);
}

for(const boundary of ['prepared','paid','applied','assessment'] as const) {
  test(`A: cold recovery at ${boundary} keeps the original paid assessment without another call`,async t=>{
    const f=await packetFixture(t);writeFileSync(f.settings,JSON.stringify({tokens:10,reply:assessmentReply(f)}));
    const sent=f.wires().length,write=f.store.writeMany.bind(f.store),stop=new Error(`stop:${boundary}`);
    let hit=false;
    f.store.writeMany=((writes,guards=[])=>{
      const match=writes.some(w=>boundary==='prepared'?w.kind==='assessment-session'&&w.expected===0:
        boundary==='paid'?w.kind==='model-call'&&(w.value as any).purpose==='assessor'&&(w.value as any).status==='succeeded':
        boundary==='applied'?w.kind==='assessment-application'&&(w.value as any).state==='applied':w.kind==='discovery-assessment');
      if(match&&boundary==='assessment'&&!hit){hit=true;throw stop;}
      const out=write(writes,guards);
      if(match&&!hit){hit=true;throw stop;}return out;
    }) as typeof f.store.writeMany;
    try {await assert.rejects(assessmentRequest(f),error=>error===stop);}finally{f.store.writeMany=write;}
    assert.ok(hit);
    const charged=f.wires().length,ledgers=f.store.list('research-budget-ledger');
    if(boundary!=='prepared') f.discovery.reopen(f.m.question.id,f.m.question.revision);
    const assessment=await assessmentRequest(f,f.open());
    assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(assessment)),assessment);
    assert.equal(f.wires().length,sent+1);
    if(boundary!=='prepared'){assert.equal(f.wires().length,charged);assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);}
    assert.deepEqual(await assessmentRequest(f,f.open()),assessment);
    assert.equal(f.store.list('discovery-assessment').length,1);assert.equal(f.wires().length,sent+1);
  });
}

test('A: new dispatch on a moved plan is refused before payment',async t=>{
  const f=await packetFixture(t),sent=f.wires().length;
  f.discovery.reopen(f.m.question.id,f.m.question.revision);
  await assert.rejects(assessmentRequest(f),{code:'input_stale'});
  assert.equal(f.wires().length,sent);assert.equal(f.store.list('discovery-assessment').length,0);
});

for (const boundary of ['paid','saved'] as const) {
  test(`A: corruption of the baseline address after ${boundary} preserves paid recovery and blocks a fresh dispatch`, async t => {
    const f=await packetFixture(t), next=await nextPacket(f), sent=f.wires().length;
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply:assessmentReply(f)}));
    let before: Awaited<ReturnType<typeof assessmentRequest>> | undefined;
    if (boundary === 'paid') {
      const write=f.store.writeMany.bind(f.store), stop=new Error('after payment');
      let hit=false;
      f.store.writeMany=((writes,guards=[])=>{
        const result=write(writes,guards);
        if (!hit && writes.some(w=>w.kind==='model-call' && (w.value as any).purpose==='assessor'
          && (w.value as any).status==='succeeded')) { hit=true; throw stop; }
        return result;
      }) as typeof f.store.writeMany;
      try { await assert.rejects(assessmentRequest(f), error=>error===stop); }
      finally { f.store.writeMany=write; }
      assert.ok(hit);
    } else before=await assessmentRequest(f);
    const paidLedgers=f.store.list('research-budget-ledger');
    // Deliberate negative corruption, NOT a lawful progress state or a P fixture.
    assert.equal(f.subject.baseline.state.kind,'absent');
    f.store.write({id:v7ProgressStateId(f.subject.packet),kind:'corrupt-baseline-address',expected:0,value:null});
    const snapshot=f.store.list().flatMap(r=>f.store.history(r.id));
    const saved=await assessmentRequest(f,f.open());
    if(before) {
      assert.deepEqual(saved,before);
      assert.deepEqual(f.store.list().flatMap(r=>f.store.history(r.id)),snapshot);
    }
    assert.deepEqual(saved.value.subject.packet,f.subject.packet);
    assert.deepEqual(saved.value.baseline,f.subject.baseline);
    assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
    assert.equal(f.wires().length,sent+1);
    assert.deepEqual(f.store.list('research-budget-ledger'),paidLedgers);
    const admissionHistory=()=>['model-call','research-budget-ledger','assessment-session','assessment-application','discovery-assessment']
      .flatMap(kind=>f.store.list(kind).flatMap(r=>f.store.history(r.id)));
    const beforeDispatch=admissionHistory();
    await assert.rejects(assessAttempts(f.open(),next.subject.packet,next.subject.baseline,f.environment,f.root),{code:'input_stale'});
    assert.equal(f.wires().length,sent+1);
    assert.deepEqual(admissionHistory(),beforeDispatch);
    // The failed new preflight can archive its candidate, but cannot admit an
    // application/call or reserve a ledger. An exact paid replay is read-only.
    const afterRefusal=f.store.list().flatMap(r=>f.store.history(r.id));
    assert.deepEqual(await assessmentRequest(f,f.open()),saved);
    assert.deepEqual(f.store.list().flatMap(r=>f.store.history(r.id)),afterRefusal);
  });
}

test('A: a paid stage overrun still produces its assessment and replays without a new ledger assignment', async t => {
  const f=await packetFixture(t),next=await nextPacket(f),sent=f.wires().length;
  writeFileSync(f.settings,JSON.stringify({tokens:20000002,reply:assessmentReply(f)}));
  const saved=await assessmentRequest(f);
  assert.equal(f.wires().length,sent+1);
  assert.equal(f.store.list('budget-incident').length,1);
  const ledgers=f.store.list('research-budget-ledger');
  assert.deepEqual(await assessmentRequest(f,f.open()),saved);
  await assert.rejects(assessAttempts(f.open(),next.subject.packet,next.subject.baseline,f.environment,f.root),
    {code:'discovery_budget_overrun'});
  assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
  assert.equal(f.wires().length,sent+1);
});

function selectedAssessmentStep(f: Awaited<ReturnType<typeof packetFixture>>) {
  const call=f.store.list<any>('model-call').find(row=>row.value.purpose==='assessor'&&row.value.draftId===f.m.draft.id)!;
  assert.ok(call);
  const claim=f.store.get<any>(call.id,1)!, application=f.store.get<any>(claim.value.assessmentApplication.id,1)!;
  const session=f.store.get<any>(application.value.session.id,application.value.session.revision)!;
  return {call,application,session};
}

async function interruptPaidAssessment(f: Awaited<ReturnType<typeof packetFixture>>, reply: Record<string,unknown>) {
  writeFileSync(f.settings,JSON.stringify({tokens:10,...reply}));
  const write=f.store.writeMany.bind(f.store),stop=new Error('intermediate paid');let hit=false;
  f.store.writeMany=((writes,guards=[])=>{
    const result=write(writes,guards);
    if(!hit&&writes.some(w=>w.kind==='model-call'&&(w.value as any).purpose==='assessor'&&(w.value as any).status==='succeeded')){
      hit=true;throw stop;
    }return result;
  }) as typeof f.store.writeMany;
  try{await assert.rejects(assessmentRequest(f),error=>error===stop);}finally{f.store.writeMany=write;}
  assert.ok(hit);
  return selectedAssessmentStep(f);
}

for (const boundary of ['paid','applied','saved'] as const) {
  test(`A: operator recovery at ${boundary} proves its original paid step after plan and baseline heads move`,async t=>{
    const f=await packetFixture(t),reply=assessmentReply(f);
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
    if(boundary==='saved') await assessmentRequest(f);
    else {
      const write=f.store.writeMany.bind(f.store),stop=new Error(`operator:${boundary}`);let hit=false;
      f.store.writeMany=((writes,guards=[])=>{
        if(boundary==='applied'&&writes.some(w=>w.kind==='discovery-assessment')){hit=true;throw stop;}
        const result=write(writes,guards);
        if(boundary==='paid'&&writes.some(w=>w.kind==='model-call'&&(w.value as any).purpose==='assessor'
          &&(w.value as any).status==='succeeded')){hit=true;throw stop;}
        return result;
      }) as typeof f.store.writeMany;
      try{await assert.rejects(assessmentRequest(f),error=>error===stop);}finally{f.store.writeMany=write;}
      assert.ok(hit);
    }
    const selected=selectedAssessmentStep(f),sent=f.wires().length,ledgers=f.store.list('research-budget-ledger');
    f.discovery.reopen(f.m.question.id,f.m.question.revision);
    // Negative address corruption, not a fabricated lawful P transition.
    f.store.write({id:v7ProgressStateId(f.subject.packet),kind:'corrupt-baseline-address',expected:0,value:null});
    const db=f.open(),receipt=await recoverResearchResponse(db,f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner');
    const assessment=db.list<any>('discovery-assessment')[0]!;
    assert.ok(assessment);assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(assessment)),assessment);
    assert.deepEqual(receipt.value.sessionBefore,reference(selected.session));assert.deepEqual(receipt.value.call,reference(selected.call));
    assert.deepEqual(receipt.value.sessionAfter,assessment.value.session);assert.equal(f.wires().length,sent);
    assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
    const snapshot=f.store.list().flatMap(row=>f.store.history(row.id));
    assert.deepEqual(await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner'),receipt);
    assert.deepEqual(f.store.list().flatMap(row=>f.store.history(row.id)),snapshot);
    await assert.rejects(recoverResearchResponse(f.open(),f.engine.environments,'foreign',reference(selected.call),reference(selected.session),'owner'),
      {code:'response_recovery_session_stale'});
    const wrongSession={...selected.session.value,binding:{...selected.session.value.binding}};
    const forged=f.store.write({id:'assessment-session:v1:forged',kind:'assessment-session',expected:0,value:wrongSession});
    assert.throws(()=>readResearchResponse(f.open(),'p',reference(selected.call),forged as any,f.m.draft,f.m.question,
      selected.application.value.role,null),{code:'response_recovery_cursor_stale'});
    f.store.write({id:receipt.id,kind:receipt.kind,expected:receipt.revision,value:{...receipt.value,sessionAfter:reference(forged)}});
    await assert.rejects(recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner'),
      {code:'response_recovery_invalid'});
    assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
  });
}

for (const action of ['assessment_checkpoint','read_context'] as const) {
  for (const resume of ['operator','cold'] as const) {
    for (const move of ['none','reopen','corrupt-baseline'] as const) {
      const name=action==='assessment_checkpoint'&&resume==='operator'&&move==='none'
        ?'A: operator recovery of a paid checkpoint cannot send the next assessment request'
        :`A: ${resume} applies a paid ${action} on its historical basis after ${move}`;
      test(name,async t=>{
        const f=await packetFixture(t);
        const checkpoint={action:'assessment_checkpoint',notes:['Exact attempt needs another page']};
        const selected=await interruptPaidAssessment(f,action==='read_context'?{readArchive:true}:{reply:checkpoint});
        const sent=f.wires().length,ledgers=f.store.list('research-budget-ledger');
        if(move==='reopen') f.discovery.reopen(f.m.question.id,f.m.question.revision);
        // A negative address corruption; lawful progress-state production remains P.
        if(move==='corrupt-baseline') f.store.write({id:v7ProgressStateId(f.subject.packet),kind:'corrupt-baseline-address',expected:0,value:null});
        writeFileSync(f.settings,JSON.stringify({tokens:10,reply:assessmentReply(f)}));
        let receipt: Awaited<ReturnType<typeof recoverResearchResponse>> | undefined;
        if(resume==='operator') receipt=await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner');
        else if(move==='none') {
          const saved=await assessmentRequest(f,f.open());
          assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
        } else await assert.rejects(assessmentRequest(f,f.open()),{code:'input_stale'});
        const applied=f.store.get<any>(selected.application.id)!;
        assert.equal(applied.value.state,'applied');
        assert.deepEqual(applied.value.received,reference(selected.call));
        const after=f.store.get<any>(applied.value.after.id,applied.value.after.revision)!;
        assert.equal(after.revision,selected.session.revision+1);assert.equal(after.value.result,null);
        if(action==='assessment_checkpoint') {
          assert.deepEqual(after.value.notes,[{evidence:{offset:0,end:2},packet:selected.call.value.packet.archive,response:checkpoint}]);
        } else {
          assert.deepEqual(after.value.notes,[]);
          const entries=after.value.workspace.entries;
          assert.equal(entries.length,1);
          assert.deepEqual(entries[0].result.record,selected.call.value.packet.archive);
          assert.equal(entries[0].result.pointer,'/body/value');
          const archive=f.store.get(selected.call.value.packet.archive.id,selected.call.value.packet.archive.revision)!;
          assert.deepEqual(entries[0].result.value,readArchiveBody(f.store,archive).body.value);
          assert.equal(after.value.workspace.blocked,undefined);
        }
        const terminal=resume==='cold'&&move==='none';
        assert.equal(f.wires().length,sent+(terminal?1:0));
        if(!terminal) assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
        assert.equal(f.store.list('discovery-assessment').length,terminal?1:0);
        // A cold normal resume may have applied the checkpoint without an operator
        // receipt. The operator proves that exact step without applying it twice.
        receipt??=await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner');
        assert.deepEqual(receipt.value.sessionAfter,reference(after));
        const snapshot=f.store.list().flatMap(row=>f.store.history(row.id));
        assert.deepEqual(await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner'),receipt);
        assert.deepEqual(f.store.list().flatMap(row=>f.store.history(row.id)),snapshot);
        if(move==='none') {
          if(!terminal) {
            const saved=await assessmentRequest(f,f.open());
            assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
            assert.equal(f.wires().length,sent+1);
          }
        } else {
          // Fresh dispatch keeps current plan/baseline guards. A stale retry
          // cannot rewrite the paid application, create its next application,
          // change the cursor, or reserve another ledger entry.
          for(let repeat=0;repeat<2;repeat++) await assert.rejects(assessmentRequest(f,f.open()),{code:'input_stale'});
          assert.deepEqual(f.store.list().flatMap(row=>f.store.history(row.id)),snapshot);
          assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
          assert.equal(f.store.get(after.value.application),null);
        }
      });
    }
  }
}

test('A: a missing next application is not authority for an invented attempts cursor',async t=>{
  const f=await packetFixture(t);
  const selected=await interruptPaidAssessment(f,{reply:{action:'assessment_checkpoint',notes:['Saved intermediate judgment']}});
  const receipt=await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner');
  const after=f.store.get<any>(receipt.value.sessionAfter.id,receipt.value.sessionAfter.revision)!;
  const sent=f.wires().length,ledgers=f.store.list('research-budget-ledger');
  const {application:_application,...withoutApplication}=after.value;
  // Deliberately corrupt the cursor; none of these writes is positive proof.
  for(const value of [withoutApplication,{...after.value,application:['not-a-string']},
    {...after.value,application:'invented-next-application'},after.value]) {
    const head=f.store.get(after.id)!;
    f.store.write({id:after.id,kind:after.kind,expected:head.revision,value});
    const snapshot=f.store.list().flatMap(row=>f.store.history(row.id));
    await assert.rejects(assessmentRequest(f,f.open()),{code:'research_context_application_invalid'});
    assert.deepEqual(f.store.list().flatMap(row=>f.store.history(row.id)),snapshot);
  }
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
});

test('A: historical application of read_context rejects a corrupted archive address',async t=>{
  const f=await packetFixture(t);
  const selected=await interruptPaidAssessment(f,{readArchive:true,corruptReadArchive:true});
  f.discovery.reopen(f.m.question.id,f.m.question.revision);
  const sent=f.wires().length,ledgers=f.store.list('research-budget-ledger');
  await assert.rejects(recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner'),
    {code:'research_context_application_refused'});
  const application=f.store.get<any>(selected.application.id)!;
  assert.equal(application.value.state,'refused');assert.equal(application.value.refusal.kind,'response');
  assert.deepEqual(application.value.received,reference(selected.call));
  assert.equal(f.store.list('research-response-recovery').length,0);
  assert.equal(f.store.list('discovery-assessment').length,0);
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
});
