import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/runtime/process.js";

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
