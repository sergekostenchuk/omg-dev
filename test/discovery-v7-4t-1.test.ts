import { hashJson } from '../src/canonical.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
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
import { attemptAccountKey, projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-4t1-"));
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
/** Frame/plan preparation uses answerDiscoveryFixture; this fixture is not a live D1/D2 proof.
 * Attempts, paid assessments and P applications below use their real producers. */
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
  f.engine.execute({type:'create-project',project,title:'P'});
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
  // Each edition has its own execution owner; the stage budget remains shared across them.
  const runs=new Map<string,string>();
  const prepare=(selected=subject())=>{
    const context={history:[],readings:[]};
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const runId=runs.get(selected.planAnswer.hash);
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runs.set(selected.planAnswer.hash,run.id); const number=run.value.turns+1;
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

import { applyDiscoveryAssessment, readV7AssessmentReplay, readV7ProgressStateAt, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';

type Setup = Awaited<ReturnType<typeof setup>>;
const noEnd = () => ({ type:'impossible', code:'source_unavailable', evidence:[], text:'No source' });
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
  accept?:boolean; requirements?:boolean; question?:string; tokens?:number; transition?:unknown}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:options.question??'q-industry',entries});
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
    noProgress:entries.filter(e=>!accepted.some(c=>c.container.id===e.attempt.id)
      && !(options.transition as any)?.bases?.some((b:any)=>b.constraint?.id===e.attempt.id))
      .map(e=>({attempt:e.attempt,reason:'No new basis'})),transition:options.transition??null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:options.tokens??10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
const errorCode=(action:()=>unknown,code:string)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);

const snapshot=(store:Store)=>store.list().flatMap(row=>store.history(row.id));

import {variantSnapshotReadiness,produceVariantSnapshot,readVariantSnapshot,type VariantSnapshotRefusal} from '../src/discovery/variant-snapshot.js';
import {readVariantSnapshotStructural,variantRecordId,type VariantSnapshot} from '../src/discovery/discovery-variants.js';
import {discoveryAcceptanceActId} from '../src/discovery/v7-contracts.js';

async function applied(f:Setup,question='q-industry') {
  const entry=await produce(f,noEnd(),question),assessment=await assess(f,[entry],{question});
  return {...assessment,...applyDiscoveryAssessment(f.store,'p',reference(assessment.paid))};
}
function ready(f:Setup) { return produceVariantSnapshot(f.store,'p'); }
function refused(f:Setup,code:'not_ready'|'early_limit'='not_ready',store=f.store):VariantSnapshotRefusal {
  const result=variantSnapshotReadiness(store,'p');
  if(result.status==='ready')throw new Error('Unexpected ready');
  assert.equal(result.status,code);
  assert.throws(()=>produceVariantSnapshot(store,'p'),(error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,`discovery_variant_${code}`);
    assert.deepEqual(error.details,{reasons:result.reasons});return true;
  });return result;
}
function forge(f:Setup,value:VariantSnapshot) {
  return f.store.write<VariantSnapshot>({id:variantRecordId('discovery-variant-snapshot',value),kind:'discovery-variant-snapshot',expected:0,value});
}

test('4T.1: real broad sweep retains open blocking, refuses pending paid P, then publishes exact snapshot and cold repeat',async t=>{
  const f=await setup(t),first=await applied(f),entry=await produce(f,noEnd(),'q-market'),
    second=await assess(f,[entry],{question:'q-market'});
  let before=snapshot(f.store),calls=f.wires().length;
  const pending=refused(f);assert.equal(pending.status,'not_ready');
  assert.ok(pending.reasons.some(r=>r.code==='assessment_unapplied'&&r.grounds.some(g=>g.id===second.paid.id)));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
  const next=applyDiscoveryAssessment(f.store,'p',reference(second.paid)),published=ready(f),value=published.record.value;
  assert.equal(published.repeated,false);assert.equal(published.generationAllowed,true);
  assert.deepEqual(value.frame,f.v.frameRef);assert.deepEqual(value.plan,f.v.planAnswer);
  const act=f.store.get<any>(discoveryAcceptanceActId('p',f.v.draft.id,'plan',f.v.planAnswer))!;
  assert.deepEqual(value.questions.map(q=>[q.planQuestionId,q.blocking,q.question]),[
    ['q-industry',true,act.value.questionAfter],['q-market',false,act.value.questionAfter]]);
  assert.deepEqual(value.questions.map(q=>q.progress),[reference(first.state),reference(next.state)]);
  assert.ok(value.questions.every(q=>q.reason?.code==='progress_open'));
  assert.equal(first.state.value.summary.reason,null);
  assert.equal(value.questions[0]!.reason!.message,`Applied progress remains open after ${first.state.value.summary.count} accounted attempts; no-progress streak ${first.state.value.summary.streak}`);
  assert.deepEqual(value.questions[0]!.applications,first.applications.map(reference));
  assert.deepEqual(readVariantSnapshotStructural(f.store,'p',reference(published.record)).record,published.record);
  before=snapshot(f.store);calls=f.wires().length;
  const cold=produceVariantSnapshot(f.open(),'p');assert.equal(cold.status,'ready');
  if(cold.status==='ready'){assert.equal(cold.repeated,true);assert.deepEqual(cold.record,published.record);}
  assert.deepEqual(readVariantSnapshot(f.open(),'p',reference(published.record)),published.record);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

test('4T.1-01: a lawful fully covered paid packet replays cold without blocking the same snapshot',async t=>{
  const f=await setup(t),entry=await produce(f),first=await assess(f,[entry]);
  const original=applyDiscoveryAssessment(f.store,'p',reference(first.paid));await applied(f,'q-market');
  const published=ready(f).record,second=await assess(f,[entry]);assert.notEqual(second.paid.id,first.paid.id);
  const before=snapshot(f.store),calls=f.wires().length;
  const replay=applyDiscoveryAssessment(f.open(),'p',reference(second.paid));assert.equal(replay.repeated,true);
  assert.deepEqual(replay.state,original.state);assert.deepEqual(replay.applications,original.applications);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
  const cold=f.open(),read=readV7AssessmentReplay(cold,'p',reference(second.paid));assert.deepEqual(read,replay);
  assert.equal(variantSnapshotReadiness(cold,'p').status,'ready');
  const repeated=produceVariantSnapshot(cold,'p');assert.equal(repeated.repeated,true);assert.deepEqual(repeated.record,published);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

test('4T.1-01: a paid packet with an uncovered remainder stays pending and the replay reader does not apply it',async t=>{
  const f=await setup(t),entry=await produce(f),first=await assess(f,[entry]);
  applyDiscoveryAssessment(f.store,'p',reference(first.paid));await applied(f,'q-market');
  const remaining=await produce(f),second=await assess(f,[entry,remaining]);
  const before=snapshot(f.store),calls=f.wires().length;
  assert.equal(readV7AssessmentReplay(f.open(),'p',reference(second.paid)),null);
  const result=refused(f);assert.ok(result.reasons.some(r=>r.code==='assessment_unapplied'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

for(const damage of ['account','application'] as const)test(`4T.1-01: an unproved ${damage} cannot masquerade as a covered packet`,async t=>{
  const f=await setup(t),entry=await produce(f),first=await assess(f,[entry]);
  applyDiscoveryAssessment(f.store,'p',reference(first.paid));await applied(f,'q-market');
  const remaining=await produce(f),second=await assess(f,[entry,remaining]);
  const saved=f.store.get<any>(attemptAccountKey(second.packet,entry.attempt),1)!;
  // Negative corruption only: a manufactured account of the new K is not a P.3 application.
  const fake={...saved.value,attempt:remaining.attempt,
    ...(damage==='application'?{application:{id:'v7-progress-application:missing',revision:1,hash:saved.hash}}:{})};
  f.store.write({id:attemptAccountKey(second.packet,remaining.attempt),kind:saved.kind,expected:0,value:fake});
  const before=snapshot(f.store),calls=f.wires().length;
  errorCode(()=>readV7AssessmentReplay(f.open(),'p',reference(second.paid)),'discovery_progress_conflict');
  errorCode(()=>produceVariantSnapshot(f.open(),'p'),'discovery_progress_conflict');
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

test('4T.1-01: a real paid reassessment cannot change the previously accepted claims through replay',async t=>{
  const f=await setup(t),end={type:'submitted',contract:'discovery-claims/v7',value:{claims:[{id:'h',kind:'hypothesis',
    text:'The product may use one shared inventory',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
    scope:{variants:'common'},basis:{howToVerify:'Measure shared inventory use'}}]}},entry=await produce(f,end),first=await assess(f,[entry]);
  applyDiscoveryAssessment(f.store,'p',reference(first.paid));await applied(f,'q-market');
  const second=await assess(f,[entry],{accept:true}),before=snapshot(f.store),calls=f.wires().length;
  for(const action of [()=>readV7AssessmentReplay(f.open(),'p',reference(second.paid)),
    ()=>applyDiscoveryAssessment(f.open(),'p',reference(second.paid)),()=>produceVariantSnapshot(f.open(),'p')])
    errorCode(action,'discovery_progress_conflict');
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

test('4T.1: an unstarted question and a completed but unpaid K cannot be covered by caller text or run pause',async t=>{
  const f=await setup(t);await applied(f);
  // Deliberately forged diagnostic: a pause is not a budget producer or a coverage reason.
  const run=f.store.list<ResearchRun>('research-run').find(r=>r.value.draftId===f.v.draft.id)!;
  f.store.write({id:`research-run:${hashJson(['p',f.v.draft.id])}`,kind:'research-run',expected:0,
    value:{...run.value,status:'paused',pauseCode:'discovery_budget_reserve',error:'Caller says this missing question is covered'}});
  let before=snapshot(f.store),sent=f.wires().length;
  let result=refused(f);assert.equal(result.status,'not_ready');
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,sent);
  await produce(f,noEnd(),'q-market');before=snapshot(f.store);sent=f.wires().length;
  result=refused(f);assert.equal(result.status,'not_ready');
  assert.ok(result.reasons.some(r=>r.code==='assessment_unpaid'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,sent);
});

test('4T.1: historical proof rejects foreign progress, missing/reordered applications and invented or missing explanations',async t=>{
  const f=await setup(t);await applied(f);await applied(f);await applied(f,'q-market');
  const original=ready(f).record;
  const changes:((v:VariantSnapshot)=>void)[]=[
    v=>{v.questions[0]!.progress=v.questions[1]!.progress;},
    v=>{v.questions[0]!.applications.shift();},
    v=>{v.questions[0]!.applications.reverse();},
    v=>{v.questions[0]!.reason!.message='A caller made up a missing source';},
    v=>{v.questions[0]!.reason=null;},
    v=>{v.questions[1]!.progress=null;v.questions[1]!.applications=[];v.questions[1]!.reason={code:'source_missing',message:'Caller says ready',grounds:[v.plan]};},
    v=>{v.questions[0]!.question=v.plan;},
    v=>{v.frame=v.plan;},
    v=>{v.questions.reverse();}
  ];
  for(const change of changes){const value=structuredClone(original.value);change(value);const bad=forge(f,value),before=snapshot(f.store);
    errorCode(()=>readVariantSnapshot(f.open(),'p',reference(bad)),'discovery_variant_basis_invalid');assert.deepEqual(snapshot(f.store),before);}
});

test('4T.1: all exact applications remain in order through stalled; historical heads are not current CAS guards',async t=>{
  const f=await setup(t);const chain=[];
  for(let i=0;i<3;i++)chain.push(await applied(f));
  await applied(f,'q-market');const result=ready(f);
  assert.deepEqual(result.record.value.questions[0]!.applications,chain.flatMap(a=>a.applications.map(reference)));
  assert.equal(result.record.value.questions[0]!.reason!.code,'progress_stalled');
  const state=readV7ProgressStateAt(f.store,result.record.value.questions[0]!.progress!);
  assert.equal(state.value.summary.streak,3);assert.equal(state.value.summary.outcome,'stalled');
  const own=result.guards.filter(g=>g.id===state.id);assert.deepEqual(own,[reference(state)]);
  const before=snapshot(f.store);assert.deepEqual(readVariantSnapshot(f.open(),'p',reference(result.record)),result.record);
  assert.deepEqual(snapshot(f.store),before);
});

test('4T.1: a real new plan accepted by the second Store before the lock invalidates preliminary readiness',async t=>{
  const f=await setup(t);await applied(f);await applied(f,'q-market');
  assert.equal(variantSnapshotReadiness(f.store,'p').status,'ready');
  const db=f.open();nextEdition({...f,store:db,discovery:new Discovery(db),engine:new ProductEngine(db)});
  const before=snapshot(f.store),calls=f.wires().length;
  errorCode(()=>produceVariantSnapshot(f.store,'p'),'discovery_variant_not_ready');
  assert.equal(f.store.list('discovery-variant-snapshot').length,0);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

import {synthesisSession,readSynthesisSessionV3} from '../src/discovery/synthesis-session.js';
import {readerPilot,pilotEnvironment} from '../src/discovery/reader-pilot.js';
import {discoveryTraversal} from '../src/discovery/discovery-outcome.js';

async function cutSession(f:Setup) {
  const command=f.environment.value.implementer.command!;
  f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,
    stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,
    maxRequestChars:100000,maxReadChars:20000,maxReplyChars:200000,maxCalls:50,maxReportedTokens:100000}});
  const pilot=readerPilot(f.store,'p')!,source=f.discovery.evidence.document('p','snapshot-source','A source with an unresolved exception','text/plain',0);
  const observation=f.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:source.value.content.length});
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{const rows=write(writes,guards);
    if(!cut&&writes.some(w=>w.kind==='synthesis-session'&&w.expected===0)){cut=true;throw new Error('4T.1 stop after actual session producer before first intent');}
    return rows;}) as typeof f.store.writeMany;
  try{await assert.rejects(()=>synthesisSession(f.store,f.store.get<DiscoveryDraft>(f.v.draft.id)!,f.v.plan,f.environment,
    pilotEnvironment(f.environment.value,pilot.value),pilot,{role:'research',stage:'discovery',subject:f.subject(),
      workingSelections:[{kind:'context',value:observation}],inventory:{sources:[]},history:[]},'Synthesize'),/stop after actual session producer/);}
  finally{f.store.writeMany=write;}
  assert.ok(cut);const session=f.store.list('synthesis-session')[0]!;
  assert.deepEqual(readSynthesisSessionV3(f.open(),reference(session)),session);return session;
}
function nextEdition(f:Setup) {
  const question=f.store.get<Question>(f.v.plan.id)!;f.discovery.reopen(question.id,question.revision);
  const source=f.discovery.evidence.document('p','edition-two','The revised research basis','text/plain',0),old=f.v.planAnswer;
  answerDiscoveryFixture(f.engine,'p',f.store.get<DiscoveryDraft>(f.v.draft.id)!,f.store.get<Question>(question.id)!,
    validPlan(f.v.frameRef,[planQuestion('q-industry','industry','blocking'),planQuestion('q-market','market')],2,old),source);
  f.v.plan=f.store.get<Question>(question.id)!;f.v.planAnswer=f.v.plan.value.answer!;f.v.draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!;
}

test('4T.1: a real synthesis session before its first intent blocks a covered front without dispatch or writes',async t=>{
  const f=await setup(t);await applied(f);await applied(f,'q-market');
  const preliminary=variantSnapshotReadiness(f.store,'p');assert.equal(preliminary.status,'ready');
  if(preliminary.status!=='ready')throw new Error('ready');
  const pinned=preliminary.guards.map(g=>f.store.get(g.id));
  const db=f.open(),session=await cutSession({...f,store:db,discovery:new Discovery(db),engine:new ProductEngine(db)});
  assert.deepEqual(preliminary.guards.map(g=>f.store.get(g.id)),pinned,'first session does not move prior plan/P/budget/runner/dispatch heads');
  const before=snapshot(f.store),calls=f.wires().length;
  const result=refused(f,'not_ready',f.open());assert.equal(result.status,'not_ready');
  assert.ok(result.reasons.some(r=>r.code==='session_pending'&&r.grounds.some(g=>g.id===session.id)));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
  assert.equal(f.store.list<ResearchConsumerIntent>('research-consumer-intent').filter(i=>i.value.owner.id===session.id).length,0);
});

test('4T.1: a second plan edition cannot inherit old P; old unpaid intent/session do not block its own complete snapshot',async t=>{
  const f=await setup(t);await applied(f);await applied(f,'q-market');const old=ready(f).record;
  f.prepare(f.subject());await cutSession(f);nextEdition(f);
  const before=snapshot(f.store),calls=f.wires().length;
  assert.equal(variantSnapshotReadiness(f.open(),'p').status,'not_ready');
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
  await applied(f);await applied(f,'q-market');const current=ready(f).record;
  assert.notEqual(current.id,old.id);assert.notDeepEqual(current.value.plan,old.value.plan);
  assert.ok(current.value.questions.every(q=>q.progress&&!old.value.questions.some(o=>o.progress?.id===q.progress!.id)));
  assert.deepEqual(readVariantSnapshot(f.open(),'p',reference(old)),old);
  assert.deepEqual(readVariantSnapshot(f.open(),'p',reference(current)),current);
});

for(const full of [false,true])test(`4T.1: proved exhausted budget ${full?'preserves full snapshot while denying generation':'returns early_limit for incomplete coverage'}`,async t=>{
  const f=await setup(t);await applied(f);
  const entry=await produce(f,noEnd(),full?'q-market':'q-industry');
  const budget=discoveryTraversal(f.store,f.store.get<DiscoveryDraft>(f.v.draft.id)!)!.budget!;
  const paid=await assess(f,[entry],{question:full?'q-market':'q-industry',tokens:V7_STAGE_TOKEN_CEILING-2000000-budget.measured-1});
  applyDiscoveryAssessment(f.store,'p',reference(paid.paid));
  const before=snapshot(f.store),calls=f.wires().length,result=full?ready(f):refused(f,'early_limit');
  assert.equal(result.budget!.exhausted,true);assert.equal(result.generationAllowed,false);
  assert.equal(result.status,full?'ready':'early_limit');
  if(!full)assert.deepEqual(snapshot(f.store),before);
  else if(result.status==='ready')assert.deepEqual(readVariantSnapshot(f.open(),'p',reference(result.record)),result.record);
  assert.equal(f.wires().length,calls);
});

test('4T.1: an applied terminal unknown retains its constraint proof and needs no invented absence reason',async t=>{
  const f=await setup(t);await applied(f);
  const source=f.discovery.evidence.document('p','missing-registry','This registry is not published','text/plain',0);
  const entry=await produce(f,{type:'impossible',code:'source_unavailable',evidence:[reference(source)],text:'No registry'},'q-market');
  const paid=await assess(f,[entry],{question:'q-market',transition:{outcome:'unknown',bases:[{constraint:entry.attempt}],
    reason:'The required registry is not published',consequence:'The unsupported branch remains unknown',nextAction:'Obtain the missing registry'}});
  const application=applyDiscoveryAssessment(f.store,'p',reference(paid.paid)),result=ready(f);
  const question=result.record.value.questions[1]!;
  assert.equal(question.reason,null);assert.deepEqual(question.progress,reference(application.state));
  assert.equal(readV7ProgressStateAt(f.open(),question.progress!).value.summary.outcome,'unknown');
});

test('4T.1: prepared current work is pending; snapshot never silently sends it',async t=>{
  const f=await setup(t);await applied(f);await applied(f,'q-market');const prepared=f.prepare();
  const before=snapshot(f.store),calls=f.wires().length,result=refused(f);
  assert.equal(result.status,'not_ready');assert.ok(result.reasons.some(r=>r.code==='consumer_pending'&&r.grounds.some(g=>g.id===prepared.intent.id)));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

for(const damage of ['subject','progress','reason'] as const)test(`4T.1: lost own ${damage} is a typed refusal, never readiness`,async t=>{
  const f=await setup(t);await applied(f);await applied(f,'q-market');
  if(damage==='subject'){
    const prepared=f.prepare(),row=f.store.get<ResearchConsumerIntent>(prepared.intent.id)!,value=structuredClone(row.value);
    delete value.cursor.subject;f.store.write({id:row.id,kind:row.kind,expected:row.revision,value});
    const before=snapshot(f.store);errorCode(()=>produceVariantSnapshot(f.store,'p'),'discovery_variant_basis_invalid');assert.deepEqual(snapshot(f.store),before);
  }else{
    const original=ready(f).record,value=structuredClone(original.value) as any;
    delete value.questions[0][damage];const row=forge(f,value),before=snapshot(f.store);
    errorCode(()=>readVariantSnapshot(f.open(),'p',reference(row)),'discovery_variant_basis_invalid');assert.deepEqual(snapshot(f.store),before);
  }
});

import {storeEvents} from '../src/storage/store.js';
test('4T.1: atomic preparation rolls back callback, guard and later-write failures; repeat changes no primary stamp',t=>{
  const f=fixture(t),guard=f.store.write({id:'basis',kind:'basis',expected:0,value:{proof:'saved'}}),before=snapshot(f.store),stamp=f.store.changeStamp();
  assert.throws(()=>f.store.atomicWrite(()=>{throw new Error('callback failed');}),/callback failed/);
  errorCode(()=>f.store.atomicWrite(()=>({value:null,writes:[{id:'new',kind:'row',expected:0,value:{}}],guards:[{id:guard.id,absent:true}]})),'input_stale');
  errorCode(()=>f.store.atomicWrite(()=>({value:null,writes:[{id:'new',kind:'row',expected:0,value:{}},{id:guard.id,kind:guard.kind,expected:0,value:{}}],guards:[]})),'revision_conflict');
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.store.changeStamp(),stamp);
  const repeat=f.store.atomicWrite(view=>({value:view.get(guard.id),writes:[],guards:[reference(guard)]}));
  assert.deepEqual(repeat,{value:guard,records:[]});assert.equal(f.store.changeStamp(),stamp);assert.deepEqual(snapshot(f.store),before);
  const written=f.store.atomicWrite(view=>({value:reference(view.get(guard.id)!),writes:[{id:'new',kind:'row',expected:0,value:{proof:'new'}}],guards:[reference(guard)]}));
  assert.equal(written.records.length,1);assert.deepEqual(written.value,reference(guard));
});

test('4T.1: preparation rejects async and nested writes through either view or captured connection',t=>{
  const f=fixture(t),before=snapshot(f.store),input={id:'bad',kind:'row',expected:0,value:{}};
  const illegal=[
    (view:Store)=>{view.write(input);},(view:Store)=>{view.writeMany([input]);},
    (_view:Store)=>{f.store.write(input);},(_view:Store)=>{f.store.atomicWrite(()=>({value:null,writes:[],guards:[]}));}
  ];
  for(const action of illegal){errorCode(()=>f.store.atomicWrite(view=>{action(view);return {value:null,writes:[],guards:[]};}),'store_atomic_prepare_invalid');assert.deepEqual(snapshot(f.store),before);}
  errorCode(()=>f.store.atomicWrite((()=>Promise.resolve({value:null,writes:[],guards:[]})) as any),'store_atomic_prepare_invalid');
  assert.deepEqual(snapshot(f.store),before);
});

test('4T.1: a second writer cannot insert after the lock; real P proof and publication work with cold and warm cache',async t=>{
  const f=await setup(t);await applied(f);await applied(f,'q-market');
  // Warm common P proofs outside the atomic operation. The operation itself must skip cache transactions.
  const preliminary=variantSnapshotReadiness(f.store,'p');assert.equal(preliminary.status,'ready');
  const other=f.open(),atomic=f.store.atomicWrite.bind(f.store);let blocked=false;
  f.store.atomicWrite=((prepare:any)=>atomic(view=>{
    assert.throws(()=>other.write({id:'phantom-after-lock',kind:'row',expected:0,value:{}}),(error:any)=>{
      blocked=error.errcode===5||error.errcode===6;return blocked;});
    return prepare(view);
  })) as typeof f.store.atomicWrite;
  const writes=storeEvents().cacheWrites,result=ready(f);assert.ok(blocked);assert.equal(f.store.get('phantom-after-lock'),null);
  assert.equal(storeEvents().cacheWrites,writes,'no nested proof-cache transaction');f.store.atomicWrite=atomic;
  const before=snapshot(f.store),cold=f.open(),stamp=cold.changeStamp(),again=produceVariantSnapshot(cold,'p');
  assert.deepEqual(again.record,result.record);assert.equal(again.repeated,true);assert.equal(cold.changeStamp(),stamp);
  assert.deepEqual(snapshot(f.store),before);
});
