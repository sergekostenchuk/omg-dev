import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { physicalClaim, authorizeModelDispatch, prepareModelCallRecovery, readModelCallRecovery, prepareLateModelReceipt, readLateModelReceipt, recoverModelCall } from '../src/discovery/model-call-recovery.js';
import { processStart } from '../src/runtime/process-identity.js';
import { modelUsage, type ModelCall, type ProcessIdentity } from '../src/runtime/model-usage.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-physical-')), store = new Store(join(root, 'store.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const seed = (requestId: string, owner: ProcessIdentity, provider: (ProcessIdentity & { group: number | null }) | null = null) => store.write<ModelCall>({ id: `model-call:${requestId}`, kind: 'model-call', expected: 0,
    value: { projectId: 'p', draftId: 'd', purpose: 'analyst', requestId, startedAt: 1, finishedAt: null, status: 'running', requested: { actor: 'test', model: 'fixture', effort: 'low', command: { executable: process.execPath, args: [] } },
      confirmed: { model: null, effort: null, speed: null }, request: { chars: 2, bytes: 2, hash: hashJson({}) }, response: null, usage: null, usageSource: 'unavailable', error: null,
      ownerProcess: owner, ...(provider ? { providerProcess: { pid: provider.pid, started: provider.started } } : {}),
      execution: { version: 'model-execution/v1', phase: provider ? 'authorized' : 'claimed', owner, provider } } });
  return { root, store, seed };
}
async function localProcess(t: test.TestContext, body = 'console.log("ready");setInterval(()=>{},1000)', group = false) {
  const child = spawn(process.execPath, ['-e', body], { detached: group, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { if (group) process.kill(-child.pid!, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} });
  await once(child.stdout!, 'data');
  return { child, identity: { pid: child.pid!, started: processStart(child.pid!) } };
}
async function stop(child: ChildProcess) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }

// A real owner dies before onSpawn. A waiting child cannot be claimed absent,
// but the persisted request boundary proves no model request was authorized.
test('physical era recovers a real lost owner before dispatch with visible unknown process and usage', async t => {
  const f = fixture(t), owner = await localProcess(t), call = f.seed('before-spawn', owner.identity);
  assert.throws(() => prepareModelCallRecovery(f.store, 'p', reference(call)), { code: 'model_call_still_running' });
  await stop(owner.child);
  const omCall = f.seed('needs-producer', owner.identity);
  const om = f.store.write({ id: omCall.id, kind: omCall.kind, expected: omCall.revision, value: { ...omCall.value, om: { application: 'running' } } });
  assert.throws(() => recoverModelCall(f.store, 'p', reference(om)), { code: 'model_call_recovery_producer_required' });
  assert.equal(f.store.get(om.id)!.hash, om.hash);
  const prepared = prepareModelCallRecovery(f.store, 'p', reference(call));
  assert.equal(f.store.get(call.id)!.revision, 1, 'preparation has no side effects');
  assert.deepEqual(prepared.incident.value.proof, { owner: 'gone', provider: 'not-authorized', group: 'unknown', request: 'not-authorized', physical: 'unknown' });
  const recovered = f.store.writeMany<ModelCall>(prepared.writes, prepared.guards)[0]!;
  assert.equal(recovered.value.usage, null);
  assert.equal(readModelCallRecovery(f.store, 'p', reference(recovered)).original.hash, call.hash);
  const usage = modelUsage(f.store, 'p', 0);
  assert.equal(usage.active.some(active => active.id === call.id), false); assert.equal(usage.cumulative.unmeasuredCalls, 2);
  assert.equal(usage.interruptions[0]!.physical, 'unknown');
  const restarted = new Store(f.store.path); t.after(() => restarted.close());
  assert.deepEqual(readModelCallRecovery(restarted, 'p', reference(recovered)).proof, prepared.incident.value.proof);
  assert.throws(() => recoverModelCall(restarted, 'p', reference(call)), { code: 'model_call_foreign' });
  const forgedStore = new Proxy(f.store, { get(target, field) {
    if (field === 'get') return (id: string, revision?: number) => {
      const row = target.get(id, revision);
      if (id === recovered.id && revision === recovered.revision && row) return { ...row, value: { ...recovered.value, startedAt: 999 } };
      return row;
    };
    const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => readModelCallRecovery(forgedStore, 'p', reference(recovered)), { code: 'model_call_recovery_invalid' });
});

test('physical dispatch stores provider before transfer and fences a foreign owner or stale claim', async t => {
  const f = fixture(t), own = physicalClaim(), provider = await localProcess(t, 'console.log("ready");process.stdin.resume() ', process.platform !== 'win32');
  const call = f.seed('authorize', own.ownerProcess!);
  const authorized = authorizeModelDispatch(f.store, reference(call), provider.identity.pid);
  assert.equal(authorized.value.execution!.phase, 'authorized');
  assert.deepEqual(authorized.value.providerProcess, provider.identity);
  assert.throws(() => authorizeModelDispatch(f.store, reference(call), provider.identity.pid), { code: 'model_call_foreign' });
  const foreignOwner = await localProcess(t), foreign = f.seed('foreign', foreignOwner.identity);
  assert.throws(() => authorizeModelDispatch(f.store, reference(foreign), provider.identity.pid), { code: 'model_call_dispatch_unowned' });
});

test('physical recovery preserves a living provider and surviving group after actual owner and leader loss', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), owner = await localProcess(t);
  const provider = await localProcess(t, "const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)", true);
  const call = f.seed('group', owner.identity, { ...provider.identity, group: provider.identity.pid });
  await stop(owner.child);
  assert.throws(() => prepareModelCallRecovery(f.store, 'p', reference(call)), { code: 'model_call_still_running' });
  await stop(provider.child);
  assert.throws(() => prepareModelCallRecovery(f.store, 'p', reference(call)), { code: 'model_call_process_uncertain' });
  assert.equal(f.store.get(call.id)!.hash, call.hash);
});

test('physical lost dispatch recovery is CAS atomic and archives exact late bytes without reopening it', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), owner = await localProcess(t), provider = await localProcess(t, undefined, true);
  const call = f.seed('sent', owner.identity, { ...provider.identity, group: provider.identity.pid });
  await stop(owner.child); await stop(provider.child);
  const first = prepareModelCallRecovery(f.store, 'p', reference(call)), competitor = prepareModelCallRecovery(f.store, 'p', reference(call));
  const recovered = f.store.writeMany<ModelCall>(first.writes, first.guards)[0]!;
  assert.throws(() => f.store.writeMany(competitor.writes, competitor.guards), { code: 'input_stale' });
  assert.equal(f.store.list('model-call-recovery').length, 1);
  const processResult = { exitCode: 0, signal: null, stdout: JSON.stringify({ protocol: 'omg-agent/v1', requestId: 'sent', research: { ok: true }, usage: { inputTokens: 9, outputTokens: 2, cachedInputTokens: null, reasoningOutputTokens: null } }), stderr: '' };
  const late = prepareLateModelReceipt(f.store, 'p', reference(call), { process: processResult, launchError: null });
  f.store.writeMany(late.writes, late.guards);
  assert.equal(f.store.get(call.id)!.hash, recovered.hash, 'late evidence never rolls back the interrupted terminal state');
  assert.equal(late.record.value.evidence.process!.stdout, processResult.stdout);
  assert.equal(readLateModelReceipt(f.store, 'p', reference(recovered))!.hash, late.record.hash);
  assert.equal(prepareLateModelReceipt(f.store, 'p', reference(call), { process: processResult, launchError: null }).writes.length, 0);
  assert.throws(() => prepareLateModelReceipt(f.store, 'p', reference(call), { process: { ...processResult, stdout: 'substituted bytes' }, launchError: null }), { code: 'model_call_late_receipt_invalid' });
  assert.equal(readModelCallRecovery(f.store, 'p', reference(recovered)).proof.physical, 'group-terminated');
  const restarted = new Store(f.store.path); t.after(() => restarted.close());
  assert.equal(prepareLateModelReceipt(restarted, 'p', reference(call), { process: processResult, launchError: null }).record.hash, late.record.hash);
  const forged = { ...recovered.value, execution: { ...recovered.value.execution!, phase: 'claimed' as const, provider: null } };
  const bad = f.store.write<ModelCall>({ id: recovered.id, kind: recovered.kind, expected: recovered.revision, value: forged });
  assert.throws(() => readModelCallRecovery(f.store, 'p', reference(bad)), { code: 'model_call_recovery_invalid' });
});

test('receipt wins against prepared recovery without a partial interruption record', async t => {
  const f = fixture(t), owner = await localProcess(t), call = f.seed('receipt-race', owner.identity);
  await stop(owner.child);
  const pending = prepareModelCallRecovery(f.store, 'p', reference(call));
  f.store.write({ id: call.id, kind: call.kind, expected: call.revision, value: { ...call.value, status: 'succeeded', response: { chars: 2, bytes: 2 }, finishedAt: 2 } });
  assert.throws(() => f.store.writeMany(pending.writes, pending.guards), { code: 'input_stale' });
  assert.equal(f.store.list('model-call-recovery').length, 0);
});
