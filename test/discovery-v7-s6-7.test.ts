import { readV7ProgressStateAt } from '../src/discovery/v7-progress.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { readResearchConsumerTurn, readResearchAttemptBinding, listResearchConsumerIntents } from '../src/discovery/response-recovery.js';
import { projectSynthesisHandoffIntent } from '../src/discovery/research-consumer-transition.js';
import type { Write, TransactionGuard } from '../src/storage/store.js';
import { readSynthesisSessionV3 } from '../src/discovery/synthesis-session.js';
import { readerPilot } from '../src/discovery/reader-pilot.js';
import { discoveryFixture, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-v7-s6-7-");
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

async function setup(t: test.TestContext, questions = [planQuestion('support','market'), planQuestion('block','industry','blocking')], calibrated = true, planning = true) {
  const f=fixture(t);f.engine.execute({type:'create-project',project:'p',title:'P'});
  const wire=join(f.root,'wire.ndjson'), settings=join(f.root,'reply.json'), adapter=join(f.root,'adapter.mjs');
  const configure=(replies: unknown[]=[], tokens: number | null=10)=>writeFileSync(settings,JSON.stringify({replies,tokens}));
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
let previous=[];try{previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const position=previous.map(line=>JSON.parse(line)).filter(row=>row.subject?.dispatchMode!=='consolidation'&&!row.subject?.assessmentSubject).length;
let research=r.subject?.dispatchMode==='consolidation'
 ?{action:'checkpoint',question:r.subject.question.id,value:{summaries:r.subject.consolidation.notes.map((n,i)=>({notes:[i],text:'Finding '+i+' retains its exception and unresolved condition'})),citationIds:r.subject.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['New conflict remains open']}
 :s.replies[position]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
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
  let terminalConstraint: Ref | undefined;
  const finishFrontier=()=>{terminalConstraint??=reference(f.discovery.evidence.document('p','terminal-source','The requested source is unavailable','text/plain',0));writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings,'utf8')),terminalConstraint}));};
  const run=(limit=8,store=f.store, policy=true)=>new Researcher(store,new Discovery(store),new ProductEngine(store).environments)
    .run('p',v.draft.id,limit,undefined,policy?{producerPolicy:{discovery:7}}:{});
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const history=()=>f.store.list().map(row=>[row.id,row.revision,row.hash]);
  const commandForPilot = { executable: process.execPath, args: [adapter] };
  const enablePlanning = (maxRequestChars = 100000) => f.engine.execute({ type: 'configure-reader-pilot', project: 'p', expected: 0, settings: { experimental: true, active: true,
    stopAfter: 'L2', reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command: commandForPilot },
    agentCommand: commandForPilot, maxRequestChars: 100000, maxReadChars: 20000, maxReplyChars: 200000,
    maxCalls: 50, maxReportedTokens: 100000,
    v7Planning: { contract: 'v7-plan-planning/v1', maxRequestChars, maxRounds: 3 } } });
  if (planning) enablePlanning();
  return {...f,finishFrontier,v,questions,run,wires,history,configure,environment,calibrate,enablePlanning};
}

const ended=(type='impossible')=>({action:'answer',question:'$selected',value:{type,code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]});

const reads = [{action:'read_context',record:{id:'unused',revision:1,hash:'0'.repeat(64)},pointer:'/unused'}];
const toSynthesis={action:'synthesize',question:'$selected'};

function sessions(store:Store){return store.list<any>('synthesis-session');}

type Ready = Awaited<ReturnType<typeof setup>>;
const paid = (f:Ready) => ({calls:f.store.list('model-call'),ledger:f.store.list('research-budget-ledger'),wire:f.wires()});
const productHistory = (f:Ready) => f.store.list().map(row => f.store.history(row.id).map(reference));
const synthesisIntent = (f:Ready) => listResearchConsumerIntents(f.store,'p',f.v.draft.id).find(row=>row.value.kind==='synthesis')!;
function handoff(writes:Write[]) {
 return writes.some(row=>row.kind==='research-turn' && row.expected===0 && (row.value as any).dispatchMode==='synthesis');
}
function verifyDelivery(f:Ready, assessments=0) {
 const intent=synthesisIntent(f),session=readSynthesisSessionV3(f.open(),reference(sessions(f.store)[0]!));
 const turns=f.store.list<any>('research-turn').filter(row=>row.value.dispatchMode==='synthesis');
 assert.equal(turns.length,1);const turn=turns[0]!,original=f.store.get<any>(turn.id,1)!;
 assert.deepEqual(session.value.delivered,reference(original));
 assert.equal(intent.value.outputs!.filter(ref=>ref.id===turn.id).length,1);
 assert.deepEqual(original.value.consumerIntent,reference(f.store.get(intent.id,1)!));
 assert.deepEqual(session.value.delivery,{run:turn.value.run,turn:turn.value.number});
 assert.equal(intent.value.call!.revision,1);assert.ok(f.store.get(intent.value.call!.id,1));
 assert.deepEqual(readResearchConsumerTurn(f.open(),reference(turn)),turn);
 const binding=readResearchAttemptBinding(f.open(),'p',turn.id)!;assert.ok(binding);
 assert.deepEqual(binding.inputs.call,intent.value.call);
 assert.equal(f.store.list('research-attempt').length,1);
 assert.deepEqual(binding.attempt.value.call,intent.value.call);
 assert.equal(f.wires().filter(w=>!w.subject.assessmentSubject).length,2,'one planner and one synthesis call');
 assert.equal(f.wires().filter(w=>w.subject.dispatchMode==='planning').length,1);
 assert.equal(f.wires().filter(w=>w.subject.assessmentSubject).length,assessments);
 assert.equal(f.store.list('v7-progress-application').length,assessments);
 assert.equal(f.wires().length,2+assessments);
 for(const wire of f.wires().filter(w=>w.subject.assessmentSubject)) {
  assert.deepEqual(wire.subject.assessmentSubject.packet.planAnswer,f.v.planAnswer);
  assert.equal(wire.subject.assessmentSubject.packet.planQuestionId,'block');
 }
 for(const state of f.store.list('v7-progress-state'))readV7ProgressStateAt(f.open(),reference(state));
 return {intent,session,turn,original,binding};
}

const boundaries=['before-handoff','inside-handoff','after-handoff','before-attempt','after-attempt',
 'before-binding','inside-binding','after-binding'] as const;
for(const boundary of boundaries)
 test(`S6.7: ${boundary} cold continuation retains one atomic delivery and attempt`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);f.configure([toSynthesis,ended()]);
 const write=f.store.writeMany.bind(f.store);let cut=false;
 let pack:Write[]=[];let packGuards:TransactionGuard[]=[];
 f.store.writeMany=((writes,guards=[])=>{
  const isHandoff=handoff(writes);
  if(isHandoff){pack=structuredClone(writes);packGuards=structuredClone(guards);}
  const target=boundary.includes('handoff')?isHandoff:boundary.includes('attempt')
   ?writes.some(row=>row.kind==='research-attempt'):writes.some(row=>row.kind==='research-attempt-binding');
  if(cut || !target)return write(writes,guards);
  cut=true;
  if(boundary.startsWith('inside')) {
   const before=writes.map(row=>f.store.get(row.id));
   const failed=writes.map((row,index)=>index===writes.length-1?{...row,expected:row.expected+1}:row);
   assert.throws(()=>write(failed,guards),{code:'revision_conflict'});
   assert.deepEqual(writes.map(row=>f.store.get(row.id)),before,'the failure rolls back every earlier write in the transaction');
   throw new Error('S6.7 injected transaction failure');
  }
  if(boundary.startsWith('after'))write(writes,guards);
  throw new Error('S6.7 injected persistent interruption');
 }) as Store['writeMany'];
 try{await f.run(3);}finally{f.store.writeMany=write;}
 assert.equal(cut,true);assert.equal(f.wires().length,2);
 assert.deepEqual(pack.map(row=>row.kind),['research-run','research-turn','research-consumer-intent','synthesis-session']);
 assert.equal(pack.filter(row=>row.kind==='research-turn')[0]!.expected,0);
 for(const row of pack.filter(row=>row.kind!=='research-turn'))
  assert.ok(packGuards.some(ref=>!('absent' in ref)&&ref.id===row.id&&ref.revision===row.expected));
 const turnWrite=pack.find(row=>row.kind==='research-turn')!;
 assert.ok(packGuards.some(ref=>'absent' in ref&&ref.id===turnWrite.id));
 if(boundary==='before-handoff'||boundary==='inside-handoff'){
  assert.equal(f.store.list<any>('research-turn').filter(row=>row.value.dispatchMode==='synthesis').length,0);
  assert.equal(sessions(f.store)[0]!.value.delivered,null);
  assert.equal(synthesisIntent(f).value.outputs!.some(ref=>ref.id===turnWrite.id),false);
 }
 const before=paid(f),result=await f.run(3,f.open(),false);
 assert.equal(result.value.status,'paused',JSON.stringify(result.value));
 assert.equal(result.value.pauseCode,'research_assessment_pending');assert.deepEqual(paid(f),before);
 verifyDelivery(f);
 const fixed=productHistory(f);
 for(let repeat=0;repeat<2;repeat++){
  assert.deepEqual(await f.run(3,f.open(),false),result);
  assert.deepEqual(productHistory(f),fixed);assert.deepEqual(paid(f),before);
 }
});

test('S6.7: a lawfully re-prepared synthesis claims once and hands off its actual application revision',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);f.configure([toSynthesis,ended()]);
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{
  const rows=write(writes,guards);
  if(!cut&&writes.some(row=>row.kind==='research-consumer-intent'&&(row.value as any).kind==='synthesis'&&(row.value as any).state==='prepared')){
   cut=true;throw new Error('S6.7 interrupt unsent prepared synthesis');
  }
  return rows;
 }) as Store['writeMany'];
 f.finishFrontier();
 try{await f.run(3);}finally{f.store.writeMany=write;}
 assert.equal(cut,true);assert.equal(f.wires().length,1);
 const first=synthesisIntent(f);assert.equal(first.revision,1);
 const other=f.open(),pilot=readerPilot(other,'p')!,{projectId:_project,...settings}=pilot.value;
 new ProductEngine(other).execute({type:'configure-reader-pilot',project:'p',expected:pilot.revision,
  settings:{...settings,maxReplyChars:settings.maxReplyChars+1}});
 const result=await f.run(3,f.open());assert.equal(result.value.status,'completed',JSON.stringify(result.value));
 const saved=verifyDelivery(f,1),history=f.store.history<any>(first.id);
 assert.deepEqual(history.map(row=>row.value.state),['prepared','prepared','running','applied','applied']);
 assert.deepEqual(saved.intent.value.profile,reference(readerPilot(f.store,'p')!));
 const fixed=productHistory(f),before=paid(f);await f.run(3,f.open(),false);
 assert.deepEqual(productHistory(f),fixed);assert.deepEqual(paid(f),before);
});

test('S6.7: delivery projection refuses an absent basis, a foreign position and a second append',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);f.configure([toSynthesis,ended()]);
 f.finishFrontier();assert.equal((await f.run(3)).value.status,'completed');
 const {intent,original}=verifyDelivery(f,1);
 const applied=f.store.get<any>(intent.id,intent.revision-1)!,running=f.store.get<any>(intent.id,intent.revision-2)!;
 assert.deepEqual(projectSynthesisHandoffIntent(applied,running,reference(original)),intent.value);
 for(const change of [
  (v:any)=>{v.outputs=null;},(v:any)=>{v.call=null;},(v:any)=>{v.call.revision=2;},
  (v:any)=>{delete v.cursor.delivery;},(v:any)=>{v.cursor.delivery.turn++;}
 ]){
  const value=structuredClone(applied.value);change(value);
  assert.throws(()=>projectSynthesisHandoffIntent({...applied,value},running,reference(original)),{code:'research_consumer_intent_invalid'});
 }
 assert.throws(()=>projectSynthesisHandoffIntent(intent,applied,reference(original)),{code:'research_consumer_intent_invalid'});
 const fixed=productHistory(f);await f.run(3,f.open(),false);assert.deepEqual(productHistory(f),fixed);
});
