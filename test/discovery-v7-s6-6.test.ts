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
import { synthesisSession, readSynthesisSessionV3 } from '../src/discovery/synthesis-session.js';
import { pilotEnvironment, readerPilot } from '../src/discovery/reader-pilot.js';
import { configureV7SavedSynthesis } from '../src/discovery/saved-synthesis.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-v7-s6-6-"));
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
const heads=(f:Awaited<ReturnType<typeof setup>>)=>({calls:f.store.list('model-call'),ledger:f.store.list('research-budget-ledger')});

for(const boundary of ['session','prepared','paid','applied'] as const)
 test(`S6.6: cold runner resumes its exact v3 ${boundary} before any new planner`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);f.configure([toSynthesis,ended()]);
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
   const found=writes.some(row=> boundary==='session' ? row.kind==='synthesis-session' && row.expected===0
    :boundary==='paid' ? row.kind==='model-call' && (row.value as any).status==='succeeded' && (row.value as any).purpose==='analyst'
    :row.kind==='research-consumer-intent' && (row.value as any).kind==='synthesis' && (row.value as any).state===boundary);
   if(!cut && found){cut=true;write(writes,guards);throw new Error(`S6.6 cut after ${boundary}`);}
   return write(writes,guards);
  }) as Store['writeMany'];
  f.finishFrontier();try{await f.run(3);}finally{f.store.writeMany=write;}
  assert.equal(cut,true);assert.equal(sessions(f.store).length,1);
  const original=sessions(f.store)[0]!;
  const callsBefore=f.wires().length;
  const result=await f.run(3,f.open(),boundary!=='paid' && boundary!=='applied');
  const admitted=boundary==='session'||boundary==='prepared';
  assert.equal(result.value.status,admitted?'completed':'paused',JSON.stringify(result.value));
  assert.equal(result.value.pauseCode,admitted?null:'research_assessment_pending');
  assert.equal(sessions(f.store).length,1);assert.equal(sessions(f.store)[0]!.id,original.id);
  assert.equal(f.wires().filter(w=>!w.subject.assessmentSubject).length,2);
  assert.equal(f.wires().filter(w=>w.subject.assessmentSubject).length,admitted?1:0);assert.equal(callsBefore,boundary==='paid'||boundary==='applied'?2:1);
  assert.equal(f.wires().filter(row=>row.subject.dispatchMode==='planning').length,1);
  assert.equal(f.store.list('research-attempt').length,1);
  for(const turn of f.store.list<any>('research-turn'))assert.deepEqual(readResearchConsumerTurn(f.open(),reference(turn)),turn);
  const history=f.history(),paid=heads(f);await f.run(3,f.open(),false);
  assert.deepEqual(f.history(),history);assert.deepEqual(heads(f),paid);assert.equal(f.wires().length,admitted?3:2);
 });


type Ready = Awaited<ReturnType<typeof setup>>;
const subjectOf = (f: Ready, id = 'block') => ({contract:'v7-plan-subject/v1', planAnswer:f.v.planAnswer,planQuestionId:id});
function nextEdition(f: Ready) {
 const plan=f.store.get<Question>(f.v.plan.id)!;f.discovery.reopen(plan.id,plan.revision);
 const source=f.discovery.evidence.document('p','next-edition','Second accepted plan basis','text/plain',0);
 answerDiscoveryFixture(f.engine,'p',f.store.get<DiscoveryDraft>(f.v.draft.id)!,f.store.get<Question>(plan.id)!,
  validPlan(f.v.frameRef,[planQuestion('block','industry','blocking')],2,f.v.planAnswer),source);
 return f.store.get<Question>(plan.id)!.value.answer!;
}
function cutAfter(f:Ready, predicate:(row:any)=>boolean) {
 const write=f.store.writeMany.bind(f.store);let cut=false;
 f.store.writeMany=((writes,guards=[])=>{const rows=write(writes,guards);
  if(!cut && writes.some(predicate)){cut=true;throw new Error('S6.6 persistent cut');}return rows;}) as Store['writeMany'];
 return ()=>{f.store.writeMany=write;assert.equal(cut,true);};
}
function direct(f:Ready,id='block',materials:unknown[]=[],options:Parameters<typeof synthesisSession>[9]={}) {
 const pilot=readerPilot(f.store,'p')!;
 return synthesisSession(f.store,f.v.draft,f.v.plan,f.environment,pilotEnvironment(f.environment.value,pilot.value),pilot,
  {role:'research',stage:'discovery',subject:subjectOf(f,id),workingSelections:materials,inventory:{sources:[]},history:[]},
  'Synthesize this exact plan question',undefined,options);
}
function material(f:Ready,name:string,large=false){
 const source=f.discovery.evidence.document('p',name,`Material ${name}: a condition and its exception. `+(large?'detail '.repeat(16000):''),'text/plain',0);
 return {kind:'context',value:f.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:source.value.content.length})};
}
const checkpoint=(piece:ReturnType<typeof material>,text='A finding with its exception')=>({action:'checkpoint',question:'$selected',value:{finding:text},
 citations:[{source:piece.value.source,selector:piece.value.selector}],unresolved:[]});
const snapshot=(f:Ready)=>({history:f.history(),paid:heads(f),wire:f.wires()});

for(const boundary of ['prepared','paid','applied'] as const)
 test(`S6.6: ${boundary} old edition keeps its own history and cannot buy work of the new edition`,async t=>{
  const f=await setup(t,[planQuestion('block','industry','blocking')]);f.configure([toSynthesis,ended()]);
  const restore=cutAfter(f,row=>boundary==='paid'?row.kind==='model-call' && row.value.status==='succeeded' && row.value.purpose==='analyst'
   :row.kind==='research-consumer-intent' && row.value.kind==='synthesis' && row.value.state===boundary);
  await f.run(3);restore();const original=sessions(f.store)[0]!,next=nextEdition(f),before=heads(f),count=f.wires().length;
  const resumed=await f.run(3,f.open());
  assert.equal(resumed.value.status,'paused');
  assert.equal(resumed.value.pauseCode,boundary==='prepared'?'research_plan_subject_invalid':'attempt_invalid',JSON.stringify(resumed.value));
  assert.deepEqual(heads(f),before);assert.equal(f.wires().length,count);
  const proven=readSynthesisSessionV3(f.open(),reference(sessions(f.store)[0]!));
  assert.deepEqual(proven.value.binding.subject,subjectOf(f));assert.notDeepEqual(proven.value.binding.subject.planAnswer,next);
  assert.equal(proven.id,original.id);assert.equal(proven.value.result!==null,boundary!=='prepared');
  if(boundary!=='prepared')for(const turn of f.store.list<any>('research-turn'))readResearchConsumerTurn(f.open(),reference(turn));
 });

test('S6.6: paid lookup applies in restore-only; the next synthesis send requires explicit current admission',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 f.configure([toSynthesis,{action:'read_context',record:reference(f.v.draft),pointer:'/stage',purpose:'Exact stage'},ended()]);
 const restore=cutAfter(f,row=>row.kind==='model-call' && row.value.status==='succeeded' && row.value.purpose==='analyst');
 await f.run(3);restore();const before=heads(f),count=f.wires().length;
 const restored=await f.run(3,f.open(),false);
 assert.equal(restored.value.pauseCode,'research_restore_complete',JSON.stringify(restored.value));
 assert.deepEqual(heads(f),before);assert.equal(f.wires().length,count);
 const session=readSynthesisSessionV3(f.open(),reference(sessions(f.store)[0]!));
 assert.ok(session.value.workspace?.entries.length);assert.equal(session.value.result,null);
 const fixed = snapshot(f);
 for (let repeat = 0; repeat < 2; repeat++) {
  assert.deepEqual(await f.run(3,f.open(),false),restored);
  assert.deepEqual(snapshot(f),fixed,'second and third restore-only entries preserve complete history and payment');
 }
 f.finishFrontier();const resumed=await f.run(3,f.open());assert.equal(resumed.value.status,'completed',JSON.stringify(resumed.value));
 assert.equal(f.wires().filter(w=>!w.subject.assessmentSubject).length,count+1);
 assert.equal(f.wires().filter(w=>w.subject.assessmentSubject).length,1);assert.equal(f.wires().filter(row=>row.subject.dispatchMode==='planning').length,1);
});

test('S6.6: two real unreserved subject sessions refuse ambiguity before any new dispatch',async t=>{
 const f=await setup(t);f.configure([ended()]);
 for(const id of ['support','block']) {
  const restore=cutAfter(f,row=>row.kind==='research-consumer-intent' && row.value.kind==='synthesis' && row.value.state==='prepared');
  await assert.rejects(direct(f,id),/persistent cut/);restore();
 }
 const before=snapshot(f);
 await assert.rejects(f.run(3,f.open()),{code:'research_synthesis_ambiguous'});
 assert.deepEqual(snapshot(f),before);assert.equal(sessions(f.store).length,2);
 for(const session of sessions(f.store))readSynthesisSessionV3(f.open(),reference(session));
});

test('S6.6: a proven reserved v3 position refuses a competing real unfinished planner',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 const stopPlanner=cutAfter(f,row=>row.kind==='research-consumer-intent' && row.value.kind==='reading-planner' && row.value.state==='prepared');
 await f.run(3);stopPlanner();
 const run=f.store.list<any>('research-run')[0]!,number=run.value.turns+1;
 const restore=cutAfter(f,row=>row.kind==='synthesis-session' && row.expected===0);
 await assert.rejects(direct(f,'block',[],{delivery:{run:run.id,turn:number},reserve:{write:{id:run.id,kind:run.kind,expected:run.revision,
  value:{...run.value,turns:number}},guards:[reference(run)]}}),/persistent cut/);restore();
 const before=snapshot(f),result=await f.run(3,f.open());
 assert.equal(result.value.pauseCode,'research_consumer_intent_invalid',JSON.stringify(result.value));
 assert.deepEqual(heads(f),before.paid);assert.deepEqual(f.wires(),before.wire);
});

test('S6.6: saved-only uses the exact subject notes without asking a new planner',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);const first=material(f,'one'),second=material(f,'two');
 f.configure([checkpoint(first),ended(),ended()]);
 assert.equal((await direct(f,'block',[first,second])).action,'answer');
 configureV7SavedSynthesis(f.store,'p',subjectOf(f),0);const count=f.wires().length;
 const unadmitted=snapshot(f);
 await assert.rejects(f.run(3,f.open(),false),{code:'research_contract_upgrade_required'});
 assert.deepEqual(snapshot(f),unadmitted);
 f.finishFrontier();const result=await f.run(3,f.open());
 assert.equal(result.value.status,'completed',JSON.stringify(result.value));assert.equal(f.wires().filter(w=>!w.subject.assessmentSubject).length,count+1);
 assert.equal(f.wires().filter(w=>w.subject.assessmentSubject).length,1);
 assert.equal(f.wires().some(row=>row.subject.dispatchMode==='planning'),false);
 for(const session of sessions(f.store))readSynthesisSessionV3(f.open(),reference(session));
 const before=snapshot(f);await f.run(3,f.open(),false);assert.deepEqual(snapshot(f),before);
});


for(const boundary of ['reservation','paid'] as const)
 test(`S6.6: ${boundary} after a delivered pause resumes with the earlier delivery mark intact`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);f.configure([toSynthesis,{action:'pause',reason:'Explicit saved pause'},ended()]);
 const first=await f.run(3);assert.equal(first.value.pauseCode,'research_model_paused',JSON.stringify(first.value));
 const session=sessions(f.store)[0]!;assert.ok(session.value.delivered);
 const restore=cutAfter(f,row=>boundary==='reservation'
  ?row.kind==='synthesis-session' && row.value.delivery?.turn===first.value.turns+1
  :row.kind==='model-call' && row.value.status==='succeeded' && row.value.purpose==='analyst');
 await f.run(3,f.store);restore();
 const reserved=sessions(f.store)[0]!;assert.deepEqual(reserved.value.delivered,session.value.delivered);
 assert.equal(reserved.value.delivery.turn,first.value.turns+1);const calls=f.wires().length;
 f.finishFrontier();const result=await f.run(3,f.open(),boundary!=='paid');
 assert.equal(result.value.status,boundary==='paid'?'paused':'completed',JSON.stringify(result.value));
 assert.equal(result.value.pauseCode,boundary==='paid'?'research_assessment_pending':null);
 assert.equal(f.wires().filter(w=>!w.subject.assessmentSubject).length,calls+(boundary==='paid'?0:1));
 assert.equal(f.wires().filter(w=>w.subject.assessmentSubject).length,boundary==='paid'?0:1);assert.equal(f.wires().filter(row=>row.subject.dispatchMode==='planning').length,1);
 readSynthesisSessionV3(f.open(),reference(sessions(f.store)[0]!));
});

function updatePilot(f:Ready, patch:Record<string,unknown>){
 const pilot=readerPilot(f.store,'p')!,{projectId:_project,...settings}=pilot.value;
 f.engine.execute({type:'configure-reader-pilot',project:'p',expected:pilot.revision,settings:{...settings,...patch}});
}

test('S6.6: a real paid consolidation resumes in restore-only before another synthesis call or planner',async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 f.configure([{action:'pause',reason:'Before synthesis reservation'}]);
 const run=await f.run(1);assert.equal(run.value.pauseCode,'research_model_paused');
 updatePilot(f,{maxRequestChars:200000});
 const pieces=[material(f,'one',true),material(f,'two',true),material(f,'three')];
 f.configure([{action:'pause',reason:'Before synthesis reservation'},checkpoint(pieces[0]!,'x'.repeat(30000)),
  checkpoint(pieces[1]!,'y'.repeat(30000)),{action:'pause',reason:'Before measured profile'},ended()]);
 await direct(f,'block',pieces,{delivery:{run:run.id,turn:run.value.turns+1},reserve:{write:{id:run.id,kind:run.kind,expected:run.revision,
  value:{...run.value,turns:run.value.turns+1}},guards:[reference(run)]}});
 const pause=await f.run(3,f.open());assert.equal(pause.value.pauseCode,'research_model_paused',JSON.stringify(pause.value));
 updatePilot(f,{maxRequestChars:60000,conclusionShare:0.35});
 const restore=cutAfter(f,row=>row.kind==='model-call' && row.value.status==='succeeded' && f.store.get<any>(row.value.consumerIntent?.id)?.value.kind==='consolidation');
 await f.run(3);restore();const paid=heads(f),calls=f.wires().length;
 assert.equal(f.wires().filter(row=>row.subject.dispatchMode==='consolidation').length,1);
 const restored=await f.run(3,f.open(),false);
 assert.equal(restored.value.pauseCode,'research_restore_complete',JSON.stringify(restored.value));
 assert.deepEqual(heads(f),paid);assert.equal(f.wires().length,calls);
 const session=readSynthesisSessionV3(f.open(),reference(sessions(f.store)[0]!));assert.ok(session.value.notes.some(note=>note.consolidated));
 f.finishFrontier();const completed=await f.run(3,f.open());assert.equal(completed.value.status,'completed',JSON.stringify(completed.value));
 assert.equal(f.wires().filter(w=>!w.subject.assessmentSubject).length,calls+1);
 assert.equal(f.wires().filter(w=>w.subject.assessmentSubject).length,1);assert.equal(f.wires().filter(row=>row.subject.dispatchMode==='planning').length,1);
 for(const turn of f.store.list<any>('research-turn'))readResearchConsumerTurn(f.open(),reference(turn));
 const before=snapshot(f);await f.run(3,f.open(),false);assert.deepEqual(snapshot(f),before);
});


for (const terminal of [true, false])
 test(`S6.6-01: disabling pilot preserves a paid ${terminal ? 'terminal' : 'lookup'} and admits no new send`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);
 const lookup={action:'read_context',record:reference(f.v.draft),pointer:'/stage',purpose:'Exact stage'};
 f.configure([toSynthesis,terminal?ended():lookup,ended()]);
 const restore=cutAfter(f,row=>row.kind==='model-call' && row.value.status==='succeeded' && row.value.purpose==='analyst');
 await f.run(3);restore();
 const other=f.open(),pilot=readerPilot(other,'p')!,{projectId:_project,...settings}=pilot.value;
 new ProductEngine(other).execute({type:'configure-reader-pilot',project:'p',expected:pilot.revision,settings:{...settings,active:false}});
 const cold=f.open(),write=cold.writeMany.bind(cold);let stale=0;
 cold.writeMany=((writes,guards=[])=>{
  try{return write(writes,guards);}catch(error){
   if ((error as {code?:string}).code==='input_stale' && ++stale>=3)
    throw new Error('Three stale applications of the same paid response');
   throw error;
  }
 }) as Store['writeMany'];
 const before=heads(f),calls=f.wires().length,result=await f.run(3,cold,false);
 assert.equal(stale,0);assert.deepEqual(heads(f),before);assert.equal(f.wires().length,calls);
 assert.equal(result.value.status,'paused',JSON.stringify(result.value));
 if(terminal)assert.equal(result.value.pauseCode,'research_assessment_pending');
 if (!terminal) {
  assert.equal(result.value.pauseCode,'research_restore_complete');
  const refused=await f.run(3,f.open());
  assert.equal(refused.value.pauseCode,'reader_pilot_required',JSON.stringify(refused.value));
  assert.deepEqual(heads(f),before);assert.equal(f.wires().length,calls);
 }
 for(const turn of f.store.list<any>('research-turn'))readResearchConsumerTurn(f.open(),reference(turn));
});

for (const foreign of [true, false])
 test(`S6.6-03: a damaged ${foreign ? 'foreign' : 'own'} draft session ${foreign ? 'cannot block this run' : 'is a typed refusal'}`,async t=>{
 const f=await setup(t,[planQuestion('block','industry','blocking')]);f.configure([toSynthesis,ended()]);
 const restore=cutAfter(f,row=>row.kind==='synthesis-session' && row.expected===0);
 await assert.rejects(direct(f),/persistent cut/);restore();
 const original=sessions(f.store)[0]!;
 // Explicit negative mutation of a genuine producer: its exact Question is lost.
 const damaged=structuredClone(original.value);damaged.binding.question.hash='0'.repeat(64);
 if (foreign) {
  // An actual other draft of the same project; its old era does not add a
  // second active v7 plan. Its deliberately damaged v3 claim is irrelevant.
  const other=f.discovery.create('p','discovery','R0','concept',[
   {field:'old',kind:'fact',prompt:'Other draft',risk:'unknown',schema:{type:'object'}}],[],6);
  damaged.binding.draft=reference(other);
 }
 const broken=f.store.write({id:foreign?original.id+':foreign':original.id,kind:original.kind,
  expected:foreign?0:original.revision,value:damaged});
 assert.throws(()=>readSynthesisSessionV3(f.open(),reference(broken)),{code:'synthesis_session_invalid'});
 if (foreign) {
  f.configure([ended()]);
  f.finishFrontier();const result=await f.run(3,f.open());assert.equal(result.value.status,'completed',JSON.stringify(result.value));
  assert.equal(f.wires().filter(w=>!w.subject.assessmentSubject).length,1);
  assert.equal(f.wires().filter(w=>w.subject.assessmentSubject).length,1);assert.deepEqual(f.store.get(broken.id),broken);
  const own=readSynthesisSessionV3(f.open(),reference(f.store.get<any>(original.id)!));
  assert.deepEqual(own.value.binding.draft,original.value.binding.draft);assert.ok(own.value.result);
 } else {
  const before=snapshot(f);
  await assert.rejects(f.run(3,f.open()),{code:'synthesis_session_invalid'});
  assert.deepEqual(snapshot(f),before);
 }
});
