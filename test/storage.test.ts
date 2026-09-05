import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Store } from "../src/storage/store.js";
import { restoreSnapshot, inspectSnapshot } from "../src/storage/snapshots.js";
import { EngineError } from "../src/errors.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-store-"));
  const path = join(root, "live.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, snapshots: join(root, "backups") };
}

test("SQLite persists immutable revisions; CAS and multi-entity rollback prevent lost updates", t => {
  const { store, path } = fixture(t);
  const first = store.write({ id: "idea", kind: "concept", expected: 0, value: { title: "Garden" } });
  const second = new Store(path);
  try {
    second.write({ id: "idea", kind: "concept", expected: 1, value: { title: "Garden revised" } });
    assert.throws(() => store.write({ id: "idea", kind: "concept", expected: 1, value: {} }), code("revision_conflict"));
    assert.throws(() => store.writeMany([
      { id: "other", kind: "concept", expected: 0, value: {} },
      { id: "idea", kind: "concept", expected: 0, value: {} },
    ]), code("revision_conflict"));
    assert.equal(store.get("other"), null);
    assert.deepEqual(second.get("idea", 1), first);
    assert.equal(store.history("idea").length, 2);
  } finally { second.close(); }
  const raw = new DatabaseSync(path);
  try { assert.throws(() => raw.exec("UPDATE revisions SET body='{}'"), /immutable_revision/); }
  finally { raw.close(); }
});

test("A/B rotation restores all revisions into an empty directory and replaces only the older slot", async t => {
  const { store, root, snapshots } = fixture(t);
  store.write({ id: "graph", kind: "graph", expected: 0, value: { nodes: ["one"] } });
  const a = await store.snapshot(snapshots);
  store.write({ id: "graph", kind: "graph", expected: 1, value: { nodes: ["one", "two"] } });
  const b = await store.snapshot(snapshots);
  const preserved = readFileSync(b.path);
  store.write({ id: "graph", kind: "graph", expected: 2, value: { nodes: ["one", "two", "three"] } });
  const next = await store.snapshot(snapshots);
  assert.equal(next.path, a.path); assert.equal(next.generation, 3);
  assert.deepEqual(readFileSync(b.path), preserved);
  const restoredPath = join(root, "empty", "recovered.sqlite");
  restoreSnapshot(snapshots, restoredPath);
  const restored = new Store(restoredPath);
  try {
    assert.equal(restored.databaseId, store.databaseId);
    assert.deepEqual(restored.history("graph"), store.history("graph"));
  } finally { restored.close(); }
});

test("cancellation preserves the last valid snapshot; corrupt latest falls back to previous", async t => {
  const { store, root, snapshots } = fixture(t);
  store.write({ id: "proof", kind: "evidence", expected: 0, value: { body: "x".repeat(250_000) } });
  const a = await store.snapshot(snapshots);
  const original = readFileSync(a.path);
  const abort = new AbortController();
  await assert.rejects(store.snapshot(snapshots, { signal: abort.signal, progress: () => abort.abort() }));
  assert.deepEqual(readFileSync(a.path), original);
  const b = await store.snapshot(snapshots);
  writeFileSync(b.path, "not a database");
  const restored = restoreSnapshot(snapshots, join(root, "fallback.sqlite"));
  assert.equal(restored.generation, a.generation);
  assert.equal(inspectSnapshot(a.path).contentHash, a.contentHash);
});

test("foreign files, missing expected revisions, malformed JSON and destructive restore are refused", async t => {
  const { store, root, snapshots } = fixture(t);
  assert.throws(() => store.write({ id: "x", kind: "x", value: {} } as never), code("invalid_write"));
  assert.throws(() => store.write({ id: "x", kind: "x", expected: 0, value: { absent: undefined } }), code("invalid_json"));
  const foreign = join(root, "foreign.sqlite");
  const raw = new DatabaseSync(foreign); raw.exec("CREATE TABLE something(id INTEGER)"); raw.close();
  assert.throws(() => new Store(foreign), code("foreign_database"));
  await store.snapshot(snapshots);
  assert.throws(() => restoreSnapshot(snapshots, store.path), code("restore_target_exists"));
  const link = join(root, "linked.sqlite"); symlinkSync(store.path, link);
  assert.throws(() => new Store(link), code("unsafe_database_path"));
  const dangling = join(root, "dangling.sqlite"); symlinkSync(join(root, "absent.sqlite"), dangling);
  assert.throws(() => new Store(dangling), code("unsafe_database_path"));
  const other = new Store(join(root, "other.sqlite"));
  try { await assert.rejects(other.snapshot(snapshots), code("foreign_snapshot")); } finally { other.close(); }
});

test("process death during SQLite backup leaves a recoverable snapshot and releases the write reservation", async t => {
  const { store, root, snapshots, path } = fixture(t);
  store.write({ id: "question", kind: "question", expected: 0, value: { text: "x".repeat(500_000) } });
  const first = await store.snapshot(snapshots);
  const before = readFileSync(first.path);
  const moduleUrl = new URL("../src/storage/store.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {Store} from ${JSON.stringify(moduleUrl)};
     const store=new Store(${JSON.stringify(path)});
     await store.snapshot(${JSON.stringify(snapshots)}, {progress(){process.kill(process.pid,'SIGKILL')}});`
  ], { timeout: 10_000 });
  assert.equal(child.signal, "SIGKILL");
  assert.deepEqual(readFileSync(first.path), before);
  store.write({ id: "later", kind: "question", expected: 0, value: {} });
  assert.equal(restoreSnapshot(snapshots, join(root, "cold", "state.sqlite")).contentHash, first.contentHash);
});

test("snapshot publication cannot replace the live database through an ancestor alias", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-alias-"));
  mkdirSync(join(root, "real", "slots"), { recursive: true });
  symlinkSync(join(root, "real"), join(root, "alias"));
  const store = new Store(join(root, "real", "slots", "snapshot-A.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(store.snapshot(join(root, "alias", "slots")), code("unsafe_snapshot_path"));
});
