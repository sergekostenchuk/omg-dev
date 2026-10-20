import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { assessmentSessionWithProof, assessmentRolePrompt, readAssessmentDispatchAdmission } from '../src/discovery/assessment-session.js';
import { contextWorkspace } from '../src/discovery/context-workspace.js';
import { methodologyAssessmentTransport, assessmentQuestionContract } from '../src/discovery/continuation-packet.js';
import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { baselineGuards } from '../src/discovery/v7-attempt-assessment.js';
import { assessAttempts, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import { DISCOVERY_ASSESSMENT_CONTRACT_V2 } from '../src/discovery/research-model.js';
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
  completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
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

test('A: a real paid packet assessment is proved from its terminal without accepting claims or changing K',async t=>{
  const f=await packetFixture(t),reply=assessmentReply(f);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const before=f.store.list('research-attempt-binding'),question=f.store.get(f.m.question.id),sent=f.wires().length;
  const assessment=await assessmentRequest(f);
  assert.equal(assessment.value.contract,DISCOVERY_ASSESSMENT_CONTRACT_V2);
  assert.equal(assessment.value.verdict,'return');assert.deepEqual(assessment.value.novelty,reply.novelty);
  assert.deepEqual(assessment.value.methodology,reply.methodology);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(assessment)),assessment);
  assert.equal(f.wires().length,sent+1);
  assert.deepEqual(f.store.list('research-attempt-binding'),before);assert.deepEqual(f.store.get(f.m.question.id),question);
  assert.equal(f.store.list('v7-progress-state').length,0);
  const snapshot=f.store.list().flatMap(r=>f.store.history(r.id));
  assert.deepEqual(await assessmentRequest(f,f.open()),assessment);
  assert.deepEqual(f.store.list().flatMap(r=>f.store.history(r.id)),snapshot);assert.equal(f.wires().length,sent+1);
});

test('A: incomplete novelty and methodology never become a discovery assessment',async t=>{
  for(const field of ['novelty','methodology'] as const) await t.test(field,async t=>{
    const f=await packetFixture(t),reply:any=assessmentReply(f);delete reply[field];
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
    await assert.rejects(assessmentRequest(f),{code:'discovery_novelty_invalid'});
    assert.equal(f.store.list('discovery-assessment').length,0);
    assert.ok(f.store.list<any>('model-call').some(c=>c.value.purpose==='assessor'&&c.value.status==='succeeded'));
  });
});

test('A: a forged supported label, another paid application and another project cannot impersonate an assessment',async t=>{
  const f=await packetFixture(t);writeFileSync(f.settings,JSON.stringify({tokens:10,reply:assessmentReply(f)}));
  const assessment=await assessmentRequest(f);
  await assert.rejects(async()=>readDiscoveryAssessment(f.store,'foreign',reference(assessment)),{code:'discovery_assessment_invalid'});
  const fake=f.store.write({id:'discovery-assessment:forged',kind:'discovery-assessment',expected:0,
    value:{...assessment.value,reasons:['A fabricated explanation']}});
  assert.throws(()=>readDiscoveryAssessment(f.store,'p',reference(fake)),{code:'discovery_assessment_invalid'});
  const original=f.store.get<any>(assessment.value.application.id,1)!;
  const wrong=f.store.write({id:'discovery-assessment:unapplied',kind:'discovery-assessment',expected:0,
    value:{...assessment.value,application:reference(original)}});
  assert.throws(()=>readDiscoveryAssessment(f.store,'p',reference(wrong)),{code:'research_context_application_invalid'});
});

test('A: assessor identity cannot equal the proven producer even when current settings name another implementer',async t=>{
  const f=await packetFixture(t),sent=f.wires().length;
  const environment=f.engine.environments.configure('p',{...f.environment.value,
    implementer:{...f.environment.value.implementer,actor:'other-author'},
    reviewer:{...f.environment.value.reviewer,actor:'author'}},f.environment.revision);
  await assert.rejects(assessAttempts(f.store,f.subject.packet,f.subject.baseline,environment,f.root),{code:'assessor_not_independent'});
  assert.equal(f.wires().length,sent);assert.equal(f.store.list('assessment-session').length,0);
});

test('A: checkpoint continuation preserves the mandatory M2 result contract and produces one proved terminal',async t=>{
  const f=await packetFixture(t),sent=f.wires().length;
  writeFileSync(f.settings,JSON.stringify({tokens:10,replies:[{action:'assessment_checkpoint',notes:['Read packet']},assessmentReply(f)]}));
  const assessment=await assessmentRequest(f);
  assert.deepEqual(readDiscoveryAssessment(f.store,'p',reference(assessment)),assessment);
  assert.equal(f.wires().length,sent+2);
  for(const wire of f.wires().slice(sent))assert.ok(wire.subject.question.schema.required.includes('methodology'));
  assert.equal(f.store.list('discovery-assessment').length,1);
});


test('A: paid accepted fact keeps its exact methodology without applying its claim',async t=>{
  const f=await packetFixture(t,true),source=f.source!,attempt=f.subject.packet.entries[0]!.attempt;
  const address={project:'p',container:attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'fact-throughput'};
  const evidence=(pointer:string)=>({source:reference(source),selector:{kind:'json-pointer',pointer}});
  const reply={verdict:'supported',reasons:['Measured evidence'],return:null,
    novelty:{attempts:[{attempt,reason:'Reviewed'}],accepted:[{claim:address,reason:'Measurement'}],rejected:[],
      newContent:[{claim:address,reason:'New measurement'}],duplicates:[],noProgress:[],transition:null},
    methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[{
      claim:address,significance:{kind:'blocking',reason:'Required measurement'},sources:[{source:reference(source),role:'primary',reason:'Original measurement',
        evidence:[evidence('/fact')],original:reference(source),originalReason:'Original report',limitation:null,
        publicationDate:{status:'known',value:'2026-10-20',evidence:[evidence('/published')]},
        eventDate:{status:'unknown',reason:'Event day unreported'},version:{status:'known',value:'2.1',evidence:[evidence('/version')]},retrievedAt:null}],
      temporalApplicability:{status:'established',scope:'Measured deployment',reason:'Dated measurement',evidence:[evidence('/published')]},
      corroboration:{status:'single_confirmation',reason:'One original',limitation:'Independent confirmation required'},
      refutation:{status:'not_performed',reason:'No search yet',traces:[],counterarguments:[],limitations:['Refutation search remains']}}]}};
  const beforePayment=f.wires().length;
  writeFileSync(f.settings,JSON.stringify({tokens:10,readSource:true,reply}));
  const saved=await assessmentRequest(f);
  assert.equal(f.wires().length,beforePayment+2);
  assert.ok(JSON.stringify(f.wires().at(-1).subject.contextWorkspace).includes('Measured throughput is 42'));
  const paidCandidate = f.wires().at(-1).subject.value;
  assert.deepEqual(paidCandidate.materials,[{ref:reference(source),kind:source.kind,value:source.value}]);
  assert.deepEqual(saved.value.methodology,reply.methodology);assert.deepEqual(saved.value.novelty.accepted,reply.novelty.accepted);
  const sent = f.wires().length;
  f.discovery.evidence.document('p','measurement',JSON.stringify({fact:'Later measurement is 99'}),'application/json',source.revision);
  assert.deepEqual(await assessmentRequest(f,f.open()),saved);
  assert.equal(f.wires().length,sent);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved)),saved);
  assert.equal(f.store.list('v7-progress-state').length,0);assert.equal(f.store.get(f.m.question.id)!.revision,f.m.question.revision);
});

test('A: paid wire with a forged candidate cannot prove the packet assessment',async t=>{
  const f=await packetFixture(t),subject={...f.subject,assessment:methodologyAssessmentTransport()},reply=assessmentReply(f);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const delivered=await assessmentSessionWithProof(f.store,f.m.draft,f.m.question,f.environment,f.environment.value,undefined,
    {assessmentSubject:subject,value:{attempts:['fabricated candidate']},observations:[]},assessmentQuestionContract(subject).prompt,
    undefined,baselineGuards(subject.baseline));
  const proof=delivered.proof!;
  const value={contract:DISCOVERY_ASSESSMENT_CONTRACT_V2,projectId:'p',subject:{kind:'attempts',packet:subject.packet},baseline:subject.baseline,
    session:proof.session,application:proof.application,assessor:proof.role.actor,environment:proof.environment,...reply};
  const id=`discovery-assessment:v2:${hashJson({projectId:'p',session:proof.session,application:proof.application})}`;
  const forged=f.store.write({id,kind:'discovery-assessment',expected:0,value});
  assert.throws(()=>readDiscoveryAssessment(f.store,'p',reference(forged)),{code:'discovery_assessment_invalid'});
});


test('A: independence includes a second producer in the same proven packet',async t=>{
  const f=await packetFixture(t),first=f.subject.packet.entries[0]!;
  const environment=f.engine.environments.configure('p',{...f.environment.value,
    implementer:{...f.environment.value.implementer,actor:'coauthor'}},f.environment.revision);
  await researchCall(environment.value.implementer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'analyst'});
  const run=f.store.get<ResearchRun>(f.m.run.id)!,selected=f.m.selected,context={history:[],readings:[]};
  const number=run.value.turns+1;
  const intent=prepareResearchConsumerIntent(f.store,{projectId:'p',kind:'analyst',key:`${run.id}:${number}`,owner:reference(run),
    draft:reference(f.m.draft),question:reference(f.m.question),role:environment.value.implementer,dispatch:environment.value,profile:null,
    cursor:{run:run.id,turn:number,instruction:f.prompt,context,subject:selected},basis:f.m.draft.value.inputs,
    guards:uniqueTransactionGuards([reference(run),reference(f.m.draft),reference(f.m.question),reference(environment)])});
  const response=await researchCall(environment.value.implementer,environment.value,f.prompt,context,undefined,
    {store:f.store,draftId:f.m.draft.id,questionId:f.m.question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
  const execution=readResearchConsumerExecution(f.store,'p',reference(intent));assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(run.value,{runId:run.id,intent:reference(intent),response,question:reference(f.m.question),
    owner:run.value.owner,limit:number,context,subject:selected});
  const turnId=managedTurnId(run.id,number),application=prepareResearchConsumerApplication(f.store,reference(intent),reference(execution.call),[
    {id:run.id,kind:run.kind,expected:run.revision,value:projected.run},{id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(run),reference(environment),{id:turnId,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const call=f.store.get<ResearchConsumerIntent>(intent.id)!.value.call!;
  const attempt=recordV7Attempt(f.store,{project:'p',planAnswer:selected.planAnswer,planQuestionId:selected.planQuestionId,call,
    end:attemptEndOfAction(response,selected)}).attempt;
  const done=completeResearchAttemptTurn(f.store,'p',reference(f.store.get(turnId)!),reference(attempt));
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:selected.planAnswer,planQuestionId:selected.planQuestionId,
    entries:[first,{attempt:reference(attempt),binding:reference(done.binding)}]});
  const selectedEnvironment=f.engine.environments.configure('p',{...environment.value,
    implementer:{...environment.value.implementer,actor:'third-author'},reviewer:{...environment.value.reviewer,actor:'coauthor'}},environment.revision);
  const sent=f.wires().length;
  await assert.rejects(assessAttempts(f.store,packet,f.subject.baseline,selectedEnvironment,f.root),{code:'assessor_not_independent'});
  assert.equal(f.wires().length,sent);assert.equal(f.store.list('assessment-session').length,0);
});


test('A: a different requested assessor cannot receive the original paid result', async t => {
  const f = await packetFixture(t);
  writeFileSync(f.settings, JSON.stringify({tokens:10,reply:assessmentReply(f)}));
  const original = await assessmentRequest(f), sent = f.wires().length;
  const environment = f.engine.environments.configure('p', {...f.environment.value,
    reviewer:{...f.environment.value.reviewer,actor:'another-reviewer'}}, f.environment.revision);
  await assert.rejects(assessAttempts(f.store,f.subject.packet,f.subject.baseline,environment,f.root),
    {code:'discovery_assessment_invalid'});
  assert.equal(f.wires().length,sent);
  assert.deepEqual(await assessmentRequest(f,f.open()),original);
});

test('A: absent environment and null saved assessment return typed refusals', async t => {
  const f = await packetFixture(t), sent = f.wires().length;
  await assert.rejects(assessAttempts(f.store,f.subject.packet,f.subject.baseline,null as any,f.root),
    {code:'discovery_assessment_invalid'});
  const broken = f.store.write({id:'discovery-assessment:null',kind:'discovery-assessment',expected:0,value:null});
  assert.throws(() => readDiscoveryAssessment(f.store,'p',reference(broken)),{code:'discovery_assessment_invalid'});
  assert.equal(f.wires().length,sent);
});


for (const defect of ['missing','unclassified'] as const) {
  test(`A: a ${defect} novelty reply can be corrected with the original methodology contract`, async t => {
  const f = await packetFixture(t), broken = assessmentReply(f) as any;
  if(defect==='missing') delete broken.novelty;
  else broken.novelty.attempts=[];
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:broken}));
  await assert.rejects(assessmentRequest(f),{code:'discovery_novelty_invalid'});
  assert.equal(f.store.list('discovery-assessment').length,0);
  const first = f.store.list('model-call').filter(r => (r.value as any).purpose === 'assessor' && (r.value as any).draftId === f.m.draft.id);
  assert.equal(first.length,1);
  const sent = f.wires().length, reply = assessmentReply(f);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const assessment = await assessmentRequest(f,f.open());
  assert.deepEqual(assessment.value.novelty,reply.novelty);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(assessment)),assessment);
  assert.equal(f.wires().length,sent+1);
  assert.deepEqual(f.store.get(first[0]!.id,first[0]!.revision),first[0]);
  const corrected = f.wires().at(-1).subject;
  assert.ok(corrected.question.schema.required.includes('methodology'));
  assert.deepEqual(corrected.failures[0].responseContract.schema,corrected.question.schema);
  assert.ok(corrected.failures[0].responseContract.schema.required.includes('novelty'));
  const prepared = f.store.get<any>(assessment.value.application.id,1)!;
  const session = f.store.get<any>(prepared.value.session.id,prepared.value.session.revision)!;
  const feedback = readAssessmentDispatchAdmission(f.store,reference(prepared)).context.failures?.[0];
  assert.ok(feedback);
  const context = {...prepared.value.context,assessmentSession:session.id,
    assessmentState:{offset:session.value.offset,candidateOffset:session.value.candidateOffset??0,
      total:JSON.stringify(prepared.value.context.observations).length},assessmentNotes:session.value.notes,
    contextWorkspace:contextWorkspace(session.value.workspace,session.value.focus).entries.map(entry=>entry.result),focus:null};
  const charged = f.store.list('research-budget-ledger');
  for (const failures of [undefined,[],[{...feedback,code:'forged-correction'}]]) {
    await assert.rejects(researchCall(prepared.value.role,prepared.value.dispatch,assessmentRolePrompt(prepared.value.prompt),
      {...context,...(failures===undefined?{}:{failures})},undefined,{store:f.store,
        draftId:session.value.binding.draft.id,questionId:session.value.binding.question.id,purpose:'assessor',
        session:reference(session),application:reference(prepared),prepareCall:()=>{throw new Error('Forged feedback must not reserve a call');}}),
      {code:'discovery_assessment_subject_invalid'});
  }
  assert.equal(f.wires().length,sent+1);
  assert.deepEqual(f.store.list('research-budget-ledger'),charged);
});

}

test('A: a genuine profile from another project is refused before payment', async t => {
  const f=await packetFixture(t), env=f.environment.value;
  f.engine.environments.configure('foreign',{workspace:f.root,implementer:env.implementer,reviewer:env.reviewer,
    fullCheck:env.fullCheck,timeoutMs:env.timeoutMs},0);
  const pilot=configureReaderPilot(f.store,f.engine.environments,'foreign',{
    experimental:true,active:false,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:env.reviewer.command},
    agentCommand:env.reviewer.command,maxRequestChars:300000,maxReadChars:100000,maxReplyChars:50000,
    maxCalls:10,maxReportedTokens:1000000},0);
  const sent=f.wires().length;
  await assert.rejects(assessAttempts(f.store,f.subject.packet,f.subject.baseline,f.environment,f.root,undefined,pilot),
    {code:'discovery_assessment_invalid'});
  assert.equal(f.wires().length,sent);assert.equal(f.store.list('assessment-session').length,0);
});
