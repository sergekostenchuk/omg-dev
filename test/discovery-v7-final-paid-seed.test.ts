import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reference } from '../src/pipeline/contracts.js';
import { all, money } from './discovery-v7-dossier-seed.js';
import { storeUnchanged } from './store-unchanged.js';
import { finalPaid, FINAL_SEED_BRIEF } from './discovery-v7-final-paid-seed.js';

test('final paid seed: lazy real preparation retains exact paid references through close and reopen', async t => {
  const f = await finalPaid(t);
  assert.equal(f.result.value.projection.result.bundle.verdict.outcome, 'go');
  assert.equal(f.packet.brief.text, FINAL_SEED_BRIEF);
  const refs = [f.d6, f.prepared, f.execution, f.paidResult, f.result.value.session, f.result.value.application,
    f.result.value.call, f.result.value.request, f.result.value.response, reference(f.packet.brief.source),
    reference(f.packet.brief.fact), reference(f.packet.brief.acceptance)];
  for (const ref of refs) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref);
  const before = all(f.store), calls = money(f.store), wire = f.wires();
  const hot = await storeUnchanged(f.store, () => f.restore());
  f.reopen();
  for (const ref of refs) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref);
  const cold = await storeUnchanged(f.store, () => f.restore());
  assert.deepEqual(cold, hot);
  assert.deepEqual((await f.read()).result, hot.result);
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
});

test('final paid seed: copies isolate database, mutable values and runtime without paying on restore', async t => {
  const [a, b] = await Promise.all([finalPaid(t), finalPaid(t)]);
  assert.notEqual(a.path, b.path); assert.notEqual(a.root, b.root);
  assert.notEqual(a.environment.value.implementer.command.args[0], b.environment.value.implementer.command.args[0]);
  assert.deepEqual(a.paidResult, b.paidResult); assert.deepEqual(a.prepared, b.prepared);
  assert.deepEqual(money(a.store), money(b.store), 'planting another copy does not add a calibration or payment');
  const before = all(b.store), moneyBefore = money(b.store), wire = b.wires();
  a.store.write({ id: 'fixture:copy-a', kind: 'transport-fixture', expected: 0, value: { projectId: 'p', only: 'A' } });
  a.packet.subject.identity = 'caller-mutation';
  a.reply({ only: 'A' });
  writeFileSync(join(a.root, 'wire.ndjson'), '');
  assert.equal(b.store.get('fixture:copy-a'), null);
  assert.notEqual(b.packet.subject.identity, a.packet.subject.identity);
  assert.notEqual(readFileSync(join(a.root, 'reply.json'), 'utf8'), readFileSync(join(b.root, 'reply.json'), 'utf8'));
  assert.deepEqual(b.wires(), wire);
  await storeUnchanged(b.store, () => b.restore());
  assert.equal(all(b.store), before); assert.deepEqual(money(b.store), moneyBefore); assert.deepEqual(b.wires(), wire);
});

test('final paid seed: each terminal outcome has its own actual paid result', async t => {
  for (const outcome of ['conditional', 'no_go', 'insufficient_evidence'] as const) {
    const f = await finalPaid(t, outcome), result = f.result.value.projection.result.bundle;
    assert.equal(result.verdict.outcome, outcome);
    if (outcome === 'conditional') assert.equal(result.verdict.conditions.length, 1);
    else { assert.equal(result.projection, null); assert.equal(result.constitution, null); }
    assert.deepEqual((await storeUnchanged(f.store, () => f.restore())).output, f.result);
  }
});

test('final paid seed: model-selected and nonempty partial routes retain their real paid origins', async t => {
  const model = await finalPaid(t, 'go', 'model');
  assert.equal(model.packet.dossier.manifest.value.completeness, 'complete');
  const decision = model.packet.dossier.route.decision!;
  assert.equal(model.store.get(decision.ref.id, decision.ref.revision)!.kind, 'discovery-variant-model-decision');
  const partial = await finalPaid(t, 'insufficient_evidence', 'partial');
  assert.equal(partial.packet.dossier.manifest.value.completeness, 'partial');
  assert.ok(partial.packet.dossier.materials.length > 0);
  assert.ok(partial.packet.dossier.manifest.value.reasons.length > 0);
  for (const f of [model, partial]) {
    const calls = money(f.store), wire = f.wires();
    f.reopen();
    assert.deepEqual((await storeUnchanged(f.store, () => f.restore())).output, f.result);
    assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wire);
  }
});
