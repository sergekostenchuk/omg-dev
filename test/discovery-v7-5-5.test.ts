import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision } from '../src/storage/store.js';
import { storeView } from '../src/storage/store-view.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, staleUnpaidDeepAdmission } from '../src/discovery/response-recovery.js';
import { replayDeepResponse } from '../src/discovery/response-replay.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT, CONTEXT_PREPARATION_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline, readV7ProgressStateAt } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession,
  type VariantSessionInput } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA,
  type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION,
  type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope, readCurrentVariantChoice, readCurrentVariantScope } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';

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
async function paid(t: test.TestContext, answer: unknown = generation()) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-5-5-' }), project = 'p', runs = new Map<string, string>();
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

import { DISCOVERY_DEEP_PREPARATION_CONTRACT,
  produceDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { Discovery } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';

type Paid = Awaited<ReturnType<typeof paid>>;
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

import { prepareDeepResearch, runDeepResearch, resumeDeepResearch, applyDeepResearch, readDeepResearchResult, type DeepResearchInput, type ProvenDeepResearchResult } from '../src/discovery/deep-research-execution.js';
import { prepareResearchConsumerApplication, deepResearchApplication, readResearchConsumerExecution,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import type { Write, TransactionGuard } from '../src/storage/store.js';
const all = (store: Store) => canonical(store.list().flatMap(row => store.history(row.id)));
const end = { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'No accessible source for this exact cell' };
async function ready(t: test.TestContext, model = false) {
  const f = await paid(t);
  let scope: ReturnType<typeof publishVariantScope>['scope'];
  if (model) { const choice = await modelChoose(f); scope = publishVariantScope(f.store, 'p', reference(choice)).scope; }
  else scope = selected(f).published;
  const preparation = produceDeepPreparation(f.store, 'p', inputFor(f, scope)).record;
  f.reply({ action: 'answer', question: 'q-industry', value: end, citations: [] });
  const input = { projectId: 'p', deepPreparation: reference(preparation), environment: f.environment };
  return { ...f, get store() { return interceptions.get(f.store) ?? f.store; }, scopeRecord: scope, preparation, input };
}
type Ready = Awaited<ReturnType<typeof ready>>;
const interceptions = new WeakMap<Store, Store>();
function intercept(store: Store, action: (writes: Write[], guards: TransactionGuard[], write: () => Revision[]) => Revision[]) {
  assert.equal(interceptions.has(store), false);
  const view = storeView(store, { write: (writes, guards) => action(writes, guards, () => store.writeMany(writes, guards)) });
  interceptions.set(store, view);
  return () => { interceptions.delete(store); };
}

function cut(f: Ready, point: 'before'|'after') {
  return intercept(f.store, (writes, _guards, write) => {
    if (writes.some(w => w.kind === 'research-turn' && w.expected === 0)) {
      if (point === 'after') write();
      throw new Error('deep application cut');
    }
    return write();
  });
}
const deepIntents = (f: Ready, store = f.store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => Object.hasOwn(row.value.cursor, 'deepPreparation'));
for (const model of [false, true]) test(`5.5 real ${model?'model':'owner'} choose → preparation → managed paid deep and K`, async t => {
  const f = await ready(t, model), before = f.wires().length;
  const result = await runDeepResearch(f.store, f.input);
  assert.ok(result); assert.equal(result.verification, 'proven'); assert.equal(f.wires().length, before + 1);
  assert.deepEqual(result.attempt.value.end, end); assert.equal(result.turn.value.status, 'completed');
  assert.deepEqual(result.binding.value.attempt, reference(result.attempt));
  const wire = f.wires().at(-1)!;
  assert.deepEqual(wire.subject.deepPreparation, reference(f.preparation));
  const beforeCold = all(f.store), account = money(f.store), sent = f.wires().length;
  const cold = new Store(f.store.path);
  const replay = await runDeepResearch(cold, f.input, { restoreOnly: true, allowance: 0 });
  assert.deepEqual(replay, result); assert.deepEqual(readDeepResearchResult(cold, 'p', reference(result.intent)), result);
  assert.equal(all(cold), beforeCold); assert.deepEqual(money(cold), account); assert.equal(f.wires().length, sent);
});

test('5.5 restoreOnly and exhausted allowance preserve new/session-only/prepared states without payment', async t => {
  const f = await ready(t), before = all(f.store), account = money(f.store), sent = f.wires().length;
  assert.equal(await runDeepResearch(f.store, f.input, { restoreOnly: true }), null);
  await assert.rejects(runDeepResearch(f.store, f.input, { allowance: 0 }), { code: 'research_turns_exhausted' });
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, sent);
  const undo = intercept(f.store, (writes, _guards, write) => {
    if (writes.some(w => w.kind === 'research-consumer-intent')) throw new Error('session only');
    return write();
  });
  assert.throws(() => prepareDeepResearch(f.store, f.input), /session only/); undo();
  const only = all(f.store);
  assert.equal(await runDeepResearch(f.store, f.input, { restoreOnly: true }), null); assert.equal(all(f.store), only);
  const intent = prepareDeepResearch(f.store, f.input), prepared = all(f.store);
  assert.equal(await resumeDeepResearch(f.store, 'p', reference(intent), { restoreOnly: true }), null);
  await assert.rejects(resumeDeepResearch(f.store, 'p', reference(intent), { allowance: 0 }), { code: 'research_turns_exhausted' });
  assert.equal(all(f.store), prepared); assert.equal(f.wires().length, sent);
  assert.ok(await resumeDeepResearch(f.store, 'p', reference(intent)));
});

for (const point of ['before','after'] as const) test(`5.5 paid cut ${point} application recovers through cold original identity`, async t => {
  const f = await ready(t), before = f.wires().length, undo = cut(f, point);
  await assert.rejects(runDeepResearch(f.store, f.input), /deep application cut/); undo();
  assert.equal(f.wires().length, before + 1);
  const intent = deepIntents(f)[0]!;
  assert.equal(intent.value.state, point === 'before' ? 'running' : 'applied');
  const result = await resumeDeepResearch(new Store(f.store.path), 'p', reference(intent), { restoreOnly: true, allowance: 0 });
  assert.ok(result); assert.equal(result.turn.value.status, 'completed'); assert.equal(f.wires().length, before + 1);
  const history = all(f.store);
  assert.deepEqual(await resumeDeepResearch(f.store, 'p', reference(intent), { restoreOnly: true }), result);
  assert.equal(all(f.store), history);
});

for (const change of ['mode','selection','plan'] as const) test(`5.5 paid work after late ${change} restores original subject without current overwrite`, async t => {
  const f = await ready(t), undo = cut(f, 'before');
  await assert.rejects(runDeepResearch(f.store, f.input), /deep application cut/); undo();
  const other = new Store(f.store.path);
  if (change === 'mode') modeOf(other, 'bypass');
  if (change === 'plan') nextPlan(f, other);
  if (change === 'selection') {
    const old = f.store.get<any>(f.scopeRecord.value.decision.id, f.scopeRecord.value.decision.revision)!;
    const state = f.store.get<VariantState>(variantStateId('p', f.draft.id))!;
    const scope: VariantChoiceScope = { ...f.scope!, operation: 'revise', previous: reference(old), expectedSelection: reference(state),
      outcome: { kind: 'reject_all', reason: 'New owner choice' } };
    answerVariantChoice(other, scope, mint(other, scope).authority);
  }
  const heads = [other.get('project-mode:p'),other.get(f.v.plan.id),other.get(variantStateId('p', f.draft.id))];
  const sent = f.wires().length, account = money(other), intent = deepIntents(f, other)[0]!;
  const result = await resumeDeepResearch(other, 'p', reference(intent), { restoreOnly: true, allowance: 0 });
  assert.ok(result); assert.deepEqual(result.preparation.preparation, f.preparation);
  assert.deepEqual([other.get('project-mode:p'),other.get(f.v.plan.id),other.get(variantStateId('p', f.draft.id))], heads);
  assert.equal(f.wires().length, sent); assert.deepEqual(money(other), account);
});

test('5.5 full deep identity isolates a revised scope over the same cell', async t => {
  const f = await ready(t), first = await runDeepResearch(f.store, f.input); assert.ok(first);
  const decision = f.store.get<any>(f.scopeRecord.value.decision.id, f.scopeRecord.value.decision.revision)!;
  const state = f.store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const revised: VariantChoiceScope = { ...f.scope!, operation: 'revise', previous: reference(decision), expectedSelection: reference(state),
    outcome: { ...f.scope!.outcome, reason: 'Same member, new owner scope' } };
  const act = answerVariantChoice(f.store, revised, mint(f.store, revised).authority);
  const scope = publishVariantScope(f.store, 'p', reference(act.decision)).scope;
  const preparation = produceDeepPreparation(f.store, 'p', inputFor(f, scope)).record;
  const second = await runDeepResearch(f.store, { ...f.input, deepPreparation: reference(preparation) }); assert.ok(second);
  assert.deepEqual(first.preparation.preparation.value.cell, second.preparation.preparation.value.cell);
  assert.notEqual(first.intent.id, second.intent.id); assert.notEqual(first.call.id, second.call.id);
  assert.notEqual(first.attempt.id, second.attempt.id);
  assert.deepEqual(readDeepResearchResult(new Store(f.store.path), 'p', reference(first.intent)), first);
});

for (const defect of ['missing','null','foreign','structural'] as const) test(`5.5 ${defect} preparation refuses all explicit entry without writes or payment`, async t => {
  const f = await ready(t);
  const lookalike = f.store.write({ id: 'lookalike-deep', kind: 'discovery-deep-preparation', expected: 0, value: f.preparation.value });
  const value = defect === 'missing' ? undefined : defect === 'null' ? null : defect === 'foreign'
    ? { ...reference(f.preparation), hash: '0'.repeat(64) } : reference(lookalike);
  const input = { ...f.input, deepPreparation: value } as any;
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  assert.throws(() => prepareDeepResearch(f.store, input), EngineError);
  await assert.rejects(runDeepResearch(f.store, input), EngineError);
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, sent);
});

for (const field of ['deepPreparation','deepCell','deepScope'] as const) test(`5.5 common intent rejects missing ${field} and cannot downgrade deep to broad`, async t => {
  const f = await ready(t), prepared = prepareDeepResearch(f.store, f.input);
  const input = structuredClone(prepared.value) as any;
  input.key += '-bad'; delete input.cursor.context[field];
  if (field === 'deepPreparation') delete input.cursor.deepPreparation;
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  assert.throws(() => prepareResearchConsumerIntent(f.store, input), EngineError);
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, sent);
});

test('5.5 immutable origin rejects loss of deep marker in a paid intent head', async t => {
  const f = await ready(t), undo = cut(f, 'before');
  await assert.rejects(runDeepResearch(f.store, f.input), /deep application cut/); undo();
  const intent = deepIntents(f)[0]!, value = structuredClone(intent.value); delete value.cursor.deepPreparation;
  const bad = f.store.write({ id: intent.id, kind: intent.kind, expected: intent.revision, value });
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  for (const store of [f.store, new Store(f.store.path)]) {
    assert.throws(() => applyDeepResearch(store, 'p', reference(bad)), EngineError);
    await assert.rejects(resumeDeepResearch(store, 'p', reference(bad), { restoreOnly: true }), EngineError);
    assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
  }
});

for (const shift of ['mode','selection','plan'] as const) test(`5.5 mandatory reservation guards stop second Store ${shift} before payment`, async t => {
  const f = await ready(t), intent = prepareDeepResearch(f.store, f.input), other = new Store(f.store.path);
  const account = money(f.store), sent = f.wires().length;
  let expected: string | null = null;
  const undo = intercept(f.store, (writes, _guards, write) => {
    if (writes.some(w => w.kind === 'model-call' && w.expected === 0)) {
      if (shift === 'mode') modeOf(other, 'bypass');
      if (shift === 'plan') nextPlan(f, other);
      if (shift === 'selection') {
        const decision = other.get<any>(f.scopeRecord.value.decision.id, f.scopeRecord.value.decision.revision)!;
        const state = other.get<VariantState>(variantStateId('p', f.draft.id))!;
        const scope: VariantChoiceScope = { ...f.scope!, operation: 'revise', previous: reference(decision), expectedSelection: reference(state),
          outcome: { kind: 'reject_all', reason: 'Concurrent owner change before payment' } };
        answerVariantChoice(other, scope, mint(other, scope).authority);
      }
      expected = all(other);
    }
    return write();
  });
  await assert.rejects(resumeDeepResearch(f.store, 'p', reference(intent)), EngineError); undo();
  assert.ok(expected, 'The second Store must run in the real reservation window');
  assert.equal(all(f.store), expected); assert.equal(f.wires().length, sent); assert.deepEqual(money(f.store), account);
});

test('5.5 owner race at application preserves paid deep and the newer current state', async t => {
  const f = await ready(t), other = new Store(f.store.path);
  let ownerState: Ref | null = null;
  const undo = intercept(f.store, (writes, _guards, write) => {
    if (writes.some(w => w.kind === 'research-turn' && w.expected === 0)) {
      const decision = other.get<any>(f.scopeRecord.value.decision.id, f.scopeRecord.value.decision.revision)!;
      const state = other.get<VariantState>(variantStateId('p', f.draft.id))!;
      const scope: VariantChoiceScope = { ...f.scope!, operation: 'revise', previous: reference(decision), expectedSelection: reference(state),
        outcome: { kind: 'reject_all', reason: 'Concurrent owner change before application' } };
      ownerState = reference(answerVariantChoice(other, scope, mint(other, scope).authority).state);
    }
    return write();
  });
  const result = await runDeepResearch(f.store, f.input); undo();
  assert.ok(result); assert.ok(ownerState); assert.deepEqual(reference(f.store.get(variantStateId('p', f.draft.id))!), ownerState);
  assert.deepEqual(readDeepResearchResult(new Store(f.store.path), 'p', reference(result.intent)), result);
});

test('5.5 common application rejects substituted or omitted outputs without any partial terminal write', async t => {
  const f = await ready(t), undo = cut(f, 'before');
  await assert.rejects(runDeepResearch(f.store, f.input), /deep application cut/); undo();
  const intent = deepIntents(f)[0]!, paid = readResearchConsumerExecution(f.store, 'p', reference(intent));
  assert.equal(paid.kind, 'response'); if (paid.kind !== 'response') assert.fail();
  const writes = deepResearchApplication(f.store, intent, paid);
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  for (const mutated of [writes.slice(0,2), writes.map(w => w.kind === 'research-attempt'
    ? { ...w, value: { ...(w.value as any), end: { ...end, text: 'A forged end' } } } : w)]) {
    for (const store of [f.store, new Store(f.store.path)]) {
      assert.throws(() => prepareResearchConsumerApplication(store, reference(intent), reference(paid.call), mutated, [intent.value.owner]),
        { code: 'research_consumer_intent_invalid' });
      assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
    }
  }
});


test('5.5 capacity binds the exact preparation of a real owner-selected cell', async t => {
  const f = await ready(t);
  const intent = prepareDeepResearch(f.store, f.input);
  assert.deepEqual(intent.value.cursor.resultCapacity.bindings.deepPreparation, reference(f.preparation));
  assert.deepEqual(intent.value.cursor.context.deepCell, f.preparation.value.cell);
  assert.deepEqual(intent.value.cursor.context.deepScope, f.scopeRecord.value);
});


test('5.5 another common intent key cannot buy the same preparation and actor twice', async t => {
  const f=await ready(t),intent=prepareDeepResearch(f.store,f.input),input=structuredClone(intent.value);
  input.key += '-another'; const before=all(f.store),accounting=money(f.store),sent=f.wires().length;
  assert.throws(()=>prepareResearchConsumerIntent(f.store,input),e=>e instanceof EngineError);
  assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
});


test('5.5 compact managed context retains the proven deep fields and recovers through the ordinary preparation reader', async t => {
  const f=await ready(t); let captured: ResearchConsumerIntent | null=null;
  const undo=intercept(f.store,(writes,_guards,write)=>{
    const intent=writes.find(w=>w.kind==='research-consumer-intent');
    if(intent){captured=structuredClone(intent.value) as ResearchConsumerIntent;throw new Error('compact preparation cut');}
    return write();
  });
  assert.throws(()=>prepareDeepResearch(f.store,f.input),/compact preparation cut/);undo();
  assert.ok(captured);const input=captured as ResearchConsumerIntent;
  for(const field of ['resultCapacityContract','resultCapacity','resultCapacityPrompt'])delete input.cursor[field];
  const prepared=prepareResearchConsumerIntent(f.store,input,[],{contextContract:CONTEXT_PREPARATION_CONTRACT});
  assert.equal(prepared.value.contract,'research-consumer-intent/v2');
  assert.equal(Object.hasOwn(prepared.value.cursor,'context'),false);
  const result=(await resumeDeepResearch(f.store,'p',reference(prepared)))!;
  assert.deepEqual(result.attempt.value.end,end);
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length,cold=new Store(f.store.path);t.after(()=>cold.close());
  assert.deepEqual(await resumeDeepResearch(cold,'p',reference(prepared),{restoreOnly:true,allowance:0}),result);
  assert.equal(all(cold),before);assert.deepEqual(money(cold),accounting);assert.equal(f.wires().length,sent);
});

test('5.5 deep continues the original broad MR/P run and its next positions, with exact replay and unchanged N', async t => {
  const f = await ready(t), subject = { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: 'q-industry' };
  let baseline = v7ProgressBaseline(f.store, subject);
  assert.equal(baseline.state.kind, 'state');
  const prior = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  const runId = prior.value.summary.cursor.run;
  const oldRun = f.store.get<ResearchRun>(runId)!;
  f.store.write<ResearchRun>({ id: oldRun.id, kind: oldRun.kind, expected: oldRun.revision, value: { ...oldRun.value, limit: 1, status: 'paused', pauseCode: 'research_variant_handoff_unavailable' } });
  const limit = 1;
  const results: NonNullable<Awaited<ReturnType<typeof runDeepResearch>>>[] = [];
  for (let index = 0; index < 2; index++) {
    const owner = f.store.get<ResearchRun>(runId)!, number = owner.value.turns + 1;
    const input: DeepResearchInput = { ...f.input, owner: reference(owner), guards: [(baseline.state as { ref: Ref }).ref] };
    f.reply({ action: 'answer', question: 'q-industry', value: end, citations: [] });
    const result: ProvenDeepResearchResult = (await runDeepResearch(f.store, input))!; results.push(result);
    assert.equal(result.turn.value.run, runId); assert.equal(result.turn.value.number, number);
    assert.equal(f.store.get<ResearchRun>(runId)!.value.limit, limit);
    const packet = projectAttemptPacket(f.store, { ...subject, entries: [{ attempt: reference(result.attempt), binding: reference(result.binding) }] });
    f.reply({ verdict: 'supported', reasons: ['Exact paid deep step'], return: null,
      novelty: { attempts: [{ attempt: reference(result.attempt), reason: 'Exact deep result' }], accepted: [], rejected: [], newContent: [], duplicates: [],
        noProgress: [{ attempt: reference(result.attempt), reason: 'No accessible source' }], transition: null },
      methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } });
    const assessment = await assessAttempts(f.store, packet, baseline, f.environment, f.root);
    applyDiscoveryAssessment(f.store, 'p', reference(assessment));
    baseline = v7ProgressBaseline(f.store, subject);
    const state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
    assert.equal(state.value.summary.cursor.run, runId); assert.equal(state.value.summary.cursor.number, number);
    assert.equal(state.value.summary.count, index + 2);
    const snapshot = all(f.store), account = money(f.store), wires = f.wires().length;
    const cold = new Store(f.store.path); t.after(() => cold.close());
    assert.deepEqual(await runDeepResearch(cold, input, { restoreOnly: true, allowance: 0 }), result);
    assert.equal(all(cold), snapshot); assert.deepEqual(money(cold), account); assert.equal(f.wires().length, wires);
  }
  assert.notEqual(results[0]!.call.id, results[1]!.call.id);
  const pRef = (baseline.state as { ref: Ref }).ref;
  const savedState = readV7ProgressStateAt(f.store, pRef);
  modeOf(f.store, 'bypass');
  const cold = new Store(f.store.path); t.after(() => cold.close());
  const beforeHistorical = all(cold), accountHistorical = money(cold), sentHistorical = f.wires().length;
  assert.deepEqual(readV7ProgressStateAt(cold, pRef), savedState);
  assert.equal(all(cold), beforeHistorical); assert.deepEqual(money(cold), accountHistorical); assert.equal(f.wires().length, sentHistorical);
  const snapshot = all(f.store), account = money(f.store), wires = f.wires().length;
  assert.deepEqual(replayDeepResponse(f.store, f.input.deepPreparation, 'analyst', f.environment.value.implementer.actor, reference(results[0]!.intent))?.research,
    { action: 'answer', question: 'q-industry', value: end, citations: [] });
  assert.throws(() => replayDeepResponse(f.store, f.input.deepPreparation, 'analyst', f.environment.value.implementer.actor), EngineError);
  assert.equal(all(f.store), snapshot); assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, wires);
});

test('5.5 extra frontier guards survive reservation and cannot replace mandatory preparation guards', async t => {
  const f = await ready(t), guardId = 'frontier-test:must-remain-absent';
  const prepared = prepareDeepResearch(f.store, { ...f.input, guards: [{ id: guardId, absent: true }] });
  assert.ok(prepared.value.guards.some(g => g.id === guardId && 'absent' in g));
  const other = new Store(f.store.path); t.after(() => other.close());
  other.write({ id: guardId, kind: 'negative-race-fixture', expected: 0, value: { closed: true } });
  const before = all(f.store), account = money(f.store), wires = f.wires().length;
  await assert.rejects(resumeDeepResearch(f.store, 'p', reference(prepared)), EngineError);
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, wires);
});

test('5.5 explicit linked positions reject absent, foreign and skipped owners before any admission writes', async t => {
  const f = await ready(t), subject = { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: 'q-industry' };
  const baseline = v7ProgressBaseline(f.store, subject);
  assert.equal(baseline.state.kind, 'state');
  const state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  const run = f.store.get<ResearchRun>(state.value.summary.cursor.run)!;
  for (const extra of [{ owner: null }, { owner: { id: run.id } },
    { owner: { ...reference(run), hash: '0'.repeat(64) } }, { owner: reference(run), turn: run.value.turns + 2 }, { owner: reference(run), turn: null }, { owner: reference(run), guards: null }]) {
    const before = all(f.store), account = money(f.store), sent = f.wires().length;
    assert.throws(() => prepareDeepResearch(f.store, { ...f.input, ...extra } as any), EngineError);
    assert.equal(all(f.store), before); assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, sent);
  }

});


test('5.5 a refused reservation leaves its exact paused owner unchanged', async t => {
  const f = await ready(t), subject = { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: 'q-industry' };
  const baseline = v7ProgressBaseline(f.store, subject);
  assert.equal(baseline.state.kind, 'state');
  const state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  const before = f.store.get<ResearchRun>(state.value.summary.cursor.run)!;
  // A runner pause is operational metadata, not a successful paid result or a handoff proof.
  const paused = f.store.write<ResearchRun>({ id: before.id, kind: before.kind, expected: before.revision,
    value: { ...before.value, status: 'paused', pauseCode: 'research_variant_handoff_unavailable', limit: 1 } });
  const intent = prepareDeepResearch(f.store, { ...f.input, owner: reference(paused) });
  const other = new Store(f.store.path); t.after(() => other.close());
  const account = money(f.store), sent = f.wires().length;
  let expected: string | null = null, activated = false;
  const undo = intercept(f.store, (writes, _guards, write) => {
    if (writes.some(w => w.kind === 'model-call' && w.expected === 0)) {
      activated = writes.some(w => w.id === paused.id && w.expected === paused.revision
        && (w.value as ResearchRun).status === 'running');
      modeOf(other, 'bypass');
      expected = all(other);
    }
    return write();
  });
  await assert.rejects(resumeDeepResearch(f.store, 'p', reference(intent)), EngineError); undo();
  assert.ok(expected); assert.equal(activated, true);
  assert.deepEqual(f.store.get(paused.id), paused);
  assert.equal(all(f.store), expected); assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, sent);
});


test('5.5 a prepared head cannot erase its immutable deep identity through the common transport', async t => {
  const f = await ready(t), intent = prepareDeepResearch(f.store, f.input);
  const value = structuredClone(intent.value);
  delete value.cursor.deepPreparation;
  for (const key of ['deepPreparation', 'deepCell', 'deepScope']) delete value.cursor.context[key];
  const masked = f.store.write({ id: intent.id, kind: intent.kind, expected: intent.revision, value });
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  const cold = new Store(f.store.path); t.after(() => cold.close());
  for (const store of [f.store, cold]) {
    await assert.rejects(researchCall(value.role, value.dispatch, value.cursor.instruction, value.cursor.context, undefined,
      { store, draftId: value.draft.id, questionId: value.question.id, purpose: 'analyst',
        consumerIntent: reference(masked), session: value.owner }), EngineError);
    assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
  }
});

function linkedInput(f: Ready): DeepResearchInput {
  const baseline = v7ProgressBaseline(f.store, { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: 'q-industry' });
  assert.equal(baseline.state.kind, 'state');
  const state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  return { ...f.input, owner: reference(f.store.get<ResearchRun>(state.value.summary.cursor.run)!) };
}
function revisedChoice(f: Ready) {
  const previous = f.store.get(f.scopeRecord.value.decision.id, f.scopeRecord.value.decision.revision)!;
  const state = f.store.get(variantStateId('p', f.draft.id))!;
  const scope: VariantChoiceScope = { ...f.scope!, operation: 'revise', previous: reference(previous), expectedSelection: reference(state),
    outcome: { ...f.scope!.outcome, reason: 'A lawful owner revision before the next deep position' } };
  return answerVariantChoice(f.store, scope, mint(f.store, scope).authority);
}
function revisedPreparation(f: Ready) {
  const act = revisedChoice(f);
  const published = publishVariantScope(f.store, 'p', reference(act.decision)).scope;
  return produceDeepPreparation(f.store, 'p', inputFor(f, published)).record;
}
for (const cold of [false, true]) test(`5.345-01 stale unpaid linked admission after owner revise ${cold ? 'cold' : 'hot'}`, async t => {
  const f = await ready(t), first = linkedInput(f), old = prepareDeepResearch(f.store, first);
  const history = f.store.history(old.id), preparation = revisedPreparation(f);
  const input: DeepResearchInput = { ...first, deepPreparation: reference(preparation) };
  const store = cold ? new Store(f.store.path) : f.store; if (cold) t.after(() => store.close());
  const before = all(store), account = money(store), sent = f.wires().length;
  assert.equal(await resumeDeepResearch(store, 'p', reference(old), { restoreOnly: true, allowance: 0 }), null);
  assert.equal(await runDeepResearch(store, input, { restoreOnly: true, allowance: 0 }), null);
  await assert.rejects(runDeepResearch(store, input, { allowance: 0 }), { code: 'research_turns_exhausted' });
  assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
  const oldCalls = new Set(store.list('model-call').map(row => row.id));
  const result = (await runDeepResearch(store, input, { allowance: 1 }))!;
  assert.deepEqual(reference(result.preparation.preparation), reference(preparation));
  assert.notEqual(result.intent.id, old.id); assert.equal(result.intent.value.key, old.value.key);
  assert.equal(result.intent.value.generation, old.value.generation + 1);
  assert.deepEqual(result.intent.value.previous, reference(old));
  assert.deepEqual(result.intent.value.owner, old.value.owner);
  assert.deepEqual(store.history(old.id), history); assert.equal(f.wires().length, sent + 1);
  assert.deepEqual(store.list('model-call').filter(row => !oldCalls.has(row.id)).map(row => row.id), [result.call.id]);
  const run = store.get<ResearchRun>(first.owner!.id)!, origin = store.get<ResearchRun>(first.owner!.id, first.owner!.revision)!;
  assert.equal(run.value.turns, origin.value.turns + 1); assert.equal(run.value.limit, origin.value.limit);
  const saved = all(store), paid = money(store), wire = f.wires().length, fresh = new Store(store.path); t.after(() => fresh.close());
  assert.deepEqual(await runDeepResearch(fresh, input, { restoreOnly: true, allowance: 0 }), result);
  assert.equal(await resumeDeepResearch(fresh, 'p', reference(old), { restoreOnly: true, allowance: 0 }), null);
  assert.equal(all(fresh), saved); assert.deepEqual(money(fresh), paid); assert.equal(f.wires().length, wire);
});

test('5.345-01 a damaged stale preparation binding cannot permit another generation', async t => {
  const f = await ready(t), first = linkedInput(f), old = prepareDeepResearch(f.store, first), preparation = revisedPreparation(f);
  const value = structuredClone(old.value); value.cursor.context.deepCell.criterion = 'A substituted historical cell';
  f.store.write({ id: old.id, kind: old.kind, expected: old.revision, value });
  const input = { ...first, deepPreparation: reference(preparation) }, before = all(f.store), account = money(f.store), sent = f.wires().length;
  const cold = new Store(f.store.path); t.after(() => cold.close());
  for (const store of [f.store, cold]) {
    await assert.rejects(runDeepResearch(store, input, { allowance: 1 }), { code: 'research_consumer_intent_invalid' });
    assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
  }
});

test('5.345-01 a begun old position recovers its paid preparation before a new requested scope', async t => {
  const f = await ready(t), first = linkedInput(f), sent = f.wires().length, undo = cut(f, 'before');
  await assert.rejects(runDeepResearch(f.store, first), /deep application cut/); undo();
  const old = deepIntents(f).find(row => row.value.cursor.run === first.owner!.id)!;
  assert.equal(old.value.state, 'running'); assert.ok(old.value.call);
  const preparation = revisedPreparation(f), input = { ...first, deepPreparation: reference(preparation) };
  const state = f.store.get(variantStateId('p', f.draft.id)), account = money(f.store), wires = f.wires().length;
  const result = (await runDeepResearch(f.store, input, { restoreOnly: true, allowance: 0 }))!;
  assert.equal(result.intent.id, old.id); assert.deepEqual(reference(result.preparation.preparation), first.deepPreparation);
  assert.deepEqual(f.store.get(variantStateId('p', f.draft.id)), state);
  assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, wires); assert.equal(wires, sent + 1);
  const before = all(f.store), cold = new Store(f.store.path); t.after(() => cold.close());
  assert.deepEqual(await runDeepResearch(cold, input, { restoreOnly: true, allowance: 0 }), result);
  assert.equal(all(cold), before); assert.deepEqual(money(cold), account); assert.equal(f.wires().length, wires);
});

test('5.345-01 competing current admissions share one successor generation and one purchase', async t => {
  const f = await ready(t), first = linkedInput(f), old = prepareDeepResearch(f.store, first), history = f.store.history(old.id);
  const preparation = revisedPreparation(f), input = { ...first, deepPreparation: reference(preparation) };
  const other = new Store(f.store.path); t.after(() => other.close());
  let competing: Revision<ResearchConsumerIntent> | null = null, expected: string | null = null;
  const sent = f.wires().length, account = money(f.store);
  const undo = intercept(f.store, (writes, guards, write) => {
    if (writes.some(w => w.kind === 'research-consumer-intent' && (w.value as ResearchConsumerIntent).generation === old.value.generation + 1)) {
      assert.ok(guards.some(guard => canonical(guard) === canonical(reference(old))));
      competing = prepareDeepResearch(other, input); expected = all(other);
    }
    return write();
  });
  assert.throws(() => prepareDeepResearch(f.store, input), EngineError); undo();
  assert.ok(competing); assert.ok(expected); assert.equal(all(f.store), expected);
  assert.deepEqual(money(f.store), account); assert.equal(f.wires().length, sent);
  assert.deepEqual(f.store.history(old.id), history);
  const result = (await runDeepResearch(f.store, input))!;
  assert.equal(result.intent.id, (competing as Revision<ResearchConsumerIntent>).id);
  assert.equal(f.wires().length, sent + 1);
  const before = all(f.store), paid = money(f.store), wires = f.wires().length;
  assert.deepEqual(await runDeepResearch(other, input, { restoreOnly: true, allowance: 0 }), result);
  assert.equal(all(other), before); assert.deepEqual(money(other), paid); assert.equal(f.wires().length, wires);
});

test('5.345-01 a current unpaid admission cannot be replaced by another valid cell at the same position', async t => {
  const f = await ready(t), first = linkedInput(f), old = prepareDeepResearch(f.store, first);
  const preparation = produceDeepPreparation(f.store, 'p', inputFor(f, f.scopeRecord, 'q-market')).record;
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  const cold = new Store(f.store.path); t.after(() => cold.close());
  for (const store of [f.store, cold]) {
    await assert.rejects(runDeepResearch(store, { ...first, deepPreparation: reference(preparation) }), { code: 'discovery_deep_execution_invalid' });
    assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
    assert.deepEqual(store.get(old.id), old);
  }
});

for (const cold of [false, true]) test(`5.345-01 a proven replacement choice releases unpaid admission before its scope exists ${cold ? 'cold' : 'hot'}`, async t => {
  const f = await ready(t), first = linkedInput(f), old = prepareDeepResearch(f.store, first);
  const history = f.store.history(old.id), act = revisedChoice(f);
  const store = cold ? new Store(f.store.path) : f.store; if (cold) t.after(() => store.close());
  const before = all(store), account = money(store), sent = f.wires().length;
  const choice = readCurrentVariantChoice(store, 'p', reference(f.v.draft));
  assert.deepEqual(choice.choice.ref, reference(act.decision));
  assert.deepEqual(reference(choice.state), reference(act.state));
  assert.throws(() => readCurrentVariantScope(store, 'p', reference(f.v.draft)), { code: 'discovery_variant_scope_required' });
  assert.equal(staleUnpaidDeepAdmission(store, old), true);
  assert.equal(await runDeepResearch(store, first, { restoreOnly: true, allowance: 0 }), null);
  assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
  const scope = publishVariantScope(store, 'p', reference(act.decision)).scope;
  const preparation = produceDeepPreparation(store, 'p', inputFor(f, scope)).record;
  const input = { ...first, deepPreparation: reference(preparation) };
  const result = (await runDeepResearch(store, input, { allowance: 1 }))!;
  assert.deepEqual(result.intent.value.previous, reference(old));
  assert.equal(result.intent.value.cursor.turn, old.value.cursor.turn);
  assert.deepEqual(store.history(old.id), history); assert.equal(f.wires().length, sent + 1);
  const saved = all(store), paid = money(store), wires = f.wires().length, fresh = new Store(store.path); t.after(() => fresh.close());
  assert.deepEqual(await runDeepResearch(fresh, input, { restoreOnly: true, allowance: 0 }), result);
  assert.equal(all(fresh), saved); assert.deepEqual(money(fresh), paid); assert.equal(f.wires().length, wires);
});

for (const defect of ['lost-original-scope', 'lost-mode', 'structural-choice'] as const)
test(`5.345-01 ${defect} cannot manufacture a replacement before scope publication`, async t => {
  const f = await ready(t), old = prepareDeepResearch(f.store, linkedInput(f));
  if (defect !== 'lost-original-scope') revisedChoice(f);
  if (defect === 'structural-choice') {
    const state = f.store.get<VariantState>(variantStateId('p', f.draft.id))!;
    const decision = f.store.get(state.value.decision!.id, state.value.decision!.revision)!;
    const fake = f.store.write({ id: 'structural-replacement-choice', kind: decision.kind, expected: 0, value: decision.value });
    f.store.write({ id: state.id, kind: state.kind, expected: state.revision, value: { ...state.value, decision: reference(fake) } });
  } else {
    const sql = new DatabaseSync(f.store.path);
    try { sql.prepare('DELETE FROM heads WHERE entity_id=?').run(defect === 'lost-mode' ? 'project-mode:p' : f.scopeRecord.id); }
    finally { sql.close(); }
  }
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  const orphaned = { scope: f.store.history(f.scopeRecord.id), mode: f.store.history('project-mode:p') };
  const cold = new Store(f.store.path); t.after(() => cold.close());
  for (const store of [f.store, cold]) {
    assert.throws(() => staleUnpaidDeepAdmission(store, old), EngineError);
    assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
    assert.deepEqual({ scope: store.history(f.scopeRecord.id), mode: store.history('project-mode:p') }, orphaned);
  }
});

test('5.345-01 a proven reject_all supersedes unpaid deep without inventing a scope', async t => {
  const f = await ready(t), old = prepareDeepResearch(f.store, linkedInput(f));
  const request: VariantChoiceScope = { ...f.scope!, operation: 'revise', previous: f.scopeRecord.value.decision,
    expectedSelection: reference(f.store.get(variantStateId('p', f.draft.id))!),
    outcome: { kind: 'reject_all', reason: 'The owner rejects every variant before the unpaid deep operation' } };
  const act = answerVariantChoice(f.store, request, mint(f.store, request).authority);
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  const cold = new Store(f.store.path); t.after(() => cold.close());
  for (const store of [f.store, cold]) {
    const current = readCurrentVariantChoice(store, 'p', reference(f.v.draft));
    assert.deepEqual(current.choice.ref, reference(act.decision)); assert.equal(current.choice.value.outcome.kind, 'reject_all');
    assert.equal(staleUnpaidDeepAdmission(store, old), true);
    assert.throws(() => readCurrentVariantScope(store, 'p', reference(f.v.draft)), { code: 'discovery_variant_scope_required' });
    assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
  }
});

// Every masked door re-derives the old admission through the opaque view (no kept proof), so hot and cold are two tests.
for (const cold of [false, true])
test(`5.345-01 current-choice proof refuses missing state, decision, grant, session, set and member ${cold ? 'cold' : 'hot'}`, async t => {
  const f = await ready(t), old = prepareDeepResearch(f.store, linkedInput(f)), act = revisedChoice(f);
  const before = all(f.store), account = money(f.store), sent = f.wires().length;
  const store = cold ? new Store(f.store.path) : f.store; if (cold) t.after(() => store.close());
  const missing = [
    { id: variantStateId('p', f.draft.id), headOnly: true },
    { id: act.decision.id }, { id: act.decision.value.authority.grant.id },
    { id: act.decision.value.authority.session.id }, { id: f.scopeRecord.value.set.id }, { id: f.scopeRecord.value.member.id },
  ];
  for (const absent of missing) {
    const view = storeView(store, { get: (id, revision) => id === absent.id && (!absent.headOnly || revision === undefined) ? null : undefined,
      write: () => { throw new Error('A read-only proof attempted a write'); } });
    assert.throws(() => staleUnpaidDeepAdmission(view, old), EngineError, absent.id);
    assert.throws(() => readCurrentVariantChoice(view, 'p', reference(f.v.draft)), EngineError, absent.id);
    assert.equal(all(store), before); assert.deepEqual(money(store), account); assert.equal(f.wires().length, sent);
  }
});
