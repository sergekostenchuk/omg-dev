import { readV7ProgressStateAt } from '../src/discovery/v7-progress.js';
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
import { canonical, type Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import type { V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { readResearchConsumerTurn } from '../src/discovery/response-recovery.js';
import { v7PlannerRounds } from '../src/discovery/reading-plan.js';
import type { ReaderPilot } from '../src/discovery/reader-pilot.js';
import { listResearchConsumerIntents, consumerIntentContext } from '../src/discovery/response-recovery.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3a3k-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

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

async function setup(t: test.TestContext, questions = [planQuestion('support','market'), planQuestion('block','industry','blocking')], calibrated = true, planning = true) {
  const f=fixture(t);f.engine.execute({type:'create-project',project:'p',title:'P'});
  writeFileSync(join(f.root,'scope.txt'),'Exact scope for the real queued read.');
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
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 const rejected=(r.subject.value?.attempts??[]).flatMap(entry=>entry.end.type==='submitted'?entry.end.value.claims.map((claim,index)=>({claim:{project:packet.project,container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id},reason:'Insufficient corroboration'})):[]);
 research=s.assessmentReply??{verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected,newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
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
    configure([ended(), {necessary:true,reason:'Calibration review'}, {action:'read_plan',question:'$selected',reads}], tokens);
    await researchCall(environment.value.implementer,environment.value,'Calibrate planner',{dispatchMode:'planning'},undefined,
      {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'reading-planner'});
    await researchCall(environment.value.reviewer,environment.value,'Calibrate assessor',{},undefined,
      {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'assessor'});
    configure();writeFileSync(wire,'');
  };
  if (calibrated) await calibrate();
  configure();writeFileSync(wire,'');
  const v=acceptPlan(f,'p',questions);
  const run=(limit=8,store=f.store, policy=true)=>new Researcher(store,new Discovery(store),new ProductEngine(store).environments)
    .run('p',v.draft.id,limit,undefined,policy?{producerPolicy:{discovery:7}}:{});
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const history=()=>f.store.list().map(row=>[row.id,row.revision,row.hash]);
  const commandForPilot = { executable: process.execPath, args: [adapter] };
  const enablePlanning = (maxRequestChars = 100000) => f.engine.execute({ type: 'configure-reader-pilot', project: 'p', expected: 0, settings: { experimental: true, active: true,
    stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command: commandForPilot },
    agentCommand: commandForPilot, maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 10000,
    maxCalls: 20, maxReportedTokens: 100000,
    v7Planning: { contract: 'v7-plan-planning/v1', maxRequestChars, maxRounds: 3 } } });
  if (planning) enablePlanning();
  return {...f,v,questions,run,wires,history,configure,environment,calibrate,enablePlanning};
}

const ended=(type='impossible')=>({action:'answer',question:'$selected',value:{type,code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]});

const reads = [{ action: 'search', query: 'one exact symbol' }, { action: 'read', path: 'scope.txt', media: 'text/plain' }];
const planner = { action: 'read_plan', question: '$selected', reads };

// A queue-only entry must leave synthesis to a separately admitted run.
function queueProducts(f: Awaited<ReturnType<typeof setup>>) {
  assert.deepEqual(f.store.list('synthesis-session'), []);
  const intents = listResearchConsumerIntents(f.store, 'p', f.v.draft.id);
  assert.deepEqual(intents.filter(row => ['synthesis', 'consolidation'].includes(row.value.kind)), []);
  assert.deepEqual(f.store.list<any>('model-call').filter(row => row.value.consumerIntent
    && ['synthesis', 'consolidation'].includes(f.store.get<any>(row.value.consumerIntent.id)?.value.kind)), []);
  // Includes queue/result/intent/call/ledger and every other product record.
  // Only the run may gain a new pause reason at the public admission door.
  return f.store.list().filter(row => row.kind !== 'research-run').map(reference);
}
async function refuseNewWork(f: Awaited<ReturnType<typeof setup>>, store = f.open()) {
  const before = queueProducts(f);
  const stopped = await f.run(1, store, false);
  assert.equal(stopped.value.pauseCode, 'research_contract_upgrade_required', JSON.stringify(stopped.value));
  assert.deepEqual(queueProducts(f), before);
  return stopped;
}

test('S6.3: a real paid planner publishes one original turn and its complete exact subject queue', async t => {
  const f = await setup(t); f.configure([planner]);
  const before = f.store.list('research-budget-ledger');
  const result = await f.run(1);
  assert.equal(result.value.pauseCode, 'research_turns_exhausted', JSON.stringify(result.value));
  const rows = f.store.list<any>('research-turn').sort((a,b) => a.value.number-b.value.number);
  assert.equal(rows.length, 3); assert.equal(result.value.turns, 3); assert.ok(result.value.requestChars > 0);
  const parent = rows[0]!, original = f.store.get<any>(parent.id, 1)!;
  assert.equal(original.value.dispatchMode, 'planning'); assert.equal(original.value.status, 'pending');
  assert.equal(parent.revision, 2); assert.equal(parent.value.status, 'completed');
  assert.deepEqual(parent.value.action, { ...planner, question: 'block' });
  const subject: V7PlanSubject = { contract: 'v7-plan-subject/v1', planAnswer: f.v.planAnswer, planQuestionId: 'block' };
  assert.deepEqual(parent.value.subject, subject);
  assert.equal(v7PlannerRounds(f.store, 'p', subject), 1);
  assert.deepEqual(parent.value.observation.children, rows.slice(1).map(row => reference(f.store.get<any>(row.id, 1)!)));
  for (const [index, child] of rows.slice(1).entries()) {
    assert.equal(child.value.status, 'completed'); assert.equal(child.value.error, null);
    assert.deepEqual(child.value.action, reads[index]); assert.deepEqual(child.value.subject, subject);
    assert.deepEqual(child.value.question, reference(f.v.plan)); assert.deepEqual(child.value.plannedBy, reference(original));
    assert.equal(Object.hasOwn(child.value, 'attemptContract'), false);
    assert.deepEqual(readResearchConsumerTurn(f.store, reference(child)), child);
  }
  assert.deepEqual(readResearchConsumerTurn(f.store, reference(parent)), parent);
  const intent = listResearchConsumerIntents(f.store, 'p', f.v.draft.id).find(row => row.value.kind === 'reading-planner')!;
  assert.equal(intent.value.state, 'applied');
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  assert.equal(f.wires().length, 1); assert.equal(ledger.length, before.length + 1);
  const paused = await refuseNewWork(f);
  const history = f.history(); assert.deepEqual(await refuseNewWork(f), paused);
  assert.deepEqual(f.history(), history); assert.deepEqual(f.store.list('model-call'), calls);
  assert.deepEqual(f.store.list('research-budget-ledger'), ledger); assert.equal(f.wires().length, 1);
});

for (const boundary of ['paid', 'before-queue', 'in-queue', 'after-queue'] as const)
  test(`S6.3: cold continuation after ${boundary} keeps one planner payment and an atomic complete queue`, async t => {
    const f = await setup(t); f.configure([planner]);
    const write = f.store.writeMany.bind(f.store);
    let cut = false;
    f.store.writeMany = ((writes, guards = []) => {
      const parent = writes.some(row => row.kind === 'research-turn' && row.id.startsWith('research-turn:v1:')
        && row.expected === (boundary === 'paid' ? 0 : 1));
      const queued = writes.filter(row => row.kind === 'research-turn' && row.expected === 0 && !row.id.startsWith('research-turn:v1:'));
      if (!cut && parent && (boundary === 'paid' || queued.length === 2)) {
        cut = true;
        if (boundary === 'after-queue') write(writes, guards);
        if (boundary === 'in-queue') {
          // A real conflict at the last child must roll back the preceding run,
          // parent and first child writes in the same Store transaction.
          const damaged = writes.map(row => row.id === queued[1]!.id ? { ...row, expected: 1 } : row);
          return write(damaged, guards);
        }
        throw new Error(`S6.3 cut ${boundary}`);
      }
      return write(writes, guards);
    }) as Store['writeMany'];
    const paused = await f.run(1); f.store.writeMany = write;
    assert.equal(cut, true, JSON.stringify(paused.value)); assert.equal(paused.value.status, 'paused');
    const saved = f.store.list<any>('research-turn');
    assert.equal(saved.length, boundary === 'paid' ? 0 : boundary === 'after-queue' ? 3 : 1);
    assert.equal(paused.value.turns, boundary === 'paid' ? 0 : boundary === 'after-queue' ? 3 : 1);
    const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
    const cold = f.open(), result = await f.run(1, cold, false);
    assert.equal(result.value.pauseCode, 'research_contract_upgrade_required', JSON.stringify(result.value));
    assert.equal(result.value.turns, 3); assert.ok(result.value.requestChars > 0);
    const turns = cold.list<any>('research-turn'); assert.equal(turns.length, 3);
    for (const turn of turns.filter(row => !row.id.startsWith('research-turn:v1:'))) {
      assert.equal(turn.value.status, 'completed'); assert.equal(turn.value.error, null);
    }
    for (const turn of turns) assert.deepEqual(readResearchConsumerTurn(cold, reference(turn)), turn);
    assert.equal(turns.filter(turn => turn.id.startsWith('research-turn:v1:')).length, 1);
    assert.deepEqual(cold.list('model-call'), calls); assert.deepEqual(cold.list('research-budget-ledger'), ledger);
    assert.equal(f.wires().length, 1);
    const before = f.history(); assert.deepEqual(await f.run(1, f.open(), false), result);
    assert.deepEqual(f.history(), before);
  });

for (const invalid of ['foreign-question', 'attempt-answer'] as const)
  test(`S6.3: ${invalid} preserves the paid response without publishing a queue or attempt`, async t => {
    const f = await setup(t);
    f.configure([invalid === 'foreign-question' ? { ...planner, question: 'foreign' } : ended()]);
    const result = await f.run(1);
    assert.equal(result.value.pauseCode, invalid === 'foreign-question' ? 'reading_plan_invalid' : 'research_mode_invalid',
      JSON.stringify(result.value));
    const turns = f.store.list<any>('research-turn'); assert.equal(turns.length, 1);
    assert.equal(turns[0]!.value.status, 'pending'); assert.equal(turns[0]!.value.dispatchMode, 'planning');
    assert.equal(f.store.list('research-attempt').length, 0);
    const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
    await f.run(1, f.open(), false);
    assert.deepEqual(f.store.list('model-call'), calls); assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
    assert.equal(f.wires().length, 1);
  });

test('S6.3: planner admission on the next subject preserves the existing common budget and run counters', async t => {
  const f = await setup(t, undefined, true, false);
  const first = await f.run(1);
  assert.equal(first.value.pauseCode, 'research_turns_exhausted'); assert.equal(first.value.turns, 1);
  const segments = f.store.list('research-budget'), ledger = f.store.list<any>('research-budget-ledger');
  assert.equal(segments.length, 1); assert.equal(ledger.length, 1);
  f.enablePlanning(); f.configure([ended(), planner]);
  const result = await f.run(1, f.open());
  assert.equal(result.value.pauseCode, 'research_turns_exhausted', JSON.stringify(result.value));
  assert.equal(result.value.turns, 4);
  const intent = listResearchConsumerIntents(f.store, 'p', f.v.draft.id).find(row => row.value.kind === 'reading-planner')!;
  assert.equal(result.value.requestChars, first.value.requestChars + canonical(consumerIntentContext(f.store, intent.value)).length);
  assert.deepEqual(f.store.list('research-budget').map(row => row.id), segments.map(row => row.id));
  for (const row of ledger) {
    assert.deepEqual(f.store.get(row.id, row.revision), row);
    const next = f.store.get<any>(row.id)!;
    assert.equal(next.value.assignments.length, row.value.assignments.length + 1);
    assert.deepEqual(next.value.assignments.slice(0, row.value.assignments.length), row.value.assignments);
    const calls = f.store.list<any>('model-call').filter(call => call.value.draftId === f.v.draft.id);
    assert.deepEqual(new Set(next.value.assignments.map((item: any) => item.call)), new Set(calls.map(call => call.id)));
  }
  assert.deepEqual(f.store.list('research-budget-ledger').map(row => row.id), ledger.map(row => row.id));
  assert.deepEqual(f.wires().filter(wire=>!wire.subject.assessmentSubject).map(wire => wire.subject.question.id), ['block', 'support']);
  const assessments=f.wires().filter(w=>w.subject.assessmentSubject);
  assert.deepEqual(assessments.map(w=>w.subject.assessmentSubject.packet.planQuestionId),['block']);
  for(const wire of assessments)assert.deepEqual(wire.subject.assessmentSubject.packet.planAnswer,f.v.planAnswer);
  assert.equal(f.store.list('v7-progress-application').length,1);
  for(const state of f.store.list('v7-progress-state')) {
    const proof=readV7ProgressStateAt(f.open(),reference(state));
    assert.deepEqual(proof.value.subject.planAnswer,f.v.planAnswer);
  }
  assert.equal(f.wires().length,3);
  queueProducts(f);
});

test('S6.3: the explicit complete planner request limit refuses before reservation or payment', async t => {
  const f = await setup(t, undefined, true, false); f.enablePlanning(1); f.configure([planner]);
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
  const result = await f.run(1);
  assert.equal(result.value.pauseCode, 'pilot_request_limit', JSON.stringify(result.value));
  assert.deepEqual(f.store.list('model-call'), calls); assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
  assert.equal(f.store.list('research-turn').length, 0); assert.equal(f.wires().length, 0);
});

for (const boundary of ['unpaid', 'paid'] as const)
  test(`S6.3: disabling planning after ${boundary} admission cannot send anew or discard paid work`, async t => {
    const f = await setup(t); f.configure([planner]);
    const write = f.store.writeMany.bind(f.store); let cut = false;
    f.store.writeMany = ((writes, guards = []) => {
      if (!cut && writes.some(row => row.expected === 0 && row.kind ===
        (boundary === 'unpaid' ? 'model-call' : 'research-turn'))) {
        cut = true; throw new Error(`S6.3 settings ${boundary}`);
      }
      return write(writes, guards);
    }) as Store['writeMany'];
    await f.run(1); f.store.writeMany = write; assert.equal(cut, true);
    const configured = f.store.list<any>('reader-pilot')[0]!;
    const { projectId: _project, ...settings } = configured.value;
    f.engine.execute({ type: 'configure-reader-pilot', project: 'p', expected: configured.revision,
      settings: { ...settings, active: false } });
    const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
    const cold = f.open(), result = await f.run(1, cold, boundary !== 'paid');
    assert.equal(result.value.pauseCode, boundary === 'paid' ? 'research_contract_upgrade_required' : 'reading_plan_disabled',
      JSON.stringify(result.value));
    assert.equal(cold.list('research-turn').length, boundary === 'paid' ? 3 : 0);
    for (const row of cold.list('research-turn')) assert.deepEqual(readResearchConsumerTurn(cold, reference(row)), row);
    assert.deepEqual(cold.list('model-call'), calls); assert.deepEqual(cold.list('research-budget-ledger'), ledger);
    assert.equal(f.wires().length, boundary === 'paid' ? 1 : 0);
  });

for (const action of [{ action: 'synthesize', question: '$selected' }, { action: 'pause', reason: 'Planner stopped' }])
  test(`S6.3: a paid planner ${action.action} keeps its exact terminal turn without starting another consumer`, async t => {
    const f = await setup(t); f.configure([action]);
    const result = await f.run(1);
    assert.equal(result.value.pauseCode, action.action === 'pause' ? 'research_model_paused' : 'research_turns_exhausted',
      JSON.stringify(result.value));
    const turns = f.store.list<any>('research-turn'); assert.equal(turns.length, 1);
    assert.equal(turns[0]!.value.status, 'completed');
    assert.deepEqual(readResearchConsumerTurn(f.store, reference(turns[0]!)), turns[0]);
    assert.equal(listResearchConsumerIntents(f.store, 'p', f.v.draft.id).length, 1);
    assert.equal(f.store.list('synthesis-session').length, 0); assert.equal(f.wires().length, 1);
    const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
    await f.run(1, f.open(), false);
    assert.deepEqual(f.store.list('model-call'), calls); assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
    assert.equal(f.wires().length, 1);
  });


for (const boundary of ['settings-snapshot', 'intent-publication', 'reservation', 'unpaid-resume'] as const)
  test(`S6.3-01: a second Store disabling settings at ${boundary} cannot lose the planner reservation guard`, async t => {
    const f = await setup(t); f.configure([planner]);
    const other = f.open(), otherEngine = new ProductEngine(other);
    const initialPilot = other.get<ReaderPilot>('reader-pilot:p')!;
    const toggle = (active: boolean) => {
      const pilot = other.get<ReaderPilot>(initialPilot.id)!;
      const { projectId: _projectId, ...settings } = pilot.value;
      otherEngine.execute({ type: 'configure-reader-pilot', project: 'p', expected: pilot.revision,
        settings: { ...settings, active } });
    };
    const get = f.store.get.bind(f.store), write = f.store.writeMany.bind(f.store);
    if (boundary === 'unpaid-resume') {
      let prepared = false;
      f.store.writeMany = ((writes, guards = []) => {
        if (writes.some(row => row.kind === 'model-call' && row.expected === 0)) {
          prepared = true; throw new Error('S6.3-01 cut before the unpaid reservation');
        }
        return write(writes, guards);
      }) as Store['writeMany'];
      await f.run(1); f.store.writeMany = write;
      assert.equal(prepared, true);
    }
    const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
    let changed = false, published = false, reserved = false;
    f.store.get = ((id, revision) => {
      const row = get(id, revision);
      if (!changed && ['settings-snapshot', 'unpaid-resume'].includes(boundary)
        && revision === undefined && row?.kind === 'reader-pilot'
        && new Error().stack?.includes('runPlanAttempts')) {
        changed = true; toggle(false);
      }
      return row;
    }) as Store['get'];
    f.store.writeMany = ((writes, guards = []) => {
      const intent = writes.find(row => row.kind === 'research-consumer-intent'
        && row.expected === 0 && (row.value as { kind?: string }).kind === 'reading-planner');
      if (intent && boundary === 'intent-publication' && !changed) { changed = true; toggle(false); }
      if (writes.some(row => row.kind === 'model-call' && row.expected === 0)) {
        reserved = true;
        if (boundary === 'reservation' && !changed) { changed = true; toggle(false); }
        // Reproduce the review's whole unsafe chain if the snapshot lost its
        // Ref: re-enable after publication, then disable after admission.
        if (boundary === 'settings-snapshot' && published) toggle(false);
      }
      const result = write(writes, guards);
      if (intent) {
        published = true;
        if (boundary === 'settings-snapshot') toggle(true);
      }
      return result;
    }) as Store['writeMany'];
    let result;
    try { result = await f.run(1); }
    finally { f.store.get = get; f.store.writeMany = write; }
    assert.equal(changed, true, 'the real configuration command reached the named window');
    assert.equal(result.value.pauseCode, 'input_stale', JSON.stringify(result.value));
    assert.equal(f.wires().length, 0);
    assert.deepEqual(f.store.list('model-call'), calls);
    assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
    assert.equal(f.store.list('research-turn').length, 0);
    const intents = listResearchConsumerIntents(f.store, 'p', f.v.draft.id);
    if (boundary === 'settings-snapshot' || boundary === 'intent-publication') {
      assert.equal(published, false); assert.equal(intents.length, 0);
    } else {
      assert.equal(reserved, true); assert.equal(intents.length, 1);
      assert.equal(intents[0]!.value.state, 'prepared');
      for (const refs of [intents[0]!.value.basis, intents[0]!.value.guards])
        assert.equal(refs.filter(ref => canonical(ref) === canonical(reference(initialPilot))).length, 1);
    }
  });
