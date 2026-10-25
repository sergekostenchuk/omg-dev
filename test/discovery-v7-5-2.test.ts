import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
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
  type VariantScope, type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope, readCurrentVariantScope, VARIANT_SCOPE_KIND } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand, validPlan, validFrame, type PlanQuestion } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';

// Real paid generation/selection preparation shared in shape with the accepted 4P.1 scenarios.
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
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-5-2-' }), project = 'p', runs = new Map<string, string>();
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
  reply(answer === 'none' ? none([reference(saved)]) : answer);
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

import { DISCOVERY_DEEP_PREPARATION_KIND, DISCOVERY_DEEP_PREPARATION_CONTRACT, deepPreparationId,
  produceDeepPreparation, readDeepPreparation, requireCurrentDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { Discovery } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';

type Paid = Awaited<ReturnType<typeof paid>>;
const snapshot = (store: Store) => canonical(store.list().map(head => ({ head, history: store.history(head.id) })));
function selected(f: Paid) {
  const act = answerVariantChoice(f.store, f.scope!, mint(f.store, f.scope!).authority);
  return { act, published: publishVariantScope(f.store, 'p', reference(act.decision)).scope };
}
function inputFor(f: Paid, scope: ReturnType<typeof publishVariantScope>['scope'], questionId = 'q-industry'): DeepPreparation {
  const question = provePlanQuestions(f.store, f.store.get<DiscoveryDraft>(scope.value.draft.id, scope.value.draft.revision)!,
    f.v.planAnswer).find(item => item.planQuestionId === questionId)!.question as Record<string, Json>;
  return { contract: DISCOVERY_DEEP_PREPARATION_CONTRACT, cell: { contract: DISCOVERY_COVERAGE_CELL_CONTRACT,
    projectId: 'p', subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: f.v.planAnswer, planQuestionId: questionId },
    variant: { set: scope.value.set, member: scope.value.member }, requiredDepth: question.requiredDepth as string,
    criterion: question.criterion as string }, scope: reference(scope) };
}
function nextPlan(f: Paid, store: Store) {
  const engine = new ProductEngine(store), discovery = new Discovery(store), plan = store.get<Question>(f.v.plan.id)!;
  discovery.reopen(plan.id, plan.revision);
  const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(f.v.draft.id)!;
  const source = discovery.evidence.document('p', 'deep-next-plan', 'Next accepted plan', 'text/plain', 0);
  const questions = provePlanQuestions(store, f.v.draft, f.v.planAnswer).map(item => item.question as unknown as PlanQuestion);
  answerDiscoveryFixture(engine, 'p', draft, question, validPlan(f.v.frameRef, questions, 2, f.v.planAnswer), source);
  return store.get<Question>(plan.id)!.value.answer!;
}
const checkedRefusal = (store: Store, f: Paid, invoke: () => unknown, code?: string, field?: string) => {
  const before = snapshot(store), accounting = money(store), sent = f.wires().length;
  assert.throws(invoke, error => {
    assert.ok(error instanceof EngineError); if (code) assert.equal(error.code, code);
    if (field) assert.equal((error.details as {field: string}).field, field);
    return true;
  });
  assert.equal(snapshot(store), before); assert.deepEqual(money(store), accounting); assert.equal(f.wires().length, sent);
};

for (const kind of ['owner', 'model'] as const)
test(`5.2: real ${kind} choose and published P.1 scope produce the exact deep subject; admission guards and cold repetition write and pay nothing`, async t => {
  const f = await paid(t), scope = kind === 'owner' ? selected(f).published
    : publishVariantScope(f.store, 'p', reference(await modelChoose(f))).scope;
  const input = inputFor(f, scope), produced = produceDeepPreparation(f.store, 'p', input), ref = reference(produced.record);
  assert.equal(produced.repeated, false); assert.deepEqual(produced.record.value, input);
  assert.equal(produced.record.id, deepPreparationId(input)); assert.equal(produced.record.revision, 1);
  assert.equal(produced.record.kind, DISCOVERY_DEEP_PREPARATION_KIND);
  const before = snapshot(f.store), accounting = money(f.store), sent = f.wires().length;
  const cold = f.open();
  for (const store of [f.store, cold]) {
    const historical = readDeepPreparation(store, 'p', ref);
    assert.equal(historical.verification, 'proven'); assert.deepEqual(historical.preparation, produced.record);
    assert.equal(historical.scope.choice.kind, kind); assert.deepEqual(historical.scope.scope, scope);
    assert.equal(historical.question.planQuestionId, input.cell.subject.planQuestionId);
    const current = requireCurrentDeepPreparation(store, 'p', ref);
    const state = readCurrentVariantScope(store, 'p', scope.value.draft).state;
    const guards = [ref, reference(scope), scope.value.draft, reference(store.get<Question>(f.v.plan.id)!),
      f.v.planAnswer, scope.value.set, scope.value.member, scope.value.decision, scope.value.mode, reference(state),
      f.v.frameRef, reference(frameQuestion(store, f))];
    assert.deepEqual(new Set(current.guards.map(canonical)), new Set(guards.map(canonical)), 'mandatory guards are derived, not supplied by the caller');
    assert.deepEqual(produceDeepPreparation(store, 'p', input), {record: produced.record, repeated: true});
    assert.equal(snapshot(store), before); assert.deepEqual(money(store), accounting); assert.equal(f.wires().length, sent);
  }
});

test('5.2: another question or a real revised scope has its own preparation; an old exact preparation stays historical without reactivating its choice', async t => {
  const f = await paid(t), first = selected(f), input = inputFor(f, first.published);
  const a = produceDeepPreparation(f.store, 'p', input).record;
  const b = produceDeepPreparation(f.store, 'p', inputFor(f, first.published, 'q-market')).record;
  assert.notEqual(a.id, b.id);
  const revise = revised(f.scope!, first.act, 'choose'), act = answerVariantChoice(f.store, revise, mint(f.store, revise).authority);
  const scope = publishVariantScope(f.store, 'p', reference(act.decision)).scope;
  const c = produceDeepPreparation(f.store, 'p', inputFor(f, scope)).record;
  assert.deepEqual(a.value.cell, c.value.cell); assert.notEqual(a.id, c.id);
  const before = snapshot(f.store), sent = f.wires().length;
  for (const store of [f.store, f.open()]) {
    for (const old of [a, b]) {
      assert.deepEqual(readDeepPreparation(store, 'p', reference(old)).preparation, old);
      checkedRefusal(store, f, () => requireCurrentDeepPreparation(store, 'p', reference(old)), 'discovery_deep_preparation_stale', 'scope');
      checkedRefusal(store, f, () => produceDeepPreparation(store, 'p', old.value), 'discovery_deep_preparation_stale', 'scope');
    }
    assert.deepEqual(requireCurrentDeepPreparation(store, 'p', reference(c)).preparation, c);
    assert.equal(snapshot(store), before); assert.equal(f.wires().length, sent);
  }
  const rejection = revised(f.scope!, act, 'reject_all');
  answerVariantChoice(f.store, rejection, mint(f.store, rejection).authority);
  const rejected = snapshot(f.store), rejectedSends = f.wires().length;
  for (const store of [f.store, f.open()]) {
    assert.deepEqual(readDeepPreparation(store, 'p', reference(c)).preparation, c);
    checkedRefusal(store, f, () => requireCurrentDeepPreparation(store, 'p', reference(c)), 'discovery_variant_scope_required');
    checkedRefusal(store, f, () => produceDeepPreparation(store, 'p', c.value), 'discovery_variant_scope_required');
    assert.equal(snapshot(store), rejected); assert.equal(f.wires().length, rejectedSends);
  }
});

for (const move of ['mode', 'plan'] as const)
test(`5.2: a lawful ${move} move leaves the preparation historically exact but never admits a new step or producer repeat`, async t => {
  const f = await paid(t), {published} = selected(f), input = inputFor(f, published);
  const saved = produceDeepPreparation(f.store, 'p', input).record;
  if (move === 'mode') modeOf(f.store, 'bypass'); else nextPlan(f, f.store);
  const before = snapshot(f.store), sent = f.wires().length;
  for (const store of [f.store, f.open()]) {
    assert.deepEqual(readDeepPreparation(store, 'p', reference(saved)).preparation, saved);
    checkedRefusal(store, f, () => requireCurrentDeepPreparation(store, 'p', reference(saved)), 'discovery_deep_preparation_stale');
    checkedRefusal(store, f, () => produceDeepPreparation(store, 'p', input), 'discovery_deep_preparation_stale');
    assert.equal(snapshot(store), before); assert.equal(f.wires().length, sent);
  }
});

for (const move of ['mode', 'selection', 'plan'] as const)
test(`5.2: a real second Store ${move} move before the preparation write loses CAS without a partial record or new payment`, async t => {
  const f = await paid(t), {act, published} = selected(f), input = inputFor(f, published), other = f.open();
  const write = f.store.writeMany.bind(f.store); let after = '', accounting: ReturnType<typeof money> | undefined, sent = 0;
  f.store.writeMany = ((writes, guards) => {
    if (!after && writes.some(item => item.kind === DISCOVERY_DEEP_PREPARATION_KIND)) {
      const required = move === 'mode' ? published.value.mode : move === 'selection' ? reference(act.state) : reference(f.store.get<Question>(f.v.plan.id)!);
      assert.ok(guards?.some(guard => canonical(guard) === canonical(required)));
      if (move === 'mode') modeOf(other, 'bypass');
      else if (move === 'selection') { const request = revised(f.scope!, act, 'reject_all'); answerVariantChoice(other, request, mint(other, request).authority); }
      else nextPlan(f, other);
      after = snapshot(other); accounting = money(other); sent = f.wires().length;
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  try { refuses(() => produceDeepPreparation(f.store, 'p', input), 'input_stale'); }
  finally { f.store.writeMany = write; }
  assert.ok(after); assert.equal(f.store.get(deepPreparationId(input)), null);
  assert.equal(snapshot(f.store), after); assert.deepEqual(money(f.store), accounting); assert.equal(f.wires().length, sent);
});

test('5.2: absent/null/foreign scope, every changed exact cell basis and verbatim depth/criterion refuse before writing; saved lookalikes also fail historical proof', async t => {
  const f = await paid(t), {published} = selected(f), input = inputFor(f, published);
  const cases: {name: string; mutate(value: DeepPreparation): void; closed?: boolean; field?: string}[] = [
    {name: 'absent scope', mutate: value => { delete (value as Partial<DeepPreparation>).scope; }, closed: false, field: 'preparation.scope'},
    {name: 'null scope', mutate: value => { Object.assign(value, {scope: null}); }, closed: false, field: 'scope'},
    {name: 'foreign scope', mutate: value => { value.scope.id = value.scope.id.replace(':p:', ':foreign:'); }, closed: false, field: 'scope'},
    {name: 'scope hash', mutate: value => { value.scope.hash = '0'.repeat(64); }},
    {name: 'scope revision', mutate: value => { value.scope.revision++; }},
    {name: 'scope id', mutate: value => { value.scope.id += '-missing'; }},
    {name: 'plan hash', mutate: value => { value.cell.subject.planAnswer.hash = '0'.repeat(64); }, field: 'cell.subject.planAnswer'},
    {name: 'plan revision', mutate: value => { value.cell.subject.planAnswer.revision++; }, field: 'cell.subject.planAnswer'},
    {name: 'plan id', mutate: value => { value.cell.subject.planAnswer.id += '-foreign'; }, field: 'cell.subject.planAnswer'},
    {name: 'question', mutate: value => { value.cell.subject.planQuestionId = 'not-in-plan'; }, field: 'cell.subject.planQuestionId'},
    {name: 'set hash', mutate: value => { value.cell.variant.set.hash = '0'.repeat(64); }, field: 'cell.variant.set'},
    {name: 'set revision', mutate: value => { value.cell.variant.set.revision++; }, field: 'cell.variant.set'},
    {name: 'set id', mutate: value => { value.cell.variant.set.id += '-foreign'; }, field: 'cell.variant.set'},
    {name: 'member hash', mutate: value => { value.cell.variant.member.hash = '0'.repeat(64); }, field: 'cell.variant.member'},
    {name: 'member revision', mutate: value => { value.cell.variant.member.revision++; }, field: 'cell.variant.member'},
    {name: 'member id', mutate: value => { value.cell.variant.member.id += '-foreign'; }, field: 'cell.variant.member'},
    {name: 'other real member', mutate: value => { value.cell.variant.member = f.set!.value.members[1]!; }, field: 'cell.variant.member'},
    {name: 'depth', mutate: value => { value.cell.requiredDepth += ' '; }, field: 'cell.requiredDepth'},
    {name: 'criterion', mutate: value => { value.cell.criterion += ' '; }, field: 'cell.criterion'},
  ];
  for (const item of cases) {
    const value = structuredClone(input); item.mutate(value);
    for (const store of [f.store, f.open()])
      checkedRefusal(store, f, () => produceDeepPreparation(store, 'p', value), item.field ? 'discovery_deep_preparation_invalid' : undefined, item.field);
    if (item.closed !== false) {
      // Deliberate saved negative imitation, with its honest deterministic address/hash, not a producer result.
      const corrupt = f.store.write({ id: deepPreparationId(value), kind: DISCOVERY_DEEP_PREPARATION_KIND, expected: 0, value });
      for (const store of [f.store, f.open()]) {
        checkedRefusal(store, f, () => readDeepPreparation(store, 'p', reference(corrupt)), item.field ? 'discovery_deep_preparation_invalid' : undefined, item.field);
        checkedRefusal(store, f, () => produceDeepPreparation(store, 'p', value));
      }
    }
  }
  checkedRefusal(f.store, f, () => produceDeepPreparation(f.store, 'foreign', input), 'discovery_deep_preparation_invalid', 'cell.projectId');
  const good = produceDeepPreparation(f.store, 'p', input).record;
  for (const badRef of [null, undefined, {...reference(good), hash: '0'.repeat(64)}, {...reference(good), revision: 2}, {...reference(good), id: good.id + '-missing'}])
    checkedRefusal(f.store, f, () => readDeepPreparation(f.store, 'p', badRef as Ref), 'discovery_deep_preparation_invalid', 'preparation');
  checkedRefusal(f.store, f, () => readDeepPreparation(f.store, 'foreign', reference(good)), 'discovery_deep_preparation_invalid', 'cell.projectId');
});

test('5.2: scope substitutions of draft/decision/mode and a structural owner lookalike prove no preparation', async t => {
  const f = await paid(t), {published} = selected(f), input = inputFor(f, published);
  const invented: Ref = {id: `discovery-choice-session:${rand()}`, revision: 1, hash: '0'.repeat(64)};
  const fake = {contract: VARIANT_OWNER_DECISION_CONTRACT, projectId: 'p', draft: f.scope!.draft, set: reference(f.set!), mode: f.scope!.mode,
    expectedSelection: reference(f.state1), previous: null, operation: 'initial',
    outcome: {kind: 'choose', member: f.set!.value.members[0], reason: 'Explicit negative authority lookalike'}, authority: {grant: invented, session: invented}};
  const fakeDecision = f.store.write({id: variantRecordId('discovery-variant-owner-decision', fake), kind: 'discovery-variant-owner-decision', expected: 0, value: fake});
  for (const field of ['draft', 'decision', 'mode', 'lookalike'] as const) {
    const value = {...structuredClone(published.value), ...(field === 'lookalike' ? {decision: reference(fakeDecision)} :
      {[field]: {...published.value[field], hash: '0'.repeat(64)}})};
    const scope = f.store.write({id: variantRecordId(VARIANT_SCOPE_KIND, value), kind: VARIANT_SCOPE_KIND, expected: 0, value});
    const wrong = {...input, scope: reference(scope)};
    checkedRefusal(f.store, f, () => produceDeepPreparation(f.store, 'p', wrong));
    const row = f.store.write({id: deepPreparationId(wrong), kind: DISCOVERY_DEEP_PREPARATION_KIND, expected: 0, value: wrong});
    for (const store of [f.store, f.open()]) checkedRefusal(store, f, () => readDeepPreparation(store, 'p', reference(row)));
  }
});

test('5.2: real owner/model reject_all and no_variants cannot supply a preparation scope', async t => {
  for (const kind of ['owner', 'model', 'none'] as const) {
    const f = await paid(t, kind === 'none' ? 'none' : generation());
    if (kind === 'owner') { const rejection: VariantChoiceScope = {...f.scope!, outcome: {kind: 'reject_all', reason: 'Reject the real paid set'}};
      answerVariantChoice(f.store, rejection, mint(f.store, rejection).authority);
    } else if (kind === 'model') await modelChoose(f, 'reject_all');
    const imaginary: Ref = {id: 'discovery-variant-scope:p:missing', revision: 1, hash: '0'.repeat(64)};
    const value: DeepPreparation = {contract: DISCOVERY_DEEP_PREPARATION_CONTRACT, scope: imaginary,
      cell: {contract: DISCOVERY_COVERAGE_CELL_CONTRACT, projectId: 'p', subject: f.subject(),
        variant: {set: {id:'discovery-variant-set:p:missing', revision:1, hash:'0'.repeat(64)}, member: {id:'discovery-variant:p:missing',revision:1,hash:'0'.repeat(64)}},
        requiredDepth: 'deep', criterion: 'No scope exists'}};
    for (const store of [f.store, f.open()]) {
      checkedRefusal(store, f, () => readCurrentVariantScope(store, 'p', f.draft), 'discovery_variant_scope_required');
      checkedRefusal(store, f, () => produceDeepPreparation(store, 'p', value));
    }
    assert.equal(f.store.list(DISCOVERY_DEEP_PREPARATION_KIND).length, 0);
  }
});

test('5.2: a real paid model choose published without state cannot authorize a structural scope/preparation even historically', async t => {
  const f = await paid(t), mode = modeOf(f.store, 'bypass');
  f.reply({action: 'choose', key: 'v1', reason: 'Paid decision before its mode moved'});
  const calibration = reference(f.store.write({id:'transport-fixture:deep-stale-calibration',kind:'transport-fixture',expected:0,value:{projectId:'p'}}));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', {variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,
      kind:'decision',set:calibration,mode:reference(mode),expectedSelection:null},history:[]}, undefined,
      {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'variant-decision'});
  const prepared = prepareVariantSession(f.store, {projectId:'p',environment:f.environment,role:f.environment.value.implementer,prompt:'Choose the exact paid set',
    variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,kind:'decision',set:reference(f.set!),mode:reference(mode),expectedSelection:reference(f.state1)}});
  const v = prepared.intent.value;
  await researchCall(v.role,v.dispatch,v.cursor.prompt,v.cursor.context,undefined,
    {store:f.store,draftId:v.draft.id,questionId:v.question.id,purpose:v.kind,consumerIntent:reference(prepared.intent),session:v.owner});
  modeOf(f.store,'questions'); applyVariantSession(f.store,'p',reference(f.store.get(prepared.intent.id)!));
  const decision = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  assert.equal(readVariantModelDecision(f.store,'p',reference(decision)).state,null);
  const value = {contract:VARIANT_SCOPE_CONTRACT, projectId:'p', draft:f.scope!.draft, set:reference(f.set!), member:f.set!.value.members[0]!,
    decision:reference(decision),mode:reference(mode)};
  // Negative lookalikes are explicitly saved; they do not fabricate a successful model decision or application.
  const scope = f.store.write<VariantScope>({id:variantRecordId(VARIANT_SCOPE_KIND,value),kind:VARIANT_SCOPE_KIND,expected:0,value});
  const input = inputFor(f, scope), row = f.store.write({id:deepPreparationId(input),kind:DISCOVERY_DEEP_PREPARATION_KIND,expected:0,value:input});
  for (const store of [f.store,f.open()]) {
    checkedRefusal(store,f,()=>produceDeepPreparation(store,'p',input),'discovery_variant_scope_invalid');
    checkedRefusal(store,f,()=>readDeepPreparation(store,'p',reference(row)),'discovery_variant_scope_invalid');
  }
});

function frameQuestion(store: Store, f: Paid) {
  const frame = f.v.draft.value.questions.map(id => store.get<Question>(id)).find(row => row?.value.spec.field === 'frame');
  assert.ok(frame); return frame;
}

for (const change of ['reopened', 'missing', 'replaced'] as const)
test(`5.2-01: a ${change} frame head refuses new preparation, producer repeat and current admission hot/cold while exact history remains readable`, async t => {
  const f = await paid(t), {published} = selected(f), input = inputFor(f, published);
  const saved = produceDeepPreparation(f.store, 'p', input).record, next = inputFor(f, published, 'q-market');
  const frame = frameQuestion(f.store, f);
  assert.deepEqual(frame.value.answer, f.v.frameRef);
  if (change === 'missing') {
    // Explicit negative loss of the mutable head only. Immutable frame revisions and their provenance remain saved.
    const db = new DatabaseSync(f.store.path);
    try { assert.equal(db.prepare('DELETE FROM heads WHERE entity_id = ?').run(frame.id).changes, 1); }
    finally { db.close(); }
    assert.equal(f.store.get(frame.id), null);
  } else {
    f.discovery.reopen(frame.id, frame.revision);
    if (change === 'replaced') {
      const source = f.discovery.evidence.document('p', 'new-deep-frame', 'New frame basis', 'text/plain', 0);
      const value = {...validFrame() as Record<string, Json>, scale: 'A changed current frame'};
      answerDiscoveryFixture(f.engine, 'p', f.store.get<DiscoveryDraft>(f.v.draft.id)!, f.store.get<Question>(frame.id)!, value, source);
      assert.notDeepEqual(f.store.get<Question>(frame.id)!.value.answer, f.v.frameRef);
    }
  }
  const before = snapshot(f.store), history = f.store.history(frame.id), accounting = money(f.store), sent = f.wires().length;
  for (const store of [f.store, f.open()]) {
    assert.deepEqual(readDeepPreparation(store, 'p', reference(saved)).preparation, saved);
    assert.equal(snapshot(store), before); assert.deepEqual(store.history(frame.id), history);
    assert.deepEqual(money(store), accounting); assert.equal(f.wires().length, sent);
    for (const invoke of [() => produceDeepPreparation(store, 'p', next), () => produceDeepPreparation(store, 'p', input),
      () => requireCurrentDeepPreparation(store, 'p', reference(saved))]) {
      checkedRefusal(store, f, invoke, 'discovery_deep_preparation_stale');
      assert.equal(snapshot(store), before); assert.deepEqual(store.history(frame.id), history);
    }
    assert.equal(store.get(deepPreparationId(next)), null);
  }
});

test('5.2-01: a second Store reopening the real frame Question in the write window loses the preparation CAS with no side effects', async t => {
  const f = await paid(t), {published} = selected(f), input = inputFor(f, published);
  const saved = produceDeepPreparation(f.store, 'p', input).record, next = inputFor(f, published, 'q-market');
  const frame = frameQuestion(f.store, f), other = f.open(), write = f.store.writeMany.bind(f.store);
  let after = '', accounting: ReturnType<typeof money> | undefined, sent = 0;
  f.store.writeMany = ((writes, guards) => {
    if (!after && writes.some(row => row.kind === DISCOVERY_DEEP_PREPARATION_KIND)) {
      for (const ref of [reference(frame), f.v.frameRef]) assert.ok(guards?.some(guard => canonical(guard) === canonical(ref)));
      new Discovery(other).reopen(frame.id, frame.revision);
      after = snapshot(other); accounting = money(other); sent = f.wires().length;
    }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  try { refuses(() => produceDeepPreparation(f.store, 'p', next), 'input_stale'); }
  finally { f.store.writeMany = write; }
  assert.ok(after); assert.equal(f.store.get(deepPreparationId(next)), null);
  for (const store of [f.store, f.open()]) {
    assert.deepEqual(readDeepPreparation(store, 'p', reference(saved)).preparation, saved);
    checkedRefusal(store, f, () => requireCurrentDeepPreparation(store, 'p', reference(saved)), 'discovery_deep_preparation_stale', 'frame');
    assert.equal(snapshot(store), after); assert.deepEqual(money(store), accounting); assert.equal(f.wires().length, sent);
  }
});
