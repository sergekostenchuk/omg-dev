import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson, canonical } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision } from '../src/storage/store.js';
import { pendingOverlay } from '../src/storage/store-view.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun, PaidDiscoveryAttemptsAssessment } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { historicalProof, historicalTrace, withHistoricalReads } from '../src/history/proofs.js';
import { storeUnchanged } from './store-unchanged.js';

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


/** The real paid assessments of the world, oldest first. */
const paidAssessments = (store: Store) => store.list<PaidDiscoveryAttemptsAssessment>('discovery-assessment')
  .sort((a, b) => a.id.localeCompare(b.id));
/** Physical reads of one exact record id by the genuine Store's own get, during the action. */
function readsOf(t: test.TestContext, store: Store, id: string, action: () => unknown) {
  let count = 0;
  const original = Store.prototype.get, method = t.mock.method(Store.prototype, 'get', function (this: Store, key: string, revision?: number) {
    if (this === store && key === id) count++;
    return original.call(this, key, revision as number);
  } as typeof Store.prototype.get);
  try { action(); } finally { method.mock.restore(); }
  return count;
}
const refuses = (action: () => unknown) => assert.throws(action, (error: unknown) => error instanceof EngineError);

test('nested assessment proof: a trace over a genuine Store reuses the kept exact proof, copied per entry', async t => {
  const f = await paid(t), [first] = paidAssessments(f.store), ref = reference(first!);
  const fresh = new Store(f.store.path); t.after(() => fresh.close());
  // A transparent but unregistered Proxy is no proved source: it derives in place and reads the exact assessment.
  const passing = new Proxy(fresh, { get(target, key) {
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
  const derived = readsOf(t, fresh, first!.id, () => readDiscoveryAssessment(passing, 'p', ref));
  assert.ok(derived > 0, 'an in-place derivation reads the exact assessment');
  const proof = readDiscoveryAssessment(fresh, 'p', ref);
  assert.deepEqual(readDiscoveryAssessment(passing, 'p', ref), proof);
  // A nested trace the proof module made over the genuine Store reuses the kept proof of this exact Ref.
  for (let i = 0; i < 3; i++)
    assert.equal(readsOf(t, fresh, first!.id, () => readDiscoveryAssessment(historicalTrace(fresh), 'p', ref)), 0,
      'a nested trace over the genuine Store reuses the kept proof');
  assert.deepEqual(readDiscoveryAssessment(historicalTrace(historicalTrace(fresh)), 'p', ref), proof);
  // Independent results, also inside one explicit region and for the deriving entry.
  const region = new Store(f.store.path); t.after(() => region.close());
  withHistoricalReads(() => {
    const derived = readDiscoveryAssessment(historicalTrace(region), 'p', ref);
    (derived.value as any).projectId = 'mutated'; (derived as any).hash = '0'.repeat(64);
    const repeated = readDiscoveryAssessment(historicalTrace(region), 'p', ref);
    assert.deepEqual(repeated, proof);
    (repeated.value as any).subject = null;
    assert.deepEqual(readDiscoveryAssessment(region, 'p', ref), proof);
  });
});

test('nested assessment proof: ordered and distinct observations and a parent proof\'s transitive reads are the same cold and repeated', async t => {
  const f = await paid(t), [first] = paidAssessments(f.store), ref = reference(first!);
  const observe = (store: Store, mode: 'ordered' | 'distinct') => {
    const seen: string[] = [];
    readDiscoveryAssessment(historicalTrace(store, (r, head, method) => seen.push(canonical([r, head, method] as never)), mode), 'p', ref);
    return seen;
  };
  for (const mode of ['ordered', 'distinct'] as const) {
    const store = new Store(f.store.path); t.after(() => store.close());
    const coldSeen = observe(store, mode), repeatedSeen = observe(store, mode);
    assert.ok(coldSeen.length > 0); assert.deepEqual(repeatedSeen, coldSeen);
  }
  // A parent proof that reads the assessment through its own traced source keeps the nested reads as its own.
  const parentReads = (store: Store) => {
    const seen: string[] = [];
    const value = historicalProof(historicalTrace(store, (r, head, method) => seen.push(canonical([r, head, method] as never))),
      { reader: 'test.nested-assessment-parent/v1', project: 'p', ref }, source => readDiscoveryAssessment(source, 'p', ref).hash,
      () => { throw new Error('cyclic'); });
    return { value, seen };
  };
  const store = new Store(f.store.path); t.after(() => store.close());
  const coldParent = parentReads(store);
  assert.equal(coldParent.value, first!.hash); assert.ok(coldParent.seen.length > 0);
  // A second Store moves today's heads; the exact historical proof keeps its result.
  const other = new Store(f.store.path); t.after(() => other.close());
  other.write({ id: `nested-proof-probe:${rand()}`, kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
  const [, second] = paidAssessments(other);
  if (second) applyDiscoveryAssessment(other, 'p', reference(second));
  assert.deepEqual(readDiscoveryAssessment(historicalTrace(store), 'p', ref), readDiscoveryAssessment(new Store(f.store.path), 'p', ref));
});

test('nested assessment proof: opaque, overlay, changed Store and a lost or foreign basis keep the old path and refusals without effects', async t => {
  const f = await paid(t), [first] = paidAssessments(f.store), ref = reference(first!);
  const proof = readDiscoveryAssessment(f.store, 'p', ref), paidBefore = money(f.store), wires = f.wires().length;
  const attempt = first!.value.subject.packet.entries[0]!.attempt;
  // A Proxy losing the paid attempt, and a registered trace over it, derive in place and refuse as before.
  const losing = new Proxy(f.store, { get(target, key) {
    if (key === 'get') return (id: string, revision?: number) => id === attempt.id ? null : target.get(id, revision as number);
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
  refuses(() => readDiscoveryAssessment(losing, 'p', ref));
  refuses(() => readDiscoveryAssessment(historicalTrace(losing), 'p', ref));
  // A pending overlay with a substituted assessment row is its own source, never the kept proof.
  const changed = { ...first!, value: { ...first!.value, verdict: 'return' } } as Revision<PaidDiscoveryAttemptsAssessment>;
  const overlay = pendingOverlay(f.store, [{ ...changed, hash: hashJson(changed.value as never) }]);
  assert.throws(() => readDiscoveryAssessment(historicalTrace(overlay), 'p', ref), (error: unknown) => error instanceof EngineError);
  // A Store with a replaced read is not genuine: in place again.
  const replaced = new Store(f.store.path); t.after(() => replaced.close());
  const get = replaced.get.bind(replaced);
  replaced.get = ((id: string, revision?: number) => id === attempt.id ? null : get(id, revision as number)) as typeof replaced.get;
  refuses(() => readDiscoveryAssessment(historicalTrace(replaced), 'p', ref));
  for (const source of [f.store, historicalTrace(f.store)]) {
    refuses(() => readDiscoveryAssessment(source, 'foreign', ref));
    refuses(() => readDiscoveryAssessment(source, 'p', { ...ref, hash: '0'.repeat(64) }));
    refuses(() => readDiscoveryAssessment(source, 'p', reference(f.set!)));
  }
  await storeUnchanged(f.store, () => readDiscoveryAssessment(historicalTrace(f.store), 'p', ref));
  assert.deepEqual(readDiscoveryAssessment(historicalTrace(f.store), 'p', ref), proof);
  assert.deepEqual(money(f.store), paidBefore); assert.equal(f.wires().length, wires);
});
