import { hashJson } from "../canonical.js";
import { requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Sealed } from "./refusal.js";
import { readRecord, writeGuarded } from "./refs.js";
import { readJournal, REFUSAL_JOURNAL_KIND, type JournalRow } from "./refusal-journal.js";

/**
 * The history of attempts at one block and one slice of the horizon.
 * An attempt is a COMPLETED CYCLE at a goal named BEFORE it started — a question or an agreed package of questions
 * with the checkable result that would bring the goal nearer. Its outcome is counted once; the same outcome delivered
 * again is a repeat, not a second event.
 * Progress is not a word a caller may say. An outcome carries ACHIEVEMENTS: the stable key of what was closed and the
 * exact reference to the record that accepted it. The series decides for itself whether the attempt moved anything —
 * there is progress when a key is new to the history of THIS goal — so alternation A → B → A, the re-taking of a
 * result that was lost, a changed candidate and a delivered answer are no progress, and a fix that cancelled an
 * earlier result is a conflict of results rather than a success.
 * The count of consecutive attempts without progress, the verdict of every attempt and the saved stop are DERIVED
 * from the attempts and re-derived whenever the record is read: a stored count or verdict that does not follow from
 * the attempts is refused instead of believed. There is no limit on the NUMBER of attempts. The third consecutive
 * attempt without progress saves a stop with its cause and the point to continue from; a restart does not lift it,
 * and only a recorded ground — a change of approach or of inputs, or the owner's decision — continues the work.
 * EVERY change of state names the state it comes from: the attempt a request opens, the outcome it closes, the stop
 * it continues and the predecessor it succeeds. A delivery that arrives late finds its own state already there and
 * changes nothing (T5), instead of landing on whatever state the series has reached since.
 */
const UNIT = "store-repairs";
const MAX_ENTITY_ID = 200; // the store's own limit on an entity id (src/storage/store.ts)
const STOP_AFTER = 3; // the third consecutive attempt without progress saves a stop (rules of model calls, G7)

export const REPAIR_SERIES_KIND = "repair-series";

/**
 * Why a cycle ended. The table is closed because the rules attach a defined effect to its entries and an unnamed
 * reason has no defined effect: "awaiting-owner" neither raises the count nor clears it, "interrupted" is a cause of
 * ending and not a verdict about progress, and an answer that came off-form or not to the question ends the attempt
 * WITHOUT a result. Refusing an unnamed reason is not a choice about the product; inventing an effect for one would be.
 */
export const COMPLETION_REASONS = Object.freeze(["result", "refused", "off-form", "interrupted", "awaiting-owner"] as const);
export type CompletionReason = typeof COMPLETION_REASONS[number];

// A cycle that ends without a result claims neither an achievement nor the loss of one.
const WITHOUT_RESULT: readonly CompletionReason[] = Object.freeze(["off-form", "awaiting-owner"] as const);

export const ATTEMPT_VERDICTS = Object.freeze(["progress", "conflict", "none", "neutral"] as const);
export type AttemptVerdict = typeof ATTEMPT_VERDICTS[number];

// The grounds on which stopped work continues. "Inputs changed" is also what a successor of a series stands on when
// the slice moves — a recorded ground to continue, which is not itself progress.
export const CONTINUATION_GROUNDS = Object.freeze(["approach-changed", "inputs-changed", "owner-decision"] as const);
export type ContinuationGround = typeof CONTINUATION_GROUNDS[number];

// Every refusal this unit can produce. The list is the checklist its test walks, so a new code cannot arrive untested.
export const SERIES_CODES = Object.freeze([
  "series_conflict", "series_missing", "series_invalid", "series_foreign", "slice_unchanged",
  "attempt_running", "attempt_unknown", "attempt_conflict", "outcome_conflict", "outcome_invalid",
  "basis_unresolved", "cancelled_unknown", "refusal_unlinked",
  "series_stopped", "stop_absent", "continuation_conflict",
] as const);
export type SeriesCode = typeof SERIES_CODES[number];

/** The goal named before the attempt: its lasting identity, the question or agreed package, and the checkable result. */
export interface AttemptGoal {
  readonly key: string;
  readonly questions: readonly string[];
  readonly result: string;
}

/**
 * What one cycle closed: the lasting key of the obligation, gap line or answer, and the exact reference to the record
 * that accepted it. The reference proves WHICH record was read, never that it accepted anything (that is the duty of
 * the unit that writes the accepting record); the key is what the history of a goal is kept in, so it survives a
 * change of revisions, of ids and of the series around it.
 */
export interface Achievement {
  readonly key: string;
  readonly basis: Ref;
}

/**
 * A refusal of a completed cycle, kept as the LINK to the row the journal of refusals holds for it.
 * The row id of A2 is the hash of that row's own content — its gate, code, goal, remedy, origin and the exact record
 * the gate wrote — so the link fixes the refusal's name and goal exactly, and G7's class and addressee are found
 * beside the row. Two refusals of the same name and goal from different origins are different rows, and therefore
 * different here. The name and the goal are NOT copied into the series: a copy of what the link already determines
 * would be a second truth about one fact, free to drift from the row it stands for.
 */
export interface SeriesRefusal {
  readonly row: string;
}

/** What a caller claims a refusal was. All three are weighed against the journal; only the link is kept. */
export interface ClaimedRefusal extends SeriesRefusal {
  readonly name: string;
  readonly goal: string;
}

export interface AttemptOutcome {
  readonly reason: CompletionReason;
  readonly achieved: readonly Achievement[];
  readonly cancelled: readonly string[];
  readonly refusals: readonly SeriesRefusal[];
}

export interface ClaimedOutcome extends Omit<AttemptOutcome, "refusals"> {
  readonly refusals: readonly ClaimedRefusal[];
}

// An attempt with no outcome is the one still running: there is one truth about its state, not a status field beside it.
export interface Attempt {
  readonly ordinal: number;
  readonly goal: AttemptGoal;
  readonly outcome: AttemptOutcome | null;
  readonly verdict: AttemptVerdict | null;
}

export interface SeriesBasis {
  readonly ground: ContinuationGround;
  readonly text: string;
}

export interface Continuation extends SeriesBasis {
  readonly after: number;
}

export interface SeriesStop {
  readonly attempt: number;
  readonly attempts: readonly number[];
  readonly goals: readonly string[];
  readonly reason: string;
  readonly resume: string;
}

export interface RepairSeries {
  readonly projectId: string;
  readonly block: string;
  readonly line: number;
  readonly slice: string;
  readonly predecessor: Ref | null;
  readonly basis: SeriesBasis | null;
  readonly inherited: readonly Attempt[];
  readonly attempts: readonly Attempt[];
  readonly continuations: readonly Continuation[];
  readonly withoutProgress: number;
  readonly stop: SeriesStop | null;
}

export interface SeriesRequest {
  readonly project: string;
  readonly block: string;
  readonly line: number;
}
export interface OpenSeriesRequest extends SeriesRequest {
  readonly slice: string;
  readonly predecessor: Ref | null;
  readonly basis: SeriesBasis | null;
}
/** The ordinal is part of the request: a late delivery finds its own attempt, and never opens the one after it. */
export interface BeginAttemptRequest extends SeriesRequest {
  readonly attempt: number;
  readonly goal: AttemptGoal;
}
export interface CompleteAttemptRequest extends SeriesRequest {
  readonly attempt: number;
  readonly outcome: ClaimedOutcome;
}
/** The stop is part of the request: a late continuation finds the stop it was given for, and never lifts a later one. */
export interface ResumeSeriesRequest extends SeriesRequest, SeriesBasis {
  readonly stop: number;
}

/**
 * One prepared change: the record to write, the exact references it must be guarded by, and what the series would
 * hold afterwards. `write` is null when the series already holds this change — a repeat needs no revision.
 * A caller that has to write SEVERAL records at once (B3 applying the transition of many series together with its own
 * record of the transition) puts these writes and guards into one writeGuarded of its own, so that either all of the
 * successors and the transition are applied, or none is.
 */
export interface PreparedWrite {
  readonly id: string;
  readonly kind: string;
  readonly expected: number;
  readonly value: RepairSeries;
}
export interface SeriesTransition {
  readonly write: PreparedWrite | null;
  readonly guards: readonly Ref[];
  readonly value: RepairSeries;
}

const GOAL_KEYS = Object.freeze(["key", "questions", "result"] as const);
const ACHIEVEMENT_KEYS = Object.freeze(["key", "basis"] as const);
const STORED_REFUSAL_KEYS = Object.freeze(["row"] as const);
const CLAIMED_REFUSAL_KEYS = Object.freeze(["name", "goal", "row"] as const);
const OUTCOME_KEYS = Object.freeze(["reason", "achieved", "cancelled", "refusals"] as const);
const ATTEMPT_KEYS = Object.freeze(["ordinal", "goal", "outcome", "verdict"] as const);
const BASIS_KEYS = Object.freeze(["ground", "text"] as const);
const CONTINUATION_KEYS = Object.freeze([...BASIS_KEYS, "after"] as const);
const SERIES_KEYS = Object.freeze([
  "projectId", "block", "line", "slice", "predecessor", "basis",
  "inherited", "attempts", "continuations", "withoutProgress", "stop",
] as const);

interface Address { readonly project: string; readonly block: string; readonly line: number; readonly id: string }
interface Context { readonly target: string; readonly ref: Ref | undefined }
interface Prepared { readonly transition: SeriesTransition; readonly current: Revision<RepairSeries> | null }

export function seriesId(project: string, block: string, line: number): string {
  // The line is decimal digits and a project carries no ':', so the address of a series decomposes in one way only,
  // even though a block name carries ':' of its own ("block:cart").
  const id = `${REPAIR_SERIES_KIND}:${requireProject(project)}:${requireLine(line)}:${requireBlock(block)}`;
  requireCondition(id.length <= MAX_ENTITY_ID, "series_request_invalid", "A series whose address overflows an entity id cannot be kept");
  return id;
}

/**
 * Opens the series of one block and one slice of the horizon, or its successor when the slice has moved.
 * A successor names its predecessor by an exact reference, carries its whole history of attempts and stands on a
 * recorded ground — the change of inputs continues the work, but is not itself progress, so the count of attempts
 * without progress is carried over with the history rather than cleared. A successor at the same slice is refused:
 * an unchanged slice is the same series, and re-issuing one would be a way round a saved stop.
 * Opening the same series again changes nothing and writes no revision, however much has happened since (T5).
 */
export function openSeries(store: Store, request: OpenSeriesRequest): OmResult<Sealed<Revision<RepairSeries>>> {
  return applied(store, prepareOpen(store, request));
}

/**
 * Names the goal of one cycle and the ordinal of the attempt it opens.
 * An ordinal this series already holds is that attempt — running or long closed — when the goal is the same, so a
 * notification lost to a restart re-reaches the cycle it was about instead of opening the next one; the same ordinal
 * under another goal is a conflict. Only the next ordinal opens an attempt, and none opens while a stop stands.
 */
export function beginAttempt(store: Store, request: BeginAttemptRequest): OmResult<Sealed<Revision<RepairSeries>>> {
  return applied(store, prepareBegin(store, request));
}

/**
 * Records the outcome of one completed cycle, once.
 * The same outcome delivered again changes nothing and writes no revision; a different outcome for an attempt already
 * closed is refused, so a late delivery does not undo a later one (T5). Whether the attempt moved the goal is decided
 * here, from the achievements it carries and the history of that goal — never from a word of the caller's.
 */
export function completeAttempt(store: Store, request: CompleteAttemptRequest): OmResult<Sealed<Revision<RepairSeries>>> {
  return applied(store, prepareComplete(store, request));
}

/**
 * Continues the series from the stop the request names, on a recorded ground.
 * A restart does not lift a stop and neither does a continuation given for an earlier one: the ground is recorded
 * against the attempt whose stop it answers, so a late repeat finds its own ground already there and leaves a stop
 * saved since then standing. The count of attempts without progress is untouched — a change of approach or of inputs
 * is not itself progress.
 */
export function resumeSeries(store: Store, request: ResumeSeriesRequest): OmResult<Sealed<Revision<RepairSeries>>> {
  return applied(store, prepareResume(store, request));
}

/**
 * Reads the series of one block and line.
 * An absent series is a typed refusal, not an empty one: a block that was never repaired and a series that was lost
 * are different facts, and no consumer may read them alike (T4).
 */
export function readSeries(store: Store, request: SeriesRequest): OmResult<Sealed<Revision<RepairSeries>>> {
  requireStore(store);
  requireCondition(isPlainObject(request), "series_request_invalid", "A series is read through a request object");
  const address = requireAddress(request);
  const current = currentSeries(store, address);
  if (!current) return missing(address);
  return current.ok ? delivered(current.value) : current;
}

// Each change is prepared once and applied in one of two ways: written on its own here, or handed to a caller that
// writes it together with other records in a single guarded transaction. One implementation, two entrances.
export const prepareOpenSeries = (store: Store, request: OpenSeriesRequest): OmResult<Sealed<SeriesTransition>> =>
  handed(prepareOpen(store, request));
export const prepareBeginAttempt = (store: Store, request: BeginAttemptRequest): OmResult<Sealed<SeriesTransition>> =>
  handed(prepareBegin(store, request));
export const prepareCompleteAttempt = (store: Store, request: CompleteAttemptRequest): OmResult<Sealed<SeriesTransition>> =>
  handed(prepareComplete(store, request));
export const prepareResumeSeries = (store: Store, request: ResumeSeriesRequest): OmResult<Sealed<SeriesTransition>> =>
  handed(prepareResume(store, request));

const handed = (prepared: OmResult<Prepared>): OmResult<Sealed<SeriesTransition>> =>
  prepared.ok ? delivered(prepared.value.transition) : prepared;

function applied(store: Store, prepared: OmResult<Prepared>): OmResult<Sealed<Revision<RepairSeries>>> {
  if (!prepared.ok) return prepared;
  const { transition, current } = prepared.value;
  // Nothing to write is a fact, not a failure: the series already holds what was asked for.
  if (transition.write === null) return delivered(current!);
  const result = writeGuarded<RepairSeries>(store, {
    unit: UNIT, target: transition.write.id, guards: transition.guards, writes: [transition.write],
  });
  if (!result.ok) return result;
  return delivered(result.value[0]!);
}

const unchanged = (current: Revision<RepairSeries>): OmResult<Prepared> =>
  ({ ok: true, value: { transition: { write: null, guards: [], value: current.value }, current } });

function change(address: Address, value: RepairSeries, expected: number, guards: readonly Ref[], current: Revision<RepairSeries> | null): OmResult<Prepared> {
  return {
    ok: true,
    value: {
      transition: { write: { id: address.id, kind: REPAIR_SERIES_KIND, expected, value }, guards: [...guards], value },
      current,
    },
  };
}

function prepareOpen(store: Store, request: OpenSeriesRequest): OmResult<Prepared> {
  requireStore(store);
  requireCondition(isPlainObject(request), "series_request_invalid", "A series is opened through a request object");
  const address = requireAddress(request);
  requireCondition(isText(request.slice), "series_request_invalid", "A series names the slice of the horizon it belongs to");
  // The first line has no predecessor and no ground to stand on; any later line has both. Neither is a default.
  // Whether a predecessor that IS named is an exact reference is data, not shape: it comes back addressed.
  requireCondition("predecessor" in request && (address.line === 1) === (request.predecessor === null),
    "series_request_invalid", "Only the first line of a series has no predecessor");
  requireCondition((request.basis === null) === (request.predecessor === null),
    "series_request_invalid", "A successor of a series carries the recorded ground it stands on");
  requireCondition(request.basis === null || basisProblem(request.basis) === null,
    "series_request_invalid", "The ground of a successor names one of the recorded grounds and says what changed");
  const basis = request.basis === null ? null : basisOf(request.basis);

  // The predecessor is resolved first, at the exact revision the request names, so that opening the same successor
  // again is recognised as a repeat however far the predecessor has moved on since.
  let inherited: readonly Attempt[] = [];
  let predecessor: Ref | null = null;
  let earlier: Revision<RepairSeries> | null = null;
  if (request.predecessor !== null) {
    const at = seriesId(address.project, address.block, address.line - 1);
    const read = readRecord<RepairSeries>(store, request.predecessor, {
      unit: UNIT, target: address.id, kind: REPAIR_SERIES_KIND, id: at,
    });
    if (!read.ok) return read;
    const broken = checkSeries(store, read.value.value, { ...address, line: address.line - 1, id: at },
      { target: address.id, ref: reference(read.value) });
    if (broken) return broken;
    earlier = read.value as Revision<RepairSeries>;
    inherited = [...earlier.value.inherited, ...earlier.value.attempts].map(copyAttempt);
    predecessor = reference(earlier);
  }

  const standing = currentSeries(store, address);
  if (standing) {
    if (!standing.ok) return standing;
    const held = standing.value.value;
    const same = held.slice === request.slice
      && hashJson(held.predecessor) === hashJson(predecessor) && hashJson(held.basis) === hashJson(basis);
    if (same) return unchanged(standing.value);
    return refused("series_conflict", "A series already stands at this address on another slice, predecessor or ground",
      { unit: UNIT, target: address.id, field: "slice", ref: reference(standing.value) }, "producer");
  }

  if (earlier) {
    if (earlier.value.slice === request.slice) {
      return refused("slice_unchanged", "An unchanged slice keeps the same series and the same count, and opens no successor",
        { unit: UNIT, target: address.id, field: "slice", ref: predecessor ?? undefined }, "producer");
    }
    // A cycle that is still running belongs to the series it was begun in: it is completed, or recorded as
    // interrupted, before the slice moves. Carrying it over would hand the successor an attempt it never began.
    if (running(earlier.value) !== null) {
      return refused("attempt_running", "The predecessor still holds a running attempt, which is completed before the slice moves",
        { unit: UNIT, target: address.id, field: "attempts", ref: predecessor ?? undefined }, "producer");
    }
  }

  const value = settled({
    projectId: address.project, block: address.block, line: address.line, slice: request.slice,
    predecessor, basis, inherited, attempts: [], continuations: [],
  });
  return change(address, value, 0, predecessor === null ? [] : [predecessor], null);
}

function prepareBegin(store: Store, request: BeginAttemptRequest): OmResult<Prepared> {
  requireStore(store);
  requireCondition(isPlainObject(request), "series_request_invalid", "An attempt is begun through a request object");
  const address = requireAddress(request);
  requireCondition(Number.isSafeInteger(request.attempt) && request.attempt >= 1,
    "series_request_invalid", "An attempt names the ordinal it opens, so that a late delivery finds its own attempt");
  requireCondition(goalProblem(request.goal) === null,
    "series_request_invalid", "An attempt names its goal beforehand: a lasting key, the question or package of questions, and the checkable result");
  const goal = goalOf(request.goal);

  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value;
  const context: Context = { target: address.id, ref: reference(head) };
  const held = head.value;

  const known = [...held.inherited, ...held.attempts].find(item => item.ordinal === request.attempt);
  if (known) {
    // T5: an ordinal this series already holds is that attempt, whether it is still running or long closed. A
    // notification that arrives twice, or late, re-reaches the cycle it was about and opens nothing.
    if (hashJson(known.goal) === hashJson(goal)) return unchanged(head);
    return problem("attempt_conflict", `Attempt ${request.attempt} was begun for another goal, and a later goal does not replace it`, context, "goal");
  }
  if (request.attempt !== held.inherited.length + held.attempts.length + 1) {
    return problem("attempt_unknown", `Attempt ${request.attempt} is neither an attempt this series holds nor the next one to open`, context, "attempt");
  }
  if (running(held) !== null) {
    return problem("attempt_running", "Another goal is already being attempted in this series, and a second cycle does not run beside it", context, "attempt");
  }
  if (held.stop !== null) {
    return problem("series_stopped", `A saved stop stands after attempt ${held.stop.attempt}; only a recorded ground continues the work`, context, "stop");
  }
  const attempt: Attempt = { ordinal: request.attempt, goal, outcome: null, verdict: null };
  const value = settled({ ...plainSeries(held), attempts: [...held.attempts.map(copyAttempt), attempt] });
  return change(address, value, head.revision, [reference(head)], head);
}

function prepareComplete(store: Store, request: CompleteAttemptRequest): OmResult<Prepared> {
  requireStore(store);
  requireCondition(isPlainObject(request), "series_request_invalid", "An outcome is recorded through a request object");
  const address = requireAddress(request);
  requireCondition(Number.isSafeInteger(request.attempt) && request.attempt >= 1,
    "series_request_invalid", "An outcome names the attempt it closes by its ordinal");
  requireCondition(outcomeProblem(request.outcome, CLAIMED_REFUSAL_KEYS) === null,
    "series_request_invalid", "An outcome names why the cycle ended, what it achieved and on what ground, what it cancelled, and every refusal with the journal row it stands for");
  const outcome = outcomeOf(request.outcome);

  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value;
  const context: Context = { target: address.id, ref: reference(head) };
  const held = head.value;

  // An inherited attempt was completed in the series it was begun in, so only an own attempt can still be running.
  const attempt = [...held.inherited, ...held.attempts].find(item => item.ordinal === request.attempt);
  if (!attempt) {
    return problem("attempt_unknown", `No attempt ${request.attempt} stands in this series`, context, "attempt");
  }
  if (attempt.outcome !== null) {
    // An outcome is counted once. The same one again is a repeat of the delivery, not a second cycle, and it stays a
    // repeat however many attempts have been begun and closed since.
    if (hashJson(attempt.outcome) === hashJson(outcome)) return unchanged(head);
    return problem("outcome_conflict", `Attempt ${request.attempt} is closed already, and a later outcome does not replace the earlier one`, context, "outcome");
  }

  const contradiction = outcomeContradiction(outcome);
  if (contradiction) return problem("outcome_invalid", contradiction, context, "outcome");
  for (let item = 0; item < outcome.achieved.length; item += 1) {
    const found = store.get(outcome.achieved[item]!.basis.id, outcome.achieved[item]!.basis.revision);
    if (!found || found.hash !== outcome.achieved[item]!.basis.hash) {
      // An achievement stands on a record that exists at exactly the reference it names. Whether that record ACCEPTED
      // anything is decided by the unit that writes it, not read out of a word in this outcome.
      return problem("basis_unresolved", "An achievement names a record that does not stand at that exact reference", context, `outcome.achieved.${item}.basis`);
    }
  }
  const linked = linkedRefusals(store, address, request.outcome.refusals, context);
  if (linked) return linked;
  const history = walk(held).achieved.get(attempt.goal.key) ?? new Set<string>();
  for (let item = 0; item < outcome.cancelled.length; item += 1) {
    if (!history.has(outcome.cancelled[item]!)) {
      return problem("cancelled_unknown", "A cancelled result was never accepted for this goal, so nothing was lost by it", context, `outcome.cancelled.${item}`);
    }
  }

  const closed: Attempt = { ordinal: attempt.ordinal, goal: goalOf(attempt.goal), outcome, verdict: null };
  const value = settled({
    ...plainSeries(held),
    attempts: held.attempts.map(item => (item.ordinal === request.attempt ? closed : copyAttempt(item))),
  });
  return change(address, value, head.revision, [reference(head)], head);
}

function prepareResume(store: Store, request: ResumeSeriesRequest): OmResult<Prepared> {
  requireStore(store);
  requireCondition(isPlainObject(request), "series_request_invalid", "A stopped series is continued through a request object");
  const address = requireAddress(request);
  requireCondition(Number.isSafeInteger(request.stop) && request.stop >= 1,
    "series_request_invalid", "A continuation names the attempt whose stop it answers");
  requireCondition(basisProblem(request) === null,
    "series_request_invalid", "A continuation names one of the recorded grounds and says what changed");
  const basis = basisOf(request);

  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value;
  const context: Context = { target: address.id, ref: reference(head) };
  const held = head.value;

  const already = held.continuations.find(item => item.after === request.stop);
  if (already) {
    // T5: the stop this ground was given for is continued already. The same ground again changes nothing, and a
    // different one does not replace it — neither lifts a stop saved since then, because neither is about it.
    if (hashJson(plainBasis(already)) === hashJson(basis)) return unchanged(head);
    return problem("continuation_conflict", `The stop after attempt ${request.stop} is continued already, and a later ground does not replace the earlier one`, context, "ground");
  }
  if (held.stop === null || held.stop.attempt !== request.stop) {
    return problem("stop_absent", `No saved stop stands after attempt ${request.stop} in this series`, context, "stop");
  }
  const value = settled({
    ...plainSeries(held),
    continuations: [...held.continuations.map(plainContinuation), { ...basis, after: request.stop }],
  });
  return change(address, value, head.revision, [reference(head)], head);
}

/**
 * Weighs each refusal a cycle claims against the journal of refusals of THIS project.
 * The link must stand for a row the journal holds, and the name and goal the cycle reports must be the row's own —
 * so the refusal kept in the series is a refusal a gate really wrote, and G7's class and addressee are reachable from
 * it. The CLASSIFICATION is not required: G7 derives it later, and what matters here is that it can be found.
 */
function linkedRefusals(store: Store, address: Address, claimed: readonly ClaimedRefusal[], context: Context): OmResult<never> | null {
  if (claimed.length === 0) return null;
  const journal = readJournal(store, { project: address.project });
  if (!journal.ok) {
    return problem("refusal_unlinked", `This project holds no journal a refusal could stand in: ${journal.refusal.code}`, context, "outcome.refusals");
  }
  const rows = new Map<string, JournalRow>(journal.value.value.rows.map(row => [row.id, row as JournalRow]));
  for (let item = 0; item < claimed.length; item += 1) {
    const found = rows.get(claimed[item]!.row);
    if (!found) {
      return problem("refusal_unlinked", "No refusal stands in the journal of this project under that row", context, `outcome.refusals.${item}.row`);
    }
    // Two refusals of the same name and goal from different origins are different rows; this is what tells them apart.
    if (found.code !== claimed[item]!.name || found.goal !== claimed[item]!.goal) {
      return problem("refusal_unlinked", "The refusal a cycle reports is not the refusal that row holds", context, `outcome.refusals.${item}.name`);
    }
  }
  return null;
}

function currentSeries(store: Store, address: Address): OmResult<Revision<RepairSeries>> | null {
  // The head revision of the exact id is what a reference to it is made of; the record is then read as any record is,
  // so a foreign kind standing at this address is refused instead of being extended.
  const head = store.get<RepairSeries>(address.id);
  if (!head) return null;
  const read = readRecord<RepairSeries>(store, reference(head), {
    unit: UNIT, target: address.id, kind: REPAIR_SERIES_KIND, id: address.id,
  });
  if (!read.ok) return read;
  const broken = checkSeries(store, read.value.value, address, { target: address.id, ref: reference(head) });
  return broken ?? { ok: true, value: read.value as Revision<RepairSeries> };
}

const missing = (address: Address): OmResult<never> =>
  refused("series_missing", "No series of repairs stands for this block and line",
    { unit: UNIT, target: address.id }, "producer");

const running = (value: RepairSeries): Attempt | null => value.attempts.find(item => item.outcome === null) ?? null;

// ---------------------------------------------------------------------------
// What the series derives for itself: the verdict of every attempt, the count and the saved stop.

interface Walk {
  readonly verdicts: ReadonlyMap<number, AttemptVerdict>;
  readonly achieved: ReadonlyMap<string, ReadonlySet<string>>;
  readonly withoutProgress: number;
  readonly stop: SeriesStop | null;
  readonly stray: boolean;
}

type SeriesDraft = Omit<RepairSeries, "withoutProgress" | "stop">;

/**
 * Walks the attempts of a goal's whole lineage and derives what follows from them.
 * Nothing stored is believed here: the verdict of an attempt comes from its achievements weighed against the history
 * of ITS goal, the count from the verdicts, and the stop from the count. A key already in that history is no progress
 * however it was reached, and a key stays in the history once accepted — so the re-taking of a lost result is not a
 * new achievement either. A cancelled result makes the cycle a conflict of results rather than a success.
 */
function walk(value: SeriesDraft): Walk {
  const verdicts = new Map<number, AttemptVerdict>();
  const achieved = new Map<string, Set<string>>();
  const lifts = new Map(value.continuations.map(item => [item.after, item]));
  const used = new Set<number>();
  let withoutProgress = 0;
  let stop: SeriesStop | null = null;
  let stray = false;
  let run: { ordinals: number[]; goals: string[] } = { ordinals: [], goals: [] };

  const step = (attempt: Attempt): void => {
    if (attempt.outcome === null) return;
    const history = achieved.get(attempt.goal.key) ?? new Set<string>();
    const verdict: AttemptVerdict = attempt.outcome.reason === "awaiting-owner" ? "neutral"
      : attempt.outcome.cancelled.length > 0 ? "conflict"
        : attempt.outcome.achieved.some(item => !history.has(item.key)) ? "progress" : "none";
    verdicts.set(attempt.ordinal, verdict);
    for (const item of attempt.outcome.achieved) history.add(item.key);
    achieved.set(attempt.goal.key, history);

    if (verdict === "progress") {
      withoutProgress = 0;
      run = { ordinals: [], goals: [] };
    } else if (verdict !== "neutral") {
      withoutProgress += 1;
      run.ordinals.push(attempt.ordinal);
      if (!run.goals.includes(attempt.goal.key)) run.goals.push(attempt.goal.key);
      if (withoutProgress >= STOP_AFTER && stop === null) stop = stopOf(attempt, run.ordinals, run.goals);
    }
    const lift = lifts.get(attempt.ordinal);
    if (lift) {
      used.add(attempt.ordinal);
      // A continuation standing where no stop was raised is a ground for nothing; the record is refused, not read.
      if (stop === null) stray = true;
      else stop = null;
    }
  };

  for (const attempt of value.inherited) step(attempt);
  // The recorded ground a successor stands on continues the work the predecessor stopped at; the count stays.
  if (value.basis !== null) stop = null;
  for (const attempt of value.attempts) step(attempt);
  return { verdicts, achieved, withoutProgress, stop, stray: stray || used.size !== lifts.size };
}

function stopOf(attempt: Attempt, ordinals: readonly number[], goals: readonly string[]): SeriesStop {
  // Assembled by code from the records of the attempts, so two readings of the same history give the same stop.
  return {
    attempt: attempt.ordinal,
    attempts: [...ordinals],
    goals: [...goals],
    reason: `${ordinals.length} consecutive attempts closed without a new accepted result for ${goals.join(", ")}`,
    resume: `attempt ${attempt.ordinal + 1} needs a recorded ground: a changed approach, changed inputs or the owner's decision`,
  };
}

/** The value as it is written: the attempts carry the verdicts the walk derived, and the count and stop follow them. */
function settled(draft: SeriesDraft): RepairSeries {
  const derived = walk(draft);
  const verdict = (attempt: Attempt): Attempt =>
    ({ ...copyAttempt(attempt), verdict: derived.verdicts.get(attempt.ordinal) ?? null });
  return {
    projectId: draft.projectId, block: draft.block, line: draft.line, slice: draft.slice,
    predecessor: draft.predecessor === null ? null : exactRef(draft.predecessor),
    basis: draft.basis === null ? null : plainBasis(draft.basis),
    inherited: draft.inherited.map(verdict),
    attempts: draft.attempts.map(verdict),
    continuations: draft.continuations.map(plainContinuation),
    withoutProgress: derived.withoutProgress,
    stop: derived.stop,
  };
}

// ---------------------------------------------------------------------------
// Copies. Fields are taken one by one, so a record holds what the series is defined to hold and nothing that came
// with it; a key such as "__proto__" survives JSON as an own field and is content, not a detail to carry along.
// Every UNORDERED set is put in one canonical order here — before it is written and before two of them are compared —
// so that the same results, the same cancellations, the same refusals and the same package of questions are the same
// outcome whichever order they arrived in (T6), and a repeat of it is a repeat (T5). The order of the ATTEMPTS and of
// the CONTINUATIONS is not of this kind: those are sequences, and their order is the history itself.
// Not localeCompare: what is written must not depend on the machine's locale.
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const ordered = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...items].sort((left, right) => compare(key(left), key(right)));

const exactRef = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
const plainBasis = (basis: SeriesBasis): SeriesBasis => ({ ground: basis.ground, text: basis.text });
const plainContinuation = (item: Continuation): Continuation => ({ ...plainBasis(item), after: item.after });

const goalOf = (goal: AttemptGoal): AttemptGoal =>
  ({ key: goal.key, questions: ordered(goal.questions, question => question), result: goal.result });

/** The outcome as the series keeps it: canonical, and holding the LINK to each refusal rather than a copy of it. */
const outcomeOf = (outcome: AttemptOutcome | ClaimedOutcome): AttemptOutcome => ({
  reason: outcome.reason,
  achieved: ordered(outcome.achieved, item => `${item.key} ${item.basis.id} ${item.basis.revision} ${item.basis.hash}`)
    .map(item => ({ key: item.key, basis: exactRef(item.basis) })),
  cancelled: ordered(outcome.cancelled, key => key),
  // Multiplicity is kept: two refusals are two, and only their order is decided here.
  refusals: ordered(outcome.refusals, item => item.row).map(item => ({ row: item.row })),
});

const copyAttempt = (attempt: Attempt): Attempt => ({
  ordinal: attempt.ordinal, goal: goalOf(attempt.goal),
  outcome: attempt.outcome === null ? null : outcomeOf(attempt.outcome),
  verdict: attempt.verdict,
});

const plainSeries = (value: RepairSeries): SeriesDraft => ({
  projectId: value.projectId, block: value.block, line: value.line, slice: value.slice,
  predecessor: value.predecessor === null ? null : exactRef(value.predecessor),
  basis: value.basis === null ? null : plainBasis(value.basis),
  inherited: value.inherited.map(copyAttempt),
  attempts: value.attempts.map(copyAttempt),
  continuations: value.continuations.map(plainContinuation),
});

// ---------------------------------------------------------------------------
// Shape. The same shape is read on two paths — as it arrives from a caller, and as it already stands in the store.
// What is wrong is the same; who is at fault is not, so a caller's defect is thrown and a stored one is refused.

function goalProblem(value: unknown): string | null {
  if (!isPlainObject(value) || !exactKeys(value, GOAL_KEYS)) return "goal";
  const goal = value as Record<string, unknown>;
  if (!isText(goal['key'])) return "key";
  if (!isText(goal['result'])) return "result";
  const questions = goal['questions'];
  // An absent set is not an empty one, and a goal with no question at all names nothing to attempt.
  if (!Array.isArray(questions) || questions.length === 0) return "questions";
  return questions.every(isText) ? null : "questions";
}

function outcomeProblem(value: unknown, refusalKeys: readonly string[]): string | null {
  if (!isPlainObject(value) || !exactKeys(value, OUTCOME_KEYS)) return "outcome";
  const outcome = value as Record<string, unknown>;
  if (!COMPLETION_REASONS.includes(outcome['reason'] as CompletionReason)) return "reason";
  const achieved = outcome['achieved'];
  if (!Array.isArray(achieved)) return "achieved";
  for (let index = 0; index < achieved.length; index += 1) {
    const item = achieved[index];
    if (!isPlainObject(item) || !exactKeys(item, ACHIEVEMENT_KEYS)) return `achieved.${index}`;
    const entry = item as Record<string, unknown>;
    if (!isText(entry['key'])) return `achieved.${index}.key`;
    if (!isRef(entry['basis'])) return `achieved.${index}.basis`;
  }
  const cancelled = outcome['cancelled'];
  if (!Array.isArray(cancelled) || !cancelled.every(isText)) return "cancelled";
  const refusals = outcome['refusals'];
  if (!Array.isArray(refusals)) return "refusals";
  for (let index = 0; index < refusals.length; index += 1) {
    const item = refusals[index];
    if (!isPlainObject(item) || !exactKeys(item, refusalKeys)) return `refusals.${index}`;
    const entry = item as Record<string, unknown>;
    for (const field of refusalKeys) {
      if (!isText(entry[field])) return `refusals.${index}.${field}`;
    }
  }
  return null;
}

/** What the rules forbid an outcome to say, whatever its shape. */
function outcomeContradiction(outcome: AttemptOutcome): string | null {
  if (WITHOUT_RESULT.includes(outcome.reason) && outcome.achieved.length > 0) {
    return `A cycle that ended as "${outcome.reason}" ended without a result and claims no achievement`;
  }
  if (WITHOUT_RESULT.includes(outcome.reason) && outcome.cancelled.length > 0) {
    return `A cycle that ended as "${outcome.reason}" reached no result and cancelled none`;
  }
  if (outcome.reason === "refused" && outcome.refusals.length === 0) {
    return "A cycle that ended in a final refusal names at least one refusal";
  }
  if (new Set(outcome.achieved.map(item => item.key)).size !== outcome.achieved.length) {
    return "An outcome names each achievement once";
  }
  if (new Set(outcome.cancelled).size !== outcome.cancelled.length) {
    return "An outcome names each cancelled result once";
  }
  return null;
}

function basisProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return "basis";
  const basis = value as Record<string, unknown>;
  if (!CONTINUATION_GROUNDS.includes(basis['ground'] as ContinuationGround)) return "ground";
  return isText(basis['text']) ? null : "text";
}

const basisOf = (basis: SeriesBasis): SeriesBasis => plainBasis({ ground: basis.ground, text: basis.text });

// ---------------------------------------------------------------------------
// The stored record.

/**
 * Checks a stored series and everything it stands on.
 * Its address fields must be the address it was found at, its attempts must be attempts held in canonical form, and
 * every DERIVED field — each verdict, the count and the stop — is derived again here and compared: a record that
 * merely agrees with itself is not a history this unit ever wrote. Its inherited attempts are derived again from the
 * predecessor read at the EXACT reference it names, and that predecessor is checked the same way, down the line to
 * the first. The line of a predecessor is one less than its successor's, so the lineage ends at line 1 and cannot
 * close on itself.
 */
function checkSeries(store: Store, value: unknown, address: Address, context: Context): OmResult<never> | null {
  if (!isPlainObject(value) || !exactKeys(value, SERIES_KEYS)) {
    return problem("series_invalid", "A series carries its address, its history of attempts and what follows from them, and nothing else", context, "value");
  }
  const series = value as Record<string, unknown>;
  if (!isText(series['projectId']) || !isText(series['block']) || !Number.isSafeInteger(series['line'])) {
    return problem("series_invalid", "A series names the project, block and line it belongs to", context, "projectId");
  }
  // A series of another block, project or line standing at this address is not this series, however well it reads.
  if (series['projectId'] !== address.project || series['block'] !== address.block || series['line'] !== address.line) {
    return problem("series_foreign", `A series of ${String(series['block'])} in ${String(series['projectId'])} cannot stand for ${address.id}`, context, "block");
  }
  if (!isText(series['slice'])) return problem("series_invalid", "A series names the slice of the horizon it belongs to", context, "slice");
  const predecessor = series['predecessor'];
  if (predecessor !== null && !isRef(predecessor)) {
    return problem("series_invalid", "A series names its predecessor by an exact reference, or null when it opens the first line", context, "predecessor");
  }
  if ((address.line === 1) !== (predecessor === null)) {
    return problem("series_invalid", "Only the first line of a series has no predecessor", context, "predecessor");
  }
  const basis = series['basis'];
  const grounded = predecessor === null
    ? basis === null
    : isPlainObject(basis) && exactKeys(basis, BASIS_KEYS) && basisProblem(basis) === null;
  if (!grounded) {
    return problem("series_invalid", "A successor of a series carries the recorded ground it stands on, and a first line carries none", context, "basis");
  }
  const inherited = series['inherited'];
  const attempts = series['attempts'];
  if (!Array.isArray(inherited) || !Array.isArray(attempts)) {
    return problem("series_invalid", "A series carries its inherited history and its own attempts, each explicitly empty when there is none", context, "attempts");
  }
  const all = [...inherited, ...attempts];
  for (let index = 0; index < all.length; index += 1) {
    const path = index < inherited.length ? `inherited.${index}` : `attempts.${index - inherited.length}`;
    const found = checkAttempt(all[index], index + 1, context, path);
    if (found) return found;
  }
  // Only the last attempt may still be running: a second open cycle would leave two histories in one series.
  if (all.some((item, index) => (item as Attempt).outcome === null && index !== all.length - 1)) {
    return problem("series_invalid", "Only the last attempt of a series may still be running", context, "attempts");
  }
  if (inherited.some(item => (item as Attempt).outcome === null)) {
    return problem("series_invalid", "An inherited attempt was completed in the series it was begun in", context, "inherited");
  }
  const continuations = series['continuations'];
  if (!Array.isArray(continuations)) {
    return problem("series_invalid", "A series carries its recorded continuations, explicitly empty until a stop was continued", context, "continuations");
  }
  let last = inherited.length;
  for (let index = 0; index < continuations.length; index += 1) {
    const item = continuations[index];
    if (!isPlainObject(item) || !exactKeys(item, CONTINUATION_KEYS) || basisProblem(item) !== null) {
      return problem("series_invalid", "A continuation names the recorded ground it stands on and the attempt it follows", context, `continuations.${index}`);
    }
    // A continuation of THIS series follows one of its own attempts; stops are answered in the order they were saved.
    const after = (item as Record<string, unknown>)['after'];
    if (!Number.isSafeInteger(after) || Number(after) <= last || Number(after) > all.length) {
      return problem("series_invalid", "A continuation follows one attempt of this series, and one attempt is continued once", context, `continuations.${index}.after`);
    }
    last = Number(after);
  }

  const draft = plainSeries(series as unknown as RepairSeries);
  if (predecessor !== null) {
    const at = seriesId(address.project, address.block, address.line - 1);
    const read = readRecord<RepairSeries>(store, predecessor, { unit: UNIT, target: address.id, kind: REPAIR_SERIES_KIND, id: at });
    if (!read.ok) {
      return problem("series_invalid", `The predecessor a series names is not a series of this block: ${read.refusal.code}`, context, "predecessor");
    }
    const broken = checkSeries(store, read.value.value, { ...address, line: address.line - 1, id: at }, context);
    if (broken) return broken;
    // T3: the inherited history is derived AGAIN from the predecessor at the revision it names, so a predecessor that
    // has since moved on does not make this record false, and a rewritten history is not taken for an inherited one.
    const handedDown = [...read.value.value.inherited, ...read.value.value.attempts].map(copyAttempt);
    if (hashJson(handedDown) !== hashJson(draft.inherited)) {
      return problem("series_invalid", "The inherited history is not the history its predecessor holds", context, "inherited");
    }
    if (read.value.value.slice === draft.slice) {
      return problem("series_invalid", "A successor stands on a slice its predecessor did not hold", context, "slice");
    }
  }

  const derived = walk(draft);
  if (derived.stray) {
    return problem("series_invalid", "A continuation stands where no stop was saved", context, "continuations");
  }
  for (const attempt of [...draft.inherited, ...draft.attempts]) {
    if ((derived.verdicts.get(attempt.ordinal) ?? null) !== attempt.verdict) {
      return problem("series_invalid", "An attempt does not hold the verdict its outcome and the history of its goal give it", context, `attempts.${attempt.ordinal}.verdict`);
    }
  }
  if (series['withoutProgress'] !== derived.withoutProgress) {
    return problem("series_invalid", "The count of attempts without progress is not the count its attempts give", context, "withoutProgress");
  }
  if (hashJson(series['stop'] ?? null) !== hashJson(derived.stop)) {
    return problem("series_invalid", "The saved stop is not the stop its attempts give", context, "stop");
  }
  return null;
}

function checkAttempt(value: unknown, ordinal: number, context: Context, path: string): OmResult<never> | null {
  if (!isPlainObject(value) || !exactKeys(value, ATTEMPT_KEYS)) {
    return problem("series_invalid", "An attempt carries its ordinal, its goal, its outcome and the verdict derived from them", context, path);
  }
  const attempt = value as Record<string, unknown>;
  // Ordinals run on without gaps across the whole lineage, so the attempt a stop or a continuation names is one attempt.
  if (attempt['ordinal'] !== ordinal) {
    return problem("series_invalid", `An attempt at position ${ordinal} carries the ordinal ${String(attempt['ordinal'])}`, context, `${path}.ordinal`);
  }
  const goal = goalProblem(attempt['goal']);
  if (goal) return problem("series_invalid", "An attempt names the goal it was begun for", context, `${path}.goal.${goal}`);
  // An unordered set held out of canonical order is not the goal or the outcome this unit writes: two readings of one
  // fact would then differ, and a repeat of it would look like a contradiction.
  if (hashJson(goalOf(attempt['goal'] as AttemptGoal)) !== hashJson(attempt['goal'])) {
    return problem("series_invalid", "A goal is not held as this unit writes one", context, `${path}.goal`);
  }
  if (attempt['outcome'] === null) {
    return attempt['verdict'] === null ? null
      : problem("series_invalid", "An attempt still running carries no verdict", context, `${path}.verdict`);
  }
  const outcome = outcomeProblem(attempt['outcome'], STORED_REFUSAL_KEYS);
  if (outcome) return problem("series_invalid", "An attempt holds the outcome of the cycle it closed", context, `${path}.${outcome}`);
  if (hashJson(outcomeOf(attempt['outcome'] as AttemptOutcome)) !== hashJson(attempt['outcome'])) {
    return problem("series_invalid", "An outcome is not held as this unit writes one", context, `${path}.outcome`);
  }
  if (!ATTEMPT_VERDICTS.includes(attempt['verdict'] as AttemptVerdict)) {
    return problem("series_invalid", "A completed attempt carries the verdict derived from its outcome", context, `${path}.verdict`);
  }
  const contradiction = outcomeContradiction(attempt['outcome'] as AttemptOutcome);
  return contradiction ? problem("series_invalid", contradiction, context, `${path}.outcome`) : null;
}

// Own keys only, and exactly these: a value parsed from JSON may carry "__proto__" as an own field, and an unexpected
// field is a difference in content, not a detail to ignore.
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  const own = Object.keys(value as object);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value as object, key));
}

// A refusal of this unit goes back to whoever produced what it read: the series rules on the history it keeps and on
// nothing else, and switches nothing by refusing (T8).
function problem(code: SeriesCode, message: string, context: Context, field: string): OmResult<never> {
  return refused(code, message, { unit: UNIT, target: context.target, field, ref: context.ref }, "producer");
}

function requireStore(store: unknown): asserts store is Store {
  requireCondition(store instanceof Store, "series_request_invalid", "A series is read and written through a store");
}

function requireAddress(request: SeriesRequest): Address {
  const id = seriesId(request.project, request.block, request.line);
  return { project: request.project, block: request.block, line: request.line, id };
}

function requireProject(project: unknown): string {
  requireCondition(typeof project === "string" && project.length > 0, "series_request_invalid", "A series is kept for a project");
  // ':' separates namespaces inside an id: a project carrying one would address another project's records.
  requireCondition(!project.includes(":"), "series_request_invalid", "A project name carries no ':' namespace separator");
  // A refusal of a cycle is kept as a link into the project's journal, so a project whose journal cannot be addressed
  // cannot hold a series either.
  requireCondition(project.length + REFUSAL_JOURNAL_KIND.length + 1 <= MAX_ENTITY_ID,
    "series_request_invalid", "A project name that overflows an entity id cannot be repaired");
  return project;
}

function requireBlock(block: unknown): string {
  requireCondition(typeof block === "string" && block.length > 0, "series_request_invalid", "A series is kept for a block");
  return block;
}

function requireLine(line: unknown): number {
  requireCondition(Number.isSafeInteger(line) && Number(line) >= 1,
    "series_request_invalid", "A series stands on a line of its own, counted from one");
  return line as number;
}
