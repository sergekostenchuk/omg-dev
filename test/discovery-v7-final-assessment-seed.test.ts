import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reference } from '../src/pipeline/contracts.js';
import { all, money } from './discovery-v7-dossier-seed.js';
import { storeUnchanged } from './store-unchanged.js';
import { finalAssessmentPaid } from './discovery-v7-final-assessment-seed.js';

test('final assessment seed: first isolated consumer builds genuine paid references and restores hot and cold', async t => {
  const f = await finalAssessmentPaid(t);
  assert.equal(f.result.value.projection.verdict, 'supported');
  assert.equal(f.result.value.projection.candidateOutcome, 'go');
  const refs = [f.paidD7, f.prepared, f.execution, f.paidResult, f.result.value.session, f.result.value.application,
    f.result.value.call, f.result.value.request, f.result.value.response];
  for (const ref of refs) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref);
  const before = all(f.store), finances = money(f.store), wire = f.wires();
  const hot = await storeUnchanged(f.store, () => f.restore());
  assert.deepEqual(hot.output, f.result);
  assert.deepEqual((await storeUnchanged(f.store, () => f.read())).output, f.result);
  f.reopen();
  const cold = await storeUnchanged(f.store, () => f.restore());
  assert.deepEqual(cold, hot);
  for (const ref of refs) assert.deepEqual(reference(f.store.get(ref.id, ref.revision)!), ref);
  assert.equal(all(f.store), before); assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire);
});

test('final assessment seed: independent concurrent clones isolate Store, values, settings and wire without another payment', async t => {
  const [a, b] = await Promise.all([finalAssessmentPaid(t), finalAssessmentPaid(t)]);
  assert.notEqual(a.root, b.root); assert.notEqual(a.path, b.path);
  assert.notEqual(a.environment.value.reviewer.command.args[0], b.environment.value.reviewer.command.args[0]);
  assert.deepEqual(a.paidResult, b.paidResult); assert.deepEqual(a.prepared, b.prepared);
  assert.deepEqual(money(a.store), money(b.store));
  const before = all(b.store), finances = money(b.store), wire = b.wires();
  a.store.write({ id: 'fixture:assessment-copy-a', kind: 'transport-fixture', expected: 0, value: { projectId: 'p', only: 'A' } });
  a.packet.candidate.verdict.reason = 'caller mutation';
  a.result.value.projection.result.reasons.push('caller mutation');
  a.reply({ only: 'A' }); writeFileSync(join(a.root, 'wire.ndjson'), '');
  assert.equal(b.store.get('fixture:assessment-copy-a'), null);
  assert.notEqual(a.packet.candidate.verdict.reason, b.packet.candidate.verdict.reason);
  assert.notDeepEqual(a.result.value.projection.result.reasons, b.result.value.projection.result.reasons);
  assert.notEqual(readFileSync(join(a.root, 'reply.json'), 'utf8'), readFileSync(join(b.root, 'reply.json'), 'utf8'));
  await storeUnchanged(b.store, () => b.restore());
  assert.equal(all(b.store), before); assert.deepEqual(money(b.store), finances); assert.deepEqual(b.wires(), wire);
});

test('final assessment seed: conditional remains conditional in a supported paid assessment', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'conditional' });
  assert.equal(f.result.value.projection.verdict, 'supported');
  assert.equal(f.result.value.projection.candidateOutcome, 'conditional');
  assert.equal(f.packet.candidate.verdict.conditions.length, 1);
  assert.deepEqual((await storeUnchanged(f.store, () => f.readExecution())).output, f.result);
});

test('final assessment seed: model-selected no_go has its own paid return without a fabricated constitution', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'no_go', route: 'model', verdict: 'return' });
  assert.equal(f.result.value.projection.verdict, 'return');
  assert.equal(f.result.value.projection.candidateOutcome, 'no_go');
  assert.equal(f.packet.candidate.constitution, null);
  const decision = f.final.packet.dossier.route.decision!;
  assert.equal(f.store.get(decision.ref.id, decision.ref.revision)!.kind, 'discovery-variant-model-decision');
  assert.deepEqual((await storeUnchanged(f.store, () => f.restore())).output, f.result);
});

test('final assessment seed: a nonempty partial retains insufficient evidence through paid assessment and cold restore', async t => {
  const f = await finalAssessmentPaid(t, { outcome: 'insufficient_evidence', route: 'partial' });
  assert.equal(f.result.value.projection.verdict, 'supported');
  assert.equal(f.result.value.projection.candidateOutcome, 'insufficient_evidence');
  assert.equal(f.final.packet.dossier.manifest.value.completeness, 'partial');
  assert.ok(f.final.packet.dossier.materials.length > 0);
  assert.ok(f.final.packet.dossier.manifest.value.reasons.length > 0);
  assert.equal(f.packet.candidate.projection, null); assert.equal(f.packet.candidate.constitution, null);
  const finances = money(f.store), wire = f.wires();
  f.reopen();
  assert.deepEqual((await storeUnchanged(f.store, () => f.restore())).output, f.result);
  assert.deepEqual(money(f.store), finances); assert.deepEqual(f.wires(), wire);
});
