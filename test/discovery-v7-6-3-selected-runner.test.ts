import test, { describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { Researcher, readSelectedResearchPause, SELECTED_DOSSIER_PENDING, SELECTED_DOSSIER_PAUSE } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet } from '../src/discovery/discovery-variants.js';
import { V7_AXES } from '../src/discovery/v7-contracts.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion, type DiscoveryFixture } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { discoveryInspection, readVariantHandoff, DEEP_FRONTIER_STOP_KIND } from '../src/discovery/discovery-outcome.js';
import { readSelectedDossier, SELECTED_DOSSIER_KIND } from '../src/discovery/selected-dossier.js';
import { resolveClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';
import { canonical } from '../src/canonical.js';
import { readDeepResearchResult, runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { readVariantScope } from '../src/discovery/variant-scope.js';
import type { ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
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
async function setup(t: Parameters<typeof discoveryFixture>[0], questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')], initialMode: 'questions'|'bypass'|null = 'questions',
  shared?: { project: string; fixture: DiscoveryFixture }) {
  const project = shared?.project ?? 'p';
  const base = shared?.fixture ?? discoveryFixture(t, 'omg-selected-runner-');
  const f = shared ? { ...base, root: join(base.root, project) } : base;
  if (shared) mkdirSync(f.root, { recursive: true });
  f.engine.execute({ type: 'create-project', project: project, title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure({selectedAxes:true});
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
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):r.subject.deepPreparation?(s.deepTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create(project, 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, project, questions);
  function mode(value: 'questions'|'bypass', store = f.store) {
    const request = { project: project, mode: value, previous: store.get(`project-mode:${project}`) ? reference(store.get(`project-mode:${project}`)!) : null };
    const sessions = new ProjectModeSessions(store), invitation = issueProjectModeInvitation(store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: project, invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const initial = initialMode === null ? null : mode(initialMode);
  if (initial) {
    const cal = f.store.write({ id: `variant-calibration:${project}`, kind: 'transport-fixture', expected: 0, value: { projectId: project } });
    for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
      { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? {snapshot: reference(cal)} : {set: reference(cal)}), mode: reference(initial), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  }
  writeFileSync(wire, '');
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run(project, v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const generationCalls = () => wires().filter(row => row.subject.variantSubject);
  const nextEdition = (store = f.store) => {
    const discovery = new Discovery(store), engine = new ProductEngine(store);
    const plan = store.get<Question>(v.plan.id)!; discovery.reopen(plan.id, plan.revision);
    const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(v.draft.id)!;
    const source = discovery.evidence.document(project, 'edition-two', 'New accepted edition', 'text/plain', 0);
    answerDiscoveryFixture(engine, project, draft, question, validPlan(v.frameRef, questions, 2, v.planAnswer), source);
    return store.get<Question>(plan.id)!.value.answer!;
  };
  return { ...f, project, v, environment, command, run, wires, generationCalls, configure, mode, initial, nextEdition };
}
const money = (store: Store) => store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind)).flatMap(row => store.history(row.id));
function choiceScope(f: Awaited<ReturnType<typeof setup>>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
  const state = f.store.get<VariantState>(variantStateId(f.project, f.v.draft.id))!;
  const set = f.store.get<VariantSet>(state.value.set!.id, state.value.set!.revision)!;
  return { action: VARIANT_OWNER_ACTION, projectId: f.project, draft: set.value.draft, set: reference(set),
    mode: reference(f.store.get(`project-mode:${f.project}`)!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: kind === 'choose' ? { kind, member: set.value.members[0]!, reason: 'Authorized owner chooses the member' }
      : { kind, reason: 'Authorized owner rejects the exact set' } };
}
function owner(store: Store, scope: VariantChoiceScope) {
  const sessions = new VariantChoiceSessions(store), issued = issueVariantChoiceInvitation(store, scope);
  assert.ok(issued.ok); if (!issued.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ projectId: scope.projectId, invitation: issued.value.invitation });
  assert.ok(login.ok); if (!login.ok) assert.fail('Expected successful owner exchange');
  const act = answerVariantChoice(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok); return act;
}

const deepCalls = (f: Awaited<ReturnType<typeof setup>>) => f.wires().filter(row => row.subject.deepPreparation);
const deepIntents = (store: Store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => Object.hasOwn(row.value.cursor, 'deepPreparation'));
async function inert(f: Awaited<ReturnType<typeof setup>>, store: Store, action: () => Promise<unknown>) {
  const paid=money(store),wire=f.wires();
  const result=await storeUnchanged(store,action);
  assert.deepEqual(money(store),paid);assert.deepEqual(f.wires(),wire);return result;
}
async function ready(t:Parameters<typeof discoveryFixture>[0],model=false,config:Record<string,unknown>={},
  shared?: { project: string; fixture: DiscoveryFixture; questions?: PlanQuestion[] }) {
  const f=await setup(t,shared?.questions,model?'bypass':'questions',shared);
  const generated=await f.run(3);
  assert.equal(generated.value.pauseCode,model?'research_turns_exhausted':'research_variant_owner_required',generated.value.error!);
  f.configure(config);
  if(model)await f.run(1);else owner(f.store,choiceScope(f));
  const pending=await f.run(1,f.store,true), details=JSON.parse(pending.value.error!);
  assert.equal(pending.value.pauseCode,'research_deep_frontier_pending',pending.value.error!);
  const handoff=(await readVariantHandoff(f.store,f.project,details.handoff)).record;
  assert.equal(handoff.value.next,'deep');assert.deepEqual(handoff.value.scope,details.scope);
  assert.deepEqual(reference(readVariantScope(f.store,f.project,details.scope).scope),details.scope);
  return {...f,scope:details.scope,pending};
}

const drive=(f:Awaited<ReturnType<typeof ready>>,store=f.store)=>new EarlyStageDriver(new ProductEngine(store))
  .run({project:f.project,draftId:f.v.draft.id,maxTurns:8,maxCalls:20});
async function complete(f:Awaited<ReturnType<typeof ready>>,run:Revision<ResearchRun>) {
  assert.equal(run.value.pauseCode,SELECTED_DOSSIER_PAUSE,run.value.error!);
  const saved=JSON.parse(run.value.error!), proof=readSelectedDossier(f.store,f.project,saved.selected);
  const handoff=(await readVariantHandoff(f.store,f.project,saved.handoff)).record;
  assert.deepEqual(reference(proof.manifest),saved.dossier);assert.equal(proof.manifest.value.completeness,'complete');
  for(const axis of V7_AXES){
    assert.ok(proof.manifest.value.axes[axis].claims.length,axis);
    for(const address of proof.manifest.value.axes[axis].claims){
      const claim=resolveClaimAddress(f.store,address).claim;
      assert.ok(claim&&typeof claim==='object'&&!Array.isArray(claim));
      assert.equal(claim.axis,axis);
      assert.ok(proof.materials.some(row=>canonical(row.claim)===canonical(address)));
    }
  }
  assert.equal(proof.coverage.missing.length,0);assert.deepEqual(proof.record.value.scope,f.scope);
  assert.deepEqual(proof.record.value.member,handoff.value.choice);assert.deepEqual(proof.record.value.decision,handoff.value.decision);
  assert.equal(f.store.list<{projectId:string}>(DEEP_FRONTIER_STOP_KIND).filter(row=>row.value.projectId===f.project).length,0);
  assert.equal(f.store.list<{projectId:string}>(SELECTED_DOSSIER_KIND).filter(row=>row.value.projectId===f.project).length,1);assert.equal(f.store.list<{projectId:string}>('discovery-dossier-manifest').filter(row=>row.value.projectId===f.project).length,1);
  assert.equal(discoveryInspection(f.store,f.store.get<DiscoveryDraft>(f.v.draft.id)!).outcome.state,'researching');
  return {saved,proof,handoff};
}
async function fixed(f:Awaited<ReturnType<typeof ready>>,run:Revision<ResearchRun>,coldRunner=false) {
  assert.equal(run.value.pauseCode,SELECTED_DOSSIER_PAUSE);
  const saved=JSON.parse(run.value.error!),cold=f.open(),before=history(f.store);
  await inert(f,coldRunner?cold:f.store,async()=>{
    assert.deepEqual(await f.run(8,coldRunner?cold:f.store,true),run);
  });
  await inert(f,coldRunner?f.store:cold,async()=>{
    const result=await drive(f,coldRunner?f.store:cold);
    assert.equal(result.end,'stage_paused',JSON.stringify(result));assert.equal(result.reason?.code,SELECTED_DOSSIER_PAUSE);
    assert.deepEqual(result.reason?.handoff,saved.handoff);assert.deepEqual(result.reason?.selected,saved.selected);
    assert.deepEqual(result.reason?.dossier,saved.dossier);assert.equal(result.reason?.completeness,'complete');
    assert.equal(result.reason?.next,'dossier-assessment');assert.equal(result.budget.callsMade,0);
    assert.equal(result.stageResult?.discovery?.state,'researching');assert.equal(result.om,null);
  });
  assert.equal(history(f.store),before);
}
for(const model of [false,true])test(`selected runner: real ${model?'model':'owner'} choice reaches complete recipient through both public doors`,async t=>{
  const f=await ready(t,model),run=await f.run(2);
  await complete(f,run);
  assert.deepEqual(deepCalls(f).map(row=>row.subject.deepCell.subject.planQuestionId),['q-one','q-two']);
  assert.equal(f.generationCalls().filter(row=>row.subject.variantSubject.kind==='proposal').length,1);
  assert.equal(f.generationCalls().filter(row=>row.subject.variantSubject.kind==='decision').length,model?1:0);
  for(const intent of deepIntents(f.store))assert.equal(readDeepResearchResult(f.store,'p',reference(intent)).verification,'proven');
  await fixed(f,run,model);
});
test('selected runner: closed cells without material on every investigated axis refuse publication without further payment',async t=>{
  const f=await ready(t,false,{selectedAxes:false});let paid:unknown,wire:unknown;
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    const rows=commit();
    if(writes.some(row=>row.kind==='research-run'&&(row.value as ResearchRun).pauseCode===SELECTED_DOSSIER_PENDING)){
      paid=money(f.store);wire=f.wires();
    }
    return rows;
  });
  await assert.rejects(()=>f.run(2),{code:'discovery_dossier_invalid'});restore();
  assert.equal(deepPlanSelection(f.store,'p',f.scope).coverage.missing.length,0);
  assert.equal(deepCalls(f).length,2);assert.ok(paid);assert.ok(wire);
  assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);
  assert.equal(f.store.list(SELECTED_DOSSIER_KIND).length,0);assert.equal(f.store.list('discovery-dossier-manifest').length,0);
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    await assert.rejects(()=>f.run(1,store,true),{code:'discovery_dossier_invalid'});
    const result=await drive(f,store);assert.equal(result.end,'blocked');assert.equal(result.reason?.code,'discovery_dossier_invalid');
  });
});
test('selected runner: driver execution restores the last paid MR/P before publishing the complete pair',async t=>{
  const f=await ready(t);await f.run(1);let cut=false;
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    if(!cut&&writes.some(w=>w.kind==='v7-progress-application')){cut=true;throw new Error('cut before final P');}
    return commit();
  });
  await f.run(1);restore();assert.ok(cut);assert.equal(deepCalls(f).length,2);
  assert.equal(f.store.list(SELECTED_DOSSIER_KIND).length,0);
  const paid=money(f.store),wire=f.wires();
  const result=await drive(f,f.open());
  assert.equal(result.reason?.code,SELECTED_DOSSIER_PAUSE,JSON.stringify(result));
  assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);
  const run=f.store.list<ResearchRun>('research-run').find(r=>r.value.draftId===f.v.draft.id)!;
  await fixed(f,run);
});
for(const cutAt of ['before-pair','after-pair','before-pause'] as const)
test(`selected runner: cold cut ${cutAt} restores one exact pair without payment`,async t=>{
  const f=await ready(t);let cut=false;
  const original=Store.prototype.atomicWrite;
  const atomic=t.mock.method(Store.prototype,'atomicWrite',function(this:Store,prepare:Parameters<Store['atomicWrite']>[0]){
    if(this===f.store&&!cut&&cutAt==='before-pair'){
      const run=this.list<ResearchRun>('research-run').find(r=>r.value.draftId===f.v.draft.id);
      if(run?.value.pauseCode===SELECTED_DOSSIER_PENDING){cut=true;throw new Error('cut before selected pair');}
    }
    const result=original.call(this,prepare);
    if(this===f.store&&!cut&&cutAt==='after-pair'&&result.records.some(r=>r.kind===SELECTED_DOSSIER_KIND)){
      cut=true;throw new Error('cut after selected pair');
    }
    return result;
  });
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    if(!cut&&cutAt==='before-pause'&&writes.some(w=>w.kind==='research-run'&&(w.value as any).pauseCode===SELECTED_DOSSIER_PAUSE)){
      cut=true;throw new Error('cut before selected final pause');
    }
    const rows=commit();
    // Unrelated events do not sever the exact pending run at the producer cut.
    if(writes.some(w=>w.kind==='research-run'&&(w.value as any).pauseCode===SELECTED_DOSSIER_PENDING))
      f.open().write({id:'unrelated-selected-event',kind:'fixture-event',expected:0,value:{unrelated:true}});
    return rows;
  });
  await assert.rejects(()=>f.run(2),/cut/);restore();atomic.mock.restore();assert.ok(cut);
  const existing=f.store.list(SELECTED_DOSSIER_KIND)[0],paid=money(f.store),wire=f.wires();
  const run=await f.run(1,f.open(),true),{saved}=await complete(f,run);
  if(existing)assert.deepEqual(saved.selected,reference(existing));
  assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);assert.equal(deepCalls(f).length,2);
  await fixed(f,run);
});
describe('selected runner: two projects',()=>{
  let seed:{a:Awaited<ReturnType<typeof ready>>;b:Awaited<ReturnType<typeof ready>>;wireA:string;wireB:string};
  const cleanups:Array<()=>void>=[];
  before(async()=>{
    const started=performance.now();
    const context={after:(fn:()=>void)=>{cleanups.push(fn);}};
    const a=await ready(context);
    console.log(`# two-project A chosen duration_ms: ${performance.now()-started}`);
    async function paidPrefix(f:Awaited<ReturnType<typeof ready>>,cells:number){
      const phase=performance.now();
      const original=Store.prototype.atomicWrite;
      const cut=mock.method(Store.prototype,'atomicWrite',function(this:Store,prepare:Parameters<Store['atomicWrite']>[0]){
        if(this===f.store&&this.get<ResearchRun>(f.pending.id)?.value.pauseCode===SELECTED_DOSSIER_PENDING)
          throw new Error('seed before selected pair');
        return original.call(this,prepare);
      });
      try { await assert.rejects(()=>f.run(cells),/seed before selected pair/); }
      finally { cut.mock.restore(); }
      assert.equal(deepCalls(f).length,cells);
      console.log(`# two-project ${f.project} paid prefix duration_ms: ${performance.now()-phase}`);
    }
    await paidPrefix(a,2);
    const phase=performance.now();
    const b=await ready(context,false,{}, {project:'other-project',fixture:a,questions:[planQuestion('q-two','market')]});
    console.log(`# two-project B chosen duration_ms: ${performance.now()-phase}`);
    await paidPrefix(b,1);
    assert.equal(a.store.list(SELECTED_DOSSIER_KIND).length,0);
    seed={a,b,wireA:readFileSync(join(a.root,'wire.ndjson'),'utf8'),wireB:readFileSync(join(b.root,'wire.ndjson'),'utf8')};
    console.log(`# two-project genuine paid-prefix preparation duration_ms: ${performance.now()-started}`);
  });
  after(()=>{for(const cleanup of cleanups)cleanup();});
  let copy=0;
  async function world(t:test.TestContext){
    // Copy real immutable records, event boundaries and identities unchanged.
    // Historical commands keep their original addresses; new runtime is isolated below.
    const path=join(seed.a.root,`case-${++copy}.sqlite`),source=new DatabaseSync(seed.a.path,{readOnly:true});
    try { await backup(source,path); } finally { source.close(); }
    const stores:Store[]=[],open=()=>{const store=new Store(path);stores.push(store);return store;},store=open();
    t.after(()=>{for(const db of stores)db.close();});
    const connect=(f:typeof seed.a)=>{
      const root=join(seed.a.root,`case-${copy}-runtime-${f.project}`);mkdirSync(root);
      const settings=join(root,'settings.json'),wire=join(root,'wire.ndjson'),adapter=join(root,'adapter.mjs');
      writeFileSync(settings,readFileSync(join(f.root,'settings.json')));
      writeFileSync(wire,f.project===seed.a.project?seed.wireA:seed.wireB);
      writeFileSync(adapter,readFileSync(join(f.root,'adapter.mjs'),'utf8').replaceAll(f.root,root));
      const engine=new ProductEngine(store),command={executable:process.execPath,args:[adapter]};
      // A lawful current revision points new runtime at isolated files. Paid
      // historical environments and every saved Ref/hash stay byte-for-byte.
      const environment=engine.environments.configure(f.project,{...f.environment.value,workspace:root,
        implementer:{...f.environment.value.implementer,command},reviewer:{...f.environment.value.reviewer,command},
        fullCheck:command},f.environment.revision);
      const wires=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      return {...f,root,path,store,open,engine,environment,command,discovery:new Discovery(store),wires,
        generationCalls:()=>wires().filter(row=>row.subject.variantSubject),
        run:(limit=8,at=store,restoreOnly=false)=>new Researcher(at,new Discovery(at),new ProductEngine(at).environments)
          .run(f.project,f.v.draft.id,limit,undefined,{producerPolicy:{discovery:7},restoreOnly})};
    };
    return {f:connect(seed.a),b:connect(seed.b)};
  }
  // Both doors recover each cut; one hot and one cold recovery per cut class.
  for(const [door,cold,cutAt] of [
    ['researcher',false,'before-pair'],['driver',true,'before-pair'],
    ['researcher',true,'after-pair'],['driver',false,'after-pair'],
  ] as const)
test(`selected runner: two projects ${door} ${cold?'cold':'hot'} cut ${cutAt} keeps each exact publication`,async t=>{
  const {f,b}=await world(t),original=Store.prototype.atomicWrite;let cut=false;
  const mock=t.mock.method(Store.prototype,'atomicWrite',function(this:Store,prepare:Parameters<Store['atomicWrite']>[0]){
    if(this===f.store&&!cut&&cutAt==='before-pair'
      &&this.get<ResearchRun>(f.pending.id)?.value.pauseCode===SELECTED_DOSSIER_PENDING){
      cut=true;throw new Error('project A cut before pair');
    }
    const result=original.call(this,prepare);
    if(this===f.store&&!cut&&cutAt==='after-pair'&&result.records.some(row=>row.kind===SELECTED_DOSSIER_KIND)){
      cut=true;throw new Error('project A cut after pair');
    }
    return result;
  });
  await assert.rejects(()=>f.run(1,f.store,true),/project A cut/);mock.mock.restore();assert.ok(cut);
  const pending=f.store.get<ResearchRun>(f.pending.id)!,pendingSaved=JSON.parse(pending.value.error!);
  assert.equal(pending.value.pauseCode,SELECTED_DOSSIER_PENDING);
  const existing=f.store.list(SELECTED_DOSSIER_KIND)[0];
  assert.equal(!!existing,cutAt==='after-pair');
  const aIntents=deepIntents(f.store).filter(row=>row.value.projectId===f.project);
  assert.equal(aIntents.length,2);assert.equal(deepCalls(f).length,2);

  // A remains pending while B publishes its own real paid prefix in this DB.
  const bRun=await b.run(1,b.store,true);
  const bProof=await complete(b,bRun);
  assert.deepEqual(deepCalls(b).map(row=>row.subject.deepCell.subject.planQuestionId),['q-two']);
  assert.equal(b.generationCalls().filter(row=>row.subject.variantSubject.kind==='proposal').length,1);
  assert.deepEqual(f.store.get(pending.id),pending);
  // This later boundary still sees A's pending body: boundary matching alone
  // would treat B as a second (or the only) candidate for A.
  assert.deepEqual(f.store.getAtEvent(bProof.proof.record.value.boundary.sequence,pending.id),pending);
  const paid=money(f.store),aWire=f.wires(),bWire=b.wires(),store=cold?f.open():f.store;
  await inert(f,store,async()=>{
    const found=await readSelectedResearchPause(store,f.project,f.v.draft.id,pending);
    assert.deepEqual(reference(found.handoff),pendingSaved.handoff);
    assert.deepEqual(found.selected?reference(found.selected.record):null,existing?reference(existing):null);
  });
  let run:Revision<ResearchRun>;
  if(door==='researcher')run=await f.run(1,store,true);
  else {
    const result=await drive(f,store);
    assert.equal(result.end,'stage_paused',JSON.stringify(result));
    assert.equal(result.reason?.code,SELECTED_DOSSIER_PAUSE);
    run=store.get<ResearchRun>(pending.id)!;
    const saved=JSON.parse(run.value.error!);
    assert.deepEqual(result.reason?.handoff,saved.handoff);assert.deepEqual(result.reason?.selected,saved.selected);
    assert.deepEqual(result.reason?.dossier,saved.dossier);assert.equal(result.budget.callsMade,0);
  }
  const {saved}=await complete(f,run);
  assert.deepEqual(saved.handoff,pendingSaved.handoff);
  if(existing)assert.deepEqual(saved.selected,reference(existing));
  assert.notDeepEqual(saved.selected,bProof.saved.selected);assert.notDeepEqual(saved.dossier,bProof.saved.dossier);
  assert.equal(f.store.list(SELECTED_DOSSIER_KIND).length,2);
  assert.equal(f.store.list('discovery-dossier-manifest').length,2);
  for(const ref of [saved.selected,saved.dossier,bProof.saved.selected,bProof.saved.dossier])
    assert.equal(f.store.history(ref.id).length,1);
  assert.deepEqual(f.store.get(pending.id,pending.revision),pending);
  assert.deepEqual(f.store.get(bRun.id),bRun);
  for(const intent of aIntents)assert.deepEqual(f.store.get(intent.id),intent);
  assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),aWire);assert.deepEqual(b.wires(),bWire);
  // One cold historical reader cycle preserves B's complete proof. Ready
  // repeats exercise both public doors once, without another cold-loop matrix.
  const coldStore=f.open(),fixedHistory=history(f.store);
  await inert(f,coldStore,async()=>{
    assert.deepEqual(readSelectedDossier(coldStore,b.project,bProof.saved.selected),bProof.proof);
    const old=await readSelectedResearchPause(coldStore,b.project,b.v.draft.id,bRun);
    assert.deepEqual(reference(old.handoff),bProof.saved.handoff);assert.deepEqual(old.selected,bProof.proof);
  });
  await inert(f,store,async()=>{
    assert.deepEqual(await f.run(8,store,true),run);
    const repeated=await drive(f,coldStore);
    assert.equal(repeated.reason?.code,SELECTED_DOSSIER_PAUSE);
    assert.deepEqual(repeated.reason?.handoff,saved.handoff);assert.deepEqual(repeated.reason?.selected,saved.selected);
    assert.deepEqual(repeated.reason?.dossier,saved.dossier);assert.equal(repeated.budget.callsMade,0);
  });
  assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),aWire);assert.deepEqual(b.wires(),bWire);
  assert.equal(history(f.store),fixedHistory);
  assert.equal(readFileSync(join(seed.a.root,'wire.ndjson'),'utf8'),seed.wireA);
  assert.equal(readFileSync(join(seed.b.root,'wire.ndjson'),'utf8'),seed.wireB);
});
});
for(const change of ['choice','plan','mode'] as const)test(`selected runner: exact carrier survives late ${change} before its final pause`,async t=>{
  const f=await ready(t),original=Store.prototype.atomicWrite;let cut=false;
  const mock=t.mock.method(Store.prototype,'atomicWrite',function(this:Store,prepare:Parameters<Store['atomicWrite']>[0]){
    const result=original.call(this,prepare);
    if(this===f.store&&!cut&&result.records.some(r=>r.kind===SELECTED_DOSSIER_KIND)){cut=true;throw new Error('pair saved');}
    return result;
  });
  await assert.rejects(()=>f.run(2),/pair saved/);mock.mock.restore();assert.ok(cut);
  const carrier=f.store.list(SELECTED_DOSSIER_KIND)[0]!,old=readSelectedDossier(f.store,'p',reference(carrier));
  if(change==='plan')f.nextEdition();else if(change==='mode')f.mode('bypass');else {
    const state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
    owner(f.store,{...choiceScope(f),operation:'revise',previous:state.value.decision!,expectedSelection:reference(state)});
  }
  const paid=money(f.store),wire=f.wires(),run=await f.run(1,f.open(),true);
  assert.deepEqual(JSON.parse(run.value.error!).selected,reference(carrier));
  assert.deepEqual(readSelectedDossier(f.open(),'p',reference(carrier)),old);
  assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);await fixed(f,run);
});
test('selected runner: a null pending carrier refuses with a typed error without another pair or payment',async t=>{
  const f=await ready(t),original=Store.prototype.atomicWrite;let cut=false;
  const mock=t.mock.method(Store.prototype,'atomicWrite',function(this:Store,prepare:Parameters<Store['atomicWrite']>[0]){
    const result=original.call(this,prepare);
    if(this===f.store&&!cut&&result.records.some(row=>row.kind===SELECTED_DOSSIER_KIND)){
      cut=true;throw new Error('saved pair before damaged carrier');
    }
    return result;
  });
  await assert.rejects(()=>f.run(2),/saved pair/);mock.mock.restore();assert.ok(cut);
  const carrier=f.store.list(SELECTED_DOSSIER_KIND)[0]!;
  f.store.write({id:carrier.id,kind:carrier.kind,expected:carrier.revision,value:null});
  const before=history(f.store);
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    await assert.rejects(()=>f.run(1,store,true),e=>e instanceof EngineError);
    const result=await drive(f,store);assert.equal(result.end,'blocked');
  });
  assert.equal(history(f.store),before);
  assert.equal(deepCalls(f).length,2);
  assert.equal(f.store.list(SELECTED_DOSSIER_KIND).length,1);assert.equal(f.store.list('discovery-dossier-manifest').length,1);
});
test('selected runner: later real applied P cannot rewrite the saved complete carrier',async t=>{
  const f=await ready(t),run=await f.run(2),{saved,proof}=await complete(f,run);
  const first=deepIntents(f.store).find(row=>row.value.cursor.subject?.planQuestionId==='q-one')!;
  assert.ok(first);f.configure({close:false,outcome:'open'});
  // P keeps this subject's original run. New managed work activates that run;
  // the prior exact selected pause and carrier remain historically readable.
  const result=(await runDeepResearch(f.store,{projectId:'p',deepPreparation:first.value.cursor.deepPreparation!,environment:f.environment,owner:reference(run)}))!;
  assert.equal(deepCalls(f).length,3);assert.equal(deepCalls(f)[2]!.subject.deepCell.subject.planQuestionId,'q-one');
  const packet=projectAttemptPacket(f.store,{project:'p',...first.value.cursor.subject!,entries:[{attempt:reference(result.attempt),binding:reference(result.binding)}]});
  const mr=await assessAttemptsWithRequirements(f.store,packet,v7ProgressBaseline(f.store,packet),f.environment,f.root);
  applyDiscoveryAssessment(f.store,'p',reference(mr));
  const frontier=deepPlanSelection(f.store,'p',f.scope),cells=frontier.coverage.cells;
  assert.equal(cells.find(row=>row.cell.subject.planQuestionId==='q-one')!.covered,false);
  assert.equal(cells.find(row=>row.cell.subject.planQuestionId==='q-two')!.covered,true);
  assert.equal(frontier.progress.find(row=>row.question==='q-one')!.summary!.outcome,'open');
  const active=f.store.get<ResearchRun>(run.id)!;
  assert.ok(active.revision>run.revision);assert.equal(active.value.status,'running');
  assert.equal(active.value.pauseCode,null);assert.equal(active.value.error,null);
  assert.deepEqual(f.store.get(run.id,run.revision),run);
  const before=history(f.store);
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    const historical=await readSelectedResearchPause(store,'p',f.v.draft.id,run);
    assert.deepEqual(historical.selected,proof);
    assert.deepEqual(reference(historical.selected!.record),saved.selected);
    assert.deepEqual(reference(historical.selected!.manifest),saved.dossier);
    assert.deepEqual(reference(historical.handoff),saved.handoff);
  });
  assert.equal(history(f.store),before);
});
test('selected runner: missing null foreign and mixed pause addresses refuse both doors without control writes',async t=>{
  const f=await ready(t),original=await f.run(2),{saved}=await complete(f,original);
  for(const field of ['handoff','selected','dossier'])for(const fault of ['absent','null','missing','foreign']){
    const damaged=structuredClone(saved);
    if(fault==='absent')delete damaged[field];else if(fault==='null')damaged[field]=null;
    else if(fault==='missing')damaged[field]={...saved[field],id:'missing-selected-address'};
    else damaged[field]=saved[field==='selected'?'dossier':'selected'];
    f.store.write({id:original.id,kind:original.kind,expected:f.store.get(original.id)!.revision,value:{...original.value,error:canonical(damaged)}});
    for(const store of field==='selected'?[f.store,f.open()]:[f.store])await inert(f,store,async()=>{
      await assert.rejects(()=>f.run(1,store,true),e=>e instanceof EngineError);
      const result=await drive(f,store);assert.equal(result.end,'blocked',JSON.stringify(result));assert.equal(result.reason?.selected,undefined);
    });
  }
  for(const patch of [{stop:saved.handoff},{completeness:'partial'},{selected:null},{contract:'forged-complete'}]){
    const damaged={...saved,...patch};
    f.store.write({id:original.id,kind:original.kind,expected:f.store.get(original.id)!.revision,value:{...original.value,error:canonical(damaged)}});
    for(const store of Object.hasOwn(patch,'stop')?[f.store,f.open()]:[f.store])await inert(f,store,async()=>{
      await assert.rejects(()=>f.run(1,store,true),{code:'discovery_selected_pause_invalid'});
      assert.equal((await drive(f,store)).end,'blocked');
    });
  }
  const mixed={...saved,code:'research_dossier_assessment_unavailable',completeness:'partial'};
  f.store.write({id:original.id,kind:original.kind,expected:f.store.get(original.id)!.revision,value:{...original.value,pauseCode:mixed.code,error:canonical(mixed)}});
  const before=history(f.store);
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    await assert.rejects(()=>f.run(1,store,true),{code:'discovery_selected_pause_invalid'});
    assert.equal((await drive(f,store)).end,'blocked');
  });
  assert.equal(history(f.store),before);
});
for(const change of ['frame','plan','mode','choice'] as const)test(`selected runner: second Store ${change} before publication refuses without a half pair`,async t=>{
  const f=await ready(t),other=f.open(),original=Store.prototype.atomicWrite;
  let fired=false,after='',paid:unknown,wire:unknown;
  const mock=t.mock.method(Store.prototype,'atomicWrite',function(this:Store,prepare:Parameters<Store['atomicWrite']>[0]){
    if(this===f.store&&!fired&&this.list<ResearchRun>('research-run').some(r=>r.value.pauseCode===SELECTED_DOSSIER_PENDING)){
      fired=true;
      if(change==='plan')f.nextEdition(other);else if(change==='mode')f.mode('bypass',other);
      else if(change==='frame'){
        const q=other.list<Question>('question').find(q=>q.value.draftId===f.v.draft.id&&q.value.spec.field==='frame')!;
        new Discovery(other).reopen(q.id,q.revision);
      }else{const state=other.get<VariantState>(variantStateId('p',f.v.draft.id))!;
        owner(other,{...choiceScope(f),operation:'revise',previous:state.value.decision!,expectedSelection:reference(state)});}
      after=history(other);paid=money(other);wire=f.wires();
    }
    return original.call(this,prepare);
  });
  await assert.rejects(()=>f.run(2),{code:'discovery_selected_dossier_stale'});mock.mock.restore();assert.ok(fired);
  assert.equal(history(f.store),after);assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);
  assert.equal(f.store.list(SELECTED_DOSSIER_KIND).length,0);assert.equal(f.store.list('discovery-dossier-manifest').length,0);
});
test('selected runner: competing run revision before final pause preserves its row and the atomic pair',async t=>{
  const f=await ready(t),other=f.open();let fired=false,after='',paid:unknown,wire:unknown;
  const restore=interceptWrites(t,f.store,(writes,commit)=>{
    if(!fired&&writes.some(w=>w.kind==='research-run'&&(w.value as any).pauseCode===SELECTED_DOSSIER_PAUSE)){
      fired=true;const run=other.list<ResearchRun>('research-run').find(r=>r.value.draftId===f.v.draft.id)!;
      other.write({id:run.id,kind:run.kind,expected:run.revision,value:run.value});
      after=history(other);paid=money(other);wire=f.wires();
    }
    return commit();
  });
  await assert.rejects(()=>f.run(2),{code:'revision_conflict'});restore();assert.ok(fired);
  assert.equal(history(f.store),after);assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);
  assert.equal(f.store.list(SELECTED_DOSSIER_KIND).length,1);assert.equal(f.store.list('discovery-dossier-manifest').length,1);
  const run=await f.run(1,f.open(),true);assert.deepEqual(money(f.store),paid);assert.deepEqual(f.wires(),wire);await fixed(f,run);
});
