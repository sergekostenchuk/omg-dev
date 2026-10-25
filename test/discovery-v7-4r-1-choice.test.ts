import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { readVariantModelDecision, readVariantGeneration } from '../src/discovery/variant-session.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantExecutionSession, type VariantSet } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice, readVariantOwnerDecision } from '../src/discovery/discovery-decision.js';
import { readCurrentVariantScope } from '../src/discovery/variant-scope.js';
import type { ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { V7_STAGE_TOKEN_CEILING, V7_COMPLETION_RESERVE } from '../src/discovery/v7-contracts.js';
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
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
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


const money = (store: Store) => store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind)).flatMap(row => store.history(row.id));
function choiceScope(f: Awaited<ReturnType<typeof setup>>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
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
const subjectCalls = (f: Awaited<ReturnType<typeof setup>>, kind: string) => f.wires().filter(w => w.subject.variantSubject?.kind === kind);
async function fixed(f: Awaited<ReturnType<typeof setup>>, result: Revision<import('../src/discovery/research-model.js').ResearchRun>) {
  const before = history(f.store), sent = f.wires();
  assert.deepEqual(await f.run(1, f.open(), true), result); assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), sent);
}
for (const kind of ['choose', 'reject_all'] as const) test(`4R.1 choice: public bypass generation -> separate paid ${kind} -> addressed handoff pause and cold fixed point`, async t => {
  const f = await setup(t, undefined, 'bypass'); f.configure({ reject: kind === 'reject_all' });
  const result = await f.run(3); assert.equal(result.value.pauseCode, 'research_variant_handoff_unavailable', JSON.stringify(result.value));
  assert.equal(result.value.status, 'paused'); assert.equal(subjectCalls(f, 'proposal').length, 1); assert.equal(subjectCalls(f, 'decision').length, 1);
  const decision = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!, proof = readVariantModelDecision(f.store, 'p', reference(decision));
  assert.ok(proof.state); assert.equal(decision.value.outcome.kind, kind);
  const pause = JSON.parse(result.value.error!); assert.deepEqual(pause.decision, reference(decision)); assert.equal(pause.reason, kind);
  assert.deepEqual(pause.result, decision.value.set); assert.deepEqual(pause.selection, proof.state);
  if (kind === 'choose') assert.deepEqual(pause.scope, reference(readCurrentVariantScope(f.store, 'p', decision.value.draft).scope));
  else { assert.equal(pause.scope, null); assert.equal(f.store.list('discovery-variant-scope').length, 0); }
  assert.equal(f.store.list('discovery-variant-handoff').length, 0); await fixed(f, result);
});
for (const kind of ['choose', 'reject_all'] as const) test(`4R.1 choice: questions stops without a model choice, then accepts a real owner ${kind} on cold continuation`, async t => {
  const f = await setup(t), door = await f.run(3);
  assert.equal(door.value.pauseCode, 'research_variant_owner_required'); assert.equal(subjectCalls(f, 'decision').length, 0);
  const scope = choiceScope(f, kind), act = owner(f.store, scope), paid = money(f.store), sent = f.wires(), mode = reference(f.store.get('project-mode:p')!);
  const result = await f.run(1, f.open(), true); assert.equal(result.value.pauseCode, 'research_variant_handoff_unavailable', JSON.stringify(result.value));
  assert.deepEqual(JSON.parse(result.value.error!).decision, reference(act.decision)); assert.deepEqual(readVariantOwnerDecision(f.store, 'p', reference(act.decision)).state, act.state);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), sent); assert.deepEqual(reference(f.store.get('project-mode:p')!), mode);
  assert.equal(f.store.list('discovery-variant-scope').length, kind === 'choose' ? 1 : 0); await fixed(f, result);
});

test('4R.1 choice: a mode switch after paid generation buys only its separate choice, preserving the original generation subject', async t => {
  const f = await setup(t); assert.equal((await f.run(2)).value.pauseCode, 'research_variant_owner_required');
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, original = readVariantGeneration(f.store, 'p', reference(set));
  const bypass = f.mode('bypass'), result = await f.run(1, f.open());
  assert.equal(result.value.pauseCode, 'research_variant_handoff_unavailable', JSON.stringify(result.value));
  assert.equal(subjectCalls(f, 'proposal').length, 1); assert.equal(subjectCalls(f, 'decision').length, 1);
  assert.deepEqual(readVariantGeneration(f.store, 'p', reference(set)), original);
  const decision = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  assert.deepEqual(decision.value.mode, reference(bypass)); assert.deepEqual(original.session.value.variantSubject.mode, reference(f.initial)); await fixed(f, result);
});

test('4R.1 choice: generation and decision each consume an allowance; restoreOnly cannot buy the missing choice', async t => {
  const f = await setup(t, undefined, 'bypass'), limited = await f.run(2);
  assert.equal(limited.value.pauseCode, 'research_turns_exhausted', JSON.stringify(limited.value)); assert.equal(subjectCalls(f, 'proposal').length, 1);
  assert.equal(subjectCalls(f, 'decision').length, 0); assert.equal(f.store.list('discovery-variant-session').length, 1);
  const sent = f.wires(), restored = await f.run(1, f.open(), true); assert.equal(restored.value.pauseCode, 'research_restore_complete'); assert.deepEqual(f.wires(), sent);
  const ready = await f.run(1, f.open()); assert.equal(ready.value.pauseCode, 'research_variant_handoff_unavailable'); assert.equal(subjectCalls(f, 'decision').length, 1); await fixed(f, ready);
});

function cutDecision(store: Store, phase: 'session-only' | 'prepared' | 'reservation' | 'paid' | 'application') {
  const write = store.writeMany.bind(store), atomic = store.atomicWrite.bind(store); let hit = false;
  store.atomicWrite = ((prepare) => {
    const result = atomic(prepare);
    if (!hit && phase === 'prepared' && result.records.some(row => row.kind === 'research-consumer-intent'
      && (row.value as ResearchConsumerIntent).kind === 'variant-decision')) {
      hit = true; throw new Error('Cut after real atomic decision preparation');
    }
    return result;
  }) as typeof store.atomicWrite;
  store.writeMany = ((writes, guards = []) => {
    const step = writes.some(row => phase === 'prepared'
      ? row.kind === 'research-consumer-intent' && row.expected === 0 && (row.value as ResearchConsumerIntent).kind === 'variant-decision'
      : phase === 'reservation' ? row.kind === 'model-call' && row.expected === 0 && (row.value as {variantSubject?: {kind:string}}).variantSubject?.kind === 'decision'
      : row.kind === 'discovery-variant-session' && row.expected === (phase === 'session-only' ? 0 : 1)
        && (row.value as VariantExecutionSession).variantSubject.kind === 'decision');
    if (step && !hit && phase === 'paid') { hit = true; throw new Error('Cut after real paid decision, before application'); }
    const rows = write(writes, guards); if (step && !hit) { hit = true; throw new Error(`Cut after decision ${phase}`); } return rows;
  }) as typeof store.writeMany;
  return () => { store.writeMany = write; store.atomicWrite = atomic; assert.ok(hit, `Reached real decision ${phase}`); };
}
for (const phase of ['session-only', 'prepared', 'reservation', 'paid', 'application'] as const)
  test(`4R.1 choice: cold recovery at ${phase} preserves the original identity and never buys a second decision`, async t => {
    const f = await setup(t); await f.run(2); f.mode('bypass'); const undo = cutDecision(f.store, phase);
    const interrupted = await f.run(1); undo(); assert.notEqual(interrupted.value.status, 'completed');
    const session = f.store.list<VariantExecutionSession>('discovery-variant-session').find(row => row.value.variantSubject.kind === 'decision')!;
    const sent = f.wires(), restored = await f.run(1, f.open(), true); assert.deepEqual(f.wires(), sent);
    if (phase === 'session-only' || phase === 'prepared') {
      assert.equal(restored.value.pauseCode, 'research_restore_complete'); assert.equal(subjectCalls(f, 'decision').length, 0);
      assert.equal((await f.run(1, f.open())).value.pauseCode, 'research_variant_handoff_unavailable');
    } else if (phase === 'reservation') assert.notEqual(restored.value.pauseCode, 'research_variant_handoff_unavailable');
    else assert.equal(restored.value.pauseCode, 'research_variant_handoff_unavailable', JSON.stringify(restored.value));
    assert.equal(f.store.list<VariantExecutionSession>('discovery-variant-session').filter(row => row.value.variantSubject.kind === 'decision').length, 1);
    assert.equal(f.store.list<VariantExecutionSession>('discovery-variant-session').find(row => row.value.variantSubject.kind === 'decision')!.id, session.id);
    assert.equal(subjectCalls(f, 'decision').length, phase === 'reservation' ? 0 : 1);
    await fixed(f, await f.run(1, f.open(), true));
  });

test('4R.1 choice: concurrent authorized owner after a paid decision keeps the owner state and restores the stale model free', async t => {
  const f = await setup(t); await f.run(2); f.mode('bypass'); const undo = cutDecision(f.store, 'paid'); await f.run(1); undo();
  f.mode('questions'); const act = owner(f.store, choiceScope(f)), paid = money(f.store), sent = f.wires();
  const result = await f.run(1, f.open(), true); assert.equal(result.value.pauseCode, 'research_variant_handoff_unavailable', JSON.stringify(result.value));
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  assert.equal(readVariantModelDecision(f.store, 'p', reference(model)).state, null);
  assert.deepEqual(JSON.parse(result.value.error!).decision, reference(act.decision)); assert.deepEqual(f.store.get(act.state.id), act.state);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), sent); assert.equal(subjectCalls(f, 'decision').length, 1); await fixed(f, result);
});

test('4R.1 choice: paid decision restores before a new accepted edition or a former producer policy without activating an old scope', async t => {
  const f = await setup(t); await f.run(2); f.mode('bypass'); const undo = cutDecision(f.store, 'paid'); await f.run(1); undo();
  f.nextEdition(); const sent = f.wires(), paid = money(f.store);
  const result = await new Researcher(f.store, f.discovery, f.engine.environments).run('p', f.v.draft.id, 1, undefined,
    { restoreOnly: true, producerPolicy: { discovery: 6 } });
  const decision = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  assert.ok(readVariantModelDecision(f.store, 'p', reference(decision))); assert.notEqual(result.value.pauseCode, 'research_variant_handoff_unavailable');
  assert.equal(f.store.list('discovery-variant-scope').length, 0); assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), sent); await fixed(f, result);
});

test('4R.1 choice: stale paid model with no applied state is retained and cannot become a scope or another purchase after restart/mode/actor shift', async t => {
  const f = await setup(t); await f.run(2); f.mode('bypass'); const undo = cutDecision(f.store, 'paid'); await f.run(1); undo();
  f.mode('questions'); const sent = f.wires(), result = await f.run(1, f.open(), true);
  assert.equal(result.value.pauseCode, 'research_variant_owner_required'); const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  assert.equal(readVariantModelDecision(f.store, 'p', reference(model)).state, null); assert.equal(f.store.list('discovery-variant-scope').length, 0);
  f.mode('bypass'); f.engine.environments.configure('p', { ...f.environment.value,
    implementer: { ...f.environment.value.implementer, actor: 'another-model-author' } }, f.environment.revision);
  const again = await f.run(3, f.open()); assert.equal(again.value.pauseCode, 'research_variant_context_stale'); assert.deepEqual(f.wires(), sent); await fixed(f, again);
});

function switchMode(store: Store, mode: 'questions' | 'bypass') {
  const head = store.get('project-mode:p'), request = { project: 'p', mode, previous: head ? reference(head) : null };
  const sessions = new ProjectModeSessions(store), invite = issueProjectModeInvitation(store, request); assert.ok(invite.ok);
  if (!invite.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ project: 'p', invitation: invite.value.invitation }); assert.ok(login.ok);
  if (!login.ok) assert.fail('Expected successful owner exchange');
  return setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
}
for (const shift of ['mode', 'owner-state'] as const) test(`4R.1 choice: a second Store shifts ${shift} after preparation; the common reservation buys nothing from the stale admission`, async t => {
  const f = await setup(t); await f.run(2); f.mode('bypass');
  const second = f.open(), atomic = f.store.atomicWrite.bind(f.store); let moved = false;
  const sent = f.wires(), paid = money(f.store);
  f.store.atomicWrite = ((prepare) => {
    const result = atomic(prepare);
    const decision = result.records.some(row => row.kind === 'research-consumer-intent' && row.revision === 1
      && (row.value as ResearchConsumerIntent).kind === 'variant-decision');
    if (decision && !moved) { moved = true; switchMode(second, 'questions'); if (shift === 'owner-state') owner(second, choiceScope(f)); }
    return result;
  }) as typeof f.store.atomicWrite;
  const refused = await f.run(1); f.store.atomicWrite = atomic; assert.ok(moved);
  assert.notEqual(refused.value.pauseCode, 'research_variant_handoff_unavailable'); assert.deepEqual(f.wires(), sent); assert.deepEqual(money(f.store), paid);
  const resumed = await f.run(1, f.open(), true);
  assert.equal(resumed.value.pauseCode, shift === 'mode' ? 'research_variant_owner_required' : 'research_variant_handoff_unavailable', JSON.stringify(resumed.value));
  assert.deepEqual(f.wires(), sent); assert.deepEqual(money(f.store), paid); await fixed(f, resumed);
});

test('4R.1 choice: a structural owner lookalike and its fabricated current state never become a ready choice', async t => {
  const f = await setup(t); await f.run(2); const scope = choiceScope(f), { action: _action, ...basis } = scope;
  const fake = f.store.write({ id: 'explicit-negative-owner-lookalike', kind: 'discovery-variant-owner-decision', expected: 0,
    value: { ...basis, contract: 'discovery-variant-owner-decision/v1', authority: { grant: scope.set, session: scope.set } } });
  const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  const corrupted = f.store.write({ id: state.id, kind: state.kind, expected: state.revision, value: { ...state.value, previous: reference(state), decision: reference(fake) } });
  const sent = f.wires(), paid = money(f.store), result = await f.run(2, f.open());
  assert.notEqual(result.value.pauseCode, 'research_variant_handoff_unavailable'); assert.equal(f.store.list('discovery-variant-scope').length, 0);
  assert.deepEqual(f.store.get(state.id), corrupted); assert.deepEqual(f.wires(), sent); assert.deepEqual(money(f.store), paid);
});

test('4R.1 choice: a changed model head/current selection cannot masquerade as the original applied decision', async t => {
  const f = await setup(t, undefined, 'bypass'); await f.run(3);
  const saved = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!, state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  const bad = f.store.write({ id: saved.id, kind: saved.kind, expected: saved.revision,
    value: { ...saved.value, outcome: { kind: 'reject_all' as const, reason: 'Explicitly forged changed head' } } });
  f.store.write({ id: state.id, kind: state.kind, expected: state.revision, value: { ...state.value, previous: reference(state), decision: reference(bad) } });
  const sent = f.wires(), paid = money(f.store), scopes = f.store.list('discovery-variant-scope'), result = await f.run(3, f.open());
  assert.notEqual(result.value.pauseCode, 'research_variant_handoff_unavailable'); assert.deepEqual(f.store.list('discovery-variant-scope'), scopes);
  assert.deepEqual(f.wires(), sent); assert.deepEqual(money(f.store), paid); assert.ok(readVariantModelDecision(f.store, 'p', reference(saved)));
});

test('4R.1 choice: a real model -> owner override -> owner revise stays current across restart, mode and actor changes without another purchase', async t => {
  const f = await setup(t, undefined, 'bypass'); const first = await f.run(3);
  assert.equal(first.value.pauseCode, 'research_variant_handoff_unavailable');
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!, proof = readVariantModelDecision(f.store, 'p', reference(model));
  const override: VariantChoiceScope = { ...choiceScope(f, 'reject_all'), operation: 'override', previous: reference(model), expectedSelection: proof.state! };
  const act = owner(f.store, override), sent = f.wires(), paid = money(f.store);
  const rejected = await f.run(1, f.open()); assert.equal(JSON.parse(rejected.value.error!).scope, null);
  assert.deepEqual(JSON.parse(rejected.value.error!).decision, reference(act.decision));
  const revise: VariantChoiceScope = { ...choiceScope(f), operation: 'revise', previous: reference(act.decision), expectedSelection: reference(act.state) };
  const last = owner(f.store, revise); f.mode('questions');
  f.engine.environments.configure('p', { ...f.environment.value, implementer: { ...f.environment.value.implementer, actor: 'new-author-after-owner-act' } }, f.environment.revision);
  const chosen = await f.run(3, f.open()); assert.equal(chosen.value.pauseCode, 'research_variant_handoff_unavailable');
  assert.deepEqual(JSON.parse(chosen.value.error!).decision, reference(last.decision));
  assert.deepEqual(readCurrentVariantScope(f.store, 'p', last.decision.value.draft).choice.ref, reference(last.decision));
  assert.deepEqual(f.wires(), sent); assert.deepEqual(money(f.store), paid); await fixed(f, chosen);
});

test('4R.1 choice: actual paid generation can exhaust the research reserve; the common B.2 reservation cannot buy the next choice', async t => {
  const f = await setup(t, undefined, 'bypass'); f.configure({ proposalTokens: V7_STAGE_TOKEN_CEILING - V7_COMPLETION_RESERVE - 23 });
  const result = await f.run(3);
  assert.equal(result.value.pauseCode, 'discovery_budget_reserve', JSON.stringify(result.value));
  assert.equal(subjectCalls(f, 'proposal').length, 1); assert.equal(subjectCalls(f, 'decision').length, 0);
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!; assert.ok(readVariantGeneration(f.store, 'p', reference(set)));
  const paid = money(f.store), sent = f.wires(), restored = await f.run(1, f.open(), true);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), sent); assert.equal(f.store.list('discovery-variant-model-decision').length, 0); await fixed(f, restored);
});
