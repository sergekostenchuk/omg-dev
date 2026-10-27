import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync, backup } from 'node:sqlite';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { stopRun, acquireRunExecution, releaseRunExecution, readRunControl } from '../src/om/run-control.js';
import { ProductEngine } from '../src/product/engine.js';
import { EngineError } from '../src/errors.js';
import { BudgetReentry, Researcher, readBudgetStopReentry } from '../src/discovery/research-runner.js';
import { prepareResearchEnvelope, researchCall, resumeDossierResearchCall, withResearchRunControl } from '../src/discovery/research-protocol.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { runDossierAssessmentSession } from '../src/discovery/assessment-session.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation, StageBudgetSessions, issueStageBudgetInvitation, increaseStageBudget } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { readVariantHandoff, readDeepFrontierStop } from '../src/discovery/discovery-outcome.js';
import { readPartialDossier } from '../src/discovery/dossier-manifest.js';
import { V7_AXES } from '../src/discovery/v7-contracts.js';
import { canonical, hashJson } from '../src/canonical.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { readVariantScope } from '../src/discovery/variant-scope.js';
import type { ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { readEffectiveStageBudget, stageBudgetIncreaseId, DISCOVERY_V7_STAGE_BUDGET_KEY } from '../src/discovery/stage-token-budget.js';
import { budgetUsage, raiseWorkingLimit } from '../src/runtime/research-budget.js';
import { storeUnchanged } from './store-unchanged.js';

// Include orphaned history as well as current heads after the explicit missing-head corruptions.
function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
      revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id, revision').all() });
  } finally { db.close(); }
}
// The public runner uses Store indices outside the deliberately narrow storeView
// surface. Intercept only writes to this connection; all reads stay real and the
// second Store still commits independently inside the tested reservation window.
function interceptWrites(t:test.TestContext, target:Store,
  action:(writes:Write[],commit:()=>Revision<unknown>[],guards:TransactionGuard[])=>Revision<unknown>[]) {
  const original=Store.prototype.writeMany;
  const method=t.mock.method(Store.prototype,'writeMany',function<T>(this:Store,writes:Write[],guards:TransactionGuard[]=[]):Revision<T>[] {
    const commit=()=>original.call(this,writes,guards);
    return (this===target?action(writes,commit,guards):commit()) as Revision<T>[];
  });
  return ()=>method.mock.restore();
}
const seedCleanup:Array<()=>void>=[];
test.after(()=>{for(const cleanup of seedCleanup)cleanup();});

async function build(questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')], initialMode: 'questions'|'bypass'|null = 'questions') {
  const f = discoveryFixture({after:fn=>seedCleanup.push(fn)}, 'omg-budget-reentry-seed-');
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
let runtime=${JSON.stringify(f.root)};try{runtime=JSON.parse(readFileSync(${JSON.stringify(join(f.root,'runtime.json'))},'utf8'))}catch{}
const r=JSON.parse(readFileSync(0,'utf8')), s=JSON.parse(readFileSync(join(runtime,'settings.json'),'utf8')), q=r.subject.question?.id??'probe';
let prior=[];try{prior=readFileSync(join(runtime,'wire.ndjson'),'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line))}catch{}
appendFileSync(join(runtime,'wire.ndjson'),JSON.stringify(r)+'\\n');
let research=s.actions?.[prior.filter(row=>!row.subject.assessmentSubject&&!row.subject.variantSubject).length]??{action:'answer',question:q,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=q;
if(r.subject.subject?.contract==='v7-plan-subject/v1'&&!r.subject.deepPreparation){
 const at=r.subject.subject,id=at.planQuestionId;
 research={action:'answer',question:id,value:{type:'submitted',contract:'discovery-claims/v7',value:{claims:[{id:'broad-'+prior.length,kind:'hypothesis',text:'Common sweep material '+prior.length,axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:at.planAnswer,planQuestionId:id}],scope:{variants:'common'},basis:{howToVerify:'Measure the common domain'}}]}},citations:[]};
}
if(r.subject.deepPreparation){
 const cell=r.subject.deepCell, id=cell.subject.planQuestionId;
 const claim={id:'deep-'+prior.length,kind:'hypothesis',text:'Exact variant material '+prior.length,axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:cell.subject.planAnswer,planQuestionId:id}],scope:{variants:s.deepMode==='common'?'common':[cell.variant.member]},basis:{howToVerify:'Measure the exact chosen variant'}};
 const claims=s.deepClaims??(s.selectedAxes&&id==='q-two'&&s.deepMode!=='common'?${JSON.stringify(V7_AXES)}.map(axis=>({...claim,id:claim.id+'-'+axis,text:claim.text+' '+axis,axis,basis:{howToVerify:claim.basis.howToVerify+' '+axis}})):[claim]);
 research={action:'answer',question:id,value:s.deepMode==='impossible'?{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'}:{type:'submitted',contract:'discovery-claims/v7',value:{claims}},citations:[]};
}
if(r.subject.variantSubject?.kind==='decision')research=s.reject?{action:'reject_all',reason:'Model rejects this exact set'}:{action:'choose',key:'v1',reason:'Model chooses the bounded member'};
else if(r.subject.variantSubject){
 const grounds=[r.subject.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];
 research=s.none?{action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds}],searchLimits:['Saved sweep only'],unknowns:['Demand unknown']}
 :{action:'variants',variants:[{key:'v1',title:'Bounded variant',proposal:{bounded:true},criteria:Object.fromEntries(keys.map(key=>[key,{conclusion:'Bounded model proposal',grounds,assumptions:[],unknowns:['Demand unknown'],quantity:null}]))}],scale:Object.fromEntries(keys.map(key=>[key,'Same bounded scale'])),comparison:'One bounded option',recommendation:{key:'v1',reason:'Only bounded candidate'},searchLimits:['Saved sweep only'],unknowns:['Demand unknown']};
}
if(r.subject.role==='reader'){if(s.readerFail)process.exit(42);research={selections:r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]})),unresolved:[]}};
if(r.subject.assessmentSubject){
 const entries=r.subject.assessmentSubject.packet.entries;
 const all=r.subject.value.attempts.flatMap(row=>row.end.type==='submitted'?row.end.value.claims.map((claim,index)=>({accepted:!claim.id.startsWith('counter'),claim:{project:r.subject.assessmentSubject.packet.project,container:row.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id}})):[]);
 const accepted=all.filter(c=>c.accepted).map(c=>({claim:c.claim,reason:'Supported exact hypothesis or addressed unknown'}));
 research={verdict:'supported',reasons:['Exact material classification'],return:null,novelty:{attempts:entries.map(e=>({attempt:e.attempt,reason:'Exact attempt'})),accepted,rejected:all.filter(c=>!c.accepted).map(c=>({claim:c.claim,reason:'Counterargument not supported'})),newContent:accepted,duplicates:[],noProgress:entries.filter(e=>!accepted.some(c=>c.claim.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No accepted addition'})),transition:accepted.length&&s.close!==false?{outcome:'closed',bases:accepted.map(c=>({claim:c.claim})),reason:'The exact criterion has enough supported material',sufficiency:{criterion:'Named basis answering '+r.subject.assessmentSubject.packet.planQuestionId,requiredDepth:'deep',reason:'Required depth is met',methodologyRequirements:[]}}:accepted.length&&s.outcome?{outcome:s.outcome,bases:accepted.map(c=>({claim:c.claim})),reason:'Reopened by the applied assessment',...(s.outcome==='unknown'?{consequence:'The deep cell stays missing',nextAction:'Find the named evidence'}:{})}:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
if(r.subject.managedDossier)research=s.dossierReply;
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):r.subject.deepPreparation?(s.deepTokens??10):(s.analystTokens??10),outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, 'p', questions);
  function mode(value: 'questions'|'bypass', store = f.store) {
    const request = { project: 'p', mode: value, previous: store.get('project-mode:p') ? reference(store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(store), invitation = issueProjectModeInvitation(store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const initial = initialMode === null ? null : mode(initialMode);
  if (initial) {
    const cal = f.store.write({ id: 'variant-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
    for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
      { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? {snapshot: reference(cal)} : {set: reference(cal)}), mode: reference(initial), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  }
  writeFileSync(wire, '');
  f.store.close();
  return {root:f.root,path:f.path,v,environment,command,initial,questions};
}
type Base=Awaited<ReturnType<typeof build>>;
function bind(t:{after(fn:()=>void):void},base:Base,path=base.path,runtime=base.root){
  const {root,v,environment,command,initial,questions}=base,stores:Store[]=[];
  const open=()=>{const store=new Store(path);stores.push(store);return store;};
  const store=open(),engine=new ProductEngine(store),discovery=new Discovery(store),f={root,path,store,engine,discovery,open};
  const selector=join(root,'runtime.json');
  let previousRuntime:string|undefined;try{previousRuntime=readFileSync(selector,'utf8');}catch{}
  writeFileSync(selector,JSON.stringify(runtime));
  t.after(()=>{for(const db of stores)db.close();
    if(previousRuntime===undefined)rmSync(selector,{force:true});else writeFileSync(selector,previousRuntime);});
  const settings=join(runtime,'settings.json'),wire=join(runtime,'wire.ndjson');
  const configure=(patch:Record<string,unknown>={})=>writeFileSync(settings,JSON.stringify({...JSON.parse(readFileSync(settings,'utf8')),...patch}));
  function mode(value: 'questions'|'bypass', store = f.store) {
    const request = { project: 'p', mode: value, previous: store.get('project-mode:p') ? reference(store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(store), invitation = issueProjectModeInvitation(store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const generationCalls = () => wires().filter(row => row.subject.variantSubject);
  const nextEdition = (store = f.store) => {
    const discovery = new Discovery(store), engine = new ProductEngine(store);
    const plan = store.get<Question>(v.plan.id)!; discovery.reopen(plan.id, plan.revision);
    const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(v.draft.id)!;
    const source = discovery.evidence.document('p', 'edition-two', 'New accepted edition', 'text/plain', 0);
    answerDiscoveryFixture(engine, 'p', draft, question, validPlan(v.frameRef, questions, 2, v.planAnswer), source);
    return store.get<Question>(plan.id)!.value.answer!;
  };
  return {...f,base,runtime,v,environment,command,run,wires,generationCalls,configure,mode,initial,nextEdition};
}
const money = (store: Store) => [...store.identities('list','model-call'),...store.identities('list','research-budget-ledger')]
  .flatMap(row=>store.history(row.id));
function choiceScope(f: ReturnType<typeof bind>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
  const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  const set = f.store.get<VariantSet>(state.value.set!.id, state.value.set!.revision)!;
  return { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set),
    mode: reference(f.store.get('project-mode:p')!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: kind === 'choose' ? { kind, member: set.value.members[0]!, reason: 'Authorized owner chooses the member' }
      : { kind, reason: 'Authorized owner rejects the exact set' } };
}
function owner(store: Store, scope: VariantChoiceScope) {
  const sessions = new VariantChoiceSessions(store), issued = issueVariantChoiceInvitation(store, scope);
  assert.ok(issued.ok); if (!issued.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
  assert.ok(login.ok); if (!login.ok) assert.fail('Expected successful owner exchange');
  const act = answerVariantChoice(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok); return act;
}

const deepCalls = (f: ReturnType<typeof bind>) => f.wires().filter(row => row.subject.deepPreparation);
const deepIntents = (store: Store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => Object.hasOwn(row.value.cursor, 'deepPreparation'));
async function inert(f: ReturnType<typeof bind>, store: Store, action: () => Promise<unknown>) {
  const paid=money(store),wire=f.wires();
  const result=await storeUnchanged(store,action);
  assert.deepEqual(money(store),paid);assert.deepEqual(f.wires(),wire);return result;
}
type SavedWorld={base:Base;snapshot:string;scope:Ref;pending:Revision<ResearchRun>};
const readyWorlds=new Map<string,SavedWorld>();
/** Cache only the real producer prefix. Each test receives a byte-for-byte SQLite
 * copy and separate mutable runtime files; the original environment/actor/Ref
 * history and immutable adapter code are untouched. Tests in this file run serially. */
async function ready(t:test.TestContext,model=false,config:Record<string,unknown>={}){
  const key=canonical(model);let seed=readyWorlds.get(key);
  if(!seed){
    const base=await build(undefined,model?'bypass':'questions'),closing:Array<()=>void>=[];
    const f=bind({after:fn=>closing.push(fn)},base);
    const made=await readyIn(f,model);
    for(const close of closing)close();
    const snapshot=mkdtempSync(join(tmpdir(),'omg-budget-reentry-prefix-'));
    seedCleanup.push(()=>rmSync(snapshot,{recursive:true,force:true}));
    for(const name of ['state.sqlite','settings.json','wire.ndjson'])copyFileSync(join(base.root,name),join(snapshot,name));
    seed={base,snapshot,scope:structuredClone(made.scope),pending:structuredClone(made.pending)};
    readyWorlds.set(key,seed);
  }
  const f=copyWorld(t,seed);f.configure(config);return f;
}
function copyWorld(t:test.TestContext,seed:SavedWorld){
  const runtime=mkdtempSync(join(tmpdir(),'omg-budget-reentry-world-')),closing:Array<()=>void>=[];
  t.after(()=>{for(const close of closing)close();rmSync(runtime,{recursive:true,force:true});});
  for(const name of ['state.sqlite','settings.json','wire.ndjson'])copyFileSync(join(seed.snapshot,name),join(runtime,name));
  return {...bind({after:fn=>closing.push(fn)},seed.base,join(runtime,'state.sqlite'),runtime),
    scope:structuredClone(seed.scope),pending:structuredClone(seed.pending)};
}
async function saveWorld(f:Awaited<ReturnType<typeof ready>>):Promise<SavedWorld>{
  const snapshot=mkdtempSync(join(tmpdir(),'omg-budget-reentry-paid-prefix-'));
  seedCleanup.push(()=>rmSync(snapshot,{recursive:true,force:true}));
  const source=new DatabaseSync(f.path,{readOnly:true});
  try{await backup(source,join(snapshot,'state.sqlite'));}finally{source.close();}
  for(const name of ['settings.json','wire.ndjson'])copyFileSync(join(f.runtime,name),join(snapshot,name));
  return {base:f.base,snapshot,scope:structuredClone(f.scope),pending:structuredClone(f.pending)};
}
async function readyIn(f:ReturnType<typeof bind>,model:boolean){
  const generated=await f.run(3);
  assert.equal(generated.value.pauseCode,model?'research_turns_exhausted':'research_variant_owner_required',generated.value.error!);
  if(model)await f.run(1);else owner(f.store,choiceScope(f));
  const pending=await f.run(1,f.store,true), details=JSON.parse(pending.value.error!);
  assert.equal(pending.value.pauseCode,'research_deep_frontier_pending',pending.value.error!);
  const handoff=(await readVariantHandoff(f.store,'p',details.handoff)).record;
  assert.equal(handoff.value.next,'deep');assert.deepEqual(handoff.value.scope,details.scope);
  assert.deepEqual(reference(readVariantScope(f.store,'p',details.scope).scope),details.scope);
  return {...f,scope:details.scope as Ref,pending};
}


const stoppedWorlds = new Map<number, SavedWorld>();
async function stopped(t: test.TestContext, tokens = 18_000_000) {
  let seed = stoppedWorlds.get(tokens);
  let f: Awaited<ReturnType<typeof ready>>;
  if (!seed) {
    f = await ready(t);
    f.configure({ assessorTokens: tokens });
    const result = await f.run(2);
    assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', result.value.error!);
    const details = JSON.parse(result.value.error!);
    const stop = await readDeepFrontierStop(f.store, 'p', details.stop);
    assert.equal(stop.record.value.reason, 'budget');
    assert.equal(stop.coverage.missing.length, 1);
    assert.equal(deepCalls(f).length, 1);
    // The next reviewer is calibrated through a real v6 call: the unusually
    // expensive old MR remains fully charged, but is not a forecast for this role.
    f.configure({ assessorTokens: 10, close: false, outcome: 'open' });
    const environment = f.engine.environments.configure('p', { ...f.environment.value,
      reviewer: { ...f.environment.value.reviewer, model: 'next-reviewer' } }, f.environment.revision);
    const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
      [{ field: 'probe', kind: 'fact', prompt: 'Calibrate next reviewer', risk: 'unknown', schema: { type: 'object' } }], [], 6);
    await researchCall(environment.value.reviewer, environment.value, 'Calibrate', {}, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'assessor' });
    seed = await saveWorld(f); stoppedWorlds.set(tokens, seed);
  } else f = copyWorld(t, seed);
  const original = f.store.get<ResearchRun>(f.pending.id)!, details = JSON.parse(original.value.error!);
  return { ...f, original, details };
}
type Stopped = Awaited<ReturnType<typeof stopped>>;
function increase(f: Stopped, limit = 24_000_000, store = f.store) {
  const segment = readEffectiveStageBudget(store, 'p').segment!;
  const scope = { project: 'p', stage: 'discovery' as const, previous: reference(segment), limit };
  const invitation = issueStageBudgetInvitation(store, scope); assert.ok(invitation.ok);
  const sessions = new StageBudgetSessions(store);
  const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok);
  const raised = increaseStageBudget(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok);
  return raised;
}
function driver(f: Stopped, store = f.store, maxTurns = 1, maxCalls = 2) {
  return new EarlyStageDriver(new ProductEngine(store), new BudgetReentry({ discovery: 7 }))
    .run({ project: 'p', draftId: f.v.draft.id, maxTurns, maxCalls });
}
async function forecastRefusal(f: Stopped, door: 'driver' | 'researcher', code: string, store = f.store) {
  if (door === 'driver') {
    const result = await driver(f, store);
    assert.equal(result.reason?.code, code, JSON.stringify(result.reason));
    assert.equal(result.reason?.target, f.v.draft.id); assert.equal(result.budget.callsMade, 0);
    assert.equal(result.reason?.handoff, undefined); assert.equal(result.reason?.next, undefined);
    return result.reason!.message;
  }
  let message: string | undefined;
  await assert.rejects(f.run(1, store), (error: unknown) => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, code);
    message = error.message; return true;
  });
  assert.ok(message); return message;
}
async function refusedByBothDoors(f: Stopped, code: string) {
  const paid = money(f.store), wire = f.wires();
  const message = await forecastRefusal(f, 'researcher', code);
  const paused = f.store.get<ResearchRun>(f.original.id)!;
  const intent = deepIntents(f.store).find(row => row.value.kind === 'analyst'
    && row.value.cursor.subject?.planQuestionId === 'q-two')!;
  assert.ok(intent); assert.equal(intent.value.state, 'prepared');
  assert.equal(intent.value.call, null); assert.equal(intent.value.request, null);
  assert.deepEqual(intent.value.owner, reference(paused));
  assert.equal(await forecastRefusal(f, 'driver', code, f.open()), message);
  assert.equal(await inert(f, f.store, () => forecastRefusal(f, 'researcher', code, f.open())), message);
  assert.equal(await forecastRefusal(f, 'driver', code, f.open()), message);
  assert.deepEqual(reference(f.store.get<ResearchRun>(paused.id)!), reference(paused));
  assert.deepEqual(reference(f.store.get<ResearchConsumerIntent>(intent.id)!), reference(intent));
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  return { paused, intent, message };
}
async function continueBothDoors(t: test.TestContext, f: Stopped, intent: Revision<ResearchConsumerIntent>,
  increases: ReturnType<typeof readEffectiveStageBudget>['increases']) {
  // Each door starts from the same genuine, calibrated unpaid checkpoint, in
  // its own SQLite and runtime copy. The hot run uses the original open Store.
  const seed = await saveWorld(f);
  const check = async (world: Stopped) => {
    assertAdvanced(world, 1);
    assert.equal(world.store.list<ModelCall>('model-call').filter(row => row.value.consumerIntent?.id === intent.id).length, 1);
    assert.deepEqual(readEffectiveStageBudget(world.store, 'p').increases, increases);
    await oldSnapshot(world);
  };
  await f.run(1); await check(f);
  const cold = { ...copyWorld(t, seed), original: f.original, details: f.details };
  await cold.run(1, cold.open()); await check(cold);
  const driven = { ...copyWorld(t, seed), original: f.original, details: f.details };
  const outcome = await driver(driven, driven.open());
  assert.equal(outcome.budget.callsMade, 2, JSON.stringify(outcome.reason));
  await check(driven);
}
async function oldSnapshot(f: Stopped, store = f.store) {
  const before = history(store), wire = f.wires();
  const proof = await readPartialDossier(store, 'p', f.details.dossier);
  assert.deepEqual(reference(proof.stop!), f.details.stop);
  assert.deepEqual(reference(proof.record), f.details.dossier);
  assert.deepEqual(store.get(f.original.id, f.original.revision), f.original);
  assert.equal(history(store), before); assert.deepEqual(f.wires(), wire);
}
function assertAdvanced(f: Stopped, paid: number) {
  const calls = deepCalls(f);
  assert.equal(calls.length, paid + 1);
  assert.equal(calls.at(-1).subject.deepCell.subject.planQuestionId, 'q-two');
  const frontier = deepPlanSelection(f.store, 'p', f.scope);
  const first = frontier.progress.find(row => row.question === 'q-one')!;
  const second = frontier.progress.find(row => row.question === 'q-two')!;
  assert.ok(first.state); assert.ok(second.state);
  return frontier;
}
for (const door of ['researcher', 'driver'] as const) test(`budget re-entry: ${door} uses the proved later owner increase; paid progress and old snapshot survive hot/cold`, async t => {
  const f = await stopped(t), before = readEffectiveStageBudget(f.store, 'p').segment!;
  const oldUsage = budgetUsage(f.store, before), paid = deepCalls(f).length;
  const oldProgress = deepPlanSelection(f.store, 'p', f.scope).progress;
  const oldCalls = money(f.store).filter(row => row.kind === 'model-call').map(reference);
  const raised = increase(f);
  assert.equal(raised.segment.value.initialGroupLimit, before.value.initialGroupLimit);
  assert.equal(raised.segment.value.completionReserve, 2_000_000);
  assert.deepEqual(budgetUsage(f.store, raised.segment), { ...oldUsage, guards: [reference(raised.segment), ...oldUsage.guards.slice(1)], remaining: oldUsage.remaining + 4_000_000 });
  await inert(f, f.store, async () => assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), true));
  // Driver is deliberately cold after the increase; Researcher uses the live Store.
  const store = door === 'driver' ? f.open() : f.store;
  if (door === 'driver') {
    const result = await driver(f, store); assert.equal(result.end, 'stage_paused');
    assert.equal(result.budget.turnsUsed, 1); assert.equal(result.budget.callsMade, 2); assert.equal(result.budget.callsRemaining, 0);
  } else await f.run(1, store);
  const progress = assertAdvanced(f, paid).progress;
  assert.deepEqual(progress.find(row => row.question === 'q-one'), oldProgress.find(row => row.question === 'q-one'));
  assert.equal(progress.find(row => row.question === 'q-two')!.summary!.count,
    oldProgress.find(row => row.question === 'q-two')!.summary!.count + 1);
  const latest = deepIntents(f.store).find(row => row.value.cursor.subject?.planQuestionId === 'q-two')!;
  assert.equal(latest.value.cursor.run, f.original.id);
  assert.equal(latest.value.cursor.turn, f.original.value.turns + 1);
  for (const ref of oldCalls) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref);
  assert.ok(budgetUsage(f.store, readEffectiveStageBudget(f.store, 'p').segment!).measured > oldUsage.measured);
  await oldSnapshot(f); await oldSnapshot(f, f.open());
  // Recovery alone cannot use the new allowance to buy a third deep position.
  await f.run(1, f.store, true);
  assert.equal(deepCalls(f).length, paid + 1);
  if (door === 'driver') {
    // The first bounded invocation leaves the selected cell open. A second
    // cold driver invocation must continue this exact stopped route.
    const first = f.store.get<ResearchRun>(f.original.id)!;
    assert.equal(first.value.pauseCode, 'research_deep_frontier_pending');
    const again = await driver(f, f.open());
    assert.equal(again.budget.turnsUsed, 1); assert.equal(again.budget.callsMade, 2);
    assert.equal(deepCalls(f).length, paid + 2);
    const next = deepIntents(f.store).find(row => row.value.cursor.turn === first.value.turns + 1)!;
    assert.equal(next.value.cursor.run, f.original.id);
    assert.equal(next.value.cursor.subject?.planQuestionId, 'q-two');
    await oldSnapshot(f, f.open());
    const oldPaid = money(f.store), oldWire = f.wires();
    f.nextEdition();
    const afterEdition = money(f.store), afterEditionWire = f.wires();
    assert.deepEqual(afterEdition, oldPaid); assert.deepEqual(afterEditionWire, oldWire);
    const changed = await driver(f, f.open());
    assert.equal(changed.budget.callsMade, 0);
    assert.deepEqual(money(f.store), afterEdition); assert.deepEqual(f.wires(), afterEditionWire);
  }
});

test('budget re-entry: working group stays blocked after owner increase and resumes only after its own Optimization', async t => {
  const f = await stopped(t, 20_000_000), raised = increase(f);
  const usage = budgetUsage(f.store, raised.segment), paid = deepCalls(f).length;
  assert.ok(usage.measured > 20_000_000);
  await inert(f, f.store, async () => {
    assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), false);
    assert.deepEqual(await f.run(1), f.original);
    assert.equal((await driver(f)).reason?.dossier?.hash, f.details.dossier.hash);
  });
  const required = usage.measured + 100_000;
  raiseWorkingLimit(f.store, raised.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', raised.segment.value.initialGroupLimit,
    { reason: 'One missing exact deep cell', progress: 'The first cell has a paid applied P', required,
      options: [{ method: 'Reuse the paid first cell', saved: 0, decision: 'accept', quality: 'No evidence removed', preserved: ['q-two'] }],
      obligations: ['q-two'], forecast: 'A calibrated deep call and its calibrated MR', basis: [f.details.stop] }, 24_000_000);
  await f.run(1, f.open()); assertAdvanced(f, paid);
  await oldSnapshot(f);
});

test('budget re-entry: a forecast over the working group preserves the unpaid owner until its own increase', async t => {
  const f = await stopped(t), raised = increase(f);
  // One real measured v6 call establishes the forecast for both public doors.
  const environment = f.engine.environments.effective('p').environment;
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Measure analyst', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  f.configure({ analystTokens: 2_000_000 });
  await researchCall(environment.value.implementer, environment.value, 'Measure analyst ' + 'x'.repeat(80_000), {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  f.configure({ analystTokens: 10 });
  const { intent } = await refusedByBothDoors(f, 'discovery_budget_reserve');
  const usage = budgetUsage(f.store, raised.segment);
  const beforeIncreases = readEffectiveStageBudget(f.store, 'p').increases;
  raiseWorkingLimit(f.store, raised.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', raised.segment.value.initialGroupLimit,
    { reason: 'The measured next analyst exceeds the old group', progress: 'The exact first cell is paid',
      required: usage.measured + 3_000_000,
      options: [{ method: 'Reuse the paid first cell', saved: 0, decision: 'accept', quality: 'No evidence removed', preserved: ['q-two'] }],
      obligations: ['q-two'], forecast: 'The measured analyst and its calibrated MR', basis: [f.details.stop] }, 24_000_000);
  await continueBothDoors(t, f, intent, beforeIncreases);
});

test('budget re-entry: a paid analyst survives an MR working-limit pause until the remaining MR is admitted', async t => {
  const f = await stopped(t), raised = increase(f);
  const environment = f.engine.environments.effective('p').environment;
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Measure pending reviewer', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  // Real reviewer calibration makes its reserve exceed the group while the
  // analyst still fits. The old analyst stays paid throughout recovery.
  f.configure({ analystTokens: 2_000_000 });
  await researchCall(environment.value.reviewer, environment.value,
    'Measure pending reviewer ' + 'x'.repeat(200_000), {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'assessor' });
  f.configure({ analystTokens: 10, assessorTokens: 10 });
  const before = deepCalls(f).length;
  const assessments = () => f.wires().filter(row => row.subject.assessmentSubject);
  const beforeAssessments = assessments().length;
  const first = await driver(f);
  const paused = f.store.get<ResearchRun>(f.original.id)!;
  const usage = budgetUsage(f.store, raised.segment);
  const afterAnalyst = deepCalls(f);
  assert.equal(first.budget.callsMade, 1);
  assert.equal(afterAnalyst.length, before + 1);
  assert.equal(assessments().length, beforeAssessments);
  assert.equal(paused.value.pauseCode, 'discovery_budget_reserve');
  assert.equal(JSON.parse(paused.value.error!).details.cause, 'budget_question_limit');
  const paidDeep = afterAnalyst.at(-1), paid = money(f.store), wire = f.wires();
  const analyst = deepIntents(f.store).find(row => row.value.kind === 'analyst'
    && row.value.cursor.subject?.planQuestionId === 'q-two')!;
  assert.ok(analyst); assert.equal(analyst.value.state, 'applied');
  const analystCalls = f.store.list<ModelCall>('model-call').filter(row => row.value.consumerIntent?.id === analyst.id);
  assert.equal(analystCalls.length, 1);
  const increaseRefs = readEffectiveStageBudget(f.store, 'p').increases;
  // Neither the default driver nor a second invocation while the working
  // limit remains blocked may acquire a fresh analyst or reviewer call.
  const disabled = await new ProductEngine(f.open()).earlyStages.run({ project: 'p', draftId: f.v.draft.id, maxTurns: 1, maxCalls: 2 });
  assert.equal(disabled.budget.callsMade, 0);
  const blocked = await driver(f, f.open());
  assert.equal(blocked.budget.callsMade, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  raiseWorkingLimit(f.store, raised.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', raised.segment.value.initialGroupLimit,
    { reason: 'The already paid analyst needs its measured MR', progress: 'q-two analyst is paid; no MR was sent',
      required: usage.measured + 3_000_000,
      options: [{ method: 'Reuse the exact paid analyst', saved: 0, decision: 'accept', quality: 'Keep the full paid answer', preserved: ['q-two'] }],
      obligations: ['q-two'], forecast: 'The measured reviewer requires 2.2M reserve', basis: [f.details.stop] }, 24_000_000);
  const resumed = await driver(f, f.open(), 1, 1);
  const afterReviewer = deepCalls(f);
  assert.equal(resumed.budget.callsMade, 1, JSON.stringify(resumed.reason));
  assert.equal(assessments().length, beforeAssessments + 1);
  assert.equal(afterReviewer.length, before + 1);
  assert.deepEqual(afterReviewer.at(-1), paidDeep);
  assert.deepEqual(f.store.get<ResearchConsumerIntent>(analyst.id), analyst);
  assert.deepEqual(f.store.list<ModelCall>('model-call').filter(row => row.value.consumerIntent?.id === analyst.id), analystCalls);
  assert.deepEqual(f.wires().slice(0, wire.length), wire);
  assert.deepEqual(readEffectiveStageBudget(f.store, 'p').increases, increaseRefs);
  assertAdvanced(f, before); await oldSnapshot(f, f.open());
});

test('budget re-entry: no owner increase, new plan/allowance, restoreOnly and zero driver allowances cannot buy research', async t => {
  const f = await stopped(t);
  // Exact old D6 pauses are inert in restoreOnly. A normal invocation may now
  // spend the completion reserve on D6, while the ordinary driver and the
  // re-entry reader below must still reject another research purchase.
  await inert(f, f.store, async () => {
    assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), false);
    assert.deepEqual(await f.run(20, f.store, true), f.original);
    await driver(f); assert.equal(deepCalls(f).length, 1);
  });
  const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  owner(f.store, { ...choiceScope(f), operation: 'revise', previous: state.value.decision!, expectedSelection: reference(state) });
  await inert(f, f.store, async () => assert.deepEqual(await f.run(20, f.store, true), f.original));
  increase(f);
  await inert(f, f.store, async () => {
    assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), false);
    assert.deepEqual(await f.run(1, f.store, true), f.original);
    assert.equal((await driver(f)).budget.callsMade, 0);
  });
  f.nextEdition();
  await inert(f, f.store, async () => {
    assert.deepEqual(await f.run(1, f.store, true), f.original);
    assert.equal((await driver(f)).budget.callsMade, 0);
    assert.deepEqual(await f.run(1, f.store, true), f.original);
    await driver(f, f.store, 0, 2); await driver(f, f.open(), 1, 0);
    await assert.rejects(f.run(0), { code: 'research_budget_invalid' });
  });
});

test('budget re-entry: forged, absent and foreign increase chains refuse without history, money or wire changes', async t => {
  for (const corruption of ['no-act', 'foreign-act', 'missing-authority'] as const) {
    const f = await stopped(t);
    const previous = readEffectiveStageBudget(f.store, 'p').segment!;
    if (corruption === 'no-act') f.store.write({ id: previous.id, kind: previous.kind, expected: previous.revision,
      value: { ...previous.value, limit: 24_000_000 } });
    else {
      const raised = increase(f);
      // Append an untrusted policy revision and its forged first act. Historical
      // accepted revisions are untouched; a later head cannot authorize itself.
      const body = { ...raised.segment.value, limit: 25_000_000 };
      const next = { id: raised.segment.id, revision: raised.segment.revision + 1, hash: hashJson(body) };
      const value = { ...raised.increase.value, previous: reference(raised.segment), segment: next, limit: body.limit } as any;
      if (corruption === 'foreign-act') value.project = 'foreign-project';
      else delete value.authority;
      f.store.writeMany([{ id: raised.segment.id, kind: raised.segment.kind, expected: raised.segment.revision, value: body },
        { id: stageBudgetIncreaseId('p', next.revision), kind: raised.increase.kind, expected: 0, value }]);
    }
    const store = corruption === 'no-act' ? f.store : f.open();
    await inert(f, store, async () => {
      await assert.rejects(f.run(1, store), error => /^discovery_budget_/.test((error as any).code));
      const result = await driver(f, store);
      assert.match(result.reason?.code ?? '', /^discovery_budget_/);
    });
  }
});

test('budget re-entry: a cut after the paid MR restores its original P before another send', async t => {
  const f = await stopped(t); increase(f);
  let cut = false;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    if (!cut && writes.some(row => row.kind === 'v7-progress-application')) {
      cut = true; throw new Error('budget re-entry cut before P');
    }
    return commit();
  });
  await f.run(1); restore(); assert.ok(cut);
  const intents = deepIntents(f.store), paid = money(f.store), wire = f.wires();
  assert.equal(deepCalls(f).length, 2);
  const held = acquireRunExecution(f.store, { project: 'p' }); assert.ok(held.ok);
  releaseRunExecution(f.store, held.value);
  const cold = f.open();
  await withResearchRunControl(cold, 'p', held.value.hold, () => f.run(1, cold, true));
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  assert.deepEqual(deepIntents(f.store).map(row => row.id), intents.map(row => row.id));
  const frontier = deepPlanSelection(f.store, 'p', f.scope);
  assert.ok(frontier.progress.find(row => row.question === 'q-two')!.state);
  await oldSnapshot(f);
});

test('budget re-entry: second Store changes the stage segment before reservation; no new purchase escapes its guard', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(); let raced = false, paid: unknown, wire: unknown;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    if (!raced && writes.some(row => row.kind === 'model-call' && row.expected === 0)) {
      raced = true; increase(f, 25_000_000, other);
      paid = money(other); wire = f.wires();
    }
    return commit();
  });
  await assert.rejects(f.run(1), error => ['input_stale', 'revision_conflict'].includes((error as any).code));
  restore(); assert.ok(raced);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  assert.equal(deepCalls(f).length, 1);
  // A fresh invocation may admit the same still-unpaid original position.
  await f.run(1, f.open()); assertAdvanced(f, 1);
  await oldSnapshot(f);
});

test('budget re-entry: owner permission cannot replace the real dispatch forecast', async t => {
  const f = await stopped(t); increase(f);
  const current = f.engine.environments.effective('p').environment;
  const uncalibrated = f.engine.environments.configure('p', { ...current.value,
    implementer: { ...current.value.implementer, model: 'uncalibrated-owner-reentry' } }, current.revision);
  assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), true);
  const { paused, intent, message } = await refusedByBothDoors(f, 'budget_estimate_missing');
  assert.match(message, /No comparable measured calls/);
  assert.equal(paused.value.pauseCode, 'research_deep_frontier_pending', paused.value.error!);
  assert.equal(deepCalls(f).length, 1);
  // Calibrate the same actor/model once through ordinary paid transport. The
  // saved checkpoint and exact owner then feed both independent public doors.
  const beforeIncreases = readEffectiveStageBudget(f.store, 'p').increases;
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Calibrate next analyst', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  await researchCall(uncalibrated.value.implementer, uncalibrated.value, 'Calibrate', {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  await continueBothDoors(t, f, intent, beforeIncreases);
});

test('budget re-entry: an ordinary v7 forecast refusal does not use the stopped-route exception', async t => {
  const f = await ready(t);
  const current = f.engine.environments.effective('p').environment;
  f.engine.environments.configure('p', { ...current.value,
    implementer: { ...current.value.implementer, model: 'uncalibrated-ordinary-v7' } }, current.revision);
  const paid = money(f.store), wire = f.wires();
  const result = await f.run(1);
  assert.equal(result.value.pauseCode, 'budget_estimate_missing');
  assert.equal(Object.hasOwn(result.value, 'budgetReentry'), false);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
});

test('budget re-entry: one-call invocations recover the same paid deep step without paying for it again', async t => {
  const f = await stopped(t); increase(f);
  const first = await driver(f, f.store, 1, 1);
  const firstDeep = deepCalls(f);
  assert.equal(first.budget.callsMade, 1); assert.equal(firstDeep.length, 2);
  const intents = deepIntents(f.store).filter(row => row.value.kind === 'analyst'
    && row.value.cursor.subject?.planQuestionId === 'q-two');
  assert.equal(intents.length, 1); const intent = intents[0]!;
  const call = f.store.list<ModelCall>('model-call').find(row => row.value.consumerIntent?.id === intent.id);
  assert.ok(call); const deep = firstDeep.at(-1);
  const second = await driver(f, f.open(), 1, 1);
  const recoveredDeep = deepCalls(f);
  assert.equal(second.budget.callsMade, 1); assert.equal(recoveredDeep.length, 2);
  assert.deepEqual(recoveredDeep.at(-1), deep);
  const recovered = f.store.get<ResearchConsumerIntent>(intent.id)!;
  assert.ok(recovered); assert.deepEqual(recovered.value.cursor, intent.value.cursor);
  assert.equal(f.store.list<ModelCall>('model-call').filter(row => row.value.consumerIntent?.id === intent.id).length, 1);
  assert.equal(f.store.list<ModelCall>('model-call').find(row => row.value.consumerIntent?.id === intent.id)!.id, call.id);
  assertAdvanced(f, 1); await oldSnapshot(f, f.open());
});

test('budget re-entry: only the immutable constructor policy opts in; a request policy cannot enable the default driver', async t => {
  const f = await stopped(t); increase(f);
  const request = { project: 'p', draftId: f.v.draft.id, maxTurns: 1, maxCalls: 2, producerPolicy: { discovery: 7 } };
  const disabled = { discovery: 6 }, configured = new EarlyStageDriver(new ProductEngine(f.store), new BudgetReentry(disabled));
  disabled.discovery = 7;
  await inert(f, f.store, async () => {
    const plain = await new ProductEngine(f.store).earlyStages.run(request);
    assert.equal(plain.reason?.dossier?.hash, f.details.dossier.hash);
    assert.equal(plain.budget.callsMade, 0);
    assert.equal((await configured.run(request)).budget.callsMade, 0);
  });
  const enabled = { discovery: 7 }, admitted = new EarlyStageDriver(new ProductEngine(f.store), new BudgetReentry(enabled));
  enabled.discovery = 6;
  const outcome = await admitted.run({ project: 'p', draftId: f.v.draft.id, maxTurns: 1, maxCalls: 2 });
  assert.equal(outcome.budget.turnsUsed, 1); assert.equal(outcome.budget.callsMade, 2);
  assertAdvanced(f, 1);
});

test('budget re-entry: explicit policy respects stopped and busy control without another sender', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(), held = acquireRunExecution(other, { project: 'p' }); assert.ok(held.ok);
  await inert(f, f.store, async () => {
    const busy = await driver(f); assert.equal(busy.end, 'busy'); assert.equal(busy.budget.callsMade, 0);
  });
  releaseRunExecution(other, held.value);
  assert.ok(stopRun(other, { project: 'p' }).ok);
  await inert(f, f.store, async () => {
    const stopped = await driver(f); assert.equal(stopped.end, 'stopped'); assert.equal(stopped.budget.callsMade, 0);
  });
});

test('budget re-entry: a second Store stop at reservation preserves the original hold and buys nothing', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(); let fired = false, paid: unknown, wire: unknown;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    if (!fired && writes.some(row => row.kind === 'model-call' && row.expected === 0)) {
      fired = true; assert.ok(stopRun(other, { project: 'p' }).ok);
      paid = money(other); wire = f.wires();
    }
    return commit();
  });
  const result = await driver(f); restore(); assert.ok(fired);
  assert.equal(result.end, 'stopped'); assert.equal(result.reason?.code, 'run_stopped');
  assert.equal(result.budget.callsMade, 0); assert.equal(result.budget.turnsUsed, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  await oldSnapshot(f);
});

test('budget re-entry: a second Store releasing the hold during preparation cannot authorize a new send', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(), paid = money(f.store), wire = f.wires(); let fired = false;
  const restore = interceptWrites(t, f.store, (_writes, commit) => {
    const rows = commit();
    if (!fired && rows.some(row => row.kind === 'research-consumer-intent' && (row.value as any).cursor.deepPreparation)) {
      fired = true;
      const control = readRunControl(other, { project: 'p' }); assert.ok(control.ok);
      const head = control.value.control!;
      releaseRunExecution(other, { hold: { project: 'p', control: reference(head) }, executor: head.value.execution! });
    }
    return rows;
  });
  const result = await driver(f); restore(); assert.ok(fired);
  assert.equal(result.reason?.code, 'run_control_changed');
  assert.equal(result.budget.callsMade, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  const pending = deepIntents(f.store).find(row => row.value.cursor.subject?.planQuestionId === 'q-two')!;
  assert.equal(pending.value.state, 'prepared');
  // A new owner recovers exactly that unpaid preparation. The finished scope
  // must not constrain the independent invocation, nor be saved in the intent.
  const resumed = await driver(f, f.open());
  assert.equal(resumed.budget.callsMade, 2); assertAdvanced(f, 1);
  assert.equal(deepIntents(f.store).find(row => row.value.cursor.subject?.planQuestionId === 'q-two')!.id, pending.id);
});

test('budget re-entry: the explicit constructor policy alone cannot start arbitrary v7 work', async t => {
  const f = await ready(t), paid = money(f.store), wire = f.wires();
  const handoff = JSON.parse(f.pending.value.error!).handoff;
  const result = await new EarlyStageDriver(new ProductEngine(f.store), new BudgetReentry({ discovery: 7 }))
    .run({ project: 'p', draftId: f.v.draft.id, maxTurns: 5, maxCalls: 10 });
  assert.equal(result.budget.callsMade, 0); assert.equal(result.budget.turnsUsed, 0);
  assert.deepEqual(result.reason?.handoff, handoff);
  assert.equal(result.reason?.next, 'deep'); assert.equal(result.reason?.target, 'deep');
  assert.equal(result.stageResult?.discovery?.state, 'researching');
  const cold = await new EarlyStageDriver(new ProductEngine(f.open()))
    .run({ project: 'p', draftId: f.v.draft.id, maxTurns: 5, maxCalls: 10 });
  assert.deepEqual(cold.reason?.handoff, handoff);
  assert.equal(cold.reason?.next, 'deep'); assert.equal(cold.reason?.target, 'deep');
  assert.equal(cold.stageResult?.discovery?.state, 'researching');
  assert.equal(cold.budget.callsMade, 0); assert.equal(cold.budget.turnsUsed, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);

  // A genuine negative partial dossier has no deep stop. The opt-in must leave
  // this historical result alone rather than treating it as a budget re-entry.
  const negative = bind(t, await build()); negative.configure({ none: true });
  const partial = await negative.run(3);
  assert.equal(partial.value.pauseCode, 'research_dossier_assessment_unavailable');
  const saved = JSON.parse(partial.value.error!);
  assert.equal(saved.stop, undefined);
  const optIn = new BudgetReentry({ discovery: 7 });
  await inert(negative, negative.store, async () => {
    const currentDraft = negative.store.get<DiscoveryDraft>(negative.v.draft.id)!;
    assert.equal(await optIn.eligible(negative.store, 'p', currentDraft, partial), false);
    const restored = await new EarlyStageDriver(new ProductEngine(negative.store), optIn)
      .run({ project: 'p', draftId: negative.v.draft.id, maxTurns: 5, maxCalls: 10 });
    assert.deepEqual(restored.reason?.handoff, saved.handoff);
    assert.deepEqual(restored.reason?.dossier, saved.dossier);
    assert.equal(restored.reason?.completeness, 'partial');
    assert.equal(restored.budget.callsMade, 0); assert.equal(restored.budget.turnsUsed, 0);
  });
});

test('budget re-entry: control scope binds Store/project, snapshots the hold, rejects nesting and expires without leaking', async t => {
  const f = await ready(t), other = f.open();
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Scope transport probe', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  // The ordinary public packer saves the context before control admits a new
  // dispatch. Keep that legitimate preparation outside the no-write window.
  prepareResearchEnvelope(f.environment.value.implementer, f.environment.value, 'Scope probe', {},
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  const send = (store = f.store) => researchCall(f.environment.value.implementer, f.environment.value, 'Scope probe', {}, undefined,
    { store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  const acquired = acquireRunExecution(f.store, { project: 'p' }); assert.ok(acquired.ok);
  const hold = structuredClone(acquired.value.hold);
  const before = history(f.store);
  await inert(f, f.store, async () => {
    await assert.rejects(withResearchRunControl(other, 'p', hold, () => send()), { code: 'run_control_changed' });
    await assert.rejects(withResearchRunControl(f.store, 'foreign', { project: 'foreign', control: null }, () => send()), { code: 'run_control_changed' });
    await assert.rejects(withResearchRunControl(f.store, 'p', null as never, () => send()), { code: 'run_control_request_invalid' });
    await assert.rejects(withResearchRunControl(f.store, 'p', { project: 'p' } as never, () => send()), { code: 'run_control_request_invalid' });
    await assert.rejects(withResearchRunControl(f.store, 'p', { ...hold, extra: true } as never, () => send()),
      { code: 'run_control_request_invalid' });
  });
  assert.equal(history(f.store), before);
  await withResearchRunControl(f.store, 'p', hold, async () => {
    releaseRunExecution(other, acquired.value);
    const fresh = acquireRunExecution(other, { project: 'p' }); assert.ok(fresh.ok);
    // Mutating both the outer object and its Ref cannot upgrade the saved hold.
    Object.assign(hold.control!, fresh.value.hold.control!);
    Object.assign(hold, fresh.value.hold);
    const unchanged = history(f.store);
    await inert(f, f.store, async () => {
      await assert.rejects(send(), { code: 'run_control_changed' });
      await assert.rejects(withResearchRunControl(f.store, 'p', fresh.value.hold, () => send()), { code: 'run_control_changed' });
    });
    assert.equal(history(f.store), unchanged);
    releaseRunExecution(other, fresh.value);
  });
  // An async child retaining the ALS object after its invocation is over does
  // not retain dispatch authority. This uses an explicit promise, no timer.
  const latest = acquireRunExecution(f.store, { project: 'p' }); assert.ok(latest.ok);
  let start!: () => void;
  const released = new Promise<void>(resolve => { start = resolve; });
  let child!: Promise<unknown>;
  await withResearchRunControl(f.store, 'p', latest.value.hold, async () => {
    child = released.then(() => send());
  });
  await inert(f, f.store, async () => {
    const refused = assert.rejects(child, { code: 'run_control_changed' }); start(); await refused;
  });
  const wire = f.wires().length;
  await send(); assert.equal(f.wires().length, wire + 1, 'the later independent call has no finished scope');
  releaseRunExecution(f.store, latest.value);
});

test('budget re-entry: claimed dossier dispatch retains the original hold through authorization; paid recovery ignores a later loss', async t => {
  const f = await stopped(t); increase(f);
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', f.details.dossier);
  const bases = [{ record: packet.manifest.ref }];
  const reply: DossierAssessmentResult = { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: packet.subject, verdict: 'return',
    reasons: ['The historical budget stop retains its missing material'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(dimension => [dimension,
      { judgement: 'adequate', reason: `Assessed ${dimension}`, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(item => item.address), unknowns: packet.unknowns.map(item => item.unknown.claim),
      contradictions: packet.contradictions.map(item => ({ id: item.contradiction.id,
        sides: item.sides.map(side => side.address) as [import('../src/discovery/claim-address.js').ClaimAddress, import('../src/discovery/claim-address.js').ClaimAddress],
        grounds: item.grounds.map(record => record.ref) })) },
    return: { targets: [{ partialReason: 0 }], reason: 'Continue the missing cell', bases } };
  f.configure({ dossierReply: reply });
  const original = acquireRunExecution(f.store, { project: 'p' }); assert.ok(original.ok);
  let cut = false;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    const rows = commit();
    if (!cut && writes.some(row => row.kind === 'model-call' && (row.value as ModelCall).purpose === 'dossier-assessor')) {
      cut = true; throw new Error('cut after dossier reservation');
    }
    return rows;
  });
  const environment = f.engine.environments.effective('p').environment;
  await assert.rejects(withResearchRunControl(f.store, 'p', original.value.hold,
    () => runDossierAssessmentSession(f.store, 'p', packet.subject, environment)), /cut after dossier reservation/);
  restore(); assert.ok(cut);
  const claim = f.store.list<ModelCall>('model-call').find(row => row.value.purpose === 'dossier-assessor')!;
  assert.equal(claim.value.execution?.phase, 'claimed');
  const application = claim.value.assessmentApplication!;
  releaseRunExecution(f.open(), original.value);
  const cold = f.open(), claimedHistory = history(cold);
  await inert(f, cold, async () => {
    await assert.rejects(withResearchRunControl(cold, 'p', original.value.hold,
      () => resumeDossierResearchCall(cold, application)), { code: 'run_control_changed' });
  });
  assert.equal(history(cold), claimedHistory);
  const checkpoint = await saveWorld(f);
  // A lawful fresh invocation authorizes the existing claim, without another reservation.
  const fresh = acquireRunExecution(cold, { project: 'p' }); assert.ok(fresh.ok);
  const ledger = cold.list('research-budget-ledger').flatMap(row => cold.history(row.id)), wire = f.wires().length;
  let receiptCut = false;
  const releaseAtReceipt = interceptWrites(t, cold, (writes, commit) => {
    if (!receiptCut && writes.some(row => row.kind === 'model-response')) {
      receiptCut = true; releaseRunExecution(f.store, fresh.value);
    }
    return commit();
  });
  await withResearchRunControl(cold, 'p', fresh.value.hold, () => resumeDossierResearchCall(cold, application));
  releaseAtReceipt(); assert.ok(receiptCut, 'paid receipt commits despite the lost original hold');
  assert.equal(f.wires().length, wire + 1);
  assert.equal(cold.list<ModelCall>('model-call').filter(row => row.value.purpose === 'dossier-assessor').length, 1);
  assert.deepEqual(cold.list('research-budget-ledger').flatMap(row => cold.history(row.id)), ledger);
  const paid = money(cold), paidWire = f.wires();
  const completed = await withResearchRunControl(cold, 'p', fresh.value.hold,
    () => runDossierAssessmentSession(cold, 'p', packet.subject));
  assert.ok(completed.result);
  assert.deepEqual(money(cold), paid); assert.deepEqual(f.wires(), paidWire);
  const finalHistory = history(cold);
  await inert(f, cold, () => withResearchRunControl(cold, 'p', fresh.value.hold,
    () => runDossierAssessmentSession(cold, 'p', packet.subject)));
  assert.equal(history(cold), finalHistory);
  // The same real claim in an isolated cut state also exercises the gate's
  // authorization CAS, after admission but before stdin may reach the adapter.
  const raced = copyWorld(t, checkpoint), second = raced.open();
  const owner = acquireRunExecution(raced.store, { project: 'p' }); assert.ok(owner.ok);
  let moved = false; const racedWire = raced.wires();
  const racedLedger = raced.store.list('research-budget-ledger').flatMap(row => raced.store.history(row.id));
  const undo = interceptWrites(t, raced.store, (writes, commit) => {
    if (!moved && writes.some(row => row.kind === 'model-call' && (row.value as ModelCall).execution?.phase === 'authorized')) {
      moved = true; releaseRunExecution(second, owner.value);
    }
    return commit();
  });
  await assert.rejects(withResearchRunControl(raced.store, 'p', owner.value.hold,
    () => resumeDossierResearchCall(raced.store, application)), { code: 'run_control_changed' });
  undo(); assert.ok(moved); assert.deepEqual(raced.wires(), racedWire);
  const refused = raced.store.get<ModelCall>(claim.id)!;
  assert.equal(refused.value.status, 'failed'); assert.equal(refused.value.error, 'run_control_changed');
  assert.equal(refused.value.response, null);
  assert.equal(refused.value.execution?.phase, 'claimed'); assert.equal(refused.value.usage, null);
  assert.equal(raced.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'dossier-assessor').length, 1);
  assert.deepEqual(raced.store.list('research-budget-ledger').flatMap(row => raced.store.history(row.id)), racedLedger);
  assert.equal(raced.store.history<ModelCall>(claim.id).some(row => row.value.execution?.phase === 'authorized'), false);
});
