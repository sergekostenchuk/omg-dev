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
  beginAttempt, completeAttempt, escalateSeries, openSeries, readSeries, readStopHistory, resumeSeries, seriesId,
  prepareBeginAttempt, prepareCompleteAttempt, prepareEscalateSeries, prepareOpenSeries, prepareResumeSeries,
  inputFixNamespace, ownerDecisionNamespace, stopReviewNamespace,
  ATTEMPT_VERDICTS, COMPLETION_REASONS, CONTINUATION_GROUNDS, INPUT_FIX_KIND, OWNER_DECISION_KIND,
  REPAIR_SERIES_KIND, SERIES_CODES, STOP_REVIEW_KIND, SUCCESSION_GROUNDS,
  type Attempt, type AttemptGoal, type BeginAttemptRequest, type ClaimedOutcome, type ClaimedRefusal,
  type CompleteAttemptRequest, type Continuation, type EscalateSeriesRequest, type OpenSeriesRequest, type RepairSeries,
  type GroundRecord, type ResumeSeriesRequest, type SeriesRequest, type SeriesTransition,
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
          sources: (over['sources'] as Json | undefined)
            ?? [{ role: "proposal", ref: { id: "layer-proposal:7", revision: 2, hash: hex("b") } }],
        },
      }],
    },
  });
  const journal = deliveredOf(recordRefusal(store, { project, source: reference(source) }));
  return { name, goal, row: journal.value.rows[journal.value.rows.length - 1]!.id };
}

/**
 * The record of a review of a stop with an independent reviewer — what A6 will write, and all this unit reads of it.
 * "independent" is in it on purpose: the series must not lift a stop because a record says so about itself.
 */
const review = (project: string, stop: number, goals: readonly string[] = ["gap:cart:price"], over: Record<string, unknown> = {}) => ({
  projectId: project, block: BLOCK, stop, goals: [...goals],
  reviewer: { name: "a reviewer who is not the executor", independent: true },
  context: { attempts: [stop - 2, stop - 1, stop], refusals: ["graph_invalid"] },
  cause: "the same question goes to the same producer every cycle, and its answer is refused for the same reason",
  change: { text: "ask M5 to address the gap before a layer is proposed", addresses: ["M5", "MC2"] },
  ...over,
});

const reviewed = (store: Store, project: string, value: Record<string, unknown>, kind = STOP_REVIEW_KIND, prefix?: string): Ref =>
  reference(store.write({ id: `${prefix ?? stopReviewNamespace(project)}${next()}`, kind, expected: 0, value: value as Json }));

/** The record of the repeated addressed check that confirms a fixed input — what B1 and A4 will write. */
const confirmed = (store: Store, project: string, value: Record<string, unknown>, kind = INPUT_FIX_KIND, prefix?: string): Ref =>
  reference(store.write({ id: `${prefix ?? inputFixNamespace(project)}${next()}`, kind, expected: 0, value: value as Json }));

/**
 * A review that ENDED WITHOUT A DECISION: it says so in its own content — here a cause, and explicitly no usable change.
 * It is what A6 writes when the reviewer found nothing to change, and the ground of an escalation, never of a
 * continuation.
 */
const undecided = (store: Store, project: string, stop: number, goals?: readonly string[], over: Record<string, unknown> = {}): Ref =>
  reviewed(store, project, review(project, stop, goals, { change: null, ...over }));

const byReview = (store: Store, project: string, stop: number, goals?: readonly string[], over: Record<string, unknown> = {}) =>
  ({ ground: "review-record", text: "the review named a cause and a change", review: { ref: reviewed(store, project, review(project, stop, goals, over)) } } as const);

/**
 * The record the owner's decision is taken in — what the command API of H2 will write, and all this unit reads of it.
 * "taken" is in it on purpose: the series must not continue because a record says of itself that the owner approved.
 */
const decision = (project: string, stop: number, goals: readonly string[] = ["gap:cart:price"], over: Record<string, unknown> = {}) => ({
  projectId: project, block: BLOCK, stop, goals: [...goals],
  decided: "go on: I have read what was tried and I want one more window",
  taken: { by: "the owner", through: "the command API", approved: true },
  ...over,
});

const decided = (store: Store, project: string, value: Record<string, unknown>, kind = OWNER_DECISION_KIND, prefix?: string): Ref =>
  reference(store.write({ id: `${prefix ?? ownerDecisionNamespace(project)}${next()}`, kind, expected: 0, value: value as Json }));

const byOwner = (store: Store, project: string, stop: number, goals?: readonly string[], over: Record<string, unknown> = {}) =>
  ({ ground: "owner-decision", text: "the owner decided to go on", decision: { ref: decided(store, project, decision(project, stop, goals, over)) } } as const);

/**
 * A record its writer hands over to be written WITH the change it grounds — what A6 does with a review it has just
 * had back, H2 with the owner's decision, B1 and A4 with the confirmation of a re-check. Nothing of it is in the
 * store until the transition is applied.
 */
const onItsWay = (id: string, kind: string, value: Record<string, unknown>): GroundRecord =>
  ({ pending: { id, kind, value: value as Json } });

const unwritten = (project: string, kind: string): string => {
  const namespace = kind === STOP_REVIEW_KIND ? stopReviewNamespace(project)
    : kind === INPUT_FIX_KIND ? inputFixNamespace(project) : ownerDecisionNamespace(project);
  return `${namespace}${next()}`;
};

/**
 * The stored form of a ground a request was made with: the series keeps the exact reference of each record, whichever
 * of the two ways it came by.
 */
function storedGround(ground: Record<string, unknown>, after: number): Record<string, unknown> {
  const taken = (source: unknown): Ref => (source as { ref: Ref }).ref;
  if (ground['ground'] === "review-record") return { ground: "review-record", text: ground['text'], review: taken(ground['review']), after };
  if (ground['ground'] === "inputs-fixed") {
    return { ground: "inputs-fixed", text: ground['text'], refusal: ground['refusal'], input: ground['input'], confirmation: taken(ground['confirmation']), after };
  }
  return { ground: "owner-decision", text: ground['text'], decision: taken(ground['decision']), after };
}

/** A refusal a gate wrote against a named input of this project, and the exact revision the attempts ran with. */
function fixable(store: Store, project: string, earlier = 0): { input: Ref; refusal: ClaimedRefusal } {
  const id = `om-stage:${project}:${next()}`;
  let input = store.write({ id, kind: "om-stage", expected: 0, value: { rows: ["the price of a cart line names no producer"] } });
  // Revisions the attempts never ran with, so that "a later revision" can be told from "another revision".
  for (let round = 0; round < earlier; round += 1) {
    input = store.write({ id, kind: "om-stage", expected: input.revision, value: { rows: ["and the tax of a cart line names none either", round] } });
  }
  return { input: reference(input), refusal: journalled(store, project, { sources: [{ role: "input", ref: reference(input) }] }) };
}

/** The input fixed at a later revision, and the confirmation of the repeated addressed check that says so. */
function byFix(store: Store, project: string, base: { input: Ref; refusal: ClaimedRefusal }, over: Record<string, unknown> = {}) {
  const head = store.get(base.input.id)!;
  const better = store.write({
    id: base.input.id, kind: "om-stage", expected: head.revision,
    value: { rows: ["the price of a cart line is produced by the pricing operation", head.revision] },
  });
  return {
    ground: "inputs-fixed", text: "the stage was corrected and the addressed check was run again",
    refusal: base.refusal.row, input: base.input,
    confirmation: { ref: confirmed(store, project, { refusal: base.refusal.row, input: reference(better), check: "addressed", ...over }) },
  } as const;
}

/** Three cycles that move nothing, all refused by the same journalled refusal, so a stop names it. */
function circled(store: Store, project: string, refusal: ClaimedRefusal, line = 1): void {
  for (let round = 0; round < 3; round += 1) {
    cycle(store, project, goal(), outcome({ reason: "refused", refusals: [refusal] }), line);
  }
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
  deliveredOf(resumeSeries(store, { ...address("p12"), stop: 3, ...byOwner(store, "p12", 3) }));
  record(refusalOf(resumeSeries(store, { ...address("p12"), stop: 3, ...byOwner(store, "p12", 3) })), "continuation_conflict", "p12");

  opened(store, "p13");
  record(refusalOf(resumeSeries(store, { ...address("p13"), stop: 1, ...byOwner(store, "p13", 1) })), "stop_absent", "p13");

  opened(store, "p14");
  deliveredOf(beginAttempt(store, { ...address("p14"), attempt: 1, goal: goal() }));
  record(refusalOf(completeAttempt(store, {
    ...address("p14"), attempt: 1, outcome: outcome({ reason: "refused", refusals: [{ name: "graph_invalid", goal: "a goal", row: "om-refusal:invented" }] }),
  })), "refusal_unlinked", "p14");

  // The second rung: the first was spent without a new accepted result, so nothing but the owner's decision continues.
  opened(store, "p15");
  for (let round = 0; round < 3; round += 1) cycle(store, "p15", goal(), fruitless());
  deliveredOf(resumeSeries(store, { ...address("p15"), stop: 3, ...byReview(store, "p15", 3) }));
  for (let round = 0; round < 3; round += 1) cycle(store, "p15", goal(), fruitless());
  const owed = addressed(refusalOf(resumeSeries(store, { ...address("p15"), stop: 6, ...byReview(store, "p15", 6) })), "owner_required", "p15");
  assert.equal(owed.route, "owner");
  seen.push(owed.code);

  // A review of another stop is no ground to lift this one.
  opened(store, "p16");
  for (let round = 0; round < 3; round += 1) cycle(store, "p16", goal(), fruitless());
  record(refusalOf(resumeSeries(store, { ...address("p16"), stop: 3, ...byReview(store, "p16", 9) })), "review_unusable", "p16");

  // A decision taken about another stop is no ground to lift this one either, and it goes back to the owner.
  opened(store, "p16b");
  for (let round = 0; round < 3; round += 1) cycle(store, "p16b", goal(), fruitless());
  const misdirected = addressed(refusalOf(resumeSeries(store, { ...address("p16b"), stop: 3, ...byOwner(store, "p16b", 9) })), "decision_unusable", "p16b");
  // A stop escalated on one review is not escalated again on another.
  opened(store, "p16c");
  for (let round = 0; round < 3; round += 1) cycle(store, "p16c", goal(), fruitless());
  deliveredOf(escalateSeries(store, { ...address("p16c"), stop: 3, review: { ref: undecided(store, "p16c", 3) } }));
  record(refusalOf(escalateSeries(store, { ...address("p16c"), stop: 3, review: { ref: undecided(store, "p16c", 3) } })), "escalation_conflict", "p16c");
  assert.equal(misdirected.route, "owner");
  seen.push(misdirected.code);

  // A fixed input that fixes a refusal these attempts never ran into.
  opened(store, "p17");
  for (let round = 0; round < 3; round += 1) cycle(store, "p17", goal(), fruitless());
  const stranger = journalled(store, "p17");
  record(refusalOf(resumeSeries(store, {
    ...address("p17"), stop: 3, ground: "inputs-fixed", text: "the stage was corrected",
    refusal: stranger.row, input: { id: "layer-proposal:7", revision: 2, hash: hex("b") },
    confirmation: { ref: confirmed(store, "p17", { refusal: stranger.row, input: { id: "layer-proposal:7", revision: 3, hash: hex("c") } }) },
  })), "input_unfixed", "p17");

  assert.deepEqual([...new Set(seen)].sort(), [...SERIES_CODES].sort());
});

test("an absent argument, field or set is a typed refusal that names the address, while an explicit emptiness is not (T4)", t => {
  const { store } = fixture(t);
  // An absent series is not an empty one: a block never repaired and a series lost read differently.
  for (const call of [
    () => readSeries(store, address("empty")),
    () => beginAttempt(store, { ...address("empty"), attempt: 1, goal: goal() }),
    () => completeAttempt(store, { ...address("empty"), attempt: 1, outcome: outcome() }),
    () => resumeSeries(store, { ...address("empty"), stop: 1, ...byOwner(store, "empty", 1) }),
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
  // The ladder is as obligatory as the count: a series that carries no rung at all carries no series.
  assert.equal(stored(value => without({ ...value }, "ladder"), "series_invalid", "a12"), "value");
  assert.equal(stored(value => ({ ...value, ladder: null }), "series_invalid", "a13"), "ladder");
  assert.equal(stored(value => ({ ...value, ladder: without({ ...value.ladder }, "grounds") }), "series_invalid", "a14"), "ladder");

  // A ground held without the record it is made of: the continuation names a review nobody can read.
  const continued = (build: (item: Continuation) => Record<string, unknown>, project: string): string | undefined => {
    opened(store, project);
    for (let round = 0; round < 3; round += 1) cycle(store, project, goal(), fruitless());
    deliveredOf(resumeSeries(store, { ...address(project), stop: 3, ...byReview(store, project, 3) }));
    forge(store, project, value => ({ ...value, continuations: [build(value.continuations[0]!)] }));
    return addressed(refusalOf(readSeries(store, address(project))), "series_invalid", project).at.field;
  };
  assert.equal(continued(item => without({ ...item }, "review"), "a15"), "continuations.0.review");
  assert.equal(continued(item => ({ ...item, review: null }), "a16"), "continuations.0.review");
  assert.equal(continued(item => without({ ...item }, "text"), "a17"), "continuations.0.text");
  assert.equal(continued(item => without({ ...item }, "after"), "a18"), "continuations.0");
  // And a ground padded out with a record its own rule never names is not that ground either.
  assert.equal(continued(item => ({ ...item, confirmation: { id: "x", revision: 1, hash: hex("a") } }), "a19"), "continuations.0");

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
    ["a ladder standing at a rung its continuations never climbed",
      value => ({ ...value, ladder: { ...value.ladder, rung: 2, grounds: ["owner-decision"] } })],
    ["a ladder admitting a ground its rung does not",
      value => ({ ...value, ladder: { ...value.ladder, grounds: [...value.ladder.grounds, "approach-changed"] } })],
    ["a ladder claiming windows that were never opened",
      value => ({ ...value, ladder: { ...value.ladder, windows: [4] } })],
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
    addressed(refusalOf(resumeSeries(store, { ...address(project), stop: 4, ...byOwner(store, project, 4) })), "series_invalid", project);
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

  // The competitor continues the stopped series while this call is continuing it on another ground. The review this
  // call stands on is perfectly good: the window it would have opened is lost with the transaction, not half-opened.
  const contested = byReview(store, PROJECT, 4);
  const rival = byOwner(store, PROJECT, 4);
  store.armed = true;
  store.run = other => { deliveredOf(resumeSeries(other, { ...address(PROJECT), stop: 4, ...rival })); };
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 4, ...contested })), "input_stale");
  assert.deepEqual(held(store)!.value.continuations.map(item => item.ground), ["owner-decision"]);
  assert.equal(held(store)!.value.ladder.rung, 2);

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
  // THE STOP. Three attempts without progress, a review recorded for that stop, and three more before it stops again.
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  const ground = byReview(store, PROJECT, 3);
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  for (let round = 0; round < 2; round += 1) assert.equal(cycle(store, PROJECT, goal(), fruitless()).value.stop, null);
  const sixth = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(sixth.value.stop!.attempt, 6);

  // The SAME continuation delivered again is about the stop after attempt three, which is continued already. It
  // changes nothing and it does not lift the stop saved after attempt six.
  const late = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(late.revision, sixth.revision);
  assert.deepEqual(late.value, sixth.value);
  assert.equal(late.value.stop!.attempt, 6);
  assert.deepEqual(late.value.continuations.map(item => item.after), [3]);
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 7, goal: goal() })), "series_stopped");
  // A ground given for a stop that never stood is refused, and so is a second ground for one already continued.
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 2, ...byOwner(store, PROJECT, 2) })), "stop_absent");
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...byOwner(store, PROJECT, 3) })), "continuation_conflict");
  assert.equal(store.history(seriesId(PROJECT, BLOCK, 1)).length, sixth.revision);

  // THE ATTEMPT. A "begin" that arrives late finds the attempt it was about, closed long since, and opens nothing.
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byOwner(store, PROJECT, 6) }));
  const moved = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:A")] }));
  assert.equal(moved.value.attempts.length, 7);
  const echo = deliveredOf(beginAttempt(store, { ...address(PROJECT), attempt: 1, goal: goal() }));
  assert.equal(echo.revision, moved.revision);
  assert.equal(echo.value.attempts.length, 7);
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
  assert.equal(one.writes.length, 1);
  assert.equal(one.writes[0]!.kind, REPAIR_SERIES_KIND);
  assert.equal(one.writes[0]!.expected, 0);
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
    writes: [...parts.flatMap(part => [...part.writes]), transition()],
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
  assert.deepEqual(repeat.writes, []);
  assert.deepEqual(repeat.guards, []);
  assert.deepEqual(repeat.value, deliveredOf(readSeries(store, at(BLOCK, 2))).value);
  // And a prepared change that cannot be made is refused at preparation, before anything is written.
  assert.equal(refusalOf(prepareBeginAttempt(store, { ...at(BLOCK, 2), attempt: 9, goal: goal() })).code, "attempt_unknown");
  assert.equal(refusalOf(prepareResumeSeries(store, { ...at(BLOCK, 2), stop: 1, ...byOwner(store, PROJECT, 1) })).code, "stop_absent");
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

  // Only a ground of the rung the ladder stands at continues the work, and it is kept where the owner can read it.
  const ground = byReview(back, PROJECT, 3, stop.goals);
  const resumed = deliveredOf(resumeSeries(back, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(resumed.value.stop, null);
  assert.deepEqual(resumed.value.continuations, [storedGround(ground, 3)]);
  // The continuation opens a NEW window: the count starts again, and it is not progress — the rung is spent, and the
  // ladder now stands for the goals that stop was raised for.
  assert.equal(resumed.value.withoutProgress, 0);
  assert.equal(resumed.value.ladder.rung, 2);
  assert.deepEqual(resumed.value.ladder.goals, stop.goals);
  assert.deepEqual(resumed.value.ladder.windows, [3]);
  assert.deepEqual(resumed.value.ladder.grounds, ["owner-decision"]);

  // Two more attempts that move nothing do not stop it; the third of the new window does.
  for (let round = 0; round < 2; round += 1) assert.equal(cycle(back, PROJECT, goal(), fruitless(), 1).value.stop, null);
  const sixth = cycle(back, PROJECT, goal(), fruitless(), 1);
  assert.equal(sixth.value.withoutProgress, 3);
  assert.equal(sixth.value.stop!.attempt, 6);
  assert.deepEqual(sixth.value.stop!.attempts, [4, 5, 6]);
  assert.ok(sixth.value.stop!.resume.includes("owner"));
  // And progress clears the count, the road to the next stop and the ladder.
  deliveredOf(resumeSeries(back, { ...address(PROJECT), stop: 6, ...byOwner(back, PROJECT, 6) }));
  const won = cycle(back, PROJECT, goal(), outcome({ achieved: [win(back, "line:A")] }), 1);
  assert.equal(won.value.withoutProgress, 0);
  assert.equal(won.value.stop, null);
  assert.deepEqual(won.value.ladder, { rung: 1, goals: [], windows: [], grounds: [...CONTINUATION_GROUNDS] });
  assert.deepEqual(won.value.continuations.map(item => item.after), [3, 6]);
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

  // A stop the predecessor saved comes across with the history, and the move does NOT continue it: one change of
  // horizon is a ground to open a successor, never a ground to go on.
  opened(store, "halted");
  for (let round = 0; round < 3; round += 1) cycle(store, "halted", goal(), fruitless());
  const halted = deliveredOf(readSeries(store, address("halted")));
  assert.equal(halted.value.stop!.attempt, 3);
  const carried = deliveredOf(openSeries(store, {
    ...address("halted", 2), slice: "slice:cart@2", predecessor: reference(halted),
    basis: { ground: "inputs-changed", text: "the basis of the block was replaced" },
  }));
  assert.deepEqual(carried.value.stop, halted.value.stop);
  assert.equal(carried.value.withoutProgress, 3);
  assert.deepEqual(carried.value.basis, { ground: "inputs-changed", text: "the basis of the block was replaced" });
  addressed(refusalOf(beginAttempt(store, { ...address("halted", 2), attempt: 4, goal: goal() })), "series_stopped", "halted", 2);

  // The stop is continued in the successor, where it now stands, and that opens the window the attempts run in.
  deliveredOf(resumeSeries(store, { ...address("halted", 2), stop: 3, ...byReview(store, "halted", 3) }));
  const after = cycle(store, "halted", goal(), fruitless(), 2);
  assert.equal(after.value.withoutProgress, 1);
  assert.equal(after.value.stop, null);
  assert.deepEqual(after.value.continuations.map(item => item.after), [3]);
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
    (request, series) => { escalateSeries(series as Store, request as EscalateSeriesRequest); },
    (request, series) => { prepareEscalateSeries(series as Store, request as EscalateSeriesRequest); },
  ];
  const [open, begin, complete, resume] = calls as [typeof calls[number], typeof calls[number], typeof calls[number], typeof calls[number]];
  const good: Record<string, unknown> = {
    ...address(PROJECT), slice: SLICE, predecessor: null, basis: null, goal: goal(),
    attempt: 1, outcome: outcome(), stop: 1, ground: "owner-decision", text: "carry on",
    review: { id: `${stopReviewNamespace(PROJECT)}1`, revision: 1, hash: hex("a") },
    decision: { id: `${ownerDecisionNamespace(PROJECT)}1`, revision: 1, hash: hex("a") },
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
  // A ground to CONTINUE is not a ground to open a successor: the vocabularies are different, and neither defaults.
  for (const basis of [undefined, "basis", 7, {}, { ground: "invented", text: "why" }, { ground: "inputs-changed", text: "" },
    { ground: "owner-decision", text: "why" }, { ground: "review-record", text: "why" }, { ground: "inputs-fixed", text: "why" }]) {
    assert.throws(() => open({ ...good, line: 2, predecessor: { id: seriesId(PROJECT, BLOCK, 1), revision: 1, hash: hex("a") }, basis }, store), code("series_request_invalid"));
  }
  const ref = { id: "om-input:alpha", revision: 1, hash: hex("a") };
  for (const over of [{ ground: undefined }, { ground: "invented" }, { text: undefined }, { text: "" }, { text: 7 }, { stop: undefined }, { stop: 0 }, { stop: 1.5 }, { stop: "1" },
    // The ground the executor used to write by its own hand is gone, and so is the ground a successor stands on.
    { ground: "approach-changed" }, { ground: "inputs-changed" },
    // A ground without the records it is made of is no ground: nothing stands in for an absent reference.
    { ground: "review-record", review: undefined }, { ground: "review-record", review: null }, { ground: "review-record", review: "om-stop-review:alpha:1" },
    { ground: "review-record", review: { id: "om-stop-review:alpha:1", revision: 1 } },
    { ground: "inputs-fixed" }, { ground: "inputs-fixed", refusal: "row", input: ref },
    { ground: "inputs-fixed", refusal: "", input: ref, confirmation: ref },
    { ground: "inputs-fixed", refusal: "row", input: null, confirmation: ref },
    { ground: "inputs-fixed", refusal: "row", input: ref, confirmation: { id: "x", revision: 0, hash: hex("a") } },
    // The owner's decision is a record as well: without the reference to it there is no ground, only a sentence.
    { decision: null }, { decision: "om-owner-decision:alpha:1" }, { decision: { id: "x", revision: 1 } },
    { decision: { id: "", revision: 1, hash: hex("a") } }]) {
    assert.throws(() => resume({ ...good, ...over }, store), code("series_request_invalid"));
  }
  assert.throws(() => resume(without(good, "decision"), store), code("series_request_invalid"));
  // An escalation names its stop and the exact review; neither is defaulted, and a review is never named by a word.
  const escalate = calls[9]!;
  for (const over of [{ stop: undefined }, { stop: 0 }, { stop: 1.5 }, { stop: "1" }, { review: null }, { review: "om-stop-review:alpha:1" },
    { review: { id: "om-stop-review:alpha:1", revision: 1 } }, { review: { id: "", revision: 1, hash: hex("a") } }]) {
    assert.throws(() => escalate({ ...good, ...over }, store), code("series_request_invalid"));
  }
  assert.throws(() => escalate(without(good, "review"), store), code("series_request_invalid"));
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

  for (const table of [SERIES_CODES, COMPLETION_REASONS, ATTEMPT_VERDICTS, CONTINUATION_GROUNDS, SUCCESSION_GROUNDS]) {
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
  // The record the ground stands on is written by whoever writes it — the command API, not the series; it is in
  // place before the count is taken, so that what the series itself adds to the store can be seen to be nothing.
  const ownerGround = byOwner(store, PROJECT, 3);
  const before = store.list().length;
  cycle(store, PROJECT, goal(), refusal);
  for (let round = 0; round < 2; round += 1) cycle(store, PROJECT, goal(), fruitless());
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ownerGround }));

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
  assert.equal(series.value.withoutProgress, 0);
  assert.equal(series.value.ladder.rung, 2);
  assert.deepEqual((series.value.attempts as readonly Attempt[]).map(item => item.verdict), ["none", "none", "none"]);
});

// ---------------------------------------------------------------------------
// The ladder after a stop (owner's decision of 21.09.2026, journal entry 170).

test("a continuation on the record of a review opens a new window: three attempts again before the next stop", t => {
  const { path, store } = fixture(t);
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  const stopped = deliveredOf(readSeries(store, address(PROJECT)));
  assert.equal(stopped.value.stop!.attempt, 3);
  // At the start the ladder stands at its first rung, and the stop says what that rung asks for.
  assert.deepEqual(stopped.value.ladder, { rung: 1, goals: [], windows: [], grounds: [...CONTINUATION_GROUNDS] });
  assert.ok(stopped.value.stop!.resume.includes("first rung"));
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 4, goal: goal() })), "series_stopped");

  const ground = byReview(store, PROJECT, 3);
  const resumed = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(resumed.value.stop, null);
  assert.deepEqual(resumed.value.continuations, [storedGround(ground, 3)]);
  // The continuation is no progress: no verdict changed, nothing was accepted, and the rung it stood on is spent.
  assert.deepEqual(verdicts(resumed.value), ["none", "none", "none"]);
  assert.deepEqual(resumed.value.ladder, { rung: 2, goals: ["gap:cart:price"], windows: [3], grounds: ["owner-decision"] });
  // But the window starts again: the count of attempts without progress begins from nothing.
  assert.equal(resumed.value.withoutProgress, 0);

  const fourth = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(fourth.value.withoutProgress, 1);
  assert.equal(fourth.value.stop, null);
  const fifth = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(fifth.value.withoutProgress, 2);
  assert.equal(fifth.value.stop, null);
  // The third of the NEW window stops the series, and the stop names that window, not the whole history.
  const sixth = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(sixth.value.withoutProgress, 3);
  assert.equal(sixth.value.stop!.attempt, 6);
  assert.deepEqual(sixth.value.stop!.attempts, [4, 5, 6]);
  assert.ok(sixth.value.stop!.resume.includes("owner"));
  assert.equal(sixth.value.attempts.length, 6);

  // A restart derives the same ladder from the same history: it is in the record, not in a process.
  store.close();
  const back = new Store(path);
  t.after(() => back.close());
  assert.deepEqual(deliveredOf(readSeries(back, address(PROJECT))).value, sixth.value);
});

test("a second stop with no new accepted result of the goal is continued by the owner and by nobody else", t => {
  const { store } = fixture(t);
  const base = fixable(store, PROJECT);
  opened(store);
  circled(store, PROJECT, base.refusal);
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...byReview(store, PROJECT, 3) }));
  circled(store, PROJECT, base.refusal);
  const standing = held(store)!;
  assert.equal(standing.value.stop!.attempt, 6);
  assert.equal(standing.value.ladder.rung, 2);

  // The record of a review of THIS stop, and a fix of the very input these attempts ran into, both perfectly formed:
  // at the second rung neither is a ground, and the refusal goes to the owner.
  for (const ground of [byReview(store, PROJECT, 6), byFix(store, PROJECT, base)]) {
    const refusal = addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...ground })), "owner_required");
    assert.equal(refusal.route, "owner");
    assert.equal(refusal.at.field, "ground");
    assert.ok(refusal.message.includes("gap:cart:price"));
  }
  // Both ways in are the same way: what is prepared for another unit's transaction is refused at preparation too.
  assert.equal(refusalOf(prepareResumeSeries(store, { ...address(PROJECT), stop: 6, ...byReview(store, PROJECT, 6) })).code, "owner_required");
  assert.equal(refusalOf(prepareResumeSeries(store, { ...address(PROJECT), stop: 6, ...byFix(store, PROJECT, base) })).code, "owner_required");
  assert.equal(deliveredOf(prepareResumeSeries(store, { ...address(PROJECT), stop: 6, ...byOwner(store, PROJECT, 6) })).writes[0]!.expected, standing.revision);

  // The refusal switched nothing (T8): the stop stands, no window opened, no revision was written.
  const after = held(store)!;
  assert.equal(after.revision, standing.revision);
  assert.deepEqual(after.value.stop, standing.value.stop);
  assert.deepEqual(after.value.continuations.map(item => item.after), [3]);
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 7, goal: goal() })), "series_stopped");

  const owned = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byOwner(store, PROJECT, 6) }));
  assert.equal(owned.value.stop, null);
  assert.equal(owned.value.withoutProgress, 0);
  assert.deepEqual(owned.value.ladder.windows, [3, 6]);
  assert.deepEqual(owned.value.ladder.goals, ["gap:cart:price"]);
});

test("the owner's decision opens a window of its own, and the next stop is the owner's again", t => {
  const { store } = fixture(t);
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  // The owner may decide at any rung, including the first, and that spends the rung like any continuation.
  const first = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...byOwner(store, PROJECT, 3) }));
  assert.equal(first.value.ladder.rung, 2);
  for (let round = 0; round < 2; round += 1) assert.equal(cycle(store, PROJECT, goal(), fruitless()).value.stop, null);
  const second = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(second.value.stop!.attempt, 6);

  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byOwner(store, PROJECT, 6) }));
  for (let round = 0; round < 2; round += 1) assert.equal(cycle(store, PROJECT, goal(), fruitless()).value.stop, null);
  const third = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(third.value.stop!.attempt, 9);
  // The ladder does not climb back down to the reviewer, however many windows the owner opens.
  assert.equal(third.value.ladder.rung, 2);
  assert.deepEqual(third.value.ladder.windows, [3, 6]);
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 9, ...byReview(store, PROJECT, 9) })), "owner_required");
  const again = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 9, ...byOwner(store, PROJECT, 9) }));
  assert.deepEqual(again.value.ladder.windows, [3, 6, 9]);
  assert.equal(again.value.stop, null);
});

test("only a new accepted result of the goal the ladder stands for returns it to the start", t => {
  const { store } = fixture(t);
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...byReview(store, PROJECT, 3) }));

  // A result accepted for ANOTHER goal opens a window, as any progress does, but the rung stays where it was.
  const other = cycle(store, PROJECT, goal({ key: "gap:cart:tax" }), outcome({ achieved: [win(store, "line:tax")] }));
  assert.equal(other.value.attempts[3]!.verdict, "progress");
  assert.equal(other.value.withoutProgress, 0);
  assert.equal(other.value.ladder.rung, 2);
  assert.deepEqual(other.value.ladder.goals, ["gap:cart:price"]);
  for (let round = 0; round < 2; round += 1) cycle(store, PROJECT, goal(), fruitless());
  const stopped = cycle(store, PROJECT, goal(), fruitless());
  assert.equal(stopped.value.stop!.attempt, 7);
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 7, ...byReview(store, PROJECT, 7) })), "owner_required");
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 7, ...byOwner(store, PROJECT, 7) }));

  // A new accepted result of the goal itself does return it: the ladder is at the start, and the reviewer is a ground.
  const won = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:price")] }));
  assert.deepEqual(won.value.ladder, { rung: 1, goals: [], windows: [], grounds: [...CONTINUATION_GROUNDS] });
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  assert.equal(held(store)!.value.stop!.attempt, 11);
  const resumed = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 11, ...byReview(store, PROJECT, 11) }));
  assert.equal(resumed.value.stop, null);
  assert.deepEqual(resumed.value.ladder.windows, [11]);

  // Re-taking a result this goal already had is no new result, so it returns nothing.
  for (let round = 0; round < 2; round += 1) cycle(store, PROJECT, goal(), fruitless());
  const retaken = cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:price")] }));
  assert.equal(retaken.value.attempts[13]!.verdict, "none");
  assert.equal(retaken.value.ladder.rung, 2);
  assert.equal(retaken.value.stop!.attempt, 14);
});

test("the state of the ladder outlives a successor, a change of slice and a return to the earlier subject", t => {
  const { store } = fixture(t);
  const at = (line: number): SeriesRequest => address("long", line);
  const moved = (line: number, slice: string, from: Revision<RepairSeries>) => deliveredOf(openSeries(store, {
    ...at(line), slice, predecessor: reference(from), basis: { ground: "inputs-changed", text: "the closure of the block moved" },
  }));
  opened(store, "long");
  for (let round = 0; round < 3; round += 1) cycle(store, "long", goal(), fruitless());
  deliveredOf(resumeSeries(store, { ...at(1), stop: 3, ...byReview(store, "long", 3) }));
  for (let round = 0; round < 3; round += 1) cycle(store, "long", goal(), fruitless());
  const first = deliveredOf(readSeries(store, at(1)));
  assert.equal(first.value.stop!.attempt, 6);
  assert.equal(first.value.ladder.rung, 2);

  // The slice moves. The stop comes across still standing — one change of horizon lifts nothing — and so do the
  // count, the window already opened and the rung.
  const second = moved(2, "slice:cart@2", first);
  assert.deepEqual(second.value.stop, first.value.stop);
  assert.deepEqual(second.value.ladder, first.value.ladder);
  assert.deepEqual(second.value.continuations.map(item => item.after), [3]);
  assert.equal(second.value.withoutProgress, 3);
  addressed(refusalOf(beginAttempt(store, { ...at(2), attempt: 7, goal: goal() })), "series_stopped", "long", 2);
  addressed(refusalOf(resumeSeries(store, { ...at(2), stop: 6, ...byReview(store, "long", 6) })), "owner_required", "long", 2);

  // And back to the subject it started on: another line, the same history, and the same rung of the same ladder.
  const third = moved(3, SLICE, second);
  assert.deepEqual(third.value.ladder, first.value.ladder);
  assert.deepEqual(third.value.stop, first.value.stop);
  addressed(refusalOf(resumeSeries(store, { ...at(3), stop: 6, ...byReview(store, "long", 6) })), "owner_required", "long", 3);

  // Only the owner continues it, and the window opens on the line the series now stands on.
  const carried = deliveredOf(resumeSeries(store, { ...at(3), stop: 6, ...byOwner(store, "long", 6) }));
  assert.equal(carried.value.stop, null);
  assert.deepEqual(carried.value.continuations.map(item => item.after), [3, 6]);
  assert.deepEqual(carried.value.ladder.windows, [3, 6]);
  const seventh = cycle(store, "long", goal(), fruitless(), 3);
  assert.equal(seventh.value.withoutProgress, 1);
  assert.equal(seventh.value.stop, null);

  // A successor that dropped a continuation of its predecessor would raise a stop answered long ago: it is refused.
  forge(store, "long", value => ({ ...value, continuations: [value.continuations[1]!] }), 3);
  assert.equal(addressed(refusalOf(readSeries(store, at(3))), "series_invalid", "long", 3).at.field, "continuations");
});

test("the executor's own word that the approach has changed lifts no stop any more", t => {
  const { store } = fixture(t);
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  const before = held(store)!;
  assert.ok(!(CONTINUATION_GROUNDS as readonly string[]).includes("approach-changed"));

  // It is not a ground of the table any more, so it is a defect of the calling code, not a refusal of the series.
  for (const ground of ["approach-changed", "inputs-changed"]) {
    assert.throws(() => resumeSeries(store, { ...address(PROJECT), stop: 3, ground, text: "I will try something else" } as unknown as ResumeSeriesRequest),
      code("series_request_invalid"));
  }
  const after = held(store)!;
  assert.equal(after.revision, before.revision);
  assert.equal(after.value.stop!.attempt, 3);
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 4, goal: goal() })), "series_stopped");

  // And a series holding such a continuation is not a series this unit ever wrote.
  forge(store, PROJECT, value => ({ ...value, continuations: [{ ground: "approach-changed", text: "I tried something else", after: 3 }] }));
  assert.equal(addressed(refusalOf(readSeries(store, address(PROJECT))), "series_invalid").at.field, "continuations.0.ground");
});

test("a review is the review of THIS stop and THIS goal, it says a cause and a change, and it answers once (T5)", t => {
  const { store } = fixture(t);
  opened(store);
  cycle(store, PROJECT, goal(), fruitless());
  cycle(store, PROJECT, goal({ key: "gap:cart:tax" }), fruitless());
  cycle(store, PROJECT, goal(), fruitless());
  const stop = held(store)!.value.stop!;
  assert.deepEqual(stop.goals, ["gap:cart:price", "gap:cart:tax"]);
  const standing = () => held(store)!;
  const refuse = (review: unknown, expected: string): Refusal => addressed(refusalOf(resumeSeries(store, {
    ...address(PROJECT), stop: 3, ground: "review-record", text: "the reviewer looked at it", review: { ref: review as Ref },
  })), expected);

  // A review kept in another project's namespace, one whose content was rewritten under a reference to it, and a
  // record of another kind wearing the address of a review: none of them is read as a review of this stop.
  const genuine = reviewed(store, PROJECT, review(PROJECT, 3, stop.goals));
  assert.equal(refuse(reviewed(store, "elsewhere", review(PROJECT, 3, stop.goals)), "record_foreign").at.field, "id");
  assert.equal(refuse({ ...genuine, hash: hex("d") }, "record_forged").at.field, "hash");
  assert.equal(refuse(reviewed(store, PROJECT, review(PROJECT, 3, stop.goals), UNIT_REFUSAL_KIND), "record_foreign").at.field, "kind");
  assert.equal(refuse({ id: genuine.id, revision: 9, hash: genuine.hash }, "record_missing").at.ref!.revision, 9);

  // The stop and the goals are derived here from the attempts, so no field of the review decides what it belongs to.
  // The last of these declares itself accepted, independent and applicable to any stop; it is about another one.
  const unusable: [unknown, string][] = [
    [review(PROJECT, 9, stop.goals), "review.stop"],
    [review(PROJECT, 3, ["gap:cart:price"]), "review.goals"],
    [review(PROJECT, 3, [...stop.goals, "gap:cart:weight"]), "review.goals"],
    [review(PROJECT, 3, stop.goals, { goals: [] }), "review.goals"],
    [review(PROJECT, 3, stop.goals, { block: "block:checkout" }), "review.block"],
    [review(PROJECT, 3, stop.goals, { projectId: "beta" }), "review.block"],
    [review(PROJECT, 3, stop.goals, { cause: "" }), "review.cause"],
    [review(PROJECT, 3, stop.goals, { change: {} }), "review.change"],
    [without(review(PROJECT, 3, stop.goals), "change"), "review.change"],
    [review(PROJECT, 9, stop.goals, { lifts: "any stop", accepted: true, independent: true }), "review.stop"],
  ];
  for (const [value, field] of unusable) {
    assert.equal(refuse(reviewed(store, PROJECT, value as Record<string, unknown>), "review_unusable").at.field, field);
  }
  // Nothing of that moved anything: the stop stands where it stood and no window opened.
  assert.equal(standing().value.stop!.attempt, 3);
  assert.deepEqual(standing().value.continuations, []);

  // The review of this stop lifts it, once. The same one delivered again changes nothing, and when the next stop is
  // saved it is the ladder that answers first: this rung is spent.
  const ground = { ground: "review-record", text: "the reviewer looked at it", review: { ref: genuine } } as const;
  const resumed = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  const echo = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(echo.revision, resumed.revision);
  assert.deepEqual(echo.value, resumed.value);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  assert.equal(held(store)!.value.stop!.attempt, 6);
  const late = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(late.value.stop!.attempt, 6);
  assert.deepEqual(late.value.continuations.map(item => item.after), [3]);
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...ground })), "owner_required");
});

test("a fixed input names the refusal that stood, the input it stood on and the confirmation of the repeated check", t => {
  const { store } = fixture(t);
  const base = fixable(store, PROJECT);
  opened(store);
  circled(store, PROJECT, base.refusal);
  assert.equal(held(store)!.value.stop!.attempt, 3);
  const refuse = (ground: Record<string, unknown>, expected: string): Refusal => addressed(refusalOf(resumeSeries(store, {
    ...address(PROJECT), stop: 3, ground: "inputs-fixed", text: "the stage was corrected",
    refusal: base.refusal.row, input: base.input, ...ground,
  } as unknown as ResumeSeriesRequest)), expected);

  const elsewhere = fixable(store, "beta");
  const another = fixable(store, PROJECT, 1);
  const stranger = journalled(store, PROJECT, { code: "work_not_atomic", goal: "each work owns one artifact" });
  const fix = byFix(store, PROJECT, base);
  const fixedRef = (over: Record<string, unknown> = {}, drop?: string): Ref => {
    const value: Record<string, unknown> = {
      refusal: base.refusal.row, input: { id: base.input.id, revision: 2, hash: store.get(base.input.id, 2)!.hash }, ...over,
    };
    return confirmed(store, PROJECT, drop === undefined ? value : without(value, drop));
  };
  // Everything the refusals below stand on is in place; from here the series itself writes nothing (T8). The input
  // goes on being written by whoever fixes it — that is the point of the ground — so only what the series could
  // touch is watched: its own record and the journal it reads a refusal from.
  const untouched = [store.get(`om-refusal-journal:${PROJECT}`)!, held(store)!];

  // A row that stands nowhere, and a row of another project's journal: neither is a refusal of this project.
  assert.equal(refuse({ refusal: "om-refusal:invented", confirmation: fix.confirmation }, "refusal_unlinked").at.field, "refusal");
  assert.equal(refuse({ refusal: elsewhere.refusal.row, confirmation: fix.confirmation }, "refusal_unlinked").at.field, "refusal");
  // A refusal of this project that these attempts never ran into fixes nothing they were stopped for.
  assert.equal(refuse({ refusal: stranger.row, confirmation: fix.confirmation }, "input_unfixed").at.field, "refusal");
  // An input that refusal never stood on: its origin holds the records it was weighed against, and this is not one.
  assert.equal(refuse({ input: elsewhere.input, confirmation: fix.confirmation }, "input_unfixed").at.field, "input");
  assert.equal(refuse({ input: { ...base.input, revision: 9 }, confirmation: fix.confirmation }, "input_unfixed").at.field, "input");

  // The confirmation is read at its exact reference, inside this project's namespace, as a record of its own kind.
  assert.equal(refuse({ confirmation: { ref: confirmed(store, "beta", { refusal: base.refusal.row, input: base.input }) } }, "record_foreign").at.field, "id");
  assert.equal(refuse({ confirmation: { ref: { ...fix.confirmation.ref, hash: hex("d") } } }, "record_forged").at.field, "hash");
  assert.equal(refuse({ confirmation: { ref: confirmed(store, PROJECT, { refusal: base.refusal.row, input: base.input }, UNIT_REFUSAL_KIND) } }, "record_foreign").at.field, "kind");

  // And what it says is weighed against the refusal and the input the continuation names: another refusal, another
  // record, the very revision the attempts ran with, a revision that stands nowhere, and a revision that changed
  // nothing are none of them a fix. A new id is not one either — that is the rule in so many words.
  assert.equal(refuse({ confirmation: { ref: fixedRef({ refusal: stranger.row }) } }, "input_unfixed").at.field, "confirmation.refusal");
  assert.equal(refuse({ confirmation: { ref: fixedRef({}, "input") } }, "input_unfixed").at.field, "confirmation.input");
  assert.equal(refuse({ confirmation: { ref: fixedRef({ input: elsewhere.input }) } }, "input_unfixed").at.field, "confirmation.input");
  // Another record entirely, at a later revision and holding something else: a new id is no fix of this input.
  assert.equal(refuse({ confirmation: { ref: fixedRef({ input: another.input }) } }, "input_unfixed").at.field, "confirmation.input");
  assert.equal(refuse({ confirmation: { ref: fixedRef({ input: base.input }) } }, "input_unfixed").at.field, "confirmation.input");
  assert.equal(refuse({ confirmation: { ref: fixedRef({ input: { ...base.input, revision: 9 } }) } }, "input_unfixed").at.field, "confirmation.input");
  // A revision that holds again exactly what the refusal stood on is a new revision and no fix.
  const copied = store.write({ id: base.input.id, kind: "om-stage", expected: 2, value: store.get(base.input.id, 1)!.value });
  assert.equal(refuse({ confirmation: { ref: fixedRef({ input: reference(copied) }) } }, "input_unfixed").at.field, "confirmation.input");

  // Nothing of that was written anywhere: the stop stands, and the journal and the input are as they were (T8).
  assert.equal(held(store)!.value.stop!.attempt, 3);
  for (const record of untouched) {
    const now = store.get(record.id)!;
    assert.equal(now.revision, record.revision, record.id);
    assert.equal(now.hash, record.hash, record.id);
  }

  // The fix of the very input these attempts ran into continues the series, and opens a window like any ground.
  const resumed = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...fix }));
  assert.equal(resumed.value.stop, null);
  assert.equal(resumed.value.withoutProgress, 0);
  assert.deepEqual(resumed.value.continuations, [storedGround(fix, 3)]);
  assert.deepEqual(resumed.value.ladder, { rung: 2, goals: ["gap:cart:price"], windows: [3], grounds: ["owner-decision"] });
  // A confirmation of an EARLIER revision is no fix either, even when its content differs from the one the attempts
  // ran with: a fix comes after the refusal it answers, not before it.
  opened(store, "back");
  const older = fixable(store, "back", 1);
  assert.equal(older.input.revision, 2);
  circled(store, "back", older.refusal);
  addressed(refusalOf(resumeSeries(store, {
    ...address("back"), stop: 3, ground: "inputs-fixed", text: "a revision the attempts had left behind",
    refusal: older.refusal.row, input: older.input,
    confirmation: { ref: confirmed(store, "back", {
      refusal: older.refusal.row, input: { id: older.input.id, revision: 1, hash: store.get(older.input.id, 1)!.hash },
    }) },
  })), "input_unfixed", "back");

  // And at the second rung it is no ground at all, however well it is made: a fix of the input the NEW window ran
  // into does not stand in for the owner's decision.
  const second = fixable(store, PROJECT);
  circled(store, PROJECT, second.refusal);
  assert.equal(held(store)!.value.stop!.attempt, 6);
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byFix(store, PROJECT, second) })), "owner_required");
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byOwner(store, PROJECT, 6) }));
});

test("the ladder is derived from the history at every reading, and a stored one that does not follow is refused (T3)", t => {
  const { store } = fixture(t);
  const build = (project: string): RepairSeries => {
    opened(store, project);
    for (let round = 0; round < 3; round += 1) cycle(store, project, goal(), fruitless());
    deliveredOf(resumeSeries(store, { ...address(project), stop: 3, ...byReview(store, project, 3) }));
    for (let round = 0; round < 3; round += 1) cycle(store, project, goal(), fruitless());
    return held(store, project)!.value;
  };
  const genuine = build("ladder");
  assert.deepEqual(genuine.ladder, { rung: 2, goals: ["gap:cart:price"], windows: [3], grounds: ["owner-decision"] });
  assert.equal(genuine.stop!.attempt, 6);

  const forgeries: [string, (value: RepairSeries) => Record<string, unknown>][] = [
    ["a rung climbed back down to the reviewer",
      value => ({ ...value, ladder: { ...value.ladder, rung: 1, grounds: [...CONTINUATION_GROUNDS] } })],
    ["a ladder that forgot the goal it stands for", value => ({ ...value, ladder: { ...value.ladder, goals: [] } })],
    ["a ladder that forgot the window it opened", value => ({ ...value, ladder: { ...value.ladder, windows: [] } })],
    ["grounds that do not follow from the rung",
      value => ({ ...value, ladder: { ...value.ladder, grounds: [...CONTINUATION_GROUNDS] } })],
    ["a ladder wearing a field of its own", value => ({ ...value, ladder: { ...value.ladder, lifted: true } })],
  ];
  forgeries.forEach(([name, forgery], index) => {
    const project = `rung${index}`;
    build(project);
    forge(store, project, forgery);
    const refusal = addressed(refusalOf(readSeries(store, address(project))), "series_invalid", project);
    assert.equal(refusal.at.field, "ladder", name);
    // A series whose ladder cannot be read cannot be continued on any ground either.
    addressed(refusalOf(resumeSeries(store, { ...address(project), stop: 6, ...byOwner(store, project, 6) })), "series_invalid", project);
  });

  // A continuation standing on a ground the rung it answers does not admit is not read either, however the count,
  // the stop and the ladder around it were written to agree with it.
  forge(store, "ladder", value => ({
    ...value, stop: null, withoutProgress: 0,
    continuations: [...value.continuations, { ground: "review-record", text: "a second look", review: byReview(store, "ladder", 6).review.ref, after: 6 }],
  }));
  const refusal = addressed(refusalOf(readSeries(store, address("ladder"))), "series_invalid", "ladder");
  assert.equal(refusal.at.field, "continuations");
  assert.ok(refusal.message.includes("rung 2"));

  // The module has not been released, so no store holds a series of the former shape: one is refused, not migrated.
  forge(store, "ladder", value => ({
    ...without({ ...value }, "ladder"),
    continuations: [{ ground: "approach-changed", text: "I tried something else", after: 3 }],
  }));
  assert.equal(addressed(refusalOf(readSeries(store, address("ladder"))), "series_invalid", "ladder").at.field, "value");
});

test("a decision of the owner is a record too: about THIS stop and THIS goal, and never a sentence alone (T1, T5)", t => {
  const { store } = fixture(t);
  opened(store);
  cycle(store, PROJECT, goal(), fruitless());
  cycle(store, PROJECT, goal({ key: "gap:cart:tax" }), fruitless());
  cycle(store, PROJECT, goal(), fruitless());
  const stop = held(store)!.value.stop!;
  assert.deepEqual(stop.goals, ["gap:cart:price", "gap:cart:tax"]);
  const refuse = (decision: unknown, expected: string): Refusal => addressed(refusalOf(resumeSeries(store, {
    ...address(PROJECT), stop: 3, ground: "owner-decision", text: "the owner decided", decision: { ref: decision as Ref },
  })), expected);

  // Read like the other two grounds: this project's namespace, this kind, this exact content.
  const genuine = decided(store, PROJECT, decision(PROJECT, 3, stop.goals));
  assert.equal(refuse(decided(store, "elsewhere", decision(PROJECT, 3, stop.goals)), "record_foreign").at.field, "id");
  assert.equal(refuse({ ...genuine, hash: hex("d") }, "record_forged").at.field, "hash");
  assert.equal(refuse(decided(store, PROJECT, decision(PROJECT, 3, stop.goals), STOP_REVIEW_KIND), "record_foreign").at.field, "kind");
  assert.equal(refuse({ id: genuine.id, revision: 9, hash: genuine.hash }, "record_missing").at.ref!.revision, 9);

  // The stop and the goals are derived here from the attempts, so nothing the record says of itself decides what it
  // belongs to. The last of these declares itself taken by the owner, approved and good for any stop; it is about
  // another one, and that is the end of it.
  const unusable: [unknown, string][] = [
    [decision(PROJECT, 9, stop.goals), "decision.stop"],
    [decision(PROJECT, 3, ["gap:cart:price"]), "decision.goals"],
    [decision(PROJECT, 3, [...stop.goals, "gap:cart:weight"]), "decision.goals"],
    [decision(PROJECT, 3, stop.goals, { goals: [] }), "decision.goals"],
    [decision(PROJECT, 3, stop.goals, { block: "block:checkout" }), "decision.block"],
    [decision(PROJECT, 3, stop.goals, { projectId: "beta" }), "decision.block"],
    [decision(PROJECT, 3, stop.goals, { decided: "" }), "decision.decided"],
    [decision(PROJECT, 3, stop.goals, { decided: { approved: true } }), "decision.decided"],
    [without(decision(PROJECT, 3, stop.goals), "decided"), "decision.decided"],
    [decision(PROJECT, 9, stop.goals, { lifts: "any stop", approved: true, by: "the owner" }), "decision.stop"],
  ];
  for (const [value, field] of unusable) {
    const refusal = refuse(decided(store, PROJECT, value as Record<string, unknown>), "decision_unusable");
    assert.equal(refusal.at.field, field);
    assert.equal(refusal.route, "owner");
  }
  // A record that is no record of a stop at all is refused with the ground it was given for, not read around.
  assert.equal(refuse(reference(store.write({
    id: `${ownerDecisionNamespace(PROJECT)}plain`, kind: OWNER_DECISION_KIND, expected: 0, value: "the owner said yes",
  })), "decision_unusable").at.field, "decision");
  // Nothing of that moved anything: the stop stands where it stood and no window opened.
  assert.equal(held(store)!.value.stop!.attempt, 3);
  assert.deepEqual(held(store)!.value.continuations, []);

  // The decision taken about THIS stop lifts it, once, and opens a window like any ground.
  const ground = { ground: "owner-decision", text: "the owner decided", decision: { ref: genuine } } as const;
  const resumed = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(resumed.value.stop, null);
  assert.equal(resumed.value.withoutProgress, 0);
  assert.deepEqual(resumed.value.continuations, [storedGround(ground, 3)]);
  const echo = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(echo.revision, resumed.revision);
  assert.deepEqual(echo.value, resumed.value);
  // Another decision for a stop already continued does not replace the one it was continued on.
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...byOwner(store, PROJECT, 3, stop.goals) })), "continuation_conflict");

  // And when the next stop is saved, the decision that answered the earlier one does not answer this one: the
  // continuation names the stop it belongs to, so a repeat delivered late is a repeat and lifts nothing.
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  assert.equal(held(store)!.value.stop!.attempt, 6);
  const late = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground }));
  assert.equal(late.value.stop!.attempt, 6);
  assert.deepEqual(late.value.continuations.map(item => item.after), [3]);
  // At the second rung the decision is the only ground there is, and it is read exactly as before.
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byReview(store, PROJECT, 6) })), "owner_required");
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byOwner(store, PROJECT, 9) })), "decision_unusable");
  const second = deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...byOwner(store, PROJECT, 6) }));
  assert.equal(second.value.stop, null);
  assert.deepEqual(second.value.ladder.windows, [3, 6]);

  // A stored ground of the owner without the record it stands on is not a ground this unit ever wrote.
  forge(store, PROJECT, value => ({
    ...value, continuations: [without({ ...value.continuations[0]! }, "decision"), value.continuations[1]!],
  }));
  assert.equal(addressed(refusalOf(readSeries(store, address(PROJECT))), "series_invalid").at.field, "continuations.0.decision");
});

test("a successor derives an inherited decision from its predecessor, and a race for one leaves nothing half-open (T3, T7)", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-series-owner-"));
  const path = join(root, "live.sqlite");
  const store = new RacingStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.target = seriesId(PROJECT, BLOCK, 1);
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());

  // Two decisions about the same stop, both good. The competitor's lands; ours finds the head it read gone, and the
  // window it would have opened is lost with the transaction rather than opened half-way.
  const rival = byOwner(store, PROJECT, 3);
  const ours = byOwner(store, PROJECT, 3);
  store.armed = true;
  store.run = other => { deliveredOf(resumeSeries(other, { ...address(PROJECT), stop: 3, ...rival })); };
  addressed(refusalOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ours })), "input_stale");
  const landed = deliveredOf(readSeries(store, address(PROJECT)));
  assert.deepEqual(landed.value.continuations, [storedGround(rival, 3)]);
  assert.equal(landed.value.ladder.rung, 2);

  // The slice moves. The successor carries that continuation, and it is derived again from the predecessor at the
  // exact reference it names: a decision swapped for another good one in the successor is not the one handed down.
  store.armed = false;
  const successor = deliveredOf(openSeries(store, {
    ...address(PROJECT, 2), slice: "slice:cart@2", predecessor: reference(landed),
    basis: { ground: "inputs-changed", text: "the closure of the block moved" },
  }));
  assert.deepEqual(successor.value.continuations, landed.value.continuations);
  assert.equal(successor.value.ladder.rung, 2);
  forge(store, PROJECT, value => ({ ...value, continuations: [{ ...value.continuations[0]!, decision: ours.decision.ref }] }), 2);
  assert.equal(addressed(refusalOf(readSeries(store, address(PROJECT, 2))), "series_invalid", PROJECT, 2).at.field, "continuations");
});

// ---------------------------------------------------------------------------
// A review that ended without a decision (review returned, journal entry 172): the stop goes to the owner.

test("a review that ended without a decision sends the stop to the owner, and a second review no longer lifts it", t => {
  const { path, store } = fixture(t);
  const base = fixable(store, PROJECT);
  opened(store);
  circled(store, PROJECT, base.refusal);
  const standing = held(store)!;
  assert.equal(standing.value.stop!.attempt, 3);
  assert.equal(standing.value.ladder.rung, 1);

  // The reviewer's scenario, step 2: a review of this stop that names a cause and, explicitly, no usable change.
  // It continues nothing, and says which transition such a review is for.
  const nothing = undecided(store, PROJECT, 3);
  const refusal = addressed(refusalOf(resumeSeries(store, {
    ...address(PROJECT), stop: 3, ground: "review-record", text: "the reviewer looked at it", review: { ref: nothing },
  })), "review_unusable");
  assert.equal(refusal.at.field, "review.change");
  assert.ok(refusal.message.includes("escalateSeries"));
  assert.equal(held(store)!.revision, standing.revision);

  // The transition keeps that outcome in the series: the rung is spent, the stop STAYS, and no window opens.
  const sent = deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: nothing } }));
  assert.deepEqual(sent.value.escalations, [{ after: 3, review: nothing }]);
  assert.deepEqual(sent.value.ladder, { rung: 2, goals: ["gap:cart:price"], windows: [], grounds: ["owner-decision"] });
  assert.equal(sent.value.stop!.attempt, 3);
  assert.deepEqual(sent.value.stop!.attempts, standing.value.stop!.attempts);
  assert.equal(sent.value.stop!.reason, standing.value.stop!.reason);
  assert.ok(sent.value.stop!.resume.includes("owner's decision"));
  assert.equal(sent.value.withoutProgress, standing.value.withoutProgress);
  assert.deepEqual(sent.value.continuations, []);
  addressed(refusalOf(beginAttempt(store, { ...address(PROJECT), attempt: 4, goal: goal() })), "series_stopped");

  // Step 3: another review of the same stop, with a cause AND a change, is refused towards the owner; so is a fix of
  // the very input these attempts ran into.
  const stillOwners = (at: Store): void => {
    for (const ground of [byReview(at, PROJECT, 3), byFix(at, PROJECT, base)]) {
      const owed = addressed(refusalOf(resumeSeries(at, { ...address(PROJECT), stop: 3, ...ground })), "owner_required");
      assert.equal(owed.route, "owner");
    }
    assert.equal(at.get<RepairSeries>(seriesId(PROJECT, BLOCK, 1))!.value.stop!.attempt, 3);
  };
  stillOwners(store);

  // The same after a restart: the escalation is in the record, and the rung is derived from it again.
  store.close();
  const back = new Store(path);
  t.after(() => back.close());
  const cold = deliveredOf(readSeries(back, address(PROJECT)));
  assert.deepEqual(cold.value, sent.value);
  stillOwners(back);
  // And the same escalation delivered again is a repeat: no revision.
  const echo = deliveredOf(escalateSeries(back, { ...address(PROJECT), stop: 3, review: { ref: nothing } }));
  assert.equal(echo.revision, sent.revision);

  // The owner's decision opens a window of up to three attempts, and the next stop is the owner's again.
  const owned = deliveredOf(resumeSeries(back, { ...address(PROJECT), stop: 3, ...byOwner(back, PROJECT, 3) }));
  assert.equal(owned.value.stop, null);
  assert.equal(owned.value.withoutProgress, 0);
  assert.deepEqual(owned.value.ladder.windows, [3]);
  for (let round = 0; round < 2; round += 1) assert.equal(cycle(back, PROJECT, goal(), fruitless()).value.stop, null);
  const sixth = cycle(back, PROJECT, goal(), fruitless());
  assert.equal(sixth.value.stop!.attempt, 6);
  assert.equal(sixth.value.ladder.rung, 2);
  addressed(refusalOf(resumeSeries(back, { ...address(PROJECT), stop: 6, ...byReview(back, PROJECT, 6) })), "owner_required");
  // An escalation delivered late for the stop the owner has since answered changes nothing and lifts nothing.
  const late = deliveredOf(escalateSeries(back, { ...address(PROJECT), stop: 3, review: { ref: nothing } }));
  assert.equal(late.revision, sixth.revision);
  assert.equal(late.value.stop!.attempt, 6);
});

test("an escalation stands on the exact record of a review that ended without a decision, of its own stop, once (T5)", t => {
  const { store } = fixture(t);
  opened(store);
  cycle(store, PROJECT, goal(), fruitless());
  cycle(store, PROJECT, goal({ key: "gap:cart:tax" }), fruitless());
  cycle(store, PROJECT, goal(), fruitless());
  const stop = held(store)!.value.stop!;
  const before = held(store)!;
  const refuse = (review: unknown, expected: string): Refusal =>
    addressed(refusalOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: review as Ref } })), expected);

  // Read like every record of a ground: this project's namespace, this kind, this exact content.
  const genuine = undecided(store, PROJECT, 3, stop.goals);
  assert.equal(refuse(reviewed(store, "elsewhere", review(PROJECT, 3, stop.goals, { change: null })), "record_foreign").at.field, "id");
  assert.equal(refuse({ ...genuine, hash: hex("d") }, "record_forged").at.field, "hash");
  assert.equal(refuse(reviewed(store, PROJECT, review(PROJECT, 3, stop.goals, { change: null }), OWNER_DECISION_KIND), "record_foreign").at.field, "kind");
  assert.equal(refuse({ id: genuine.id, revision: 9, hash: genuine.hash }, "record_missing").at.ref!.revision, 9);

  // A review of another stop, goal or block is not the review of this stop, however it ended.
  const unusable: [Record<string, unknown>, string][] = [
    [review(PROJECT, 9, stop.goals, { change: null }), "review.stop"],
    [review(PROJECT, 3, ["gap:cart:price"], { change: null }), "review.goals"],
    [review(PROJECT, 3, stop.goals, { change: null, block: "block:checkout" }), "review.block"],
    [review(PROJECT, 3, stop.goals, { change: null, projectId: "beta" }), "review.block"],
    // A broken record is no outcome: a part left out, left empty or left as an empty structure moves nothing.
    [without(review(PROJECT, 3, stop.goals), "change"), "review.change"],
    [review(PROJECT, 3, stop.goals, { change: {} }), "review.change"],
    [review(PROJECT, 3, stop.goals, { change: [] }), "review.change"],
    [review(PROJECT, 3, stop.goals, { change: "" }), "review.change"],
    [without(review(PROJECT, 3, stop.goals, { change: null }), "cause"), "review.cause"],
    [review(PROJECT, 3, stop.goals, { change: null, cause: "" }), "review.cause"],
    [review(PROJECT, 3, stop.goals, { change: null, cause: 7 }), "review.cause"],
    // And a review that DID decide escalates nothing: it is a ground to continue, through the other transition.
    [review(PROJECT, 3, stop.goals), "review.change"],
    // A status beside the content decides nothing either: this one declares "no decision" and says a change.
    [review(PROJECT, 3, stop.goals, { outcome: "no-decision", decided: false }), "review.change"],
  ];
  for (const [value, field] of unusable) assert.equal(refuse(reviewed(store, PROJECT, value), "review_unusable").at.field, field);
  const decided = refuse(reviewed(store, PROJECT, review(PROJECT, 3, stop.goals)), "review_unusable");
  assert.ok(decided.message.includes("resumeSeries"));
  // Nothing of that moved anything.
  assert.equal(held(store)!.revision, before.revision);
  assert.deepEqual(held(store)!.value.escalations, []);

  // Applied once: the same request again is a repeat without a revision; another review for the escalated stop is a
  // conflict, not a second application.
  const sent = deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: genuine } }));
  const echo = deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: genuine } }));
  assert.equal(echo.revision, sent.revision);
  assert.deepEqual(echo.value, sent.value);
  assert.equal(addressed(refusalOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: undecided(store, PROJECT, 3, stop.goals) } })), "escalation_conflict").at.field, "review");
  assert.equal(held(store)!.revision, sent.revision);

  // A reviewer who could not name a cause at all ended without a decision too, whatever change is written beside it.
  opened(store, "blind");
  for (let round = 0; round < 3; round += 1) cycle(store, "blind", goal(), fruitless());
  const blind = deliveredOf(escalateSeries(store, { ...address("blind"), stop: 3, review: { ref: reviewed(store, "blind", review("blind", 3, undefined, { cause: null })) } }));
  assert.equal(blind.value.ladder.rung, 2);

  // A stop that no longer stands cannot be escalated: continued on a review that decided, it is gone.
  opened(store, "gone");
  for (let round = 0; round < 3; round += 1) cycle(store, "gone", goal(), fruitless());
  deliveredOf(resumeSeries(store, { ...address("gone"), stop: 3, ...byReview(store, "gone", 3) }));
  addressed(refusalOf(escalateSeries(store, { ...address("gone"), stop: 3, review: { ref: undecided(store, "gone", 3) } })), "stop_absent", "gone");
  // And a stop at the owner's rung has nothing left to escalate.
  for (let round = 0; round < 3; round += 1) cycle(store, "gone", goal(), fruitless());
  const owners = addressed(refusalOf(escalateSeries(store, { ...address("gone"), stop: 6, review: { ref: undecided(store, "gone", 6) } })), "owner_required", "gone");
  assert.equal(owners.route, "owner");
  assert.deepEqual(held(store, "gone")!.value.escalations, []);
});

test("an escalation outlives a successor and a change of slice, and a successor derives it again from its predecessor", t => {
  const { store } = fixture(t);
  const base = fixable(store, "long");
  const at = (line: number): SeriesRequest => address("long", line);
  const moved = (line: number, slice: string, from: Revision<RepairSeries>) => deliveredOf(openSeries(store, {
    ...at(line), slice, predecessor: reference(from), basis: { ground: "inputs-changed", text: "the closure of the block moved" },
  }));
  opened(store, "long");
  circled(store, "long", base.refusal);
  const first = deliveredOf(escalateSeries(store, { ...at(1), stop: 3, review: { ref: undecided(store, "long", 3) } }));

  // The slice moves, then comes back to the subject it started on. Each line carries the stop, the escalation and the
  // rung — one change of horizon does not hand the stop back to the reviewer.
  const second = moved(2, "slice:cart@2", first);
  const third = moved(3, SLICE, second);
  for (const [line, series] of [[2, second], [3, third]] as const) {
    assert.deepEqual(series.value.escalations, first.value.escalations);
    assert.deepEqual(series.value.stop, first.value.stop);
    assert.deepEqual(series.value.ladder, first.value.ladder);
    for (const ground of [byReview(store, "long", 3), byFix(store, "long", base)]) {
      addressed(refusalOf(resumeSeries(store, { ...at(line), stop: 3, ...ground })), "owner_required", "long", line);
    }
    // The escalation it inherited is its own: the same request again is a repeat, another review a conflict.
    assert.equal(deliveredOf(escalateSeries(store, { ...at(line), stop: 3, review: { ref: first.value.escalations[0]!.review } })).revision, series.revision);
    addressed(refusalOf(escalateSeries(store, { ...at(line), stop: 3, review: { ref: undecided(store, "long", 3) } })), "escalation_conflict", "long", line);
  }

  // Only the owner continues it, on the line the series now stands on.
  const owned = deliveredOf(resumeSeries(store, { ...at(3), stop: 3, ...byOwner(store, "long", 3) }));
  assert.equal(owned.value.stop, null);
  assert.deepEqual(owned.value.ladder.windows, [3]);

  // A successor that dropped the escalation, or swapped it for another good one, is not the one handed down (T3).
  const dropped = held(store, "long", 2)!;
  forge(store, "long", value => ({ ...value, escalations: [] }), 2);
  assert.equal(addressed(refusalOf(readSeries(store, at(2))), "series_invalid", "long", 2).at.field, "escalations");
  store.write({ id: dropped.id, kind: REPAIR_SERIES_KIND, expected: dropped.revision + 1, value: dropped.value as unknown as Json });
  forge(store, "long", value => ({ ...value, escalations: [{ after: 3, review: undecided(store, "long", 3) }] }), 2);
  assert.equal(addressed(refusalOf(readSeries(store, at(2))), "series_invalid", "long", 2).at.field, "escalations");
});

test("an escalation stored where no stop of the first rung stood, or held out of shape, is refused (T3, T4)", t => {
  const { store } = fixture(t);
  const build = (project: string): RepairSeries => {
    opened(store, project);
    for (let round = 0; round < 3; round += 1) cycle(store, project, goal(), fruitless());
    return deliveredOf(escalateSeries(store, { ...address(project), stop: 3, review: { ref: undecided(store, project, 3) } })).value;
  };
  const genuine = build("esc");
  const review_ = genuine.escalations[0]!.review;
  const forgeries: [string, (value: RepairSeries) => Record<string, unknown>, string][] = [
    ["a series with no set of escalations at all", value => without({ ...value }, "escalations"), "value"],
    ["an absent set is not an empty one", value => ({ ...value, escalations: null }), "escalations"],
    ["an escalation without its review", value => ({ ...value, escalations: [{ after: 3 }] }), "escalations.0"],
    ["an escalation wearing a field of its own", value => ({ ...value, escalations: [{ after: 3, review: review_, lifts: true }] }), "escalations.0"],
    ["an escalation of an attempt the series does not hold", value => ({ ...value, escalations: [{ after: 9, review: review_ }] }), "escalations.0.after"],
    ["one stop escalated twice", value => ({ ...value, escalations: [{ after: 3, review: review_ }, { after: 3, review: review_ }] }), "escalations.1.after"],
    ["an escalation where no stop was saved", value => ({ ...value, escalations: [{ after: 2, review: review_ }] }), "escalations"],
    ["an escalation wished away, the rung it gave kept", value => ({ ...value, escalations: [] }), "ladder"],
    ["an escalation kept, the rung it gave taken back",
      value => ({ ...value, ladder: { rung: 1, goals: [], windows: [], grounds: [...CONTINUATION_GROUNDS] } }), "ladder"],
    ["an escalation that lifted its stop", value => ({ ...value, stop: null }), "stop"],
  ];
  forgeries.forEach(([name, forgery, field], index) => {
    const project = `esc${index}`;
    build(project);
    forge(store, project, forgery);
    assert.equal(addressed(refusalOf(readSeries(store, address(project))), "series_invalid", project).at.field, field, name);
  });
  // An escalation standing at a stop of the owner's rung is no escalation either.
  opened(store, "late");
  for (let round = 0; round < 3; round += 1) cycle(store, "late", goal(), fruitless());
  deliveredOf(resumeSeries(store, { ...address("late"), stop: 3, ...byReview(store, "late", 3) }));
  for (let round = 0; round < 3; round += 1) cycle(store, "late", goal(), fruitless());
  forge(store, "late", value => ({ ...value, escalations: [{ after: 6, review: review_ }] }));
  const refusal = addressed(refusalOf(readSeries(store, address("late"))), "series_invalid", "late");
  assert.equal(refusal.at.field, "escalations");
  assert.ok(refusal.message.includes("first rung"));
});

test("an escalation racing another change is refused rather than written over it (T7)", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-series-escalate-"));
  const path = join(root, "live.sqlite");
  const store = new RacingStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.target = seriesId(PROJECT, BLOCK, 1);
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());

  // Two reviews of the same stop, both ended without a decision. The competitor's lands between our read and our write.
  const theirs = undecided(store, PROJECT, 3);
  const ours = undecided(store, PROJECT, 3);
  store.armed = true;
  store.run = other => { deliveredOf(escalateSeries(other, { ...address(PROJECT), stop: 3, review: { ref: theirs } })); };
  addressed(refusalOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: ours } })), "input_stale");
  assert.deepEqual(held(store)!.value.escalations, [{ after: 3, review: theirs }]);
  // Read again, ours is what it is: another review for a stop already escalated.
  addressed(refusalOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: { ref: ours } })), "escalation_conflict");

  // The owner answers the stop between our read and our escalation of it on yet another review: nothing is escalated
  // over a stop that no longer stands, and read again it is simply gone.
  opened(store, "other");
  store.target = seriesId("other", BLOCK, 1);
  for (let round = 0; round < 3; round += 1) cycle(store, "other", goal(), fruitless());
  const owner = byOwner(store, "other", 3);
  const late = undecided(store, "other", 3);
  store.armed = true;
  store.run = other => { deliveredOf(resumeSeries(other, { ...address("other"), stop: 3, ...owner })); };
  addressed(refusalOf(escalateSeries(store, { ...address("other"), stop: 3, review: { ref: late } })), "input_stale", "other");
  assert.deepEqual(held(store, "other")!.value.escalations, []);
  addressed(refusalOf(escalateSeries(store, { ...address("other"), stop: 3, review: { ref: late } })), "stop_absent", "other");
});

test("escalations of several series are prepared without writing and applied by one transaction, or by none", t => {
  const { store } = fixture(t);
  const blocks = ["block:cart", "block:checkout", "block:invoice"] as const;
  const at = (block: string): SeriesRequest => ({ project: PROJECT, block, line: 1 });
  const stopped = (block: string): void => {
    deliveredOf(openSeries(store, { ...at(block), slice: SLICE, predecessor: null, basis: null }));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      deliveredOf(beginAttempt(store, { ...at(block), attempt, goal: goal() }));
      deliveredOf(completeAttempt(store, { ...at(block), attempt, outcome: fruitless() }));
    }
  };
  for (const block of blocks) stopped(block);
  const prepare = (block: string) => deliveredOf(prepareEscalateSeries(store, {
    ...at(block), stop: 3, review: { ref: undecided(store, PROJECT, 3, undefined, { block }) },
  }));
  const heads = () => blocks.map(block => store.get(seriesId(PROJECT, block, 1))!.revision);
  const apply = (parts: readonly SeriesTransition[]) => writeGuarded(store, {
    unit: "b3", target: "om-escalations:alpha", writes: parts.flatMap(part => [...part.writes]), guards: parts.flatMap(part => [...part.guards]),
  });

  // A prepared escalation is a write and its guard, and nothing has been written yet.
  const before = heads();
  const cart = prepare("block:cart");
  const checkout = prepare("block:checkout");
  assert.equal(cart.writes.length, 1);
  assert.equal(cart.writes[0]!.kind, REPAIR_SERIES_KIND);
  assert.equal(cart.writes[0]!.expected, before[0]);
  assert.deepEqual(cart.guards, [reference(store.get(seriesId(PROJECT, "block:cart", 1))!)]);
  assert.equal(cart.value.ladder.rung, 2);
  assert.deepEqual(heads(), before);

  // One participant moves before the write — the owner answers the checkout stop — and the transaction commits
  // nothing: the cart is not left escalated on its own.
  deliveredOf(resumeSeries(store, { ...at("block:checkout"), stop: 3, ...byOwner(store, PROJECT, 3, undefined, { block: "block:checkout" }) }));
  assert.equal(refusalOf(apply([cart, checkout])).code, "input_stale");
  assert.deepEqual(deliveredOf(readSeries(store, at("block:cart"))).value.escalations, []);
  assert.equal(deliveredOf(readSeries(store, at("block:cart"))).value.ladder.rung, 1);
  assert.deepEqual(deliveredOf(readSeries(store, at("block:checkout"))).value.escalations, []);
  // What cannot be escalated any more is refused at preparation, before anything is written.
  assert.equal(refusalOf(prepareEscalateSeries(store, {
    ...at("block:checkout"), stop: 3, review: { ref: undecided(store, PROJECT, 3, undefined, { block: "block:checkout" }) },
  })).code, "stop_absent");

  // Nothing prevented: both escalations are written by one transaction, and read back as this unit's own.
  const done = deliveredOf(apply([prepare("block:cart"), prepare("block:invoice")]));
  assert.equal(done.length, 2);
  for (const block of ["block:cart", "block:invoice"]) {
    const series = deliveredOf(readSeries(store, at(block)));
    assert.equal(series.value.escalations.length, 1);
    assert.equal(series.value.ladder.rung, 2);
    assert.equal(series.value.stop!.attempt, 3);
  }
  // A prepared escalation that is a repeat carries no write, so a caller adds nothing to its transaction.
  const cartReview = deliveredOf(readSeries(store, at("block:cart"))).value.escalations[0]!.review;
  const repeat = deliveredOf(prepareEscalateSeries(store, { ...at("block:cart"), stop: 3, review: { ref: cartReview } }));
  assert.deepEqual(repeat.writes, []);
  assert.deepEqual(repeat.guards, []);
});

// ---------------------------------------------------------------------------
// A ground written in the same transaction as the change it grounds (review returned, journal entry 174).

test("a review written WITH the escalation: nothing of it stands before, both stand after, and a moved guard leaves neither", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-om-series-pending-"));
  const path = join(root, "live.sqlite");
  const store = new RacingStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.target = seriesId(PROJECT, BLOCK, 1);
  opened(store);
  for (let round = 0; round < 3; round += 1) cycle(store, PROJECT, goal(), fruitless());
  const stopped = held(store)!;

  // Two writers, each with a review of this stop that has just come back and is not in the store at all. The
  // competitor's transaction lands between our read and our write.
  const theirs = unwritten(PROJECT, STOP_REVIEW_KIND);
  const ours = unwritten(PROJECT, STOP_REVIEW_KIND);
  const value = review(PROJECT, 3, undefined, { change: null });
  assert.equal(store.get(theirs), null);
  assert.equal(store.get(ours), null);
  store.armed = true;
  store.run = other => {
    deliveredOf(escalateSeries(other, { ...address(PROJECT), stop: 3, review: onItsWay(theirs, STOP_REVIEW_KIND, value) }));
  };
  addressed(refusalOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: onItsWay(ours, STOP_REVIEW_KIND, value) })), "input_stale");
  // Neither of OUR two records was written: not the review, not the second rung.
  assert.equal(store.get(ours), null);
  const landed = deliveredOf(readSeries(store, address(PROJECT)));
  assert.equal(landed.value.escalations.length, 1);
  assert.equal(landed.value.escalations[0]!.review.id, theirs);
  // The competitor's review was written by the same transaction as its escalation, at its first revision.
  const written = store.get(theirs)!;
  assert.equal(written.revision, 1);
  assert.equal(written.kind, STOP_REVIEW_KIND);
  assert.equal(written.hash, hashJson(value));
  assert.deepEqual(landed.value.escalations[0]!.review, reference(written));
  assert.equal(store.history(seriesId(PROJECT, BLOCK, 1)).length, stopped.revision + 1);
  assert.equal(landed.value.ladder.rung, 2);
  assert.equal(landed.value.stop!.attempt, 3);

  // T5 for a record on its way: the same request again finds its own record standing and is a repeat — no second
  // revision of either. Другое содержимое под тем же id is a revision conflict, and nothing is overwritten.
  store.armed = false;
  const repeat = deliveredOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: onItsWay(theirs, STOP_REVIEW_KIND, value) }));
  assert.equal(repeat.revision, landed.revision);
  assert.equal(store.history(theirs).length, 1);
  assert.deepEqual(deliveredOf(prepareEscalateSeries(store, { ...address(PROJECT), stop: 3, review: onItsWay(theirs, STOP_REVIEW_KIND, value) })).writes, []);
  const clash = addressed(refusalOf(escalateSeries(store, {
    ...address(PROJECT), stop: 3, review: onItsWay(theirs, STOP_REVIEW_KIND, review(PROJECT, 3, undefined, { change: null, cause: "another cause" })),
  })), "revision_conflict");
  assert.equal(clash.at.field, "review.pending.id");
  assert.equal(store.history(theirs).length, 1);
  assert.equal(store.get(theirs)!.hash, written.hash);

  // And the same window on the id of the record itself: it is free when the preparation looks, and taken by someone
  // else before the write. The transaction commits nothing, so the series is not escalated on a record it never wrote.
  opened(store, "taken");
  for (let round = 0; round < 3; round += 1) cycle(store, "taken", goal(), fruitless());
  const contested = unwritten("taken", STOP_REVIEW_KIND);
  const mine = review("taken", 3, undefined, { change: null });
  store.target = contested;
  store.armed = true;
  store.run = other => { other.write({ id: contested, kind: STOP_REVIEW_KIND, expected: 0, value: review("taken", 3, undefined, { change: null, cause: "theirs" }) as unknown as Json }); };
  const lost = refusalOf(escalateSeries(store, { ...address("taken"), stop: 3, review: onItsWay(contested, STOP_REVIEW_KIND, mine) }));
  assert.equal(lost.code, "revision_conflict");
  // The refusal names the id that was taken, which is the record that could not be written.
  assert.equal(lost.at.target, contested);
  assert.equal(lost.at.unit, UNIT);
  assert.equal(store.history(contested).length, 1);
  assert.notEqual(store.get(contested)!.hash, hashJson(mine));
  assert.deepEqual(held(store, "taken")!.value.escalations, []);
  assert.equal(held(store, "taken")!.value.ladder.rung, 1);
});

test("a review, a confirmation of a fix and a decision of the owner, each written with the continuation it grounds", t => {
  const { store } = fixture(t);
  const window = (project: string): { readonly base: { input: Ref; refusal: ClaimedRefusal } } => {
    const base = fixable(store, project);
    opened(store, project);
    circled(store, project, base.refusal);
    return { base };
  };

  // A review that decided, written with the continuation it grounds.
  window("rev");
  const reviewId = unwritten("rev", STOP_REVIEW_KIND);
  assert.equal(store.get(reviewId), null);
  const resumed = deliveredOf(resumeSeries(store, {
    ...address("rev"), stop: 3, ground: "review-record", text: "the reviewer answered",
    review: onItsWay(reviewId, STOP_REVIEW_KIND, review("rev", 3)),
  }));
  assert.equal(store.get(reviewId)!.revision, 1);
  assert.deepEqual(resumed.value.continuations[0]!, {
    ground: "review-record", text: "the reviewer answered", review: reference(store.get(reviewId)!), after: 3,
  });
  assert.equal(resumed.value.stop, null);
  assert.equal(resumed.value.ladder.rung, 2);

  // A confirmation of a fixed input, written with the continuation. The input it confirms is a revision that STANDS:
  // a re-check is run on a record, not on one that is still to be written.
  const fixWindow = window("fix");
  const better = store.write({
    id: fixWindow.base.input.id, kind: "om-stage", expected: fixWindow.base.input.revision,
    value: { rows: ["the price is produced by the pricing operation"] },
  });
  const fixId = unwritten("fix", INPUT_FIX_KIND);
  const fixed = deliveredOf(resumeSeries(store, {
    ...address("fix"), stop: 3, ground: "inputs-fixed", text: "the stage was corrected and re-checked",
    refusal: fixWindow.base.refusal.row, input: fixWindow.base.input,
    confirmation: onItsWay(fixId, INPUT_FIX_KIND, { refusal: fixWindow.base.refusal.row, input: reference(better), check: "addressed" }),
  }));
  assert.equal(store.get(fixId)!.revision, 1);
  assert.equal(fixed.value.continuations[0]!.ground, "inputs-fixed");
  assert.equal(fixed.value.stop, null);

  // The owner's decision, written with the continuation: H2 writes the decision and continues the series at once.
  const ownerWindow = window("own");
  deliveredOf(escalateSeries(store, { ...address("own"), stop: 3, review: { ref: undecided(store, "own", 3) } }));
  const decisionId = unwritten("own", OWNER_DECISION_KIND);
  assert.equal(store.get(decisionId), null);
  const owned = deliveredOf(resumeSeries(store, {
    ...address("own"), stop: 3, ground: "owner-decision", text: "the owner decided",
    decision: onItsWay(decisionId, OWNER_DECISION_KIND, decision("own", 3)),
  }));
  assert.equal(store.get(decisionId)!.revision, 1);
  assert.equal(owned.value.stop, null);
  assert.deepEqual(owned.value.ladder.windows, [3]);
  assert.equal(ownerWindow.base.refusal.row.length > 0, true);

  // Prepared, not written: the set carries the series and the record its ground is made of, and when the series
  // moves before the write, neither is written.
  const raceWindow = window("race");
  const lateId = unwritten("race", OWNER_DECISION_KIND);
  deliveredOf(escalateSeries(store, { ...address("race"), stop: 3, review: { ref: undecided(store, "race", 3) } }));
  const transition = deliveredOf(prepareResumeSeries(store, {
    ...address("race"), stop: 3, ground: "owner-decision", text: "the owner decided",
    decision: onItsWay(lateId, OWNER_DECISION_KIND, decision("race", 3)),
  }));
  assert.deepEqual(transition.writes.map(write => write.id), [seriesId("race", BLOCK, 1), lateId]);
  assert.equal(transition.writes[1]!.expected, 0);
  assert.equal(store.get(lateId), null);
  // Another decision answers that stop first; the prepared set is stale, and nothing of it is applied.
  deliveredOf(resumeSeries(store, { ...address("race"), stop: 3, ...byOwner(store, "race", 3) }));
  const before = held(store, "race")!;
  assert.equal(refusalOf(writeGuarded(store, {
    unit: "a6", target: seriesId("race", BLOCK, 1), writes: [...transition.writes], guards: [...transition.guards],
  })).code, "input_stale");
  assert.equal(store.get(lateId), null);
  assert.equal(held(store, "race")!.revision, before.revision);
  assert.equal(raceWindow.base.refusal.row.length > 0, true);
});

test("a record handed over to be written is held to the address and the content of a stored one, and writes nothing when refused", t => {
  const { store } = fixture(t);
  const base = fixable(store, PROJECT);
  opened(store);
  circled(store, PROJECT, base.refusal);
  const stop = held(store)!.value.stop!;
  const standing = held(store)!;
  const escalate = (id: string, kind: string, value: Record<string, unknown>, expected: string): Refusal =>
    addressed(refusalOf(escalateSeries(store, { ...address(PROJECT), stop: 3, review: onItsWay(id, kind, value) })), expected);
  const undecidedValue = review(PROJECT, 3, stop.goals, { change: null });

  // The address rules of a stored record hold before the store is touched: this project's namespace, this kind.
  const foreign = `${stopReviewNamespace("beta")}${next()}`;
  assert.equal(escalate(foreign, STOP_REVIEW_KIND, undecidedValue, "record_foreign").at.field, "review.pending.id");
  assert.equal(escalate(`om-stage:${PROJECT}:1`, STOP_REVIEW_KIND, undecidedValue, "record_foreign").at.field, "review.pending.id");
  const wrongKind = unwritten(PROJECT, STOP_REVIEW_KIND);
  assert.equal(escalate(wrongKind, OWNER_DECISION_KIND, undecidedValue, "record_foreign").at.field, "review.pending.kind");

  // The content is weighed by the same rules as a stored record's, and a record refused is a record not written.
  const cases: [Record<string, unknown>, string][] = [
    [review(PROJECT, 9, stop.goals, { change: null }), "review.stop"],
    [review(PROJECT, 3, ["gap:cart:tax"], { change: null }), "review.goals"],
    [review(PROJECT, 3, [...stop.goals, "gap:cart:tax"], { change: null }), "review.goals"],
    [review(PROJECT, 3, stop.goals, { change: null, block: "block:checkout" }), "review.block"],
    [review(PROJECT, 3, stop.goals, { change: null, projectId: "beta" }), "review.block"],
    [review(PROJECT, 3, stop.goals, {}), "review.change"],
    [review(PROJECT, 3, stop.goals, { change: {} }), "review.change"],
  ];
  for (const [value, field] of cases) {
    const id = unwritten(PROJECT, STOP_REVIEW_KIND);
    assert.equal(escalate(id, STOP_REVIEW_KIND, value, "review_unusable").at.field, field);
    assert.equal(store.get(id), null, field);
  }
  assert.equal(store.get(foreign), null);
  assert.equal(store.get(wrongKind), null);
  assert.equal(held(store)!.revision, standing.revision);
  assert.deepEqual(held(store)!.value.escalations, []);

  // An id another record already stands at is not written over, whatever that record is.
  const taken = unwritten(PROJECT, STOP_REVIEW_KIND);
  const other = store.write({ id: taken, kind: STOP_REVIEW_KIND, expected: 0, value: review(PROJECT, 9, stop.goals) as unknown as Json });
  assert.equal(escalate(taken, STOP_REVIEW_KIND, undecidedValue, "revision_conflict").at.field, "review.pending.id");
  assert.equal(store.get(taken)!.hash, other.hash);
  assert.equal(store.history(taken).length, 1);

  // Neither of the two ways is a default for the other: a ground names exactly one of them.
  const broken: unknown[] = [
    {}, { ref: reference(other), pending: { id: taken, kind: STOP_REVIEW_KIND, value: undecidedValue } },
    { pending: null }, { pending: { id: taken, kind: STOP_REVIEW_KIND } },
    { pending: { id: taken, value: undecidedValue } }, { pending: { kind: STOP_REVIEW_KIND, value: undecidedValue } },
    { pending: { id: "", kind: STOP_REVIEW_KIND, value: undecidedValue } },
    { pending: { id: `${stopReviewNamespace(PROJECT)}${"x".repeat(200)}`, kind: STOP_REVIEW_KIND, value: undecidedValue } },
    { pending: { id: taken, kind: STOP_REVIEW_KIND, value: undefined } },
    { pending: { id: taken, kind: STOP_REVIEW_KIND, value: () => undecidedValue } },
    { pending: { id: taken, kind: STOP_REVIEW_KIND, value: undecidedValue, extra: 1 } },
  ];
  for (const review_ of broken) {
    assert.throws(() => escalateSeries(store, { ...address(PROJECT), stop: 3, review: review_ as GroundRecord }), code("series_request_invalid"));
    assert.throws(() => resumeSeries(store, {
      ...address(PROJECT), stop: 3, ground: "review-record", text: "on", review: review_ as GroundRecord,
    }), code("series_request_invalid"));
  }
  assert.equal(held(store)!.revision, standing.revision);
});

test("two series and one new record of a ground go into one transaction, or none of them does", t => {
  const { store } = fixture(t);
  const other = "block:checkout";
  const at = (block: string): SeriesRequest => ({ project: PROJECT, block, line: 1 });
  const stopped = (block: string): void => {
    deliveredOf(openSeries(store, { ...at(block), slice: SLICE, predecessor: null, basis: null }));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      deliveredOf(beginAttempt(store, { ...at(block), attempt, goal: goal() }));
      deliveredOf(completeAttempt(store, { ...at(block), attempt, outcome: fruitless() }));
    }
  };
  stopped(BLOCK);
  stopped(other);

  // One block's stop is escalated on a review that is written with it; the other's on a review already stored.
  const newReview = unwritten(PROJECT, STOP_REVIEW_KIND);
  const prepare = () => [
    deliveredOf(prepareEscalateSeries(store, {
      ...at(BLOCK), stop: 3, review: onItsWay(newReview, STOP_REVIEW_KIND, review(PROJECT, 3, undefined, { change: null })),
    })),
    deliveredOf(prepareEscalateSeries(store, {
      ...at(other), stop: 3, review: { ref: undecided(store, PROJECT, 3, undefined, { block: other }) },
    })),
  ];
  const apply = (parts: readonly SeriesTransition[]) => writeGuarded(store, {
    unit: "a6", target: "om-escalations:alpha",
    writes: parts.flatMap(part => [...part.writes]), guards: parts.flatMap(part => [...part.guards]),
  });
  const first = prepare();
  assert.deepEqual(first[0]!.writes.map(write => write.id), [seriesId(PROJECT, BLOCK, 1), newReview]);
  assert.equal(first[1]!.writes.length, 1);
  assert.equal(store.get(newReview), null);

  // One participant moves before the write: nothing at all is applied — not the other series, and not the new record.
  deliveredOf(escalateSeries(store, { ...at(other), stop: 3, review: { ref: undecided(store, PROJECT, 3, undefined, { block: other }) } }));
  assert.equal(refusalOf(apply(first)).code, "input_stale");
  assert.equal(store.get(newReview), null);
  assert.deepEqual(deliveredOf(readSeries(store, at(BLOCK))).value.escalations, []);

  // Nothing prevented: the review and both series move together.
  const second = deliveredOf(prepareEscalateSeries(store, {
    ...at(BLOCK), stop: 3, review: onItsWay(newReview, STOP_REVIEW_KIND, review(PROJECT, 3, undefined, { change: null })),
  }));
  const done = deliveredOf(apply([second]));
  assert.equal(done.length, 2);
  assert.equal(store.get(newReview)!.revision, 1);
  const series = deliveredOf(readSeries(store, at(BLOCK)));
  assert.deepEqual(series.value.escalations, [{ after: 3, review: reference(store.get(newReview)!) }]);
  assert.equal(series.value.ladder.rung, 2);
  assert.equal(deliveredOf(readSeries(store, at(other))).value.ladder.rung, 2);
});

// ---------------------------------------------------------------------------
// The history of the stops, derived by the same walk that builds and checks the ladder (journal record №186).

test("the history of the stops comes from the same walk: exact goals, window boundaries, and what answered each", t => {
  const { store } = fixture(t);
  opened(store);
  // Two cycles of one goal and a third of another: the stop is counted over both of them.
  const refusal = journalled(store, PROJECT);
  const failed = () => outcome({ reason: "refused", refusals: [refusal] });
  cycle(store, PROJECT, goal(), failed());
  cycle(store, PROJECT, goal(), failed());
  cycle(store, PROJECT, goal({ key: "gap:cart:tax" }), failed());
  assert.deepEqual(held(store)!.value.stop!.goals, ["gap:cart:price", "gap:cart:tax"]);

  // A stop that stands: nothing answered it, so no window was opened.
  assert.deepEqual(deliveredOf(readStopHistory(store, address(PROJECT))), {
    standing: 3,
    stops: [{
      attempt: 3, attempts: [1, 2, 3], goals: ["gap:cart:price", "gap:cart:tax"],
      escalation: null, continuation: null, window: null,
    }],
  });

  // Continued on a review: the window it opened stays open until something ends it.
  const ground = byReview(store, PROJECT, 3, ["gap:cart:price", "gap:cart:tax"]);
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 3, ...ground } as ResumeSeriesRequest));
  const continued = deliveredOf(readStopHistory(store, address(PROJECT)));
  assert.equal(continued.standing, null);
  assert.deepEqual(continued.stops[0]!.continuation, storedGround(ground, 3));
  assert.deepEqual(continued.stops[0]!.window, { ended: "open" });

  // Three more cycles without progress: that window closed in the NEXT stop, which the history holds too.
  circled(store, PROJECT, refusal);
  const twice = deliveredOf(readStopHistory(store, address(PROJECT)));
  assert.deepEqual(twice.stops.map(item => item.attempt), [3, 6]);
  assert.deepEqual(twice.stops[0]!.window, { ended: "stop", at: 6 });
  assert.deepEqual(twice.stops[1]!.goals, ["gap:cart:price"]);
  assert.equal(twice.stops[1]!.window, null);

  // The owner lets it go on, and the next cycle reaches a new accepted result: THAT ends the second window, and it
  // returns the ladder to its start — which drops the windows the ladder had spent. The history keeps every stop.
  const owner = byOwner(store, PROJECT, 6, ["gap:cart:price"]);
  deliveredOf(resumeSeries(store, { ...address(PROJECT), stop: 6, ...owner } as ResumeSeriesRequest));
  cycle(store, PROJECT, goal(), outcome({ achieved: [win(store, "line:cart:price")] }));
  assert.deepEqual(held(store)!.value.ladder.windows, []);
  circled(store, PROJECT, refusal);

  const whole = deliveredOf(readStopHistory(store, address(PROJECT)));
  assert.deepEqual(whole.stops.map(item => item.attempt), [3, 6, 10]);
  assert.equal(whole.standing, 10);
  assert.deepEqual(whole.stops[0]!.window, { ended: "stop", at: 6 });
  assert.deepEqual(whole.stops[1]!.window, { ended: "progress", at: 7, goal: "gap:cart:price", accepted: ["line:cart:price"] });
  assert.deepEqual(whole.stops[1]!.continuation, storedGround(owner, 6));
  assert.equal(whole.stops[2]!.window, null);
  // The goals of a stop already answered are still exact here, and the ladder no longer says them at all.
  assert.deepEqual(whole.stops[0]!.goals, ["gap:cart:price", "gap:cart:tax"]);
  assert.deepEqual(held(store)!.value.ladder.goals, []);
  assert.ok(deeplyFrozen(whole));

  // A successor of the series carries the whole history: an inherited stop keeps its attempt, its goals and its window.
  const predecessor = reference(held(store)!);
  opened(store, PROJECT, { line: 2, slice: "slice:cart@2", predecessor, basis: { ground: "inputs-changed", text: "the slice of the horizon moved" } });
  const inheritedHistory = deliveredOf(readStopHistory(store, address(PROJECT, 2)));
  assert.deepEqual(inheritedHistory, whole);

  // An escalation answers a stop and opens NO window: the stop stays, and it stays the owner's.
  opened(store, "beta");
  circled(store, "beta", journalled(store, "beta"));
  const raised = undecided(store, "beta", 3);
  deliveredOf(escalateSeries(store, { ...address("beta"), stop: 3, review: { ref: raised } }));
  const escalated = deliveredOf(readStopHistory(store, address("beta")));
  assert.equal(escalated.standing, 3);
  assert.deepEqual(escalated.stops[0]!.escalation, { after: 3, review: raised });
  assert.equal(escalated.stops[0]!.continuation, null);
  assert.equal(escalated.stops[0]!.window, null);

  // It is read like any series: the shape of the request is weighed first, and a series that does not stand is refused.
  assert.throws(() => readStopHistory(store, undefined as unknown as SeriesRequest), code("series_request_invalid"));
  assert.throws(() => readStopHistory({} as Store, address(PROJECT)), code("series_request_invalid"));
  assert.equal(refusalOf(readStopHistory(store, address("gamma"))).code, "series_missing");
});

// ---------------------------------------------------------------------------
// A record that arrives ALREADY WRITTEN (repair A3.2, verdict 188). A saved stop closes the window, so a stored
// history holds no attempt past a stop nothing had continued, and every escalation and continuation in it answers the
// stop of its OWN attempt. The live operations refuse both (series_stopped, stop_absent) — and never saw this record
// written, which is why the same rule is applied at every reading.

/** One more completed attempt, shaped exactly as this unit writes one: the last attempt of a line at a later ordinal. */
const oneMore = (attempts: readonly Attempt[], ordinal: number): Record<string, unknown> =>
  ({ ...(attempts[attempts.length - 1] as unknown as Record<string, unknown>), ordinal });

test("a stored history holds no attempt past a standing stop, and no transition of another attempt's stop (T3, T4)", t => {
  const { store } = fixture(t);
  const stopped = (project: string): RepairSeries => {
    opened(store, project);
    for (let round = 0; round < 3; round += 1) cycle(store, project, goal(), fruitless());
    return held(store, project)!.value;
  };

  // An attempt standing past a stop nothing continued. Everything derived from the history is written to agree with it
  // — a count of four, the same stop, the same rung — and the attempt still could not have been begun.
  const plain = stopped("past");
  assert.equal(plain.stop!.attempt, 3);
  forge(store, "past", value => ({ ...value, attempts: [...value.attempts, oneMore(value.attempts, 4)], withoutProgress: 4 }));
  const past = addressed(refusalOf(readSeries(store, address("past"))), "series_invalid", "past");
  assert.equal(past.at.field, "attempts.4");
  assert.ok(past.message.includes("attempt 3"));

  // And an attempt merely BEGUN past it moves no count at all, so nothing derived disagrees with the record either.
  stopped("open");
  forge(store, "open", value => ({
    ...value, attempts: [...value.attempts, { ordinal: 4, goal: value.attempts[0]!.goal, outcome: null, verdict: null }],
  }));
  assert.equal(addressed(refusalOf(readSeries(store, address("open"))), "series_invalid", "open").at.field, "attempts.4");

  // The ESCALATION of a stop is the escalation of its own attempt. This is the history verdict 188 reproduced: the
  // stop stands after attempt 3, the escalation says "after: 4", and the history handed it to the stop of attempt 3.
  stopped("raise");
  const undecided_ = deliveredOf(escalateSeries(store, {
    ...address("raise"), stop: 3, review: { ref: undecided(store, "raise", 3) },
  })).value.escalations[0]!.review;
  forge(store, "raise", value => ({
    ...value, attempts: [...value.attempts, oneMore(value.attempts, 4)], withoutProgress: 4,
    escalations: [{ after: 4, review: undecided_ }],
  }));
  const raise = addressed(refusalOf(readSeries(store, address("raise"))), "series_invalid", "raise");
  assert.equal(raise.at.field, "escalations.0.after");
  assert.ok(raise.message.includes("attempt 3"));
  // The history of the stops comes from the same reading, so it hands out no escalation of a stop that is not its own:
  // the refusal comes first, instead of the stop of attempt 3 carrying an escalation nobody made for it.
  assert.equal(addressed(refusalOf(readStopHistory(store, address("raise"))), "series_invalid", "raise").at.field, "escalations.0.after");

  // The same for a CONTINUATION: the window it opens is the window of its own stop, and no later attempt lends it one.
  stopped("lift");
  const ground = byReview(store, "lift", 3);
  const continued = deliveredOf(resumeSeries(store, { ...address("lift"), stop: 3, ...ground })).value;
  assert.deepEqual(continued.ladder.windows, [3]);
  assert.equal(continued.stop, null);
  forge(store, "lift", value => ({
    ...value, attempts: [...value.attempts, oneMore(value.attempts, 4)],
    continuations: [{ ...value.continuations[0]!, after: 4 }],
  }));
  const lift = addressed(refusalOf(readSeries(store, address("lift"))), "series_invalid", "lift");
  assert.equal(lift.at.field, "continuations.0.after");
  assert.equal(addressed(refusalOf(readStopHistory(store, address("lift"))), "series_invalid", "lift").at.field, "continuations.0.after");

  // What the live operations do is untouched: an ordinal that is not the standing stop is stop_absent for either kind
  // of transition, an attempt past the stop is series_stopped, and no refusal writes anything (T8).
  const genuine = stopped("live");
  const before = held(store, "live")!.revision;
  addressed(refusalOf(escalateSeries(store, { ...address("live"), stop: 4, review: { ref: undecided(store, "live", 4) } })), "stop_absent", "live");
  addressed(refusalOf(resumeSeries(store, { ...address("live"), stop: 4, ...byReview(store, "live", 4) })), "stop_absent", "live");
  addressed(refusalOf(beginAttempt(store, { ...address("live"), attempt: 4, goal: goal() })), "series_stopped", "live");
  assert.equal(held(store, "live")!.revision, before);
  assert.deepEqual(held(store, "live")!.value, genuine);

  // A successor whose predecessor holds such a history is refused by the same check: the inherited line is derived
  // again from the predecessor at the exact reference it names, and a history that could not have happened is not one.
  stopped("heir");
  const successor = deliveredOf(openSeries(store, {
    ...address("heir", 2), slice: "slice:cart@2", predecessor: reference(held(store, "heir", 1)!),
    basis: { ground: "inputs-changed", text: "the closure of the block moved" },
  }));
  assert.equal(successor.value.stop!.attempt, 3);
  assert.equal(successor.value.inherited.length, 3);
  forge(store, "heir", value => ({ ...value, attempts: [...value.attempts, oneMore(value.attempts, 4)], withoutProgress: 4 }));
  const moved = reference(held(store, "heir", 1)!);
  forge(store, "heir", value => ({
    ...value, predecessor: moved, inherited: [...value.inherited, oneMore(value.inherited, 4)], withoutProgress: 4,
  }), 2);
  assert.equal(addressed(refusalOf(readSeries(store, address("heir", 1))), "series_invalid", "heir").at.field, "attempts.4");
  const heir = addressed(refusalOf(readSeries(store, address("heir", 2))), "series_invalid", "heir", 2);
  assert.equal(heir.at.field, "attempts.4");
  assert.equal(addressed(refusalOf(readStopHistory(store, address("heir", 2))), "series_invalid", "heir", 2).at.field, "attempts.4");
});
