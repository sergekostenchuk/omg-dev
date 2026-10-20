import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING, DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { hashJson, type Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { uniqueTransactionGuards } from "../src/runtime/environment.js";
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { proveClaimAddress } from '../src/discovery/claim-address.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { planAttemptSelection, nextPlanQuestion, proveAttempt, type V7AttemptEnd } from '../src/discovery/v7-plan-questions.js';
import { readResearchConsumerTurn, prepareResearchConsumerIntent, completeResearchAttemptTurn } from '../src/discovery/response-recovery.js';
import { discoveryInspection } from '../src/discovery/discovery-outcome.js';
import { executionAdmission, acceptedIssuance } from '../src/discovery/projection-reader.js';
import { stageSummary } from '../src/product/stage-summary.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3a3k-"));
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
function acceptNextPlanEdition(f: Fixture, project: string, draft: Revision<DiscoveryDraft>, frameRef: Ref,
  previous: Ref, questions: PlanQuestion[]) {
  const planQ = questionOf(f.store, f.store.get<DiscoveryDraft>(draft.id)!, "plan");
  f.discovery.reopen(planQ.id, planQ.revision);
  const reopened = f.store.get<Question>(planQ.id)!;
  const src = f.discovery.evidence.document(project, `basis-${rand()}`, `Source ${rand()}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!, reopened,
    validPlan(frameRef, questions, 2, previous), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(draft.id)!, plan, planAnswer: plan.value.answer! };
}


async function setup(t: test.TestContext, questions = [planQuestion('support','market'), planQuestion('block','industry','blocking')]) {
  const f=fixture(t);f.engine.execute({type:'create-project',project:'p',title:'P'});
  const wire=join(f.root,'wire.ndjson'), settings=join(f.root,'reply.json'), adapter=join(f.root,'adapter.mjs');
  const configure=(replies: unknown[]=[], tokens=10)=>writeFileSync(settings,JSON.stringify({replies,tokens}));
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
let previous=[];try{previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
let research=s.replies[previous.length]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=r.subject.question.id;
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command={executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure('p',{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},
    fullCheck:command,timeoutMs:5000},0);
  const calibration=f.discovery.create('p','discovery','R0','concept',[
    {field:'probe',kind:'fact',prompt:'Calibrate',risk:'unknown',schema:{type:'object'}}],[],6);
  await researchCall(environment.value.implementer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'analyst'});
  configure([ended(),{necessary:true,reason:'Calibration review'}]);
  await researchCall(environment.value.reviewer,environment.value,'Calibrate reviewer',{},undefined,
    {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'escalation-assessor'});
  configure();writeFileSync(wire,'');
  const v=acceptPlan(f,'p',questions);
  const run=(limit=8,store=f.store, policy=true)=>new Researcher(store,new Discovery(store),new ProductEngine(store).environments)
    .run('p',v.draft.id,limit,undefined,policy?{producerPolicy:{discovery:7}}:{});
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const history=()=>f.store.list().map(row=>[row.id,row.revision,row.hash]);
  return {...f,v,questions,run,wires,history,configure,environment};
}

const ended=(type='impossible')=>({action:'answer',question:'$selected',value:{type,code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]});

test('R: real initial traversal orders blocking first, uses reservation @1 and leaves Discovery researching',async t=>{
  const f=await setup(t), beforeDraft=f.store.get(f.v.draft.id), beforeQuestion=f.store.get(f.v.plan.id);
  const batches:string[][]=[],write=f.store.writeMany.bind(f.store);
  f.store.writeMany=((writes,guards=[])=>{if(writes.some(w=>w.kind==='model-call'&&w.expected===0))batches.push(writes.map(w=>w.kind));return write(writes,guards);}) as typeof f.store.writeMany;
  f.configure([ended('refused'),ended()]);
  const run=await f.run();assert.equal(run.value.status,'completed',JSON.stringify(run.value));
  assert.deepEqual(f.wires().map(w=>w.subject.question.id),['block','support']);
  assert.deepEqual(f.store.get(f.v.draft.id),beforeDraft);assert.deepEqual(f.store.get(f.v.plan.id),beforeQuestion);
  const attempts=f.store.list<any>('research-attempt');assert.equal(attempts.length,2);
  for(const attempt of attempts){
    const proof=proveAttempt(f.store,reference(attempt));assert.equal(proof.attempt.value.call.revision,1);
    assert.equal(f.store.get<any>(attempt.value.call.id,1)!.value.status,'running');
    assert.equal(f.store.get<any>(attempt.value.call.id)!.value.status,'succeeded');
  }
  for(const turn of f.store.list<any>('research-turn')){const proved=readResearchConsumerTurn(f.store,reference(turn));assert.equal(proved.value.status,'completed');assert.ok(proved.value.attemptBinding);}
  assert.ok(batches[0]!.includes('research-budget'));
  for(const kinds of batches)for(const kind of ['research-budget-ledger','model-call','research-consumer-intent','request-manifest'])assert.ok(kinds.includes(kind),`${kind}: ${kinds.join(',')}`);
  assert.equal(planAttemptSelection(f.store,'p').next,null);assert.equal(nextPlanQuestion(f.store,'p')!.planQuestionId,'block');
  assert.equal(discoveryInspection(f.store,f.store.get<DiscoveryDraft>(f.v.draft.id)!).outcome.state,'researching');
  assert.equal(acceptedIssuance(f.store,f.v.draft).issued,false);
  const saved=f.history();await f.run(1,f.open(),false);assert.deepEqual(f.history(),saved);assert.equal(f.wires().length,2);
});

for(const boundary of ['paid','attempt','binding'] as const)test(`R: cold recovery after ${boundary} never repays or adds ledger`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]),write=f.store.writeMany.bind(f.store);
  let interrupted=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!interrupted&&writes.some(w=>boundary==='paid'?w.kind==='research-turn'&&w.expected===0:
      boundary==='attempt'?w.kind==='research-attempt':w.kind==='research-attempt-binding')){
      interrupted=true;if(boundary==='attempt')write(writes,guards);throw new Error(`cut-${boundary}`);
    }return write(writes,guards);
  }) as typeof f.store.writeMany;
  const paused=await f.run();assert.equal(interrupted,true);assert.equal(paused.value.status,'paused',JSON.stringify(paused.value));
  f.store.writeMany=write;
  const calls=f.wires().length,ledgers=f.store.list('research-budget-ledger');
  const done=await f.run(1,f.open(),false);assert.equal(done.value.status,'completed',JSON.stringify(done.value));
  assert.equal(f.wires().length,calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledgers);
  assert.equal(f.store.list('research-attempt').length,1);assert.equal(f.store.list('research-attempt-binding').length,1);
  const saved=f.history();await f.run(1,f.open(),false);assert.deepEqual(f.history(),saved);
});

test('R: default v7 stays off, allowance pauses before a new question and completed turns recover first',async t=>{
  const f=await setup(t);
  await assert.rejects(f.run(1,f.store,false),{code:'research_contract_upgrade_required'});assert.equal(f.wires().length,0);
  const paused=await f.run(1);assert.equal(paused.value.status,'paused');assert.equal(paused.value.pauseCode,'research_turns_exhausted');
  assert.equal(f.store.list('research-attempt').length,1);assert.equal(f.wires().length,1);
  const done=await f.run(1,f.open());assert.equal(done.value.status,'completed',JSON.stringify(done.value));assert.equal(f.wires().length,2);
});

for(const recorded of [false,true])test(`R: plan replacement ${recorded?'finishes the recorded attempt':'keeps a paid answer pending at its exact door'}`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]),write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut&&writes.some(w=>w.kind===(recorded?'research-attempt-binding':'research-attempt'))){cut=true;throw new Error('cut');}
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  await f.run();assert.equal(cut,true);f.store.writeMany=write;
  const ledger=f.store.list('research-budget-ledger'),calls=f.wires().length;
  acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,[planQuestion('next','market')]);
  const result=await f.run(1,f.open(),false);
  assert.equal(result.value.status,'paused');
  assert.equal(result.value.pauseCode,recorded?'research_contract_upgrade_required':'attempt_invalid',JSON.stringify(result.value));
  const turn=f.store.list<any>('research-turn')[0]!;
  assert.equal(turn.value.status,recorded?'completed':'pending');
  assert.deepEqual(turn.value.subject,{contract:'v7-plan-subject/v1',planAnswer:f.v.planAnswer,planQuestionId:'block'});
  assert.equal(f.store.list('research-attempt').length,recorded?1:0);
  assert.equal(f.store.list('research-attempt-binding').length,recorded?1:0);
  assert.equal(f.wires().length,calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  await f.run(1,f.open(),false);assert.equal(f.wires().length,calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

test('R: a deep attempt conflict retains paid response and exact pending subject',async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const missing={id:'source:missing',revision:1,hash:'a'.repeat(64)};
  f.configure([{...ended(),value:{type:'impossible',code:'source_unavailable',evidence:[missing],text:'Not proven'}}]);
  const paused=await f.run();assert.equal(paused.value.status,'paused');assert.equal(paused.value.pauseCode,'attempt_invalid',JSON.stringify(paused.value));
  assert.equal(f.store.list('research-attempt').length,0);assert.equal(f.store.list<any>('research-turn')[0]!.value.status,'pending');
  const paid=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await f.run(1,f.open(),false);assert.deepEqual(f.store.list('model-call'),paid);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

test('R: budget exhaustion preserves the completed paid attempt and blocks the next dispatch',async t=>{
  const f=await setup(t);f.configure([],V7_STAGE_TOKEN_CEILING);
  const result=await f.run();assert.equal(result.value.status,'paused');
  assert.equal(result.value.pauseCode,'discovery_budget_overrun',JSON.stringify(result.value));
  assert.equal(f.wires().length,1);assert.equal(f.store.list('research-attempt').length,1);
  assert.equal(f.store.list<any>('research-turn')[0]!.value.status,'completed');
});

test('R: owner pause is proved by logical subject and survives cold summary and a new plan edition',async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const source=f.discovery.evidence.document('p','owner-research','The owner chooses a jurisdiction.','text/plain',0),ref=reference(source);
  f.configure([{action:'read_source',source:ref,start:0,end:source.value.content.length},
    {action:'need_owner',question:'$selected',reason:'Choose a jurisdiction',searched:[ref]},
    {necessary:true,reason:'Jurisdiction must be chosen by the owner'}]);
  const run=await f.run();assert.equal(run.value.status,'needs_owner',JSON.stringify(run.value));
  assert.deepEqual(run.value.ownerQuestion,{question:'block',reason:'Jurisdiction must be chosen by the owner',searched:[ref]});
  assert.equal(f.store.get<Question>(f.v.plan.id)!.value.status,'answered');
  const cold=f.open(),summary=stageSummary(cold,'p','discovery',f.v.draft.id);
  assert.equal(summary.candidate!.runFailure,null,JSON.stringify(summary));
  assert.equal(summary.candidate!.run!.status,'needs_owner');
  assert.deepEqual(summary.candidate!.run!.subject,{contract:'v7-plan-subject/v1',planAnswer:f.v.planAnswer,planQuestionId:'block'});
  const before=f.history();assert.deepEqual(await f.run(1,cold,false),run);assert.deepEqual(f.history(),before);
  acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,[planQuestion('next','market')]);
  const edited=f.history();assert.deepEqual(await f.run(1,f.open(),false),run);assert.deepEqual(f.history(),edited);
  const updated=stageSummary(f.open(),'p','discovery',f.v.draft.id);
  assert.equal(updated.candidate!.runFailure,null);assert.deepEqual(updated.candidate!.run!.subject,summary.candidate!.run!.subject);
  assert.equal(f.wires().length,3);
});

test('R: acceptance gates require a proved plan and keep the new stage-result route closed',async t=>{
  const f=await setup(t),before=f.history();
  assert.equal(executionAdmission(f.store,f.v.draft,'new-research').admitted,false);
  assert.equal(executionAdmission(f.store,f.v.draft,'new-research',{discovery:7}).admitted,true);
  assert.equal(executionAdmission(f.store,f.v.draft,'stage-result',{discovery:7}).admitted,false);
  assert.deepEqual(f.history(),before);
  const plan=f.store.get<Question>(f.v.plan.id)!;f.discovery.reopen(plan.id,plan.revision);
  await assert.rejects(f.run(),{code:'plan_questions_invalid'});assert.equal(f.wires().length,0);
});

test('R: submitted and duplicate ends use ordinary paid calls without accepting their claims',async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]),write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut&&writes.some(w=>w.kind==='research-consumer-intent'&&w.expected===0)){cut=true;throw new Error('before prepare');}
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  const paused=await f.run();assert.equal(cut,true);f.store.writeMany=write;
  const source=f.discovery.evidence.document('p','claim-basis','Evidence for claim','text/plain',0);
  const end={type:'submitted' as const,contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'fact',kind:'fact',text:'Claim',axis:'industry',
    planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'block'}],scope:{variants:'common'},
    basis:{source:{ref:reference(source),range:{start:0,end:3},valueHash:hashJson('Evi')},limit:'snapshot',asOf:'2026-10'}}]}} as unknown as V7AttemptEnd;
  f.configure([{...ended(),value:end}]);
  const owner=f.store.write({id:'research-run:independent',kind:'research-run',expected:0,value:{...paused.value,status:'running' as const}});
  const subject={contract:'v7-plan-subject/v1' as const,planAnswer:f.v.planAnswer,planQuestionId:'block'};
  const context={role:'research',history:[],readings:[],contextWorkspace:[]},instruction='Return a submitted attempt for this exact plan question.';
  const intent=prepareResearchConsumerIntent(f.store,{projectId:'p',kind:'analyst',key:owner.id,owner:reference(owner),
    draft:reference(f.v.draft),question:reference(f.v.plan),role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,
    cursor:{run:owner.id,turn:1,mode:null,instruction,context,subject},basis:[],
    guards:uniqueTransactionGuards([reference(owner),reference(f.v.draft),reference(f.v.plan),reference(f.environment)])});
  await researchCall(f.environment.value.implementer,f.environment.value,instruction,context,undefined,
    {store:f.store,draftId:f.v.draft.id,questionId:f.v.plan.id,purpose:'analyst',consumerIntent:reference(intent)});
  const original=recordV7Attempt(f.store,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'block',
    call:f.store.get<any>(intent.id)!.value.call,end});
  f.configure([{...ended(),value:end},{...ended(),value:{type:'duplicate',of:reference(original.attempt)}}]);
  const current=f.store.get<any>(paused.id)!;
  prepareResearchConsumerIntent(f.store,{projectId:'p',kind:'analyst',key:hashJson([paused.id,1,'analyst']),owner:reference(current),
    draft:reference(f.v.draft),question:reference(f.v.plan),role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,
    cursor:{run:paused.id,turn:1,mode:null,instruction,context,subject},basis:[],
    guards:uniqueTransactionGuards([reference(current),reference(f.v.draft),reference(f.v.plan),reference(f.environment)])});
  const done=await f.run(1,f.open());assert.equal(done.value.status,'completed',JSON.stringify(done.value));
  assert.deepEqual(f.store.list<any>('research-attempt').map(a=>a.value.end.type).sort(),['duplicate','submitted']);
  assert.equal(f.wires().length,2);
  assert.throws(()=>proveClaimAddress(f.store,{project:'p',container:reference(original.attempt),containerKind:'research-attempt',pointer:'/claims/0',claimId:'fact'}),{code:'claim_attempt_not_accepted'});
});

test('R: a competing completion wins the K batch without partial binding or overwriting its run',async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]),second=f.open(),write=f.store.writeMany.bind(f.store);let winner:unknown;
  f.store.writeMany=((writes,guards=[])=>{
    if(!winner&&writes.some(w=>w.kind==='research-attempt-binding')){
      const pending=second.list<any>('research-turn')[0]!,attempt=second.list('research-attempt')[0]!;
      completeResearchAttemptTurn(second,'p',reference(pending),reference(attempt));
      const run=second.get<any>(pending.value.run)!;
      second.write({id:run.id,kind:run.kind,expected:run.revision,value:{...run.value,status:'completed'}});
      winner=f.history();
    }return write(writes,guards);
  }) as typeof f.store.writeMany;
  const done=await f.run();assert.equal(done.value.status,'completed');assert.deepEqual(f.history(),winner);
  f.store.writeMany=write;assert.equal(f.store.list('research-attempt-binding').length,1);
  const before=f.history();await f.run(1,f.open(),false);assert.deepEqual(f.history(),before);assert.equal(f.wires().length,1);
});

for(const corrupt of ['subject','foreign-question','early-answer'] as const)test(`R: ${corrupt} is an addressed refusal without a second purchase`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  if(corrupt==='subject'){
    const write=f.store.writeMany.bind(f.store);let cut=false;
    f.store.writeMany=((writes,guards=[])=>{if(!cut&&writes.some(w=>w.kind==='research-attempt')){cut=true;throw new Error('cut');}return write(writes,guards);}) as typeof f.store.writeMany;
    await f.run();f.store.writeMany=write;
    const turn=f.store.list<any>('research-turn')[0]!,{subject:_subject,...value}=turn.value;
    f.store.write({id:turn.id,kind:turn.kind,expected:turn.revision,value});
  }else f.configure([corrupt==='foreign-question'?{...ended(),question:'someone-else'}:
    {action:'answer',question:'$selected',value:{edition:1},citations:[]}]);
  const stopped=await f.run();assert.equal(stopped.value.status,'paused');
  assert.equal(stopped.value.pauseCode,corrupt==='subject'?'research_consumer_intent_invalid':'research_response_invalid',JSON.stringify(stopped.value));
  assert.equal(f.store.list('research-attempt').length,0);assert.equal(f.wires().length,1);
  const ledger=f.store.list('research-budget-ledger');await f.run(1,f.open(),false);
  assert.equal(f.wires().length,1);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

test('R: source search and context reads precede a submitted end without accepting the claim',async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const source=f.discovery.evidence.document('p','research-basis','A precise current observation','text/plain',0);
  const end={type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'fact',kind:'fact',text:'Observed',axis:'industry',
    planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'block'}],scope:{variants:'common'},
    basis:{source:{ref:reference(source),range:{start:0,end:1},valueHash:hashJson('A')},limit:'snapshot',asOf:'2026-10'}}]}};
  f.configure([{action:'search',query:'precise'},{action:'read_context',record:reference(f.v.draft),pointer:'/fields/plan'},
    {...ended(),value:end}]);
  const run=await f.run();assert.equal(run.value.status,'completed',JSON.stringify(run.value));
  assert.equal(f.wires().length,3);assert.equal(f.store.list<any>('research-turn').filter(t=>t.value.status==='completed').length,3);
  const attempt=f.store.list('research-attempt')[0]!;
  assert.throws(()=>proveClaimAddress(f.store,{project:'p',container:reference(attempt),containerKind:'research-attempt',pointer:'/claims/0',claimId:'fact'}),{code:'claim_attempt_not_accepted'});
  const saved=f.history();await f.run(1,f.open(),false);assert.deepEqual(f.history(),saved);
});

test('R: corrupt attempt heads are refused rather than treated as unanswered questions',async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);await f.run();
  const record=f.store.list<any>('research-attempt')[0]!;
  f.store.write({id:record.id,kind:record.kind,expected:record.revision,value:{...record.value,project:'foreign'}});
  assert.throws(()=>planAttemptSelection(f.store,'p'),{code:'attempt_invalid'});assert.equal(f.wires().length,1);
});

test('R: a conflicting end at the paid call key preserves the pending turn and never purchases a replacement',async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]),write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{if(!cut&&writes.some(w=>w.kind==='research-attempt')){cut=true;throw new Error('cut');}return write(writes,guards);}) as typeof f.store.writeMany;
  await f.run();f.store.writeMany=write;
  const pending=f.store.list<any>('research-turn')[0]!,intent=f.store.get<any>(pending.value.consumerIntent.id)!;
  recordV7Attempt(f.store,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'block',call:intent.value.call,
    end:{type:'refused',code:'source_unavailable',evidence:[],text:'A different end at this exact key'}});
  const paused=await f.run(1,f.open(),false);
  assert.equal(paused.value.pauseCode,'attempt_conflict',JSON.stringify(paused.value));
  assert.ok(paused.value.error!.includes(f.v.planAnswer.id));assert.ok(paused.value.error!.includes('block'));
  assert.deepEqual(f.store.get(pending.id),pending);assert.equal(f.store.list('research-attempt-binding').length,0);
  const ledger=f.store.list('research-budget-ledger');await f.run(1,f.open(),false);
  assert.equal(f.wires().length,1);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

// DR3a3-R-01: retain the reviewer's unpaid-restore regression and paid-replay control.
test('R: an unpaid prepared intent consumes current allowance exactly once', async t => {
  const f = await setup(t), write = f.store.writeMany.bind(f.store);
  let interrupted = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!interrupted && writes.some(w => w.kind === 'model-call' && w.expected === 0)) {
      interrupted = true;
      throw new Error('crash before reservation');
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  const before = await f.run(1);
  assert.equal(interrupted, true);
  assert.equal(f.wires().length, 0);
  assert.equal(f.store.list<any>('research-consumer-intent')
    .filter(row => row.value.cursor?.run === before.id && row.value.state === 'prepared').length, 1);
  f.store.writeMany = write;
  const after = await f.run(1, f.open());
  assert.equal(f.wires().length, 1, 'run(1) may purchase only one new analyst turn');
  assert.deepEqual(f.wires().map(row => row.subject.question.id), ['block']);
  assert.equal(after.value.status, 'paused');
  assert.equal(after.value.pauseCode, 'research_turns_exhausted');
  assert.equal(f.store.list('research-attempt').length, 1);
});

test('R: paid replay stays free before one new turn in current allowance', async t => {
  const f = await setup(t), write = f.store.writeMany.bind(f.store);
  let interrupted = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!interrupted && writes.some(w => w.kind === 'research-turn' && w.expected === 0)) {
      interrupted = true;
      throw new Error('crash after paid response');
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  await f.run(1);
  assert.equal(interrupted, true);
  assert.equal(f.wires().length, 1);
  f.store.writeMany = write;
  const assignedCalls = () => f.store.list<{ assignments: { call: string }[] }>('research-budget-ledger')
    .flatMap(row => row.value.assignments.map(assignment => assignment.call));
  const paidCalls = assignedCalls();
  const after = await f.run(1, f.open());
  assert.equal(f.wires().length, 2);
  assert.deepEqual(f.wires().map(row => row.subject.question.id), ['block', 'support']);
  assert.equal(after.value.status, 'completed');
  assert.equal(assignedCalls().length, paidCalls.length + 1);
  for (const call of paidCalls) assert.equal(assignedCalls().filter(id => id === call).length, 1);
});
