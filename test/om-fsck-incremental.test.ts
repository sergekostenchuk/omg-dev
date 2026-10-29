import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest } from "../src/canonical.js";
import { reference } from "../src/pipeline/contracts.js";
import { Store } from "../src/storage/store.js";
import { checkStoreIntegritySince } from "../src/storage/fsck.js";
import { incrementalIntegrityGate, integrityGate, integrityId, integrityMarkPath, saveIntegrityMark } from "../src/om/integrity.js";

/**
 * PROOF-SPEED-2 (owner rule 08.10, the database fingerprint): a Discovery entry checks only what was committed after a
 * mark this very file still proves; om-start and om-continue keep the whole check. The mark is a note beside the file,
 * written once the checking Store is closed, naming the database, the event at its cursor and the file as left; any write
 * to the file after it — by anyone — makes the next entry check in full before any history is used.
 */
const PROJECT = "garden";
const TRIGGERS = ["revisions_no_update", "revisions_no_delete", "events_no_update", "events_no_delete"];

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-fsck-inc-"));
  const path = join(root, "store.sqlite");
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const [a] = store.writeMany([{ id: "note:garden:a", kind: "note", expected: 0, value: { text: "first" } }]);
  store.writeMany([{ id: "note:garden:b", kind: "note", expected: 0, value: { names: [reference(a!)] } }]);
  return {
    path, get store() { return store; }, a: a!,
    reopen() { store.close(); store = new Store(path); return store; },
    /** A change as someone other than the engine makes it: another connection, raw SQL, the immutability triggers dropped. */
    foreign(sql: string, ...values: (string | number)[]) {
      store.close();
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=OFF");
      for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.prepare(sql).run(...values);
      db.close();
      store = new Store(path);
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
/** One entry: the check from the mark, and — when clean — its mark kept for when the Store closes, as the driver does. */
function entry(store: Store, project = PROJECT) {
  const gate = incrementalIntegrityGate(store, project);
  if (gate.checked !== null) saveIntegrityMark(store, project, gate.checked, gate.witness);
  return gate;
}
const code = (gate: { refusal: ReturnType<typeof integrityGate> }) => gate.refusal && !gate.refusal.ok ? gate.refusal.refusal.code : null;
const message = (gate: { refusal: ReturnType<typeof integrityGate> }) => gate.refusal && !gate.refusal.ok ? gate.refusal.refusal.message : "";
/** Rewrites an old body in place, keeping its sha256, the counts and the last event: only reading the body finds it. */
const behind = (f: Fixture) =>
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ text: "forged" }), f.a.id);

test("incremental om-fsck: a clean entry leaves a note beside the file, writes no product record; the next entry checks only what came after", t => {
  const f = fixture(t);
  const stamp = f.store.changeStamp();
  assert.deepEqual([code(entry(f.store)), f.store.changeStamp()], [null, stamp], "the whole check, then nothing written to the database");
  assert.equal(f.store.get(integrityId(PROJECT)), null, "a clean check saves no diagnostic record");
  const mark = f.store.lastEvent(), store = f.reopen();
  assert.ok(existsSync(integrityMarkPath(store, PROJECT)), "the note is written once the Store is closed");
  store.writeMany([{ id: "note:garden:c", kind: "note", expected: 0, value: { text: "third" } }]);
  const since = checkStoreIntegritySince(store, mark);
  assert.deepEqual([since.events, since.findings], [1, []], "after the mark only the one new event is checked");
  assert.equal(entry(store).since, null, "a write of this very connection is pending in its journal: the entry checks in full");
  const cold = entry(f.reopen());
  assert.deepEqual([code(cold), cold.since], [null, f.store.lastEvent()], "a cold entry over the untouched file checks from its mark");
});

test("incremental om-fsck: an old body rewritten after the mark — same sha256, counts and last event — stops the next cold entry", t => {
  const f = fixture(t);
  assert.equal(code(entry(f.store)), null);
  f.reopen();
  behind(f);
  const gate = entry(f.store);
  assert.deepEqual([gate.since, code(gate)], [null, "store_damaged"], "the file was written after the mark: the whole check runs");
  assert.match(message(gate), new RegExp(`revision_corrupt ${f.a.id}@1`));
  assert.ok(f.store.get(integrityId(PROJECT)), "the found damage is saved for the owner");
  assert.equal(code({ refusal: integrityGate(f.store, PROJECT) }), "store_damaged", "om-start finds the same");
});

test("incremental om-fsck: after the mark a new reference to other bytes is forged; a removed event is found by the whole check", t => {
  const f = fixture(t);
  assert.equal(code(entry(f.store)), null);
  const store = f.reopen();
  const forged = { ...reference(f.a), hash: digest(canonical({ text: "other" })) };
  store.writeMany([{ id: "note:garden:c", kind: "note", expected: 0, value: { names: [forged] } }]);
  assert.deepEqual(checkStoreIntegritySince(store, store.lastEvent() - 1).findings.map(row => row.code), ["reference_forged"]);
  const g = fixture(t);
  assert.equal(code(entry(g.store)), null);
  g.reopen();
  g.foreign("DELETE FROM events WHERE entity_id = ? AND revision = 1", g.a.id);
  const gate = entry(g.store);
  assert.equal(code(gate), "store_damaged");
  assert.match(message(gate), new RegExp(`event_missing ${g.a.id}@1`));
});

test("incremental om-fsck: a forged, foreign or erased note is no mark — each entry checks in full and finds the damage behind it", t => {
  /** The world: a clean entry, its note, then an old body rewritten behind it (only the whole check reads it). */
  const world = () => { const f = fixture(t); assert.equal(code(entry(f.store)), null); f.reopen(); behind(f); return f; };
  const note = (f: Fixture) => JSON.parse(readFileSync(integrityMarkPath(f.store, PROJECT), "utf8")) as Record<string, unknown>;
  const sign = (path: string) => { const s = statSync(path, { bigint: true }); return { size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), ino: String(s.ino) }; };
  /** The note rewritten so that it proves this very file as it is now — every binding but the one changed by `edit`. */
  const reforge = (f: Fixture, edit: (mark: Record<string, unknown>) => Record<string, unknown>) =>
    writeFileSync(integrityMarkPath(f.store, PROJECT), JSON.stringify(edit({ ...note(f), file: sign(f.path) })));
  const found = (f: Fixture, why: string) => {
    const gate = entry(f.store);
    assert.deepEqual([gate.since, code(gate)], [null, "store_damaged"], why);
    assert.match(message(gate), new RegExp(`revision_corrupt ${f.a.id}@1`), why);
  };
  // The limit of the model: a note forged with this file's sign and every binding right is taken — the engine is the only
  // writer of the database and of its note (owner rule 08.10); om-start and om-continue still check the whole store.
  const limit = world();
  reforge(limit, mark => mark);
  assert.equal(code(entry(limit.store)), null, "a note forged with every binding right is the model's limit");
  assert.equal(code({ refusal: integrityGate(limit.store, PROJECT) }), "store_damaged", "om-start finds the damage");
  // Even past a fully forged note, a removed event leaves revisions and events unpaired: the whole check runs.
  const unpaired = fixture(t);
  assert.equal(code(entry(unpaired.store)), null);
  unpaired.reopen();
  unpaired.foreign("DELETE FROM events WHERE entity_id = ? AND revision = 1", unpaired.a.id);
  reforge(unpaired, mark => mark);
  const gate = entry(unpaired.store);
  assert.equal(code(gate), "store_damaged", "revisions and events unpaired behind a forged note");
  assert.match(message(gate), new RegExp(`event_missing ${unpaired.a.id}@1`));
  // (a) A note forged with another event at its cursor.
  const forged = world();
  reforge(forged, mark => ({ ...mark, event: { id: "note:garden:x", revision: 1, hash: "0".repeat(64) } }));
  found(forged, "(a) a forged note");
  // (b) The note of another database — the same history byte for byte — and the note of another project.
  const other = fixture(t), mine = world();
  assert.equal(code(entry(other.store)), null);
  other.reopen();
  reforge(mine, () => ({ ...JSON.parse(readFileSync(integrityMarkPath(other.store, PROJECT), "utf8")), file: sign(mine.path) }));
  found(mine, "(b) the note of another database");
  const project = fixture(t);
  assert.equal(code(entry(project.store, "orchard")), null, "another project of the same database keeps its own note");
  project.reopen();
  behind(project);
  found(project, "(b) another project's note");
  // (c) The note is erased.
  const erased = world();
  rmSync(integrityMarkPath(erased.store, PROJECT));
  found(erased, "(c) an erased note");
});

test("incremental om-fsck (map-2 №18491): another connection's commit while the checking Store is open leaves no mark and erases the old one", t => {
  /** A change by another connection while the checking Store stays open: raw SQL, the immutability triggers dropped. */
  const meanwhile = (f: Fixture, sql: string, ...values: (string | number)[]) => {
    const db = new DatabaseSync(f.path);
    for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.prepare(sql).run(...values);
    db.close();
  };
  const f = fixture(t);
  assert.equal(code(entry(f.store)), null, "A checks the whole store and keeps its mark for when it closes");
  meanwhile(f, "UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ text: "forged" }), f.a.id);
  f.reopen();
  assert.equal(existsSync(integrityMarkPath(f.store, PROJECT)), false, "the file changed under A: no mark");
  const gate = entry(f.store);
  assert.deepEqual([gate.since, code(gate)], [null, "store_damaged"]);
  assert.match(message(gate), new RegExp(`revision_corrupt ${f.a.id}@1`));
  // An older mark is erased the same way: the next entry cannot fall back on it.
  const g = fixture(t);
  assert.equal(code(entry(g.store)), null);
  g.reopen();
  assert.ok(existsSync(integrityMarkPath(g.store, PROJECT)), "a clean entry left its mark");
  assert.equal(entry(g.store).since, g.store.lastEvent(), "the next entry checks from it");
  meanwhile(g, "UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ text: "forged" }), g.a.id);
  g.reopen();
  assert.equal(existsSync(integrityMarkPath(g.store, PROJECT)), false, "the old mark is erased");
  assert.equal(code(entry(g.store)), "store_damaged");
});

test("incremental om-fsck (map-2 №18514): the sign is taken under one lock no other writer passes; a lock that cannot be taken leaves no mark", t => {
  // While the mark's sign is taken, another connection cannot commit: the boundary is guarded, not merely narrowed.
  const f = fixture(t);
  assert.equal(code(entry(f.store)), null);
  let refused: string | null = null;
  f.store.sealOnClose({ inspect: () => true, abandoned: () => {}, sealed: () => {
    const other = new DatabaseSync(f.path);
    try { other.exec("PRAGMA busy_timeout=0"); other.exec("BEGIN IMMEDIATE"); other.exec("ROLLBACK"); refused = "none"; }
    catch (error) { refused = String((error as { code?: unknown }).code ?? error); }
    finally { other.close(); }
  } });
  f.reopen();
  assert.ok(refused !== null && refused !== "none", `another writer is shut out while the sign is taken (${refused})`);
  assert.ok(existsSync(integrityMarkPath(f.store, PROJECT)), "the guarded end left its mark");
  // Another connection holds a write transaction at the end: the lock cannot be taken, no mark is left, the old one erased.
  assert.equal(entry(f.store).since, f.store.lastEvent());
  const holder = new DatabaseSync(f.path);
  holder.exec("BEGIN IMMEDIATE");
  try { f.store.close(); } finally { holder.exec("ROLLBACK"); holder.close(); }
  assert.equal(existsSync(integrityMarkPath(f.store, PROJECT)), false, "an unguarded end erases the mark");
  f.reopen();
  assert.equal(entry(f.store).since, null, "the next entry checks in full");
});
