import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { canonical } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { readResearchConsumerTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { prepareDeepResearchCycle, resumeDeepResearchCycle, runDeepResearch, readDeepResearchResult } from '../src/discovery/deep-research-execution.js';
import { readEffectiveStageBudget } from '../src/discovery/stage-token-budget.js';
import { V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { deepCycleWorld, deepCycleMoney, deepCycleHistory } from './discovery-v7-deep-cycle-fixture.js';

const intents = (store: Store) => store.list<ResearchConsumerIntent>('research-consumer-intent')
  .filter(row => row.value.cursor.deepResearchContract === 'deep-research-cycle/v1');
async function drive(engine: ProductEngine, draftId: string, maxTurns = 1) {
  return await engine.execute({ type: 'early-stage-run', project: 'p', draftId, maxTurns, maxCalls: 1 }) as any;
}
for (const mask of ['missing marker', 'unknown marker', 'lost history', 'foreign history'] as const) test(`deep cycle refuses ${mask} without spending`, { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t); await drive(f.engine, f.v.draft.id, 8);
  const pending = intents(f.store).find(row => row.value.state === 'prepared')!; assert.ok(pending);
  const value = structuredClone(pending.value);
  if (mask === 'missing marker') { delete value.cursor.deepResearchContract; delete value.cursor.context.deepResearchContract; }
  if (mask === 'unknown marker') value.cursor.deepResearchContract = 'deep-research-cycle/unknown';
  if (mask === 'lost history') delete value.cursor.deepHistory;
  if (mask === 'foreign history') value.cursor.deepHistory = [reference(f.store.get('project:p')!)];
  const bad = f.store.write({ id: pending.id, kind: pending.kind, expected: pending.revision, value });
  const cold = new Store(f.path); t.after(() => cold.close());
  const before = deepCycleHistory(cold), money = deepCycleMoney(cold), sent = f.wires().length;
  await assert.rejects(resumeDeepResearchCycle(cold, 'p', reference(bad), { restoreOnly: true, allowance: 0 }), EngineError);
  assert.equal(deepCycleHistory(cold), before); assert.deepEqual(deepCycleMoney(cold), money); assert.equal(f.wires().length, sent);
});
test('deep cycle: new owner scope does not inherit served pins or the old preparation history', { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t);
  for (let step = 0; step < 3; step++) await drive(f.engine, f.v.draft.id);
  const served = intents(f.store).find(row => row.value.cursor.deepHistory.length === 2)!;
  const oldTurn = f.store.get(served.value.outputs![1]!.id)!;
  assert.equal((readResearchConsumerTurn(f.store, reference(oldTurn)).value.action as any).action, 'read_source');
  f.reviseScope(f.store);
  const result = await drive(f.engine, f.v.draft.id); assert.equal(result.budget.callsMade, 1, JSON.stringify(result));
  const latest = f.wires().filter(row => row.subject.deepPreparation).at(-1).subject;
  assert.notEqual(canonical(latest.deepPreparation), canonical(served.value.cursor.deepPreparation));
  assert.equal(latest.discoveryClaims.sources.length, 0, 'A saved Source alone is not a served pin for a new cell/scope');
  const fresh = intents(f.store).find(row => canonical(row.value.cursor.deepPreparation) === canonical(latest.deepPreparation))!;
  assert.deepEqual(fresh.value.cursor.deepHistory, []);
  const cold = new Store(f.path); t.after(() => cold.close());
  assert.deepEqual(readResearchConsumerTurn(cold, reference(oldTurn)), oldTurn, 'Old paid history remains readable');
});
test('deep cycle: the same stage account remains spent at the next cold entry', { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t);
  f.configure({ deepTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
  await drive(f.engine, f.v.draft.id);
  const budget = readEffectiveStageBudget(f.store, 'p'), paid = deepCycleMoney(f.store), sent = f.wires().length;
  assert.ok(budget.segment); assert.equal(budget.limit, V7_STAGE_TOKEN_CEILING);
  const cold = new Store(f.path); t.after(() => cold.close());
  const old = intents(cold)[0]!, owner = cold.get<any>(old.value.owner.id)!;
  const pending = prepareDeepResearchCycle(cold, { projectId: 'p', deepPreparation: old.value.cursor.deepPreparation,
    owner: reference(owner), environment: new ProductEngine(cold).environments.get('p') });
  assert.equal(await resumeDeepResearchCycle(cold, 'p', reference(pending), { restoreOnly: true, allowance: 0 }), null);
  await assert.rejects(resumeDeepResearchCycle(cold, 'p', reference(pending), { allowance: 1 }),
    { code: 'discovery_budget_reserve' });
  assert.equal(f.wires().length, sent, 'A new deep entry cannot reset the cell expense or stage ceiling');
  assert.deepEqual(deepCycleMoney(cold), paid); assert.deepEqual(readEffectiveStageBudget(cold, 'p'), budget);
});
test('deep cycle leaves the explicit historical one-step producer and paid reader answer-only', { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t); await drive(f.engine, f.v.draft.id);
  const preparation = intents(f.store)[0]!.value.cursor.deepPreparation;
  f.configure({ deepWeb: false });
  const result = await runDeepResearch(f.store, { projectId: 'p', deepPreparation: preparation,
    environment: f.engine.environments.get('p') });
  assert.ok(result); assert.equal(Object.hasOwn(result.intent.value.cursor, 'deepResearchContract'), false);
  assert.equal(result.intent.value.outputs!.length, 3);
  const request = f.wires().filter(row => row.subject.deepPreparation).at(-1).subject;
  assert.equal(Object.hasOwn(request, 'deepResearchContract'), false);
  assert.equal(request.discoveryResponseContract.schema.properties.action.const, 'answer');
  const cold = new Store(f.path); t.after(() => cold.close());
  const before = deepCycleHistory(cold), money = deepCycleMoney(cold), sent = f.wires().length;
  assert.deepEqual(readDeepResearchResult(cold, 'p', reference(result.intent)), result);
  assert.equal(deepCycleHistory(cold), before); assert.deepEqual(deepCycleMoney(cold), money); assert.equal(f.wires().length, sent);
});

test('deep cycle refuses missing run identity before touching storage', () => {
  for (const input of [null, {}, { owner: null }]) assert.throws(() => prepareDeepResearchCycle(null as any, input as any), { code: 'discovery_deep_execution_invalid' });
});


test('deep cycle: pause publishes no attempt and restores without payment', { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t);
  f.configure({ deepAction: { action: 'pause', reason: 'Save this exact cell for later evidence' } });
  const outcome = await drive(f.engine, f.v.draft.id);
  assert.equal(outcome.end, 'stage_paused', JSON.stringify(outcome));
  const intent = intents(f.store)[0]!;
  assert.equal(intent.value.outputs!.length, 2);
  assert.equal(f.store.list<any>('research-attempt').filter(row => row.value.call.id === intent.value.call!.id).length, 0);
  const cold = new Store(f.path); t.after(() => cold.close());
  const paid = deepCycleMoney(cold), sent = f.wires().length;
  await resumeDeepResearchCycle(cold, 'p', reference(intent), { restoreOnly: true, allowance: 0 });
  assert.deepEqual(deepCycleMoney(cold), paid); assert.equal(f.wires().length, sent);
});

test('deep cycle: need_owner and its independent assessor share the outer call allowance', { timeout: 60000 }, async t => {
  const f = await deepCycleWorld(t);
  for (let step = 0; step < 3; step++) await drive(f.engine, f.v.draft.id);
  const source = f.store.list<any>('source').find(row => row.value.origin.kind === 'web')!;
  f.configure({ deepAction: { action: 'need_owner', question: '$selected', reason: 'Choose the exact owner preference', searched: [reference(source)] } });
  const before = f.store.list('model-call').length;
  const paused = await drive(f.engine, f.v.draft.id, 8);
  assert.equal(paused.end, 'stage_paused', JSON.stringify(paused));
  assert.equal(paused.budget.callsMade, 1);
  assert.equal(f.store.list('model-call').length, before + 1);
  const intent = intents(f.store).find(row => row.value.cursor.deepHistory.length === 3)!;
  assert.equal(intent.value.outputs!.length, 2);
  const cold = new Store(f.path); t.after(() => cold.close());
  const next = await drive(new ProductEngine(cold), f.v.draft.id, 8);
  assert.equal(next.budget.callsMade, 1, JSON.stringify(next));
  assert.notEqual(next.end, 'blocked', JSON.stringify(next));
  assert.equal(f.wires().filter(row => row.subject.role === 'assess-escalation').length, 1);
  assert.equal(f.store.list<any>('research-attempt').filter(row => row.value.call.id === intent.value.call!.id).length, 0);
});
