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
