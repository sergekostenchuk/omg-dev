import {synthesisSession} from '../src/discovery/synthesis-session.js';
import {pilotEnvironment,readerPilot} from '../src/discovery/reader-pilot.js';
import {prepareResearchConsumerIntent,prepareResearchConsumerApplication,readResearchConsumerExecution,completeResearchAttemptTurn} from '../src/discovery/response-recovery.js';
import {projectPaidTurnAdmission,managedTurnId} from '../src/discovery/research-consumer-transition.js';
import {recordV7Attempt} from '../src/discovery/v7-attempts.js';
import {attemptEndOfAction,V7_PLAN_SUBJECT_CONTRACT} from '../src/discovery/v7-managed-attempt.js';
import {projectAttemptPacket,attemptAccountKey} from '../src/discovery/v7-attempt-assessment.js';
import {REQUEST_MANIFEST_CONTRACT,readArchiveBody} from '../src/discovery/request-parts.js';
import {configureV7SavedSynthesis} from '../src/discovery/saved-synthesis.js';
import {uniqueTransactionGuards} from '../src/runtime/environment.js';
import type {ResearchRun} from '../src/discovery/research-model.js';
import {v7CheckpointPrefixes} from '../src/discovery/v7-plan-questions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import {join} from 'node:path';
import {Discovery,type DiscoveryDraft,type Question} from '../src/discovery/discovery.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import {Store,type Revision} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference,type Ref} from '../src/pipeline/contracts.js';
import { canonical, hashJson } from '../src/canonical.js';
import {answerDiscoveryFixture} from './product-fixture.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {Researcher} from '../src/discovery/research-runner.js';
import {applyDiscoveryAssessment,v7ProgressBaseline,readV7ProgressStateAt,PROGRESS_EVENT_KIND} from '../src/discovery/v7-progress.js';
import {assessAttemptsWithRequirements,readDiscoveryAssessment} from '../src/discovery/research-assessment.js';
import { discoveryFixture, rand, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";
const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-r1-");
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
  const configure=(replies: unknown[]=[], tokens: number | null=10)=>writeFileSync(settings,JSON.stringify({replies,tokens}));
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
let previous=[];try{previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const ordinal=previous.map(line=>JSON.parse(line)).filter(row=>!row.subject.assessmentSubject).length;
let research=s.replies[ordinal]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=r.subject.question.id;
if(s.terminalConstraint&&research.action==='answer')research.value.evidence=[s.terminalConstraint];
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 const rejected=(r.subject.value?.attempts??[]).flatMap(entry=>entry.end.type==='submitted'?entry.end.value.claims.map((claim,index)=>({claim:{project:packet.project,container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id},reason:'Insufficient corroboration'})):[]);
 research=s.assessmentReply??{verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected,newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
 if(s.terminalConstraint&&research.novelty){research.verdict='supported';research.return=null;research.novelty.noProgress=[];research.novelty.transition={outcome:'unknown',bases:[{constraint:packet.entries[0].attempt}],reason:'Source unavailable',consequence:'The named basis remains unknown',nextAction:'Obtain another source'};}
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
  let terminalConstraint: Ref | undefined;
  const finishFrontier=()=>{terminalConstraint??=reference(f.discovery.evidence.document('p','terminal-source','The requested source is unavailable','text/plain',0));writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings,'utf8')),terminalConstraint}));};
  const run=(limit=8,store=f.store, policy=true)=>new Researcher(store,new Discovery(store),new ProductEngine(store).environments)
    .run('p',v.draft.id,limit,undefined,policy?{producerPolicy:{discovery:7}}:{});
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const history=()=>f.store.list().map(row=>[row.id,row.revision,row.hash]);
  return {...f,v,questions,run,wires,history,configure,environment,calibrate,command,settings,finishFrontier};
}

const ended=(type='impossible')=>({action:'answer',question:'$selected',value:{type,code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]});


function assessmentWires(f: Awaited<ReturnType<typeof setup>>) { return f.wires().filter(w=>w.subject.assessmentSubject); }
function counters(f: Awaited<ReturnType<typeof setup>>) {
  return {calls:f.wires().length,ledger:f.store.list('research-budget-ledger'),
    accounts:f.store.list('v7-attempt-account'),events:f.store.list(PROGRESS_EVENT_KIND),
    states:f.store.list('v7-progress-state'),attempts:f.store.list('research-attempt')};
}
function cutAt(f: Awaited<ReturnType<typeof setup>>, boundary:'unpaid'|'paid'|'published'|'before-apply'|'after-apply') {
  const write=f.store.writeMany.bind(f.store);let hit=false;
  f.store.writeMany=((writes,guards=[])=>{
    const selected=writes.some(w=>boundary==='unpaid'?w.kind==='assessment-session':boundary==='paid'?w.kind==='model-call'&&(w.value as any).purpose==='assessor'&&(w.value as any).status==='succeeded':
      boundary==='published'?w.kind==='discovery-assessment':w.kind==='v7-progress-application');
    if(!hit&&selected){hit=true;if(boundary!=='before-apply'&&boundary!=='unpaid')write(writes,guards);throw new Error('R1 cut '+boundary);}
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  return ()=>{f.store.writeMany=write;assert.ok(hit,'the real producer reached '+boundary);};
}

test('R.1: each exact subject is assessed and applied before the next analyst call; assessment adds no attempt',async t=>{
  const f=await setup(t),write=f.store.writeMany.bind(f.store);let second=false;f.finishFrontier();
  f.store.writeMany=((writes,guards=[])=>{
    if(writes.some(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose==='analyst')&&f.store.list('research-attempt').length){
      second=true;assert.equal(f.store.list('v7-attempt-account').length,1);assert.equal(f.store.list('v7-progress-state').length,1);
    }return write(writes,guards);
  }) as typeof f.store.writeMany;
  const run=await f.run();assert.equal(run.value.status,'paused');assert.equal(run.value.pauseCode,'project_mode_unset',JSON.stringify(run.value));assert.ok(second);
  assert.equal(run.value.turns,2);assert.equal(f.store.list('research-attempt').length,2);
  assert.deepEqual(assessmentWires(f).map(w=>w.subject.assessmentSubject.packet.planQuestionId),['block','support']);
  assert.deepEqual(f.wires().map(w=>w.subject.assessmentSubject?'assessor':w.subject.question.id),['block','assessor','support','assessor']);
  assert.equal(f.store.list('v7-attempt-account').length,2);
  for(const state of f.store.list<any>('v7-progress-state')){
    const proof=readV7ProgressStateAt(f.open(),reference(state));assert.equal(proof.value.summary.count,1);
    const application=f.store.get<any>(state.value.application.id,state.value.application.revision)!;
    const paid=readDiscoveryAssessment(f.open(),'p',application.value.assessment);
    assert.deepEqual(paid.value.subject.packet.planAnswer,f.v.planAnswer);assert.equal(paid.value.subject.packet.entries.length,1);
  }
  const before=counters(f),history=f.history();await f.run(1,f.open(),false);
  assert.deepEqual(counters(f),before);assert.deepEqual(f.history(),history);
});

for(const boundary of ['paid','published','before-apply','after-apply'] as const)for(const completed of [false,true])
 test(`R.1: cold ${boundary} recovery with completed=${completed} applies the paid prefix once without dispatch`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]),restore=cutAt(f,boundary);
  const stopped=await f.run();restore();assert.equal(stopped.value.status,'paused');
  assert.equal(f.store.list('v7-attempt-account').length,boundary==='after-apply'?1:0);
  assert.equal(f.store.list('v7-progress-state').length,boundary==='after-apply'?1:0);
  if(completed){const run=f.store.get<any>(stopped.id)!;f.store.write({id:run.id,kind:run.kind,expected:run.revision,value:{...run.value,status:'completed'}});}
  const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  const done=await f.run(1,f.open(),false);assert.equal(done.value.pauseCode,'research_restore_complete',JSON.stringify(done.value));
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.store.list('v7-attempt-account').length,1);assert.equal(f.store.list('v7-progress-application').length,1);
  assert.equal(f.store.list<any>('v7-progress-state')[0]!.value.summary.count,1);assert.equal(done.value.turns,1);
  const before=counters(f),history=f.history();await f.run(1,f.open(),false);assert.deepEqual(counters(f),before);assert.deepEqual(f.history(),history);
 });

for(const boundary of ['paid','published','after-apply'] as const)test(`R.1: ${boundary} recovery retains the original plan after a lawful new edition`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]),restore=cutAt(f,boundary);
  await f.run();restore();const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,[planQuestion('new','industry')]);
  const result=await f.run(1,f.open(),false);assert.equal(result.value.status,'paused');assert.equal(result.value.pauseCode,'research_contract_upgrade_required',JSON.stringify(result.value));
  assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  const state=f.store.list<any>('v7-progress-state')[0]!;assert.deepEqual(state.value.subject.planAnswer,f.v.planAnswer);assert.equal(state.value.subject.planQuestionId,'block');
  assert.equal(state.value.summary.count,1);assert.equal(f.store.list('v7-attempt-account').length,1);
  const before=counters(f);await f.run(1,f.open(),false);assert.deepEqual(counters(f),before);
});

test('R.1: an earlier paid pending answer is not skipped or counted while its assessment is still unpaid',async t=>{
 const f=await setup(t),write=f.store.writeMany.bind(f.store);let cut=false;f.finishFrontier();
 f.store.writeMany=((writes,guards=[])=>{if(!cut&&writes.some(w=>w.kind==='research-attempt')){cut=true;throw new Error('before attempt');}return write(writes,guards);}) as typeof f.store.writeMany;
 await f.run();assert.ok(cut);f.store.writeMany=write;const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
 const paused=await f.run(1,f.open(),false);assert.equal(paused.value.status,'paused');assert.equal(paused.value.pauseCode,'research_assessment_pending',JSON.stringify(paused.value));
 assert.equal(paused.value.turns,1);assert.equal(f.store.list('v7-attempt-account').length,0);assert.equal(f.store.list('discovery-assessment').length,0);
 assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
 const done=await f.run(1,f.open());assert.equal(done.value.status,'paused');assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));assert.equal(done.value.turns,2);
 assert.deepEqual(assessmentWires(f).map(w=>w.subject.assessmentSubject.packet.planQuestionId),['block','support']);
});

async function appendAttempt(f:Awaited<ReturnType<typeof setup>>) {
 const previous=f.store.list<ResearchRun>('research-run')[0]!;
 const run=f.store.write<ResearchRun>({id:previous.id,kind:previous.kind,expected:previous.revision,value:{...previous.value,status:'running'}}),number=run.value.turns+1;
 const draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!,question=f.store.get<Question>(f.v.plan.id)!;
 const subject={contract:V7_PLAN_SUBJECT_CONTRACT,planAnswer:f.v.planAnswer,planQuestionId:'block'};
 const instruction='Return an ended attempt for the exact selected question.',context={history:[],readings:[]};
 const intent=prepareResearchConsumerIntent(f.store,{projectId:'p',kind:'analyst',key:hashJson([run.id,number,'analyst']),
  owner:reference(run),draft:reference(draft),question:reference(question),role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,
  cursor:{run:run.id,turn:number,instruction,context,subject},basis:draft.value.inputs,
  guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(f.environment)])});
 const response=await researchCall(f.environment.value.implementer,f.environment.value,instruction,context,undefined,
  {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
 const execution=readResearchConsumerExecution(f.store,'p',reference(intent));assert.equal(execution.kind,'response');
 const projected=projectPaidTurnAdmission(run.value,{runId:run.id,intent:reference(intent),response,question:reference(question),owner:run.value.owner,limit:8,context,subject});
 const turnId=managedTurnId(run.id,number);
 const app=prepareResearchConsumerApplication(f.store,reference(intent),reference(execution.call),[
  {id:run.id,kind:run.kind,expected:run.revision,value:projected.run},
  {id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
  [reference(run),reference(f.environment),{id:turnId,absent:true}]);
 f.store.writeMany(app.writes,app.guards);
 const call=f.store.get<any>(intent.id)!.value.call;
 const recorded=recordV7Attempt(f.store,{project:'p',planAnswer:subject.planAnswer,planQuestionId:'block',call,end:attemptEndOfAction(response,subject)});
 completeResearchAttemptTurn(f.store,'p',reference(f.store.get(turnId)!),reference(recorded.attempt));
 const stopped=f.store.get<ResearchRun>(run.id)!;f.store.write({id:stopped.id,kind:stopped.kind,expected:stopped.revision,value:{...stopped.value,status:'paused'}});
}
function packetOf(f:Awaited<ReturnType<typeof setup>>) {
 const turns=f.store.list<any>('research-turn').sort((a,b)=>a.value.number-b.value.number);
 const run=f.store.list<ResearchRun>('research-run')[0]!;
 const prefix=v7CheckpointPrefixes(f.store,'p',f.v.draft.id,run,turns)[0]!;
 return projectAttemptPacket(f.store,{project:'p',...prefix.subject,entries:prefix.entries});
}
async function competingFirst(f:Awaited<ReturnType<typeof setup>>,packet:ReturnType<typeof packetOf>) {
 const first={...packet,entries:packet.entries.slice(0,1)};
 const paid=await assessAttemptsWithRequirements(f.store,first,v7ProgressBaseline(f.store,first),f.environment,f.root);
 return applyDiscoveryAssessment(f.store,'p',reference(paid));
}
for(const covered of [false,true])test(`R.1: stale paid packet covered=${covered} preserves accounts atomically and never repurchases`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{if(!cut&&writes.some(w=>w.kind==='assessment-session')){cut=true;throw new Error('before assessment session');}return write(writes,guards);}) as typeof f.store.writeMany;
 await f.run();f.store.writeMany=write;assert.ok(cut);
 if(!covered)await appendAttempt(f);
 const restore=cutAt(f,'published');await f.run();restore();
 const packet=packetOf(f);await competingFirst(f,packet);
 const before=counters(f),apps=f.store.list('v7-progress-application');
 const result=await f.run(1,f.open(),false);
 if(covered){assert.equal(result.value.pauseCode,'research_restore_complete',JSON.stringify(result.value));}
 else {assert.equal(result.value.pauseCode,'discovery_progress_stale',JSON.stringify(result.value));assert.equal(result.value.status,'paused');}
 assert.deepEqual(counters(f),before);assert.deepEqual(f.store.list('v7-progress-application'),apps);
 const again=await f.run(1,f.open(),false);assert.equal(again.value.status,result.value.status);assert.equal(again.value.pauseCode,result.value.pauseCode);
 assert.deepEqual(counters(f),before);assert.deepEqual(f.store.list('v7-progress-application'),apps);
});

test('R.1: a real pending queued child blocks the checkpoint; completed reads add no N',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,stopAfter:'L2',
  reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:f.command},agentCommand:f.command,
  maxRequestChars:100000,maxReadChars:20000,maxReplyChars:10000,maxCalls:20,maxReportedTokens:100000,
  v7Planning:{contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:3}}});
 f.configure([{action:'read_plan',question:'$selected',reads:[{action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'}]}]);
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{const result=write(writes,guards);if(!cut&&writes.some(w=>w.kind==='research-turn'&&w.expected===0&&!w.id.startsWith('research-turn:v1:'))){cut=true;throw new Error('after real queue publication');}return result;}) as typeof f.store.writeMany;
 const blocked=await f.run(1);f.store.writeMany=write;assert.ok(cut);assert.equal(blocked.value.pauseCode,'research_interrupted',JSON.stringify(blocked.value));
 assert.equal(f.store.list('discovery-assessment').length,0);assert.equal(f.store.list('v7-attempt-account').length,0);
 const turns=f.store.list<any>('research-turn').sort((a,b)=>a.value.number-b.value.number);
 assert.equal(turns.length,2);assert.equal(turns[1]!.value.status,'pending');
 assert.deepEqual(v7CheckpointPrefixes(f.store,'p',f.v.draft.id,blocked,turns),[]);
 const before=counters(f);await f.run(1,f.open(),false);assert.deepEqual(counters(f),before);
 // End planning after its admitted queue; the next analyst is separately admitted.
 const pilot=f.store.get<any>('reader-pilot:p')!;
 f.store.write({id:pilot.id,kind:pilot.kind,expected:pilot.revision,value:{...pilot.value,active:false}});
 f.configure([{action:'read_plan',question:'$selected',reads:[]},ended()]);
 const done=await f.run(1,f.open());assert.equal(packetOf(f).entries.length,1);assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));
 assert.equal(f.store.list('research-attempt').length,1);assert.equal(f.store.list('v7-attempt-account').length,1);
 const state=f.store.list<any>('v7-progress-state')[0]!;assert.equal(state.value.summary.count,1);assert.equal(done.value.turns,3);
 assert.equal(assessmentWires(f).length,1);
});

test('R.1: an already paid assessor checkpoint replays free and waits without N before its next admitted request',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 writeFileSync(f.settings,JSON.stringify({replies:[],tokens:10,assessmentReply:{action:'assessment_checkpoint',notes:['Continue the exact packet']}}));f.finishFrontier();
 const restore=cutAt(f,'paid');await f.run();restore();
 const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
 const waiting=await f.run(1,f.open(),false);assert.equal(waiting.value.pauseCode,'research_assessment_pending',JSON.stringify(waiting.value));
 assert.equal(waiting.value.turns,1);assert.equal(f.store.list('v7-attempt-account').length,0);
 assert.equal(f.store.list('v7-progress-state').length,0);assert.equal(f.store.list('discovery-assessment').length,0);
 assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
 const before=f.history();await f.run(1,f.open(),false);assert.deepEqual(f.history(),before);
 f.configure();f.finishFrontier();const done=await f.run(1,f.open());assert.equal(done.value.status,'paused');assert.equal(done.value.pauseCode,'project_mode_unset',JSON.stringify(done.value));
 assert.equal(done.value.turns,1);assert.equal(f.store.list('v7-attempt-account').length,1);
 assert.equal(f.store.list<any>('v7-progress-state')[0]!.value.summary.count,1);assert.equal(f.wires().length,sent+1);
 const stable=counters(f);await f.run(1,f.open(),false);assert.deepEqual(counters(f),stable);
});

test('R.1: a restored unpaid next intent cannot dispatch ahead of the previous paid application',async t=>{
 const f=await setup(t),restore=cutAt(f,'published');f.finishFrontier();const stopped=await f.run();restore();
 const run=f.store.get<ResearchRun>(stopped.id)!,draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!,question=f.store.get<Question>(f.v.plan.id)!;
 const subject={contract:V7_PLAN_SUBJECT_CONTRACT,planAnswer:f.v.planAnswer,planQuestionId:'support'};
 const instruction='Research the next exact subject.',context={role:'research',history:[],readings:[],contextWorkspace:[]};
 const intent=prepareResearchConsumerIntent(f.store,{projectId:'p',kind:'analyst',key:hashJson([run.id,2,'analyst']),
  owner:reference(run),draft:reference(draft),question:reference(question),role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,
  cursor:{run:run.id,turn:2,mode:null,instruction,context,subject},basis:draft.value.inputs,
  guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(f.environment)])});
 const sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
 const waiting=await f.run(1,f.open(),false);assert.equal(waiting.value.pauseCode,'research_contract_upgrade_required',JSON.stringify(waiting.value));
 assert.equal(f.store.list('v7-attempt-account').length,1);assert.equal(f.store.list('v7-progress-application').length,1);
 assert.equal(f.store.get<any>(intent.id)!.value.state,'prepared');assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
 const done=await f.run(1,f.open());assert.equal(done.value.status,'paused');assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));
 assert.equal(f.store.list('v7-attempt-account').length,2);assert.equal(done.value.turns,2);
 assert.equal(f.store.get<any>(intent.id)!.value.state,'applied');
 assert.deepEqual(assessmentWires(f).map(w=>w.subject.assessmentSubject.packet.planQuestionId),['block','support']);
 const stable=counters(f);await f.run(1,f.open(),false);assert.deepEqual(counters(f),stable);
});

test('R.1: a forged account cannot suppress assessment or authorize run completion',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]),write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{if(!cut&&writes.some(w=>w.kind==='assessment-session')){cut=true;throw new Error('before assessment admission');}return write(writes,guards);}) as typeof f.store.writeMany;
 await f.run();f.store.writeMany=write;assert.ok(cut);const packet=packetOf(f),attempt=packet.entries[0]!.attempt;
 // Explicitly corrupt fixture: no P.3 application or paid assessment backs this account.
 f.store.write({id:attemptAccountKey(packet,attempt),kind:'v7-attempt-account',expected:0,value:{contract:'v7-attempt-account/v1',
  subject:{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'block'},application:{id:'missing-application',revision:1,hash:'a'.repeat(64)},
  attempt,number:1,accepted:[],eventIds:[],streak:1}});
 const before=counters(f);
 for(const policy of [false,true]){const result=await f.run(1,f.open(),policy);assert.equal(result.value.status,'paused');
  assert.equal(result.value.pauseCode,'discovery_progress_conflict',JSON.stringify(result.value));assert.deepEqual(counters(f),before);}
 assert.equal(f.store.list('v7-progress-state').length,0);assert.equal(f.store.list('discovery-assessment').length,0);
});


test('R.1-01: a stale assessor continuation pauses its own running revision and cold replay never becomes busy',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 writeFileSync(f.settings,JSON.stringify({replies:[],tokens:10,assessmentReply:{action:'assessment_checkpoint',notes:['Continue exact packet']}}));
 const restore=cutAt(f,'paid');await f.run();restore();
 const waiting=await f.run(1,f.open(),false);assert.equal(waiting.value.pauseCode,'research_assessment_pending');
 acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,[planQuestion('new','industry')]);
 const before=counters(f);
 const stale=await f.run(1,f.open());assert.equal(stale.value.status,'paused',JSON.stringify(stale.value));
 assert.equal(stale.value.pauseCode,'input_stale',JSON.stringify(stale.value));assert.deepEqual(counters(f),before);
 for(const policy of [false,true]){
  const repeated=await f.run(1,f.open(),policy);
  assert.equal(repeated.value.status,'paused');assert.notEqual(repeated.value.pauseCode,'research_busy');
  assert.deepEqual(counters(f),before);
 }
});

test('R.1-01: a genuine competing Store CAS wins over checkpoint activation without being overwritten',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]),restore=cutAt(f,'unpaid');
 const stopped=await f.run();restore();
 const cold=f.open(),competitor=f.open(),write=cold.writeMany.bind(cold);let winner:Revision<ResearchRun>|undefined;
 cold.writeMany=((writes,guards=[])=>{
  if(!winner&&writes.some(w=>w.id===stopped.id&&(w.value as any).status==='running')){
   const current=competitor.get<ResearchRun>(stopped.id)!;
   winner=competitor.write<ResearchRun>({id:current.id,kind:current.kind,expected:current.revision,
    value:{...current.value,status:'paused',pauseCode:'research_interrupted',error:'Competing researcher stopped this run'}});
  }
  return write(writes,guards);
 }) as typeof cold.writeMany;
 const before=counters(f),result=await f.run(1,cold);
 assert.ok(winner);assert.deepEqual(result,winner);assert.deepEqual(f.store.get(stopped.id),winner);
 assert.deepEqual(counters(f),before);
});

async function reserveNextSynthesis(f:Awaited<ReturnType<typeof setup>>,boundary:'session'|'prepared'|'paid',materials:unknown[]=[]){
 f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,stopAfter:'L2',
  reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:f.command},agentCommand:f.command,
  maxRequestChars:100000,maxReadChars:20000,maxReplyChars:200000,maxCalls:50,maxReportedTokens:100000}});
 const pilot=readerPilot(f.store,'p')!,run=f.store.list<ResearchRun>('research-run')[0]!,number=run.value.turns+1;
 const subject={contract:V7_PLAN_SUBJECT_CONTRACT,planAnswer:f.v.planAnswer,planQuestionId:'support'};
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{
  const result=write(writes,guards);
  if(!cut&&writes.some(w=>boundary==='session'?w.kind==='synthesis-session'&&w.expected===0:
   boundary==='prepared'?w.kind==='research-consumer-intent'&&(w.value as any).kind==='synthesis'&&(w.value as any).state==='prepared':
   w.kind==='model-call'&&(w.value as any).purpose==='analyst'&&(w.value as any).status==='succeeded')){
   cut=true;throw new Error('R1 synthesis cut '+boundary);
  }
  return result;
 }) as typeof f.store.writeMany;
 try{
  await assert.rejects(synthesisSession(f.store,f.v.draft,f.v.plan,f.environment,pilotEnvironment(f.environment.value,pilot.value),pilot,
   {role:'research',stage:'discovery',subject,workingSelections:materials,inventory:{sources:[]},history:[]},'Synthesize the exact next subject',undefined,
   {delivery:{run:run.id,turn:number},reserve:{write:{id:run.id,kind:run.kind,expected:run.revision,value:{...run.value,turns:number}},guards:[reference(run)]}}),
   new RegExp('R1 synthesis cut '+boundary));
 }finally{f.store.writeMany=write;}
 assert.ok(cut);return f.store.list<any>('synthesis-session')[0]!;
}

for(const assessment of ['published','unpaid'] as const)for(const step of ['session','prepared'] as const)
test(`R.1-02: ${step}-only v3 synthesis waits for the prior ${assessment} assessment before any new send`,async t=>{
 const f=await setup(t),restore=cutAt(f,assessment);await f.run();restore();
 await reserveNextSynthesis(f,step);
 const before=counters(f),waiting=await f.run(1,f.open(),false);
 assert.equal(waiting.value.status,'paused');assert.equal(waiting.value.pauseCode,
  assessment==='published'?'research_restore_complete':'research_assessment_pending',JSON.stringify(waiting.value));
 assert.equal(f.wires().length,before.calls);assert.deepEqual(f.store.list('research-budget-ledger'),before.ledger);
 assert.equal(f.store.list('v7-attempt-account').length,assessment==='published'?1:0);
 const cold=f.open(),write=cold.writeMany.bind(cold);let sent=false;
 cold.writeMany=((writes,guards=[])=>{
  if(writes.some(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose==='analyst')){
   sent=true;const state=cold.list<any>('v7-progress-state')[0]!;assert.ok(state);
   assert.equal(readV7ProgressStateAt(cold,reference(state)).value.summary.count,1);
   assert.equal(cold.list('v7-attempt-account').length,1,'The first complete paid application precedes synthesis');
  }
  return write(writes,guards);
 }) as typeof cold.writeMany;
 const done=await f.run(1,cold);assert.ok(sent,JSON.stringify(done.value));
 assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));
 assert.equal(done.value.turns,2);assert.equal(f.store.list('research-attempt').length,2);
 assert.equal(f.store.list('v7-attempt-account').length,2);
 const stable=counters(f);await f.run(1,f.open(),false);assert.deepEqual(counters(f),stable);
});

test('R.1-02: a paid v3 synthesis result restores before its unpaid prior assessment without another call',async t=>{
 const f=await setup(t),restore=cutAt(f,'unpaid');await f.run();restore();
 const session=await reserveNextSynthesis(f,'paid');
 const before=counters(f),waiting=await f.run(1,f.open(),false);
 assert.equal(waiting.value.status,'paused');assert.equal(waiting.value.pauseCode,'research_assessment_pending',JSON.stringify(waiting.value));
 assert.equal(f.wires().length,before.calls);assert.deepEqual(f.store.list('research-budget-ledger'),before.ledger);
 assert.equal(f.store.list('v7-attempt-account').length,0);assert.equal(f.store.list('v7-progress-state').length,0);
 assert.equal(f.store.list('research-attempt').length,2,'The already paid synthesis end and K were restored');
 assert.ok(f.store.get<any>(session.id)!.value.delivered);
 const stable=counters(f);await f.run(1,f.open(),false);assert.deepEqual(counters(f),stable);
});


test('R.1-02: a paid intermediate v3 checkpoint restores its note before gating the next synthesis send',async t=>{
 const f=await setup(t),restore=cutAt(f,'unpaid');await f.run();restore();
 const source=f.discovery.evidence.document('p','checkpoint-material','A delivered clause and its exception.','text/plain',0);
 const material={kind:'context',value:f.discovery.evidence.observe('p',reference(source),
  {kind:'text-range',start:0,end:source.value.content.length})};
 f.configure([ended(),{action:'checkpoint',question:'$selected',value:{finding:'The delivered clause has an exception'},
  citations:[{source:material.value.source,selector:material.value.selector}],unresolved:[]}]);
 const session=await reserveNextSynthesis(f,'paid',[material]),before=counters(f);
 const waiting=await f.run(1,f.open(),false);
 assert.equal(waiting.value.status,'paused');assert.equal(waiting.value.pauseCode,'research_assessment_pending',JSON.stringify(waiting.value));
 assert.equal(f.wires().length,before.calls);assert.deepEqual(f.store.list('research-budget-ledger'),before.ledger);
 const restored=f.store.get<any>(session.id)!;assert.equal(restored.value.result,null);assert.ok(restored.value.notes.length);
 assert.equal(f.store.list('research-checkpoint').length,1);assert.equal(f.store.list('research-attempt').length,1);
 assert.equal(f.store.list('v7-attempt-account').length,0);
 const stable=counters(f);await f.run(1,f.open(),false);assert.deepEqual(counters(f),stable);
 f.configure();const cold=f.open(),write=cold.writeMany.bind(cold);let resumed=false;
 cold.writeMany=((writes,guards=[])=>{
  if(writes.some(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose==='analyst')){
   resumed=true;assert.equal(cold.list('v7-attempt-account').length,1);
   assert.equal(readV7ProgressStateAt(cold,reference(cold.list<any>('v7-progress-state')[0]!)).value.summary.count,1);
  }
  return write(writes,guards);
 }) as typeof cold.writeMany;
 const done=await f.run(1,cold);assert.ok(resumed,JSON.stringify(done.value));
 assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));assert.equal(done.value.turns,2);
 assert.equal(f.store.list('v7-attempt-account').length,2);assert.equal(f.wires().length,before.calls+3);
});

for (const boundary of ['unpaid','prepared-assessor'] as const)
test(`R.1: replacement edition leaves ${boundary} old assessment uncounted and completes its own exact subject`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{
  if(!cut&&writes.some(w=>boundary==='unpaid'?w.kind==='assessment-session':
    w.kind==='model-call'&&w.expected===0&&(w.value as any).purpose==='assessor')){
   cut=true;throw new Error('before old assessor payment');
  }
  return write(writes,guards);
 }) as Store['writeMany'];
 await f.run();f.store.writeMany=write;assert.ok(cut);
 const old=f.store.list('research-attempt')[0]!,oldRef=reference(old);
 const next=acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,[planQuestion('new','industry')]);
 const calls=f.wires().length,ledger=f.store.list('research-budget-ledger');
 const pending=await f.run(1,f.open(),false);
 assert.equal(pending.value.pauseCode,'research_assessment_pending',JSON.stringify(pending.value));
 assert.equal(f.wires().length,calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
 f.finishFrontier();const done=await f.run(1,f.open());assert.equal(done.value.status,'paused');assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));
 assert.deepEqual(f.wires().filter(w=>!w.subject.assessmentSubject).map(w=>w.subject.question.id),['block','new']);
 assert.deepEqual(assessmentWires(f).map(w=>w.subject.assessmentSubject.packet.planAnswer),[next.planAnswer]);
 assert.deepEqual(f.store.get(old.id,old.revision),old);
 assert.equal(f.store.list('v7-attempt-account').length,1);
 const state=f.store.list<any>('v7-progress-state')[0]!;
 assert.deepEqual(state.value.subject.planAnswer,next.planAnswer);assert.equal(state.value.summary.count,1);
 const paid=readDiscoveryAssessment(f.store,'p',reference(f.store.list<any>('discovery-assessment')[0]!));
 assert.ok(paid.value.subject.packet.entries.every(e=>canonical(e.attempt)!==canonical(oldRef)));
 const before=counters(f),history=f.history();const cold=await f.run(1,f.open(),false);
 assert.deepEqual(cold,done);assert.deepEqual(counters(f),before);assert.deepEqual(f.history(),history);
});


for (const cutSession of [false,true])
test(`R.1/S6.8: saved-only recovery retains the exact negative owner review${cutSession?' after its session-only cut':''} and applies the final attempt`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 f.engine.execute({type:'configure-reader-pilot',project:'p',expected:0,settings:{experimental:true,active:true,stopAfter:'L2',
  reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command:f.command},agentCommand:f.command,
  maxRequestChars:100000,maxReadChars:20000,maxReplyChars:200000,maxCalls:50,maxReportedTokens:100000,
  v7Planning:{contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:3}}});
 const pieces=['a','b'].map(name=>{
  const source=f.discovery.evidence.document('p','note-'+name,'A finding and its exception '+name,'text/plain',0);
  return {kind:'context',value:f.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:source.value.content.length})};
 });
 const subject={contract:V7_PLAN_SUBJECT_CONTRACT,planAnswer:f.v.planAnswer,planQuestionId:'block'},pilot=readerPilot(f.store,'p')!;
 f.configure([{action:'checkpoint',question:'$selected',value:{finding:'The finding retains its exception'},
  citations:[{source:pieces[0]!.value.source,selector:pieces[0]!.value.selector}],unresolved:[]},ended()]);
 assert.equal((await synthesisSession(f.store,f.v.draft,f.v.plan,f.environment,pilotEnvironment(f.environment.value,pilot.value),pilot,
  {role:'research',stage:'discovery',subject,workingSelections:pieces,inventory:{sources:[]},history:[]},'Synthesize',undefined,{})).action,'answer');
 const prior=f.wires().length,source=f.discovery.evidence.document('p','jurisdiction','Only the owner can select a jurisdiction.','text/plain',0);
 f.configure([...Array.from({length:prior},()=>ended()),
  {action:'read_plan',question:'$selected',reads:[{action:'read_source',source:reference(source),start:0,end:source.value.content.length}]},
  {action:'need_owner',question:'$selected',reason:'Choose this subject jurisdiction',searched:[reference(source)]},
  {necessary:false,reason:'The cited source already answers the subject'},ended()]);
 const write=f.store.writeMany.bind(f.store);let paidCut=false;
 f.store.writeMany=((writes,guards=[])=>{const rows=write(writes,guards);
  if(!paidCut&&writes.some(row=>row.kind==='model-call'&&(row.value as any).purpose==='escalation-assessor'&&(row.value as any).status==='succeeded')){
   paidCut=true;throw new Error('R1/S6.8 cut after paid owner review');
  }return rows;}) as Store['writeMany'];
 try{await f.run(3);}finally{f.store.writeMany=write;}
 assert.ok(paidCut);const choice=configureV7SavedSynthesis(f.store,'p',subject,0);
 const before=f.wires().length,reviews=f.store.list<any>('model-call').filter(row=>row.value.purpose==='escalation-assessor').map(reference);
 let sessionCut=false;
 if(cutSession)f.store.writeMany=((writes,guards=[])=>{const rows=write(writes,guards);
  if(!sessionCut&&writes.some(row=>row.kind==='synthesis-session'&&row.expected===0&&(row.value as any).basis.previousProposalRef)){
   sessionCut=true;throw new Error('R1/S6.8 cut before the first saved-only intent');
  }return rows;}) as Store['writeMany'];
 let result;
 try{result=await f.run(1);}finally{f.store.writeMany=write;}
 if(cutSession){
  assert.ok(sessionCut);assert.equal(result.value.pauseCode,'research_interrupted');assert.equal(f.wires().length,before);
  const cold=await f.run(1,f.open(),false);assert.equal(cold.value.pauseCode,'research_restore_complete');
  const fixed=f.history(),snapshot=counters(f);assert.deepEqual(await f.run(1,f.open(),false),cold);
  assert.deepEqual(f.history(),fixed);assert.deepEqual(counters(f),snapshot);
  result=await f.run(1,f.open());
 }
 assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
 const reviewed=f.store.list<any>('research-turn').find(row=>row.value.action?.action==='need_owner')!;
 assert.equal(reviewed.value.status,'completed');assert.equal(reviewed.value.observation.necessary,false);
 const fresh=f.wires().slice(before),sends=fresh.filter(row=>!row.subject.assessmentSubject);
 assert.equal(fresh.length,2);assert.equal(sends.length,1);assert.equal(assessmentWires(f).length,1);
 assert.deepEqual(sends[0].subject.previousProposalRef,reference(reviewed));
 const archive=sends[0].subject.working.archive,body=readArchiveBody(f.open(),f.store.get(archive.id,archive.revision)!).body;
 assert.deepEqual(body.subject,subject);assert.deepEqual(body.history,[{...reviewed.value,ref:reference(reviewed)}]);
 assert.deepEqual(body.savedMaterials.map((piece:any)=>piece.value.checkpoint),choice.value.checkpoints);
 assert.deepEqual(f.store.list<any>('model-call').filter(row=>row.value.purpose==='escalation-assessor').map(reference),reviews);
 assert.equal(f.store.list('research-attempt').length,1);assert.equal(f.store.list('v7-attempt-account').length,1);
 assert.equal(readV7ProgressStateAt(f.open(),reference(f.store.list<any>('v7-progress-state')[0]!)).value.summary.count,1);
 const restored=await f.run(1,f.open(),false);assert.equal(restored.value.pauseCode,'research_turns_exhausted');
 const fixed=f.history(),snapshot=counters(f);assert.deepEqual(await f.run(1,f.open(),false),restored);
 assert.deepEqual(f.history(),fixed);assert.deepEqual(counters(f),snapshot);
});
