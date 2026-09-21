import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import {
  classifyRefusal, journalId, readJournal, recordRefusal, unitRefusalNamespace,
  REFUSAL_JOURNAL_CODES, REFUSAL_JOURNAL_KIND, UNIT_REFUSAL_KIND,
  type ClassifyRefusalRequest, type JournalRequest, type JournalRow, type RecordRefusalRequest, type RefusalClassification, type RefusalJournal,
} from "../src/om/refusal-journal.js";

const UNIT = "store-refusals";
const PROJECT = "alpha";
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-om-journal-"));
  const path = join(root, "live.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store };
}

function refusalOf<T>(result: OmResult<T>): Refusal {
  if (result.ok) assert.fail("expected a refusal, got a delivered value");
  return result.refusal;
}

function deliveredOf<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`unexpected refusal ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(deeplyFrozen);
}

function addressed(refusal: Refusal, expected: string, project = PROJECT, target = journalId(project)): Refusal {
  assert.equal(refusal.code, expected);
  assert.equal(refusal.at.unit, UNIT);
  assert.equal(refusal.at.target, target);
  assert.ok(refusal.message.length > 0);
  assert.ok(REFUSAL_ROUTES.includes(refusal.route));
  return refusal;
}

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
const refTo = (id: string, revision = 1, seed = "a"): Ref => ({ id, revision, hash: hex(seed) });

const PROPOSAL = refTo("layer-proposal:alpha:7", 2, "b");
const BASE = refTo("graph:alpha", 3, "c");

const origin = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "artifact_missing",
  stage: "candidate-assembly",
  subject: "artifact:cart",
  sources: [{ role: "proposal", ref: PROPOSAL }, { role: "base", ref: BASE }],
  ...over,
});

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  code: "graph_invalid",
  goal: "every artifact an operation consumes is produced somewhere in the layer",
  remedy: "add the producer of artifact:cart to the proposal, or drop the operation consuming it",
  origin: origin(),
  ...over,
});

const gateFailure = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ gate: "G3", refusals: [entry()], ...over });

// What G7 derived for a row. The journal keeps these words without ruling on them, so the test uses G7's own.
const verdict = (over: Record<string, unknown> = {}): RefusalClassification => ({
  row: "om-refusal:unset",
  class: "input",
  addressee: "stage:alpha:specification",
  basis: [{ role: "proposal", ref: PROPOSAL }, { role: "base", ref: BASE }],
  ...over,
} as RefusalClassification);

// An absent field is an absent KEY: undefined is not a JSON value, so a record can only omit what it does not carry.
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

function gateRecord(store: Store, name: string, value: unknown, project = PROJECT): Revision<Json> {
  return store.write({ id: `${unitRefusalNamespace(project)}${name}`, kind: UNIT_REFUSAL_KIND, expected: 0, value });
}

// A journal that genuinely holds one refusal of its OWN project, so a test can forge exactly one thing about it and
// nothing else stands in the way of the check it is aimed at.
function planted(store: Store, project: string): { source: Revision<Json>; row: JournalRow } {
  const source = gateRecord(store, "g3:1", gateFailure(), project);
  return { source, row: deliveredOf(recordRefusal(store, { project, source: reference(source) })).value.rows[0]! };
}

// Content changed and the id recomputed from it — a row made to agree with itself, the way a forger would.
const reHashed = (row: Record<string, unknown>): Record<string, unknown> => {
  const body = without(row, "id");
  return { id: hashJson(body), ...body };
};

const journalOf = (store: Store, project = PROJECT): Revision<RefusalJournal> | null => store.get<RefusalJournal>(journalId(project));

test("a gate refusal reaches the journal with its gate, code, goal, remedy and origin", t => {
  const { store } = fixture(t);
  const record = gateRecord(store, "g3:1", gateFailure({
    refusals: [entry(), entry({ code: "layer_port_unbound", origin: origin({ subject: "port:cart:in", stage: "layer-assembly" }) })],
  }));

  const journal = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(record) }));
  assert.equal(journal.id, journalId(PROJECT));
  assert.equal(journal.kind, REFUSAL_JOURNAL_KIND);
  assert.equal(journal.revision, 1);
  assert.equal(journal.value.projectId, PROJECT);
  assert.equal(journal.value.rows.length, 2);
  // A journal nobody has classified yet says so explicitly.
  assert.deepEqual(journal.value.classifications, []);

  const first = journal.value.rows[0]!;
  assert.equal(first.gate, "G3");
  assert.equal(first.code, "graph_invalid");
  assert.ok(first.goal.length > 0);
  assert.ok(first.remedy.length > 0);
  assert.equal(first.origin.name, "artifact_missing");
  assert.equal(first.origin.stage, "candidate-assembly");
  assert.equal(first.origin.subject, "artifact:cart");
  assert.deepEqual(first.origin.sources.map(source => source.role), ["base", "proposal"]);
  assert.deepEqual(first.origin.sources.map(source => source.ref), [BASE, PROPOSAL]);
  assert.deepEqual(first.source, reference(record));
  assert.equal(journal.value.rows[1]!.code, "layer_port_unbound");
  assert.notEqual(first.id, journal.value.rows[1]!.id);

  // What was handed out is what was written: the copy hashes as the stored record does.
  const stored = journalOf(store)!;
  assert.equal(hashJson(journal.value), stored.hash);
  assert.ok(deeplyFrozen(journal));
  assert.equal(store.history(journalId(PROJECT)).length, 1);

  const read = deliveredOf(readJournal(store, { project: PROJECT }));
  assert.deepEqual(read.value, journal.value);
  assert.notEqual(read.value, journal.value);
});

test("every refusal code of this unit is produced, addressed and routed", t => {
  const { store } = fixture(t);
  const seen: string[] = [];
  const record = (refusal: Refusal, expected: string, project = PROJECT): void => { seen.push(addressed(refusal, expected, project).code); };
  const failOn = (project: string, value: unknown): Refusal => {
    const source = gateRecord(store, "g3:1", value, project);
    return refusalOf(recordRefusal(store, { project, source: reference(source) }));
  };

  record(failOn("p1", "a refusal"), "refusal_record_invalid", "p1");
  record(failOn("p2", gateFailure({ refusals: [] })), "refusals_missing", "p2");
  record(failOn("p3", gateFailure({ refusals: [without(entry(), "goal")] })), "refusal_entry_invalid", "p3");
  record(failOn("p4", gateFailure({ refusals: [entry({ origin: origin({ stage: "" }) })] })), "origin_invalid", "p4");
  record(failOn("p5", gateFailure({ refusals: [entry({ origin: origin({ sources: [{ role: "proposal", ref: { id: PROPOSAL.id, revision: 2 } }] }) })] })), "origin_source_invalid", "p5");

  store.write({ id: journalId("p6"), kind: REFUSAL_JOURNAL_KIND, expected: 0, value: { projectId: "p6", rows: ["a row"], classifications: [] } });
  record(failOn("p6", gateFailure()), "journal_invalid", "p6");
  store.write({ id: journalId("p7"), kind: REFUSAL_JOURNAL_KIND, expected: 0, value: { projectId: "elsewhere", rows: [], classifications: [] } });
  record(failOn("p7", gateFailure()), "journal_foreign", "p7");
  record(refusalOf(readJournal(store, { project: "p8" })), "journal_missing", "p8");

  const classified = gateRecord(store, "g3:1", gateFailure(), "p9");
  const row = deliveredOf(recordRefusal(store, { project: "p9", source: reference(classified) })).value.rows[0]!.id;
  record(refusalOf(classifyRefusal(store, { project: "p9", ...verdict({ row: "om-refusal:invented" }) })), "row_unknown", "p9");
  deliveredOf(classifyRefusal(store, { project: "p9", ...verdict({ row }) }));
  record(refusalOf(classifyRefusal(store, { project: "p9", ...verdict({ row, class: "derivation" }) })), "classification_conflict", "p9");

  assert.deepEqual([...new Set(seen)].sort(), [...REFUSAL_JOURNAL_CODES].sort());
  for (const project of ["p1", "p2", "p3", "p4", "p5", "p8"]) assert.equal(journalOf(store, project), null);
});

test("an absent field, source or set is a typed refusal that names the address, while an explicit emptiness is not (T4)", t => {
  const { store } = fixture(t);
  let counter = 0;
  const field = (value: unknown, expected: string): string | undefined => {
    counter += 1;
    const source = gateRecord(store, `g3:${counter}`, value);
    return addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: reference(source) })), expected).at.field;
  };

  assert.equal(field({ refusals: [entry()] }, "refusal_record_invalid"), "value");
  assert.equal(field({ gate: "", refusals: [entry()] }, "refusal_record_invalid"), "gate");
  assert.equal(field({ gate: "G3" }, "refusal_record_invalid"), "value");
  assert.equal(field(gateFailure({ refusals: null }), "refusal_record_invalid"), "refusals");
  assert.equal(field(gateFailure({ refusals: [] }), "refusals_missing"), "refusals");
  assert.equal(field(gateFailure({ refusals: [without(entry(), "code")] }), "refusal_entry_invalid"), "refusals.0");
  assert.equal(field(gateFailure({ refusals: [entry({ code: null })] }), "refusal_entry_invalid"), "refusals.0.code");
  assert.equal(field(gateFailure({ refusals: [entry(), entry({ remedy: null })] }), "refusal_entry_invalid"), "refusals.1.remedy");
  assert.equal(field(gateFailure({ refusals: [without(entry(), "origin")] }), "refusal_entry_invalid"), "refusals.0");
  assert.equal(field(gateFailure({ refusals: [entry({ origin: without(origin(), "name") })] }), "origin_invalid"), "refusals.0.origin");
  assert.equal(field(gateFailure({ refusals: [entry({ origin: origin({ subject: 7 }) })] }), "origin_invalid"), "refusals.0.origin.subject");
  // An absent set of sources is not an empty one and is never read as "no source was needed".
  assert.equal(field(gateFailure({ refusals: [entry({ origin: without(origin(), "sources") })] }), "origin_invalid"), "refusals.0.origin");
  assert.equal(field(gateFailure({ refusals: [entry({ origin: origin({ sources: null }) })] }), "origin_invalid"), "refusals.0.origin.sources");
  assert.equal(field(gateFailure({ refusals: [entry({ origin: origin({ sources: {} }) })] }), "origin_invalid"), "refusals.0.origin.sources");
  assert.equal(field(gateFailure({ refusals: [entry({ origin: origin({ sources: [{ ref: PROPOSAL }] }) })] }), "origin_source_invalid"), "refusals.0.origin.sources.0");
  assert.equal(field(gateFailure({ refusals: [entry({ origin: origin({ sources: [{ role: "", ref: PROPOSAL }] }) })] }), "origin_source_invalid"), "refusals.0.origin.sources.0.role");
  assert.equal(field(gateFailure({ refusals: [entry({ origin: origin({ sources: [{ role: "proposal", ref: { ...PROPOSAL, hash: "short" } }] }) })] }), "origin_source_invalid"), "refusals.0.origin.sources.0.ref");
  assert.equal(journalOf(store), null);

  // An origin whose sources are explicitly empty says "not established" and is kept for G7 to stop on.
  const open = gateRecord(store, "g7:open", gateFailure({ gate: "G7", refusals: [entry({ origin: origin({ sources: [] }) })] }));
  const journal = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(open) }));
  assert.deepEqual(journal.value.rows[0]!.origin.sources, []);
  assert.equal(journal.value.rows.length, 1);
});

test("a forged input is refused: foreign project, foreign kind, substituted hash, declared verdict", t => {
  const { store } = fixture(t);
  const body = gateFailure();
  const mine = gateRecord(store, "g3:1", body);
  const twin = gateRecord(store, "g3:1", body, "beta");
  const disguised = store.write({ id: `${unitRefusalNamespace(PROJECT)}g3:2`, kind: "gate-pass", expected: 0, value: body });
  // Identical content hashes alike, so neither the hash nor the body's own words are an identity.
  assert.equal(twin.hash, mine.hash);
  assert.equal(disguised.hash, mine.hash);

  const refuse = (source: unknown, expected: string): Refusal =>
    addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: source as Ref })), expected);

  assert.equal(refuse(reference(twin), "record_foreign").at.field, "id");
  assert.equal(refuse(reference(disguised), "record_foreign").at.field, "kind");
  assert.equal(refuse({ ...reference(mine), hash: hex("d") }, "record_forged").at.field, "hash");
  assert.equal(refuse({ id: `${unitRefusalNamespace(PROJECT)}absent`, revision: 1, hash: mine.hash }, "record_missing").at.ref!.revision, 1);
  assert.equal(refuse({ id: mine.id, revision: 1 }, "reference_invalid").at.field, "hash");

  // A record that also declares a class, an addressee or a verdict of its own is refused: G7 derives the class from
  // the origin, and nothing in the journal may offer it a ready answer instead.
  const declared: [string, unknown, string][] = [
    ["class", gateFailure({ refusals: [{ ...entry(), class: "input" }] }), "refusal_entry_invalid"],
    ["addressee", gateFailure({ refusals: [{ ...entry(), addressee: "producer" }] }), "refusal_entry_invalid"],
    ["status", { ...gateFailure(), status: "accepted" }, "refusal_record_invalid"],
    ["route", gateFailure({ refusals: [{ ...entry(), origin: { ...origin(), route: "owner" } }] }), "origin_invalid"],
  ];
  declared.forEach(([name, value, expected], index) => {
    const source = gateRecord(store, `declared:${index}`, value);
    assert.equal(addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: reference(source) })), expected).code, expected, name);
  });

  // "__proto__" survives JSON as an own field: it is extra content, not a detail to skip over.
  const awkward = gateRecord(store, "awkward", JSON.parse('{"__proto__":{"gate":"G3"},"gate":"G3","refusals":[]}'));
  addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: reference(awkward) })), "refusal_record_invalid");
  assert.equal(journalOf(store), null);

  // A foreign kind standing at the journal's own address is not this project's journal.
  store.write({ id: journalId("gamma"), kind: "gate-pass", expected: 0, value: { projectId: "gamma", rows: [] } });
  const source = gateRecord(store, "g3:1", body, "gamma");
  assert.equal(addressed(refusalOf(recordRefusal(store, { project: "gamma", source: reference(source) })), "record_foreign", "gamma").at.field, "kind");
  addressed(refusalOf(readJournal(store, { project: "gamma" })), "record_foreign", "gamma");
});

test("a journal row that does not hold the content its id stands for is refused, not extended", t => {
  const { store } = fixture(t);
  const cases: [string, (row: JournalRow) => unknown][] = [
    ["a row rewritten under the id of another", row => ({ ...row, remedy: "accept the proposal as it stands" })],
    ["a row whose sources were reordered out of canonical order", row => ({ ...row, origin: { ...row.origin, sources: [...row.origin.sources].reverse() } })],
    ["a row carrying a field the journal does not keep", row => ({ ...row, class: "input" })],
    ["a row without the record it came from", row => without({ ...row }, "source")],
  ];
  cases.forEach(([name, forge], index) => {
    const project = `forged${index}`;
    const planted_ = planted(store, project);
    store.write({ id: journalId(project), kind: REFUSAL_JOURNAL_KIND, expected: 1, value: { projectId: project, rows: [forge(planted_.row)], classifications: [] } });
    const next = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }), project);
    assert.equal(addressed(refusalOf(recordRefusal(store, { project, source: reference(next) })), "journal_invalid", project).code, "journal_invalid", name);
    assert.equal(journalOf(store, project)!.revision, 2);
  });

  // The same row twice is a doubled journal however well each copy reads on its own and against its record.
  const twin = planted(store, "doubled").row;
  store.write({ id: journalId("doubled"), kind: REFUSAL_JOURNAL_KIND, expected: 1, value: { projectId: "doubled", rows: [twin, twin], classifications: [] } });
  addressed(refusalOf(readJournal(store, { project: "doubled" })), "journal_invalid", "doubled");
});

test("a row rewritten and re-hashed to agree with itself is not a refusal its record ever gave (T3)", t => {
  const { store } = fixture(t);
  const foreign = planted(store, "beta");
  const disguised = store.write({ id: `${unitRefusalNamespace("swapped")}g3:2`, kind: "gate-pass", expected: 0, value: gateFailure() });

  const cases: [string, (row: JournalRow, project: string) => unknown][] = [
    // The reviewer's scenario: another gate, another code, another remedy, and an id recomputed so the row agrees
    // with itself. Nothing but the record it names can tell the difference.
    ["another gate and another refusal under a freshly computed id", row =>
      reHashed({ ...row, gate: "G5", code: "work_not_atomic", remedy: "split the work so it owns one artifact" })],
    ["a goal and a remedy nobody gave", row => reHashed({ ...row, goal: "no artifact is ever missing", remedy: "accept the proposal as it stands" })],
    ["an origin pointing at another stage", row => reHashed({ ...row, origin: { ...row.origin, stage: "feasibility", subject: "workspace" } })],
    ["a record that is not in the store", (row, project) =>
      reHashed({ ...row, source: { id: `${unitRefusalNamespace(project)}absent`, revision: 1, hash: row.source.hash } })],
    // A row that is a faithful copy of another project's row: only the namespace its record lives in tells them apart.
    ["a row taken whole from another project's record", () => foreign.row],
    ["a record of another kind inside this project", row => reHashed({ ...row, source: reference(disguised) })],
    ["a record at a hash it does not hold", row => reHashed({ ...row, source: { ...row.source, hash: hex("d") } })],
    ["a record at a revision it never reached", row => reHashed({ ...row, source: { ...row.source, revision: 9 } })],
  ];

  cases.forEach(([name, forge], index) => {
    const project = `swap${index}`;
    const { row } = planted(store, project);
    const classified = deliveredOf(classifyRefusal(store, { project, ...verdict({ row: row.id }) }));
    const swapped = forge(row, project) as JournalRow;
    store.write({
      id: journalId(project), kind: REFUSAL_JOURNAL_KIND, expected: classified.revision,
      value: {
        projectId: project, rows: [swapped],
        classifications: [{ ...classified.value.classifications[0]!, row: swapped.id }],
      },
    });

    // All three paths refuse it: reading, journalling another refusal, and classifying.
    assert.equal(addressed(refusalOf(readJournal(store, { project })), "journal_invalid", project).code, "journal_invalid", name);
    const next = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }), project);
    addressed(refusalOf(recordRefusal(store, { project, source: reference(next) })), "journal_invalid", project);
    addressed(refusalOf(classifyRefusal(store, { project, ...verdict({ row: swapped.id }) })), "journal_invalid", project);
    assert.equal(journalOf(store, project)!.revision, classified.revision + 1);
  });
});

test("a refusal journalled earlier still reads and classifies after its own record has moved on", t => {
  const { store } = fixture(t);
  const source = gateRecord(store, "g3:1", gateFailure());
  const journal = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) }));
  const row = journal.value.rows[0]!;

  // The gate rewrites its record. The row was derived from the revision it names, and that revision still stands.
  store.write({ id: source.id, kind: UNIT_REFUSAL_KIND, expected: 1, value: gateFailure({ gate: "G5", refusals: [entry({ code: "work_not_atomic" })] }) });
  const read = deliveredOf(readJournal(store, { project: PROJECT }));
  assert.deepEqual(read.value.rows, journal.value.rows);
  assert.equal(read.value.rows[0]!.gate, "G3");

  const classified = deliveredOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row: row.id }) }));
  assert.equal(classified.value.classifications[0]!.row, row.id);

  // And the newer refusal is journalled beside the older one.
  const current = store.get(source.id)!;
  const grown = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(current) }));
  assert.deepEqual(grown.value.rows.map(item => item.gate), ["G3", "G5"]);
  assert.deepEqual(grown.value.rows.map(item => item.source.revision), [1, 2]);

  // Both rows read back: each is derived again from the revision it names, not from the record's current head.
  const both = deliveredOf(readJournal(store, { project: PROJECT }));
  assert.deepEqual(both.value.rows, grown.value.rows);
  assert.deepEqual(both.value.rows.map(item => item.code), ["graph_invalid", "work_not_atomic"]);
});

test("a guarded record that changes between the check and the write is refused, not written over (T7)", t => {
  const { store, path } = fixture(t);
  const source = gateRecord(store, "g3:1", gateFailure());
  const stale = reference(source);

  const other = new Store(path);
  try { other.write({ id: source.id, kind: UNIT_REFUSAL_KIND, expected: 1, value: gateFailure({ gate: "G5" }) }); } finally { other.close(); }

  // The exact revision the reference names still exists and still reads, but its record has moved on. The refusal
  // is addressed to the record that went stale, not to the journal it was about to be appended to.
  const refusal = addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: stale })), "input_stale", PROJECT, source.id);
  assert.deepEqual(refusal.at.ref, stale);
  assert.equal(journalOf(store), null);
  assert.equal(store.history(source.id).length, 2);

  const current = store.get(source.id)!;
  const journal = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(current) }));
  assert.equal(journal.value.rows[0]!.gate, "G5");
});

// A second writer commits between this unit's read of the journal and its own write. The store is synchronous, so the
// only way to stand in that window is to write from another connection while the read is being answered.
class RacingStore extends Store {
  armed = false;
  target = "";
  run: ((store: Store) => void) | null = null;
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    const found = super.get<T>(id, revision);
    if (this.armed && id === this.target && this.run) {
      this.armed = false;
      const other = new Store(this.path);
      try { this.run(other); } finally { other.close(); }
    }
    return found;
  }
}

test("a journal appended by someone else between the read and the write is refused, and no row is lost (T7)", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-journal-race-"));
  const path = join(root, "live.sqlite");
  const store = new RacingStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.target = journalId(PROJECT);

  const first = gateRecord(store, "g3:1", gateFailure());
  const second = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));

  // The journal does not exist yet: the competitor creates it while this call believes there is nothing to append to.
  store.armed = true;
  store.run = other => { deliveredOf(recordRefusal(other, { project: PROJECT, source: reference(first) })); };
  addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: reference(second) })), "revision_conflict");
  const created = journalOf(store)!;
  assert.equal(created.revision, 1);
  assert.deepEqual(created.value.rows.map(row => row.gate), ["G3"]);

  // The journal exists: the competitor appends to it while this call holds the previous head.
  const third = gateRecord(store, "g4:1", gateFailure({ gate: "G4" }));
  store.armed = true;
  store.run = other => { deliveredOf(recordRefusal(other, { project: PROJECT, source: reference(second) })); };
  const refusal = addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: reference(third) })), "input_stale");
  assert.deepEqual(refusal.at.ref, reference(created));
  const after = journalOf(store)!;
  assert.equal(after.revision, 2);
  assert.deepEqual(after.value.rows.map(row => row.gate), ["G3", "G5"]);

  // Nothing was lost: the refused refusal is journalled once the current head is read again.
  store.armed = false;
  const journal = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(third) }));
  assert.deepEqual(journal.value.rows.map(row => row.gate), ["G3", "G5", "G4"]);
});

test("journalling a refusal switches nothing: readiness, the graph, gaps, attempts and the queue stay as they were (T8)", t => {
  const { store } = fixture(t);
  const untouched = [
    store.write({ id: "om-readiness:alpha", kind: "om-readiness", expected: 0, value: { ready: false, basis: null } }),
    store.write({ id: "graph:alpha", kind: "graph", expected: 0, value: { horizon: ["block:cart"] } }),
    store.write({ id: "om-gaps:alpha", kind: "om-gaps", expected: 0, value: { open: ["gap:1"] } }),
    store.write({ id: "om-attempts:alpha", kind: "om-attempts", expected: 0, value: { withoutProgress: 2 } }),
    store.write({ id: "om-queue:alpha", kind: "om-queue", expected: 0, value: { order: ["block:cart"], weights: { "block:cart": 3 } } }),
  ];
  const source = gateRecord(store, "g6:1", gateFailure({ gate: "G6", refusals: [entry({ code: "repository_dirty", origin: origin({ stage: "feasibility", subject: "workspace" }) })] }));
  const before = store.list().length;

  const row = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) })).value.rows[0]!.id;
  deliveredOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row, class: "conditions", addressee: "owner" }) }));

  for (const record of untouched) {
    const now = store.get(record.id)!;
    assert.equal(now.revision, 1, record.id);
    assert.equal(now.hash, record.hash, record.id);
    assert.equal(store.history(record.id).length, 1, record.id);
  }
  // One record was written and it is the journal itself, holding both the row and what G7 made of it.
  assert.equal(store.list().length, before + 1);
  assert.deepEqual(journalOf(store)!.value.classifications.map(item => item.addressee), ["owner"]);
  assert.deepEqual(store.list(REFUSAL_JOURNAL_KIND).map(record => record.id), [journalId(PROJECT)]);
  assert.equal(store.history(source.id).length, 1);
});

test("the same refusal recorded again adds no row and no revision, while a second event keeps its own row", t => {
  const { store } = fixture(t);
  const source = gateRecord(store, "g3:1", gateFailure());
  const first = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) }));
  const again = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) }));
  assert.equal(again.revision, 1);
  assert.deepEqual(again.value, first.value);
  assert.equal(store.history(journalId(PROJECT)).length, 1);

  // One record naming the same refusal twice, and naming it with its sources in the other order, is one row.
  const repeated = gateRecord(store, "g3:2", gateFailure({
    gate: "G4",
    refusals: [entry(), entry(), entry({ origin: origin({ sources: [{ role: "base", ref: BASE }, { role: "proposal", ref: PROPOSAL }] }) })],
  }));
  const grown = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(repeated) }));
  assert.equal(grown.revision, 2);
  assert.equal(grown.value.rows.length, 2);

  // Two different records carrying the same refusal are two events: a repetition across attempts still reaches G7.
  const twin = gateRecord(store, "g3:3", gateFailure());
  const both = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(twin) }));
  assert.equal(both.value.rows.length, 3);
  assert.deepEqual(both.value.rows.map(row => row.code), ["graph_invalid", "graph_invalid", "graph_invalid"]);
  assert.deepEqual([...new Set(both.value.rows.map(row => row.id))].length, 3);
  assert.deepEqual(both.value.rows.map(row => row.source.id), [source.id, repeated.id, twin.id]);
});

test("every exported function refuses a missing, null or mistyped argument as a typed defect, never a TypeError", t => {
  const { store } = fixture(t);
  const source = reference(gateRecord(store, "g3:1", gateFailure()));
  // No default argument stands in for a broken one: a helper that quietly substitutes the real store would test itself.
  const write = (request: unknown, journal: unknown): void => { recordRefusal(journal as Store, request as RecordRefusalRequest); };
  const read = (request: unknown, journal: unknown): void => { readJournal(journal as Store, request as JournalRequest); };

  for (const request of [null, undefined, "request", 7, [{ project: PROJECT, source }]]) {
    assert.throws(() => write(request, store), code("journal_request_invalid"));
    assert.throws(() => read(request, store), code("journal_request_invalid"));
  }
  for (const project of [undefined, null, "", 7, {}, "alpha:beta", ":", "a".repeat(200)]) {
    assert.throws(() => write({ project, source }, store), code("journal_request_invalid"));
    assert.throws(() => read({ project }, store), code("journal_request_invalid"));
    assert.throws(() => journalId(project as string), code("journal_request_invalid"));
    assert.throws(() => unitRefusalNamespace(project as string), code("journal_request_invalid"));
  }
  for (const broken of [null, undefined, "store", 7, {}, { get: () => null, writeMany: () => [] }]) {
    assert.throws(() => write({ project: PROJECT, source }, broken), code("journal_request_invalid"));
    assert.throws(() => read({ project: PROJECT }, broken), code("journal_request_invalid"));
  }
  // A reference is data, not a defect of the calling code: it comes back as an addressed refusal.
  for (const broken of [undefined, null, "reference", 7, {}, { id: source.id, revision: 1 }, { ...source, revision: 0 }]) {
    addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: broken as Ref })), "reference_invalid");
  }
  assert.equal(journalOf(store), null);
});

test("the journal handed to a consumer is a deep frozen copy, independent of the store and of the policy tables (T11)", t => {
  const { store } = fixture(t);
  const source = gateRecord(store, "g3:1", gateFailure());
  const first = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) }));
  const again = deliveredOf(readJournal(store, { project: PROJECT }));
  assert.notEqual(first.value, again.value);
  assert.deepEqual(first.value, again.value);
  assert.equal(hashJson(again.value), store.get(journalId(PROJECT))!.hash);
  assert.ok(deeplyFrozen(again));
  assert.throws(() => {
    // @ts-expect-error a delivered journal is readonly at compile time, not only frozen at run time
    again.value.rows[0]!.origin.subject = "artifact:other";
  }, TypeError);
  assert.throws(() => { (again.value.rows as unknown as unknown[]).push({}); }, TypeError);
  assert.equal(store.get<RefusalJournal>(journalId(PROJECT))!.value.rows[0]!.origin.subject, "artifact:cart");

  assert.ok(Object.isFrozen(REFUSAL_JOURNAL_CODES));
  assert.throws(() => { (REFUSAL_JOURNAL_CODES as unknown as string[]).push("invented"); }, TypeError);
  assert.throws(() => {
    // @ts-expect-error a policy table does not change while the module works, at compile time as well
    REFUSAL_JOURNAL_CODES[0] = "invented";
  }, TypeError);
});

test("G7 writes the class and the addressee beside the row, and the same decision twice changes nothing (T5)", t => {
  const { store } = fixture(t);
  const source = gateRecord(store, "g3:1", gateFailure());
  const recorded = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) }));
  const row = recorded.value.rows[0]!;

  const journal = deliveredOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row: row.id }) }));
  assert.equal(journal.revision, 2);
  assert.equal(journal.value.classifications.length, 1);
  const decision = journal.value.classifications[0]!;
  assert.equal(decision.row, row.id);
  assert.equal(decision.class, "input");
  assert.equal(decision.addressee, "stage:alpha:specification");
  assert.deepEqual(decision.basis.map(ground => ground.role), ["base", "proposal"]);
  // The row keeps the identity its id stands for: a classification stands beside what the gate reported, not in it.
  assert.deepEqual(journal.value.rows, recorded.value.rows);
  assert.equal(hashJson(journal.value), journalOf(store)!.hash);
  assert.ok(deeplyFrozen(journal));

  // The same decision again, and with its grounds in the other order, is the same decision.
  const again = deliveredOf(classifyRefusal(store, {
    project: PROJECT, ...verdict({ row: row.id, basis: [{ role: "base", ref: BASE }, { role: "proposal", ref: PROPOSAL }] }),
  }));
  assert.equal(again.revision, 2);
  assert.deepEqual(again.value, journal.value);
  assert.equal(store.history(journalId(PROJECT)).length, 2);

  // A later reading does not undo the earlier decision, whichever part of it differs.
  for (const over of [{ class: "derivation" }, { addressee: "model" }, { basis: [] }]) {
    addressed(refusalOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row: row.id, ...over }) })), "classification_conflict");
  }
  addressed(refusalOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row: "om-refusal:invented" }) })), "row_unknown");

  // A row of another project's journal is not a row of this one, and a project with no journal has nothing to classify.
  const foreign = gateRecord(store, "g3:1", gateFailure({ gate: "G5" }), "beta");
  const elsewhere = deliveredOf(recordRefusal(store, { project: "beta", source: reference(foreign) })).value.rows[0]!.id;
  addressed(refusalOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row: elsewhere }) })), "row_unknown");
  addressed(refusalOf(classifyRefusal(store, { project: "gamma", ...verdict({ row: row.id }) })), "journal_missing", "gamma");
  assert.equal(store.history(journalId(PROJECT)).length, 2);

  const read = deliveredOf(readJournal(store, { project: PROJECT }));
  assert.deepEqual(read.value.classifications, journal.value.classifications);
  assert.deepEqual(read.value.rows, journal.value.rows);

  // A later refusal is journalled without disturbing what G7 already decided about an earlier one.
  const next = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));
  const grown = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(next) }));
  assert.deepEqual(grown.value.rows.map(item => item.gate), ["G3", "G5"]);
  assert.deepEqual(grown.value.classifications, journal.value.classifications);
});

test("classifying refuses a missing, null or mistyped argument as a typed defect, never a TypeError", t => {
  const { store } = fixture(t);
  const source = gateRecord(store, "g3:1", gateFailure());
  const row = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) })).value.rows[0]!.id;
  const classify = (request: unknown, journal: unknown): void => { classifyRefusal(journal as Store, request as ClassifyRefusalRequest); };
  const good = { project: PROJECT, ...verdict({ row }) };

  for (const request of [null, undefined, "request", 7, [good]]) assert.throws(() => classify(request, store), code("journal_request_invalid"));
  for (const broken of [null, undefined, "store", 7, {}]) assert.throws(() => classify(good, broken), code("journal_request_invalid"));
  for (const field of ["project", "row", "class", "addressee"] as const) {
    for (const broken of [undefined, null, "", 7, {}]) {
      assert.throws(() => classify({ ...good, [field]: broken }, store), code("journal_request_invalid"));
    }
  }
  // An absent set of grounds is not an empty one, and a ground is a role with an exact reference or nothing.
  for (const broken of [undefined, null, "basis", 7, {}]) assert.throws(() => classify({ ...good, basis: broken }, store), code("journal_request_invalid"));
  for (const broken of [null, undefined, "ground", 7, {}, { role: "proposal" }, { ref: PROPOSAL }, { role: "", ref: PROPOSAL },
    { role: "proposal", ref: { id: PROPOSAL.id, revision: 1 } }, { role: "proposal", ref: { ...PROPOSAL, hash: "short" } },
    { role: "proposal", ref: PROPOSAL, note: "agreed" }]) {
    assert.throws(() => classify({ ...good, basis: [broken] }, store), code("journal_request_invalid"));
  }
  assert.deepEqual(journalOf(store)!.value.classifications, []);

  // Grounds that are explicitly empty are the origin G7 could not establish, and the journal keeps them as said.
  const journal = deliveredOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row, class: "unknown", addressee: "owner", basis: [] }) }));
  assert.deepEqual(journal.value.classifications[0]!.basis, []);
  assert.equal(hashJson(journal.value), journalOf(store)!.hash);
});

test("a stored classification that stands for nothing, doubles a decision or is not held as written is refused", t => {
  const { store } = fixture(t);
  const cases: [string, (row: JournalRow, good: RefusalClassification) => Record<string, unknown>][] = [
    ["a journal of the earlier shape, carrying no set of classifications at all", row => ({ rows: [row] })],
    ["a classification of a refusal this journal does not hold", (row, good) => ({ rows: [row], classifications: [{ ...good, row: "om-refusal:invented" }] })],
    ["two decisions for one refusal", (row, good) => ({ rows: [row], classifications: [good, { ...good, class: "derivation" }] })],
    ["a classification carrying a field the journal does not keep", (row, good) => ({ rows: [row], classifications: [{ ...good, note: "agreed" }] })],
    ["grounds left out of the canonical order", (row, good) => ({ rows: [row], classifications: [{ ...good, basis: [...good.basis].reverse() }] })],
    ["a ground that is not an exact reference", (row, good) => ({ rows: [row], classifications: [{ ...good, basis: [{ role: "proposal", ref: { id: PROPOSAL.id, revision: 1 } }] }] })],
    ["a classification without its addressee", (row, good) => ({ rows: [row], classifications: [without({ ...good }, "addressee")] })],
    ["a set of classifications that is not a set", (row, good) => ({ rows: [row], classifications: { [row.id]: good } })],
  ];
  cases.forEach(([name, build], index) => {
    const project = `stored${index}`;
    const { row } = planted(store, project);
    const classified = deliveredOf(classifyRefusal(store, { project, ...verdict({ row: row.id }) }));
    store.write({
      id: journalId(project), kind: REFUSAL_JOURNAL_KIND, expected: classified.revision,
      value: { projectId: project, ...build(row, classified.value.classifications[0]!) },
    });
    assert.equal(addressed(refusalOf(readJournal(store, { project })), "journal_invalid", project).code, "journal_invalid", name);
    // A journal that cannot be read cannot be added to or decided upon either.
    const next = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }), project);
    addressed(refusalOf(recordRefusal(store, { project, source: reference(next) })), "journal_invalid", project);
    addressed(refusalOf(classifyRefusal(store, { project, ...verdict({ row: row.id }) })), "journal_invalid", project);
    assert.equal(journalOf(store, project)!.revision, classified.revision + 1);
  });
});

test("a journal written to by someone else between the read and the classification is refused, and nothing is lost (T7)", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-journal-class-"));
  const path = join(root, "live.sqlite");
  const store = new RacingStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.target = journalId(PROJECT);

  const first = gateRecord(store, "g3:1", gateFailure());
  const second = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));
  const row = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(first) })).value.rows[0]!.id;

  // The competitor journals another refusal while this call holds the head it read.
  store.armed = true;
  store.run = other => { deliveredOf(recordRefusal(other, { project: PROJECT, source: reference(second) })); };
  addressed(refusalOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row }) })), "input_stale");
  const after = journalOf(store)!;
  assert.equal(after.revision, 2);
  assert.deepEqual(after.value.rows.map(item => item.gate), ["G3", "G5"]);
  assert.deepEqual(after.value.classifications, []);

  // The competitor classifies the other row while this call is deciding on its own.
  const otherRow = after.value.rows[1]!.id;
  store.armed = true;
  store.run = other => { deliveredOf(classifyRefusal(other, { project: PROJECT, ...verdict({ row: otherRow, class: "derivation" }) })); };
  addressed(refusalOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row }) })), "input_stale");
  assert.deepEqual(journalOf(store)!.value.classifications.map(item => item.row), [otherRow]);

  // Neither decision was lost: read the head again and both stand.
  store.armed = false;
  const journal = deliveredOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row }) }));
  assert.deepEqual(journal.value.classifications.map(item => item.class), ["derivation", "input"]);
  assert.deepEqual(journal.value.rows.map(item => item.gate), ["G3", "G5"]);
});
