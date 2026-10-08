import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest } from "../src/canonical.js";
import { reference } from "../src/pipeline/contracts.js";
import { Store } from "../src/storage/store.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { integrityGate, integrityId, runIntegrityCheck, type IntegrityRecord } from "../src/om/integrity.js";
import { continuePass, startPass } from "../src/om/run-driver.js";

/**
 * NR1 (№3633, №3646): om-fsck, as in git. A change made to the database by anyone but the engine — another connection
 * writing raw SQL — is found by the whole check at its exact address: a body that is not the one its sha256 was written
 * for, a revision rewritten with its sha256 while another record still names the old hash, a revision or event gone, a
 * head moved. The check runs by itself at om-start and om-continue: damage found stops the pass with the addresses.
 */
const PROJECT = "garden";
const TRIGGERS = ["revisions_no_update", "revisions_no_delete", "events_no_update", "events_no_delete"];

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-fsck-"));
  const path = join(root, "store.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const [a] = store.writeMany([{ id: "note:garden:a", kind: "note", expected: 0, value: { text: "first" } }]);
  const [b] = store.writeMany([{ id: "note:garden:b", kind: "note", expected: 0, value: { names: [reference(a!)] } }]);
  const [a2] = store.writeMany([{ id: "note:garden:a", kind: "note", expected: 1, value: { text: "second" } }]);
  return {
    path, store, a: a!, b: b!, a2: a2!,
    /** A change as someone other than the engine makes it: another connection, raw SQL, the immutability triggers dropped. */
    foreign(sql: string, ...values: (string | number)[]) {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=OFF");
      for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.prepare(sql).run(...values);
      db.close();
    },
  };
}
const found = (store: Store) => checkStoreIntegrity(store).findings.map(finding => `${finding.code}:${finding.id}@${finding.revision}`).sort();
const refusedAs = (result: { ok: boolean; refusal?: { code: string; message: string; route?: string } } | null, code: string, includes?: string) => {
  assert.ok(result && !result.ok, `Expected ${code}`);
  assert.equal(result.refusal!.code, code);
  if (includes) assert.ok(result.refusal!.message.includes(includes), result.refusal!.message);
};

test("om-fsck: a database the engine wrote has no findings; the manual check saves its result", t => {
  const f = fixture(t);
  const report = checkStoreIntegrity(f.store);
  assert.deepEqual(report.findings, []);
  assert.deepEqual([report.revisions, report.events, report.references, report.lastSequence], [3, 3, 1, 3]);
  assert.equal(integrityGate(f.store, PROJECT), null);
  const saved = runIntegrityCheck(f.store, { project: PROJECT });
  assert.ok(saved.ok);
  assert.equal(saved.value.id, integrityId(PROJECT));
  assert.deepEqual(saved.value.value.findings, []);
});

test("om-fsck finds each change of another connection at its address", t => {
  const f = fixture(t);
  // A body changed in place without its sha256.
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ text: "forged" }), f.a.id);
  assert.deepEqual(found(f.store), [`revision_corrupt:${f.a.id}@1`]);
  // The same body rewritten with its sha256: the row agrees with itself, b still names the old hash.
  f.foreign("UPDATE revisions SET sha256=? WHERE entity_id=? AND revision=1", digest(canonical({ text: "forged" })), f.a.id);
  assert.deepEqual(found(f.store), [`reference_forged:${f.b.id}@1`]);
  // A revision gone: the line has a hole and b names a revision the store does not hold.
  f.foreign("DELETE FROM revisions WHERE entity_id=? AND revision=1", f.a.id);
  const gone = found(f.store);
  assert.ok(gone.includes(`revision_gap:${f.a.id}@2`), gone.join());
  assert.ok(gone.includes(`reference_missing:${f.b.id}@1`), gone.join());
});

test("om-fsck finds an event gone and a head moved back", t => {
  const f = fixture(t);
  f.foreign("DELETE FROM events WHERE entity_id=? AND revision=1", f.b.id);
  assert.deepEqual(found(f.store), [`event_missing:${f.b.id}@1`]);
  const g = fixture(t);
  g.foreign("UPDATE heads SET revision=1 WHERE entity_id=?", g.a.id);
  assert.equal(g.store.get(g.a.id)!.revision, 1, "The raw change does move what a read sees");
  assert.deepEqual(found(g.store), [`head_invalid:${g.a.id}@1`]);
});

test("om-fsck runs by itself at om-start and om-continue: damage stops the pass with its addresses, a repaired database starts", async t => {
  const f = fixture(t);
  const original = f.store.get(f.a.id, 1)!;
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ text: "forged" }), f.a.id);
  // Reads are trusted: nothing on the way of a read notices the damage — the check at the start does.
  assert.deepEqual(f.store.get(f.a.id, 1)!.value, { text: "forged" });
  refusedAs(await startPass(f.store, { project: PROJECT }), "store_damaged", `revision_corrupt ${f.a.id}@1`);
  refusedAs(await continuePass(f.store, { project: PROJECT }), "store_damaged", `revision_corrupt ${f.a.id}@1`);
  const gate = integrityGate(f.store, PROJECT)!;
  assert.equal(gate.ok, false);
  assert.equal(gate.refusal.route, "owner");
  const saved = f.store.get<IntegrityRecord>(integrityId(PROJECT))!;
  assert.deepEqual(saved.value.findings.map(finding => finding.code), ["revision_corrupt"]);
  // The check repairs nothing; the owner does (here: the original body back), and the next start passes the check.
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical(original.value), f.a.id);
  assert.equal(integrityGate(f.store, PROJECT), null);
  const started = await startPass(f.store, { project: PROJECT });
  assert.notEqual(started.ok ? "started" : started.refusal.code, "store_damaged");
});

test("om-fsck reads one committed snapshot: a lawful write of another connection between its reads is no damage (№3674 п.1)", t => {
  const f = fixture(t);
  const prepare = DatabaseSync.prototype.prepare;
  let injected = false;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    if (!injected && sql.startsWith("SELECT entity_id, revision FROM heads")) {
      injected = true;
      const other = new Store(f.path);
      try { other.writeMany([{ id: "note:garden:concurrent", kind: "note", expected: 0, value: { text: "written meanwhile" } },
        { id: f.a.id, kind: "note", expected: 2, value: { text: "third" } }]); } finally { other.close(); }
    }
    return prepare.call(this, sql);
  } as typeof DatabaseSync.prototype.prepare;
  let report;
  try { report = checkStoreIntegrity(f.store); } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.ok(injected, "The other connection wrote between the reads of the check");
  assert.deepEqual(report.findings, []);
  assert.deepEqual([report.revisions, report.lastSequence], [3, 3], "The check saw the snapshot it began with");
  const after = checkStoreIntegrity(f.store);
  assert.deepEqual([after.findings, after.revisions], [[], 5], "The next check sees the write whole");
  assert.equal(integrityGate(f.store, PROJECT), null);
});
