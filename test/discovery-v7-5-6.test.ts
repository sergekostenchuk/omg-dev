import { fixtureApplicableAxes } from './discovery-v7-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { discoveryInspection, readVariantHandoff, readDeepFrontierStop } from '../src/discovery/discovery-outcome.js';
import { readPartialDossier } from '../src/discovery/dossier-manifest.js';
import { V7_AXES } from '../src/discovery/v7-contracts.js';
import { readSelectedDossier } from '../src/discovery/selected-dossier.js';
import { resolveClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';
import { canonical } from '../src/canonical.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { readDeepResearchResult, runDeepResearch, resumeDeepResearch } from '../src/discovery/deep-research-execution.js';
import { readDeepPreparation } from '../src/discovery/deep-research.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import { readVariantScope } from '../src/discovery/variant-scope.js';
import type { ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import type { ResearchRun, V7ProgressState } from '../src/discovery/research-model.js';

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
// A world is built once by the real producers in a root of its own; every test opens its own Stores over it. A cached
// ready world is restored from its byte snapshot before each test (tests of a file run one after another), so no test
// sees another's writes. Saved records name the world's root (workspace, adapter), hence restore in place.
const roots: string[] = [];
process.once('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
type Base = { root: string; path: string; v: ReturnType<typeof acceptPlan>; environment: Revision<any>; command: { executable: string; args: string[] };
  initial: Revision<unknown> | null; questions: PlanQuestion[] };
async function build(questions: PlanQuestion[], initialMode: 'questions'|'bypass'|null): Promise<Base> {
  const f = discoveryFixture({ after: () => {} }, 'omg-56-');
  roots.push(f.root);
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')), s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')), q=r.subject.question?.id??'probe';
let prior=[];try{prior=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line))}catch{}
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
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
 const all=r.subject.value.attempts.flatMap(row=>row.end.type==='submitted'?row.end.value.claims.map((claim,index)=>({accepted:true,claim:{project:r.subject.assessmentSubject.packet.project,container:row.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id}})):[]);
 const accepted=all.filter(c=>c.accepted).map(c=>({claim:c.claim,reason:'Supported exact hypothesis or addressed unknown'}));
 research={verdict:'supported',reasons:['Exact material classification'],return:null,novelty:{attempts:entries.map(e=>({attempt:e.attempt,reason:'Exact attempt'})),accepted,rejected:all.filter(c=>!c.accepted).map(c=>({claim:c.claim,reason:'Counterargument not supported'})),newContent:accepted,duplicates:[],noProgress:entries.filter(e=>!accepted.some(c=>c.claim.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No accepted addition'})),transition:accepted.length&&s.close!==false?{outcome:'closed',bases:accepted.map(c=>({claim:c.claim})),reason:'The exact criterion has enough supported material',sufficiency:{criterion:'Named basis answering '+r.subject.assessmentSubject.packet.planQuestionId,requiredDepth:'deep',reason:'Required depth is met',methodologyRequirements:[]}}:accepted.length&&s.outcome?{outcome:s.outcome,bases:accepted.map(c=>({claim:c.claim})),reason:'Reopened by the applied assessment',...(s.outcome==='unknown'?{consequence:'The deep cell stays missing',nextAction:'Find the named evidence'}:{})}:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):r.subject.deepPreparation?(s.deepTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
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
  return { root: f.root, path: f.path, v, environment, command, initial, questions };
}
function bind(t: { after(fn: () => void): void }, base: Base) {
  const { root, path, v, environment, command, initial, questions } = base, stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); });
  const f = { root, path, store, engine, discovery, open };
  const settings = join(root, 'settings.json'), wire = join(root, 'wire.ndjson');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
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
  return { ...f, v, environment, command, run, wires, generationCalls, configure, mode, initial, nextEdition };
}
async function setup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')], initialMode: 'questions'|'bypass'|null = 'questions') {
  return bind(t, await build(questions, initialMode));
}
const WORLD_FILES = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'settings.json', 'wire.ndjson'];
const money = (store: Store) => store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind)).flatMap(row => store.history(row.id));
function choiceScope(f: Awaited<ReturnType<typeof setup>>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
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

const deepCalls = (f: Awaited<ReturnType<typeof setup>>) => f.wires().filter(row => row.subject.deepPreparation);
const deepIntents = (store: Store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => Object.hasOwn(row.value.cursor, 'deepPreparation'));
async function inert(f: Awaited<ReturnType<typeof setup>>, store: Store, action: () => Promise<unknown>) {
  const before=history(store), paid=money(store), wire=f.wires();
  const result=await action();
  assert.equal(history(store),before);assert.deepEqual(money(store),paid);assert.deepEqual(f.wires(),wire);return result;
}
const readyWorlds = new Map<string, { base: Base; snapshot: string; data: { scope: any; pending: any } }>();
/** The real generation, choice and pending deep frontier is produced once per (model, config); each later test starts
 * from its exact bytes in its own Stores. */
async function ready(t:test.TestContext,model=false,config:Record<string,unknown>={}) {
  const key=JSON.stringify([model,config]);let cached=readyWorlds.get(key);
  if(!cached){
    const closing:(()=>void)[]=[], base=await build([planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')],model?'bypass':'questions');
    const made=await readyIn(bind({after:fn=>closing.push(fn)},base),model,config);
    for(const close of closing)close();
    const snapshot=mkdtempSync(join(tmpdir(),'omg-56-snap-'));roots.push(snapshot);
    for(const file of WORLD_FILES)if(existsSync(join(base.root,file)))copyFileSync(join(base.root,file),join(snapshot,file));
    cached={base,snapshot,data:structuredClone({scope:made.scope,pending:made.pending})};readyWorlds.set(key,cached);
  }
  for(const file of WORLD_FILES){rmSync(join(cached.base.root,file),{force:true});
    if(existsSync(join(cached.snapshot,file)))copyFileSync(join(cached.snapshot,file),join(cached.base.root,file));}
  return {...bind(t,cached.base),...structuredClone(cached.data)};
}
async function readyIn(f:ReturnType<typeof bind>,model:boolean,config:Record<string,unknown>) {
  const generated=await f.run(3);
  assert.equal(generated.value.pauseCode,model?'research_turns_exhausted':'research_variant_owner_required',generated.value.error!);
  f.configure(config);
  if(model)await f.run(1);else owner(f.store,choiceScope(f));
  const pending=await f.run(1,f.store,true), details=JSON.parse(pending.value.error!);
  assert.equal(pending.value.pauseCode,'research_deep_frontier_pending',pending.value.error!);
  const handoff=(await readVariantHandoff(f.store,'p',details.handoff)).record;
  assert.equal(handoff.value.next,'deep');assert.deepEqual(handoff.value.scope,details.scope);
  assert.deepEqual(reference(readVariantScope(f.store,'p',details.scope).scope),details.scope);
  return {...f,scope:details.scope,pending};
}
for(const model of [false,true])test(`5.6: real ${model?'model':'owner'} choose buys only the other cell after applied coverage, then cold fixed point`,async t=>{
  const f=await ready(t,model,{selectedAxes:true}), first=await f.run(1), details=JSON.parse(first.value.error!);
  assert.equal(first.value.pauseCode,'research_deep_frontier_pending',first.value.error!);
  const coverage=deepPlanSelection(f.store,'p',f.scope);
  assert.deepEqual(coverage.coverage.cells.map(row=>row.covered),[true,false]);
  assert.equal(coverage.next!.cell.subject.planQuestionId,'q-two');
  assert.deepEqual(details.progress.map((row:any)=>row.summary.count),[2,1]);
  assert.deepEqual(deepCalls(f).map(row=>row.subject.deepCell.subject.planQuestionId),['q-one']);
  const final=await f.run(1,f.open());
  assert.equal(final.value.pauseCode,'research_selected_dossier_assessment_unavailable',final.value.error!);
  const selected=readSelectedDossier(f.store,'p',JSON.parse(final.value.error!).selected);
  for(const axis of V7_AXES){
    assert.equal(selected.manifest.value.axes[axis].claims.length > 0, selected.manifest.value.axes[axis].depth !== 'inapplicable', axis);
    for(const address of selected.manifest.value.axes[axis].claims){
      const claim=resolveClaimAddress(f.store,address).claim;
      assert.ok(claim&&typeof claim==='object'&&!Array.isArray(claim));
      assert.equal(claim.axis,axis);
    }
  }
  assert.deepEqual(reference(selected.manifest),JSON.parse(final.value.error!).dossier);
  assert.equal(selected.coverage.missing.length,0);assert.deepEqual(selected.record.value.scope,f.scope);
  assert.deepEqual(deepCalls(f).map(row=>row.subject.deepCell.subject.planQuestionId),['q-one','q-two']);
  assert.deepEqual(deepPlanSelection(f.store,'p',f.scope).coverage.cells.map(row=>row.covered),[true,true]);
  for(const row of deepIntents(f.store))assert.equal(readDeepResearchResult(f.store,'p',reference(row)).verification,'proven');
  assert.equal(f.store.list('discovery-dossier-manifest').length,1);assert.equal(selected.manifest.value.completeness,'complete');
  assert.equal(discoveryInspection(f.store,f.store.get<DiscoveryDraft>(f.v.draft.id)!).outcome.state,'researching');
  await inert(f,f.store,async()=>assert.deepEqual(await f.run(3,f.store,true),final));
  const cold=f.open();
  // The saved selected D6 is a fixed point in restore mode; ordinary run may now buy its assessment.
  await inert(f,cold,async()=>assert.deepEqual(await f.run(3,cold,true),final));
});

for(const mode of ['common','insufficient'] as const)test(`5.6: applied ${mode} material stays in the exact missing frontier`,async t=>{
  const f=await ready(t,false,mode==='common'?{deepMode:'common'}:{close:false,outcome:'open'});
  const result=await f.run(1), selection=deepPlanSelection(f.store,'p',f.scope);
  assert.equal(result.value.pauseCode,'research_deep_frontier_pending',result.value.error!);
  assert.equal(selection.coverage.cells[0]!.covered,false);
  assert.equal(selection.coverage.cells[0]!.missing!.code,mode==='common'?'coverage_no_variant_ground':'coverage_no_sufficiency');
  assert.equal(selection.next!.cell.subject.planQuestionId,'q-one');
  assert.equal(selection.next!.cell.requiredDepth,'deep');
  assert.equal(selection.next!.cell.criterion,'Named basis answering q-one');
  await inert(f,f.open(),()=>f.run(1,f.open(),true));
});

for(const outcome of ['open','unknown'] as const)test(`5.6: a later real applied ${outcome} supersedes coverage and restores the exact frontier hot and cold`,async t=>{
  const f=await ready(t);await f.run(1);
  const first=deepIntents(f.store)[0]!, subject=first.value.cursor.subject!;
  assert.equal(deepPlanSelection(f.store,'p',f.scope).coverage.cells[0]!.covered,true);
  // A separate lawful managed attempt supplies new evidence; no saved P or paid record is manufactured.
  f.configure({close:false,outcome});
  const run=f.store.get<ResearchRun>(first.value.owner.id)!;
  const result=(await runDeepResearch(f.store,{projectId:'p',deepPreparation:first.value.cursor.deepPreparation!,
    environment:f.environment,owner:reference(run)}))!;
  const packet=projectAttemptPacket(f.store,{project:'p',...subject,
    entries:[{attempt:reference(result.attempt),binding:reference(result.binding)}]});
  const assessment=await assessAttemptsWithRequirements(f.store,packet,v7ProgressBaseline(f.store,packet),f.environment,f.root);
  applyDiscoveryAssessment(f.store,'p',reference(assessment));
  const before=history(f.store), paid=money(f.store), wire=f.wires();
  for(const store of [f.store,f.open()]){
    const frontier=deepPlanSelection(store,'p',f.scope);
    assert.equal(frontier.coverage.cells[0]!.covered,false);
    assert.equal(frontier.next!.cell.subject.planQuestionId,'q-one');
    assert.equal(frontier.progress[0]!.summary!.outcome,outcome);
    assert.deepEqual(frontier.next!.cell.subject,subject);
    assert.equal(history(store),before);assert.deepEqual(money(store),paid);assert.deepEqual(f.wires(),wire);
  }
});

// The six real turns of the two stalled cells are built once, by the first test that needs them; the exact bytes of
// their end are saved, and the next test opens its own Stores over a restored copy of them.
type SixWorld={base:Base;snapshot:string;scope:any};
let sixWorld:SixWorld|undefined;
async function six(t:test.TestContext){
  if(sixWorld){
    for(const file of WORLD_FILES){rmSync(join(sixWorld.base.root,file),{force:true});
      if(existsSync(join(sixWorld.snapshot,file)))copyFileSync(join(sixWorld.snapshot,file),join(sixWorld.base.root,file));}
    return {...bind(t,sixWorld.base),scope:structuredClone(sixWorld.scope)};
  }
  const f=await ready(t,false,{deepMode:'impossible'});
  await f.run(1);
  assert.equal(deepPlanSelection(f.store,'p',f.scope).progress[0]!.summary!.streak,1);
  const environment=f.store.get<typeof f.environment.value>(f.environment.id)!;
  f.engine.environments.configure('p',{...environment.value,timeoutMs:environment.value.timeoutMs+1},environment.revision);
  await f.run(2,f.open());
  let frontier=deepPlanSelection(f.store,'p',f.scope);
  assert.equal(frontier.progress[0]!.summary!.streak,3);
  assert.equal(frontier.progress[0]!.stalled,true);
  assert.equal(frontier.next!.cell.subject.planQuestionId,'q-two');
  await f.run(3,f.open());frontier=deepPlanSelection(f.store,'p',f.scope);
  assert.equal(frontier.next,null);assert.deepEqual(frontier.progress.map(row=>row.summary!.streak),[3,3]);
  assert.deepEqual(deepCalls(f).map(row=>row.subject.deepCell.subject.planQuestionId),['q-one','q-one','q-one','q-two','q-two','q-two']);
  const run=f.store.list<any>('research-run').find(row=>row.value.draftId===f.v.draft.id)!;
  assert.equal(run.value.pauseCode,'research_dossier_assessment_unavailable');assert.equal(run.value.turns,8);
  const snapshot=mkdtempSync(join(tmpdir(),'omg-56-six-'));roots.push(snapshot);
  const source=new DatabaseSync(f.path,{readOnly:true});
  try{await backup(source,join(snapshot,'state.sqlite'));}finally{source.close();}
  for(const file of ['settings.json','wire.ndjson'])copyFileSync(join(f.root,file),join(snapshot,file));
  sixWorld={base:readyWorlds.get(JSON.stringify([false,{deepMode:'impossible'}]))!.base,snapshot,scope:structuredClone(f.scope)};
  return f;
}
test('5.6: N and exact run cursor survive restart and an environment revision; stalled cells are not bought again',async t=>{
  // The steps and their assertions are those of six(): three paid turns of one cell, an environment revision, two
  // restarts, and three of the other cell, every one counted once.
  const f=await six(t);
  assert.deepEqual(deepCalls(f).map(row=>row.subject.deepCell.subject.planQuestionId),['q-one','q-one','q-one','q-two','q-two','q-two']);
  assert.equal(deepPlanSelection(f.store,'p',f.scope).next,null);
});
test('5.6: the stalled stop and its partial dossier are read as saved; a restore-only run on the hot and on a newly opened Store buys and writes nothing',async t=>{
  const f=await six(t), frontier=deepPlanSelection(f.store,'p',f.scope);
  const run=f.store.list<any>('research-run').find(row=>row.value.draftId===f.v.draft.id)!;
  assert.equal(run.value.pauseCode,'research_dossier_assessment_unavailable');assert.equal(run.value.turns,8);
  const details=JSON.parse(run.value.error!), stop=await readDeepFrontierStop(f.store,'p',details.stop);
  const dossier=await readPartialDossier(f.store,'p',details.dossier);
  assert.equal(stop.record.value.reason,'stall');assert.deepEqual(stop.coverage.missing,frontier.coverage.missing);
  assert.deepEqual(reference(dossier.stop!),details.stop);assert.deepEqual(reference(dossier.handoff),details.handoff);
  assert.equal(dossier.record.value.completeness,'partial');
  // Historical stalled partial recovery does not authorize the newly connected D6 assessment.
  for(const store of [f.store,f.open()])await inert(f,store,async()=>assert.deepEqual(await f.run(5,store,true),run));
});

test('5.6: restoreOnly, default policy and zero allowance cannot buy or prepare the missing cell',async t=>{
  const f=await ready(t), store=f.open();
  await inert(f,store,()=>f.run(1,store,true));
  await inert(f,store,()=>new Researcher(store,new Discovery(store),new ProductEngine(store).environments).run('p',f.v.draft.id,1));
  await inert(f,store,()=>assert.rejects(()=>f.run(0,store),{code:'research_budget_invalid'}));
  assert.equal(deepCalls(f).length,0);assert.equal(f.store.list('discovery-deep-preparation').length,0);
});

test('5.6: real paid budget stays exhausted across restart and keeps the exact missing cell',async t=>{
  const f=await ready(t);f.configure({assessorTokens:V7_STAGE_TOKEN_CEILING-2_000_000});
  const result=await f.run(2), details=JSON.parse(result.value.error!);
  assert.equal(result.value.pauseCode,'research_dossier_assessment_unavailable',result.value.error!);
  assert.equal(deepCalls(f).length,1);assert.equal(details.nextCell.subject.planQuestionId,'q-two');
  assert.equal(details.budget.exhausted,true);assert.ok(details.budget.measured>=V7_STAGE_TOKEN_CEILING-2_000_000);
  assert.ok(details.budget.calls.length);assert.ok(f.store.get(details.budget.ledger.id,details.budget.ledger.revision));
  const stop=await readDeepFrontierStop(f.store,'p',details.stop), dossier=await readPartialDossier(f.store,'p',details.dossier);
  assert.equal(stop.record.value.reason,'budget');assert.deepEqual(stop.record.value.budget,details.budget);
  assert.equal(stop.coverage.missing[0]!.cell.subject.planQuestionId,'q-two');
  assert.deepEqual(reference(dossier.stop!),details.stop);assert.deepEqual(reference(dossier.handoff),details.handoff);
  assert.equal(dossier.record.value.completeness,'partial');
  // Research allowance exhaustion preserves this stop; D6 completion has its own forecast and is not requested here.
  for(const store of [f.store,f.open()])await inert(f,store,async()=>assert.deepEqual(await f.run(5,store,true),result));
});

test('5.6: a real new scope with the same cell has its own preparation and paid identity',async t=>{
  const f=await ready(t,false,{close:false,outcome:'open'});await f.run(1);
  const old=readVariantScope(f.store,'p',f.scope), state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
  owner(f.store,{...choiceScope(f),operation:'revise',previous:old.scope.value.decision,expectedSelection:reference(state)});
  await f.run(1,f.open());
  const sent=deepCalls(f);assert.equal(sent.length,2);
  assert.deepEqual(sent[0].subject.deepCell,sent[1].subject.deepCell);
  assert.notDeepEqual(sent[0].subject.deepPreparation,sent[1].subject.deepPreparation);
  assert.notDeepEqual(sent[0].subject.deepScope.decision,sent[1].subject.deepScope.decision);
  assert.equal(deepIntents(f.store).length,2);
  assert.equal(readVariantScope(f.open(),'p',f.scope).scope.id,old.scope.id);
});

for(const cold of [false,true])for(const position of [1,2])
test(`5.6-01: ${cold?'cold':'hot'} prepared cut at deep position ${position} resumes the original owner without revise`,async t=>{
  const f=await ready(t);let prepared=0, cut=false, savedHistory='', savedMoney=money(f.store), savedWire=f.wires();
  if(position===2)f.configure({selectedAxes:true});
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    const preparing=writes.some(row=>row.kind==='research-consumer-intent'&&row.expected===0
      &&Object.hasOwn((row.value as ResearchConsumerIntent).cursor,'deepPreparation'));
    const result=commit();
    if(preparing&&++prepared===position){
      cut=true;savedHistory=history(f.store);savedMoney=money(f.store);savedWire=f.wires();
      throw new Error('5.6-01 cut after prepared commit, before reservation');
    }
    return result;
  });
  try{await f.run(position);}finally{restore();}
  assert.ok(cut);assert.equal(deepCalls(f).length,position-1);
  assert.equal(history(f.store),savedHistory);assert.deepEqual(money(f.store),savedMoney);assert.deepEqual(f.wires(),savedWire);
  const intent=deepIntents(f.store).find(row=>row.value.state==='prepared')!;
  assert.ok(intent);assert.equal(intent.value.call,null);assert.equal(deepIntents(f.store).length,position);
  const admitted=f.store.get<ResearchRun>(intent.value.owner.id)!;
  assert.deepEqual(reference(admitted),intent.value.owner);assert.equal(admitted.value.status,'paused');
  assert.equal(intent.value.cursor.turn,admitted.value.turns+1);
  const store=cold?f.open():f.store;
  await inert(f,store,async()=>assert.deepEqual(await f.run(1,store,true),admitted));
  const result=await f.run(1,store);
  assert.equal(result.value.pauseCode,position===1?'research_deep_frontier_pending':'research_selected_dossier_assessment_unavailable',result.value.error!);
  const applied=store.get<ResearchConsumerIntent>(intent.id)!;
  assert.equal(applied.value.state,'applied');assert.equal(deepIntents(store).length,position);
  assert.deepEqual(applied.value.owner,intent.value.owner);assert.equal(applied.value.rootKey,intent.value.rootKey);
  assert.deepEqual(applied.value.cursor,intent.value.cursor);
  assert.deepEqual(store.get(intent.id,intent.revision),intent);assert.deepEqual(store.get(admitted.id,admitted.revision),admitted);
  const proof=readDeepResearchResult(store,'p',reference(applied));
  assert.deepEqual(reference(proof.preparation.preparation),intent.value.cursor.deepPreparation);
  assert.equal(deepCalls(f).length,position);assert.equal(f.wires().length,savedWire.length+2,'one deep send and its ordinary MR');
  assert.deepEqual(f.wires().slice(0,savedWire.length),savedWire);
  const oldCalls=new Set(savedMoney.filter(row=>row.kind==='model-call').map(row=>row.id));
  const added=store.list<{requestId:string}>('model-call').filter(row=>!oldCalls.has(row.id));
  assert.equal(added.length,2);assert.ok(added.some(row=>row.id===proof.call.id));
  assert.deepEqual(added.map(row=>row.value.requestId).sort(),f.wires().slice(savedWire.length).map(row=>row.requestId).sort());
  assert.equal(deepPlanSelection(store,'p',f.scope).coverage.cells[position-1]!.covered,true);
  if(position===2){
    const selected=readSelectedDossier(store,'p',JSON.parse(result.value.error!).selected);
    for(const axis of V7_AXES){
      assert.equal(selected.manifest.value.axes[axis].claims.length > 0, selected.manifest.value.axes[axis].depth !== 'inapplicable', axis);
      for(const address of selected.manifest.value.axes[axis].claims){
        const claim=resolveClaimAddress(store,address).claim;
      assert.ok(claim&&typeof claim==='object'&&!Array.isArray(claim));
      assert.equal(claim.axis,axis);
    }
    }
    assert.deepEqual(reference(selected.manifest),JSON.parse(result.value.error!).dossier);
    assert.deepEqual(selected.record.value.scope,f.scope);assert.equal(selected.coverage.missing.length,0);
  }
  if(position===2){
    await inert(f,store,async()=>assert.deepEqual(await f.run(2,store,true),result));
    const again=f.open();
    await inert(f,again,async()=>assert.deepEqual(await f.run(2,again,true),result));
  }else for(const again of [store,f.open()])await inert(f,again,async()=>{
    assert.deepEqual(await f.run(2,again,true),result);
  });
});

async function unpaidDeep(t:test.TestContext, dedicatedEnvironment=false) {
  const f=await ready(t);let cut=false;
  // Isolate a missing deep environment from the earlier paid snapshot's own
  // environment, so that negative reaches the unpaid admission proof.
  if(dedicatedEnvironment){
    const current=f.store.get<typeof f.environment.value>(f.environment.id)!;
    f.engine.environments.configure('p',{...current.value,timeoutMs:current.value.timeoutMs+1},current.revision);
  }
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    const preparing=writes.some(row=>row.kind==='research-consumer-intent'&&row.expected===0
      &&Object.hasOwn((row.value as ResearchConsumerIntent).cursor,'deepPreparation'));
    const result=commit();
    if(preparing&&!cut){cut=true;throw new Error('5.6-02 unpaid preparation cut');}
    return result;
  });
  try{await f.run(1);}finally{restore();}
  assert.ok(cut);assert.equal(deepCalls(f).length,0);
  const intent=deepIntents(f.store)[0]!;assert.equal(intent.value.state,'prepared');
  return {...f,intent};
}
for(const cold of [false,true])test(`5.6-02: ${cold?'cold':'hot'} timeout-only revision replaces the unpaid generation exactly once`,async t=>{
  const f=await unpaidDeep(t), old=f.intent, oldHistory=f.store.history(old.id);
  const beforeEnvironment=f.store.get<typeof f.environment.value>(f.environment.id)!;
  const next=f.engine.environments.configure('p',{...beforeEnvironment.value,timeoutMs:beforeEnvironment.value.timeoutMs+1},beforeEnvironment.revision);
  const store=cold?f.open():f.store;
  await inert(f,store,()=>f.run(1,store,true));
  const sent=f.wires(), paid=money(store), result=await f.run(1,store);
  assert.equal(result.value.pauseCode,'research_deep_frontier_pending',result.value.error!);
  const current=deepIntents(store).find(row=>row.id!==old.id)!;
  assert.ok(current);assert.equal(current.value.generation,old.value.generation+1);
  assert.deepEqual(current.value.previous,reference(old));assert.equal(current.value.rootKey,old.value.rootKey);
  assert.deepEqual(current.value.owner,old.value.owner);
  for(const key of ['run','turn','subject','deepPreparation'] as const)assert.deepEqual(current.value.cursor[key],old.value.cursor[key]);
  assert.deepEqual(current.value.role,old.value.role);assert.deepEqual(current.value.dispatch,next.value);
  assert.ok(current.value.guards.some(guard=>canonical(guard)===canonical(reference(next))));
  assert.deepEqual(store.history(old.id),oldHistory);assert.equal(deepCalls(f).length,1);
  assert.equal(deepIntents(store).length,2);assert.equal(readDeepResearchResult(store,'p',reference(current)).verification,'proven');
  assert.equal(f.wires().length,sent.length+2);assert.deepEqual(f.wires().slice(0,sent.length),sent);
  const oldCalls=new Set(paid.filter(row=>row.kind==='model-call').map(row=>row.id));
  assert.equal(store.list('model-call').filter(row=>!oldCalls.has(row.id)).length,2);
  for(const again of [store,f.open()])await inert(f,again,async()=>assert.deepEqual(await f.run(2,again,true),result));
});
for(const damage of ['missing-current','missing-original','substituted-current','substituted-dispatch'] as const)
test(`5.6-02: ${damage} environment is not permission to replace unpaid work hot or cold`,async t=>{
  const f=await unpaidDeep(t,damage==='missing-original'), saved=f.store.get<typeof f.environment.value>(f.environment.id)!;
  f.engine.environments.configure('p',{...saved.value,timeoutMs:saved.value.timeoutMs+1},saved.revision);
  if(damage==='substituted-dispatch')f.store.write({id:f.intent.id,kind:f.intent.kind,expected:f.intent.revision,
    value:{...f.intent.value,dispatch:{...f.intent.value.dispatch,timeoutMs:f.intent.value.dispatch.timeoutMs+1}}});
  for(const store of [f.store,f.open()]){
    const get=store.get.bind(store);
    const mock=t.mock.method(store,'get',((id:string,revision?:number)=>{
      if(id===saved.id){
        if(damage==='missing-current'&&revision===undefined||damage==='missing-original'&&revision===saved.revision)return null;
        const record=get(id,revision);
        if(damage==='substituted-current'&&revision!==saved.revision&&record)
          return {...record,value:{...(record.value as object),projectId:'foreign'}};
      }
      return get(id,revision);
    }) as Store['get']);
    try{await inert(f,store,()=>assert.rejects(()=>f.run(1,store),{code:'discovery_deep_environment_invalid'}));}
    finally{mock.mock.restore();}
  }
  assert.equal(deepCalls(f).length,0);assert.equal(deepIntents(f.store).length,1);
});
test('5.6-02: a competing old reservation cannot survive timeout-only replacement',async t=>{
  const f=await unpaidDeep(t), old=f.intent, other=f.open();
  let reservation:{writes:Write[];guards:TransactionGuard[]}|undefined;
  const capture=interceptWrites(t,other,(writes,commit,guards)=>{
    if(writes.some(row=>row.kind==='model-call'&&row.expected===0)){
      reservation={writes:structuredClone(writes),guards:structuredClone(guards)};
      throw new Error('5.6-02 cut before old physical reservation');
    }
    return commit();
  });
  try{await assert.rejects(()=>resumeDeepResearch(other,'p',reference(old)),/cut before old physical reservation/);}
  finally{capture();}
  assert.ok(reservation);assert.equal(deepCalls(f).length,0);
  const env=f.store.get<typeof f.environment.value>(f.environment.id)!;
  f.engine.environments.configure('p',{...env.value,timeoutMs:env.value.timeoutMs+1},env.revision);
  let raced=false;
  const restore=interceptWrites(t,f.store,(writes,commit,guards)=>{
    if(writes.some(row=>row.kind==='research-consumer-intent'&&row.expected===0&&(row.value as ResearchConsumerIntent).generation===old.value.generation+1)){
      assert.ok(guards.some(guard=>canonical(guard)===canonical(reference(old))));
      const before=history(other), paid=money(other), wire=f.wires();
      assert.throws(()=>other.writeMany(reservation!.writes,reservation!.guards),{code:'input_stale'});
      assert.equal(history(other),before);assert.deepEqual(money(other),paid);assert.deepEqual(f.wires(),wire);raced=true;
    }
    return commit();
  });
  let result:Revision<ResearchRun>;
  try{result=await f.run(1);}finally{restore();}
  assert.ok(raced);assert.equal(deepCalls(f).length,1);assert.equal(deepIntents(f.store).length,2);
  assert.deepEqual(f.store.get(old.id),old);
  const active=deepIntents(f.store).find(row=>row.id!==old.id)!;
  assert.deepEqual(active.value.previous,reference(old));readDeepResearchResult(other,'p',reference(active));
  for(const store of [f.store,f.open()])await inert(f,store,async()=>assert.deepEqual(await f.run(2,store,true),result));
});

for(const cold of [false,true])test(`5.6: ${cold?'cold':'hot'} owner revise replaces only the stale unpaid deep admission at the same run position`,async t=>{
  const f=await ready(t);let cut=false;
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    const preparing=writes.some(row=>row.kind==='research-consumer-intent'&&row.expected===0
      &&Object.hasOwn((row.value as ResearchConsumerIntent).cursor,'deepPreparation'));
    const result=commit();
    if(preparing&&!cut){cut=true;throw new Error('5.6 cut after prepared intent, before reservation');}
    return result;
  });
  try{await f.run(1);}finally{restore();}
  assert.ok(cut);assert.equal(deepCalls(f).length,0);
  const oldIntent=deepIntents(f.store)[0]!, oldHistory=f.store.history(oldIntent.id);
  assert.equal(oldIntent.value.state,'prepared');assert.equal(oldIntent.value.call,null);
  const oldPreparation=readDeepPreparation(f.store,'p',oldIntent.value.cursor.deepPreparation!).preparation;
  const oldOwner=f.store.get<ResearchRun>(oldIntent.value.owner.id)!;
  const scope=readVariantScope(f.store,'p',f.scope), state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
  owner(f.store,{...choiceScope(f),operation:'revise',previous:scope.scope.value.decision,expectedSelection:reference(state)});
  const store=cold?f.open():f.store;
  await inert(f,store,async()=>assert.deepEqual(await f.run(1,store,true),oldOwner));
  const result=await f.run(1,store);
  assert.equal(result.value.pauseCode,'research_deep_frontier_pending',result.value.error!);
  assert.equal(deepCalls(f).length,1);
  assert.deepEqual(store.history(oldIntent.id),oldHistory,'the old immutable admission is preserved');
  const active=deepIntents(store).find(row=>row.id!==oldIntent.id)!;
  assert.ok(active);assert.equal(active.value.state,'applied');
  assert.equal(active.value.owner.id,oldOwner.id);assert.equal(active.value.cursor.turn,oldIntent.value.cursor.turn);
  assert.equal(store.get<ResearchRun>(oldOwner.id)!.value.turns,oldOwner.value.turns+1);
  assert.notDeepEqual(active.value.cursor.deepPreparation,oldIntent.value.cursor.deepPreparation);
  const proven=readDeepResearchResult(store,'p',reference(active));
  assert.notDeepEqual(proven.preparation.preparation.value.scope,f.scope);
  assert.deepEqual(proven.preparation.preparation.value.cell,oldPreparation.value.cell);
  assert.equal(f.generationCalls().filter(row=>row.subject.variantSubject.kind==='proposal').length,1);
  assert.equal(f.generationCalls().filter(row=>row.subject.variantSubject.kind==='decision').length,0);
  for(const again of [store,f.open()])await inert(f,again,async()=>assert.deepEqual(await f.run(2,again,true),result));
});

test('5.6: paid replacement recovers before a reopened plan and never rechecks the retired admission against current heads',async t=>{
  const f=await ready(t);let preparedCut=false,paidCut=false;
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    if(preparedCut&&writes.some(row=>row.kind==='research-turn'&&row.expected===0)&&!paidCut){
      paidCut=true;throw new Error('5.6 replacement paid before application');
    }
    const preparing=writes.some(row=>row.kind==='research-consumer-intent'&&row.expected===0
      &&Object.hasOwn((row.value as ResearchConsumerIntent).cursor,'deepPreparation'));
    const result=commit();
    if(preparing&&!preparedCut){preparedCut=true;throw new Error('5.6 original prepared before revise');}
    return result;
  });
  try{
    await f.run(1);assert.ok(preparedCut);
    const scope=readVariantScope(f.store,'p',f.scope), state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
    owner(f.store,{...choiceScope(f),operation:'revise',previous:scope.scope.value.decision,expectedSelection:reference(state)});
    await f.run(1);assert.ok(paidCut);
  }finally{restore();}
  const old=deepIntents(f.store).find(row=>row.value.state==='prepared')!;
  const paid=deepIntents(f.store).find(row=>row.value.state==='running')!;
  assert.ok(old);assert.ok(paid);assert.equal(deepCalls(f).length,1);
  const oldHistory=f.store.history(old.id), calls=money(f.store), wire=f.wires();
  const plan=f.store.get<Question>(f.v.plan.id)!;f.discovery.reopen(plan.id,plan.revision);
  const restored=await f.run(1,f.open(),true);
  const applied=f.store.get<ResearchConsumerIntent>(paid.id)!;
  assert.equal(applied.value.state,'applied');assert.equal(readDeepResearchResult(f.open(),'p',reference(applied)).verification,'proven');
  // Paid K is restored first. The existing checkpoint then refuses the reopened
  // current plan before admitting an unpaid assessment; no new MR is purchased.
  assert.equal(restored.value.pauseCode,'plan_questions_invalid',restored.value.error!);
  assert.deepEqual(f.store.history(old.id),oldHistory);assert.deepEqual(money(f.store),calls);assert.deepEqual(f.wires(),wire);
  await inert(f,f.open(),()=>f.run(1,f.open(),true));
});

test('5.6: a new accepted plan with the same question ids buys no replay of the former edition',async t=>{
  const f=await ready(t);await f.run(1);
  f.configure({close:false,outcome:'open'});await f.run(1);f.configure({close:true});
  const before=deepCalls(f),frontier=deepPlanSelection(f.store,'p',f.scope);
  assert.equal(before.length,2);
  assert.deepEqual(before.map(row=>row.subject.deepCell.subject.planQuestionId),['q-one','q-two']);
  for(const [id,covered,outcome] of [['q-one',true,'closed'],['q-two',false,'open']] as const){
    const cell=frontier.coverage.cells.find(row=>row.cell.subject.planQuestionId===id)!;
    assert.deepEqual(cell.cell.subject.planAnswer,f.v.planAnswer);assert.equal(cell.covered,covered);
    assert.equal(frontier.progress.find(row=>row.question===id)!.summary!.outcome,outcome);
  }
  assert.equal(f.store.list('discovery-selected-dossier').length,0);
  assert.equal(f.store.list('discovery-dossier-manifest').length,0);
  const next=f.nextEdition();
  await f.run(3);owner(f.store,choiceScope(f));await f.run(1);
  const sent=deepCalls(f);assert.equal(sent.length,3);
  assert.deepEqual(sent.slice(0,2),before);
  assert.equal(f.generationCalls().filter(row=>row.subject.variantSubject.kind==='proposal').length,2);
  assert.equal(f.generationCalls().filter(row=>row.subject.variantSubject.kind==='decision').length,0);
  assert.equal(sent[2].subject.deepCell.subject.planQuestionId,before[0].subject.deepCell.subject.planQuestionId);
  assert.deepEqual(sent[2].subject.deepCell.subject.planAnswer,next);
  assert.notDeepEqual(sent[2].subject.deepPreparation,before[0].subject.deepPreparation);
});

for(const shift of ['frame','plan','mode','selection'] as const)
test(`5.6: second Store ${shift} at deep reservation refuses without payment or a diagnostic write`,async t=>{
  const f=await ready(t), other=f.open(), sent=f.wires();
  let after:string|null=null, paid:ReturnType<typeof money>|null=null;
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    if(after===null&&writes.some(row=>row.kind==='model-call'&&row.expected===0)){
      if(shift==='frame'){
        const draft=other.get<DiscoveryDraft>(f.v.draft.id)!;
        const q=draft.value.questions.map(id=>other.get<Question>(id)!).find(row=>row.value.spec.field==='frame')!;
        new Discovery(other).reopen(q.id,q.revision);
      }
      if(shift==='plan')f.nextEdition(other);
      if(shift==='mode')f.mode('bypass',other);
      if(shift==='selection'){
        const state=other.get<VariantState>(variantStateId('p',f.v.draft.id))!, previous=readVariantScope(other,'p',f.scope).scope.value.decision;
        owner(other,{...choiceScope(f,'reject_all'),operation:'revise',previous,expectedSelection:reference(state)});
      }
      after=history(other);paid=money(other);
    }
    return commit();
  });
  try{await assert.rejects(()=>f.run(1),{code:'input_stale'});}finally{restore();}
  assert.ok(after,'The real reservation window was reached');assert.equal(history(f.store),after);
  assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),sent);
});

test('5.6: a missing applied progress head is a proof refusal, never an empty coverage frontier',async t=>{
  const f=await ready(t);await f.run(1);
  const head=f.store.list<V7ProgressState>('v7-progress-state').find(row=>row.value.subject.planQuestionId==='q-one')!;
  assert.ok(head);
  for(const store of [f.store,f.open()]){
    const before=history(store), sent=f.wires(), get=store.get.bind(store);
    const method=t.mock.method(store,'get',((id:string,revision?:number)=>
      id===head.id&&revision===undefined?null:get(id,revision)) as typeof store.get);
    try{assert.throws(()=>deepPlanSelection(store,'p',f.scope),{code:'discovery_progress_conflict'});}finally{method.mock.restore();}
    assert.equal(history(store),before);assert.deepEqual(f.wires(),sent);
  }
});

for(const point of ['paid','typed-paid','applied','assessed'] as const)test(`5.6: cold recovery at ${point} uses the original deep identity before a new actor or allowance`,async t=>{
  const f=await ready(t);let cut=false;
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    const trigger=point==='paid'||point==='typed-paid'?writes.some(row=>row.kind==='research-turn'&&row.expected===0)
      :point==='applied'?writes.some(row=>row.kind==='research-attempt-binding')
      :writes.some(row=>row.kind==='v7-progress-application');
    if(trigger&&!cut){cut=true;throw point==='typed-paid'
      ?new EngineError('discovery_deep_execution_invalid','5.6 typed paid-application cut')
      :new Error(`5.6 ${point} cut`);}return commit();
  });
  try{await f.run(1);}finally{restore();}
  assert.ok(cut);assert.equal(deepCalls(f).length,1);
  const intent=deepIntents(f.store)[0]!, call=intent.value.call;
  const current=f.store.get<typeof f.environment.value>(f.environment.id)!;
  f.engine.environments.configure('p',{...current.value,implementer:{...current.value.implementer,actor:'new-actor'}},current.revision);
  if(point==='paid'){
    const old=readVariantScope(f.store,'p',f.scope), state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
    owner(f.store,{...choiceScope(f),operation:'revise',previous:old.scope.value.decision,expectedSelection:reference(state)});
  }
  const sent=f.wires().length;
  const restored=await f.run(1,f.open(),true);
  assert.equal(deepCalls(f).length,1);assert.equal(f.wires().length,sent,'paid recovery never buys for today actor');
  assert.deepEqual(f.store.get<ResearchConsumerIntent>(intent.id)!.value.call,call);
  assert.equal(deepIntents(f.store).length,1);
  const applied=f.store.get<ResearchConsumerIntent>(intent.id)!;assert.equal(applied.value.state,'applied');
  const original=readDeepResearchResult(f.open(),'p',reference(applied));
  assert.deepEqual(original.preparation.preparation.value.scope,f.scope);
  assert.equal(original.intent.value.role.actor,'model-author');
  if(point==='assessed')assert.equal(deepPlanSelection(f.store,'p',f.scope).coverage.cells[0]!.covered,true);
  else assert.equal(restored.value.pauseCode,'research_assessment_pending');
  await inert(f,f.open(),()=>f.run(1,f.open(),true));
});
