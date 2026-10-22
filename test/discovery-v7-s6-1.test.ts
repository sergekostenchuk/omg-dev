import { readV7ProgressStateAt } from '../src/discovery/v7-progress.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import type { ResearchTurn } from '../src/discovery/research-model.js';
import { proveAttempt } from '../src/discovery/v7-plan-questions.js';
import { readResearchConsumerTurn, readContextTurnHistoryAt } from '../src/discovery/response-recovery.js';
import { discoveryFixture, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3a3k-");
type Fixture = ReturnType<typeof fixture>;


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
  return {...f,finishFrontier,v,questions,run,wires,history,configure,environment,calibrate};
}

const ended=(type='impossible')=>({action:'answer',question:'$selected',value:{type,code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]});

test('S6.1: paid context reads keep the complete run prefix across plan subjects', async t => {
  const f = await setup(t, [planQuestion('q-supply', 'industry', 'blocking'), planQuestion('q-market', 'market')]);
  const supplyRead = { action: 'read_context', record: reference(f.v.draft), pointer: '/fields/frame' };
  const marketRead = { action: 'read_context', record: reference(f.v.draft), pointer: '/fields/plan' };
  f.configure([supplyRead, ended(), marketRead, ended()]);
 f.finishFrontier();
  const run = await f.run();
  assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  assert.equal(run.value.pauseCode, null);
  assert.deepEqual(f.wires().filter(wire => !wire.subject.assessmentSubject).map(wire => wire.subject.question.id), ['q-supply', 'q-supply', 'q-market', 'q-market']);
  const wires = f.wires().filter(wire => !wire.subject.assessmentSubject);
  const assessments = f.wires().filter(wire => wire.subject.assessmentSubject);
  assert.deepEqual(assessments.map(w => w.subject.assessmentSubject.packet.planQuestionId), ['q-supply','q-market']);
  for (const wire of assessments) assert.deepEqual(wire.subject.assessmentSubject.packet.planAnswer, f.v.planAnswer);
  assert.equal(f.store.list('v7-progress-application').length, 2);
  for(const state of f.store.list('v7-progress-state')) {
    const proof=readV7ProgressStateAt(f.open(),reference(state));
    assert.deepEqual(proof.value.subject.planAnswer,f.v.planAnswer);
  }
  assert.equal(f.wires().length, 6);
  assert.deepEqual(wires[1]!.subject.contextWorkspace.map((entry: { pointer: string }) => entry.pointer), ['/fields/frame']);
  assert.deepEqual(wires[2]!.subject.contextWorkspace, [], 'the new subject receives none of the prior subject workspace');
  assert.deepEqual(wires[3]!.subject.contextWorkspace.map((entry: { pointer: string }) => entry.pointer), ['/fields/plan']);
  const attempts = f.store.list('research-attempt');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(row => proveAttempt(f.store, reference(row)).attempt.value.planQuestionId).sort(),
    ['q-market', 'q-supply']);
  const turns = f.store.list<ResearchTurn>('research-turn').filter(row => row.value.run === run.id)
    .sort((left, right) => left.value.number - right.value.number);
  assert.deepEqual(turns.map(row => row.value.number), [1, 2, 3, 4]);
  for (const turn of turns) {
    const proved = readResearchConsumerTurn(f.store, reference(turn));
    assert.equal(proved.value.status, 'completed');
    assert.equal(proved.value.error, null);
  }
  const question = reference(f.v.plan);
  const prefix = readContextTurnHistoryAt(f.store, 'p', f.v.draft, question, turns, 3);
  assert.deepEqual(prefix.map(proof => reference(proof.turn)), turns.slice(0, 2).map(reference));
  const before = f.history();
  assert.throws(() => readContextTurnHistoryAt(f.store, 'p', f.v.draft, question, turns.slice(1), 3),
    { code: 'research_consumer_intent_invalid',
      message: `[${f.v.draft.id}] The addressed read lost its complete earlier run history` });
  assert.deepEqual(f.history(), before);
  const paid = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  assert.equal(paid.filter(row => (row.value as { draftId?: string }).draftId === f.v.draft.id).length, 6);
  const cold = f.open();
  assert.notEqual(cold, f.store);
  assert.deepEqual(readContextTurnHistoryAt(cold, 'p', f.v.draft, question, turns, 3), prefix);
  assert.deepEqual(await f.run(1, cold, false), run);
  assert.deepEqual(f.history(), before);
  assert.deepEqual(cold.list('model-call'), paid);
  assert.deepEqual(cold.list('research-budget-ledger'), ledger);
  assert.equal(f.wires().length, 6);
});
