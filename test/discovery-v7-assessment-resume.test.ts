import { assessAttempts, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { type Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, recoverResearchResponse, readResearchResponse, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { type AssessmentTransportSubject } from '../src/discovery/continuation-packet.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3ba-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

const rand = () => Math.random().toString(16).slice(2);
const allAxes = (depth: string) => Object.fromEntries(V7_AXES.map(axis => [axis, { depth }]));

function validFrame(): Json {
  return { productType: "internal", scale: "30 users across 10 sites",
    industries: ["construction"], domains: ["materials supply", "equipment accounting"],
    axes: allAxes("deep"),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } };
}
type PlanQuestion = { id: string; axis: string; domain: string; text: string; class: string;
  criterion: string; requiredDepth: string; roles: string[]; searchPlaces: string[] };
function planQuestion(id: string, axis: string, cls = "supporting"): PlanQuestion {
  return { id, axis, domain: "construction", text: `What covers ${id}?`,
    class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
    roles: ["domain expert"], searchPlaces: ["domain documents"] };
}
function validPlan(frameRef: Ref, questions: PlanQuestion[], edition = 1, previous: Ref | null = null): Json {
  return { edition, frame: frameRef, previous, questions } as unknown as Json;
}
function questionOf(store: Store, draft: Revision<DiscoveryDraft>, field: string): Revision<Question> {
  const question = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field);
  assert.ok(question, `question for ${field}`);
  return question;
}
/** The real plan acceptance chain (frame and plan through #answer). */
function acceptPlan(f: Fixture, project: string, questions: PlanQuestion[]) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, questions), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
async function setup(t: test.TestContext) {
  const f = fixture(t), project = 'p', wire = join(f.root,'wire.ndjson'), adapter = join(f.root,'adapter.mjs');
  const settings = join(f.root,'reply.json');
  writeFileSync(settings,JSON.stringify({tokens:10}));
  writeFileSync(adapter, `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const queued=settings.replies?.shift();if(queued)writeFileSync(${JSON.stringify(settings)},JSON.stringify(settings));
const research=queued??settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:settings.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = {executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure(project,{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:10000},0);
  const old=f.discovery.create(project,'discovery','R0','concept',[
    {field:'probe',kind:'fact',prompt:'Calibrate',risk:'unknown',schema:{type:'object'}}],[],6);
  const q=f.store.get<Question>(old.value.questions[0]!)!;
  await researchCall(environment.value.implementer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:old.id,questionId:q.id,purpose:'analyst'});
  await researchCall(environment.value.reviewer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:old.id,questionId:q.id,purpose:'assessor'});
  const questions=[planQuestion('q-industry','industry','blocking'),planQuestion('q-market','market')];
  const v=acceptPlan(f,project,questions);
  const subject=(id='q-industry',answer=v.planAnswer):V7PlanSubject=>({contract:V7_PLAN_SUBJECT_CONTRACT,planAnswer:answer,planQuestionId:id});
  const prompt='Research the selected plan question; return an answer with a V7AttemptEnd value and empty citations.';
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
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,project,questions,subject,prepare,wires,environment,prompt,settings};
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

test('A: operator recovery of a paid checkpoint cannot send the next assessment request',async t=>{
  const f=await packetFixture(t);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'assessment_checkpoint',notes:['Exact attempt needs another page']}}));
  const write=f.store.writeMany.bind(f.store),stop=new Error('checkpoint paid');let hit=false;
  f.store.writeMany=((writes,guards=[])=>{
    const result=write(writes,guards);
    if(!hit&&writes.some(w=>w.kind==='model-call'&&(w.value as any).purpose==='assessor'&&(w.value as any).status==='succeeded')){
      hit=true;throw stop;
    }return result;
  }) as typeof f.store.writeMany;
  try{await assert.rejects(assessmentRequest(f),error=>error===stop);}finally{f.store.writeMany=write;}
  assert.ok(hit);
  const selected=selectedAssessmentStep(f),sent=f.wires().length,ledgers=f.store.list('research-budget-ledger');
  const receipt=await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner');
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
  assert.equal(f.store.list('discovery-assessment').length,0);
  const after=f.store.get<any>(receipt.value.sessionAfter.id,receipt.value.sessionAfter.revision)!;
  assert.equal(after.value.result,null);
  assert.deepEqual(after.value.notes,[{evidence:{offset:0,end:2},packet:selected.call.value.packet.archive,
    response:{action:'assessment_checkpoint',notes:['Exact attempt needs another page']}}]);
  const snapshot=f.store.list().flatMap(row=>f.store.history(row.id));
  assert.deepEqual(await recoverResearchResponse(f.open(),f.engine.environments,'p',reference(selected.call),reference(selected.session),'owner'),receipt);
  assert.deepEqual(f.store.list().flatMap(row=>f.store.history(row.id)),snapshot);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:assessmentReply(f)}));
  const assessment=await assessmentRequest(f,f.open());
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(assessment)),assessment);assert.equal(f.wires().length,sent+1);
});
