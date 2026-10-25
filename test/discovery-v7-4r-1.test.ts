import { readVariantHandoff, discoveryInspection } from '../src/discovery/discovery-outcome.js';
import { readPartialDossier } from '../src/discovery/dossier-manifest.js';
import { readVariantScope } from '../src/discovery/variant-scope.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { synthesisSession } from '../src/discovery/synthesis-session.js';
import { readerPilot, pilotEnvironment } from '../src/discovery/reader-pilot.js';
import { configureV7SavedSynthesis } from '../src/discovery/saved-synthesis.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';
import { EngineError } from '../src/errors.js';
import { variantStateId } from '../src/discovery/variant-decision.js';
import { readVariantGeneration } from '../src/discovery/variant-session.js';
import { variantSnapshotReadiness } from '../src/discovery/variant-snapshot.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet, type VariantSnapshot, type VariantExecutionSession } from '../src/discovery/discovery-variants.js';
import { captureResearchConsumerRetryPermits, listResearchConsumerIntentsByRoot, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { readBundle, resumeReadBundleIntent, readReaderResultAt } from '../src/discovery/reader.js';
import { ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';

const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
async function setup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry')], initialMode: 'questions'|'bypass' = 'questions') {
  const f = discoveryFixture(t, 'omg-4r1-');
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
if(r.subject.variantSubject?.kind==='decision')research=s.reject?{action:'reject_all',reason:'Model rejects this exact set'}:{action:'choose',key:'v1',reason:'Model chooses the bounded member'};
else if(r.subject.variantSubject){
 const grounds=[r.subject.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];
 research=s.none?{action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds}],searchLimits:['Saved sweep only'],unknowns:['Demand unknown']}
 :{action:'variants',variants:[{key:'v1',title:'Bounded variant',proposal:{bounded:true},criteria:Object.fromEntries(keys.map(key=>[key,{conclusion:'Bounded model proposal',grounds,assumptions:[],unknowns:['Demand unknown'],quantity:null}]))}],scale:Object.fromEntries(keys.map(key=>[key,'Same bounded scale'])),comparison:'One bounded option',recommendation:{key:'v1',reason:'Only bounded candidate'},searchLimits:['Saved sweep only'],unknowns:['Demand unknown']};
}
if(r.subject.role==='reader'){if(s.readerFail)process.exit(42);research={selections:r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]})),unresolved:[]}};
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet, attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 research={verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected:[],newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, 'p', questions);
  function mode(value: 'questions'|'bypass') {
    const request = { project: 'p', mode: value, previous: f.store.get('project-mode:p') ? reference(f.store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(f.store), invitation = issueProjectModeInvitation(f.store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(f.store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const initial = mode(initialMode), cal = f.store.write({ id: 'variant-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
  for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
    { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? {snapshot: reference(cal)} : {set: reference(cal)}), mode: reference(initial), expectedSelection: null }, history: [] }, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  writeFileSync(wire, '');
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const generationCalls = () => wires().filter(row => row.subject.variantSubject);
  const nextEdition = () => {
    const plan = f.store.get<Question>(v.plan.id)!; f.discovery.reopen(plan.id, plan.revision);
    const question = f.store.get<Question>(plan.id)!, draft = f.store.get<DiscoveryDraft>(v.draft.id)!;
    const source = f.discovery.evidence.document('p', 'edition-two', 'New accepted edition', 'text/plain', 0);
    answerDiscoveryFixture(f.engine, 'p', draft, question, validPlan(v.frameRef, questions, 2, v.planAnswer), source);
    return f.store.get<Question>(plan.id)!.value.answer!;
  };
  return { ...f, v, environment, command, run, wires, generationCalls, configure, mode, initial, nextEdition };
}

test('4R.1: ordinary runner restores MR/P, covers the whole sweep including applied open/stalled, and publishes paid generation before owner door', async t => {
  const f = await setup(t, [planQuestion('block', 'industry', 'blocking'), planQuestion('support', 'market')]);
  const result = await f.run();
  assert.equal(result.value.pauseCode, 'research_variant_owner_required', JSON.stringify(result.value));
  assert.equal(result.value.status, 'paused'); assert.equal(result.value.ownerQuestion, null);
  const ready = variantSnapshotReadiness(f.store, 'p'); assert.equal(ready.status, 'ready');
  const snapshot = f.store.list<VariantSnapshot>('discovery-variant-snapshot')[0]!;
  assert.deepEqual(snapshot.value.questions.map(q => q.planQuestionId), ['block', 'support']);
  assert.ok(snapshot.value.questions.every(q => q.progress && q.applications.length));
  assert.ok(snapshot.value.questions.some(q => q.reason?.code === 'progress_open'));
  assert.ok(snapshot.value.questions.some(q => q.reason?.code === 'progress_stalled'));
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, proof = readVariantGeneration(f.store, 'p', reference(set));
  assert.deepEqual(set.value.snapshot, reference(snapshot)); assert.equal(f.generationCalls().length, 1);
  assert.equal(proof.session.value.actor, f.environment.value.implementer.actor);
  assert.deepEqual(JSON.parse(result.value.error!).result, reference(set));
  assert.equal(result.value.turns, f.wires().filter(w => !w.subject.variantSubject && !w.subject.assessmentSubject).length);
  const before = history(f.store), sent = f.wires().length;
  assert.deepEqual(await f.run(8, f.open()), result);
  assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, sent);
});

test('4R.1: bypass buys a separate model choice after generation and pauses at the exact saved handoff', async t => {
  const f = await setup(t, undefined, 'bypass'); const result = await f.run(3);
  assert.equal(result.value.pauseCode, 'research_deep_frontier_pending', JSON.stringify(result.value));
  assert.equal(f.generationCalls().filter(row => row.subject.variantSubject.kind === 'proposal').length, 1);
  assert.equal(f.generationCalls().filter(row => row.subject.variantSubject.kind === 'decision').length, 1);
  const state = f.store.list<any>('discovery-variant-state')[0]!; assert.ok(state.value.decision);
  assert.deepEqual(JSON.parse(result.value.error!).decision, state.value.decision);
  assert.ok(JSON.parse(result.value.error!).scope);
  const details = JSON.parse(result.value.error!), handoff = await readVariantHandoff(f.store, 'p', details.handoff);
  const scope = readVariantScope(f.store, 'p', details.scope);
  assert.equal(handoff.record.value.next, 'deep'); assert.equal(handoff.record.value.reason, 'choose');
  assert.equal(handoff.record.value.projectId, 'p'); assert.equal(handoff.record.value.draft.id, f.v.draft.id);
  assert.deepEqual(handoff.record.value.scope, reference(scope.scope));
  assert.deepEqual(handoff.record.value.decision, state.value.decision);
  assert.deepEqual(scope.scope.value.decision, state.value.decision);
  assert.equal(f.store.list('discovery-deep-preparation').length, 0);
  const before = history(f.store), sent = f.wires();
  assert.deepEqual(await f.run(2, f.open(), true), result);
  assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), sent);
});

test('4R.1: no_variants is its own paid result and cold fixed point, never completed Discovery', async t => {
  const f = await setup(t); f.configure({ none: true }); const result = await f.run(2);
  assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', JSON.stringify(result.value));
  const pause = JSON.parse(result.value.error!), handoff = await readVariantHandoff(f.store, 'p', pause.handoff);
  const dossier = await readPartialDossier(f.store, 'p', pause.dossier);
  assert.equal(handoff.record.value.reason, 'no_variants');
  assert.deepEqual(handoff.record.value.result, reference(f.store.list('discovery-variant-none')[0]!));
  assert.equal(handoff.record.value.projectId, 'p'); assert.equal(handoff.record.value.draft.id, f.v.draft.id);
  assert.deepEqual(reference(dossier.handoff), pause.handoff); assert.deepEqual(dossier.record.value.draft, handoff.record.value.draft);
  assert.equal(dossier.record.value.projectId, 'p'); assert.equal(dossier.record.value.completeness, 'partial');
  assert.equal(discoveryInspection(f.store, f.store.get<DiscoveryDraft>(f.v.draft.id)!).outcome.state, 'researching');
  assert.equal(f.store.list('stage-artifact').length, 0);
  assert.equal(f.store.list('discovery-variant-set').length, 0); assert.equal(f.store.list('discovery-variant-none').length, 1);
  assert.equal(f.generationCalls().length, 1); const before = history(f.store), wire = f.wires();
  assert.deepEqual(await f.run(2, f.open(), true), result); assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), wire);
});

test('4R.1: call allowance and restoreOnly stop before buying generation; a later explicit allowance sends it once', async t => {
  const f = await setup(t); const limited = await f.run(1);
  assert.equal(limited.value.pauseCode, 'research_turns_exhausted', JSON.stringify(limited.value));
  assert.equal(variantSnapshotReadiness(f.store, 'p').status, 'ready'); assert.equal(f.generationCalls().length, 0);
  assert.equal(f.store.list('discovery-variant-session').length, 0); const sent = f.wires().length;
  const fixed = history(f.store), restored = await f.run(1, f.open(), true); assert.deepEqual(restored, limited); assert.deepEqual(history(f.store), fixed);
  assert.equal(f.wires().length, sent); assert.equal(f.store.list('discovery-variant-session').length, 0);
  assert.equal((await f.run(1, f.open())).value.pauseCode, 'research_variant_owner_required'); assert.equal(f.generationCalls().length, 1);
});

function cutGeneration(store: Store, phase: 'session-only'|'paid'|'application') {
  const write = store.writeMany.bind(store); let cut = false;
  store.writeMany = ((writes, guards = []) => {
    const step = writes.find(row => row.kind === 'discovery-variant-session' && row.expected === (phase === 'session-only' ? 0 : 1));
    if (step && !cut && phase === 'paid') { cut = true; throw new Error('Cut before generation application'); }
    const result = write(writes, guards);
    if (step && !cut) { cut = true; throw new Error(`Cut after ${phase}`); } return result;
  }) as typeof store.writeMany;
  return () => { store.writeMany = write; assert.ok(cut, `Reached ${phase}`); };
}
for (const phase of ['session-only', 'paid', 'application'] as const) {
  test(`4R.1: cold ${phase} recovery retains the original session/paid answer and never buys a second generation`, async t => {
    const f = await setup(t), restore = cutGeneration(f.store, phase);
    const broken = await f.run(2); restore(); assert.equal(broken.value.pauseCode, 'research_interrupted', JSON.stringify(broken.value));
    const session = f.store.list<VariantExecutionSession>('discovery-variant-session')[0]!, sent = f.wires().length;
    f.configure({ none: true });
    const first = await f.run(2, f.open(), true);
    if (phase === 'session-only') {
      assert.equal(first.value.pauseCode, 'research_restore_complete'); assert.equal(f.wires().length, sent);
      f.configure({ none: false }); assert.equal((await f.run(1, f.open())).value.pauseCode, 'research_variant_owner_required');
    } else assert.equal(first.value.pauseCode, 'research_variant_owner_required', JSON.stringify(first.value));
    assert.equal(f.generationCalls().length, 1); assert.equal(f.store.list('discovery-variant-none').length, 0);
    assert.equal(f.store.list('discovery-variant-session').length, 1); assert.equal(f.store.list('discovery-variant-session')[0]!.id, session.id);
    const before = history(f.store), calls = f.wires().length, result = await f.run(2, f.open(), true);
    assert.equal(result.value.pauseCode, 'research_variant_owner_required'); assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, calls);
  });
}

test('4R.1: a saved paid generation restores under its old mode after an authorized mode change, with no new state or charge', async t => {
  const f = await setup(t), restore = cutGeneration(f.store, 'paid'); await f.run(2); restore();
  const session = f.store.list<VariantExecutionSession>('discovery-variant-session')[0]!, calls = f.wires().length;
  f.mode('bypass'); const result = await f.run(2, f.open(), true);
  assert.equal(result.value.pauseCode, 'research_variant_context_stale', JSON.stringify(result.value));
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, proof = readVariantGeneration(f.store, 'p', reference(set));
  assert.deepEqual(proof.session.value.variantSubject, session.value.variantSubject); assert.equal(proof.state, null);
  assert.equal(f.wires().length, calls); assert.equal(f.generationCalls().length, 1);
  const before = history(f.store); assert.deepEqual(await f.run(2, f.open(), true), result); assert.deepEqual(history(f.store), before);
});

test('4R.1: a new accepted edition of the same Question restores old paid generation without inheriting its scope, then earns its own generation', async t => {
  const f = await setup(t), restore = cutGeneration(f.store, 'paid'); await f.run(2); restore();
  const next = f.nextEdition(), calls = f.wires().length;
  const cold = await f.run(1, f.open(), true); assert.equal(f.wires().length, calls);
  assert.notEqual(cold.value.pauseCode, 'research_variant_owner_required');
  const old = f.store.list<VariantSet>('discovery-variant-set')[0]!;
  const oldSnapshot = f.store.get<VariantSnapshot>(old.value.snapshot.id, old.value.snapshot.revision)!;
  assert.deepEqual(oldSnapshot.value.plan, f.v.planAnswer); assert.equal(variantSnapshotReadiness(f.store, 'p').status, 'not_ready');
  const current = await f.run(2, f.open()); assert.equal(current.value.pauseCode, 'research_variant_owner_required', JSON.stringify(current.value));
  assert.equal(f.generationCalls().length, 2); assert.equal(f.store.list('discovery-variant-set').length, 2);
  const plans = f.store.list<VariantSnapshot>('discovery-variant-snapshot').map(row => row.value.plan);
  assert.ok(plans.some(plan => canonical(plan) === canonical(next))); assert.equal(variantSnapshotReadiness(f.store, 'p').status, 'ready');
});

test('4R.1: common research budget stops new generation after actual paid assessment usage consumes the research reserve', async t => {
  const f = await setup(t); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 1000 });
  const result = await f.run(2);
  assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', JSON.stringify(result.value));
  const pause = JSON.parse(result.value.error!);
  assert.equal(pause.reason, 'early_limit');
  const handoff = await readVariantHandoff(f.store, 'p', pause.handoff), dossier = await readPartialDossier(f.store, 'p', pause.dossier);
  assert.equal(handoff.record.value.reason, 'early_limit'); assert.equal(handoff.record.value.projectId, 'p');
  assert.equal(handoff.record.value.draft.id, f.v.draft.id); assert.equal(handoff.record.value.snapshot, null);
  assert.deepEqual(reference(dossier.handoff), pause.handoff); assert.deepEqual(dossier.record.value.draft, handoff.record.value.draft);
  assert.equal(dossier.record.value.projectId, 'p'); assert.equal(dossier.record.value.completeness, 'partial');
  assert.equal(dossier.record.value.reasons[0]!.code, 'budget');
  for (const ground of handoff.record.value.stop!.grounds)
    assert.ok(dossier.record.value.reasons[0]!.grounds.some(r => canonical(r) === canonical(ground)));
  assert.equal(f.generationCalls().length, 0); assert.equal(f.store.list('discovery-variant-snapshot').length, 0);
  const ready = variantSnapshotReadiness(f.store, 'p');
  assert.equal(ready.status, 'ready'); if (ready.status === 'ready') assert.equal(ready.generationAllowed, false);
  assert.ok(ready.budget?.exhausted); assert.ok(ready.budget.measured >= V7_STAGE_TOKEN_CEILING - 1000);
  const ledger = f.store.get(ready.budget.ledger.id, ready.budget.ledger.revision)!;
  assert.equal(ledger.kind, 'research-budget-ledger'); assert.deepEqual(reference(ledger), ready.budget.ledger);
  assert.ok(handoff.record.value.stop!.grounds.some(r => canonical(r) === canonical(ready.budget!.ledger)));
  const before = history(f.store), wire = f.wires();
  const paid = () => f.store.list().filter(r => ['model-call', 'research-budget-ledger'].includes(r.kind)).flatMap(r => f.store.history(r.id));
  const calls = paid();
  assert.deepEqual(await f.run(1, f.open(), true), result); assert.deepEqual(history(f.store), before);
  assert.deepEqual(paid(), calls); assert.deepEqual(f.wires(), wire);
});

for (const decoration of ['variant kind', 'variantSubject'] as const) {
  test(`4R.1: MR/P pending cannot disappear by adding ${decoration}`, async t => {
    const f = await setup(t), write = f.store.writeMany.bind(f.store); let cut = false;
    f.store.writeMany = ((writes, guards = []) => {
      const pending = writes.some(row => row.kind === 'research-consumer-intent' && (row.value as any).kind === 'analyst');
      const result = write(writes, guards); if (pending && !cut) { cut = true; throw new Error('Prepared analyst saved'); } return result;
    }) as typeof f.store.writeMany;
    await f.run(1); f.store.writeMany = write; assert.ok(cut);
    const pending = f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row => row.value.kind === 'analyst')!;
    const value = decoration === 'variant kind' ? { ...pending.value, kind: 'variant-proposal' }
      : { ...pending.value, cursor: { ...pending.value.cursor, variantSubject: { ready: true } } };
    f.store.write({ id: pending.id, kind: pending.kind, expected: pending.revision, value });
    const before = history(f.store); let refused = false, status: string | undefined;
    try { status = variantSnapshotReadiness(f.store, 'p').status; } catch { refused = true; }
    assert.ok(refused || status !== 'ready');
    if (decoration === 'variant kind') assert.ok(refused);
    assert.deepEqual(history(f.store), before); assert.equal(f.generationCalls().length, 0);
  });
}

test('4R.1: a forged completed run does not prove coverage or skip the first pending question', async t => {
  const f = await setup(t), id = `research-run:${hashJson(['p', f.v.draft.id])}`;
  f.store.write<ResearchRun>({ id, kind: 'research-run', expected: 0, value: { projectId: 'p', draftId: f.v.draft.id, environment: reference(f.environment), status: 'completed', turns: 0,
    limit: 1, inputs: f.v.draft.value.inputs, ownerQuestion: null, error: null, pauseCode: null, owner: { pid: 0, started: 'dead' }, requestChars: 0 } });
  const before = variantSnapshotReadiness(f.store, 'p'); assert.equal(before.status, 'not_ready');
  const result = await f.run(1); assert.equal(result.value.turns, 1); assert.equal(result.value.pauseCode, 'research_turns_exhausted');
  assert.equal(f.generationCalls().length, 0); assert.equal(f.store.list('discovery-variant-snapshot').length, 0);
});


test('4R.1: paid generation restores after a competing state write without overwriting it or buying another answer', async t => {
  const f = await setup(t), restore = cutGeneration(f.store, 'paid'); await f.run(2); restore();
  const session = f.store.list<VariantExecutionSession>('discovery-variant-session')[0]!, calls = f.wires().length;
  // Explicit negative control for the CAS door, not a manufactured positive choice/decision.
  const moved = f.store.write({ id: variantStateId('p', f.v.draft.id), kind: 'discovery-variant-state', expected: 0,
    value: { control: 'competing state; no decision proof' } });
  const result = await f.run(2, f.open(), true);
  assert.equal(result.value.pauseCode, 'research_variant_context_stale', JSON.stringify(result.value));
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, proof = readVariantGeneration(f.store, 'p', reference(set));
  assert.deepEqual(proof.session.value.variantSubject, session.value.variantSubject); assert.equal(proof.state, null);
  assert.deepEqual(f.store.get(moved.id), moved); assert.equal(f.wires().length, calls); assert.equal(f.generationCalls().length, 1);
  const before = history(f.store); assert.deepEqual(await f.run(2, f.open(), true), result); assert.deepEqual(history(f.store), before);
});

test('4R.1: a paid MR/P assessment is applied free before snapshot admission and generation', async t => {
  const f = await setup(t), write = f.store.writeMany.bind(f.store); let cut = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!cut && writes.some(row => row.kind === 'v7-progress-application')) { cut = true; throw new Error('Paid assessment before P'); }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  const broken = await f.run(1); f.store.writeMany = write; assert.ok(cut);
  assert.equal(broken.value.pauseCode, 'research_interrupted'); assert.equal(f.store.list('v7-progress-application').length, 0);
  assert.equal(variantSnapshotReadiness(f.store, 'p').status, 'not_ready');
  const calls = f.wires().length, assessments = f.store.list('discovery-assessment'); assert.equal(assessments.length, 1);
  const restored = await f.run(1, f.open(), true);
  assert.equal(restored.value.pauseCode, 'research_restore_complete', JSON.stringify(restored.value));
  assert.equal(f.wires().length, calls); assert.deepEqual(f.store.list('discovery-assessment'), assessments);
  assert.equal(f.store.list('v7-progress-application').length, 1); assert.equal(variantSnapshotReadiness(f.store, 'p').status, 'ready');
  assert.equal(f.store.list('discovery-variant-snapshot').length, 0); assert.equal(f.generationCalls().length, 0);
  const result = await f.run(1, f.open()); assert.equal(result.value.pauseCode, 'research_variant_owner_required');
  assert.equal(f.generationCalls().length, 1); assert.equal(result.value.turns, 1);
});


test('4R.1: an unpaid saved session keeps its old mode and cannot purchase a new-mode generation', async t => {
  const f = await setup(t), restore = cutGeneration(f.store, 'session-only'); await f.run(2); restore();
  const original = f.store.list<VariantExecutionSession>('discovery-variant-session')[0]!, calls = f.wires().length;
  f.mode('bypass'); const result = await f.run(1, f.open());
  assert.equal(result.value.pauseCode, 'research_consumer_context_stale', JSON.stringify(result.value));
  assert.equal(f.wires().length, calls); assert.equal(f.generationCalls().length, 0);
  assert.deepEqual(f.store.list('discovery-variant-session'), [original]);
  const before = history(f.store); assert.deepEqual(await f.run(1, f.open()), result); assert.deepEqual(history(f.store), before);
});

test('4R.1: a malformed current selection cannot buy generation from a structural state pointer', async t => {
  const f = await setup(t); await f.run(1); const calls = f.wires().length;
  const corrupt = f.store.write({ id: variantStateId('p', f.v.draft.id), kind: 'discovery-variant-state', expected: 0,
    value: { projectId: 'other', state: 'not a proven choice' } });
  const result = await f.run(1, f.open());
  assert.equal(result.value.pauseCode, 'discovery_variant_invalid', JSON.stringify(result.value));
  assert.equal(f.wires().length, calls); assert.equal(f.generationCalls().length, 0);
  assert.equal(f.store.list('discovery-variant-session').length, 0); assert.deepEqual(f.store.get(corrupt.id), corrupt);
  const before = history(f.store); assert.deepEqual(await f.run(1, f.open()), result); assert.deepEqual(history(f.store), before);
});


async function savedNegativeReview(t: test.TestContext) {
  const f = await setup(t, [planQuestion('block', 'industry', 'blocking')]);
  f.engine.execute({ type: 'configure-reader-pilot', project: 'p', expected: 0, settings: { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command: f.command }, agentCommand: f.command,
    maxRequestChars: 100000, maxReadChars: 100000, maxReplyChars: 200000, maxCalls: 50, maxReportedTokens: 100000,
    v7Planning: { contract: 'v7-plan-planning/v1', maxRequestChars: 100000, maxRounds: 3 } } });
  const pieces = ['a', 'b'].map(name => {
    const source = f.discovery.evidence.document('p', 'note-' + name, 'Finding with its exception ' + name, 'text/plain', 0);
    return { kind: 'context', value: f.discovery.evidence.observe('p', reference(source), { kind: 'text-range', start: 0, end: source.value.content.length }) };
  });
  const subject = { contract: 'v7-plan-subject/v1' as const, planAnswer: f.v.planAnswer, planQuestionId: 'block' }, pilot = readerPilot(f.store, 'p')!;
  const ended = { action: 'answer', question: '$selected', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'No accessible source' }, citations: [] };
  f.configure({ actions: [{ action: 'checkpoint', question: '$selected', value: { finding: 'Finding with exception' },
    citations: [{ source: pieces[0]!.value.source, selector: pieces[0]!.value.selector }], unresolved: [] }, ended] });
  assert.equal((await synthesisSession(f.store, f.v.draft, f.v.plan, f.environment, pilotEnvironment(f.environment.value, pilot.value), pilot,
    { role: 'research', stage: 'discovery', subject, workingSelections: pieces, inventory: { sources: [] }, history: [] }, 'Synthesize', undefined, {})).action, 'answer');
  const prior = f.wires().length, source = f.discovery.evidence.document('p', 'jurisdiction', 'The evidence determines this jurisdiction.', 'text/plain', 0);
  f.configure({ actions: [...Array.from({ length: prior }, () => ended),
    { action: 'read_plan', question: '$selected', reads: [{ action: 'read_source', source: reference(source), start: 0, end: source.value.content.length }] },
    { action: 'need_owner', question: '$selected', reason: 'Select the jurisdiction', searched: [reference(source)] },
    { necessary: false, reason: 'The source already determines the jurisdiction' }, ended] });
  const write = f.store.writeMany.bind(f.store); let cut = false;
  f.store.writeMany = ((writes, guards = []) => {
    const result = write(writes, guards);
    if (!cut && writes.some(row => row.kind === 'model-call' && (row.value as any).purpose === 'escalation-assessor' && (row.value as any).status === 'succeeded')) {
      cut = true; throw new Error('Paid negative owner review before application');
    } return result;
  }) as typeof f.store.writeMany;
  const interrupted = await f.run(3); f.store.writeMany = write;
  assert.ok(cut); assert.equal(interrupted.value.pauseCode, 'research_interrupted');
  const review = f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row => row.value.kind === 'escalation-assessor')!;
  assert.equal(review.value.state, 'running'); return { ...f, review, subject };
}

test('4R.1: real paid negative S6.8 review is pending until application, then saved-only synthesis preserves it before generation and a new edition', async t => {
  const f = await savedNegativeReview(t), calls = f.wires().length;
  const pending = variantSnapshotReadiness(f.store, 'p'); assert.equal(pending.status, 'not_ready');
  assert.ok(pending.reasons.some(reason => reason.code === 'consumer_pending' && reason.grounds.some(ref => ref.id === f.review.id)));
  const cold = await f.run(1, f.open(), true); assert.equal(cold.value.pauseCode, 'research_contract_upgrade_required');
  assert.equal(f.wires().length, calls); assert.equal(f.store.get<ResearchConsumerIntent>(f.review.id)!.value.state, 'applied');
  const fixed = history(f.store); assert.deepEqual(await f.run(1, f.open(), true), cold); assert.deepEqual(history(f.store), fixed);
  const reviewed = f.store.get<any>(f.review.value.cursor.pendingTurn.id)!;
  configureV7SavedSynthesis(f.store, 'p', f.subject, 0); const reviewedCalls = f.store.list<any>('model-call').filter(row => row.value.purpose === 'escalation-assessor');
  const result = await f.run(1, f.open()); assert.equal(result.value.pauseCode, 'research_turns_exhausted', JSON.stringify(result.value));
  const continuation = f.wires()[calls].subject, archive = f.store.get(continuation.working.archive.id, continuation.working.archive.revision)!;
  const body = readArchiveBody(f.open(), archive).body;
  assert.deepEqual(body.previousProposalRef, reference(reviewed));
  assert.ok((body.history as any[]).some(row => row.action?.action === 'need_owner' && row.observation?.necessary === false));
  assert.deepEqual(f.store.list<any>('model-call').filter(row => row.value.purpose === 'escalation-assessor'), reviewedCalls);
  assert.equal(variantSnapshotReadiness(f.store, 'p').status, 'ready');
  assert.equal((await f.run(1, f.open())).value.pauseCode, 'research_variant_owner_required'); assert.equal(f.generationCalls().length, 1);
  const next = f.nextEdition(), before = history(f.store); assert.notDeepEqual(next, f.v.planAnswer);
  assert.equal(variantSnapshotReadiness(f.open(), 'p').status, 'not_ready'); assert.deepEqual(history(f.store), before);
});

for (const damage of ['omission', 'foreign subject', 'kind'] as const) {
  test(`4R.1: an escalation review with ${damage} cannot hide pending or buy another result`, async t => {
    const f = await savedNegativeReview(t), original = f.review.value, context = { ...original.cursor.context };
    if (damage === 'omission') delete context.subject;
    if (damage === 'foreign subject') context.subject = { ...f.subject, planAnswer: f.v.frameRef };
    const value = damage === 'kind' ? { ...original, kind: 'variant-proposal' }
      : { ...original, cursor: { ...original.cursor, context } };
    f.store.write({ id: f.review.id, kind: f.review.kind, expected: f.review.revision, value });
    const before = history(f.store), calls = f.wires().length;
    assert.throws(() => variantSnapshotReadiness(f.store, 'p'), (error: unknown) => error instanceof EngineError
      && ['research_consumer_intent_invalid', 'discovery_variant_basis_invalid'].includes(error.code));
    assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, calls); assert.equal(f.generationCalls().length, 0);
  });
}


async function pendingReader(t: test.TestContext, phase: 'none'|'prepared'|'paid'|'split-paid'|'assembly' = 'prepared') {
  const f = await setup(t, [planQuestion('block', 'industry', 'blocking')]);
  f.engine.execute({ type: 'configure-reader-pilot', project: 'p', expected: 0, settings: { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command: f.command }, agentCommand: f.command,
    maxRequestChars: 100000, maxReadChars: 100000, maxReplyChars: 200000, maxCalls: 50, maxReportedTokens: 100000,
    v7Planning: { contract: 'v7-plan-planning/v1', maxRequestChars: 100000, maxRounds: 3 } } });
  writeFileSync(join(f.root, 'reader-material.txt'), ['split-paid','assembly'].includes(phase) ? 'A'.repeat(120000) : 'A clause.\nIts exception.');
  f.configure({ actions: [{ action: 'read_plan', question: '$selected', reads: [{ action: 'read_bundle',
    purpose: 'Find the clause and exception', inputs: [{ path: 'reader-material.txt', media: 'text/plain' }] }] },
    { selections: [{ sourceIndex: 0, firstLine: 1, lastLine: 2 }], unresolved: [] }] });
  const write = f.store.writeMany.bind(f.store); let cut = false;
  f.store.writeMany = ((writes, guards = []) => {
    const prepares = writes.some(row => row.kind === 'research-consumer-intent' && row.expected === 0 && (row.value as any).kind === 'reader');
    const assembly = writes.some(row => row.kind === 'reader-result' && (row.value as any).producer === 'combined');
    if (!cut && (phase === 'none' && prepares || phase === 'assembly' && assembly)) {
      cut = true; throw new Error('Cut before reader ' + phase);
    }
    const result = write(writes, guards);
    const paid = writes.some(row => row.kind === 'model-call' && (row.value as any).purpose === 'reader' && (row.value as any).status === 'succeeded');
    if (!cut && (phase === 'prepared' && prepares || ['paid','split-paid'].includes(phase) && paid)) {
      cut = true; throw new Error('Cut after reader ' + phase);
    } return result;
  }) as typeof f.store.writeMany;
  const broken = await f.run(1); f.store.writeMany = write;
  assert.ok(cut, JSON.stringify(broken.value)); assert.equal(broken.value.pauseCode, 'research_interrupted');
  const reader = f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row => row.value.kind === 'reader')!;
  if (phase === 'prepared') assert.equal(reader.value.state, 'prepared');
  const child = f.store.list<any>('research-turn').find(row => row.value.action?.action === 'read_bundle')!;
  return { ...f, reader, child };
}

test('4R.1: a real queued reader child stays pending until paid recovery, then allows snapshot/generation without changing its original run/turn', async t => {
  const f = await pendingReader(t), pending = variantSnapshotReadiness(f.store, 'p');
  assert.equal(pending.status, 'not_ready');
  assert.ok(pending.reasons.some(reason => reason.code === 'consumer_pending' && reason.grounds.some(ref => ref.id === f.reader.id)));
  const calls = f.wires().length, before = history(f.store);
  assert.equal(variantSnapshotReadiness(f.open(), 'p').status, 'not_ready'); assert.deepEqual(history(f.store), before);
  const result = await f.run(1, f.open()); assert.equal(result.value.pauseCode, 'research_turns_exhausted', JSON.stringify(result.value));
  const reader = f.store.get<ResearchConsumerIntent>(f.reader.id)!;
  assert.equal(reader.value.state, 'applied'); assert.deepEqual(reader.value.cursor.consumer, f.reader.value.cursor.consumer);
  assert.deepEqual(f.wires().slice(calls).map(w => w.subject.role === 'reader' ? 'reader' : w.subject.assessmentSubject ? 'assessor' : 'synthesis'), ['reader', 'synthesis', 'assessor']);
  assert.equal(variantSnapshotReadiness(f.open(), 'p').status, 'ready');
  const fixed = history(f.store); assert.deepEqual(await f.run(1, f.open(), true), result); assert.deepEqual(history(f.store), fixed);
  const generated = await f.run(1, f.open());
  assert.equal(generated.value.pauseCode, 'research_variant_owner_required', JSON.stringify(generated.value)); assert.equal(f.generationCalls().length, 1);
  f.nextEdition(); const next = history(f.store);
  assert.equal(variantSnapshotReadiness(f.open(), 'p').status, 'not_ready'); assert.deepEqual(history(f.store), next);
});

for (const damage of ['omission', 'turn', 'run', 'kind'] as const) {
  test(`4R.1: queued reader ${damage} masquerade cannot hide pending or pay`, async t => {
    const f = await pendingReader(t), cursor = { ...f.reader.value.cursor };
    if (damage === 'omission') delete cursor.consumer;
    if (damage === 'turn') {
      const parent = f.store.list<any>('research-turn').find(row => row.value.dispatchMode === 'planning')!;
      cursor.consumer = { ...cursor.consumer, turn: reference(parent) }; // a real proven parent is not this reader's owner child
    }
    if (damage === 'run') cursor.consumer = { ...cursor.consumer, run: f.v.planAnswer };
    const value = damage === 'kind' ? { ...f.reader.value, kind: 'analyst' } : { ...f.reader.value, cursor };
    f.store.write({ id: f.reader.id, kind: f.reader.kind, expected: f.reader.revision, value });
    const before = history(f.store), calls = f.wires().length;
    assert.throws(() => variantSnapshotReadiness(f.store, 'p'), (error: unknown) => error instanceof EngineError
      && ['research_consumer_intent_invalid', 'discovery_variant_basis_invalid'].includes(error.code));
    assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, calls); assert.equal(f.generationCalls().length, 0);
  });
}


const paidReaderState = (store: Store) => ({ calls: store.list('model-call'), ledger: store.list('research-budget-ledger'),
  budget: store.list('research-budget') });
for (const phase of ['none','prepared','paid','split-paid','assembly'] as const) {
  test(`4R.1: reader restoreOnly at ${phase} restores paid bytes and never buys or re-prepares the unpaid remainder`, async t => {
    const f = await pendingReader(t, phase), before = paidReaderState(f.store), sent = f.wires().length;
    const intents = f.store.list<ResearchConsumerIntent>('research-consumer-intent').filter(row => row.value.kind === 'reader');
    const results = f.store.list('reader-result'), child = f.store.get(f.child.id)!;
    const restored = await f.run(1, f.open(), true);
    assert.equal(restored.value.pauseCode, ['none','prepared','split-paid'].includes(phase) ? 'research_restore_complete' : 'research_contract_upgrade_required', JSON.stringify(restored.value));
    assert.deepEqual(paidReaderState(f.store), before); assert.equal(f.wires().length, sent); assert.equal(f.generationCalls().length, 0);
    const readers = f.store.list<ResearchConsumerIntent>('research-consumer-intent').filter(row => row.value.kind === 'reader');
    assert.deepEqual(readers.map(row => row.id), intents.map(row => row.id), 'no new retry or split identity during restore');
    if (phase === 'none' || phase === 'prepared') {
      assert.deepEqual(readers, intents); assert.deepEqual(f.store.list('reader-result'), results); assert.deepEqual(f.store.get(child.id), child);
    } else {
      assert.ok(readers.every(row => row.value.state === 'applied'));
      assert.ok(f.store.list('reader-result').length > results.length);
    }
    if (phase === 'split-paid') assert.equal(f.store.get<any>(child.id)!.value.status, 'pending');
    if (phase === 'assembly') {
      const combined = f.store.list<any>('reader-result').find(row => row.value.producer === 'combined')!;
      assert.deepEqual(readReaderResultAt(f.open(),'p',reference(combined)),combined);
      assert.equal(f.store.get<any>(child.id)!.value.status, 'completed');
    }
    const fixed = history(f.store); assert.deepEqual(await f.run(1,f.open(),true),restored);
    assert.deepEqual(history(f.store),fixed); assert.deepEqual(paidReaderState(f.store),before); assert.equal(f.wires().length,sent);
    if (phase === 'split-paid') {
      const original = readers[0]!, pilot = readerPilot(f.store,'p')!;
      await assert.rejects(resumeReadBundleIntent(f.store,reference(original),f.environment.value,pilot,undefined,[],{restoreOnly:true}),
        {code:'research_restore_complete'});
      assert.deepEqual(history(f.store),fixed);assert.equal(f.wires().length,sent);
      const result = await resumeReadBundleIntent(f.store,reference(original),f.environment.value,pilot,undefined,[]);
      assert.equal(result.value.producer,'combined');
      assert.equal(f.wires().length,sent+1,'ordinary admission buys only the unpaid half');
      assert.equal(f.wires().at(-1).subject.role,'reader');
      assert.deepEqual(f.store.get(original.id,original.revision),original);
      assert.equal(f.store.list<ResearchConsumerIntent>('research-consumer-intent').filter(row=>row.value.kind==='reader').length,2);
    } else if (phase === 'none' || phase === 'prepared') {
      const priorReaderCalls = f.wires().filter(row=>row.subject.role==='reader').length;
      await f.run(1,f.open());
      assert.equal(f.wires().filter(row=>row.subject.role==='reader').length,priorReaderCalls+1);
      assert.equal(f.store.get<any>(child.id)!.value.status,'completed');
    }
  });
}

test('4R.1: an explicit retry permit for a genuinely failed reader cannot override restoreOnly', async t => {
  const f = await pendingReader(t); f.configure({readerFail:true});
  await f.run(1,f.open());
  const refused = f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row=>row.value.kind==='reader')!;
  assert.equal(refused.value.state,'refused'); assert.equal(refused.value.refusal?.kind,'provider-failed');
  f.configure({readerFail:false}); const permits = captureResearchConsumerRetryPermits(f.store,'p');
  assert.ok(permits.some(ref=>ref.id===refused.id));
  const active = readerPilot(f.store,'p')!, failed = f.store.get(refused.value.call!.id)!;
  const {projectId:_projectId,...settings} = active.value;
  f.engine.execute({type:'configure-reader-pilot',project:'p',expected:active.revision,
    settings:{...settings,unknownReserves:[{call:reference(failed),tokens:130}]}});
  const cursor = refused.value.cursor, pilot = readerPilot(f.store,'p')!, before = history(f.store), paid = paidReaderState(f.store), sent = f.wires().length;
  const read = (restoreOnly: boolean) => readBundle(f.store,f.environment.value,pilot,refused.value.question,cursor.purpose,cursor.rootInputs,
    undefined,cursor.consumer,permits,{restoreOnly});
  await assert.rejects(read(true),{code:'research_restore_complete'}); assert.deepEqual(history(f.store),before);
  assert.deepEqual(paidReaderState(f.store),paid); assert.equal(f.wires().length,sent);
  await assert.rejects(read(true),{code:'research_restore_complete'}); assert.deepEqual(history(f.store),before);
  const recovered = await read(false); assert.deepEqual(readReaderResultAt(f.open(),'p',reference(recovered)),recovered);
  assert.equal(f.wires().length,sent+1);
  assert.deepEqual(f.store.get(refused.id,refused.revision),refused);
});


test('4R.1: an uncovered remainder preserves the exact paid-prefix pause on a cold entry', async t => {
  const f=await setup(t,[planQuestion('block','industry','blocking'),planQuestion('uncovered','market')]);
  const stopped=await f.run(1);assert.equal(stopped.value.pauseCode,'research_turns_exhausted');
  const ready=variantSnapshotReadiness(f.open(),'p');assert.equal(ready.status,'not_ready');
  assert.ok(ready.reasons.some(reason=>reason.code==='question_uncovered'&&reason.message.includes('uncovered')));
  const before=history(f.store),paid=paidReaderState(f.store),sent=f.wires().length;
  assert.deepEqual(await f.run(1,f.open(),true),stopped);assert.deepEqual(history(f.store),before);
  assert.deepEqual(paidReaderState(f.store),paid);assert.equal(f.wires().length,sent);assert.equal(f.generationCalls().length,0);
});


for (const phase of ['session-only','paid','application'] as const) {
  test(`4R.1: queued reader generation at ${phase} restores its exact identity without recursive proof or repayment`, async t => {
    const f=await pendingReader(t);await f.run(1,f.open());
    assert.equal(variantSnapshotReadiness(f.open(),'p').status,'ready');
    const restore=cutGeneration(f.store,phase),cut=await f.run(1);restore();
    assert.equal(cut.value.pauseCode,'research_interrupted',JSON.stringify(cut.value));
    const beforeCalls=paidReaderState(f.store),sent=f.wires().length;
    const cold=await f.run(1,f.open(),true);
    assert.equal(cold.value.pauseCode,phase==='session-only'?'research_restore_complete':'research_variant_owner_required',JSON.stringify(cold.value));
    assert.deepEqual(paidReaderState(f.store),beforeCalls);assert.equal(f.wires().length,sent);
    if(phase==='session-only') assert.equal((await f.run(1,f.open())).value.pauseCode,'research_variant_owner_required');
    assert.equal(f.generationCalls().length,1);
    const set=f.store.list<VariantSet>('discovery-variant-set')[0]!;
    assert.deepEqual(readVariantGeneration(f.open(),'p',reference(set)).publication.result.ref,reference(set));
    const fixed=history(f.store),paid=paidReaderState(f.store),count=f.wires().length;
    await f.run(1,f.open());await f.run(1,f.open(),true);
    assert.deepEqual(history(f.store),fixed);assert.deepEqual(paidReaderState(f.store),paid);assert.equal(f.wires().length,count);
  });
}

for(const damage of ['kind','root','project','root-and-project','intent-call','claim-absent','claim-foreign','call-project','intent-null','call-null','foreign-head','foreign-call','intent-head-absent','intent-entity-kind','call-head-absent','call-entity-kind','foreign-call-entity-kind'] as const) {
  test(`4R.1: a published variant cannot hide reader lineage ${damage} masquerade`, async t => {
    const f=await pendingReader(t);await f.run(1,f.open());
    const published=await f.run(1,f.open());assert.equal(published.value.pauseCode,'research_variant_owner_required',JSON.stringify(published.value));
    const reader=f.store.get<ResearchConsumerIntent>(f.reader.id)!,call=f.store.get<any>(reader.value.call!.id)!;
    const rootKey=reader.value.cursor.rootKey;
    if(damage==='intent-head-absent'||damage==='call-head-absent'||damage==='intent-entity-kind'||damage==='call-entity-kind') {
      const target=damage.startsWith('intent-')?reader:call,sql=new DatabaseSync(f.store.path);
      try {
        if(damage.endsWith('head-absent'))sql.prepare('DELETE FROM heads WHERE entity_id=?').run(target.id);
        else {
          sql.prepare('INSERT INTO revisions(entity_id,revision,kind,body,sha256) SELECT entity_id,revision+1,?,body,sha256 FROM revisions WHERE entity_id=? AND revision=?')
            .run('foreign-record',target.id,target.revision);
          sql.prepare('UPDATE heads SET revision=? WHERE entity_id=?').run(target.revision+1,target.id);
        }
      } finally {sql.close();}
    } else if(damage==='intent-null') {
      f.store.write({id:reader.id,kind:reader.kind,expected:reader.revision,value:null});
    } else if(damage==='call-null') {
      f.store.write({id:call.id,kind:call.kind,expected:call.revision,value:null});
    } else if(damage==='foreign-head') {
      const variant=f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row=>row.value.kind==='variant-proposal')!;
      f.store.write({id:variant.id,kind:variant.kind,expected:variant.revision,
        value:{...variant.value,kind:'reader',cursor:{...variant.value.cursor,rootKey}}});
    } else if(damage==='foreign-call'||damage==='foreign-call-entity-kind') {
      const planner=f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row=>row.value.kind==='reading-planner')!;
      const foreign=f.store.get<any>(planner.value.call!.id)!;
      const claimed=f.store.write({id:foreign.id,kind:foreign.kind,expected:foreign.revision,
        value:{...foreign.value,consumerIntent:reference(f.store.get(reader.id,1)!)}});
      if(damage==='foreign-call-entity-kind') {
        const sql=new DatabaseSync(f.store.path);
        try {
          sql.prepare('INSERT INTO revisions(entity_id,revision,kind,body,sha256) SELECT entity_id,revision+1,?,body,sha256 FROM revisions WHERE entity_id=? AND revision=?')
            .run('foreign-record',claimed.id,claimed.revision);
          sql.prepare('UPDATE heads SET revision=? WHERE entity_id=?').run(claimed.revision+1,claimed.id);
        } finally {sql.close();}
      }
    } else if(['kind','root','project','root-and-project','intent-call'].includes(damage)) {
      const value:any={...reader.value,cursor:{...reader.value.cursor}};
      if(damage==='kind')value.kind='variant-proposal';
      if(damage==='root'||damage==='root-and-project')value.cursor.rootKey='foreign-root';
      if(damage==='project'||damage==='root-and-project')value.projectId='foreign-project';
      if(damage==='intent-call')delete value.call;
      f.store.write({id:reader.id,kind:reader.kind,expected:reader.revision,value});
    } else {
      const value={...call.value};
      if(damage==='claim-absent')delete value.consumerIntent;
      if(damage==='claim-foreign')value.consumerIntent=reference(f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(row=>row.value.kind==='reading-planner')!);
      if(damage==='call-project')value.projectId='foreign-project';
      f.store.write({id:call.id,kind:call.kind,expected:call.revision,value});
    }
    const before=history(f.store),paid=paidReaderState(f.store),sent=f.wires().length;
    assert.throws(()=>listResearchConsumerIntentsByRoot(f.open(),'p',rootKey),{code:'research_consumer_intent_invalid'});
    assert.deepEqual(history(f.store),before);assert.deepEqual(paidReaderState(f.store),paid);assert.equal(f.wires().length,sent);
  });
}

test('4R.1: an unpaid prepared reader cannot leave its lineage by changing entity kind', async t => {
  const f=await pendingReader(t),reader=f.store.get<ResearchConsumerIntent>(f.reader.id)!;
  assert.equal(reader.value.state,'prepared');assert.equal(reader.value.call,null);
  const sql=new DatabaseSync(f.store.path);
  try {
    sql.prepare('INSERT INTO revisions(entity_id,revision,kind,body,sha256) SELECT entity_id,revision+1,?,body,sha256 FROM revisions WHERE entity_id=? AND revision=?')
      .run('foreign-record',reader.id,reader.revision);
    sql.prepare('UPDATE heads SET revision=? WHERE entity_id=?').run(reader.revision+1,reader.id);
  } finally {sql.close();}
  const before=history(f.store),paid=paidReaderState(f.store),sent=f.wires().length;
  assert.throws(()=>listResearchConsumerIntentsByRoot(f.open(),'p',reader.value.cursor.rootKey),{code:'research_consumer_intent_invalid'});
  assert.deepEqual(history(f.store),before);assert.deepEqual(paidReaderState(f.store),paid);assert.equal(f.wires().length,sent);
});
