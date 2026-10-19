import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { observeStore, Store, storeReads, checkTransactionGuards, type AbsentGuard, type ReadGuard, type StoreObserver, type TransactionGuard } from "../src/storage/store.js";
import { historicalRead, withHistoricalReads } from "../src/history/proofs.js";
import { reference } from "../src/pipeline/contracts.js";
import { captureView, storeView } from "../src/storage/store-view.js";
import { isRef } from "../src/pipeline/contracts.js";
import { HASH_PATTERN, HASH_RE } from "../src/canonical.js";
import { uniqueTransactionGuards, transactionGuardsCurrent } from "../src/runtime/environment.js";
import { readOmAdmissionGuards } from "../src/om/input.js";
import { restoreSnapshot, inspectSnapshot } from "../src/storage/snapshots.js";
import { assertSchema, removeProofCache } from "../src/storage/schema.js";
import { canonical, digest, type Json } from "../src/canonical.js";
import { copyFileSync } from "node:fs";
import { EngineError } from "../src/errors.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";

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

test("absence guards preserve absence and permit the same transaction to create its guarded ID", t => {
  const { store, path } = fixture(t);
  const guard: AbsentGuard = { id: "pilot", absent: true };
  assert.equal(isRef(guard), false);
  assert.deepEqual(store.writeMany([], [guard]), []);
  store.writeMany([{ id: "neighbor", kind: "proof", expected: 0, value: {} }], [guard]);
  assert.equal(store.get(guard.id), null);
  assert.deepEqual(store.history(guard.id), []);
  assert.deepEqual(store.list().map(record => record.id), ["neighbor"]);
  const writes = [
    { id: guard.id, kind: "pilot", expected: 0, value: { active: true } },
    { id: "accepted", kind: "proof", expected: 0, value: {} },
  ];
  const saved = store.writeMany(writes, [guard]);
  assert.equal(saved.length, 2);
  assert.throws(() => store.writeMany(writes, [guard]), code("input_stale"));
  store.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.get(guard.id), saved[0]);
    assert.throws(() => reopened.writeMany([], [guard]), code("input_stale"));
    assert.equal(reopened.history(guard.id).length, 1);
  } finally { reopened.close(); }
});

test("a second Store invalidates every guarded dependency without partial neighboring records", t => {
  const { store, path } = fixture(t);
  const second = new Store(path);
  t.after(() => second.close());
  for (const changed of ["present-a", "present-b", "absent-a", "absent-b"]) {
    const prefix = `${changed}:`;
    const present = ["present-a", "present-b"].map(id => store.write({
      id: prefix + id, kind: "source", expected: 0, value: { original: true },
    }));
    const guards: TransactionGuard[] = [...present,
      { id: prefix + "absent-a", absent: true }, { id: prefix + "absent-b", absent: true }];
    second.write({ id: prefix + changed, kind: "source", expected: changed.startsWith("present") ? 1 : 0, value: {} });
    const writes = ["left", "right"].map(id => ({ id: prefix + id, kind: "proof", expected: 0, value: {} }));
    assert.throws(() => store.writeMany(writes, guards), code("input_stale"));
    for (const write of writes) {
      assert.equal(second.get(write.id), null);
      assert.deepEqual(second.history(write.id), []);
    }
    for (const record of present) assert.deepEqual(second.get(record.id, record.revision), record);
    const current = second.get(prefix + changed)!;
    const refreshed = guards.map(guard => guard.id === current.id ? current : guard);
    assert.equal(store.writeMany(writes, refreshed).length, 2);
  }
});

test("mixed positive and absence guards retain duplicates and never erase contradictory dependencies", t => {
  const { store } = fixture(t);
  const source = store.write({ id: "source", kind: "source", expected: 0, value: {} });
  const positive: ReadGuard = source;
  const absent: AbsentGuard = { id: "new", absent: true };
  assert.deepEqual(store.writeMany([], [positive, absent, positive, absent]), []);
  for (const guards of [[positive, { id: source.id, absent: true } as const],
    [{ id: source.id, absent: true } as const, positive]]) {
    assert.throws(() => store.writeMany([{ id: "forbidden", kind: "proof", expected: 0, value: {} }], guards), code("input_stale"));
    assert.equal(store.get("forbidden"), null);
  }
  for (const guard of [{ ...positive, hash: "0".repeat(64) }, { ...positive, revision: 2 },
    { ...positive, id: "foreign-source" }]) {
    assert.throws(() => store.writeMany([], [guard]), code("input_stale"));
  }
  const results = store.writeMany([
    { id: absent.id, kind: "source", expected: 0, value: {} },
    { id: source.id, kind: source.kind, expected: source.revision, value: { updated: true } },
  ], [positive, absent, absent, positive]);
  assert.equal(results[1]!.revision, 2);
  assert.deepEqual(store.get(source.id, 1), source);
});

test("all guard forms are validated before database checks and writes", t => {
  const { store } = fixture(t);
  const valid = { id: "guarded", revision: 1, hash: "a".repeat(64) };
  const malformed: unknown[] = [undefined, null, true, 1, "guarded", [], {},
    { absent: true }, { id: "", absent: true }, { id: 1, absent: true },
    { id: "guarded" }, { ...valid, revision: undefined }, { ...valid, hash: undefined },
    ...[false, undefined, null, 1, "true"].map(absent => ({ id: "guarded", absent })),
    ...[false, undefined, null, 1, "true"].map(absent => ({ ...valid, absent })),
    { ...valid, absent: true }, { id: "guarded", absent: true, revision: undefined },
    { id: "guarded", absent: true, hash: undefined },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null].map(revision => ({ ...valid, revision })),
    ...["", "a".repeat(63), "a".repeat(65), "g".repeat(64), "A".repeat(64), 1, null].map(hash => ({ ...valid, hash })),
  ];
  const writes = ["left", "right"].map(id => ({ id, kind: "proof", expected: 0, value: {} }));
  for (const guard of malformed) {
    assert.throws(() => store.writeMany(writes, [valid, guard] as never), code("invalid_guard"));
  }
  for (const guards of [null, {}, "guards", 1, new Array(1)]) {
    assert.throws(() => store.writeMany(writes, guards as never), code("invalid_guard"));
  }
  assert.deepEqual(store.list(), []);
  assert.equal(store.writeMany(writes).length, 2);
});

test("a capture view refuses a malformed guard at capture, agreeing with the commit", t => {
  const { store } = fixture(t);
  const source = store.write({ id: "source", kind: "source", expected: 0, value: {} });
  const capture = captureView(store, { rows: new Map() });
  const malformed = { id: source.id, revision: source.revision, hash: source.hash.toUpperCase() };
  assert.throws(() => capture.view.writeMany([{ id: "x", kind: "proof", expected: 0, value: {} }], [malformed]),
    code("invalid_guard"));
  assert.throws(() => store.writeMany([], [malformed]), code("invalid_guard"));
  assert.deepEqual(capture.writes, []);
  assert.deepEqual(capture.guards, []);
});

test("the exported hash-form surface cannot be mutated into accepting an uppercase hash", t => {
  const { store } = fixture(t);
  const source = store.write({ id: "source", kind: "source", expected: 0, value: {} });
  const malformed = { id: source.id, revision: source.revision, hash: source.hash.toUpperCase() };
  const capture = captureView(store, { rows: new Map() });
  const mutable = HASH_RE as unknown as Record<string, unknown>;
  try {
    assert.throws(() => (mutable['compile'] as (s: string, f: string) => void)(HASH_PATTERN, "i"));
    assert.equal(isRef(malformed), false);
    assert.throws(() => checkTransactionGuards([malformed]), code("invalid_guard"));
    assert.throws(() => uniqueTransactionGuards([malformed]), code("invalid_guard"));
    assert.throws(() => store.writeMany([], [malformed]), code("invalid_guard"));
    assert.throws(() => capture.view.writeMany([], [malformed]), code("invalid_guard"));
    const om = readOmAdmissionGuards([malformed], "gate", "G1");
    assert.equal(om.ok, false);
    if (!om.ok) assert.equal(om.refusal.code, "om_admission_guard_invalid");
    assert.deepEqual(capture.writes, []);
    assert.deepEqual(capture.guards, []);
  } finally { try { (mutable['compile'] as (s: string) => void)(HASH_PATTERN); } catch { /* absent */ } }
});

test("transaction guards read database heads directly and positive guards retain checksum validation", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, t => {
  const { store, path } = fixture(t);
  const source = store.write({ id: "source", kind: "source", expected: 0, value: {} });
  store.get = () => { throw new Error("A transaction must not use a public read wrapper"); };
  assert.deepEqual(store.writeMany([], [source, { id: "missing", absent: true }]), []);
  assert.throws(() => store.writeMany([], [{ id: source.id, absent: true }]), code("input_stale"));
  const raw = new DatabaseSync(path);
  try {
    raw.exec("DROP TRIGGER revisions_no_update; UPDATE revisions SET body='null' WHERE entity_id='source'");
    assert.throws(() => store.writeMany([], [source]), code("record_corrupt"));
    assert.throws(() => store.writeMany([], [{ id: source.id, absent: true }]), code("input_stale"));
  } finally { raw.close(); }
});

test("guarded writes roll back their own creations on a later write conflict", t => {
  const { store } = fixture(t);
  store.write({ id: "occupied", kind: "source", expected: 0, value: {} });
  assert.throws(() => store.writeMany([
    { id: "new", kind: "source", expected: 0, value: {} },
    { id: "neighbor", kind: "proof", expected: 0, value: {} },
    { id: "occupied", kind: "source", expected: 0, value: {} },
  ], [{ id: "new", absent: true }]), code("revision_conflict"));
  assert.equal(store.get("new"), null);
  assert.equal(store.get("neighbor"), null);
  assert.deepEqual(store.history("new"), []);
  assert.deepEqual(store.history("neighbor"), []);
});

test("the complete ee3fd4c Store producer retains records, hashes and history after restart", t => {
  const { store, path, root } = fixture(t);
  store.close();
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const repositoryUrl = pathToFileURL(repository).href;
  const loader = join(root, "legacy-store-loader.mjs");
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root;
export function initialize(data) { root = data.root; }
export async function load(url, context, next) {
  const prefix = new URL('dist/src/', root).href;
  if (url.startsWith(prefix) && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    const source = execFileSync('git', ['show', 'ee3fd4cb0941cc47e1b783e06015bd3a8d59fd8b:' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, { data: { root: ${JSON.stringify(repositoryUrl)} } });`;
  const output = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, "--input-type=module", "--eval",
    `import { Store } from ${JSON.stringify(new URL('dist/src/storage/store.js', repositoryUrl).href)};
const store = new Store(${JSON.stringify(path)});
const source = store.write({id:'source', kind:'source', expected:0, value: {text:'legacy'}});
store.writeMany([{id:'proof', kind:'proof', expected:0, value:{source}}], [source]);
store.write({id:source.id, kind:source.kind, expected:1, value:{text:'changed'}});
process.stdout.write(JSON.stringify({list:store.list(), history:store.history(source.id)})); store.close();`],
    { cwd: repository, encoding: "utf8", timeout: 30_000 });
  const legacy = JSON.parse(output) as { list: unknown[]; history: ReadGuard[] };
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.list(), legacy.list);
    assert.deepEqual(reopened.history("source"), legacy.history);
    assert.deepEqual(reopened.get("source", 1), legacy.history[0]);
    assert.throws(() => reopened.writeMany([], [legacy.history[0]!]), code("input_stale"));
    assert.deepEqual(reopened.writeMany([], [legacy.history[1]!, { id: "missing", absent: true }]), []);
    assert.deepEqual(reopened.list(), legacy.list);
  } finally { reopened.close(); }
});

test("S1.3 the change stamp moves with every commit this Store or another connection makes, and only then; identities are the rows get, list and history select, without their bodies", t => {
  const { store, path } = fixture(t);
  const other = new Store(path);
  try {
    const empty = store.changeStamp();
    assert.equal(store.changeStamp(), empty, "Reads and repeated stamps change nothing");
    const a = store.write({ id: "stamp:a", kind: "proof", expected: 0, value: { v: 1 } });
    const own = store.changeStamp();
    assert.notEqual(own, empty, "An own commit moves the stamp");
    store.get(a.id); store.list("proof"); store.history(a.id); store.identities("list", "proof");
    assert.equal(store.changeStamp(), own, "Reads do not move the stamp");
    assert.throws(() => store.write({ id: a.id, kind: a.kind, expected: 0, value: {} }), code("revision_conflict"));
    assert.throws(() => store.writeMany([{ id: "stamp:x", kind: "proof", expected: 0, value: {} }], [{ id: a.id, absent: true }]), code("input_stale"));
    assert.equal(store.changeStamp(), own, "A refused, rolled back transaction moves nothing");
    const b = other.write({ id: "stamp:b", kind: "proof", expected: 0, value: { v: 2 } });
    const foreign = store.changeStamp();
    assert.notEqual(foreign, own, "A commit of another connection moves the stamp too");
    const a2 = other.write({ id: a.id, kind: a.kind, expected: 1, value: { v: 3 } });
    assert.notEqual(store.changeStamp(), foreign);
    const identity = (row: { id: string; kind: string; revision: number; hash: string }) => ({ id: row.id, kind: row.kind, revision: row.revision, hash: row.hash });
    assert.deepEqual(store.identities("get", a.id), [identity(store.get(a.id)!)]);
    assert.deepEqual(store.identities("get", a.id, 1), [identity(store.get(a.id, 1)!)]);
    assert.deepEqual(store.identities("get", "stamp:absent"), [], "An absent head has no identity");
    assert.deepEqual(store.identities("get", a.id, 9), [], "An absent revision has no identity");
    assert.deepEqual(store.identities("list", "proof"), store.list("proof").map(identity));
    assert.deepEqual(store.identities("list"), store.list().map(identity));
    assert.deepEqual(store.identities("history", a.id), store.history(a.id).map(identity));
    assert.deepEqual(store.identities("history", a.id).map(row => row.revision), [1, 2]);
    assert.deepEqual([a2.revision, b.revision], [2, 1]);
  } finally { other.close(); }
  assert.throws(() => { const closed = new Store(path); closed.close(); closed.changeStamp(); }, code("store_busy"));
});

test("S1.3/Q4 identities('prefix') selects the literal entity_id head range in id order without decoding bodies — open and exact boundaries, empty prefix, no match, and the read is counted and reported like every other", t => {
  const { store, path } = fixture(t);
  const identity = (row: { id: string; kind: string; revision: number; hash: string }) =>
    ({ id: row.id, kind: row.kind, revision: row.revision, hash: row.hash });
  const bare = store.write({ id: "q44", kind: "proof", expected: 0, value: { v: 0 } });
  const a = store.write({ id: "q44:a", kind: "proof", expected: 0, value: { v: 1 } });
  const nested = store.write({ id: "q44:a:b", kind: "note", expected: 0, value: { v: 2 } });
  const z = store.write({ id: "q44:z", kind: "proof", expected: 0, value: { v: 3 } });
  const neighbor = store.write({ id: "q44x:a", kind: "proof", expected: 0, value: { v: 9 } });
  const edge = store.write({ id: "q44:\u{10ffff}x", kind: "proof", expected: 0, value: { v: 7 } });
  const percent = store.write({ id: "q44:%", kind: "proof", expected: 0, value: { v: 8 } });
  const underscored = store.write({ id: "q44:_x", kind: "proof", expected: 0, value: { v: 8 } });
  const upper = store.write({ id: "q44:A", kind: "proof", expected: 0, value: { v: 8 } });
  const foreignCase = store.write({ id: "Q44:a", kind: "proof", expected: 0, value: { v: 9 } });
  assert.deepEqual(store.identities("prefix", "q44:"), [percent, upper, underscored, a, nested, z, edge].map(identity),
    "The range is id order over heads of one kind or another — never bodies, never neighbors");
  assert.deepEqual(store.identities("prefix", "q44:%").map(row => row.id), ["q44:%"],
    "% is an ordinary literal character, never a pattern wildcard");
  assert.deepEqual(store.identities("prefix", "q44:_").map(row => row.id), ["q44:_x"],
    "_ is an ordinary literal character, never a pattern wildcard");
  assert.deepEqual(store.identities("prefix", "Q44:").map(row => row.id), [foreignCase.id],
    "Case is literal: 'Q44:' and 'q44:' are different ranges");
  assert.deepEqual(store.identities("prefix", "q44"), [bare, percent, upper, underscored, a, nested, z, edge, neighbor].map(identity),
    "A bare prefix is literal: 'q44x:a' shares it, colons are ordinary characters");
  assert.deepEqual(store.identities("prefix", "q44:a").map(row => row.id), ["q44:a", "q44:a:b"], "A deeper address is still inside the prefix");
  assert.deepEqual(store.identities("prefix", "q44:\u{10ffff}").map(row => row.id), ["q44:\u{10ffff}x"], "A prefix ending at the last code point has an open bound");
  assert.deepEqual(store.identities("prefix", "q44:none"), [], "No match selects nothing");
  assert.deepEqual(store.identities("prefix", ""), store.identities("list"), "The empty prefix is the whole head set, same as list's identities");
  store.write({ id: a.id, kind: a.kind, expected: 1, value: { v: 5 } });
  assert.deepEqual(store.identities("prefix", "q44:a").map(row => row.revision), [2, 1], "Heads only: an older revision is not an identity row");
  const settled = storeReads();
  store.identities("prefix", "q44:");
  assert.equal(storeReads() - settled, 1, "A prefix select is one counted read");
  const events: unknown[] = [];
  const watcher: StoreObserver = { begin() { return {}; }, end(_token, source, method, mode, id, revision, rows) {
    events.push([source === store, method, mode, id ?? null, revision ?? null, rows.map(row => row.id)]);
  }, write() {}, untraced() {} };
  const previous = observeStore(watcher);
  try {
    store.identities("prefix", "q44:a");
    assert.deepEqual(events, [[true, "identities", "prefix", "q44:a", null, ["q44:a", "q44:a:b"]]],
      "The observer hears mode 'prefix' with the literal argument and its identity rows");
  } finally { observeStore(previous); }
  const raw = new DatabaseSync(path);
  try { raw.exec("DROP TRIGGER revisions_no_update; UPDATE revisions SET body='null' WHERE entity_id='q44:z'"); }
  finally { raw.close(); }
  // NR1 (№3591/№3646): a read takes the body as written; the body unlike its hash is found by om-fsck at its address.
  assert.ok(checkStoreIntegrity(store).findings.some(item => item.code === "revision_corrupt" && item.id === "q44:z" && item.revision === 1),
    "The corrupt body is found by the whole check");
  assert.deepEqual(store.identities("prefix", "q44:").map(row => row.id), ["q44:%", "q44:A", "q44:_x", "q44:a", "q44:a:b", "q44:z", "q44:\u{10ffff}x"],
    "Identities never decode bodies: the corrupt row is still reported by its stored hash");
  assert.deepEqual(store.identities("prefix", "q44x:"), [neighbor].map(identity), "The neighbor outside the range is untouched");
});

test("S1.3/S1.4 every Store counts its get, list, history and identities reads in one process-wide count (№2302-1); a stamp is no such read", t => {
  const { store, path } = fixture(t);
  const other = new Store(path);
  try {
    store.write({ id: "count:a", kind: "proof", expected: 0, value: {} });
    const start = storeReads();
    store.get("count:a"); store.get("count:a", 1); store.list("proof"); store.history("count:a"); other.get("count:a");
    assert.equal(storeReads() - start, 5);
    const settled = storeReads();
    store.identities("get", "count:a"); store.identities("list"); store.identities("history", "count:a");
    assert.equal(storeReads() - settled, 3, "identities are reads of the Store too, no bypass of the count");
    const counted = storeReads(); store.changeStamp();
    assert.equal(storeReads(), counted);
  } finally { other.close(); }
});

test("S1.4 the Store reports each completed read once with its request and result, never a read that threw, and every write attempt before its first check — refused, rolled back or refused by a view policy (№2302-1, -2)", t => {
  const { store } = fixture(t);
  const a = store.write({ id: "observe:a", kind: "proof", expected: 0, value: { v: 1 } });
  const events: unknown[] = [], writes: Store[] = [];
  let begun = 0, untraced = 0;
  const token = {};
  const watcher: StoreObserver = {
    begin() { begun++; return token; },
    end(given, source, method, mode, id, revision, rows) { assert.equal(given, token); events.push([source === store, method, mode, id ?? null, revision ?? null, rows.map(row => row.id)]); },
    write(source) { writes.push(source); },
    untraced() { untraced++; },
  };
  const previous = observeStore(watcher);
  try {
    store.get(a.id); store.get(a.id, 1); store.get("observe:none"); store.list("proof"); store.list("none"); store.history(a.id);
    store.identities("get", a.id, 1); store.identities("list"); store.identities("history", "observe:none");
    assert.deepEqual(events, [
      [true, "get", "get", a.id, null, [a.id]], [true, "get", "get", a.id, 1, [a.id]], [true, "get", "get", "observe:none", null, []],
      [true, "list", "list", "proof", null, [a.id]], [true, "list", "list", "none", null, []], [true, "history", "history", a.id, null, [a.id]],
      [true, "identities", "get", a.id, 1, [a.id]], [true, "identities", "list", null, null, [a.id]], [true, "identities", "history", "observe:none", null, []],
    ]);
    const settled = events.length, started = begun;
    assert.throws(() => store.get(Symbol("unbindable") as unknown as string));
    assert.deepEqual([events.length, begun], [settled, started + 1], "A read that threw was begun and never reported as complete");
    assert.throws(() => store.write({ id: a.id, kind: "proof", expected: 7, value: {} }), (error: unknown) => (error as EngineError).code === "revision_conflict");
    assert.throws(() => store.writeMany([{ id: "observe:b", kind: "proof", expected: 0, value: {} }], [{ id: "observe:none", absent: true }, { id: a.id, revision: 9, hash: a.hash }]),
      (error: unknown) => (error as EngineError).code === "input_stale");
    const refusing = storeView(store, { write: () => { throw new EngineError("policy_refused", "never"); } });
    assert.throws(() => refusing.write({ id: a.id, kind: "proof", expected: 1, value: {} }), (error: unknown) => (error as EngineError).code === "policy_refused");
    assert.deepEqual(writes, [store, store, store], "Each attempt — a conflict, a stale guard, a policy refusal — is reported before any check");
    assert.equal(store.get(a.id)!.revision, 1, "Nothing was published");
    const capture = captureView(store, { rows: new Map() }).view, writeOnly = storeView(store, { write: () => { throw new EngineError("policy_refused", "never"); } });
    writeOnly.get(a.id); writeOnly.list("proof"); assert.equal(untraced, 0, "A write-only view of the Store reads as the Store itself");
    capture.get(a.id); capture.list("proof"); capture.history(a.id); assert.equal(untraced, 3, "Every read through an opaque view is reported as untraced (№2395)");
  } finally { observeStore(previous); }
});

// PF4 part 2 (№3499 §3.1, §5): committed events without bodies, migration 2 and the proof cache of this database.
test("PF4 rows 14-16: the last committed event and the events in (from, to] — sequence order, the revision's kind, several events of one id and a gap in the numbers — read no body, count no product read and reach no observer", t => {
  const { store, path } = fixture(t);
  assert.equal(store.lastEvent(), 0);
  store.write({ id: "pf4:a", kind: "one", expected: 0, value: {} });
  const second = new Store(path);
  try {
    second.writeMany([{ id: "pf4:b", kind: "two", expected: 0, value: {} }, { id: "pf4:a", kind: "one", expected: 1, value: { v: 2 } }]);
    const raw = new DatabaseSync(path);
    try {
      raw.prepare("INSERT INTO revisions VALUES(?,?,?,?,?)").run("pf4:c", 1, "three", "{}", digest("{}"));
      raw.prepare("INSERT INTO heads VALUES(?,?)").run("pf4:c", 1);
      raw.prepare("INSERT INTO events(sequence, entity_id, revision) VALUES(10, ?, ?)").run("pf4:c", 1);
    } finally { raw.close(); }
    const hash = second.get("pf4:a")!.hash, reads = storeReads(), seen: string[] = [];
    const previous = observeStore({ begin: () => { seen.push("read"); return undefined; }, end() {}, write() {}, untraced() {} });
    try {
      assert.equal(store.lastEvent(), 10);
      assert.deepEqual(store.events(0, 10), [
        { sequence: 1, id: "pf4:a", revision: 1, kind: "one" }, { sequence: 2, id: "pf4:b", revision: 1, kind: "two" },
        { sequence: 3, id: "pf4:a", revision: 2, kind: "one" }, { sequence: 10, id: "pf4:c", revision: 1, kind: "three" }]);
      assert.deepEqual(store.events(3, 9), [], "A gap in the numbers is no missing event: the range is what SQLite holds");
      assert.deepEqual(store.events(1, 3).map(event => event.sequence), [2, 3], "The range is (from, to]");
      assert.deepEqual(store.eventAt(3), { id: "pf4:a", revision: 2, hash });
      assert.equal(store.eventAt(5), null);
    } finally { observeStore(previous); }
    assert.equal(storeReads(), reads, "No product read is counted"); assert.deepEqual(seen, [], "No observer sees them");
  } finally { second.close(); }
  store.close();
  assert.throws(() => store.lastEvent(), code("store_busy")); assert.throws(() => store.events(0, 1), code("store_busy"));
});

test("PF4 rows 37-39 (№3523): the proof cache is an extension of v1 — schema, user_version and migrations stay as they were; it is installed in the transaction of the open, wholly or not at all; an incomplete or foreign extension is migration_mismatch, removed by the door without touching the history; snapshots with and without it read and restore alike", async t => {
  const { store, path, root, snapshots } = fixture(t);
  const objects = (db: DatabaseSync) => db.prepare("SELECT type || ':' || name AS object FROM sqlite_master WHERE name LIKE 'proof_%' ORDER BY name").all().map(row => String(row['object']));
  const shape = (db: DatabaseSync) => ({ user: Number(db.prepare("PRAGMA user_version").get()!['user_version']),
    migrations: db.prepare("SELECT version, sha256 FROM migrations ORDER BY version").all().map(row => [Number(row['version']), String(row['sha256'])]),
    cache: objects(db), record: objects(db).includes('table:proof_cache_schema') ? db.prepare("SELECT version FROM proof_cache_schema").all().map(row => Number(row['version'])) : [] });
  const product = (db: DatabaseSync) => canonical(["identity", "revisions", "heads", "events"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()) as unknown as Json);
  const inspect = <T,>(read: (db: DatabaseSync) => T, at = path): T => { const db = new DatabaseSync(at, { readOnly: true }); try { return read(db); } finally { db.close(); } };
  const EXTENSION = ["table:proof_cache", "table:proof_cache_schema", "table:proof_links", "index:proof_links_node", "table:proof_nodes"];
  store.write({ id: "pf4:m", kind: "k", expected: 0, value: { v: 1 } });
  store.close();
  const installed = inspect(shape);
  assert.deepEqual([installed.user, installed.migrations.length, installed.cache, installed.record], [1, 1, EXTENSION, [2]],
    "Row 37: v1 as it was, the extension beside it with its own record");
  const history = inspect(product);
  new Store(path).close();
  assert.deepEqual(inspect(shape), installed, "Row 37: a repeated open changes nothing");
  removeProofCache(path);
  assert.deepEqual(inspect(shape), { ...installed, cache: [], record: [] }); assert.equal(inspect(product), history, "Row 39: the door touches no product row");
  inspect(db => assertSchema(db));
  removeProofCache(path);
  assert.deepEqual(inspect(shape).cache, [], "Row 39: the door is idempotent");
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    if (sql.includes("INSERT INTO proof_cache_schema")) throw new Error("pf4: interrupted install");
    return prepare.call(this, sql);
  };
  try { assert.throws(() => new Store(path), /interrupted install/); } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.deepEqual(inspect(shape).cache, [], "Row 37: an interrupted install leaves nothing of the extension");
  const reopened = new Store(path);
  assert.deepEqual(reopened.get("pf4:m")!.value, { v: 1 }); reopened.close();
  assert.deepEqual(inspect(shape), installed); assert.equal(inspect(product), history);
  const broken = (change: string) => {
    const raw = new DatabaseSync(path); raw.exec(change); raw.close();
    assert.throws(() => new Store(path), code("migration_mismatch"), change);
    assert.throws(() => inspect(db => assertSchema(db)), code("migration_mismatch"));
    removeProofCache(path);
    assert.equal(inspect(product), history, "Row 39: removing an incomplete extension keeps the history");
    new Store(path).close();
    assert.deepEqual(inspect(shape), installed);
  };
  broken("DROP TABLE proof_nodes");
  broken("DELETE FROM proof_cache_schema");
  broken("UPDATE proof_cache_schema SET version = 3");
  broken("UPDATE proof_cache_schema SET sha256 = 'other'");
  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE proof_links; CREATE VIEW proof_links AS SELECT 1 AS key");
  raw.close();
  assert.throws(() => removeProofCache(path), code("migration_mismatch"), "An object of another type under its name is no object of the extension");
  assert.deepEqual(inspect(objects), ["table:proof_cache", "table:proof_cache_schema", "view:proof_links", "table:proof_nodes"],
    "The refused door rolled back: nothing was dropped");
  const fix = new DatabaseSync(path); fix.exec("DROP VIEW proof_links"); fix.close();
  removeProofCache(path);
  const current = new Store(path);
  const withExtension = await current.snapshot(snapshots);
  current.close();
  assert.equal(inspectSnapshot(withExtension.path).contentHash, withExtension.contentHash);
  const withoutExtension = join(root, "without-extension.sqlite");
  copyFileSync(withExtension.path, withoutExtension);
  removeProofCache(withoutExtension);
  assert.equal(inspectSnapshot(withoutExtension).contentHash, withExtension.contentHash, "Row 38: the extension is no part of the history a snapshot names");
  assert.deepEqual(inspect(objects, withoutExtension), []);
  const restored = restoreSnapshot(snapshots, join(root, "restored", "state.sqlite"));
  const opened = new Store(restored.path);
  try { assert.deepEqual(opened.get("pf4:m")!.value, { v: 1 }); assert.equal(opened.proofCacheRead("absent"), null); } finally { opened.close(); }
  const fromBare = new Store(withoutExtension);
  try { assert.equal(fromBare.history("pf4:m").length, 1); } finally { fromBare.close(); }
  assert.deepEqual(inspect(objects, withoutExtension), EXTENSION, "Row 38: a snapshot without the extension starts cold and installs it on a working open");
});

/** The engine of one commit, transpiled from git, on its own process (the ee3fd4c producer above uses the same loader). */
function atCommit(root: string, commit: string, script: string): unknown {
  const repository = fileURLToPath(new URL('../../', import.meta.url)), repositoryUrl = pathToFileURL(repository).href;
  const loader = join(root, `legacy-${commit}-loader.mjs`);
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
let root;
export function initialize(data) { root = data.root; }
export async function load(url, context, next) {
  const prefix = new URL('dist/src/', root).href;
  if (url.startsWith(prefix) && /\\.js$/.test(url)) {
    const relative = 'src/' + url.slice(prefix.length).replace(/\\.js$/, '.ts');
    const source = execFileSync('git', ['show', ${JSON.stringify(commit)} + ':' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}`);
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, { data: { root: ${JSON.stringify(repositoryUrl)} } });`;
  const src = (module: string) => JSON.stringify(new URL(`dist/src/${module}.js`, repositoryUrl).href);
  const output = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, "--input-type=module", "--no-warnings", "--eval",
    `const { Store } = await import(${src('storage/store')}); const { inspectSnapshot } = await import(${src('storage/snapshots')});
const out = value => process.stdout.write(JSON.stringify(value));
${script}`], { cwd: repository, encoding: "utf8", timeout: 60_000 });
  return JSON.parse(output);
}

test("PF4 (№3523): the engine before PF4 (3e8aa784) opens and writes a database with the extension and reads snapshots with and without it; a check this engine saved notices what the old engine wrote, and one it did not touch stays", async t => {
  const { store, path, root, snapshots } = fixture(t);
  const dep = store.write({ id: "pf4:dep", kind: "k", expected: 0, value: { v: 1 } });
  const other = store.write({ id: "pf4:other", kind: "k", expected: 0, value: { v: 1 } });
  const runs = { dep: 0, other: 0 };
  const prove = (target: Store, name: keyof typeof runs) => withHistoricalReads(() => historicalRead(target, { reader: "M6.route-result", project: "garden",
    ref: reference(name === "dep" ? dep : other), parameters: "pf4-legacy" }, () => { runs[name]++; return target.get(`pf4:${name}`)!.value; }, () => { throw new Error("cycle"); }));
  prove(store, "dep"); prove(store, "other");
  const snapshot = await store.snapshot(snapshots);
  store.close();
  const bare = join(root, "bare-snapshot.sqlite");
  copyFileSync(snapshot.path, bare);
  removeProofCache(bare);
  const legacy = atCommit(root, "3e8aa784b5d61188dfa6ad171f9d8cccefb2f1b6", `const store = new Store(${JSON.stringify(path)});
const before = store.get('pf4:dep').value;
store.write({ id: 'pf4:dep', kind: 'k', expected: 1, value: { v: 2 } });
store.close();
out({ before, snapshots: [inspectSnapshot(${JSON.stringify(snapshot.path)}).contentHash, inspectSnapshot(${JSON.stringify(bare)}).contentHash] });`) as { before: Json; snapshots: string[] };
  assert.deepEqual(legacy.before, { v: 1 });
  assert.deepEqual(legacy.snapshots, [snapshot.contentHash, snapshot.contentHash], "The old engine reads snapshots with and without the extension");
  assert.equal(inspectSnapshot(bare).contentHash, snapshot.contentHash, "And so does this one");
  const reopened = new Store(path); t.after(() => reopened.close());
  assert.deepEqual(prove(reopened, "dep"), { v: 2 }); assert.equal(runs.dep, 2, "The old engine's write is an event after the saved mark");
  assert.deepEqual(prove(reopened, "other"), { v: 1 }); assert.equal(runs.other, 1, "A check it did not touch is taken as saved");
});

test("PF4 rows 34-36: the proof cache is written in one transaction of its own — a failure inside leaves nothing, a held cache is skipped at once — bounded by results and bytes with unreferenced nodes swept and shared ones kept; it adds no event, moves no change stamp and no read count, and can be emptied", t => {
  const { store, path } = fixture(t);
  store.write({ id: "pf4:w", kind: "k", expected: 0, value: {} });
  const stamp = store.changeStamp(), last = store.lastEvent(), reads = storeReads();
  const limits = { roots: 3, bytes: 1024 * 1024 };
  const record = (key: string, nodes: string[]) => ({ key, body: JSON.stringify({ key }), nodes });
  const node = (hash: string) => ({ hash, body: JSON.stringify({ hash }) });
  const raw = new DatabaseSync(path); t.after(() => raw.close());
  const count = (table: string) => Number(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!['n']);
  raw.exec("CREATE TRIGGER pf4_fail BEFORE INSERT ON proof_nodes WHEN NEW.hash = 'fail' BEGIN SELECT RAISE(ABORT, 'pf4_fail'); END");
  assert.throws(() => store.proofCacheWrite([record("a", ["shared", "fail"])], [node("shared"), node("fail")], limits), /pf4_fail/);
  assert.deepEqual([count("proof_cache"), count("proof_nodes"), count("proof_links")], [0, 0, 0], "Row 34: a failure inside leaves nothing");
  raw.exec("DROP TRIGGER pf4_fail");
  raw.exec("BEGIN IMMEDIATE");
  assert.equal(store.proofCacheWrite([record("a", ["shared"])], [node("shared")], limits), null, "Row 35: a held cache is skipped at once");
  raw.exec("ROLLBACK");
  assert.equal(store.write({ id: "pf4:after-busy", kind: "k", expected: 0, value: {} }).revision, 1, "Row 35: product writes go on");
  const lastAfter = store.lastEvent(), stampAfter = store.changeStamp();
  const first = store.proofCacheWrite([record("a", ["shared", "a1"]), record("b", ["shared", "b1"])], [node("shared"), node("a1"), node("b1")], limits)!;
  assert.deepEqual([first.records, first.nodes, first.evicted], [2, 3, 0]);
  const second = store.proofCacheWrite([record("c", ["shared", "c1"]), record("d", ["d1"])], [node("c1"), node("d1")], limits)!;
  assert.equal(second.evicted, 1); assert.deepEqual(second.swept, ["a1"], "The oldest result goes, with only the nodes no kept result reaches");
  assert.equal(store.proofCacheRead("a"), null); assert.notEqual(store.proofCacheNode("shared"), null);
  const replaced = store.proofCacheWrite([record("b", ["b2"])], [node("b2")], limits)!;
  assert.deepEqual(replaced.swept, ["b1"], "Row 36: a replaced result takes its old links with it; the pair is one row");
  assert.equal(JSON.parse(store.proofCacheRead("b")!).key, "b");
  const small = store.proofCacheWrite([record("e", ["e1"])], [{ hash: "e1", body: "x".repeat(4000) }], { roots: 512, bytes: 6000 })!;
  assert.ok(small.bytes <= 6000 && small.evicted > 0, "Row 35: the byte bound evicts the oldest results");
  assert.deepEqual([store.changeStamp(), store.lastEvent(), storeReads()], [stampAfter, lastAfter, reads + 1],
    "The cache writes add no event, move no change stamp and count no product read (the one counted is the product write's own check)");
  assert.equal(lastAfter, last + 1); assert.notEqual(stampAfter, stamp);
  store.proofCacheClear();
  assert.deepEqual([count("proof_cache"), count("proof_nodes"), count("proof_links")], [0, 0, 0]);
  assert.equal(store.get("pf4:w")!.revision, 1);
  // Return №3541-2: whether a node is saved is decided inside the transaction. A node another connection swept is
  // written again from what was given; a result naming a node neither saved nor given writes nothing at all.
  store.proofCacheWrite([record("f", ["f1"])], [node("f1")], limits);
  raw.prepare("DELETE FROM proof_links").run(); raw.prepare("DELETE FROM proof_nodes").run();
  const again = store.proofCacheWrite([record("g", ["f1", "g1"])], [node("f1"), node("g1")], limits)!;
  assert.equal(again.nodes, 2, "The swept node is written again in the result's own transaction");
  assert.equal(Number(raw.prepare("SELECT count(*) AS n FROM proof_links l LEFT JOIN proof_nodes n ON l.node = n.hash WHERE n.hash IS NULL").get()!['n']), 0);
  assert.throws(() => store.proofCacheWrite([record("h", ["absent"])], [], limits), code("proof_cache_incomplete"));
  assert.equal(store.proofCacheRead("h"), null, "Nothing of an incomplete result is written");
});

test("headsMatch compares positive, absent and contradictory guards in one counted snapshot without decoding a body", t => {
  const { store } = fixture(t);
  const a = store.write({ id: "hm:a", kind: "k", expected: 0, value: { n: 1 } });
  const b = store.write({ id: "hm:b", kind: "k", expected: 0, value: { n: 1 } });
  const ghost: AbsentGuard = { id: "hm:ghost", absent: true };
  const before = storeReads();
  const first = store.headsMatch([reference(a), reference(b), ghost]);
  assert.deepEqual([first.ok, first.conflict, first.mismatches], [true, false, []]);
  assert.equal(storeReads() - before, 1, "one physical read for the whole guard set");
  assert.equal(store.headsMatch([]).ok, true, "the empty guard set holds");
  store.write({ id: "hm:b", kind: "k", expected: 1, value: { n: 2 } });
  const moved = store.headsMatch([reference(a), reference(b), ghost]);
  assert.equal(moved.ok, false); assert.equal(moved.conflict, false);
  assert.equal(moved.mismatches.length, 1);
  assert.equal(moved.mismatches[0]!.id, "hm:b");
  assert.equal(moved.mismatches[0]!.actual?.revision, 2);
  store.write({ id: "hm:ghost", kind: "k", expected: 0, value: {} });
  const present = store.headsMatch([ghost]);
  assert.equal(present.ok, false); assert.equal(present.mismatches[0]!.id, "hm:ghost");
  const conflict = store.headsMatch([reference(a), { id: "hm:a", absent: true }]);
  assert.equal(conflict.ok, false); assert.equal(conflict.conflict, true,
    "contradictory requirements on one id are a conflict, never a silent pass");
  const bulk: TransactionGuard[] = [];
  for (let index = 0; index < 1001; index++)
    bulk.push(reference(store.write({ id: `hm:bulk:${index}`, kind: "k", expected: 0, value: { index } })));
  const bulkBefore = storeReads();
  assert.equal(store.headsMatch(bulk).ok, true, "chunks share the one snapshot");
  assert.equal(storeReads() - bulkBefore, Math.ceil(bulk.length / 999),
    "every executed SELECT chunk is a counted read, not one flat read for the whole set");
  assert.throws(() => store.headsMatch([{ id: "x", absent: false } as unknown as TransactionGuard]),
    code("invalid_guard"), "guards are checked with the single form every caller shares");
});

test("headsMatch under a capture journals exactly the selected ids — reused unchanged and after a foreign write, re-derived when a selected head moves or appears", t => {
  const { store } = fixture(t);
  // №6262 G1-02: inside an active capture each distinct id is one point identities get of the same
  // snapshot — present or absent — so the journal depends on those ids only, never on the whole Store.
  for (const count of [2, 1001]) {
    const refs = store.writeMany(Array.from({ length: count }, (_value, index) =>
      ({ id: `hm:pf4:${count}:${index}`, kind: "k", expected: 0, value: { index } }))).map(reference);
    const ghost: AbsentGuard = { id: `hm:pf4:${count}:ghost`, absent: true };
    let derived = 0;
    const run = (guards: TransactionGuard[]) => withHistoricalReads(() => historicalRead(store,
      { reader: "M6.route-result", project: "garden", ref: refs[0]! },
      () => { derived++; return { ok: store.headsMatch(guards).ok }; },
      () => { throw new Error("cycle"); }));
    const guards: TransactionGuard[] = [...refs, ghost];
    assert.deepEqual(run(guards), { ok: true }); assert.deepEqual(run(guards), { ok: true });
    assert.equal(derived, 1, `${count} dependencies: the second operation replays the saved proof`);
    store.write({ id: `unrelated:another-project:${count}`, kind: "noise", expected: 0, value: {} });
    assert.deepEqual(run(guards), { ok: true });
    assert.equal(derived, 1, `${count} dependencies: a write of an unselected id leaves the proof reusable`);
    const last = refs.at(-1)!;
    store.write({ id: last.id, kind: "k", expected: last.revision, value: { moved: true } });
    assert.deepEqual(run(guards), { ok: false });
    assert.equal(derived, 2, `${count} dependencies: a moved selected head re-derives`);
    const current = [...refs.slice(0, -1), reference(store.get(last.id)!), ghost];
    assert.deepEqual(run(current), { ok: true });
    assert.equal(derived, 3);
    store.write({ id: ghost.id, kind: "k", expected: 0, value: {} });
    assert.deepEqual(run(current), { ok: false });
    assert.equal(derived, 4, `${count} dependencies: a selected absent id that appears re-derives`);
  }
});

test("headsMatch reports to an observing observer one point read per distinct id — physical and observed counts agree for 0, 2 and 1001 ids", t => {
  const { store } = fixture(t);
  const seen: { method: string; mode: string; id: string | undefined; rows: number }[] = [];
  const previous = observeStore({ begin: () => ({}),
    end: (_token, _store, method, mode, id, _revision, rows) => { seen.push({ method, mode, id, rows: rows.length }); },
    write: () => {}, untraced: () => {} });
  try {
    for (const count of [0, 2, 1001]) {
      const refs = count ? store.writeMany(Array.from({ length: count }, (_value, index) =>
        ({ id: `hm:obs:${count}:${index}`, kind: "k", expected: 0, value: { index } }))).map(reference) : [];
      const guards: TransactionGuard[] = count ? [...refs, refs[0]!, { id: `hm:obs:${count}:ghost`, absent: true }] : [];
      seen.length = 0;
      const before = storeReads();
      assert.equal(store.headsMatch(guards).ok, true);
      const physical = storeReads() - before;
      const distinct = count ? count + 1 : 0;
      assert.equal(physical, distinct, `${count}: one physical read per distinct id, the repeated guard read once`);
      assert.equal(seen.length, physical, `${count}: every physical read is observed exactly once`);
      assert.ok(seen.every(event => event.method === "identities" && event.mode === "get" && event.id !== undefined),
        `${count}: never a whole-Store list`);
      if (count) assert.deepEqual(seen.at(-1), { method: "identities", mode: "get", id: `hm:obs:${count}:ghost`, rows: 0 },
        `${count}: the absent id is recorded as selected and found absent`);
    }
  } finally { observeStore(previous); }
  // Outside any capture the same comparison stays the chunked snapshot.
  const bulk = store.list().filter(row => row.id.startsWith("hm:obs:1001:")).map(reference);
  const before = storeReads();
  assert.equal(store.headsMatch(bulk).ok, true);
  assert.equal(storeReads() - before, Math.ceil(bulk.length / 999), "unobserved: one counted read per SELECT chunk");
});

test("transactionGuardsCurrent takes the heads snapshot only on a genuine unobserved Store, else the observable gets", t => {
  const { store } = fixture(t);
  const a = store.write({ id: "tg:a", kind: "k", expected: 0, value: { n: 1 } });
  const ghost: AbsentGuard = { id: "tg:ghost", absent: true };
  const guards: TransactionGuard[] = [reference(a), ghost];
  const count = (action: () => boolean): [boolean, number] => {
    const before = storeReads(); const result = action(); return [result, storeReads() - before];
  };
  assert.deepEqual(count(() => transactionGuardsCurrent(store, guards)), [true, 1],
    "one snapshot read on a genuine Store");
  assert.equal(transactionGuardsCurrent(store, [reference(a), { id: "tg:a", absent: true }]), false,
    "contradictory guards refuse exactly as the per-guard walk did");
  // An opaque view never takes the snapshot: the observable per-guard gets stay.
  const opaque = { get: (id: string, revision?: number) => store.get(id, revision) } as Store;
  assert.deepEqual(count(() => transactionGuardsCurrent(opaque, guards)), [true, 2],
    "a view it cannot prove keeps the two observable gets");
  // A capture whose reads are observed keeps the same gets — the snapshot would hide them.
  const inside = withHistoricalReads(() => historicalRead(store,
    { reader: "M6.route-result", project: "garden", ref: reference(a) },
    () => count(() => transactionGuardsCurrent(store, guards)), () => { throw new Error("cycle"); }));
  assert.deepEqual(inside, [true, 2], "inside an active capture the heads are read one by one");
  assert.deepEqual(count(() => transactionGuardsCurrent(store, guards)), [true, 1],
    "and the snapshot returns outside it");
  // An installed observer that answers begin() is itself an active capture: the gets stay observable.
  const seen: string[] = [];
  const previous = observeStore({ begin: () => ({}),
    end: (_token, _store, method) => { seen.push(method); }, write: () => {}, untraced: () => {} });
  try {
    assert.equal(transactionGuardsCurrent(store, guards), true);
    assert.deepEqual(seen, ["get", "get"], "an observing observer keeps the per-guard reads");
    seen.length = 0;
    assert.equal(store.headsMatch(guards).ok, true);
    assert.deepEqual(seen, ["identities", "identities"],
      "under an observing observer headsMatch reads each selected id by a point identities get (№6262)");
  } finally { observeStore(previous); }
});
