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
