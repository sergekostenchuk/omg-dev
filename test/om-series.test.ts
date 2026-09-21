import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { REFUSAL_ROUTES, type OmResult, type Refusal } from "../src/om/refusal.js";
import { writeGuarded } from "../src/om/refs.js";
import {
  classifyRefusal, readJournal, recordRefusal, unitRefusalNamespace, UNIT_REFUSAL_KIND,
} from "../src/om/refusal-journal.js";
import {
  beginAttempt, completeAttempt, openSeries, readSeries, resumeSeries, seriesId,
  prepareBeginAttempt, prepareCompleteAttempt, prepareOpenSeries, prepareResumeSeries,
  ATTEMPT_VERDICTS, COMPLETION_REASONS, CONTINUATION_GROUNDS, REPAIR_SERIES_KIND, SERIES_CODES,
  type Attempt, type AttemptGoal, type BeginAttemptRequest, type ClaimedOutcome, type ClaimedRefusal,
  type CompleteAttemptRequest, type OpenSeriesRequest, type RepairSeries, type ResumeSeriesRequest,
  type SeriesRequest, type SeriesTransition,
} from "../src/om/series.js";

const UNIT = "store-repairs";
const PROJECT = "alpha";
const BLOCK = "block:cart";
const SLICE = "slice:cart@1";
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-om-series-"));
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

function addressed(refusal: Refusal, expected: string, project = PROJECT, line = 1, block = BLOCK): Refusal {
  assert.equal(refusal.code, expected);
  assert.equal(refusal.at.unit, UNIT);
  assert.equal(refusal.at.target, seriesId(project, block, line));
  assert.ok(refusal.message.length > 0);
  assert.ok(REFUSAL_ROUTES.includes(refusal.route));
  return refusal;
}

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);

// An absent field is an absent KEY: undefined is not a JSON value, so a record can only omit what it does not carry.
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

let unique = 0;
const next = (): number => (unique += 1);

// The record that accepted a result. Which unit writes it is decided in later tasks (a closed gap line, a checked
// answer, an accepted frame); the series only resolves the exact reference an achievement stands on.
function accepted(store: Store, key: string): Ref {
  return reference(store.write({ id: `om-accepted:${next()}:${key}`, kind: "om-gap-line", expected: 0, value: { closed: key } }));
}

/**
 * A refusal a gate really wrote, journalled through the accepted API of A2, and the link the series keeps to it.
 * Two calls with the same code and goal but different origins are two legitimate rows, which is exactly what the
 * series has to be able to tell apart.
 */
function journalled(store: Store, project: string, over: Record<string, unknown> = {}): ClaimedRefusal {
  const name = String(over['code'] ?? "graph_invalid");
  const goal = String(over['goal'] ?? "every artifact an operation consumes is produced somewhere in the layer");
  const source = store.write({
    id: `${unitRefusalNamespace(project)}g:${next()}`, kind: UNIT_REFUSAL_KIND, expected: 0,
    value: {
      gate: String(over['gate'] ?? "G3"),
      refusals: [{
        code: name, goal, remedy: "add the producer of the artifact to the proposal",
        origin: {
          name: String(over['origin'] ?? "artifact_missing"),
          stage: String(over['stage'] ?? "candidate-assembly"),
          subject: String(over['subject'] ?? "artifact:cart"),
          sources: [{ role: "proposal", ref: { id: "layer-proposal:7", revision: 2, hash: hex("b") } }],
        },
      }],
    },
  });
  const journal = deliveredOf(recordRefusal(store, { project, source: reference(source) }));
  return { name, goal, row: journal.value.rows[journal.value.rows.length - 1]!.id };
}

const goal = (over: Partial<AttemptGoal> = {}): AttemptGoal => ({
  key: "gap:cart:price",
  questions: ["which node produces the price of a cart line?"],
  result: "an accepted layer proposal naming the producer",
  ...over,
});

const outcome = (over: Partial<ClaimedOutcome> = {}): ClaimedOutcome =>
  ({ reason: "result", achieved: [], cancelled: [], refusals: [], ...over }) as ClaimedOutcome;

// A completed cycle that delivered a candidate and had nothing accepted: a cycle all the same, and no progress.
const fruitless = (): ClaimedOutcome => outcome();
// A cycle that ended in a final refusal of its own, linked to the row the journal holds for it.
const refusedBy = (store: Store, project: string, over: Record<string, unknown> = {}): ClaimedOutcome =>
  outcome({ reason: "refused", refusals: [journalled(store, project, over)] });

const win = (store: Store, key: string) => ({ key, basis: accepted(store, key) });

const address = (project: string, line = 1): SeriesRequest => ({ project, block: BLOCK, line });

function opened(store: Store, project = PROJECT, over: Partial<OpenSeriesRequest> = {}) {
  return deliveredOf(openSeries(store, {
    ...address(project, over.line ?? 1), slice: SLICE, predecessor: null, basis: null, ...over,
  }));
}

const held = (store: Store, project = PROJECT, line = 1): Revision<RepairSeries> | null =>
  store.get<RepairSeries>(seriesId(project, BLOCK, line));

const ordinal = (store: Store, project = PROJECT, line = 1): number => {
  const value = held(store, project, line)!.value;
  return value.inherited.length + value.attempts.length + 1;
};

const standingStop = (store: Store, project = PROJECT, line = 1): number => held(store, project, line)!.value.stop!.attempt;

/** One completed cycle: the goal is named first with the ordinal it opens, then its outcome is delivered once. */
function cycle(store: Store, project: string, g: AttemptGoal, o: ClaimedOutcome, line = 1) {
  const attempt = ordinal(store, project, line);
  deliveredOf(beginAttempt(store, { ...address(project, line), attempt, goal: g }));
  return deliveredOf(completeAttempt(store, { ...address(project, line), attempt, outcome: o }));
}

const verdicts = (value: RepairSeries): (string | null)[] => [...value.inherited, ...value.attempts].map(item => item.verdict);

/** A series forged in place: the shape is right, only the content is not what this unit would ever have written. */
function forge(store: Store, project: string, build: (value: RepairSeries) => Record<string, unknown>, line = 1): void {
  const current = held(store, project, line)!;
  store.write({ id: current.id, kind: REPAIR_SERIES_KIND, expected: current.revision, value: build(current.value) });
}

test("a series keeps the cycle it was given: the goal named first, the outcome once, and the progress it derived", t => {
  const { store } = fixture(t);
  const series = opened(store);
  assert.equal(series.id, seriesId(PROJECT, BLOCK, 1));
  assert.equal(series.kind, REPAIR_SERIES_KIND);
  assert.equal(series.revision, 1);
  assert.equal(series.value.projectId, PROJECT);
  assert.equal(series.value.block, BLOCK);
  assert.equal(series.value.slice, SLICE);
  assert.equal(series.value.predecessor, null);
  assert.equal(series.value.basis, null);
  // A series that has inherited, attempted and continued nothing yet says so explicitly.
  assert.deepEqual(series.value.inherited, []);
  assert.deepEqual(series.value.attempts, []);
  assert.deepEqual(series.value.continuations, []);
  assert.equal(series.value.withoutProgress, 0);
  assert.equal(series.value.stop, null);

  const begun = deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  assert.equal(begun.value.attempts.length, 1);
  const open = begun.value.attempts[0]!;
  assert.equal(open.ordinal, 1);
  assert.equal(open.goal.key, "gap:cart:price");
  assert.deepEqual(open.goal.questions, ["which node produces the price of a cart line?"]);
  assert.ok(open.goal.result.length > 0);
  // An attempt still running has no outcome and no verdict, and it moves no count.
  assert.equal(open.outcome, null);
  assert.equal(open.verdict, null);
  assert.equal(begun.value.withoutProgress, 0);

  const done = deliveredOf(completeAttempt(store, {
    ...address(PROJECT), attempt: 1, outcome: outcome({ achieved: [win(store, "line:cart:price")] }),
  }));
  assert.equal(done.revision, 3);
  const closed = done.value.attempts[0]!;
  assert.equal(closed.outcome!.reason, "result");
  assert.deepEqual(closed.outcome!.achieved.map(item => item.key), ["line:cart:price"]);
  assert.deepEqual(closed.outcome!.cancelled, []);
  assert.deepEqual(closed.outcome!.refusals, []);
  // The verdict is the series' own: a new accepted result for this goal is progress, and progress clears the count.
  assert.equal(closed.verdict, "progress");
  assert.equal(done.value.withoutProgress, 0);
  assert.equal(done.value.stop, null);

  // What was handed out is what was written: the copy hashes as the stored record does.
  assert.equal(hashJson(done.value), held(store)!.hash);
  assert.ok(deeplyFrozen(done));
  const read = deliveredOf(readSeries(store, address(PROJECT)));
  assert.deepEqual(read.value, done.value);
  assert.notEqual(read.value, done.value);
  assert.equal(store.history(seriesId(PROJECT, BLOCK, 1)).length, 3);
});

test("every refusal code of this unit is produced, addressed and routed", t => {
  const { store } = fixture(t);
  const seen: string[] = [];
  const record = (refusal: Refusal, expected: string, project: string, line = 1): void => {
    seen.push(addressed(refusal, expected, project, line).code);
  };

  opened(store, "p1");
  record(refusalOf(openSeries(store, { ...address("p1"), slice: "slice:other", predecessor: null, basis: null })), "series_conflict", "p1");

  record(refusalOf(beginAttempt(store, { ...address("p2"), attempt: 1, goal: goal() })), "series_missing", "p2");

  opened(store, "p3");
  forge(store, "p3", value => ({ ...value, slice: "slice:rewritten", withoutProgress: 7 }));
  record(refusalOf(readSeries(store, address("p3"))), "series_invalid", "p3");

  store.write({ id: seriesId("p4", BLOCK, 1), kind: REPAIR_SERIES_KIND, expected: 0, value: {
    ...opened(store, "p4x").value, projectId: "p4", block: "block:other",
  } as unknown as Json });
  record(refusalOf(readSeries(store, address("p4"))), "series_foreign", "p4");

  const first = opened(store, "p5");
  record(refusalOf(openSeries(store, {
    ...address("p5", 2), slice: SLICE, predecessor: reference(first), basis: { ground: "inputs-changed", text: "the slice moved" },
  })), "slice_unchanged", "p5", 2);

  opened(store, "p6");
  deliveredOf(beginAttempt(store, { ...address("p6"), attempt: 1, goal: goal() }));
  record(refusalOf(beginAttempt(store, { ...address("p6"), attempt: 2, goal: goal({ key: "gap:cart:tax" }) })), "attempt_running", "p6");
  record(refusalOf(beginAttempt(store, { ...address("p6"), attempt: 1, goal: goal({ key: "gap:cart:tax" }) })), "attempt_conflict", "p6");
  record(refusalOf(beginAttempt(store, { ...address("p6"), attempt: 9, goal: goal() })), "attempt_unknown", "p6");

  opened(store, "p7");
  record(refusalOf(completeAttempt(store, { ...address("p7"), attempt: 99, outcome: outcome() })), "attempt_unknown", "p7");

  opened(store, "p8");
  cycle(store, "p8", goal(), fruitless());
  record(refusalOf(completeAttempt(store, { ...address("p8"), attempt: 1, outcome: refusedBy(store, "p8") })), "outcome_conflict", "p8");

  opened(store, "p9");
  deliveredOf(beginAttempt(store, { ...address("p9"), attempt: 1, goal: goal() }));
  record(refusalOf(completeAttempt(store, {
    ...address("p9"), attempt: 1, outcome: outcome({ reason: "awaiting-owner", achieved: [win(store, "line:cart:price")] }),
  })), "outcome_invalid", "p9");

  opened(store, "p10");
  deliveredOf(beginAttempt(store, { ...address("p10"), attempt: 1, goal: goal() }));
  record(refusalOf(completeAttempt(store, {
    ...address("p10"), attempt: 1, outcome: outcome({ achieved: [{ key: "line:cart:price", basis: { id: "om-accepted:nowhere", revision: 1, hash: hex("a") } }] }),
  })), "basis_unresolved", "p10");

  opened(store, "p11");
  deliveredOf(beginAttempt(store, { ...address("p11"), attempt: 1, goal: goal() }));
  record(refusalOf(completeAttempt(store, {
    ...address("p11"), attempt: 1, outcome: outcome({ reason: "refused", cancelled: ["line:never:accepted"], refusals: [journalled(store, "p11")] }),
  })), "cancelled_unknown", "p11");

  opened(store, "p12");
  for (let round = 0; round < 3; round += 1) cycle(store, "p12", goal(), fruitless());
  record(refusalOf(beginAttempt(store, { ...address("p12"), attempt: 4, goal: goal() })), "series_stopped", "p12");
  deliveredOf(resumeSeries(store, { ...address("p12"), stop: 3, ground: "owner-decision", text: "carry on" }));
  record(refusalOf(resumeSeries(store, { ...address("p12"), stop: 3, ground: "approach-changed", text: "or rather this" })), "continuation_conflict", "p12");

  opened(store, "p13");
  record(refusalOf(resumeSeries(store, { ...address("p13"), stop: 1, ground: "owner-decision", text: "carry on" })), "stop_absent", "p13");

  opened(store, "p14");
  deliveredOf(beginAttempt(store, { ...address("p14"), attempt: 1, goal: goal() }));
  record(refusalOf(completeAttempt(store, {
    ...address("p14"), attempt: 1, outcome: outcome({ reason: "refused", refusals: [{ name: "graph_invalid", goal: "a goal", row: "om-refusal:invented" }] }),
  })), "refusal_unlinked", "p14");

  assert.deepEqual([...new Set(seen)].sort(), [...SERIES_CODES].sort());
});

test("an absent argument, field or set is a typed refusal that names the address, while an explicit emptiness is not (T4)", t => {
  const { store } = fixture(t);
  // An absent series is not an empty one: a block never repaired and a series lost read differently.
  for (const call of [
    () => readSeries(store, address("empty")),
    () => beginAttempt(store, { ...address("empty"), attempt: 1, goal: goal() }),
    () => completeAttempt(store, { ...address("empty"), attempt: 1, outcome: outcome() }),
    () => resumeSeries(store, { ...address("empty"), stop: 1, ground: "owner-decision", text: "carry on" }),
  ]) addressed(refusalOf(call()), "series_missing", "empty");

  // An absent set inside a stored series is not an empty one, and the refusal names which one is missing.
  const stored = (build: (value: RepairSeries) => Record<string, unknown>, expected: string, project: string): string | undefined => {
    opened(store, project);
    cycle(store, project, goal(), fruitless());
    forge(store, project, build);
    return addressed(refusalOf(readSeries(store, address(project))), expected, project).at.field;
  };
  assert.equal(stored(value => without({ ...value }, "inherited"), "series_invalid", "a1"), "value");
  assert.equal(stored(value => ({ ...value, inherited: null }), "series_invalid", "a2"), "attempts");
  assert.equal(stored(value => ({ ...value, continuations: null }), "series_invalid", "a3"), "continuations");
  assert.equal(stored(value => without({ ...value }, "stop"), "series_invalid", "a4"), "value");
  assert.equal(stored(value => ({ ...value, slice: "" }), "series_invalid", "a5"), "slice");
  assert.equal(stored(value => ({ ...value, attempts: [without({ ...value.attempts[0]! }, "outcome")] }), "series_invalid", "a6"), "attempts.0");
  assert.equal(stored(value => ({
    ...value, attempts: [{ ...value.attempts[0]!, goal: without({ ...value.attempts[0]!.goal }, "questions") }],
  }), "series_invalid", "a7"), "attempts.0.goal.goal");
  assert.equal(stored(value => ({
    ...value, attempts: [{ ...value.attempts[0]!, goal: { ...value.attempts[0]!.goal, questions: [] } }],
  }), "series_invalid", "a8"), "attempts.0.goal.questions");
  assert.equal(stored(value => ({
    ...value, attempts: [{ ...value.attempts[0]!, outcome: without({ ...value.attempts[0]!.outcome! }, "refusals") }],
  }), "series_invalid", "a9"), "attempts.0.outcome");
  assert.equal(stored(value => ({
    ...value, attempts: [{ ...value.attempts[0]!, outcome: { ...value.attempts[0]!.outcome!, cancelled: null } }],
  }), "series_invalid", "a10"), "attempts.0.cancelled");
  // A refusal held without the link it stands for is a refusal nobody can resolve.
  assert.equal(stored(value => ({
    ...value, attempts: [{ ...value.attempts[0]!, outcome: { ...value.attempts[0]!.outcome!, reason: "refused", refusals: [{ name: "n", goal: "g" }] } }],
  }), "series_invalid", "a11"), "attempts.0.refusals.0");

  // Explicit emptiness is a fact and is kept: a cycle that accepted nothing is a cycle, not a missing one.
  const empty = opened(store, "bare");
  assert.deepEqual(empty.value.attempts, []);
  assert.deepEqual(empty.value.continuations, []);
  const bare = cycle(store, "bare", goal(), fruitless());
  assert.deepEqual(bare.value.attempts[0]!.outcome!.achieved, []);
  assert.deepEqual(bare.value.attempts[0]!.outcome!.refusals, []);
  assert.equal(bare.value.attempts[0]!.verdict, "none");
  assert.equal(bare.value.withoutProgress, 1);
});

test("a forged input is refused: a foreign namespace, a substituted hash and an imitated verdict (T3)", t => {
  const { store } = fixture(t);
  const one = opened(store, "beta");
  const two = deliveredOf(openSeries(store, {
    ...address("beta", 2), slice: "slice:cart@2", predecessor: reference(one),
    basis: { ground: "inputs-changed", text: "the closure of the block's dependencies moved" },
  }));
  assert.equal(two.value.predecessor!.id, seriesId("beta", BLOCK, 1));

  // A predecessor of another block, at a hash it does not hold, at a revision it never reached, or absent.
  // The refusal is addressed to the record that was wrong — the predecessor being read, not the series being opened.
  const foreign = opened(store, "gamma");
  const refuse = (predecessor: unknown, expected: string): Refusal => addressed(refusalOf(openSeries(store, {
    ...address("beta", 3), slice: "slice:cart@3", predecessor: predecessor as Ref,
    basis: { ground: "inputs-changed", text: "again" },
  })), expected, "beta", 2);
  assert.equal(refuse(reference(foreign), "record_foreign").at.field, "id");
  assert.equal(refuse({ ...reference(two), hash: hex("d") }, "record_forged").at.field, "hash");
  assert.equal(refuse({ ...reference(two), revision: 9 }, "record_missing").at.ref!.revision, 9);
  assert.equal(refuse({ id: seriesId("beta", BLOCK, 2), revision: 1 }, "reference_invalid").at.field, "hash");
  // A predecessor two lines back is not this line's predecessor, however genuine it is.
  assert.equal(refuse(reference(one), "record_foreign").at.field, "id");

  // A record of another kind standing at a series' own address is not a series.
  store.write({ id: seriesId("delta", BLOCK, 1), kind: "gate-pass", expected: 0, value: { projectId: "delta" } });
  assert.equal(addressed(refusalOf(readSeries(store, address("delta"))), "record_foreign", "delta").at.field, "kind");

  // A verdict, a count, a stop and a canonical order imitated in place: the record agrees with itself and nothing else.
  // Each forgery changes ONE thing and leaves the rest of the history standing, so exactly one check can catch it.
  const swapped = (value: RepairSeries, at: number, change: (attempt: Attempt) => Record<string, unknown>) =>
    ({ ...value, attempts: value.attempts.map((item, index) => (index === at ? change(item) : item)) });
  const imitations: [string, (value: RepairSeries) => Record<string, unknown>][] = [
    ["an attempt that moved nothing wearing the verdict of one that did",
      value => swapped(value, 1, attempt => ({ ...attempt, verdict: "progress" }))],
    ["a count that does not follow from the attempts", value => ({ ...value, withoutProgress: 0 })],
    ["a stop wished away", value => ({ ...value, stop: null })],
    ["a stop whose cause and point of continuation were written by hand",
      value => ({ ...value, stop: { ...value.stop!, reason: "because I say so", resume: "as you were" } })],
    ["a continuation standing where no stop was saved", value => ({
      ...value, continuations: [{ ground: "owner-decision", text: "carry on", after: 1 }],
    })],
    ["an attempt carrying a field the series does not keep",
      value => swapped(value, 0, attempt => ({ ...attempt, progress: true }))],
    ["an outcome that claims an achievement it says it could not have",
      value => swapped(value, 0, attempt => ({ ...attempt, outcome: { ...attempt.outcome!, reason: "off-form" } }))],
    ["achievements held out of canonical order",
      value => swapped(value, 0, attempt => ({ ...attempt, outcome: { ...attempt.outcome!, achieved: [...attempt.outcome!.achieved].reverse() } }))],
    ["a package of questions held out of canonical order",
      value => swapped(value, 0, attempt => ({ ...attempt, goal: { ...attempt.goal, questions: [...attempt.goal.questions].reverse() } }))],
  ];
  imitations.forEach(([name, build], index) => {
    const project = `forged${index}`;
    opened(store, project);
    // One attempt that moved the goal, then three that did not: a count of three and a stop saved after the fourth.
    cycle(store, project, goal({ questions: ["question two", "question one"] }),
      outcome({ achieved: [win(store, "line:B"), win(store, "line:A")] }));
    for (let round = 0; round < 3; round += 1) cycle(store, project, goal(), fruitless());
    const genuine = held(store, project)!.value;
    assert.equal(genuine.withoutProgress, 3, name);
    assert.equal(genuine.stop!.attempt, 4, name);
    assert.deepEqual(verdicts(genuine), ["progress", "none", "none", "none"], name);

    forge(store, project, build);
    assert.equal(addressed(refusalOf(readSeries(store, address(project))), "series_invalid", project).code, "series_invalid", name);
    // A series that cannot be read cannot be attempted, closed, continued or re-opened either: every path refuses.
    addressed(refusalOf(beginAttempt(store, { ...address(project), attempt: 5, goal: goal() })), "series_invalid", project);
    addressed(refusalOf(completeAttempt(store, { ...address(project), attempt: 1, outcome: outcome() })), "series_invalid", project);
    addressed(refusalOf(resumeSeries(store, { ...address(project), stop: 4, ground: "owner-decision", text: "carry on" })), "series_invalid", project);
    addressed(refusalOf(openSeries(store, { ...address(project), slice: SLICE, predecessor: null, basis: null })), "series_invalid", project);
    // And it is no ground for a successor: a lineage does not start from a history nobody wrote.
    assert.equal(refusalOf(openSeries(store, {
      ...address(project, 2), slice: "slice:cart@2", predecessor: reference(held(store, project)!),
      basis: { ground: "inputs-changed", text: "the slice moved" },
    })).code, "series_invalid", name);
  });

  // An inherited history rewritten under a genuine predecessor reference.
  opened(store, "swap");
  const swapBase = cycle(store, "swap", goal(), outcome({ achieved: [win(store, "line:cart:price")] }));
  const successor = deliveredOf(openSeries(store, {
    ...address("swap", 2), slice: "slice:cart@2", predecessor: reference(swapBase),
    basis: { ground: "inputs-changed", text: "the slice moved" },
  }));
  assert.deepEqual(successor.value.inherited.map(item => item.ordinal), [1]);
  forge(store, "swap", value => ({
    ...value,
    inherited: [{ ...value.inherited[0]!, goal: { ...value.inherited[0]!.goal, key: "gap:cart:tax" } }],
  }), 2);
  assert.equal(addressed(refusalOf(readSeries(store, address("swap", 2))), "series_invalid", "swap", 2).at.field, "inherited");

  // "__proto__" survives JSON as an own field: it is extra content, not a detail to skip over.
  opened(store, "awkward");
  forge(store, "awkward", value => JSON.parse(`{"__proto__":{"line":9},${JSON.stringify(value).slice(1)}`) as Record<string, unknown>);
  assert.equal(addressed(refusalOf(readSeries(store, address("awkward"))), "series_invalid", "awkward").at.field, "value");
});

// A second writer commits between this unit's read of the series and its own write. The store is synchronous, so the
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

test("a series written to by someone else between the read and the write is refused, and nothing is lost (T7)", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-series-race-"));
  const path = join(root, "live.sqlite");
  const store = new RacingStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.target = seriesId(PROJECT, BLOCK, 1);

  // The series does not exist yet: the competitor opens it while this call believes there is nothing there.
  store.armed = true;
  store.run = other => { opened(other); };
  addressed(refusalOf(openSeries(store, { ...address(PROJECT), slice: "slice:cart@9", predecessor: null, basis: null })), "revision_conflict");
  const created = held(store)!;
  assert.equal(created.revision, 1);
  assert.equal(created.value.slice, SLICE);

  // The series exists: the competitor begins an attempt while this call holds the head it read.
  store.armed = true;
  store.run = other => { deliveredOf(beginAttempt(other, { ...address(PROJECT), attempt: 1, goal: goal({ key: "gap:cart:tax" }) })); };
  const refusal = addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() })), "input_stale");
  assert.deepEqual(refusal.at.ref, reference(created));
  assert.equal(held(store)!.value.attempts[0]!.goal.key, "gap:cart:tax");

  // The competitor closes that attempt while this call is closing it too: the outcome is counted once.
  store.armed = true;
  store.run = other => {
    deliveredOf(completeAttempt(other, { ...address(PROJECT), attempt: 1, outcome: outcome({ achieved: [win(other, "line:cart:tax")] }) }));
  };
  addressed(refusalOf(completeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: fruitless() })), "input_stale");
  const after = held(store)!;
  assert.equal(after.value.attempts[0]!.verdict, "progress");
  assert.equal(after.value.attempts.length, 1);

  // Nothing was lost: the refused attempt is begun once the current head is read again.
  store.armed = false;
  const grown = deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() }));
  assert.deepEqual(grown.value.attempts.map(item => item.goal.key), ["gap:cart:tax", "gap:cart:price"]);
  assert.equal(grown.value.withoutProgress, 0);
  deliveredOf(completeAttempt(store, { ...address(PROJECT), attempt: 2, outcome: fruitless() }));
  for (let round = 0; round < 2; round += 1) cycle(store, PROJECT, goal(), fruitless());
  assert.equal(standingStop(store), 4);

  // The competitor continues the stopped series while this call is continuing it on another ground.
  store.armed = true;
  store.run = other => { deliveredOf(resumeSeries(other, { ...address(PROJECT), stop: 4, ground: "owner-decision", text: "the owner said to go on" })); };
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 4, ground: "approach-changed", text: "ask M5 first" })), "input_stale");
  assert.deepEqual(held(store)!.value.continuations.map(item => item.ground), ["owner-decision"]);

  // And a predecessor that moves between the read and the write leaves the successor unwritten, not half-built.
  store.armed = false;
  const done = deliveredOf(readSeries(store, address(PROJECT)));
  store.armed = true;
  store.run = other => { deliveredOf(beginAttempt(other, { ...address(PROJECT), attempt: 5, goal: goal({ key: "gap:cart:tax" }) })); };
  addressed(refusalOf(openSeries(store, {
    ...address(PROJECT, 2), slice: "slice:cart@2", predecessor: reference(done),
    basis: { ground: "inputs-changed", text: "the slice moved" },
  })), "input_stale", PROJECT, 1);
  assert.equal(held(store, PROJECT, 2), null);
});

test("every change names the state it comes from, so a late delivery finds its own and changes nothing (T5)", t => {
  const { path, store } = fixture(t);
  // THE STOP. Three attempts without progress, a ground recorded for that stop, then a fourth attempt stops again.
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  const ground = { ground: "approach-changed", text: "ask M5 to address the gap first" } as const;
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  const fourth = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(fourth.value.stop!.attempt, 4);

  // The SAME continuation delivered again is about the stop after attempt three, which is continued already. It
  // changes nothing and it does not lift the stop saved after attempt four.
  const late = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(late.revision, fourth.revision);
  assert.deepEqual(late.value, fourth.value);
  assert.equal(late.value.stop!.attempt, 4);
  assert.deepEqual(late.value.continuations.map(item => item.after), [3]);
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 5, goal: goal() })), "series_stopped");
  // A ground given for a stop that never stood is refused, and so is a second ground for one already continued.
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 2, ground: "owner-decision", text: "carry on" })), "stop_absent");
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ground: "owner-decision", text: "another ground" })), "continuation_conflict");
  assert.equal(store.history(seriesId(PROJECT, BLOCK, 1)).length, fourth.revision);

  // THE ATTEMPT. A "begin" that arrives late finds the attempt it was about, closed long since, and opens nothing.
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 4, ground: "owner-decision", text: "the owner said to go on" }));
  const moved = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:A")] }));
  assert.equal(moved.value.attempts.length, 5);
  const echo = deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  assert.equal(echo.revision, moved.revision);
  assert.equal(echo.value.attempts.length, 5);
  // The same ordinal under another goal is a conflict, not a second attempt and not a rewriting of the first.
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal({ key: "gap:cart:tax" }) })), "attempt_conflict");
  // An ordinal that is neither held nor next opens nothing either.
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 9, goal: goal() })), "attempt_unknown");

  // THE OUTCOME. A closed attempt keeps its outcome however many attempts were begun and closed after it.
  const back = deliveredOf(completeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: fruitless() }));
  assert.equal(back.revision, moved.revision);
  assert.deepEqual(back.value, moved.value);

  // THE SERIES. Opening it again is a repeat whatever has happened in it since.
  const again = deliveredOf(openSeries(store, { ...address(PROJECT), slice: SLICE, predecessor: null, basis: null }));
  assert.equal(again.revision, moved.revision);
  assert.deepEqual(again.value, moved.value);
  addressed(refusalOf(openSeries(store, { ...address(PROJECT), slice: "slice:cart@2", predecessor: null, basis: null })), "series_conflict");

  // And the same after a restart: what a late delivery finds is in the record, not in a process.
  store.close();
  const reopened = new Store(path);
  t.after(() => reopened.close());
  const cold = deliveredOf(readSeries(reopened, address(PROJECT)));
  assert.deepEqual(cold.value, moved.value);
  assert.deepEqual(deliveredOf(resumeSeries(reopened, { ...address(PROJECT), stop: 3, ...ground })).value, moved.value);
  assert.deepEqual(deliveredOf(beginAttempt(reopened, { ...address(PROJECT), attempt: 1, goal: goal() })).value, moved.value);
  assert.deepEqual(deliveredOf(completeAttempt(reopened, { ...address(PROJECT), attempt: 1, outcome: fruitless() })).value, moved.value);
  assert.equal(reopened.history(seriesId(PROJECT, BLOCK, 1)).length, moved.revision);

  // A successor, too, is opened once: the repeat is recognised after the successor has a history of its own.
  const successor = deliveredOf(openSeries(reopened, {
    ...address(PROJECT, 2), slice: "slice:cart@2", predecessor: reference(cold), basis: { ground: "inputs-changed", text: "the slice moved" },
  }));
  cycle(reopened, PROJECT, goal(), fruitless(), 2);
  const reopenedSuccessor = deliveredOf(openSeries(reopened, {
    ...address(PROJECT, 2), slice: "slice:cart@2", predecessor: reference(cold), basis: { ground: "inputs-changed", text: "the slice moved" },
  }));
  assert.equal(reopenedSuccessor.value.attempts.length, 1);
  assert.equal(reopenedSuccessor.revision, successor.revision + 2);
});

test("the order of an unordered set does not change what an outcome is (T5, T6)", t => {
  const { store } = fixture(t);
  opened(store);
  const one = win(store, "line:A");
  const two = win(store, "line:B");
  const first = journalled(store, PROJECT);
  const second = journalled(store, PROJECT, { code: "layer_port_unbound", goal: "every port of an operation is bound" });
  const questions = ["address the second question", "address the first question"];

  const attempt = ordinal(store, PROJECT);
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt, goal: goal({ questions }) }));
  const closed = deliveredOf(completeAttempt(store, {
    ...address(PROJECT), attempt,
    outcome: outcome({ reason: "refused", achieved: [one, two], refusals: [first, second, first] }),
  }));
  // Written canonically whichever order it arrived in, and the package of questions with it.
  assert.deepEqual(closed.value.attempts[0]!.goal.questions, [...questions].sort());
  assert.deepEqual(closed.value.attempts[0]!.outcome!.achieved.map(item => item.key), ["line:A", "line:B"]);
  // Multiplicity is kept: two refusals are two, even when they are the same refusal named twice.
  assert.equal(closed.value.attempts[0]!.outcome!.refusals.length, 3);
  assert.deepEqual(closed.value.attempts[0]!.outcome!.refusals, [first, second, first].map(item => ({ row: item.row })).sort((l, r) => (l.row < r.row ? -1 : 1)));

  // The same results, cancellations, refusals and questions in another order are the same outcome: no revision.
  const again = deliveredOf(completeAttempt(store, {
    ...address(PROJECT), attempt,
    outcome: outcome({ reason: "refused", achieved: [two, one], refusals: [second, first, first] }),
  }));
  assert.equal(again.revision, closed.revision);
  assert.deepEqual(again.value, closed.value);
  // And the goal, too: a package of questions named in another order is the same attempt, not a conflicting one.
  const sameGoal = deliveredOf(beginAttempt(store, {
    ...address(PROJECT), attempt, goal: goal({ questions: [...questions].reverse() }),
  }));
  assert.equal(sameGoal.revision, closed.revision);

  // A cancellation set is normalised too, and dropping a refusal really is a different outcome.
  const later = ordinal(store, PROJECT);
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: later, goal: goal() }));
  const cancels = deliveredOf(completeAttempt(store, {
    ...address(PROJECT), attempt: later, outcome: outcome({ reason: "interrupted", cancelled: ["line:B", "line:A"] }),
  }));
  assert.deepEqual(cancels.value.attempts[1]!.outcome!.cancelled, ["line:A", "line:B"]);
  assert.deepEqual(deliveredOf(completeAttempt(store, {
    ...address(PROJECT), attempt: later, outcome: outcome({ reason: "interrupted", cancelled: ["line:A", "line:B"] }),
  })).value, cancels.value);
  addressed(refusalOf(completeAttempt(store, {
    ...address(PROJECT), attempt: later, outcome: outcome({ reason: "interrupted", cancelled: ["line:A"] }),
  })), "outcome_conflict");
  addressed(refusalOf(completeAttempt(store, {
    ...address(PROJECT), attempt, outcome: outcome({ reason: "refused", achieved: [one, two], refusals: [first, second] }),
  })), "outcome_conflict");
});

test("a refusal keeps the link that tells it from another of the same name and goal", t => {
  const { store } = fixture(t);
  opened(store);
  // Two legitimate events of A2 with the SAME name and goal, from different origins: the proposal's own error, and
  // a definition lost by the assembler. G7 classifies them differently, and the series must keep them apart.
  const fromProposal = journalled(store, PROJECT, { stage: "layer-design", subject: "artifact:cart" });
  const fromAssembly = journalled(store, PROJECT, { stage: "candidate-assembly", subject: "artifact:cart" });
  assert.equal(fromProposal.name, fromAssembly.name);
  assert.equal(fromProposal.goal, fromAssembly.goal);
  assert.notEqual(fromProposal.row, fromAssembly.row);

  deliveredOf(classifyRefusal(store, { project: PROJECT, row: fromProposal.row, class: "design", addressee: "MC2", basis: [] }));
  deliveredOf(classifyRefusal(store, { project: PROJECT, row: fromAssembly.row, class: "derivation", addressee: "code-producer", basis: [] }));

  const one = cycle(store, PROJECT, goal(), outcome({ reason: "refused", refusals: [fromProposal] }));
  const two = cycle(store, PROJECT, goal(), outcome({ reason: "refused", refusals: [fromAssembly] }));
  const rows = [...two.value.attempts].map(item => item.outcome!.refusals[0]!.row);
  assert.deepEqual(rows, [fromProposal.row, fromAssembly.row]);
  assert.notEqual(rows[0], rows[1]);
  assert.ok(one.revision < two.revision);

  // From the series alone the addressee of each attempt is found, because the link resolves to one row and one class.
  const journal = deliveredOf(readJournal(store, { project: PROJECT }));
  const addresseeOf = (row: string): string => journal.value.classifications.find(item => item.row === row)!.addressee;
  assert.deepEqual(rows.map(addresseeOf), ["MC2", "code-producer"]);
  const originOf = (row: string): string => journal.value.rows.find(item => item.id === row)!.origin.stage;
  assert.deepEqual(rows.map(originOf), ["layer-design", "candidate-assembly"]);

  // A link is weighed against the journal of THIS project when the cycle is closed: a row that stands nowhere, a row
  // of another project, and a row whose refusal is not the one the cycle reports are all refused.
  const elsewhere = journalled(store, "beta");
  const attempt = ordinal(store, PROJECT);
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt, goal: goal() }));
  for (const broken of [
    { ...fromProposal, row: "om-refusal:invented" },
    { ...elsewhere },
    { ...fromProposal, name: "work_not_atomic" },
    { ...fromProposal, goal: "a goal the row does not hold" },
  ]) {
    addressed(refusalOf(completeAttempt(store, {
      ...address(PROJECT), attempt, outcome: outcome({ reason: "refused", refusals: [broken] }),
    })), "refusal_unlinked");
  }
  assert.equal(held(store)!.value.attempts[2]!.outcome, null);

  // A project with no journal at all has no refusal a cycle could stand on.
  opened(store, "silent");
  deliveredOf(beginAttempt(store, { ...address("silent"), attempt: 1, goal: goal() }));
  addressed(refusalOf(completeAttempt(store, {
    ...address("silent"), attempt: 1, outcome: outcome({ reason: "refused", refusals: [fromProposal] }),
  })), "refusal_unlinked", "silent");
  // The classification is not required at the time the cycle closes: G7 derives it later, and the link finds it then.
  const unclassified = journalled(store, PROJECT, { code: "work_not_atomic", goal: "each work owns one artifact" });
  deliveredOf(completeAttempt(store, {
    ...address(PROJECT), attempt, outcome: outcome({ reason: "refused", refusals: [unclassified] }),
  }));
  assert.equal(held(store)!.value.attempts[2]!.outcome!.refusals[0]!.row, unclassified.row);
});

test("prepared changes of several series are applied by one transaction, or by none of them", t => {
  const { store } = fixture(t);
  const other = "block:checkout";
  const at = (block: string, line: number): SeriesRequest => ({ project: PROJECT, block, line });
  const first = deliveredOf(openSeries(store, { ...at(BLOCK, 1), slice: SLICE, predecessor: null, basis: null }));
  const second = deliveredOf(openSeries(store, { ...at(other, 1), slice: SLICE, predecessor: null, basis: null }));
  const ground = { ground: "inputs-changed", text: "the horizon was accepted anew" } as const;

  const prepare = (block: string, from: Revision<RepairSeries>) => deliveredOf(prepareOpenSeries(store, {
    ...at(block, 2), slice: "slice:cart@2", predecessor: reference(from), basis: { ...ground },
  }));
  // A prepared change is a write and its guards, and nothing has been written yet.
  const one = prepare(BLOCK, first);
  const two = prepare(other, second);
  assert.equal(one.write!.kind, REPAIR_SERIES_KIND);
  assert.equal(one.write!.expected, 0);
  assert.deepEqual(one.guards, [reference(first)]);
  assert.deepEqual(one.value.inherited, []);
  assert.equal(store.get(seriesId(PROJECT, BLOCK, 2)), null);
  assert.equal(store.get(seriesId(PROJECT, other, 2)), null);

  // B3's own record of the transition joins the same transaction, guarded by the exact result of G2 it applies.
  const g2 = store.write({ id: "om-horizon:alpha:7", kind: "om-horizon", expected: 0, value: { state: "accepted" } });
  const transition = (over: Partial<Write> = {}): Write =>
    ({ id: "om-series-transition:alpha:7", kind: "series-transition", expected: 0, value: { state: "applied" }, ...over });
  const apply = (parts: readonly SeriesTransition[], guards: readonly Ref[]) => writeGuarded(store, {
    unit: "b3", target: "om-series-transition:alpha:7",
    writes: [...parts.map(part => part.write!), transition()],
    guards: [...parts.flatMap(part => [...part.guards]), ...guards],
  });

  // One participant's guard has moved: the transaction commits nothing, and NO successor is left applied.
  deliveredOf(beginAttempt(store, { ...at(other, 1), attempt: 1, goal: goal() }));
  assert.equal(refusalOf(apply([one, two], [reference(g2)])).code, "input_stale");
  assert.equal(store.get(seriesId(PROJECT, BLOCK, 2)), null);
  assert.equal(store.get(seriesId(PROJECT, other, 2)), null);
  assert.equal(store.get("om-series-transition:alpha:7"), null);

  // The same when it is the result of G2 that moved between the preparation and the write.
  deliveredOf(completeAttempt(store, { ...at(other, 1), attempt: 1, outcome: fruitless() }));
  const ready = prepare(other, store.get<RepairSeries>(seriesId(PROJECT, other, 1))!);
  const stale = reference(g2);
  store.write({ id: g2.id, kind: "om-horizon", expected: 1, value: { state: "accepted", again: true } });
  assert.equal(refusalOf(apply([one, ready], [stale])).code, "input_stale");
  assert.equal(store.get(seriesId(PROJECT, BLOCK, 2)), null);

  // Nothing prevented: both successors and the transition are written by one transaction.
  const done = deliveredOf(apply([one, ready], [reference(store.get(g2.id)!)]));
  assert.equal(done.length, 3);
  assert.deepEqual(done.map(record => record.id),
    [seriesId(PROJECT, BLOCK, 2), seriesId(PROJECT, other, 2), "om-series-transition:alpha:7"]);
  // What was written is a series this unit reads back as its own, history and all.
  const carried = deliveredOf(readSeries(store, at(other, 2)));
  assert.equal(carried.value.inherited.length, 1);
  assert.equal(carried.value.withoutProgress, 1);
  assert.deepEqual(carried.value.basis, { ...ground });
  assert.deepEqual(deliveredOf(readSeries(store, at(BLOCK, 2))).value.inherited, []);

  // A prepared change that is a repeat carries no write at all, so a caller adds nothing to its transaction.
  const repeat = prepare(BLOCK, first);
  assert.equal(repeat.write, null);
  assert.deepEqual(repeat.guards, []);
  assert.deepEqual(repeat.value, deliveredOf(readSeries(store, at(BLOCK, 2))).value);
  // And a prepared change that cannot be made is refused at preparation, before anything is written.
  assert.equal(refusalOf(prepareBeginAttempt(store, { ...at(BLOCK, 2), attempt: 9, goal: goal() })).code, "attempt_unknown");
  assert.equal(refusalOf(prepareResumeSeries(store, { ...at(BLOCK, 2), stop: 1, ground: "owner-decision", text: "on" })).code, "stop_absent");
  assert.equal(refusalOf(prepareCompleteAttempt(store, { ...at(BLOCK, 2), attempt: 1, outcome: outcome() })).code, "attempt_unknown");
});

test("alternation A → B → A is no progress, and neither is re-taking a result that was lost", t => {
  const { store } = fixture(t);
  opened(store);
  const one = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:A")] }));
  assert.equal(one.value.attempts[0]!.verdict, "progress");
  const two = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:B")] }));
  assert.equal(two.value.attempts[1]!.verdict, "progress");
  assert.equal(two.value.withoutProgress, 0);

  // Back to A. The record is new, the reference is new, the key is not: the history of this goal already holds it.
  const three = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:A")] }));
  assert.equal(three.value.attempts[2]!.verdict, "none");
  assert.equal(three.value.withoutProgress, 1);

  // A candidate changed and an answer delivered are not results: a cycle that accepted nothing moved nothing.
  const four = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(four.value.attempts[3]!.verdict, "none");
  assert.equal(four.value.withoutProgress, 2);

  // The same key accepted for ANOTHER goal is that goal's first result: the history is kept per goal.
  const other = cycle(store, PROJECT, goal({ key: "gap:cart:tax" }), outcome({ achieved: [win(store, "line:A")] }));
  assert.equal(other.value.attempts[4]!.verdict, "progress");
  assert.equal(other.value.withoutProgress, 0);
  assert.deepEqual(verdicts(other.value), ["progress", "progress", "none", "none", "progress"]);
});

test("a fix that cancelled another result is a conflict, not a success, and the lost result stays in the history", t => {
  const { store } = fixture(t);
  opened(store);
  cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:A")] }));

  // Fixing B undid A. A conflict of results is not a success, so the count grows even though B is new.
  const clash = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:B")], cancelled: ["line:A"] }));
  assert.equal(clash.value.attempts[1]!.verdict, "conflict");
  assert.deepEqual(clash.value.attempts[1]!.outcome!.cancelled, ["line:A"]);
  assert.equal(clash.value.withoutProgress, 1);

  // Taking A back is the re-taking of something already achieved, and is no new progress.
  const back = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:A")] }));
  assert.equal(back.value.attempts[2]!.verdict, "none");
  assert.equal(back.value.withoutProgress, 2);

  // A cancelled result this goal never accepted is refused: nothing was lost by it.
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 4, goal: goal() }));
  assert.equal(addressed(refusalOf(completeAttempt(store, {
    ...address(PROJECT), attempt: 4, outcome: outcome({ cancelled: ["line:Z"] }),
  })), "cancelled_unknown").at.field, "outcome.cancelled.0");
  deliveredOf(completeAttempt(store, { ...address(PROJECT), attempt: 4, outcome: outcome({ achieved: [win(store, "line:D")] }) }));

  // A result accepted under ANOTHER goal is not this goal's to cancel either: the history is kept per goal.
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 5, goal: goal({ key: "gap:cart:tax" }) }));
  addressed(refusalOf(completeAttempt(store, {
    ...address(PROJECT), attempt: 5, outcome: outcome({ achieved: [win(store, "line:C")], cancelled: ["line:A"] }),
  })), "cancelled_unknown");
  assert.equal(held(store)!.value.attempts[4]!.outcome, null);
});

test("a package of questions is one cycle: the count of the series is not multiplied by the questions", t => {
  const { store } = fixture(t);
  opened(store);
  const package_ = goal({
    key: "gap:cart:addressing",
    questions: ["address question one", "address question two", "address question three"],
    result: "a checked answer for each of the three",
  });

  // Three questions answered and accepted in ONE cycle: one attempt, one clearing of the count.
  const won = cycle(store, PROJECT, package_, outcome({ achieved: [win(store, "q:1"), win(store, "q:2"), win(store, "q:3")] }));
  assert.equal(won.value.attempts.length, 1);
  assert.equal(won.value.attempts[0]!.verdict, "progress");
  assert.equal(won.value.withoutProgress, 0);

  // Three questions and nothing accepted: one attempt without progress, so the count is one, not three.
  const lost = cycle(store, PROJECT, package_, refusedBy(store, PROJECT));
  assert.equal(lost.value.attempts.length, 2);
  assert.equal(lost.value.withoutProgress, 1);
  const again = cycle(store, PROJECT, package_, refusedBy(store, PROJECT, { code: "work_not_atomic" }));
  assert.equal(again.value.withoutProgress, 2);
  assert.equal(again.value.stop, null);
  // A package is one cycle on the way to a stop as well: the third attempt is the third, not the ninth.
  const stopped = cycle(store, PROJECT, package_, refusedBy(store, PROJECT));
  assert.equal(stopped.value.withoutProgress, 3);
  assert.deepEqual(stopped.value.stop!.attempts, [2, 3, 4]);
});

test("the same outcome delivered again is a repeat, not a new attempt, and it is counted once", t => {
  const { store } = fixture(t);
  opened(store);
  const refusal = refusedBy(store, PROJECT);
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const first = deliveredOf(completeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusal }));
  assert.equal(first.value.withoutProgress, 1);

  const again = deliveredOf(completeAttempt(store, { ...address(PROJECT), attempt: 1, outcome: refusal }));
  assert.equal(again.revision, first.revision);
  assert.deepEqual(again.value, first.value);
  assert.equal(again.value.attempts.length, 1);
  assert.equal(again.value.withoutProgress, 1);
  assert.equal(store.history(seriesId(PROJECT, BLOCK, 1)).length, first.revision);

  // A different outcome for a cycle already closed does not replace the one it ended with (T5).
  addressed(refusalOf(completeAttempt(store, {
    ...address(PROJECT), attempt: 1, outcome: outcome({ achieved: [win(store, "line:A")] }),
  })), "outcome_conflict");
  assert.equal(held(store)!.value.withoutProgress, 1);

  // Naming the next ordinal begins a NEW cycle; naming the running one again is that cycle.
  const running = deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() }));
  assert.equal(running.value.attempts.length, 2);
  const repeat = deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() }));
  assert.equal(repeat.revision, running.revision);
  assert.equal(repeat.value.attempts.length, 2);
});

test("an interrupted attempt keeps its own outcome across a restart, and the count follows the results it left", t => {
  const { path, store } = fixture(t);
  opened(store);
  cycle(store, PROJECT, goal(), fruitless());
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal({ questions: ["one", "two"] }) }));
  const basis = win(store, "q:one");
  store.close();

  // The process restarts. The cycle that was open is still open, and it is THE SAME attempt that is closed.
  const back = new Store(path);
  t.after(() => back.close());
  const found = deliveredOf(readSeries(back, address(PROJECT)));
  assert.equal(found.value.attempts.length, 2);
  assert.equal(found.value.attempts[1]!.outcome, null);
  assert.equal(found.value.withoutProgress, 1);
  // Naming that attempt again after the restart re-reaches it instead of opening a second one.
  const same = deliveredOf(beginAttempt(back, { ...address(PROJECT), attempt: 2, goal: goal({ questions: ["one", "two"] }) }));
  assert.equal(same.value.attempts.length, 2);
  assert.equal(same.revision, found.revision);

  // "Interrupted" is why the cycle ended, not a verdict about progress: one question was accepted before the failure.
  const closed = deliveredOf(completeAttempt(back, {
    ...address(PROJECT), attempt: 2, outcome: outcome({ reason: "interrupted", achieved: [basis] }),
  }));
  assert.equal(closed.value.attempts[1]!.verdict, "progress");
  assert.equal(closed.value.withoutProgress, 0);
  // A re-delivered notification of the same interrupted outcome opens no new attempt.
  const echo = deliveredOf(completeAttempt(back, {
    ...address(PROJECT), attempt: 2, outcome: outcome({ reason: "interrupted", achieved: [basis] }),
  }));
  assert.equal(echo.revision, closed.revision);
  assert.equal(echo.value.attempts.length, 2);

  // The other variant: an interruption that left no accepted result is a completed attempt without progress.
  opened(back, "barren");
  deliveredOf(beginAttempt(back, { ...address("barren"), attempt: 1, goal: goal() }));
  const barren = deliveredOf(completeAttempt(back, { ...address("barren"), attempt: 1, outcome: outcome({ reason: "interrupted" }) }));
  assert.equal(barren.value.attempts[0]!.verdict, "none");
  assert.equal(barren.value.withoutProgress, 1);
});

test("\"awaiting owner\" neither raises the count nor clears it", t => {
  const { store } = fixture(t);
  opened(store);
  cycle(store, PROJECT, goal(), fruitless());
  cycle(store, PROJECT, goal(), fruitless());
  assert.equal(held(store)!.value.withoutProgress, 2);

  const waiting = cycle(store, PROJECT, goal(), outcome({ reason: "awaiting-owner" }));
  assert.equal(waiting.value.attempts[2]!.verdict, "neutral");
  assert.equal(waiting.value.withoutProgress, 2);
  assert.equal(waiting.value.stop, null);
  // Waiting is a completed cycle all the same: it stands in the history and is counted once.
  assert.equal(waiting.value.attempts.length, 3);

  // It neither clears the count: the next attempt without progress is the third, and it stops the series.
  const stopped = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(stopped.value.withoutProgress, 3);
  assert.deepEqual(stopped.value.stop!.attempts, [1, 2, 4]);

  // A cycle that only waits claims no achievement and cancels nothing: it reached no result to claim or lose.
  opened(store, "waits");
  deliveredOf(beginAttempt(store, { ...address("waits"), attempt: 1, goal: goal() }));
  for (const over of [{ achieved: [win(store, "line:A")] }, { cancelled: ["line:A"] }]) {
    addressed(refusalOf(completeAttempt(store, {
      ...address("waits"), attempt: 1, outcome: outcome({ reason: "awaiting-owner", ...over }),
    })), "outcome_invalid", "waits");
  }
  // An answer that came off-form ends the attempt without a result for the same reason, and is still counted.
  const off = deliveredOf(completeAttempt(store, { ...address("waits"), attempt: 1, outcome: outcome({ reason: "off-form" }) }));
  assert.equal(off.value.attempts[0]!.verdict, "none");
  assert.equal(off.value.withoutProgress, 1);
});

test("the third attempt without progress saves a stop a restart does not lift, and only a recorded ground continues", t => {
  const { path, store } = fixture(t);
  opened(store);
  cycle(store, PROJECT, goal(), refusedBy(store, PROJECT));
  cycle(store, PROJECT, goal(), refusedBy(store, PROJECT, { code: "work_not_atomic" }));
  assert.equal(held(store)!.value.stop, null);
  const stopped = cycle(store, PROJECT, goal({ key: "gap:cart:tax" }), refusedBy(store, PROJECT));

  const stop = stopped.value.stop!;
  assert.equal(stopped.value.withoutProgress, 3);
  assert.equal(stop.attempt, 3);
  assert.deepEqual(stop.attempts, [1, 2, 3]);
  // The explanation is assembled by code from the records of the attempts: which goals were set, and where to resume.
  assert.deepEqual(stop.goals, ["gap:cart:price", "gap:cart:tax"]);
  assert.ok(stop.reason.includes("3 consecutive attempts"));
  assert.ok(stop.resume.includes("attempt 4"));
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 4, goal: goal() })), "series_stopped");
  store.close();

  // A restart does not lift it: the stop is in the record, not in a process.
  const back = new Store(path);
  t.after(() => back.close());
  const read = deliveredOf(readSeries(back, address(PROJECT)));
  assert.deepEqual(read.value.stop, stop);
  assert.equal(read.value.withoutProgress, 3);
  addressed(refusalOf(beginAttempt(back, { ...address(PROJECT), attempt: 4, goal: goal() })), "series_stopped");

  // Only a recorded ground continues the work, and the ground is kept where the owner can read it.
  const text = "ask M5 to address the gap before proposing a layer";
  const resumed = deliveredOf(resumeSeries(back, { ...address(PROJECT), stop: 3, ground: "approach-changed", text }));
  assert.equal(resumed.value.stop, null);
  assert.deepEqual(resumed.value.continuations, [{ ground: "approach-changed", text, after: 3 }]);
  // Continuing is not progress: the count is untouched, so one more attempt that moves nothing stops the series again.
  assert.equal(resumed.value.withoutProgress, 3);

  const fourth = cycle(back, PROJECT, goal(), fruitless(), 1);
  assert.equal(fourth.value.withoutProgress, 4);
  assert.equal(fourth.value.stop!.attempt, 4);
  assert.deepEqual(fourth.value.stop!.attempts, [1, 2, 3, 4]);
  // And progress clears both the count and the road to the next stop.
  deliveredOf(resumeSeries(back, { ...address(PROJECT), stop: 4, ground: "owner-decision", text: "try the other producer" }));
  const won = cycle(back, PROJECT, goal(), outcome({ achieved: [win(back, "line:A")] }), 1);
  assert.equal(won.value.withoutProgress, 0);
  assert.equal(won.value.stop, null);
  assert.deepEqual(won.value.continuations.map(item => item.after), [3, 4]);
});

test("the identity of a goal survives a change of revisions, of ids and of the series around it", t => {
  const { store } = fixture(t);
  const first = opened(store, "chain");
  cycle(store, "chain", goal(), outcome({ achieved: [win(store, "line:A")] }));
  const before = cycle(store, "chain", goal(), fruitless());
  assert.equal(before.value.withoutProgress, 1);
  assert.ok(before.revision > first.revision);

  // The slice moved: a successor on a line of its own, standing on a recorded ground, carrying the whole history.
  const moved = deliveredOf(openSeries(store, {
    ...address("chain", 2), slice: "slice:cart@2", predecessor: reference(before),
    basis: { ground: "inputs-changed", text: "a dependency left the closure of this block" },
  }));
  assert.notEqual(moved.id, before.id);
  assert.equal(moved.revision, 1);
  assert.deepEqual(moved.value.predecessor, reference(before));
  assert.deepEqual(moved.value.inherited.map(item => item.ordinal), [1, 2]);
  assert.deepEqual(moved.value.inherited.map(item => item.verdict), ["progress", "none"]);
  assert.deepEqual(moved.value.attempts, []);
  // A change of inputs is a ground to continue, not progress: the count comes across with the history.
  assert.equal(moved.value.withoutProgress, 1);

  // Under a new id, at revision one, the goal is the same goal: its first result is still its first result.
  const retaken = cycle(store, "chain", goal(), outcome({ achieved: [win(store, "line:A")] }), 2);
  assert.equal(retaken.value.attempts[0]!.ordinal, 3);
  assert.equal(retaken.value.attempts[0]!.verdict, "none");
  assert.equal(retaken.value.withoutProgress, 2);
  const fresh = cycle(store, "chain", goal(), outcome({ achieved: [win(store, "line:C")] }), 2);
  assert.equal(fresh.value.attempts[1]!.verdict, "progress");
  assert.equal(fresh.value.withoutProgress, 0);

  // A stop the predecessor saved comes across with the history, and the recorded ground of the move continues it.
  opened(store, "halted");
  for (let round = 0; round < 3; round += 1) cycle(store, "halted", goal(), fruitless());
  const halted = deliveredOf(readSeries(store, address("halted")));
  assert.equal(halted.value.stop!.attempt, 3);
  const carried = deliveredOf(openSeries(store, {
    ...address("halted", 2), slice: "slice:cart@2", predecessor: reference(halted),
    basis: { ground: "inputs-changed", text: "the basis of the block was replaced" },
  }));
  assert.equal(carried.value.stop, null);
  assert.equal(carried.value.withoutProgress, 3);
  assert.deepEqual(carried.value.basis, { ground: "inputs-changed", text: "the basis of the block was replaced" });
  // The ground is recorded, so the next attempt runs; it is still the fourth without progress and stops again.
  const after = cycle(store, "halted", goal(), fruitless(), 2);
  assert.equal(after.value.withoutProgress, 4);
  assert.equal(after.value.stop!.attempt, 4);
});

test("every exported function refuses a missing, null or mistyped argument as a typed defect, never a TypeError", t => {
  const { store } = fixture(t);
  opened(store);
  deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  const calls: ((request: unknown, series: unknown) => void)[] = [
    (request, series) => { openSeries(series as Store, request as OpenSeriesRequest); },
    (request, series) => { beginAttempt(series as Store, request as BeginAttemptRequest); },
    (request, series) => { completeAttempt(series as Store, request as CompleteAttemptRequest); },
    (request, series) => { resumeSeries(series as Store, request as ResumeSeriesRequest); },
    (request, series) => { readSeries(series as Store, request as SeriesRequest); },
    (request, series) => { prepareOpenSeries(series as Store, request as OpenSeriesRequest); },
    (request, series) => { prepareBeginAttempt(series as Store, request as BeginAttemptRequest); },
    (request, series) => { prepareCompleteAttempt(series as Store, request as CompleteAttemptRequest); },
    (request, series) => { prepareResumeSeries(series as Store, request as ResumeSeriesRequest); },
  ];
  const [open, begin, complete, resume] = calls as [typeof calls[number], typeof calls[number], typeof calls[number], typeof calls[number]];
  const good: Record<string, unknown> = {
    ...address(PROJECT), slice: SLICE, predecessor: null, basis: null, goal: goal(),
    attempt: 1, outcome: outcome(), stop: 1, ground: "owner-decision", text: "carry on",
  };

  // No default argument stands in for a broken one: a helper quietly substituting the real store would test itself.
  for (const request of [null, undefined, "request", 7, [good]]) {
    for (const call of calls) assert.throws(() => call(request, store), code("series_request_invalid"));
  }
  for (const broken of [null, undefined, "store", 7, {}, { get: () => null, writeMany: () => [] }]) {
    for (const call of calls) assert.throws(() => call(good, broken), code("series_request_invalid"));
  }
  for (const project of [undefined, null, "", 7, {}, "alpha:beta", ":", "a".repeat(200)]) {
    for (const call of calls) assert.throws(() => call({ ...good, project }, store), code("series_request_invalid"));
    assert.throws(() => seriesId(project as string, BLOCK, 1), code("series_request_invalid"));
  }
  for (const block of [undefined, null, "", 7, {}, "b".repeat(200)]) {
    for (const call of calls) assert.throws(() => call({ ...good, block }, store), code("series_request_invalid"));
    assert.throws(() => seriesId(PROJECT, block as string, 1), code("series_request_invalid"));
  }
  for (const line of [undefined, null, 0, -1, 1.5, "1", {}]) {
    for (const call of calls) assert.throws(() => call({ ...good, line }, store), code("series_request_invalid"));
    assert.throws(() => seriesId(PROJECT, BLOCK, line as number), code("series_request_invalid"));
  }
  for (const slice of [undefined, null, "", 7, {}]) assert.throws(() => open({ ...good, slice }, store), code("series_request_invalid"));
  // The first line has no predecessor and no ground; any later one has both, and neither is defaulted.
  for (const predecessor of [undefined, "ref", 7, {}, { id: seriesId(PROJECT, BLOCK, 1), revision: 1 }]) {
    assert.throws(() => open({ ...good, predecessor }, store), code("series_request_invalid"));
  }
  assert.throws(() => open({ ...good, line: 2 }, store), code("series_request_invalid"));
  assert.throws(() => open({ ...good, predecessor: { id: seriesId(PROJECT, BLOCK, 1), revision: 1, hash: hex("a") } }, store), code("series_request_invalid"));
  for (const basis of [undefined, "basis", 7, {}, { ground: "invented", text: "why" }, { ground: "owner-decision", text: "" }]) {
    assert.throws(() => open({ ...good, line: 2, predecessor: { id: seriesId(PROJECT, BLOCK, 1), revision: 1, hash: hex("a") }, basis }, store), code("series_request_invalid"));
  }
  for (const over of [{ ground: undefined }, { ground: "invented" }, { text: undefined }, { text: "" }, { text: 7 }, { stop: undefined }, { stop: 0 }, { stop: 1.5 }, { stop: "1" }]) {
    assert.throws(() => resume({ ...good, ...over }, store), code("series_request_invalid"));
  }
  for (const goalValue of [undefined, null, "goal", 7, {}, without(goal() as unknown as Record<string, unknown>, "key"),
    { ...goal(), extra: 1 }, { ...goal(), questions: [] }, { ...goal(), questions: "one" }, { ...goal(), questions: [7] }, { ...goal(), result: "" }]) {
    assert.throws(() => begin({ ...good, goal: goalValue }, store), code("series_request_invalid"));
  }
  for (const attempt of [undefined, null, 0, -1, 1.5, "1", {}]) {
    assert.throws(() => begin({ ...good, attempt }, store), code("series_request_invalid"));
    assert.throws(() => complete({ ...good, attempt }, store), code("series_request_invalid"));
  }
  for (const value of [undefined, null, "outcome", 7, [], without(outcome() as unknown as Record<string, unknown>, "achieved"),
    { ...outcome(), extra: 1 }, { ...outcome(), reason: "invented" }, { ...outcome(), achieved: null },
    { ...outcome(), achieved: [{ key: "line:A" }] }, { ...outcome(), achieved: [{ key: "", basis: { id: "x", revision: 1, hash: hex("a") } }] },
    { ...outcome(), achieved: [{ key: "line:A", basis: { id: "x", revision: 1 } }] }, { ...outcome(), cancelled: [7] },
    // A refusal without its link, or with a field the series does not keep, is a defect of the calling code.
    { ...outcome(), refusals: [{ name: "n", goal: "g" }] }, { ...outcome(), refusals: [{ row: "r" }] },
    { ...outcome(), refusals: [{ name: "n", goal: "g", row: "" }] }, { ...outcome(), refusals: [{ name: "n", goal: "g", row: "r", class: "input" }] }]) {
    assert.throws(() => complete({ ...good, outcome: value }, store), code("series_request_invalid"));
  }
  assert.equal(held(store)!.value.attempts[0]!.outcome, null);
  assert.equal(store.history(seriesId(PROJECT, BLOCK, 1)).length, 2);
});

test("what a consumer is handed is a deep frozen copy, independent of the store and of the policy tables (T11)", t => {
  const { store } = fixture(t);
  opened(store);
  const first = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:A")] }));
  const again = deliveredOf(readSeries(store, address(PROJECT)));
  assert.notEqual(first.value, again.value);
  assert.deepEqual(first.value, again.value);
  assert.equal(hashJson(again.value), held(store)!.hash);
  assert.ok(deeplyFrozen(again));
  assert.throws(() => {
    // @ts-expect-error a delivered series is readonly at compile time, not only frozen at run time
    again.value.attempts[0]!.goal.key = "gap:invented";
  }, TypeError);
  assert.throws(() => { (again.value.attempts as unknown as unknown[]).push({}); }, TypeError);
  assert.equal(held(store)!.value.attempts[0]!.goal.key, "gap:cart:price");
  // A prepared change is handed over as a frozen copy as well: a caller cannot edit the write it is about to make.
  const prepared = deliveredOf(prepareBeginAttempt(store, { ...address(PROJECT), attempt: 2, goal: goal() }));
  assert.ok(deeplyFrozen(prepared));
  assert.equal(store.history(seriesId(PROJECT, BLOCK, 1)).length, 3);

  for (const table of [SERIES_CODES, COMPLETION_REASONS, ATTEMPT_VERDICTS, CONTINUATION_GROUNDS]) {
    assert.ok(Object.isFrozen(table));
    assert.throws(() => { (table as unknown as string[]).push("invented"); }, TypeError);
  }
  assert.throws(() => {
    // @ts-expect-error a policy table does not change while the module works, at compile time as well
    SERIES_CODES[0] = "invented";
  }, TypeError);
});

test("a series switches nothing else: the journal, the graph, gaps, readiness and the queue stay as they were (T8)", t => {
  const { store } = fixture(t);
  const refusal = refusedBy(store, PROJECT);
  const untouched = [
    store.write({ id: "graph:alpha", kind: "graph", expected: 0, value: { horizon: [BLOCK] } }),
    store.write({ id: "om-gaps:alpha", kind: "om-gaps", expected: 0, value: { open: ["gap:cart:price"] } }),
    store.write({ id: "om-readiness:alpha", kind: "om-readiness", expected: 0, value: { ready: false, basis: null } }),
    store.write({ id: "om-queue:alpha", kind: "om-queue", expected: 0, value: { order: [BLOCK] } }),
    store.get(`om-refusal-journal:${PROJECT}`)!,
  ];
  opened(store);
  const before = store.list().length;
  cycle(store, PROJECT, goal(), refusal);
  for (let round = 0; round < 2; round += 1) cycle(store, PROJECT, goal(), fruitless());
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ground: "inputs-changed", text: "the stage was accepted anew" }));

  for (const record of untouched) {
    const now = store.get(record.id)!;
    assert.equal(now.revision, record.revision, record.id);
    assert.equal(now.hash, record.hash, record.id);
    assert.equal(store.history(record.id).length, record.revision, record.id);
  }
  // Only the series itself was written; the journal it reads a refusal from is read, never appended to.
  assert.equal(store.list().length, before);
  assert.deepEqual(store.list(REPAIR_SERIES_KIND).map(record => record.id), [seriesId(PROJECT, BLOCK, 1)]);
  const series = deliveredOf(readSeries(store, address(PROJECT)));
  assert.equal(series.value.stop, null);
  assert.equal(series.value.withoutProgress, 3);
  assert.deepEqual((series.value.attempts as readonly Attempt[]).map(item => item.verdict), ["none", "none", "none"]);
});
