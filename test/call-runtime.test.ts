import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { digest, hashJson } from '../src/canonical.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import type { DiscoveryDraft } from '../src/discovery/discovery.js';
import type { ResearchScope } from '../src/graph/research-scope.js';
import { captureCallRuntime } from '../src/runtime/call-runtime.js';
import { previewResearch } from '../src/discovery/research-preview.js';

const originalPath = process.env['PATH'];

// All provider invocations below are local Node fixtures, never real Codex or
// paid requests. Scope rows seed telemetry tests; policy admission has its own
// public-path tests in obligation-policy/runtime-observation suites.
function fixture(t: test.TestContext, mode = 'normal', declareAdapter = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-call-runtime-'))), bin = join(root, 'bin'); mkdirSync(bin);
  const store = new Store(join(root, 'db.sqlite')), engine = new ProductEngine(store);
  t.after(() => { process.env['PATH'] = originalPath; store.close(); rmSync(root, { recursive: true, force: true }); });
  const codex = join(bin, 'codex'), adapter = join(root, 'adapter.mjs'), log = join(root, 'invocations.log');
  writeFileSync(codex, `#!${process.execPath}\nimport{readFileSync,appendFileSync}from'node:fs';const log=${JSON.stringify(log)};if(process.argv[2]==='--version'){appendFileSync(log,'version\\n');console.log(${JSON.stringify(mode === 'bad-version' ? 'unknown-provider' : 'codex-cli fixture-1')});}else{appendFileSync(log,'provider\\n');const r=JSON.parse(readFileSync(0,'utf8'));if(${JSON.stringify(mode)}==='changed-provider')appendFileSync(process.argv[1],'\\n// changed during invocation\\n');if(${JSON.stringify(mode)}==='changed-adapter')appendFileSync(${JSON.stringify(adapter)},'\\n// changed during invocation\\n');console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'Local fixture'},runtime:{status:'observed',source:'fabricated by adapter'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));}\n`);
  chmodSync(codex, 0o700);
  writeFileSync(adapter, `import{readFileSync}from'node:fs';import{spawnSync}from'node:child_process';const r=spawnSync('codex',['exec'],{input:readFileSync(0,'utf8'),encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status??1;\n`);
  process.env['PATH'] = bin + delimiter + (originalPath ?? '');
  engine.execute({ type: 'create-project', project: 'p', title: 'Runtime telemetry fixture' });
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure('p', { workspace: root,
    implementer: { actor: 'reader', model: 'fixture', effort: 'high', command }, reviewer: { actor: 'assessor', model: 'fixture', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['--version'] }, timeoutMs: 5000 }, 0);
  const source = engine.discovery.evidence.document('p', 'declared-check', 'export {};', 'text/plain', 0);
  const scope = store.write<ResearchScope>({ id: 'research-scope:p:R2', kind: 'research-scope', expected: 0,
    value: { projectId: 'p', policy: { version: 1, assignments: [{ runtimeCheck: { script: reference(source), dependencies: [],
      subjects: declareAdapter ? [adapter] : [], executables: ['codex'], args: [], timeoutMs: 1000, purpose: 'Fixture evidence declaration' } }] } } });
  const draft = engine.discovery.create('p', 'features', 'R1', 'compilation', [{ field: 'fixture', kind: 'design', proof: 'assessment',
    prompt: 'Return a fixture observation', risk: 'Wrong installed runtime', schema: { type: 'string' } }], [reference(scope)]);
  const role = environment.value.implementer;
  const invoke = () => researchCall(role, environment.value, 'Read the fixture', { fixture: true }, undefined,
    { store, draftId: draft.id, questionId: draft.value.questions[0]!, purpose: 'analyst' });
  return { root, bin, store, engine, codex, adapter, log, scope, draft, role, environment, invoke };
}

test('ordinary dispatch records the actual declared CLI, adapter and request without a second provider invocation', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.invoke(), { action: 'pause', reason: 'Local fixture' });
  const call = f.store.list<ModelCall>('model-call')[0]!, runtime = call.value.runtime!;
  assert.equal(call.value.status, 'succeeded'); assert.equal(runtime.status, 'observed'); assert.equal(runtime.error, null);
  assert.equal(runtime.requestHash, call.value.request.hash); assert.deepEqual(runtime.declaration, reference(f.scope));
  assert.equal(runtime.snapshot!.roleHash, hashJson(f.role));
  assert.equal(runtime.snapshot!.adapter.path, f.adapter); assert.equal(runtime.snapshot!.adapter.hash, digest(readFileSync(f.adapter)));
  assert.equal(runtime.snapshot!.subjects.find(subject => subject.requested === 'codex')!.path, f.codex);
  assert.equal(runtime.snapshot!.subjects.find(subject => subject.requested === 'codex')!.hash, digest(readFileSync(f.codex)));
  assert.equal(runtime.snapshot!.codex.result.stdout.trim(), 'codex-cli fixture-1');
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['version', 'provider']);
  assert.equal(f.store.list('model-call').length, 1); assert.equal(call.value.usage!.inputTokens, 10);
  assert.ok(call.value.request.record && call.value.response!.record);
  assert.equal(runtime.snapshot!.interpreter.path, realpathSync(process.execPath));
});

test('an unavailable version or undeclared adapter stays explicit and cannot masquerade as compatibility evidence', async t => {
  for (const [mode, declared, code] of [['bad-version', true, 'call_runtime_version_unavailable'], ['normal', false, 'call_runtime_adapter_not_declared']] as const) {
    const f = fixture(t, mode, declared); await f.invoke();
    const call = f.store.list<ModelCall>('model-call')[0]!;
    assert.equal(call.value.status, 'succeeded', 'Telemetry failure is not a new gate on the paid answer');
    assert.equal(call.value.runtime!.status, 'unavailable'); assert.equal(call.value.runtime!.error, code);
    assert.equal(call.value.usage!.outputTokens, 2); assert.equal(f.store.list('model-call').length, 1);
    assert.equal(call.value.runtime!.snapshot, null, 'Adapter-provided runtime text cannot supply an engine fingerprint');
  }
});

test('provider or adapter replacement during the call invalidates the runtime claim but preserves response and usage', async t => {
  for (const mode of ['changed-provider', 'changed-adapter']) {
    const f = fixture(t, mode); await f.invoke();
    const call = f.store.list<ModelCall>('model-call')[0]!;
    assert.equal(call.value.status, 'succeeded'); assert.equal(call.value.runtime!.status, 'stale');
    assert.equal(call.value.runtime!.error, 'call_runtime_changed'); assert.ok(call.value.response!.record);
    assert.deepEqual(call.value.usage, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 });
  }
});

test('a PATH substitution between capture and dispatch cannot produce a matching runtime claim', async t => {
  const f = fixture(t), alternative = join(f.root, 'other-bin'); mkdirSync(alternative);
  writeFileSync(join(alternative, 'codex'), readFileSync(f.codex)); chmodSync(join(alternative, 'codex'), 0o700);
  const original = f.store.writeMany.bind(f.store); let changed = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!changed && writes.some(write => write.kind === 'model-call' && write.value.status === 'running')) {
      changed = true; process.env['PATH'] = alternative + delimiter + process.env['PATH'];
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  await f.invoke(); const call = f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(call.value.status, 'succeeded'); assert.equal(call.value.runtime!.status, 'stale');
  assert.equal(call.value.runtime!.snapshot!.subjects.find(subject => subject.requested === 'codex')!.path, f.codex);
});

test('paid response and usage are durable before final fingerprint publication, including a concurrent telemetry conflict', async t => {
  const f = fixture(t), original = f.store.writeMany.bind(f.store); let intercepted = false;
  f.store.writeMany = ((writes: any[], guards: any[] = []) => {
    if (!intercepted && writes.some(write => write.kind === 'model-call' && write.value.runtime?.status === 'observed')) {
      intercepted = true; const paid = f.store.list<ModelCall>('model-call')[0]!;
      assert.equal(paid.value.status, 'succeeded'); assert.equal(paid.value.usage!.inputTokens, 10);
      assert.ok(paid.value.response!.record); assert.equal(paid.value.runtime!.error, 'call_runtime_finalize_pending');
      original([{ id: paid.id, kind: paid.kind, expected: paid.revision, value: paid.value }]);
    }
    return original(writes, guards);
  }) as Store['writeMany'];
  assert.deepEqual(await f.invoke(), { action: 'pause', reason: 'Local fixture' });
  assert.equal(intercepted, true); const call = f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(call.value.status, 'succeeded'); assert.equal(call.value.runtime!.status, 'unavailable');
  assert.equal(f.store.list('model-call').length, 1); assert.equal(readFileSync(f.log, 'utf8').split('provider').length - 1, 1);
});

test('historical unscoped calls are not reinterpreted and a missing declaration is explicitly unavailable in the new scoped path', async t => {
  const f = fixture(t);
  assert.equal(await captureCallRuntime(f.store, { ...f.draft.value, inputs: [] } as DiscoveryDraft, f.role, f.environment.value, 'old'), null);
  assert.equal(f.store.list('model-call').length, 0);
  const current = f.store.get<ResearchScope>(f.scope.id)!;
  const updated = f.store.write<ResearchScope>({ id: current.id, kind: current.kind, expected: current.revision,
    value: { ...current.value, policy: { ...current.value.policy!, assignments: [] } } });
  const result = await captureCallRuntime(f.store, { ...f.draft.value, inputs: [reference(updated)] }, f.role, f.environment.value, 'new');
  assert.equal(result!.status, 'unavailable'); assert.equal(result!.error, 'call_runtime_not_declared');
});

test('preview stops before version telemetry as well as before provider dispatch and reservations', async t => {
  const f = fixture(t), preview = await previewResearch(f.invoke);
  assert.equal(preview.draft, f.draft.id); assert.equal(preview.hash, digest(preview.input));
  assert.equal(existsSync(f.log), false); assert.equal(f.store.list('model-call').length, 0);
  assert.equal(f.store.list('project-dispatch').length, 0);
});
