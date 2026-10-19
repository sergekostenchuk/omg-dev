import { readCompletionCloseAt as readCompletionCloseAtOf, deriveWindowProgress as deriveWindowProgressOf,
  type WindowProgressRow } from './repeat-gate.js';
import { canonical, compareKeys, compositeKey, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import { readPreparedSeriesTransition as readPreparedSeriesTransitionOf, prepareSeriesTransition as prepareSeriesTransitionOf,
  comparePreparedSeriesSlices as comparePreparedSeriesSlicesOf, type PreparedSeriesDecision } from "./series-transition.js";
import { readHorizonIssuance as readHorizonIssuanceOf, prepareHorizonIssuance as prepareHorizonIssuanceOf } from "./horizon.js";
import { readModelTerminalWitness as readModelTerminalWitnessOf } from "./model-call.js";
import { delivered, isPlainObject, isText, localErrors, localRefusals, sealed, transfer, transferring, type Failed, type OmResult,
  type RefusalRoute, type Sealed, type SourceCodes } from "./refusal.js";
import { readRecord as readRecordOf, writeGuarded as writeGuardedOf, type GuardedWrite, type RecordRequest } from "./refs.js";
import { readJournal as readJournalOf, REFUSAL_JOURNAL_KIND, type JournalRow } from "./refusal-journal.js";
import { readGaps as readGapsOf, prepareCurrentGaps as prepareCurrentGapsOf, type GapReadRequest } from "./gaps.js";
import { readOmInput as readOmInputOf, withHistoricalReads, historicalRead } from "./input.js";
import { readFrameBasis as readFrameBasisOf } from "./frame-obligations.js";
import { readRoutes as readRoutesOf, prepareRoutes as prepareRoutesOf, prepareManagedRouteBatch as prepareManagedRouteBatchOf } from "./routes.js";
import { gapLineKey, gapLineExpectedResult } from "./gap-lines.js";
import { inputDecisionNamespace } from "./addressing.js";

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
/**
 * Q2b (№2518): every refusal code series.ts creates itself, from the actual places of issue — the store-repairs codes
 * above (the subset om-series.test pins), the G7 completion codes, B3's refused transition and the saved-record codes it
 * states about a handed-over record (№2460-1). SERIES_CODES stays exported and exact.
 */
export const SERIES_LOCAL_CODES = Object.freeze([...SERIES_CODES, "completion_required", "completion_conflict", "completion_invalid",
  "completion_request_invalid", "input_stale", "series_transition_refused", "record_foreign", "revision_conflict"] as const);
export type SeriesLocalCode = typeof SERIES_LOCAL_CODES[number];
export const SERIES_ERROR_CODES = Object.freeze(["series_request_invalid"] as const);
export type SeriesErrorCode = typeof SERIES_ERROR_CODES[number];
/** The units whose refusals series.ts hands on, each through its reader bound below. */
export type SeriesSource = "refs" | "repeat-gate" | "series-transition" | "horizon" | "model-call" | "refusal-journal" | "gaps"
  | "input" | "frame-obligations" | "routes";
export type SeriesResultCode = SeriesLocalCode | SourceCodes<SeriesSource>;
export type SeriesResult<T> = OmResult<T, SeriesResultCode>;

const readCompletionCloseAt = transferring("repeat-gate", readCompletionCloseAtOf);
const deriveWindowProgress = transferring("repeat-gate", deriveWindowProgressOf);
const readPreparedSeriesTransition = transferring("series-transition", readPreparedSeriesTransitionOf);
const prepareSeriesTransition = transferring("series-transition", prepareSeriesTransitionOf);
const comparePreparedSeriesSlices = transferring("series-transition", comparePreparedSeriesSlicesOf);
const readHorizonIssuance = transferring("horizon", readHorizonIssuanceOf);
const prepareHorizonIssuance = transferring("horizon", prepareHorizonIssuanceOf);
const readModelTerminalWitness = transferring("model-call", readModelTerminalWitnessOf);
const readJournal = transferring("refusal-journal", readJournalOf);
const readGaps = transferring("gaps", readGapsOf);
const prepareCurrentGaps = transferring("gaps", prepareCurrentGapsOf);
const readOmInput = transferring("input", readOmInputOf);
const readFrameBasis = transferring("frame-obligations", readFrameBasisOf);
const readRoutes = transferring("routes", readRoutesOf);
const prepareRoutes = transferring("routes", prepareRoutesOf);
const prepareManagedRouteBatch = transferring("routes", prepareManagedRouteBatchOf);
const readRecord = <T = Json>(store: Store, reference: unknown, request: RecordRequest) => transfer("refs", readRecordOf<T>(store, reference, request));
const writeGuarded = <T = Json>(store: Store, request: GuardedWrite) => transfer("refs", writeGuardedOf<T>(store, request));
const refuse = localRefusals(SERIES_LOCAL_CODES);
// Annotated explicitly: only a declared `never` (or `asserts`) makes a bare call end the control flow for tsc.
const raise: (code: SeriesErrorCode, message: string, details?: unknown) => never = localErrors(SERIES_ERROR_CODES);
const check: (condition: unknown, code: SeriesErrorCode, message: string) => asserts condition = (condition, code, message) => {
  if (!condition) raise(code, message);
};

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

/**
 * LP6 (№3325 §2–§5). A clean administrative end of an attempt — every technical end of its work a proved end by the
 * replaced B1 of its own area — is neutral for the count of attempts without progress: it neither raises the count nor
 * clears it. The family of decided input fields is new or known against the history of the whole LINE, so a changed set
 * of questions (a new composite goal) does not make the same accepted field new. Both rules hold only from the series'
 * explicit boundary on; the history before it is walked by the rules of its own era.
 */
export const ATTEMPT_PROGRESS_CONTRACT = "om-attempt-progress/v1" as const;
export const SERIES_PROGRESS_CONTRACT = "om-series-progress/v1" as const;
/** The key family of a decided block input field; such keys reach a series only from their confirming provider. */
export const INPUT_FIELD_KEY_PREFIX = "om-result:input-field:";
export type AdministrativeEnd = {
  readonly kind: "area-input-replaced";
  readonly input: Ref;
  readonly replacements: readonly Ref[];
  readonly sources: readonly Ref[];
} | {
  /** G6.2 (return №3899): a sound member of a group ended by the saved G5 rejection of others' defective work — neutral. */
  readonly kind: "group-rejected";
  readonly rejection: Ref;
  readonly sources: readonly Ref[];
};
export interface AttemptProgress { readonly contract: typeof ATTEMPT_PROGRESS_CONTRACT; readonly administrative: AdministrativeEnd | null }
/** The boundary from which a block series is walked by LP6: the exact revision before it, and the first attempt it covers. */
export interface ProgressPolicy { readonly contract: typeof SERIES_PROGRESS_CONTRACT; readonly previous: Ref | null; readonly from: number }
/** A saved stop reconciled under LP6: the exact transition record and the result keys it brought into the history. */
export interface Reconciliation {
  readonly after: number;
  readonly transition: Ref;
  readonly achieved: readonly { readonly goal: string; readonly key: string }[];
}

export interface AttemptOutcome {
  readonly reason: CompletionReason;
  readonly achieved: readonly Achievement[];
  readonly cancelled: readonly string[];
  readonly refusals: readonly SeriesRefusal[];
  /** What a block's managed close of the LP6 era proved besides its results; absent before the series' boundary. */
  readonly progress?: AttemptProgress;
}

export interface ClaimedOutcome extends Omit<AttemptOutcome, "refusals"> {
  readonly refusals: readonly ClaimedRefusal[];
}

// An attempt with no outcome is the one still running: there is one truth about its state, not a status field beside it.
export interface Attempt {
  readonly ordinal: number;
  readonly terminal?: Ref;
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

/**
 * How the window opened after a stop was answered ENDED. A window opens at the start of a series, at every new accepted
 * result and at every recorded continuation, so the window a continuation opened ends at the first of: the next saved
 * stop, a cycle that reached a new accepted result, or nothing yet.
 */
export const WINDOW_ENDINGS = Object.freeze(["stop", "progress", "open"] as const);
export type WindowEnding = typeof WINDOW_ENDINGS[number];

export type StopWindow =
  | { readonly ended: "stop"; readonly at: number }
  | { readonly ended: "progress"; readonly at: number; readonly goal: string; readonly accepted: readonly string[] }
  | { readonly ended: "open" };

/**
 * One SAVED STOP of a line, as the walk over its attempts derives it: the attempt it was saved after, the exact goals
 * it was counted over, what answered it, and what became of the window its continuation opened.
 * This is HISTORY, not state: the ladder of a series keeps only what the NEXT continuation has to satisfy, and a new
 * accepted result returns it to the start, which drops the windows already spent. A consumer that needs the goals of a
 * stop already answered, or the boundary of a window already closed, reads them here — from the one walk that derives
 * and checks the ladder itself — instead of approximating them from what the current ladder still says.
 */
export interface StopHistoryEntry {
  readonly attempt: number;
  readonly attempts: readonly number[];
  readonly goals: readonly string[];
  /** The escalation that sent this stop to the owner, or null. */
  readonly escalation: Escalation | null;
  /** The continuation this stop was continued on, or null while it stands. */
  readonly continuation: Continuation | null;
  /** What became of the window the continuation opened — null when no continuation opened one. */
  readonly window: StopWindow | null;
  /** LP6: the transition that reconciled this stop — present only when one did. */
  readonly reconciliation?: Ref;
}

export interface StopHistory {
  /** Every stop this line saved, inherited ones first, in the order they were saved. */
  readonly stops: readonly StopHistoryEntry[];
  /** The attempt the stop standing NOW was saved after, or null: the same stop the record holds. */
  readonly standing: number | null;
}

/**
 * Q3 (№2549, №2556): the order a revision of a series keeps its achieved results in. A series opened, registered or created
 * by an applied transition since Q3 carries it; a revision without it is of the fec6932 era, whose key joined the parts with
 * a space, and that stays its order for reading and for an exact repeat. One revision, one order — never two tried.
 */
export const ACHIEVED_ORDER = 'composite-key/v1' as const;
export type AchievedOrder = typeof ACHIEVED_ORDER;
export interface RepairSeries {
  readonly achievedOrder?: AchievedOrder;
  readonly contract?: typeof MANAGED_SERIES_CONTRACT;
  readonly activation?: SeriesActivation;
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
  /** LP6: present from the series' first activation of the new progress rules on, and inherited by a successor. */
  readonly progressPolicy?: ProgressPolicy;
  readonly reconciliations?: readonly Reconciliation[];
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
  readonly completion?: CompletionPlan;
}
export interface CompleteAttemptRequest extends SeriesRequest {
  readonly terminal?: Ref;
  readonly attempt: number;
  readonly outcome: ClaimedOutcome;
}
export type MechanismOwner = { readonly kind: "mechanism"; readonly mechanism: "M5:addressing" };
export type SeriesOwner = { readonly kind: "block"; readonly block: string } | MechanismOwner;
export interface MechanismSeriesRequest { readonly project: string; readonly owner: MechanismOwner; readonly line: number }
export type AnySeriesRequest = SeriesRequest | MechanismSeriesRequest;
export interface MechanismAdmission { readonly gaps: Sealed<GapReadRequest>; readonly routes: Ref; readonly batch: string }
export interface MechanismRepairSeries extends Omit<RepairSeries, "block"> {
  readonly owner: MechanismOwner;
  readonly scope: Sealed<GapReadRequest>;
  readonly admissions: readonly { readonly attempt: number; readonly basis: MechanismAdmission }[];
}
export type AnyRepairSeries = RepairSeries | MechanismRepairSeries;
export interface MechanismOpenSeriesRequest extends MechanismSeriesRequest {
  readonly scope: Sealed<GapReadRequest>; readonly predecessor: Ref | null; readonly basis: SeriesBasis | null;
}
export interface MechanismBeginAttemptRequest extends MechanismSeriesRequest {
  readonly attempt: number; readonly goal: AttemptGoal; readonly admission: MechanismAdmission; readonly completion?: CompletionPlan;
}
export type MechanismCompleteAttemptRequest = MechanismSeriesRequest & Pick<CompleteAttemptRequest, "attempt" | "outcome">;
export type AnyOpenSeriesRequest = OpenSeriesRequest | MechanismOpenSeriesRequest;
export type AnyBeginAttemptRequest = BeginAttemptRequest | MechanismBeginAttemptRequest;
export type AnyCompleteAttemptRequest = CompleteAttemptRequest | MechanismCompleteAttemptRequest;
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
  readonly guards: readonly TransactionGuard[];
  readonly value: RepairSeries;
}

export interface AnySeriesTransition extends Omit<SeriesTransition, "value"> { readonly value: AnyRepairSeries }
export type MechanismResumeSeriesRequest = MechanismSeriesRequest & ContinuationRequest & { readonly stop: number };
export type MechanismEscalateSeriesRequest = MechanismSeriesRequest & Pick<EscalateSeriesRequest, "stop" | "review">;
export type AnyResumeSeriesRequest = ResumeSeriesRequest | MechanismResumeSeriesRequest;
export type AnyEscalateSeriesRequest = EscalateSeriesRequest | MechanismEscalateSeriesRequest;

const GOAL_KEYS = Object.freeze(["key", "questions", "result"] as const);
const ACHIEVEMENT_KEYS = Object.freeze(["key", "basis"] as const);
const CLAIMED_REFUSAL_KEYS = Object.freeze(["name", "goal", "row"] as const);
const OUTCOME_KEYS = Object.freeze(["reason", "achieved", "cancelled", "refusals"] as const);
const REF_SOURCE_KEYS = Object.freeze(["ref"] as const);
const PENDING_SOURCE_KEYS = Object.freeze(["pending"] as const);
const PENDING_KEYS = Object.freeze(["id", "kind", "value"] as const);

export interface SeriesAddress { readonly project: string; readonly owner: SeriesOwner; readonly line: number; readonly id: string }
type Address = SeriesAddress;
interface Context { readonly target: string; readonly ref: Ref | undefined }
interface Prepared { readonly transition: AnySeriesTransition; readonly current: Revision<AnyRepairSeries> | null }

export function seriesId(project: string, block: string, line: number): string {
  // The line is decimal digits and a project carries no ':', so the address of a series decomposes in one way only,
  // even though a block name carries ':' of its own ("block:cart").
  const id = `${REPAIR_SERIES_KIND}:${requireProject(project)}:${requireLine(line)}:${requireBlock(block)}`;
  check(id.length <= MAX_ENTITY_ID, "series_request_invalid", "A series whose address overflows an entity id cannot be kept");
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
export function openSeries(store: Store, request: OpenSeriesRequest): SeriesResult<Sealed<Revision<RepairSeries>>>;
export function openSeries(store: Store, request: AnyOpenSeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>>;
export function openSeries(store: Store, request: AnyOpenSeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  return withHistoricalReads(() => applied(store, prepareOpen(store, request)));
}

/**
 * Names the goal of one cycle and the ordinal of the attempt it opens.
 * An ordinal this series already holds is that attempt — running or long closed — when the goal is the same, so a
 * notification lost to a restart re-reaches the cycle it was about instead of opening the next one; the same ordinal
 * under another goal is a conflict. Only the next ordinal opens an attempt, and none opens while a stop stands.
 */
export function beginAttempt(store: Store, request: BeginAttemptRequest): SeriesResult<Sealed<Revision<RepairSeries>>>;
export function beginAttempt(store: Store, request: AnyBeginAttemptRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>>;
export function beginAttempt(store: Store, request: AnyBeginAttemptRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  return withHistoricalReads(() => applied(store, prepareBegin(store, request)));
}

/**
 * Records the outcome of one completed cycle, once.
 * The same outcome delivered again changes nothing and writes no revision; a different outcome for an attempt already
 * closed is refused, so a late delivery does not undo a later one (T5). Whether the attempt moved the goal is decided
 * here, from the achievements it carries and the history of that goal — never from a word of the caller's.
 */
export function completeAttempt(store: Store, request: CompleteAttemptRequest): SeriesResult<Sealed<Revision<RepairSeries>>>;
export function completeAttempt(store: Store, request: AnyCompleteAttemptRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>>;
export function completeAttempt(store: Store, request: AnyCompleteAttemptRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  return withHistoricalReads(() => applied(store, prepareComplete(store, request)));
}

/**
 * Continues the series from the stop the request names, on a ground the rung it has reached admits.
 * A restart does not lift a stop and neither does a continuation given for an earlier one: the ground is recorded
 * against the attempt whose stop it answers, so a late repeat finds its own ground already there and leaves a stop
 * saved since then standing. A continuation opens a new window of up to three attempts without progress; it is not
 * itself progress, so it spends the rung it stood on instead of returning the ladder to the start.
 */
export function resumeSeries(store: Store, request: ResumeSeriesRequest): SeriesResult<Sealed<Revision<RepairSeries>>>;
export function resumeSeries(store: Store, request: AnyResumeSeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>>;
export function resumeSeries(store: Store, request: AnyResumeSeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  return withHistoricalReads(() => applied(store, prepareResume(store, request)));
}

/**
 * Sends the stop the request names to the owner, on the exact record of a review that ended without a decision.
 * The rules put such a stop on the second rung: the stop stays saved, no window opens, and from then on only the
 * owner's decision continues it — a second review of the same stop, however good, and a fixed input no longer do.
 * A6 writes the review and changes no series, so this is the transition that keeps its outcome in the series itself.
 * It applies to its own stop and once: the same request again changes nothing, another review for a stop already
 * escalated is refused, and a stop that no longer stands cannot be escalated at all (T5).
 */
export function escalateSeries(store: Store, request: EscalateSeriesRequest): SeriesResult<Sealed<Revision<RepairSeries>>>;
export function escalateSeries(store: Store, request: AnyEscalateSeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>>;
export function escalateSeries(store: Store, request: AnyEscalateSeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  return withHistoricalReads(() => applied(store, prepareEscalate(store, request)));
}

/**
 * LP6 (№3325 §5): lifts the saved stop the request names by `progress-reconciled` — the transition of the new era for a
 * stop whose whole counted window proves fresh input-field results or clean administrative ends of the replaced B1. It
 * opens a new window with a count of zero, neither climbs nor resets the rung, adds no window to the ladder and puts the
 * proved results into the history; the old outcomes, verdicts and the stop itself stay as they were written. The record
 * of the transition and the new revision of the series are one guarded transaction; a repeat finds its own transition.
 * A window with a real failure is `progress_unproved` (from repeat-gate), and the old rules of the ladder stand.
 */
export function reconcileSeries(store: Store, request: ReconcileSeriesRequest): SeriesResult<Sealed<Revision<RepairSeries>>> {
  return withHistoricalReads(() => applied(store, prepareReconcile(store, request))) as SeriesResult<Sealed<Revision<RepairSeries>>>;
}
export function prepareReconcileSeries(store: Store, request: ReconcileSeriesRequest): SeriesResult<Sealed<SeriesTransition>> {
  return withHistoricalReads(() => handed(prepareReconcile(store, request))) as SeriesResult<Sealed<SeriesTransition>>;
}

/**
 * Reads the series of one block and line.
 * An absent series is a typed refusal, not an empty one: a block that was never repaired and a series that was lost
 * are different facts, and no consumer may read them alike (T4).
 */
export function readSeries(store: Store, request: SeriesRequest): SeriesResult<Sealed<Revision<RepairSeries>>>;
export function readSeries(store: Store, request: AnySeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>>;
export function readSeries(store: Store, request: AnySeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  requireStore(store);
  check(isPlainObject(request), "series_request_invalid", "A series is read through a request object");
  const address = requireAddress(request);
  return withHistoricalReads(() => {
    const current = currentSeries(store, address);
    if (!current) return missing(address);
    return current.ok ? delivered(current.value) : current;
  });
}

/** Exact history uses the same series check without requiring this revision to remain the head. */
export function readAnySeriesAt(store: Store, project: string, ref: Ref): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  requireStore(store); requireProject(project);
  check(isRef(ref), "series_request_invalid", "Historical series reading needs an exact reference");
  return withHistoricalReads(() => historicalRead(store, { reader: 'A3.series-history', project, ref, parameters: null },
    () => readSeriesHistory(store, project, ref),
    () => problem('series_invalid', 'Series history may not depend on itself', { target: ref.id, ref }, 'history')));
}
/** NR1 (№3600): a trusted read — every revision of a series was built by its transition producer from the exact
 * predecessor revision and written under its guards; the history is read at its exact reference, never checked again. */
function readSeriesHistory(store: Store, project: string, ref: Ref): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  requireStore(store);
  requireProject(project);
  if (!isRef(ref)) raise("series_request_invalid", "Historical series reading needs an exact reference",
    { unit: UNIT, target: REPAIR_SERIES_KIND, field: "reference" });
  return readRecord<AnyRepairSeries>(store, ref, { unit: UNIT, target: ref.id, kind: REPAIR_SERIES_KIND, idPrefix: `${REPAIR_SERIES_KIND}:${project}:` });
}

/** Work and participation share exact lineage proof, but only active participation admits new work. */
export function prepareSeriesLineAdmission(store: Store, project: string, ref: Ref): SeriesResult<Sealed<SeriesLineAdmission>> {
  requireStore(store); requireProject(project); check(isRef(ref), "series_request_invalid", "Admission needs an exact series");
  return mechanismResult(() => currentBlockAdmission(store, project, ref, true));
}
export function prepareSeriesParticipantAdmission(store: Store, project: string, ref: Ref): SeriesResult<Sealed<SeriesLineAdmission>> {
  requireStore(store); requireProject(project); check(isRef(ref), "series_request_invalid", "Participation needs an exact series");
  return mechanismResult(() => currentBlockAdmission(store, project, ref, false));
}

function currentLineProblem(store: Store, address: Address, ref?: Ref): SeriesResult<never> | null {
  return store.get(ownerSeriesId(address.project, address.owner, address.line + 1))
    ? problem("series_conflict", "New work belongs to the current successor of this lineage", { target: address.id, ref }, "line")
    : null;
}

/**
 * THE HISTORY OF THE STOPS of one line, inherited ones included — for a consumer that has to speak about a stop the
 * series has already answered: which goals it was counted over, what answered it, and what ended the window its
 * continuation opened.
 *
 * It is the SAME derivation, not a second one: the walk that builds the count, the ladder and the saved stop, and that
 * every reading of the record checks the stored ones against, fills this history in as it goes. The LADDER is state —
 * it says what the next continuation has to satisfy, and a new accepted result returns it to the start, which drops the
 * windows already spent and the goals of the stop the ladder began at. The history is not dropped: the attempts, the
 * continuations and the escalations it is derived from stay in the record and travel to a successor, so an inherited
 * stop keeps its goals and its window exactly. Nothing here is stored beside them and nothing is believed: a record
 * whose stored ladder, count or stop does not follow from the same walk is refused by readSeries before this returns.
 */
export function readStopHistory(store: Store, request: AnySeriesRequest): SeriesResult<Sealed<StopHistory>> {
  const read = readSeries(store, request);
  if (!read.ok) return read;
  return stopHistoryOf(read.value.value);
}

/** The same history, derived from the exact saved series rather than its current head. */
export function readStopHistoryAt(store: Store, project: string, ref: Ref): SeriesResult<Sealed<StopHistory>> {
  const invalid = (field: string): never => { raise("series_request_invalid", "Historical stop history needs its project and exact series",
    { unit: UNIT, target: REPAIR_SERIES_KIND, field }); };
  if (!(store instanceof Store)) invalid("store");
  try { project = requireProject(project); }
  catch (error) { if (error instanceof EngineError && error.code === "series_request_invalid") invalid("project"); throw error; }
  if (!isRef(ref)) invalid("reference");
  const read = readAnySeriesAt(store, project, ref);
  return read.ok ? stopHistoryOf(read.value.value) : read;
}

function stopHistoryOf(value: Sealed<AnyRepairSeries>): SeriesResult<Sealed<StopHistory>> {
  const derived = walk(plainSeries(value as unknown as AnyRepairSeries));
  return delivered({ stops: derived.stops, standing: derived.stop === null ? null : derived.stop.attempt });
}

// Each change is prepared once and applied in one of two ways: written on its own here, or handed to a caller that
// writes it together with other records in a single guarded transaction. One implementation, two entrances.
export function prepareOpenSeries(store: Store, request: OpenSeriesRequest): SeriesResult<Sealed<SeriesTransition>>;
export function prepareOpenSeries(store: Store, request: AnyOpenSeriesRequest): SeriesResult<Sealed<AnySeriesTransition>>;
export function prepareOpenSeries(store: Store, request: AnyOpenSeriesRequest): SeriesResult<Sealed<AnySeriesTransition>> { return withHistoricalReads(() => handed(prepareOpen(store, request))); }
export function prepareBeginAttempt(store: Store, request: BeginAttemptRequest): SeriesResult<Sealed<SeriesTransition>>;
export function prepareBeginAttempt(store: Store, request: AnyBeginAttemptRequest): SeriesResult<Sealed<AnySeriesTransition>>;
export function prepareBeginAttempt(store: Store, request: AnyBeginAttemptRequest): SeriesResult<Sealed<AnySeriesTransition>> { return withHistoricalReads(() => handed(prepareBegin(store, request))); }
export function prepareCompleteAttempt(store: Store, request: CompleteAttemptRequest): SeriesResult<Sealed<SeriesTransition>>;
export function prepareCompleteAttempt(store: Store, request: AnyCompleteAttemptRequest): SeriesResult<Sealed<AnySeriesTransition>>;
export function prepareCompleteAttempt(store: Store, request: AnyCompleteAttemptRequest): SeriesResult<Sealed<AnySeriesTransition>> { return withHistoricalReads(() => handed(prepareComplete(store, request))); }
export function prepareResumeSeries(store: Store, request: ResumeSeriesRequest): SeriesResult<Sealed<SeriesTransition>>;
export function prepareResumeSeries(store: Store, request: AnyResumeSeriesRequest): SeriesResult<Sealed<AnySeriesTransition>>;
export function prepareResumeSeries(store: Store, request: AnyResumeSeriesRequest): SeriesResult<Sealed<AnySeriesTransition>> { return withHistoricalReads(() => handed(prepareResume(store, request))); }
export function prepareEscalateSeries(store: Store, request: EscalateSeriesRequest): SeriesResult<Sealed<SeriesTransition>>;
export function prepareEscalateSeries(store: Store, request: AnyEscalateSeriesRequest): SeriesResult<Sealed<AnySeriesTransition>>;
export function prepareEscalateSeries(store: Store, request: AnyEscalateSeriesRequest): SeriesResult<Sealed<AnySeriesTransition>> { return withHistoricalReads(() => handed(prepareEscalate(store, request))); }

const handed = (prepared: SeriesResult<Prepared>): SeriesResult<Sealed<AnySeriesTransition>> =>
  prepared.ok ? delivered(prepared.value.transition) : prepared;

function applied(store: Store, prepared: SeriesResult<Prepared>): SeriesResult<Sealed<Revision<AnyRepairSeries>>> {
  if (!prepared.ok) return prepared;
  const { transition, current } = prepared.value;
  // Nothing to write is a fact, not a failure: the series already holds what was asked for.
  if (transition.writes.length === 0) return delivered(current!);
  // One transaction for the series and the ground it stands on: both commit, or neither does (T7).
  const result = writeGuarded<AnyRepairSeries>(store, {
    unit: UNIT, target: transition.writes[0]!.id, guards: transition.guards, writes: [...transition.writes],
  });
  if (!result.ok) return result;
  return delivered(result.value[0]!);
}

const unchanged = (current: Revision<AnyRepairSeries>, guards: readonly TransactionGuard[] = []): SeriesResult<Prepared> =>
  ({ ok: true, value: { transition: { writes: [], guards, value: current.value }, current } });

function change(
  address: Address, value: AnyRepairSeries, expected: number, guards: readonly TransactionGuard[], current: Revision<AnyRepairSeries> | null,
  grounds: readonly PreparedWrite[] = [],
): SeriesResult<Prepared> {
  const series: PreparedWrite = { id: address.id, kind: REPAIR_SERIES_KIND, expected, value };
  return { ok: true, value: { transition: { writes: [series, ...grounds], guards: [...guards], value }, current } };
}

function prepareOpen(store: Store, request: AnyOpenSeriesRequest): SeriesResult<Prepared> {
  try { return prepareOpenInner(store, request); } catch (error) { if (error instanceof MechanismFailure) return error.result; throw error; }
}
function prepareOpenInner(store: Store, request: AnyOpenSeriesRequest): SeriesResult<Prepared> {
  requireStore(store);
  check(isPlainObject(request), "series_request_invalid", "A series is opened through a request object");
  const address = requireAddress(request);
  const mechanism = "owner" in request;
  if (mechanism) requireScope(request.scope);
  else check(isText(request.slice), "series_request_invalid", "A series names the slice of the horizon it belongs to");
  const projection = mechanism ? projectMechanismSlice(store, address.project, request.scope, false) : null;
  if (projection && !projection.ok) return projection;
  if (projection?.ok && projection.value.value.questions.length === 0)
    return problem("series_invalid", "An empty addressing slice opens no work and does not erase its lineage", { target: address.id, ref: undefined }, "scope.questions");
  const slice = projection?.ok ? projection.value.slice : (request as OpenSeriesRequest).slice;
  let sourceGuards: readonly TransactionGuard[] = [];
  let registrationPointer: Ref | null = null;

  // The first line has no predecessor and no ground to stand on; any later line has both. Neither is a default.
  // Whether a predecessor that IS named is an exact reference is data, not shape: it comes back addressed.
  check("predecessor" in request && (address.line === 1) === (request.predecessor === null),
    "series_request_invalid", "Only the first line of a series has no predecessor");
  check((request.basis === null) === (request.predecessor === null),
    "series_request_invalid", "A successor of a series carries the recorded ground it stands on");
  check(request.basis === null || basisProblem(request.basis) === null,
    "series_request_invalid", "The ground of a successor names one of the recorded grounds and says what changed");
  const basis = request.basis === null ? null : basisOf(request.basis);

  // The predecessor is resolved first, at the exact revision the request names, so that opening the same successor
  // again is recognised as a repeat however far the predecessor has moved on since.
  let inherited: readonly Attempt[] = [];
  let carried: readonly Continuation[] = [];
  let escalated: readonly Escalation[] = [];
  let predecessor: Ref | null = null;
  let earlier: Revision<AnyRepairSeries> | null = null;
  if (request.predecessor !== null) {
    const at = ownerSeriesId(address.project, address.owner, address.line - 1);
    const read = readRecord<AnyRepairSeries>(store, request.predecessor, {
      unit: UNIT, target: address.id, kind: REPAIR_SERIES_KIND, id: at,
    });
    if (!read.ok) return read;
    earlier = read.value as Revision<AnyRepairSeries>;
    inherited = [...earlier.value.inherited, ...earlier.value.attempts].map(attempt => copyAttempt(attempt, ACHIEVED_ORDER));
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
    const same = held.slice === slice
      && hashJson(held.predecessor) === hashJson(predecessor) && hashJson(held.basis) === hashJson(basis);
    if (same) {
      if (mechanism && "owner" in held && canonical(normalizedScope(request.scope)) !== canonical(normalizedScope(held.scope))) {
        const obsolete = currentLineProblem(store, address, reference(standing.value));
        if (obsolete) return obsolete;
        const fresh = projectMechanismSlice(store, address.project, request.scope, true);
        if (!fresh.ok) return fresh;
        return unchanged(standing.value, fresh.value.guards);
      }
      return unchanged(standing.value);
    }
    return refuse("series_conflict", "A series already stands at this address on another slice, predecessor or ground",
      { unit: UNIT, target: address.id, field: "slice", ref: reference(standing.value) }, "producer");
  }

  // Capture the registry before walking roots: its CAS serializes first-open with activation.
  const membership = !mechanism && !earlier ? captureMembership(store, address.project) : null;
  if (membership?.value.mode === 'transition-managed') {
    const pointer = store.get<CurrentSeriesPointer>(seriesCurrentId(address.project));
    mechanismCheck(pointer, address.id, 'pointer', 'Managed registration requires its current activation pointer');
    checkedRegistrationSources(store, address.project, reference(membership.record!), reference(pointer));
    registrationPointer = reference(pointer);
    sourceGuards = [registrationPointer];
  }
  if (!mechanism && earlier) {
    if (earlier.value.contract !== undefined || membership?.value.mode === 'transition-managed')
      return problem("series_conflict", "Managed successors require a proved prepared transition", { target: address.id, ref: predecessor! }, "activation");
  }
  if (mechanism) {
    const admitted = projectMechanismSlice(store, address.project, request.scope, true);
    if (!admitted.ok) return admitted;
    sourceGuards = admitted.value.guards;
  }
  if (earlier) {
    if (earlier.value.slice === slice) {
      return refuse("slice_unchanged", "An unchanged slice keeps the same series and the same count, and opens no successor",
        { unit: UNIT, target: address.id, field: "slice", ref: predecessor ?? undefined }, "producer");
    }
    // A cycle that is still running belongs to the series it was begun in: it is completed, or recorded as
    // interrupted, before the slice moves. Carrying it over would hand the successor an attempt it never began.
    if (running(earlier.value) !== null) {
      return refuse("attempt_running", "The predecessor still holds a running attempt, which is completed before the slice moves",
        { unit: UNIT, target: address.id, field: "attempts", ref: predecessor ?? undefined }, "producer");
    }
  }

  const value = !mechanism && membership?.value.mode === 'transition-managed'
    ? registeredRoot(address.project, (address.owner as Extract<SeriesOwner, { kind: 'block' }>).block, slice, membership.value, ACHIEVED_ORDER)
    : settled({
    achievedOrder: ACHIEVED_ORDER, projectId: address.project, ...ownerFields(address.owner), line: address.line, slice,
    ...(mechanism ? { scope: normalizedScope(request.scope), admissions: earlier && "owner" in earlier.value ? earlier.value.admissions : [] } : {}),
    predecessor, basis, inherited, attempts: [], continuations: carried, escalations: escalated,
    ...(earlier && "block" in earlier.value && earlier.value.progressPolicy !== undefined ? { progressPolicy: earlier.value.progressPolicy } : {}),
    ...(earlier && "block" in earlier.value && earlier.value.reconciliations !== undefined ? { reconciliations: earlier.value.reconciliations } : {}),
  } as SeriesDraft);
  // Claim the old line in the same CAS transaction. Its unchanged body remains historical, while its new revision
  // invalidates previously prepared work on that old line in either transaction ordering.
  const claim: PreparedWrite[] = earlier ? [{ id: earlier.id, kind: REPAIR_SERIES_KIND,
    expected: earlier.revision, value: earlier.value }] : [];
  if (!mechanism && !earlier && membership) {
    const root = { id: address.id, revision: 1, hash: hashJson(value) };
    const body = registeredMembership(membership.value, (address.owner as Extract<SeriesOwner, { kind: 'block' }>).block, root);
    claim.push({ id: seriesMembershipId(address.project), kind: SERIES_MEMBERSHIP_KIND,
      expected: membership.record?.revision ?? 0, value: body });
    if (membership.value.mode === 'transition-managed') {
      const era = prepareEraWrite(store, { id: address.id, kind: REPAIR_SERIES_KIND, revision: 1, hash: root.hash, value: value as RepairSeries },
        { kind: 'registration', membership: reference(membership.record!), pointer: registrationPointer!, slice, achievedOrder: ACHIEVED_ORDER });
      if (era) claim.push(era);
    }
  }
  return change(address, value, 0, [...sourceGuards, ...(predecessor === null ? [] : [predecessor]),
    ...(membership?.record ? [reference(membership.record)] : [])], null, claim);
}

function prepareBegin(store: Store, request: AnyBeginAttemptRequest, managed?: CompletionPlan): SeriesResult<Prepared> {
  try { return prepareBeginInner(store, request, managed); }
  catch (error) { if (error instanceof CompletionFailure) return error.result; throw error; }
}
function requireBeginRequest(store: Store, request: AnyBeginAttemptRequest): Address {
  requireStore(store);
  check(isPlainObject(request), "series_request_invalid", "An attempt is begun through a request object");
  const address = requireAddress(request);
  if ("owner" in request) requireAdmission(request.admission);
  check(Number.isSafeInteger(request.attempt) && request.attempt >= 1,
    "series_request_invalid", "An attempt names the ordinal it opens, so that a late delivery finds its own attempt");
  check(goalProblem(request.goal) === null,
    "series_request_invalid", "An attempt names its goal beforehand: a lasting key, the question or package of questions, and the checkable result");
  return address;
}
function prepareBeginInner(store: Store, request: AnyBeginAttemptRequest, managed?: CompletionPlan): SeriesResult<Prepared> {
  const address = requireBeginRequest(store, request);
  const goal = goalOf(request.goal);

  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value;
  const context: Context = { target: address.id, ref: reference(head) };
  const held = head.value;
  const known = [...held.inherited, ...held.attempts].find(item => item.ordinal === request.attempt);
  const completion = readCompletionBinding(store, address.project, reference(head), request.attempt);
  if (!completion.ok) return completion;
  const era = completionEra(store, address.project, address.id);
  if (!known && !managed && (request.completion || era && request.attempt >= era.value.firstManagedAttempt))
    return refuse("completion_required", "This attempt must open through G7 with its complete managed work", { unit: UNIT, target: address.id, field: "completion" }, "producer");
  if (known && completion.value !== null) {
    if (request.completion && canonical(normalizeCompletionPlan(request.completion)) !== canonical(completion.value.value.plan))
      return refuse("completion_conflict", "A repeated opening retains its original complete assignment", { unit: UNIT, target: address.id, field: "completion" }, "producer");
  } else if (known && managed)
    return refuse("completion_conflict", "An existing standalone attempt cannot acquire a completion owner", { unit: UNIT, target: address.id, field: "completion" }, "producer");

  if (known) {
    // T5: an ordinal this series already holds is that attempt, whether it is still running or long closed. A
    // notification that arrives twice, or late, re-reaches the cycle it was about and opens nothing.
    if (hashJson(known.goal) === hashJson(goal)) {
      if ("owner" in held && "owner" in request && canonical(held.admissions.find(row => row.attempt === request.attempt)?.basis ?? null) !== canonical(normalizedAdmission(request.admission)))
        return problem("attempt_conflict", "An existing attempt retains its exact admission evidence", context, "admission");
      return unchanged(head);
    }
    return problem("attempt_conflict", `Attempt ${request.attempt} was begun for another goal, and a later goal does not replace it`, context, "goal");
  }
  const obsolete = currentLineProblem(store, address, reference(head));
  if (obsolete) return obsolete;
  const lineAdmission = mutationAdmission(store, head);
  if (!lineAdmission.ok) return lineAdmission;
  let admission: SeriesAdmissionProof | null = null;
  if ("owner" in request) {
    const admitted = prepareSeriesAdmission(store, request, request.admission);
    if (!admitted.ok) return admitted;
    admission = admitted.value as SeriesAdmissionProof;
    if (!("owner" in held) || held.slice !== admission.slice)
      return problem("series_conflict", "A changed mechanism task or accepted consumer set requires the inherited successor", context, "scope");
    if (canonical(goal.questions) !== canonical(admission.goal.questions) || goal.result !== admission.goal.result)
      return problem("attempt_conflict", "The declared goal must equal the entire selected M6 batch and its result contract", context, "goal");
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
  const value = settled({ ...plainSeries(held),
    ...("owner" in held && "owner" in request ? { admissions: [...held.admissions, { attempt: request.attempt, basis: normalizedAdmission(request.admission) }] } : {}), attempts: [...held.attempts.map(item => copyAttempt(item, held.achievedOrder)), attempt] });
  return change(address, value, head.revision, [...lineAdmission.value.guards, ...(admission?.guards ?? [])], head);
}

function prepareComplete(store: Store, request: AnyCompleteAttemptRequest, managed?: Ref): SeriesResult<Prepared> {
  requireStore(store);
  check(isPlainObject(request), "series_request_invalid", "An outcome is recorded through a request object");
  const address = requireAddress(request);
  check(Number.isSafeInteger(request.attempt) && request.attempt >= 1,
    "series_request_invalid", "An outcome names the attempt it closes by its ordinal");
  check(outcomeProblem(request.outcome, CLAIMED_REFUSAL_KEYS) === null,
    "series_request_invalid", "An outcome names why the cycle ended, what it achieved and on what ground, what it cancelled, and every refusal with the journal row it stands for");
  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value;
  const context: Context = { target: address.id, ref: reference(head) };
  const held = head.value;
  // In the order of the revision it closes: an exact repeat of an earlier era stays a repeat (№2556).
  const outcome = outcomeOf(request.outcome, held.achievedOrder);

  // An inherited attempt was completed in the series it was begun in, so only an own attempt can still be running.
  const attempt = [...held.inherited, ...held.attempts].find(item => item.ordinal === request.attempt);
  if (!attempt) {
    return problem("attempt_unknown", `No attempt ${request.attempt} stands in this series`, context, "attempt");
  }
  if (attempt.outcome !== null) {
    // An outcome is counted once. The same one again is a repeat of the delivery, not a second cycle, and it stays a
    // repeat however many attempts have been begun and closed since.
    if (hashJson(attempt.outcome) === hashJson(outcome)
      && canonical(attempt.terminal ?? null) === canonical(("terminal" in request ? request.terminal : undefined) ?? null)) return unchanged(head);
    return problem("outcome_conflict", `Attempt ${request.attempt} is closed already, and a later outcome does not replace the earlier one`, context, "outcome");
  }

  const binding = readCompletionBinding(store, address.project, reference(head), request.attempt);
  if (!binding.ok) return binding;
  if (binding.value !== null) {
    if (!managed) return refuse('completion_required', 'Only G7 can close a managed attempt through its complete proof',
      { unit: UNIT, target: head.id, field: 'completion' }, 'producer');
    const proof = readCompletionCloseAt(store, address.project, managed);
    if (!proof.ok) return proof;
    if (!sameRef(proof.value.binding, reference(binding.value)) || !sameRef(proof.value.series, reference(head))
      || canonical(outcomeOf(proof.value.outcome, held.achievedOrder)) !== canonical(outcome))
      return refuse('completion_invalid', 'The A3 outcome must equal the proved complete managed composition',
        { unit: UNIT, target: head.id, field: 'completion' }, 'producer');
  } else if (managed) return refuse('completion_invalid', 'A standalone attempt cannot acquire a managed close proof',
    { unit: UNIT, target: head.id, field: 'completion' }, 'producer');
  let completionGuards: readonly Ref[];
  const terminal = 'terminal' in request ? request.terminal : undefined;
  if (terminal !== undefined) {
    check(isRef(terminal), "series_request_invalid", "Terminal completion names an exact E4 witness");
    const witness = readModelTerminalWitness(store, { project: address.project, record: terminal });
    if (!witness.ok) return witness;
    if (witness.value.series.id !== head.id || witness.value.attempt !== attempt.ordinal
      || canonical(witness.value.goal) !== canonical(attempt.goal) || outcome.reason !== witness.value.reason
      || outcome.achieved.length || outcome.cancelled.length || !held.attempts.some(item => item.ordinal === attempt.ordinal))
      return problem("outcome_invalid", "Terminal completion belongs only to its original open attempt and physical outcome", context, "terminal");
    const admission = prepareSeriesParticipantAdmission(store, address.project, reference(head));
    if (!admission.ok) return admission;
    if (admission.value.pointer === null || admission.value.pointer.id !== witness.value.change.currentPointer.id
      || admission.value.pointer.revision < witness.value.change.currentPointer.revision
      || (admission.value.pointer.revision === witness.value.change.currentPointer.revision && !sameRef(admission.value.pointer, witness.value.change.currentPointer)))
      return problem("series_conflict", "The terminal witness must name the current applied change", context, "terminal");
    completionGuards = admission.value.guards;
  } else if (managed && binding.value) {
    const admission = prepareCompletionAdmission(store, address.project, reference(binding.value));
    if (!admission.ok) return admission;
    completionGuards = admission.value.guards;
  } else {
    const admission = mutationAdmission(store, head);
    if (!admission.ok) return admission;
    completionGuards = admission.value.guards;
  }

  // LP6 (№3325 §4): progress is derived by a block's managed close of the new era, never claimed by a caller; the first
  // such close activates the boundary of the series at its own attempt, and from it on every managed close carries one.
  const progressed = outcome.progress !== undefined;
  const policy = "block" in held ? held.progressPolicy : undefined;
  if (progressed && (binding.value === null || !("block" in held)))
    return problem("outcome_invalid", "Only a managed close of a block carries its progress", context, "outcome.progress");
  if (binding.value !== null && "block" in held && policy !== undefined && (attempt.ordinal >= policy.from) !== progressed)
    return refuse('completion_invalid', 'A managed close keeps the progress rules of its side of the series boundary',
      { unit: UNIT, target: head.id, field: 'completion' }, 'producer');
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

  const closed: Attempt = { ordinal: attempt.ordinal, goal: goalOf(attempt.goal), outcome, verdict: null,
    ...(terminal === undefined ? {} : { terminal: exactRef(terminal) }) };
  const value = settled({
    ...plainSeries(held),
    ...(progressed && policy === undefined ? { progressPolicy: { contract: SERIES_PROGRESS_CONTRACT, previous: reference(head), from: attempt.ordinal } } : {}),
    attempts: held.attempts.map(item => (item.ordinal === request.attempt ? closed : copyAttempt(item, held.achievedOrder))),
  } as SeriesDraft);
  return change(address, value, head.revision, completionGuards, head);
}

function prepareResume(store: Store, request: AnyResumeSeriesRequest): SeriesResult<Prepared> {
  requireStore(store);
  check(isPlainObject(request), "series_request_invalid", "A stopped series is continued through a request object");
  const address = requireAddress(request);
  check(Number.isSafeInteger(request.stop) && request.stop >= 1,
    "series_request_invalid", "A continuation names the attempt whose stop it answers");
  check(groundProblem(request, isGroundRecord) === null,
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
  const obsolete = currentLineProblem(store, address, reference(head));
  if (obsolete) return obsolete;
  const lineAdmission = mutationAdmission(store, head);
  if (!lineAdmission.ok) return lineAdmission;
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
  return change(address, value, head.revision, lineAdmission.value.guards, head, grounded.write === null ? [] : [grounded.write]);
}

function prepareEscalate(store: Store, request: AnyEscalateSeriesRequest): SeriesResult<Prepared> {
  requireStore(store);
  check(isPlainObject(request), "series_request_invalid", "A stop is escalated through a request object");
  const address = requireAddress(request);
  check(Number.isSafeInteger(request.stop) && request.stop >= 1,
    "series_request_invalid", "An escalation names the attempt whose stop it sends to the owner");
  check(isGroundRecord(request.review),
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
  const obsolete = currentLineProblem(store, address, reference(head));
  if (obsolete) return obsolete;
  const lineAdmission = mutationAdmission(store, head);
  if (!lineAdmission.ok) return lineAdmission;
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
  return change(address, value, head.revision, lineAdmission.value.guards, head, grounded.write === null ? [] : [grounded.write]);
}

// ---------------------------------------------------------------------------
// LP6 (№3325 §5): progress-reconciled. A saved stop the rules of the new era prove false is lifted by a transition record
// of its own — never by a string of explanation, a model's decision or a pretended owner's decision.

export const SERIES_PROGRESS_TRANSITION_KIND = "om-series-progress-transition";
export const SERIES_PROGRESS_TRANSITION_CONTRACT = "om-series-progress-transition/v1" as const;
export type ReconcileSeriesRequest = SeriesRequest & { readonly stop: number };
/** The proved transition of one saved stop: its exact source revision, the stop and every counted row of its window. */
export interface SeriesProgressTransition {
  readonly contract: typeof SERIES_PROGRESS_TRANSITION_CONTRACT; readonly project: string; readonly series: Ref; readonly stop: number;
  readonly rows: readonly WindowProgressRow[];
}
/** Deterministic in the exact source state and its stop: a repeat addresses that state, never "whatever stop stands now". */
export function seriesProgressTransitionId(project: string, series: Ref, stop: number): string {
  return `${SERIES_PROGRESS_TRANSITION_KIND}:${project}:${hashJson({ series: exactRef(series), stop } as unknown as Json)}`;
}
/** The results a transition puts into the history, in the one order a reconciliation holds them. */
const reconciledOf = (record: SeriesProgressTransition): { goal: string; key: string }[] =>
  ordered(record.rows.flatMap(row => row.achieved.map(key => ({ goal: row.goal.key, key }))), row => compositeKey([row.goal, row.key]));
const rowOf = (row: WindowProgressRow): WindowProgressRow => ({ ordinal: row.ordinal, goal: goalOf(row.goal), close: exactRef(row.close),
  result: row.result, achieved: [...row.achieved], sources: row.sources.map(exactRef) });
/**
 * The one derivation of a transition, for its producer and its reader: the stop standing at the end of the exact source
 * revision of a block series, its counted window read by the common subject derivation of repeat-gate over the decided
 * fields the line held then. Historical proof only: the saved refs in their own eras, never today's B1 head.
 */
function progressTransitionValue(store: Store, project: string, source: Ref, held: Sealed<AnyRepairSeries>, context: Context):
  SeriesResult<SeriesProgressTransition> {
  if (!("block" in held)) return problem("series_invalid", "Only a block series is reconciled by the rules of LP6", context, "owner");
  const derived = walk(plainSeries(held as unknown as AnyRepairSeries));
  if (derived.stop === null) return problem("stop_absent", "No saved stop stands at the end of this revision of the series", context, "stop");
  const rows = deriveWindowProgress(store, project, { series: source, ordinals: derived.stop.attempts });
  if (!rows.ok) return rows;
  return delivered({ contract: SERIES_PROGRESS_TRANSITION_CONTRACT, project, series: exactRef(source), stop: derived.stop.attempt,
    rows: rows.value.map(row => rowOf(row as WindowProgressRow)) }) as SeriesResult<SeriesProgressTransition>;
}
/** Reads a transition at its exact reference: its own address, and equal to the one derivation of its saved source. */
export function readSeriesProgressTransitionAt(store: Store, project: string, ref: Ref): SeriesResult<Sealed<Revision<SeriesProgressTransition>>> {
  requireStore(store); requireProject(project);
  check(isRef(ref), "series_request_invalid", "A progress transition is read at its exact reference");
  // NR1 (№3600): a trusted read — the transition was written once as the derivation of its stop and window.
  return withHistoricalReads(() => historicalRead(store, { reader: 'A3.progress-transition', project, ref, parameters: null }, () => {
    const read = readRecord<SeriesProgressTransition>(store, ref, { unit: UNIT, target: ref.id, kind: SERIES_PROGRESS_TRANSITION_KIND,
      idPrefix: `${SERIES_PROGRESS_TRANSITION_KIND}:${project}:` });
    return (read.ok ? delivered(read.value as Revision<SeriesProgressTransition>) : read) as SeriesResult<Sealed<Revision<SeriesProgressTransition>>>;
  }, () => problem("series_invalid", "A progress transition cannot prove itself", { target: ref.id, ref }, "history")));
}
function prepareReconcile(store: Store, request: ReconcileSeriesRequest): SeriesResult<Prepared> {
  requireStore(store);
  check(isPlainObject(request), "series_request_invalid", "A stopped series is reconciled through a request object");
  const address = requireAddress(request);
  check(address.owner.kind === "block", "series_request_invalid", "Only a block series is reconciled by the rules of LP6");
  check(Number.isSafeInteger(request.stop) && request.stop >= 1, "series_request_invalid", "A reconciliation names the attempt whose stop it answers");
  const current = currentSeries(store, address);
  if (!current) return missing(address);
  if (!current.ok) return current;
  const head = current.value, held = head.value as RepairSeries;
  const context: Context = { target: address.id, ref: reference(head) };
  // T5: the stop this transition answers is reconciled already — a repeat, a reopen or a repeat after later actions finds
  // that very transition and writes nothing; it never lands on a stop saved since then.
  const already = (held.reconciliations ?? []).find(item => item.after === request.stop);
  if (already) {
    const saved = readSeriesProgressTransitionAt(store, address.project, already.transition);
    return saved.ok ? unchanged(head) : saved;
  }
  const obsolete = currentLineProblem(store, address, reference(head));
  if (obsolete) return obsolete;
  const lineAdmission = mutationAdmission(store, head);
  if (!lineAdmission.ok) return lineAdmission;
  if (held.stop === null || held.stop.attempt !== request.stop)
    return problem("stop_absent", `No saved stop stands after attempt ${request.stop} in this series`, context, "stop");
  const derived = progressTransitionValue(store, address.project, reference(head), held, context);
  if (!derived.ok) return derived;
  const record = derived.value;
  const id = seriesProgressTransitionId(address.project, reference(head), request.stop);
  const transition: Ref = { id, revision: 1, hash: hashJson(record as unknown as Json) };
  // The boundary is activated here, at the attempt after the stop, when no close of the new era activated it before.
  const value = settled({
    ...plainSeries(held),
    progressPolicy: held.progressPolicy ?? { contract: SERIES_PROGRESS_CONTRACT, previous: reference(head),
      from: held.inherited.length + held.attempts.length + 1 },
    reconciliations: [...(held.reconciliations ?? []).map(reconciliationOf),
      reconciliationOf({ after: request.stop, transition, achieved: reconciledOf(record) })],
  } as SeriesDraft);
  return change(address, value, head.revision, lineAdmission.value.guards, head,
    [{ id, kind: SERIES_PROGRESS_TRANSITION_KIND, expected: 0, value: record as unknown as Json }]);
}

/** Where a record of a ground comes from, what it holds, and — when it is written with this change — its write. */
interface Located {
  readonly ref: Ref;
  readonly value: unknown;
  readonly write: PreparedWrite | null;
}

/** The record the request's own ground stands on: the review, the confirmation of the fix, or the owner's decision. */
function groundOf(store: Store, address: Address, request: ContinuationRequest): SeriesResult<never> | Located {
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
): SeriesResult<never> | Located {
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
function asRecord(code: "record_foreign" | "revision_conflict", message: string, address: Address, field: string, ref?: Ref): SeriesResult<never> {
  return refuse(code, message, { unit: UNIT, target: address.id, field, ref }, "producer");
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
  store: Store, address: Address, basis: ContinuationBasis, value: unknown, held: AnyRepairSeries, stop: SeriesStop, context: Context,
): SeriesResult<never> | null {
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
  if (record['projectId'] !== address.project || (address.owner.kind === "block"
    ? record['block'] !== address.owner.block || Object.hasOwn(record, "owner")
    : Object.hasOwn(record, "block") || canonical(record['owner'] ?? null) !== canonical(address.owner))) return { field: address.owner.kind === "block" ? ".block" : ".owner" };
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
function weighReview(value: unknown, address: Address, stop: SeriesStop, context: Context, wanted: ReviewEnd): SeriesResult<never> | null {
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
function weighDecision(value: unknown, address: Address, stop: SeriesStop, context: Context): SeriesResult<never> | null {
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
  store: Store, address: Address, basis: InputsContinuation, value: unknown, held: AnyRepairSeries, stop: SeriesStop, context: Context,
): SeriesResult<never> | null {
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
function linkedRefusals(store: Store, address: Address, claimed: readonly ClaimedRefusal[], context: Context): SeriesResult<never> | null {
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

function currentSeries(store: Store, address: Address): SeriesResult<Revision<AnyRepairSeries>> | null {
  // The head revision of the exact id is what a reference to it is made of; the record is then read as any record is,
  // so a foreign kind standing at this address is refused instead of being extended.
  const head = store.get<AnyRepairSeries>(address.id);
  if (!head) return null;
  const read = readRecord<AnyRepairSeries>(store, reference(head), {
    unit: UNIT, target: address.id, kind: REPAIR_SERIES_KIND, id: address.id,
  });
  // NR1 (№3600): the head was written by its transition producer; it is read, not checked again.
  if (!read.ok) return read;
  return { ok: true, value: read.value as Revision<AnyRepairSeries> };
}

const missing = (address: Address): SeriesResult<never> =>
  refuse("series_missing", "No series of repairs stands for this block and line",
    { unit: UNIT, target: address.id }, "producer");

const running = (value: AnyRepairSeries): Attempt | null => value.attempts.find(item => item.outcome === null) ?? null;

// ---------------------------------------------------------------------------
// What the series derives for itself: the verdict of every attempt, the count, the saved stop and the ladder.

interface Walk {
  readonly verdicts: ReadonlyMap<number, AttemptVerdict>;
  readonly achieved: ReadonlyMap<string, ReadonlySet<string>>;
  readonly withoutProgress: number;
  readonly ladder: SeriesLadder;
  readonly stop: SeriesStop | null;
  readonly stops: readonly StopHistoryEntry[];
  readonly flaw: { readonly field: string; readonly message: string } | null;
  /** LP6: the keys of decided input fields the whole line holds — its outcomes and its reconciliations. */
  readonly fields: ReadonlySet<string>;
}

// The history as the walk fills it in: one draft per saved stop, completed as the walk reaches what answered it and
// what closed the window it opened.
interface StopDraft {
  attempt: number;
  attempts: readonly number[];
  goals: readonly string[];
  escalation: Escalation | null;
  continuation: Continuation | null;
  window: StopWindow | null;
  reconciliation?: Ref;
}

type SeriesDraft = Omit<RepairSeries, "withoutProgress" | "ladder" | "stop"> | Omit<MechanismRepairSeries, "withoutProgress" | "ladder" | "stop">;

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
 * of ITS goal, the count from the verdicts, and the stop from the count. A history that could not have happened is
 * named as a flaw rather than walked on: an attempt standing after a stop nothing had continued, and an escalation or
 * a continuation recorded after a LATER attempt than the stop it would answer, are both refused at every reading.
 * A key already in that history is no progress however it was reached, and a key stays in the history once accepted —
 * so the re-taking of a lost result is not a new achievement either. A cancelled result makes the cycle a conflict of
 * results rather than a success.
 */
function walk(value: SeriesDraft): Walk {
  const verdicts = new Map<number, AttemptVerdict>();
  const achieved = new Map<string, Set<string>>();
  // Each transition is kept with the position it is stored at, so that a refusal names the field it was read from.
  const lifts = new Map(value.continuations.map((item, index) => [item.after, { item, index }]));
  const used = new Set<number>();
  const raises = new Map(value.escalations.map((item, index) => [item.after, { item, index }]));
  const raised = new Set<number>();
  let withoutProgress = 0;
  let stop: SeriesStop | null = null;
  let ladder = ladderStart();
  let flaw: { readonly field: string; readonly message: string } | null = null;
  let run: { ordinals: number[]; goals: string[] } = { ordinals: [], goals: [] };
  // LP6: the boundary of the new rules, the line history of decided input fields, and the reconciled stops.
  const policy = "block" in value ? value.progressPolicy : undefined;
  const newEra = (attempt: Attempt): boolean => policy !== undefined && attempt.ordinal >= policy.from;
  const fields = new Set<string>();
  const settles = new Map((("block" in value ? value.reconciliations : undefined) ?? []).map((item, index) => [item.after, { item, index }]));
  const settled = new Set<number>();
  // The history of the stops, and the two drafts the walk is in the middle of: the stop standing at this point, and
  // the one whose continuation opened the window the walk is inside.
  const stops: StopDraft[] = [];
  let saved: StopDraft | null = null;
  let inside: StopDraft | null = null;
  // A window is the run of attempts a stop is counted in. One opens at the start, at every new accepted result, and
  // at every recorded continuation — that is what "again up to three attempts" is made of.
  const opened = (): void => { withoutProgress = 0; run = { ordinals: [], goals: [] }; };

  const step = (attempt: Attempt): void => {
    // A SAVED STOP CLOSES THE WINDOW. While it stands no attempt of this series follows it — a restart does not lift
    // it and only a ground of its rung opens a new window — and a transition recorded after a LATER attempt answers no
    // stop this history holds. The two are one forged history seen from two sides: an escalation "after: 4" beside the
    // stop saved after attempt 3 was read as that stop's own and handed to it, so the checks stand together and each
    // names the field it was read from. The public operations already refuse both live (series_stopped when an attempt
    // is begun past a standing stop, stop_absent when a continuation or an escalation names another ordinal); this is
    // the same rule applied to a record that arrives already written.
    if (stop !== null && attempt.ordinal !== stop.attempt) {
      const standing = stop.attempt;
      const raise = raises.get(attempt.ordinal);
      const lift = lifts.get(attempt.ordinal);
      if (raise !== undefined) {
        flaw ??= {
          field: `escalations.${raise.index}.after`,
          message: `An escalation of attempt ${attempt.ordinal} is not the escalation of the stop saved after attempt ${standing}, the only stop that stands there`,
        };
      } else if (lift !== undefined) {
        flaw ??= {
          field: `continuations.${lift.index}.after`,
          message: `A continuation of attempt ${attempt.ordinal} is not the continuation of the stop saved after attempt ${standing}, the only stop that stands there`,
        };
      } else {
        flaw ??= {
          field: `attempts.${attempt.ordinal}`,
          message: `Attempt ${attempt.ordinal} was begun while the stop saved after attempt ${standing} still stood, and no ground had continued it`,
        };
      }
    }
    if (attempt.outcome === null) return;
    const history = achieved.get(attempt.goal.key) ?? new Set<string>();
    // LP6: a decided input field is new or known against the whole line, whatever composite goal asked for it. No record
    // before LP6 holds such a key, so the old history is walked exactly as before.
    const known = (key: string): boolean => key.startsWith(INPUT_FIELD_KEY_PREFIX) ? fields.has(key) : history.has(key);
    const fresh = attempt.outcome.achieved.filter(item => !known(item.key)).map(item => item.key);
    // LP6: a clean administrative end by the replaced B1 of the attempt's own area is neutral — no count, no reset.
    const administrative = newEra(attempt) && (attempt.outcome.progress?.administrative ?? null) !== null;
    const verdict: AttemptVerdict = attempt.outcome.reason === "awaiting-owner" || administrative ? "neutral"
      : attempt.outcome.cancelled.length > 0 ? "conflict"
        : fresh.length > 0 ? "progress" : "none";
    verdicts.set(attempt.ordinal, verdict);
    for (const item of attempt.outcome.achieved) {
      history.add(item.key);
      if (item.key.startsWith(INPUT_FIELD_KEY_PREFIX)) fields.add(item.key);
    }
    achieved.set(attempt.goal.key, history);

    if (verdict === "progress") {
      opened();
      // A new accepted result closes the window it was reached in, whichever goal it belongs to: what stops the series
      // afterwards is counted in the window this result opened, not in the one before it.
      if (inside !== null) {
        inside.window = { ended: "progress", at: attempt.ordinal, goal: attempt.goal.key, accepted: fresh };
        inside = null;
      }
      // Only a new accepted result of the goal the ladder stands for returns it to the start; a result of another
      // goal opens a window, as any progress does, but leaves the rung where it was.
      if (ladder.goals.includes(attempt.goal.key)) ladder = ladderStart();
    } else if (verdict !== "neutral") {
      withoutProgress += 1;
      run.ordinals.push(attempt.ordinal);
      if (!run.goals.includes(attempt.goal.key)) run.goals.push(attempt.goal.key);
      if (withoutProgress >= STOP_AFTER && stop === null) {
        stop = stopOf(attempt, run.ordinals, run.goals, ladder);
        // This stop closes the window that was open, and becomes the one the history is collecting next.
        if (inside !== null) { inside.window = { ended: "stop", at: attempt.ordinal }; inside = null; }
        saved = {
          attempt: stop.attempt, attempts: [...stop.attempts], goals: [...stop.goals],
          escalation: null, continuation: null, window: null,
        };
        stops.push(saved);
      }
    }
    // An escalation answers the stop of this attempt BEFORE any continuation of it: the owner decides on a stop
    // that was escalated to them, never the other way round.
    if (raises.has(attempt.ordinal)) {
      raised.add(attempt.ordinal);
      if (stop === null || ladder.rung !== FIRST_RUNG) flaw ??= { field: "escalations", message: "An escalation stands where no stop of the first rung was saved" };
      else {
        // It answers the stop that stands, which is the one the history is collecting.
        if (saved !== null) saved.escalation = plainEscalation(raises.get(attempt.ordinal)!.item);
        // The stop STAYS, the count stays and no window opens: only the rung, and what the stop now asks for, move.
        ladder = sentToOwner(ladder, stop);
        stop = { ...stop, attempts: [...stop.attempts], goals: [...stop.goals], resume: resumeOf(stop.attempt, ladder) };
      }
    }
    const lift = lifts.get(attempt.ordinal)?.item;
    if (lift) {
      used.add(attempt.ordinal);
      // A continuation standing where no stop was raised, or on a ground the rung it answers does not admit, is a
      // ground for nothing; the record is refused, not read.
      if (stop === null) flaw ??= { field: "continuations", message: "A continuation stands where no stop was saved" };
      else if (!ladder.grounds.includes(lift.ground)) {
        flaw ??= { field: "continuations", message: `A stop at rung ${ladder.rung} of the ladder is not continued on the ground "${lift.ground}"` };
      } else {
        if (saved !== null) {
          saved.continuation = plainContinuation(lift);
          // The window this continuation opens is the one the history follows until a result or the next stop ends it.
          inside = saved;
          saved = null;
        }
        ladder = climbed(ladder, stop);
        stop = null;
        opened();
      }
    }
    // LP6 (№3325 §5): a reconciled stop is lifted without a ground of the ladder. It opens a new window with a count of
    // zero, neither climbs nor resets the rung and adds no window to the ladder; the results it proved enter the
    // history of their original goals and of the line. The old outcomes and verdicts stay as they were written.
    const settle = settles.get(attempt.ordinal)?.item;
    if (settle) {
      settled.add(attempt.ordinal);
      if (stop === null || stop.attempt !== attempt.ordinal || lift !== undefined) {
        flaw ??= { field: "reconciliations", message: `A reconciliation after attempt ${attempt.ordinal} answers no stop that stands there alone` };
      } else {
        for (const row of settle.achieved) {
          const goal = achieved.get(row.goal) ?? new Set<string>();
          goal.add(row.key);
          achieved.set(row.goal, goal);
          if (row.key.startsWith(INPUT_FIELD_KEY_PREFIX)) fields.add(row.key);
        }
        if (saved !== null) {
          saved.reconciliation = exactRef(settle.transition);
          inside = saved;
          saved = null;
        }
        stop = null;
        opened();
      }
    }
  };

  for (const attempt of value.inherited) step(attempt);
  for (const attempt of value.attempts) step(attempt);
  if (settled.size !== settles.size) flaw ??= { field: "reconciliations", message: "A reconciliation follows an attempt this series does not hold" };
  if (used.size !== lifts.size) flaw ??= { field: "continuations", message: "A continuation follows an attempt this series does not hold" };
  if (raised.size !== raises.size) flaw ??= { field: "escalations", message: "An escalation follows an attempt this series does not hold" };
  // A window still open is said to be open: what will end it is not yet in the history. Only the window of the LAST
  // continuation can be in that state, because every later continuation follows a stop, and a stop closes it.
  for (const draft of stops) if ((draft.continuation !== null || draft.reconciliation !== undefined) && draft.window === null) draft.window = { ended: "open" };
  return { verdicts, achieved, withoutProgress, ladder, stop, stops, flaw, fields };
}

/**
 * LP6: the decided input fields a line holds before one of its attempts, as the one walk of its rules derives them —
 * its outcomes and its reconciliations up to there. Whoever weighs a later attempt reads the line's history here.
 */
export function decidedFieldsBefore(value: Sealed<AnyRepairSeries>, ordinal: number): string[] {
  const plain = plainSeries(value as unknown as AnyRepairSeries);
  const before = <T extends { readonly after: number }>(items: readonly T[]): T[] => items.filter(item => item.after < ordinal);
  const draft = { ...plain, inherited: plain.inherited.filter(item => item.ordinal < ordinal),
    attempts: plain.attempts.filter(item => item.ordinal < ordinal),
    continuations: before(plain.continuations), escalations: before(plain.escalations),
    ...("reconciliations" in plain && plain.reconciliations !== undefined ? { reconciliations: before(plain.reconciliations) } : {}) } as SeriesDraft;
  return [...walk(draft).fields].sort();
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
function settled(draft: SeriesDraft): AnyRepairSeries {
  const derived = walk(draft);
  const verdict = (attempt: Attempt): Attempt =>
    ({ ...copyAttempt(attempt, draft.achievedOrder), verdict: derived.verdicts.get(attempt.ordinal) ?? null });
  return {
    ...(draft.achievedOrder === undefined ? {} : { achievedOrder: draft.achievedOrder }),
    projectId: draft.projectId, ...ownerFields(seriesOwner(draft)), line: draft.line, slice: draft.slice,
    ...(draft.contract === undefined ? {} : { contract: draft.contract, activation: sealed(draft.activation!) }),
    ...("owner" in draft ? { scope: normalizedScope(draft.scope), admissions: sealed(draft.admissions) } : {}),
    predecessor: draft.predecessor === null ? null : exactRef(draft.predecessor),
    basis: draft.basis === null ? null : plainBasis(draft.basis),
    inherited: draft.inherited.map(verdict),
    attempts: draft.attempts.map(verdict),
    continuations: draft.continuations.map(plainContinuation),
    escalations: draft.escalations.map(plainEscalation),
    withoutProgress: derived.withoutProgress,
    ladder: derived.ladder,
    stop: derived.stop,
    ...("progressPolicy" in draft && draft.progressPolicy !== undefined ? { progressPolicy: policyOf(draft.progressPolicy) } : {}),
    ...("reconciliations" in draft && draft.reconciliations !== undefined ? { reconciliations: draft.reconciliations.map(reconciliationOf) } : {}),
  } as AnyRepairSeries;
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
const achievedKey = (order: AchievedOrder | undefined) => (item: Achievement): string => order === ACHIEVED_ORDER
  ? compositeKey([item.key, item.basis.id, item.basis.revision, item.basis.hash])
  // The fec6932 key, kept for the revisions of its era: their saved order is read and repeated as it was written.
  : `${item.key} ${item.basis.id} ${item.basis.revision} ${item.basis.hash}`;
const outcomeOf = (outcome: AttemptOutcome | ClaimedOutcome, order: AchievedOrder | undefined): AttemptOutcome => ({
  reason: outcome.reason,
  achieved: ordered(outcome.achieved, achievedKey(order))
    .map(item => ({ key: item.key, basis: exactRef(item.basis) })),
  cancelled: ordered(outcome.cancelled, key => key),
  // Multiplicity is kept: two refusals are two, and only their order is decided here.
  refusals: ordered(outcome.refusals, item => item.row).map(item => ({ row: item.row })),
  ...(outcome.progress === undefined ? {} : { progress: progressOf(outcome.progress) }),
});
const refsInOrder = (refs: readonly Ref[]): Ref[] => ordered(refs.map(exactRef), item => canonical(item));
const progressOf = (progress: AttemptProgress): AttemptProgress => ({ contract: progress.contract,
  administrative: progress.administrative === null ? null : progress.administrative.kind === "group-rejected"
    ? { kind: "group-rejected", rejection: exactRef(progress.administrative.rejection), sources: refsInOrder(progress.administrative.sources) }
    : { kind: progress.administrative.kind, input: exactRef(progress.administrative.input),
      replacements: refsInOrder(progress.administrative.replacements), sources: refsInOrder(progress.administrative.sources) } });
const policyOf = (policy: ProgressPolicy): ProgressPolicy =>
  ({ contract: policy.contract, previous: policy.previous === null ? null : exactRef(policy.previous), from: policy.from });
const reconciliationOf = (item: Reconciliation): Reconciliation => ({ after: item.after, transition: exactRef(item.transition),
  achieved: ordered(item.achieved.map(row => ({ goal: row.goal, key: row.key })), row => compositeKey([row.goal, row.key])) });

const copyAttempt = (attempt: Attempt, order: AchievedOrder | undefined): Attempt => ({
  ordinal: attempt.ordinal, goal: goalOf(attempt.goal),
  outcome: attempt.outcome === null ? null : outcomeOf(attempt.outcome, order),
  verdict: attempt.verdict,
  ...(attempt.terminal === undefined ? {} : { terminal: exactRef(attempt.terminal) }),
});

const plainSeries = (value: AnyRepairSeries): SeriesDraft => ({
  ...(value.achievedOrder === undefined ? {} : { achievedOrder: value.achievedOrder }),
  projectId: value.projectId, ...ownerFields(seriesOwner(value)), line: value.line, slice: value.slice,
  ...(value.contract === undefined ? {} : { contract: value.contract, activation: sealed(value.activation!) }),
  ...("owner" in value ? { scope: normalizedScope(value.scope), admissions: sealed(value.admissions) } : {}),
  predecessor: value.predecessor === null ? null : exactRef(value.predecessor),
  basis: value.basis === null ? null : plainBasis(value.basis),
  inherited: value.inherited.map(attempt => copyAttempt(attempt, value.achievedOrder)),
  attempts: value.attempts.map(attempt => copyAttempt(attempt, value.achievedOrder)),
  continuations: value.continuations.map(plainContinuation),
  escalations: value.escalations.map(plainEscalation),
  ...(!("block" in value) || value.progressPolicy === undefined ? {} : { progressPolicy: policyOf(value.progressPolicy) }),
  ...(!("block" in value) || value.reconciliations === undefined ? {} : { reconciliations: value.reconciliations.map(reconciliationOf) }),
} as SeriesDraft);

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
  if (!isPlainObject(value) || !exactKeys(value, Object.hasOwn(value as object, "progress") ? [...OUTCOME_KEYS, "progress"] : OUTCOME_KEYS)) return "outcome";
  const outcome = value as Record<string, unknown>;
  if (Object.hasOwn(outcome, "progress")) {
    const flawed = progressProblem(outcome['progress']);
    if (flawed !== null) return flawed;
  }
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

/** The LP6 progress of an outcome: its contract and either no administrative end or a complete, non-empty one. */
function progressProblem(value: unknown): string | null {
  if (!isPlainObject(value) || !exactKeys(value, ["contract", "administrative"]) || (value as Record<string, unknown>)['contract'] !== ATTEMPT_PROGRESS_CONTRACT)
    return "progress";
  const end = (value as Record<string, unknown>)['administrative'];
  if (end === null) return null;
  const group = isPlainObject(end) && (end as Record<string, unknown>)['kind'] === "group-rejected";
  if (group ? !exactKeys(end as object, ["kind", "rejection", "sources"]) || !isRef((end as Record<string, unknown>)['rejection'])
    : !isPlainObject(end) || !exactKeys(end, ["kind", "input", "replacements", "sources"])
      || (end as Record<string, unknown>)['kind'] !== "area-input-replaced" || !isRef((end as Record<string, unknown>)['input']))
    return "progress.administrative";
  for (const field of group ? ["sources"] : ["replacements", "sources"]) {
    const list = (end as Record<string, unknown>)[field];
    if (!Array.isArray(list) || list.length === 0 || !list.every(isRef) || new Set(list.map(item => canonical(item))).size !== list.length)
      return `progress.administrative.${field}`;
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

// Own keys only, and exactly these: a value parsed from JSON may carry "__proto__" as an own field, and an unexpected
// field is a difference in content, not a detail to ignore.
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  const own = Object.keys(value as object);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value as object, key));
}

// A refusal of this unit goes back to whoever produced what it read — or, when what is missing is a decision only the
// owner can take, to the owner. The series rules on the history it keeps and on nothing else, and switches nothing by
// refusing (T8): a stop stays a stop, and no window opens because a ground was turned away.
function problem(code: SeriesCode, message: string, context: Context, field: string, route: RefusalRoute = "producer"): SeriesResult<never> {
  return refuse(code, message, { unit: UNIT, target: context.target, field, ref: context.ref }, route);
}

function requireStore(store: unknown): asserts store is Store {
  check(store instanceof Store, "series_request_invalid", "A series is read and written through a store");
}

/** The addressing slice contains semantic tasks and allowed accepted consumers; revisions remain evidence. */
export interface MechanismSlice {
  contract: 'addressing-slice/v1'; owner: MechanismOwner;
  questions: { target: string; field: string; classification: unknown; task: unknown; producer: unknown; protected: unknown; decision?: unknown }[];
  consumers: { id: string; kind: string }[];
}
export interface MechanismProjection { slice: string; value: MechanismSlice; guards: TransactionGuard[]; references: Ref[] }
export interface SeriesAdmissionProof extends MechanismProjection {
  goal: Omit<AttemptGoal, 'key'>; gaps: { id: string; target: string; field: string }[];
}
class MechanismFailure extends Error { constructor(readonly result: Failed<SeriesResultCode>) { super(result.refusal.message); } }
function mechanismTake<T>(result: SeriesResult<T>): T { if (!result.ok) throw new MechanismFailure(result); return result.value; }
function mechanismCheck(condition: unknown, target: string, field: string, message: string): asserts condition {
  if (!condition) mechanismTake(problem('series_invalid', message, { target, ref: undefined }, field));
}
function mechanismResult<T>(action: () => T): SeriesResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); } catch (error) { if (error instanceof MechanismFailure) return error.result; throw error; }
  });
}
const mechanismObject = (value: unknown): value is Record<string, any> => isPlainObject(value);
const guardsUnique = (guards: readonly TransactionGuard[]): TransactionGuard[] => ordered(uniqueTransactionGuards(guards), canonical);
const refsUnique = (refs: readonly Ref[]): Ref[] => ordered([...new Map(refs.map(ref => [canonical(ref), exactRef(ref)])).values()], canonical);
function normalizedScope(scope: Sealed<GapReadRequest>): GapReadRequest {
  return sealed({ sources: scope.sources, records: ordered(scope.records, canonical) }) as GapReadRequest;
}
function requireScope(scope: unknown): asserts scope is GapReadRequest {
  check(mechanismObject(scope) && exactKeys(scope, ['sources', 'records']) && isPlainObject(scope.sources)
    && isText(scope.sources.project) && isRef(scope.sources.input)
    && Array.isArray(scope.records) && scope.records.every(isRef), 'series_request_invalid', 'A mechanism scope requires the complete exact D1 source and record set');
}
function normalizedAdmission(admission: MechanismAdmission): MechanismAdmission {
  return { gaps: normalizedScope(admission.gaps), routes: exactRef(admission.routes), batch: admission.batch };
}
function requireAdmission(admission: unknown): asserts admission is MechanismAdmission {
  check(mechanismObject(admission) && exactKeys(admission, ['gaps', 'routes', 'batch']) && isRef(admission.routes)
    && isText(admission.batch), 'series_request_invalid', 'Admission needs the full D1 and one exact selected M6 batch');
  requireScope(admission.gaps);
}
function mechanismGaps(store: Store, project: string, scope: Sealed<GapReadRequest>) {
  return historicalRead(store, { reader: 'A3.3.full-gaps', project, ref: scope.sources.input, parameters: normalizedScope(scope) as unknown as Json },
    () => mechanismTake(readGaps(store, scope as GapReadRequest)), () => {
      mechanismCheck(false, scope.sources.input.id, 'scope.history', 'The complete D1 basis must not form a cycle');
      throw new Error('Unreachable cycle refusal');
    });
}
function mechanismProjection(store: Store, project: string, scope: Sealed<GapReadRequest>, current: boolean): MechanismProjection {
  const historical = historicalRead(store, { reader: 'A3.3.mechanism-slice', project, ref: scope.sources.input,
    parameters: normalizedScope(scope) as unknown as Json }, () => deriveMechanismProjection(store, project, scope), () => {
      mechanismCheck(false, scope.sources.input.id, 'scope.history', 'A mechanism slice must not depend cyclically on itself');
      throw new Error('Unreachable cycle refusal');
    });
  if (!current) return historical;
  const full = mechanismGaps(store, project, scope);
  const prepared = mechanismTake(prepareCurrentGaps(store, { sources: full.sources as GapReadRequest['sources'], records: [...scope.records] }));
  const guards = guardsUnique([...prepared.guards, scope.sources.input, ...scope.records]);
  for (const ref of guards) {
    const head = store.get(ref.id);
    mechanismCheck('absent' in ref ? head === null : head && sameRef(reference(head), ref), ref.id, 'head', 'A current addressing prerequisite has changed');
  }
  return { ...historical, guards, references: refsUnique([...historical.references, ...prepared.references]) };
}
function deriveMechanismProjection(store: Store, project: string, scope: Sealed<GapReadRequest>): MechanismProjection {
  const full = mechanismGaps(store, project, scope);
  mechanismCheck(full.sources.project === project, project, 'scope.project', 'The complete gap snapshot belongs to this project');
  const source = full.sources as GapReadRequest['sources'];
  const input = mechanismTake(readOmInput(store, project, source.input));
  const operations = mechanismTake(readFrameBasis(store, source.operations.frame));
  const references: Ref[] = [source.input, source.graph, ...scope.records, ...operations.references];
  const guards: TransactionGuard[] = [];
  const catalog = new Map(operations.upper.nodes.map(node => [node.id, { id: node.id, kind: node.kind }]));
  if (operations.accepted) for (const node of operations.accepted.graph.nodes.filter(node => node.kind === 'operation'))
    catalog.set(node.id, { id: node.id, kind: node.kind });
  if (!('state' in source.works)) {
    const works = mechanismTake(readFrameBasis(store, source.works.frame));
    references.push(...works.references);
    if (works.accepted) for (const node of works.accepted.graph.nodes.filter(node => node.kind === 'work'))
      catalog.set(node.id, { id: node.id, kind: node.kind });
  }
  const questions: MechanismSlice['questions'] = [];
  for (const gap of full.collection.gaps.filter(gap => gap.code === 'question_unaddressed'
    && gap.mechanism === 'M5:addressing' && gap.field === 'address')) {
    const matching = input.value.input.questions.filter(question => question.id === gap.target);
    mechanismCheck(matching.length === 1, gap.target, 'question', 'The full D1 task must match exactly one original B1 question');
    const question = matching[0]!, { source: producerRef, addressedBy, ...task } = question;
    const rawGraph = mechanismTake(readRecord<{ nodes: { id: string }[] }>(store, source.graph,
      { unit: UNIT, target: gap.target, id: `graph:${project}`, kind: 'graph' }));
    mechanismCheck(!rawGraph.value.nodes.some(node => node.id === question.consumer) || catalog.has(question.consumer),
      gap.target, 'consumer', 'An already supplied consumer needs its exact accepted layer, not an unaccepted graph node');
    const producer = input.value.input.sources.find(row => row.id === producerRef.id);
    mechanismCheck(producer, gap.target, 'producer', 'The task must have a verified stable producer');
    const { id: _id, evidence: _evidence, addressedBy: _addressedBy, ...classification } = gap;
    const row: MechanismSlice['questions'][number] = {
      target: gap.target, field: gap.field, classification,
      task, producer: { id: producerRef.id, contractVersion: producer.contractVersion },
      protected: { ...(catalog.has(question.consumer) ? { consumer: question.consumer } : {}),
        ...(question.kind !== null ? { kind: question.kind } : {}) },
    };
    if (addressedBy) {
      // B1 has already proved this exact F5.3 derivation. Its semantic decision, not its revision, is a condition.
      const decision = mechanismTake(readRecord<{ decision: unknown }>(store, addressedBy,
        { unit: UNIT, target: gap.target, kind: 'input-decision', idPrefix: inputDecisionNamespace(project) }));
      row.decision = decision.value.decision; references.push(addressedBy);
    }
    questions.push(row);
  }
  const value: MechanismSlice = { contract: 'addressing-slice/v1', owner: { kind: 'mechanism', mechanism: 'M5:addressing' },
    questions: ordered(questions, row => canonical([row.target, row.field])), consumers: ordered([...catalog.values()], canonical) };
  return { slice: hashJson(value), value, guards: guardsUnique(guards), references: refsUnique(references) };
}
export function projectMechanismSlice(store: Store, project: string, scope: Sealed<GapReadRequest>, current = false): SeriesResult<Sealed<MechanismProjection>> {
  requireStore(store); requireProject(project); requireScope(scope);
  check(typeof current === 'boolean', 'series_request_invalid', 'The reading mode must be explicit');
  return mechanismResult(() => mechanismProjection(store, project, normalizedScope(scope), current));
}
function mechanismAdmission(store: Store, request: MechanismSeriesRequest, admission: MechanismAdmission, current: boolean, managed?: { series: Ref; attempt: number }): SeriesAdmissionProof {
  const historical = historicalRead(store, { reader: 'A3.3.mechanism-admission', project: request.project, ref: admission.routes,
    parameters: { request, admission: normalizedAdmission(admission) } as unknown as Json },
    () => deriveMechanismAdmission(store, request, admission), () => {
      mechanismCheck(false, admission.routes.id, 'admission.history', 'A mechanism admission must not depend cyclically on itself');
      throw new Error('Unreachable cycle refusal');
    });
  if (!current) return historical;
  const obsolete = currentLineProblem(store, seriesAddress(request));
  if (obsolete) mechanismTake(obsolete);
  const scope = mechanismProjection(store, request.project, admission.gaps, true);
  const saved = mechanismTake(readRoutes(store, { project: request.project, record: admission.routes })).record.value.request;
  const binding = managed ? mechanismTake(readCompletionBinding(store, request.project, managed.series, managed.attempt)) : null;
  const prepared = binding
    ? mechanismTake(prepareManagedRouteBatch(store, { project: request.project, ...managed!, routes: admission.routes, batch: admission.batch }))
    : mechanismTake(prepareRoutes(store, { ...saved, gaps: normalizedScope(saved.gaps),
      catalog: { paths: [...saved.catalog.paths], records: [...saved.catalog.records] }, tasks: saved.tasks.map(record => ({ record })) }));
  mechanismCheck(canonical(reference(prepared.record)) === canonical(admission.routes) && prepared.writes.length === 0,
    admission.routes.id, 'routes', 'New admission requires the saved current route, not an unrecorded replacement');
  return { ...historical, guards: guardsUnique([...scope.guards, ...prepared.guards, admission.routes]),
    references: refsUnique([...historical.references, ...scope.references, ...prepared.references]) };
}
function deriveMechanismAdmission(store: Store, request: MechanismSeriesRequest, admission: MechanismAdmission): SeriesAdmissionProof {
  const scope = mechanismProjection(store, request.project, admission.gaps, false);
  const routes = mechanismTake(readRoutes(store, { project: request.project, record: admission.routes }));
  mechanismCheck(canonical(normalizedScope(routes.record.value.request.gaps)) === canonical(normalizedScope(admission.gaps)),
    admission.routes.id, 'gaps', 'The selected route must stand on the same complete D1 snapshot');
  const batches = routes.record.value.batches.filter(batch => batch.id === admission.batch);
  mechanismCheck(batches.length === 1, admission.routes.id, 'batch', 'Admission must name exactly one saved M6 batch');
  const batch = batches[0]!;
  mechanismCheck(batch.model === 'MC2' && batch.task === 'input-field' && batch.items.length > 0,
    admission.routes.id, 'batch', 'M5:addressing only owns a nonempty MC2 input-field task');
  const full = mechanismGaps(store, request.project, admission.gaps);
  const gaps = batch.items.map(item => {
    const gap = full.collection.gaps.find(gap => gap.id === item.gap);
    mechanismCheck(gap && gap.target === item.target && gap.field === item.field && gap.code === 'question_unaddressed'
      && gap.mechanism === 'M5:addressing' && gap.field === 'address' && gap.consumers.length === 0
      && scope.value.questions.some(question => question.target === gap.target && question.field === gap.field),
    item.target, 'batch', 'Every selected assignment must belong to this mechanism slice');
    return { id: gap.id, target: gap.target, field: gap.field };
  });
  mechanismCheck(new Set(gaps.map(gap => gap.id)).size === gaps.length, admission.routes.id, 'batch', 'An assignment may occur only once');
  const guards = [...scope.guards], references = [...scope.references, ...routes.references];
  return { ...scope, guards: guardsUnique(guards), references: refsUnique(references), gaps,
    goal: { questions: ordered(gaps.map(gap => gapLineKey(request.project, gap.target, gap.field)), value => value),
      result: gapLineExpectedResult(request.project, gaps[0]!.target, gaps[0]!.field) } };
}
export function prepareSeriesAdmission(store: Store, request: MechanismSeriesRequest, admission: MechanismAdmission): SeriesResult<Sealed<SeriesAdmissionProof>> {
  requireStore(store); const address = seriesAddress(request); requireAdmission(admission);
  check(address.owner.kind === 'mechanism', 'series_request_invalid', 'This admission belongs to a mechanism');
  return mechanismResult(() => {
    const read = mechanismTake(readAnySeries(store, request));
    const line = mechanismTake(prepareSeriesLineAdmission(store, request.project, reference(read)));
    const proof = mechanismAdmission(store, request, admission, true);
    return { ...proof, guards: guardsUnique([...proof.guards, ...line.guards]) };
  });
}
interface MechanismAdmissionRequest {
  project: string; series: Ref; attempt: number; admission: MechanismAdmission; current: boolean;
}
type MechanismAttemptProof = SeriesAdmissionProof & { series: Revision<MechanismRepairSeries>; owner: MechanismOwner; goal: AttemptGoal };
export function readMechanismAdmission(store: Store, request: MechanismAdmissionRequest): SeriesResult<Sealed<MechanismAttemptProof>> {
  return readMechanismAttemptAdmission(store, request, 'design');
}
/**
 * Analysis serves a saved attempt's stop or hold, even after its questions have changed or disappeared.
 * Its original admission is historical evidence. A different supplied admission names additional analysis
 * sources: these have their own current admission and guards, without replacing the original assignment.
 * E1 proves the exact stop/hold and permitted rung before dispatching.
 */
export function readMechanismAnalysisAdmission(store: Store, request: MechanismAdmissionRequest): SeriesResult<Sealed<MechanismAttemptProof>> {
  return readMechanismAttemptAdmission(store, request, 'analysis');
}
function readMechanismAttemptAdmission(store: Store, request: MechanismAdmissionRequest, purpose: 'design' | 'analysis'): SeriesResult<Sealed<MechanismAttemptProof>> {
  requireStore(store); check(isPlainObject(request), 'series_request_invalid', 'Admission reading requires an exact request');
  requireProject(request.project); requireAdmission(request.admission);
  check(isRef(request.series) && Number.isSafeInteger(request.attempt) && request.attempt > 0 && typeof request.current === 'boolean',
    'series_request_invalid', 'The exact series, attempt and admission mode are required');
  return mechanismResult(() => {
    const series = mechanismTake(readAnySeriesAt(store, request.project, request.series)) as Revision<AnyRepairSeries>;
    mechanismCheck('owner' in series.value, request.series.id, 'owner', 'A mechanism admission needs a mechanism series');
    const value = series.value as MechanismRepairSeries;
    const attempt = [...value.inherited, ...value.attempts].find(attempt => attempt.ordinal === request.attempt);
    const admitted = value.admissions.find(row => row.attempt === request.attempt);
    mechanismCheck(attempt && admitted, request.series.id, 'admission', 'The admission belongs to this exact saved attempt');
    const address = { project: request.project, owner: value.owner, line: value.line };
    const line = request.current ? mechanismTake(prepareSeriesLineAdmission(store, request.project, request.series)) : null;
    if (purpose === 'analysis') {
      const original = mechanismAdmission(store, address, admitted.basis, false);
      const sameSources = canonical(normalizedAdmission(request.admission)) === canonical(normalizedAdmission(admitted.basis));
      const sources = sameSources ? original : mechanismAdmission(store, address, request.admission, request.current);
      return { ...original, series: series as Revision<MechanismRepairSeries>, owner: value.owner, goal: attempt.goal,
        references: refsUnique([...original.references, ...sources.references, request.series]),
        guards: request.current ? guardsUnique([...line!.guards, ...(sameSources ? [] : sources.guards)]) : [] };
    }
    const proof = mechanismAdmission(store, address, request.admission, request.current, { series: request.series, attempt: request.attempt });
    const original = mechanismProjection(store, request.project, admitted.basis.gaps, false);
    mechanismCheck(proof.slice === original.slice, request.series.id, 'admission.scope', 'A refreshed admission must preserve the exact semantic task and consumer conditions');
    mechanismCheck(canonical(attempt.goal.questions) === canonical(proof.goal.questions) && attempt.goal.result === proof.goal.result,
      request.series.id, 'goal', 'The complete selected task must equal the declared goal');
    return { ...proof, guards: guardsUnique([...proof.guards, ...(line?.guards ?? [])]),
      series: series as Revision<MechanismRepairSeries>, owner: value.owner, goal: attempt.goal };
  });
}

function requireAddress(request: AnySeriesRequest): Address { return seriesAddress(request); }
export function seriesAddress(request: AnySeriesRequest): SeriesAddress {
  check(isPlainObject(request), "series_request_invalid", "A series needs an explicit owner address");
  const project = requireProject(request.project), line = requireLine(request.line);
  if (Object.hasOwn(request, "owner")) {
    const owner = (request as MechanismSeriesRequest).owner;
    check(isPlainObject(owner) && exactKeys(owner, ["kind", "mechanism"]) && owner.kind === "mechanism"
      && owner.mechanism === "M5:addressing" && !Object.hasOwn(request, "block"), "series_request_invalid", "An explicit supported mechanism owner cannot masquerade as a block");
    const id = ownerSeriesId(project, owner, line);
    check(id.length <= MAX_ENTITY_ID, "series_request_invalid", "The mechanism address exceeds the entity limit");
    return { project, line, owner: { kind: "mechanism", mechanism: "M5:addressing" }, id };
  }
  check(!Object.hasOwn(request, "scope") && !Object.hasOwn(request, "admission"), "series_request_invalid",
    "A modern mechanism envelope requires its explicit owner and cannot fall through to the legacy block contract");
  const block = requireBlock((request as SeriesRequest).block);
  return { project, line, owner: { kind: "block", block }, id: seriesId(project, block, line) };
}
export function seriesOwner(value: { readonly block: string } | { readonly owner: MechanismOwner }): SeriesOwner {
  check(isPlainObject(value), "series_request_invalid", "An owner comes from an explicit series value");
  if ("owner" in value) {
    check(isPlainObject(value.owner) && exactKeys(value.owner, ["kind", "mechanism"])
      && value.owner.kind === "mechanism" && value.owner.mechanism === "M5:addressing" && !Object.hasOwn(value, "block"),
      "series_request_invalid", "The mechanism owner is explicit and cannot also be a block");
    return { ...value.owner };
  }
  return { kind: "block", block: requireBlock(value.block) };
}
export function seriesRequestOf(value: Sealed<AnyRepairSeries>): AnySeriesRequest {
  const owner = seriesOwner(value), project = requireProject(value.projectId), line = requireLine(value.line);
  return owner.kind === "mechanism" ? { project, owner, line } : { project, block: owner.block, line };
}
const ownerSeriesId = (project: string, owner: SeriesOwner, line: number): string => owner.kind === "block"
  ? seriesId(project, owner.block, line) : `${REPAIR_SERIES_KIND}:${project}:mechanism:${line}:${owner.mechanism}`;
const ownerFields = (owner: SeriesOwner) => owner.kind === "block" ? { block: owner.block } : { owner: { ...owner } };
export const readAnySeries = (store: Store, request: AnySeriesRequest): SeriesResult<Sealed<Revision<AnyRepairSeries>>> => readSeries(store, request);
export function readSeriesAt(store: Store, project: string, ref: Ref): SeriesResult<Sealed<Revision<RepairSeries>>> {
  const read = readAnySeriesAt(store, project, ref);
  if (!read.ok) return read;
  if ("owner" in read.value.value) return problem("series_foreign", "This reader requires a block series", { target: ref.id, ref }, "owner");
  return delivered(read.value as Revision<RepairSeries>);
}

function requireProject(project: unknown): string {
  check(typeof project === "string" && project.length > 0, "series_request_invalid", "A series is kept for a project");
  // ':' separates namespaces inside an id: a project carrying one would address another project's records.
  check(!project.includes(":"), "series_request_invalid", "A project name carries no ':' namespace separator");
  // A refusal of a cycle is kept as a link into the project's journal, so a project whose journal cannot be addressed
  // cannot hold a series either.
  check(project.length + REFUSAL_JOURNAL_KIND.length + 1 <= MAX_ENTITY_ID,
    "series_request_invalid", "A project name that overflows an entity id cannot be repaired");
  return project;
}

function requireBlock(block: unknown): string {
  check(typeof block === "string" && block.length > 0, "series_request_invalid", "A series is kept for a block");
  return block;
}

function requireLine(line: unknown): number {
  check(Number.isSafeInteger(line) && Number(line) >= 1,
    "series_request_invalid", "A series stands on a line of its own, counted from one");
  return line as number;
}

export const SERIES_MEMBERSHIP_KIND = 'om-series-membership';
export const SERIES_CURRENT_KIND = 'om-series-current';
export const SERIES_APPLIED_KIND = 'om-series-applied';
export const SERIES_DISCARDED_KIND = 'om-series-discarded';
export const SERIES_ERA_KIND = 'om-series-era';
export const MANAGED_SERIES_CONTRACT = 'om-repair-series/v2';
export const SERIES_ACTIVATION_CONTRACT = 'om-series-activation/v1';
export type SeriesParticipation = PreparedSeriesDecision['participation'];
export type SeriesActivation =
  | { contract: typeof SERIES_ACTIVATION_CONTRACT; state: 'unactivated'; registered: Ref }
  | { contract: typeof SERIES_ACTIVATION_CONTRACT; state: 'activated'; applied: Ref; prepared: Ref;
      participation: SeriesParticipation; activeBasis: Ref | null };
export interface SeriesMembership {
  contract: 'om-series-membership/v1'; project: string; mode: 'legacy' | 'transition-managed';
  roots: { block: string; root: Ref }[]; activation: Ref | null;
}
export type SeriesEraOrigin = { kind: 'activation'; applied: Ref }
  // The order of the registered root (№2556-1): absent in a registration of the fec6932 era.
  | { kind: 'registration'; membership: Ref; pointer: Ref; slice: string; achievedOrder?: AchievedOrder };
export interface SeriesEra {
  contract: 'om-series-era/v1'; project: string; seriesId: string; firstManaged: Ref; origin: SeriesEraOrigin;
}
export function seriesEraId(project: string, seriesId: string): string {
  requireProject(project);
  check(typeof seriesId === 'string' && seriesId.startsWith(`${REPAIR_SERIES_KIND}:${project}:`),
    'series_request_invalid', 'An era belongs to the complete series ID in its project');
  return `${SERIES_ERA_KIND}:${project}:${hashJson({ seriesId })}`;
}
export interface SeriesActivationRequest { project: string; prepared: Ref; issuance: Ref }
export interface DiscardedSeriesTransition extends SeriesActivationRequest {
  contract: 'om-series-discarded/v1'; state: 'discarded'; codes: string[];
}
export interface PreparedSeriesDiscard {
  record: Revision<DiscardedSeriesTransition>; writes: Write[]; guards: TransactionGuard[];
}
export interface AppliedSeriesDecision {
  block: string; series: Ref; participation: SeriesParticipation;
  outcome: 'establish-basis' | 'continue' | 'new-work' | 'inactive'; activeBasis: Ref | null;
}
export interface AppliedSeriesTransition extends SeriesActivationRequest {
  contract: 'om-series-applied/v1'; membership: Ref | null; roots: SeriesMembership['roots']; previous: Ref | null;
  decisions: AppliedSeriesDecision[];
  /** The order of the NEW lines this application creates (№2556-1); absent in an application of the fec6932 era. */
  achievedOrder?: AchievedOrder;
}
export interface CurrentSeriesPointer {
  contract: 'om-series-current/v1'; project: string; applied: Ref; membership: Ref; previous: Ref | null;
  series: { block: string; activation: Ref; participation: SeriesParticipation }[];
}
export interface PreparedSeriesActivation {
  record: Revision<AppliedSeriesTransition>; pointer: Revision<CurrentSeriesPointer>;
  series: Revision<RepairSeries>[]; writes: Write[]; guards: TransactionGuard[];
}
export interface SeriesLineAdmission {
  series: Revision<AnyRepairSeries>; guards: Ref[]; pointer: Ref | null; activation: Ref | null;
  participation: SeriesParticipation | 'unactivated' | 'legacy'; references: Ref[];
}
export interface SeriesWorkAdmissionRequest { project: string; series: Ref; pointer: Ref | null }
export interface SeriesAdmissionChange extends SeriesWorkAdmissionRequest {
  contract: 'series-admission-change/v1'; applied: Ref; currentPointer: Ref;
}
export function seriesMembershipId(project: string): string { return `${SERIES_MEMBERSHIP_KIND}:${requireProject(project)}`; }
export function seriesCurrentId(project: string): string { return `${SERIES_CURRENT_KIND}:${requireProject(project)}`; }
export function seriesRequiresAdmissionProof(series: AnyRepairSeries): boolean {
  check(isPlainObject(series), 'series_request_invalid', 'An admission-era query requires a series record');
  return 'block' in series && series.contract === MANAGED_SERIES_CONTRACT;
}
function activationId(request: SeriesActivationRequest): string {
  return `${SERIES_APPLIED_KIND}:${request.project}:${hashJson({ prepared: request.prepared, issuance: request.issuance })}`;
}
function requireActivationRequest(store: Store, request: unknown): asserts request is SeriesActivationRequest {
  requireStore(store);
  check(mechanismObject(request) && exactKeys(request, ['project', 'prepared', 'issuance'])
    && isRef(request.prepared) && isRef(request.issuance), 'series_request_invalid', 'Activation requires exact saved P and G2 sources');
  requireProject(request.project);
}
function requireWorkAdmissionRequest(store: Store, request: unknown, change = false): asserts request is SeriesWorkAdmissionRequest & { currentPointer?: Ref } {
  requireStore(store);
  check(mechanismObject(request) && isRef(request.series) && (request.pointer === null || isRef(request.pointer))
    && Object.hasOwn(request, 'pointer') && (!change || !Object.hasOwn(request, 'currentPointer') || isRef(request.currentPointer)),
  'series_request_invalid', 'Admission history names the exact source series and an explicit original pointer or null');
  requireProject(request.project);
}
function sourceRecord<T>(store: Store, ref: Ref, project: string, kind: string, id = `${kind}:${project}`): Revision<T> {
  return mechanismTake(readRecord<T>(store, ref, { unit: UNIT, target: id, kind, id })) as Revision<T>;
}
function revisionOfWrite<T>(write: Write): Revision<T> {
  return { id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(write.value), value: write.value as T };
}
function rootOf(store: Store, project: string, series: Revision<AnyRepairSeries>): Ref {
  let current = series;
  while (current.value.predecessor !== null) current = mechanismTake(readAnySeriesAt(store, project, current.value.predecessor)) as Revision<AnyRepairSeries>;
  const root = store.get(current.id, 1);
  mechanismCheck(root, current.id, 'root', 'A lineage retains its original first revision');
  return reference(root);
}
function checkedMembership(store: Store, project: string, ref: Ref): Revision<SeriesMembership> {
  // NR1 (№3600): a trusted read — membership is written by registration and activation producers only.
  return historicalRead(store, { reader: 'A3.membership', project, ref, parameters: null },
    () => sourceRecord<SeriesMembership>(store, ref, project, SERIES_MEMBERSHIP_KIND),
    () => { mechanismCheck(false, ref.id, 'membership', 'Membership history may not depend on itself'); throw new Error('Unreachable'); });
}
interface CapturedMembership { record: Revision<SeriesMembership> | null; value: SeriesMembership; series: Revision<RepairSeries>[] }
function captureMembership(store: Store, project: string): CapturedMembership {
  // Reading absence before enumeration is essential: the following expected=0 write arbitrates registration/bootstrap.
  const captured = store.get<SeriesMembership>(seriesMembershipId(project));
  const record = captured ? checkedMembership(store, project, reference(captured)) : null;
  const roots: SeriesMembership['roots'] = [], current = new Map<string, Revision<RepairSeries>>();
  // Q4 (№2563-3): the project prefix is an indexed head range over identities — kind is selected from the same
  // metadata before any body is decoded, so a foreign project's corrupt series is never read. A view without a
  // proven Store keeps the previous list and filter.
  const prefix = `${REPAIR_SERIES_KIND}:${project}:`;
  const genuine = provenStore(store);
  const lines: Revision<RepairSeries>[] = genuine
    ? genuine.identities('prefix', prefix)
      .filter(row => row.kind === REPAIR_SERIES_KIND && !row.id.startsWith(`${prefix}mechanism:`))
      .flatMap(row => { const head = store.get<RepairSeries>(row.id); return head ? [head] : []; })
    : store.list<RepairSeries>(REPAIR_SERIES_KIND).filter(row => row.id.startsWith(prefix));
  for (const raw of lines) {
    if (raw.id.startsWith(`${REPAIR_SERIES_KIND}:${project}:mechanism:`)) continue;
    const series = mechanismTake(readAnySeriesAt(store, project, reference(raw))) as Revision<RepairSeries>;
    if (series.value.line === 1) roots.push({ block: series.value.block, root: rootOf(store, project, series) });
    const prior = current.get(series.value.block);
    if (!prior || series.value.line > prior.value.line) current.set(series.value.block, series);
  }
  const sortedRoots = ordered(roots, row => row.block);
  if (record) mechanismCheck(canonical(record.value.roots) === canonical(sortedRoots), record.id, 'roots', 'Membership must equal all lawful block roots');
  else mechanismCheck(![...current.values()].some(row => row.value.contract !== undefined) && !store.get(seriesCurrentId(project)),
    seriesMembershipId(project), 'membership', 'A managed project cannot lose its membership source');
  return { record, value: record?.value ?? { contract: 'om-series-membership/v1', project, mode: 'legacy', roots: sortedRoots, activation: null },
    series: ordered([...current.values()], row => row.value.block) };
}
export function readSeriesMembership(store: Store, request: { project: string; record?: Ref }): SeriesResult<Sealed<Revision<SeriesMembership>>> {
  requireStore(store); check(mechanismObject(request) && (!Object.hasOwn(request, 'record') || isRef(request.record)), 'series_request_invalid', 'Membership reading needs a project and optional exact reference'); requireProject(request.project);
  return mechanismResult(() => {
    if (request.record) return checkedMembership(store, request.project, request.record);
    const membership = captureMembership(store, request.project);
    mechanismCheck(membership.record, seriesMembershipId(request.project), 'membership', 'The membership source is absent');
    return membership.record;
  });
}
function checkedTransitionPair(store: Store, request: SeriesActivationRequest) {
  const prepared = mechanismTake(readPreparedSeriesTransition(store, { project: request.project, record: request.prepared })).record;
  const issuance = mechanismTake(readHorizonIssuance(store, { project: request.project, record: request.issuance })).record;
  mechanismCheck(prepared.value.request.project === request.project && issuance.value.project === request.project
    && issuance.value.choiceVersion === prepared.value.request.choiceVersion
    && sameRef(issuance.value.transition, request.prepared) && sameRef(issuance.value.horizon, prepared.value.request.horizon),
  request.issuance.id, 'issuance', 'G2 must prove exactly this project, choice version, prepared transition and horizon');
  return { prepared, issuance };
}
function requireAcceptedIssuance(issuance: ReturnType<typeof checkedTransitionPair>['issuance']): void {
  if (issuance.value.state === 'refused') mechanismTake(refuse('series_transition_refused',
    'The bound G2 refused this transition', { unit: 'B3', target: issuance.id, field: 'state', ref: reference(issuance) }, 'producer'));
}
function discardId(request: SeriesActivationRequest): string {
  return `${SERIES_DISCARDED_KIND}:${request.project}:${hashJson({ prepared: request.prepared, issuance: request.issuance })}`;
}
function deriveDiscarded(store: Store, request: SeriesActivationRequest): DiscardedSeriesTransition {
  const { issuance } = checkedTransitionPair(store, request);
  mechanismCheck(issuance.value.state === 'refused', request.issuance.id, 'state', 'Only a proved negative G2 produces a discarded transition');
  return { contract: 'om-series-discarded/v1', project: request.project, prepared: exactRef(request.prepared),
    issuance: exactRef(request.issuance), state: 'discarded', codes: [...issuance.value.codes] };
}
function checkedDiscarded(store: Store, project: string, ref: Ref): Revision<DiscardedSeriesTransition> {
  const record = mechanismTake(readRecord<DiscardedSeriesTransition>(store, ref, { unit: 'B3', target: ref.id,
    kind: SERIES_DISCARDED_KIND, idPrefix: `${SERIES_DISCARDED_KIND}:${project}:` })) as Revision<DiscardedSeriesTransition>;
  const value = record.value;
  mechanismCheck(mechanismObject(value) && exactKeys(value, ['contract', 'project', 'prepared', 'issuance', 'state', 'codes'])
    && value.contract === 'om-series-discarded/v1' && value.project === project && value.state === 'discarded'
    && isRef(value.prepared) && exactKeys(value.prepared, ['id', 'revision', 'hash'])
    && isRef(value.issuance) && exactKeys(value.issuance, ['id', 'revision', 'hash'])
    && Array.isArray(value.codes) && value.codes.every(code => typeof code === 'string'),
  ref.id, 'discarded', 'Discarded history requires its producer and all exact negative sources');
  const request = { project, prepared: value.prepared, issuance: value.issuance };
  mechanismCheck(record.revision === 1 && ref.id === discardId(request) && record.hash === hashJson(value),
    ref.id, 'record', 'The discarded record is the immutable, exact-hash result of its P/G pair');
  mechanismCheck(canonical(value) === canonical(deriveDiscarded(store, request)), ref.id, 'discarded',
    'Discarded history is rederived from the bound negative G2, including its complete codes');
  return record;
}
export function readDiscardedSeriesTransition(store: Store, request: { project: string; record: Ref }): SeriesResult<Sealed<Revision<DiscardedSeriesTransition>>> {
  requireStore(store);
  check(mechanismObject(request) && exactKeys(request, ['project', 'record']) && isRef(request.record),
    'series_request_invalid', 'Discarded history names its project and exact saved record');
  requireProject(request.project);
  return mechanismResult(() => checkedDiscarded(store, request.project, request.record));
}
export function prepareSeriesDiscard(store: Store, request: SeriesActivationRequest): SeriesResult<Sealed<PreparedSeriesDiscard>> {
  requireActivationRequest(store, request);
  return mechanismResult(() => {
    const id = discardId(request), existing = store.get<DiscardedSeriesTransition>(id, 1);
    if (existing) return { record: checkedDiscarded(store, request.project, reference(existing)), writes: [], guards: [] };
    const value = deriveDiscarded(store, request), write: Write = { id, kind: SERIES_DISCARDED_KIND, expected: 0, value };
    // P/G are exact historical sources, not current-head guards. Only the new immutable result is CAS-written.
    return { record: revisionOfWrite<DiscardedSeriesTransition>(write), writes: [write], guards: [] };
  });
}
export function writeSeriesDiscard(store: Store, request: SeriesActivationRequest): SeriesResult<Sealed<PreparedSeriesDiscard>> {
  const prepared = prepareSeriesDiscard(store, request);
  if (!prepared.ok || !prepared.value.writes.length) return prepared;
  const written = writeGuarded(store, { unit: 'B3', target: prepared.value.record.id, writes: prepared.value.writes, guards: prepared.value.guards });
  return written.ok ? delivered({ ...prepared.value, writes: [] }) : written;
}
function deriveApplied(store: Store, request: SeriesActivationRequest, membership: Ref | null,
  roots: SeriesMembership['roots'], previous: Ref | null, order: AchievedOrder | undefined): AppliedSeriesTransition {
  const { prepared, issuance } = checkedTransitionPair(store, request);
  requireAcceptedIssuance(issuance);
  const members = membership ? checkedMembership(store, request.project, membership).value : null;
  mechanismCheck(!members || canonical(members.roots) === canonical(roots), request.prepared.id, 'roots', 'Application preserves its captured membership roots');
  mechanismCheck((members?.mode === 'transition-managed') === (previous !== null), request.prepared.id, 'previous', 'Managed transitions retain their original current pointer');
  const oldPointer = previous ? checkedCurrent(store, request.project, previous) : null;
  const sources = prepared.value.request.series.map(ref => mechanismTake(readAnySeriesAt(store, request.project, ref)) as Revision<RepairSeries>);
  mechanismCheck(sources.length === roots.length && canonical(ordered(sources.map(series => ({ block: series.value.block,
    root: rootOf(store, request.project, series) })), row => row.block)) === canonical(roots), request.prepared.id, 'series', 'P must cover the complete proved block membership');
  const decisions: AppliedSeriesDecision[] = prepared.value.decisions.map(decision => {
    const source = sources.find(row => sameRef(reference(row), decision.series));
    mechanismCheck(source, decision.series.id, 'series', 'Every decision must name its exact source series');
    const activation = source.value.activation;
    if (oldPointer && activation?.state === 'activated') {
      const row = oldPointer.value.series.find(row => row.block === source.value.block);
      mechanismCheck(row && row.activation.id === source.id && sameRef(oldPointer.value.applied, activation.applied)
        && row.participation === activation.participation, source.id, 'activation', 'P participants retain the activation of their original pointer');
    } else if (oldPointer) mechanismCheck(activation?.state === 'unactivated', source.id, 'activation', 'A managed participant is explicitly registered or activated');
    else mechanismCheck(activation === undefined, source.id, 'activation', 'Bootstrap receives only original legacy participants');
    const previousBasis = activation?.state === 'activated' ? activation.activeBasis : null;
    let outcome: AppliedSeriesDecision['outcome'] = 'inactive';
    if (decision.participation === 'active') outcome = previousBasis === null ? 'establish-basis'
      : mechanismTake(comparePreparedSeriesSlices(store, { project: request.project, previous: previousBasis, next: request.prepared, block: decision.block }));
    if (outcome === 'new-work' && running(source.value) !== null)
      mechanismTake(problem('attempt_running', 'A new local subject waits for explicit completion of the original attempt', { target: source.id, ref: reference(source) }, 'attempts'));
    return { block: decision.block, series: exactRef(decision.series), participation: decision.participation, outcome,
      activeBasis: decision.participation === 'active' ? exactRef(request.prepared) : previousBasis };
  });
  mechanismCheck(decisions.length === roots.length, request.prepared.id, 'decisions', 'Every registered block needs a proved participation decision');
  return { contract: 'om-series-applied/v1', project: request.project, prepared: exactRef(request.prepared), issuance: exactRef(request.issuance),
    membership: membership === null ? null : exactRef(membership), roots, previous: previous === null ? null : exactRef(previous), decisions,
    ...(order === undefined ? {} : { achievedOrder: order }) };
}
function checkedApplied(store: Store, project: string, ref: Ref): Revision<AppliedSeriesTransition> {
  // NR1 (№3600): a trusted read — the application was written once from its exact P/G pair (deriveApplied).
  return historicalRead(store, { reader: 'A3.applied', project, ref, parameters: null }, () =>
    mechanismTake(readRecord<AppliedSeriesTransition>(store, ref, { unit: UNIT, target: project, kind: SERIES_APPLIED_KIND,
      idPrefix: `${SERIES_APPLIED_KIND}:${project}:` })) as Revision<AppliedSeriesTransition>,
    () => { mechanismCheck(false, ref.id, 'applied', 'Applied history may not depend on itself'); throw new Error('Unreachable'); });
}
function activationWrites(store: Store, applied: Revision<AppliedSeriesTransition>): Write[] {
  const value = applied.value, prepared = mechanismTake(readPreparedSeriesTransition(store, { project: value.project, record: value.prepared })).record.value;
  const writes: Write[] = [];
  for (const decision of value.decisions) {
    const source = mechanismTake(readAnySeriesAt(store, value.project, decision.series)) as Revision<RepairSeries>;
    const activation: SeriesActivation = { contract: SERIES_ACTIVATION_CONTRACT, state: 'activated', applied: reference(applied),
      prepared: value.prepared, participation: decision.participation, activeBasis: decision.activeBasis };
    if (decision.outcome === 'new-work') {
      const slice = prepared.decisions.find(row => row.block === decision.block)!.slice!;
      // A new line is of the order its application chose; the source keeps its own (№2556-1).
      const { achievedOrder: _sourceOrder, ...base } = plainSeries(source.value);
      const next = settled({ ...base, ...(value.achievedOrder === undefined ? {} : { achievedOrder: value.achievedOrder }),
        contract: MANAGED_SERIES_CONTRACT, activation,
        line: source.value.line + 1, slice: slice.hash, predecessor: reference(source), basis: { ground: 'inputs-changed', text: 'Applied horizon changes the proved local slice' },
        inherited: [...source.value.inherited, ...source.value.attempts].map(attempt => copyAttempt(attempt, value.achievedOrder)), attempts: [] }) as RepairSeries;
      writes.push({ id: seriesId(value.project, decision.block, next.line), kind: REPAIR_SERIES_KIND, expected: 0, value: next },
        { id: source.id, kind: REPAIR_SERIES_KIND, expected: source.revision, value: source.value });
    } else writes.push({ id: source.id, kind: REPAIR_SERIES_KIND, expected: source.revision,
      value: settled({ ...plainSeries(source.value), contract: MANAGED_SERIES_CONTRACT, activation }) });
  }
  return writes;
}
function membershipAfter(store: Store, applied: Revision<AppliedSeriesTransition>): Write {
  const before = applied.value.membership ? checkedMembership(store, applied.value.project, applied.value.membership) : null;
  return { id: seriesMembershipId(applied.value.project), kind: SERIES_MEMBERSHIP_KIND, expected: before?.revision ?? 0,
    value: { contract: 'om-series-membership/v1', project: applied.value.project, mode: 'transition-managed', roots: applied.value.roots,
      activation: before?.value.activation ?? reference(applied) } satisfies SeriesMembership };
}
function currentAfter(store: Store, applied: Revision<AppliedSeriesTransition>, writes: Write[]): Write {
  const member = revisionOfWrite<SeriesMembership>(membershipAfter(store, applied));
  const series = applied.value.decisions.map(decision => {
    const source = mechanismTake(readAnySeriesAt(store, applied.value.project, decision.series));
    const id = decision.outcome === 'new-work' ? seriesId(applied.value.project, decision.block, source.value.line + 1) : source.id;
    const revision = revisionOfWrite<RepairSeries>(writes.find(write => write.id === id)!);
    return { block: decision.block, activation: reference(revision), participation: decision.participation };
  });
  return { id: seriesCurrentId(applied.value.project), kind: SERIES_CURRENT_KIND, expected: applied.value.previous?.revision ?? 0,
    value: { contract: 'om-series-current/v1', project: applied.value.project, applied: reference(applied), membership: reference(member),
      previous: applied.value.previous, series } satisfies CurrentSeriesPointer };
}
function checkedCurrent(store: Store, project: string, ref: Ref): Revision<CurrentSeriesPointer> {
  // NR1 (№3600): a trusted read — the pointer was committed with its application (currentAfter).
  return historicalRead(store, { reader: 'A3.current-history', project, ref, parameters: null },
    () => sourceRecord<CurrentSeriesPointer>(store, ref, project, SERIES_CURRENT_KIND),
    () => { mechanismCheck(false, ref.id, 'pointer', 'Pointer history may not depend on itself'); throw new Error('Unreachable'); });
}
export function readAppliedSeriesTransition(store: Store, request: { project: string; record: Ref }): SeriesResult<Sealed<Revision<AppliedSeriesTransition>>> {
  requireStore(store); check(mechanismObject(request) && isRef(request.record), 'series_request_invalid', 'Applied history needs an exact reference'); requireProject(request.project);
  return mechanismResult(() => checkedApplied(store, request.project, request.record));
}
export function readCurrentSeriesPointer(store: Store, request: { project: string; record?: Ref }): SeriesResult<Sealed<Revision<CurrentSeriesPointer>>> {
  requireStore(store); check(mechanismObject(request) && (!Object.hasOwn(request, 'record') || isRef(request.record)), 'series_request_invalid', 'Pointer reading requires a project and optional exact reference'); requireProject(request.project);
  return mechanismResult(() => {
    const ref = request.record ?? (() => { const head = store.get(seriesCurrentId(request.project));
      mechanismCheck(head, seriesCurrentId(request.project), 'pointer', 'The current series pointer is absent'); return reference(head); })();
    return checkedCurrent(store, request.project, ref);
  });
}
export function prepareSeriesActivation(store: Store, request: SeriesActivationRequest): SeriesResult<Sealed<PreparedSeriesActivation>> {
  requireActivationRequest(store, request);
  return mechanismResult(() => {
    const existing = store.get<AppliedSeriesTransition>(activationId(request), 1);
    if (existing) {
      const record = checkedApplied(store, request.project, reference(existing)), writes = activationWrites(store, record);
      const pointer = revisionOfWrite<CurrentSeriesPointer>(currentAfter(store, record, writes));
      checkedCurrent(store, request.project, reference(pointer));
      return { record, pointer, series: pointer.value.series.map(row => mechanismTake(readAnySeriesAt(store, request.project, row.activation)) as Revision<RepairSeries>), writes: [], guards: [] };
    }
    const { prepared: p, issuance: g } = checkedTransitionPair(store, request);
    requireAcceptedIssuance(g);
    const membership = captureMembership(store, request.project);
    const current = store.get<CurrentSeriesPointer>(seriesCurrentId(request.project));
    const previous = current ? reference(checkedCurrent(store, request.project, reference(current))) : null;
    mechanismCheck(canonical(refsUnique(p.value.request.series)) === canonical(refsUnique(membership.series.map(reference))), request.prepared.id, 'series', 'Prepared participants must equal all current registered block lines');
    const fresh = mechanismTake(prepareSeriesTransition(store, p.value.request as Parameters<typeof prepareSeriesTransition>[1]));
    const issued = mechanismTake(prepareHorizonIssuance(store, { project: request.project, choiceVersion: g.value.choiceVersion, horizon: g.value.horizon, transition: g.value.transition }));
    mechanismCheck(!fresh.writes.length && !issued.writes.length && sameRef(reference(issued.record), request.issuance), request.issuance.id, 'issuance', 'The exact saved P/G must remain admitted');
    const value = deriveApplied(store, request, membership.record ? reference(membership.record) : null, membership.value.roots, previous, ACHIEVED_ORDER);
    const record = revisionOfWrite<AppliedSeriesTransition>({ id: activationId(request), kind: SERIES_APPLIED_KIND, expected: 0, value });
    const seriesWrites = activationWrites(store, record), memberWrite = membershipAfter(store, record);
    const pointerWrite = currentAfter(store, record, seriesWrites), pointer = revisionOfWrite<CurrentSeriesPointer>(pointerWrite);
    const eraWrites = pointer.value.series.flatMap(row => {
      const first = revisionOfWrite<RepairSeries>(seriesWrites.find(write => write.id === row.activation.id)!);
      const write = prepareEraWrite(store, first, { kind: 'activation', applied: reference(record) });
      return write ? [write] : [];
    });
    const writes = [{ id: record.id, kind: record.kind, expected: 0, value }, ...seriesWrites, memberWrite, pointerWrite, ...eraWrites];
    const guards = uniqueTransactionGuards([...fresh.guards, ...issued.guards,
      ...(membership.record ? [reference(membership.record)] : [{ id: seriesMembershipId(request.project), absent: true as const }]),
      ...(previous ? [previous] : [{ id: seriesCurrentId(request.project), absent: true as const }])]);
    return { record, pointer, series: pointer.value.series.map(row => revisionOfWrite<RepairSeries>(seriesWrites.find(write => write.id === row.activation.id)!)), writes, guards };
  });
}
export function applySeriesActivation(store: Store, request: SeriesActivationRequest): SeriesResult<Sealed<PreparedSeriesActivation>> {
  const prepared = prepareSeriesActivation(store, request);
  if (!prepared.ok || !prepared.value.writes.length) return prepared;
  const written = writeGuarded(store, { unit: UNIT, target: request.project, writes: prepared.value.writes, guards: prepared.value.guards });
  return written.ok ? delivered({ ...prepared.value, writes: [] }) : written;
}

function mutationAdmission(store: Store, source: Revision<AnyRepairSeries>): SeriesResult<Sealed<{ guards: readonly Ref[] }>> {
  // Legacy commands already read their own exact source. Activation rewrites it in the same CAS transaction,
  // preserving their established race codes and avoiding a stricter reread of unrelated legacy records.
  return source.value.contract === undefined && source.value.activation === undefined
    ? delivered({ guards: [reference(source)] })
    : prepareSeriesLineAdmission(store, source.value.projectId, reference(source));
}
function currentBlockAdmission(store: Store, project: string, ref: Ref, work: boolean): SeriesLineAdmission {
  // Capture the mutable admission before historical proof walks earlier revisions of the same line.
  // A concurrent change after this snapshot is refused by its original transaction guard.
  const head = store.get(ref.id);
  const series = mechanismTake(readAnySeriesAt(store, project, ref)) as Revision<AnyRepairSeries>;
  const address = seriesAddress(seriesRequestOf(series.value));
  if (!head || !sameRef(reference(head), ref)) mechanismTake(problem('series_conflict', 'Admission needs the exact current series head', { target: ref.id, ref }, 'line'));
  const obsolete = currentLineProblem(store, address, ref);
  if (obsolete) mechanismTake(obsolete);
  if ('owner' in series.value) return { series, guards: [exactRef(ref)], pointer: null, activation: null, participation: 'legacy', references: [exactRef(ref)] };
  // Q4 (№2563-1): admission needs only the exact proof spine — the membership head proved by checkedMembership,
  // this line's own root in its root set, the head/successor checks above, pointer and participation. Enumerating
  // every repair-series line is the writer's business and stays there; an unrelated line no longer
  // blocks this admission, while every exact basis — roots, membership history, applied, pointer, predecessors —
  // keeps its refusal.
  const captured = store.get<SeriesMembership>(seriesMembershipId(project));
  const record = captured ? checkedMembership(store, project, reference(captured)) : null;
  const activation = series.value.activation;
  const guards = [exactRef(ref)], references = [exactRef(ref)];
  if (record) references.push(reference(record));
  if (!work && record) guards.push(reference(record));
  if (record === null || record.value.mode === 'legacy') {
    // The absent/legacy verdicts of captureMembership still stand over the project's own namespace: no foreign
    // managed line, no lost pointer, no root the record does not name — each an exact refusal there, not here.
    captureMembership(store, project);
    mechanismCheck(activation === undefined && series.value.contract === undefined && !store.get(seriesCurrentId(project)), ref.id, 'activation', 'Legacy admission cannot replace missing managed proof');
    return { series, guards: refsUnique(guards), pointer: null, activation: null, participation: 'legacy', references: refsUnique(references) };
  }
  mechanismCheck(series.value.contract === MANAGED_SERIES_CONTRACT && activation, ref.id, 'activation', 'Managed membership requires the explicit series producer');
  mechanismCheck(record.value.roots.some(row => row.block === (series.value as RepairSeries).block
    && canonical(row.root) === canonical(rootOf(store, project, series))), record.id, 'roots',
    'Membership does not name the exact root of this line');
  const rawPointer = store.get<CurrentSeriesPointer>(seriesCurrentId(project));
  mechanismCheck(rawPointer, ref.id, 'pointer', 'Managed admission requires the current pointer');
  const pointer = checkedCurrent(store, project, reference(rawPointer));
  guards.push(reference(pointer)); references.push(reference(pointer), pointer.value.membership, pointer.value.applied);
  if (activation.state === 'unactivated') {
    mechanismCheck(!work, ref.id, 'participation', 'A registered root participates in preparation but cannot start work before activation');
    return { series, guards: refsUnique(guards), pointer: reference(pointer), activation: null, participation: 'unactivated', references: refsUnique(references) };
  }
  const row = pointer.value.series.find(row => row.block === (series.value as RepairSeries).block);
  mechanismCheck(row && row.activation.id === ref.id && row.activation.revision <= ref.revision
    && sameRef(pointer.value.applied, activation.applied) && row.participation === activation.participation,
  ref.id, 'pointer', 'The current pointer must admit this exact activated lineage');
  if (work) mechanismCheck(row.participation === 'active', ref.id, 'participation', 'Only active block participation admits new work');
  return { series, guards: refsUnique(guards), pointer: reference(pointer), activation: activation.applied,
    participation: activation.participation, references: refsUnique(references) };
}
export function readSeriesWorkAdmission(store: Store, request: SeriesWorkAdmissionRequest): SeriesResult<Sealed<SeriesLineAdmission>> {
  requireWorkAdmissionRequest(store, request);
  return mechanismResult(() => {
    const series = mechanismTake(readAnySeriesAt(store, request.project, request.series)) as Revision<AnyRepairSeries>;
    const activation = series.value.activation;
    if ('owner' in series.value || activation === undefined) {
      mechanismCheck(request.pointer === null && series.value.contract === undefined, request.series.id, 'pointer', 'The legacy producer has an explicit pointer-free historical admission');
      return { series, guards: [exactRef(request.series)], pointer: null, activation: null, participation: 'legacy' as const, references: [exactRef(request.series)] };
    }
    mechanismCheck(activation.state === 'activated' && activation.participation === 'active' && request.pointer !== null,
      request.series.id, 'activation', 'Managed work requires its original active admission and exact pointer');
    const pointer = checkedCurrent(store, request.project, request.pointer);
    const row = pointer.value.series.find(row => row.block === (series.value as RepairSeries).block);
    mechanismCheck(row && row.activation.id === series.id && row.activation.revision <= series.revision && row.participation === 'active'
      && sameRef(pointer.value.applied, activation.applied), request.series.id, 'pointer', 'Historical work admission must belong to this series activation');
    return { series, guards: refsUnique([request.series, request.pointer]), pointer: exactRef(request.pointer), activation: exactRef(activation.applied),
      participation: 'active' as const, references: refsUnique([request.series, request.pointer, activation.applied, pointer.value.membership]) };
  });
}
export function readSeriesAdmissionChange(store: Store, request: SeriesWorkAdmissionRequest & { currentPointer?: Ref }): SeriesResult<Sealed<{
  proof: SeriesAdmissionChange; references: Ref[]; guards: Ref[];
}>> {
  requireWorkAdmissionRequest(store, request, true);
  return mechanismResult(() => {
    const original = mechanismTake(readSeriesWorkAdmission(store, request));
    mechanismCheck('block' in original.series.value, request.series.id, 'owner', 'Block activation does not terminate mechanism admission');
    const current = request.currentPointer ?? (() => {
      const pointer = store.get(seriesCurrentId(request.project));
      mechanismCheck(pointer, request.series.id, 'pointer', 'An absent pointer does not prove termination');
      return reference(pointer);
    })();
    const pointer = checkedCurrent(store, request.project, current), applied = checkedApplied(store, request.project, pointer.value.applied);
    mechanismCheck(request.pointer === null || !sameRef(request.pointer, current), request.series.id, 'pointer', 'Termination requires an applied change of the original admission');
    // Follow exact predecessor pointers to the original admission; unrelated activation is not a witness.
    let cursor: Revision<CurrentSeriesPointer> | null = pointer;
    let originFound = request.pointer === null;
    let lineFound = false;
    while (cursor) {
      const transition = checkedApplied(store, request.project, cursor.value.applied);
      const decision = transition.value.decisions.find(row => row.block === (original.series.value as RepairSeries).block);
      if (decision && decision.series.id === request.series.id && decision.series.revision >= request.series.revision) {
        const source = mechanismTake(readAnySeriesAt(store, request.project, decision.series));
        mechanismCheck(sameRef(rootOf(store, request.project, source as Revision<AnyRepairSeries>), rootOf(store, request.project, original.series)),
          request.series.id, 'line', 'The applied change must belong to the original lineage');
        lineFound = true;
      }
      if (request.pointer !== null && cursor.value.previous && sameRef(cursor.value.previous, request.pointer)) { originFound = true; break; }
      if (cursor.value.previous === null) break;
      cursor = checkedCurrent(store, request.project, cursor.value.previous);
    }
    mechanismCheck(originFound && lineFound, request.series.id, 'change', 'The terminal witness needs a proved applied change after this exact admission');
    const proof: SeriesAdmissionChange = { contract: 'series-admission-change/v1', project: request.project, series: exactRef(request.series),
      pointer: request.pointer === null ? null : exactRef(request.pointer), applied: reference(applied), currentPointer: exactRef(current) };
    const head = request.currentPointer === undefined ? store.get(request.series.id) : null;
    return { proof, references: refsUnique([...original.references, current, reference(applied)]),
      guards: request.currentPointer === undefined ? refsUnique([current, ...(head ? [reference(head)] : [])]) : [] };
  });
}
/** This lookup establishes only a threshold. It deliberately never traverses the future producer. */
function lookupSeriesEra(store: Store, project: string, id: string): Revision<SeriesEra> | null {
  const at = seriesEraId(project, id), raw = store.get<SeriesEra>(at, 1);
  if (!raw) return null;
  const record = sourceRecord<SeriesEra>(store, reference(raw), project, SERIES_ERA_KIND, at), value = record.value;
  mechanismCheck(mechanismObject(value) && exactKeys(value, ['contract', 'project', 'seriesId', 'firstManaged', 'origin'])
    && value.contract === 'om-series-era/v1' && value.project === project && value.seriesId === id
    && isRef(value.firstManaged) && value.firstManaged.id === id && mechanismObject(value.origin),
  at, 'era', 'The immutable era threshold belongs to this exact project and full series ID');
  const origin = value.origin;
  mechanismCheck(origin.kind === 'activation'
    ? exactKeys(origin, ['kind', 'applied']) && isRef(origin.applied) && origin.applied.revision === 1 && origin.applied.id.startsWith(`${SERIES_APPLIED_KIND}:${project}:`)
    : origin.kind === 'registration' && exactKeys(origin, ['kind', 'membership', 'pointer', 'slice', ...(Object.hasOwn(origin, 'achievedOrder') ? ['achievedOrder'] : [])])
      && isRef(origin.membership) && origin.membership.id === seriesMembershipId(project)
      && isRef(origin.pointer) && origin.pointer.id === seriesCurrentId(project) && isText(origin.slice),
  at, 'origin', 'Era provenance names an exact application or root-registration source of its own project');
  mechanismCheck(origin.kind !== 'registration' || !Object.hasOwn(origin, 'achievedOrder') || origin.achievedOrder === ACHIEVED_ORDER,
    at, 'origin.achievedOrder', 'A registration names the order of its root only as this unit writes it');
  return record;
}
function checkedRegistrationSources(store: Store, project: string, membership: Ref, pointer: Ref): Revision<SeriesMembership> {
  const before = checkedMembership(store, project, membership), current = checkedCurrent(store, project, pointer);
  mechanismCheck(current.value.membership.revision <= before.revision, membership.id, 'pointer',
    'A registration cannot stand on a pointer produced after its source membership');
  let preceding = checkedMembership(store, project, current.value.membership);
  for (let revision = preceding.revision + 1; revision <= before.revision; revision += 1) {
    const raw = store.get<SeriesMembership>(membership.id, revision);
    mechanismCheck(raw, membership.id, 'membership', 'Every registration source revision must remain present');
    const next = checkedMembership(store, project, reference(raw));
    mechanismCheck(next.value.roots.length === preceding.value.roots.length + 1, membership.id, 'pointer',
      'Only root registrations may follow the membership of the original current pointer');
    preceding = next;
  }
  return before;
}
function registeredRoot(project: string, block: string, slice: string, membership: SeriesMembership, order: AchievedOrder | undefined): RepairSeries {
  mechanismCheck(membership.mode === 'transition-managed' && membership.activation !== null
    && !membership.roots.some(row => row.block === block), seriesId(project, block, 1), 'registration',
  'Managed registration adds one previously absent block root');
  return settled({ ...(order === undefined ? {} : { achievedOrder: order }), projectId: project, block, line: 1, slice, contract: MANAGED_SERIES_CONTRACT,
    activation: { contract: SERIES_ACTIVATION_CONTRACT, state: 'unactivated', registered: membership.activation },
    predecessor: null, basis: null, inherited: [], attempts: [], continuations: [], escalations: [] }) as RepairSeries;
}
function registeredMembership(before: SeriesMembership, block: string, root: Ref): SeriesMembership {
  return { ...before, roots: ordered([...before.roots, { block, root: exactRef(root) }], row => row.block) };
}
function checkedEraProduction(store: Store, era: Revision<SeriesEra>): Revision<RepairSeries> {
  const { project, seriesId: id, firstManaged } = era.value;
  // NR1 (№3600): a trusted read — the first managed revision was written by its activation or registration producer.
  return historicalRead(store, { reader: 'A3.era-production', project, ref: reference(era), parameters: null },
    () => sourceRecord<RepairSeries>(store, firstManaged, project, REPAIR_SERIES_KIND, id),
    () => { mechanismCheck(false, era.id, 'era', 'The era producer may not depend on itself'); throw new Error('Unreachable'); });
}
function prepareEraWrite(store: Store, first: Revision<RepairSeries>, origin: SeriesEraOrigin): Write | null {
  const project = first.value.projectId, existing = lookupSeriesEra(store, project, first.id);
  if (existing) {
    const original = checkedEraProduction(store, existing);
    mechanismCheck(original.revision < first.revision || (sameRef(reference(original), reference(first))
      && canonical(existing.value.origin) === canonical(origin)), existing.id, 'firstManaged',
    'An existing era cannot move its threshold or replace its original producer');
    return null;
  }
  if (first.revision > 1) {
    const previous = store.get<RepairSeries>(first.id, first.revision - 1);
    mechanismCheck(previous && previous.value.contract === undefined && previous.value.activation === undefined,
      first.id, 'era', 'A later managed revision cannot recreate a lost era source');
  }
  const value: SeriesEra = { contract: 'om-series-era/v1', project, seriesId: first.id, firstManaged: reference(first), origin };
  return { id: seriesEraId(project, first.id), kind: SERIES_ERA_KIND, expected: 0, value };
}

/** Completion ownership is independent of the B3 membership/revision era. */
export interface CompletionPlan { routes: Ref; batches: readonly string[] }
export const COMPLETION_OWNER_KIND = 'om-completion-owner';
export const COMPLETION_ERA_KIND = 'om-completion-era';
export const COMPLETION_ASSIGNMENT_KIND = 'om-completion-assignment';
export const COMPLETION_WORK_KIND = 'om-completion-work';
export const COMPLETION_CLOSE_KIND = 'om-completion-close';
export interface CompletionOwner {
  contract: 'om-completion-owner/v1'; project: string; series: Ref; previous: Ref;
  attempt: number; owner: SeriesOwner; goal: AttemptGoal; plan: CompletionPlan; admission: MechanismAdmission | null;
}
export interface CompletionEra {
  contract: 'om-completion-era/v1'; project: string; seriesId: string;
  firstManagedAttempt: number; opening: Ref; binding: Ref;
}
export interface CompletionAssignment {
  contract: 'om-completion-assignment/v1'; project: string; binding: Ref;
  key: string; kind: 'root' | 'part' | 'continuation' | 'fact'; parent: Ref | null;
  source: Ref; batch: string; position: number | null; question: string | null;
}
export interface CompletionWork {
  contract: 'om-completion-work/v1'; project: string; binding: Ref; previous: Ref | null;
  assignments: Ref[]; products: Ref[]; journal: Ref | null; closed: Ref | null;
}
/** H1.0c: the exact pre-close work, the additions of the close (explicitly none) and its final journal, to rederive. */
export interface ManagedClosure { binding: Ref; work: Ref; additions: readonly Ref[]; journal: Ref | null; progress?: typeof ATTEMPT_PROGRESS_CONTRACT }
export const completionOwnerId = (project: string, seriesId: string, attempt: number): string =>
  `${COMPLETION_OWNER_KIND}:${project}:${hashJson({ seriesId, attempt })}`;
export const completionEraId = (project: string, seriesId: string): string =>
  `${COMPLETION_ERA_KIND}:${project}:${hashJson(seriesId)}`;
export const completionWorkId = (project: string, bindingId: string): string =>
  `${COMPLETION_WORK_KIND}:${project}:${hashJson(bindingId)}`;
export const completionCloseId = (project: string, bindingId: string): string =>
  `${COMPLETION_CLOSE_KIND}:${project}:${hashJson(bindingId)}`;
export const completionAssignmentId = (project: string, bindingId: string, key: string): string =>
  `${COMPLETION_ASSIGNMENT_KIND}:${project}:${hashJson({ binding: bindingId, key })}`;
class CompletionFailure extends Error {
  constructor(readonly result: Failed<SeriesResultCode>) { super(result.refusal.message); }
}
function completionFail(target: string, field: string, message: string, code: SeriesLocalCode = 'completion_invalid'): never {
  const result = refuse(code, message, { unit: 'G7', target, field }, 'producer');
  if (!result.ok) throw new CompletionFailure(result);
  throw new Error('Unreachable');
}
function completionTake<T>(result: SeriesResult<T>): T {
  if (!result.ok) throw new CompletionFailure(result);
  return result.value;
}
function completionResult<T>(read: () => T): SeriesResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(read()); }
    catch (error) { if (error instanceof CompletionFailure) return error.result; throw error; }
  });
}
function completionExact<T>(store: Store, project: string, ref: Ref, kind: string, id = ref.id): Revision<T> {
  if (!isRef(ref) || !ref.id.startsWith(`${kind}:${project}:`))
    completionFail(id, 'record', 'Completion evidence must belong to this project and contract');
  return completionTake(readRecord<T>(store, ref, { unit: 'G7', target: id, id, kind })) as Revision<T>;
}
function normalizeCompletionPlan(plan: CompletionPlan): CompletionPlan {
  if (!isPlainObject(plan) || !isRef(plan.routes) || !Array.isArray(plan.batches) || !plan.batches.length
    || !plan.batches.every(isText) || new Set(plan.batches).size !== plan.batches.length
    || !exactKeys(plan, ['routes', 'batches']))
    completionFail('completion', 'plan', 'Completion names an exact M6 and a nonempty unique batch set', 'completion_request_invalid');
  return { routes: exactRef(plan.routes), batches: [...plan.batches].sort() };
}
function completionEra(store: Store, project: string, seriesId: string): Revision<CompletionEra> | null {
  const id = completionEraId(project, seriesId), record = store.get<CompletionEra>(id, 1);
  if (!record) return null;
  const value = record.value;
  if (record.kind !== COMPLETION_ERA_KIND || record.revision !== 1 || !isPlainObject(value)
    || value.contract !== 'om-completion-era/v1' || value.project !== project || value.seriesId !== seriesId
    || !Number.isSafeInteger(value.firstManagedAttempt) || value.firstManagedAttempt < 1
    || !isRef(value.opening) || value.opening.id !== seriesId || !isRef(value.binding)
    || value.binding.id !== completionOwnerId(project, seriesId, value.firstManagedAttempt)
    || !exactKeys(value, ['contract', 'project', 'seriesId', 'firstManagedAttempt', 'opening', 'binding']))
    completionFail(id, 'era', 'The independent immutable completion era is contradictory');
  return record;
}
/** One derivation of the selected whole M6 batches, used at opening and historical binding reads. */
function completionPlanSources(store: Store, before: Revision<AnyRepairSeries>, request: AnyBeginAttemptRequest, plan: CompletionPlan, current: boolean) {
  const routes = completionTake(readRoutes(store, { project: request.project, record: plan.routes }));
  const selected = plan.batches.map(id => {
    const matches = routes.record.value.batches.filter(batch => batch.id === id);
    if (matches.length !== 1) completionFail(id, 'batch', 'Each selected logical root is one complete proved M6 batch');
    return matches[0]!;
  });
  const owner = seriesOwner(before.value), goal = goalOf(request.goal);
  if ('owner' in request) {
    if (!request.admission) completionFail(before.id, 'admission', 'A mechanism owner retains its full original admission');
    if (!sameRef(plan.routes, request.admission.routes) || canonical(plan.batches) !== canonical([request.admission.batch]))
      completionFail(before.id, 'admission', 'M5 completion retains its exact single admitted batch');
  } else for (const batch of selected) {
    if (batch.items.some(item => !item.consumers.includes(request.block))
      || batch.task === 'node-expansion' && batch.level === 2 && batch.node !== request.block)
      completionFail(before.id, 'batch', 'Every item in the selected whole batch belongs to this consumer');
  }
  const questions = [...new Set(selected.flatMap(batch => batch.items.map(item => gapLineKey(request.project, item.target, item.field))))].sort();
  const results = [...new Set(selected.flatMap(batch => batch.items.map(item => gapLineExpectedResult(request.project, item.target, item.field))))];
  if (canonical(questions) !== canonical(goal.questions) || results.length !== 1 || results[0] !== goal.result)
    completionFail(before.id, 'goal', 'The initial work must cover exactly the complete recorded question set and result');
  const guards: TransactionGuard[] = [reference(before)];
  if (current) {
    const fresh = completionTake(prepareRoutes(store, JSON.parse(canonical({ ...routes.record.value.request,
      tasks: routes.record.value.request.tasks.map(record => ({ record })) }))));
    if (fresh.writes.length || !sameRef(reference(fresh.record), plan.routes))
      completionFail(before.id, 'routes', 'The new managed opening requires the exact current M6', 'input_stale');
    guards.push(...fresh.guards);
  }
  return { owner, goal, guards };
}
/** NR1 (№3600): a trusted read — the owner was written once, atomically with its opening, by prepareManagedBeginAttempt. */
export function readCompletionOwnerAt(store: Store, project: string, ref: Ref): SeriesResult<Sealed<Revision<CompletionOwner>>> {
  return completionResult(() => historicalRead(store, { reader: 'G7.completion-owner', project, ref },
    () => completionExact<CompletionOwner>(store, project, ref, COMPLETION_OWNER_KIND),
    () => completionFail(ref.id, 'history', 'A completion owner cannot derive from itself')));
}
/** Addressed selector. Missing a known managed ordinal is damage, never a legacy fallback. */
export function readCompletionBinding(store: Store, project: string, series: Ref, ordinal: number): SeriesResult<Sealed<Revision<CompletionOwner> | null>> {
  return completionResult(() => {
    const source = completionTake(readRecord<AnyRepairSeries>(store, series,
      { unit: 'G7', target: series.id, kind: REPAIR_SERIES_KIND, id: series.id }));
    if (!isPlainObject(source.value) || !Array.isArray(source.value.inherited) || !Array.isArray(source.value.attempts))
      completionFail(series.id, 'series', 'The completion selector needs a full exact original series');
    const inherited = source.value.inherited.find(attempt => attempt.ordinal === ordinal);
    if (inherited && source.value.predecessor)
      return completionTake(readCompletionBinding(store, project, source.value.predecessor, ordinal)) as Revision<CompletionOwner> | null;
    const id = completionOwnerId(project, series.id, ordinal), binding = store.get<CompletionOwner>(id, 1);
    const era = completionEra(store, project, series.id);
    if (!era) {
      if (binding || store.get(completionWorkId(project, id), 1)) completionFail(id, 'era', 'Managed evidence has lost its independent era');
      return null;
    }
    if (ordinal < era.value.firstManagedAttempt) {
      if (binding) completionFail(id, 'era', 'A binding cannot precede its completion threshold');
      return null;
    }
    const first = completionTake(readCompletionOwnerAt(store, project, era.value.binding));
    if (!sameRef(first.value.series, era.value.opening) || first.value.attempt !== era.value.firstManagedAttempt)
      completionFail(era.id, 'opening', 'The threshold must reproduce the first managed opening');
    if (!source.value.attempts.some(attempt => attempt.ordinal === ordinal) && !binding) return null;
    if (!binding) completionFail(id, 'binding', 'A managed attempt has lost its mandatory owner');
    const checked = completionTake(readCompletionOwnerAt(store, project, reference(binding))) as Revision<CompletionOwner>;
    const initial = store.get<CompletionWork>(completionWorkId(project, id), 1);
    const expected: CompletionWork = { contract: 'om-completion-work/v1', project, binding: reference(checked),
      previous: null, assignments: completionRootAssignments(checked).map(reference).sort((a, b) => compareKeys(canonical(a), canonical(b))),
      products: [], journal: null, closed: null };
    if (!initial || initial.kind !== COMPLETION_WORK_KIND || initial.hash !== hashJson(expected)
      || canonical(initial.value) !== canonical(expected))
      completionFail(id, 'work', 'A managed opening needs its initial registry');
    for (const root of completionRootAssignments(checked)) {
      const actual = completionExact<CompletionAssignment>(store, project, reference(root), COMPLETION_ASSIGNMENT_KIND);
      if (canonical(actual) !== canonical(root)) completionFail(root.id, 'assignment', 'The initial root must retain its exact producer value');
    }
    return checked;
  });
}
export function completionRootAssignments(binding: Revision<CompletionOwner>): Revision<CompletionAssignment>[] {
  return binding.value.plan.batches.map(batch => {
    const value: CompletionAssignment = { contract: 'om-completion-assignment/v1', project: binding.value.project,
      binding: reference(binding), key: `batch:${batch}`, kind: 'root', parent: null,
      source: binding.value.plan.routes, batch, position: null, question: null };
    return { id: completionAssignmentId(value.project, binding.id, value.key), kind: COMPLETION_ASSIGNMENT_KIND,
      revision: 1, hash: hashJson(value), value };
  });
}
/** H1.0c: the one non-physical check of the whole selected goal; no batch, packet or E1 field is invented for it. */
export const ANSWERS_GATE_ASSIGNMENT_KEY = 'answers-gate' as const;
export const ANSWERS_GATE_ASSIGNMENT_CONTRACT = 'om-answers-gate-assignment/v1' as const;
export interface AnswersGateAssignment {
  contract: typeof ANSWERS_GATE_ASSIGNMENT_CONTRACT; project: string; binding: Ref;
  key: typeof ANSWERS_GATE_ASSIGNMENT_KEY; kind: 'answers-gate'; owner: SeriesOwner; goal: AttemptGoal; plan: CompletionPlan;
}
export function answersGateAssignment(binding: Revision<CompletionOwner>): Revision<AnswersGateAssignment> {
  check(isPlainObject(binding) && isText(binding.id) && isPlainObject(binding.value) && isText(binding.value.project)
    && isPlainObject(binding.value.owner) && isPlainObject(binding.value.goal) && isPlainObject(binding.value.plan)
    && isRef(reference(binding)), 'series_request_invalid', 'The answers-gate check derives from one exact completion binding');
  const value: AnswersGateAssignment = { contract: ANSWERS_GATE_ASSIGNMENT_CONTRACT, project: binding.value.project,
    binding: reference(binding), key: ANSWERS_GATE_ASSIGNMENT_KEY, kind: 'answers-gate', owner: binding.value.owner,
    goal: binding.value.goal, plan: binding.value.plan };
  return { id: completionAssignmentId(value.project, binding.id, value.key), kind: COMPLETION_ASSIGNMENT_KIND,
    revision: 1, hash: hashJson(value), value };
}
/** NR1 (№3600): a trusted read — the check was written as its derivation from the exact block binding (№1628 Q2). */
export function readAnswersGateAssignmentAt(store: Store, project: string, ref: Ref): SeriesResult<Sealed<Revision<AnswersGateAssignment>>> {
  requireStore(store); requireProject(project);
  check(isRef(ref), 'series_request_invalid', 'An answers-gate assignment is read by an exact reference');
  return completionResult(() => historicalRead(store, { reader: 'G7.answers-assignment', project, ref },
    () => {
      const row = completionExact<AnswersGateAssignment>(store, project, ref, COMPLETION_ASSIGNMENT_KIND);
      // The two assignment contracts share one kind; each is read only by the reader of its own contract.
      if (!isPlainObject(row.value) || row.value.contract !== ANSWERS_GATE_ASSIGNMENT_CONTRACT)
        completionFail(ref.id, 'contract', 'A physical assignment is read by its own reader, never as an answers check');
      return row;
    },
    () => completionFail(ref.id, 'history', 'An answers-gate assignment cannot derive from itself')));
}
/** G7's managed A3 preparer returns the indivisible opening bundle, never an unbacked S write. */
export function prepareManagedBeginAttempt(store: Store, request: AnyBeginAttemptRequest): SeriesResult<Sealed<AnySeriesTransition>> {
  const address = requireBeginRequest(store, request);
  return completionResult(() => {
    const before = completionTake(readAnySeries(store, request)) as Revision<AnyRepairSeries>;
    const binding = completionTake(readCompletionBinding(store, request.project, reference(before), request.attempt));
    if (!request.completion) return completionTake(prepareBeginAttempt(store, request)) as AnySeriesTransition;
    const plan = normalizeCompletionPlan(request.completion);
    if (binding) return completionTake(prepareBeginAttempt(store, request)) as AnySeriesTransition;
    const era = completionEra(store, request.project, address.id);
    const sources = completionPlanSources(store, before, request, plan, true);
    const begun = completionTake(prepareBegin(store, request, plan));
    if (!begun.transition.writes.length) completionFail(address.id, 'attempt', 'A standalone attempt cannot acquire an owner', 'completion_conflict');
    const opening = { id: address.id, revision: before.revision + 1, hash: hashJson(begun.transition.value) };
    const value: CompletionOwner = { contract: 'om-completion-owner/v1', project: request.project,
      series: opening, previous: reference(before), attempt: request.attempt, owner: sources.owner, goal: sources.goal, plan,
      admission: 'owner' in request ? normalizedAdmission(request.admission) : null };
    const owner: Revision<CompletionOwner> = { id: completionOwnerId(request.project, address.id, request.attempt),
      kind: COMPLETION_OWNER_KIND, revision: 1, hash: hashJson(value), value };
    const assignments = completionRootAssignments(owner);
    const work: CompletionWork = { contract: 'om-completion-work/v1', project: request.project, binding: reference(owner),
      previous: null, assignments: assignments.map(reference).sort((a, b) => compareKeys(canonical(a), canonical(b))), products: [], journal: null, closed: null };
    const writes: PreparedWrite[] = [...begun.transition.writes, { id: owner.id, kind: owner.kind, expected: 0, value },
      ...assignments.map(record => ({ id: record.id, kind: record.kind, expected: 0, value: record.value })),
      { id: completionWorkId(request.project, owner.id), kind: COMPLETION_WORK_KIND, expected: 0, value: work }];
    if (!era) writes.push({ id: completionEraId(request.project, address.id), kind: COMPLETION_ERA_KIND, expected: 0,
      value: { contract: 'om-completion-era/v1', project: request.project, seriesId: address.id,
        firstManagedAttempt: request.attempt, opening, binding: reference(owner) } satisfies CompletionEra });
    return { writes, guards: [...begun.transition.guards, ...sources.guards, ...(era ? [reference(era)] : [])], value: begun.transition.value };
  });
}

export function prepareManagedCompleteAttempt(store: Store, request: AnyCompleteAttemptRequest, close: Ref): SeriesResult<Sealed<AnySeriesTransition>> {
  return withHistoricalReads(() => handed(prepareComplete(store, request, close)));
}


/** The completion door belongs only to the original open attempt; it grants no new work admission. */
export function prepareCompletionAdmission(store: Store, project: string, bindingRef: Ref): SeriesResult<Sealed<{ guards: Ref[] }>> {
  return completionResult(() => {
    const binding = completionTake(readCompletionOwnerAt(store, project, bindingRef));
    const head = store.get(binding.value.series.id);
    if (!head) completionFail(binding.id, 'series', 'Completion needs its current original series');
    const series = completionTake(readAnySeriesAt(store, project, reference(head)));
    const attempt = series.value.attempts.find(row => row.ordinal === binding.value.attempt);
    if (!attempt || attempt.outcome !== null || canonical(attempt.goal) !== canonical(binding.value.goal))
      completionFail(binding.id, 'attempt', 'Only the own open attempt with the full original goal can complete');
    const line = completionTake(prepareSeriesParticipantAdmission(store, project, reference(head)));
    if (line.participation === 'unactivated') completionFail(binding.id, 'series', 'An unactivated block has no completion admission');
    if ('owner' in series.value) {
      const original = completionTake(readAnySeriesAt(store, project, binding.value.series));
      if (!('owner' in original.value)) completionFail(binding.id, 'owner', 'The original mechanism owner is mandatory');
      const admission = original.value.admissions.find(row => row.attempt === binding.value.attempt);
      if (!admission) completionFail(binding.id, 'admission', 'The original typed mechanism admission is mandatory');
      completionTake(readMechanismAdmission(store, { project, series: binding.value.series, attempt: binding.value.attempt,
        admission: admission.basis, current: false }));
    }
    return { guards: refsUnique([bindingRef, reference(head), ...line.guards]) };
  });
}


/** Reconstruct the exact opening work admission; no present-day pointer participates in this proof. */
export function readCompletionOriginalAdmission(store: Store, project: string, bindingRef: Ref): SeriesResult<Sealed<{
  series: Ref; pointer: Ref | null; references: Ref[];
}>> {
  return completionResult(() => {
    const binding = completionTake(readCompletionOwnerAt(store, project, bindingRef));
    const series = completionTake(readAnySeriesAt(store, project, binding.value.series));
    let pointer: Ref | null = null;
    if ('block' in series.value && series.value.activation?.state === 'activated') {
      const applied = checkedApplied(store, project, series.value.activation.applied);
      pointer = reference(revisionOfWrite(currentAfter(store, applied, activationWrites(store, applied))));
    }
    const original = completionTake(readSeriesWorkAdmission(store, { project, series: binding.value.series, pointer }));
    return { series: binding.value.series, pointer, references: original.references as Ref[] };
  });
}
