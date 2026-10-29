import { deliveredContract } from './discovery-response-contract-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { readResearchConsumerTurn } from '../src/discovery/response-recovery.js';
import { listResearchConsumerIntents } from '../src/discovery/response-recovery.js';
import { readBundle, resumeReadBundleIntent } from '../src/discovery/reader.js';
import { readerPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { questionDispatchId } from '../src/discovery/v7-managed-attempt.js';
import { readResearchConsumerExecution } from '../src/discovery/response-recovery.js';
import { synthesisSession } from '../src/discovery/synthesis-session.js';
import { discoveryFixture, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-v7-s6-5-");
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

async function setup(t: test.TestContext, questions = [planQuestion('support','market'), planQuestion('block','industry','blocking')], calibrated = true, planning = true) {
  const f=fixture(t);f.engine.execute({type:'create-project',project:'p',title:'P'});
  const wire=join(f.root,'wire.ndjson'), settings=join(f.root,'reply.json'), adapter=join(f.root,'adapter.mjs');
  const configure=(replies: unknown[]=[], tokens: number | null=10)=>writeFileSync(settings,JSON.stringify({replies,tokens}));
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
let previous=[];try{previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
let research=s.replies[previous.length]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=r.subject.question.id;
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


// Only the operation failure is injected. The planner, full queue, reader
// intent and (for claimed) paid response are created by the real runner.
async function interruptedReader(t: Parameters<typeof setup>[0], boundary: 'prepared' | 'applied' = 'prepared') {
  const f=await setup(t,[planQuestion('block','industry','blocking')]);
  writeFileSync(join(f.root,'scope.txt'),'Exact condition.\nApplicable exception.\n');
  writeFileSync(join(f.root,'concurrent.txt'),'Concurrent condition.\nIts exception.\n');
  writeFileSync(join(f.root,'previous.txt'),'Earlier condition.\nEarlier exception.\n');
  f.configure([{...planner,reads:[
    {action:'read_bundle',purpose:'Queued condition',inputs:[{path:'scope.txt',media:'text/plain'}]},
    {action:'read_context',record:reference(f.v.draft),pointer:'/fields/frame/domains'}
  ]},readerReply,readerReply,readerReply]);
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    const reader=writes.some(row=>row.kind==='research-consumer-intent' && (row.value as any).kind==='reader'
      && (row.value as any).state===boundary);
    if(!cut && reader && boundary==='applied') {cut=true;throw new Error('S6.5 cut before paid reader application');}
    const saved=write(writes,guards);
    if(!cut && reader){cut=true;throw new Error('S6.5 cut after real reader preparation');}
    return saved;
  }) as Store['writeMany'];
  try{await f.run(2);}finally{f.store.writeMany=write;}
  assert.equal(cut,true);
  const intent=listResearchConsumerIntents(f.store,'p',f.v.draft.id).find(row=>row.value.kind==='reader')!;
  assert.equal(intent.value.state,boundary==='prepared'?'prepared':'running');
  const child=f.store.get<any>(intent.value.owner.id)!;
  const failed=f.store.write<any>({id:child.id,kind:child.kind,expected:child.revision,
    value:{...child.value,status:'completed',error:'Injected interruption of the queued operation'}});
  assert.deepEqual(readResearchConsumerTurn(f.store,reference(failed)),failed);
  const retry=(store=f.store)=>new ProductEngine(store).execute({type:'retry-planned-read',project:'p',child:reference(failed)}) as Revision<any>;
  return {...f,intent,failed,retry};
}
type Interrupted=Awaited<ReturnType<typeof interruptedReader>>;

const commonRead=(f:Interrupted,store:Store,path='concurrent.txt')=>{
  const effective=new ProductEngine(store).environments.effective('p');
  return readBundle(store,{...effective.environment.value,workspace:effective.root},readerPilot(store,'p')!,
    reference(f.v.plan),`Unbound ${path}`,[{path,media:'text/plain'}]);
};

async function finishQueueOnce(f:Interrupted,expectedCalls:number){
  const retried=f.store.get<any>(f.failed.id)!;
  assert.equal(retried.value.status,'pending');assert.deepEqual(retried.value.replayedFrom,reference(f.failed));
  const rebound=f.store.get<any>(f.intent.id)!;
  assert.equal(rebound.value.state,'prepared');assert.deepEqual(rebound.value.owner,reference(retried));
  assert.deepEqual(rebound.value.cursor.consumer.turn,reference(retried));
  const callsBefore=f.store.list('model-call'),ledgerBefore=f.store.list('research-budget-ledger'),sent=f.wires().length;
  const paused=await f.run(2,f.open(),false);assert.equal(paused.value.pauseCode,'research_restore_complete');
  assert.deepEqual(f.store.get(rebound.id),rebound);assert.deepEqual(f.store.get(retried.id),retried);
  assert.deepEqual(f.store.list('model-call'),callsBefore);assert.deepEqual(f.store.list('research-budget-ledger'),ledgerBefore);assert.equal(f.wires().length,sent);
  const fixed=f.history();assert.deepEqual(await f.run(2,f.open(),false),paused);assert.deepEqual(f.history(),fixed);
  const effective=f.engine.environments.effective('p');
  await resumeReadBundleIntent(f.store,reference(rebound),{...effective.environment.value,workspace:effective.root},readerPilot(f.store,'p')!,undefined,[]);
  const resumed=await f.run(2,f.open(),false);
  const completed=f.store.get<any>(f.failed.id)!;
  assert.equal(completed.value.status,'completed',JSON.stringify(resumed.value));assert.equal(completed.value.error,null);
  const cold=f.open();
  for(const turn of ownTurns(cold))assert.deepEqual(readResearchConsumerTurn(cold,reference(turn)),turn);
  assert.equal(f.wires().length,expectedCalls);
  const readerWire=f.wires().find((wire:any)=>wire.subject?.role==='reader');
  assert.ok(readerWire);deliveredContract(f.store,readerWire,'reader',readerReply);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await f.run(2,f.open(),false);
  assert.deepEqual(f.history(),history);assert.deepEqual(f.store.list('model-call'),calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,expectedCalls);
}

for(const existingCounter of [false,true])
  test(`S6.5: a real common reader dispatch wins the retry window with a ${existingCounter?'saved':'missing'} physical counter atomically`,async t=>{
    const f=await interruptedReader(t);
    if(existingCounter)await commonRead(f,f.open(),'previous.txt');
    const counterId=questionDispatchId('p',f.v.plan.id,null),counter=f.store.get<any>(counterId);
    assert.equal(Boolean(counter),existingCounter);
    const queue=ownTurns(f.store),run=f.store.get<any>(f.failed.value.run)!;
    const before=f.store.get(f.intent.id),other=f.open();
    const write=f.store.writeMany.bind(f.store),concurrentWrite=other.writeMany.bind(other);
    let reached=false;
    other.writeMany=((writes,guards=[])=>{
      if(!reached && writes.some(row=>row.kind==='model-call' && (row.value as any).purpose==='reader')){
        reached=true;let reserved:Revision<any>[]|undefined;
        f.store.writeMany=((retryWrites,retryGuards=[])=>{
          assert.ok(retryWrites.some(row=>row.id===f.failed.id));
          reserved=concurrentWrite(writes,guards);
          const current=other.get<any>(counterId)!;
          assert.equal(current.revision,(counter?.revision??0)+1);
          return write(retryWrites,retryGuards);
        }) as Store['writeMany'];
        try{assert.throws(()=>f.retry(),{code:'revision_conflict'});}finally{f.store.writeMany=write;}
        assert.ok(reserved);
        assert.deepEqual(ownTurns(f.store),queue,'the complete queue rolls back');
        assert.deepEqual(f.store.get(run.id),run);assert.deepEqual(f.store.get(f.intent.id),before,'reader rebind rolls back too');
        return reserved;
      }
      return concurrentWrite(writes,guards);
    }) as Store['writeMany'];
    try{await commonRead(f,other);}finally{other.writeMany=concurrentWrite;}
    assert.equal(reached,true);assert.equal(f.wires().length,existingCounter?3:2);
    // One initial planner call, plus the successful common reader(s).
    assert.equal(f.store.list<any>('model-call').filter(row=>row.value.draftId===f.v.draft.id).length,existingCounter?3:2);
    f.retry();
    await finishQueueOnce(f,existingCounter?4:3);
  });

test('S6.5: retry winning a real common reader reservation prevents every call/ledger write and cold queue recovery pays once',async t=>{
  const f=await interruptedReader(t),other=f.open(),write=other.writeMany.bind(other);
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');let reached=false;
  other.writeMany=((writes,guards=[])=>{
    if(!reached && writes.some(row=>row.kind==='model-call' && (row.value as any).purpose==='reader')){
      reached=true;f.retry();
      return write(writes,guards);
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  try{await assert.rejects(commonRead(f,other),{code:'reader_intent_claim_conflict'});}finally{other.writeMany=write;}
  assert.equal(reached,true);assert.deepEqual(f.store.list('model-call'),calls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);assert.equal(f.wires().length,1);
  await finishQueueOnce(f,2);
});

test('S6.5: a real v3 subject dispatch in the retry window conflicts on its exact subject counter without partial rebind',async t=>{
  const f=await interruptedReader(t),other=f.open(),subject=f.failed.value.subject;
  const counterId=questionDispatchId('p',f.v.plan.id,subject),counter=f.store.get<any>(counterId)!;
  assert.ok(counter);assert.deepEqual(counter.value.subject,subject);
  f.configure([planner,ended(),readerReply]);
  const queue=ownTurns(f.store),run=f.store.get<any>(f.failed.value.run)!,before=f.store.get(f.intent.id);
  const write=f.store.writeMany.bind(f.store),concurrentWrite=other.writeMany.bind(other);
  const context={role:'research',stage:'discovery',subject,inventory:{sources:[]},history:[],contextWorkspace:[]};
  const synthesize=(store:Store)=>{
    const pilot=readerPilot(store,'p')!;
    return synthesisSession(store,f.v.draft,f.v.plan,f.environment,pilotEnvironment(f.environment.value,pilot.value),
      pilot,context,'Synthesize the exact plan-question');
  };
  let reached=false;
  other.writeMany=((writes,guards=[])=>{
    if(!reached && writes.some(row=>row.kind==='model-call' && (row.value as any).purpose==='analyst')){
      reached=true;let reserved:Revision<any>[]|undefined;
      f.store.writeMany=((retryWrites,retryGuards=[])=>{
        assert.ok(retryGuards.some(guard=>'revision' in guard && guard.id===counter.id
          && guard.revision===counter.revision && guard.hash===counter.hash));
        reserved=concurrentWrite(writes,guards);
        assert.equal(other.get(counterId)!.revision,counter.revision+1);
        return write(retryWrites,retryGuards);
      }) as Store['writeMany'];
      try{assert.throws(()=>f.retry(),{code:'input_stale'});}finally{f.store.writeMany=write;}
      assert.ok(reserved);assert.deepEqual(ownTurns(f.store),queue);
      assert.deepEqual(f.store.get(run.id),run);assert.deepEqual(f.store.get(f.intent.id),before);
      return reserved;
    }
    return concurrentWrite(writes,guards);
  }) as Store['writeMany'];
  let result;
  try{result=await synthesize(other);}finally{other.writeMany=concurrentWrite;}
  assert.equal(reached,true);assert.deepEqual(result,{...ended(),question:'block'});
  assert.equal(f.wires().length,2);assert.deepEqual(f.wires()[1]!.subject.subject,subject);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  assert.deepEqual(await synthesize(f.open()),result);assert.deepEqual(f.history(),history);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  f.retry();await finishQueueOnce(f,3);
});

test('S6.5: a genuinely claimed reader with a saved paid response cannot be rebound by direct or cold public retry',async t=>{
  const f=await interruptedReader(t,'applied');
  const intent=f.store.get<any>(f.intent.id)!;
  assert.equal(readResearchConsumerExecution(f.store,'p',reference(intent)).kind,'response');
  assert.equal(f.wires().length,2);
  const history=f.history(),calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  assert.ok(calls.filter(row=>(row.value as any).draftId===f.v.draft.id).every(row=>(row.value as any).status==='succeeded'));
  assert.throws(()=>f.retry(),{code:'reading_plan_recovery_invalid'});
  assert.throws(()=>f.retry(f.open()),{code:'reading_plan_recovery_invalid'});
  assert.deepEqual(f.history(),history);assert.deepEqual(f.store.get(intent.id),intent);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,2);
});


test('S6.5: a foreign dispatch after application preparation rejects the entire batch; cold paid replay refreshes the same guard',async t=>{
  const f=await interruptedReader(t);f.retry();
  const write=f.store.writeMany.bind(f.store);
  let application:{writes:Write[];guards:TransactionGuard[]}|undefined;
  f.store.writeMany=((writes,guards=[])=>{
    if(!application && writes.some(row=>row.id===f.intent.id && (row.value as any).state==='applied')){
      application={writes,guards};throw new Error('S6.5 cut after real paid application preparation');
    }
    return write(writes,guards);
  }) as Store['writeMany'];
  try{await f.run(2);}finally{f.store.writeMany=write;}
  assert.ok(application);
  const guarded=application;
  const running=f.store.get<any>(f.intent.id)!;
  assert.equal(running.value.state,'running');
  assert.equal(readResearchConsumerExecution(f.store,'p',reference(running)).kind,'response');
  assert.equal(f.wires().length,2);
  const counterId=questionDispatchId('p',f.v.plan.id,null),counter=f.store.get(counterId)!;
  assert.ok(guarded.guards.some(guard=>'revision' in guard && guard.id===counter.id
    && guard.revision===counter.revision && guard.hash===counter.hash));
  assert.ok(running.value.guards.some((guard:TransactionGuard)=>guard.id===counterId));
  const queue=ownTurns(f.store),other=f.open(),concurrentWrite=other.writeMany.bind(other);
  let reached=false;
  other.writeMany=((writes,guards=[])=>{
    if(!reached && writes.some(row=>row.kind==='model-call' && (row.value as any).purpose==='reader')){
      reached=true;
      const reserved=concurrentWrite(writes,guards);
      assert.equal(other.get(counterId)!.revision,counter.revision+1);
      // Negative stale commit: use the exact batch prepared by the real runner.
      assert.throws(()=>write(guarded.writes,guarded.guards),{code:'input_stale'});
      assert.deepEqual(ownTurns(f.store),queue);assert.deepEqual(f.store.get(running.id),running);
      assert.deepEqual(f.store.list('reader-result'),[],'no partial output before the foreign reader applies');
      return reserved;
    }
    return concurrentWrite(writes,guards);
  }) as Store['writeMany'];
  try{await commonRead(f,other);}finally{other.writeMany=concurrentWrite;}
  assert.equal(reached,true);assert.equal(f.wires().length,3);
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  await f.run(2,f.open(),false);
  const completed=f.store.get<any>(f.failed.id)!;
  assert.equal(completed.value.status,'completed');assert.equal(completed.value.error,null);
  assert.equal(f.store.get<any>(running.id)!.value.state,'applied');
  for(const child of ownTurns(f.store))assert.deepEqual(readResearchConsumerTurn(f.open(),reference(child)),child);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.wires().length,3,'the already paid queued reader never calls again');
  const history=f.history();await f.run(2,f.open(),false);assert.deepEqual(f.history(),history);
});
