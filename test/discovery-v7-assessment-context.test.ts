import { assessmentSession, assessmentRolePrompt } from '../src/discovery/assessment-session.js';
import { contextWorkspace } from '../src/discovery/context-workspace.js';
import { readRequestWire } from '../src/discovery/request-parts.js';
import { canonical, hashJson } from '../src/canonical.js';
import { baselineGuards } from '../src/discovery/v7-attempt-assessment.js';
import { budgetUsage, type BudgetSegment } from '../src/runtime/research-budget.js';
import { stageBudgetSegmentId } from '../src/discovery/stage-token-budget.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
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
import { researchCall, prepareResearchEnvelope } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT, partitionResearchWire } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { proveAssessmentTransportSubject, ATTEMPTS_ASSESSMENT_INSTRUCTION,
  type AssessmentTransportSubject } from '../src/discovery/continuation-packet.js';
import { researchCapacityInput, resultCapacityFrom, requireAttemptsAssessmentReply } from '../src/discovery/early-research-outcome.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3bt-"));
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
/** The next lawful plan edition: reopen and accept again. */
async function setup(t: test.TestContext) {
  const f = fixture(t), project = 'p', wire = join(f.root,'wire.ndjson'), adapter = join(f.root,'adapter.mjs');
  const settings = join(f.root,'reply.json');
  writeFileSync(settings,JSON.stringify({tokens:10}));
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const research=settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:settings.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = {executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure(project,{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
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


async function packetFixture(t: test.TestContext) {
  const f=await setup(t), m=f.prepare(), response=await m.invoke();
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
  const capacity=(assessmentSubject=subject,context:Record<string,any>={assessmentSubject})=>resultCapacityFrom(researchCapacityInput({
    operation:'assess-test',generation:0,bindings:{projectId:'p',draft:reference(m.draft),question:reference(m.question),assessmentSubject},
    role:'assessor',purpose:'assessor',actionMode:'assess-attempts',limit:60000,prompt:ATTEMPTS_ASSESSMENT_INSTRUCTION,
    binding:f.environment.value.reviewer,draft:m.draft.value,question:m.question,context}));
  const envelope=(assessmentSubject=subject,admission=capacity(assessmentSubject),context:Record<string,any>={assessmentSubject})=>
    prepareResearchEnvelope(f.environment.value.reviewer,f.environment.value,ATTEMPTS_ASSESSMENT_INSTRUCTION,context,
      {store:f.store,draftId:m.draft.id,questionId:m.question.id,purpose:'assessor'},admission,
      '00000000-0000-0000-0000-000000000000',REQUEST_MANIFEST_CONTRACT);
  return {...f,m,subject,capacity,envelope};
}

test('T: real completed managed attempt keeps its exact packet, baseline, Question and mandatory novelty in wire/capacity',async t=>{
  const f=await packetFixture(t), capacity=f.capacity(), packed=f.envelope();
  const subject=packed.subject as any;
  assert.deepEqual(subject.assessmentSubject,f.subject);
  assert.deepEqual(capacity.bindings.assessmentSubject,f.subject);
  assert.deepEqual(subject.question.basis,f.subject.packet.question);
  assert.equal(subject.question.id,'q-industry');
  assert.ok(subject.question.schema.required.includes('novelty'));
  assert.equal(subject.question.schema.properties.verdict.enum.join(','),'supported,return');
  assert.deepEqual(f.store.get<any>(subject.working.archive.id)!.value.question,f.subject.packet.question);
  assert.equal(partitionResearchWire(packed.envelope,packed.subject).join(''),packed.input);
  assert.deepEqual(proveAssessmentTransportSubject(f.store,{assessmentSubject:f.subject},'p',f.subject.packet.question),f.subject);
  assert.equal(requireAttemptsAssessmentReply({verdict:'return',reasons:['No new evidence'],return:{target:{attempt:f.subject.packet.entries[0]!.attempt},reason:'No evidence'},
    novelty:{attempts:[],accepted:[],rejected:[],newContent:[],duplicates:[],noProgress:[],transition:null}}),undefined);
  assert.throws(()=>requireAttemptsAssessmentReply({verdict:'supported',reasons:['ok'],return:null}),{code:'discovery_novelty_invalid'});
});

test('T: missing, null, forged and foreign assessment subjects refuse before dispatch',async t=>{
  const f=await packetFixture(t), sent=f.wires().length, ledger=f.store.list('research-budget-ledger');
  for(const subject of [null,{}, {...f.subject,baseline:null}, {...f.subject,packet:null},
    {...f.subject,packet:{...f.subject.packet,question:{...f.subject.packet.question,hash:'forged'}}},
    {...f.subject,baseline:{...f.subject.baseline,state:{kind:'absent',id:'v7-progress-state:foreign'}}}]) {
    assert.throws(()=>f.envelope(subject as any),{code:'discovery_assessment_subject_invalid'});
  }
  const cap=f.capacity();
  assert.throws(()=>f.envelope(f.subject,cap,{}),{code:'discovery_assessment_subject_invalid'});
  const other={...f.subject,baseline:{...f.subject.baseline,materials:[{bad:true}]}};
  assert.throws(()=>f.envelope(other as any,cap),{code:'discovery_assessment_subject_invalid'});
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

function dispatchContext(session:any, app:any) {
  return {...app.context,assessmentSession:session.id,
    assessmentState:{offset:session.value.offset,candidateOffset:session.value.candidateOffset??0,
      total:JSON.stringify(app.context.observations).length},assessmentNotes:session.value.notes,
    contextWorkspace:contextWorkspace(session.value.workspace,session.value.focus).entries.map(e=>e.result),focus:null};
}
async function paidAssessment(f:Awaited<ReturnType<typeof packetFixture>>, subject=f.subject, conflicts=0, tokens=10, candidate=0) {
  const reply={verdict:'return',reasons:['No new evidence'],return:{target:{attempt:subject.packet.entries[0]!.attempt},reason:'No evidence'},
    novelty:{attempts:[{attempt:subject.packet.entries[0]!.attempt,reason:'No evidence'}],accepted:[],rejected:[],newContent:[],duplicates:[],
      noProgress:[{attempt:subject.packet.entries[0]!.attempt,reason:'No evidence'}],transition:null}};
  writeFileSync(f.settings,JSON.stringify({tokens,reply}));
  const existingApps=new Set(f.store.list('assessment-application').map(a=>a.id));
  const write=f.store.writeMany.bind(f.store),other=f.open(),stop=new Error('T stopped after durable paid response');
  let clashes=0,terminalKinds:string[]=[],reservationKinds:string[]=[];
  f.store.writeMany=((writes,guards=[])=>{
    const terminal=writes.some(w=>w.kind==='model-call'&&(w.value as any).purpose==='assessor'&&(w.value as any).status==='succeeded');
    if (writes.some(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose==='assessor'))reservationKinds=writes.map(w=>w.kind);
    if(terminal&&clashes<conflicts){
      const ledger=other.list('research-budget-ledger')[0]!;
      other.write({id:ledger.id,kind:ledger.kind,expected:ledger.revision,value:ledger.value});clashes++;
    }
    const result=write(writes,guards);
    if(terminal){terminalKinds=writes.map(w=>w.kind);throw stop;}
    return result;
  }) as typeof f.store.writeMany;
  try {
    await assert.rejects(assessmentSession(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
      {assessmentSubject:subject,value:{attempts:subject.packet.entries,candidate},observations:[]},ATTEMPTS_ASSESSMENT_INSTRUCTION,
      undefined,baselineGuards(subject.baseline)),error=>error===stop);
  } finally {f.store.writeMany=write;}
  const app=f.store.list<any>('assessment-application').find(a=>!existingApps.has(a.id) && same(a.value.context.assessmentSubject,subject))!;
  assert.ok(app,'the real producer saved its application');assert.equal(app.value.state,'running');
  const prepared=f.store.get<any>(app.id,1)!,session=f.store.get<any>(app.value.session.id,app.value.session.revision)!;
  const invoke=(db=f.store,context=dispatchContext(session,prepared.value),role=prepared.value.role)=>researchCall(role,prepared.value.dispatch,
    assessmentRolePrompt(prepared.value.prompt),context,undefined,{store:db,draftId:prepared.value.dispatch.projectId===f.project?f.m.draft.id:'foreign',
      questionId:f.m.question.id,purpose:'assessor',session:reference(session),application:reference(prepared),
      prepareCall:()=>{throw new Error('Replay must not reserve a call');}});
  return {app,prepared,session,invoke,reply,clashes,terminalKinds,reservationKinds};
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

test('T: real assessment producer saves atomic wire/call/application and cold replay is free after plan changes',async t=>{
  const f=await packetFixture(t), paid=await paidAssessment(f);
  for(const kind of ['research-budget-ledger','model-call','assessment-application','request-manifest'])
    assert.ok(paid.reservationKinds.includes(kind),`${kind}: ${paid.reservationKinds}`);
  assert.ok(paid.terminalKinds.includes('model-response'));assert.ok(paid.terminalKinds.includes('model-call'));
  const call=f.store.get<ModelCall>(paid.app.value.call.id)!,wire=readRequestWire(f.store,call.value.request.record!,{projectId:'p',draftId:f.m.draft.id,requestId:call.value.requestId});
  assert.deepEqual(JSON.parse(wire.text),f.wires().at(-1));
  assert.deepEqual(JSON.parse(wire.text).subject.assessmentSubject,f.subject);
  assert.equal(JSON.parse(wire.text).prompt.includes(assessmentRolePrompt('')),false);
  assert.ok(JSON.parse(wire.text).prompt.includes(ATTEMPTS_ASSESSMENT_INSTRUCTION));
  f.discovery.reopen(f.m.question.id,f.m.question.revision);
  const count=f.wires().length,snapshot=f.store.list().flatMap(r=>f.store.history(r.id));
  assert.deepEqual(await paid.invoke(f.open()),paid.reply);
  assert.deepEqual(f.store.list().flatMap(r=>f.store.history(r.id)),snapshot);assert.equal(f.wires().length,count);
  for(const context of [{...dispatchContext(paid.session,paid.prepared.value),assessmentSubject:{...f.subject,baseline:{...f.subject.baseline,materials:[{}]}}},
    {...dispatchContext(paid.session,paid.prepared.value),assessmentSubject:null},
    {...dispatchContext(paid.session,paid.prepared.value),assessmentState:{offset:99}}])
    await assert.rejects(paid.invoke(f.open(),context),{code:'discovery_assessment_subject_invalid'});
  await assert.rejects(paid.invoke(f.open(),undefined,{...paid.prepared.value.role,actor:'foreign'}),{code:'research_context_application_invalid'});
  assert.equal(f.wires().length,count);
});

test('T: repeated accounting conflicts preserve the paid overrun and prevent another send',async t=>{
  const f=await packetFixture(t),paid=await paidAssessment(f,f.subject,9,20_000_002);
  assert.equal(paid.clashes,9);
  for(const kind of ['model-call','model-response','budget-incident'])assert.ok(paid.terminalKinds.includes(kind));
  const segment=f.store.get<BudgetSegment>(stageBudgetSegmentId('p'))!,usage=budgetUsage(f.store,segment);
  assert.equal(usage.reserved,0);assert.ok(usage.measured>segment.value.limit);
  const before=f.store.list('research-budget-ledger'),sent=f.wires().length;
  assert.deepEqual(await paid.invoke(f.open()),paid.reply);
  assert.deepEqual(f.store.list('research-budget-ledger'),before);assert.equal(f.wires().length,sent);
  // Another application/candidate is not a replay of the paid operation.
  await assert.rejects(assessmentSession(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
    {assessmentSubject:f.subject,value:{attempts:f.subject.packet.entries,next:true},observations:[]},ATTEMPTS_ASSESSMENT_INSTRUCTION,
    undefined,baselineGuards(f.subject.baseline)),{code:'discovery_budget_overrun'});
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),before);
});

test('T: a subject alone never authorizes an assessor payment',async t=>{
  const f=await packetFixture(t),sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  await assert.rejects(researchCall(f.environment.value.reviewer,f.environment.value,ATTEMPTS_ASSESSMENT_INSTRUCTION,
    {assessmentSubject:f.subject},undefined,{store:f.store,draftId:f.m.draft.id,questionId:f.m.question.id,purpose:'assessor'}),
    {code:'discovery_assessment_subject_invalid'});
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});


test('T: continuation preserves novelty, while a new baseline isolates the operation and old paid recovery',async t=>{
  const f=await packetFixture(t),a=await paidAssessment(f),b=await paidAssessment(f,f.subject,0,10,1);
  const wire=f.wires().at(-1),first=JSON.parse(readRequestWire(f.store,f.store.get<ModelCall>(a.app.value.call.id)!.value.request.record!,
    {projectId:'p',draftId:f.m.draft.id,requestId:f.store.get<ModelCall>(a.app.value.call.id)!.value.requestId}).text);
  assert.equal(wire.subject.continuation.kind,'continuation');
  assert.deepEqual(wire.subject.assessmentSubject,first.subject.assessmentSubject);
  assert.deepEqual(wire.subject.question.schema,first.subject.question.schema);
  assert.ok(wire.subject.question.schema.required.includes('novelty'));
  // M currently proves a baseline record's address/kind. This is a comparison
  // snapshot, not a claimed progress application (P owns that producer).
  const state=f.store.write({id:f.subject.baseline.state.kind==='absent'?f.subject.baseline.state.id:'unreachable',
    kind:'v7-progress-state',expected:0,value:{project:'p',comparison:'saved baseline'}});
  const changed:AssessmentTransportSubject={...f.subject,baseline:{...f.subject.baseline,state:{kind:'state',ref:reference(state)}}};
  const c=await paidAssessment(f,changed);
  assert.equal(f.wires().at(-1).subject.continuation.kind,'initial');
  assert.notEqual(c.app.id,a.app.id);assert.notEqual(c.app.value.call.id,a.app.value.call.id);
  assert.notEqual(f.store.get<ModelCall>(c.app.value.call.id)!.value.progressKey,f.store.get<ModelCall>(a.app.value.call.id)!.value.progressKey);
  const sent=f.wires().length,history=f.store.list().flatMap(r=>f.store.history(r.id));
  assert.deepEqual(await a.invoke(f.open()),a.reply);assert.deepEqual(await b.invoke(f.open()),b.reply);
  assert.deepEqual(await c.invoke(f.open()),c.reply);
  await assert.rejects(a.invoke(f.open(),{...dispatchContext(a.session,a.prepared.value),assessmentSubject:changed}),
    {code:'discovery_assessment_subject_invalid'});
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list().flatMap(r=>f.store.history(r.id)),history);
});

test('T: the real producer cannot omit the baseline guard or dispatch a corrupted packet',async t=>{
  const f=await packetFixture(t),before=f.wires().length,ledger=f.store.list('research-budget-ledger');
  await assert.rejects(assessmentSession(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
    {assessmentSubject:f.subject,value:{attempts:f.subject.packet.entries},observations:[]},ATTEMPTS_ASSESSMENT_INSTRUCTION),
    {code:'discovery_assessment_subject_invalid'});
  const broken={...f.subject,packet:{...f.subject.packet,entries:[{...f.subject.packet.entries[0],binding:{id:'missing',revision:1,hash:'0'.repeat(64)}}]}};
  await assert.rejects(assessmentSession(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
    {assessmentSubject:broken,value:{attempts:broken.packet.entries},observations:[]},ATTEMPTS_ASSESSMENT_INSTRUCTION,
    undefined,baselineGuards(f.subject.baseline)),error=>{assert.equal((error as any).code,'discovery_assessment_subject_invalid');
      assert.match((error as any).details.field,/binding$/);return true;});
  await assert.rejects(researchCall(f.environment.value.implementer,f.environment.value,f.prompt,
    {assessmentSubject:f.subject},undefined,{store:f.store,draftId:f.m.draft.id,questionId:f.m.question.id,
      purpose:'analyst',consumerIntent:reference(f.m.intent)}),{code:'discovery_assessment_subject_invalid'});
  assert.equal(f.wires().length,before);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});


test('T: an unavailable legal budget is an addressed refusal before adapter or ledger',async t=>{
  const f=await packetFixture(t),before=f.wires().length,ledger=f.store.list('research-budget-ledger');
  const environment=f.engine.environments.configure('p',{...f.environment.value,
    reviewer:{...f.environment.value.reviewer,model:'uncalibrated-model'}},f.environment.revision);
  await assert.rejects(assessmentSession(f.store,f.m.draft,f.m.question,environment,environment.value,undefined,
    {assessmentSubject:f.subject,value:{attempts:f.subject.packet.entries},observations:[]},ATTEMPTS_ASSESSMENT_INSTRUCTION,
    undefined,baselineGuards(f.subject.baseline)),error=>{
      assert.equal((error as any).code,'budget_estimate_missing');
      assert.equal((error as any).details.class,'research');assert.equal((error as any).details.estimate,null);
      assert.ok((error as any).details.segment.id);assert.ok((error as any).details.remaining>0);return true;
    });
  assert.equal(f.wires().length,before);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

test('T: prepareCall cannot replace the call or assessment key',async t=>{
  const f=await packetFixture(t),stop=new Error('T stopped before reservation'),write=f.store.writeMany.bind(f.store);
  f.store.writeMany=((writes,guards=[])=>{
    if(writes.some(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose==='assessor'))throw stop;
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  try {
    await assert.rejects(assessmentSession(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
      {assessmentSubject:f.subject,value:{attempts:f.subject.packet.entries},observations:[]},ATTEMPTS_ASSESSMENT_INSTRUCTION,
      undefined,baselineGuards(f.subject.baseline)),error=>error===stop);
  } finally {f.store.writeMany=write;}
  const app=f.store.list<any>('assessment-application')[0]!,session=f.store.get<any>(app.value.session.id,app.value.session.revision)!;
  assert.equal(app.value.state,'prepared');
  const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  await assert.rejects(researchCall(app.value.role,app.value.dispatch,assessmentRolePrompt(app.value.prompt),
    dispatchContext(session,app.value),undefined,{store:f.store,draftId:f.m.draft.id,questionId:f.m.question.id,
      purpose:'assessor',session:reference(session),application:reference(app),prepareCall:call=>{
        (call.value as any).assessmentKey='forged';
        // Keep the transition and all guards otherwise valid: only the changed
        // reserved call may cause this refusal, not an empty callback result.
        return {writes:[{id:app.id,kind:app.kind,expected:app.revision,
          value:{...app.value,state:'running',call:{id:call.id,revision:call.expected+1,hash:hashJson(call.value)}}}],
          guards:uniqueTransactionGuards([reference(session),reference(app),...app.value.guards])};
      }}),error=>{assert.equal((error as any).code,'research_context_application_invalid');
        assert.match((error as Error).message,/preserve the call/);return true;});
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.deepEqual(f.store.get(app.id),app);
});
