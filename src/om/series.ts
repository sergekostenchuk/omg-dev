import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, sealed, type OmResult, type RefusalRoute, type Sealed } from "./refusal.js";
import { readRecord, writeGuarded, type RefsRefusalCode } from "./refs.js";
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
 * The count of consecutive attempts without progress, the verdict of every attempt, the saved stop and the LADDER the
 * series stands on after one are DERIVED from the attempts, the continuations and the escalations, and re-derived
 * whenever the record is read: a stored count, verdict or rung that does not follow from them is refused instead of
 * believed. There is no limit on the NUMBER of attempts. The third consecutive attempt without progress IN THE WINDOW
 * NOW OPEN saves a stop with its cause and the point to continue from; a restart does not lift it, and only a ground
 * of the rung the ladder has reached continues the work: while the first rung stands, the recorded review of THIS stop
 * with an independent reviewer or a confirmed fix of the input; once that rung has been spent — by a continuation that
 * gave no new accepted result of the goal, or by a review that ended without a decision and escalated the stop — the
 * owner's decision alone. A continuation opens a NEW WINDOW — up to three attempts without progress again — and is
 * not itself progress; an escalation opens none and leaves the stop standing. Only a new accepted result of the goal
 * the ladder stands for returns it to the start, and the ladder outlives a successor of the series, a change of slice
 * and a return to an earlier subject.
 * EVERY change of state names the state it comes from: the attempt a request opens, the outcome it closes, the stop
 * it continues or escalates and the predecessor it succeeds. A delivery that arrives late finds its own state already
 * there and changes nothing (T5), instead of landing on whatever state the series has reached since.
 */
const UNIT = "store-repairs";
const MAX_ENTITY_ID = 200; // the store's own limit on an entity id (src/storage/store.ts)
const STOP_AFTER = 3; // the third consecutive attempt without progress in the open window stops (model calls, G7)

export const REPAIR_SERIES_KIND = "repair-series";

/**
 * The records the three grounds are made of. All are written by later units — the review of a stop by A6, the
 * confirmation of a repeated addressed check by B1 and A4, the owner's decision by the command API of H2 — and this
 * unit only READS them, at the exact reference a request names and inside this project's namespace. What it weighs is
 * what it can weigh from its own history, and the three are tied to that history differently. The review and the
 * owner's decision name the stop itself — its attempt and the goals it was raised for — and are compared with the stop
 * derived from the attempts. The fixed input names no stop: it is tied through the refusal the attempts of THIS stop
 * ran into, the input that refusal stood on, and the confirmation of a later revision of that same input.
 * Whether the reviewer was independent, whether the re-check really passed and whether the decision really came from
 * the owner are established by the unit whose duty that is; a field of a record declaring any of them would be a
 * verdict handed to a consumer to trust. What a ground may NOT do is stand on a sentence alone: T1 — what was decided
 * is read from a record, not taken on the word of whoever is asking.
 *
 * A review says how it ENDED, and says it in its own content rather than in a status beside it: a cause (or a named
 * hypothesis) and a change are each either said, or explicitly null — null cause, "the reviewer could not name one";
 * null change, "the review found no usable change". Said and said is a review that decided something, and it is a
 * ground to continue. Either one null is a review that ENDED WITHOUT A DECISION, and the rules send that stop to the
 * owner: it is a ground to escalate, never to continue. Anything else — a key left out, an empty text, an empty
 * structure — is not an outcome at all but a broken record, and it moves nothing. A failed call or an off-form answer
 * leaves no record of a review, and the series does nothing about it: recovering the same call is A6's.
 */
export const STOP_REVIEW_KIND = "om-stop-review";
export const INPUT_FIX_KIND = "om-input-fix";
export const OWNER_DECISION_KIND = "om-owner-decision";

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

/**
 * The grounds on which stopped work continues, and the only ones (owner's decision of 21.09.2026).
 * "The approach has changed", written by the executor's own hand, is not among them any more: it lifted a stop without
 * anyone outside the circling cycle having looked at it. Each of the three that are left stands on a record somebody
 * else wrote — the review of this stop, the confirmation of a fixed input, the decision of the owner — because a
 * ground that stood on a sentence would be that same hand under another name.
 */
export const CONTINUATION_GROUNDS = Object.freeze(["inputs-fixed", "owner-decision", "review-record"] as const);
export type ContinuationGround = typeof CONTINUATION_GROUNDS[number];

// The ladder admits the owner at every rung, and the two grounds of the first rung only while that rung stands.
const OWNER_ONLY = Object.freeze(["owner-decision"] as const);
const FIRST_RUNG = 1;
const OWNER_RUNG = 2;
const groundsOf = (rung: number): readonly ContinuationGround[] => (rung === FIRST_RUNG ? CONTINUATION_GROUNDS : OWNER_ONLY);

// Why a SUCCESSOR of a series was opened. A slice that moved is a ground to open one and carry the history over; it
// is not a ground to continue a stopped series, and one change of horizon moves no rung of the ladder.
export const SUCCESSION_GROUNDS = Object.freeze(["inputs-changed"] as const);
export type SuccessionGround = typeof SUCCESSION_GROUNDS[number];

// Every refusal this unit can produce. The list is the checklist its test walks, so a new code cannot arrive untested.
export const SERIES_CODES = Object.freeze([
  "series_conflict", "series_missing", "series_invalid", "series_foreign", "slice_unchanged",
  "attempt_running", "attempt_unknown", "attempt_conflict", "outcome_conflict", "outcome_invalid",
  "basis_unresolved", "cancelled_unknown", "refusal_unlinked",
  "series_stopped", "stop_absent", "continuation_conflict",
  "owner_required", "review_unusable", "input_unfixed", "decision_unusable", "escalation_conflict",
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

/** The recorded ground a SUCCESSOR of a series stands on: the slice of the horizon it was opened for moved. */
export interface SeriesBasis {
  readonly ground: SuccessionGround;
  readonly text: string;
}

/**
 * A ground to continue a stopped series, with the records it is made of.
 * The text is what the owner reads; the references are what the series weighs. A ground carries exactly the records
 * ITS rule names — a review names one record, a fixed input names the refusal that stood, the input the attempts ran
 * with and the confirmation of the repeated check, a decision of the owner names the record that decision was taken
 * in — so a ground can neither be given without them nor pad itself out with references nothing looks at.
 */
export interface ReviewContinuation {
  readonly ground: "review-record";
  readonly text: string;
  readonly review: Ref;
}
export interface InputsContinuation {
  readonly ground: "inputs-fixed";
  readonly text: string;
  readonly refusal: string;
  readonly input: Ref;
  readonly confirmation: Ref;
}
export interface OwnerContinuation {
  readonly ground: "owner-decision";
  readonly text: string;
  readonly decision: Ref;
}
export type ContinuationBasis = ReviewContinuation | InputsContinuation | OwnerContinuation;
export type Continuation = ContinuationBasis & { readonly after: number };

/**
 * A stop sent to the owner because its review ENDED WITHOUT A DECISION: the stop it answers and the exact review that
 * says so. It lifts nothing and opens no window — the stop stays saved, and only the owner's decision continues it.
 */
export interface Escalation {
  readonly after: number;
  readonly review: Ref;
}

export interface SeriesStop {
  readonly attempt: number;
  readonly attempts: readonly number[];
  readonly goals: readonly string[];
  readonly reason: string;
  readonly resume: string;
}

/**
 * Where the series stands on the ladder after a stop, derived from its history like the count and the stop itself.
 * `rung` is the rung the NEXT continuation has to satisfy, `goals` the goals of the stop the ladder began at — the
 * original goal a new accepted result of which returns it to the start — `windows` the stops already continued, each
 * of which opened a window of its own, and `grounds` what a continuation may stand on now, so that a consumer reads
 * the requirement instead of deriving the ladder again for itself.
 */
export interface SeriesLadder {
  readonly rung: number;
  readonly goals: readonly string[];
  readonly windows: readonly number[];
  readonly grounds: readonly ContinuationGround[];
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
  readonly escalations: readonly Escalation[];
  readonly withoutProgress: number;
  readonly ladder: SeriesLadder;
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
/**
 * The record a ground stands on, in one of the two ways a neighbour can hand it over — never both, never neither.
 * `ref` names a record ALREADY STORED, at its exact reference. `pending` is the record the neighbour writes IN THIS
 * SAME TRANSACTION (A6 writing a review and escalating on it, H2 writing the owner's decision and continuing on it):
 * the store offers no outer transaction, so a ground written on its own first would stand in the store while the
 * series still allowed what that ground forbids. The content of the record is weighed by the same function either
 * way; only where the value comes from differs, and the series keeps the exact reference in both cases.
 */
export interface PendingRecord {
  readonly id: string;
  readonly kind: string;
  readonly value: Json;
}
export type GroundRecord =
  | { readonly ref: Ref; readonly pending?: never }
  | { readonly pending: PendingRecord; readonly ref?: never };

/** The ground a continuation is ASKED for with: the records it stands on, each already stored or written with it. */
export interface ReviewGround {
  readonly ground: "review-record";
  readonly text: string;
  readonly review: GroundRecord;
}
export interface InputsGround {
  readonly ground: "inputs-fixed";
  readonly text: string;
  readonly refusal: string;
  readonly input: Ref;
  readonly confirmation: GroundRecord;
}
export interface OwnerGround {
  readonly ground: "owner-decision";
  readonly text: string;
  readonly decision: GroundRecord;
}
export type ContinuationRequest = ReviewGround | InputsGround | OwnerGround;

/** The stop is part of the request: a late continuation finds the stop it was given for, and never lifts a later one. */
export type ResumeSeriesRequest = SeriesRequest & ContinuationRequest & { readonly stop: number };
/** Names the stop it escalates and the review that ended without a decision, so a late repeat finds its own. */
export interface EscalateSeriesRequest extends SeriesRequest {
  readonly stop: number;
  readonly review: GroundRecord;
}

/**
 * One prepared change: the records to write, the exact references they must be guarded by, and what the series would
 * hold afterwards. The series itself is always the FIRST write; a ground handed over as `pending` is the second, so
 * the ground and the change it grounds commit together or not at all. `writes` is empty when the series already holds
 * this change — a repeat needs no revision, and adds nothing to anyone's transaction.
 * A caller that has to write SEVERAL records at once (B3 applying the transition of many series together with its own
 * record of the transition, A6 writing a review and escalating on it) puts these writes and guards into one
 * writeGuarded of its own, so that either all of them are applied, or none is.
 */
export interface PreparedWrite {
  readonly id: string;
  readonly kind: string;
  readonly expected: number;
  readonly value: unknown;
}
export interface SeriesTransition {
  readonly writes: readonly PreparedWrite[];
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
const REVIEW_GROUND_KEYS = Object.freeze([...BASIS_KEYS, "review"] as const);
const INPUTS_GROUND_KEYS = Object.freeze([...BASIS_KEYS, "refusal", "input", "confirmation"] as const);
const OWNER_GROUND_KEYS = Object.freeze([...BASIS_KEYS, "decision"] as const);
const groundKeys = (ground: ContinuationGround): readonly string[] =>
  ground === "review-record" ? REVIEW_GROUND_KEYS : ground === "inputs-fixed" ? INPUTS_GROUND_KEYS : OWNER_GROUND_KEYS;
const SERIES_KEYS = Object.freeze([
  "projectId", "block", "line", "slice", "predecessor", "basis",
  "inherited", "attempts", "continuations", "escalations", "withoutProgress", "ladder", "stop",
] as const);
const ESCALATION_KEYS = Object.freeze(["after", "review"] as const);
const REF_SOURCE_KEYS = Object.freeze(["ref"] as const);
const PENDING_SOURCE_KEYS = Object.freeze(["pending"] as const);
const PENDING_KEYS = Object.freeze(["id", "kind", "value"] as const);

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
 * The namespaces the records of the three grounds are read from.
 * A record of another project cannot be a ground here even if it reads perfectly, so the address is checked before
 * the store is touched; the tail of the id belongs to the unit that writes the record.
 */
export function stopReviewNamespace(project: string): string {
  return `${STOP_REVIEW_KIND}:${requireProject(project)}:`;
}
export function inputFixNamespace(project: string): string {
  return `${INPUT_FIX_KIND}:${requireProject(project)}:`;
}
export function ownerDecisionNamespace(project: string): string {
  return `${OWNER_DECISION_KIND}:${requireProject(project)}:`;
}

/**
 * Opens the series of one block and one slice of the horizon, or its successor when the slice has moved.
 * A successor names its predecessor by an exact reference, carries its whole history — attempts AND the continuations
 * recorded so far — and stands on a recorded ground of its own. The change of the slice is a ground to OPEN it, not a
 * ground to continue: a stop the predecessor saved comes across still standing, the count of attempts without progress
 * comes with it, and the rung of the ladder comes with it too, because one change of horizon moves no rung.
 * A successor at the same slice is refused:
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
 * Continues the series from the stop the request names, on a ground the rung it has reached admits.
 * A restart does not lift a stop and neither does a continuation given for an earlier one: the ground is recorded
 * against the attempt whose stop it answers, so a late repeat finds its own ground already there and leaves a stop
 * saved since then standing. A continuation opens a new window of up to three attempts without progress; it is not
 * itself progress, so it spends the rung it stood on instead of returning the ladder to the start.
 */
export function resumeSeries(store: Store, request: ResumeSeriesRequest): OmResult<Sealed<Revision<RepairSeries>>> {
  return applied(store, prepareResume(store, request));
}

/**
 * Sends the stop the request names to the owner, on the exact record of a review that ended without a decision.
 * The rules put such a stop on the second rung: the stop stays saved, no window opens, and from then on only the
 * owner's decision continues it — a second review of the same stop, however good, and a fixed input no longer do.
 * A6 writes the review and changes no series, so this is the transition that keeps its outcome in the series itself.
 * It applies to its own stop and once: the same request again changes nothing, another review for a stop already
 * escalated is refused, and a stop that no longer stands cannot be escalated at all (T5).
 */
export function escalateSeries(store: Store, request: EscalateSeriesRequest): OmResult<Sealed<Revision<RepairSeries>>> {
  return applied(store, prepareEscalate(store, request));
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
export const prepareEscalateSeries = (store: Store, request: EscalateSeriesRequest): OmResult<Sealed<SeriesTransition>> =>
  handed(prepareEscalate(store, request));

const handed = (prepared: OmResult<Prepared>): OmResult<Sealed<SeriesTransition>> =>
  prepared.ok ? delivered(prepared.value.transition) : prepared;

function applied(store: Store, prepared: OmResult<Prepared>): OmResult<Sealed<Revision<RepairSeries>>> {
  if (!prepared.ok) return prepared;
  const { transition, current } = prepared.value;
  // Nothing to write is a fact, not a failure: the series already holds what was asked for.
  if (transition.writes.length === 0) return delivered(current!);
  // One transaction for the series and the ground it stands on: both commit, or neither does (T7).
  const result = writeGuarded<RepairSeries>(store, {
    unit: UNIT, target: transition.writes[0]!.id, guards: transition.guards, writes: [...transition.writes],
  });
  if (!result.ok) return result;
  return delivered(result.value[0]!);
}

const unchanged = (current: Revision<RepairSeries>): OmResult<Prepared> =>
  ({ ok: true, value: { transition: { writes: [], guards: [], value: current.value }, current } });

function change(
  address: Address, value: RepairSeries, expected: number, guards: readonly Ref[], current: Revision<RepairSeries> | null,
  grounds: readonly PreparedWrite[] = [],
): OmResult<Prepared> {
  const series: PreparedWrite = { id: address.id, kind: REPAIR_SERIES_KIND, expected, value };
  return { ok: true, value: { transition: { writes: [series, ...grounds], guards: [...guards], value }, current } };
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
  let carried: readonly Continuation[] = [];
  let escalated: readonly Escalation[] = [];
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
    // The continuations come across with the attempts: a stop already answered must not come back to life in the
    // successor, and the windows already opened are what the rung of the ladder is derived from.
    carried = earlier.value.continuations.map(plainContinuation);
    // Escalations too: a stop the owner alone may continue stays the owner's across a change of horizon.
    escalated = earlier.value.escalations.map(plainEscalation);
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
    predecessor, basis, inherited, attempts: [], continuations: carried, escalations: escalated,
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
    return problem("series_stopped", `A saved stop stands after attempt ${held.stop.attempt}: ${held.stop.resume}`, context, "stop");
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
  requireCondition(groundProblem(request, isGroundRecord) === null,
    "series_request_invalid", "A continuation names one of the recorded grounds, says what changed, and carries the records that ground is made of — each stored and named by its exact reference, or written with it, never both and never neither");

  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value;
  const context: Context = { target: address.id, ref: reference(head) };
  const held = head.value;

  // Where the record of the ground comes from is settled first, so that its exact reference is known before anything
  // is compared: a late repeat of a continuation whose ground was written with it finds that record stored by now.
  const grounded = groundOf(store, address, request);
  if ("ok" in grounded) return grounded;
  const basis = basisFrom(request, grounded.ref);

  const already = held.continuations.find(item => item.after === request.stop);
  if (already) {
    // T5: the stop this ground was given for is continued already. The same ground again changes nothing, and a
    // different one does not replace it — neither lifts a stop saved since then, because neither is about it.
    if (hashJson(continuationOf(already)) === hashJson(basis)) return unchanged(head);
    return problem("continuation_conflict", `The stop after attempt ${request.stop} is continued already, and a later ground does not replace the earlier one`, context, "ground");
  }
  const stop = held.stop;
  if (stop === null || stop.attempt !== request.stop) {
    return problem("stop_absent", `No saved stop stands after attempt ${request.stop} in this series`, context, "stop");
  }
  // The rung decides what this stop admits, and the ladder was derived from the history when the record was read.
  // A refusal here goes to the OWNER: what is missing is the owner's decision, and nobody else can supply it.
  if (!held.ladder.grounds.includes(basis.ground)) {
    return problem("owner_required",
      `The first rung of the ladder is spent for ${held.ladder.goals.join(", ")}, so only the owner's decision continues the stop after attempt ${request.stop}`,
      context, "ground", "owner");
  }
  const unusable = groundStanding(store, address, basis, grounded.value, held, stop, context);
  if (unusable) return unusable;

  const value = settled({
    ...plainSeries(held),
    continuations: [...held.continuations.map(plainContinuation), { ...basis, after: request.stop }],
  });
  return change(address, value, head.revision, [reference(head)], head, grounded.write === null ? [] : [grounded.write]);
}

function prepareEscalate(store: Store, request: EscalateSeriesRequest): OmResult<Prepared> {
  requireStore(store);
  requireCondition(isPlainObject(request), "series_request_invalid", "A stop is escalated through a request object");
  const address = requireAddress(request);
  requireCondition(Number.isSafeInteger(request.stop) && request.stop >= 1,
    "series_request_invalid", "An escalation names the attempt whose stop it sends to the owner");
  requireCondition(isGroundRecord(request.review),
    "series_request_invalid", "An escalation names the review that ended without a decision — stored and named by its exact reference, or written with it, never both and never neither");

  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value;
  const context: Context = { target: address.id, ref: reference(head) };
  const held = head.value;

  const grounded = locate(store, address, request.review, STOP_REVIEW_KIND, stopReviewNamespace(address.project), "review");
  if ("ok" in grounded) return grounded;
  const escalation: Escalation = { after: request.stop, review: exactRef(grounded.ref) };

  const already = held.escalations.find(item => item.after === request.stop);
  if (already) {
    // T5: this stop was sent to the owner already. The same review again is the same request delivered twice; another
    // review does not replace the one it was escalated on — neither is applied a second time.
    if (sameRef(already.review, escalation.review)) return unchanged(head);
    return problem("escalation_conflict", `The stop after attempt ${request.stop} was sent to the owner on another review already, and a later review does not replace it`, context, "review");
  }
  const stop = held.stop;
  if (stop === null || stop.attempt !== request.stop) {
    return problem("stop_absent", `No saved stop stands after attempt ${request.stop} in this series`, context, "stop");
  }
  // At the second rung no review is called and there is nothing left to escalate: the stop is the owner's already.
  if (held.ladder.rung !== FIRST_RUNG) {
    return problem("owner_required", `The stop after attempt ${request.stop} already waits for the owner's decision, and a review has nothing to send on`, context, "stop", "owner");
  }
  const unusable = weighReview(grounded.value, address, stop, context, "undecided");
  if (unusable) return unusable;

  const value = settled({ ...plainSeries(held), escalations: [...held.escalations.map(plainEscalation), escalation] });
  return change(address, value, head.revision, [reference(head)], head, grounded.write === null ? [] : [grounded.write]);
}

/** Where a record of a ground comes from, what it holds, and — when it is written with this change — its write. */
interface Located {
  readonly ref: Ref;
  readonly value: unknown;
  readonly write: PreparedWrite | null;
}

/** The record the request's own ground stands on: the review, the confirmation of the fix, or the owner's decision. */
function groundOf(store: Store, address: Address, request: ContinuationRequest): OmResult<never> | Located {
  if (request.ground === "review-record") {
    return locate(store, address, request.review, STOP_REVIEW_KIND, stopReviewNamespace(address.project), "review");
  }
  if (request.ground === "inputs-fixed") {
    return locate(store, address, request.confirmation, INPUT_FIX_KIND, inputFixNamespace(address.project), "confirmation");
  }
  return locate(store, address, request.decision, OWNER_DECISION_KIND, ownerDecisionNamespace(address.project), "decision");
}

/**
 * Settles where the record of a ground comes from, and nothing else — its CONTENT is weighed afterwards by one function
 * whichever way it came.
 * A stored record is read at its exact reference inside this project's namespace, as A1 reads any record. A record
 * written with this change is held to the same address rules BEFORE the store is touched — this namespace, this kind —
 * and its exact reference is computed as the store will make it: the first revision of its id, with the hash of its
 * content. One copy of that content is taken here, and it is the copy that is weighed, referenced and written, so no
 * caller can change between the check and the write what the series stands on.
 * An id already standing is not overwritten. Holding this very record, it IS this record — stored by the transaction
 * this request repeats, or by its writer on its own — and is taken like any stored one; holding anything else, it is a
 * revision conflict, the same refusal the store gives when another record takes the id between this preparation and
 * the write (T5, T7).
 */
function locate(
  store: Store, address: Address, source: GroundRecord, kind: string, namespace: string, field: string,
): OmResult<never> | Located {
  if (source.ref !== undefined) {
    const read = readRecord<Json>(store, source.ref, { unit: UNIT, target: address.id, kind, idPrefix: namespace });
    if (!read.ok) return read;
    return { ref: reference(read.value), value: read.value.value, write: null };
  }
  const pending = source.pending;
  if (!pending.id.startsWith(namespace)) {
    return asRecord("record_foreign", `A record at ${pending.id} lies outside ${namespace}`, address, `${field}.pending.id`);
  }
  if (pending.kind !== kind) {
    return asRecord("record_foreign", `A ${pending.kind} record cannot stand for a ${kind} record`, address, `${field}.pending.kind`);
  }
  const value = sealed(pending.value);
  const hash = hashJson(value);
  const standing = store.get(pending.id);
  if (standing === null) {
    return { ref: { id: pending.id, revision: 1, hash }, value, write: { id: pending.id, kind, expected: 0, value } };
  }
  if (standing.kind === kind && standing.hash === hash) return { ref: reference(standing), value: standing.value, write: null };
  return asRecord("revision_conflict", `Another record already stands at ${pending.id}, and a record written with this change is the first revision of its id`,
    address, `${field}.pending.id`, reference(standing));
}

// A record handed over to be written is refused with the codes A1 gives a stored record for the same defect, so that
// one fact reads alike whichever way the record came.
function asRecord(code: RefsRefusalCode, message: string, address: Address, field: string, ref?: Ref): OmResult<never> {
  return refused(code, message, { unit: UNIT, target: address.id, field, ref }, "producer");
}

function basisFrom(request: ContinuationRequest, ref: Ref): ContinuationBasis {
  if (request.ground === "review-record") return { ground: request.ground, text: request.text, review: exactRef(ref) };
  if (request.ground === "inputs-fixed") {
    return {
      ground: request.ground, text: request.text, refusal: request.refusal,
      input: exactRef(request.input), confirmation: exactRef(ref),
    };
  }
  return { ground: request.ground, text: request.text, decision: exactRef(ref) };
}

/** Weighs the content of a ground's record against the history this series holds, whichever way the record came. */
function groundStanding(
  store: Store, address: Address, basis: ContinuationBasis, value: unknown, held: RepairSeries, stop: SeriesStop, context: Context,
): OmResult<never> | null {
  if (basis.ground === "review-record") return weighReview(value, address, stop, context, "decided");
  if (basis.ground === "inputs-fixed") return weighFix(store, address, basis, value, held, stop, context);
  return weighDecision(value, address, stop, context);
}

/**
 * The one question the records of a review and of an owner's decision share: is this about THIS lineage and THIS
 * stop, with THE GOALS the stop was raised for? (A fixed input names no stop and is tied to it otherwise — see
 * weighFix.) The stop and the goals are derived here from the attempts, never read out of the record, so a record about
 * another stop, one that arrived late for a stop continued long since and one delivered twice all fail on the
 * comparison (T3, T5) — and no field a record carries about itself, "accepted", "independent" or "lifts any stop", is
 * consulted.
 */
function aboutStop(value: unknown, address: Address, stop: SeriesStop): { readonly value: Record<string, unknown> } | { readonly field: string } {
  if (!isPlainObject(value)) return { field: "" };
  const record = value as Record<string, unknown>;
  if (record['projectId'] !== address.project || record['block'] !== address.block) return { field: ".block" };
  if (record['stop'] !== stop.attempt) return { field: ".stop" };
  const goals = record['goals'];
  if (!Array.isArray(goals) || goals.length === 0 || !goals.every(isText)) return { field: ".goals" };
  // T6: the goals are an unordered set on both sides, so both are put in one order before they are compared.
  if (hashJson(ordered(goals as string[], key => key)) !== hashJson(ordered([...stop.goals], key => key))) {
    return { field: ".goals" };
  }
  return { value: record };
}

const notAbout = (field: string): string =>
  field === ".block" ? "is about another block"
    : field === ".stop" ? "is about another stop"
      : field === ".goals" ? "is about another goal" : "is not a record of a stop at all";

type ReviewEnd = "decided" | "undecided";

/**
 * How a review ended, read from what it says rather than from a status beside it (see STOP_REVIEW_KIND).
 * A cause and a change are each said or explicitly null; a key left out, an empty text or an empty structure is a
 * broken record, which is no outcome at all. A status field would be a second truth free to contradict the content.
 */
function reviewEnd(review: Record<string, unknown>): { readonly end: ReviewEnd } | { readonly field: string } {
  const cause = review['cause'];
  const change = review['change'];
  if (cause !== null && !said(cause)) return { field: "review.cause" };
  if (change !== null && !said(change)) return { field: "review.change" };
  return { end: cause === null || change === null ? "undecided" : "decided" };
}

/**
 * The review of a stop, weighed for what the request wants of it.
 * A review that decided — a cause and a change — continues the stop; a review that ended without a decision sends it
 * to the owner and continues nothing. Each is refused on the other's path, so that no review is read as the outcome
 * it did not have. The independence of the reviewer and the worth of the cause are A6's to establish.
 */
function weighReview(value: unknown, address: Address, stop: SeriesStop, context: Context, wanted: ReviewEnd): OmResult<never> | null {
  const found = aboutStop(value, address, stop);
  if ("field" in found) {
    return problem("review_unusable", `A review that ${notAbout(found.field)} is no ground for this stop`, context, `review${found.field}`);
  }
  const ended = reviewEnd(found.value);
  if ("field" in ended) {
    return problem("review_unusable", "A review says its cause and its change, each explicitly null when there is none; a part left out or left empty is a broken record, not an outcome", context, ended.field);
  }
  if (ended.end === wanted) return null;
  if (wanted === "decided") {
    return problem("review_unusable",
      `This review ended without a decision, so it continues nothing: escalateSeries sends the stop after attempt ${stop.attempt} to the owner on it`,
      context, found.value['change'] === null ? "review.change" : "review.cause");
  }
  return problem("review_unusable",
    `This review found a cause and a change, so it escalates nothing: it continues the stop after attempt ${stop.attempt} through resumeSeries`,
    context, "review.change");
}

/**
 * The decision of the owner.
 * The owner decides through the command API (H2), which writes the decision down — before this change, or with it; this
 * unit weighs that record like the others. A ground standing on a sentence alone would let any code that can call this
 * function walk the series past the rung where only the owner may decide — the executor's own hand under another name —
 * and T1 says what was decided is read from a record. WHO decided and how their action was authenticated is the command
 * API's to answer: this unit reads no field claiming it, and refuses towards the owner when the record does not hold.
 */
function weighDecision(value: unknown, address: Address, stop: SeriesStop, context: Context): OmResult<never> | null {
  const found = aboutStop(value, address, stop);
  if ("field" in found) {
    return problem("decision_unusable", `A decision that ${notAbout(found.field)} does not continue this stop`, context, `decision${found.field}`, "owner");
  }
  if (!isText(found.value['decided'])) {
    return problem("decision_unusable", "A record that says nothing the owner decided is no ground to continue", context, "decision.decided", "owner");
  }
  return null;
}

/**
 * A fixed input, weighed against the refusal it is supposed to have fixed. It names no stop: it is tied to this one
 * through the refusal the attempts of THIS stop ran into.
 * The refusal is a row of THIS project's journal (A2), and one the attempts this stop was raised for really ran into;
 * the input is one of the exact records that refusal was weighed against, which its origin holds; and the confirmation
 * of the repeated addressed check names that same refusal and a LATER revision of that same record, whose content
 * really differs. A new id, a new revision holding the same content, or a confirmation about something else is no fix.
 * The confirmation may be written with this change; the revision it confirms may not — a check is run on a revision
 * that stands, so that revision is read from the store. Whether the change was the one the refusal called for is what
 * the repeated ADDRESSED check establishes, and its record is read here, not re-run.
 */
function weighFix(
  store: Store, address: Address, basis: InputsContinuation, value: unknown, held: RepairSeries, stop: SeriesStop, context: Context,
): OmResult<never> | null {
  const journal = readJournal(store, { project: address.project });
  if (!journal.ok) {
    return problem("refusal_unlinked", `This project holds no journal a refusal could stand in: ${journal.refusal.code}`, context, "refusal");
  }
  const row = journal.value.value.rows.find(item => item.id === basis.refusal);
  if (!row) {
    return problem("refusal_unlinked", "No refusal stands in the journal of this project under that row", context, "refusal");
  }
  const attempts = new Map([...held.inherited, ...held.attempts].map(item => [item.ordinal, item]));
  const met = stop.attempts.some(ordinal =>
    (attempts.get(ordinal)?.outcome?.refusals ?? []).some(item => item.row === basis.refusal));
  if (!met) {
    return problem("input_unfixed", "The attempts this stop was raised for did not run into that refusal", context, "refusal");
  }
  if (!row.origin.sources.some(item => sameRef(item.ref, basis.input))) {
    return problem("input_unfixed", "That refusal did not stand on the input the continuation names", context, "input");
  }
  if (!isPlainObject(value)) {
    return problem("input_unfixed", "A confirmation carries the refusal it re-checked and the revision of the input it re-checked", context, "confirmation");
  }
  const confirmation = value as Record<string, unknown>;
  if (confirmation['refusal'] !== basis.refusal) {
    return problem("input_unfixed", "The confirmation re-checked another refusal", context, "confirmation.refusal");
  }
  const fixed = confirmation['input'];
  if (!isRef(fixed)) {
    return problem("input_unfixed", "A confirmation names the exact revision of the input it re-checked", context, "confirmation.input");
  }
  if (fixed.id !== basis.input.id) {
    return problem("input_unfixed", "A record of another id is no fix of the input the attempts ran with", context, "confirmation.input");
  }
  if (fixed.revision <= basis.input.revision) {
    return problem("input_unfixed", "A confirmation of a revision no later than the one the attempts ran with fixes nothing", context, "confirmation.input");
  }
  const found = store.get(fixed.id, fixed.revision);
  if (!found || found.hash !== fixed.hash) {
    return problem("input_unfixed", "The confirmation names a revision of the input that does not stand at that exact reference", context, "confirmation.input");
  }
  if (found.hash === basis.input.hash) {
    return problem("input_unfixed", "A new revision holding the very data the refusal stood on is no fix of it", context, "confirmation.input");
  }
  return null;
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
// What the series derives for itself: the verdict of every attempt, the count, the saved stop and the ladder.

interface Walk {
  readonly verdicts: ReadonlyMap<number, AttemptVerdict>;
  readonly achieved: ReadonlyMap<string, ReadonlySet<string>>;
  readonly withoutProgress: number;
  readonly ladder: SeriesLadder;
  readonly stop: SeriesStop | null;
  readonly flaw: { readonly field: string; readonly message: string } | null;
}

type SeriesDraft = Omit<RepairSeries, "withoutProgress" | "ladder" | "stop">;

// A ladder is built here rather than shared: what is written holds no object of a policy table (T11).
const ladderAt = (rung: number, goals: readonly string[], windows: readonly number[]): SeriesLadder =>
  ({ rung, goals: [...goals], windows: [...windows], grounds: [...groundsOf(rung)] });
const ladderStart = (): SeriesLadder => ladderAt(FIRST_RUNG, [], []);
// A continuation spends the rung it stood on: the next stop of the same goal is the owner's, and the ladder never
// climbs back down to the reviewer. The goals it stands for are those of the stop that began it — the original goal.
const climbed = (ladder: SeriesLadder, stop: SeriesStop): SeriesLadder =>
  ladderAt(OWNER_RUNG, ladder.goals.length > 0 ? ladder.goals : stop.goals, [...ladder.windows, stop.attempt]);
// A review that ended without a decision spends the first rung too, but it opens nothing: the ladder stands at the
// owner's rung for the goals of the stop, and the list of windows stays what it was.
const sentToOwner = (ladder: SeriesLadder, stop: SeriesStop): SeriesLadder =>
  ladderAt(OWNER_RUNG, ladder.goals.length > 0 ? ladder.goals : stop.goals, ladder.windows);

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
  const raises = new Map(value.escalations.map(item => [item.after, item]));
  const raised = new Set<number>();
  let withoutProgress = 0;
  let stop: SeriesStop | null = null;
  let ladder = ladderStart();
  let flaw: { readonly field: string; readonly message: string } | null = null;
  let run: { ordinals: number[]; goals: string[] } = { ordinals: [], goals: [] };
  // A window is the run of attempts a stop is counted in. One opens at the start, at every new accepted result, and
  // at every recorded continuation — that is what "again up to three attempts" is made of.
  const opened = (): void => { withoutProgress = 0; run = { ordinals: [], goals: [] }; };

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
      opened();
      // Only a new accepted result of the goal the ladder stands for returns it to the start; a result of another
      // goal opens a window, as any progress does, but leaves the rung where it was.
      if (ladder.goals.includes(attempt.goal.key)) ladder = ladderStart();
    } else if (verdict !== "neutral") {
      withoutProgress += 1;
      run.ordinals.push(attempt.ordinal);
      if (!run.goals.includes(attempt.goal.key)) run.goals.push(attempt.goal.key);
      if (withoutProgress >= STOP_AFTER && stop === null) stop = stopOf(attempt, run.ordinals, run.goals, ladder);
    }
    // An escalation answers the stop of this attempt BEFORE any continuation of it: the owner decides on a stop
    // that was escalated to them, never the other way round.
    if (raises.has(attempt.ordinal)) {
      raised.add(attempt.ordinal);
      if (stop === null || ladder.rung !== FIRST_RUNG) flaw ??= { field: "escalations", message: "An escalation stands where no stop of the first rung was saved" };
      else {
        // The stop STAYS, the count stays and no window opens: only the rung, and what the stop now asks for, move.
        ladder = sentToOwner(ladder, stop);
        stop = { ...stop, attempts: [...stop.attempts], goals: [...stop.goals], resume: resumeOf(stop.attempt, ladder) };
      }
    }
    const lift = lifts.get(attempt.ordinal);
    if (lift) {
      used.add(attempt.ordinal);
      // A continuation standing where no stop was raised, or on a ground the rung it answers does not admit, is a
      // ground for nothing; the record is refused, not read.
      if (stop === null) flaw ??= { field: "continuations", message: "A continuation stands where no stop was saved" };
      else if (!ladder.grounds.includes(lift.ground)) {
        flaw ??= { field: "continuations", message: `A stop at rung ${ladder.rung} of the ladder is not continued on the ground "${lift.ground}"` };
      } else {
        ladder = climbed(ladder, stop);
        stop = null;
        opened();
      }
    }
  };

  for (const attempt of value.inherited) step(attempt);
  for (const attempt of value.attempts) step(attempt);
  if (used.size !== lifts.size) flaw ??= { field: "continuations", message: "A continuation follows an attempt this series does not hold" };
  if (raised.size !== raises.size) flaw ??= { field: "escalations", message: "An escalation follows an attempt this series does not hold" };
  return { verdicts, achieved, withoutProgress, ladder, stop, flaw };
}

function stopOf(attempt: Attempt, ordinals: readonly number[], goals: readonly string[], ladder: SeriesLadder): SeriesStop {
  // Assembled by code from the records of the attempts, so two readings of the same history give the same stop.
  return {
    attempt: attempt.ordinal,
    attempts: [...ordinals],
    goals: [...goals],
    reason: `${ordinals.length} consecutive attempts closed without a new accepted result for ${goals.join(", ")}`,
    resume: resumeOf(attempt.ordinal, ladder),
  };
}

const resumeOf = (ordinal: number, ladder: SeriesLadder): string => (ladder.rung === FIRST_RUNG
  ? `attempt ${ordinal + 1} needs a ground of the first rung: the recorded review of this stop with an independent reviewer, a confirmed fix of the input, or the owner's decision`
  : `attempt ${ordinal + 1} needs the owner's decision: the first rung of the ladder is spent for ${ladder.goals.join(", ")}`);

/** The value as it is written: the attempts carry the verdicts the walk derived, and the count, ladder and stop follow. */
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
    escalations: draft.escalations.map(plainEscalation),
    withoutProgress: derived.withoutProgress,
    ladder: derived.ladder,
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
const sameRef = (left: Ref, right: Ref): boolean =>
  left.id === right.id && left.revision === right.revision && left.hash === right.hash;
const plainBasis = (basis: SeriesBasis): SeriesBasis => ({ ground: basis.ground, text: basis.text });

/** The ground as the series keeps it: the records its own rule names, copied one by one, and nothing else. */
function continuationOf(basis: ContinuationBasis): ContinuationBasis {
  if (basis.ground === "review-record") return { ground: basis.ground, text: basis.text, review: exactRef(basis.review) };
  if (basis.ground === "inputs-fixed") {
    return {
      ground: basis.ground, text: basis.text, refusal: basis.refusal,
      input: exactRef(basis.input), confirmation: exactRef(basis.confirmation),
    };
  }
  return { ground: basis.ground, text: basis.text, decision: exactRef(basis.decision) };
}
const plainContinuation = (item: Continuation): Continuation => ({ ...continuationOf(item), after: item.after });
const plainEscalation = (item: Escalation): Escalation => ({ after: item.after, review: exactRef(item.review) });

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
  escalations: value.escalations.map(plainEscalation),
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
  if (!SUCCESSION_GROUNDS.includes(basis['ground'] as SuccessionGround)) return "ground";
  return isText(basis['text']) ? null : "text";
}

const basisOf = (basis: SeriesBasis): SeriesBasis => plainBasis({ ground: basis.ground, text: basis.text });

/**
 * The shape of a ground to continue, on both paths it arrives by — a request and a stored continuation.
 * The key set is NOT fixed here: a request carries the address of its series as well, and what a ground may not do is
 * come without the records it is made of. The stored form is held to its exact keys where it is read.
 */
function groundProblem(value: unknown, holds: (record: unknown) => boolean): string | null {
  if (!isPlainObject(value)) return "ground";
  const basis = value as Record<string, unknown>;
  const ground = basis['ground'];
  if (!CONTINUATION_GROUNDS.includes(ground as ContinuationGround)) return "ground";
  if (!isText(basis['text'])) return "text";
  if (ground === "review-record") return holds(basis['review']) ? null : "review";
  if (ground === "inputs-fixed") {
    if (!isText(basis['refusal'])) return "refusal";
    // The input the attempts ran with is a revision that STANDS: it is what they ran with, not something to be
    // written now. Only the confirmation of the re-check may still be on its way.
    if (!isRef(basis['input'])) return "input";
    if (!holds(basis['confirmation'])) return "confirmation";
    return null;
  }
  return holds(basis['decision']) ? null : "decision";
}

/**
 * The two ways a neighbour hands over the record of a ground, and the rule that it is exactly one of them.
 * A record on its way carries the id it will stand at, its kind and its content; the series checks here only that all
 * three are there and that the content is JSON a store can hold, so that what it hashes and writes is a value and not
 * a promise. Where that id may lie and what the content must say are weighed later, like a stored record's.
 */
function isGroundRecord(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const source = value as Record<string, unknown>;
  if (exactKeys(source, REF_SOURCE_KEYS)) return isRef(source['ref']);
  if (!exactKeys(source, PENDING_SOURCE_KEYS)) return false;
  const pending = source['pending'];
  if (!isPlainObject(pending) || !exactKeys(pending, PENDING_KEYS)) return false;
  const record = pending as Record<string, unknown>;
  return isText(record['id']) && String(record['id']).length <= MAX_ENTITY_ID
    && isText(record['kind']) && isJson(record['value']);
}

// A value a store can hold at all: canonical() is the one judge of that, and its refusal is a defect of the caller.
function isJson(value: unknown): boolean {
  try {
    canonical(value);
    return true;
  } catch (error) {
    if (error instanceof EngineError) return false;
    throw error;
  }
}

// Said at all, in whatever form the unit that writes the record holds it. What it is WORTH is that unit's to answer;
// that it was said is this unit's, because an absent part of an agreed record is an absence, not an empty one (T4).
const said = (value: unknown): boolean =>
  isText(value) || (Array.isArray(value) ? value.length > 0 : isPlainObject(value) && Object.keys(value as object).length > 0);

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
  // A continuation may answer an INHERITED stop: a slice that moved does not lift one, so the successor is where the
  // stop its predecessor saved is continued. Stops are still answered in the order they were saved, and once each.
  let last = 0;
  for (let index = 0; index < continuations.length; index += 1) {
    const item = continuations[index];
    const flawed = groundProblem(item, isRef);
    if (flawed !== null) {
      return problem("series_invalid", "A continuation names the recorded ground it stands on with the records that ground is made of", context, `continuations.${index}.${flawed}`);
    }
    if (!exactKeys(item, [...groundKeys((item as Continuation).ground), "after"])) {
      return problem("series_invalid", "A continuation carries the records of its own ground and the attempt it follows, and nothing else", context, `continuations.${index}`);
    }
    const after = (item as Record<string, unknown>)['after'];
    if (!Number.isSafeInteger(after) || Number(after) <= last || Number(after) > all.length) {
      return problem("series_invalid", "A continuation follows one attempt of this series, and one attempt is continued once", context, `continuations.${index}.after`);
    }
    last = Number(after);
  }
  const escalations = series['escalations'];
  if (!Array.isArray(escalations)) {
    return problem("series_invalid", "A series carries its escalations, explicitly empty until a stop was sent to the owner", context, "escalations");
  }
  let raised = 0;
  for (let index = 0; index < escalations.length; index += 1) {
    const item = escalations[index];
    if (!isPlainObject(item) || !exactKeys(item, ESCALATION_KEYS) || !isRef((item as Record<string, unknown>)['review'])) {
      return problem("series_invalid", "An escalation names the stop it sent to the owner and the exact review it was sent on, and nothing else", context, `escalations.${index}`);
    }
    const after = (item as Record<string, unknown>)['after'];
    if (!Number.isSafeInteger(after) || Number(after) <= raised || Number(after) > all.length) {
      return problem("series_invalid", "An escalation follows one attempt of this series, and one stop is escalated once", context, `escalations.${index}.after`);
    }
    raised = Number(after);
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
    // The continuations already recorded come across whole and unchanged: dropping one would raise a stop that was
    // answered long ago, and adding one would give the successor a window nobody opened.
    const answered = read.value.value.continuations.map(plainContinuation);
    if (hashJson(draft.continuations.slice(0, answered.length)) !== hashJson(answered)) {
      return problem("series_invalid", "The continuations a successor inherits are not the ones its predecessor holds", context, "continuations");
    }
    // The same for escalations: a successor that dropped one would hand a stop the owner alone may continue back to
    // the reviewer, and one change of horizon does not do that.
    const sent = read.value.value.escalations.map(plainEscalation);
    if (hashJson(draft.escalations.slice(0, sent.length)) !== hashJson(sent)) {
      return problem("series_invalid", "The escalations a successor inherits are not the ones its predecessor holds", context, "escalations");
    }
    if (read.value.value.slice === draft.slice) {
      return problem("series_invalid", "A successor stands on a slice its predecessor did not hold", context, "slice");
    }
  }

  const derived = walk(draft);
  if (derived.flaw !== null) {
    return problem("series_invalid", derived.flaw.message, context, derived.flaw.field);
  }
  for (const attempt of [...draft.inherited, ...draft.attempts]) {
    if ((derived.verdicts.get(attempt.ordinal) ?? null) !== attempt.verdict) {
      return problem("series_invalid", "An attempt does not hold the verdict its outcome and the history of its goal give it", context, `attempts.${attempt.ordinal}.verdict`);
    }
  }
  if (series['withoutProgress'] !== derived.withoutProgress) {
    return problem("series_invalid", "The count of attempts without progress is not the count its attempts give", context, "withoutProgress");
  }
  if (hashJson(series['ladder'] ?? null) !== hashJson(derived.ladder)) {
    return problem("series_invalid", "The ladder is not the ladder its attempts and continuations give", context, "ladder");
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

// A refusal of this unit goes back to whoever produced what it read — or, when what is missing is a decision only the
// owner can take, to the owner. The series rules on the history it keeps and on nothing else, and switches nothing by
// refusing (T8): a stop stays a stop, and no window opens because a ground was turned away.
function problem(code: SeriesCode, message: string, context: Context, field: string, route: RefusalRoute = "producer"): OmResult<never> {
  return refused(code, message, { unit: UNIT, target: context.target, field, ref: context.ref }, route);
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
