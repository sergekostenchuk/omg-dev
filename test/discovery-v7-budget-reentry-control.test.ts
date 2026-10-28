// OMG-V7-BUDGET-REENTRY: what the re-entry must refuse (no owner increase, forged chains, policy, control, busy / stopped holds) and how it recovers from
// cuts and races between Stores. The worlds and helpers are shared with discovery-v7-budget-reentry.test.ts through discovery-v7-budget-reentry-fixture.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { type DiscoveryDraft } from '../src/discovery/discovery.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { stopRun, acquireRunExecution, releaseRunExecution, readRunControl } from '../src/om/run-control.js';
import { ProductEngine } from '../src/product/engine.js';
import { BudgetReentry, readBudgetStopReentry } from '../src/discovery/research-runner.js';
import { prepareResearchEnvelope, researchCall, resumeDossierResearchCall, withResearchRunControl } from '../src/discovery/research-protocol.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { runDossierAssessmentSession } from '../src/discovery/assessment-session.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { type ModelCall } from '../src/runtime/model-usage.js';
import { variantStateId, type VariantState } from '../src/discovery/variant-decision.js';
import { hashJson } from '../src/canonical.js';
import { deepPlanSelection } from '../src/discovery/v7-plan-questions.js';
import { readEffectiveStageBudget, stageBudgetIncreaseId } from '../src/discovery/stage-token-budget.js';
import { history, interceptWrites, build, bind, money, choiceScope, owner, deepCalls, deepIntents, inert, ready, copyWorld, saveWorld, stopped, increase, driver, oldSnapshot, assertAdvanced } from './discovery-v7-budget-reentry-fixture.js';

// The route below is walked one owner act at a time: the stopped route (0), its choice revised (1), the budget increased on top
// of the revision (2), a new plan edition on top of both (3). Each state has its own test; the acts are the same and come in the
// same order, and an inert window changes nothing, so a state does not depend on the windows of the states before it.
async function walked(t: test.TestContext, acts: 0 | 1 | 2 | 3) {
  const f = await stopped(t);
  if (acts >= 1) {
    const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
    owner(f.store, { ...choiceScope(f), operation: 'revise', previous: state.value.decision!, expectedSelection: reference(state) });
  }
  if (acts >= 2) increase(f);
  if (acts >= 3) f.nextEdition();
  return f;
}

test('budget re-entry: without an owner increase restoreOnly and the ordinary driver cannot buy research', async t => {
  const f = await walked(t, 0);
  // Exact old D6 pauses are inert in restoreOnly. A normal invocation may now
  // spend the completion reserve on D6, while the ordinary driver and the
  // re-entry reader below must still reject another research purchase.
  await inert(f, f.store, async () => {
    assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), false);
    assert.deepEqual(await f.run(20, f.store, true), f.original);
    await driver(f); assert.equal(deepCalls(f).length, 1);
  });
});

test('budget re-entry: a revised owner choice leaves restoreOnly unable to buy research', async t => {
  const f = await walked(t, 1);
  await inert(f, f.store, async () => assert.deepEqual(await f.run(20, f.store, true), f.original));
});

test('budget re-entry: an owner increase after a revised choice does not re-enter the stopped route', async t => {
  const f = await walked(t, 2);
  await inert(f, f.store, async () => {
    assert.equal(await readBudgetStopReentry(f.store, 'p', f.v.draft.id, f.details.stop), false);
    assert.deepEqual(await f.run(1, f.store, true), f.original);
    assert.equal((await driver(f)).budget.callsMade, 0);
  });
});

test('budget re-entry: a new plan edition leaves restoreOnly, the driver and zero allowances unable to buy research', async t => {
  const f = await walked(t, 3);
  await inert(f, f.store, async () => {
    assert.deepEqual(await f.run(1, f.store, true), f.original);
    assert.equal((await driver(f)).budget.callsMade, 0);
    assert.deepEqual(await f.run(1, f.store, true), f.original);
    await driver(f, f.store, 0, 2); await driver(f, f.open(), 1, 0);
    await assert.rejects(f.run(0), { code: 'research_budget_invalid' });
  });
});

test('budget re-entry: forged, absent and foreign increase chains refuse without history, money or wire changes', async t => {
  for (const corruption of ['no-act', 'foreign-act', 'missing-authority'] as const) {
    const f = await stopped(t);
    const previous = readEffectiveStageBudget(f.store, 'p').segment!;
    if (corruption === 'no-act') f.store.write({ id: previous.id, kind: previous.kind, expected: previous.revision,
      value: { ...previous.value, limit: 24_000_000 } });
    else {
      const raised = increase(f);
      // Append an untrusted policy revision and its forged first act. Historical
      // accepted revisions are untouched; a later head cannot authorize itself.
      const body = { ...raised.segment.value, limit: 25_000_000 };
      const next = { id: raised.segment.id, revision: raised.segment.revision + 1, hash: hashJson(body) };
      const value = { ...raised.increase.value, previous: reference(raised.segment), segment: next, limit: body.limit } as any;
      if (corruption === 'foreign-act') value.project = 'foreign-project';
      else delete value.authority;
      f.store.writeMany([{ id: raised.segment.id, kind: raised.segment.kind, expected: raised.segment.revision, value: body },
        { id: stageBudgetIncreaseId('p', next.revision), kind: raised.increase.kind, expected: 0, value }]);
    }
    const store = corruption === 'no-act' ? f.store : f.open();
    await inert(f, store, async () => {
      await assert.rejects(f.run(1, store), error => /^discovery_budget_/.test((error as any).code));
      const result = await driver(f, store);
      assert.match(result.reason?.code ?? '', /^discovery_budget_/);
    });
  }
});

test('budget re-entry: a cut after the paid MR restores its original P before another send', async t => {
  const f = await stopped(t); increase(f);
  let cut = false;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    if (!cut && writes.some(row => row.kind === 'v7-progress-application')) {
      cut = true; throw new Error('budget re-entry cut before P');
    }
    return commit();
  });
  await f.run(1); restore(); assert.ok(cut);
  const intents = deepIntents(f.store), paid = money(f.store), wire = f.wires();
  assert.equal(deepCalls(f).length, 2);
  const held = acquireRunExecution(f.store, { project: 'p' }); assert.ok(held.ok);
  releaseRunExecution(f.store, held.value);
  const cold = f.open();
  await withResearchRunControl(cold, 'p', held.value.hold, () => f.run(1, cold, true));
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  assert.deepEqual(deepIntents(f.store).map(row => row.id), intents.map(row => row.id));
  const frontier = deepPlanSelection(f.store, 'p', f.scope);
  assert.ok(frontier.progress.find(row => row.question === 'q-two')!.state);
  await oldSnapshot(f);
});

test('budget re-entry: second Store changes the stage segment before reservation; no new purchase escapes its guard', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(); let raced = false, paid: unknown, wire: unknown;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    if (!raced && writes.some(row => row.kind === 'model-call' && row.expected === 0)) {
      raced = true; increase(f, 25_000_000, other);
      paid = money(other); wire = f.wires();
    }
    return commit();
  });
  await assert.rejects(f.run(1), error => ['input_stale', 'revision_conflict'].includes((error as any).code));
  restore(); assert.ok(raced);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  assert.equal(deepCalls(f).length, 1);
  // A fresh invocation may admit the same still-unpaid original position.
  await f.run(1, f.open()); assertAdvanced(f, 1);
  await oldSnapshot(f);
});

test('budget re-entry: an ordinary v7 forecast refusal does not use the stopped-route exception', async t => {
  const f = await ready(t);
  const current = f.engine.environments.effective('p').environment;
  f.engine.environments.configure('p', { ...current.value,
    implementer: { ...current.value.implementer, model: 'uncalibrated-ordinary-v7' } }, current.revision);
  const paid = money(f.store), wire = f.wires();
  const result = await f.run(1);
  assert.equal(result.value.pauseCode, 'budget_estimate_missing');
  assert.equal(Object.hasOwn(result.value, 'budgetReentry'), false);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
});

test('budget re-entry: only the immutable constructor policy opts in; a request policy cannot enable the default driver', async t => {
  const f = await stopped(t); increase(f);
  const request = { project: 'p', draftId: f.v.draft.id, maxTurns: 1, maxCalls: 2, producerPolicy: { discovery: 7 } };
  const disabled = { discovery: 6 }, configured = new EarlyStageDriver(new ProductEngine(f.store), new BudgetReentry(disabled));
  disabled.discovery = 7;
  await inert(f, f.store, async () => {
    const plain = await new ProductEngine(f.store).earlyStages.run(request);
    assert.equal(plain.reason?.dossier?.hash, f.details.dossier.hash);
    assert.equal(plain.budget.callsMade, 0);
    assert.equal((await configured.run(request)).budget.callsMade, 0);
  });
  const enabled = { discovery: 7 }, admitted = new EarlyStageDriver(new ProductEngine(f.store), new BudgetReentry(enabled));
  enabled.discovery = 6;
  const outcome = await admitted.run({ project: 'p', draftId: f.v.draft.id, maxTurns: 1, maxCalls: 2 });
  assert.equal(outcome.budget.turnsUsed, 1); assert.equal(outcome.budget.callsMade, 2);
  assertAdvanced(f, 1);
});

test('budget re-entry: explicit policy respects stopped and busy control without another sender', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(), held = acquireRunExecution(other, { project: 'p' }); assert.ok(held.ok);
  await inert(f, f.store, async () => {
    const busy = await driver(f); assert.equal(busy.end, 'busy'); assert.equal(busy.budget.callsMade, 0);
  });
  releaseRunExecution(other, held.value);
  assert.ok(stopRun(other, { project: 'p' }).ok);
  await inert(f, f.store, async () => {
    const stopped = await driver(f); assert.equal(stopped.end, 'stopped'); assert.equal(stopped.budget.callsMade, 0);
  });
});

test('budget re-entry: a second Store stop at reservation preserves the original hold and buys nothing', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(); let fired = false, paid: unknown, wire: unknown;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    if (!fired && writes.some(row => row.kind === 'model-call' && row.expected === 0)) {
      fired = true; assert.ok(stopRun(other, { project: 'p' }).ok);
      paid = money(other); wire = f.wires();
    }
    return commit();
  });
  const result = await driver(f); restore(); assert.ok(fired);
  assert.equal(result.end, 'stopped'); assert.equal(result.reason?.code, 'run_stopped');
  assert.equal(result.budget.callsMade, 0); assert.equal(result.budget.turnsUsed, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  await oldSnapshot(f);
});

test('budget re-entry: a second Store releasing the hold during preparation cannot authorize a new send', async t => {
  const f = await stopped(t); increase(f);
  const other = f.open(), paid = money(f.store), wire = f.wires(); let fired = false;
  const restore = interceptWrites(t, f.store, (_writes, commit) => {
    const rows = commit();
    if (!fired && rows.some(row => row.kind === 'research-consumer-intent' && (row.value as any).cursor.deepPreparation)) {
      fired = true;
      const control = readRunControl(other, { project: 'p' }); assert.ok(control.ok);
      const head = control.value.control!;
      releaseRunExecution(other, { hold: { project: 'p', control: reference(head) }, executor: head.value.execution! });
    }
    return rows;
  });
  const result = await driver(f); restore(); assert.ok(fired);
  assert.equal(result.reason?.code, 'run_control_changed');
  assert.equal(result.budget.callsMade, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  const pending = deepIntents(f.store).find(row => row.value.cursor.subject?.planQuestionId === 'q-two')!;
  assert.equal(pending.value.state, 'prepared');
  // A new owner recovers exactly that unpaid preparation. The finished scope
  // must not constrain the independent invocation, nor be saved in the intent.
  const resumed = await driver(f, f.open());
  assert.equal(resumed.budget.callsMade, 2); assertAdvanced(f, 1);
  assert.equal(deepIntents(f.store).find(row => row.value.cursor.subject?.planQuestionId === 'q-two')!.id, pending.id);
});

test('budget re-entry: the explicit constructor policy alone cannot start arbitrary v7 work', async t => {
  const f = await ready(t), paid = money(f.store), wire = f.wires();
  const handoff = JSON.parse(f.pending.value.error!).handoff;
  const result = await new EarlyStageDriver(new ProductEngine(f.store), new BudgetReentry({ discovery: 7 }))
    .run({ project: 'p', draftId: f.v.draft.id, maxTurns: 5, maxCalls: 10 });
  assert.equal(result.budget.callsMade, 0); assert.equal(result.budget.turnsUsed, 0);
  assert.deepEqual(result.reason?.handoff, handoff);
  assert.equal(result.reason?.next, 'deep'); assert.equal(result.reason?.target, 'deep');
  assert.equal(result.stageResult?.discovery?.state, 'researching');
  const cold = await new EarlyStageDriver(new ProductEngine(f.open()))
    .run({ project: 'p', draftId: f.v.draft.id, maxTurns: 5, maxCalls: 10 });
  assert.deepEqual(cold.reason?.handoff, handoff);
  assert.equal(cold.reason?.next, 'deep'); assert.equal(cold.reason?.target, 'deep');
  assert.equal(cold.stageResult?.discovery?.state, 'researching');
  assert.equal(cold.budget.callsMade, 0); assert.equal(cold.budget.turnsUsed, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);

  // A genuine negative partial dossier has no deep stop. The opt-in must leave
  // this historical result alone rather than treating it as a budget re-entry.
  const negative = bind(t, await build()); negative.configure({ none: true });
  const partial = await negative.run(3);
  assert.equal(partial.value.pauseCode, 'research_dossier_assessment_unavailable');
  const saved = JSON.parse(partial.value.error!);
  assert.equal(saved.stop, undefined);
  const optIn = new BudgetReentry({ discovery: 7 });
  await inert(negative, negative.store, async () => {
    const currentDraft = negative.store.get<DiscoveryDraft>(negative.v.draft.id)!;
    assert.equal(await optIn.eligible(negative.store, 'p', currentDraft, partial), false);
    const restored = await new EarlyStageDriver(new ProductEngine(negative.store), optIn)
      .run({ project: 'p', draftId: negative.v.draft.id, maxTurns: 5, maxCalls: 10 });
    assert.deepEqual(restored.reason?.handoff, saved.handoff);
    assert.deepEqual(restored.reason?.dossier, saved.dossier);
    assert.equal(restored.reason?.completeness, 'partial');
    assert.equal(restored.budget.callsMade, 0); assert.equal(restored.budget.turnsUsed, 0);
  });
});

test('budget re-entry: control scope binds Store/project, snapshots the hold, rejects nesting and expires without leaking', async t => {
  const f = await ready(t), other = f.open();
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept',
    [{ field: 'probe', kind: 'fact', prompt: 'Scope transport probe', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  // The ordinary public packer saves the context before control admits a new
  // dispatch. Keep that legitimate preparation outside the no-write window.
  prepareResearchEnvelope(f.environment.value.implementer, f.environment.value, 'Scope probe', {},
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  const send = (store = f.store) => researchCall(f.environment.value.implementer, f.environment.value, 'Scope probe', {}, undefined,
    { store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  const acquired = acquireRunExecution(f.store, { project: 'p' }); assert.ok(acquired.ok);
  const hold = structuredClone(acquired.value.hold);
  const before = history(f.store);
  await inert(f, f.store, async () => {
    await assert.rejects(withResearchRunControl(other, 'p', hold, () => send()), { code: 'run_control_changed' });
    await assert.rejects(withResearchRunControl(f.store, 'foreign', { project: 'foreign', control: null }, () => send()), { code: 'run_control_changed' });
    await assert.rejects(withResearchRunControl(f.store, 'p', null as never, () => send()), { code: 'run_control_request_invalid' });
    await assert.rejects(withResearchRunControl(f.store, 'p', { project: 'p' } as never, () => send()), { code: 'run_control_request_invalid' });
    await assert.rejects(withResearchRunControl(f.store, 'p', { ...hold, extra: true } as never, () => send()),
      { code: 'run_control_request_invalid' });
  });
  assert.equal(history(f.store), before);
  await withResearchRunControl(f.store, 'p', hold, async () => {
    releaseRunExecution(other, acquired.value);
    const fresh = acquireRunExecution(other, { project: 'p' }); assert.ok(fresh.ok);
    // Mutating both the outer object and its Ref cannot upgrade the saved hold.
    Object.assign(hold.control!, fresh.value.hold.control!);
    Object.assign(hold, fresh.value.hold);
    const unchanged = history(f.store);
    await inert(f, f.store, async () => {
      await assert.rejects(send(), { code: 'run_control_changed' });
      await assert.rejects(withResearchRunControl(f.store, 'p', fresh.value.hold, () => send()), { code: 'run_control_changed' });
    });
    assert.equal(history(f.store), unchanged);
    releaseRunExecution(other, fresh.value);
  });
  // An async child retaining the ALS object after its invocation is over does
  // not retain dispatch authority. This uses an explicit promise, no timer.
  const latest = acquireRunExecution(f.store, { project: 'p' }); assert.ok(latest.ok);
  let start!: () => void;
  const released = new Promise<void>(resolve => { start = resolve; });
  let child!: Promise<unknown>;
  await withResearchRunControl(f.store, 'p', latest.value.hold, async () => {
    child = released.then(() => send());
  });
  await inert(f, f.store, async () => {
    const refused = assert.rejects(child, { code: 'run_control_changed' }); start(); await refused;
  });
  const wire = f.wires().length;
  await send(); assert.equal(f.wires().length, wire + 1, 'the later independent call has no finished scope');
  releaseRunExecution(f.store, latest.value);
});

test('budget re-entry: claimed dossier dispatch retains the original hold through authorization; paid recovery ignores a later loss', async t => {
  const f = await stopped(t); increase(f);
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', f.details.dossier);
  const bases = [{ record: packet.manifest.ref }];
  const reply: DossierAssessmentResult = { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: packet.subject, verdict: 'return',
    reasons: ['The historical budget stop retains its missing material'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(dimension => [dimension,
      { judgement: 'adequate', reason: `Assessed ${dimension}`, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(item => item.address), unknowns: packet.unknowns.map(item => item.unknown.claim),
      contradictions: packet.contradictions.map(item => ({ id: item.contradiction.id,
        sides: item.sides.map(side => side.address) as [import('../src/discovery/claim-address.js').ClaimAddress, import('../src/discovery/claim-address.js').ClaimAddress],
        grounds: item.grounds.map(record => record.ref) })) },
    return: { targets: [{ partialReason: 0 }], reason: 'Continue the missing cell', bases } };
  f.configure({ dossierReply: reply });
  const original = acquireRunExecution(f.store, { project: 'p' }); assert.ok(original.ok);
  let cut = false;
  const restore = interceptWrites(t, f.store, (writes, commit) => {
    const rows = commit();
    if (!cut && writes.some(row => row.kind === 'model-call' && (row.value as ModelCall).purpose === 'dossier-assessor')) {
      cut = true; throw new Error('cut after dossier reservation');
    }
    return rows;
  });
  const environment = f.engine.environments.effective('p').environment;
  await assert.rejects(withResearchRunControl(f.store, 'p', original.value.hold,
    () => runDossierAssessmentSession(f.store, 'p', packet.subject, environment)), /cut after dossier reservation/);
  restore(); assert.ok(cut);
  const claim = f.store.list<ModelCall>('model-call').find(row => row.value.purpose === 'dossier-assessor')!;
  assert.equal(claim.value.execution?.phase, 'claimed');
  const application = claim.value.assessmentApplication!;
  releaseRunExecution(f.open(), original.value);
  const cold = f.open(), claimedHistory = history(cold);
  await inert(f, cold, async () => {
    await assert.rejects(withResearchRunControl(cold, 'p', original.value.hold,
      () => resumeDossierResearchCall(cold, application)), { code: 'run_control_changed' });
  });
  assert.equal(history(cold), claimedHistory);
  const checkpoint = await saveWorld(f);
  // A lawful fresh invocation authorizes the existing claim, without another reservation.
  const fresh = acquireRunExecution(cold, { project: 'p' }); assert.ok(fresh.ok);
  const ledger = cold.list('research-budget-ledger').flatMap(row => cold.history(row.id)), wire = f.wires().length;
  let receiptCut = false;
  const releaseAtReceipt = interceptWrites(t, cold, (writes, commit) => {
    if (!receiptCut && writes.some(row => row.kind === 'model-response')) {
      receiptCut = true; releaseRunExecution(f.store, fresh.value);
    }
    return commit();
  });
  await withResearchRunControl(cold, 'p', fresh.value.hold, () => resumeDossierResearchCall(cold, application));
  releaseAtReceipt(); assert.ok(receiptCut, 'paid receipt commits despite the lost original hold');
  assert.equal(f.wires().length, wire + 1);
  assert.equal(cold.list<ModelCall>('model-call').filter(row => row.value.purpose === 'dossier-assessor').length, 1);
  assert.deepEqual(cold.list('research-budget-ledger').flatMap(row => cold.history(row.id)), ledger);
  const paid = money(cold), paidWire = f.wires();
  const completed = await withResearchRunControl(cold, 'p', fresh.value.hold,
    () => runDossierAssessmentSession(cold, 'p', packet.subject));
  assert.ok(completed.result);
  assert.deepEqual(money(cold), paid); assert.deepEqual(f.wires(), paidWire);
  const finalHistory = history(cold);
  await inert(f, cold, () => withResearchRunControl(cold, 'p', fresh.value.hold,
    () => runDossierAssessmentSession(cold, 'p', packet.subject)));
  assert.equal(history(cold), finalHistory);
  // The same real claim in an isolated cut state also exercises the gate's
  // authorization CAS, after admission but before stdin may reach the adapter.
  const raced = copyWorld(t, checkpoint), second = raced.open();
  const owner = acquireRunExecution(raced.store, { project: 'p' }); assert.ok(owner.ok);
  let moved = false; const racedWire = raced.wires();
  const racedLedger = raced.store.list('research-budget-ledger').flatMap(row => raced.store.history(row.id));
  const undo = interceptWrites(t, raced.store, (writes, commit) => {
    if (!moved && writes.some(row => row.kind === 'model-call' && (row.value as ModelCall).execution?.phase === 'authorized')) {
      moved = true; releaseRunExecution(second, owner.value);
    }
    return commit();
  });
  await assert.rejects(withResearchRunControl(raced.store, 'p', owner.value.hold,
    () => resumeDossierResearchCall(raced.store, application)), { code: 'run_control_changed' });
  undo(); assert.ok(moved); assert.deepEqual(raced.wires(), racedWire);
  const refused = raced.store.get<ModelCall>(claim.id)!;
  assert.equal(refused.value.status, 'failed'); assert.equal(refused.value.error, 'run_control_changed');
  assert.equal(refused.value.response, null);
  assert.equal(refused.value.execution?.phase, 'claimed'); assert.equal(refused.value.usage, null);
  assert.equal(raced.store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'dossier-assessor').length, 1);
  assert.deepEqual(raced.store.list('research-budget-ledger').flatMap(row => raced.store.history(row.id)), racedLedger);
  assert.equal(raced.store.history<ModelCall>(claim.id).some(row => row.value.execution?.phase === 'authorized'), false);
});
