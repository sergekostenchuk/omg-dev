import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, storeReads, type Revision } from '../src/storage/store.js';
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
import { projectAttemptPacket, attemptAccountKey } from '../src/discovery/v7-attempt-assessment.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-p5-"));
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
  const prepare=(selected=subject())=>{
    const context={history:[],readings:[]};
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=()=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,subject,prepare,wires,environment,settings};
}

import { applyDiscoveryAssessment, readV7ProgressStateAt, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { proveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
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
  accept?:boolean; requirements?:boolean}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:'q-industry',entries});
  const baseline=options.baseline??v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.accept?claims:[];
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:accepted.map(claim=>({claim,reason:'New basis'})),duplicates:[],
    noProgress:entries.filter(e=>!accepted.some(c=>c.container.id===e.attempt.id))
      .map(e=>({attempt:e.attempt,reason:'No new basis'})),transition:null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
const errorCode=(action:()=>unknown,code:string)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);

const snapshot=(store:Store)=>store.list().flatMap(row=>store.history(row.id));
function replay(f:Setup,a:Awaited<ReturnType<typeof assess>>,db:Store) {
  return (a.paid.value.contract==='discovery-assessment/v3'?assessAttemptsWithRequirements:assessAttempts)(
    db,a.packet,a.baseline,f.environment,f.root);
}

for(const requirements of [false,true]) {
  test(`P.5: paid ${requirements?'v3':'v2'} replay stays free across actual absent→state and state→next`,async t=>{
    const f=await setup(t),one=await produce(f,hypothesis(f,'First accepted basis')),
      a=await assess(f,[one],{accept:true,requirements});
    assert.equal(a.baseline.state.kind,'absent');
    const first=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
    let records=snapshot(f.store),sent=f.wires().length;
    assert.deepEqual(await replay(f,a,f.open()),a.paid);
    assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
    const two=await produce(f,hypothesis(f,'Second accepted basis')),
      b=await assess(f,[two],{accept:true,requirements});
    assert.deepEqual(b.baseline.state,{kind:'state',ref:reference(first.state)});
    const second=applyDiscoveryAssessment(f.store,'p',reference(b.paid));
    assert.equal(second.state.revision,first.state.revision+1);
    assert.equal(second.state.value.summary.count,2);
    records=snapshot(f.store);sent=f.wires().length;
    for(const saved of [a,b]) {
      assert.deepEqual(await replay(f,saved,f.open()),saved.paid);
      assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(saved.paid)),saved.paid);
      const repeated=applyDiscoveryAssessment(f.open(),'p',reference(saved.paid));
      assert.equal(repeated.repeated,true);assert.deepEqual(repeated.state,second.state);
      assert.equal(repeated.applications.length,1);
      assert.deepEqual(repeated.applications[0]!.value.assessment,reference(saved.paid));
    }
    assert.deepEqual(readV7ProgressStateAt(f.open(),reference(first.state)),first.state);
    assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
  });
}

for(const initialState of [false,true]) {
  test(`P.5: stale ${initialState?'revision':'absent'} result reuses covered attempts and refuses fresh remainder atomically`,async t=>{
    const f=await setup(t);
    if(initialState) {
      const seed=await assess(f,[await produce(f)]);
      applyDiscoveryAssessment(f.store,'p',reference(seed.paid));
    }
    const entries=[await produce(f),await produce(f)],
      baseline=v7ProgressBaseline(f.store,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}),
      a=await assess(f,[entries[0]!],{baseline}),both=await assess(f,entries,{baseline});
    const applied=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),records=snapshot(f.store),sent=f.wires().length;
    assert.equal(applyDiscoveryAssessment(f.open(),'p',reference(a.paid)).repeated,true);
    for(let repeat=0;repeat<2;repeat++) {
      assert.throws(()=>applyDiscoveryAssessment(f.open(),'p',reference(both.paid)),(error:unknown)=>{
        assert.ok(error instanceof EngineError);assert.equal(error.code,'discovery_progress_stale');
        assert.equal((error.details as {field?:string})?.field,'baseline.state');return true;
      });
      assert.deepEqual(await replay(f,both,f.open()),both.paid);
    }
    assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
    assert.equal(f.store.get(attemptAccountKey(both.packet,entries[1]!.attempt),1),null);
    assert.deepEqual(readV7ProgressStateAt(f.open(),reference(applied.state)),applied.state);
  });
}

test('P.5: a stale fresh dispatch refuses before payment while the exact paid packet still replays',async t=>{
  const f=await setup(t),a=await assess(f,[await produce(f)],{requirements:true});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const next=await produce(f),packet=projectAttemptPacket(f.store,{...a.packet,entries:[next]}),sent=f.wires().length;
  const protectedHistory=()=>['model-call','research-budget-ledger','assessment-session','assessment-application',
    'discovery-assessment','v7-progress-state','v7-progress-application','v7-attempt-account','research-progress-event']
    .flatMap(kind=>f.store.list(kind).flatMap(row=>f.store.history(row.id)));
  const before=protectedHistory();
  await assert.rejects(assessAttemptsWithRequirements(f.open(),packet,a.baseline,f.environment,f.root),{code:'input_stale'});
  assert.deepEqual(protectedHistory(),before);assert.equal(f.wires().length,sent);
  const afterRefusal=snapshot(f.store);
  assert.deepEqual(await replay(f,a,f.open()),a.paid);
  assert.deepEqual(snapshot(f.store),afterRefusal);
});

test('P.5: paid replay, stale apply and exact accepted proof read no additional unrelated records',async t=>{
  const f=await setup(t),entries=[await produce(f,hypothesis(f,'Covered claim')),await produce(f)],
    a=await assess(f,[entries[0]!],{accept:true}),both=await assess(f,entries,{accept:true,baseline:a.baseline});
  applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const measure=async(db:Store)=>{
    const reads:number[]=[];
    let before=storeReads();assert.deepEqual(await replay(f,a,db),a.paid);reads.push(storeReads()-before);
    before=storeReads();assert.equal(applyDiscoveryAssessment(db,'p',reference(a.paid)).repeated,true);reads.push(storeReads()-before);
    before=storeReads();errorCode(()=>applyDiscoveryAssessment(db,'p',reference(both.paid)),'discovery_progress_stale');reads.push(storeReads()-before);
    before=storeReads();proveClaimAddress(db,a.claims[0]!);reads.push(storeReads()-before);
    return reads;
  };
  // Identical database images give each measurement the same cold cache;
  // measuring successive connections to one DB would warm persisted proofs.
  const image=await f.store.snapshot(join(f.root,'measurement-image')),sent=f.wires().length;
  let before:number[]|undefined;
  for(const size of [0,10,100]) {
    const path=join(f.root,`measurement-${size}.sqlite`);copyFileSync(image.path,path);
    const db=new Store(path);
    try {
    // Explicit irrelevant negative records, including tempting same-kind heads:
    // none is a real paid/accepted record or may be selected by these exact APIs.
    db.writeMany(Array.from({length:size},(_,i)=>({id:`unrelated:${size}:${i}`,expected:0,
      kind:['research-turn','discovery-assessment','v7-attempt-account','v7-progress-state','research-progress-event'][i%5]!,
      value:{projectId:i%2?'p':'foreign',planQuestionId:'unrelated',invalid:true,i}})),[]);
    const measured=await measure(db);
    if(before) assert.deepEqual(measured,before,`unrelated ${size} records must add +0 Store reads`);
    else { before=measured;assert.ok(before.every(count=>count>0)); }
    } finally { db.close(); }
  }
  t.diagnostic(`cold reads: paid replay / covered apply / stale apply / claim proof = ${before!.join(' / ')}; unrelated +10/+100 = +0`);
  assert.equal(f.wires().length,sent);
});

test('P.5: replay never substitutes a missing exact baseline with a later valid head',async t=>{
  const f=await setup(t),a=await assess(f,[await produce(f)]),first=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),
    b=await assess(f,[await produce(f)]),second=applyDiscoveryAssessment(f.store,'p',reference(b.paid));
  const sent=f.wires().length;
  // Explicit negative read boundary: only the pinned predecessor is absent;
  // its newer valid head remains available and must never substitute for it.
  const cold=f.open(),get=cold.get.bind(cold);
  cold.get=((...args:Parameters<Store['get']>)=>args[0]===first.state.id&&args[1]===first.state.revision
    ?null:get(...args)) as Store['get'];
  const records=snapshot(f.store);
  await assert.rejects(replay(f,b,cold),{code:'discovery_assessment_subject_invalid'});
  assert.throws(()=>applyDiscoveryAssessment(cold,'p',reference(b.paid)),(error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,'research_context_application_invalid');
    assert.match(error.message,/Physical outcome is not proved: discovery_assessment_subject_invalid/);return true;
  });
  assert.deepEqual(snapshot(f.store),records);assert.equal(f.wires().length,sent);
  assert.equal(f.store.get(second.state.id)!.revision,second.state.revision);
});
