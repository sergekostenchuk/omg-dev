import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  type ResearchConsumerIntent, type ResearchConsumerIntentInput } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { prepareVariantSession, applyVariantSession, runVariantSession, readVariantModelDecision, readVariantExecutionSession,
  type VariantSessionInput } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, variantRecordId, type VariantSubject, type VariantSet, type DiscoveryVariant } from '../src/discovery/discovery-variants.js';
import { variantStateId, variantDecisionPublicationWrites, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { variantExecutionSessionId, projectPaidVariantSession } from '../src/discovery/research-consumer-transition.js';
import { variantTransportFields, variantTransportGuards } from '../src/discovery/continuation-packet.js';
import { ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

// 4B.2 (codex-omg №11655 п.1): only bypass buys a separate managed model decision over an exact PROVEN set; questions
// stops at the owner door. The snapshot is the real 4T.1 one, the set the real 4B.1 publication, the modes real project
// modes written through their owner authority; frame/plan come from the named v7 fixture.
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const ok = <T>(result: any): T => { assert.equal(result.ok, true, JSON.stringify(result.refusal ?? null)); return result.value as T; };
const judgement = { conclusion: 'Bounded by the actual sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the saved sweep'], quantity: null };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'One shared scale from low to high']));
const generation = { action: 'variants', variants: [1, 2].map(i => ({ key: `v${i}`, title: `Variant ${i}`, proposal: { scope: `scope-${i}` }, criteria })),
  scale, comparison: 'Two bounded variants on one scale', recommendation: { key: 'v2', reason: 'The generation recommends the wider one' },
  searchLimits: ['Only the saved sweep'], unknowns: [] };
const none = (grounds: Ref[]) => ({ action: 'no_variants', reasons: [{ code: 'snapshot_insufficient', message: 'No bounded variant', grounds }],
  searchLimits: ['Only the saved sweep'], unknowns: [] });
const choose = (key: string) => ({ action: 'choose', key, reason: `The model chooses ${key}` });

async function setup(t: test.TestContext, answer: unknown = generation) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-4b2-' }), project = 'p';
  await f.engine.execute({ type: 'create-project', project, title: 'Paid variant decision' });
  const runs = new Map<string, string>();
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const runId = runs.get(selected.planAnswer.hash);
    const run = runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({ id: `research-run:${rand()}`, kind: 'research-run', expected: 0,
      value: { projectId: project, draftId: draft.id, environment: reference(f.environment), turns: 0, limit: 100, requestChars: 0,
        owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run), draft: reference(draft),
      question: reference(question), role: f.environment.value.implementer, dispatch: f.environment.value, profile: null,
      cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input);
    const invoke = () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const entry = await produce(g, undefined, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Real paid assessment'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }],
      accepted: [], rejected: [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
      methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
    const paid = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
    applyDiscoveryAssessment(f.store, project, reference(paid));
  }
  const saved = produceVariantSnapshot(f.store, project).record;
  // Real project modes, each written through its own owner authority.
  const setMode = (mode: 'questions' | 'bypass', previous: Ref | null) => {
    const sessions = new ProjectModeSessions(f.store), invite = ok<any>(issueProjectModeInvitation(f.store, { project, mode, previous }));
    const login = ok<any>(sessions.exchange({ project, invitation: invite.invitation }));
    const record = setProjectMode(f.store, { project, mode, previous }, sessions.authority(login.bearer)).record;
    ok(sessions.revoke(login.bearer));
    return record;
  };
  const questions = setMode('questions', null);
  const reply = (value: unknown) => writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: value }));
  // Service calibrations of both variant purposes and both roles on the legacy calibration draft (transport fixtures only).
  const cal = reference(f.store.write({ id: 'transport-fixture:calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer]) for (const kind of ['proposal', 'decision'] as const) {
    reply(kind === 'proposal' ? generation : choose('v1'));
    const subject: VariantSubject = kind === 'proposal' ? { contract: VARIANT_SUBJECT_CONTRACT, kind, snapshot: cal, mode: reference(questions), expectedSelection: null }
      : { contract: VARIANT_SUBJECT_CONTRACT, kind, set: cal, mode: reference(questions), expectedSelection: null };
    await researchCall(role, f.environment.value, 'Calibrate', { variantSubject: subject, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: `variant-${kind}` });
  }
  // The real 4B.1 publication of the set, in questions mode.
  reply(answer);
  const proposal: VariantSessionInput = { projectId: project, environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Propose variants from this exact saved sweep',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(saved), mode: reference(questions), expectedSelection: null } };
  const generated = await runVariantSession(f.store, proposal);
  const set = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === project) ?? null;
  const result = generated.value.result!, draft = generated.value.draft;
  const state1 = f.store.get<VariantState>(variantStateId(project, draft.id))!;
  const decisionInput = (mode: Ref, expected: Ref | null = reference(state1), role = f.environment.value.implementer): VariantSessionInput => ({
    projectId: project, environment: f.environment, role, prompt: 'Choose one variant of this exact set, or reject them all',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: set ? reference(set) : (null as never), mode, expectedSelection: expected } });
  /** The real managed paid decision call without its application. */
  async function pay(input: VariantSessionInput, store = f.store) {
    const prepared = prepareVariantSession(store, input), v = prepared.intent.value;
    await researchCall(v.role, v.dispatch, v.cursor.prompt, v.cursor.context, undefined,
      { store, draftId: v.draft.id, questionId: v.question.id, purpose: v.kind, consumerIntent: reference(prepared.intent), session: v.owner });
    return store.get<ResearchConsumerIntent>(prepared.intent.id)!;
  }
  return { ...g, project, saved, setMode, questions, reply, set, result, draft, state1, decisionInput, pay };
}
const membersOf = (f: Awaited<ReturnType<typeof setup>>) => f.set!.value.members.map(ref => f.store.get<DiscoveryVariant>(ref.id, ref.revision)!);

test('4B.2: bypass buys one managed model decision over the exact proven set — the chosen member, not the recommendation, and the next state in one batch', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  f.reply(choose('v1'));
  const sent = f.wires().length;
  const receipt = await runVariantSession(f.store, f.decisionInput(reference(bypass)));
  assert.equal(f.wires().length, sent + 1, 'one paid decision');
  const [v1] = membersOf(f);
  const decision = f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === f.project)!;
  assert.deepEqual(decision.value.outcome, { kind: 'choose', member: reference(v1!), reason: 'The model chooses v1' }, 'the chosen key, not the recommended v2');
  assert.equal(decision.id, variantRecordId('discovery-variant-model-decision', decision.value));
  assert.deepEqual([decision.value.set, decision.value.mode, decision.value.expectedSelection, decision.value.previous],
    [reference(f.set!), reference(bypass), reference(f.state1), null]);
  const state = f.store.get<VariantState>(variantStateId(f.project, f.draft.id))!;
  assert.deepEqual([state.revision, state.value.decision, state.value.set, state.value.result, state.value.previous, state.value.mode],
    [2, reference(decision), reference(f.set!), reference(f.set!), reference(f.state1), reference(bypass)]);
  const applied = f.store.get<ResearchConsumerIntent>(receipt.value.result!.intent.id)!;
  assert.deepEqual(applied.value.outputs, [reference(receipt), reference(decision), reference(state)]);
  const proven = readVariantModelDecision(f.store, f.project, reference(decision));
  assert.deepEqual([proven.verification, proven.state, proven.decision.ref], ['proven', reference(state), reference(decision)]);
  const snapshot = history(f.store);
  for (const store of [f.store, f.open()]) assert.deepEqual(await runVariantSession(store, f.decisionInput(reference(bypass))), receipt);
  assert.deepEqual(history(f.store), snapshot, 'the cold exact repeat writes nothing');
  assert.equal(f.wires().length, sent + 1, 'and pays nothing');
});

test('4B.2: reject_all is a decision without a member', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  f.reply({ action: 'reject_all', reason: 'No variant fits the mandate' });
  await runVariantSession(f.store, f.decisionInput(reference(bypass)));
  const decision = f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === f.project)!;
  assert.deepEqual(decision.value.outcome, { kind: 'reject_all', reason: 'No variant fits the mandate' });
  assert.equal(readVariantModelDecision(f.store, f.project, reference(decision)).verification, 'proven');
});

test('4B.2: questions buys no model choice — the decision stops at the owner door before any record or payment', async t => {
  const f = await setup(t);
  const before = history(f.store), sent = f.wires().length;
  assert.throws(() => prepareVariantSession(f.store, f.decisionInput(reference(f.questions))), code('discovery_variant_owner_door'));
  assert.deepEqual(history(f.store), before);
  assert.equal(f.wires().length, sent);
});

test('4B.2: one set is decided once — another actor, mode or selection buys nothing, after the decision and while one is being paid', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  f.reply(choose('v2'));
  // While identity A is paid but not applied, identity B of the same set buys nothing.
  const running = await f.pay(f.decisionInput(reference(bypass)));
  const sent = f.wires().length, before = history(f.store);
  assert.throws(() => prepareVariantSession(f.store, f.decisionInput(reference(bypass), reference(f.state1), f.environment.value.reviewer)),
    code('discovery_variant_decision_exists'));
  assert.deepEqual(history(f.store), before);
  applyVariantSession(f.store, f.project, reference(running));
  const state2 = f.store.get<VariantState>(variantStateId(f.project, f.draft.id))!;
  const bypass2 = f.setMode('bypass', reference(bypass));
  const after = history(f.store);
  for (const [note, input] of [['another actor', f.decisionInput(reference(bypass), reference(f.state1), f.environment.value.reviewer)],
    ['another mode', f.decisionInput(reference(bypass2))], ['the decided state as selection', f.decisionInput(reference(bypass2), reference(state2))]] as const)
    assert.throws(() => prepareVariantSession(f.store, input), code('discovery_variant_decision_exists'), note);
  assert.deepEqual(history(f.store), after);
  assert.equal(f.wires().length, sent);
});

test('4B.2: a mode moved after payment keeps the paid decision historically proven without a state, overwriting nothing and buying no other', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  f.reply(choose('v1'));
  const running = await f.pay(f.decisionInput(reference(bypass))), sent = f.wires().length;
  const back = f.setMode('questions', reference(bypass));
  const receipt = applyVariantSession(f.store, f.project, reference(running));
  assert.equal(f.wires().length, sent, 'no second payment');
  assert.deepEqual(reference(f.store.get(variantStateId(f.project, f.draft.id))!), reference(f.state1), 'the current state is not overwritten');
  const decision = f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === f.project)!;
  const proven = readVariantModelDecision(f.open(), f.project, reference(decision));
  assert.deepEqual([proven.verification, proven.state], ['proven', null], 'the result and the stale state are distinguishable');
  assert.deepEqual(readVariantExecutionSession(f.open(), f.project, reference(receipt)), receipt);
  assert.deepEqual(reference(f.store.get(back.id)!), reference(back));
  const bypass2 = f.setMode('bypass', reference(back));
  assert.throws(() => prepareVariantSession(f.store, f.decisionInput(reference(bypass2))), code('discovery_variant_decision_exists'));
});

test('4B.2: no direct transport, unproven set or no_variants buys a model decision', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  const before = history(f.store), sent = f.wires().length;
  const subject = f.decisionInput(reference(bypass)).variantSubject;
  f.reply(choose('v1'));
  await assert.rejects(() => researchCall(f.environment.value.implementer, f.environment.value, 'Choose', { variantSubject: subject, history: [] }, undefined,
    { store: f.store, draftId: f.draft.id, questionId: f.result ? prepareQuestion(f) : '', purpose: 'variant-decision' }), code('discovery_variant_managed'));
  assert.deepEqual(history(f.store), before);
  // A structural copy of the set under its canonical address proves nothing.
  const forged = { ...f.set!.value, comparison: 'Forged comparison' };
  const copy = reference(f.store.write({ id: variantRecordId('discovery-variant-set', forged), kind: 'discovery-variant-set', expected: 0, value: forged as unknown as Json }));
  const afterForgery = history(f.store);
  assert.throws(() => prepareVariantSession(f.store, { ...f.decisionInput(reference(bypass)), variantSubject: { ...subject, set: copy } } as VariantSessionInput),
    (error: unknown) => error instanceof EngineError);
  assert.deepEqual(history(f.store), afterForgery);
  assert.equal(f.wires().length, sent);
  // A no_variants result is no set to decide over.
  const g = await setup(t, none([reference(f.saved)]));
  assert.equal(g.set, null);
  const negative = g.store.list<any>('discovery-variant-none').find(row => row.value.projectId === g.project)!;
  const gb = g.setMode('bypass', reference(g.questions));
  const input: VariantSessionInput = { ...g.decisionInput(reference(gb)), variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision',
    set: reference(negative), mode: reference(gb), expectedSelection: reference(g.state1) } };
  assert.throws(() => prepareVariantSession(g.store, input), code('discovery_variant_set_not_ready'));
});
function prepareQuestion(f: Awaited<ReturnType<typeof setup>>): string {
  return f.store.get<any>(f.result.intent.id, f.result.intent.revision)!.value.question.id;
}

const accounting = (store: Store) => history(store).filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind));
/** Real producer cut after session creation, before the intent transaction. Capture its legal input for common-door
 * negatives; the readonly callback's throw rolls back the attempted intent. No positive session is hand-written. */
function sessionOnly(f: Awaited<ReturnType<typeof setup>>, input: VariantSessionInput) {
  const cut = new Error('session-only cut'), atomic = f.store.atomicWrite.bind(f.store);
  let pending: ResearchConsumerIntent | null = null;
  f.store.atomicWrite = ((prepare: Parameters<Store['atomicWrite']>[0]) => atomic(view => {
    const batch = prepare(view);
    pending = batch.writes.find(write => write.kind === 'research-consumer-intent')!.value as ResearchConsumerIntent;
    throw cut;
  })) as typeof f.store.atomicWrite;
  try { assert.throws(() => prepareVariantSession(f.store, input), error => error === cut); }
  finally { f.store.atomicWrite = atomic; }
  assert.ok(pending);
  const value = pending as ResearchConsumerIntent;
  const { contract: _contract, rootKey: _root, generation: _generation, previous: _previous, state: _state,
    call: _call, request: _request, archive: _archive, outputs: _outputs, refusal: _refusal, ...admission } = value;
  return { input: admission as ResearchConsumerIntentInput, session: f.store.get(value.owner.id, value.owner.revision)! };
}

test('4B.2: the common preparer independently rejects questions and missing dispatch dependencies before publishing an intent', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  const saved = sessionOnly(f, f.decisionInput(reference(bypass)));
  // Explicit negative corruption: a structural session changes the real producer's subject to questions. It must not
  // become an admission by bypassing prepareVariantSession and entering the common preparer directly.
  const subject = { ...f.decisionInput(reference(f.questions)).variantSubject }, original = saved.session.value as any;
  const value = { ...original, variantSubject: subject }, id = variantExecutionSessionId(value);
  const fake = f.store.write({ id, kind: 'discovery-variant-session', expected: 0, value });
  const bad: ResearchConsumerIntentInput = { ...saved.input, key: id, owner: reference(fake),
    cursor: { ...saved.input.cursor, sessionId: id, variantSubject: subject,
      context: { ...saved.input.cursor.context, ...variantTransportFields(f.project, value.draft, value.question, value.purpose, value.actor, subject) } },
    guards: uniqueTransactionGuards([reference(fake), value.draft, value.question, reference(f.environment),
      ...variantTransportGuards(f.project, value.draft.id, subject)]) };
  const before = history(f.store), sent = f.wires().length;
  assert.throws(() => prepareResearchConsumerIntent(f.store, bad), code('discovery_variant_owner_door'));
  for (const key of ['draft', 'question', 'owner', 'projectId', 'key', 'role', 'dispatch', 'cursor', 'guards', 'basis']) {
    const missing = { ...saved.input } as Record<string, unknown>; delete missing[key];
    assert.throws(() => prepareResearchConsumerIntent(f.store, missing as ResearchConsumerIntentInput), error => error instanceof EngineError);
  }
  for (const guard of variantTransportGuards(f.project, saved.input.draft.id, saved.input.cursor.variantSubject)) {
    assert.throws(() => prepareResearchConsumerIntent(f.store, { ...saved.input,
      guards: saved.input.guards.filter(savedGuard => savedGuard.id !== guard.id) }), error => error instanceof EngineError);
  }
  assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, sent);
});

test('4B.2: a structurally valid current state without the paid generation publication never admits a decision', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  // Negative state corruption under the real address; this revision was not an output of the paid set application.
  const forged = f.store.write({ id: f.state1.id, kind: f.state1.kind, expected: f.state1.revision,
    value: { ...f.state1.value, mode: reference(bypass), previous: reference(f.state1) } });
  const before = history(f.store), money = accounting(f.store), sent = f.wires().length;
  assert.throws(() => prepareVariantSession(f.store, f.decisionInput(reference(bypass), reference(forged))), code('discovery_variant_decision_invalid'));
  assert.deepEqual(history(f.store), before); assert.deepEqual(accounting(f.store), money); assert.equal(f.wires().length, sent);
});

test('4B.2: a second Store winning between admission and intent commit admits exactly one identity without a deadlocked loser', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions)); f.reply(choose('v1'));
  const first = f.decisionInput(reference(bypass)), winner = f.decisionInput(reference(bypass), reference(f.state1), f.environment.value.reviewer);
  sessionOnly(f, first); sessionOnly(f, winner);
  const other = f.open(), atomic = f.store.atomicWrite.bind(f.store);
  let raced = false, afterWinner: ReturnType<typeof history> = [];
  f.store.atomicWrite = ((prepare: Parameters<Store['atomicWrite']>[0]) => {
    if (!raced) { raced = true; prepareVariantSession(other, winner); afterWinner = history(other); }
    return atomic(prepare);
  }) as typeof f.store.atomicWrite;
  const sent = f.wires().length;
  try { assert.throws(() => prepareVariantSession(f.store, first), code('discovery_variant_decision_exists')); }
  finally { f.store.atomicWrite = atomic; }
  assert.equal(raced, true); assert.deepEqual(history(f.store), afterWinner);
  assert.equal(f.store.list<ResearchConsumerIntent>('research-consumer-intent').filter(row => row.value.kind === 'variant-decision').length, 1);
  await runVariantSession(other, winner); assert.equal(f.wires().length, sent + 1);
  const cold = f.open(), done = history(cold);
  assert.throws(() => prepareVariantSession(cold, first), code('discovery_variant_decision_exists'));
  assert.deepEqual(history(cold), done); assert.equal(f.wires().length, sent + 1);
});

test('4B.2: a mode race at physical reservation sends and pays nothing; a fresh cold admission recovers from the stale prepared intent', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions)); f.reply(choose('v1'));
  const input = f.decisionInput(reference(bypass)); prepareVariantSession(f.store, input);
  const other = f.open(), write = f.store.writeMany.bind(f.store), sent = f.wires().length, money = accounting(f.store);
  let changed: Ref | null = null, afterMove: ReturnType<typeof history> = [];
  f.store.writeMany = ((writes, guards) => {
    if (!changed && writes.some(row => row.kind === 'model-call' && (row.value as any).purpose === 'variant-decision')) {
      const sessions = new ProjectModeSessions(other), scope = { project: f.project, mode: 'questions' as const, previous: reference(bypass) };
      const invite = ok<any>(issueProjectModeInvitation(other, scope)), login = ok<any>(sessions.exchange({ project: f.project, invitation: invite.invitation }));
      changed = reference(setProjectMode(other, scope, sessions.authority(login.bearer)).record); afterMove = history(other);
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  try { await assert.rejects(() => runVariantSession(f.store, input), code('input_stale')); }
  finally { f.store.writeMany = write; }
  assert.ok(changed); assert.deepEqual(history(f.store), afterMove); assert.deepEqual(accounting(f.store), money); assert.equal(f.wires().length, sent);
  const latest = f.setMode('bypass', changed!), cold = f.open();
  const receipt = await runVariantSession(cold, f.decisionInput(reference(latest)));
  assert.equal(receipt.value.cursor, 1); assert.equal(f.wires().length, sent + 1, 'the unpaid stale preparation does not trap the set');
  assert.equal(cold.list('discovery-variant-model-decision').length, 1);
});

test('4B.2: a newer paid generation after decision payment keeps its current state and a cold stale decision reason', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions)); f.reply(choose('v1'));
  const input = f.decisionInput(reference(bypass)), running = await f.pay(input);
  f.reply(generation);
  await runVariantSession(f.store, { projectId: f.project, environment: f.environment, role: f.environment.value.reviewer,
    prompt: 'A new generation from the same real sweep', variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal',
      snapshot: reference(f.saved), mode: reference(bypass), expectedSelection: reference(f.state1) } });
  const state = f.store.get<VariantState>(f.state1.id)!, money = accounting(f.store), sent = f.wires().length;
  assert.notDeepEqual(state.value.set, reference(f.set!));
  const receipt = applyVariantSession(f.store, f.project, reference(running)), cold = f.open();
  const decision = cold.list('discovery-variant-model-decision')[0]!, proved = readVariantModelDecision(cold, f.project, reference(decision));
  assert.equal(proved.state, null); assert.deepEqual(proved.stale, { code: 'discovery_variant_stale', reason: 'mode_or_selection_changed' });
  assert.deepEqual(reference(cold.get(state.id)!), reference(state)); assert.deepEqual(accounting(cold), money);
  const before = history(cold); assert.deepEqual(await runVariantSession(cold, input), receipt);
  assert.deepEqual(history(cold), before); assert.equal(f.wires().length, sent);
});

test('4B.2: the common application rejects every incomplete product and supplies its own mode guard; paid recovery is free after a race', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions)); f.reply(choose('v1'));
  const running = await f.pay(f.decisionInput(reference(bypass))), paid = readResearchConsumerExecution(f.store, f.project, reference(running));
  assert.equal(paid.kind, 'response'); if (paid.kind !== 'response') throw new Error('Expected real paid decision');
  const owner = f.store.get<any>(running.value.owner.id, running.value.owner.revision)!;
  const value = projectPaidVariantSession(owner, running, { call: reference(paid.call), response: paid.response, payload: paid.payload });
  const product = variantDecisionPublicationWrites(f.store, value, paid.payload);
  const receipt = { id: owner.id, kind: owner.kind, expected: owner.revision, value };
  const complete = [receipt, ...product.writes], before = history(f.store), sent = f.wires().length, money = accounting(f.store);
  for (const writes of [[receipt], [receipt, product.writes[0]!], [receipt, product.writes[1]!],
    [receipt, { ...product.writes[0]!, value: { ...product.decision.value, outcome: { kind: 'reject_all', reason: 'Substituted result' } } }, product.writes[1]!],
    [...complete, { id: 'negative-extra-output', kind: 'extra-output', expected: 0, value: {} }]])
    assert.throws(() => prepareResearchConsumerApplication(f.store, reference(running), reference(paid.call), writes, [reference(owner)]), error => error instanceof EngineError);
  assert.deepEqual(history(f.store), before);
  const batch = prepareResearchConsumerApplication(f.store, reference(running), reference(paid.call), complete, [reference(owner)]);
  assert.ok(batch.guards.some(guard => hashJson(guard) === hashJson(reference(bypass))));
  assert.ok(batch.guards.some(guard => hashJson(guard) === hashJson(reference(f.set!))));
  f.setMode('questions', reference(bypass)); const afterMove = history(f.store);
  assert.throws(() => f.store.writeMany(batch.writes, batch.guards), code('input_stale'));
  assert.deepEqual(history(f.store), afterMove); assert.deepEqual(accounting(f.store), money); assert.equal(f.wires().length, sent);
  applyVariantSession(f.open(), f.project, reference(running));
  assert.equal(readVariantModelDecision(f.open(), f.project, product.decision.ref).state, null);
  assert.deepEqual(accounting(f.store), money); assert.equal(f.wires().length, sent);
});

test('4B.2: the historical reader proves every named output in full in warm and cold Stores', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions)); f.reply(choose('v1'));
  const receipt = await runVariantSession(f.store, f.decisionInput(reference(bypass)));
  const decision = f.store.list('discovery-variant-model-decision')[0]!, state = f.store.get(f.state1.id)!, before = history(f.store);
  for (const store of [f.store, f.open()]) {
    const get = store.get.bind(store);
    for (const target of [reference(receipt), reference(decision), reference(state)]) for (const corruption of ['missing', 'kind', 'value']) {
      store.get = ((id, revision) => {
        const row = get(id, revision);
        if (id !== target.id || revision !== target.revision || !row) return row;
        return corruption === 'missing' ? null : { ...row, ...(corruption === 'kind' ? { kind: 'negative-lookalike' } : { value: { ...row.value as any, reason: 'Negative substitution' } }) };
      }) as typeof store.get;
      try { assert.throws(() => readVariantModelDecision(store, f.project, reference(decision)), error => error instanceof EngineError); }
      finally { store.get = get; }
    }
    assert.equal(readVariantModelDecision(store, f.project, reference(decision)).stale, null);
  }
  assert.deepEqual(history(f.store), before);
});
