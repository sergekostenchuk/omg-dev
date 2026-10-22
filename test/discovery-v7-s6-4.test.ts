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
import { type Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { readResearchConsumerTurn } from '../src/discovery/response-recovery.js';
import { splitPlannedContextRead, v7PlannerRounds, v7DispatchMode } from '../src/discovery/reading-plan.js';
import { listResearchConsumerIntents } from '../src/discovery/response-recovery.js';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { readSavedReaderBundleResult } from '../src/discovery/reader.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-v7-s6-4-"));
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
    configure([ended(), {necessary:true,reason:'Calibration review'}, {action:'read_plan',question:'$selected',reads},
      {selections:[{sourceIndex:0,firstLine:1,lastLine:2}],unresolved:[]}], tokens);
    await researchCall({actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},environment.value,
      'Calibrate reader',{role:'reader'},undefined,
      {store:f.store,draftId:calibration.id,questionId:calibration.value.questions[0]!,purpose:'reader'});
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


const ownTurns = (store: Store) => store.list<any>('research-turn').sort((a,b) => a.value.number-b.value.number);
const readerReply = {selections:[{sourceIndex:0,firstLine:1,lastLine:2}],unresolved:[]};

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

test('S6.4: a real planner queue executes search, a source read and the common paid reader for one exact subject', async t => {
  const f = await setup(t, [planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Exact condition.\nApplicable exception.\n');
  const source=f.store.list<any>('source').find(row=>row.value.origin.kind==='owner-document')!;
  const actions = [...reads, {action:'read_source',source:reference(source),start:0,end:5},
    {action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'}, {action:'read_bundle',purpose:'Read the exact condition and exception',
    inputs:[{path:'scope.txt',media:'text/plain'}]}];
  f.configure([{...planner,reads:actions}, readerReply]);
  const calls = f.store.list('model-call').length, ledger = f.store.list('research-budget-ledger').length;
  const result = await f.run(1);
  assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
  const turns = ownTurns(f.store); assert.equal(turns.length,6);
  assert.equal(f.wires().length,2); assert.equal(f.wires()[1]!.subject.role,'reader');
  assert.equal(f.store.list('model-call').length,calls+2);
  const ledgers=f.store.list<any>('research-budget-ledger');
  assert.equal(ledgers.length,ledger+1);
  assert.equal(ledgers.at(-1)!.value.assignments.length,2,'both paid calls share the same ledger');
  assert.deepEqual(new Set(ledgers.at(-1)!.value.assignments.map((row:any)=>row.call)),
    new Set(f.store.list<any>('model-call').filter(row=>row.value.draftId===f.v.draft.id).map(row=>row.id)));
  const original = f.store.get<any>(turns[0]!.id,1)!;
  assert.deepEqual(turns[0]!.value.observation.children,turns.slice(1).map(row=>reference(f.store.get<any>(row.id,1)!)));
  for (const [index, child] of turns.slice(1).entries()) {
    assert.equal(child.value.status,'completed'); assert.equal(child.value.error,null);
    assert.deepEqual(child.value.action,actions[index]); assert.deepEqual(child.value.plannedBy,reference(original));
    assert.deepEqual(child.value.subject,original.value.subject);
    assert.deepEqual(readResearchConsumerTurn(f.store,reference(child)),child);
  }
  const bundle = turns[5]!, reader = listResearchConsumerIntents(f.store,'p',f.v.draft.id).find(row=>row.value.kind==='reader')!;
  assert.equal(reader.value.state,'applied');
  assert.deepEqual(reader.value.cursor.consumer.turn,reference(f.store.get<any>(bundle.id,1)!));
  await refuseNewWork(f);
  const history=f.history(), savedCalls=f.store.list('model-call'), savedLedger=f.store.list('research-budget-ledger');
  await refuseNewWork(f);
  assert.deepEqual(f.history(),history); assert.deepEqual(f.store.list('model-call'),savedCalls);
  assert.deepEqual(f.store.list('research-budget-ledger'),savedLedger); assert.equal(f.wires().length,2);
});

test('S6.4: an answered physical plan keeps a failed logical child open for the real public retry', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  f.configure([{...planner,reads:[{action:'read',path:'arrives.txt',media:'text/plain'}]}]);
  const blocked=await f.run(2);
  assert.equal(blocked.value.pauseCode,'reading_plan_blocked',JSON.stringify(blocked.value));
  const failed=ownTurns(f.store)[1]!;
  assert.equal(failed.value.status,'completed'); assert.ok(failed.value.error);
  assert.equal(f.store.get<Question>(f.v.plan.id)!.value.status,'answered');
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  writeFileSync(join(f.root,'arrives.txt'),'Now available.');
  f.engine.execute({type:'retry-planned-read',project:'p',child:reference(failed)});
  const pending=f.store.get<any>(failed.id)!;
  assert.equal(pending.value.status,'pending'); assert.deepEqual(pending.value.replayedFrom,reference(failed));
  const result=await f.run(1,f.open(),false);
  assert.equal(result.value.pauseCode,'research_contract_upgrade_required',JSON.stringify(result.value));
  queueProducts(f);
  const complete=f.store.get<any>(failed.id)!;
  assert.equal(complete.value.status,'completed'); assert.equal(complete.value.error,null);
  assert.deepEqual(complete.value.plannedBy,failed.value.plannedBy); assert.deepEqual(complete.value.subject,failed.value.subject);
  assert.deepEqual(readResearchConsumerTurn(f.store,reference(complete)),complete);
  assert.deepEqual(f.store.list('model-call'),calls); assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,1);
});

test('S6.4: a saved paid reader result completes its original child cold after settings are disabled without paying again', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Exact condition.\nApplicable exception.\n');
  f.configure([{...planner,reads:[{action:'read_bundle',purpose:'Read condition',inputs:[{path:'scope.txt',media:'text/plain'}]}]},readerReply]);
  const write=f.store.writeMany.bind(f.store); let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut && writes.some(row=>row.kind==='research-turn' && row.expected===1
      && (row.value as any).action?.action==='read_bundle' && (row.value as any).status==='completed')) {
      cut=true;throw new Error('S6.4 cut after the paid reader result');
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  const stopped=await f.run(2);f.store.writeMany=write;
  assert.equal(cut,true,JSON.stringify(stopped.value));assert.equal(f.wires().length,2);
  const child=ownTurns(f.store)[1]!;assert.equal(child.value.status,'pending');
  const pilot=f.store.get<any>('reader-pilot:p')!;const {projectId: _project,...settings}=pilot.value;
  f.engine.execute({type:'configure-reader-pilot',project:'p',expected:pilot.revision,settings:{...settings,active:false}});
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await f.run(2,f.open(),false);
  const completed=f.store.get<any>(child.id)!;
  assert.equal(completed.value.status,'completed');assert.equal(completed.value.error,null);
  assert.deepEqual(completed.value.subject,child.value.subject);assert.deepEqual(readResearchConsumerTurn(f.store,reference(completed)),completed);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,2);
});


test('S6.4: the real splitter preserves the exact paid queue through cold execution of both parts', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  f.configure([{...planner,reads:[{action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'}]}]);
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    const saved=write(writes,guards);
    if(!cut && writes.some(row=>row.kind==='research-turn' && row.expected===0 && !row.id.startsWith('research-turn:v1:'))) {
      cut=true;throw new Error('S6.4 cut after publishing the real queue');
    }
    return saved;
  }) as Store['writeMany'];
  const stopped=await f.run(1);f.store.writeMany=write;assert.equal(cut,true);
  const child=ownTurns(f.store)[1]!, parent=ownTurns(f.store)[0]!;
  const split=splitPlannedContextRead(f.store,stopped,child,f.v.draft,f.v.plan);
  assert.equal(split.children.length,2);
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  const result=await f.run(1,f.open(),false);
  assert.equal(result.value.pauseCode,'research_contract_upgrade_required',JSON.stringify(result.value));
  queueProducts(f);
  const parts=split.children.map(ref=>f.store.get<any>(ref.id)!);
  assert.deepEqual(parts.flatMap(row=>row.value.observation.value),['materials supply','equipment accounting']);
  for(const part of parts) {
    assert.equal(part.value.status,'completed');assert.equal(part.value.error,null);
    assert.deepEqual(part.value.splitFrom,reference(child));assert.deepEqual(part.value.plannedBy,child.value.plannedBy);
    assert.deepEqual(part.value.subject,parent.value.subject);assert.deepEqual(readResearchConsumerTurn(f.store,reference(part)),part);
  }
  for(const row of ownTurns(f.store))assert.deepEqual(readResearchConsumerTurn(f.store,reference(row)),row);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,1);
});

test('S6.4: another real reader result cannot masquerade as this queued child completion', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Exact condition.\nApplicable exception.\n');
  f.configure([{...planner,reads:['first','second'].map(purpose=>({action:'read_bundle',purpose,
    inputs:[{path:'scope.txt',media:'text/plain'}]}))},readerReply,readerReply]);
  const write=f.store.writeMany.bind(f.store);let changed=false,damaged='';
  f.store.writeMany=((writes,guards=[])=>{
    const second=writes.find(row=>row.kind==='research-turn' && row.expected===1
      && (row.value as any).action?.purpose==='second' && (row.value as any).status==='completed');
    if(second&&!changed) {
      const first=ownTurns(f.store).find(row=>row.value.action?.purpose==='first')!;
      assert.equal(first.value.status,'completed');changed=true;damaged=second.id;
      return write(writes.map(row=>row.id===second.id?{...row,value:{...row.value as object,
        observation:first.value.observation}}:row),guards);
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  const result=await f.run(3);f.store.writeMany=write;
  assert.equal(changed,true,JSON.stringify(result.value));
  assert.equal(result.value.pauseCode,'research_consumer_intent_invalid',JSON.stringify(result.value));
  assert.throws(()=>readResearchConsumerTurn(f.store,reference(f.store.get<any>(damaged)!)),{code:'research_consumer_intent_invalid'});
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await f.run(2,f.open());
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});


function changePilot(f: Awaited<ReturnType<typeof setup>>, patch: Record<string, unknown>) {
  const pilot=f.store.get<any>('reader-pilot:p')!;const {projectId:_project,...settings}=pilot.value;
  return f.engine.execute({type:'configure-reader-pilot',project:'p',expected:pilot.revision,settings:{...settings,...patch}});
}

test('S6.4: subject B does not inherit subject A failed child when the real analyst ends A', async t => {
  const f=await setup(t);writeFileSync(join(f.root,'scope.txt'),'Available to the second subject.');
  f.configure([{...planner,reads:[{action:'read',path:'missing.txt',media:'text/plain'}]},ended(),
    {...planner,reads:[{action:'read',path:'scope.txt',media:'text/plain'}]}]);
  assert.equal((await f.run(2)).value.pauseCode,'reading_plan_blocked');
  const failed=ownTurns(f.store)[1]!;
  changePilot(f,{active:false});
  assert.equal((await f.run(1)).value.pauseCode,'research_turns_exhausted');
  changePilot(f,{active:true});
  const result=await f.run(1,f.open());
  assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
  queueProducts(f);
  assert.deepEqual(f.wires().filter(row=>!row.subject.assessmentSubject).map(row=>row.subject.question.id),['block','block','support']);
  const assessments=f.wires().filter(w=>w.subject.assessmentSubject);
  assert.deepEqual(assessments.map(w=>w.subject.assessmentSubject.packet.planQuestionId),['block']);
  for(const wire of assessments)assert.deepEqual(wire.subject.assessmentSubject.packet.planAnswer,f.v.planAnswer);
  assert.equal(f.store.list('v7-progress-application').length,1);
  for(const state of f.store.list('v7-progress-state')) {
    const proof=readV7ProgressStateAt(f.open(),reference(state));
    assert.deepEqual(proof.value.subject.planAnswer,f.v.planAnswer);
  }
  assert.equal(f.wires().length,4);
  assert.deepEqual(f.store.get(failed.id),failed);
  const newest=ownTurns(f.store).at(-1)!;
  assert.equal(newest.value.subject.planQuestionId,'support');assert.equal(newest.value.error,null);
  assert.deepEqual(readResearchConsumerTurn(f.store,reference(newest)),newest);
  assert.equal(v7PlannerRounds(f.store,'p',failed.value.subject),1);
  assert.equal(v7PlannerRounds(f.store,'p',newest.value.subject),1);
});

test('S6.4: a replacement edition with the same question id gets its own queue and no old failed child', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Available to the new edition.');
  f.configure([{...planner,reads:[{action:'read',path:'missing.txt',media:'text/plain'}]},
    {...planner,reads:[{action:'read',path:'scope.txt',media:'text/plain'}]}]);
  assert.equal((await f.run(2)).value.pauseCode,'reading_plan_blocked');
  const failed=ownTurns(f.store)[1]!, oldPlan=f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(oldPlan.id,oldPlan.revision);
  const draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!,question=f.store.get<Question>(oldPlan.id)!;
  const source=f.discovery.evidence.document('p','edition2','Second edition source','text/plain',0);
  answerDiscoveryFixture(f.engine,'p',draft,question,validPlan(f.v.frameRef,f.questions,2,f.v.planAnswer),source);
  const nextPlan=f.store.get<Question>(oldPlan.id)!;
  const result=await f.run(1,f.open());
  assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
  queueProducts(f);
  const child=ownTurns(f.store).at(-1)!;
  assert.deepEqual(child.value.subject.planAnswer,nextPlan.value.answer);
  assert.notDeepEqual(child.value.subject.planAnswer,failed.value.subject.planAnswer);
  assert.deepEqual(f.store.get(failed.id),failed);assert.equal(child.value.error,null);
  assert.equal(f.wires().length,2);
  assert.equal(v7PlannerRounds(f.store,'p',failed.value.subject),1);
  assert.equal(v7PlannerRounds(f.store,'p',child.value.subject),1);
});

test('S6.4: one actual paid round exhausts maxRounds=1 even after reopening Store and dropping in-memory turns', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const pilot=f.store.get<any>('reader-pilot:p')!;
  changePilot(f,{v7Planning:{...pilot.value.v7Planning,maxRounds:1}});
  writeFileSync(join(f.root,'scope.txt'),'One real round.');f.configure([{...planner,reads:[reads[1]]}]);
  assert.equal((await f.run(1)).value.pauseCode,'research_turns_exhausted');
  queueProducts(f);
  const subject=ownTurns(f.store)[0]!.value.subject,cold=f.open();
  assert.equal(v7PlannerRounds(cold,'p',subject),1);
  const calls=cold.list('model-call'),ledger=cold.list('research-budget-ledger');
  assert.throws(()=>v7DispatchMode(cold,'p',[],f.v.plan,subject,
    {contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:1}),{code:'reading_plan_rounds_exhausted'});
  queueProducts(f);
  assert.deepEqual(cold.list('model-call'),calls);assert.deepEqual(cold.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,1);
});

test('S6.4: repeated context children retain the no-progress refusal and exact pending child on cold replay', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const action={action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'};
  f.configure([{...planner,reads:[{...action,page:{offset:0,limit:2}},{...action,page:{offset:0,limit:3}}]}]);
  const result=await f.run(2);
  assert.equal(result.value.pauseCode,'research_no_progress',JSON.stringify(result.value));
  const turns=ownTurns(f.store),pending=turns[2]!;
  assert.equal(pending.value.status,'pending');
  assert.deepEqual(pending.value.observation,{code:'research_no_progress',previous:reference(turns[1]!)});
  assert.deepEqual(readResearchConsumerTurn(f.store,reference(pending)),pending);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  assert.deepEqual(await f.run(2,f.open()),result);
  assert.deepEqual(f.history(),history);assert.deepEqual(f.store.list('model-call'),calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,1);
});


test('S6.4: a real unclaimed reader follows the public failed-child retry and executes once cold', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Exact condition.\nApplicable exception.\n');
  f.configure([{...planner,reads:[{action:'read_bundle',purpose:'Read condition',inputs:[{path:'scope.txt',media:'text/plain'}]}]},readerReply]);
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    const result=write(writes,guards);
    if(!cut && writes.some(row=>row.kind==='research-consumer-intent' && (row.value as any).kind==='reader'
      && (row.value as any).state==='prepared')) {cut=true;throw new Error('S6.4 cut with a real unclaimed reader');}
    return result;
  }) as Store['writeMany'];
  await f.run(2);f.store.writeMany=write;assert.equal(cut,true);
  const intent=listResearchConsumerIntents(f.store,'p',f.v.draft.id).find(row=>row.value.kind==='reader')!;
  assert.equal(intent.value.state,'prepared');assert.equal(f.wires().length,1);
  const child=f.store.get<any>(intent.value.owner.id)!;
  // Inject only the operation failure, as in the existing C23 regression.
  // Planner, queue and prepared reader are all produced by the real runner.
  const failed=f.store.write({id:child.id,kind:child.kind,expected:child.revision,
    value:{...child.value,status:'completed',error:'Injected interruption before reader reservation'}});
  const pending=f.engine.execute({type:'retry-planned-read',project:'p',child:reference(failed)}) as Revision<any>;
  const rebound=f.store.get<any>(intent.id)!;
  assert.deepEqual(rebound.value.owner,reference(pending));assert.deepEqual(rebound.value.cursor.consumer.turn,reference(pending));
  const result=await f.run(1,f.open(),false);
  assert.equal(result.value.pauseCode,'research_contract_upgrade_required',JSON.stringify(result.value));
  queueProducts(f);
  const completed=f.store.get<any>(child.id)!;
  assert.equal(completed.value.status,'completed');assert.equal(completed.value.error,null);
  assert.deepEqual(completed.value.replayedFrom,reference(failed));assert.deepEqual(completed.value.plannedBy,child.value.plannedBy);
  assert.deepEqual(readResearchConsumerTurn(f.store,reference(completed)),completed);assert.equal(f.wires().length,2);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await refuseNewWork(f);assert.deepEqual(f.history(),history);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,2);
});

test('S6.4: reopening the physical plan cannot rebind or repurchase a saved paid child result', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Exact condition.\nApplicable exception.\n');
  f.configure([{...planner,reads:[{action:'read_bundle',purpose:'Read condition',inputs:[{path:'scope.txt',media:'text/plain'}]}]},readerReply]);
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut && writes.some(row=>row.kind==='research-turn' && row.expected===1
      && (row.value as any).action?.action==='read_bundle' && (row.value as any).status==='completed')) {
      cut=true;throw new Error('S6.4 cut after paid reader before plan reopen');
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  await f.run(2);f.store.writeMany=write;assert.equal(cut,true);
  const child=ownTurns(f.store)[1]!,plan=f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(plan.id,plan.revision);
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await f.run(2,f.open(),false);
  const completed=f.store.get<any>(child.id)!;
  assert.equal(completed.value.status,'completed');assert.equal(completed.value.error,null);
  assert.deepEqual(completed.value.subject,child.value.subject);assert.deepEqual(completed.value.question,child.value.question);
  assert.deepEqual(readResearchConsumerTurn(f.store,reference(completed)),completed);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,2);
});

for (const action of ['read', 'read_context'] as const) {
  for (const damage of ['missing', 'foreign'] as const) {
    test(`S6.4: ${damage} ${action} result is refused on the real queued completion and cold replay`, async t => {
      const f=await setup(t,[planQuestion('block','industry','blocking')]);
      writeFileSync(join(f.root,'scope.txt'),'The exact file result.');
      const read=action==='read' ? reads[1] : {
        action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'};
      f.configure([{...planner,reads:[read]}]);
      const write=f.store.writeMany.bind(f.store);let damaged='';
      f.store.writeMany=((writes,guards=[])=>{
        const child=writes.find(row=>row.kind==='research-turn' && row.expected===1
          && (row.value as any).action?.action===action && (row.value as any).status==='completed');
        if(child && !damaged) {
          damaged=child.id;
          return write(writes.map(row=>row.id===child.id?{...row,value:{...row.value as object,
            observation:damage==='missing'?null:{...(row.value as any).observation,
              ...(action==='read'?{excerpt:'A substituted result'}:{value:['A substituted result']})}}}:row),guards);
        }
        return write(writes,guards);
      }) as Store['writeMany'];
      const result=await f.run(2);f.store.writeMany=write;
      assert.ok(damaged,JSON.stringify(result.value));
      assert.equal(result.value.pauseCode,'research_consumer_intent_invalid',JSON.stringify(result.value));
      assert.throws(()=>readResearchConsumerTurn(f.store,reference(f.store.get<any>(damaged)!)),{code:'research_consumer_intent_invalid'});
      const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
      const cold=await f.run(2,f.open());
      assert.equal(cold.value.pauseCode,'research_consumer_intent_invalid');
      assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
      assert.equal(f.wires().length,1);
    });
  }
}

test('S6.4: a paid context child still splits from its immutable context after the physical plan reopens', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  f.configure([{...planner,reads:[{action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'}]}]);
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    const saved=write(writes,guards);
    if(!cut && writes.some(row=>row.kind==='research-turn' && row.expected===0 && !row.id.startsWith('research-turn:v1:'))) {
      cut=true;throw new Error('S6.4 cut before splitting a paid child');
    }
    return saved;
  }) as Store['writeMany'];
  const stopped=await f.run(1);f.store.writeMany=write;assert.equal(cut,true);
  const child=ownTurns(f.store)[1]!,plan=f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(plan.id,plan.revision);
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  const split=splitPlannedContextRead(f.open(),stopped,child,f.v.draft,f.v.plan);
  await f.run(2,f.open(),false);
  const parts=split.children.map(ref=>f.store.get<any>(ref.id)!);
  assert.deepEqual(parts.flatMap(row=>row.value.observation.value),['materials supply','equipment accounting']);
  for(const part of parts) {
    assert.equal(part.value.status,'completed');assert.equal(part.value.error,null);
    assert.deepEqual(part.value.subject,child.value.subject);
    assert.deepEqual(part.value.plannedBy,child.value.plannedBy);
    assert.deepEqual(readResearchConsumerTurn(f.store,reference(part)),part);
  }
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,1);
});

for (const damage of ['null', 'missing-contract', 'unknown-contract'] as const) {
  test(`S6.4-01: ${damage} cannot hide the result proof of a real read_source child`, async t => {
    const f=await setup(t,[planQuestion('block','industry','blocking')]);
    const source=f.store.list<any>('source').find(row=>row.value.origin.kind==='owner-document')!;
    f.configure([{...planner,reads:[{action:'read_source',source:reference(source),start:0,end:5}]}]);
    const write=f.store.writeMany.bind(f.store);let damaged='';
    f.store.writeMany=((writes,guards=[])=>{
      const child=writes.find(row=>row.kind==='research-turn' && row.expected===1
        && (row.value as any).action?.action==='read_source' && (row.value as any).status==='completed');
      if(child && !damaged) {
        damaged=child.id;
        const observation={...(child.value as any).observation};
        if(damage==='missing-contract')delete observation.contract;
        else observation.contract='source-read/unknown';
        return write(writes.map(row=>row.id===child.id?{...row,value:{...row.value as object,
          observation:damage==='null'?null:observation}}:row),guards);
      }
      return write(writes,guards);
    }) as Store['writeMany'];
    const result=await f.run(2);f.store.writeMany=write;
    assert.ok(damaged,JSON.stringify(result.value));
    assert.equal(result.value.pauseCode,'research_consumer_intent_invalid');
    assert.throws(()=>readResearchConsumerTurn(f.store,reference(f.store.get<any>(damaged)!)),{code:'research_consumer_intent_invalid'});
    const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger'),cold=f.open();
    assert.throws(()=>readResearchConsumerTurn(cold,reference(cold.get<any>(damaged)!)),{code:'research_consumer_intent_invalid'});
    assert.equal((await f.run(2,cold)).value.pauseCode,'research_consumer_intent_invalid');
    assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
    assert.equal(f.wires().length,1);
  });
}

test('S6.4-03: two real sibling queue members cannot masquerade as a child split', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const action={action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'};
  f.configure([{...planner,reads:[action,{...action,page:{offset:0,limit:1}},{...action,page:{offset:1,limit:1}}]}]);
  const write=f.store.writeMany.bind(f.store);let changed=false,damaged='';
  f.store.writeMany=((writes,guards=[])=>{
    const child=writes.find(row=>row.kind==='research-turn' && row.expected===1
      && (row.value as any).action?.action==='read_context' && (row.value as any).status==='completed');
    if(child&&!changed) {
      const neighbours=ownTurns(f.store).filter(row=>row.id!==child.id && !row.id.startsWith('research-turn:v1:'));
      assert.equal(neighbours.length,2);changed=true;damaged=child.id;
      return write(writes.map(row=>row.id===child.id?{...row,value:{...row.value as object,
        observation:{splitInto:neighbours.map(reference),reason:'context_read_limit'}}}:row),guards);
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  const result=await f.run(2);f.store.writeMany=write;
  assert.equal(changed,true);assert.equal(result.value.pauseCode,'research_consumer_intent_invalid');
  const cold=f.open(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  assert.throws(()=>readResearchConsumerTurn(cold,reference(cold.get<any>(damaged)!)),{code:'research_consumer_intent_invalid'});
  assert.equal((await f.run(2,cold)).value.pauseCode,'research_consumer_intent_invalid');
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,1);
});

test('S6.4-02: a second purpose reuses full reader coverage without another intent or payment', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Exact condition.\nApplicable exception.\n');
  f.configure([{...planner,reads:['first','second'].map(purpose=>({action:'read_bundle',purpose,
    inputs:[{path:'scope.txt',media:'text/plain'}]}))},readerReply]);
  const result=await f.run(1);
  assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
  const children=ownTurns(f.store).slice(1);
  assert.equal(children.length,2);
  const first=f.store.get<any>(children[0]!.value.observation.ref.id)!;
  const reused=f.store.get<any>(children[1]!.value.observation.ref.id)!;
  assert.equal(first.value.producer,'paid');assert.equal(reused.value.producer,'reused');
  assert.equal(reused.value.purpose,'second');assert.deepEqual(reused.value.reusedFrom,[reference(first)]);
  assert.equal(listResearchConsumerIntents(f.store,'p',f.v.draft.id).filter(row=>row.value.kind==='reader').length,1);
  for(const child of children)assert.deepEqual(readResearchConsumerTurn(f.store,reference(child)),child);
  assert.equal(f.wires().length,2,'only planner and first reader pay');
  await refuseNewWork(f);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await refuseNewWork(f);assert.deepEqual(f.history(),history);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});

test('S6.4-02: a different equivalent public request can borrow the exact prior paid bundle directly', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  const source=f.store.list<any>('source').find(row=>row.value.origin.kind==='owner-document')!;
  f.configure([{...planner,reads:[
    {action:'read_bundle',purpose:'same',inputs:[{source:reference(source)}]},
    {action:'read_bundle',purpose:'same',inputs:[{source:reference(source),range:{start:0,end:source.value.content.length}}]}
  ]},{selections:[{sourceIndex:0,firstLine:1,lastLine:1}],unresolved:[]}]);
  const result=await f.run(1);
  assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
  const children=ownTurns(f.store).slice(1);
  assert.equal(children.length,2);
  assert.deepEqual(children[1]!.value.observation.ref,children[0]!.value.observation.ref);
  assert.equal(f.store.get<any>(children[0]!.value.observation.ref.id)!.value.producer,'paid');
  assert.equal(listResearchConsumerIntents(f.store,'p',f.v.draft.id).filter(row=>row.value.kind==='reader').length,1);
  for(const child of children)assert.deepEqual(readResearchConsumerTurn(f.store,reference(child)),child);
  await refuseNewWork(f);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await refuseNewWork(f);assert.deepEqual(f.history(),history);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,2);
});

test('S6.4-02: equivalent path and Source requests borrow one outside result without reader payment', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'outside.txt'),'Short source.');
  writeFileSync(join(f.root,'foreign.txt'),'Short source.');
  const sources=new ResearchSources(f.store,'p',f.root);
  const source=sources.read('outside.txt','text/plain'),foreign=sources.read('foreign.txt','text/plain');
  const range={start:999,end:1000};
  f.configure([{...planner,reads:[
    {action:'read_bundle',purpose:'same outside',inputs:[{path:'outside.txt',media:'text/plain',range}]},
    {action:'read_bundle',purpose:'same outside',inputs:[{source:reference(source),range}]}
  ]}]);
  const result=await f.run(1),children=ownTurns(f.store).slice(1);
  assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
  assert.equal(children.length,2);
  const first=children[0]!,second=children[1]!,output=first.value.observation.ref as Ref;
  assert.deepEqual(second.value.observation.ref,output);
  const results=f.store.list<any>('reader-result');
  assert.equal(results.length,1);assert.equal(results[0]!.value.producer,'outside');
  assert.equal(listResearchConsumerIntents(f.store,'p',f.v.draft.id).filter(row=>row.value.kind==='reader').length,0);
  assert.equal(f.wires().length,1,'only the planner calls the adapter');
  const cold=f.open();
  for(const child of children){
    assert.equal(child.value.status,'completed');assert.equal(child.value.error,null);
    assert.deepEqual(readResearchConsumerTurn(f.store,reference(child)),child);
    assert.deepEqual(readResearchConsumerTurn(cold,reference(child)),child);
  }
  const consumer={run:reference(f.store.get<any>(second.value.run,1)!),
    turn:reference(f.store.get<any>(second.id,1)!)};
  assert.equal(readSavedReaderBundleResult(cold,'p',second.value.question,'same outside',
    second.value.action.inputs,consumer),null,'unbound lookup cannot borrow another child result');
  for(const input of [{source:reference(foreign),range},
    {source:reference(source),range:{start:999,end:1001}},
    {source:reference(source),range:{start:0,end:5}}])
    assert.equal(readSavedReaderBundleResult(cold,'p',second.value.question,'same outside',[input],consumer,output),null);
  await refuseNewWork(f);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await refuseNewWork(f,cold);
  assert.deepEqual(f.history(),history);assert.deepEqual(f.store.list('reader-result'),results);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,1);
});

test('S6.4-02: a saved outside result finishes its exact child after disabled settings and plan reopen without a new result', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'A short source.');
  f.configure([{...planner,reads:[{action:'read_bundle',purpose:'Outside window',
    inputs:[{path:'scope.txt',media:'text/plain',range:{start:999,end:1000}}]}]}]);
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut && writes.some(row=>row.kind==='research-turn' && row.expected===1
      && (row.value as any).action?.action==='read_bundle' && (row.value as any).status==='completed')) {
      cut=true;throw new Error('S6.4-02 cut after a real outside result');
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  await f.run(2);f.store.writeMany=write;assert.equal(cut,true);
  const child=ownTurns(f.store)[1]!,results=f.store.list<any>('reader-result');
  assert.equal(results.length,1);assert.equal(results[0]!.value.producer,'outside');
  assert.deepEqual(results[0]!.value.request.consumer.turn,reference(child));
  assert.equal(listResearchConsumerIntents(f.store,'p',f.v.draft.id).filter(row=>row.value.kind==='reader').length,0);
  changePilot(f,{active:false});const plan=f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(plan.id,plan.revision);
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await f.run(2,f.open(),false);
  const completed=f.store.get<any>(child.id)!;
  assert.equal(completed.value.status,'completed');assert.equal(completed.value.error,null);
  assert.deepEqual(completed.value.observation.ref,reference(results[0]!));
  assert.deepEqual(readResearchConsumerTurn(f.open(),reference(completed)),completed);
  assert.deepEqual(f.store.list('reader-result'),results);assert.deepEqual(f.store.list('model-call'),calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,1);
  const history=f.history();await f.run(2,f.open(),false);assert.deepEqual(f.history(),history);
});

test('S6.4-02: a real combined reader tree and its reused coverage finish both queued children without extra payment', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  for(const name of ['a','b'])writeFileSync(join(f.root,`${name}.txt`),`${name.repeat(18000)}\n${name.repeat(18000)}\n`);
  changePilot(f,{maxRequestChars:60000});
  const inputs=['a','b'].map(name=>({path:`${name}.txt`,media:'text/plain'}));
  f.configure([{...planner,reads:['combined','reuse combined'].map(purpose=>({action:'read_bundle',purpose,inputs}))},readerReply,readerReply]);
  const result=await f.run(1);
  assert.equal(result.value.pauseCode,'research_turns_exhausted',JSON.stringify(result.value));
  const children=ownTurns(f.store).slice(1),combined=f.store.get<any>(children[0]!.value.observation.ref.id)!;
  const reused=f.store.get<any>(children[1]!.value.observation.ref.id)!;
  assert.equal(combined.value.producer,'combined');assert.equal(combined.value.parts.length,2);
  assert.equal(reused.value.producer,'reused');assert.ok(reused.value.reusedFrom.length>0);
  assert.equal(listResearchConsumerIntents(f.store,'p',f.v.draft.id).filter(row=>row.value.kind==='reader').length,2);
  for(const child of children)assert.deepEqual(readResearchConsumerTurn(f.store,reference(child)),child);
  assert.equal(f.wires().length,3,'planner and two reader parts, no call for reuse');
  await refuseNewWork(f);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await refuseNewWork(f);assert.deepEqual(f.history(),history);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});
