import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("OMRUN-SPLIT: importing the shared fixture registers no tests and starts no producer", () => {
  const fixture = new URL("./om-run-fixture.js", import.meta.url).href;
  const probe = `
    import processes from 'node:child_process';
    import files from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
      processes[name] = () => { throw new Error('Fixture import started a producer through ' + name); };
    }
    files.mkdtempSync = () => { throw new Error('Fixture import eagerly created temporary state'); };
    syncBuiltinESMExports();
    await import(${JSON.stringify(fixture)});
    process.stdout.write('fixture imported\\n');
  `;
  const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", probe], {
    encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stdout, "fixture imported\n", "A registration would emit node:test TAP output");
});
