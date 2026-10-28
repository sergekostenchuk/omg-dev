// OMG-V7-BUDGET-REENTRY: re-entry of a stopped route by the proved later owner increase, and the forecast gates which keep it from buying.
// The worlds and helpers are shared with discovery-v7-budget-reentry-control.test.ts through discovery-v7-budget-reentry-fixture.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { readBudgetStopReentry } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { type ResearchRun } from '../src/discovery/research-model.js';
import { type ModelCall } from '../src/runtime/model-usage.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { readEffectiveStageBudget, DISCOVERY_V7_STAGE_BUDGET_KEY } from '../src/discovery/stage-token-budget.js';
import { budgetUsage, raiseWorkingLimit } from '../src/runtime/research-budget.js';
import { money, deepCalls, deepIntents, inert, stopped, increase, driver, refusedByBothDoors, continueBothDoors, oldSnapshot, assertAdvanced } from './discovery-v7-budget-reentry-fixture.js';

for (const door of ['researcher', 'driver'] as const) test(`budget re-entry: ${door} uses the proved later owner increase; paid progress and old snapshot survive hot/cold`, async t => {
  const f = await stopped(t), before = readEffectiveStageBudget(f.store, 'p').segment!;
  const oldUsage = budgetUsage(f.store, before), paid = deepCalls(f).length;
  const oldProgress = deepPlanSelection(f.store, 'p', f.scope).progress;
  const oldCalls = money(f.store).filter(row => row.kind === 'model-call').map(reference);
  const raised = increase(f);
  assert.equal(raised.segment.value.initialGroupLimit, before.value.initialGroupLimit);
  assert.equal(raised.segment.value.completionReserve, 2_000_000);
  assert.deepEqual(budgetUsage(f.store, raised.segment), { ...oldUsage, guards: [reference(raised.segment), ...oldUsage.guards.slice(1)], remaining: oldUsage.remaining + 4_000_000 });
  await inert(f, f.store, async () => assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), true));
  // Driver is deliberately cold after the increase; Researcher uses the live Store.
  const store = door === 'driver' ? f.open() : f.store;
  if (door === 'driver') {
    const result = await driver(f, store); assert.equal(result.end, 'stage_paused');
    assert.equal(result.budget.turnsUsed, 1); assert.equal(result.budget.callsMade, 2); assert.equal(result.budget.callsRemaining, 0);
  } else await f.run(1, store);
  const progress = assertAdvanced(f, paid).progress;
  assert.deepEqual(progress.find(row => row.question === 'q-one'), oldProgress.find(row => row.question === 'q-one'));
  assert.equal(progress.find(row => row.question === 'q-two')!.summary!.count,
    oldProgress.find(row => row.question === 'q-two')!.summary!.count + 1);
  const latest = deepIntents(f.store).find(row => row.value.cursor.subject?.planQuestionId === 'q-two')!;
  assert.equal(latest.value.cursor.run, f.original.id);
  assert.equal(latest.value.cursor.turn, f.original.value.turns + 1);
  for (const ref of oldCalls) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref);
  assert.ok(budgetUsage(f.store, readEffectiveStageBudget(f.store, 'p').segment!).measured > oldUsage.measured);
  await oldSnapshot(f); await oldSnapshot(f, f.open());
  // Recovery alone cannot use the new allowance to buy a third deep position.
  await f.run(1, f.store, true);
  assert.equal(deepCalls(f).length, paid + 1);
  if (door === 'driver') {
    // The first bounded invocation leaves the selected cell open. A second
    // cold driver invocation must continue this exact stopped route.
    const first = f.store.get<ResearchRun>(f.original.id)!;
    assert.equal(first.value.pauseCode, 'research_deep_frontier_pending');
    const again = await driver(f, f.open());
    assert.equal(again.budget.turnsUsed, 1); assert.equal(again.budget.callsMade, 2);
    assert.equal(deepCalls(f).length, paid + 2);
    const next = deepIntents(f.store).find(row => row.value.cursor.turn === first.value.turns + 1)!;
    assert.equal(next.value.cursor.run, f.original.id);
    assert.equal(next.value.cursor.subject?.planQuestionId, 'q-two');
    await oldSnapshot(f, f.open());
    const oldPaid = money(f.store), oldWire = f.wires();
    f.nextEdition();
    const afterEdition = money(f.store), afterEditionWire = f.wires();
    assert.deepEqual(afterEdition, oldPaid); assert.deepEqual(afterEditionWire, oldWire);
    const changed = await driver(f, f.open());
    assert.equal(changed.budget.callsMade, 0);
    assert.deepEqual(money(f.store), afterEdition); assert.deepEqual(f.wires(), afterEditionWire);
  }
});

test('budget re-entry: working group stays blocked after owner increase and resumes only after its own Optimization', async t => {
  const f = await stopped(t, 20_000_000), raised = increase(f);
  const usage = budgetUsage(f.store, raised.segment), paid = deepCalls(f).length;
  assert.ok(usage.measured > 20_000_000);
  await inert(f, f.store, async () => {
    assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), false);
    assert.deepEqual(await f.run(1), f.original);
    assert.equal((await driver(f)).reason?.dossier?.hash, f.details.dossier.hash);
  });
  const required = usage.measured + 100_000;
  raiseWorkingLimit(f.store, raised.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', raised.segment.value.initialGroupLimit,
    { reason: 'One missing exact deep cell', progress: 'The first cell has a paid applied P', required,
      options: [{ method: 'Reuse the paid first cell', saved: 0, decision: 'accept', quality: 'No evidence removed', preserved: ['q-two'] }],
      obligations: ['q-two'], forecast: 'A calibrated deep call and its calibrated MR', basis: [f.details.stop] }, 24_000_000);
  await f.run(1, f.open()); assertAdvanced(f, paid);
  await oldSnapshot(f);
});

test('budget re-entry: a forecast over the working group preserves the unpaid owner until its own increase', async t => {
  const f = await stopped(t), raised = increase(f);
  // One real measured v6 call establishes the forecast for both public doors.
  const environment = f.engine.environments.effective('p').environment;
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Measure analyst', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  f.configure({ analystTokens: 2_000_000 });
  await researchCall(environment.value.implementer, environment.value, 'Measure analyst ' + 'x'.repeat(80_000), {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  f.configure({ analystTokens: 10 });
  const { intent } = await refusedByBothDoors(f, 'discovery_budget_reserve');
  const usage = budgetUsage(f.store, raised.segment);
  const beforeIncreases = readEffectiveStageBudget(f.store, 'p').increases;
  raiseWorkingLimit(f.store, raised.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', raised.segment.value.initialGroupLimit,
    { reason: 'The measured next analyst exceeds the old group', progress: 'The exact first cell is paid',
      required: usage.measured + 3_000_000,
      options: [{ method: 'Reuse the paid first cell', saved: 0, decision: 'accept', quality: 'No evidence removed', preserved: ['q-two'] }],
      obligations: ['q-two'], forecast: 'The measured analyst and its calibrated MR', basis: [f.details.stop] }, 24_000_000);
  await continueBothDoors(t, f, intent, beforeIncreases);
});

test('budget re-entry: a paid analyst survives an MR working-limit pause until the remaining MR is admitted', async t => {
  const f = await stopped(t), raised = increase(f);
  const environment = f.engine.environments.effective('p').environment;
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Measure pending reviewer', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  // Real reviewer calibration makes its reserve exceed the group while the
  // analyst still fits. The old analyst stays paid throughout recovery.
  f.configure({ analystTokens: 2_000_000 });
  await researchCall(environment.value.reviewer, environment.value,
    'Measure pending reviewer ' + 'x'.repeat(200_000), {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'assessor' });
  f.configure({ analystTokens: 10, assessorTokens: 10 });
  const before = deepCalls(f).length;
  const assessments = () => f.wires().filter(row => row.subject.assessmentSubject);
  const beforeAssessments = assessments().length;
  const first = await driver(f);
  const paused = f.store.get<ResearchRun>(f.original.id)!;
  const usage = budgetUsage(f.store, raised.segment);
  const afterAnalyst = deepCalls(f);
  assert.equal(first.budget.callsMade, 1);
  assert.equal(afterAnalyst.length, before + 1);
  assert.equal(assessments().length, beforeAssessments);
  assert.equal(paused.value.pauseCode, 'discovery_budget_reserve');
  assert.equal(JSON.parse(paused.value.error!).details.cause, 'budget_question_limit');
  const paidDeep = afterAnalyst.at(-1), paid = money(f.store), wire = f.wires();
  const analyst = deepIntents(f.store).find(row => row.value.kind === 'analyst'
    && row.value.cursor.subject?.planQuestionId === 'q-two')!;
  assert.ok(analyst); assert.equal(analyst.value.state, 'applied');
  const analystCalls = f.store.list<ModelCall>('model-call').filter(row => row.value.consumerIntent?.id === analyst.id);
  assert.equal(analystCalls.length, 1);
  const increaseRefs = readEffectiveStageBudget(f.store, 'p').increases;
  // Neither the default driver nor a second invocation while the working
  // limit remains blocked may acquire a fresh analyst or reviewer call.
  const disabled = await new ProductEngine(f.open()).earlyStages.run({ project: 'p', draftId: f.v.draft.id, maxTurns: 1, maxCalls: 2 });
  assert.equal(disabled.budget.callsMade, 0);
  const blocked = await driver(f, f.open());
  assert.equal(blocked.budget.callsMade, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  raiseWorkingLimit(f.store, raised.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', raised.segment.value.initialGroupLimit,
    { reason: 'The already paid analyst needs its measured MR', progress: 'q-two analyst is paid; no MR was sent',
      required: usage.measured + 3_000_000,
      options: [{ method: 'Reuse the exact paid analyst', saved: 0, decision: 'accept', quality: 'Keep the full paid answer', preserved: ['q-two'] }],
      obligations: ['q-two'], forecast: 'The measured reviewer requires 2.2M reserve', basis: [f.details.stop] }, 24_000_000);
  const resumed = await driver(f, f.open(), 1, 1);
  const afterReviewer = deepCalls(f);
  assert.equal(resumed.budget.callsMade, 1, JSON.stringify(resumed.reason));
  assert.equal(assessments().length, beforeAssessments + 1);
  assert.equal(afterReviewer.length, before + 1);
  assert.deepEqual(afterReviewer.at(-1), paidDeep);
  assert.deepEqual(f.store.get<ResearchConsumerIntent>(analyst.id), analyst);
  assert.deepEqual(f.store.list<ModelCall>('model-call').filter(row => row.value.consumerIntent?.id === analyst.id), analystCalls);
  assert.deepEqual(f.wires().slice(0, wire.length), wire);
  assert.deepEqual(readEffectiveStageBudget(f.store, 'p').increases, increaseRefs);
  assertAdvanced(f, before); await oldSnapshot(f, f.open());
});

test('budget re-entry: owner permission cannot replace the real dispatch forecast', async t => {
  const f = await stopped(t); increase(f);
  const current = f.engine.environments.effective('p').environment;
  const uncalibrated = f.engine.environments.configure('p', { ...current.value,
    implementer: { ...current.value.implementer, model: 'uncalibrated-owner-reentry' } }, current.revision);
  assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), true);
  const { paused, intent, message } = await refusedByBothDoors(f, 'budget_estimate_missing');
  assert.match(message, /No comparable measured calls/);
  assert.equal(paused.value.pauseCode, 'research_deep_frontier_pending', paused.value.error!);
  assert.equal(deepCalls(f).length, 1);
  // Calibrate the same actor/model once through ordinary paid transport. The
  // saved checkpoint and exact owner then feed both independent public doors.
  const beforeIncreases = readEffectiveStageBudget(f.store, 'p').increases;
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Calibrate next analyst', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  await researchCall(uncalibrated.value.implementer, uncalibrated.value, 'Calibrate', {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  await continueBothDoors(t, f, intent, beforeIncreases);
});

test('budget re-entry: one-call invocations recover the same paid deep step without paying for it again', async t => {
  const f = await stopped(t); increase(f);
  const first = await driver(f, f.store, 1, 1);
  const firstDeep = deepCalls(f);
  assert.equal(first.budget.callsMade, 1); assert.equal(firstDeep.length, 2);
  const intents = deepIntents(f.store).filter(row => row.value.kind === 'analyst'
    && row.value.cursor.subject?.planQuestionId === 'q-two');
  assert.equal(intents.length, 1); const intent = intents[0]!;
  const call = f.store.list<ModelCall>('model-call').find(row => row.value.consumerIntent?.id === intent.id);
  assert.ok(call); const deep = firstDeep.at(-1);
  const second = await driver(f, f.open(), 1, 1);
  const recoveredDeep = deepCalls(f);
  assert.equal(second.budget.callsMade, 1); assert.equal(recoveredDeep.length, 2);
  assert.deepEqual(recoveredDeep.at(-1), deep);
  const recovered = f.store.get<ResearchConsumerIntent>(intent.id)!;
  assert.ok(recovered); assert.deepEqual(recovered.value.cursor, intent.value.cursor);
  assert.equal(f.store.list<ModelCall>('model-call').filter(row => row.value.consumerIntent?.id === intent.id).length, 1);
  assert.equal(f.store.list<ModelCall>('model-call').find(row => row.value.consumerIntent?.id === intent.id)!.id, call.id);
  assertAdvanced(f, 1); await oldSnapshot(f, f.open());
});
