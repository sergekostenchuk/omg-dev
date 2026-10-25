import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson } from '../src/canonical.js';
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
import { prepareVariantSession, applyVariantSession, runVariantSession, readVariantModelDecision, type VariantSessionInput } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, variantRecordId, VARIANT_OWNER_ACTION, type VariantModelDecision, type VariantState, type VariantChoiceScope } from '../src/discovery/variant-decision.js';
import { ProjectModeSessions, issueProjectModeInvitation, issueVariantChoiceInvitation, VariantChoiceSessions } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { stageSummary, renderStageSummary, type VariantChoiceSummaryRequest, type VariantChoiceStageSummary } from '../src/product/stage-summary.js';
import type { VariantChoiceActSummary } from '../src/discovery/projection-reader.js';
import type { OmResult } from '../src/om/refusal.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const code = (expected?: string) => (error: unknown) => error instanceof EngineError && (!expected || error.code === expected);
const ok = <T>(result: OmResult<T>): T => { assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code); return (result as {ok:true;value:T}).value; };
const judgement = { conclusion: 'Bounded by the paid sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the sweep'], quantity: null };
const generation = { action: 'variants', variants: [1, 2].map(i => ({ key: `v${i}`, title: `Variant ${i}`, proposal: { scope: `scope-${i}` },
  criteria: Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement])) })),
  scale: Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'One shared scale'])), comparison: 'Two bounded variants',
  recommendation: { key: 'v2', reason: 'Generation recommends the wider one' }, searchLimits: ['Only the saved sweep'], unknowns: ['Demand remains unknown'] };
const choose = (key: string) => ({ action: 'choose', key, reason: `The model chooses ${key}` });

// Real paid K/P -> snapshot -> paid generation; the accepted B.2 fixture retains only transport calibrations as fixtures.
async function setup(t: test.TestContext, answer: unknown = generation) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-4r3-choice-' }), project = 'p';
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
    const sessions = new ProjectModeSessions(f.store), invite = ok(issueProjectModeInvitation(f.store, { project, mode, previous }));
    const login = ok(sessions.exchange({ project, invitation: invite.invitation }));
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

const request = (decision: Ref): VariantChoiceSummaryRequest => ({ section: 'variant-choice', decision });
const summaryAt = (store: Store, decision: Ref) => stageSummary(store, 'p', 'discovery', request(decision));
const mint = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const login = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...login, authority: sessions.authority(login.bearer)! };
};
const scopeOf = (f: Awaited<ReturnType<typeof setup>>): VariantChoiceScope => ({
  action: VARIANT_OWNER_ACTION, projectId: 'p', draft: f.draft, set: reference(f.set!), mode: reference(f.questions),
  expectedSelection: reference(f.state1), previous: null, operation: 'initial',
  outcome: { kind: 'choose', member: f.set!.value.members[0]!, reason: 'Owner selects the bounded first member' }
});
function assertReadOnly(f: Awaited<ReturnType<typeof setup>>, ref: Ref, expected: VariantChoiceStageSummary) {
  const cold = new Store(f.store.path);
  try {
    const before = history(f.store), wires = f.wires(), text = renderStageSummary(expected);
    for (const store of [f.store, cold]) {
      assert.deepEqual(summaryAt(store, ref), expected);
      assert.equal(renderStageSummary(summaryAt(store, ref)), text);
      assert.deepEqual(history(store), before, 'every primary revision, model-call and ledger remains unchanged');
      assert.deepEqual(f.wires(), wires, 'reading and rendering send nothing');
    }
  } finally { cold.close(); }
}
for (const kind of ['choose', 'reject_all'] as const) test(`4R.3 choice: actual paid model ${kind}, exact authors/member/application and independent generation request`, async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  f.reply(kind === 'choose' ? choose('v1') : { action: 'reject_all', reason: 'Paid rejection of the whole set' });
  await runVariantSession(f.store, f.decisionInput(reference(bypass), reference(f.state1), f.environment.value.reviewer));
  const record = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!, ref = reference(record);
  const summary = summaryAt(f.store, ref), c = summary.choice;
  assert.equal(summary.contract, 'stage-summary/variant-choice/v1');
  assert.deepEqual([c.verification, c.decision, c.draft, c.set, c.mode, c.expectedSelection, c.previous],
    ['proven', ref, f.draft, reference(f.set!), reference(bypass), reference(f.state1), null]);
  assert.equal(c.author.kind, 'model');
  if (c.author.kind !== 'model') throw new Error('Expected model');
  assert.equal(c.author.actor, f.environment.value.reviewer.actor);
  assert.deepEqual([c.author.intent, c.author.call, c.author.response], [record.value.origin.intent, record.value.origin.call, record.value.origin.response]);
  assert.equal(c.generation.author.actor, f.environment.value.implementer.actor);
  assert.notDeepEqual(c.author.session, c.generation.author.session);
  assert.deepEqual(c.generation.result, reference(f.set!)); assert.deepEqual(c.generation.snapshot, reference(f.saved));
  assert.deepEqual(c.generation.recommendation, f.set!.value.recommendation);
  assert.deepEqual([c.generation.searchLimits, c.generation.unknowns], [generation.searchLimits, generation.unknowns]);
  assert.deepEqual(c.application, { status: 'applied', state: readVariantModelDecision(f.store, 'p', ref).state });
  assert.equal(c.outcome.kind, kind); assert.equal(c.outcome.reason, record.value.outcome.reason);
  if (c.outcome.kind === 'choose') {
    assert.deepEqual(c.outcome.member, f.set!.value.members[0]);
    assert.deepEqual(c.outcome.variant, f.store.get(c.outcome.member.id, c.outcome.member.revision)!.value);
    assert.notDeepEqual(c.outcome.member, c.generation.recommendation.member);
  } else assert.equal(Object.hasOwn(c.outcome, 'member'), false);
  const text = renderStageSummary(summary);
  for (const part of ['Автор генерации (модель)', 'Автор выбора (модель)', ref.hash, record.value.outcome.reason, kind,
    generation.searchLimits[0]!, generation.unknowns[0]!]) assert.ok(text.includes(part), part);
  assert.equal(text.includes('Вопрос:'), false);
  const generationOnly = stageSummary(f.store, 'p', 'discovery', { section: 'variant-generation', result: reference(f.set!) });
  assert.deepEqual(generationOnly.generation.choice, { status: 'incomplete', reason: 'variant_decisions_unsupported' });
  assertReadOnly(f, ref, summary);
});

for (const firstKind of ['choose', 'reject_all'] as const) test(`4R.3 choice: authorized initial ${firstKind} -> revise -> revise, exact previous and cold history after revoke/expiry/mode change`, async t => {
  const f = await setup(t), initial = scopeOf(f);
  if (firstKind === 'reject_all') initial.outcome = { kind: 'reject_all', reason: 'Owner initially rejects the set' };
  const login = mint(f.store, initial), first = answerVariantChoice(f.store, initial, login.authority);
  const revise: VariantChoiceScope = { ...scopeOf(f), operation: 'revise', previous: reference(first.decision), expectedSelection: reference(first.state) };
  const second = answerVariantChoice(f.store, revise, mint(f.store, revise).authority);
  const lastScope: VariantChoiceScope = { ...revise, previous: reference(second.decision), expectedSelection: reference(second.state),
    outcome: { kind: 'reject_all', reason: 'Owner revised and rejected the set' } };
  const last = answerVariantChoice(f.store, lastScope, mint(f.store, lastScope).authority);
  const summary = summaryAt(f.store, reference(last.decision));
  let act: VariantChoiceActSummary | null = summary.choice;
  for (const [saved, operation] of [[last, 'revise'], [second, 'revise'], [first, 'initial']] as const) {
    assert.ok(act); assert.deepEqual(act.decision, reference(saved.decision));
    assert.deepEqual(act.application, { status: 'applied', state: reference(saved.state) });
    assert.deepEqual(act.author, { kind: 'owner', authority: 'local-owner-authority', operation,
      grant: saved.decision.value.authority.grant, session: saved.decision.value.authority.session });
    assert.equal(act.outcome.kind, saved.decision.value.outcome.kind); assert.equal(act.outcome.reason, saved.decision.value.outcome.reason);
    act = act.previous;
  }
  assert.equal(act, null);
  const firstSummary = summaryAt(f.store, reference(first.decision));
  ok(login.sessions.revoke(login.bearer)); f.setMode('bypass', reference(f.questions));
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 3_600_000);
  assertReadOnly(f, reference(last.decision), summary); assertReadOnly(f, reference(first.decision), firstSummary);
  assert.deepEqual(reference(f.store.get(last.state.id)!), reference(last.state), 'reading the first act never reactivates it');
  const text = renderStageSummary(summary);
  for (const saved of [first, second, last]) assert.ok(text.includes(reference(saved.decision).hash));
  assert.ok(text.includes('Полномочный акт владельца: initial')); assert.ok(text.includes('Полномочный акт владельца: revise'));
  assert.ok(text.includes('Выбор reject_all')); assert.ok(text.includes('Выбор choose'));
});

for (const kind of ['choose', 'reject_all'] as const) test(`4R.3 choice: real model -> owner override ${kind} -> revise exposes every exact previous actor`, async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  f.reply(kind === 'choose' ? { action: 'reject_all', reason: 'Model rejected' } : choose('v1'));
  await runVariantSession(f.store, f.decisionInput(reference(bypass)));
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  const scope: VariantChoiceScope = { ...scopeOf(f), operation: 'override', previous: reference(model), mode: reference(bypass),
    expectedSelection: readVariantModelDecision(f.store, 'p', reference(model)).state!,
    outcome: kind === 'choose' ? scopeOf(f).outcome : { kind: 'reject_all', reason: 'Owner overrides the model' } };
  const login = mint(f.store, scope), override = answerVariantChoice(f.store, scope, login.authority);
  const revise: VariantChoiceScope = { ...scope, operation: 'revise', previous: reference(override.decision), expectedSelection: reference(override.state),
    outcome: kind === 'choose' ? { kind: 'reject_all', reason: 'Owner revises override' } : scopeOf(f).outcome };
  const last = answerVariantChoice(f.store, revise, mint(f.store, revise).authority);
  const expected = summaryAt(f.store, reference(last.decision)), c = expected.choice;
  assert.deepEqual(c.previous!.decision, reference(override.decision)); assert.deepEqual(c.previous!.previous!.decision, reference(model));
  assert.deepEqual([c.author.kind, c.previous!.author.kind, c.previous!.previous!.author.kind], ['owner', 'owner', 'model']);
  assert.equal(c.previous!.previous!.previous, null);
  assert.equal(c.previous!.outcome.kind, kind);
  ok(login.sessions.revoke(login.bearer)); f.setMode('questions', reference(bypass));
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 3_600_000);
  assertReadOnly(f, reference(last.decision), expected);
  const text = renderStageSummary(expected);
  for (const part of ['Полномочный акт владельца: override', 'Полномочный акт владельца: revise', 'Автор выбора (модель)', reference(model).hash]) assert.ok(text.includes(part));
});

for (const kind of ['choose', 'reject_all'] as const) test(`4R.3 choice: paid stale model ${kind} has no historical application and never borrows today's owner state`, async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions));
  f.reply(kind === 'choose' ? choose('v1') : { action: 'reject_all', reason: 'Stale paid rejection' });
  const running = await f.pay(f.decisionInput(reference(bypass)));
  const questions = f.setMode('questions', reference(bypass)), scope = { ...scopeOf(f), mode: reference(questions) };
  const owner = answerVariantChoice(f.store, scope, mint(f.store, scope).authority);
  applyVariantSession(f.store, 'p', reference(running));
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  const summary = summaryAt(f.store, reference(model)), c = summary.choice;
  assert.deepEqual(c.application, { status: 'not_applied', state: null, stale: { code: 'discovery_variant_stale', reason: 'mode_or_selection_changed' } });
  assert.deepEqual(c.mode, reference(bypass)); assert.deepEqual(c.expectedSelection, reference(f.state1));
  assert.equal(c.outcome.kind, kind); assert.equal(c.previous, null);
  const text = renderStageSummary(summary); assert.ok(text.includes('Оплаченный результат без применения к текущему выбору'));
  assert.ok(text.includes('mode_or_selection_changed')); assert.equal(text.includes(reference(owner.state).hash), false);
  assertReadOnly(f, reference(model), summary); assert.deepEqual(reference(f.store.get(owner.state.id)!), reference(owner.state));
});


test('4R.3 choice: absent/incomplete input, wrong discriminator and extra selectors refuse without substituting a current decision', async t => {
  const f = await setup(t), scope = scopeOf(f), act = answerVariantChoice(f.store, scope, mint(f.store, scope).authority), ref = reference(act.decision);
  const invalid: unknown[] = [null, {}, { decision: ref }, { section: 'variant-choice' }, { section: 'variant-choice', decision: null },
    { section: 'variant-choice', decision: ref.id }, { section: 'variant-choice', decision: { id: ref.id, revision: ref.revision } },
    { section: 'variant-choice', decision: { ...ref, revision: 0 } }, { section: 'variant-choice', decision: { ...ref, hash: '' } },
    { section: 'variant-unknown', decision: ref }, { section: 'variant-choice', result: ref },
    { ...request(ref), actor: 'owner' }, { ...request(ref), draftId: f.draft.id }, { ...request(ref), ready: true },
    Object.assign(Object.create({ section: 'variant-choice' }), { decision: ref })];
  for (const key of Object.keys(ref)) { const partial = { ...ref } as Record<string, unknown>; delete partial[key]; invalid.push(request(partial as unknown as Ref)); }
  const before = history(f.store), sent = f.wires();
  for (const store of [f.store, f.open()]) {
    for (const value of invalid) assert.throws(() => stageSummary(store, 'p', 'discovery', value as VariantChoiceSummaryRequest), code());
    assert.throws(() => stageSummary(store, 'p', 'concept' as 'discovery', request(ref)), code('stage_summary_variant_request_invalid'));
    assert.throws(() => stageSummary(store, 'foreign', 'discovery', request(ref)), code());
    assert.deepEqual(history(store), before); assert.deepEqual(f.wires(), sent);
  }
});

test('4R.3 choice: structural model/owner lookalikes, foreign set/member/draft/mode and missing previous never acquire proof', async t => {
  const f = await setup(t), bypass = f.setMode('bypass', reference(f.questions)); f.reply(choose('v1'));
  await runVariantSession(f.store, f.decisionInput(reference(bypass)));
  const real = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  const override: VariantChoiceScope = { ...scopeOf(f), operation: 'override', mode: reference(bypass), previous: reference(real),
    expectedSelection: readVariantModelDecision(f.store, 'p', reference(real)).state! };
  const owner = answerVariantChoice(f.store, override, mint(f.store, override).authority);
  const fakeRefs: Ref[] = [reference(f.set!), reference(f.saved), reference(f.state1)];
  // These are explicitly forged inputs. Only the genuine producers above are positive proof.
  for (const saved of [real, owner.decision]) {
    const base = saved.value as unknown as Record<string, unknown>;
    const changes: Record<string, unknown>[] = [{ projectId: 'foreign' }, { set: reference(f.saved) }, { draft: reference(f.set!) },
      { mode: reference(f.set!) }, { previous: { ...reference(real), hash: '0'.repeat(64) } },
      { outcome: { kind: 'choose', member: reference(f.saved), reason: 'Forged foreign member' } },
      { outcome: { kind: 'reject_all', reason: 'Unpaid structural rejection' } }, { contract: 'unknown/variant-decision' }];
    const values = changes.map(change => ({ ...base, ...change }));
    for (const key of Object.keys(base)) { const missing = { ...base }; delete missing[key]; values.push(missing); }
    for (const value of values) {
      const row = f.store.write({ id: variantRecordId(saved.kind, value as { projectId: string }), kind: saved.kind, expected: 0, value });
      fakeRefs.push(reference(row));
    }
  }
  const unknown = f.store.write({ id: 'unknown-choice-discriminator', kind: 'discovery-variant-decision-unknown', expected: 0, value: real.value });
  fakeRefs.push(reference(unknown), { ...reference(real), hash: 'f'.repeat(64) });
  const before = history(f.store), sent = f.wires();
  for (const store of [f.store, f.open()]) {
    for (const ref of fakeRefs) assert.throws(() => summaryAt(store, ref), code());
    assert.deepEqual(history(store), before); assert.deepEqual(f.wires(), sent);
    assert.deepEqual(summaryAt(store, reference(real)).choice.decision, reference(real));
  }
});
