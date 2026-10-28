import { fixtureApplicableAxes, discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
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
import { ProductEngine } from '../src/product/engine.js';
import { EngineError } from '../src/errors.js';
import { BudgetReentry, Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { type ResearchRun } from '../src/discovery/research-model.js';
import { type ModelCall } from '../src/runtime/model-usage.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation, StageBudgetSessions, issueStageBudgetInvitation, increaseStageBudget } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { readVariantHandoff, readDeepFrontierStop } from '../src/discovery/discovery-outcome.js';
import { readPartialDossier } from '../src/discovery/dossier-manifest.js';
import { canonical } from '../src/canonical.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { readVariantScope } from '../src/discovery/variant-scope.js';
import { type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { readEffectiveStageBudget } from '../src/discovery/stage-token-budget.js';
import { storeUnchanged } from './store-unchanged.js';

// Include orphaned history as well as current heads after the explicit missing-head corruptions.
export function history(store: Store): string {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
      revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id, revision').all() });
  } finally { db.close(); }
}
// The public runner uses Store indices outside the deliberately narrow storeView
// surface. Intercept only writes to this connection; all reads stay real and the
// second Store still commits independently inside the tested reservation window.
export function interceptWrites(t:test.TestContext, target:Store,
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

export async function build(questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')], initialMode: 'questions'|'bypass'|null = 'questions') {
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
 const claims=s.deepClaims??(s.selectedAxes&&id==='q-two'&&s.deepMode!=='common'?s.applicableAxes.map(axis=>({...claim,id:claim.id+'-'+axis,text:claim.text+' '+axis,axis,basis:{howToVerify:claim.basis.howToVerify+' '+axis}})):[claim]);
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
  configure({applicableAxes:fixtureApplicableAxes(v.draft)});
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
export type Base=Awaited<ReturnType<typeof build>>;
export function bind(t:{after(fn:()=>void):void},base:Base,path=base.path,runtime=base.root){
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
export const money = (store: Store) => [...store.identities('list','model-call'),...store.identities('list','research-budget-ledger')]
  .flatMap(row=>store.history(row.id));
export function choiceScope(f: ReturnType<typeof bind>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
  const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  const set = f.store.get<VariantSet>(state.value.set!.id, state.value.set!.revision)!;
  return { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set),
    mode: reference(f.store.get('project-mode:p')!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: kind === 'choose' ? { kind, member: set.value.members[0]!, reason: 'Authorized owner chooses the member' }
      : { kind, reason: 'Authorized owner rejects the exact set' } };
}
export function owner(store: Store, scope: VariantChoiceScope) {
  const sessions = new VariantChoiceSessions(store), issued = issueVariantChoiceInvitation(store, scope);
  assert.ok(issued.ok); if (!issued.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
  assert.ok(login.ok); if (!login.ok) assert.fail('Expected successful owner exchange');
  const act = answerVariantChoice(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok); return act;
}

export const deepCalls = (f: ReturnType<typeof bind>) => f.wires().filter(row => row.subject.deepPreparation);
export const deepIntents = (store: Store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => Object.hasOwn(row.value.cursor, 'deepPreparation'));
export async function inert(f: ReturnType<typeof bind>, store: Store, action: () => Promise<unknown>) {
  const paid=money(store),wire=f.wires();
  const result=await storeUnchanged(store,action);
  assert.deepEqual(money(store),paid);assert.deepEqual(f.wires(),wire);return result;
}
export type SavedWorld={base:Base;snapshot:string;scope:Ref;pending:Revision<ResearchRun>};
const readyWorlds=new Map<string,SavedWorld>();
/** Cache only the real producer prefix. Each test receives a byte-for-byte SQLite
 * copy and separate mutable runtime files; the original environment/actor/Ref
 * history and immutable adapter code are untouched. Tests in this file run serially. */
export async function ready(t:test.TestContext,model=false,config:Record<string,unknown>={}){
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
export function copyWorld(t:test.TestContext,seed:SavedWorld){
  const runtime=mkdtempSync(join(tmpdir(),'omg-budget-reentry-world-')),closing:Array<()=>void>=[];
  t.after(()=>{for(const close of closing)close();rmSync(runtime,{recursive:true,force:true});});
  for(const name of ['state.sqlite','settings.json','wire.ndjson'])copyFileSync(join(seed.snapshot,name),join(runtime,name));
  return {...bind({after:fn=>closing.push(fn)},seed.base,join(runtime,'state.sqlite'),runtime),
    scope:structuredClone(seed.scope),pending:structuredClone(seed.pending)};
}
export async function saveWorld(f:Awaited<ReturnType<typeof ready>>):Promise<SavedWorld>{
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
export async function stopped(t: test.TestContext, tokens = 18_000_000) {
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
export type Stopped = Awaited<ReturnType<typeof stopped>>;
export function increase(f: Stopped, limit = 24_000_000, store = f.store) {
  const segment = readEffectiveStageBudget(store, 'p').segment!;
  const scope = { project: 'p', stage: 'discovery' as const, previous: reference(segment), limit };
  const invitation = issueStageBudgetInvitation(store, scope); assert.ok(invitation.ok);
  const sessions = new StageBudgetSessions(store);
  const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok);
  const raised = increaseStageBudget(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok);
  return raised;
}
export function driver(f: Stopped, store = f.store, maxTurns = 1, maxCalls = 2) {
  return new EarlyStageDriver(new ProductEngine(store), new BudgetReentry({ discovery: 7 }))
    .run({ project: 'p', draftId: f.v.draft.id, maxTurns, maxCalls });
}
export async function forecastRefusal(f: Stopped, door: 'driver' | 'researcher', code: string, store = f.store) {
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
export async function refusedByBothDoors(f: Stopped, code: string) {
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
export async function continueBothDoors(t: test.TestContext, f: Stopped, intent: Revision<ResearchConsumerIntent>,
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
export async function oldSnapshot(f: Stopped, store = f.store) {
  const before = history(store), wire = f.wires();
  const proof = await readPartialDossier(store, 'p', f.details.dossier);
  assert.deepEqual(reference(proof.stop!), f.details.stop);
  assert.deepEqual(reference(proof.record), f.details.dossier);
  assert.deepEqual(store.get(f.original.id, f.original.revision), f.original);
  assert.equal(history(store), before); assert.deepEqual(f.wires(), wire);
}
export function assertAdvanced(f: Stopped, paid: number) {
  const calls = deepCalls(f);
  assert.equal(calls.length, paid + 1);
  assert.equal(calls.at(-1).subject.deepCell.subject.planQuestionId, 'q-two');
  const frontier = deepPlanSelection(f.store, 'p', f.scope);
  const first = frontier.progress.find(row => row.question === 'q-one')!;
  const second = frontier.progress.find(row => row.question === 'q-two')!;
  assert.ok(first.state); assert.ok(second.state);
  return frontier;
}
