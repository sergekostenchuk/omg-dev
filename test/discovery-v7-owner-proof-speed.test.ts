import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { captureView } from '../src/storage/store-view.js';
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
import { runVariantSession } from '../src/discovery/variant-session.js';
import { answerVariantChoice, readVariantOwnerDecision } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { storeUnchanged } from './store-unchanged.js';
import { withHistoricalReads } from '../src/history/proofs.js';

// Real paid generation/selection preparation shared in shape with the accepted 4P.1 scenarios.
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


/** The real paid line of 4B.1/4O.2: two assessed plan questions, the variant snapshot, real project modes and the real
 * paid generation of a two-member set with its first state. */
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial = false) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-64-transport-' }), project = 'p', runs = new Map<string, string>();
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
    const end = withMaterial && question === 'q-industry' ? { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT,
      value: { claims: [{ id: 'broad-rejected', kind: 'hypothesis', text: 'Real pre-choice rejected material', axis: 'industry',
        planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants: 'common' },
        basis: { howToVerify: 'Observe this bounded claim' } }] } } : undefined;
    const entry = await produce(g, end, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: end ? [{ claim: { project, container: entry.attempt, containerKind: 'research-attempt', pointer: '/claims/0', claimId: 'broad-rejected' }, reason: 'Rejected by the real paid assessment' }] : [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
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
  reply(typeof answer === 'function' ? answer(reference(saved)) : answer);
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

type Paid = Awaited<ReturnType<typeof paid>>;
/** The real initial owner choice and its real revise: a decision whose proof needs its exact predecessor decision. */
function owned(f: Paid) {
  const first = answerVariantChoice(f.store, f.scope!, mint(f.store, f.scope!).authority);
  const state = f.store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const scope: VariantChoiceScope = { ...f.scope!, operation: 'revise', previous: reference(first.decision), expectedSelection: reference(state),
    outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'The owner revises the exact chosen member' } };
  const second = answerVariantChoice(f.store, scope, mint(f.store, scope).authority);
  return { first, second, scope };
}
/** Real reads of one exact record id by this Store's own get, during the action. */
function readsOf(t: test.TestContext, store: Store, id: string, action: () => unknown) {
  let count = 0;
  const original = Store.prototype.get, method = t.mock.method(Store.prototype, 'get', function (this: Store, key: string, revision?: number) {
    if (this === store && key === id) count++;
    return original.call(this, key, revision as number);
  } as typeof Store.prototype.get);
  try { action(); } finally { method.mock.restore(); }
  return count;
}
const refuses = (action: () => unknown, code = 'discovery_variant_decision_invalid') =>
  assert.throws(action, (error: unknown) => error instanceof EngineError && error.code === code);

test('owner proof: a repeated exact historical owner read on a genuine Store is kept, copied per entry and cold-equal', async t => {
  const f = await paid(t), { first, second } = owned(f), ref = reference(second.decision);
  const cold = new Store(f.store.path); t.after(() => cold.close());
  const paidBefore = money(f.store);
  const once = readsOf(t, f.store, first.decision.id, () => readVariantOwnerDecision(f.store, 'p', ref));
  assert.ok(once > 0, 'the first proof reads its exact predecessor decision');
  const proof = readVariantOwnerDecision(f.store, 'p', ref);
  const again = readsOf(t, f.store, first.decision.id, () => readVariantOwnerDecision(f.store, 'p', ref));
  assert.equal(again, 0, 'the kept proof is not derived again');
  assert.equal(proof.verification, 'proven'); assert.deepEqual(reference(proof.decision), ref); assert.deepEqual(reference(proof.state), reference(second.state));
  // Each entry receives its own copy across operations.
  const a = readVariantOwnerDecision(f.store, 'p', ref), b = readVariantOwnerDecision(f.store, 'p', ref);
  assert.notEqual(a, b); assert.notEqual(a.decision, b.decision);
  (a.decision.value as any).projectId = 'mutated'; (a.state as any).hash = '0'.repeat(64);
  assert.deepEqual(readVariantOwnerDecision(f.store, 'p', ref), proof);
  // The entry that derives the proof gets its own copy too: changing it cannot reach what the next reader is given.
  const fresh = new Store(f.store.path); t.after(() => fresh.close());
  const derived = readVariantOwnerDecision(fresh, 'p', ref);
  (derived.decision.value as any).projectId = 'mutated'; (derived.session as any).id = 'mutated';
  assert.deepEqual(readVariantOwnerDecision(fresh, 'p', ref), proof);
  // Inside one explicit synchronous region too: the deriving entry and a repeated one each get their own copy.
  const region = new Store(f.store.path); t.after(() => region.close());
  withHistoricalReads(() => {
    const first = readVariantOwnerDecision(region, 'p', ref);
    (first.decision.value as any).projectId = 'mutated'; (first.state as any).hash = '0'.repeat(64);
    const repeated = readVariantOwnerDecision(region, 'p', ref);
    assert.deepEqual(repeated, proof);
    (repeated.grant.value as any).id = 'mutated';
    assert.deepEqual(readVariantOwnerDecision(region, 'p', ref), proof);
  });
  // The cold Store derives the same proof; a historical read writes no record.
  await storeUnchanged(f.store, () => readVariantOwnerDecision(f.store, 'p', ref));
  assert.deepEqual(readVariantOwnerDecision(cold, 'p', ref), proof);
  assert.deepEqual(readVariantOwnerDecision(cold, 'p', reference(first.decision)).decision, first.decision);
  assert.deepEqual(money(f.store), paidBefore);
});

test('owner proof: foreign project, changed hash, a padded Ref, views and a lost predecessor keep their typed refusals and old paths', async t => {
  const f = await paid(t), { first, second } = owned(f), ref = reference(second.decision);
  const proof = readVariantOwnerDecision(f.store, 'p', ref);
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    refuses(() => readVariantOwnerDecision(store, 'foreign', ref));
    refuses(() => readVariantOwnerDecision(store, 'p', { ...ref, hash: '0'.repeat(64) }));
    refuses(() => readVariantOwnerDecision(store, 'p', { ...ref, extra: true } as unknown as Ref));
    refuses(() => readVariantOwnerDecision(store, '', ref));
    refuses(() => readVariantOwnerDecision(store, 'p', reference(f.set!)));
  }
  // A transparent Proxy is not a genuine Store: it derives in place and gives the same proof; a capture view is no Store
  // at all and keeps the reader's typed refusal.
  const passing = new Proxy(f.store, { get(target, key) {
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
  assert.deepEqual(readVariantOwnerDecision(passing, 'p', ref), proof);
  refuses(() => readVariantOwnerDecision(captureView(f.store) as unknown as Store, 'p', ref));
  const lost = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => id === first.decision.id ? null : target.get(id, revision as number);
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  // The predecessor's absence keeps its old typed refusal (the state reader then meets no owner decision).
  assert.throws(() => readVariantOwnerDecision(lost, 'p', ref), (error: unknown) => error instanceof EngineError);
  assert.deepEqual(readVariantOwnerDecision(f.store, 'p', ref), proof);
});

test('owner proof: a kept historical proof authorizes nothing — a new owner act still needs a live session and its current guards', async t => {
  const f = await paid(t), { second, scope } = owned(f), ref = reference(second.decision);
  readVariantOwnerDecision(f.store, 'p', ref); readVariantOwnerDecision(f.store, 'p', ref);
  const state = f.store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const next: VariantChoiceScope = { ...scope, previous: ref, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: f.set!.value.members[0]!, reason: 'A new owner act after the kept proof' } };
  const login = mint(f.store, next);
  ok(login.sessions.revoke(login.bearer));
  const before = f.store.list('discovery-variant-owner-decision').length;
  refuses(() => answerVariantChoice(f.store, next, login.authority), 'owner_session_revoked');
  // A second Store moves the selection: the new act refuses as stale, never borrowing the kept proof.
  const other = new Store(f.store.path); t.after(() => other.close());
  const live = mint(f.store, next);
  const moved: VariantChoiceScope = { ...next, outcome: { kind: 'reject_all', reason: 'A concurrent owner act moves the selection' } };
  answerVariantChoice(other, moved, mint(other, moved).authority);
  assert.throws(() => answerVariantChoice(f.store, next, live.authority), (error: unknown) => error instanceof EngineError);
  assert.equal(f.store.list('discovery-variant-owner-decision').length, before + 1);
  assert.deepEqual(readVariantOwnerDecision(f.store, 'p', ref).decision, second.decision);
});

test('owner proof: a Ref whose accessors change between reads never keeps a proof under another identity', async t => {
  const f = await paid(t), { second } = owned(f), real = reference(second.decision);
  const absent: Ref = { id: real.id + '-absent', revision: real.revision, hash: '0'.repeat(64) };
  assert.equal(f.store.get(absent.id, absent.revision), null);
  // The review's probe: id and hash answer the absent identity while they are checked and keyed (three reads) and the
  // real one afterwards; a reader that proved the original Ref would keep the real proof under the absent key.
  let ids = 0, hashes = 0;
  const shifting = { get id() { return ++ids <= 3 ? absent.id : real.id; }, revision: absent.revision,
    get hash() { return ++hashes <= 3 ? absent.hash : real.hash; } } as Ref;
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    try { readVariantOwnerDecision(store, 'p', shifting); } catch (error) { assert.ok(error instanceof EngineError); }
    refuses(() => readVariantOwnerDecision(store, 'p', { ...absent }));
    assert.deepEqual(reference(readVariantOwnerDecision(store, 'p', { ...real }).decision), real);
    refuses(() => readVariantOwnerDecision(store, 'p', { ...absent }));
  }
});
