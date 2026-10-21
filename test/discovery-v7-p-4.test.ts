import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
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
import { projectAttemptPacket, attemptAccountKey, claimContentKey } from '../src/discovery/v7-attempt-assessment.js';
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
  let runId: string | undefined;
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:context.dispatchMode==='planning'?'reading-planner' as const:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,...(context.dispatchMode?{mode:context.dispatchMode}:{}),instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:context.dispatchMode==='planning'?'reading-planner':'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,project,questions,subject,prepare,wires,environment,prompt,settings,calibration:{draft:old,question:q}};
}

import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { proveClaimAddress, resolveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';

type Setup = Awaited<ReturnType<typeof setup>>;
const noEnd = () => ({ type:'impossible', code:'source_unavailable', evidence:[], text:'No source' });
function hypothesis(f: Setup, text: string) {
  return { type:'submitted', contract:DISCOVERY_CLAIMS_CONTRACT, value:{claims:[{id:'h',kind:'hypothesis',text,
    axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
    basis:{howToVerify:'Measure it'}}]} };
}
async function produce(f: Setup, end: unknown = noEnd(), question = 'q-industry') {
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'answer',question,value:end,citations:[]}}));
  const m=f.prepare(f.subject(question)), response=await m.invoke();
  const execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:100,context:m.context,subject:m.selected});
  const turnId=managedTurnId(m.run.id,m.number);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id:turnId,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const call=f.store.get<ResearchConsumerIntent>(m.intent.id)!.value.call!;
  const recorded=recordV7Attempt(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:question,
    call,end:attemptEndOfAction(response,m.selected)});
  const done=completeResearchAttemptTurn(f.store,'p',reference(f.store.get(turnId)!),reference(recorded.attempt));
  return { attempt:reference(recorded.attempt),binding:reference(done.binding) };
}
type Entry=Awaited<ReturnType<typeof produce>>;
async function assess(f: Setup, entries:Entry[], options:{baseline?:ReturnType<typeof v7ProgressBaseline>;
  accept?:boolean; selected?:number[]; requirements?:boolean; question?:string; transition?:unknown; duplicates?:boolean; reverse?:boolean; methodology?:(claims:ClaimAddress[])=>unknown}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:options.question??'q-industry',entries});
  const baseline=options.baseline??v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.selected ? claims.filter((_,i)=>options.selected!.includes(i))
    :options.accept?(options.reverse?[...claims].reverse():claims):[];
  const newClaims=options.duplicates?accepted.slice(0,1):accepted;
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:newClaims.map(claim=>({claim,reason:'New basis'})),
    duplicates:options.duplicates?accepted.slice(1).map(claim=>({claim,of:accepted[0]!,reason:'Same content'})):[],
    noProgress:entries.filter(e=>!newClaims.some(c=>c.container.id===e.attempt.id)
      && !(options.transition as any)?.bases?.some((b:any)=>b.constraint?.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No new basis'})),
    transition:options.transition??null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:options.methodology?.(claims)??{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
const errorCode=(action:()=>unknown,code:string)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);

function inference(f: Setup, premise: ClaimAddress) {
  return {type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'deduction',kind:'inference',
    text:'Deduction from the saved premise',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
    scope:{variants:'common'},basis:{from:[premise],reasoning:'The named basis entails this deduction'}}]}};
}

test('P.4: paid accepted annotation without atomic application is not acceptance',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Not yet applied')),a=await assess(f,[entry],{accept:true});
  assert.equal(resolveClaimAddress(f.open(),a.claims[0]!).container.id,entry.attempt.id);
  const before=f.store.list(),wires=f.wires().length;
  assert.throws(()=>proveClaimAddress(f.open(),a.claims[0]!), (error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,'claim_attempt_not_accepted');
    assert.deepEqual(error.details,{address:a.claims[0]!});return true;
  });
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
});

test('P.4: applied rejection never accepts a resolvable claim',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Rejected')),a=await assess(f,[entry]);
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  assert.equal(resolveClaimAddress(f.open(),a.claims[0]!).container.id,entry.attempt.id);
  errorCode(()=>proveClaimAddress(f.open(),a.claims[0]!),'claim_attempt_not_accepted');
});

test('P.4: acceptance belongs to the exact pointer, not the whole attempt',async t=>{
  const f=await setup(t),end=hypothesis(f,'Rejected first');
  end.value.claims.push({...end.value.claims[0]!,id:'second',text:'Accepted second'});
  const entry=await produce(f,end),a=await assess(f,[entry],{selected:[1]});
  const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  errorCode(()=>proveClaimAddress(f.open(),a.claims[0]!),'claim_attempt_not_accepted');
  errorCode(()=>proveClaimAddress(f.open(),{...a.claims[1]!,pointer:'/claims/0'}),'claim_address_invalid');
  const proof=proveClaimAddress(f.open(),a.claims[1]!);assert.ok(proof.kind==='attempt');
  assert.deepEqual(proof.container,f.store.get(entry.attempt.id,entry.attempt.revision));
  assert.equal((proof.claim as Record<string,Json>).id,'second');
  assert.deepEqual(proof.assessment,a.paid);assert.deepEqual(proof.application,result.applications[0]);
  assert.equal(proof.answer,null);assert.equal(proof.binding,null);
});

test('P.4: accepted duplicate has its own proof and adds no content event',async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'Same content')),second=await produce(f,hypothesis(f,'Same content'));
  const a=await assess(f,[first,second],{accept:true,duplicates:true}),result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  assert.equal(result.state.value.summary.count,2);assert.equal(f.store.list('research-progress-event').length,1);
  assert.equal(f.store.list('v7-attempt-account').length,2);
  assert.equal(claimContentKey(f.open(),a.claims[0]!),claimContentKey(f.open(),a.claims[1]!));
  const before=f.store.list(),wires=f.wires().length;
  for(const claim of a.claims) {
    const proof=proveClaimAddress(f.open(),claim);assert.ok(proof.kind==='attempt');
    assert.deepEqual(proof.application,result.applications[0]);assert.deepEqual(proof.assessment,a.paid);
  }
  assert.equal(applyDiscoveryAssessment(f.open(),'p',reference(a.paid)).repeated,true);
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
});

test('P.4: common inference key proves the original accepted attempt premise',async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'Accepted premise')),a=await assess(f,[first],{accept:true});
  const one=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),second=await produce(f,inference(f,a.claims[0]!));
  const b=await assess(f,[second],{accept:true}),key=claimContentKey(f.open(),b.claims[0]!);
  const two=applyDiscoveryAssessment(f.store,'p',reference(b.paid));
  const premise=proveClaimAddress(f.open(),a.claims[0]!),deduction=proveClaimAddress(f.open(),b.claims[0]!);
  assert.ok(premise.kind==='attempt'&&deduction.kind==='attempt');
  assert.deepEqual(premise.application,one.applications[0]);assert.deepEqual(premise.assessment,a.paid);
  assert.deepEqual(deduction.application,two.applications[0]);assert.deepEqual(deduction.assessment,b.paid);
  assert.equal(claimContentKey(f.open(),b.claims[0]!),key);
});

for(const applied of [false,true]) test(`P.4: inference refuses an unaccepted premise; rejected applied=${applied}`,async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'Unaccepted premise')),a=await assess(f,[first],{accept:!applied});
  if(applied)applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const next=await produce(f,inference(f,a.claims[0]!));
  const claim:ClaimAddress={project:'p',container:next.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'deduction'};
  errorCode(()=>claimContentKey(f.open(),claim),'claim_attempt_not_accepted');
  errorCode(()=>proveClaimAddress(f.open(),claim),'claim_attempt_not_accepted');
});

test('P.4: missing, foreign and substituted address parts refuse without fallback',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Exact address')),a=await assess(f,[entry],{accept:true});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));const valid=a.claims[0]!;
  const mutations:Record<string,unknown>[]=['project','container','containerKind','pointer','claimId'].map(key=>{
    const value:Record<string,unknown>={...valid};delete value[key];return value;
  });
  mutations.push({...valid,project:'foreign'},{...valid,container:{...valid.container,hash:'0'.repeat(64)}},
    {...valid,container:{...valid.container,revision:2}},{...valid,pointer:'/claims/1'},
    {...valid,pointer:'/claims/00'},{...valid,claimId:'foreign'},{...valid,containerKind:'research-answer'});
  for(const address of mutations) errorCode(()=>proveClaimAddress(f.open(),address as unknown as ClaimAddress),'claim_address_invalid');
  assert.equal(proveClaimAddress(f.open(),valid).container.id,entry.attempt.id);
});

for(const deterministic of [false,true]) test(`P.4: copied account cannot accept another attempt; deterministic=${deterministic}`,async t=>{
  const f=await setup(t),first=await produce(f,hypothesis(f,'First')),a=await assess(f,[first],{accept:true});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const old=f.store.list<any>('v7-attempt-account')[0]!,next=await produce(f,hypothesis(f,'Unapplied second')),b=await assess(f,[next],{accept:true});
  // Explicit negative corruption: copy another application's account, changing only its claimed attempt and accepted pointer.
  const id=deterministic?attemptAccountKey(b.packet,next.attempt):'v7-attempt-account:negative-foreign-address';
  f.store.write({id,kind:'v7-attempt-account',expected:0,value:{...old.value,attempt:next.attempt,accepted:b.claims}});
  errorCode(()=>proveClaimAddress(f.open(),b.claims[0]!),deterministic?'discovery_progress_conflict':'claim_attempt_not_accepted');
  assert.equal(proveClaimAddress(f.open(),a.claims[0]!).container.id,first.attempt.id);
});

test('P.4: accepted exact claim survives a later corrupt attempt head',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'Historical claim')),a=await assess(f,[entry],{accept:true});
  const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),original=f.store.get<any>(entry.attempt.id,entry.attempt.revision)!;
  // Explicit negative corruption of a later revision; the original remains fixed by its Ref.
  const corrupt=f.store.write({id:original.id,kind:original.kind,expected:original.revision,value:{...original.value,contract:'negative/corrupt'}});
  errorCode(()=>proveClaimAddress(f.open(),{...a.claims[0]!,container:reference(corrupt)}),'claim_address_invalid');
  const proof=proveClaimAddress(f.open(),a.claims[0]!);assert.ok(proof.kind==='attempt');
  assert.deepEqual(proof.container,original);assert.deepEqual(proof.application,result.applications[0]);assert.deepEqual(proof.assessment,a.paid);
});

for(const kind of ['v7-progress-application','v7-progress-state','research-progress-event','v7-attempt-account'])
  test(`P.4: public proof refuses a missing atomic ${kind}`,async t=>{
    const f=await setup(t),entry=await produce(f,hypothesis(f,'Atomic proof')),a=await assess(f,[entry],{accept:true});
    applyDiscoveryAssessment(f.store,'p',reference(a.paid));const selected=f.store.list(kind)[0]!,cold=f.open(),get=cold.get.bind(cold);
    cold.get=((...args:Parameters<Store['get']>)=>args[0]===selected.id&&(args[1]===undefined||args[1]===selected.revision)
      ?null:get(...args)) as Store['get'];
    errorCode(()=>proveClaimAddress(cold,a.claims[0]!),kind==='v7-attempt-account'?'claim_attempt_not_accepted':'discovery_progress_conflict');
  });
