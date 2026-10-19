import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, storeBodyCache } from '../src/storage/store.js';
import { provenStore, storeView } from '../src/storage/store-view.js';
import { transactionForTests } from '../src/om/atomic-gate.js';
import { canonical, type Json } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import {
  runProcess, stopOwnedGroup, classifyStopErrno, probeProcessIdentity,
  type ProcessIdentityProbe, type ProcessStopHooks
} from '../src/runtime/process.js';
import { processStart, writeProcessStopWitness, processStopWitnesses, evaluateProcessStopWitnesses,
  processStopPhysical, type ProcessStopWitness } from '../src/runtime/process-identity.js';
import { recoverRuntimeObservation } from '../src/runtime/runtime-observation.js';
import { stopOrphan } from '../src/execution/process.js';
import { executionFixture } from './execution-fixture.js';
import type { RuntimeObservation } from '../src/runtime/runtime-observation-model.js';
import { EngineError } from '../src/errors.js';

// Every test names the row of outcome table №1500 it pins down.

function storeFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-'));
  const store = new Store(join(root, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

const absent: ProcessIdentityProbe = { state: 'absent' };
const present = (started: string): ProcessIdentityProbe => ({ state: 'present', started });
const unavailable = (errno = 'ps_unavailable'): ProcessIdentityProbe => ({ state: 'unavailable', errno });

function runningRecord(store: Store, over: Partial<RuntimeObservation> = {}) {
  const value: RuntimeObservation = {
    version: 1, projectId: 'p', key: 'k',
    scope: { id: 'research-scope:p:R2', revision: 1, hash: '0'.repeat(64) }, requestedFor: 'o',
    check: { script: { id: 's', revision: 1, hash: '0'.repeat(64) }, dependencies: [], subjects: [], executables: [], args: [], timeoutMs: 1000, purpose: 't' },
    environment: { id: 'e', revision: 1, hash: '0'.repeat(64) }, context: [], root: '/tmp', codeRoot: null,
    runtimeBinding: 'b', platform: { os: 'x', release: 'y', arch: 'z', node: 'v' },
    executable: { path: '/x', hash: 'h', identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 } },
    subjects: [], snapshot: '/snap-kept', invocation: null,
    owner: { pid: 4242, started: 'owner-start' }, child: null,
    startedAt: 1, finishedAt: null, status: 'running', result: null, error: null, ...over
  };
  return store.write<RuntimeObservation>({ id: 'runtime-observation:t', kind: 'runtime-observation', expected: 0, value });
}

const deadOwner: ProcessStopHooks = { identify: () => absent };

function thrown(fn: () => unknown): EngineError {
  try { fn(); } catch (error) { return error as EngineError; }
  throw new Error('expected a typed refusal');
}
async function rejected(p: Promise<unknown>): Promise<EngineError> {
  try { await p; } catch (error) { return error as EngineError; }
  throw new Error('expected a typed refusal');
}

test('row 1: a pre-cancelled launch rejects before spawn and sends no signal', async () => {
  let signals = 0;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(
    runProcess({ executable: process.execPath, args: ['-e', '1'] }, process.cwd(), '', 1000, controller.signal, true, undefined,
      { signal: () => { signals++; return null; } }),
    { code: 'process_cancelled' });
  assert.equal(signals, 0);
});

test('row 2/3: a failed spawn rejects with process_failed and never signals a null pid', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const noExec = join(root, 'bogus-binary');
  writeFileSync(noExec, '#!/definitely/missing/interpreter\nexit 0\n', { mode: 0o755 });
  let signals = 0;
  await assert.rejects(
    runProcess({ executable: noExec, args: [] }, process.cwd(), '', 1000, undefined, true, undefined,
      { signal: () => { signals++; return null; } }),
    { code: 'process_failed' });
  assert.equal(signals, 0);
});

test('row 3: invalid or missing identity is refused at validate before any signal', () => {
  let signals = 0;
  const hooks: ProcessStopHooks = { identify: () => present('x'), signal: () => { signals++; return null; } };
  for (const target of [{ pid: 0, started: 'x' }, { pid: -1, started: 'x' }, { pid: 1.5, started: 'x' }, { pid: 7, started: '' }]) {
    const report = stopOwnedGroup(target, hooks);
    assert.equal(report.outcome, 'identity-unavailable');
    assert.equal(report.stage, 'validate');
  }
  assert.equal(signals, 0);
});

test('row 5: an unverifiable owner refuses recovery before touching the child', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  let signals = 0, childProbes = 0;
  assert.throws(() => recoverRuntimeObservation(store, 'p', reference(record), {
    identify: pid => { if (pid === 777) childProbes++; return unavailable('EPERM'); },
    signal: () => { signals++; return null; }
  }), { code: 'process_identity_unavailable' });
  assert.equal(signals, 0); assert.equal(childProbes, 0);
  assert.equal(store.get<RuntimeObservation>(record.id)!.value.status, 'running');
});

test('row 6: no stored child and a proven-dead owner closes the interrupted record without a signal', t => {
  const store = storeFixture(t);
  const record = runningRecord(store);
  let signals = 0;
  const closed = recoverRuntimeObservation(store, 'p', reference(record), { ...deadOwner, signal: () => { signals++; return null; } });
  assert.equal(closed.value.status, 'failed'); assert.equal(closed.value.child, null); assert.equal(signals, 0);
});

test('row 7: a proven-absent child closes the record; no signal is sent', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  let signals = 0;
  const closed = recoverRuntimeObservation(store, 'p', reference(record), { identify: () => absent, signal: () => { signals++; return null; } });
  assert.equal(closed.value.status, 'failed'); assert.equal(signals, 0);
});

test('row 8/15: a changed identity is never signalled but lets the record close', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'original' } });
  let signals = 0;
  const closed = recoverRuntimeObservation(store, 'p', reference(record), {
    identify: pid => pid === 4242 ? absent : present('recycled'), signal: () => { signals++; return null; }
  });
  assert.equal(signals, 0); assert.equal(closed.value.status, 'failed');
  const report = stopOwnedGroup({ pid: 1, started: 'a' }, { identify: () => present('b'), signal: () => { signals++; return null; } });
  assert.equal(report.outcome, 'identity-changed'); assert.equal(report.observedStarted, 'b'); assert.equal(signals, 0);
});

test('rows 9+21: an accepted signal with the child still alive defers recovery and preserves the record', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  const snapshot = record.value.snapshot;
  const attempt = () => recoverRuntimeObservation(store, 'p', reference(record), {
    identify: pid => pid === 4242 ? absent : present('c'), signal: () => null
  });
  const error = thrown(attempt);
  assert.equal(error.code, 'process_stop_unconfirmed');
  const details = error.details as { outcome: string; errno: string | null };
  assert.equal(details.outcome, 'stop-requested'); assert.equal(details.errno, null);
  const kept = store.get<RuntimeObservation>(record.id)!;
  assert.equal(kept.revision, record.revision, 'deferred recovery writes no new revision');
  assert.equal(kept.value.status, 'running');
  assert.deepEqual(kept.value.child, { pid: 777, started: 'c' });
  assert.equal(kept.value.snapshot, snapshot);
});

test('row 10: an accepted signal plus proven absence closes the record as stopped', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  const probes: number[] = [];
  const closed = recoverRuntimeObservation(store, 'p', reference(record), {
    identify: pid => { if (pid === 777) probes.push(pid); return absent; }, signal: () => null
  });
  assert.equal(closed.value.status, 'failed'); assert.equal(closed.value.child, null);
  assert.equal(probes.length, 2, 'identity is probed before and after the signal');
});

test('row 11: stopOrphan bounds its wait and reports executor_still_running instead of hanging', async () => {
  let probes = 0;
  await assert.rejects(stopOrphan({ pid: 777, started: 'c' }, { identify: () => { probes++; return present('c'); }, signal: () => null }),
    { code: 'executor_still_running' });
  assert.ok(probes > 1 && probes < 100);
});

test('row 12: ESRCH plus proven absence closes; ESRCH plus live child stays unconfirmed', t => {
  const store = storeFixture(t);
  const alive = runningRecord(store, { child: { pid: 777, started: 'c' } });
  assert.throws(() => recoverRuntimeObservation(store, 'p', reference(alive), {
    identify: pid => pid === 4242 ? absent : present('c'), signal: () => 'ESRCH'
  }), { code: 'process_stop_unconfirmed' });
  const storeB = storeFixture(t);
  const gone = runningRecord(storeB, { child: { pid: 777, started: 'c' } });
  const closed = recoverRuntimeObservation(storeB, 'p', reference(gone), { identify: () => absent, signal: () => 'ESRCH' });
  assert.equal(closed.value.status, 'failed');
});

test('row 13: EPERM with the child still alive is denied; record, identity and snapshot survive', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  const error = thrown(() => recoverRuntimeObservation(store, 'p', reference(record), {
    identify: pid => pid === 4242 ? absent : present('c'), signal: () => 'EPERM'
  }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; errno: string; stage: string; pid: number };
  assert.equal(details.outcome, 'denied'); assert.equal(details.errno, 'EPERM');
  assert.equal(details.pid, 777); assert.equal(details.stage, 'signal');
  const kept = store.get<RuntimeObservation>(record.id)!;
  assert.equal(kept.value.status, 'running'); assert.deepEqual(kept.value.child, { pid: 777, started: 'c' });
  for (const errno of ['EACCES', 'EPERM'])
    assert.equal(classifyStopErrno(errno, present('c'), 'c'), 'denied');
});

test('row 14: EPERM plus independently proven absence is lawful and keeps the errno', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  let probes = 0;
  const closed = recoverRuntimeObservation(store, 'p', reference(record), {
    identify: pid => pid === 777 ? (probes++ === 0 ? present('c') : absent) : absent, signal: () => 'EPERM'
  });
  assert.equal(closed.value.status, 'failed');
  let calls = 0;
  const report = stopOwnedGroup({ pid: 5, started: 'x' }, {
    identify: () => calls++ === 0 ? present('x') : absent, signal: () => 'EPERM'
  });
  assert.equal(report.outcome, 'absent'); assert.equal(report.errno, 'EPERM');
});

test('row 16: an unrelated syscall error is failed, never absence', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  assert.throws(() => recoverRuntimeObservation(store, 'p', reference(record), {
    identify: pid => pid === 4242 ? absent : present('c'), signal: () => 'EIO'
  }), { code: 'process_stop_failed' });
  assert.equal(classifyStopErrno('EIO', absent, 'c'), 'failed');
  assert.equal(classifyStopErrno('EINVAL', absent, 'c'), 'failed');
});

test('row 17: a lawful stop preserves the original timeout as the failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let pid: number | null = null;
  t.after(() => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { } });
  // The stub reports an accepted signal and performs the real kill so the run can close.
  await assert.rejects(runProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, root, '', 100, undefined, true,
    p => { pid = p; }, { signal: () => { try { process.kill(-pid!, 'SIGKILL'); } catch { } return null; }, identify: () => absent }),
    { code: 'process_timeout' });
});

test('row 18: a refused stop surfaces its own typed error and keeps the original reason as cause', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let pid: number | null = null;
  t.after(() => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { } });
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, root, '', 100, undefined, true,
    p => { pid = p; }, { signal: () => 'EPERM', identify: () => present('still-here') }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; errno: string; cause: { code: string } };
  assert.equal(details.outcome, 'denied'); assert.equal(details.errno, 'EPERM'); assert.equal(details.cause.code, 'process_timeout');
});

test('row 19: leader exit plus a refused group sweep rejects with the real result on the private carrier (№1631-5 C24)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let signals = 0, probes = 0;
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('partial-out')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => { signals++; return 'EPERM'; },
      // D8.5.1 (№2433): the refused sweep is re-probed; absence here stays UNPROVEN (the group never reads absent),
      // so the denial stands as before.
      probeGroup: () => { probes++; return 'EPERM'; } }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; stage: string; result?: unknown; errno?: string; groupProbe?: string | null };
  assert.equal(details.outcome, 'denied'); assert.equal(details.stage, 'group-sweep');
  assert.equal(details.errno, 'EPERM'); assert.equal(details.groupProbe, 'EPERM');
  assert.equal(signals, 1); assert.ok(probes >= 1 && probes <= 6, `probes ${probes} within the budget`);
  // Public diagnostics never carry the physical bytes; server.ts serializes
  // details into HTTP responses. The private carrier keeps them with the
  // completeness flag for the subject's own recovery path.
  assert.equal(details.result, undefined);
  assert.doesNotMatch(JSON.stringify(details), /partial-out/);
  const physical = processStopPhysical(error);
  assert.equal(physical!.complete, true); assert.equal(physical!.exitCode, 0); assert.equal(physical!.stdout, 'partial-out');
});

// D8.5.1 (№2433): a transient EPERM/EACCES of the sweep with the group proven absent by the same-PGID
// signal-0 probe is absent — the command's actual result is returned, the refusal never masks it.
test('row 19c: a refused sweep with the group proven absent resolves with the real result (EPERM)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let signals = 0, probes = 0;
  const result = await runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('partial-out'); process.exitCode = 1"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => { signals++; return 'EPERM'; }, probeGroup: () => { probes++; return 'ESRCH'; } });
  assert.equal(result.exitCode, 1); assert.equal(result.stdout, 'partial-out');
  assert.equal(signals, 1); assert.equal(probes, 1);
});

test('row 19d: a refused sweep with the group proven absent resolves with the real result (EACCES)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('done')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EACCES', probeGroup: () => 'ESRCH' });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'done');
});

test('row 19e: a late proven absence still resolves — the probe retries within its budget', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let signals = 0, probes = 0;
  const result = await runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('late')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => { signals++; return 'EPERM'; }, probeGroup: () => { probes++; return probes === 1 ? 'EPERM' : 'ESRCH'; } });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'late');
  assert.equal(signals, 1); assert.ok(probes >= 2, `second probe happened (${probes})`);
});

test('row 19f: a probe answering present keeps the denial and the original errno', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let probes = 0;
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EPERM', probeGroup: () => { probes++; return null; } }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; errno: string; groupProbe?: string | null };
  assert.equal(details.outcome, 'denied'); assert.equal(details.errno, 'EPERM'); assert.equal(details.groupProbe, null);
  assert.ok(probes >= 1 && probes <= 6, `probes ${probes} within the budget`);
});

test('row 19g: a probe observation error is no absence — the original denial keeps its diagnostics', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EPERM', probeGroup: () => 'EIO' }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; errno: string; groupProbe?: string | null };
  assert.equal(details.outcome, 'denied'); assert.equal(details.errno, 'EPERM'); assert.equal(details.groupProbe, 'EIO');
});

test('row 19h: a throwing probe is an observation error, never an absence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EPERM', probeGroup: () => { throw Object.assign(new Error('probe blew'), { code: 'EBADF' }); } }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; errno: string; groupProbe?: string | null };
  assert.equal(details.outcome, 'denied'); assert.equal(details.errno, 'EPERM'); assert.equal(details.groupProbe, 'EBADF');
});

test('row 19i: a sweep error other than EPERM/EACCES keeps the previous classification and is never probed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let probes = 0;
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EIO', probeGroup: () => { probes++; return 'ESRCH'; } }));
  assert.equal(error.code, 'process_stop_failed');
  assert.equal(probes, 0);
});

test('row 19b: leader exit plus a clean sweep resolves normally', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('done')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'ESRCH' });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'done');
});

test('row 20: timeout and exit racing produce one outcome and at most one signal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let pid: number | null = null, signals = 0;
  t.after(() => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { } });
  const controller = new AbortController();
  const run = runProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, root, '', 60, controller.signal, true,
    p => { pid = p; }, { signal: () => { signals++; try { process.kill(-pid!, 'SIGKILL'); } catch { } return null; }, identify: () => absent });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(run, (e: EngineError) => e.code === 'process_timeout' || e.code === 'process_cancelled');
  assert.equal(signals, 1);
});

// №2475 (D8.5.1 return 1): an abort/timeout landing between close and the sweep probe's end must not
// lose the already-complete physical — the refusal carries it (complete:true, the real exitCode)
// with the original reason as cause. The ESRCH control keeps the bare original reason.
for (const reason of ['abort', 'timeout'] as const) for (const finalProbe of ['EPERM', 'ESRCH'] as const) {
  test(`row 19j: ${reason} after close while the sweep probe is pending, then ${finalProbe}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const controller = new AbortController();
    let closed = false, signals = 0, probes = 0;
    let triggerTimeout: (() => void) | null = null;
    const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    const originalSpawn = cp.spawn, originalTimeout = globalThis.setTimeout;
    t.after(() => { (cp as { spawn: unknown }).spawn = originalSpawn; globalThis.setTimeout = originalTimeout; syncBuiltinESMExports(); });
    globalThis.setTimeout = (((callback: (...args: never[]) => void, delay?: number, ...args: never[]) => {
      if (delay === 4000) triggerTimeout = () => callback(...args);
      return originalTimeout(callback, delay, ...args);
    }) as unknown) as typeof setTimeout;
    (cp as { spawn: unknown }).spawn = (...args: never[]) => {
      const child = (originalSpawn as (...a: never[]) => ReturnType<typeof originalSpawn>)(...args);
      // Fire only after every close listener, including runProcess's own, has returned.
      child.once('close', () => { closed = true; queueMicrotask(() => reason === 'abort' ? controller.abort() : triggerTimeout?.()); });
      return child;
    };
    syncBuiltinESMExports();
    const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('whole-output'); process.stderr.write('whole-error'); process.exitCode=7"] },
      root, '', 4000, controller.signal, true, undefined,
      { signal: () => { signals++; return 'EPERM'; }, probeGroup: () => { probes++; return closed ? finalProbe : 'EPERM'; } }));
    assert.equal(closed, true);
    assert.equal(signals, 1);
    assert.ok(probes > 1 && probes <= 6, `probes ${probes} within the budget`);
    const cause = reason === 'abort' ? 'process_cancelled' : 'process_timeout';
    if (finalProbe === 'ESRCH') {
      assert.equal(error.code, cause);
      return;
    }
    assert.equal(error.code, 'process_stop_denied');
    const details = error.details as { errno: string; groupProbe?: string | null; cause: { code: string } };
    assert.equal(details.errno, 'EPERM'); assert.equal(details.groupProbe, 'EPERM'); assert.equal(details.cause.code, cause);
    assert.deepEqual(processStopPhysical(error), { exitCode: 7, signal: null, stdout: 'whole-output', stderr: 'whole-error', complete: true });
  });
}

// PROC1 (D8.5.1 rework): the re-probe schedule is exercised under a controlled monotonic clock —
// performance.now advances only through the waits the probe asked for (plus an injected overshoot
// for the overdue-timer case), so the asserted schedule is exact, not sampled. The run's own
// millisecond timeout stays on the real clock.
function probeClock(t: test.TestContext, overshoot = 0) {
  const realNow = performance.now.bind(performance);
  const realTimeout = globalThis.setTimeout;
  const waits: number[] = [];
  let now = 0;
  (performance as unknown as { now: () => number }).now = () => now;
  globalThis.setTimeout = (((callback: (...args: never[]) => void, delay = 0, ...args: never[]) => {
    if (delay < 2000) { waits.push(delay); return realTimeout(() => { now += delay + overshoot; callback(...args); }, 0); }
    return realTimeout(callback, delay, ...args);
  }) as unknown) as typeof setTimeout;
  t.after(() => { (performance as unknown as { now: () => number }).now = realNow; globalThis.setTimeout = realTimeout; });
  return { waits, advance: (ms: number) => { now += ms; } };
}

test('row 19k: an absence arriving after the old 100 ms is still proven — first probe at once, waits double to 320 ms', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = probeClock(t);
  let signals = 0; const probePids: number[] = [];
  const result = await runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('late-absent')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => { signals++; return 'EPERM'; },
      probeGroup: pid => { probePids.push(pid); return probePids.length < 6 ? 'EPERM' : 'ESRCH'; } });
  assert.equal(result.stdout, 'late-absent'); assert.equal(result.exitCode, 0);
  assert.equal(signals, 1, 'exactly one signal — the probe never signals again');
  assert.equal(probePids.length, 6); assert.ok(probePids.every(pid => pid === probePids[0] && pid > 0), 'the same verified PGID, never 0/-1');
  assert.deepEqual(clock.waits, [20, 40, 80, 160, 320], 'first probe at once, then doubling waits — the sixth lands at ~620 ms, past the old 100 ms deadline');
});

test('row 19l: a group that never proves absent is denied after the last probe — the report carries attempts and elapsedMs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = probeClock(t);
  let probes = 0;
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EPERM', probeGroup: () => { probes++; return 'EPERM'; } }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; errno: string; groupProbe?: string | null; attempts?: number; elapsedMs?: number; cause: null };
  assert.equal(details.outcome, 'denied'); assert.equal(details.errno, 'EPERM'); assert.equal(details.groupProbe, 'EPERM');
  assert.equal(probes, 6); assert.equal(details.attempts, 6); assert.equal(details.elapsedMs, 620);
  assert.deepEqual(clock.waits, [20, 40, 80, 160, 320]);
  assert.equal(processStopPhysical(error)?.complete, true);
});

test('row 19m: a wait resuming past the deadline sends no probe — the budget ends by time, not attempts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = probeClock(t, 2000);
  let probes = 0;
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EPERM', probeGroup: () => { probes++; return null; } }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; groupProbe?: string | null; attempts?: number; elapsedMs?: number };
  assert.equal(details.outcome, 'denied'); assert.equal(details.groupProbe, null);
  assert.equal(probes, 1); assert.equal(details.attempts, 1); assert.equal(details.elapsedMs, 2020);
  assert.deepEqual(clock.waits, [20], 'one overdue wake — and no further probe is sent');
});

test('row 19n: each wait is bounded by the time left to the deadline — probing ends at it, never past it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = probeClock(t);
  let probes = 0;
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, undefined, true,
    undefined, { signal: () => 'EPERM', probeGroup: () => { probes++; clock.advance(100); return 'EPERM'; } }));
  assert.equal(error.code, 'process_stop_denied');
  const details = error.details as { outcome: string; attempts?: number; elapsedMs?: number };
  assert.equal(details.outcome, 'denied');
  assert.equal(probes, 5); assert.equal(details.attempts, 5); assert.equal(details.elapsedMs, 1000);
  assert.deepEqual(clock.waits, [20, 40, 80, 160, 200], 'the fifth wait is cut to the 200 ms remaining');
});

test('row 23: a finished record replays its own state without touching any process', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { status: 'failed', child: null, finishedAt: 2 });
  let probes = 0, signals = 0;
  const again = recoverRuntimeObservation(store, 'p', reference(record),
    { identify: () => { probes++; return absent; }, signal: () => { signals++; return null; } });
  assert.equal(again.id, record.id); assert.equal(again.revision, record.revision);
  assert.equal(probes, 0); assert.equal(signals, 0);
});

test('row 24: a stale ref cannot act on a newer revision of the same observation', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  const closed = recoverRuntimeObservation(store, 'p', reference(record), deadOwner);
  assert.equal(closed.value.status, 'failed');
  assert.throws(() => recoverRuntimeObservation(store, 'p', reference(record), deadOwner), { code: 'runtime_observation_stale' });
});

test('row 25: stopOrphan only proceeds on a proven outcome and never signals an unverifiable pid', async () => {
  let signals = 0;
  await assert.rejects(stopOrphan({ pid: 777, started: 'c' }, { identify: () => present('c'), signal: () => { signals++; return 'EPERM'; } }),
    { code: 'process_stop_denied' });
  assert.equal(signals, 1);
  await assert.rejects(stopOrphan({ pid: 777, started: 'c' }, { identify: () => unavailable('EAGAIN') }),
    { code: 'process_identity_unavailable' });
  assert.equal(signals, 1, 'no signal when identity is unverifiable');
  await stopOrphan(null); await stopOrphan({ pid: 777, started: 'c' }, { identify: () => absent });
});

test('row 26: managed group recovery is refused on win32 before any signal', t => {
  const store = storeFixture(t);
  const record = runningRecord(store, { child: { pid: 777, started: 'c' } });
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    let signals = 0;
    assert.throws(() => recoverRuntimeObservation(store, 'p', reference(record), {
      identify: pid => pid === 4242 ? absent : present('c'), signal: () => { signals++; return null; }
    }), { code: 'runtime_recovery_unsupported' });
    assert.equal(signals, 0);
  } finally { Object.defineProperty(process, 'platform', original); }
});

test('no secrets leak: refusal details carry diagnostics only, never stdin or command context', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let pid: number | null = null;
  t.after(() => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { } });
  const error = await rejected(runProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, root,
    'secret-input-bytes', 80, undefined, true, p => { pid = p; },
    { signal: () => 'EPERM', identify: () => present('x') }));
  assert.equal(error.code, 'process_stop_denied');
  assert.doesNotMatch(JSON.stringify(error.details), /secret-input-bytes|args|executable/);
});

test('probe distinguishes present, absent and unanswerable identities (№1500: empty output is not absence)', () => {
  const self = probeProcessIdentity(process.pid);
  assert.deepEqual(self, { state: 'present', started: processStart(process.pid) });
  // A valid-range but unassigned pid: ps exits 1 with empty streams.
  assert.deepEqual(probeProcessIdentity(99999), { state: 'absent' });
  // A pid ps cannot even parse ("process id too large" on stderr) is
  // unanswerable — never proof of absence.
  const unparsed = probeProcessIdentity(2147483647);
  assert.equal(unparsed.state, 'unavailable');
});

// №1631-1 C43/C44: witnesses bind the exact attempt revision, not subject.id.
test('№1631-1: a process-stop witness is addressed by the exact attempt revision and CAS-checked', t => {
  const store = storeFixture(t);
  const attempt1 = { id: 'task-run:t', revision: 3, hash: 'a'.repeat(64) };
  const attempt2 = { id: 'task-run:t', revision: 5, hash: 'b'.repeat(64) };
  const refusal = (pid: number) => Object.defineProperty(
    new EngineError('process_stop_denied', 'refused', { outcome: 'denied', stage: 'signal', target: 'group', pid, errno: 'EPERM', cause: null }),
    'physical', { value: { exitCode: null, signal: null, stdout: 's', stderr: 'e', complete: false }, enumerable: false }) as EngineError;
  // Attempt one leaves its witness; a second refusal of the SAME attempt is an
  // exact repeat — same address, same content, no new revision.
  writeProcessStopWitness(store, attempt1, { child: null, pid: 45017 }, refusal(45017));
  writeProcessStopWitness(store, attempt1, { child: null, pid: 45017 }, refusal(45017));
  const first = store.get<ProcessStopWitness>(`process-stop:${attempt1.id}:3`)!;
  assert.equal(first.revision, 1); assert.equal(first.value.pid, 45017);
  // A later attempt can never inherit the earlier witness: it gets its own
  // address derived from its own exact record revision.
  writeProcessStopWitness(store, attempt2, { child: null, pid: 45271 }, refusal(45271));
  const witnesses = processStopWitnesses(store, 'task-run:t');
  assert.equal(witnesses.length, 2);
  assert.equal(witnesses.find(w => (w.value as ProcessStopWitness).pid === 45271)!.id, `process-stop:${attempt2.id}:5`);
  // A newer observation of the SAME attempt CAS-advances its own witness.
  writeProcessStopWitness(store, attempt1, { child: null, pid: 45017 },
    new EngineError('process_stop_unconfirmed', 'still unproven',
      { outcome: 'unconfirmed', stage: 'post-check', target: 'child', pid: 45017, errno: null, cause: null }));
  assert.equal(store.get<ProcessStopWitness>(`process-stop:${attempt1.id}:3`)!.revision, 2);
  assert.equal(store.get<ProcessStopWitness>(`process-stop:${attempt1.id}:3`)!.value.outcome, 'unconfirmed');
  // A record at the occupied address that names a foreign subject is refused:
  // a matching subject.id alone is not an exact repeat.
  const corrupted = store.get<ProcessStopWitness>(`process-stop:${attempt1.id}:3`)!;
  store.write({ id: corrupted.id, kind: corrupted.kind, expected: corrupted.revision,
    value: { ...corrupted.value, subject: { id: 'task-run:t', revision: 9, hash: 'd'.repeat(64) } } });
  assert.throws(() => writeProcessStopWitness(store, attempt1, { child: null, pid: 45017 }, refusal(45017)),
    { code: 'process_stop_witness_foreign' });
});

// №1679-2: a diagnostic without new bytes must never erase captured evidence.
test('№1679-2: a repeated diagnostic preserves the complete physical result and a conflicting complete result is refused', t => {
  const store = storeFixture(t);
  const attempt = { id: 'task-run:t', revision: 3, hash: 'a'.repeat(64) };
  const physical = (stdout: string, complete: boolean) =>
    ({ exitCode: complete ? 0 : null, signal: null, stdout, stderr: 'e', complete });
  const refusalWith = (pid: number, result: ReturnType<typeof physical> | null) => {
    const e = new EngineError('process_stop_denied', 'refused',
      { outcome: 'denied', stage: 'signal', target: 'group', pid, errno: 'EPERM', cause: null });
    if (result) Object.defineProperty(e, 'physical', { value: result, enumerable: false });
    return e;
  };
  const id = `process-stop:${attempt.id}:3`;
  writeProcessStopWitness(store, attempt, { child: null, pid: 45017 }, refusalWith(45017, physical('full-output', true)));
  // A diagnostic carrying no physical result keeps the earlier complete one.
  writeProcessStopWitness(store, attempt, { child: null, pid: 45017 },
    new EngineError('process_identity_unavailable', 'probe down',
      { outcome: 'identity-unavailable', stage: 'pre-check', target: 'child', pid: 45017, errno: 'ps_gone', cause: null }));
  const kept = store.get<ProcessStopWitness>(id)!;
  assert.equal(kept.value.physical?.complete, true);
  assert.equal(kept.value.physical?.stdout, 'full-output');
  // A partial capture never supersedes a complete one.
  writeProcessStopWitness(store, attempt, { child: null, pid: 45017 }, refusalWith(45017, physical('partial', false)));
  assert.equal(store.get<ProcessStopWitness>(id)!.value.physical?.stdout, 'full-output');
  // A different complete result for the same attempt is a typed conflict —
  // never resolved by write order — and the stored evidence is untouched.
  assert.throws(() => writeProcessStopWitness(store, attempt, { child: null, pid: 45017 },
    refusalWith(45017, physical('different-full-output', true))), { code: 'process_stop_witness_invalid' });
  assert.equal(store.get<ProcessStopWitness>(id)!.value.physical?.stdout, 'full-output');
  // The same complete bytes are a lawful repeat, not a conflict.
  writeProcessStopWitness(store, attempt, { child: null, pid: 45017 }, refusalWith(45017, physical('full-output', true)));
  assert.equal(store.get<ProcessStopWitness>(id)!.value.physical?.stdout, 'full-output');
  // A complete result arriving after a partial capture supersedes it.
  const attempt2 = { id: 'task-run:u', revision: 7, hash: 'c'.repeat(64) };
  writeProcessStopWitness(store, attempt2, { child: null, pid: 45019 }, refusalWith(45019, physical('partial-only', false)));
  writeProcessStopWitness(store, attempt2, { child: null, pid: 45019 }, refusalWith(45019, physical('now-complete', true)));
  assert.equal(store.get<ProcessStopWitness>(`process-stop:${attempt2.id}:7`)!.value.physical?.stdout, 'now-complete');
});

test('№1631-1 C43/C44 e2e: a later attempt cannot inherit an earlier witness while its own process lives', async t => {
  const f = executionFixture(t, "normal", { route: "om" });
  const originalWrite = f.store.write.bind(f.store), kill = process.kill.bind(process), pids: number[] = [];
  t.after(() => { process.kill = kill; for (const pid of pids) { try { kill(-pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } } });
  const injected = (input: { kind: string; value: { child?: unknown } }) => {
    if (input.kind === 'task-run' && input.value.child) throw Error('injected failure saving supervisor identity');
    return originalWrite(input as never);
  };
  (f.store as { write: unknown }).write = injected;
  const deny = () => { process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0 && signal === 'SIGKILL') { pids.push(-pid); throw Object.assign(Error('injected group EPERM'), { code: 'EPERM' }); }
    return kill(pid, signal);
  }) as typeof process.kill; };
  deny();
  const first = (await f.engine.executor.run('p', reference(f.plan), f.options))[0]!;
  assert.equal(first.value.state, 'interrupted'); assert.equal(first.value.child, null); assert.equal(pids.length, 1);
  process.kill = kill;
  const identity = probeProcessIdentity(pids[0]!); assert.equal(identity.state, 'present');
  if (identity.state === 'present') await stopOrphan({ pid: pids[0]!, started: identity.started });
  assert.equal(probeProcessIdentity(pids[0]!).state, 'absent');
  deny();
  // The second attempt's refusal must write its OWN witness — addressed by its
  // own attempt revision — never silently dropped on the first one's address.
  const second = (await f.engine.executor.run('p', reference(f.plan), { ...f.options, retry: true }))[0]!;
  assert.equal(second.value.state, 'interrupted'); assert.equal(second.value.child, null); assert.equal(pids.length, 2);
  const witnesses = processStopWitnesses(f.store, second.id);
  assert.equal(witnesses.length, 2);
  assert.deepEqual(witnesses.map(w => (w.value as ProcessStopWitness).pid).sort((a, b) => a! - b!), [pids[0]!, pids[1]!].sort((a, b) => a - b));
  assert.equal(probeProcessIdentity(pids[1]!).state, 'present');
  // The third entry must not start: attempt two's spawned process still lives
  // but its start identity was never captured — the pid is held as
  // unverifiable, not as provably ours or provably foreign.
  await assert.rejects(f.engine.executor.run('p', reference(f.plan), { ...f.options, retry: true }), { code: 'executor_still_running' });
  assert.equal(pids.length, 2, 'no third dispatch while the second process is live');
  (f.store as { write: unknown }).write = originalWrite;
  process.kill = kill;
  const surviving = probeProcessIdentity(pids[1]!);
  if (surviving.state === 'present') await stopOrphan({ pid: pids[1]!, started: surviving.started });
  const third = (await f.engine.executor.run('p', reference(f.plan), { ...f.options, retry: true }))[0]!;
  assert.equal(third.value.state, 'committed');
});

// D8.5 r3 rows 4/8 e2e (reviewer probe review-witness-reuse): once a witness's
// end is durably resolved, a foreign process occupying the same pid later can
// never block a new attempt of the same task-run.
test('D8.5 r3 rows 4/8: a resolved witness survives a foreign reuse of its pid', async t => {
  const f = executionFixture(t, "normal", { route: "om" });
  const originalWrite = f.store.write.bind(f.store), kill = process.kill.bind(process), pids: number[] = [];
  t.after(() => { process.kill = kill; for (const pid of pids) { try { kill(-pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } } });
  (f.store as { write: unknown }).write = (input: { kind: string; value: { child?: unknown } }) => {
    if (input.kind === 'task-run' && input.value.child) throw Error('injected failure saving supervisor identity');
    return originalWrite(input as never);
  };
  const deny = () => { process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0 && signal === 'SIGKILL') { pids.push(-pid); throw Object.assign(Error('injected group EPERM'), { code: 'EPERM' }); }
    return kill(pid, signal);
  }) as typeof process.kill; };
  deny();
  const first = (await f.engine.executor.run('p', reference(f.plan), f.options))[0]!;
  assert.equal(first.value.state, 'interrupted'); assert.equal(first.value.child, null); assert.equal(pids.length, 1);
  process.kill = kill; (f.store as { write: unknown }).write = originalWrite;
  const identity = probeProcessIdentity(pids[0]!); assert.equal(identity.state, 'present');
  if (identity.state === 'present') await stopOrphan({ pid: pids[0]!, started: identity.started });
  assert.equal(probeProcessIdentity(pids[0]!).state, 'absent');
  // Attempt two enters: the first witness is evaluated, proven absent and
  // durably resolved. The attempt itself is interrupted before any launch.
  const cancel = new AbortController(); cancel.abort();
  const second = (await f.engine.executor.run('p', reference(f.plan), { ...f.options, retry: true }, cancel.signal))[0]!;
  assert.equal(second.value.attempt, 2); assert.equal(second.value.state, 'interrupted');
  const resolved = processStopWitnesses(f.store, first.id).map(w => w.value as ProcessStopWitness);
  assert.equal(resolved.length, 1); assert.equal(resolved[0]!.end?.proof, 'absent');
  // A foreign process now occupies the released pid. The resolved witness
  // must not re-open: attempt three proceeds to its own dispatch.
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const originalSpawnSync = cp.spawnSync;
  t.after(() => { (cp as { spawnSync: unknown }).spawnSync = originalSpawnSync; syncBuiltinESMExports(); });
  (cp as { spawnSync: unknown }).spawnSync = (cmd: string, args?: string[], opts?: unknown) =>
    cmd === 'ps' && args?.[0] === '-p' && args[1] === String(pids[0])
      ? { status: 0, signal: null, stdout: 'foreign process created after the proved absence\n', stderr: '', pid: 0, output: [] } as never
      : originalSpawnSync(cmd, args as never, opts as never);
  syncBuiltinESMExports();
  const third = (await f.engine.executor.run('p', reference(f.plan), { ...f.options, retry: true }))[0]!;
  assert.equal(third.value.attempt, 3); assert.equal(third.value.state, 'committed');
});

// D8.5 round 3, outcome table rows 2-8: the shared reader validates the
// record form and the exact subject binding before trusting a witness, and a
// once-proven end is durable — a foreign pid reuse never revives it.
test('D8.5 r3 rows 4-8: evaluation resolves proven ends durably and classifies the rest', t => {
  const store = storeFixture(t);
  let counter = 0;
  const evaluate = (value: Record<string, unknown>, identify?: Parameters<typeof evaluateProcessStopWitnesses>[2]) => {
    const subject = store.write({ id: `task-run:t${counter++}`, kind: 'task-run', expected: 0, value: { attempt: 1 } });
    const ref = reference(subject);
    store.write({ id: `process-stop:${ref.id}:${ref.revision}`, kind: 'process-stop', expected: 0,
      value: { protocol: 'process-stop/v1', subject: ref, owner: null, child: null, pid: null,
        outcome: 'unconfirmed', stage: 'post-check', target: 'child', errno: null, cause: null, physical: null, ...value } });
    return evaluateProcessStopWitnesses(store, ref.id, identify);
  };
  // Row 4a: no spawned pid was ever recorded — nothing to prove.
  assert.deepEqual(evaluate({ pid: null }).map(v => [v.state, v.resolution]), [['ended', 'no-pid']]);
  // Row 8: a proven absence ends the launch and persists its resolution.
  let verdict = evaluate({ pid: 45001 }, () => absent)[0]!;
  assert.deepEqual([verdict.state, verdict.resolution], ['ended', 'absent']);
  assert.equal((verdict.record.value as ProcessStopWitness).end, undefined);
  const wid = verdict.record.id;
  assert.equal((store.get<ProcessStopWitness>(wid)!.value.end?.proof), 'absent');
  // Row 5: the recorded identity still occupies the pid — alive, not ended.
  verdict = evaluate({ pid: 45002, child: { pid: 45002, started: 'orig' } }, () => present('orig'))[0]!;
  assert.equal(verdict.state, 'alive'); assert.equal(verdict.observedStarted, 'orig');
  // Row 8: a different start time at the recorded pid is a foreign reuse —
  // the launch is ended and its resolution is stored.
  verdict = evaluate({ pid: 45003, child: { pid: 45003, started: 'orig' } }, () => present('recycled'))[0]!;
  assert.deepEqual([verdict.state, verdict.resolution], ['ended', 'identity-changed']);
  assert.equal(verdict.observedStarted, 'recycled');
  // Row 6: no captured started — a busy pid is unverifiable, never ended.
  verdict = evaluate({ pid: 45004 }, () => present('anything'))[0]!;
  assert.equal(verdict.state, 'unverifiable'); assert.equal(verdict.observedStarted, 'anything');
  // Row 7: an unavailable probe is a typed uncertainty, not a proof.
  verdict = evaluate({ pid: 45005 }, () => unavailable('EPERM'))[0]!;
  assert.deepEqual([verdict.state, verdict.errno], ['unavailable', 'EPERM']);
  // Row 4b: a stored resolution is honoured without re-probing — a foreign
  // process reusing the pid cannot revive the ended launch.
  const subject = store.write({ id: 'task-run:reuse', kind: 'task-run', expected: 0, value: { attempt: 1 } });
  const ref = reference(subject), wid2 = `process-stop:${ref.id}:${ref.revision}`;
  store.write({ id: wid2, kind: 'process-stop', expected: 0, value: { protocol: 'process-stop/v1', subject: ref,
    owner: null, child: null, pid: 45006, outcome: 'denied', stage: 'signal', target: 'group', errno: 'EPERM',
    cause: null, physical: null } });
  assert.equal(evaluateProcessStopWitnesses(store, ref.id, () => absent)[0]!.resolution, 'absent');
  assert.equal(store.get<ProcessStopWitness>(wid2)!.revision, 2);
  let probed = false;
  const after = evaluateProcessStopWitnesses(store, ref.id, () => { probed = true; return present('new-owner'); })[0]!;
  assert.equal(probed, false, 'a resolved witness is never re-probed against a reused pid');
  assert.deepEqual([after.state, after.resolution], ['ended', 'resolved']);
});

test('D8.5 r3 row 2: a malformed witness is a typed refusal, never an absent one', t => {
  const store = storeFixture(t);
  const subject = store.write({ id: 'task-run:t', kind: 'task-run', expected: 0, value: { attempt: 1 } });
  const ref = reference(subject), id = `process-stop:${ref.id}:${ref.revision}`;
  const base = { protocol: 'process-stop/v1', subject: ref, owner: null, child: null, pid: 45007,
    outcome: 'denied', stage: 'signal', target: 'group', errno: 'EPERM', cause: null, physical: null };
  const tamper = (value: unknown) => store.write({ id, kind: 'process-stop', expected: store.get(id)?.revision ?? 0, value });
  for (const [name, value] of [
    ['protocol', { ...base, protocol: 'process-stop/unknown' }],
    ['pid', { ...base, pid: 'x' }],
    ['subject', { ...base, subject: { id: ref.id } }],
    ['physical', { ...base, physical: { complete: 'yes' } }],
    ['child-mismatch', { ...base, child: { pid: 45999, started: 'other' } }],
  ] as const) {
    tamper(value);
    assert.throws(() => evaluateProcessStopWitnesses(store, ref.id, () => absent),
      { code: 'process_stop_witness_invalid' }, name);
    store.write({ id, kind: 'process-stop', expected: store.get(id)!.revision, value: base });
  }
  // A record under the namespace that is not an attempt address is invalid.
  store.write({ id: `process-stop:${ref.id}:note`, kind: 'process-stop', expected: 0, value: base });
  assert.throws(() => evaluateProcessStopWitnesses(store, ref.id, () => absent), { code: 'process_stop_witness_invalid' });
});

test('D8.5 r3 row 3: a witness that does not prove its exact subject is foreign', t => {
  const store = storeFixture(t);
  const subject = store.write({ id: 'task-run:t', kind: 'task-run', expected: 0, value: { attempt: 1 } });
  const ref = reference(subject), id = `process-stop:${ref.id}:${ref.revision}`;
  const base = { protocol: 'process-stop/v1', subject: ref, owner: null, child: null, pid: 45008,
    outcome: 'denied', stage: 'signal', target: 'group', errno: 'EPERM', cause: null, physical: null };
  // A different record's valid ref under this address is foreign.
  const other = reference(store.write({ id: 'task-run:other', kind: 'task-run', expected: 0, value: {} }));
  store.write({ id, kind: 'process-stop', expected: 0, value: { ...base, subject: other } });
  assert.throws(() => evaluateProcessStopWitnesses(store, ref.id, () => absent), { code: 'process_stop_witness_foreign' });
  // A subject naming a revision this record never had is foreign.
  store.write({ id, kind: 'process-stop', expected: 1, value: { ...base, subject: { ...ref, hash: 'f'.repeat(64) } } });
  assert.throws(() => evaluateProcessStopWitnesses(store, ref.id, () => absent), { code: 'process_stop_witness_foreign' });
  store.write({ id, kind: 'process-stop', expected: 2, value: { ...base, subject: { id: ref.id, revision: 9, hash: 'f'.repeat(64) } } });
  assert.throws(() => evaluateProcessStopWitnesses(store, ref.id, () => absent), { code: 'process_stop_witness_foreign' });
  // An untouched, well-formed witness still evaluates.
  store.write({ id, kind: 'process-stop', expected: 3, value: base });
  assert.equal(evaluateProcessStopWitnesses(store, ref.id, () => absent).length, 1);
});

// D8.5 r3 №1647 intersection: a proven end × a competing write. The
// resolution write is CAS-guarded: a second Store landing another revision of
// the same witness between enumeration and resolution gets a typed conflict,
// never a silent clobber; the competing diagnostic survives and the proven end
// is then resolved on top of it.
test('D8.5 r3: resolution is CAS-guarded against a competing witness write', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-pgr-')), database = join(root, 'db.sqlite');
  const store = new Store(database), competing = new Store(database);
  t.after(() => { store.close(); competing.close(); rmSync(root, { recursive: true, force: true }); });
  const subject = store.write({ id: 'task-run:t', kind: 'task-run', expected: 0, value: { attempt: 1 } });
  const ref = reference(subject), wid = `process-stop:${ref.id}:${ref.revision}`;
  const base = { protocol: 'process-stop/v1', subject: ref, owner: null, child: null, pid: 45009,
    outcome: 'denied', stage: 'signal', target: 'group', errno: 'EPERM', cause: null, physical: null };
  store.write({ id: wid, kind: 'process-stop', expected: 0, value: base });
  const originalWrite = store.write.bind(store);
  (store as { write: unknown }).write = (input: { kind: string; value: { end?: unknown } }) => {
    if (input.kind === 'process-stop' && input.value.end)
      competing.write({ id: wid, kind: 'process-stop', expected: competing.get(wid)!.revision,
        value: { ...base, outcome: 'unconfirmed' } });
    return originalWrite(input as never);
  };
  assert.throws(() => evaluateProcessStopWitnesses(store, ref.id, () => absent), { code: 'revision_conflict' });
  const head = competing.get<ProcessStopWitness>(wid)!;
  assert.equal(head.value.outcome, 'unconfirmed'); assert.equal(head.value.end, undefined);
  (store as { write: unknown }).write = originalWrite;
  // Re-evaluating resolves on top of the competing head — the late diagnostic
  // outcome is preserved by the merged resolution write.
  assert.equal(evaluateProcessStopWitnesses(store, ref.id, () => absent)[0]!.resolution, 'absent');
  const resolved = store.get<ProcessStopWitness>(wid)!;
  assert.equal(resolved.value.outcome, 'unconfirmed'); assert.equal(resolved.value.end?.proof, 'absent');
});

// PF3 (№3424): the witnesses of a subject are enumerated over a proven Store by the literal prefix of its head
// identities; every other source keeps its own list. Rows 29-32 of outcome table §5.
test('PF3 rows 29-32: one full witness set over a Store, a write-only view, a list-only source, a Proxy and a pending preview; foreign bodies stay unread; a later witness appears', t => {
  const store = storeFixture(t);
  const attempt = (id: string, revision: number) => ({ id, revision, hash: 'c'.repeat(64) });
  const unconfirmed = (pid: number) => new EngineError('process_stop_unconfirmed', 'still unproven',
    { outcome: 'unconfirmed', stage: 'post-check', target: 'child', pid, errno: null, cause: null });
  writeProcessStopWitness(store, attempt('task-run:p', 1), { child: null, pid: 101 }, unconfirmed(101));
  writeProcessStopWitness(store, attempt('task-run:p', 2), { child: null, pid: 102 }, unconfirmed(102));
  writeProcessStopWitness(store, attempt('task-run:p2', 1), { child: null, pid: 201 }, unconfirmed(201));
  store.writeMany([{ id: 'process-stop:task-run:p:junk', kind: 'other-kind', expected: 0, value: { not: 'a witness' } },
    { id: 'pf3:research-context', kind: 'research-context', expected: 0, value: { text: 'x'.repeat(1_000_000) } }]);
  const same = (left: unknown, right: unknown, message?: string) => assert.equal(canonical(left as Json), canonical(right as Json), message);
  // Rows 29, 31: the literal prefix of the subject, in entity order, the record of another kind included, another subject not.
  const before = storeBodyCache(), fast = processStopWitnesses(store, 'task-run:p');
  assert.ok(storeBodyCache().loadedChars - before.loadedChars < 1_000_000, 'Foreign bodies are not loaded');
  assert.deepEqual(fast.map(row => row.id), ['process-stop:task-run:p:1', 'process-stop:task-run:p:2', 'process-stop:task-run:p:junk']);
  const writeOnly = storeView(store, { write: (inputs, guards) => store.writeMany(inputs, guards) });
  assert.equal(provenStore(writeOnly), store);
  same(processStopWitnesses(writeOnly, 'task-run:p'), fast);
  same(processStopWitnesses({ list: <T,>(kind?: string) => store.list<T>(kind) }, 'task-run:p'), fast);
  // Row 30: any other source is enumerated by its own list, errors included; no new method is required of it.
  const failure = new Error('list failed');
  assert.throws(() => processStopWitnesses({ list: () => { throw failure; } }, 'task-run:p'), (error: unknown) => error === failure);
  let listed = 0;
  const proxy = new Proxy(store, { get(target, prop) {
    if (prop === 'list') return (kind?: string) => { listed++; return target.list(kind); };
    const member: unknown = Reflect.get(target, prop, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  same(processStopWitnesses(proxy, 'task-run:p'), fast);
  assert.equal(listed, 1);
  const tx = transactionForTests(store), pending = fast[0]!;
  tx.add({ writes: [{ id: 'process-stop:task-run:p:3', kind: pending.kind, expected: 0, value: structuredClone(pending.value) }], guards: [] });
  assert.deepEqual(processStopWitnesses(tx.view, 'task-run:p').map(row => row.id),
    ['process-stop:task-run:p:1', 'process-stop:task-run:p:2', 'process-stop:task-run:p:3', 'process-stop:task-run:p:junk'], 'A preview lists its pending witness');
  assert.equal(store.get('process-stop:task-run:p:3'), null);
  // Row 32: a witness another Store writes after the first enumeration appears; a reopened Store reads the same set.
  const second = new Store(store.path);
  t.after(() => second.close());
  writeProcessStopWitness(second, attempt('task-run:p', 4), { child: null, pid: 104 }, unconfirmed(104));
  const after = processStopWitnesses(store, 'task-run:p');
  assert.deepEqual(after.map(row => row.id).slice(-2), ['process-stop:task-run:p:4', 'process-stop:task-run:p:junk']);
  const reopened = new Store(store.path);
  t.after(() => reopened.close());
  same(processStopWitnesses(reopened, 'task-run:p'), after);
});
