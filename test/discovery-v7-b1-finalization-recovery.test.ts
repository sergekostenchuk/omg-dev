import test from 'node:test';
import assert from 'node:assert/strict';
import { reference } from '../src/pipeline/contracts.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { readRunnerFinalizationAt } from '../src/discovery/discovery-finalization-runner.js';
import { finalizationWorld, finalizationAdapter as adapter, returnedFinalWorld, regeneratedFinalWorld, assessedReturnedWorld, type FinalizationWorld as World } from './discovery-v7-b1-finalization-fixture.js';
import { all, money } from './discovery-v7-dossier-seed.js';
import { EngineError } from '../src/errors.js';
import { readResearchReturnAt } from '../src/discovery/discovery-research-return.js';
import { ProductEngine } from '../src/product/engine.js';
import { Store, type Write, type Revision, type TransactionGuard } from '../src/storage/store.js';

// Preserve the Store method shape: an own writeMany property disables historical proof reuse.
function interceptWrites(t: test.TestContext, target: Store, inspect: (rows: Write[]) => void) {
  const write = Store.prototype.writeMany;
  const hook = t.mock.method(Store.prototype, 'writeMany', function<T>(this: Store, rows: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (this === target) inspect(rows);
    return write.call(this, rows, guards) as Revision<T>[];
  });
  return () => hook.mock.restore();
}
function stamp(f: Pick<World, 'store' | 'wires'>) { return { history: all(f.store), event: f.store.lastEvent(), money: money(f.store), wires: f.wires() }; }
const run = (f: Pick<World, 'store' | 'discovery' | 'engine' | 'packet'>, limit = 8, restoreOnly = false) => new Researcher(f.store, f.discovery, f.engine.environments)
  .run('p', f.packet.subject.basis.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });


test('B1 recovery: a physical allowance remains shared across the D7 producer and its independent reviewer', async t => {
  const f = await finalizationWorld(t); await adapter(f, 'go');
  const before = new Set(f.store.list('model-call').map(row => row.id));
  const first = await run(f, 1), proof = await readRunnerFinalizationAt(f.store, 'p', reference(first));
  assert.equal(f.store.list('model-call').filter(row => !before.has(row.id)).length, 1);
  assert.equal(proof.status, 'assessing'); assert.ok(proof.final); assert.equal(proof.assessment, null);
  const saved = stamp(f); assert.deepEqual(await run(f, 1, true), first); assert.deepEqual(stamp(f), saved);
  const second = await run(f, 1), finished = await readRunnerFinalizationAt(f.store, 'p', reference(second));
  assert.equal(finished.status, 'needs_owner');
  assert.equal(f.store.list('model-call').filter(row => !before.has(row.id)).length, 2);
});

for (const kind of ['discovery-final-paid-result', 'discovery-final-assessment-paid-result'])
  test(`B1 recovery: paid response cut before ${kind} restores hot/cold without dispatch`, async t => {
    const f = await finalizationWorld(t); await adapter(f, 'go');
    let hit = false;
    const restore = interceptWrites(t, f.store, rows => {
      if (!hit && rows.some(row => row.kind === kind)) { hit = true; throw new EngineError('injected_write_failure', 'Paid publication cut'); }
    });
    try { await assert.rejects(run(f), (error: unknown) => error instanceof EngineError && error.code === 'injected_write_failure'); }
    finally { restore(); }
    assert.ok(hit);
    const cash = money(f.store), wires = f.wires(); f.reopen();
    const restored = await run(f, 1, true), proof = await readRunnerFinalizationAt(f.store, 'p', reference(restored));
    assert.ok(proof.final); assert.equal(proof.status, kind === 'discovery-final-paid-result' ? 'assessing' : 'needs_owner');
    assert.deepEqual(money(f.store), cash); assert.deepEqual(f.wires(), wires);
    const saved = stamp(f); assert.deepEqual(await run(f, 1, true), restored); assert.deepEqual(stamp(f), saved);
  });

test('B1 recovery: second Store changes Environment before reservation; no new physical work uses it accidentally', async t => {
  const f = await finalizationWorld(t); await adapter(f, 'go');
  const other = f.open(), engine = new ProductEngine(other);
  let hit = false; const cash = money(f.store), wires = f.wires();
  const restore = interceptWrites(t, f.store, rows => {
    if (!hit && rows.some(row => row.kind === 'model-call' && (row.value as { purpose?: string }).purpose === 'discovery-final')) {
      hit = true;
      const old = engine.environments.get('p'), { projectId: _project, ...settings } = old.value;
      engine.environments.configure('p', { ...settings, timeoutMs: settings.timeoutMs + 1 }, old.revision);
    }
  });
  try { await assert.rejects(run(f), (error: unknown) => error instanceof EngineError && ['input_stale','discovery_final_execution_invalid'].includes(error.code)); }
  finally { restore(); }
  assert.ok(hit); assert.deepEqual(money(f.store), cash); assert.deepEqual(f.wires(), wires);
});

// Each test starts from its own committed copy. The first consumer pays the real lazy construction.
test('B1 recovery: paid B2 D7 return preserves the previous final and restoreOnly makes no new purchase', async t => {
  const f = await returnedFinalWorld(t);
  const returned = await readResearchReturnAt(f.store, 'p', f.returned);
  assert.equal(returned.destination, 'D7'); assert.deepEqual(returned.final, f.original);
  const before = stamp(f);
  const saved = await run(f, 1, true);
  assert.deepEqual(saved.value.finalization, f.priorFinalization);
  assert.deepEqual(stamp(f), before);
});

test('B1 recovery: ordinary Driver spends one shared call regenerating the exact returned D7', async t => {
  const f = await regeneratedFinalWorld(t);
  const proof = await readRunnerFinalizationAt(f.store, 'p', f.run);
  assert.equal(proof.status, 'assessing'); assert.equal(proof.outcome, 'no_go');
  assert.deepEqual(proof.record.value.return, f.returned);
  assert.notDeepEqual(proof.record.value.final, f.original);
  assert.ok(proof.prepared.value.input.prompt.includes(f.returned.id));
  assert.deepEqual(reference(f.store.get(f.original.id, f.original.revision)!), f.original);
});

test('B1 recovery: the regenerated D7 restores without a new purchase or write', async t => {
  const f = await regeneratedFinalWorld(t);
  const before = stamp(f); assert.deepEqual(reference(await run(f, 1, true)), f.run); assert.deepEqual(stamp(f), before);
});

test('B1 recovery: next Driver call independently assesses exactly the revised negative final', async t => {
  const f = await assessedReturnedWorld(t), proof = await readRunnerFinalizationAt(f.store, 'p', f.run);
  assert.equal(proof.status, 'needs_owner'); assert.equal(proof.outcome, 'no_go'); assert.equal(proof.accepted, null);
  assert.deepEqual(proof.record.value.return, f.returned); assert.notDeepEqual(proof.record.value.final, f.original);
});

test('B1 recovery: assessed D7 return repeats hot and cold without repurchasing', async t => {
  const f = await assessedReturnedWorld(t), before = stamp(f);
  assert.deepEqual(reference(await run(f)), f.run); assert.deepEqual(stamp(f), before);
  f.reopen();
  assert.deepEqual(reference(await run(f, 1, true)), f.run); assert.deepEqual(stamp(f), before);
});

test('B1: an independent final return remains addressed and repeat never repurchases the same candidate', async t => {
  const f = await finalizationWorld(t); await adapter(f, 'insufficient_evidence', 'return');
  const value = await run(f), proof = await readRunnerFinalizationAt(f.store, 'p', reference(value));
  assert.equal(proof.status, 'returned'); assert.equal(proof.outcome, 'insufficient_evidence');
  assert.deepEqual(proof.correction!.targets, [{ candidate: '/verdict' }]); assert.equal(proof.accepted, null);
  const before = stamp(f); assert.deepEqual(await run(f), value); assert.deepEqual(stamp(f), before);
});

