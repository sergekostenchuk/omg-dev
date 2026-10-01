import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store, type Revision } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import { writeGuarded } from "../src/om/refs.js";
import {
  classifyRefusal, journalId, prepareClassifyRefusal, prepareRecordRefusal, readJournal, recordRefusal, unitRefusalNamespace,
  normalizeOriginSource, originSourceKey, prepareJournalBatch, readJournalAt,
  REFUSAL_JOURNAL_CODES, REFUSAL_JOURNAL_KIND, SOURCE_ORDER, UNIT_REFUSAL_KIND,
  type ClassifyRefusalRequest, type ClassifyRefusalsRequest, type JournalRequest, type JournalRow,
  type RecordRefusalRequest, type RefusalClassification, type RefusalJournal, type OriginSource,
  type JournalBatch, type JournalBatchRequest, type JournalWrite, type JournalTransition,
} from "../src/om/refusal-journal.js";
import type { FrameRequest } from "../src/om/frame-obligations.js";

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
  const { root, store } = fixture(t);
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
  // H1.0c S1: a decision about a G4b row. A G4b row stands only where its typed reader is loaded, so this one is produced
  // in a child process that registers one (C36; the registry is process state).
  const answers = answersChild(root, join(root, "codes.sqlite"), `
journal.registerAnswersSourceReader(reader);
const source = ref(put(journal.unitRefusalNamespace('p10') + 'g4b:' + hex('1'), g4b()));
const row = journal.recordRefusal(store, { project: 'p10', source }).value.value.rows[0].id;
out.refused = journal.classifyRefusal(store, { project: 'p10', row, class: 'unknown', addressee: 'owner', basis: [] });`);
  record(refusalOf(answers['refused'] as OmResult<unknown>), "classification_invalid", "p10");

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

test("a change of the journal is prepared without being written, and a caller applies it inside its own transaction", t => {
  const { store } = fixture(t);
  const first = gateRecord(store, "g3:1", gateFailure());

  // The rows, the write and the guards are ready, and the store holds nothing of them yet.
  const prepared = deliveredOf(prepareRecordRefusal(store, { project: PROJECT, source: reference(first) }));
  assert.deepEqual(prepared.writes.map(write => write.id), [journalId(PROJECT)]);
  assert.equal(prepared.writes[0]!.kind, REFUSAL_JOURNAL_KIND);
  assert.equal(prepared.writes[0]!.expected, 0);
  // The record the rows came from is guarded, so a gate that rewrites it first leaves no row standing for it.
  assert.deepEqual(prepared.guards, [reference(first)]);
  assert.equal(prepared.value.rows.length, 1);
  assert.deepEqual(prepared.value.classifications, []);
  assert.equal(journalOf(store), null);

  // The caller writes it together with a record of its own: both stand, or neither does.
  const own = { id: "om-gate-run:alpha", kind: "om-gate-run", expected: 0, value: { gate: "G3" } };
  const applied = deliveredOf(writeGuarded(store, {
    unit: "g3", target: own.id, writes: [...prepared.writes, own], guards: [...prepared.guards],
  }));
  assert.deepEqual(applied.map(record => record.id), [journalId(PROJECT), own.id]);
  assert.equal(journalOf(store)!.revision, 1);
  assert.equal(hashJson(prepared.value), journalOf(store)!.hash);

  // A prepared change that is a repeat carries no write at all, so a caller adds nothing to its transaction.
  const repeat = deliveredOf(prepareRecordRefusal(store, { project: PROJECT, source: reference(first) }));
  assert.deepEqual(repeat.writes, []);
  assert.deepEqual(repeat.guards, []);
  assert.deepEqual(repeat.value, journalOf(store)!.value);

  // A second record appends to the head it was prepared against, and guards both.
  const second = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));
  const grown = deliveredOf(prepareRecordRefusal(store, { project: PROJECT, source: reference(second) }));
  assert.equal(grown.writes[0]!.expected, 1);
  assert.deepEqual(grown.guards, [reference(second), reference(journalOf(store)!)]);
  assert.equal(grown.value.rows.length, 2);

  // A change that cannot be made is refused at the preparation, before anything is written.
  const broken = gateRecord(store, "g3:2", gateFailure({ refusals: [] }));
  addressed(refusalOf(prepareRecordRefusal(store, { project: PROJECT, source: reference(broken) })), "refusals_missing");
  addressed(refusalOf(prepareRecordRefusal(store, { project: PROJECT, source: { ...reference(first), hash: hex("d") } })), "record_forged");
  assert.equal(journalOf(store)!.revision, 1);
});

test("a whole set of decisions about one journal is prepared as ONE write, not as several competing ones", t => {
  const { store } = fixture(t);
  const record = gateRecord(store, "g3:1", gateFailure({
    refusals: [entry(), entry({ code: "layer_port_unbound" }), entry({ code: "work_not_atomic" })],
  }));
  const rows = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(record) })).value.rows.map(row => row.id);
  const head = journalOf(store)!;
  const decisions = rows.map((row, index) => verdict({ row, class: ["proposal", "input", "derivation"][index]! }));

  const prepared = deliveredOf(prepareClassifyRefusal(store, { project: PROJECT, classifications: decisions }));
  // A journal is one record, and a transaction writes each record once: three decisions are one write of one id.
  assert.equal(prepared.writes.length, 1);
  assert.equal(prepared.writes[0]!.id, journalId(PROJECT));
  assert.equal(prepared.writes[0]!.expected, head.revision);
  assert.deepEqual(prepared.guards, [reference(head)]);
  assert.deepEqual(prepared.value.classifications.map(item => item.class), ["proposal", "input", "derivation"]);
  assert.deepEqual(journalOf(store)!.value.classifications, []);

  const applied = deliveredOf(writeGuarded(store, {
    unit: "gate-repeat", target: journalId(PROJECT), writes: [...prepared.writes], guards: [...prepared.guards],
  }));
  assert.equal(applied.length, 1);
  assert.equal(journalOf(store)!.revision, head.revision + 1);
  assert.deepEqual(journalOf(store)!.value.classifications.map(item => item.row), rows);

  // The same set again decides nothing new, whatever order it comes in, and carries no write.
  const again = deliveredOf(prepareClassifyRefusal(store, { project: PROJECT, classifications: [...decisions].reverse() }));
  assert.deepEqual(again.writes, []);
  assert.deepEqual(again.guards, []);
  assert.deepEqual(again.value, journalOf(store)!.value);

  // A set that decides one refusal twice in the same breath: the same decision twice is one, a different one is a
  // second answer where the journal holds one.
  const fourth = gateRecord(store, "g3:2", gateFailure({ gate: "G4" }));
  const extra = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(fourth) })).value.rows[3]!.id;
  const twice = deliveredOf(prepareClassifyRefusal(store, {
    project: PROJECT, classifications: [verdict({ row: extra }), verdict({ row: extra })],
  }));
  assert.equal(twice.writes.length, 1);
  assert.equal((twice.writes[0]!.value as RefusalJournal).classifications.length, 4);
  addressed(refusalOf(prepareClassifyRefusal(store, {
    project: PROJECT, classifications: [verdict({ row: extra }), verdict({ row: extra, class: "unknown" })],
  })), "classification_conflict");
  // And one unknown row refuses the whole set: no decision of it is prepared at all.
  addressed(refusalOf(prepareClassifyRefusal(store, {
    project: PROJECT, classifications: [verdict({ row: extra }), verdict({ row: "om-refusal:invented" })],
  })), "row_unknown");
  assert.equal(journalOf(store)!.value.classifications.length, 3);

  // An absent set is not an empty one, and neither decides anything: both are the calling code's defect.
  const prepare = (request: unknown): void => { prepareClassifyRefusal(store, request as ClassifyRefusalsRequest); };
  for (const classifications of [undefined, null, [], "one", 7, {}]) {
    assert.throws(() => prepare({ project: PROJECT, classifications }), code("journal_request_invalid"));
  }
  for (const item of [null, undefined, "row", 7, {}, without({ ...verdict({ row: extra }) }, "addressee"),
    { ...verdict({ row: extra }), basis: [{ role: "proposal" }] }]) {
    assert.throws(() => prepare({ project: PROJECT, classifications: [item] }), code("journal_request_invalid"));
  }
  for (const project of [undefined, null, "", 7, "alpha:beta"]) {
    assert.throws(() => prepare({ project, classifications: [verdict({ row: extra })] }), code("journal_request_invalid"));
  }
  for (const broken of [null, undefined, "store", 7, {}]) {
    assert.throws(() => prepareClassifyRefusal(broken as Store, { project: PROJECT, classifications: [verdict({ row: extra })] }),
      code("journal_request_invalid"));
  }
  assert.equal(journalOf(store)!.value.classifications.length, 3);

  // The accepted single operation and the set decide alike: one is the other said for one row.
  const single = deliveredOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row: extra }) }));
  assert.deepEqual(single.value.classifications, twice.value.classifications);
  addressed(refusalOf(prepareClassifyRefusal(store, { project: "nowhere", classifications: [verdict({ row: extra })] })),
    "journal_missing", "nowhere");
});

test("the sources of an origin are separated by a byte none of them can contain, so no two keys collide (T6)", t => {
  const { store } = fixture(t);
  // Two sources whose role and id run into one another: "ab" + "c" and "a" + "bc" are the same text unseparated, so
  // a key built without a separator would make them EQUAL and leave their canonical order to the order they arrived
  // in — and a row id is the hash of that order.
  const shared = { revision: 1, hash: hex("f") };
  const left = { role: "ab", ref: { ...shared, id: "c" } };
  const right = { role: "a", ref: { ...shared, id: "bc" } };
  const rowOf = (sources: readonly unknown[], name: string): JournalRow => {
    const record = gateRecord(store, name, gateFailure({ refusals: [entry({ origin: origin({ sources }) })] }), name);
    return deliveredOf(recordRefusal(store, { project: name, source: reference(record) })).value.rows[0]!;
  };
  const one = rowOf([left, right], "sep1");
  const other = rowOf([right, left], "sep2");
  // One order, and therefore one identity, whichever way the two arrived.
  assert.deepEqual(one.origin.sources.map(item => item.role), ["a", "ab"]);
  assert.deepEqual(other.origin.sources, one.origin.sources);
  // The two rows differ only in the record they came from, so everything else about them hashes alike.
  const content = (row: JournalRow): string => hashJson(without(without({ ...row }, "source"), "id"));
  assert.equal(content(one), content(other));
});

test("the identity of a journal row is the same it has always been for the same refusal and the same sources", t => {
  const { store } = fixture(t);
  const record = gateRecord(store, "g3:1", gateFailure());
  const row = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(record) })).value.rows[0]!;

  // Derived again here, by this test's own reading of the rule: the row is the hash of its content with the sources
  // in the canonical order. Nothing of the unit's is reused, so a change of how a row is built shows up as a break.
  const key = (item: { role: string; ref: Ref }): string => `${item.role}\0${item.ref.id}\0${item.ref.revision}\0${item.ref.hash}`;
  const body = {
    gate: "G3", code: "graph_invalid",
    goal: "every artifact an operation consumes is produced somewhere in the layer",
    remedy: "add the producer of artifact:cart to the proposal, or drop the operation consuming it",
    origin: {
      name: "artifact_missing", stage: "candidate-assembly", subject: "artifact:cart",
      sources: [{ role: "proposal", ref: PROPOSAL }, { role: "base", ref: BASE }]
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)),
    },
    source: reference(record),
  };
  assert.equal(row.id, hashJson(body));
  // And pinned, so that a row journalled before this change still answers to the id it was journalled under.
  assert.equal(row.id, "d54eab905f8de3fff64764859d56d1ee403195084d77e20fa0923f36c3ae4383");
});

test("no source of this block carries a literal control byte", () => {
  // A literal NUL or other control byte makes a file binary to grep, to file and to review tools, and an editor may
  // drop it or show it as a space. Where such a byte is meant — the separator of a sort key — it is written as an
  // escape. This walks the sources so the class cannot come back unnoticed.
  const directory = new URL("../../src/om/", import.meta.url);
  const sources = readdirSync(directory).filter(name => name.endsWith(".ts"));
  assert.ok(sources.length >= 4, `expected the sources of the block, found ${sources.join(", ")}`);
  const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
  for (const name of sources) {
    const text = readFileSync(new URL(name, directory), "latin1");
    const index = text.search(control);
    assert.equal(index, -1,
      `${name} carries a literal control byte at ${index}: ${JSON.stringify(text.slice(Math.max(0, index - 40), index + 40))}`);
  }
});

test("origin context is normalized once and survives row identity, classification, historical reading and restart", t => {
  const { store, path } = fixture(t);
  const frame: FrameRequest = { project: PROJECT, level: 2, graph: BASE, horizon: refTo("om-horizon-gate:alpha:one"),
    layer: null, frame: null, upper: null };
  const left: OriginSource = { role: "proposal", ref: PROPOSAL, context: { kind: "proposal",
    request: { frame, proposals: [refTo("om-proposal:alpha:z"), PROPOSAL, PROPOSAL] } } };
  const right: OriginSource = { ...left, context: { kind: "proposal", request: {
    frame: { ...frame, horizon: refTo("om-horizon-gate:alpha:two") }, proposals: [PROPOSAL] } } };
  assert.notEqual(originSourceKey(left), originSourceKey(right));
  // Sources and proposal references are multisets: order changes nothing, multiplicity remains visible.
  const reversed: OriginSource = { ...left, context: { kind: "proposal", request: { frame,
    proposals: [...(left.context as { kind: "proposal"; request: { proposals: readonly Ref[] } }).request.proposals].reverse() } } };
  assert.deepEqual(normalizeOriginSource(reversed), normalizeOriginSource(left));
  assert.ok(deeplyFrozen(normalizeOriginSource(left)));
  const sources = [right, left, left];
  const record = gateRecord(store, "context", gateFailure({ refusals: [entry({ origin: origin({ sources }) }),
    entry({ origin: origin({ sources: [reversed, reversed, right] }) })] }));
  const recorded = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(record) }));
  assert.equal(recorded.value.rows.length, 1);
  const row = recorded.value.rows[0]!;
  assert.equal(row.origin.sources.length, 3);
  assert.equal(row.origin.sources.filter(item => originSourceKey(item) === originSourceKey(left)).length, 2);
  const normalized = normalizeOriginSource(left);
  assert.equal(normalized.context!.kind, "proposal");
  if (normalized.context!.kind === "proposal") assert.equal(normalized.context!.request.proposals.length, 3);
  const classified = deliveredOf(classifyRefusal(store, { project: PROJECT, row: row.id, class: "unknown", addressee: "reviewer", basis: sources }));
  assert.deepEqual(classified.value.classifications[0]!.basis, row.origin.sources);
  const repeated = deliveredOf(classifyRefusal(store, { project: PROJECT, row: row.id, class: "unknown", addressee: "reviewer", basis: [reversed, right, reversed] }));
  assert.equal(repeated.revision, classified.revision);
  store.write({ id: record.id, kind: record.kind, expected: record.revision, value: gateFailure() });
  assert.deepEqual(deliveredOf(readJournal(store, { project: PROJECT })).value, classified.value);
  store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  assert.deepEqual(deliveredOf(readJournal(reopened, { project: PROJECT })).value, classified.value);
});

test("origin normalization rejects incomplete modern contexts and the journal reports their source address", t => {
  const { store } = fixture(t);
  const frame: FrameRequest = { project: PROJECT, level: 2, graph: BASE, horizon: refTo("om-horizon-gate:alpha:one"),
    layer: null, frame: null, upper: null };
  const valid = { role: "base", ref: BASE, context: { kind: "frame", request: frame } };
  assert.deepEqual(normalizeOriginSource(valid), valid);
  let number = 0;
  for (const context of [null, {}, { kind: "unknown", request: frame }, { kind: "frame", request: { ...frame, layer: undefined } },
    { kind: "frame", request: { ...frame, upper: {} } }, { kind: "proposal", request: { frame } },
    { kind: "proposal", request: { frame, proposals: null } }, { kind: "proposal", request: { frame, proposals: [null] } }]) {
    const broken = { ...valid, context };
    assert.throws(() => normalizeOriginSource(broken), code("journal_request_invalid"));
    assert.throws(() => originSourceKey(broken as unknown as OriginSource), code("journal_request_invalid"));
    // Missing JSON fields, unlike an explicit undefined, are what a stored source can contain.
    const json = JSON.parse(JSON.stringify(broken));
    const record = gateRecord(store, `context-broken-${number++}`, gateFailure({ refusals: [entry({ origin: origin({ sources: [json] }) })] }));
    const refusal = addressed(refusalOf(recordRefusal(store, { project: PROJECT, source: reference(record) })), "origin_source_invalid");
    assert.ok(refusal.at.field!.startsWith("refusals.0.origin.sources.0.context"));
  }
  for (const value of [undefined, null, [], "source"]) assert.throws(() => normalizeOriginSource(value), code("journal_request_invalid"));
});


test("origin history preserves each work-zone era and refuses a forged contract context", t => {
  const { store, path } = fixture(t);
  const legacy: FrameRequest = { project: PROJECT, level: 3, graph: BASE, horizon: refTo("om-horizon-gate:alpha:work-zone"),
    layer: null, frame: null, upper: { horizon: refTo("om-horizon-gate:alpha:work-zone"), frame: null } };
  const source = (frame: FrameRequest): OriginSource => ({ role: "base", ref: BASE, context: { kind: "frame", request: frame } });
  const sources = [source(legacy), source({ ...legacy, workZoneContract: "accepted-l2-v1" })];
  assert.notEqual(originSourceKey(sources[0]!), originSourceKey(sources[1]!));
  for (const item of sources) assert.deepEqual(normalizeOriginSource(item), item);
  const record = gateRecord(store, "zone-era", gateFailure({ refusals: [entry({ origin: origin({ sources }) })] }));
  const recorded = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(record) }));
  const classified = deliveredOf(classifyRefusal(store, { project: PROJECT, row: recorded.value.rows[0]!.id,
    class: "unknown", addressee: "reviewer", basis: sources }));
  for (const contract of [undefined, null, "unknown"]) assert.throws(() =>
    normalizeOriginSource(source({ ...legacy, workZoneContract: contract } as unknown as FrameRequest)), code("journal_request_invalid"));
  assert.throws(() => normalizeOriginSource(source({ ...legacy, level: 2, upper: null, workZoneContract: "accepted-l2-v1" })), code("journal_request_invalid"));
  store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  assert.deepEqual(deliveredOf(readJournal(reopened, { project: PROJECT })).value, classified.value);
  assert.deepEqual(deliveredOf(classifyRefusal(reopened, { project: PROJECT, row: recorded.value.rows[0]!.id,
    class: "unknown", addressee: "reviewer", basis: [...sources].reverse() })), classified);
  const forged = structuredClone(classified.value) as RefusalJournal;
  const marked = forged.rows[0]!.origin.sources.find(item => item.context?.kind === "frame" && item.context.request.workZoneContract);
  assert.ok(marked?.context?.kind === "frame");
  delete (marked.context.request as FrameRequest).workZoneContract;
  reopened.write({ id: classified.id, kind: classified.kind, expected: classified.revision, value: forged });
  addressed(refusalOf(readJournal(reopened, { project: PROJECT })), "journal_invalid");
});

// ---- H1.0c: one batch of the journal (№1446 п.5; cells C32, C33, C34, C68, C69) ----

// A refusal record prepared by its producer in the caller's transaction: created by its own write, at revision 1.
// S1 of H1.0c: the staged record carries no mark of G4b (gate, g4b: namespace, stage answers-gate/v1, answers-finding),
// since a G4b source is admitted only in its exact form by its typed reader (C19, C36); the batch mechanics are the same.
const pendingWrite = (name: string, value: unknown, project = PROJECT): JournalWrite =>
  ({ id: `${unitRefusalNamespace(project)}${name}`, kind: UNIT_REFUSAL_KIND, expected: 0, value });
const pendingRef = (write: JournalWrite): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
const stagedFailure = (over: Record<string, unknown> = {}): Record<string, unknown> => gateFailure({
  gate: "G6",
  refusals: [
    entry({ code: "answer_missing_for_blocking_gap", origin: origin({ stage: "batch-staging", subject: "gap:alpha:1",
      sources: [{ role: "finding", ref: refTo("om-answers-gate:alpha:finding:1", 1, "e") }] }) }),
    entry({ code: "answer_route_invalid", origin: origin({ stage: "batch-staging", subject: "gap:alpha:2",
      sources: [{ role: "finding", ref: refTo("om-answers-gate:alpha:finding:2", 1, "e") }] }) }),
  ],
  ...over,
});
const batchOf = (over: Record<string, unknown> = {}, project = PROJECT): JournalBatchRequest =>
  ({ project, sources: [], pending: [], classifications: [], ...over }) as unknown as JournalBatchRequest;
// The caller's bundle: the batch's writes exactly as handed over, in ONE guarded transaction.
const commit = (store: Store, batch: JournalBatch, project = PROJECT) =>
  writeGuarded(store, { unit: "g4b", target: journalId(project), writes: [...batch.writes], guards: [...batch.guards] });
const transition = (batch: JournalBatch) => ({ writes: batch.writes, guards: batch.guards, value: batch.value });
// A store that reports every read of a record, to show what a preparation touches.
function counting(store: Store, seen: (id: string) => void): Store {
  return new Proxy(store, { get(target, key) {
    if (key === "get") return (id: string, revision?: number) => { seen(id); return target.get(id, revision); };
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}
// What a neighbour sees before the commit: the store with the bundle's writes standing at the revisions they create.
function bundleView(store: Store, writes: readonly JournalWrite[]): Store {
  const staged = new Map(writes.map(write => [write.id,
    { id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(write.value), value: write.value }]));
  return new Proxy(store, { get(target, key) {
    if (key === "get") return (id: string, revision?: number) => {
      const found = staged.get(id);
      return found && (revision === undefined || revision === found.revision) ? found : target.get(id, revision);
    };
    const member: unknown = Reflect.get(target, key, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}

test("C32 H1.0c a batch that finds no journal creates it in ONE write expected 0 with its rows and their decisions, beside the pending source it hands back (row 34)", t => {
  const { store, path } = fixture(t);
  const stored = gateRecord(store, "g3:1", gateFailure());
  const pending = pendingWrite("staged:1", stagedFailure());
  const request = batchOf({ sources: [pendingRef(pending), reference(stored)], pending: [pending] });
  const rows = deliveredOf(prepareJournalBatch(store, request)).value.rows;
  // Rows stand in the order their sources are named, as consecutive single records would put them.
  assert.deepEqual(rows.map(row => row.source), [pendingRef(pending), pendingRef(pending), reference(stored)]);
  // The rows are the single path's rows: the same record through the accepted operation gives the same row.
  assert.deepEqual(rows[2], deliveredOf(prepareRecordRefusal(store, { project: PROJECT, source: reference(stored) })).value.rows[0]);

  // Decisions about rows this very batch adds (C69), taken in the same write.
  const decisions = rows.map((row, index) => verdict({ row: row.id, class: ["input", "unknown", "proposal"][index]! }));
  const batch = deliveredOf(prepareJournalBatch(store, { ...request, classifications: decisions }));
  // ONE write of the journal, expected 0, after the write that creates the pending source — the batch's own copy of it.
  assert.deepEqual(batch.writes.map(write => [write.id, write.kind, write.expected]),
    [[pending.id, UNIT_REFUSAL_KIND, 0], [journalId(PROJECT), REFUSAL_JOURNAL_KIND, 0]]);
  assert.deepEqual(batch.writes[0], pending);
  // The stored source and the journal's ABSENCE are guarded; the pending source is guarded by its own write.
  assert.deepEqual(batch.guards, [reference(stored), { id: journalId(PROJECT), absent: true }]);
  assert.deepEqual(batch.value.rows, rows);
  assert.deepEqual(batch.value.classifications.map(item => [item.row, item.class]), rows.map((row, index) => [row.id, decisions[index]!.class]));
  assert.deepEqual(batch.result, { id: journalId(PROJECT), revision: 1, hash: hashJson(batch.value) });
  assert.deepEqual(batch.writes[1]!.value, batch.value);
  assert.ok(deeplyFrozen(batch));
  // The preparation wrote nothing.
  assert.equal(journalOf(store), null);
  assert.equal(store.get(pending.id), null);

  // The exact resulting reference already reads, through the common reader, from a view of the bundle.
  assert.deepEqual(deliveredOf(readJournalAt(bundleView(store, batch.writes), PROJECT, batch.result)).value, batch.value);

  const written = deliveredOf(commit(store, batch));
  assert.deepEqual(written.map(record => [record.id, record.revision]), [[pending.id, 1], [journalId(PROJECT), 1]]);
  const journal = journalOf(store)!;
  assert.deepEqual(reference(journal), batch.result);
  assert.equal(hashJson(batch.value), journal.hash);
  // The source written is the one the rows name.
  assert.deepEqual(reference(store.get(pending.id)!), pendingRef(pending));
  assert.equal(store.history(journalId(PROJECT)).length, 1);

  // Restart: the rows are derived again from their exact sources, the decisions are read beside them.
  store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  assert.deepEqual(deliveredOf(readJournalAt(reopened, PROJECT, batch.result)).value, batch.value);
  assert.deepEqual(deliveredOf(readJournal(reopened, { project: PROJECT })).value, batch.value);
});

test("C32 H1.0c a batch on a standing journal writes ONE revision expected n, guarded by that head and by every stored record it read", t => {
  const { store } = fixture(t);
  const first = gateRecord(store, "g3:1", gateFailure());
  const old = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(first) })).value.rows[0]!;
  const second = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));
  const head = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(second) }));
  assert.equal(head.revision, 2);

  const third = gateRecord(store, "g4:1", gateFailure({ gate: "G4" }));
  const pending = pendingWrite("staged:1", stagedFailure());
  // The first record is journalled already: named again, it gives no row.
  const request = batchOf({ sources: [reference(third), pendingRef(pending), reference(first)], pending: [pending] });
  const fresh = deliveredOf(prepareJournalBatch(store, request)).value.rows.slice(head.value.rows.length);
  assert.deepEqual(fresh.map(row => row.source), [reference(third), pendingRef(pending), pendingRef(pending)]);
  const decisions = [verdict({ row: old.id }), ...fresh.map(row => verdict({ row: row.id, class: "unknown", addressee: "owner", basis: [] }))];
  const batch = deliveredOf(prepareJournalBatch(store, { ...request, classifications: decisions }));

  assert.deepEqual(batch.writes.map(write => [write.id, write.expected]), [[pending.id, 0], [journalId(PROJECT), 2]]);
  // Every stored record the batch read is guarded, the one already journalled as well (row 41), then the head.
  assert.deepEqual(batch.guards, [reference(third), reference(first), reference(head)]);
  assert.deepEqual(batch.value.rows.slice(0, 2), head.value.rows);
  assert.deepEqual(batch.value.rows.slice(2), fresh);
  assert.deepEqual(batch.value.classifications.map(item => item.row), [old.id, ...fresh.map(row => row.id)]);
  assert.deepEqual(batch.result, { id: journalId(PROJECT), revision: 3, hash: hashJson(batch.value) });

  deliveredOf(commit(store, batch));
  const journal = journalOf(store)!;
  assert.deepEqual(reference(journal), batch.result);
  assert.equal(hashJson(batch.value), journal.hash);
  assert.deepEqual(deliveredOf(readJournalAt(store, PROJECT, batch.result)).value, batch.value);
});

test("C69 H1.0c a decision about a row the same batch adds is taken in its write, where the single classification still refuses it", t => {
  const { store, path } = fixture(t);
  const first = gateRecord(store, "g3:1", gateFailure());
  deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(first) }));
  const next = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));
  const fresh = deliveredOf(prepareRecordRefusal(store, { project: PROJECT, source: reference(next) })).value.rows[1]!;
  // The accepted operation keeps its rule: it decides only about rows the journal holds (refusal-journal.ts:330).
  addressed(refusalOf(prepareClassifyRefusal(store, { project: PROJECT, classifications: [verdict({ row: fresh.id })] })), "row_unknown");

  const batch = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [reference(next)], classifications: [verdict({ row: fresh.id })] })));
  assert.deepEqual(batch.value.classifications.map(item => item.row), [fresh.id]);
  deliveredOf(commit(store, batch));
  store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  // checkClassifications passes on the historical reading: the decision stands for a row of the same revision.
  const read = deliveredOf(readJournalAt(reopened, PROJECT, batch.result));
  assert.deepEqual(read.value.classifications, batch.value.classifications);
  assert.equal(read.value.rows[1]!.id, fresh.id);
});

test("C33 H1.0c a pending source is admitted only with its exact write, read as strictly as a stored one, and never on a caller's flag", t => {
  const { store } = fixture(t);
  const pending = pendingWrite("staged:1", stagedFailure());
  const standing = gateRecord(store, "staged:9", stagedFailure());
  const before = store.list().length;
  const refuse = (name: string, sources: unknown[], writes: unknown[], expected: string, target = journalId(PROJECT)): Refusal => {
    const refusal = refusalOf(prepareJournalBatch(store, batchOf({ sources, pending: writes })));
    assert.equal(refusal.code, expected, name);
    assert.equal(refusal.at.target, target, name);
    return refusal;
  };
  const forged = (value: unknown): JournalWrite => ({ ...pending, value });

  refuse("a pending source without its write", [pendingRef(pending)], [], "record_missing");
  refuse("a substituted hash", [{ ...pendingRef(pending), hash: hex("d") }], [pending], "record_forged");
  refuse("a substituted body under the original reference", [pendingRef(pending)],
    [forged(stagedFailure({ refusals: [entry({ remedy: "accept the proposal as it stands" })] }))], "record_forged");
  refuse("a revision its write does not create", [{ ...pendingRef(pending), revision: 2 }], [pending], "record_missing");
  const verdictIn = forged(stagedFailure({ refusals: [{ ...entry(), class: "input" }] }));
  refuse("a body declaring a verdict, its reference recomputed", [pendingRef(verdictIn)], [verdictIn], "refusal_entry_invalid");
  const statusIn = forged({ ...stagedFailure(), status: "accepted" });
  refuse("a record declaring a status, its reference recomputed", [pendingRef(statusIn)], [statusIn], "refusal_record_invalid");
  const empty = forged(stagedFailure({ refusals: [] }));
  refuse("a record naming no refusal", [pendingRef(empty)], [empty], "refusals_missing");
  const awkward = forged(JSON.parse('{"__proto__":{"gate":"G3"},"gate":"G4b","refusals":[]}'));
  refuse("an own __proto__ field", [pendingRef(awkward)], [awkward], "refusal_record_invalid");
  const unsourced = forged(stagedFailure({ refusals: [entry({ origin: origin({ sources: [{ role: "finding" }] }) })] }));
  refuse("a source without its reference", [pendingRef(unsourced)], [unsourced], "origin_source_invalid");
  const disguised: JournalWrite = { ...pending, kind: "gate-pass" };
  assert.equal(refuse("a write of another kind", [pendingRef(disguised)], [disguised], "record_foreign").at.field, "kind");
  const foreign = pendingWrite("staged:1", stagedFailure(), "beta");
  assert.equal(refuse("a write in another project's namespace", [pendingRef(foreign)], [foreign], "record_foreign").at.field, "id");
  const journalAddress: JournalWrite = { ...pending, id: journalId(PROJECT) };
  refuse("a write at the journal's own address", [pendingRef(journalAddress)], [journalAddress], "record_foreign");

  // No flag of the caller stands in for the write or for the check.
  assert.throws(() => prepareJournalBatch(store, { ...batchOf({ sources: [pendingRef(pending)] }), verified: true } as JournalBatchRequest),
    code("journal_request_invalid"));
  assert.throws(() => prepareJournalBatch(store, batchOf({ sources: [pendingRef(pending)], pending: [{ ...pending, verified: true }] })),
    code("journal_request_invalid"));
  assert.equal(journalOf(store), null);
  assert.equal(store.get(pending.id), null);
  assert.equal(store.list().length, before);

  // A record that stands already under other bytes is weighed as the write offered, and that write cannot create it:
  // the store refuses the whole transaction.
  const other = pendingWrite("staged:9", stagedFailure({ gate: "G4c" }));
  const clash = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [pendingRef(other)], pending: [other] })));
  assert.deepEqual(clash.writes[0], other);
  const conflict = refusalOf(commit(store, clash));
  assert.equal(conflict.code, "revision_conflict");
  assert.equal(conflict.at.target, other.id);
  assert.equal(journalOf(store), null);
  assert.equal(store.list().length, before);
  // One that stands under the same bytes has been created: it is read and guarded as a stored record, and its write,
  // which could only fail now, is not carried.
  const same = pendingWrite("staged:9", stagedFailure());
  assert.deepEqual(pendingRef(same), reference(standing));
  const created = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [pendingRef(same)], pending: [same] })));
  assert.deepEqual(created.writes.map(write => write.id), [journalId(PROJECT)]);
  assert.deepEqual(created.guards, [reference(standing), { id: journalId(PROJECT), absent: true }]);

  // Its exact write admits it, and the rows name the revision that write creates.
  const batch = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [pendingRef(pending)], pending: [pending] })));
  assert.deepEqual(batch.value.rows.map(row => row.source), [pendingRef(pending), pendingRef(pending)]);
  assert.deepEqual(batch.writes.map(write => write.id), [pending.id, journalId(PROJECT)]);
  assert.deepEqual(batch.guards, [{ id: journalId(PROJECT), absent: true }]);
});

test("C33 H1.0c the batch hands back the exact bytes it read: the caller's object changed afterwards, or written beside them, cannot put another source under the rows", t => {
  const { store, path } = fixture(t);
  const original = pendingWrite("staged:1", stagedFailure());
  const mine = structuredClone(original) as JournalWrite & { value: { refusals: Array<Record<string, unknown>> } };
  const batch = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [pendingRef(original)], pending: [mine] })));
  // The caller's object changes after the preparation: nothing the batch handed out changes with it.
  mine.value.refusals[0]!['remedy'] = "accept the proposal as it stands";
  mine.value.refusals.pop();
  assert.notEqual(hashJson(mine.value), hashJson(original.value));
  assert.deepEqual(batch.writes[0], original);
  assert.equal(hashJson(batch.writes[0]!.value), batch.value.rows[0]!.source.hash);
  // The caller's own write beside the batch's is a second write of one record: the store refuses the whole transaction.
  assert.throws(() => writeGuarded(store, { unit: "g4b", target: journalId(PROJECT), writes: [mine, ...batch.writes], guards: [...batch.guards] }),
    code("duplicate_write"));
  assert.equal(store.get(original.id), null);
  assert.equal(journalOf(store), null);

  deliveredOf(commit(store, batch));
  // Hash of what was handed out = hash of what was written = hash the rows name.
  assert.deepEqual(reference(store.get(original.id)!), pendingRef(original));
  assert.equal(store.get(original.id)!.hash, batch.value.rows[0]!.source.hash);
  store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  assert.deepEqual(deliveredOf(readJournal(reopened, { project: PROJECT })).value, batch.value);
});

test("C33 H1.0c a batch weighs one copy of its request: a value that reads differently twice cannot pass a check as one thing and reach the journal as another", t => {
  const { store } = fixture(t);
  const first = gateRecord(store, "g3:1", gateFailure());
  const row = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(first) })).value.rows[0]!.id;
  const next = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));
  // The same content in another project's namespace has the same hash, so one reference could read at both addresses.
  const alien = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }), "beta");
  assert.equal(alien.hash, next.hash);
  let classes = 0, ids = 0;
  const decision = { row, get class() { classes += 1; return classes === 1 ? "input" : 7; }, addressee: "owner", basis: [] };
  const source = { get id() { ids += 1; return ids === 1 ? next.id : alien.id; }, revision: 1, hash: next.hash };
  const batch = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [source], classifications: [decision] })));
  assert.equal(classes, 1);
  assert.equal(ids, 1);
  assert.equal(batch.value.classifications[0]!.class, "input");
  assert.deepEqual(batch.value.rows[1]!.source, reference(next));
  deliveredOf(commit(store, batch));
  assert.deepEqual(deliveredOf(readJournal(store, { project: PROJECT })).value, batch.value);
});

test("C32 H1.0c the same batch after its write adds no revision: it names the head as its guard and its result, after restart too", t => {
  const { store, path } = fixture(t);
  const stored = gateRecord(store, "g3:1", gateFailure());
  const pending = pendingWrite("staged:1", stagedFailure());
  const request = batchOf({ sources: [reference(stored), pendingRef(pending)], pending: [pending] });
  const decisions = deliveredOf(prepareJournalBatch(store, request)).value.rows.map(row => verdict({ row: row.id }));
  const complete = { ...request, classifications: decisions };
  const batch = deliveredOf(prepareJournalBatch(store, complete));
  deliveredOf(commit(store, batch));
  const head = reference(journalOf(store)!);

  // The very same batch, its pending source included: that record has been created, so nothing is written.
  const same = deliveredOf(prepareJournalBatch(store, complete));
  assert.deepEqual([same.writes, same.guards, same.result], [[], [head], head]);
  assert.deepEqual(same.value, batch.value);
  // Repeated with the source it created named as a stored one, in another order: the same.
  const repeat = batchOf({ sources: [pendingRef(pending), reference(stored)], classifications: [...decisions].reverse() });
  const again = deliveredOf(prepareJournalBatch(store, repeat));
  assert.deepEqual([again.writes, again.guards, again.result], [[], [head], head]);
  assert.deepEqual(again.value, batch.value);
  // A part of it is a repeat as well, and the accepted operations agree.
  assert.deepEqual(deliveredOf(prepareJournalBatch(store, batchOf({ classifications: [decisions[1]!] }))).result, head);
  assert.deepEqual(deliveredOf(prepareRecordRefusal(store, { project: PROJECT, source: pendingRef(pending) })).writes, []);
  // A different decision about a decided row is refused, not written over.
  addressed(refusalOf(prepareJournalBatch(store, batchOf({ classifications: [verdict({ row: decisions[0]!.row, class: "derivation" })] }))),
    "classification_conflict");

  store.close(); const reopened = new Store(path); t.after(() => reopened.close());
  for (const late of [complete, repeat]) {
    const prepared = deliveredOf(prepareJournalBatch(reopened, late));
    assert.deepEqual([prepared.writes, prepared.guards, prepared.result], [[], [head], head]);
  }
  assert.equal(reopened.history(journalId(PROJECT)).length, 1);
  assert.equal(reopened.history(pending.id).length, 1);
});

test("41 H1.0c a journal, a stored source or a pending source that moves between the preparation and the write refuses the whole bundle (row 2)", t => {
  const { store, path } = fixture(t);
  const between = (run: (other: Store) => void): void => { const other = new Store(path); try { run(other); } finally { other.close(); } };
  const prepared = (project: string, sources: Ref[], pending: JournalWrite[]): JournalBatch =>
    deliveredOf(prepareJournalBatch(store, batchOf({ sources, pending }, project)));

  // The journal is created by someone else after this batch prepared its creation: the absence it was weighed on is gone.
  {
    const project = "w1";
    const stored = gateRecord(store, "g3:1", gateFailure(), project);
    const pending = pendingWrite("staged:1", stagedFailure(), project);
    const batch = prepared(project, [reference(stored), pendingRef(pending)], [pending]);
    between(other => { deliveredOf(recordRefusal(other, { project, source: reference(stored) })); });
    const refusal = refusalOf(commit(store, batch, project));
    assert.equal(refusal.code, "input_stale");
    assert.equal(refusal.at.target, journalId(project));
    assert.equal(store.get(pending.id), null);
    assert.equal(journalOf(store, project)!.revision, 1);
    assert.equal(journalOf(store, project)!.value.rows.length, 1);
    // Nothing is lost: prepared again on what stands now, it appends to the competitor's journal.
    const again = prepared(project, [reference(stored), pendingRef(pending)], [pending]);
    assert.deepEqual(again.writes.map(write => [write.id, write.expected]), [[pending.id, 0], [journalId(project), 1]]);
    deliveredOf(commit(store, again, project));
    assert.equal(journalOf(store, project)!.value.rows.length, 3);
  }
  // The journal is appended to by someone else.
  {
    const project = "w2";
    const first = gateRecord(store, "g3:1", gateFailure(), project);
    const head = deliveredOf(recordRefusal(store, { project, source: reference(first) }));
    const second = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }), project);
    const pending = pendingWrite("staged:1", stagedFailure(), project);
    const batch = prepared(project, [pendingRef(pending)], [pending]);
    between(other => { deliveredOf(recordRefusal(other, { project, source: reference(second) })); });
    const refusal = refusalOf(commit(store, batch, project));
    assert.equal(refusal.code, "input_stale");
    assert.deepEqual(refusal.at.ref, reference(head));
    assert.equal(store.get(pending.id), null);
    assert.equal(journalOf(store, project)!.revision, 2);
  }
  // The journal is classified by someone else: its head moves although no row is added.
  {
    const project = "w3";
    const first = gateRecord(store, "g3:1", gateFailure(), project);
    const row = deliveredOf(recordRefusal(store, { project, source: reference(first) })).value.rows[0]!.id;
    const pending = pendingWrite("staged:1", stagedFailure(), project);
    const batch = prepared(project, [pendingRef(pending)], [pending]);
    between(other => { deliveredOf(classifyRefusal(other, { project, ...verdict({ row }) })); });
    assert.equal(refusalOf(commit(store, batch, project)).code, "input_stale");
    assert.equal(store.get(pending.id), null);
  }
  // The pending source is written by someone else: its own write can no longer create it.
  {
    const project = "w4";
    const pending = pendingWrite("staged:1", stagedFailure(), project);
    const batch = prepared(project, [pendingRef(pending)], [pending]);
    between(other => { other.write({ id: pending.id, kind: pending.kind, expected: 0, value: stagedFailure({ gate: "G4c" }) }); });
    const refusal = refusalOf(commit(store, batch, project));
    assert.equal(refusal.code, "revision_conflict");
    assert.equal(refusal.at.target, pending.id);
    assert.equal(journalOf(store, project), null);
  }
  // A stored source is rewritten by its gate: no row stands for content it no longer holds.
  {
    const project = "w5";
    const stored = gateRecord(store, "g3:1", gateFailure(), project);
    const pending = pendingWrite("staged:1", stagedFailure(), project);
    const batch = prepared(project, [reference(stored), pendingRef(pending)], [pending]);
    between(other => { other.write({ id: stored.id, kind: UNIT_REFUSAL_KIND, expected: 1, value: gateFailure({ gate: "G5" }) }); });
    const refusal = refusalOf(commit(store, batch, project));
    assert.equal(refusal.code, "input_stale");
    assert.deepEqual(refusal.at.ref, reference(stored));
    assert.equal(store.get(pending.id), null);
    assert.equal(journalOf(store, project), null);
  }
  // The pending source is written by someone else with the very same bytes: the transaction still fails whole, and the
  // batch prepared again finds the record created and journals it as a stored one.
  {
    const project = "w6";
    const pending = pendingWrite("staged:1", stagedFailure(), project);
    const batch = prepared(project, [pendingRef(pending)], [pending]);
    between(other => { other.write(pending); });
    assert.equal(refusalOf(commit(store, batch, project)).code, "revision_conflict");
    assert.equal(journalOf(store, project), null);
    const again = prepared(project, [pendingRef(pending)], [pending]);
    assert.deepEqual(again.writes.map(write => write.id), [journalId(project)]);
    assert.deepEqual(again.guards, [pendingRef(pending), { id: journalId(project), absent: true }]);
    deliveredOf(commit(store, again, project));
    assert.equal(store.history(pending.id).length, 1);
  }
  // A stored source the journal holds already, named beside a new one, is rewritten by its gate: the batch read it, so
  // the bundle refuses (row 41).
  {
    const project = "w7";
    const first = gateRecord(store, "g3:1", gateFailure(), project);
    deliveredOf(recordRefusal(store, { project, source: reference(first) }));
    const pending = pendingWrite("staged:1", stagedFailure(), project);
    const batch = prepared(project, [pendingRef(pending), reference(first)], [pending]);
    between(other => { other.write({ id: first.id, kind: UNIT_REFUSAL_KIND, expected: 1, value: gateFailure({ gate: "G6" }) }); });
    const refusal = refusalOf(commit(store, batch, project));
    assert.equal(refusal.code, "input_stale");
    assert.deepEqual(refusal.at.ref, reference(first));
    assert.equal(store.get(pending.id), null);
    assert.equal(journalOf(store, project)!.revision, 1);
  }
});

test("C69 H1.0c a batch decides by the single-row rules: an unknown or foreign row and a second different decision refuse it whole", t => {
  const { store } = fixture(t);
  const first = gateRecord(store, "g3:1", gateFailure());
  const row = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(first) })).value.rows[0]!;
  deliveredOf(classifyRefusal(store, { project: PROJECT, ...verdict({ row: row.id }) }));
  const head = journalOf(store)!;
  const next = gateRecord(store, "g5:1", gateFailure({ gate: "G5" }));
  const fresh = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [reference(next)] }))).value.rows[1]!;
  const foreign = planted(store, "beta").row;
  const refuse = (classifications: RefusalClassification[], expected: string): void => {
    const refusal = addressed(refusalOf(prepareJournalBatch(store, batchOf({ sources: [reference(next)], classifications }))), expected);
    assert.deepEqual(refusal.at.ref, reference(head));
  };
  refuse([verdict({ row: "om-refusal:invented" })], "row_unknown");
  refuse([verdict({ row: foreign.id })], "row_unknown");
  refuse([verdict({ row: fresh.id }), verdict({ row: "om-refusal:invented" })], "row_unknown");
  refuse([verdict({ row: row.id, class: "derivation" })], "classification_conflict");
  refuse([verdict({ row: fresh.id }), verdict({ row: fresh.id, class: "unknown" })], "classification_conflict");
  assert.equal(journalOf(store)!.revision, head.revision);

  // The same decision twice is one, and the standing decision again is a repeat.
  const once = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [reference(next)],
    classifications: [verdict({ row: fresh.id }), verdict({ row: fresh.id }), verdict({ row: row.id })] })));
  assert.deepEqual(once.value.classifications.map(item => item.row), [row.id, fresh.id]);

  // A batch that finds no journal has no head to address its refusal to.
  const lone = gateRecord(store, "g3:1", gateFailure(), "delta");
  const refusal = addressed(refusalOf(prepareJournalBatch(store,
    batchOf({ sources: [reference(lone)], classifications: [verdict({ row: row.id })] }, "delta"))), "row_unknown", "delta");
  assert.equal(refusal.at.ref, undefined);
  assert.equal(journalOf(store, "delta"), null);
});

test("C32 H1.0c an absent journal is not an empty one: a batch adding no row finds it missing, a standing journal takes an empty batch as a repeat", t => {
  const { store } = fixture(t);
  addressed(refusalOf(prepareJournalBatch(store, batchOf())), "journal_missing");
  addressed(refusalOf(prepareJournalBatch(store, batchOf({ classifications: [verdict({ row: "om-refusal:invented" })] }))), "journal_missing");
  assert.equal(journalOf(store), null);

  const source = gateRecord(store, "g3:1", gateFailure());
  const head = deliveredOf(recordRefusal(store, { project: PROJECT, source: reference(source) }));
  const empty = deliveredOf(prepareJournalBatch(store, batchOf()));
  assert.deepEqual(empty.writes, []);
  assert.deepEqual(empty.guards, [reference(head)]);
  assert.deepEqual(empty.result, reference(head));
  assert.deepEqual(empty.value, head.value);
});

test("C32 H1.0c a batch keeps the single path's order and bytes: rows as their sources are first named, decisions as asked, one source or decisions alone as the single preparation", t => {
  const { root, store } = fixture(t);
  const seed = (target: Store): Ref[] => [
    reference(gateRecord(target, "z:1", gateFailure({ gate: "GZ" }))),
    // Another record with the same content is another event and keeps its own row (T6).
    reference(gateRecord(target, "g3:2", gateFailure())),
    reference(gateRecord(target, "g5:1", gateFailure({ gate: "G5", refusals: [entry({ code: "work_not_atomic" }), entry()] }))),
    reference(gateRecord(target, "g3:1", gateFailure())),
  ];
  const sources = seed(store);
  const rows = deliveredOf(prepareJournalBatch(store, batchOf({ sources }))).value.rows;
  assert.equal(new Set(rows.map(row => row.id)).size, 5);
  assert.deepEqual(rows.map(row => row.source), [sources[0], sources[1], sources[2], sources[2], sources[3]]);
  const decisions = [rows[3]!, rows[0]!, rows[4]!].map((row, index) => verdict({ row: row.id, class: `class-${index}` }));
  // A source or a decision named twice is one; the first mention keeps its place.
  const batch = deliveredOf(prepareJournalBatch(store, batchOf({ sources: [...sources, sources[3], sources[0]],
    classifications: [...decisions, decisions[0]!] })));
  assert.deepEqual(batch.value.rows, rows);
  assert.deepEqual(batch.value.classifications.map(item => item.row), decisions.map(item => item.row));
  assert.deepEqual(batch.guards, [...sources, { id: journalId(PROJECT), absent: true }]);

  // The single operations one after another — each record in the order named, then each decision in the order asked —
  // leave the very journal this one write creates.
  const sequential = new Store(join(root, "sequential.sqlite")); t.after(() => sequential.close());
  assert.deepEqual(seed(sequential), sources);
  for (const source of sources) deliveredOf(recordRefusal(sequential, { project: PROJECT, source }));
  for (const decision of decisions) deliveredOf(classifyRefusal(sequential, { project: PROJECT, ...decision }));
  assert.deepEqual(journalOf(sequential)!.value, batch.value);
  assert.equal(journalOf(sequential)!.hash, batch.result.hash);

  // On a standing journal, a batch of one source is the single record's preparation, and a batch of decisions alone is
  // the single classification's — in an order that is not the rows' own.
  const added = reference(gateRecord(sequential, "g4:1", gateFailure({ gate: "G4" })));
  assert.deepEqual(transition(deliveredOf(prepareJournalBatch(sequential, batchOf({ sources: [added] })))),
    { ...deliveredOf(prepareRecordRefusal(sequential, { project: PROJECT, source: added })) });
  const late = [rows[2]!, rows[1]!].map(row => verdict({ row: row.id, class: "late" }));
  assert.deepEqual(transition(deliveredOf(prepareJournalBatch(sequential, batchOf({ classifications: late })))),
    { ...deliveredOf(prepareClassifyRefusal(sequential, { project: PROJECT, classifications: late })) });

  // A source named several times is one source, read from the store once within the batch.
  let reads = 0;
  const counted = counting(store, id => { if (id === sources[3]!.id) reads += 1; });
  const thrice = deliveredOf(prepareJournalBatch(counted, batchOf({ sources: [sources[3], sources[3], sources[3]] })));
  assert.equal(reads, 1);
  assert.equal(thrice.value.rows.length, 1);
});

test("C32 H1.0c every argument of the batch is checked for its shape before the store is read, as a typed defect and never a TypeError", t => {
  const { store } = fixture(t);
  let reads = 0;
  const counted = counting(store, () => { reads += 1; });
  const pending = pendingWrite("staged:1", stagedFailure());
  const good = batchOf({ sources: [pendingRef(pending)], pending: [pending], classifications: [verdict({ row: "om-refusal:any" })] });
  // No default argument stands in for a broken store: an explicit undefined would quietly become the real one.
  const defectOf = (journal: unknown, request: unknown): void => {
    assert.throws(() => prepareJournalBatch(journal as Store, request as JournalBatchRequest), code("journal_request_invalid"));
  };
  const defect = (request: unknown): void => defectOf(counted, request);

  for (const broken of [null, undefined, "store", 7, {}, { get: () => null, writeMany: () => [] }]) defectOf(broken, good);
  for (const request of [null, undefined, "request", 7, [good]]) defect(request);
  for (const project of [undefined, null, "", 7, {}, "alpha:beta", ":", "a".repeat(200)]) defect({ ...good, project });
  for (const key of ["sources", "pending", "classifications"] as const) {
    defect(without({ ...good }, key));
    for (const broken of [undefined, null, key, 7, {}]) defect({ ...good, [key]: broken });
  }
  defect({ ...good, trusted: true });
  // A request that is not JSON — an undefined or an infinite number where a reference stands — is the caller's defect.
  defect({ ...good, sources: [pendingRef(pending), undefined] });
  defect({ ...good, sources: [{ ...pendingRef(pending), revision: Number.NaN }] });
  for (const write of [null, undefined, "write", 7, [], {}, without({ ...pending }, "value"), { ...pending, value: undefined },
    { ...pending, id: "" }, { ...pending, kind: 7 }, { ...pending, expected: 1 }, { ...pending, expected: -1 }, { ...pending, expected: "0" },
    { ...pending, value: { count: Number.NaN } }, { ...pending, value: () => 1 }, { ...pending, verified: true }]) {
    defect({ ...good, pending: [write] });
  }
  // Each pending write is written once and stands for a source the batch names.
  defect({ ...good, pending: [pending, pending] });
  defect({ ...good, sources: [], pending: [pending] });
  for (const item of [null, undefined, "row", 7, {}, without({ ...verdict() }, "addressee"), { ...verdict(), basis: [{ role: "proposal" }] },
    { ...verdict(), basis: null }]) {
    defect({ ...good, classifications: [item] });
  }
  assert.equal(reads, 0);

  // A malformed reference in JSON is data, as on the single path: an addressed refusal, still before the store is read.
  for (const broken of [null, "reference", 7, {}, { id: pending.id, revision: 1 }, { ...pendingRef(pending), revision: 0 }]) {
    addressed(refusalOf(prepareJournalBatch(counted, { ...good, sources: [pendingRef(pending), broken as Ref] })), "reference_invalid");
  }
  assert.equal(reads, 0);
  assert.equal(journalOf(store), null);
});

// The base the accepted single-row preparations must keep their output against (C34, C68).
const BASE_COMMIT = "4e4351f65b6cf5e93683fcc874f2938437c21eb3";

// One program runs the same steps twice, each time in its own process: once on the code of this tree, once on the
// base loaded whole from Git. Only the modules differ, never the steps or the reading of their results. What the steps
// produced is printed as ONE text, refusals and thrown defects with their messages and details, and compared as text.
function journalRun(root: string, database: string, steps: readonly unknown[], base: boolean): { batch: string; text: string; outputs: unknown[]; history: unknown[] } {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const loader = join(root, "journal-base-loader.mjs"), runner = join(root, "journal-runner.mjs");
  const input = join(root, `journal-steps-${base ? "base" : "current"}.json`);
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
    const source = execFileSync('git', ['show', '${BASE_COMMIT}:' + relative],
      { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 10000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}`);
  writeFileSync(runner, `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database, input] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { EngineError } = await import(src('errors.js'));
const { writeGuarded } = await import(src('om/refs.js'));
const journal = await import(src('om/refusal-journal.js'));
const steps = JSON.parse(readFileSync(input, 'utf8')), store = new Store(database), outputs = [];
const attempt = run => {
  try { return { result: run() }; }
  catch (error) {
    if (error instanceof EngineError) return { throws: { code: error.code, message: error.message, details: error.details } };
    throw error;
  }
};
try {
  for (const step of steps) outputs.push(attempt(() => {
    switch (step.op) {
      case 'prepareRecord': return journal.prepareRecordRefusal(store, step.request);
      case 'record': return journal.recordRefusal(store, step.request);
      case 'prepareClassify': return journal.prepareClassifyRefusal(store, step.request);
      case 'classify': return journal.classifyRefusal(store, step.request);
      case 'read': return journal.readJournal(store, step.request);
      case 'apply': {
        const prepared = outputs[step.of].result.value;
        return writeGuarded(store, { unit: 'compat', target: prepared.writes[0].id, writes: [...prepared.writes], guards: [...prepared.guards] });
      }
      default: throw new Error('unknown step ' + step.op);
    }
  }));
  process.stdout.write(typeof journal.prepareJournalBatch + '\\n' + JSON.stringify({ outputs,
    history: store.list().map(record => [record.id, record.revision, record.hash]) }));
} finally { store.close(); }`);
  writeFileSync(input, JSON.stringify(steps));
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},
    { data: { root: ${JSON.stringify(pathToFileURL(repository).href)} } });`;
  const flags = base ? ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`] : [];
  const printed = execFileSync(process.execPath, [...flags, runner, repository, database, input],
    { cwd: repository, encoding: "utf8", timeout: 120_000, maxBuffer: 10_000_000 });
  const split = printed.indexOf("\n");
  const text = printed.slice(split + 1);
  return { batch: printed.slice(0, split), text, ...(JSON.parse(text) as { outputs: unknown[]; history: unknown[] }) };
}

test("C34 C68 H1.0c a journal of the base 4e4351f is continued byte for byte as the base continues it, and a new journal is created in the explicit new form", t => {
  const { root, store } = fixture(t);
  const frame: FrameRequest = { project: PROJECT, level: 2, graph: BASE, horizon: refTo("om-horizon-gate:alpha:one"),
    layer: null, frame: null, upper: null };
  const contextual: OriginSource = { role: "proposal", ref: PROPOSAL, context: { kind: "proposal",
    request: { frame, proposals: [refTo("om-proposal:alpha:z"), PROPOSAL] } } };
  // The same records in every store: a hash is the hash of content, so every step addresses the same references.
  const seed = (target: Store): Record<string, Ref> => {
    const records: Record<string, Ref> = {
      g3: reference(gateRecord(target, "g3:1", gateFailure())),
      g5: reference(gateRecord(target, "g5:1", gateFailure({ gate: "G5",
        refusals: [entry({ code: "work_not_atomic" }), entry({ code: "layer_port_unbound", origin: origin({ subject: "port:cart:in" }) })] }))),
      g4: reference(gateRecord(target, "g4:1", gateFailure({ gate: "G4", refusals: [entry(), entry()] }))),
      broken: reference(gateRecord(target, "g3:2", gateFailure({ refusals: [] }))),
      context: reference(gateRecord(target, "ctx:1", gateFailure({ refusals: [entry({ origin: origin({ sources: [contextual, contextual] }) })] }))),
      foreign: reference(gateRecord(target, "g3:1", gateFailure(), "beta")),
      forgedSource: reference(gateRecord(target, "g3:1", gateFailure(), "forged")),
    };
    const moved = gateRecord(target, "g6:1", gateFailure({ gate: "G6" }));
    target.write({ id: moved.id, kind: UNIT_REFUSAL_KIND, expected: 1, value: gateFailure({ gate: "G6", refusals: [entry({ code: "repository_dirty" })] }) });
    records['moved'] = reference(moved);
    target.write({ id: journalId("forged"), kind: REFUSAL_JOURNAL_KIND, expected: 0, value: { projectId: "forged", rows: ["a row"], classifications: [] } });
    return records;
  };
  const refs = seed(store);
  const rowsOf = (source: Ref): string[] => deliveredOf(prepareRecordRefusal(store, { project: PROJECT, source })).value.rows.map(row => row.id);
  const [g3] = rowsOf(refs['g3']!), [g5a, g5b] = rowsOf(refs['g5']!), [g4] = rowsOf(refs['g4']!);
  const decide = (row: string, over: Record<string, unknown> = {}) => verdict({ row, ...over });
  const record = (source: unknown, project = PROJECT) => ({ project, source });
  const steps: unknown[] = [
    { op: "prepareRecord", request: record(refs['g3']) },
    { op: "prepareClassify", request: { project: PROJECT, classifications: [decide(g3!)] } },
    { op: "record", request: record(refs['g3']) },
    { op: "prepareRecord", request: record(refs['g3']) },
    { op: "record", request: record(refs['g3']) },
    { op: "prepareRecord", request: record(refs['g5']) },
    { op: "record", request: record(refs['g5']) },
    { op: "prepareRecord", request: record(refs['g4']) },
    { op: "record", request: record(refs['g4']) },
    { op: "prepareRecord", request: record(refs['broken']) },
    { op: "prepareRecord", request: record({ ...refs['g3']!, hash: hex("d") }) },
    { op: "prepareRecord", request: record(refs['foreign']) },
    { op: "prepareRecord", request: record({ id: refs['g3']!.id, revision: 1 }) },
    { op: "prepareRecord", request: record(refs['moved']) },
    { op: "record", request: record(refs['moved']) },
    { op: "prepareClassify", request: { project: PROJECT, classifications: [decide(g3!, { class: "proposal" }), decide(g5a!), decide(g5b!, { basis: [] })] } },
    // The index of the output it applies within the continued run, which starts after the three creation steps.
    { op: "apply", of: 12 },
    { op: "prepareClassify", request: { project: PROJECT, classifications: [decide(g5b!, { basis: [] }), decide(g3!, { class: "proposal" })] } },
    { op: "classify", request: { project: PROJECT, ...decide(g4!, { class: "unknown", addressee: "owner" }) } },
    { op: "classify", request: { project: PROJECT, ...decide(g4!, { class: "unknown", addressee: "owner" }) } },
    { op: "classify", request: { project: PROJECT, ...decide(g4!, { class: "derivation" }) } },
    { op: "classify", request: { project: PROJECT, ...decide("om-refusal:invented") } },
    { op: "prepareClassify", request: { project: PROJECT, classifications: [decide(g4!, { class: "unknown", addressee: "owner" }), decide("om-refusal:invented")] } },
    { op: "prepareClassify", request: { project: PROJECT, classifications: [] } },
    { op: "classify", request: { project: "gamma", ...decide(g3!) } },
    { op: "record", request: record(refs['forgedSource'], "forged") },
    { op: "classify", request: { project: "forged", ...decide(g3!) } },
    { op: "prepareRecord", request: record(refs['context']) },
    { op: "record", request: record(refs['context']) },
    { op: "prepareRecord", request: null },
    { op: "read", request: { project: PROJECT } },
    { op: "prepareClassify", request: { project: PROJECT, classifications: [{ ...decide(g3!), basis: [{ role: "proposal" }] }] } },
    { op: "prepareRecord", request: record(refs['g3'], "alpha:beta") },
  ];
  const era = join(root, "era.sqlite"), current = join(root, "current.sqlite"), base = join(root, "base.sqlite");
  const fresh = join(root, "fresh.sqlite"), freshBase = join(root, "fresh-base.sqlite");
  for (const path of [era, fresh, freshBase]) {
    const target = new Store(path);
    try { assert.deepEqual(seed(target), refs); } finally { target.close(); }
  }
  // Q3 (№2573-2): the journal is created by the base 4e4351f — a journal of its era — and both codes then continue it on
  // identical copies: what the base did to it, the current code does byte for byte, by the rule of that era.
  const created = journalRun(root, era, [steps[2]!], true).outputs as { result: { ok: boolean } }[];
  assert.equal(created[0]!.result.ok, true);
  for (const path of [current, base]) copyFileSync(era, path);
  const continued = steps.slice(3);
  const mine = journalRun(root, current, continued, false);
  const theirs = journalRun(root, base, continued, true);
  // Each run is what it says: this tree has the batch, the base does not.
  assert.equal(mine.batch, "function");
  assert.equal(theirs.batch, "undefined");
  // Byte for byte: the printed outputs — writes, guards, values, refusals, thrown defects with message and details —
  // and the records each store holds afterwards.
  assert.equal(mine.text, theirs.text);

  // And the comparison is not empty: it walked writes, repeats, both guard shapes and every refusal it names.
  type Output = { result?: { ok: boolean; value?: { writes?: unknown[]; guards?: Ref[] }; refusal?: { code: string } };
    throws?: { code: string; message: string } };
  const outputs = mine.outputs as Output[];
  assert.equal(outputs.length, continued.length);
  assert.deepEqual([outputs[0]!.result!.value!.writes, outputs[0]!.result!.value!.guards], [[], []]);
  // C68: frame-accept.ts:214 finds the previous head among these guards, after the source.
  const previous = outputs[2]!.result!.value!.guards!;
  assert.deepEqual(previous.map(ref => ref.id), [refs['g5']!.id, journalId(PROJECT)]);
  assert.equal(previous.find(ref => ref.id === journalId(PROJECT))!.revision, 1);
  const codes = new Set(outputs.map(item => item.throws?.code ?? (item.result!.ok ? "ok" : item.result!.refusal!.code)));
  for (const expected of ["ok", "journal_missing", "refusals_missing", "record_forged", "record_foreign", "reference_invalid", "input_stale",
    "classification_conflict", "row_unknown", "journal_invalid", "journal_request_invalid"]) assert.ok(codes.has(expected), expected);
  // The thrown defects carry their messages into the comparison, several different ones among them.
  assert.ok(new Set(outputs.flatMap(item => item.throws ? [item.throws.message] : [])).size >= 3);

  // The era: the journal the base wrote reads in this tree, after a restart, as the one this tree wrote, and a batch of
  // every source it holds with every decision it holds is a repeat of it.
  const written = new Store(base); t.after(() => written.close());
  const head = deliveredOf(readJournal(written, { project: PROJECT }));
  assert.deepEqual(JSON.parse(JSON.stringify(head)), (outputs[27]!.result as { value: unknown }).value);
  assert.deepEqual(deliveredOf(readJournalAt(written, PROJECT, reference(head))), head);
  const repeat = deliveredOf(prepareJournalBatch(written, batchOf({ sources: [refs['g3']!, refs['g5']!, refs['g4']!, refs['context']!],
    classifications: [...head.value.classifications] })));
  assert.deepEqual([repeat.writes, repeat.guards, repeat.result], [[], [reference(head)], reference(head)]);
  assert.deepEqual(repeat.value, head.value);
  assert.equal(Object.hasOwn(head.value, "sourceOrder"), false, "A journal of the base era stays unmarked when the current code continues it");

  // A journal the current code CREATES is of the explicit new form, marked on its preparation and its revision; the base
  // creates the same journal unmarked. The two creations differ by the era they name, not by the rows of a one-source refusal.
  type Created = { result: { ok: boolean; value: { guards?: Ref[]; value: Record<string, unknown> } } };
  const creation = [steps[0]!, steps[2]!];
  const newForm = journalRun(root, fresh, creation, false).outputs as Created[];
  const baseForm = journalRun(root, freshBase, creation, true).outputs as Created[];
  assert.deepEqual(newForm[0]!.result.value.guards, [refs['g3']]);
  assert.equal(newForm[0]!.result.value.value["sourceOrder"], SOURCE_ORDER);
  assert.equal(newForm[1]!.result.value.value["sourceOrder"], SOURCE_ORDER);
  assert.equal(Object.hasOwn(baseForm[1]!.result.value.value, "sourceOrder"), false);
  assert.deepEqual(newForm[1]!.result.value.value["rows"], baseForm[1]!.result.value.value["rows"]);
  const reread = new Store(fresh); t.after(() => reread.close());
  assert.equal(deliveredOf(readJournal(reread, { project: PROJECT })).value.sourceOrder, SOURCE_ORDER);
});

// ---- H1.0c S1: the marks of G4b, the typed reader registry and the ban on classifying a G4b row (C19, C21, C36, №1628).
// The registry is process state, so every scenario that needs a reader — or needs to be sure there is none — runs in a
// child process that imports refusal-journal and its leaves only. The reader there is synthetic: it proves nothing about
// G4b itself (its real reader belongs to answers-gate); it lets the test see WHEN the journal calls it and on what view.
type ChildOutput = Record<string, unknown>;
function answersChild(root: string, database: string, body: string): ChildOutput {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const script = join(root, `answers-child-${hashJson(body).slice(0, 12)}.mjs`);
  writeFileSync(script, `import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository, database] = process.argv.slice(2);
const src = path => pathToFileURL(join(repository, 'dist/src', path)).href;
const { Store } = await import(src('storage/store.js'));
const { EngineError } = await import(src('errors.js'));
const { hashJson } = await import(src('canonical.js'));
const { refused } = await import(src('om/refusal.js'));
const { writeGuarded } = await import(src('om/refs.js'));
const journal = await import(src('om/refusal-journal.js'));
const PROJECT = ${JSON.stringify(PROJECT)};
const ns = journal.unitRefusalNamespace(PROJECT);
const hex = seed => seed.repeat(64).slice(0, 64);
const ref = record => ({ id: record.id, revision: record.revision, hash: record.hash });
const proof = { id: 'om-answers-gate:' + PROJECT + ':finding:' + hex('f'), revision: 1, hash: hex('e') };
const g4bEntry = (over = {}, origin = {}) => ({ code: 'answer_missing', goal: 'every gap of the goal is answered',
  remedy: 'answer the gap', origin: { name: 'answer_missing', stage: 'answers-gate/v1', subject: 'node:cart',
  sources: [{ role: 'answers-finding', ref: proof }], ...origin }, ...over });
const g4b = (over = {}, origin = {}) => ({ gate: 'G4b', refusals: [g4bEntry({}, origin)], ...over });
const g3 = (over = {}) => ({ gate: 'G3', refusals: [{ code: 'graph_invalid', goal: 'every artifact is produced',
  remedy: 'add the producer', origin: { name: 'artifact_missing', stage: 'candidate-assembly', subject: 'artifact:cart',
  sources: [{ role: 'proposal', ref: { id: 'layer-proposal:alpha:7', revision: 2, hash: hex('b') } }] } }], ...over });
const put = (id, value) => store.write({ id, kind: journal.UNIT_REFUSAL_KIND, expected: 0, value });
const pendingOf = (id, value) => ({ id, kind: journal.UNIT_REFUSAL_KIND, expected: 0, value });
const pendingRef = (id, value) => ({ id, revision: 1, hash: hashJson(value) });
const batch = over => ({ project: PROJECT, sources: [], pending: [], classifications: [], ...over });
const attempt = run => {
  try { return { result: run() }; }
  catch (error) {
    if (error instanceof EngineError) return { throws: { code: error.code, message: error.message, details: error.details } };
    throw error;
  }
};
const calls = [], refuse = new Set();
const reader = (view, project, source) => {
  const standing = view.get(source.id, source.revision);
  calls.push({ project, id: source.id, seen: standing !== null && standing.hash === source.hash });
  return refuse.has(source.id)
    ? refused('answers_evaluation_invalid', 'The synthetic reader does not prove this source', { unit: 'answers-gate', target: source.id, field: 'proof' }, 'producer')
    : { ok: true, value: null };
};
const out = {};
const store = new Store(database);
try {
${body}
} finally { store.close(); }
process.stdout.write(JSON.stringify(out));`);
  const printed = execFileSync(process.execPath, [script, repository, database],
    { cwd: repository, encoding: "utf8", timeout: 120_000, maxBuffer: 10_000_000 });
  return JSON.parse(printed) as ChildOutput;
}

type Outcome = { result?: OmResult<unknown>; throws?: { code: string; message: string; details: Record<string, unknown> } };
const refusedWith = (outcome: unknown, expected: string, field?: string): Refusal => {
  const { result } = outcome as Outcome;
  assert.ok(result, `expected a refusal ${expected}, got a thrown defect ${JSON.stringify(outcome)}`);
  const refusal = refusalOf(result);
  assert.equal(refusal.code, expected, JSON.stringify(refusal));
  if (field !== undefined) assert.equal(refusal.at.field, field, JSON.stringify(refusal));
  return refusal;
};
const deliveredIn = <T>(outcome: unknown): T => {
  const { result } = outcome as Outcome;
  assert.ok(result, `expected a delivered value, got ${JSON.stringify(outcome)}`);
  return deliveredOf(result as OmResult<T>);
};

test("C36 H1.0c without a loaded typed reader a G4b source is refused on every path, and a journal holding one does not read", t => {
  const { root } = fixture(t);
  const database = join(root, "closed.sqlite");
  // A process with the reader journals one exact G4b source beside an ordinary one.
  const written = answersChild(root, database, `
journal.registerAnswersSourceReader(reader);
out.g4b = ref(put(ns + 'g4b:' + hex('1'), g4b()));
out.second = ref(put(ns + 'g4b:' + hex('2'), g4b({}, { subject: 'node:order' })));
out.g3 = ref(put(ns + 'g3:1', g3()));
out.recorded = attempt(() => journal.recordRefusal(store, { project: PROJECT, source: out.g4b }));
out.ordinary = attempt(() => journal.recordRefusal(store, { project: PROJECT, source: out.g3 }));
out.calls = calls;`);
  const recorded = deliveredIn<Revision<RefusalJournal>>(written['recorded']);
  assert.deepEqual(recorded.value.rows.map(row => row.gate), ["G4b"]);
  const head = reference(deliveredIn<Revision<RefusalJournal>>(written['ordinary']));
  assert.ok((written['calls'] as unknown[]).length > 0);

  // A process that imports the journal alone: no reader is registered, and nothing is admitted on its shape.
  const closed = answersChild(root, database, `
out.loaded = Object.keys(journal).includes('registerAnswersSourceReader');
out.record = attempt(() => journal.prepareRecordRefusal(store, { project: PROJECT, source: ${JSON.stringify(written['second'])} }));
const other = 'om-refusal-journal:other';
out.fresh = attempt(() => journal.prepareJournalBatch(store, batch({ project: 'other',
  sources: [pendingRef('om-unit-refusal:other:g4b:' + hex('3'), g4b())], pending: [pendingOf('om-unit-refusal:other:g4b:' + hex('3'), g4b())] })));
out.read = attempt(() => journal.readJournal(store, { project: PROJECT }));
out.readAt = attempt(() => journal.readJournalAt(store, PROJECT, ${JSON.stringify(head)}));
out.ordinary = attempt(() => journal.prepareRecordRefusal(store, { project: PROJECT, source: ${JSON.stringify(written['g3'])} }));
out.classify = attempt(() => journal.prepareClassifyRefusal(store, { project: PROJECT, classifications: [{ row: 'any', class: 'input', addressee: 'x', basis: [] }] }));
out.untouched = store.get(other) === null && store.history('om-refusal-journal:' + PROJECT).length;`);
  assert.equal(closed['loaded'], true);
  const refusal = refusedWith(closed['record'], "refusal_record_invalid", "reader");
  assert.deepEqual(refusal.at.ref, written['second']);
  assert.equal(refusal.at.unit, UNIT);
  refusedWith(closed['fresh'], "refusal_record_invalid", "reader");
  // The journal that already holds a G4b row is not read without the reader either, on the head and at its reference,
  // so nothing appended to it or classified in it can stand on an unproved row.
  for (const key of ["read", "readAt", "ordinary", "classify"]) {
    const broken = refusedWith(closed[key], "journal_invalid", "rows.0.source");
    assert.match(broken.message, /reader/);
  }
  assert.equal(closed['untouched'], 2);

  // The reader loaded again, the same journal reads as it was written.
  const reopened = answersChild(root, database, `
journal.registerAnswersSourceReader(reader);
out.read = attempt(() => journal.readJournalAt(store, PROJECT, ${JSON.stringify(head)}));`);
  assert.deepEqual(reference(deliveredIn<Revision<RefusalJournal>>(reopened['read'])), head);
});

test("C19 C21 H1.0c a G4b source with any E5 mark, a contradicting mark or a single mark removed is refused before its reader, on the single path and in the batch", t => {
  const { root } = fixture(t);
  const out = answersChild(root, join(root, "marks.sqlite"), `
journal.registerAnswersSourceReader(reader);
const variants = {
  e5Namespace: [ns + 'e5:' + hex('1'), g4b()],
  e5Stage: [ns + 'g4b:' + hex('2'), g4b({}, { stage: 'fact-assessment' })],
  e5Role: [ns + 'g4b:' + hex('3'), g4b({}, { sources: [{ role: 'assessment', ref: proof }] })],
  e5Beside: [ns + 'g4b:' + hex('4'), g4b({}, { sources: [{ role: 'answers-finding', ref: proof }, { role: 'assessment', ref: proof }] })],
  noGate: [ns + 'g4b:' + hex('5'), g4b({ gate: 'G3' })],
  noSegment: [ns + 'g3:' + hex('6'), g4b()],
  noStage: [ns + 'g4b:' + hex('7'), g4b({}, { stage: 'candidate-assembly' })],
  noRole: [ns + 'g4b:' + hex('8'), g4b({}, { sources: [{ role: 'proposal', ref: proof }] })],
  noSource: [ns + 'g4b:' + hex('9'), g4b({}, { sources: [] })],
  twoRefusals: [ns + 'g4b:' + hex('a'), g4b({ refusals: [g4bEntry(), g4bEntry({ code: 'answer_foreign' })] })],
  shortAddress: [ns + 'g4b:short', g4b()],
  foreignCase: [ns + 'g3:' + hex('b'), g3({ gate: 'g4B' })],
  roleOnly: [ns + 'g3:' + hex('c'), g3({ refusals: [{ ...g3().refusals[0], origin: { ...g3().refusals[0].origin,
    sources: [...g3().refusals[0].origin.sources, { role: 'Answers-Finding', ref: proof }] } }] })],
  stageOnly: [ns + 'e5:' + hex('d'), { gate: 'E5', refusals: [g4bEntry({}, { stage: 'answers-gate/v1', sources: [{ role: 'assessment', ref: proof }] })] }],
};
out.variants = {};
for (const [name, [id, value]] of Object.entries(variants)) {
  const stored = ref(put(id, value));
  out.variants[name] = {
    ref: stored,
    marks: journal.answersSourceMarks(PROJECT, stored, value),
    record: attempt(() => journal.prepareRecordRefusal(store, { project: PROJECT, source: stored })),
    batch: attempt(() => journal.prepareJournalBatch(store, batch({ sources: [stored] }))),
  };
}
// The same contradictions arriving as pending records of a batch, on a project whose store holds none of them.
out.pending = {};
for (const [name, [id, value]] of Object.entries(variants)) {
  const pid = id.replace(ns, journal.unitRefusalNamespace('beta'));
  out.pending[name] = attempt(() => journal.prepareJournalBatch(store, { project: 'beta', sources: [pendingRef(pid, value)], pending: [pendingOf(pid, value)], classifications: [] }));
}
out.callsBefore = calls.length;
// The exact form: admitted only by its reader, on the view that holds it — stored, and pending in a batch.
const exact = ref(put(ns + 'g4b:' + hex('e'), g4b()));
out.exactMarks = journal.answersSourceMarks(PROJECT, exact, g4b());
out.exact = attempt(() => journal.recordRefusal(store, { project: PROJECT, source: exact }));
const pid = ns + 'g4b:' + hex('0');
out.exactPending = attempt(() => journal.prepareJournalBatch(store, batch({ sources: [pendingRef(pid, g4b({}, { subject: 'node:order' }))], pending: [pendingOf(pid, g4b({}, { subject: 'node:order' }))] })));
out.pendingStands = store.get(pid) !== null;
out.rowMarks = out.exact.result?.ok ? out.exact.result.value.value.rows.map(row => journal.answersRowMarks(PROJECT, row)) : null;
// The reader's own refusal reaches the caller as it is; a journal whose G4b row its reader no longer proves does not read.
refuse.add(pid);
out.refusedPending = attempt(() => journal.prepareJournalBatch(store, batch({ sources: [pendingRef(pid, g4b({}, { subject: 'node:order' }))], pending: [pendingOf(pid, g4b({}, { subject: 'node:order' }))] })));
refuse.add(exact.id);
out.refusedStored = attempt(() => journal.prepareRecordRefusal(store, { project: PROJECT, source: exact }));
out.refusedJournal = attempt(() => journal.readJournal(store, { project: PROJECT }));
refuse.clear();
// Ordinary records never reach the reader.
const before = calls.length;
const ordinary = ref(put(ns + 'g3:plain', g3()));
out.ordinaryMarks = journal.answersSourceMarks(PROJECT, ordinary, g3());
out.ordinary = attempt(() => journal.recordRefusal(store, { project: PROJECT, source: ordinary }));
const row = out.ordinary.result?.ok ? out.ordinary.result.value.value.rows.find(item => item.gate === 'G3').id : 'none';
out.classified = attempt(() => journal.prepareClassifyRefusal(store, { project: PROJECT, classifications: [{ row, class: 'input', addressee: 'stage:x', basis: [] }] }));
out.readerOnOrdinary = calls.slice(before).filter(call => !call.id.includes(':g4b:')).length;
out.calls = calls;
out.malformed = [
  attempt(() => journal.answersSourceMarks('a:b', exact, g4b())),
  attempt(() => journal.answersSourceMarks(PROJECT, { id: exact.id }, g4b())),
  attempt(() => journal.answersRowMarks(PROJECT, null)),
  attempt(() => journal.answersRowMarks(PROJECT, { gate: 'G4b' })),
  { result: { ok: true, value: journal.answersSourceMarks(PROJECT, exact, null) } },
  { result: { ok: true, value: journal.answersSourceMarks(PROJECT, exact, { gate: 'G4b', refusals: 'many' }) } },
];`);
  type Variant = { ref: Ref; marks: { any: boolean; exact: boolean }; record: unknown; batch: unknown };
  const variants = out['variants'] as Record<string, Variant>;
  assert.equal(Object.keys(variants).length, 14);
  for (const [name, variant] of Object.entries(variants)) {
    assert.deepEqual(variant.marks, { any: true, exact: false }, name);
    for (const path of [variant.record, variant.batch]) {
      const refusal = refusedWith(path, "refusal_record_invalid", "markers");
      assert.deepEqual(refusal.at.ref, variant.ref, name);
    }
    refusedWith((out['pending'] as Record<string, unknown>)[name], "refusal_record_invalid", "markers");
  }
  // Not one contradiction reached the reader: the journal refuses it by its marks, not on the reader's word.
  assert.equal(out['callsBefore'], 0);

  assert.deepEqual(out['exactMarks'], { any: true, exact: true });
  const exact = deliveredIn<Revision<RefusalJournal>>(out['exact']);
  assert.deepEqual(exact.value.rows.map(row => [row.gate, row.origin.stage, row.origin.sources.map(source => source.role)]),
    [["G4b", "answers-gate/v1", ["answers-finding"]]]);
  assert.deepEqual(out['rowMarks'], [{ any: true, exact: true }]);
  const pending = deliveredIn<JournalBatch>(out['exactPending']);
  assert.equal(pending.writes.length, 2);
  assert.equal(out['pendingStands'], false);
  type Call = { project: string; id: string; seen: boolean };
  const calls = out['calls'] as Call[];
  // The reader saw every G4b source it was asked about — the pending one on the batch's view of its write.
  assert.ok(calls.length >= 3);
  assert.ok(calls.every(call => call.project === PROJECT && call.seen && call.id.includes(":g4b:")));
  assert.ok(calls.some(call => call.id === pending.writes[0]!.id));

  const refusedPending = refusedWith(out['refusedPending'], "answers_evaluation_invalid", "proof");
  assert.equal(refusedPending.at.unit, "answers-gate");
  refusedWith(out['refusedStored'], "answers_evaluation_invalid", "proof");
  const journalBroken = refusedWith(out['refusedJournal'], "journal_invalid", "rows.0.source");
  assert.match(journalBroken.message, /answers_evaluation_invalid/);

  assert.deepEqual(out['ordinaryMarks'], { any: false, exact: false });
  deliveredIn(out['ordinary']);
  deliveredIn(out['classified']);
  assert.equal(out['readerOnOrdinary'], 0);

  const malformed = out['malformed'] as Outcome[];
  for (const item of malformed.slice(0, 4)) assert.equal(item.throws?.code, "journal_request_invalid", JSON.stringify(item));
  assert.deepEqual(malformed.slice(4).map(item => (item.result as { value: unknown }).value),
    [{ any: true, exact: false }, { any: true, exact: false }]);
});

test("C36 H1.0c no classification of a G4b row stands: the single, the set and the batch refuse it by address, and a planted one breaks every reading", t => {
  const { root } = fixture(t);
  const database = join(root, "classified.sqlite");
  const out = answersChild(root, database, `
journal.registerAnswersSourceReader(reader);
const source = ref(put(ns + 'g4b:' + hex('1'), g4b()));
const plain = ref(put(ns + 'g3:1', g3()));
journal.recordRefusal(store, { project: PROJECT, source });
const head = journal.recordRefusal(store, { project: PROJECT, source: plain }).value;
const [answersRow, plainRow] = head.value.rows.map(row => row.id);
const decision = row => ({ row, class: 'unknown', addressee: 'owner', basis: [{ role: 'answers-finding', ref: proof }] });
out.head = ref(head);
out.single = attempt(() => journal.classifyRefusal(store, { project: PROJECT, ...decision(answersRow) }));
out.set = attempt(() => journal.prepareClassifyRefusal(store, { project: PROJECT, classifications: [decision(plainRow), decision(answersRow)] }));
out.batch = attempt(() => journal.prepareJournalBatch(store, batch({ classifications: [decision(answersRow)] })));
const pid = ns + 'g4b:' + hex('2'), value = g4b({}, { subject: 'node:order' });
const probe = journal.prepareJournalBatch(store, batch({ sources: [pendingRef(pid, value)], pending: [pendingOf(pid, value)] }));
const added = probe.value.value.rows.at(-1).id;
out.sameBatch = attempt(() => journal.prepareJournalBatch(store, batch({ sources: [pendingRef(pid, value)], pending: [pendingOf(pid, value)], classifications: [decision(added)] })));
out.untouched = store.history('om-refusal-journal:' + PROJECT).length;
// The ordinary row is still classified exactly as before.
out.plain = attempt(() => journal.prepareClassifyRefusal(store, { project: PROJECT, classifications: [decision(plainRow)] }));
// A classification written around the journal's checks, held in the very shape the journal writes one.
const planted = { ...head.value, classifications: [decision(answersRow)] };
out.planted = ref(store.write({ id: head.id, kind: journal.REFUSAL_JOURNAL_KIND, expected: head.revision, value: planted }));
out.readPlanted = attempt(() => journal.readJournal(store, { project: PROJECT }));
out.readPlantedAt = attempt(() => journal.readJournalAt(store, PROJECT, out.planted));
out.readEarlier = attempt(() => journal.readJournalAt(store, PROJECT, out.head));
out.recordOnPlanted = attempt(() => journal.prepareRecordRefusal(store, { project: PROJECT, source: plain }));
out.batchOnPlanted = attempt(() => journal.prepareJournalBatch(store, batch({})));`);
  const head = out['head'] as Ref;
  for (const key of ["single", "set", "batch"]) {
    const refusal = refusedWith(out[key], "classification_invalid", "row");
    assert.equal(refusal.at.unit, UNIT);
    assert.equal(refusal.at.target, journalId(PROJECT));
    assert.deepEqual(refusal.at.ref, head);
  }
  // A row the same batch adds is refused alike (C69 does not open a door for it), and nothing was written.
  refusedWith(out['sameBatch'], "classification_invalid", "row");
  assert.equal(out['untouched'], 2);
  assert.equal(deliveredIn<JournalTransition>(out['plain']).writes.length, 1);

  for (const key of ["readPlanted", "readPlantedAt", "recordOnPlanted", "batchOnPlanted"]) {
    const refusal = refusedWith(out[key], "journal_invalid", "classifications.0.row");
    assert.deepEqual(refusal.at.ref, out['planted']);
  }
  // The revision before the forgery still reads: the forgery is refused where it stands, not back through history.
  assert.deepEqual(reference(deliveredIn<Revision<RefusalJournal>>(out['readEarlier'])), head);
});

test("C36 H1.0c the typed reader is registered once: the same again is a repeat, another one or a non-function is a typed defect", t => {
  const { root } = fixture(t);
  const out = answersChild(root, join(root, "registry.sqlite"), `
out.none = attempt(() => journal.registerAnswersSourceReader(undefined));
out.text = attempt(() => journal.registerAnswersSourceReader('reader'));
out.first = attempt(() => journal.registerAnswersSourceReader(reader));
out.again = attempt(() => journal.registerAnswersSourceReader(reader));
out.other = attempt(() => journal.registerAnswersSourceReader((view, project, source) => ({ ok: true, value: null })));
const source = ref(put(ns + 'g4b:' + hex('1'), g4b()));
out.recorded = attempt(() => journal.recordRefusal(store, { project: PROJECT, source }));
out.calls = calls.length;
out.markers = journal.G4B_MARKERS;
out.frozen = Object.isFrozen(journal.G4B_MARKERS);`);
  assert.equal((out['none'] as Outcome).throws?.code, "journal_request_invalid");
  assert.equal((out['text'] as Outcome).throws?.code, "journal_request_invalid");
  // Registration returns nothing: JSON drops the undefined result, and nothing was thrown.
  assert.deepEqual(out['first'], {});
  assert.deepEqual(out['again'], {});
  const conflict = (out['other'] as Outcome).throws!;
  assert.equal(conflict.code, "journal_reader_conflict");
  assert.equal(conflict.details['field'], "reader");
  // The first reader stays the one the journal asks.
  deliveredIn(out['recorded']);
  assert.ok((out['calls'] as number) >= 1);
  assert.deepEqual(out['markers'], { gate: "G4b", stage: "answers-gate/v1", role: "answers-finding", segment: "g4b:" });
  assert.equal(out['frozen'], true);
});

/**
 * A real journal-only G4b row: the answers-gate fixture of one addressed repository fact, a managed MC1 attempt opened
 * by G7 with its registered check, and one evaluation of the full G4b without a submission (№1446 row 8). The typed
 * reader is the real one of answers-gate, loaded (and registered) by this dynamic import.
 */
async function realAnswersRow(t: test.TestContext) {
  const { UPSTREAM_STAGES } = await import("../src/discovery/requirements.js");
  const { projectGraph } = await import("../src/graph/project.js");
  const { ProductEngine } = await import("../src/product/engine.js");
  const { inputDecisionWrite, writeAddressing } = await import("../src/om/addressing.js");
  const { prepareAnswerTask } = await import("../src/om/accepted-answer.js");
  const { writeAnswersEvaluation, writeAnswersRegistration } = await import("../src/om/answers-gate.js");
  const { writeGaps } = await import("../src/om/gaps.js");
  const { gapLineExpectedResult, gapLineKey } = await import("../src/om/gap-lines.js");
  const { writeHorizon } = await import("../src/om/horizon.js");
  const { writeOmInput } = await import("../src/om/input.js");
  const { openAttempt } = await import("../src/om/repeat-gate.js");
  const { writeRoutes } = await import("../src/om/routes.js");
  const { openSeries, readCompletionBinding } = await import("../src/om/series.js");
  const { gardenGraph } = await import("./om-fixture.js");
  const { preparedField } = await import("./preparation-fixture.js");
  const { preparedFeatures } = await import("./product-fixture.js");
  const take = <T>(result: OmResult<T>): T => { if (!result.ok) assert.fail(`${result.refusal.code}: ${result.refusal.message}`); return result.value; };
  const root = mkdtempSync(join(tmpdir(), "omg-om-journal-g4b-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = "garden", block = "garden-produce-block", target = "discovery:owner-choice";
  const engine = new ProductEngine(store);
  const { level: _level, ...l1 } = projectGraph(gardenGraph(), 1);
  preparedFeatures(engine, project, l1 as never, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Record<string, Json>)["unknowns"] = [{ id: "owner-choice",
      question: "Which output should this project use?", consumer: block, moment: "om-pass", blocksCurrentStage: false,
      resolution: "Resolve the named decision before assembling work" }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)]));
  const first = take(writeOmInput(store, { project, expected: 0, stages: stages as never }));
  const graph = store.get(`graph:${project}`)!;
  const input = take(writeAddressing(store, { project, input: reference(first), graph: reference(graph), decisions: [{ pending:
    structuredClone(inputDecisionWrite({ project, input: reference(first), graph: reference(graph), layers: [],
      decision: { target, field: "address", value: { consumer: block, kind: "repository-fact" } } })) as never }] }));
  const horizon = take(writeHorizon(store, { project, input: reference(input), graph: reference(graph), refinement: null,
    available: {}, choice: { choiceVersion: "journal-g4b", features: [{ outcome: "garden-result" }], excluded: [] } }));
  const gaps = take(writeGaps(store, { project, input: reference(input), graph: reference(graph), horizon: reference(horizon.gate),
    operations: { proposals: [], frame: { project, level: 2, graph: reference(graph), horizon: reference(horizon.gate),
      layer: null, frame: null, upper: null } },
    works: { state: "upper-not-accepted", layer: reference(store.get(`graph-layer:${project}:2`)!) } }));
  const gapRead = { sources: structuredClone(gaps.sources), records: gaps.records.map(reference) };
  const fact = gaps.records.find(row => row.value.gap.target === target && row.value.gap.kind === "repository-fact")!;
  const task = take(prepareAnswerTask(store, { project, input: reference(input), gaps: gapRead as never, gap: reference(fact),
    requirements: [{ pointer: "/contracts/0" }], resultForm: { type: "string" } }));
  const route = take(writeRoutes(store, { project, gaps: gapRead as never, catalog: { paths: [], records: [] }, previous: null,
    tasks: [task.writes.length ? { pending: structuredClone(task.writes[0]!) as never } : { record: reference(task.record) }] }));
  const batch = route.value.batches.find(item => item.model === "MC1" && item.items.some(item => item.target === target))!;
  const goal = { key: "journal:g4b", questions: batch.items.map(item => gapLineKey(project, item.target, item.field)),
    result: gapLineExpectedResult(project, batch.items[0]!.target, batch.items[0]!.field) };
  take(openSeries(store, { project, block, line: 1, slice: "journal:g4b", predecessor: null, basis: null }));
  const series = take(openAttempt(store, { project, block, line: 1, attempt: 1, goal,
    completion: { routes: reference(route), batches: [batch.id] } }));
  const binding = take(readCompletionBinding(store, project, reference(series), 1))!;
  take(writeAnswersRegistration(store, { project, binding: reference(binding) }));
  const evaluation = take(writeAnswersEvaluation(store, { project, binding: reference(binding),
    request: { project, gaps: gapRead as never, routes: reference(route), results: [] } }));
  const group = evaluation.groups[0]!;
  const journal = take(readJournal(store, { project }));
  const row = journal.value.rows.find(item => item.source.id === group.source.id)!;
  assert.ok(row, "The evaluation delivered its A2 row");
  return { store, project, row, journal, proof: group.proof, contribution: group.contribution };
}

test("37 X7 H1.0c a real journal-only G4b row is refused any classification by address, and a planted one breaks every reading", async t => {
  const { store, project, row, journal, proof, contribution } = await realAnswersRow(t);
  assert.deepEqual(contribution, { kind: "journal-only", wait: "submission", barrier: true });
  const decisions = [{ class: "proposal", addressee: `node:${row.origin.subject}` }, { class: "unknown", addressee: "origin" },
    { class: "readiness", addressee: "producer" }];
  const before = store.list().map(reference);
  for (const decision of decisions) {
    const request = { project, row: row.id, ...decision, basis: [{ role: "answers-finding", ref: proof }] };
    for (const [name, result] of [["single", classifyRefusal(store, request)],
      ["set", prepareClassifyRefusal(store, { project, classifications: [{ row: row.id, ...decision, basis: request.basis }] })],
      ["batch", prepareJournalBatch(store, { project, sources: [], pending: [], classifications: [{ row: row.id, ...decision, basis: request.basis }] })],
    ] as const) {
      assert.equal(result.ok, false, `${decision.class} ${name}`);
      if (!result.ok) assert.deepEqual([result.refusal.code, result.refusal.at.field, result.refusal.at.ref],
        ["classification_invalid", "row", reference(journal)], `${decision.class} ${name}`);
    }
  }
  assert.deepEqual(store.list().map(reference), before, "No classification of a journal-only row is written");
  const planted = store.write({ id: journal.id, kind: REFUSAL_JOURNAL_KIND, expected: journal.revision, value: { ...journal.value,
    classifications: [{ row: row.id, class: "unknown", addressee: "origin", basis: [normalizeOriginSource({ role: "answers-finding", ref: proof })] }] } });
  for (const result of [readJournal(store, { project }), readJournalAt(store, project, reference(planted))]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual([result.refusal.code, result.refusal.at.field], ["journal_invalid", "classifications.0.row"]);
  }
  const earlier = readJournalAt(store, project, reference(journal));
  assert.deepEqual(earlier.ok ? reference(earlier.value) : earlier.refusal.code, reference(journal),
    "The revision before the forgery still reads through the real typed reader");
});
