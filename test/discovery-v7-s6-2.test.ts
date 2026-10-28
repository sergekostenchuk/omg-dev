import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { canonical } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import type { V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { proveAttempt, selectV7AnalystRecovery } from '../src/discovery/v7-plan-questions.js';
import { listResearchConsumerIntents, consumerIntentContext, prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { discoveryFixture, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3a3k-");
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

function runHead(f: Awaited<ReturnType<typeof setup>>) {
  return f.store.list<ResearchRun>('research-run')[0]!;
}
async function interrupt(t: test.TestContext, boundary: 'attempt' | 'binding' | 'reservation', terminal = false) {
  const f = await setup(t), write = f.store.writeMany.bind(f.store);
  if (terminal) f.finishFrontier();
  let cut = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!cut && writes.some(row => boundary === 'reservation' ? row.kind === 'model-call' && row.expected === 0
      : row.kind === (boundary === 'attempt' ? 'research-attempt' : 'research-attempt-binding'))) {
      cut = true; throw new Error(`S6.2 cut before ${boundary}`);
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  const paused = await f.run(1);
  f.store.writeMany = write;
  assert.equal(cut, true); assert.equal(paused.value.status, 'paused');
  return f;
}
function prepareNext(f: Awaited<ReturnType<typeof setup>>, planQuestionId: string, key: string) {
  const previous = listResearchConsumerIntents(f.store, 'p', f.v.draft.id).find(row => row.value.kind === 'analyst')!;
  const subject: V7PlanSubject = { contract: 'v7-plan-subject/v1', planAnswer: f.v.planAnswer, planQuestionId };
  const run = runHead(f);
  return prepareResearchConsumerIntent(f.store, { projectId: 'p', kind: 'analyst', key,
    owner: reference(run), draft: reference(f.v.draft), question: reference(f.v.plan),
    role: previous.value.role, dispatch: previous.value.dispatch, profile: null,
    cursor: { run: run.id, turn: run.value.turns + 1, mode: null, instruction: previous.value.cursor.instruction,
      context: { ...consumerIntentContext(f.store, previous.value), subject, history: [], contextWorkspace: [] }, subject },
    basis: [f.v.planAnswer, ...f.v.draft.value.inputs],
    guards: uniqueTransactionGuards([reference(run), reference(f.v.draft), reference(f.v.plan),
      reference(f.environment), ...f.v.draft.value.inputs, f.v.planAnswer]) });
}
function nextEdition(f: Awaited<ReturnType<typeof setup>>) {
  const plan = f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(plan.id, plan.revision);
  const source = f.discovery.evidence.document('p', 'next-edition', 'Second accepted plan basis', 'text/plain', 0);
  answerDiscoveryFixture(f.engine, 'p', f.store.get<DiscoveryDraft>(f.v.draft.id)!, f.store.get<Question>(plan.id)!,
    validPlan(f.v.frameRef, [planQuestion('block', 'industry', 'blocking')], 2, f.v.planAnswer), source);
  return f.store.get<Question>(plan.id)!.value.answer!;
}

test('S6.2: a cold paid turn finishes before the next prepared analyst admission', async t => {
  const f = await interrupt(t, 'attempt', true);
  const pending = f.store.list('research-turn')[0]!, next = prepareNext(f, 'support', 's6-2-next');
  const selected = selectV7AnalystRecovery(f.store, 'p', f.v.draft.id, runHead(f));
  assert.deepEqual(reference(selected.turn!), reference(pending));
  assert.equal(selected.outstanding, undefined);
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  const cold = f.open(), resumed = await f.run(1, cold, false);
  assert.equal(resumed.value.status, 'paused');
  assert.equal(resumed.value.pauseCode, 'research_assessment_pending', JSON.stringify(resumed.value));
  assert.equal(cold.list('research-attempt').length, 1, 'the prior paid result finishes before admitting a new call');
  assert.equal(cold.list('research-attempt-binding').length, 1);
  assert.equal(cold.get<any>(next.id)!.value.state, 'prepared');
  assert.deepEqual(cold.list('model-call'), calls); assert.deepEqual(cold.list('research-budget-ledger'), ledger);
  assert.equal(f.wires().length, 1);
  f.finishFrontier();const done = await f.run(1, cold);
  assert.equal(done.value.status,'paused');assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));
  assert.deepEqual(f.wires().filter(wire => !wire.subject.assessmentSubject).map(wire => wire.subject.question.id), ['block', 'support']);
  assert.deepEqual(f.wires().filter(wire => wire.subject.assessmentSubject).map(wire => wire.subject.assessmentSubject.packet.planQuestionId), ['block', 'support']);
  assert.equal(cold.list('v7-progress-application').length, 2);
  assert.equal(cold.list('research-attempt').length, 2);
  const before = f.history(); assert.deepEqual(await f.run(1, f.open(), false), done);
  assert.deepEqual(f.history(), before); assert.equal(f.wires().length, 4);
});

test('S6.2: two genuine prepared admissions claiming one position refuse without a send', async t => {
  const f = await interrupt(t, 'reservation');
  prepareNext(f, 'block', 's6-2-conflicting-position');
  const before = f.history(), run = runHead(f);
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  assert.throws(() => selectV7AnalystRecovery(f.store, 'p', f.v.draft.id, run),
    { code: 'research_consumer_intent_invalid', message: `[${run.id}] Several incompatible analyst operations claim this run position` });
  assert.deepEqual(f.history(), before);
  const cold = f.open(), result = await f.run(1, cold);
  assert.equal(result.value.pauseCode, 'research_consumer_intent_invalid');
  assert.deepEqual(cold.list('model-call'), calls); assert.deepEqual(cold.list('research-budget-ledger'), ledger);
  assert.equal(f.wires().length, 0);
});

test('S6.2: an old paid attempt completes its own binding before selecting the replacement edition', async t => {
  const f = await interrupt(t, 'binding');
  const oldAttempt = f.store.list('research-attempt')[0]!, nextPlan = nextEdition(f);
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  const cold = f.open(), result = await f.run(1, cold, false);
  assert.equal(result.value.status, 'paused');
  assert.equal(result.value.pauseCode, 'research_assessment_pending', JSON.stringify(result.value));
  assert.deepEqual(cold.list('research-attempt'), [oldAttempt]);
  assert.equal(cold.list('research-attempt-binding').length, 1);
  assert.deepEqual(proveAttempt(cold, reference(oldAttempt)).attempt.value.planAnswer, f.v.planAnswer);
  assert.deepEqual(cold.list('model-call'), calls); assert.deepEqual(cold.list('research-budget-ledger'), ledger);
  assert.equal(f.wires().length, 1);
  f.finishFrontier();const done = await f.run(1, cold);
  assert.equal(done.value.status,'paused');assert.equal(done.value.pauseCode,'research_turns_exhausted',JSON.stringify(done.value));
  const attempts = cold.list('research-attempt').map(row => proveAttempt(cold, reference(row)).attempt.value);
  assert.equal(attempts.length, 2);
  assert.deepEqual(new Set(attempts.map(attempt => canonical(attempt.planAnswer))),
    new Set([canonical(f.v.planAnswer), canonical(nextPlan)]));
  assert.equal(new Set(attempts.map(attempt => canonical(attempt.call))).size, 2, 'the replacement edition buys its own call');
  assert.equal(f.wires().length, 3);
  assert.equal(f.wires().filter(wire => wire.subject.assessmentSubject).length, 1);
  assert.deepEqual(f.wires().filter(wire => !wire.subject.assessmentSubject).map(wire => wire.subject.question.id), ['block', 'block']);
  const app = cold.list<any>('v7-progress-application')[0]!;
  assert.deepEqual(app.value.subject.planAnswer, nextPlan);
  assert.equal(cold.list('v7-attempt-account').length, 1);
  const before = f.history(); assert.deepEqual(await f.run(1, f.open(), false), done);
  assert.deepEqual(f.history(), before); assert.equal(f.wires().length, 3);
});

test('S6.2: an unpaid old-edition admission is retained but cannot send under the replacement plan', async t => {
  const f = await interrupt(t, 'reservation');
  nextEdition(f);
  const intents = f.store.list('research-consumer-intent'), before = f.history();
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  const selected = selectV7AnalystRecovery(f.store, 'p', f.v.draft.id, runHead(f));
  assert.ok(selected.outstanding);
  assert.deepEqual(f.history(), before);
  const cold = f.open(), refused = await f.run(1, cold);
  assert.equal(refused.value.pauseCode, 'research_consumer_context_stale', JSON.stringify(refused.value));
  assert.deepEqual(cold.list('research-consumer-intent'), intents);
  assert.deepEqual(cold.list('model-call'), calls); assert.deepEqual(cold.list('research-budget-ledger'), ledger);
  assert.equal(f.wires().length, 0);
});

test('S6.2: a cold paid owner review resumes its exact pending turn without another admission', async t => {
  const f = await setup(t, [planQuestion('block', 'industry', 'blocking')]);
  const source = f.discovery.evidence.document('p', 'owner-basis', 'Only the owner can choose a jurisdiction.', 'text/plain', 0);
  f.configure([{ action: 'read_source', source: reference(source), start: 0, end: source.value.content.length },
    { action: 'need_owner', question: '$selected', reason: 'Choose a jurisdiction', searched: [reference(source)] },
    { necessary: true, reason: 'The jurisdiction requires an owner decision' }]);
  const write = f.store.writeMany.bind(f.store);
  let cut = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!cut && writes.some(row => row.kind === 'research-consumer-intent'
      && (row.value as any).kind === 'escalation-assessor' && (row.value as any).state === 'applied')) {
      cut = true; throw new Error('S6.2 cut before paid review application');
    }
    return write(writes, guards);
  }) as Store['writeMany'];
  const paused = await f.run(); f.store.writeMany = write;
  assert.equal(cut, true, JSON.stringify(paused.value)); assert.equal(paused.value.status, 'paused');
  const selected = selectV7AnalystRecovery(f.store, 'p', f.v.draft.id, runHead(f));
  assert.equal(selected.outstanding!.value.kind, 'escalation-assessor');
  assert.deepEqual(selected.outstanding!.value.cursor.pendingTurn, reference(selected.turn!));
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  const cold = f.open(), result = await f.run(1, cold, false);
  assert.equal(result.value.status, 'needs_owner', JSON.stringify(result.value));
  assert.deepEqual(result.value.ownerQuestion, { question: 'block',
    reason: 'The jurisdiction requires an owner decision', searched: [reference(source)] });
  assert.deepEqual(cold.list('model-call'), calls); assert.deepEqual(cold.list('research-budget-ledger'), ledger);
  assert.equal(f.wires().length, 3);
  const before = f.history(); assert.deepEqual(await f.run(1, f.open(), false), result);
  assert.deepEqual(f.history(), before); assert.equal(f.wires().length, 3);
});

for (const damage of ['missing-run', 'missing-position', 'foreign-position'] as const)
  test(`S6.2: ${damage} cannot select a genuine unpaid admission`, async t => {
    const f = await interrupt(t, 'reservation'), run = runHead(f);
    let damaged: Revision<ResearchRun> | null = null;
    if (damage !== 'missing-run') {
      const value = { ...run.value };
      if (damage === 'missing-position') delete (value as any).turns;
      else value.turns++;
      damaged = f.store.write<ResearchRun>({ id: run.id, kind: run.kind, value, expected: run.revision });
    }
    const before = f.history();
    assert.throws(() => selectV7AnalystRecovery(f.store, 'p', f.v.draft.id, damaged),
      { code: 'research_consumer_intent_invalid' });
    assert.deepEqual(f.history(), before); assert.equal(f.wires().length, 0);
  });
