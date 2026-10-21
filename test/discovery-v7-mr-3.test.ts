// MR.3 uses a real managed packet and shared assessment-session producer.
// It proves wire/capacity/session identity; the final assessment projector belongs to MR.4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashJson, type Json } from '../src/canonical.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING, DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { type ResearchRun, V7_PROGRESS_BASELINE_CONTRACT } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
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
const research=settings.readSource&&!r.subject.contextWorkspace?.length?{action:'read_context',record:r.subject.working.archive,pointer:'/body/value/materials/0/value/content'}:queued??settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
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
  return {...f,v,project,questions,subject,prepare,wires,environment,prompt,settings,calibration:{draft:old,question:q}};
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
import { methodologyAssessmentTransport, requirementsAssessmentTransport, assessmentQuestionContract,
  packetAssessmentSubject, assessmentResponseContract, assessmentTransportPrompt, assessmentSubjectKey,
  ATTEMPTS_REQUIREMENTS_INSTRUCTION } from '../src/discovery/continuation-packet.js';
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
