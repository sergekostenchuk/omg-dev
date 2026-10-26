import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision, type Write, type TransactionGuard } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession, prepareVariantSession, applyVariantSession, readVariantModelDecision,
  type VariantSessionInput } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, VARIANT_SCOPE_CONTRACT, variantRecordId,
  type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_DECISION_CONTRACT, VARIANT_OWNER_ACTION,
  type VariantChoiceScope, type VariantOwnerDecision, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope, readVariantScope, readCurrentVariantScope, VARIANT_SCOPE_KIND } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';

// 4P.1 (codex-omg №11896 п.1): the selected variant scope links the exact project/draft/set/member/decision/mode with
// the variant a REAL choose selected — an owner act through its proven authority or a paid bypass model decision over
// the proven paid set. The producer mints the scope of the current proven choice only; the evidential reader keeps old
// scopes provable after later choices without reactivating them; reject_all, no_variants and a stale paid model result
// select nothing; a requiring path without a published scope receives the typed refusal.
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
/** Intercepts this Store's writes on the prototype, leaving the instance itself untouched (an own property would make it
 * an opaque source for the rest of the test); the returned restore is idempotent. */
function onWrites(store: Store, wrap: (writes: Write[], guards: TransactionGuard[] | undefined, write: () => Revision<unknown>[]) => Revision<unknown>[]) {
  const previous = Store.prototype.writeMany;
  Store.prototype.writeMany = function (this: Store, writes: Write[], guards?: TransactionGuard[]) {
    return this === store ? wrap(writes, guards, () => previous.call(this, writes, guards)) : previous.call(this, writes, guards);
  } as typeof previous;
  let done = false;
  return () => { if (!done) { done = true; Store.prototype.writeMany = previous; } };
}
const refuses = (invoke: () => unknown, expected?: string) => assert.throws(invoke, (error: unknown) =>
  error instanceof EngineError && (!expected || error.code === expected));
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
}
const judgement = { conclusion: 'Bounded by the paid sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the saved sweep'], quantity: null };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'Same shared scale']));
const generation = () => ({ action: 'variants', variants: [1, 2].map(i => ({ key: `v${i}`, title: `Variant ${i}`, proposal: { scope: `scope-${i}` }, criteria })),
  scale, comparison: 'Two bounded variants on one scale', recommendation: { key: 'v2', reason: 'The generation recommends the wider one' },
  searchLimits: ['Only the saved sweep'], unknowns: [] });
const none = (grounds: Ref[]) => ({ action: 'no_variants', reasons: [{ code: 'snapshot_insufficient', message: 'No bounded variant', grounds }],
  searchLimits: ['Only the saved sweep'], unknowns: [] });

/** The real paid line of 4B.1/4O.2: two assessed plan questions, the variant snapshot, real project modes and the real
 * paid generation of a two-member set with its first state. */
async function paid(t: test.TestContext, answer: unknown = generation()) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-4p1-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Selected variant scope' });
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const old = runs.get(selected.planAnswer.hash), run = old ? f.store.get<ResearchRun>(old)! : f.store.write<ResearchRun>({
      id: `research-run:${rand()}`, kind: 'research-run', expected: 0, value: { projectId: project, draftId: draft.id, environment: reference(f.environment),
        turns: 0, limit: 100, requestChars: 0, owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run), draft: reference(draft), question: reference(question),
      role: f.environment.value.implementer, dispatch: f.environment.value, profile: null, cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input), invoke = () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const entry = await produce(g, undefined, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
      methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
    const assessment = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
    applyDiscoveryAssessment(f.store, project, reference(assessment));
  }
  const saved = produceVariantSnapshot(f.store, project).record;
  const modeSessions = new ProjectModeSessions(f.store), invite = ok(issueProjectModeInvitation(f.store, { project, mode: 'questions', previous: null }));
  const exchanged = ok(modeSessions.exchange({ project, invitation: invite.invitation }));
  const questions = setProjectMode(f.store, { project, mode: 'questions', previous: null }, modeSessions.authority(exchanged.bearer)).record;
  ok(modeSessions.revoke(exchanged.bearer));
  const reply = (value: unknown) => writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: value }));
  const subject: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(saved), mode: reference(questions), expectedSelection: null };
  // Transport-only service calibration; the positive producer below uses the real snapshot.
  const calibration = f.store.write({ id: 'transport-fixture:scope-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer]) {
    reply(generation());
    await researchCall(role, f.environment.value, 'Calibrate generation', { variantSubject: { ...subject, snapshot: reference(calibration) }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  }
  reply(answer);
  await runVariantSession(f.store, { projectId: project, environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Propose variants from this exact paid sweep', variantSubject: subject });
  const found = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === project) ?? null;
  if (!found) {
    const noneDraft = reference(f.store.get<DiscoveryDraft>(f.v.draft.id)!);
    return { ...g, project, saved, questions, reply, set: null, draft: noneDraft,
      state1: f.store.get<VariantState>(variantStateId(project, noneDraft.id))!, scope: null };
  }
  const set = found, draft = set.value.draft, state1 = f.store.get<VariantState>(variantStateId(project, draft.id))!;
  const scope: VariantChoiceScope = { action: VARIANT_OWNER_ACTION, projectId: project, draft, set: reference(set), mode: reference(questions),
    operation: 'initial', previous: null, expectedSelection: reference(state1), outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'The exact paid set fits the owner goal' } };
  return { ...g, project, saved, questions, reply, set, draft, state1, scope };
}

const mint = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const exchanged = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...exchanged, authority: sessions.authority(exchanged.bearer)! };
};
const modeOf = (store: Store, mode: 'questions' | 'bypass') => {
  const previous = store.get('project-mode:p'), scope = { project: 'p', mode, previous: previous ? reference(previous) : null };
  const sessions = new ProjectModeSessions(store), issued = ok(issueProjectModeInvitation(store, scope));
  const login = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  return setProjectMode(store, scope, sessions.authority(login.bearer)).record;
};
const revised = (scope: VariantChoiceScope, act: ReturnType<typeof answerVariantChoice>, kind: 'choose' | 'reject_all'): VariantChoiceScope => ({
  ...scope, operation: 'revise', previous: reference(act.decision), expectedSelection: reference(act.state),
  outcome: kind === 'choose' ? { kind, member: scope.outcome.kind === 'choose' ? scope.outcome.member : scope.set, reason: 'Owner revised the exact choice' }
    : { kind, reason: 'Owner rejects this exact set' } });
/** The real paid bypass model decision over the current set, choose or reject_all. */
async function modelChoose(f: Awaited<ReturnType<typeof paid>>, outcome: 'choose' | 'reject_all' = 'choose') {
  const mode = modeOf(f.store, 'bypass');
  f.reply(outcome === 'choose' ? { action: 'choose', key: 'v1', reason: 'Real paid model choice' } : { action: 'reject_all', reason: 'Real paid model rejection' });
  const calibration = reference(f.store.write({ id: 'transport-fixture:scope-decision-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT,
      kind: 'decision', set: calibration, mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
  const input: VariantSessionInput = { projectId: 'p', environment: f.environment, role: f.environment.value.implementer, prompt: 'Choose from the exact paid set',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: reference(f.set!), mode: reference(mode), expectedSelection: reference(f.store.get(variantStateId('p', f.scope!.draft.id))!) } };
  await runVariantSession(f.store, input);
  return f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === 'p')!;
}

test('4P.1: the owner initial choose mints the exact scope of the current proven choice, and its cold repeat returns the same Ref writing and paying nothing', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const act = answerVariantChoice(f.store, f.scope!, m.authority);
  const published = publishVariantScope(f.store, f.project, reference(act.decision));
  assert.equal(published.repeated, false);
  const [chosen] = f.set!.value.members;
  assert.deepEqual(published.scope.value, { contract: VARIANT_SCOPE_CONTRACT, projectId: 'p', draft: f.scope!.draft,
    set: reference(f.set!), member: chosen!, decision: reference(act.decision), mode: f.scope!.mode });
  assert.equal(published.scope.id, variantRecordId(VARIANT_SCOPE_KIND, published.scope.value));
  assert.ok(published.scope.id.startsWith('discovery-variant-scope:p:'), 'the 5.2-F address prefix');
  const proven = readVariantScope(f.store, 'p', reference(published.scope));
  assert.deepEqual([proven.verification, proven.choice.kind, proven.generation.verification], ['proven', 'owner', 'proven']);
  assert.deepEqual(proven.choice.ref, reference(act.decision));
  const current = readCurrentVariantScope(f.store, 'p', f.scope!.draft);
  assert.deepEqual(current.scope, published.scope); assert.deepEqual(current.state, act.state);
  const cold = new Store(f.store.path); t.after(() => cold.close());
  const before = history(cold), sent = f.wires().length;
  const repeat = publishVariantScope(cold, 'p', reference(act.decision));
  assert.equal(repeat.repeated, true); assert.deepEqual(reference(repeat.scope), reference(published.scope));
  assert.deepEqual(history(cold), before, 'the cold repeat writes nothing'); assert.equal(f.wires().length, sent, 'and pays nothing');
});

test('4P.1: the paid bypass model choose mints the scope of the chosen member, not the recommendation', async t => {
  const f = await paid(t), model = await modelChoose(f);
  const published = publishVariantScope(f.store, 'p', reference(model));
  const [v1, v2] = f.set!.value.members;
  assert.deepEqual(published.scope.value.member, v1!, 'the model chose v1 while the generation recommended v2');
  assert.notDeepEqual(published.scope.value.member, v2!);
  const proven = readVariantScope(f.store, 'p', reference(published.scope));
  assert.deepEqual([proven.verification, proven.choice.kind], ['proven', 'model']);
  assert.ok(proven.choice.state, 'the applied model decision kept its admitted state');
  assert.deepEqual(readCurrentVariantScope(f.store, 'p', f.scope!.draft).scope, published.scope);
  const before = history(f.store), accounting = money(f.store), sent = f.wires().length;
  const repeat = publishVariantScope(f.store, 'p', reference(model));
  assert.equal(repeat.repeated, true); assert.deepEqual(reference(repeat.scope), reference(published.scope));
  assert.deepEqual(history(f.store), before); assert.deepEqual(money(f.store), accounting); assert.equal(f.wires().length, sent);
});

test('4P.1: reject_all and no_variants select no variant and mint no scope; the requiring path gets the typed refusal', async t => {
  const f = await paid(t);
  const rejection: VariantChoiceScope = { ...f.scope!, outcome: { kind: 'reject_all', reason: 'Owner rejects this exact set' } };
  const refused = answerVariantChoice(f.store, rejection, mint(f.store, rejection).authority);
  const before = history(f.store);
  refuses(() => publishVariantScope(f.store, 'p', reference(refused.decision)), 'discovery_variant_scope_required');
  refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_required');
  assert.deepEqual(history(f.store), before);
  assert.equal(f.store.list(VARIANT_SCOPE_KIND).length, 0);
  // A decided set buys no second decision: the model reject happens on its own fresh paid line.
  const g = await paid(t), model = await modelChoose(g, 'reject_all');
  refuses(() => publishVariantScope(g.store, 'p', reference(model)), 'discovery_variant_scope_required');
  assert.equal(g.store.list(VARIANT_SCOPE_KIND).length, 0);
  const n = await paid(t, none([reference(f.saved)]));
  refuses(() => readCurrentVariantScope(n.store, 'p', n.draft), 'discovery_variant_scope_required');
  assert.equal(n.store.list(VARIANT_SCOPE_KIND).length, 0);
});

test('4P.1: a paid model result published after its mode moved selects nothing now — no state, no scope, typed stale', async t => {
  const f = await paid(t), mode = modeOf(f.store, 'bypass');
  f.reply({ action: 'choose', key: 'v1', reason: 'Real paid model choice' });
  const calibration = reference(f.store.write({ id: 'transport-fixture:scope-stale-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT,
      kind: 'decision', set: calibration, mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
  const input: VariantSessionInput = { projectId: 'p', environment: f.environment, role: f.environment.value.implementer, prompt: 'Choose from the exact paid set',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: reference(f.set!), mode: reference(mode), expectedSelection: reference(f.state1) } };
  const prepared = prepareVariantSession(f.store, input), v = prepared.intent.value;
  await researchCall(v.role, v.dispatch, v.cursor.prompt, v.cursor.context, undefined,
    { store: f.store, draftId: v.draft.id, questionId: v.question.id, purpose: v.kind, consumerIntent: reference(prepared.intent), session: v.owner });
  modeOf(f.store, 'questions');
  applyVariantSession(f.store, 'p', reference(f.store.get(prepared.intent.id)!));
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === 'p')!;
  const proven = readVariantModelDecision(f.store, 'p', reference(model));
  assert.equal(proven.state, null, 'the paid result was published stale');
  const before = history(f.store);
  refuses(() => publishVariantScope(f.store, 'p', reference(model)), 'discovery_variant_stale');
  refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_required');
  assert.deepEqual(history(f.store), before);
  assert.equal(f.store.list(VARIANT_SCOPE_KIND).length, 0);
});

test('4P.1: a later choice keeps the old scope historically proven, never reactivates it, and the current reader follows the current choice', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const first = answerVariantChoice(f.store, f.scope!, m.authority);
  const scope1 = publishVariantScope(f.store, 'p', reference(first.decision)).scope;
  // The owner revises onto the other member: the current choice is the new decision with its own scope.
  const other: VariantChoiceScope = { ...revised(f.scope!, first, 'choose'), outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'Owner revises onto the second member' } };
  const second = answerVariantChoice(f.store, other, mint(f.store, other).authority);
  const scope2 = publishVariantScope(f.store, 'p', reference(second.decision)).scope;
  assert.notDeepEqual(reference(scope2), reference(scope1));
  assert.deepEqual(readCurrentVariantScope(f.store, 'p', f.scope!.draft).scope, scope2);
  const old = readVariantScope(f.store, 'p', reference(scope1));
  assert.deepEqual([old.verification, old.choice.ref], ['proven', reference(first.decision)]);
  // A moved-off choice is never reactivated: its repeat and its current reading refuse.
  refuses(() => publishVariantScope(f.store, 'p', reference(first.decision)), 'discovery_variant_stale');
  // After a final rejection no current scope exists at all, while both old scopes stay historically proven.
  const rejected = revised(f.scope!, second, 'reject_all');
  const last = answerVariantChoice(f.store, rejected, mint(f.store, rejected).authority);
  refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_required');
  for (const saved of [scope1, scope2])
    assert.deepEqual(readVariantScope(f.store, 'p', reference(saved)).verification, 'proven');
  assert.deepEqual(reference(f.store.get(variantStateId('p', f.scope!.draft.id))!), reference(last.state));
});

test('4P.1: an unpublished current choice is the typed missing-scope refusal of the requiring path', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_required');
  const act = answerVariantChoice(f.store, f.scope!, m.authority);
  refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_required');
  publishVariantScope(f.store, 'p', reference(act.decision));
  assert.deepEqual(readCurrentVariantScope(f.store, 'p', f.scope!.draft).choice.ref, reference(act.decision));
});

test('4P.1: foreign projects, sets, members, decisions and modes never prove a scope', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const act = answerVariantChoice(f.store, f.scope!, m.authority);
  const scope = publishVariantScope(f.store, 'p', reference(act.decision)).scope;
  refuses(() => readVariantScope(f.store, 'foreign', reference(scope)));
  refuses(() => readVariantScope(f.store, 'p', { id: scope.id, revision: 1, hash: '0'.repeat(64) }), 'discovery_variant_basis_invalid');
  const forged = { ...scope.value };
  const bypass = reference(modeOf(f.store, 'bypass'));
  for (const field of ['set', 'member', 'decision', 'mode'] as const) {
    const swap: Record<string, unknown> = { set: f.set!.value.members[1], member: f.set!.value.members[1],
      decision: reference(f.state1), mode: bypass };
    const value = { ...forged, [field]: swap[field] };
    const row = f.store.write({ id: variantRecordId(VARIANT_SCOPE_KIND, value), kind: VARIANT_SCOPE_KIND, expected: 0, value });
    refuses(() => readVariantScope(f.store, 'p', reference(row)));
    refuses(() => publishVariantScope(f.store, 'p', reference(row)));
  }
  assert.equal(f.store.list(VARIANT_SCOPE_KIND).length, 5, 'the real scope plus the four forged ones, none proven');
});

test('4P.1: a structural masquerade — a closed-form scope over an unprovable owner lookalike — proves nothing', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const act = answerVariantChoice(f.store, f.scope!, m.authority);
  publishVariantScope(f.store, 'p', reference(act.decision));
  const invented: Ref = { id: `discovery-choice-session:${rand()}`, revision: 1, hash: '0'.repeat(64) };
  const fake = { contract: VARIANT_OWNER_DECISION_CONTRACT, projectId: 'p', draft: f.scope!.draft, set: reference(f.set!), mode: f.scope!.mode,
    expectedSelection: reference(f.state1), previous: null, operation: 'initial',
    outcome: { kind: 'choose', member: f.set!.value.members[0], reason: 'A lookalike with no real session' },
    authority: { grant: invented, session: invented } };
  const fakeId = variantRecordId('discovery-variant-owner-decision', fake);
  const decision = reference(f.store.write({ id: fakeId, kind: 'discovery-variant-owner-decision', expected: 0, value: fake }));
  const value = { contract: VARIANT_SCOPE_CONTRACT, projectId: 'p', draft: f.scope!.draft, set: reference(f.set!),
    member: f.set!.value.members[0], decision, mode: f.scope!.mode };
  const scope = reference(f.store.write({ id: variantRecordId(VARIANT_SCOPE_KIND, value), kind: VARIANT_SCOPE_KIND, expected: 0, value }));
  const before = history(f.store);
  refuses(() => readVariantScope(f.store, 'p', scope));
  refuses(() => publishVariantScope(f.store, 'p', decision));
  assert.deepEqual(history(f.store), before);
});

test('4P.1: an absent mandatory basis — the paid set, a member, the decision or its state — never proves a scope', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const act = answerVariantChoice(f.store, f.scope!, m.authority);
  const scope = reference(publishVariantScope(f.store, 'p', reference(act.decision)).scope);
  const [member] = f.set!.value.members;
  const get = f.store.get.bind(f.store);
  for (const hidden of [reference(f.set!), member!, reference(act.decision), reference(act.state)]) {
    f.store.get = ((id: string, revision?: number) => id === hidden.id && revision === hidden.revision ? null : get(id, revision)) as typeof f.store.get;
    try {
      refuses(() => readVariantScope(f.store, 'p', scope));
      refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft));
    } finally { delete (f.store as { get?: unknown }).get; }
  }
  assert.deepEqual(readVariantScope(f.store, 'p', scope).verification, 'proven');
});

for (const move of ['selection', 'mode'] as const) test(`4P.1: a second Store moving ${move} before commit aborts the guarded scope write, and the retry stands on the new heads`, async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const act = answerVariantChoice(f.store, f.scope!, m.authority);
  const other = new Store(f.store.path); t.after(() => other.close());
  let intervened = false, afterMove: ReturnType<typeof history> = [];
  const restore = onWrites(f.store, (writes, _guards, write) => {
    if (!intervened && writes.some(row => row.kind === VARIANT_SCOPE_KIND)) {
      intervened = true;
      if (move === 'selection') {
        const rejection: VariantChoiceScope = { ...revised(f.scope!, act, 'reject_all') };
        answerVariantChoice(other, rejection, mint(other, rejection).authority);
      } else modeOf(other, 'bypass');
      afterMove = history(other);
    }
    return write();
  });
  t.after(restore);
  refuses(() => publishVariantScope(f.store, 'p', reference(act.decision)));
  assert.equal(intervened, true);
  assert.deepEqual(history(f.store), afterMove, 'nothing beyond the second Store\'s own move');
  assert.equal(f.store.list(VARIANT_SCOPE_KIND).length, 0, 'the aborted write left no scope');
  restore();
  assert.equal(Object.hasOwn(f.store, 'writeMany'), false);
  if (move === 'selection') {
    const winner = f.store.list<VariantOwnerDecision>('discovery-variant-owner-decision').find(row => row.value.outcome.kind === 'reject_all')!;
    refuses(() => publishVariantScope(f.store, 'p', reference(winner)), 'discovery_variant_scope_required');
    const head = f.store.get<VariantState>(variantStateId('p', f.scope!.draft.id))!;
    const again: VariantChoiceScope = { ...revised(f.scope!, { decision: winner, state: head } as ReturnType<typeof answerVariantChoice>, 'choose'),
      outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'Owner restores a choice after the race' } };
    const restored = answerVariantChoice(f.store, again, mint(f.store, again).authority);
    refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_required');
    publishVariantScope(f.store, 'p', reference(restored.decision));
    assert.deepEqual(readCurrentVariantScope(f.store, 'p', f.scope!.draft).choice.ref, reference(restored.decision));
  } else {
    // The retry re-reads today's heads: the choice is still current, and the scope keeps the decision's own mode.
    const retried = publishVariantScope(f.store, 'p', reference(act.decision));
    assert.equal(retried.repeated, false);
    assert.deepEqual(retried.scope.value.mode, f.scope!.mode, 'the scope names the mode of its decision, not today\'s head');
    assert.deepEqual(readCurrentVariantScope(f.store, 'p', f.scope!.draft).choice.ref, reference(act.decision));
  }
});

test('4P.1: a scope over a real but unadmitted model choose (state=null) proves nothing even historically', async t => {
  const f = await paid(t), mode = modeOf(f.store, 'bypass');
  f.reply({ action: 'choose', key: 'v1', reason: 'Real paid model choice' });
  const calibration = reference(f.store.write({ id: 'transport-fixture:scope-unadmitted-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT,
      kind: 'decision', set: calibration, mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
  const input: VariantSessionInput = { projectId: 'p', environment: f.environment, role: f.environment.value.implementer, prompt: 'Choose from the exact paid set',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: reference(f.set!), mode: reference(mode), expectedSelection: reference(f.state1) } };
  const prepared = prepareVariantSession(f.store, input), v = prepared.intent.value;
  await researchCall(v.role, v.dispatch, v.cursor.prompt, v.cursor.context, undefined,
    { store: f.store, draftId: v.draft.id, questionId: v.question.id, purpose: v.kind, consumerIntent: reference(prepared.intent), session: v.owner });
  modeOf(f.store, 'questions');
  applyVariantSession(f.store, 'p', reference(f.store.get(prepared.intent.id)!));
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === 'p')!;
  assert.equal(readVariantModelDecision(f.store, 'p', reference(model)).state, null, 'the real stale result kept no admitted state');
  // An explicit negative: a structurally exact scope over the real unadmitted decision, written by hand at its canonical address.
  const value = { contract: VARIANT_SCOPE_CONTRACT, projectId: 'p', draft: model.value.draft, set: model.value.set,
    member: (model.value.outcome as { kind: string; member: Ref }).member, decision: reference(model), mode: model.value.mode };
  const scope = reference(f.store.write({ id: variantRecordId(VARIANT_SCOPE_KIND, value), kind: VARIANT_SCOPE_KIND, expected: 0, value }));
  const before = history(f.store);
  refuses(() => readVariantScope(f.store, 'p', scope), 'discovery_variant_scope_invalid');
  refuses(() => publishVariantScope(f.store, 'p', reference(model)), 'discovery_variant_scope_invalid');
  assert.deepEqual(history(f.store), before, 'the refusals write nothing');
});

test('4P.1: a manufactured state returning the rejected old choice is not the current selection', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const first = answerVariantChoice(f.store, f.scope!, m.authority);
  const scope1 = publishVariantScope(f.store, 'p', reference(first.decision)).scope;
  const rejected = revised(f.scope!, first, 'reject_all');
  const last = answerVariantChoice(f.store, rejected, mint(f.store, rejected).authority);
  const stateId = variantStateId('p', f.scope!.draft.id);
  // An explicit negative: the next state revision copies the first choice while naming the rejection head as previous.
  const forged = { ...last.state.value, decision: reference(first.decision), previous: reference(last.state) };
  f.store.write({ id: stateId, kind: 'discovery-variant-state', expected: last.state.revision, value: forged });
  const before = history(f.store);
  refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_invalid');
  assert.deepEqual(history(f.store), before, 'the refusal writes nothing');
  assert.equal(readVariantScope(f.store, 'p', reference(scope1)).verification, 'proven', 'the lawful old scope stays historically proven');
  refuses(() => readCurrentVariantScope(f.store, 'p', f.scope!.draft), 'discovery_variant_scope_invalid');
});

test('4P.1: the draft argument is matched as the full exact Ref — a foreign hash, a wrong revision and a second real draft revision all refuse', async t => {
  const f = await paid(t), m = mint(f.store, f.scope!);
  const act = answerVariantChoice(f.store, f.scope!, m.authority);
  publishVariantScope(f.store, 'p', reference(act.decision));
  const draft = f.scope!.draft, before = history(f.store);
  refuses(() => readCurrentVariantScope(f.store, 'p', { ...draft, hash: '0'.repeat(64) }), 'discovery_variant_scope_invalid');
  refuses(() => readCurrentVariantScope(f.store, 'p', { ...draft, revision: draft.revision + 7 }), 'discovery_variant_scope_invalid');
  assert.deepEqual(history(f.store), before, 'the refusals write nothing');
  // An explicit negative: a second real revision of the same draft record; the selection still stands on the first.
  const firstDraft = f.store.get(draft.id, draft.revision)!.value as Record<string, unknown>;
  const second = reference(f.store.write({ id: draft.id, kind: 'discovery-draft', expected: draft.revision,
    value: { ...firstDraft, title: 'A second manufactured draft revision' } as never }));
  assert.notEqual(second.revision, draft.revision);
  refuses(() => readCurrentVariantScope(f.store, 'p', second), 'discovery_variant_scope_invalid');
  assert.deepEqual(readCurrentVariantScope(f.store, 'p', draft).choice.ref, reference(act.decision), 'the exact first revision still proves');
});
