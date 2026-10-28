import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import {join} from 'node:path';
import {Discovery,type DiscoveryDraft,type Question} from '../src/discovery/discovery.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import {Store,type Revision} from '../src/storage/store.js';
import {prepareResearchConsumerIntent,readResearchConsumerIntent,readResearchConsumerTurn,type ResearchConsumerIntent,type ResearchConsumerIntentInput} from '../src/discovery/response-recovery.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference,type Ref} from '../src/pipeline/contracts.js';
import {answerDiscoveryFixture} from './product-fixture.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {Researcher} from '../src/discovery/research-runner.js';
import {planAttemptSelection} from '../src/discovery/v7-plan-questions.js';
import {variantSnapshotReadiness} from '../src/discovery/variant-snapshot.js';
import {readV7ProgressStateAt} from '../src/discovery/v7-progress.js';
import {stageBudgetSegmentId} from '../src/discovery/stage-token-budget.js';
import {budgetUsage,type BudgetSegment} from '../src/runtime/research-budget.js';
import {synthesisSession} from '../src/discovery/synthesis-session.js';
import {readerPilot,pilotEnvironment} from '../src/discovery/reader-pilot.js';
import {configureV7SavedSynthesis} from '../src/discovery/saved-synthesis.js';
import {readArchiveBody} from '../src/discovery/request-parts.js';
import {v7ProgressStateId} from '../src/discovery/v7-attempt-assessment.js';
import { discoveryFixture, rand, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";
const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-r2-");
type Fixture = ReturnType<typeof fixture>;


/** The real plan acceptance chain (frame and plan through #answer). */
function acceptPlan(f: Fixture, project: string, questions: PlanQuestion[]) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(questions), src);
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


async function setup(t: test.TestContext, questions = [planQuestion('support','market'), planQuestion('block','industry','blocking')], calibrated = true) {
  const f=fixture(t);f.engine.execute({type:'create-project',project:'p',title:'P'});
  const wire=join(f.root,'wire.ndjson'), settings=join(f.root,'reply.json'), adapter=join(f.root,'adapter.mjs');
  const configure=(replies: unknown[]=[], tokens: number | null=10, outcomes: Record<string, string>={})=>writeFileSync(settings,JSON.stringify({replies,tokens,outcomes}));
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
let previous=[];try{previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const ordinal=previous.map(line=>JSON.parse(line)).filter(row=>!row.subject.assessmentSubject).length;
let research=s.replies[ordinal]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=r.subject.question.id;
if(s.outcomes?.[r.subject.question?.id]==='closed')research.value={type:'submitted',contract:'discovery-claims/v7',value:{claims:[{id:'choice',kind:'hypothesis',text:'Deployment settings may support an internal product',axis:'industry',planQuestions:[{planAnswer:s.planAnswer,planQuestionId:r.subject.question.id}],scope:{variants:'common'},basis:{howToVerify:'Inspect deployment settings'}}]}};
else if(s.outcomes?.[r.subject.question?.id])research.value.evidence=[s.constraint];
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 const rejected=(r.subject.value?.attempts??[]).flatMap(entry=>entry.end.type==='submitted'?entry.end.value.claims.map((claim,index)=>({claim:{project:packet.project,container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id},reason:'Insufficient corroboration'})):[]);
 research=s.assessmentReply??{verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected,newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
 const outcome=s.outcomes?.[packet.planQuestionId];
 if(outcome==='closed'){research.novelty.accepted=rejected.map(row=>({claim:row.claim,reason:'Accepted testable hypothesis'}));research.novelty.rejected=[];research.novelty.newContent=research.novelty.accepted;}
 if(outcome){research.verdict='supported';research.return=null;research.novelty.noProgress=[];research.novelty.transition={outcome,bases:outcome==='closed'?[{claim:research.novelty.accepted[0].claim}]:[{constraint:packet.entries[0].attempt}],reason:'Documented availability',...(outcome==='closed'?{sufficiency:{criterion:s.criteria[packet.planQuestionId],requiredDepth:'deep',reason:'Documented availability suffices',methodologyRequirements:[]}}:{consequence:'Unavailable evidence retained',nextAction:'Obtain another basis'})};}
} 
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,...(s.tokens===null?{}:{usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}})}));`);
  const command={executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure('p',{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},
    fullCheck:command,timeoutMs:5000},0);
  const calibration=f.discovery.create('p','discovery','R0','concept',[
    {field:'probe',kind:'fact',prompt:'Calibrate',risk:'unknown',schema:{type:'object'}}],[],6);
  const calibrate = async (tokens = 10) => {
    configure([], tokens);
    await researchCall(environment.value.implementer,environment.value,'Calibrate',{},undefined,
      {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'analyst'});
    configure([ended(),{necessary:true,reason:'Calibration review'}], tokens);
    await researchCall(environment.value.reviewer,environment.value,'Calibrate reviewer',{},undefined,
      {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'escalation-assessor'});
    await researchCall(environment.value.reviewer,environment.value,'Calibrate assessor',{},undefined,
      {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'assessor'});
    await researchCall(environment.value.implementer,environment.value,'Calibrate planner',{dispatchMode:'planning'},undefined,
      {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'reading-planner'});
    configure();writeFileSync(wire,'');
  };
  if (calibrated) await calibrate();
  configure();writeFileSync(wire,'');
  const v=acceptPlan(f,'p',questions);
  const constraint=reference(f.discovery.evidence.document('p','source-availability','The requested source is unavailable in this deployment','text/plain',0));
  const outcomes=(values: Record<string,string>)=>{configure([],10,values);const saved=JSON.parse(readFileSync(settings,'utf8'));writeFileSync(settings,JSON.stringify({...saved,constraint,planAnswer:v.planAnswer,criteria:Object.fromEntries(questions.map(q=>[q.id,q.criterion]))}));};
  const run=(limit=8,store=f.store, policy=true)=>new Researcher(store,new Discovery(store),new ProductEngine(store).environments)
    .run('p',v.draft.id,limit,undefined,policy?{producerPolicy:{discovery:7}}:{});
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const history=()=>f.store.list().map(row=>[row.id,row.revision,row.hash]);
  return {...f,v,questions,run,wires,history,configure,environment,calibrate,command,settings,outcomes};
}

const ended=(type='impossible')=>({action:'answer',question:'$selected',value:{type,code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]});



type Setup = Awaited<ReturnType<typeof setup>>;
const analystSubjects = (f: Setup) => f.wires().filter(w => !w.subject.assessmentSubject).map(w => w.subject.question.id);
const assessments = (f: Setup) => f.wires().filter(w => w.subject.assessmentSubject);
function progress(f: Setup, question: string, planAnswer = f.v.planAnswer) {
  const head = f.store.get(v7ProgressStateId({project:'p',planAnswer,planQuestionId:question}));
  assert.ok(head);return readV7ProgressStateAt(f.open(),reference(head));
}
const fullHistory = (f: Setup) => f.store.list().map(row => f.store.history(row.id));
function interrupt(f: Setup, kind: string) {
  const write = f.store.writeMany.bind(f.store);let hit=false;
  f.store.writeMany = ((writes,guards=[]) => {
    if (!hit && writes.some(w=>w.kind===kind)) {
      hit=true;
      throw new Error('R2 interrupted '+kind);
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  return () => {f.store.writeMany=write;assert.ok(hit,kind+' producer reached');};
}

test('R.2: three assessed attempts stall one question, then another question continues, without accepting Discovery', async t => {
  const f=await setup(t),write=f.store.writeMany.bind(f.store);let guarded=0;
  f.store.writeMany=((writes,guards=[])=>{
    const call=writes.find(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose==='analyst');
    if(call){
      const value=call.value as any;
      const id=v7ProgressStateId({project:'p',planAnswer:value.planAnswer,planQuestionId:value.questionId});
      const head=f.store.get(id),guard=guards.find(g=>g.id===id);
      assert.deepEqual(guard,head?reference(head):{id,absent:true},'new payment guards its exact applied frontier');
      guarded++;
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  const run=await f.run(8);assert.equal(guarded,4);
  assert.equal(run.value.status,'paused',JSON.stringify(run.value));assert.equal(run.value.pauseCode,'project_mode_unset');assert.equal(run.value.turns,4);
  assert.deepEqual(analystSubjects(f),['block','block','block','support']);
  assert.deepEqual(assessments(f).map(w=>w.subject.assessmentSubject.packet.planQuestionId),analystSubjects(f));
  for(const question of ['block','support']) {
    const state=progress(f,question),count=question==='block'?3:1;assert.equal(state.value.summary.count,count);
    assert.equal(state.value.summary.streak,count);assert.equal(state.value.summary.outcome,question==='block'?'stalled':'open');
    assert.deepEqual(state.value.subject,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:question});
  }
  assert.equal(f.store.list('research-attempt').length,4);assert.equal(f.store.list('v7-attempt-account').length,4);
  assert.equal(f.store.list('v7-progress-application').length,4);assert.equal(assessments(f).length,4);
  assert.equal(f.store.list('discovery-variant-set').length,0);assert.equal(f.store.list('discovery-variant-none').length,0);
  assert.deepEqual(f.store.get<DiscoveryDraft>(f.v.draft.id),f.v.draft);
  assert.equal(planAttemptSelection(f.open(),'p').next!.planQuestionId,'support');
  assert.equal(variantSnapshotReadiness(f.open(),'p').status,'ready');
  const before=fullHistory(f),sent=f.wires().length;
  assert.deepEqual(await f.run(1,f.open(),false),run);
  assert.deepEqual(await f.run(8,f.open()),run);
  assert.deepEqual(fullHistory(f),before);assert.equal(f.wires().length,sent);
});

test('R.2: all blocking questions precede supporting questions, preserving each accepted order', async t => {
  const f=await setup(t,[planQuestion('s-first','market'),planQuestion('b-first','industry','blocking'),
    planQuestion('b-second','people','blocking'),planQuestion('s-last','risks')]);
  f.outcomes({'b-first':'unknown','b-second':'unknown','s-first':'unknown','s-last':'unknown'});
  const run=await f.run();assert.equal(run.value.status,'paused',JSON.stringify(run.value));assert.equal(run.value.pauseCode,'project_mode_unset');
  assert.deepEqual(analystSubjects(f),['b-first','b-second','s-first','s-last']);
  assert.equal(run.value.turns,4);
  for(const id of analystSubjects(f))assert.equal(progress(f,id).value.summary.outcome,'unknown');
});

test('R.2: paid closed and unknown outcomes are not dispatched again on a cold entry', async t => {
  const closed={...planQuestion('block','industry','blocking'),criterion:'Name a testable hypothesis'};
  const f=await setup(t,[planQuestion('support','market'),closed]);f.outcomes({block:'closed',support:'unknown'});
  const run=await f.run();assert.equal(run.value.status,'paused',JSON.stringify(run.value));assert.equal(run.value.pauseCode,'project_mode_unset');
  assert.equal(progress(f,'block').value.summary.outcome,'closed');
  assert.equal(progress(f,'support').value.summary.outcome,'unknown');
  assert.deepEqual(analystSubjects(f),['block','support']);
  const before=fullHistory(f),ledger=f.store.list('research-budget-ledger');
  await f.run(20,f.open());assert.deepEqual(fullHistory(f),before);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,4);
});

test('R.2: cold admission preserves P count, run cursor, exact payments and the shared budget', async t => {
  const f=await setup(t),first=await f.run(1);
  assert.equal(first.value.pauseCode,'research_turns_exhausted');assert.equal(first.value.turns,1);
  assert.equal(progress(f,'block').value.summary.count,1);assert.equal(progress(f,'block').value.summary.outcome,'open');
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  const spent=budgetUsage(f.store,f.store.get<BudgetSegment>(stageBudgetSegmentId('p'))!);
  const second=await f.run(1,f.open());assert.equal(second.value.turns,2);
  assert.equal(second.value.pauseCode,'research_turns_exhausted');assert.equal(progress(f,'block').value.summary.count,2);
  const third=await f.run(1,f.open());assert.equal(third.value.turns,3);
  assert.equal(progress(f,'block').value.summary.outcome,'stalled');assert.equal(progress(f,'block').value.summary.streak,3);
  const fourth=await f.run(1,f.open());assert.equal(fourth.value.turns,4);
  assert.deepEqual(analystSubjects(f),['block','block','block','support']);
  for(const row of [...calls,...ledger])assert.deepEqual(f.store.get(row.id,row.revision),row);
  assert.ok(budgetUsage(f.store,f.store.get<BudgetSegment>(stageBudgetSegmentId('p'))!).measured>spent.measured);
  assert.ok(fourth.value.requestChars>first.value.requestChars);
  assert.equal(f.store.list('research-budget').filter(row=>row.id===stageBudgetSegmentId('p')).length,1);
  assert.equal(f.store.list('research-run').length,1);
});

test('R.2: a replacement edition with the same name has its own progress without resetting the run or payments', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const first=await f.run();assert.equal(first.value.turns,1);const old=progress(f,'block');
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  const next=acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,[planQuestion('block','industry','blocking')]);
  const selection=planAttemptSelection(f.open(),'p');assert.equal(selection.next!.planQuestionId,'block');
  assert.deepEqual(selection.planAnswer,next.planAnswer);assert.equal(selection.attempts.length,0);
  const run=await f.run(1,f.open());assert.equal(run.value.turns,2);assert.equal(run.value.pauseCode,'research_turns_exhausted');
  assert.equal(progress(f,'block',next.planAnswer).value.summary.count,1);
  assert.deepEqual(progress(f,'block'),old);
  for(const row of [...calls,...ledger])assert.deepEqual(f.store.get(row.id,row.revision),row);
  const packets=assessments(f).map(w=>w.subject.assessmentSubject.packet);
  assert.deepEqual(packets.map(p=>p.planAnswer),[f.v.planAnswer,next.planAnswer]);
});

test('R.2: a pending unpaid assessment blocks the frontier and new dispatch on cold restore', async t => {
  const f=await setup(t),restore=interrupt(f,'assessment-session');
  const stopped=await f.run();restore();assert.equal(stopped.value.status,'paused');
  const calls=f.wires().length,ledger=f.store.list('research-budget-ledger'),before=fullHistory(f);
  assert.throws(()=>planAttemptSelection(f.open(),'p'),{code:'research_assessment_pending'});
  assert.deepEqual(fullHistory(f),before);assert.deepEqual(analystSubjects(f),['block']);
  const cold=await f.run(1,f.open(),false);assert.equal(cold.value.pauseCode,'research_assessment_pending');
  assert.equal(f.wires().length,calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  const retry=fullHistory(f);await f.run(1,f.open(),false);assert.deepEqual(fullHistory(f),retry);
});

test('R.2: a saved paid assessment blocked before application cannot be bypassed by another question', async t => {
  const f=await setup(t),restore=interrupt(f,'v7-progress-application');
  const stopped=await f.run();restore();assert.equal(stopped.value.status,'paused');
  assert.equal(f.store.list('discovery-assessment').length,1);
  const calls=f.wires().length,ledger=f.store.list('research-budget-ledger');
  assert.throws(()=>planAttemptSelection(f.open(),'p'),{code:'research_assessment_pending'});
  const cold=await f.run(1,f.open(),false);assert.equal(cold.value.pauseCode,'research_contract_upgrade_required');
  assert.equal(progress(f,'block').value.summary.count,1);assert.equal(progress(f,'block').value.summary.outcome,'open');
  assert.deepEqual(analystSubjects(f),['block']);assert.equal(f.wires().length,calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

test('R.2: a caller-written progress outcome is not proof and cannot authorize dispatch', async t => {
  const f=await setup(t);await f.run(1);const state=progress(f,'block');
  f.store.write({id:state.id,kind:state.kind,expected:state.revision,value:{...state.value,summary:{...state.value.summary,outcome:'closed'}}});
  const before=fullHistory(f),sent=f.wires().length;
  assert.throws(()=>planAttemptSelection(f.open(),'p'),{code:'discovery_progress_conflict'});
  assert.deepEqual(fullHistory(f),before);
  const run=await f.run(1,f.open());assert.equal(run.value.pauseCode,'discovery_progress_conflict');assert.equal(f.wires().length,sent);
});

test('R.2: an older proven open state cannot hide a newly finished, unapplied attempt',async t=>{
  const f=await setup(t);await f.run(1);const initial=progress(f,'block');
  const restore=interrupt(f,'assessment-session');await f.run(1);restore();
  assert.equal(f.store.list('research-attempt').length,2);assert.deepEqual(progress(f,'block'),initial);
  const before=fullHistory(f),sent=f.wires().length;
  assert.throws(()=>planAttemptSelection(f.open(),'p'),{code:'research_assessment_pending'});
  assert.deepEqual(fullHistory(f),before);await f.run(1,f.open(),false);assert.equal(f.wires().length,sent);
});

test('R.2: a prepared unpaid dispatch of a replaced edition cannot bypass the current frontier',async t=>{
  const f=await setup(t),restore=interrupt(f,'model-call');
  const first=await f.run(1);restore();assert.equal(first.value.status,'paused');
  assert.equal(f.wires().length,0);assert.equal(f.store.list('research-attempt').length,0);
  acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,[planQuestion('block','industry','blocking'),planQuestion('support','market')]);
  const ledger=f.store.list('research-budget-ledger');
  const cold=await f.run(1,f.open());assert.equal(cold.value.pauseCode,'research_consumer_context_stale');
  assert.equal(f.wires().length,0);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  const before=fullHistory(f);await f.run(1,f.open());assert.deepEqual(fullHistory(f),before);
});

for(const cutSession of [false,true])test(`R.2: an open synthesis gets a new exact completed basis${cutSession?' across session-only interruption':''}`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking'),planQuestion('uncovered','risks')]);
 f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,stopAfter:'L2',
  reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:f.command},agentCommand:f.command,
  maxRequestChars:100000,maxReadChars:20000,maxReplyChars:200000,maxCalls:50,maxReportedTokens:100000,
  v7Planning:{contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:3}}});
 f.configure([{action:'synthesize',question:'$selected'},ended()]);
 await f.run(1);await f.run(1,f.open());
 assert.equal(progress(f,'block').value.summary.count,1);assert.equal(progress(f,'block').value.summary.outcome,'open');
 const paid=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
 const previous=f.store.list<any>('research-turn').find(row=>row.value.action?.action==='answer')!;
 const restore=cutSession?cutPublishedSession(f):null;
 const stopped=await f.run(1);restore?.();
 if(cutSession){assert.equal(stopped.value.pauseCode,'research_interrupted');assert.equal(f.store.list('synthesis-session').length,2);await f.run(1,f.open());}
 assert.equal(progress(f,'block').value.summary.count,2);
 const sessions=f.store.list<any>('synthesis-session');assert.equal(sessions.length,2);
 const next=sessions.find(row=>row.value.basis.previousProposalRef?.id===previous.id)!;assert.ok(next);
 assert.deepEqual(next.value.basis.previousProposalRef,reference(previous));
 const final=await f.run(1,f.open());assert.equal(final.value.status,'paused',JSON.stringify(final.value));assert.equal(final.value.pauseCode,'research_turns_exhausted');
 const readiness=variantSnapshotReadiness(f.open(),'p');assert.equal(readiness.status,'not_ready');
 assert.ok(readiness.reasons.some(reason=>reason.code==='question_uncovered'&&reason.message.includes('uncovered')));
 assert.equal(progress(f,'block').value.summary.count,3);assert.equal(progress(f,'block').value.summary.outcome,'stalled');
 assert.equal(f.wires().filter(row=>row.subject.dispatchMode==='planning').length,1);
 for(const row of [...paid,...ledger])assert.deepEqual(f.store.get(row.id,row.revision),row);
 const before=fullHistory(f),sent=f.wires().length;await f.run(1,f.open(),false);
 assert.deepEqual(fullHistory(f),before);assert.equal(f.wires().length,sent);
});

function cutPublishedSession(f: Setup) {
 const write=f.store.writeMany.bind(f.store);let hit=false;
 f.store.writeMany=((writes,guards=[])=>{const rows=write(writes,guards);
  if(!hit&&writes.some(row=>row.kind==='synthesis-session'&&row.expected===0)){
   hit=true;throw new Error('R2 interrupted after session reservation');
  }return rows;
 }) as Store['writeMany'];
 return ()=>{f.store.writeMany=write;assert.ok(hit);};
}
test('R.2: the next saved-only basis preserves its exact negative owner review across a session-only cut',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking'),planQuestion('uncovered','risks')]);
 f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,stopAfter:'L2',
  reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:f.command},agentCommand:f.command,
  maxRequestChars:100000,maxReadChars:20000,maxReplyChars:200000,maxCalls:50,maxReportedTokens:100000,
  v7Planning:{contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:3}}});
 const source=f.discovery.evidence.document('p','review-material','A finding and its applicable exception.','text/plain',0);
 const piece={kind:'context',value:f.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:source.value.content.length})};
 const subject={contract:'v7-plan-subject/v1',planAnswer:f.v.planAnswer,planQuestionId:'block'},pilot=readerPilot(f.store,'p')!;
 f.configure([{action:'checkpoint',question:'$selected',value:{finding:'The finding retains its exception'},
  citations:[{source:piece.value.source,selector:piece.value.selector}],unresolved:[]},ended()]);
 await synthesisSession(f.store,f.v.draft,f.v.plan,f.environment,pilotEnvironment(f.environment.value,pilot.value),pilot,
  {role:'research',stage:'discovery',subject,workingSelections:[piece],inventory:{sources:[]},history:[]},'Synthesize',undefined,{});
 const prior=analystSubjects(f).length;
 f.configure([...Array.from({length:prior},()=>ended()),
  {action:'read_plan',question:'$selected',reads:[{action:'read_source',source:reference(source),start:0,end:source.value.content.length}]},
  {action:'need_owner',question:'$selected',reason:'Ask the owner to resolve this source',searched:[reference(source)]},
  {necessary:false,reason:'The cited source already answers this question'},ended()]);
 const stopped=await f.run(2);assert.equal(stopped.value.pauseCode,'research_turns_exhausted',JSON.stringify(stopped.value));
 const reviewed=f.store.list<any>('research-turn').find(row=>row.value.action?.action==='need_owner')!;
 assert.equal(reviewed.value.observation.necessary,false);
 configureV7SavedSynthesis(f.store,'p',subject,0);
 await f.run(1,f.open());assert.equal(progress(f,'block').value.summary.count,1);
 const previous=f.store.list<any>('research-turn').find(row=>row.value.action?.action==='answer')!;
 const calls=f.wires().length,reviews=f.store.list<any>('model-call').filter(row=>row.value.purpose==='escalation-assessor');
 const restore=cutPublishedSession(f);const cut=await f.run(1);restore();
 assert.equal(cut.value.pauseCode,'research_interrupted');assert.equal(f.wires().length,calls);
 await f.run(1,f.open());assert.equal(progress(f,'block').value.summary.count,2);
 const sent=f.wires().slice(calls).find(row=>!row.subject.assessmentSubject).subject;
 assert.deepEqual(sent.previousProposalRef,reference(previous));
 const body=readArchiveBody(f.open(),f.store.get(sent.working.archive.id,sent.working.archive.revision)!).body;
 assert.deepEqual(body.history,[{...reviewed.value,ref:reference(reviewed)}]);assert.deepEqual(body.subject,subject);
 assert.deepEqual(f.store.list<any>('model-call').filter(row=>row.value.purpose==='escalation-assessor'),reviews);
 assert.equal((await f.run(1,f.open(),false)).value.pauseCode,'research_turns_exhausted');
 const before=fullHistory(f),sentCount=f.wires().length;await f.run(1,f.open(),false);
 assert.deepEqual(fullHistory(f),before);assert.equal(f.wires().length,sentCount);
});

/** The common producer with the exact pre-R.2 admission: the accepted base
 * did not include P guards. No saved intent or paid result is edited. */
function prepareBeforeFrontierGuards(f: Setup, kind: 'analyst' | 'reading-planner') {
  const write=f.store.writeMany.bind(f.store);let prepared: Revision<ResearchConsumerIntent> | undefined;
  f.store.writeMany=((writes,guards=[])=>{
    const admission=writes.find(w=>w.kind==='research-consumer-intent'&&w.expected===0
      &&(w.value as ResearchConsumerIntent).kind===kind);
    if(!prepared&&admission){
      const value=admission.value as ResearchConsumerIntent;
      const frontierIds=new Set(planAttemptSelection(f.store,'p').guards.map(guard=>guard.id));
      const input: ResearchConsumerIntentInput={projectId:value.projectId,kind:value.kind,key:value.key,
        owner:value.owner,draft:value.draft,question:value.question,role:value.role,dispatch:value.dispatch,
        profile:value.profile,cursor:value.cursor,basis:value.basis,
        guards:value.guards.filter(guard=>!frontierIds.has(guard.id))};
      // Re-enter only the real common producer, with the older admission input.
      f.store.writeMany=write;
      prepared=prepareResearchConsumerIntent(f.store,input);
      throw new Error('R2 cut after pre-frontier admission');
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  return ()=>{f.store.writeMany=write;assert.ok(prepared,'real old admission published');
    assert.deepEqual(readResearchConsumerIntent(f.open(),reference(prepared)),prepared);
    return prepared;};
}

for(const kind of ['analyst','reading-planner'] as const)
for(const existing of [false,true])
for(const race of [false,true])
test(`R.2-01: old prepared ${kind} retains ${existing?'exact':'absent'} frontier at reservation${race?' against a second Store':''}`,async t=>{
  const plannerPrior=kind==='reading-planner'&&existing;
  const f=await setup(t,[...(plannerPrior?[planQuestion('prior','market','blocking')]:[]),planQuestion('block','industry','blocking'),planQuestion('uncovered','risks')]);
  const readiness=variantSnapshotReadiness(f.open(),'p');assert.equal(readiness.status,'not_ready');
  assert.ok(readiness.reasons.some(reason=>reason.code==='question_uncovered'&&reason.message.includes('uncovered')));
  if(plannerPrior)f.outcomes({prior:'unknown'});
  if(existing){await f.run(1);assert.equal(progress(f,plannerPrior?'prior':'block').value.summary.outcome,plannerPrior?'unknown':'open');}
  if(kind==='reading-planner'){
    f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,stopAfter:'L2',
      reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:f.command},agentCommand:f.command,
      maxRequestChars:100000,maxReadChars:20000,maxReplyChars:200000,maxCalls:50,maxReportedTokens:100000,
      v7Planning:{contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:3}}});
    f.configure([...(existing?[ended()]:[]),{action:'pause',reason:'Prepared planner stops here'}]);
  }
  const oldProducer=prepareBeforeFrontierGuards(f,kind);
  const cut=await f.run(1);const original=oldProducer();
  assert.equal(cut.value.pauseCode,'research_interrupted');
  const stateId=v7ProgressStateId({project:'p',planAnswer:f.v.planAnswer,planQuestionId:plannerPrior?'prior':'block'});
  assert.ok(!original.value.guards.some(guard=>guard.id===stateId));
  const prior=f.store.get(stateId),expected=prior?reference(prior):{id:stateId,absent:true};
  assert.equal(!!prior,existing);
  const beforeCalls=f.store.list('model-call'),beforeLedger=f.store.list('research-budget-ledger'),beforeBudget=f.store.list('research-budget');
  const sent=f.wires().length,other=f.open(),resume=f.open(),write=resume.writeMany.bind(resume);let reserved=0;
  resume.writeMany=((writes,guards=[])=>{
    if(writes.some(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose===kind)){
      reserved++;assert.deepEqual(guards.find(guard=>guard.id===stateId),expected);
      const refreshed=readResearchConsumerIntent(other,reference(other.get<ResearchConsumerIntent>(original.id)!));
      assert.deepEqual(refreshed,original,'transient guards do not rewrite the original admission');
      if(race){
        // A competing head is a CAS adversary, not a fixture claiming a proven
        // P transition. Even an invalid appearance must prevent this payment.
        other.write({id:stateId,kind:'v7-progress-state',expected:prior?.revision??0,
          value:prior?.value??{competing:true}});
        try{return write(writes,guards);}catch(error){
          assert.equal((error as {code:string}).code,'input_stale');
          assert.deepEqual(other.list('model-call'),beforeCalls);
          assert.deepEqual(other.list('research-budget-ledger'),beforeLedger);
          assert.deepEqual(other.list('research-budget'),beforeBudget);
          throw error;
        }
      }
    }
    return write(writes,guards);
  }) as typeof resume.writeMany;
  const result=await f.run(1,resume);assert.equal(reserved,1);
  assert.deepEqual(f.store.get(original.id,original.revision),original,'saved original remains exact');
  if(race){
    assert.equal(result.value.pauseCode,'input_stale',JSON.stringify(result.value));
    assert.deepEqual(f.store.list('research-budget'),beforeBudget);
    assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('model-call'),beforeCalls);
    assert.deepEqual(f.store.list('research-budget-ledger'),beforeLedger);
    assert.equal(f.store.get<ResearchConsumerIntent>(original.id)!.value.state,'prepared');
    const retried=await f.run(1,f.open());assert.equal(retried.value.status,'paused');
    assert.notEqual(retried.value.pauseCode,'research_busy');assert.equal(f.wires().length,sent);
    assert.deepEqual(f.store.list('model-call'),beforeCalls);assert.deepEqual(f.store.list('research-budget-ledger'),beforeLedger);
  }else{
    assert.equal(result.value.turns,cut.value.turns+1,JSON.stringify(result.value));
    assert.equal(f.wires().length,sent+(kind==='analyst'?2:1),JSON.stringify(result.value));
    const completed=f.store.get<ResearchConsumerIntent>(original.id)!;assert.equal(completed.value.state,'applied');
    assert.equal(completed.revision,3);assert.equal(f.store.get<ResearchConsumerIntent>(original.id,2)!.value.state,'running');
    assert.deepEqual(completed.value.guards,original.value.guards,'paid basis retains its original guards');
    const turn=f.store.list<any>('research-turn').find(row=>row.value.consumerIntent?.id===original.id)!;
    assert.deepEqual(readResearchConsumerTurn(f.open(),reference(turn)),turn);
    assert.ok(!Object.hasOwn(f.wires()[sent].subject,'consumerDispatchGuards'));
    assert.ok(!Object.hasOwn(completed.value.dispatch,'consumerDispatchGuards'));
    const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
    await f.run(1,f.open(),false);
    assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  }
});

for(const kind of ['analyst','reading-planner'] as const)
test(`R.2-01: paid old ${kind} applies before a late corrupt P without another payment`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  if(kind==='reading-planner'){
    f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,stopAfter:'L2',
      reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:f.command},agentCommand:f.command,
      maxRequestChars:100000,maxReadChars:20000,maxReplyChars:200000,maxCalls:50,maxReportedTokens:100000,
      v7Planning:{contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:3}}});
    f.configure([{action:'pause',reason:'Saved planner pause'}]);
  }
  const oldProducer=prepareBeforeFrontierGuards(f,kind);await f.run(1);const original=oldProducer();
  const restore=interrupt(f,'research-turn');const paid=await f.run(1);restore();
  assert.equal(paid.value.pauseCode,'research_interrupted');
  assert.equal(f.store.get<ResearchConsumerIntent>(original.id)!.value.state,'running');
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger'),sent=f.wires().length;
  const other=f.open(),stateId=v7ProgressStateId({project:'p',planAnswer:f.v.planAnswer,planQuestionId:'block'});
  const changed=other.write({id:stateId,kind:'v7-progress-state',expected:0,value:{corrupt:true}});
  // Exercise the transport's own paid-return door as well as the runner.
  // This now-false absent guard must never be evaluated for a saved response.
  await researchCall(original.value.role,original.value.dispatch,original.value.cursor.instruction,
    original.value.cursor.context,undefined,{store:other,draftId:original.value.draft.id,
      questionId:original.value.question.id,purpose:kind,consumerIntent:reference(original),
      consumerDispatchGuards:[{id:stateId,absent:true}]});
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('model-call'),calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  const result=await f.run(1,other,false);
  assert.notEqual(result.value.pauseCode,'research_busy');
  const applied=f.store.get<ResearchConsumerIntent>(original.id)!;
  assert.equal(applied.value.state,'applied',JSON.stringify(result.value));assert.equal(applied.revision,3);
  assert.deepEqual(applied.value.guards,original.value.guards);
  const turn=f.store.list<any>('research-turn').find(row=>row.value.consumerIntent?.id===original.id)!;
  assert.deepEqual(readResearchConsumerTurn(f.open(),reference(turn)),turn);
  assert.deepEqual(f.store.get(stateId),changed,'late corrupt head is not accepted or repaired by paid replay');
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('model-call'),calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  const again=await f.run(1,f.open(),false);assert.notEqual(again.value.pauseCode,'research_busy');
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('model-call'),calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});
