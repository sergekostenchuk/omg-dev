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
import { prepareResearchConsumerIntent, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { prepareVariantSession, applyVariantSession, runVariantSession, readVariantModelDecision, readVariantExecutionSession,
  type VariantSessionInput } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, variantRecordId, type VariantSubject, type VariantSet, type DiscoveryVariant } from '../src/discovery/discovery-variants.js';
import { variantStateId, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
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
