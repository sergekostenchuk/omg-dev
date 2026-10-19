import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { runProcess } from "../src/runtime/process.js";
import { processStart } from "../src/runtime/process-identity.js";

test("process adapter preserves split UTF-8 output and refuses an already-cancelled launch", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-process-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runProcess({ executable: process.execPath, args: ["-e", "const b=Buffer.from('Привет'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),20)"] }, root, "", 2000);
  assert.equal(result.stdout, "Привет");
  const signal = new AbortController(); signal.abort();
  const target = join(root, "should-not-exist");
  await assert.rejects(runProcess({ executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(target)},'bad')`] }, root, "", 2000, signal.signal), /cancelled before launch/);
  assert.equal(existsSync(target), false);
});

test("timeout terminates the owned child group instead of accepting unfinished output", async () => {
  await assert.rejects(runProcess({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, process.cwd(), "", 150), /timeout/);
});

// D8.5.1 (№2433): a cancel/timeout landing while the refused sweep is still being re-probed sends no second
// signal and settles once — the stop refusal carries the original reason as its cause.
test('an abort during an unfinished sweep probe keeps one signal, one outcome and both reasons', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-process-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let signals = 0, probes = 0;
  const controller = new AbortController();
  await assert.rejects(
    runProcess({ executable: process.execPath, args: ['-e', "process.stdout.write('x')"] }, root, '', 4000, controller.signal, true,
      undefined, { signal: () => { signals++; setTimeout(() => controller.abort(), 0); return 'EPERM'; },
        probeGroup: () => { probes++; return 'EPERM'; } }),
    (error: unknown) => {
      const failure = error as { code?: unknown; details?: unknown };
      assert.equal(failure.code, 'process_stop_denied');
      const details = failure.details as { outcome: string; errno: string; cause: { code: string } };
      assert.equal(details.outcome, 'denied'); assert.equal(details.errno, 'EPERM'); assert.equal(details.cause.code, 'process_cancelled');
      return true;
    });
  assert.equal(signals, 1); assert.ok(probes >= 1 && probes <= 6, `probes ${probes} within the budget`);
});

test('a sweep probe never runs for the single-child stop path', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-process-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let pid: number | null = null, probes = 0;
  t.after(() => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch { } });
  await assert.rejects(
    runProcess({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, root, '', 200, undefined, false,
      p => { pid = p; }, { probeGroup: () => { probes++; return 'ESRCH'; } }),
    /timeout/);
  assert.equal(probes, 0);
});

test('request bytes are transferred only after successful awaited spawn authorization', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-process-authorize-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'received');
  const adapter = { executable: process.execPath, args: ['-e', `const fs=require('node:fs');const request=fs.readFileSync(0,'utf8');if(request)fs.writeFileSync(${JSON.stringify(target)},request)`] };
  await assert.rejects(runProcess(adapter, root, 'must-not-transfer', 2000, undefined, true, async () => { await Promise.resolve(); throw Error('authorization rejected'); }), { code: 'process_record_failed' });
  assert.equal(existsSync(target), false);
  let authorized = false;
  const result = await runProcess({ executable: process.execPath, args: ['-e', "const fs=require('node:fs');process.stdout.write(fs.readFileSync(0,'utf8'))"] }, root, 'authorized-only', 2000, undefined, true, async () => { await Promise.resolve(); authorized = true; });
  assert.equal(authorized, true); assert.equal(result.stdout, 'authorized-only');
});

// PS1 (№6784, №6781 п.6, №6796): processStart caches self process start time on process lifetime,
// foreign PIDs and probeProcessIdentity remain fresh, errors and empty output are never cached.

let ps1Ordinal = 0;
interface PsMockRow {
  stdout: string;
  status?: number | null;
  stderr?: string;
  error?: Error;
}

async function runWithPsMocks(
  results: PsMockRow[],
  run: (mod: typeof import('../src/runtime/process-identity.js'), getCalls: () => number) => Promise<void> | void
) {
  const req = createRequire(import.meta.url);
  const cp = req('node:child_process');
  const original = cp.spawnSync;
  let reads = 0;
  cp.spawnSync = (command: string, ...args: unknown[]) => {
    if (command !== 'ps') return original(command, ...args);
    assert.ok(reads < results.length, 'unexpected extra ps');
    const r = results[reads++]!;
    if (r.error) return { error: r.error, status: null, stdout: '', stderr: '' };
    return { status: r.status ?? 0, stdout: r.stdout, stderr: r.stderr ?? '' };
  };
  syncBuiltinESMExports();
  try {
    const mod = await import(`../src/runtime/process-identity.js?ps1Case=${ps1Ordinal++}`);
    await run(mod, () => reads);
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
  }
}

const mockRow = (stdout: string, status = 0, stderr = ''): PsMockRow => ({ status, stdout, stderr });

test('PS1: processStart caches self process start time without repeated ps invocations', async () => {
  await runWithPsMocks([mockRow('start-A\n')], (m, count) => {
    assert.deepEqual(
      [m.processStart(process.pid), m.processStart(process.pid), m.processStart(process.pid)],
      ['start-A', 'start-A', 'start-A']
    );
    assert.equal(count(), 1, 'Exactly one ps call for multiple self processStart calls');
  });
});

test('PS1: processStart queries foreign pid with fresh ps invocation each time', async () => {
  const foreignPid = process.pid + 100000;
  await runWithPsMocks([mockRow('start-A'), mockRow('start-B')], (m, count) => {
    assert.equal(m.processStart(foreignPid), 'start-A');
    assert.equal(m.processStart(foreignPid), 'start-B');
    assert.equal(count(), 2, 'Foreign PID queries are not cached and observe changed identities');
  });
});

test('PS1: processStart retries empty successful self observation without caching', async () => {
  await runWithPsMocks([mockRow(' \n'), mockRow('start-B')], (m, count) => {
    assert.equal(m.processStart(process.pid), '');
    assert.equal(m.processStart(process.pid), 'start-B');
    assert.equal(m.processStart(process.pid), 'start-B');
    assert.equal(count(), 2, 'Empty response is retried until non-empty success is observed');
  });
});

test('PS1: processStart does not cache nonzero status self output', async () => {
  await runWithPsMocks([mockRow('ignored', 1), mockRow('start-B')], (m, count) => {
    assert.equal(m.processStart(process.pid), '');
    assert.equal(m.processStart(process.pid), 'start-B');
    assert.equal(count(), 2, 'Nonzero status response is not cached');
  });
});

test('PS1: processStart throws on observation error and never caches failed attempts', async () => {
  const err = Object.assign(new Error('unavailable'), { code: 'ENOENT' });
  await runWithPsMocks([{ error: err, stdout: '', status: null }, mockRow('start-B')], (m, count) => {
    assert.throws(() => m.processStart(process.pid), { code: 'process_identity_unavailable' });
    assert.equal(m.processStart(process.pid), 'start-B');
    assert.equal(count(), 2, 'Observation error throws typed failure and is not cached');
  });
});

test('PS1: probeProcessIdentity remains fresh after warm self cache', async () => {
  await runWithPsMocks([mockRow('start-A'), mockRow('start-B'), mockRow('', 1)], (m, count) => {
    assert.equal(m.processStart(process.pid), 'start-A');
    assert.deepEqual(m.probeProcessIdentity(process.pid), { state: 'present', started: 'start-B' });
    assert.deepEqual(m.probeProcessIdentity(process.pid), { state: 'absent' });
    assert.equal(count(), 3, 'probeProcessIdentity always performs fresh probe');
  });
});

test('PS1: processStart observes disappearance of a finished process without caching stale identity', async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
  });
  const pid = child.pid!;
  const started = processStart(pid);
  assert.ok(started.length > 0, 'child identity must be observed while child is held alive');
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  child.stdin?.end();
  await exited;
  let gone = false;
  for (let i = 0; i < 20; i++) {
    if (processStart(pid) === '') { gone = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(gone, true, 'processStart must return empty string once child exits');
});
