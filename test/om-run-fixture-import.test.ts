import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { stageId, type StageArtifact } from "../src/pipeline/contracts.js";
import { withHistoricalUpstream } from "./product-fixture.js";
import { OM_FIXTURE_ERROR } from "./om-fixture.js";
import { runFixture, worksFixture, project } from "./om-run-fixture.js";

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

test("OMRUN-SPLIT: worksFixture inside an inherited historical scope still uses the current producer", t => {
  const f = withHistoricalUpstream("must-never-load-this-era", () => worksFixture(t));
  for (const stage of UPSTREAM_STAGES)
    assert.equal(f.store.get<StageArtifact>(stageId(project, stage))!.value.status, "accepted", stage);
  assert.ok(f.store.get(`om-input:${project}`), "the current B1 input");
  assert.ok(f.store.get<{ acceptance?: unknown }>(`graph-layer:${project}:2`)!.value.acceptance, "the native N2 is accepted");
  const before = f.store.list();
  f.restart();
  assert.deepEqual(f.store.list(), before);
});

test("OMRUN-MODE: a run fixture takes only a current mode — every other value is refused at all three doors before any state or process is made", () => {
  const url = (name: string) => new URL(name, import.meta.url).href;
  const probe = `
    import processes from 'node:child_process';
    import files from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const effects = [];
    for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
      processes[name] = () => { effects.push(name); throw new Error('A refused mode started a process through ' + name); };
    }
    files.mkdtempSync = () => { effects.push('mkdtempSync'); throw new Error('A refused mode created temporary state'); };
    syncBuiltinESMExports();
    const { runFixture, secondRung, twoOwnerAnswers } = await import(${JSON.stringify(url("./om-run-fixture.js"))});
    const { EngineError } = await import(${JSON.stringify(url("../src/errors.js"))});
    for (const name of ['mkdirSync', 'writeFileSync', 'rmSync']) {
      files[name] = () => { effects.push(name); throw new Error('A refused mode touched the file system through ' + name); };
    }
    syncBuiltinESMExports();
    const context = { after() { effects.push('after'); } };
    const doors = {
      runFixture: (...mode) => runFixture(context, ['encoding'], ...mode),
      secondRung: (...mode) => secondRung(context, ...mode),
      twoOwnerAnswers: (...mode) => twoOwnerAnswers(context, false, ...mode),
    };
    const values = [['absent'], ['true', true], ['false', false], ['null', null], ['empty string', ''], ['unknown string', 'refine'],
      ['wrong case', 'Executed'], ['number', 1], ['object', {}], ['array', ['n2']], ['function', () => 'stages']];
    const rows = [];
    for (const [door, call] of Object.entries(doors)) for (const [label, ...mode] of values) {
      let returned, error;
      try { returned = call(...mode); } catch (thrown) { error = thrown; }
      const promise = returned instanceof Promise;
      if (promise) await returned.then(() => { error = undefined; }, thrown => { error = thrown; });
      rows.push({ door, label, promise, refused: error !== undefined, engine: error instanceof EngineError, code: error?.code, details: error?.details });
    }
    process.stdout.write(JSON.stringify({ rows, effects }) + '\\n');
  `;
  const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", probe], { encoding: "utf8", timeout: 120_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const { rows, effects } = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
    rows: { door: string; label: string; promise: boolean; refused: boolean; engine: boolean; code: string; details: unknown }[]; effects: string[] };
  assert.equal(rows.length, 3 * 11);
  for (const row of rows) {
    const where = `${row.door} with ${row.label}`;
    assert.deepEqual([row.refused, row.engine, row.code, row.details], [true, true, OM_FIXTURE_ERROR, { target: "/mode" }], where);
    assert.equal(row.promise, row.door !== "runFixture", `${where}: the wrappers refuse as a rejected promise, runFixture at once`);
  }
  assert.deepEqual(effects, [], "A refused mode makes no temporary state, no file and no process");
});

test("OMRUN-MODE: runFixture inside an inherited historical scope builds the current stages and the native N2 — its explicit empty era still blocks the inheritance", t => {
  const f = withHistoricalUpstream("must-never-load-this-era", () => runFixture(t, ["encoding"], "n2"));
  for (const stage of UPSTREAM_STAGES)
    assert.equal(f.store.get<StageArtifact>(stageId(project, stage))!.value.status, "accepted", stage);
  assert.ok(f.store.get(`om-input:${project}`), "the current B1 input");
  assert.ok(f.store.get<{ acceptance?: unknown }>(`graph-layer:${project}:2`)!.value.acceptance, "the native N2 is accepted");
  assert.deepEqual(f.store.list("phase"), [], "A current mode never creates research phases");
});
