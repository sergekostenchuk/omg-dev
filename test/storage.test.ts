import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { observeStore, Store, storeReads, type AbsentGuard, type ReadGuard, type StoreObserver, type TransactionGuard } from "../src/storage/store.js";
import { captureView, storeView } from "../src/storage/store-view.js";
import { isRef } from "../src/pipeline/contracts.js";
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
    { ...positive, id: "foreign-source" }, { ...positive, hash: positive.hash.toUpperCase() }]) {
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
    ...["", "a".repeat(63), "a".repeat(65), "g".repeat(64), 1, null].map(hash => ({ ...valid, hash })),
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

test("transaction guards read database heads directly and positive guards retain checksum validation", t => {
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
  assert.throws(() => store.get("q44:z"), code("record_corrupt"), "The corrupt body is still corrupt for a real read");
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
