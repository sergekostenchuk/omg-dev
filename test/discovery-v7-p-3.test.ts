import { execFileSync } from 'node:child_process';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
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
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, readResearchConsumerTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId, projectResearchTurnRevision, projectSourceReadingTurn } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { queueReadingPlan, splitPlannedContextRead } from '../src/discovery/reading-plan.js';
import { readResearchContext } from '../src/discovery/research-limits.js';
import type { ResearchTurn, ResearchAction } from '../src/discovery/research-model.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, attemptAccountKey } from '../src/discovery/v7-attempt-assessment.js';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-dr3ba-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

const rand = () => Math.random().toString(16).slice(2);
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
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:context.dispatchMode==='planning'?'reading-planner' as const:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,...(context.dispatchMode?{mode:context.dispatchMode}:{}),instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:context.dispatchMode==='planning'?'reading-planner':'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {...f,v,project,questions,subject,prepare,wires,environment,prompt,settings,calibration:{draft:old,question:q}};
}

import { applyDiscoveryAssessment, readV7ProgressStateAt, v7ProgressBaseline, proveAppliedAttemptClaim } from '../src/discovery/v7-progress.js';
import { type ClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';

type Setup = Awaited<ReturnType<typeof setup>>;
const noEnd = () => ({ type:'impossible', code:'source_unavailable', evidence:[], text:'No source' });
function hypothesis(f: Setup, text: string) {
  return { type:'submitted', contract:DISCOVERY_CLAIMS_CONTRACT, value:{claims:[{id:'h',kind:'hypothesis',text,
    axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
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
  accept?:boolean; requirements?:boolean; question?:string; transition?:unknown; duplicates?:boolean; reverse?:boolean; methodology?:(claims:ClaimAddress[])=>unknown}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:options.question??'q-industry',entries});
  const baseline=options.baseline??v7ProgressBaseline(f.store,packet);
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.accept?(options.reverse?[...claims].reverse():claims):[];
  const newClaims=options.duplicates?accepted.slice(0,1):accepted;
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:newClaims.map(claim=>({claim,reason:'New basis'})),
    duplicates:options.duplicates?accepted.slice(1).map(claim=>({claim,of:accepted[0]!,reason:'Same content'})):[],
    noProgress:entries.filter(e=>!newClaims.some(c=>c.container.id===e.attempt.id)
      && !(options.transition as any)?.bases?.some((b:any)=>b.constraint?.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No new basis'})),
    transition:options.transition??null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:options.methodology?.(claims)??{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
const errorCode=(action:()=>unknown,code:string)=>assert.throws(action,(e:unknown)=>e instanceof EngineError&&e.code===code);

test('P.3: three distinct noProgress attempts stall once; cold replay is free and immutable',async t=>{
  const f=await setup(t), entries=[];
  for(let i=0;i<3;i++) entries.push(await produce(f));
  const a=await assess(f,entries), result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  assert.equal(result.state.value.summary.streak,3);assert.equal(result.state.value.summary.outcome,'stalled');
  assert.equal(f.store.list('v7-attempt-account').length,3);
  const before=f.store.list(), wires=f.wires().length;
  const replay=applyDiscoveryAssessment(f.open(),'p',reference(a.paid));
  assert.equal(replay.repeated,true);assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
  assert.deepEqual(readV7ProgressStateAt(f.open(),reference(result.state)),result.state);
});
for(const order of [['new','same','same'],['none','none','new']] as const) {
  test(`P.3: ordered ${order.join('/')} computes N from new content, not from ids`,async t=>{
    const f=await setup(t), entries=[];
    for(const kind of order) entries.push(await produce(f,kind==='none'?noEnd():hypothesis(f,'Same hypothesis')));
    const a=await assess(f,entries,{accept:true,duplicates:order[0]==='new'});
    const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
    assert.equal(result.state.value.summary.streak,order[0]==='new'?2:0);
    assert.equal(f.store.list('research-progress-event').length,1);
    for(const claim of a.claims) {
      const proof=proveAppliedAttemptClaim(f.open(),claim);assert.equal(proof.application.value.assessment.id,a.paid.id);
      assert.equal(proof.assessment.id,a.paid.id);
    }
    assert.equal(checkStoreIntegrity(f.store).findings.length,0);
  });
}
test('P.3: absent→first and revision→next preserve the original paid baseline on cold A replay',async t=>{
  const f=await setup(t), one=await produce(f), a=await assess(f,[one]);
  const first=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const wires=f.wires().length, ledger=f.store.list('model-call');
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
  assert.equal(f.wires().length,wires);assert.deepEqual(f.store.list('model-call'),ledger);
  const two=await produce(f), b=await assess(f,[two]);
  assert.equal(b.baseline.state.kind,'state');
  const next=applyDiscoveryAssessment(f.store,'p',reference(b.paid));assert.equal(next.state.revision,first.state.revision+1);
  const records=f.store.list();
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(b.paid)),b.paid);
  assert.deepEqual(f.store.list(),records);
});
test('P.3: overlapping paid packets retain an addressed stale remainder and never recount a covered attempt',async t=>{
  const f=await setup(t), entries=[await produce(f),await produce(f)], baseline=v7ProgressBaseline(f.store,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'q-industry'});
  const one=await assess(f,entries.slice(0,1),{baseline}), both=await assess(f,entries,{baseline});
  applyDiscoveryAssessment(f.store,'p',reference(one.paid));
  const before=f.store.list();
  errorCode(()=>applyDiscoveryAssessment(f.open(),'p',reference(both.paid)),'discovery_progress_stale');
  assert.deepEqual(f.store.list(),before);assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(both.paid)),both.paid);
  assert.equal(applyDiscoveryAssessment(f.open(),'p',reference(one.paid)).repeated,true);
});
test('P.3: omitted earlier answer refuses before any progress writes',async t=>{
  const f=await setup(t);await produce(f);const second=await produce(f),a=await assess(f,[second]);
  const before=f.store.list();errorCode(()=>applyDiscoveryAssessment(f.store,'p',reference(a.paid)),'discovery_progress_order_invalid');
  assert.deepEqual(f.store.list(),before);
});
test('P.3: two Stores racing the same paid application share one atomic result',async t=>{
  const f=await setup(t),entry=await produce(f),a=await assess(f,[entry]);
  const second=f.open(), write=f.store.writeMany.bind(f.store);let competing=false;
  f.store.writeMany=((...args:Parameters<Store['writeMany']>)=>{
    if(!competing&&args[0].some(w=>w.kind==='v7-progress-application')){
      competing=true;applyDiscoveryAssessment(second,'p',reference(a.paid));
    }
    return write(...args);
  }) as Store['writeMany'];
  const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  assert.equal(result.repeated,true);assert.equal(result.state.value.summary.count,1);
  assert.equal(f.store.list('v7-progress-application').length,1);
  assert.equal(f.store.list('v7-attempt-account').length,1);
});
test('P.3: an interruption inside writeMany rolls back application, accounts, events and cursor together',async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'New')),a=await assess(f,[entry],{accept:true});
  const before=f.store.list(),get=f.store.get.bind(f.store),write=f.store.writeMany.bind(f.store);let applying=false;
  f.store.writeMany=((...args:Parameters<Store['writeMany']>)=>{applying=true;try{return write(...args);}finally{applying=false;}}) as Store['writeMany'];
  f.store.get=((...args:Parameters<Store['get']>)=>{
    if(applying&&args[0].startsWith('v7-attempt-account:'))throw new Error('injected transaction interruption');
    return get(...args);
  }) as Store['get'];
  assert.throws(()=>applyDiscoveryAssessment(f.store,'p',reference(a.paid)),/injected transaction interruption/);
  f.store.get=get;f.store.writeMany=write;
  assert.deepEqual(f.store.list(),before);assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
  assert.equal(applyDiscoveryAssessment(f.open(),'p',reference(a.paid)).state.value.summary.streak,0);
});
function factFixture(f:Setup, dated=false) {
  const source=f.discovery.evidence.document('p','measurement',JSON.stringify({fact:'A saved measurement is 42',...(dated?{published:'2026-10-21',version:'3.1'}:{})}),'application/json',0);
  const end={type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'h',kind:'fact',text:'A saved measurement is 42',
    axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
    basis:{source:{ref:reference(source),range:{start:0,end:source.value.content.length},valueHash:hashJson(source.value.content)},
      limit:'Single measurement',asOf:'Undated saved report'}}]}};
  const methodology=(claims:ClaimAddress[])=>{
    const evidence={source:reference(source),selector:{kind:'json-pointer',pointer:'/fact'}};
    return {contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[{
      claim:claims[0],significance:{kind:'blocking',reason:'Plan basis'},sources:[{source:reference(source),role:'primary',reason:'Original report',
        evidence:[evidence],original:reference(source),originalReason:'Original report',limitation:null,
        publicationDate:dated?{status:'known',value:'2026-10-21',evidence:[{...evidence,selector:{kind:'json-pointer',pointer:'/published'}}]}:{status:'unknown',reason:'Not published'},eventDate:{status:'unknown',reason:'Not dated'},
        version:dated?{status:'known',value:'3.1',evidence:[{...evidence,selector:{kind:'json-pointer',pointer:'/version'}}]}:{status:'unknown',reason:'No version'},retrievedAt:null}],
      temporalApplicability:{status:'established',scope:'Content of the saved report',reason:'This statement concerns the saved bytes',evidence:[evidence]},
      corroboration:{status:'single_confirmation',reason:'One report',limitation:'No independent confirmation'},
      refutation:{status:'not_performed',reason:'Not searched',traces:[],counterarguments:[],limitations:['Search remains']}}]};
  };
  return {end,methodology,source};
}
async function refutationSearch(f:Setup) {
  execFileSync('git',['init','--quiet',f.root]);
  writeFileSync(join(f.root,'measurement.txt'),'Original measurement only.');
  execFileSync('git',['-C',f.root,'add','measurement.txt']);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'search',query:'counterargument'}}));
  const m=f.prepare(),response=await m.invoke(),execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:100,context:m.context,subject:m.selected});
  const id=managedTurnId(m.run.id,m.number);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const turn=f.store.get<any>(id)!;
  const result=new ResearchSources(f.store,'p',f.environment.value.workspace).searchCaptured('counterargument',turn);
  f.store.writeMany([result.capture,{id,kind:'research-turn',expected:turn.revision,value:result.turn}],result.guards);
  return {turn:reference(f.store.get(id)!),capture:result.captureRef};
}
for(const defect of ['none','satisfied','date','version','independence','applicability','not-searched','counterargument','search-limitation'] as const) {
  test(`P.3: true paid v3 closure checks explicit methodology requirements: ${defect}`,async t=>{
    const f=await setup(t),trace=await refutationSearch(f),fact=factFixture(f,defect==='satisfied'),entry=await produce(f,fact.end);
    const claim={project:'p',container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
    const transition={outcome:'closed',bases:[{claim}],reason:'Criterion met',sufficiency:{criterion:f.questions[0]!.criterion,
      requiredDepth:f.questions[0]!.requiredDepth,reason:'The criterion concerns the saved measurement only',
      methodologyRequirements:[{claim,dated:defect==='date'||defect==='satisfied',versioned:defect==='version'||defect==='satisfied',independentConfirmation:defect==='independence'||defect==='satisfied',
        reason:'Explicit criterion requirements for this saved original'}]}};
    const methodology=(claims:ClaimAddress[])=>{
      const value:any=fact.methodology(claims),row=value.facts[0];value.policy='assessment-methodology-policy/v2';
      row.sources[0].limitation='This original covers one deployment only';
      if(defect==='satisfied') {
        const other=f.discovery.evidence.document('p','independent-report',JSON.stringify({fact:'An independent report confirms 42',published:'2026-10-21',version:'3.1'}),'application/json',0);
        const second=structuredClone(row.sources[0]);second.source=reference(other);second.original=reference(other);
        for(const evidence of [...second.evidence,...second.publicationDate.evidence,...second.version.evidence])evidence.source=reference(other);
        row.sources.push(second);row.corroboration={status:'independent',sources:[reference(fact.source),reference(other)],reason:'Two independently authored original reports'};
      }
      row.refutation={status:'performed',reason:'Executed the named local search',traces:[trace],counterarguments:[],limitations:[]};
      if(defect==='applicability')row.temporalApplicability={status:'limited',scope:'Other deployment',reason:'Applicability remains unproven',evidence:[]};
      if(defect==='not-searched')row.refutation={status:'not_performed',reason:'Search omitted',traces:[],counterarguments:[],limitations:[]};
      if(defect==='counterargument')row.refutation.counterarguments=[row.sources[0].evidence[0]];
      if(defect==='search-limitation')row.refutation.limitations=['Search did not cover a relevant second repository'];
      return value;
    };
    const a=await assess(f,[entry],{accept:true,requirements:true,transition,methodology}),before=f.store.list();
    if(defect==='none'||defect==='satisfied') {
      const applied=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
      assert.equal(applied.state.value.summary.outcome,'closed');
      assert.equal(applied.state.value.summary.count,1);
      assert.equal(proveAppliedAttemptClaim(f.open(),claim).assessment.id,a.paid.id);
      assert.deepEqual(readV7ProgressStateAt(f.open(),reference(applied.state)),applied.state);
    } else {
      errorCode(()=>applyDiscoveryAssessment(f.store,'p',reference(a.paid)),'discovery_novelty_invalid');
      assert.deepEqual(f.store.list(),before);
      assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
    }
  });
}

for(const repeated of [false,true]) test(`P.3: closing inference retains original paid methodology on cold application; repeated in packet=${repeated}`,async t=>{
  const f=await setup(t),trace=await refutationSearch(f),fact=factFixture(f),first=await produce(f,fact.end);
  const method=(claims:ClaimAddress[])=>{
    const m:any=fact.methodology(claims);m.policy='assessment-methodology-policy/v2';
    m.facts[0].refutation={status:'performed',reason:'Executed the named search',traces:[trace],counterarguments:[],limitations:[]};return m;
  };
  const original=await assess(f,[first],{accept:true,requirements:true,methodology:method});
  const one=applyDiscoveryAssessment(f.store,'p',reference(original.paid)),premise=original.claims[0]!;
  const inference={type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'deduction',kind:'inference',
    text:'Deduction from the saved measurement',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
    scope:{variants:'common'},basis:{from:[premise],reasoning:'This follows from the original measured result'}}]}};
  const next=await produce(f,inference),claim={project:'p',container:next.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'deduction'};
  const transition={outcome:'closed',bases:[{claim}],reason:'Derived criterion established',
    sufficiency:{criterion:f.questions[0]!.criterion,requiredDepth:f.questions[0]!.requiredDepth,reason:'Exact inference suffices',
      methodologyRequirements:[{claim:premise,dated:false,versioned:false,independentConfirmation:false,reason:'This criterion is about the saved original'}]}};
  const assessed=await assess(f,repeated?[first,next]:[next],{accept:true,requirements:true,...(repeated?{methodology:method}:{}),baseline:v7ProgressBaseline(f.store,original.packet,[premise]),transition});
  const two=applyDiscoveryAssessment(f.open(),'p',reference(assessed.paid));
  assert.equal(one.state.value.summary.outcome,'open');assert.equal(two.state.value.summary.outcome,'closed');
  assert.equal(two.state.value.summary.count,2);assert.equal(proveAppliedAttemptClaim(f.open(),claim).assessment.id,assessed.paid.id);
  const application=two.applications[0]!;
  assert.deepEqual(application.value.methodologyOrigins,[{claim:premise,assessment:reference(original.paid)}]);
  const sites=referenceSites(application.kind,application.value);
  assert.deepEqual(sites.find(site=>site.field==='methodologyOrigins[0].assessment')?.ref,reference(original.paid));
  assert.deepEqual(sites.find(site=>site.field==='methodologyOrigins[0].claim.container')?.ref,premise.container);
  assert.equal(checkStoreIntegrity(f.store).findings.length,0);
  assert.deepEqual(readV7ProgressStateAt(f.open(),reference(two.state)),two.state);
});

test('P.3: a competing different packet moves the state without leaving a partial loser',async t=>{
  const f=await setup(t),entries=[await produce(f),await produce(f)],baseline=v7ProgressBaseline(f.store,{project:'p',planAnswer:f.v.planAnswer,planQuestionId:'q-industry'});
  const a=await assess(f,entries.slice(0,1),{baseline}),b=await assess(f,entries,{baseline});
  const second=f.open(),write=f.store.writeMany.bind(f.store);let raced=false;
  f.store.writeMany=((...args:Parameters<Store['writeMany']>)=>{
    if(!raced&&args[0].some(w=>w.kind==='v7-progress-application')){raced=true;applyDiscoveryAssessment(second,'p',reference(a.paid));}
    return write(...args);
  }) as Store['writeMany'];
  errorCode(()=>applyDiscoveryAssessment(f.store,'p',reference(b.paid)),'discovery_progress_stale');
  assert.equal(f.store.list('v7-progress-application').length,1);
  assert.equal(f.store.list('v7-attempt-account').length,1);
  assert.equal(f.store.list('v7-progress-state')[0]!.revision,1);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(b.paid)),b.paid);
});

for(const omitted of ['v7-progress-application','v7-attempt-account','research-progress-event','v7-progress-state']) {
  test(`P.3: cold exact reading refuses a missing atomic ${omitted}`,async t=>{
    const f=await setup(t),entry=await produce(f,hypothesis(f,'One basis')),a=await assess(f,[entry],{accept:true});
    const applied=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),cold=f.open(),get=cold.get.bind(cold);
    const selected=f.store.list(omitted)[0]!;
    // Explicit negative storage fault, never a positive acceptance fixture.
    cold.get=((...args:Parameters<Store['get']>)=>args[0]===selected.id?null:get(...args)) as Store['get'];
    errorCode(()=>readV7ProgressStateAt(cold,reference(applied.state)),'discovery_progress_conflict');
  });
}

for(const repeated of [false,true]) {
  test(`P.3: later favourable paid methodology cannot replace original acceptance; repeated in packet=${repeated}`,async t=>{
    const f=await setup(t),trace=await refutationSearch(f),fact=factFixture(f),first=await produce(f,fact.end);
    const original=await assess(f,[first],{accept:true,methodology:fact.methodology});
    const one=applyDiscoveryAssessment(f.store,'p',reference(original.paid)),premise=original.claims[0]!;
    const favourable=(claims:ClaimAddress[])=>{
      const m:any=fact.methodology(claims);m.policy='assessment-methodology-policy/v2';
      m.facts[0].refutation={status:'performed',reason:'Later search',traces:[trace],counterarguments:[],limitations:[]};return m;
    };
    const alternate=await assess(f,[first],{accept:true,requirements:true,methodology:favourable});
    assert.notEqual(alternate.paid.id,original.paid.id);
    assert.equal(applyDiscoveryAssessment(f.open(),'p',reference(alternate.paid)).repeated,true);
    const next=await produce(f,{type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'deduction',kind:'inference',
      text:'Inference from saved fact',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
      scope:{variants:'common'},basis:{from:[premise],reasoning:'Exact original measurement'}}]}});
    const claim={project:'p',container:next.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'deduction'};
    const transition={outcome:'closed',bases:[{claim}],reason:'Criterion met',sufficiency:{criterion:f.questions[0]!.criterion,
      requiredDepth:f.questions[0]!.requiredDepth,reason:'Saved measurement suffices',methodologyRequirements:[{claim:premise,dated:false,versioned:false,independentConfirmation:false,reason:'Only saved value'}]}};
    const assessed=await assess(f,repeated?[first,next]:[next],{accept:true,requirements:true,
      baseline:v7ProgressBaseline(f.store,original.packet,[premise]),transition,...(repeated?{methodology:favourable}:{})});
    const before=f.store.list(),wires=f.wires().length;
    errorCode(()=>applyDiscoveryAssessment(f.open(),'p',reference(assessed.paid)),'discovery_novelty_invalid');
    assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wires);
    assert.deepEqual(readV7ProgressStateAt(f.open(),reference(one.state)),one.state);
    assert.equal(proveAppliedAttemptClaim(f.open(),premise).assessment.id,original.paid.id);
  });
}

for(const value of [null,{}, {contract:'v7-attempt-account/v1',accepted:[]}]) {
  test(`P.3: forged first account cannot impersonate acceptance: ${JSON.stringify(value)}`,async t=>{
    const f=await setup(t),entry=await produce(f,hypothesis(f,'Not applied')),a=await assess(f,[entry],{accept:true});
    // Explicit negative corruption: a caller-written label is not an application.
    f.store.write({id:attemptAccountKey(a.packet,entry.attempt),kind:'v7-attempt-account',expected:0,value});
    const before=f.store.list();
    errorCode(()=>proveAppliedAttemptClaim(f.open(),a.claims[0]!),'discovery_progress_conflict');
    assert.deepEqual(f.store.list(),before);
  });
}


async function plannedRead(f:Setup,split=false,complete=true) {
  const source=f.discovery.evidence.document('p','queued','Exact child bytes','text/plain',0);
  const draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!;
  const read=split?{action:'read_context' as const,record:reference(draft),pointer:'/stage'}:
    {action:'read_source' as const,source:reference(source),start:0,end:source.value.content.length};
  const action={action:'read_plan' as const,question:'q-industry',reads:[read]};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:action}));
  await researchCall(f.environment.value.implementer,f.environment.value,'Calibrate planner',{dispatchMode:'planning'},undefined,
    {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'reading-planner'});
  const m=f.prepare(f.subject(),{history:[],readings:[],dispatchMode:'planning'}),response=await m.invoke();
  const execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:100,context:m.context,subject:m.selected,mode:'planning'});
  const id=managedTurnId(m.run.id,m.number);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const parent=f.store.get<ResearchTurn>(id)!,run=f.store.get<ResearchRun>(m.run.id)!;
  const queued=queueReadingPlan(f.store,run,parent,m.draft,m.question,action);
  const completedParent=f.store.write<ResearchTurn>({id,kind:'research-turn',expected:parent.revision,
    value:projectResearchTurnRevision(parent.value as any,{kind:'reading-plan-queued',children:queued.children})});
  const child=f.store.get<ResearchTurn>(queued.children[0]!.id)!;
  let selected=[reference(child)];
  if(split) selected=splitPlannedContextRead(f.store,queued.run,child,m.draft,m.question).children;
  const completed=complete?selected.map(ref=>{
    const row=f.store.get<ResearchTurn>(ref.id,ref.revision)!;
    const a=row.value.action as ResearchAction;
    const value=a.action==='read_context'?{...row.value,status:'completed' as const,
      observation:readResearchContext(f.store,m.draft,m.question.id,undefined,a.record,a.pointer,a.page)}:
      projectSourceReadingTurn(row.value,'p',{ref:reference(source),value:source.value});
    return f.store.write<ResearchTurn>({id:row.id,kind:row.kind,expected:row.revision,value});
  }):[];
  for(const row of [completedParent,...completed]) readResearchConsumerTurn(f.open(),reference(row));
  return {run,parent:completedParent,child:f.store.get<ResearchTurn>(child.id)!,completed};
}

for(const split of [false,true]) test(`P.3-01: paid planner, real queue${split?' and split':''}, read and attempt keep one N`,async t=>{
  const f=await setup(t),queue=await plannedRead(f,split),entry=await produce(f,hypothesis(f,'After reading'));
  const a=await assess(f,[entry],{accept:true}),result=applyDiscoveryAssessment(f.open(),'p',reference(a.paid));
  assert.equal(result.state.value.summary.count,1);assert.equal(result.state.value.summary.streak,0);
  assert.equal(result.state.value.summary.cursor?.number,split?5:3);
  assert.equal(f.store.get(managedTurnId(queue.run.id,2)),null);
  assert.equal(f.store.list('v7-attempt-account').length,1);
  assert.deepEqual(result.applications[0]!.value.prefix.map(ref=>f.store.get<any>(ref.id,ref.revision)!.value.number),
    split?[1,2,3,4,5]:[1,2,3]);
  assert.deepEqual(readV7ProgressStateAt(f.open(),reference(result.state)),result.state);
});

for(const damaged of ['attempt','planner','child','split'] as const) test(`P.3-02: exact application survives later corrupt ${damaged} head`,async t=>{
  const f=await setup(t),queue=damaged==='attempt'?null:await plannedRead(f,damaged==='split');
  const entry=await produce(f,hypothesis(f,'Immutable accepted basis')),a=await assess(f,[entry],{accept:true});
  const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  const selected=damaged==='planner'?queue!.parent:damaged==='child'||damaged==='split'?queue!.completed[0]!:
    f.store.get<any>(result.applications[0]!.value.prefix.at(-1)!.id)!;
  // Explicit negative corruption of a later revision, not a new paid producer.
  const corrupt=f.store.write({id:selected.id,kind:selected.kind,expected:selected.revision,
    value:{...selected.value,observation:{forged:true}}});
  assert.throws(()=>readResearchConsumerTurn(f.open(),reference(corrupt)),EngineError);
  const before=f.store.list(),wire=f.wires().length;
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
  assert.deepEqual(readV7ProgressStateAt(f.open(),reference(result.state)),result.state);
  assert.equal(proveAppliedAttemptClaim(f.open(),a.claims[0]!).assessment.id,a.paid.id);
  assert.deepEqual(f.store.list(),before);assert.equal(f.wires().length,wire);
});

for(const corrupt of [false,true]) test(`P.3-02: pinned prefix loss/substitution still refuses; substitution=${corrupt}`,async t=>{
  const f=await setup(t);await plannedRead(f);
  const entry=await produce(f,hypothesis(f,'Pinned basis')),a=await assess(f,[entry],{accept:true});
  const result=applyDiscoveryAssessment(f.store,'p',reference(a.paid)),selected=result.applications[0]!.value.prefix[0]!;
  const cold=f.open(),get=cold.get.bind(cold);
  cold.get=((...args:Parameters<Store['get']>)=>{
    const row=get(...args);
    return args[0]===selected.id&&args[1]===selected.revision
      ?corrupt&&row?{...row,value:{forged:true}}:null:row;
  }) as Store['get'];
  errorCode(()=>readV7ProgressStateAt(cold,reference(result.state)),'discovery_progress_conflict');
});

test('P.3-02: writer CAS refuses a prefix that changes after projection',async t=>{
  const f=await setup(t),entry=await produce(f),a=await assess(f,[entry]),write=f.store.writeMany.bind(f.store);let changed=false;
  f.store.writeMany=((...args:Parameters<Store['writeMany']>)=>{
    if(!changed&&args[0].some(row=>row.kind==='v7-progress-application')){
      changed=true;const turn=f.store.list<ResearchTurn>('research-turn')[0]!;
      write([{id:turn.id,kind:turn.kind,expected:turn.revision,value:{...turn.value,observation:{forged:true}}}]);
    }
    return write(...args);
  }) as Store['writeMany'];
  errorCode(()=>applyDiscoveryAssessment(f.store,'p',reference(a.paid)),'discovery_progress_conflict');
  for(const kind of ['v7-progress-application','v7-attempt-account','research-progress-event','v7-progress-state'])
    assert.equal(f.store.list(kind).length,0);
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
});

test('P.3-02: absent saved prefix is a typed refusal, never a head fallback',async t=>{
  const f=await setup(t),entry=await produce(f),a=await assess(f,[entry]),result=applyDiscoveryAssessment(f.store,'p',reference(a.paid));
  // Explicit negative corruption: a copied application with no prefix receipt.
  const {prefix:_prefix,...value}=result.applications[0]!.value;
  const application=f.store.write({id:'v7-progress-application:negative-missing-prefix',kind:'v7-progress-application',expected:0,value});
  const state=f.store.write({id:result.state.id,kind:result.state.kind,expected:result.state.revision,
    value:{...result.state.value,application:reference(application)}});
  errorCode(()=>readV7ProgressStateAt(f.open(),reference(state)),'discovery_progress_conflict');
});

test('P.3-01: a known but unfinished queued split cannot be skipped',async t=>{
  const f=await setup(t);await plannedRead(f,true,false);
  const entry=await produce(f),a=await assess(f,[entry]),before=f.store.list();
  errorCode(()=>applyDiscoveryAssessment(f.store,'p',reference(a.paid)),'discovery_progress_order_invalid');
  assert.deepEqual(f.store.list(),before);
});
