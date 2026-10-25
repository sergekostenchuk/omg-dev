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
import { readResearchConsumerTurn, listResearchConsumerIntents } from '../src/discovery/response-recovery.js';
import { synthesisSession, readSynthesisSessionV3 } from '../src/discovery/synthesis-session.js';
import { planOwnerSubject } from '../src/discovery/v7-plan-questions.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';
import { readerPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { configureV7SavedSynthesis } from '../src/discovery/saved-synthesis.js';
import { exactContextLookup } from '../src/discovery/research-consumer-transition.js';
import { discoveryFixture, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-v7-s6-8-");
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
const position=previous.map(line=>JSON.parse(line)).filter(row=>row.subject?.dispatchMode!=='consolidation'&&!row.subject.assessmentSubject).length;
let research=r.subject?.dispatchMode==='consolidation'
 ?{action:'checkpoint',question:r.subject.question.id,value:{summaries:r.subject.consolidation.notes.map((n,i)=>({notes:[i],text:'Finding '+i+' retains its exception and unresolved condition'})),citationIds:r.subject.consolidation.citations.map((_,i)=>i)},citations:[],unresolved:['New conflict remains open']}
 :s.replies[position]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=r.subject.question.id;
if(s.terminalConstraint&&research.action==='answer')research.value.evidence=[s.terminalConstraint];
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 research={verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected:[],newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
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


type Ready=Awaited<ReturnType<typeof setup>>;
const snapshot=(f:Ready)=>({calls:f.store.list('model-call'),ledger:f.store.list('research-budget-ledger'),wire:f.wires()});
const history=(f:Ready)=>f.store.list().map(row=>f.store.history(row.id).map(reference));
function proveAssessments(f:Ready, subjects:string[]) {
 const requests=f.wires().filter(row=>row.subject.assessmentSubject);
 assert.deepEqual(requests.map(row=>row.subject.assessmentSubject.packet.planQuestionId),subjects);
 assert.equal(f.store.list('v7-progress-application').length,subjects.length);
 for(const request of requests){
  const packet=request.subject.assessmentSubject.packet;
  assert.deepEqual(packet.planAnswer,f.v.planAnswer);
  assert.deepEqual(packet.entries.map((entry:any)=>entry.attempt),f.store.list<any>('research-attempt')
   .filter(row=>row.value.planQuestionId===packet.planQuestionId).map(reference));
  const state=f.store.list<any>('v7-progress-state').find(row=>row.value.subject.planQuestionId===packet.planQuestionId)!;
  assert.ok(state);const proof=readV7ProgressStateAt(f.open(),reference(state));
  assert.deepEqual(proof.value.subject.planAnswer,f.v.planAnswer);assert.equal(proof.value.summary.count,packet.entries.length);
 }
}
const verdict=(necessary:boolean)=>({necessary,reason:necessary?'Only the owner can choose this jurisdiction':'The cited source already answers this subject'});
function scenario(f:Ready,necessary:boolean) {
 const source=f.discovery.evidence.document('p','jurisdiction','Only the owner can select a jurisdiction for this subject.','text/plain',0);
 const sourceRef=reference(source);
 f.configure([{action:'read_plan',question:'$selected',reads:[{action:'read_source',source:sourceRef,start:0,end:source.value.content.length}]},
  {action:'need_owner',question:'$selected',reason:'Choose the jurisdiction of this exact plan subject',searched:[sourceRef]},verdict(necessary),ended()]);
 return sourceRef;
}
function proveOwner(f:Ready,necessary:boolean,source:Ref) {
 const owner=f.store.list<any>('research-turn').find(turn=>turn.value.action?.action==='need_owner')!;
 assert.ok(owner);assert.equal(owner.value.status,'completed');assert.deepEqual(owner.value.observation,verdict(necessary));
 assert.deepEqual(owner.value.subject,{contract:'v7-plan-subject/v1',planAnswer:f.v.planAnswer,planQuestionId:'block'});
 assert.equal(owner.value.action.question,'block');assert.equal(owner.value.question.id,f.v.plan.id);
 const producer=f.store.get<any>(owner.value.consumerIntent.id,1)!;assert.equal(producer.value.kind,'synthesis');
 const session=readSynthesisSessionV3(f.open(),reference(f.store.get(producer.value.owner.id)!));
 assert.deepEqual(session.value.delivered,reference(f.store.get(owner.id,1)!));
 const reviews=listResearchConsumerIntents(f.store,'p',f.v.draft.id).filter(intent=>intent.value.kind==='escalation-assessor');
 assert.equal(reviews.length,1);assert.equal(reviews[0]!.value.state,'applied');
 const request=f.wires().find(row=>row.subject?.role==='assess-escalation');assert.ok(request);
 assert.deepEqual(request.subject.subject,owner.value.subject);
 assert.deepEqual(request.subject.request.subject,owner.value.subject);
 assert.equal(request.subject.request.question,'block');assert.equal(request.subject.request.planQuestion.id,'block');
 assert.equal(request.subject.question.field,'plan');assert.deepEqual(owner.value.action.searched,[source]);
 for(const turn of f.store.list<any>('research-turn'))assert.deepEqual(readResearchConsumerTurn(f.open(),reference(turn)),turn);
 return owner;
}
function cutPaidReview(f:Ready) {
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{
  const rows=write(writes,guards);
  if(!cut&&writes.some(row=>row.kind==='model-call'&&(row.value as any).purpose==='escalation-assessor'&&(row.value as any).status==='succeeded')){
   cut=true;throw new Error('S6.8 stop after paid reviewer receipt');
  }
  return rows;
 }) as Store['writeMany'];
 return ()=>{f.store.writeMany=write;assert.equal(cut,true);};
}
function edition(f:Ready) {
 const plan=f.store.get<Question>(f.v.plan.id)!;f.discovery.reopen(plan.id,plan.revision);
 const basis=f.discovery.evidence.document('p','next-plan','Another accepted plan edition.','text/plain',0);
 answerDiscoveryFixture(f.engine,'p',f.store.get<DiscoveryDraft>(f.v.draft.id)!,f.store.get<Question>(plan.id)!,
  validPlan(f.v.frameRef,[planQuestion('block','industry','blocking')],2,f.v.planAnswer),basis);
 return f.store.get<Question>(plan.id)!.value.answer!;
}
for(const necessary of [true,false])
 test(`S6.8: synthesis need_owner uses the logical subject and the real ${necessary?'necessary':'unnecessary'} review`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]),source=scenario(f,necessary);
 if(!necessary)f.finishFrontier();const result=await f.run(3);assert.equal(result.value.status,necessary?'needs_owner':'paused',JSON.stringify(result.value));
 if(!necessary)assert.equal(result.value.pauseCode,'research_turns_exhausted');
 const reviewed=proveOwner(f,necessary,source);assert.equal(f.wires().length,necessary?3:5);
 proveAssessments(f,necessary?[]:['block']);
 assert.equal(f.wires().filter(row=>!row.subject.assessmentSubject).length,necessary?3:4);
 if(!necessary){
  const continuation=f.wires()[3].subject;
  assert.deepEqual(continuation.previousProposalRef,reference(reviewed));
  const archive=f.store.get(continuation.working.archive.id,continuation.working.archive.revision)!;
  assert.deepEqual(reference(archive),continuation.working.archive);
  const body=readArchiveBody(f.open(),archive).body;
  assert.deepEqual(body.previousProposal,reviewed.value.action);
  assert.ok(body.history.some((row:any)=>row.action?.action==='need_owner'&&row.observation?.necessary===false));
  assert.ok(continuation.working.sections.some((section:any)=>section.pointer==='/body/history'));
  assert.ok(f.store.list<any>('synthesis-session').some(row=>row.value.basis.previousProposalRef?.id===reviewed.id
   && row.value.basis.previousProposalRef.revision===reviewed.revision));
 }
 assert.equal(f.store.list('research-attempt').length,necessary?0:1);
 assert.deepEqual(result.value.ownerQuestion,necessary?{question:'block',reason:verdict(true).reason,searched:[source]}:null);
 assert.deepEqual(reference(f.store.get(f.v.plan.id)!),reference(f.v.plan),'the already answered plan anchor is unchanged');
 if(necessary)assert.deepEqual(planOwnerSubject(f.open(),result),{subject:{contract:'v7-plan-subject/v1',planAnswer:f.v.planAnswer,planQuestionId:'block'},question:f.store.list<any>('research-turn').find(row=>row.value.action?.action==='need_owner')!.value.question});
 const before=snapshot(f),fixed=history(f);
 for(let repeat=0;repeat<2;repeat++){
  assert.deepEqual(await f.run(1,f.open(),false),result);assert.deepEqual(history(f),fixed);assert.deepEqual(snapshot(f),before);
 }
});
for(const necessary of [true,false])
 test(`S6.8: cold paid ${necessary?'necessary':'unnecessary'} review completes the synthesis turn before a new send`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]),source=scenario(f,necessary),restore=cutPaidReview(f);
 try{await f.run(3);}finally{restore();}
 assert.equal(f.wires().length,3);assert.equal(f.store.list('research-attempt').length,0);
 const before=snapshot(f),result=await f.run(1,f.open(),false);
 assert.equal(result.value.status,necessary?'needs_owner':'paused',JSON.stringify(result.value));
 if(!necessary)assert.equal(result.value.pauseCode,'research_contract_upgrade_required');
 proveOwner(f,necessary,source);assert.deepEqual(snapshot(f),before);assert.equal(f.store.list('research-attempt').length,0);
 const fixed=history(f);
 for(let repeat=0;repeat<2;repeat++){
  assert.deepEqual(await f.run(1,f.open(),false),result);assert.deepEqual(history(f),fixed);assert.deepEqual(snapshot(f),before);
 }
});
for(const necessary of [true,false])
 test(`S6.8: an old edition's paid ${necessary?'necessary':'unnecessary'} review keeps its exact subject after a new plan`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]),source=scenario(f,necessary),restore=cutPaidReview(f);
 try{await f.run(3);}finally{restore();}
 const next=edition(f);assert.notDeepEqual(next,f.v.planAnswer);
 const before=snapshot(f),result=await f.run(1,f.open(),false);
 assert.equal(result.value.status,necessary?'needs_owner':'paused',JSON.stringify(result.value));
 if(!necessary)assert.equal(result.value.pauseCode,'research_contract_upgrade_required');
 proveOwner(f,necessary,source);assert.deepEqual(snapshot(f),before);assert.equal(f.store.list('research-attempt').length,0);
 if(necessary)assert.deepEqual(planOwnerSubject(f.open(),result).subject,{contract:'v7-plan-subject/v1',planAnswer:f.v.planAnswer,planQuestionId:'block'});
 const fixed=history(f);assert.deepEqual(await f.run(1,f.open(),false),result);assert.deepEqual(history(f),fixed);assert.deepEqual(snapshot(f),before);
});
test('S6.8: another subject read cannot authorize a synthesis owner review',async t=>{
 const f=await setup(t,[planQuestion('a','industry','blocking'),planQuestion('block','market','blocking')]);
 const source=f.discovery.evidence.document('p','other-subject','A source only A has consulted.','text/plain',0),ref=reference(source);
 f.configure([{action:'read_plan',question:'$selected',reads:[{action:'read_source',source:ref,start:0,end:source.value.content.length}]},
  ended(),{action:'synthesize',question:'$selected'},
  {action:'need_owner',question:'$selected',reason:'Try using A history for B',searched:[ref]}]);
 f.finishFrontier();const result=await f.run(8);assert.equal(result.value.status,'paused');assert.equal(result.value.pauseCode,'owner_escalation_premature',JSON.stringify(result.value));
 assert.equal(f.wires().length,5);assert.equal(f.wires().filter(row=>!row.subject.assessmentSubject).length,4);proveAssessments(f,['a']);assert.equal(listResearchConsumerIntents(f.store,'p',f.v.draft.id).some(row=>row.value.kind==='escalation-assessor'),false);
 const before=snapshot(f);await f.run(1,f.open(),false);assert.deepEqual(snapshot(f),before);
});

test('S6.8: a prepared owner review of an old plan cannot buy the new edition',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);scenario(f,true);
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{const rows=write(writes,guards);
  if(!cut&&writes.some(row=>row.kind==='research-consumer-intent'&&(row.value as any).kind==='escalation-assessor'&&(row.value as any).state==='prepared')){
   cut=true;throw new Error('S6.8 cut before reviewer reservation');
  }return rows;}) as Store['writeMany'];
 try{await f.run(3);}finally{f.store.writeMany=write;}
 assert.equal(cut,true);assert.equal(f.wires().length,2);edition(f);
 const before=snapshot(f),result=await f.run(1,f.open());
 assert.equal(result.value.pauseCode,'research_consumer_context_stale',JSON.stringify(result.value));
 assert.deepEqual(snapshot(f),before);assert.equal(f.store.list('research-attempt').length,0);
});

test('S6.8: a second Store changing the plan before paid review application conflicts atomically and cold recovery applies once',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]),source=scenario(f,true),restore=cutPaidReview(f);
 try{await f.run(3);}finally{restore();}
 const before=snapshot(f),write=f.store.writeMany.bind(f.store);let raced=false;
 f.store.writeMany=((writes,guards=[])=>{
  if(!raced&&writes.some(row=>row.kind==='research-consumer-intent'&&(row.value as any).kind==='escalation-assessor'&&(row.value as any).state==='applied')){
   raced=true;const other=f.open();edition({...f,store:other,discovery:new Discovery(other),engine:new ProductEngine(other)});
  }
  return write(writes,guards);
 }) as Store['writeMany'];
 let paused;
 try{paused=await f.run(1,f.store,false);}finally{f.store.writeMany=write;}
 assert.equal(raced,true);assert.equal(paused.value.pauseCode,'input_stale',JSON.stringify(paused.value));
 const review=listResearchConsumerIntents(f.store,'p',f.v.draft.id).find(row=>row.value.kind==='escalation-assessor')!;
 assert.equal(review.value.state,'running');
 assert.equal(f.store.list<any>('research-turn').find(row=>row.value.action?.action==='need_owner')!.value.status,'pending');
 assert.equal(f.store.list('research-attempt').length,0);assert.deepEqual(snapshot(f),before);
 const result=await f.run(1,f.open(),false);assert.equal(result.value.status,'needs_owner',JSON.stringify(result.value));
 proveOwner(f,true,source);assert.deepEqual(snapshot(f),before);
 const fixed=history(f);assert.deepEqual(await f.run(1,f.open(),false),result);assert.deepEqual(history(f),fixed);
});

for (const cutSession of [false,true])
 test(`S6.8-01: saved-only retains its paid negative review${cutSession?' after a session-only interruption':''}`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 const pieces=['a','b'].map(name=>{
  const source=f.discovery.evidence.document('p','note-'+name,'A condition and its exception '+name,'text/plain',0);
  return {kind:'context',value:f.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:source.value.content.length})};
 });
 const subject={contract:'v7-plan-subject/v1' as const,planAnswer:f.v.planAnswer,planQuestionId:'block'};
 const pilot=readerPilot(f.store,'p')!;
 f.configure([{action:'checkpoint',question:'$selected',value:{finding:'A finding with its exception'},
  citations:[{source:pieces[0]!.value.source,selector:pieces[0]!.value.selector}],unresolved:[]},ended()]);
 assert.equal((await synthesisSession(f.store,f.v.draft,f.v.plan,f.environment,pilotEnvironment(f.environment.value,pilot.value),pilot,
  {role:'research',stage:'discovery',subject,workingSelections:pieces,inventory:{sources:[]},history:[]},'Synthesize',undefined,{})).action,'answer');
 const notes=f.store.list('research-checkpoint');assert.equal(notes.length,1);
 const prior=f.wires().length,source=scenario(f,false);
 const config=JSON.parse(readFileSync(join(f.root,'reply.json'),'utf8'));
 f.configure([...Array.from({length:prior},()=>ended()),...config.replies]);
 const restore=cutPaidReview(f);
 try{await f.run(3);}finally{restore();}
 const reviewCalls=f.store.list<any>('model-call').filter(row=>row.value.purpose==='escalation-assessor').map(reference);
 const choice=configureV7SavedSynthesis(f.store,'p',subject,0);f.finishFrontier();
 assert.deepEqual(choice.value.subject,subject);assert.deepEqual(choice.value.checkpoints,notes.map(reference));
 const before=snapshot(f),write=f.store.writeMany.bind(f.store);let interrupted=false;
 if(cutSession)f.store.writeMany=((writes,guards=[])=>{
  const rows=write(writes,guards);
  if(!interrupted&&writes.some(row=>row.kind==='synthesis-session'&&row.expected===0
   &&(row.value as any).basis.previousProposalRef)){
   interrupted=true;throw new Error('S6.8 stop after saved-only session before its first intent');
  }
  return rows;
 }) as Store['writeMany'];
 let result;
 try{result=await f.run(4);}finally{f.store.writeMany=write;}
 if(cutSession){
  assert.equal(interrupted,true);assert.equal(result.value.pauseCode,'research_interrupted',JSON.stringify(result.value));
  assert.deepEqual(snapshot(f),before);
  result=await f.run(4,f.open());
 }
 assert.equal(result.value.status,'paused',JSON.stringify(result.value));assert.equal(result.value.pauseCode,'project_mode_unset');
 const reviewed=proveOwner(f,false,source);
 assert.deepEqual(reviewed.value.subject,subject);
 const requests=f.wires().slice(before.wire.length);
 assert.equal(requests.length,2);const sends=requests.filter(row=>!row.subject.assessmentSubject);
 assert.equal(sends.length,1);proveAssessments(f,['block']);const request=sends[0]!.subject;
 assert.equal(request.dispatchMode,'synthesis');assert.deepEqual(request.previousProposalRef,reference(reviewed));
 const archive=request.working.archive;
 const body=readArchiveBody(f.open(),f.store.get(archive.id,archive.revision)!).body;
 if(!cutSession)assert.equal(body.savedOnly,true);
 assert.deepEqual(body.savedMaterials.map((piece:any)=>piece.value.checkpoint),choice.value.checkpoints);
 assert.deepEqual(body.subject,subject);
 assert.deepEqual(body.history,[{...reviewed.value,ref:reference(reviewed)}]);
 const lookup=exactContextLookup(f.open(),f.v.draft,f.v.plan,archive,'/body/history/0',undefined,()=>assert.fail('Review context is not a reader-result'));
 assert.deepEqual(lookup.value,{...reviewed.value,ref:reference(reviewed)});
 assert.deepEqual((lookup.value as any).observation,verdict(false));
 assert.ok(request.working.sections.some((section:any)=>section.pointer==='/body/history'));
 assert.deepEqual(f.store.list<any>('model-call').filter(row=>row.value.purpose==='escalation-assessor').map(reference),reviewCalls);
 assert.equal(f.store.list('model-call').length,before.calls.length+2);
 const fixed=history(f),paid=snapshot(f);
 assert.deepEqual(await f.run(1,f.open(),false),result);assert.deepEqual(history(f),fixed);assert.deepEqual(snapshot(f),paid);
});
