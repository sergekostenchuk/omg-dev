import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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
import { discoveryInspection, readVariantHandoff, produceDeepFrontierStop, readDeepFrontierStop, DEEP_FRONTIER_STOP_KIND } from '../src/discovery/discovery-outcome.js';
import { produceStoppedPartialDossier, readPartialDossier, projectDossierManifest } from '../src/discovery/dossier-manifest.js';
import { V7_AXES } from '../src/discovery/v7-contracts.js';
import { readSelectedDossier } from '../src/discovery/selected-dossier.js';
import { resolveClaimAddress } from '../src/discovery/claim-address.js';
import { EngineError } from '../src/errors.js';
import { canonical, hashJson } from '../src/canonical.js';
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { readVariantScope } from '../src/discovery/variant-scope.js';
import type { ResearchConsumerIntent } from '../src/discovery/response-recovery.js';

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
async function setup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')], initialMode: 'questions'|'bypass'|null = 'questions') {
  const f = discoveryFixture(t, 'omg-57-');
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
async function ready(t:test.TestContext,model=false,config:Record<string,unknown>={}) {
  const f=await setup(t,undefined,model?'bypass':'questions');
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

for (const model of [false, true]) test(`5.7: real ${model ? 'model' : 'owner'} choice and paid exhaustion produce exact partial then hot/cold fixed point`, async t => {
  const f = await ready(t, model);
  f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
  const result = await f.run(2), details = JSON.parse(result.value.error!);
  assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', result.value.error!);
  const stop = await readDeepFrontierStop(f.store, 'p', details.stop);
  assert.equal(stop.record.value.reason, 'budget');
  assert.equal(stop.coverage.missing.length, 1);
  assert.equal(stop.coverage.missing[0]!.cell.subject.planQuestionId, 'q-two');
  assert.equal(deepCalls(f).length, 1);
  const dossier = await readPartialDossier(f.store, 'p', details.dossier);
  assert.deepEqual(reference(dossier.stop!), details.stop);
  assert.deepEqual(reference(dossier.handoff), details.handoff);
  assert.equal(dossier.record.value.completeness, 'partial');
  assert.ok(dossier.materials.length >= 3);
  assert.equal(discoveryInspection(f.store, f.v.draft).outcome.state, 'researching');
  for (const store of [f.store, f.open()]) await inert(f, store, async () => {
    assert.deepEqual(await f.run(9, store), result);
    assert.deepEqual(await f.run(1, store, true), result);
    assert.equal((await produceStoppedPartialDossier(store, 'p', details.stop)).repeated, true);
    assert.deepEqual(reference((await readPartialDossier(store, 'p', details.dossier)).record), details.dossier);
  });
});
test('5.7: one stalled cell does not stop another; all applied N limits stop without repeat payment', async t => {
  const f = await ready(t, false, { deepMode: 'impossible' });
  await f.run(3);
  assert.equal(f.store.list(DEEP_FRONTIER_STOP_KIND).length, 0);
  assert.equal(deepPlanSelection(f.store, 'p', f.scope).next!.cell.subject.planQuestionId, 'q-two');
  const result = await f.run(3, f.open()), details = JSON.parse(result.value.error!);
  assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', result.value.error!);
  const proof = await readDeepFrontierStop(f.store, 'p', details.stop);
  assert.equal(proof.record.value.reason, 'stall');
  assert.equal(proof.coverage.missing.length, 2);
  assert.equal(deepCalls(f).length, 6);
  for (const store of [f.store, f.open()]) await inert(f, store, () => f.run(8, store));
});
test('5.7: complete coverage and an unpaid pending frontier are not partial', async t => {
  const f = await ready(t);f.configure({selectedAxes:true});
  await inert(f, f.store, () => assert.rejects(() => produceDeepFrontierStop(f.store, 'p', JSON.parse(f.pending.value.error!).handoff), { code: 'discovery_deep_stop_invalid' }));
  const result = await f.run(2);
  assert.equal(result.value.pauseCode, 'research_selected_dossier_assessment_unavailable', result.value.error!);
  const details=JSON.parse(result.value.error!), selected=readSelectedDossier(f.store,'p',details.selected);
  for(const axis of V7_AXES){
    assert.ok(selected.manifest.value.axes[axis].claims.length,axis);
    for(const address of selected.manifest.value.axes[axis].claims){
      const claim=resolveClaimAddress(f.store,address).claim;
      assert.ok(claim&&typeof claim==='object'&&!Array.isArray(claim));
      assert.equal(claim.axis,axis);
    }
  }
  assert.deepEqual(reference(selected.manifest),details.dossier);assert.equal(selected.manifest.value.completeness,'complete');
  assert.equal(selected.coverage.missing.length,0);assert.deepEqual(selected.record.value.scope,f.scope);
  assert.equal(f.store.list('discovery-dossier-manifest').length,1);
  assert.equal(f.store.list(DEEP_FRONTIER_STOP_KIND).length, 0);
  await inert(f, f.store, () => assert.rejects(() => produceDeepFrontierStop(f.store, 'p', JSON.parse(f.pending.value.error!).handoff), { code: 'discovery_deep_stop_invalid' }));
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    assert.deepEqual(await f.run(3,store),result);assert.deepEqual(await f.run(1,store,true),result);
  });
});

test('5.7: a real prepared intent before reservation is not terminal even when its run is paused', async t => {
  const f = await ready(t); let cut = false;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    const rows = commit();
    if (!cut && writes.some(w => w.kind === 'research-consumer-intent' && (w.value as any).cursor?.deepPreparation)) {
      cut = true; throw new Error('cut after actual deep prepared commit');
    }
    return rows;
  });
  await f.run(1); restore();
  assert.ok(cut); assert.equal(deepCalls(f).length, 0);
  assert.equal(deepIntents(f.store)[0]!.value.state, 'prepared');
  for (const store of [f.store, f.open()]) await inert(f, store, async () => {
    await f.run(1, store, true);
    await assert.rejects(() => produceDeepFrontierStop(store, 'p', JSON.parse(f.pending.value.error!).handoff), { code: 'discovery_deep_stop_invalid' });
  });
});
for (const cold of [false, true]) for (const cutAt of ['stop', 'dossier', 'pause'])
  test(`5.7: ${cold ? 'cold' : 'hot'} recovery after ${cutAt} preserves exact stop and one snapshot`, async t => {
    const f = await ready(t); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
    let cut = false;
    const original = Store.prototype.atomicWrite;
    const atomic = t.mock.method(Store.prototype, 'atomicWrite', function(this: Store, prepare: Parameters<Store['atomicWrite']>[0]) {
      const result = original.call(this, prepare);
      if (this === f.store && !cut && result.records.some(r => r.kind === (cutAt === 'stop' ? DEEP_FRONTIER_STOP_KIND : 'discovery-dossier-manifest')) && cutAt !== 'pause') {
        cut = true; throw new Error(`cut after committed ${cutAt}`);
      }
      return result;
    });
    const restore = interceptWrites(t, f.store, (writes, commit) => {
      if (cutAt === 'pause' && !cut && writes.some(w => w.kind === 'research-run' && (w.value as any).pauseCode === 'research_dossier_assessment_unavailable')) {
        cut = true; throw new EngineError('cut_before_partial_pause', 'cut before pause');
      }
      return commit();
    });
    try { await f.run(2); } catch (error) { assert.match(String(error), /cut/); }
    restore(); atomic.mock.restore(); assert.ok(cut);
    assert.equal(f.store.list(DEEP_FRONTIER_STOP_KIND).length, 1);
    const stop = reference(f.store.list(DEEP_FRONTIER_STOP_KIND)[0]!);
    const paid = money(f.store), wire = f.wires(), store = cold ? f.open() : f.store;
    const result = await f.run(1, store, true), details = JSON.parse(result.value.error!);
    assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', result.value.error!);
    assert.deepEqual(details.stop, stop);
    assert.equal(store.list(DEEP_FRONTIER_STOP_KIND).length, 1);
    assert.equal(store.list('discovery-dossier-manifest').length, 1);
    assert.deepEqual(money(store), paid); assert.deepEqual(f.wires(), wire);
    for (const again of [store, f.open()]) await inert(f, again, () => f.run(1, again, true));
  });

async function budgetAtPublication(t: test.TestContext) {
  const f = await ready(t); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
  const original = Store.prototype.atomicWrite;
  let stop: ReturnType<typeof reference> | null = null;
  const mock = t.mock.method(Store.prototype, 'atomicWrite', function(this: Store, prepare: Parameters<Store['atomicWrite']>[0]) {
    const result = original.call(this, prepare);
    const saved = result.records.find(r => r.kind === DEEP_FRONTIER_STOP_KIND);
    if (this === f.store && saved && !stop) { stop = reference(saved); throw new Error('cut after stop'); }
    return result;
  });
  await f.run(2); mock.mock.restore(); assert.ok(stop);
  return { ...f, stop: stop! };
}
test('5.7: missing/null/foreign/structural exact grounds cannot replace the proved stop', async t => {
    const f = await budgetAtPublication(t), original = (await readDeepFrontierStop(f.store, 'p', f.stop)).record.value;
    for (const field of ['handoff', 'scope', 'plan', 'decision', 'states', 'budget'] as const)
    for (const mutation of ['missing', 'null', 'foreign', 'structural']) {
      const value: any = structuredClone(original);
      if (mutation === 'missing') delete value[field];
      else if (mutation === 'null') value[field] = null;
      else if (mutation === 'foreign') value[field] = field === 'states' ? [original.plan] : original.run;
      else value[field] = field === 'states' ? [] : field === 'budget' ? {...value.budget, measured: 0} : {...value[field], hash: '0'.repeat(64)};
      const {boundary: _boundary, run: _run, ...basis} = value;
      const fake = f.store.write({ id: `${DEEP_FRONTIER_STOP_KIND}:p:${hashJson(basis)}`, kind: DEEP_FRONTIER_STOP_KIND, expected: 0, value });
      for (const store of [f.store, f.open()]) await inert(f, store, () => assert.rejects(() => readDeepFrontierStop(store, 'p', reference(fake)), error => error instanceof EngineError));
    }
    const run = f.store.get<ResearchRun>(original.run.id)!;
    for (const patch of [{projectId:'foreign'}, {draftId:'foreign'}, {turns:null}, {turns:-1}]) {
      const head=f.store.get(run.id)!;
      f.store.write({id:run.id,kind:run.kind,expected:head.revision,value:{...run.value,...patch}});
      for (const store of [f.store,f.open()]) await inert(f,store,async()=>{
        // The shared handoff proof may reject the invalid run before the stop's
        // local identity check. Both refusals leave the saved snapshot untouched.
        await assert.rejects(()=>produceDeepFrontierStop(store,'p',original.handoff),error => error instanceof EngineError
          && ['discovery_deep_stop_invalid','discovery_variant_basis_invalid'].includes(error.code));
      });
    }
    f.store.write({id:run.id,kind:run.kind,expected:f.store.get(run.id)!.revision,value:run.value});
    for(const store of [f.store,f.open()])await inert(f,store,async()=>
      assert.deepEqual((await readDeepFrontierStop(store,'p',f.stop)).record.value,original));
    const dossier = await produceStoppedPartialDossier(f.store, 'p', f.stop);
    const value = structuredClone(dossier.record.value); value.reasons[0]!.grounds.pop();
    const fake = projectDossierManifest(value), record = f.store.write({ id: fake.id, kind: 'discovery-dossier-manifest', expected: 0, value: fake.value });
    await inert(f, f.open(), () => assert.rejects(() => readPartialDossier(f.open(), 'p', reference(record)), {code:'discovery_dossier_invalid'}));
  });

test('5.7: paid MR without P remains unassessed in the old snapshot after late application', async t => {
  const f = await ready(t); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
  let cut = false;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    const rows = commit();
    if (!cut && writes.some(w => w.kind === 'discovery-assessment')) { cut = true; throw new Error('cut after paid MR before P'); }
    return rows;
  });
  await f.run(2); restore(); assert.ok(cut);
  const stop = await produceDeepFrontierStop(f.store, 'p', JSON.parse(f.pending.value.error!).handoff);
  const snapshot = await produceStoppedPartialDossier(f.store, 'p', reference(stop.record));
  assert.ok(snapshot.materials.some(m => m.claim.claimId.startsWith('deep-') && m.status === 'unassessed'));
  const beforeWire = f.wires(), beforeMoney = money(f.store);
  await f.run(1, f.store, true);
  assert.deepEqual(f.wires(), beforeWire); assert.deepEqual(money(f.store), beforeMoney);
  for (const store of [f.store, f.open()]) await inert(f, store, async () => {
    const old = await readPartialDossier(store, 'p', reference(snapshot.record));
    assert.deepEqual(old.record, snapshot.record); assert.deepEqual(old.materials, snapshot.materials);
    assert.equal((await produceStoppedPartialDossier(store, 'p', reference(stop.record))).repeated, true);
  });
});

test('5.7: deep partial keeps rejected material, addressed unknown and both contradiction sides', async t => {
  const f = await ready(t);
  const broad = f.store.list<any>('research-attempt').find(row => row.value.end.type === 'submitted')!;
  const priorClaim = broad.value.end.value.claims[0];
  const base = { kind:'hypothesis', axis:'industry', planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-one'}],
    scope:{variants:[readVariantScope(f.store,'p',f.scope).scope.value.member]}, basis:{howToVerify:'Compare independent evidence'} };
  const other = { project:'p', container:reference(broad), containerKind:'research-attempt', pointer:'/claims/0', claimId:priorClaim.id };
  f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000, deepClaims: [
    {...base,id:'positive',text:'Plausible chosen variant'},
    {...base,id:'counter',text:'Unsupported counterargument',refutedBy:[other]},
    {...base,id:'unknown',text:'Demand is unknown',kind:'unknown',basis:{origin:'Saved research',unknownId:'demand',question:'What is demand?',affects:['market'],consumer:'product-owner',blocksCurrentStage:true,moment:'om-pass',closeCriterion:'Obtain independent evidence'}}] });
  const result = await f.run(2), details = JSON.parse(result.value.error!);
  assert.equal(result.value.pauseCode,'research_dossier_assessment_unavailable',result.value.error!);
  const dossier = await readPartialDossier(f.store,'p',details.dossier);
  assert.equal(dossier.materials.find(m=>m.claim.claimId==='counter')!.status,'rejected');
  assert.equal(dossier.record.value.unknowns.length,1); assert.equal(dossier.contradictions.length,1);
  assert.deepEqual(dossier.contradictions[0]!.sides.map(s=>s.status),['accepted','rejected']);
  assert.deepEqual(dossier.record.value.contradictions[0]!.resolution,{state:'open'});
});

for (const change of ['frame', 'plan', 'mode', 'choice', 'budget', 'material'])
  test(`5.7: second Store ${change} between projection and stop publication leaves no stop or dossier`, async t => {
    const f = await ready(t); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
    const other = f.open(), original = Store.prototype.atomicWrite;
    let after = '', paid: unknown, wire: unknown, fired = false;
    const mock = t.mock.method(Store.prototype, 'atomicWrite', function(this: Store, prepare: Parameters<Store['atomicWrite']>[0]) {
      if (this === f.store && !fired) {
        fired = true;
        if (change === 'frame') {
          const question = other.list<Question>('question').find(q=>q.value.draftId === f.v.draft.id && q.value.spec.field === 'frame')!;
          new Discovery(other).reopen(question.id, question.revision);
        } else if (change === 'plan') f.nextEdition(other);
        else if (change === 'mode') f.mode('bypass', other);
        else if (change === 'choice') {
          const state = other.get<VariantState>(variantStateId('p', f.v.draft.id))!;
          owner(other,{...choiceScope(f), operation:'revise', previous:state.value.decision!, expectedSelection:reference(state)});
        } else if (change === 'budget') {
          const budget = other.list<any>('research-budget').find(row=>row.value.key === 'discovery-v7')!;
          other.write({ id:budget.id, kind:budget.kind, expected:budget.revision, value:budget.value });
        } else {
          // A phantom candidate is not accepted material. Publication must not
          // silently omit it between inventory and the write lock.
          const attempt = other.list<any>('research-attempt').at(-1)!;
          other.write({id:'foreign-material-race',kind:attempt.kind,expected:0,value:attempt.value});
        }
        after = history(other); paid = money(other); wire = f.wires();
      }
      return original.call(this, prepare);
    });
    await assert.rejects(()=>f.run(2),{code:'discovery_deep_stop_stale'});
    mock.mock.restore(); assert.ok(fired);
    assert.equal(history(f.store),after); assert.deepEqual(money(f.store),paid); assert.deepEqual(f.wires(),wire);
    assert.equal(f.store.list(DEEP_FRONTIER_STOP_KIND).length,0); assert.equal(f.store.list('discovery-dossier-manifest').length,0);
  });

for (const cold of [false,true]) test(`5.7: ${cold?'cold':'hot'} current applied evidence resumes stalled frontier with retained N and historical partial`, async t => {
  const f = await ready(t,false,{deepMode:'impossible'});
  // A real previous process owns the finished run. Later managed work and a
  // cold runner see its dead process identity without fabricating control rows.
  const modules = ['storage/store','discovery/discovery','product/engine','discovery/research-runner']
    .map(path=>new URL('../src/'+path+'.js',import.meta.url).href);
  execFileSync(process.execPath,['--input-type=module','-e',`
    import {Store} from ${JSON.stringify(modules[0])};
    import {Discovery} from ${JSON.stringify(modules[1])};
    import {ProductEngine} from ${JSON.stringify(modules[2])};
    import {Researcher} from ${JSON.stringify(modules[3])};
    const store=new Store(${JSON.stringify(f.store.path)});
    await new Researcher(store,new Discovery(store),new ProductEngine(store).environments).run('p',${JSON.stringify(f.v.draft.id)},6,undefined,{producerPolicy:{discovery:7}});
    store.close();`],{stdio:'pipe'});
  const stopped=f.store.list<ResearchRun>('research-run').find(row=>row.value.draftId===f.v.draft.id)!;
  assert.equal(stopped.value.pauseCode,'research_dossier_assessment_unavailable',stopped.value.error!);
  const prior=JSON.parse(stopped.value.error!), old=await readPartialDossier(f.store,'p',prior.dossier);
  assert.equal(old.stop!.value.reason,'stall');assert.equal(deepCalls(f).length,6);
  const store=cold?f.open():f.store, paidBefore=deepIntents(store).map(row=>reference(row));
  // New evidence enters through the real managed and MR/P doors. It is not a
  // restart/allowance permission and cannot rewrite the stopped snapshot.
  f.configure({deepMode:'variant',close:false,outcome:'open'});
  const priorIntent=deepIntents(store).find(row=>row.value.cursor.subject?.planQuestionId==='q-one')!;
  const next=(await runDeepResearch(store,{projectId:'p',deepPreparation:priorIntent.value.cursor.deepPreparation!,
    environment:f.environment,owner:reference(stopped)}))!;
  const packet=projectAttemptPacket(store,{project:'p',...priorIntent.value.cursor.subject!,
    entries:[{attempt:reference(next.attempt),binding:reference(next.binding)}]});
  const assessment=await assessAttemptsWithRequirements(store,packet,v7ProgressBaseline(store,packet),f.environment,f.root);
  applyDiscoveryAssessment(store,'p',reference(assessment));
  const frontier=deepPlanSelection(store,'p',f.scope);
  assert.equal(frontier.progress[0]!.summary!.count,5);assert.equal(frontier.progress[0]!.summary!.streak,0);
  assert.equal(frontier.next!.cell.subject.planQuestionId,'q-one');
  f.configure({close:true});
  const resumed=await f.run(1,store);
  assert.equal(resumed.value.pauseCode,'research_dossier_assessment_unavailable',resumed.value.error!);
  assert.equal(deepCalls(f).length,8);
  for(const at of paidBefore)assert.deepEqual(reference(store.get(at.id,at.revision)!),at);
  for(const read of [store,f.open()])await inert(f,read,async()=>{
    assert.deepEqual((await readPartialDossier(read,'p',prior.dossier)).record,old.record);
    assert.equal((await produceStoppedPartialDossier(read,'p',prior.stop)).repeated,true);
    await f.run(1,read,true);
  });
});

test('5.7: exhausted stage budget remains terminal after choice, plan and allowance changes', async t => {
  const f=await ready(t);f.configure({assessorTokens:V7_STAGE_TOKEN_CEILING-2_000_000});
  const paused=await f.run(2), details=JSON.parse(paused.value.error!);
  assert.equal(paused.value.pauseCode,'research_dossier_assessment_unavailable',paused.value.error!);
  const state=f.store.get<VariantState>(variantStateId('p',f.v.draft.id))!;
  owner(f.store,{...choiceScope(f),operation:'revise',previous:state.value.decision!,expectedSelection:reference(state)});
  for(const store of [f.store,f.open()])await inert(f,store,async()=>assert.deepEqual(await f.run(100,store),paused));
  f.nextEdition();
  for(const store of [f.store,f.open()])await inert(f,store,async()=>{
    assert.deepEqual(await f.run(100,store),paused);
    assert.deepEqual(reference((await readPartialDossier(store,'p',details.dossier)).record),details.dossier);
  });
  assert.equal(deepCalls(f).length,1);
});

test('5.7: second Store applies the real paid P before stop publication; no partial commit survives', async t => {
  const f=await ready(t);f.configure({assessorTokens:V7_STAGE_TOKEN_CEILING-2_000_000});
  let paidAssessment: ReturnType<typeof reference> | null=null;
  const restore=interceptWrites(t,f.store,(_writes,commit)=>{
    const rows=commit(), paid=rows.find(row=>row.kind==='discovery-assessment');
    if(paid&&!paidAssessment){paidAssessment=reference(paid);throw new Error('cut after MR');}
    return rows;
  });
  await f.run(2);restore();assert.ok(paidAssessment);
  const other=f.open(),original=Store.prototype.atomicWrite;
  let after='',moneyAfter:unknown,wire:unknown;
  const mock=t.mock.method(Store.prototype,'atomicWrite',function(this:Store,prepare:Parameters<Store['atomicWrite']>[0]){
    if(this===f.store&&!after){
      applyDiscoveryAssessment(other,'p',paidAssessment!);
      after=history(other);moneyAfter=money(other);wire=f.wires();
    }
    return original.call(this,prepare);
  });
  await assert.rejects(()=>produceDeepFrontierStop(f.store,'p',JSON.parse(f.pending.value.error!).handoff),{code:'discovery_deep_stop_stale'});
  mock.mock.restore();assert.ok(after);
  assert.equal(history(f.store),after);assert.deepEqual(money(f.store),moneyAfter);assert.deepEqual(f.wires(),wire);
  assert.equal(f.store.list(DEEP_FRONTIER_STOP_KIND).length,0);assert.equal(f.store.list('discovery-dossier-manifest').length,0);
});
