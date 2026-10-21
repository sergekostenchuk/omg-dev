// MR.1 checks in-memory forms against a genuine packet and existing paid v2.
// A structural v3 form here is never persisted or asserted to be a paid v3 assessment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
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
import { projectAttemptPacket, v7ProgressStateId, checkDiscoveryAssessmentForm } from '../src/discovery/v7-attempt-assessment.js';
import { type AssessmentTransportSubject } from '../src/discovery/continuation-packet.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
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
async function packetOfClaims(f:Awaited<ReturnType<typeof packetFixture>>,claims:unknown[]) {
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'answer',question:'q-industry',citations:[],
    value:{type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims}}}}));
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
  return {...f,m,subject};
}

function claimFor(f:Awaited<ReturnType<typeof packetFixture>>,id:string,kind:string,basis:unknown) {
  return {id,kind,text:`Exact ${id}`,axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
    scope:{variants:'common'},basis};
}
function closingNonFact(f:Awaited<ReturnType<typeof packetFixture>>,claims:{id:string}[],requirements:unknown[]) {
  const attempt=f.subject.packet.entries[0]!.attempt;
  const accepted=claims.map((c,i)=>({claim:{project:'p',container:attempt,containerKind:'research-attempt',pointer:`/claims/${i}`,claimId:c.id},reason:'Reviewed'}));
  return {verdict:'supported',reasons:['Saved criterion addressed'],return:null,
    novelty:{attempts:[{attempt,reason:'Reviewed'}],accepted,rejected:[],newContent:accepted,duplicates:[],noProgress:[],
      transition:{outcome:'closed',bases:accepted.map(row=>({claim:row.claim})),reason:'Exact bases',
        sufficiency:{criterion:f.questions[0]!.criterion,requiredDepth:f.questions[0]!.requiredDepth,
          reason:'Declared sufficiency',methodologyRequirements:requirements}}},
    methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}

type PacketFixture = Awaited<ReturnType<typeof packetFixture>>;
async function structuralForm(f: PacketFixture, reply: ReturnType<typeof closedReply> | ReturnType<typeof closingNonFact> | ReturnType<typeof assessmentReply>) {
  const oldReply: any = structuredClone(reply);
  oldReply.methodology.policy = 'assessment-methodology-policy/v1';
  if (oldReply.novelty.transition?.sufficiency) delete oldReply.novelty.transition.sufficiency.methodologyRequirements;
  writeFileSync(f.settings, JSON.stringify({tokens:10,reply:oldReply}));
  const paidV2 = await assessAttempts(f.store, f.subject.packet, f.subject.baseline, f.environment, f.root);
  const form = {...structuredClone(paidV2.value), ...structuredClone(reply), contract:'discovery-assessment/v3'};
  return {form, paidV2};
}
const requirementsAt = 'transition.sufficiency.methodologyRequirements';
function refused(f: PacketFixture, form: unknown, field: string) {
  assert.throws(() => checkDiscoveryAssessmentForm(f.store, form), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'discovery_novelty_invalid');
    assert.equal((error.details as {field:string}).field, field);
    return true;
  });
}

test('MR.1: exact v3/policy-v2 form and historical v2/v1 remain distinct without writing an assessment', async t => {
  const f = await packetFixture(t, true), {form, paidV2} = await structuralForm(f, closedReply(f));
  const heads = f.store.list('discovery-assessment'), ledger = f.store.list('research-budget-ledger');
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store, form).value, form);
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store, paidV2.value).value, paidV2.value);
  const {methodology: _methodology, ...old} = paidV2.value;
  const v1 = {...old, contract:'discovery-assessment/v1'};
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store, v1).value, v1);
  assert.deepEqual(f.store.list('discovery-assessment'), heads);
  assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
  assert.equal(heads.length, 1);
  assert.equal((heads[0]!.value as any).contract, 'discovery-assessment/v2');
});

test('MR.1: closed requires every exact field, explicit booleans and complete unique fact coverage', async t => {
  const f = await packetFixture(t, true), {form} = await structuralForm(f, closedReply(f));
  const cases: [string, (v:any)=>void, string][] = [
    ['absent list', v=>delete v.novelty.transition.sufficiency.methodologyRequirements, 'novelty.transition.sufficiency'],
    ['null list', v=>v.novelty.transition.sufficiency.methodologyRequirements=null, requirementsAt],
    ['object list', v=>v.novelty.transition.sufficiency.methodologyRequirements={}, requirementsAt],
    ['missing fact', v=>v.novelty.transition.sufficiency.methodologyRequirements=[], requirementsAt],
    ['duplicate', v=>v.novelty.transition.sufficiency.methodologyRequirements.push(structuredClone(v.novelty.transition.sufficiency.methodologyRequirements[0])), `${requirementsAt}.1.claim`],
    ['foreign', v=>v.novelty.transition.sufficiency.methodologyRequirements[0].claim.project='other', `${requirementsAt}.0.claim`],
    ['wrong revision', v=>v.novelty.transition.sufficiency.methodologyRequirements[0].claim.container.revision++, `${requirementsAt}.0.claim`],
    ['wrong hash', v=>v.novelty.transition.sufficiency.methodologyRequirements[0].claim.container.hash='0'.repeat(64), `${requirementsAt}.0.claim`],
    ['missing claim', v=>delete v.novelty.transition.sufficiency.methodologyRequirements[0].claim, `${requirementsAt}.0`],
    ['empty reason', v=>v.novelty.transition.sufficiency.methodologyRequirements[0].reason='', `${requirementsAt}.0.reason`],
    ['missing reason', v=>delete v.novelty.transition.sufficiency.methodologyRequirements[0].reason, `${requirementsAt}.0`],
    ['extra field', v=>v.novelty.transition.sufficiency.methodologyRequirements[0].default=false, `${requirementsAt}.0`],
    ['missing bases', v=>delete v.novelty.transition.bases, 'novelty.transition'],
    ['empty bases', v=>v.novelty.transition.bases=[], 'novelty.transition.bases'],
    ['missing sufficiency', v=>delete v.novelty.transition.sufficiency, 'novelty.transition.sufficiency'],
    ['changed criterion', v=>v.novelty.transition.sufficiency.criterion='Different criterion', 'novelty.transition.sufficiency'],
    ['changed depth', v=>v.novelty.transition.sufficiency.requiredDepth='shallow', 'novelty.transition.sufficiency'],
  ];
  for (const field of ['dated','versioned','independentConfirmation']) {
    cases.push([`missing ${field}`, v=>delete v.novelty.transition.sufficiency.methodologyRequirements[0][field], `${requirementsAt}.0`]);
    for (const bad of ['false', [false], 0, null])
      cases.push([`coerced ${field}: ${JSON.stringify(bad)}`, v=>v.novelty.transition.sufficiency.methodologyRequirements[0][field]=bad, `${requirementsAt}.0.${field}`]);
  }
  for (const [name, change, field] of cases) await t.test(name, () => {
    // JSON inputs do not share the in-memory builder aliases between requirements and novelty.
    const invalid = JSON.parse(JSON.stringify(form)); change(invalid); refused(f, invalid, field);
  });
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store, form).value, form);
  // The assessor declares the requirement; semantic compliance belongs to P.
  const independent:any=structuredClone(form);
  independent.novelty.transition.sufficiency.methodologyRequirements[0].independentConfirmation=true;
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store,independent).value,independent);
});

test('MR.1: missing or mixed discriminators refuse even without a closed transition', async t => {
  const f = await packetFixture(t), {form, paidV2} = await structuralForm(f, assessmentReply(f));
  for (const original of [form, paidV2.value]) {
    for (const policy of [undefined, null, ['assessment-methodology-policy/v2'],
      original.contract==='discovery-assessment/v3'?'assessment-methodology-policy/v1':'assessment-methodology-policy/v2']) {
      const bad:any = structuredClone(original);
      if (policy===undefined) delete bad.methodology.policy; else bad.methodology.policy=policy;
      refused(f, bad, 'methodology');
    }
  }
  for (const contract of [undefined, null, ['discovery-assessment/v3'], 'discovery-assessment/v4']) {
    const bad:any = structuredClone(form);
    if (contract===undefined) delete bad.contract; else bad.contract=contract;
    assert.throws(()=>checkDiscoveryAssessmentForm(f.store,bad),{code:'discovery_assessment_subject_invalid'});
  }
  const missing:any=structuredClone(form);delete missing.methodology;
  assert.throws(()=>checkDiscoveryAssessmentForm(f.store,missing),{code:'discovery_assessment_subject_invalid'});
  const absent:any=structuredClone(form);delete absent.methodology.facts;
  refused(f, absent, 'methodology');
});

test('MR.1: transitive inference bases share one exact fact requirement', async t => {
  const original = await packetFixture(t, true), fact = closedReply(original).novelty.accepted[0]!.claim;
  const middleClaims = ['middle-a','middle-b'].map(id=>claimFor(original,id,'inference',{from:[fact],reasoning:'Exact measurement'}));
  const middle = await packetOfClaims(original,middleClaims), middleAttempt=middle.subject.packet.entries[0]!.attempt;
  const premises = middleClaims.map((claim,i)=>({project:'p',container:middleAttempt,containerKind:'research-attempt',pointer:`/claims/${i}`,claimId:claim.id}));
  const claims = [claimFor(original,'top','inference',{from:premises,reasoning:'Both exact intermediate inferences'})];
  const f = await packetOfClaims(original, claims);
  const reply = closingNonFact(f, claims, [{claim:fact,dated:false,versioned:false,independentConfirmation:false,reason:'Requirement for the transitive fact'}]);
  const {form} = await structuralForm(f,reply);
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store,form).value,form);
  const missing:any=structuredClone(form);missing.novelty.transition.sufficiency.methodologyRequirements=[];
  refused(f,missing,requirementsAt);
  const inference:any=structuredClone(form);inference.novelty.transition.sufficiency.methodologyRequirements[0].claim=premises[0];
  refused(f,inference,`${requirementsAt}.0.claim`);
});

test('MR.1: explicit empty requirements are legal for a closing without fact dependencies', async t => {
  const original=await packetFixture(t),claim=claimFor(original,'hypothesis','hypothesis',{howToVerify:'Run the experiment'});
  const f=await packetOfClaims(original,[claim]),{form}=await structuralForm(f,closingNonFact(f,[claim],[]));
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store,form).value,form);
  const missing:any=structuredClone(form);delete missing.novelty.transition.sufficiency.methodologyRequirements;
  refused(f,missing,'novelty.transition.sufficiency');
});

test('MR.1: unrelated accepted limited fact does not enter the closing requirements', async t => {
  const original=await packetFixture(t,true),source=original.source!;
  const basis={source:{ref:reference(source),range:{start:0,end:source.value.content.length},valueHash:hashJson(source.value.content)},limit:'Original measurement',asOf:'2026-10'};
  const claims=['fact-throughput','unrelated-fact'].map(id=>claimFor(original,id,'fact',basis));
  const f=await packetOfClaims(original,claims),reply=closedReply(f),other={...reply.novelty.accepted[0]!.claim,pointer:'/claims/1',claimId:'unrelated-fact'};
  reply.novelty.accepted.push({claim:other,reason:'Another fact'});reply.novelty.newContent.push({claim:other,reason:'Another fact'});
  const limited=structuredClone(reply.methodology.facts[0]!);limited.claim=other;
  limited.temporalApplicability={status:'limited',scope:'Another deployment',reason:'Not a closing basis',evidence:[]};
  reply.methodology.facts.push(limited);
  const {form}=await structuralForm(f,reply);
  assert.deepEqual(checkDiscoveryAssessmentForm(f.store,form).value,form);
  const extra:any=structuredClone(form);extra.novelty.transition.sufficiency.methodologyRequirements.push({claim:other,dated:false,versioned:false,independentConfirmation:false,reason:'Not actually used to close'});
  refused(f,extra,`${requirementsAt}.1.claim`);
});

// These records are deliberately corrupt negative prerequisites, never accepted
// evidence or paid assessments. A real paid attempt carries the top inference;
// the v3 form must refuse corruption reached through its research-answer link.
for (const [name, damaged, field] of [
  ['missing kind', {id:'damaged'}, `${requirementsAt}.claim.kind`],
  ['unknown kind', {id:'damaged',kind:'FAKT'}, `${requirementsAt}.claim.kind`],
  ['array kind', {id:'damaged',kind:['hypothesis']}, `${requirementsAt}.claim.kind`],
  ['null kind', {id:'damaged',kind:null}, `${requirementsAt}.claim.kind`],
  ['empty premises', {id:'damaged',kind:'inference',basis:{from:[],reasoning:'Lost premises'}}, `${requirementsAt}.claim.basis.from`],
  ['missing premises', {id:'damaged',kind:'inference',basis:{reasoning:'Lost premises'}}, `${requirementsAt}.claim.basis.from`],
  ['null premises', {id:'damaged',kind:'inference',basis:{from:null,reasoning:'Lost premises'}}, `${requirementsAt}.claim.basis.from`],
  ['string premises', {id:'damaged',kind:'inference',basis:{from:'claim',reasoning:'Lost premises'}}, `${requirementsAt}.claim.basis.from`],
] as const) test(`MR.1-01: transitive research-answer refuses ${name}`, async t => {
  const original=await packetFixture(t);
  const corrupt=original.store.write({id:'research-answer:corrupt-premise',kind:'research-answer',expected:0,
    value:{projectId:'p',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[damaged]}}});
  const premise={project:'p',container:reference(corrupt),containerKind:'research-answer',pointer:'/claims/0',claimId:'damaged'};
  const claims=[claimFor(original,'top','inference',{from:[premise],reasoning:'Exact prerequisite'})];
  const f=await packetOfClaims(original,claims),{form}=await structuralForm(f,closingNonFact(f,claims,[]));
  refused(f,form,field);
});
