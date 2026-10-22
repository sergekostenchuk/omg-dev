import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { canonical, hashJson, type Json } from '../src/canonical.js';
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
import { prepareVariantSession, applyVariantSession, readVariantGeneration } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, variantRecordId, type VariantSubject,
  type VariantSet, type VariantNone, type DiscoveryVariant } from '../src/discovery/discovery-variants.js';
import { variantStateId } from '../src/discovery/variant-decision.js';
import { variantGenerationSummary } from '../src/discovery/projection-reader.js';
import { stageSummary, renderStageSummary, type VariantGenerationSummaryRequest } from '../src/product/stage-summary.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

// Genuine producer: paid K -> assessment/P -> 4T.1 snapshot -> paid 4B.1 publication.
// The control mode and frame/plan preparation retain the explicit fixtures of 4B.1.
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const judgement = { conclusion: 'Bounded by the actual sweep', grounds: [], assumptions: ['Bounded assumption'], unknowns: ['No evidence beyond the saved sweep'],
  quantity: { unit: 'weeks', minimum: 1, maximum: 2, limitations: 'Estimate only', grounds: [] } };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, { ...judgement, quantity: null }]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'One shared scale from low to high']));
function generation(count: number, grounds: Ref[] = []) {
  const boundedCriteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key,
    { ...judgement, grounds, quantity: { ...judgement.quantity, grounds } }]));
  return { action: 'variants', variants: Array.from({ length: count }, (_, i) => ({ key: `v${i + 1}`, title: `Variant ${i + 1}`,
    proposal: { scope: `scope-${i + 1}` }, criteria: grounds.length ? boundedCriteria : criteria })), scale,
    comparison: `${count} bounded variants on one scale`, recommendation: { key: `v${count}`, reason: 'Fits the snapshot best' },
    searchLimits: ['Only the saved sweep'], unknowns: ['Demand stays unknown'] };
}
const none = (grounds: Ref[]) => ({ action: 'no_variants', reasons: [{ code: 'snapshot_insufficient', message: 'The sweep supports no bounded variant', grounds }],
  searchLimits: ['Only the saved sweep'], unknowns: ['Demand stays unknown'] });

async function setup(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-4r3-' }), project = 'p';
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
  const mode = f.store.write({ id: 'mode-fixture:p', kind: 'mode-fixture', expected: 0, value: { projectId: project, mode: 'questions' } });
  const cal = f.store.write({ id: 'transport-fixture:calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  const calibration: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(cal), mode: reference(mode), expectedSelection: null };
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: generation(1) }));
  await researchCall(f.environment.value.implementer, f.environment.value, 'Calibrate variants', { variantSubject: calibration, history: [] }, undefined,
    { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  const input = { projectId: project, variantSubject: { ...calibration, snapshot: reference(saved) }, environment: f.environment,
    role: f.environment.value.implementer, prompt: 'Propose variants from this exact saved sweep' };
  const reply = (answer: unknown) => writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: answer }));
  /** The real managed paid call, without its application: the paid answer is saved before anything is published. */
  async function pay(store = f.store) {
    const prepared = prepareVariantSession(store, input), v = prepared.intent.value;
    await researchCall(v.role, v.dispatch, v.cursor.prompt, v.cursor.context, undefined,
      { store, draftId: v.draft.id, questionId: v.question.id, purpose: v.kind, consumerIntent: reference(prepared.intent), session: v.owner });
    return store.get<ResearchConsumerIntent>(prepared.intent.id)!;
  }
  return { ...g, project, input, mode, saved, reply, pay };
}

const request = (result: Ref): VariantGenerationSummaryRequest => ({ section: 'variant-generation', result });
for (const count of [1, 2, 3]) {
  test(`4R.3 generation: ${count} real paid member(s), shared scale, recommendation, author and bounds stay exact and read-only`, async t => {
    const f = await setup(t);
    f.reply(generation(count, [reference(f.saved)]));
    const running = await f.pay(), receipt = applyVariantSession(f.store, f.project, reference(running));
    const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, ref = reference(set);
    const before = history(f.store), sent = f.wires().length;
    const summary = stageSummary(f.store, f.project, 'discovery', request(ref));
    const g = summary.generation;
    assert.equal(summary.contract, 'stage-summary/variant-generation/v1');
    assert.equal(g.verification, 'proven'); assert.equal(g.kind, 'variants');
    if (g.kind !== 'variants') assert.fail('Expected proven variants');
    assert.deepEqual(g.result, ref); assert.deepEqual(g.draft, receipt.value.draft); assert.deepEqual(g.snapshot, reference(f.saved));
    assert.deepEqual(g.members, set.value.members.map(member => ({ ref: member, value: f.store.get<DiscoveryVariant>(member.id, member.revision)!.value })));
    assert.equal(g.members.length, count); assert.deepEqual(g.scale, set.value.scale); assert.equal(g.comparison, set.value.comparison);
    assert.deepEqual(g.recommendation, set.value.recommendation); assert.deepEqual(g.recommendation.member, g.members[count - 1]!.ref);
    assert.deepEqual(g.author, { kind: 'model', actor: f.input.role.actor, session: reference(receipt), ...set.value.origin });
    assert.deepEqual(g.author.intent, reference(running)); assert.deepEqual(g.author.call, receipt.value.result!.call);
    assert.deepEqual(g.publicationState, readVariantGeneration(f.store, f.project, ref).state);
    assert.deepEqual(g.choice, { status: 'incomplete', reason: 'variant_decisions_unsupported' });
    assert.deepEqual([g.searchLimits, g.unknowns], [set.value.searchLimits, set.value.unknowns]);
    const text = renderStageSummary(summary);
    for (const value of ['Опубликованные варианты', 'Общая шкала', 'Рекомендация модели:', 'Рекомендация не устанавливает выбор', 'Допущения:', 'Количественная оценка:',
      'Only the saved sweep', 'Demand stays unknown', 'Bounded assumption', f.input.role.actor, ref.hash, g.snapshot.hash]) assert.ok(text.includes(value), value);
    for (const member of g.members) assert.ok(text.includes(member.ref.hash));
    assert.ok(!text.includes('Доказанные варианты')); assert.ok(!text.includes('Вопрос:')); assert.ok(!Object.hasOwn(g, 'previous'));
    assert.deepEqual(variantGenerationSummary(f.store, f.project, ref), g);
    const cold = f.open();
    assert.deepEqual(stageSummary(cold, f.project, 'discovery', request(ref)), summary);
    assert.equal(renderStageSummary(stageSummary(cold, f.project, 'discovery', request(ref))), text);
    assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, sent);
  });
}

test('4R.3 generation: genuine no_variants is a published result with reasons, distinct from incomplete choice and missing input', async t => {
  const f = await setup(t); f.reply(none([reference(f.saved)]));
  const running = await f.pay(); applyVariantSession(f.store, f.project, reference(running));
  const record = f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const before = history(f.store), sent = f.wires().length;
  const summary = stageSummary(f.store, f.project, 'discovery', request(reference(record))), g = summary.generation;
  assert.equal(g.kind, 'no_variants');
  if (g.kind !== 'no_variants') assert.fail('Expected proven no_variants');
  assert.equal(g.verification, 'proven'); assert.deepEqual(g.reasons, record.value.reasons);
  assert.deepEqual([g.searchLimits, g.unknowns], [record.value.searchLimits, record.value.unknowns]);
  assert.equal(g.choice.status, 'incomplete'); assert.ok(!Object.hasOwn(g, 'recommendation')); assert.ok(!Object.hasOwn(g, 'members'));
  const text = renderStageSummary(summary);
  for (const value of ['Опубликован результат no_variants', 'snapshot_insufficient', f.saved.hash, 'Demand stays unknown', 'Only the saved sweep'])
    assert.ok(text.includes(value), value);
  assert.ok(!text.includes('Рекомендация модели:'));
  assert.throws(() => stageSummary(f.store, f.project, 'discovery', request({ ...reference(record), revision: 99 })), EngineError);
  assert.deepEqual(stageSummary(f.open(), f.project, 'discovery', request(reference(record))), summary);
  assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, sent);
});

for (const moved of ['mode', 'state'] as const) {
  test(`4R.3 generation: saved paid answer after ${moved} moves has an exact cold summary without claiming today's selection`, async t => {
    const f = await setup(t); f.reply(generation(2));
    const running = await f.pay(), sent = f.wires().length;
    const draft = prepareVariantSession(f.store, f.input).session.value.draft;
    const stateId = variantStateId(f.project, draft.id);
    if (moved === 'mode') f.store.write({ id: f.mode.id, kind: f.mode.kind, expected: f.mode.revision, value: { projectId: f.project, mode: 'bypass' } });
    else f.store.write({ id: stateId, kind: 'discovery-variant-state', expected: 0, value: { fixture: 'concurrent selection', decision: 'not proved', actor: 'owner-lookalike' } });
    f.reply(generation(3)); // The saved paid two-member result remains the source.
    const receipt = applyVariantSession(f.open(), f.project, reference(running));
    const set = f.store.list<VariantSet>('discovery-variant-set')[0]!;
    const before = history(f.store), state = f.store.get(stateId);
    const summary = stageSummary(f.open(), f.project, 'discovery', request(reference(set))), g = summary.generation;
    assert.equal(g.kind, 'variants'); if (g.kind !== 'variants') assert.fail();
    assert.equal(g.members.length, 2); assert.equal(g.publicationState, null);
    assert.deepEqual(g.author, { kind: 'model', actor: receipt.value.actor, session: reference(receipt), ...receipt.value.result! });
    assert.equal(g.choice.status, 'incomplete'); assert.ok(!Object.hasOwn(g, 'previous'));
    const text = renderStageSummary(summary);
    assert.ok(text.includes('Историческое состояние публикации: не записывалось'));
    assert.ok(text.includes('текущий выбор и цепочка решений этой секцией не доказаны'));
    assert.ok(!text.includes('owner-lookalike'));
    assert.deepEqual(history(f.store), before);
    for (let i = 0; i < 30; i++) f.store.write({ id: `unrelated-${i}`, kind: 'unrelated', expected: 0, value: { projectId: 'foreign', decision: 'choose', actor: 'owner' } });
    const afterUnrelated = history(f.store);
    assert.deepEqual(stageSummary(f.open(), f.project, 'discovery', request(reference(set))), summary);
    assert.deepEqual(f.store.get(stateId), state);
    assert.deepEqual(history(f.store), afterUnrelated); assert.equal(f.wires().length, sent);
  });
}

test('4R.3 generation: foreign set/member/origin and structural copies cannot acquire a generation author or recommendation', async t => {
  const f = await setup(t); f.reply(generation(2));
  const running = await f.pay(), receipt = applyVariantSession(f.store, f.project, reference(running));
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, [first, second] = set.value.members;
  const member = f.store.get<DiscoveryVariant>(first!.id, first!.revision)!;
  const forge = <T extends { projectId: string }>(kind: string, value: T) => reference(f.store.write({ id: variantRecordId(kind, value), kind, expected: 0, value: value as unknown as Json }));
  const foreignMember = forge('discovery-variant', { ...member.value, projectId: 'other' });
  const foreignSet = forge('discovery-variant-set', { ...set.value, projectId: 'other' });
  const mixed = forge('discovery-variant-set', { ...set.value, members: [foreignMember, second!] });
  const origin = forge('discovery-variant-set', { ...set.value, origin: { ...set.value.origin, call: receipt.value.result!.response } });
  const forgedAuthor = forge('discovery-variant-set', { ...set.value, origin: { ...set.value.origin, intent: reference(f.saved) } });
  const before = history(f.store), sent = f.wires().length;
  for (const store of [f.store, f.open()]) {
    for (const bad of [foreignSet, mixed, origin, forgedAuthor, foreignMember, reference(f.saved)])
      assert.throws(() => stageSummary(store, f.project, 'discovery', request(bad)), EngineError);
    assert.throws(() => stageSummary(store, 'other', 'discovery', request(reference(set))), EngineError);
    assert.equal(stageSummary(store, f.project, 'discovery', request(reference(set))).generation.verification, 'proven');
  }
  assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, sent);
});

test('4R.3 generation: missing exact result, extra decision/current-state fields and another stage are typed refusals', async t => {
  const f = await setup(t); f.reply(generation(1)); const running = await f.pay(); applyVariantSession(f.store, f.project, reference(running));
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, valid = request(reference(set));
  const before = history(f.store), sent = f.wires().length;
  for (const input of [{ section: 'variant-generation' }, { ...valid, result: null }, { ...valid, result: { id: set.id } },
    { ...valid, decision: reference(set) }, { ...valid, previous: null }, { ...valid, actor: 'owner' }, { ...valid, state: 'chosen' }])
    assert.throws(() => stageSummary(f.store, f.project, 'discovery', input as any),
      (error: unknown) => error instanceof EngineError && error.code === 'stage_summary_variant_request_invalid');
  const inheritedSection = Object.assign(Object.create({ section: 'variant-generation' }), { result: reference(set), actor: 'owner' });
  assert.throws(() => stageSummary(f.store, f.project, 'discovery', inheritedSection),
    (error: unknown) => error instanceof EngineError && error.code === 'stage_summary_variant_request_invalid');
  assert.throws(() => stageSummary(f.store, f.project, 'concept', valid as any),
    (error: unknown) => error instanceof EngineError && error.code === 'stage_summary_variant_request_invalid');
  assert.throws(() => stageSummary(f.store, f.project, 'discovery', { result: reference(set) } as any),
    (error: unknown) => error instanceof EngineError && error.code === 'stage_summary_index_request_invalid');
  assert.deepEqual(history(f.store), before); assert.equal(f.wires().length, sent);
  assert.ok(canonical(valid).includes(set.hash));
});
