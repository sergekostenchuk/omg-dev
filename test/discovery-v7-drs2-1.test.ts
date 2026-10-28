import { fixturePlanAxes, fixturePlanCoverage } from "./discovery-v7-fixture.js";
import { execFileSync } from 'node:child_process';
import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT, discoveryAcceptanceActId, type DiscoveryAcceptanceAct } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { type Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-drs2-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

const rand = () => Math.random().toString(16).slice(2);

function validFrame(questions: PlanQuestion[]): Json {
  return { productType: "internal", scale: "30 users across 10 sites",
    industries: ["construction"], domains: ["materials supply", "equipment accounting"],
    axes: fixturePlanAxes(questions),
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
  return { edition, frame: frameRef, previous, questions, coverage: fixturePlanCoverage(questions) } as unknown as Json;
}
function questionOf(store: Store, draft: Revision<DiscoveryDraft>, field: string): Revision<Question> {
  const question = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field);
  assert.ok(question, `question for ${field}`);
  return question;
}
/** The real plan acceptance chain (frame and plan through #answer). */
function acceptPlan(f: Fixture, project: string, questions: PlanQuestion[]) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, `basis:${base.id}`, `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(questions), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, questions), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
async function setup(t: test.TestContext) {
  const f = fixture(t), project = 'p', wire = join(f.root,'wire.ndjson'), adapter = join(f.root,'adapter.mjs');
  const settings = join(f.root,'reply.json');
  writeFileSync(settings,JSON.stringify({tokens:10}));
  writeFileSync(adapter, `import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const queued=settings.replies?.shift();if(queued)writeFileSync(${JSON.stringify(settings)},JSON.stringify(settings));
const research=settings.readSource&&!r.subject.contextWorkspace?.length?{action:'read_context',record:r.subject.working.archive,pointer:'/body/value/materials/0/value/content'}:queued??settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:settings.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = {executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure(project,{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:10000},0);
  const old=f.discovery.create(project,'discovery','R0','concept',[
    {field:'probe',kind:'fact',prompt:'Calibrate',risk:'unknown',schema:{type:'object'}}],[],6);
  const q=f.store.get<Question>(old.value.questions[0]!)!;
  await researchCall(environment.value.implementer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:old.id,questionId:q.id,purpose:'analyst'});
  await researchCall(environment.value.reviewer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:old.id,questionId:q.id,purpose:'assessor'});
  const questions=[planQuestion('q-industry','industry','blocking'),planQuestion('q-market','market')];
  const v=acceptPlan(f,project,questions);
  const subject=(id='q-industry',answer=v.planAnswer):V7PlanSubject=>({contract:V7_PLAN_SUBJECT_CONTRACT,planAnswer:answer,planQuestionId:id});
  const prompt='Research the selected plan question; return an answer with a V7AttemptEnd value and empty citations.';
  let runId: string | undefined;
  const prepare=(selected=subject())=>{
    const context={history:[],readings:[]};
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=()=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,subject,prepare,wires,environment,settings};
}

import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';

type Setup = Awaited<ReturnType<typeof setup>>;
const noEnd = () => ({ type:'impossible', code:'source_unavailable', evidence:[], text:'No source' });
function hypothesis(f: Setup, text: string, question='q-industry') {
  return { type:'submitted', contract:DISCOVERY_CLAIMS_CONTRACT, value:{claims:[{id:'h',kind:'hypothesis',text,
    axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:question}],scope:{variants:'common'},
    basis:{howToVerify:'Measure it'}}]} };
}
async function produce(f: Setup, end: unknown = noEnd(), question = 'q-industry') {
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'answer',question,value:end,citations:[]}}));
  const m=f.prepare(f.subject(question)), response=await m.invoke();
  const execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:100,context:m.context,subject:m.selected});
  const turnId=managedTurnId(m.run.id,m.number);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id:turnId,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const call=f.store.get<ResearchConsumerIntent>(m.intent.id)!.value.call!;
  const recorded=recordV7Attempt(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:question,
    call,end:attemptEndOfAction(response,m.selected)});
  const done=completeResearchAttemptTurn(f.store,'p',reference(f.store.get(turnId)!),reference(recorded.attempt));
  return { attempt:reference(recorded.attempt),binding:reference(done.binding) };
}
type Entry=Awaited<ReturnType<typeof produce>>;
async function assess(f: Setup, entries:Entry[], options:{baseline?:ReturnType<typeof v7ProgressBaseline>;
  accept?:boolean; requirements?:boolean}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:'q-industry',entries});
  const baseline=options.baseline??v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.accept?claims:[];
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:accepted.map(claim=>({claim,reason:'New basis'})),duplicates:[],
    noProgress:entries.filter(e=>!accepted.some(c=>c.container.id===e.attempt.id))
      .map(e=>({attempt:e.attempt,reason:'No new basis'})),transition:null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
const errorCode=(action:()=>unknown,code:string)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);


import { DatabaseSync } from 'node:sqlite';
import { removeEventIndex } from '../src/storage/schema.js';
import { canonical, digest } from '../src/canonical.js';
import { buildDiscoveryIndexAt, discoveryIndexCursor } from '../src/discovery/discovery-index.js';
import { coverageCellKey, type CoverageCell } from '../src/discovery/coverage.js';
const snapshot=(store:Store)=>store.list().flatMap(row=>store.history(row.id));
const objectSignal=(e:unknown)=>e!==null&&typeof e==='object'?(e as {signal?:string}).signal:undefined;
const scopeOf=(store:Store,plan:Ref)=>({contract:'discovery-index/v1',databaseId:store.databaseId,project:'p',plan});
function coveredCell(f:Setup) {
  // 5.1-F is structural. Even this canonical cell cannot prove deep coverage.
  const cell:CoverageCell={contract:'discovery-coverage-cell/v1',projectId:'p',subject:f.subject(),
    variant:{set:{id:'discovery-variant-set:p:structural',revision:1,hash:'a'.repeat(64)},
      member:{id:'discovery-variant:p:structural',revision:1,hash:'b'.repeat(64)}},requiredDepth:'deep',criterion:'Named exact coverage'};
  return f.store.write({id:coverageCellKey(cell),kind:'discovery-coverage-cell',expected:0,value:cell});
}

test('DRS2.1 genuine plan/K/paid assessment/P and provenance project at a fixed committed boundary',async t=>{
  const f=await setup(t),e=await produce(f,hypothesis(f,'Original basis')),a=await assess(f,[e],{accept:true});
  const beforeApply=discoveryIndexCursor(f.store);
  const applied=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const cell=coveredCell(f),cursor=discoveryIndexCursor(f.store),before=snapshot(f.store),wires=f.wires();
  const stamp=f.store.changeStamp();
  const indexed=buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,cursor);
  assert.equal(f.store.changeStamp(),stamp,'technical publication changes no primary stamp');
  assert.equal(indexed.rangeComplete,true);
  assert.deepEqual(indexed.questions.map(q=>q.planQuestionId),['q-industry','q-market']);
  assert.equal(indexed.claims.length,1);assert.deepEqual(indexed.claims[0]!.address,a.claims[0]);
  assert.equal(indexed.claims[0]!.verification,'structural');
  assert.deepEqual(indexed.progress.map(p=>p.state),[reference(applied.state)]);
  assert.deepEqual(indexed.progress[0]!.data.summary,applied.state.value.summary);
  assert.deepEqual(indexed.progress[0]!.data.summary.cursor,{run:applied.state.value.summary.cursor!.run,number:1});
  assert.notEqual(cursor.sequence,indexed.progress[0]!.data.summary.cursor!.number);
  assert.ok(indexed.sources.some(s=>s.record.id===a.paid.id));
  assert.ok(indexed.sources.some(s=>s.record.id===e.attempt.id));
  assert.ok(indexed.provenance.some(p=>p.from.id===applied.state.id&&p.to.id===applied.state.value.application.id&&p.availability==='exact'));
  assert.deepEqual(indexed.coverage,{complete:false,reason:'deep-coverage-unavailable',cells:[{verification:'structural',source:reference(cell),cell:cell.value}]});
  const earlier=buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,beforeApply);
  assert.equal(earlier.rangeComplete,true);assert.equal(earlier.progress.length,0);
  assert.equal(earlier.coverage.complete,false);assert.equal(earlier.coverage.cells.length,0);
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);
  // No source/event after the fixed cursor enters a cold historical read.
  await produce(f,hypothesis(f,'Later basis','q-market'),'q-market');
  const head=f.store.get<DiscoveryDraft>(f.v.draft.id)!;
  f.store.write({id:head.id,kind:head.kind,expected:head.revision,value:{...head.value,questions:[]}});
  const late=snapshot(f.store),lateWires=f.wires();
  const cold=f.open(),again=buildDiscoveryIndexAt(cold,'p',f.v.planAnswer,cursor);
  assert.deepEqual(snapshot(f.store),late);assert.deepEqual(f.wires(),lateWires);
  assert.deepEqual(again,indexed);assert.equal(again.sources.some(s=>s.sequence>cursor.sequence),false);
});

test('DRS2.1 interruption and cold incremental completion equal a clean full build; sequence gaps are not missing work',async t=>{
  const f=await setup(t),e=await produce(f,hypothesis(f,'One'));
  const a=await assess(f,[e],{accept:true});applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const sql=new DatabaseSync(f.path);
  // AUTOINCREMENT may leave gaps: a boundary is a committed event, not its row count.
  sql.prepare("UPDATE sqlite_sequence SET seq=seq+13 WHERE name='events'").run();sql.close();
  f.store.write({id:'unrelated:after-gap',kind:'unrelated',expected:0,value:{projectId:'foreign'}});
  const cursor=discoveryIndexCursor(f.store),before=snapshot(f.store);
  const child=`import {Store} from ${JSON.stringify(new URL('../src/storage/store.js',import.meta.url).href)};
import {buildDiscoveryIndexAt} from ${JSON.stringify(new URL('../src/discovery/discovery-index.js',import.meta.url).href)};
const s=new Store(${JSON.stringify(f.path)});console.log(JSON.stringify(buildDiscoveryIndexAt(s,'p',${JSON.stringify(f.v.planAnswer)},${JSON.stringify(cursor)},{maxEvents:7})));process.exit(0);`;
  // Exit with an open connection after the committed batch: the next process must resume the WAL.
  const first=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',child],{encoding:'utf8'})) as ReturnType<typeof buildDiscoveryIndexAt>;
  assert.equal(first.rangeComplete,false);assert.equal(first.questions.length,0);assert.equal(first.coverage.complete,false);
  const cold=f.open();let resumed=first;
  while(!resumed.rangeComplete) resumed=buildDiscoveryIndexAt(cold,'p',f.v.planAnswer,cursor,{maxEvents:17});
  const key=digest(canonical(scopeOf(f.store,f.v.planAnswer))),db=new DatabaseSync(f.path);
  db.exec('BEGIN IMMEDIATE');db.prepare('DELETE FROM event_index_rows WHERE scope_key=?').run(key);
  db.prepare('DELETE FROM event_index_scopes WHERE key=?').run(key);db.exec('COMMIT');db.close();
  const full=buildDiscoveryIndexAt(f.open(),'p',f.v.planAnswer,cursor);
  assert.deepEqual(resumed,full);assert.deepEqual(snapshot(f.store),before);
});

test('DRS2.1 failed publication rolls back rows AND cursor; cold retry and real competing cursor CAS',async t=>{
  const f=await setup(t),cursor=discoveryIndexCursor(f.store),scope=scopeOf(f.store,f.v.planAnswer),key=digest(canonical(scope));
  const child=`import {DatabaseSync} from 'node:sqlite';
import {Store} from ${JSON.stringify(new URL('../src/storage/store.js',import.meta.url).href)};
import {buildDiscoveryIndexAt} from ${JSON.stringify(new URL('../src/discovery/discovery-index.js',import.meta.url).href)};
const s=new Store(${JSON.stringify(f.path)}),prepare=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);
if(sql==='INSERT INTO event_index_rows VALUES(?,?,?)'){const run=statement.run;statement.run=function(...args){run.apply(this,args);process.kill(process.pid,'SIGKILL');};}return statement;};
buildDiscoveryIndexAt(s,'p',${JSON.stringify(f.v.planAnswer)},${JSON.stringify(cursor)});`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',child]),
    (e:unknown)=>objectSignal(e)==='SIGKILL');
  const db=new DatabaseSync(f.path);
  assert.equal(db.prepare('SELECT count(*) AS n FROM event_index_scopes').get()!['n'],0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM event_index_rows').get()!['n'],0);
  db.close();
  const cold=f.open(),done=buildDiscoveryIndexAt(cold,'p',f.v.planAnswer,cursor);
  assert.equal(done.rangeComplete,true);
  errorCode(()=>f.store.eventIndexWrite(scope,0,cursor.sequence,[]),'event_index_conflict');
  assert.equal(cold.eventIndexRead(key,cursor.sequence)!.cursor,cursor.sequence);
});

test('DRS2.1 exact project/plan/database scope, missing/malformed cursor and future revision cannot masquerade',async t=>{
  const f=await setup(t),cursor=discoveryIndexCursor(f.store),other=fixture(t);
  acceptPlan(f,'other',[planQuestion('foreign-question','industry')]);
  const second=acceptPlan(f,'p',[planQuestion('second-plan','market')]);
  const newCursor=discoveryIndexCursor(f.store);
  const original=buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,newCursor);
  const next=buildDiscoveryIndexAt(f.store,'p',second.planAnswer,newCursor);
  assert.deepEqual(original.questions.map(q=>q.planQuestionId),['q-industry','q-market']);
  assert.deepEqual(next.questions.map(q=>q.planQuestionId),['second-plan']);
  assert.equal(original.sources.some(s=>(s.record.value as any).projectId==='other'),false);
  assert.equal(next.sources.some(s=>s.record.id===f.v.planAnswer.id),false);
  errorCode(()=>buildDiscoveryIndexAt(f.store,'other',f.v.planAnswer,newCursor),'discovery_index_invalid');
  errorCode(()=>buildDiscoveryIndexAt(other.store,'p',f.v.planAnswer,cursor),'discovery_index_invalid');
  for(const bad of [undefined,{...cursor,sequence:-1},{...cursor,sequence:cursor.sequence+100000},
    {...cursor,tail:{...cursor.tail,hash:'a'.repeat(64)}},{...cursor,databaseId:'foreign'}])
    errorCode(()=>buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,bad as any),'discovery_index_invalid');
  errorCode(()=>buildDiscoveryIndexAt(f.store,'p',second.planAnswer,cursor),'discovery_index_invalid');
  const row=f.store.write({id:'late-record',kind:'test',expected:0,value:{value:1}});
  assert.equal(f.store.getAtEvent(cursor.sequence,row.id,row.revision),null);
  assert.equal(f.store.identitiesAtEvent(cursor.sequence).some(r=>r.id===row.id),false);
});

test('DRS2.1 extension mismatch is explicit; install leaves original journal/migration identity unchanged',t=>{
  const f=fixture(t);f.store.write({id:'primary',kind:'test',expected:0,value:{a:1}});
  const before=snapshot(f.store),events=f.store.events(0,f.store.lastEvent()),db=new DatabaseSync(f.path);
  db.exec('DROP TABLE event_index_rows; DROP TABLE event_index_scopes; DROP TABLE event_index_schema');
  const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql:string) {
    if(sql.includes('INSERT INTO event_index_schema')) throw new Error('interrupted_index_install');
    return prepare.call(this,sql);
  };
  try {assert.throws(()=>new Store(f.path),/interrupted_index_install/);} finally {DatabaseSync.prototype.prepare=prepare;}
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'event_index_%'").get()!['n'],0);
  const reopened=f.open();assert.deepEqual(snapshot(reopened),before);assert.deepEqual(reopened.events(0,reopened.lastEvent()),events);
  db.prepare("UPDATE event_index_schema SET sha256='wrong'").run();
  errorCode(()=>new Store(f.path),'migration_mismatch');db.close();
  removeEventIndex(f.path);const recovered=f.open();
  assert.deepEqual(snapshot(recovered),before);assert.deepEqual(recovered.events(0,recovered.lastEvent()),events);
});


test('DRS2.1 a structural covered flag and a forged paid-looking P are not promoted to proof',async t=>{
  const f=await setup(t),e=await produce(f,hypothesis(f,'One')),a=await assess(f,[e],{accept:true});
  const applied=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const original=f.store.get(applied.state.id)!;
  f.store.write({id:original.id,kind:original.kind,expected:original.revision,
    value:{...applied.state.value,application:{...applied.state.value.application,hash:'c'.repeat(64)}}});
  assert.throws(()=>buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,discoveryIndexCursor(f.store)),
    (e:unknown)=>e instanceof EngineError&&e.code==='discovery_progress_conflict');
  // The lawfully produced prior state remains readable at its original event boundary.
  const event=f.store.events(0,f.store.lastEvent()).find(e=>e.id===original.id&&e.revision===original.revision)!;
  const at={databaseId:f.store.databaseId,sequence:event.sequence,tail:f.store.eventAt(event.sequence)};
  const old=buildDiscoveryIndexAt(f.store,'p',f.v.planAnswer,at);assert.equal(old.progress.length,1);
  const cell=coveredCell(f);
  f.store.write({id:cell.id,kind:cell.kind,expected:1,value:{...cell.value as object,covered:true}});
  // Decode the closed structural form directly via another plan scope to keep the forged P out.
  const second=acceptPlan(f,'p',[planQuestion('other','market')]);
  const malformed={...cell.value as any,subject:{...f.subject(),planAnswer:second.planAnswer},covered:true};
  f.store.write({id:'forged-covered-cell',kind:'discovery-coverage-cell',expected:0,value:malformed});
  assert.throws(()=>buildDiscoveryIndexAt(f.store,'p',second.planAnswer,discoveryIndexCursor(f.store)),
    (e:unknown)=>e instanceof EngineError&&e.code==='discovery_coverage_invalid');
});

test('DRS2.1 a cold C1 projection stays identical after the same index advances to C2', t=>{
  const f=fixture(t),v=acceptPlan(f,'p',[planQuestion('original','industry')]);
  const c1=discoveryIndexCursor(f.store),first=buildDiscoveryIndexAt(f.store,'p',v.planAnswer,c1);
  f.store.write({id:'later-unrelated',kind:'test',expected:0,value:{projectId:'p'}});
  const c2=discoveryIndexCursor(f.store),later=buildDiscoveryIndexAt(f.store,'p',v.planAnswer,c2);
  assert.equal(later.indexedThrough,c2.sequence);
  const before=snapshot(f.store),again=buildDiscoveryIndexAt(f.open(),'p',v.planAnswer,c1);
  assert.deepEqual(again,first);assert.equal(again.indexedThrough,c1.sequence);
  assert.deepEqual(snapshot(f.store),before);
});

test('DRS2.1 two genuine editions of one draft/Question isolate exact sources and provenance in full and cold incremental builds',async t=>{
  const f=await setup(t),firstPlan=f.v.planAnswer;
  const e1=await produce(f,hypothesis(f,'Edition one basis')),a1=await assess(f,[e1],{accept:true});
  const p1=applyDiscoveryAssessment(f.store,'p',reference(a1.paid));
  const firstCursor=discoveryIndexCursor(f.store),firstAtC1=buildDiscoveryIndexAt(f.store,'p',firstPlan,firstCursor);
  const firstAct=f.store.get<DiscoveryAcceptanceAct>(
    discoveryAcceptanceActId('p',f.v.draft.id,'plan',firstPlan))!;
  const frameAct=f.store.get<DiscoveryAcceptanceAct>(
    discoveryAcceptanceActId('p',f.v.draft.id,'frame',f.v.frameRef))!;
  const source=f.discovery.evidence.document('p','edition:2','Another accepted edition of this plan','text/plain',0);
  const question=f.store.get<Question>(f.v.plan.id)!;
  f.discovery.reopen(question.id,question.revision);
  answerDiscoveryFixture(f.engine,'p',f.store.get<DiscoveryDraft>(f.v.draft.id)!,f.store.get<Question>(question.id)!,
    validPlan(f.v.frameRef,[planQuestion('q-industry','industry','blocking'),planQuestion('q-market','market'),
      planQuestion('q-new','industry')],2,firstPlan),source);
  const nextQuestion=f.store.get<Question>(question.id)!,nextPlan=nextQuestion.value.answer!;
  const nextAct=f.store.get<DiscoveryAcceptanceAct>(
    discoveryAcceptanceActId('p',f.v.draft.id,'plan',nextPlan))!;
  assert.equal(nextQuestion.id,firstAct.value.questionAfter.id);
  assert.equal(nextAct.value.draftId,firstAct.value.draftId);
  assert.ok(nextQuestion.revision>firstAct.value.questionAfter.revision);
  f.v.planAnswer=nextPlan;
  const e2=await produce(f,hypothesis(f,'Edition two basis')),a2=await assess(f,[e2],{accept:true});
  const p2=applyDiscoveryAssessment(f.store,'p',reference(a2.paid)),cursor=discoveryIndexCursor(f.store);
  const before=snapshot(f.store),wires=f.wires();
  const old=buildDiscoveryIndexAt(f.store,'p',firstPlan,cursor),next=buildDiscoveryIndexAt(f.store,'p',nextPlan,cursor);
  const has=(index:typeof old,ref:Ref)=>index.sources.some(s=>canonical(reference(s.record))===canonical(ref));
  for(const ref of [firstPlan,reference(firstAct),firstAct.value.questionAfter,firstAct.value.draftAfter,
    f.v.frameRef,reference(frameAct),frameAct.value.questionAfter,frameAct.value.draftAfter])
    assert.equal(has(old,ref),true,'own exact acceptance and shared frame are retained');
  for(const ref of [nextPlan,reference(nextAct),nextAct.value.questionBefore,nextAct.value.questionAfter,nextAct.value.draftAfter]) {
    assert.equal(has(old,ref),false,'a later edition is no source of the older scope');
    assert.equal(old.provenance.some(link=>canonical(link.from)===canonical(ref)||canonical(link.to)===canonical(ref)),false,
      'a later edition is no provenance of the older scope');
  }
  for(const ref of [nextPlan,reference(nextAct),nextAct.value.questionBefore,nextAct.value.questionAfter,
    nextAct.value.draftAfter,firstPlan,reference(firstAct),f.v.frameRef,reference(frameAct)])
    assert.equal(has(next,ref),true,'new scope keeps its exact acceptance and explicitly named previous/frame');
  assert.deepEqual(old.progress.map(p=>p.state),[reference(p1.state)]);
  assert.deepEqual(next.progress.map(p=>p.state),[reference(p2.state)]);
  assert.equal(has(old,e1.attempt),true);assert.equal(has(old,reference(a1.paid)),true);
  assert.equal(has(old,e2.attempt),false);assert.equal(has(old,reference(a2.paid)),false);
  assert.equal(has(next,e2.attempt),true);assert.equal(has(next,reference(a2.paid)),true);
  assert.equal(has(next,e1.attempt),false);assert.equal(has(next,reference(a1.paid)),false);
  assert.deepEqual(buildDiscoveryIndexAt(f.open(),'p',firstPlan,firstCursor),firstAtC1);
  // Discard only derived rows, then reconstruct both scopes in bounded batches after reopen.
  const db=new DatabaseSync(f.path);db.exec('BEGIN IMMEDIATE');
  for(const plan of [firstPlan,nextPlan]) {
    const key=digest(canonical(scopeOf(f.store,plan)));
    db.prepare('DELETE FROM event_index_rows WHERE scope_key=?').run(key);
    db.prepare('DELETE FROM event_index_scopes WHERE key=?').run(key);
  }
  db.exec('COMMIT');db.close();
  for(const [plan,full] of [[firstPlan,old],[nextPlan,next]] as const) {
    let batch=buildDiscoveryIndexAt(f.store,'p',plan,cursor,{maxEvents:11});assert.equal(batch.rangeComplete,false);
    const cold=f.open();while(!batch.rangeComplete)batch=buildDiscoveryIndexAt(cold,'p',plan,cursor,{maxEvents:17});
    assert.deepEqual(batch,full);assert.deepEqual(buildDiscoveryIndexAt(f.open(),'p',plan,cursor),full);
  }
  assert.deepEqual(snapshot(f.store),before);assert.deepEqual(f.wires(),wires);
});
