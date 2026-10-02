import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { digest, hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { estimateCliCall } from '../src/adapters/codex-estimate.js';
import { adapterLineagePath } from '../src/adapters/adapter-lineage.js';
import type { CallRuntimeEvidence } from '../src/runtime/call-runtime.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-lineage-')), store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store, 'codex'); engine.execute({ type: 'create-project', project: 'p', title: 'Fixture' });
  const current = join(root, 'current', 'codex-stdio.js'), old = join(root, 'old', 'codex-stdio.js');
  mkdirSync(join(root, 'current')); mkdirSync(join(root, 'old'));
  const content = '// fixture adapter bytes', sha256 = digest(content); writeFileSync(current, content);
  const role = { actor: 'author', model: 'fixture-model', effort: 'high' as const, command: { executable: process.execPath, args: [current, '--compact-research'] } };
  const declaration = { type: 'declare-adapter-lineage', project: 'p', path: old, sha256, basis: ['Verified byte-identical relocation before the old directory was removed'] };
  const declare = (overrides: Record<string, unknown> = {}) => engine.execute({ ...declaration, ...overrides }) as ReturnType<Store['write']>;
  const sample = (id = 'sample', input = 200, output = 100, chars = 1000, runtime?: CallRuntimeEvidence) => {
    const value: ModelCall = { projectId: 'p', draftId: 'fixture-draft', purpose: 'reading-planner', requestId: id,
      startedAt: 1, finishedAt: 2, status: 'succeeded', requested: { ...role, command: { ...role.command, args: [old, '--compact-research'] } },
      confirmed: { model: null, effort: null, speed: null }, request: { chars, bytes: chars, hash: digest(id) }, response: null,
      usage: { inputTokens: input, outputTokens: output, cachedInputTokens: null, reasoningOutputTokens: null }, usageSource: 'adapter', error: null,
      ...(runtime ? { runtime } : {}) };
    return store.write<ModelCall>({ id, kind: 'model-call', expected: 0, value });
  };
  const estimate = (chars = 1000) => estimateCliCall(store, 'p', role, 'reading-planner', chars);
  return { root, store, engine, old, current, content, sha256, role, declaration, declare, sample, estimate };
}

test('an explicit immutable lineage restores the two measured planner samples without rewriting calls or inventing usage', t => {
  const f = fixture(t), a = f.sample('a', 30297, 827, 59899), b = f.sample('b', 32857, 570, 67057);
  assert.throws(() => f.estimate(86492), { code: 'budget_estimate_missing' });
  const lineage = f.declare(), estimate = f.estimate(86492);
  assert.equal(estimate.kind, 'estimated'); assert.equal(estimate.tokens, 49437);
  assert.ok(estimate.basis.some(ref => ref.hash === lineage.hash)); assert.equal(estimate.basis.length, 3);
  assert.deepEqual(f.store.get(a.id), a); assert.deepEqual(f.store.get(b.id), b);
  assert.equal(f.store.list('model-call').length, 2); assert.deepEqual(f.declare(), lineage);
  assert.equal((lineage.value as any).declaredBy, 'codex'); assert.equal(f.store.history(lineage.id).length, 1);
});

test('lineage rejects malformed declarations, operator spoofing and replacement of an existing path', t => {
  const f = fixture(t); f.sample();
  for (const overrides of [{ path: 'relative/codex-stdio.js' }, { path: '/bad\0path' }, { sha256: 'invalid' }, { basis: [] }, { basis: ['  '] }, { declaredBy: 'owner' }])
    assert.throws(() => f.declare(overrides));
  const original = f.declare();
  assert.throws(() => f.declare({ sha256: '0'.repeat(64) }), { code: 'adapter_lineage_conflict' });
  assert.throws(() => f.declare({ basis: ['replacement story'] }), { code: 'adapter_lineage_conflict' });
  assert.deepEqual(f.store.get(original.id), original);
  writeFileSync(f.old, '// contradictory surviving file');
  assert.throws(() => f.declare(), { code: 'adapter_lineage_hash_conflict' });
});

test('a foreign path or project cannot supply lineage, and current adapter bytes are always required', t => {
  const f = fixture(t), sample = f.sample();
  assert.throws(() => f.declare({ path: join(f.root, 'another', 'codex-stdio.js') }), { code: 'adapter_lineage_path_unknown' });
  f.engine.execute({ type: 'create-project', project: 'q', title: 'Other fixture' });
  f.store.write({ id: 'q-sample', kind: 'model-call', expected: 0, value: { ...sample.value, projectId: 'q' } });
  f.declare({ project: 'q' });
  assert.throws(() => f.estimate(), { code: 'budget_estimate_missing' });
  f.declare(); assert.equal(f.estimate().tokens, 330);
  unlinkSync(f.current); assert.throws(() => f.estimate(), { code: 'budget_estimate_missing' });
});

test('a surviving file precedes lineage but a reused path cannot contradict its historical declaration', t => {
  const f = fixture(t); writeFileSync(f.old, f.content); const call = f.sample(); const lineage = f.declare();
  assert.deepEqual(f.estimate().basis, [reference(call)]);
  unlinkSync(f.old); assert.ok(f.estimate().basis.some(ref => ref.hash === lineage.hash));
  writeFileSync(f.old, '// reused path'); writeFileSync(f.current, '// reused path');
  assert.throws(() => f.estimate(), { code: 'budget_estimate_missing' });
});

test('an actual dispatch fingerprint survives removal and precedes a later file replacement; foreign telemetry cannot borrow it', t => {
  const f = fixture(t), call = f.sample();
  // Focused data fixture for estimator identity binding. Actual OS capture and
  // exclusion of provider-authored telemetry are tested in call-runtime.test.
  const runtime = { version: 1, status: 'observed', requestHash: call.value.request.hash,
    snapshot: { roleHash: hashJson(call.value.requested), invocation: { args: call.value.requested.command.args }, adapter: { hash: f.sha256 } } } as CallRuntimeEvidence;
  const saved = f.store.write<ModelCall>({ id: call.id, kind: call.kind, expected: call.revision, value: { ...call.value, runtime } });
  assert.equal(f.estimate().tokens, 330);
  writeFileSync(f.old, '// replaced after dispatch'); assert.equal(f.estimate().tokens, 330);
  for (const mutate of [
    (value: any) => { value.runtime.requestHash = '0'.repeat(64); },
    (value: any) => { value.runtime.snapshot.roleHash = '0'.repeat(64); },
    (value: any) => { value.runtime.snapshot.invocation.args = ['foreign']; },
    (value: any) => { value.runtime.snapshot.adapter.hash = 'bad'; },
    (value: any) => { value.runtime.status = 'stale'; },
  ]) {
    const value = structuredClone(saved.value); mutate(value);
    f.store.write({ id: saved.id, kind: saved.kind, expected: f.store.get(saved.id)!.revision, value });
    assert.throws(() => f.estimate(), { code: 'budget_estimate_missing' });
  }
});

test('same adapter bytes do not erase model, effort, speed or invocation flags from the forecast identity', t => {
  const f = fixture(t); f.sample(); f.declare();
  for (const role of [{ ...f.role, model: 'other' }, { ...f.role, effort: 'low' as const }, { ...f.role, speed: 'fast' as const },
    { ...f.role, command: { ...f.role.command, args: [f.current, '--different-mode'] } }])
    assert.throws(() => estimateCliCall(f.store, 'p', role, 'reading-planner', 1000), { code: 'budget_estimate_missing' });
  assert.equal(estimateCliCall(f.store, 'p', { ...f.role, actor: 'renamed-operator', speed: 'inherited' }, 'reading-planner', 1000).tokens, 330);
});

test('the macOS /var and /private/var spellings address one immutable lineage, not arbitrary similar paths', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), path = '/var/folders/omg-lineage-fixture-missing/codex-stdio.js';
  const sample = f.sample();
  f.store.write({ id: sample.id, kind: sample.kind, expected: sample.revision,
    value: { ...sample.value, requested: { ...sample.value.requested, command: { ...sample.value.requested.command, args: [path, '--compact-research'] } } } });
  assert.equal(adapterLineagePath(path), '/private' + path);
  const first = f.declare({ path }), alias = f.declare({ path: '/private' + path });
  assert.deepEqual(alias, first); assert.equal(f.store.list('adapter-lineage').length, 1);
  assert.notEqual(adapterLineagePath(path + '.other'), adapterLineagePath(path));
});

test('a devin-stdio adapter is a known module for lineage, while unmeasured devin usage supplies no estimate', t => {
  const f = fixture(t);
  // A historical call made through the Devin adapter path accepts its declaration.
  const old = join(f.root, 'old', 'devin-stdio.js');
  f.store.write({ id: 'devin-sample', kind: 'model-call', expected: 0, value: { projectId: 'p', purpose: 'reading-planner',
    requested: { ...f.role, command: { executable: process.execPath, args: [old] } },
    request: { chars: 1000, bytes: 1000, hash: digest('devin-sample') }, usage: null, status: 'succeeded' } as unknown as ModelCall });
  const declared = f.declare({ path: old });
  assert.equal((declared.value as { path: string }).path, adapterLineagePath(old));
  // Null usage is not zero and cannot be borrowed as a measured sample.
  assert.throws(() => estimateCliCall(f.store, 'p',
    { ...f.role, command: { executable: process.execPath, args: [join(f.root, 'current', 'devin-stdio.js')] } },
    'reading-planner', 1000), { code: 'budget_estimate_missing' });
});
