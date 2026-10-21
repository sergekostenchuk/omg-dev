import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import {
  delivered, isPlainObject, isText, refused, sealed,
  type OmResult, type Refusal, type RefusalRoute, type Sealed,
} from "./refusal.js";
import { readRecord, writeGuarded, type RefsRefusalCode } from "./refs.js";
import {
  normalizeOriginSource, originSourceKey, prepareClassifyRefusal, readJournal, readJournalAt, journalId, answersRowMarks,
  type JournalRow, type OriginSource, type OriginSourceContext, type RefusalClassification, type RefusalJournal, type RefusalOrigin,
} from "./refusal-journal.js";
import {
  prepareManagedBeginAttempt, prepareCompleteAttempt, readAnySeries, readAnySeriesAt, seriesAddress, seriesRequestOf, REPAIR_SERIES_KIND,
  decidedFieldsBefore,
  type Attempt, type AttemptGoal, type AttemptVerdict, type BeginAttemptRequest, type ClaimedRefusal,
  type CompletionReason, type Continuation, type GroundRecord, type RepairSeries,
  type SeriesLadder, type SeriesRequest, type SeriesStop, type SeriesTransition,
  type SeriesOwner, type MechanismSeriesRequest, type MechanismBeginAttemptRequest,
  type MechanismRepairSeries, type AnyRepairSeries, type AnySeriesRequest, type AnySeriesTransition,
} from "./series.js";
import { withHistoricalReads, historicalRead } from "./input.js";
import { confirmResults, readInputFieldResult, type ConfirmedResults, type FilledField, type InputFieldResult } from "./achievements.js";
import { projectGraph } from "../graph/project.js";
import type { Graph } from "../graph/model.js";
import { readFrame, type FrameRequest } from "./frame-obligations.js";
import { definitionIds, observeProposal, type ProposalRequest } from "./frame-proposals.js";
import { observeCandidate } from "./frame-candidate.js";
import { assessmentAttemptReason, checkCurrentAssessmentAttemptClosure, isAssessmentCallName,
  readAssessmentRefusalAt } from "./assessment.js";
import { acceptedAnswerNamespace } from "./accepted-answer.js";
import { callLedgerId, readCall, readCallLedger, type CallLedger } from "./call-record.js";

/**
 * The gate of repetition. It stands on EVERY return path — the refusal of the layer check (G3), of atomicity (G5), of
 * the compiler against the map, a refusal of feasibility that turned out to be a defect of the map, and the refusals
 * raised on grounds of readiness — and every attempt is opened and closed through it.
 *
 * It gives every refusal of a completed cycle its CLASS and its ADDRESSEE, and it does so from the refusal's ORIGIN
 * rather than from its name: the name, the STAGE it arose at, and the exact ground that tells the cases apart. A
 * definition unfit or missing IN THE PROPOSAL ITSELF is a project refusal and goes back as a question about that node;
 * an accepted record of a producer that is unfit is an error of the INPUT and goes back to that producer; a definition
 * that stood upstream and was lost by the assembly of the candidate is an error of DERIVATION and goes to whoever wrote
 * that code — never to the model, which must not compensate for it. A class is said only when the sources SUFFICE to
 * say it (SUBJECT_DECISIONS): the role it blames is named, and exactly one record of it is responsible. Anything less —
 * a missing role, several possible culprits, a stage or a role this gate does not name — is an origin NOT ESTABLISHED.
 *
 * Such a refusal is not routed on a guess, and it does not wait for the ladder: it raises a HOLD at once, in the same
 * transaction that records it. The hold is a record of its own, and this gate is its obligatory consumer — no further
 * attempt of the series is opened while one stands, a restart does not lift it, and neither do more attempts. It is
 * lifted by a transition of its own, on the exact record of the analysis of THAT refusal (which names the class it
 * established, with its grounds, and then routes the refusal by it) or of the owner's decision about it.
 *
 * It does not judge progress, and it believes nobody's word about it. A result reaches the series only as confirmed by
 * the provider of acceptance for the record that accepted it (achievements.ts), under the key that provider derived;
 * whether that result is progress, how many cycles have passed without any, whether a stop stands and which rung of
 * the ladder it is on are the SERIES' findings (A3), reported here and derived again nowhere.
 *
 * It changes neither the graph, nor the input, nor readiness, nor the gaps. It writes the series, the journal of
 * refusals and its own holds, each change in ONE guarded transaction (T7, T8).
 */
const UNIT = "gate-repeat";
const MAX_ENTITY_ID = 200; // the store's own limit on an entity id (src/storage/store.ts)

/**
 * The classes of a refusal. The table is closed because the rules attach a defined route to each of its entries and an
 * unnamed class has none: choosing a class for a refusal whose origin does not place it would be the invention of a
 * verdict, and the rules answer that case with "unknown" instead.
 */
export const REFUSAL_CLASSES = Object.freeze([
  "proposal", "input", "derivation", "conditions", "readiness", "unknown",
] as const);
export type RefusalClass = typeof REFUSAL_CLASSES[number];

/**
 * The stages a refusal arises at — the return paths the rules name, and only those.
 * The stage decides the two classes that are decided BY the stage: feasibility gives the conditions of repository,
 * environment and executor, readiness gives the review of a ground in M2. The other stages are placed by the subject of
 * the refusal. A stage this table does not name has no defined effect, so it leaves the origin not established.
 */
export const REFUSAL_STAGES = Object.freeze([
  "layer-check", "atomicity", "compilation", "feasibility", "readiness",
] as const);
export type RefusalStage = typeof REFUSAL_STAGES[number];

/**
 * The parts the sources of an origin played, and the only ones this gate can weigh a subject against.
 * "proposal" is what the model offered for this question, "base" an accepted record of a producer (a stage, an upper
 * layer, a frame), "derived" what the code of the block assembled out of them, and "environment" the repository,
 * workspace or executor a feasibility check stood on. An unnamed role is not read as one of these.
 */
export const ORIGIN_ROLES = Object.freeze(["proposal", "base", "derived", "environment"] as const);
/** G6.2 (№3885 В2): the role naming the accepting attempt's series in a G5 finding of the candidate — no subject role. */
export const ACCEPTING_ROLE = "accepting" as const;
export type OriginRole = typeof ORIGIN_ROLES[number];

type MapRole = "proposal" | "base" | "derived";
// The roles that carry definitions of the map. An environment record is read to prove it stands at the reference it is
// named by; what it holds is not this gate's to interpret.
const MAP_ROLES: readonly OriginRole[] = Object.freeze(["proposal", "base", "derived"] as const);

/**
 * Who a refusal of each class goes back to. The kind is this gate's word; the target beside it is the concrete node,
 * record or block, so that the addressee of one refusal is never a pair of "a name and a goal" two legitimate refusals
 * could share (the exact grounds travel with the classification).
 */
export const ADDRESSEE_KINDS: Readonly<Record<RefusalClass, string>> = Object.freeze({
  proposal: "node",       // the project question about this node: M5 and MC2
  input: "producer",      // the producer of the accepted record that is unfit
  derivation: "code",     // whoever wrote the code that lost the definition
  conditions: "owner",    // the owner or the environment
  readiness: "m2",        // the review of the ground of readiness in M2
  unknown: "analysis",    // the hold of an origin not established, at the address of the series
});

// The route of A1 each class travels back on.
const ROUTES: Readonly<Record<RefusalClass, RefusalRoute>> = Object.freeze({
  proposal: "gap", input: "producer", derivation: "producer",
  conditions: "owner", readiness: "readiness", unknown: "owner",
});

/**
 * Which class may travel to the model. Only a refusal of the PROPOSAL is a question for it; an error of the input and
 * an error of derivation are not sent along with the project ones, because a model that was asked to compensate for
 * them would be answering for somebody else's record or somebody else's code.
 */
const TO_MODEL: Readonly<Record<RefusalClass, boolean>> = Object.freeze({
  proposal: true, input: false, derivation: false, conditions: false, readiness: false, unknown: false,
});

/**
 * How many sources of each role of the map an origin names, and how many of them hold the refused subject.
 */
export interface OriginTally {
  readonly named: Readonly<Record<MapRole, number>>;
  readonly holding: Readonly<Record<MapRole, number>>;
}

/**
 * THE TABLE OF DECISION for a refusal placed by its subject: each row is a class and the condition under which the
 * sources SUFFICE to say it. A class blamed on a HOLDER needs that holder named, and exactly one of it — two records
 * that could each be the culprit leave nobody singled out. A class blamed on an ABSENCE needs every place the
 * definition could have been named and looked in. There is no last row that answers by default: a tally no row admits
 * is an origin not established, and a tally two rows admitted would be a defect of this table, which its test walks
 * every combination of to exclude.
 *   derivation — exactly one derived is named and it does not hold the subject; exactly one record upstream (proposal
 *                or base) holds it: it stood, and the one assembly named lost it.
 *   input      — exactly one base holds it; no proposal holds it; every derived named holds it: the accepted record is
 *                where it is, and nothing downstream lost it.
 *   proposal   — exactly one proposal is named, no base holds it, and either the proposal holds it and every derived
 *                named holds it (unfit in the proposal), or the proposal does not hold it, at least one base was named
 *                and looked in, and no derived holds what upstream lacks (missing from the proposal).
 */
export const SUBJECT_DECISIONS: readonly Readonly<{ class: RefusalClass; sufficient: (tally: OriginTally) => boolean }>[] = Object.freeze([
  Object.freeze({
    class: "derivation" as const,
    sufficient: (t: OriginTally) => t.named.derived === 1 && t.holding.derived === 0
      && t.holding.proposal + t.holding.base === 1,
  }),
  Object.freeze({
    class: "input" as const,
    sufficient: (t: OriginTally) => t.holding.base === 1 && t.holding.proposal === 0
      && t.holding.derived === t.named.derived,
  }),
  Object.freeze({
    class: "proposal" as const,
    sufficient: (t: OriginTally) => t.named.proposal === 1 && t.holding.base === 0 && (
      (t.holding.proposal === 1 && t.holding.derived === t.named.derived)
      || (t.holding.proposal === 0 && t.named.base >= 1 && t.holding.derived === 0)),
  }),
]);

/**
 * The refusals of the gate itself, as its card names them. They are reported BESIDE an applied change, never instead
 * of one: a refusal switches nothing (T8), and the outcome of the cycle and the classes of its refusals are recorded
 * whether or not the gate has something of its own to say about them.
 * A refusal of the PROPOSAL and one of READINESS raise none of these: the first is the gate's pass to M5 and MC2, the
 * second the review of a ground in M2, and both travel on as classifications rather than as refusals of this gate.
 */
export const GATE_REFUSAL_CODES = Object.freeze([
  "stopped_without_progress", "beyond_block", "handed_to_producer", "origin_unestablished",
] as const);
export type GateRefusalCode = typeof GATE_REFUSAL_CODES[number];

const GATE_REFUSAL_OF: Readonly<Record<RefusalClass, GateRefusalCode | null>> = Object.freeze({
  proposal: null, readiness: null,
  input: "handed_to_producer", derivation: "handed_to_producer",
  conditions: "beyond_block", unknown: "origin_unestablished",
});

// Every refusal this unit can produce of its own. The list is the checklist its test walks, so a new code cannot
// arrive untested.
export const REPEAT_GATE_CODES = Object.freeze([
  "refusals_unlinked", "refusal_unknown", "origin_unreadable", "stop_absent",
  "origin_held", "hold_invalid", "lift_unusable", "lift_conflict",
] as const);
export type RepeatGateCode = typeof REPEAT_GATE_CODES[number];

/**
 * The records of the hold of an origin not established, and of the two grounds that lift it.
 * The HOLD is written by this gate, in the transaction that records the refusal. The ANALYSIS of the origin is written
 * by A6 and names the class it established with its grounds; the owner's DECISION about a hold is written by the
 * command API of H2. This gate only reads those two, at their exact references, inside this project's namespace.
 */
export const ORIGIN_HOLD_KIND = "om-origin-hold";
export const ORIGIN_ANALYSIS_KIND = "om-origin-analysis";
export const ORIGIN_DECISION_KIND = "om-origin-decision";

/** The grounds a hold is lifted on, and the only ones: a sentence of whoever wants to go on is not among them. */
export const LIFT_GROUNDS = Object.freeze(["origin-analysis", "owner-decision"] as const);
export type LiftGround = typeof LIFT_GROUNDS[number];

/** What derived a class for one refusal: its class, who it goes back to, and whether it may travel to the model. */
export interface RoutedRefusal {
  /**
   * The row of the journal this stands for. The name and the goal of the refusal are NOT copied here: the row id is
   * the hash of the row's own content, so it fixes them exactly, and a copy would be a second truth free to drift.
   */
  readonly row: string;
  readonly class: RefusalClass;
  readonly addressee: string;
  readonly toModel: boolean;
  /** The exact records the class was weighed against — empty when the origin was not established at all. */
  readonly basis: readonly OriginSource[];
}

/** The lift of a hold: on what ground, on which exact record, and the route that record established, if any. */
export interface HoldLift {
  readonly ground: LiftGround;
  readonly record: Ref;
  /** The class the analysis established, or null when the owner decided to go on without one. */
  readonly class: RefusalClass | null;
  readonly addressee: string | null;
  readonly basis: readonly OriginSource[];
}

/**
 * The hold one refusal of unknown origin raised. It names the exact revision of the series that recorded the refusal,
 * the attempt and the journal row it is about, and the address for the analysis; `lift` is null while it stands.
 * Its id is derived from the block, the attempt and the row, so the hold of one refusal has one address across the
 * whole lineage of the series — a successor inherits the attempt, and with it the hold.
 */
export interface OriginHold {
  readonly projectId: string;
  readonly block: string;
  readonly series: Ref;
  readonly attempt: number;
  readonly row: string;
  readonly address: string;
  readonly lift: HoldLift | null;
}

/** A standing hold as it is shown to whoever takes the analysis: where it is, what it is about, and the origin. */
export type MechanismOriginHold = Omit<OriginHold, 'block'> & { readonly owner: Extract<SeriesOwner, { kind: 'mechanism' }> };
export type AnyOriginHold = OriginHold | MechanismOriginHold;

export interface HoldContext {
  readonly hold: Ref;
  readonly attempt: number;
  readonly row: string;
  readonly address: string;
  readonly origin: RefusalOrigin;
}

/** One repeated obstacle, with the address and the responsible the class of its refusal gives it. */
export interface StopObstacle {
  readonly row: string;
  /** null when this gate has not classified the row: an unclassified obstacle is said to be one, never guessed at. */
  readonly class: RefusalClass | null;
  readonly addressee: string | null;
  /** How many attempts of the window ran into it: a refusal that repeats is one this number is above one for. */
  readonly times: number;
}

export interface AttemptEnding {
  readonly attempt: number;
  readonly reason: CompletionReason;
}

/**
 * The context of what stops a series, assembled BY CODE from the records of the attempts — no model is called to
 * write it. One and the same context reaches the reviewer on the first rung of the ladder and the owner on the second,
 * and whoever takes the analysis of a hold. `stop` is the series' stop without progress, `holds` the holds of an
 * origin not established; either may stand alone, and a context exists only while one of them does.
 */
export interface StopContext {
  readonly series: string;
  readonly stop: SeriesStop | null;
  readonly holds: readonly HoldContext[];
  readonly ladder: SeriesLadder;
  readonly goals: readonly AttemptGoal[];
  readonly accepted: readonly string[];
  readonly repeated: readonly StopObstacle[];
  readonly endings: readonly AttemptEnding[];
  readonly grounds: readonly Continuation[];
}

/**
 * A context together with the MUTABLE HEADS it was read from: the records whose CURRENT revision this reading depends
 * on — the series, the journal of refusals, and every hold of the lineage, the ones that still stand and the ones
 * already lifted alike. Whoever acts on a context guards its transaction with them, so that nothing the reading stood
 * on moves between it and the write (T7); a consumer that guarded only the standing holds would let the head of a
 * lifted one change underneath it.
 * The HISTORICAL records a context names — the revision of the series a hold was raised at, the record a hold was
 * lifted on — are deliberately NOT among them: they are read at their exact references, and a newer revision of any of
 * them makes none of them false (T3).
 */
export interface ContextReading {
  readonly context: StopContext;
  readonly reads: readonly Ref[];
}

export interface StopContextSources {
  readonly series: Ref;
  readonly journal: Ref | null;
  readonly holds: readonly Ref[];
}

/**
 * What the gate hands back once a cycle has been closed through it.
 * The verdict, the count, the stop and the rung are the SERIES' findings, reported here rather than derived again.
 */
export interface RepeatOutcome {
  readonly attempt: number;
  readonly verdict: AttemptVerdict | null;
  readonly withoutProgress: number;
  /** Every refusal of the cycle, each with its own class and route: none is lost behind a chosen "main" one. */
  readonly routed: readonly RoutedRefusal[];
  /** The nodes a project question is raised for — the refusals of the proposal, and no others. */
  readonly question: readonly string[];
  /** The gate's own refusals, each addressed and routed. */
  readonly refusals: readonly Refusal[];
  readonly stop: SeriesStop | null;
  /** The holds standing for this cycle's refusals of unknown origin, at the exact revisions they stand at. */
  readonly holds: readonly Ref[];
  /** Named only while a stop stands, and named as the series DERIVED it. */
  readonly ladder: SeriesLadder | null;
  readonly context: StopContext | null;
}

/**
 * The outcome of a cycle as it is handed to this gate. Its results are named by the RECORDS that accepted them and the
 * transitions that cancelled earlier ones — never by a key: the keys are derived by the providers of acceptance.
 */
export interface GateOutcome {
  readonly reason: CompletionReason;
  readonly accepting: readonly Ref[];
  readonly cancelling: readonly Ref[];
  readonly refusals: readonly ClaimedRefusal[];
}

export interface CloseAttemptRequest extends SeriesRequest {
  readonly terminal?: Ref;
  readonly attempt: number;
  readonly outcome: GateOutcome;
}

export type MechanismCloseAttemptRequest = MechanismSeriesRequest & { readonly attempt: number; readonly outcome: GateOutcome };
export type AnyCloseAttemptRequest = CloseAttemptRequest | MechanismCloseAttemptRequest;
type AnyBeginAttemptRequest = BeginAttemptRequest | MechanismBeginAttemptRequest;

/** Names the exact standing hold it lifts, so a late repeat finds its own lift and never lifts another hold (T5). */
export interface LiftOriginHoldRequest {
  readonly project: string;
  readonly hold: Ref;
  readonly ground: LiftGround;
  readonly record: GroundRecord;
}

/** One prepared change: the records to write, the exact references guarding them, and what the gate would report. */
export interface GateWrite {
  readonly id: string;
  readonly kind: string;
  readonly expected: number;
  readonly value: unknown;
}
export interface RepeatTransition {
  readonly writes: readonly GateWrite[];
  readonly guards: readonly TransactionGuard[];
  readonly value: RepeatOutcome;
}
export interface HoldTransition {
  readonly writes: readonly GateWrite[];
  readonly guards: readonly Ref[];
  readonly value: AnyOriginHold;
}

type Address = ReturnType<typeof seriesAddress>;
interface SourceReading {
  readonly role: OriginRole; readonly ref: Ref; readonly holdsSubject: boolean;
  readonly context: Sealed<OriginSourceContext> | null;
}
/** An origin as it is weighed: the stage it arose at, the refused subject, and the exact records to weigh it against. */
interface WeighedOrigin { readonly stage: string; readonly subject: string; readonly sources: readonly OriginSource[] }
/**
 * Where one weighing of an origin happens — the same weighing on either path, told only what differs between them:
 * the record its refusals are addressed at, the block a class decided by the readiness stage goes back to, the address
 * an origin not established is held at, the field path of the set of sources, and the code and route an unreadable
 * source is refused with here.
 */
interface Placing {
  readonly project: string;
  readonly target: string;
  readonly owner: SeriesOwner;
  readonly series: string;
  readonly sources: string;
  readonly code: RepeatGateCode;
  readonly route: RefusalRoute;
}
interface Derived {
  readonly class: RefusalClass; readonly addressee: string; readonly basis: readonly OriginSource[];
  readonly assessment?: { readonly intent: Ref; readonly result: Ref; readonly source: Ref; readonly guards: readonly Ref[] };
}
interface Resolution { readonly class: RefusalClass | null; readonly addressee: string | null; readonly basis: readonly OriginSource[] }
interface Located { readonly ref: Ref; readonly value: unknown; readonly write: GateWrite | null }
interface Holds { readonly standing: readonly HoldContext[]; readonly guards: readonly Ref[] }

const GATE_OUTCOME_KEYS = Object.freeze(["reason", "accepting", "cancelling", "refusals"] as const);
const HOLD_KEYS = Object.freeze(["projectId", "block", "series", "attempt", "row", "address", "lift"] as const);
const MECHANISM_HOLD_KEYS = Object.freeze(HOLD_KEYS.map(key => key === "block" ? "owner" : key));
const LIFT_KEYS = Object.freeze(["ground", "record", "class", "addressee", "basis"] as const);
const REF_SOURCE_KEYS = Object.freeze(["ref"] as const);
const PENDING_SOURCE_KEYS = Object.freeze(["pending"] as const);
const PENDING_KEYS = Object.freeze(["id", "kind", "value"] as const);

export function originHoldNamespace(project: string): string {
  return `${ORIGIN_HOLD_KIND}:${requireProject(project)}:`;
}
export function originAnalysisNamespace(project: string): string {
  return `${ORIGIN_ANALYSIS_KIND}:${requireProject(project)}:`;
}
export function originDecisionNamespace(project: string): string {
  return `${ORIGIN_DECISION_KIND}:${requireProject(project)}:`;
}

/** The one address of the hold of one refusal met by one attempt of one block's lineage. */
export function originHoldId(project: string, block: string | SeriesOwner, attempt: number, row: string): string {
  requireCondition((isText(block) || validOwner(block)) && Number.isSafeInteger(attempt) && attempt >= 1 && isText(row),
    "repeat_request_invalid", "A hold is addressed by its block, the attempt and the journal row it is about");
  return `${originHoldNamespace(project)}${hashJson(typeof block === "string" ? { block, attempt, row } : block.kind === "block"
    ? { block: block.block, attempt, row } : { owner: block, attempt, row })}`;
}

// ---------------------------------------------------------------------------
// Opening and closing a cycle.

/**
 * Opens the next attempt of a series — the only way it is opened (H1 opens and closes attempts through this gate).
 * It is refused while a hold of an origin not established stands anywhere in the lineage of the series: the direct
 * route of such a refusal is an analysis, not more attempts. Everything else — the ordinal, a running attempt, a stop
 * without progress — is the series' to rule on, and repeating an attempt that is already open changes nothing (T5).
 */
export function openAttempt(store: Store, request: BeginAttemptRequest): OmResult<Sealed<Revision<RepairSeries>>>;
export function openAttempt(store: Store, request: MechanismBeginAttemptRequest): OmResult<Sealed<Revision<MechanismRepairSeries>>>;
export function openAttempt(store: Store, request: AnyBeginAttemptRequest): OmResult<Sealed<Revision<AnyRepairSeries>>>;
export function openAttempt(store: Store, request: AnyBeginAttemptRequest): OmResult<Sealed<Revision<AnyRepairSeries>>> {
  const prepared = prepareOpen(store, request);
  if (!prepared.ok) return prepared;
  const { writes, guards } = prepared.value.transition;
  if (writes.length === 0) return delivered(prepared.value.current);
  const written = writeGuarded<AnyRepairSeries>(store, { unit: UNIT, target: writes[0]!.id, guards, writes: [...writes] });
  if (!written.ok) return written;
  return delivered(written.value[0]!);
}

/** The same, prepared and not written, for a caller that opens an attempt together with records of its own. */
export function prepareOpenAttempt(store: Store, request: BeginAttemptRequest): OmResult<Sealed<SeriesTransition>>;
export function prepareOpenAttempt(store: Store, request: AnyBeginAttemptRequest): OmResult<Sealed<AnySeriesTransition>>;
export function prepareOpenAttempt(store: Store, request: AnyBeginAttemptRequest): OmResult<Sealed<AnySeriesTransition>> {
  const prepared = prepareOpen(store, request);
  return prepared.ok ? delivered(prepared.value.transition) : prepared;
}

/**
 * Closes one completed cycle at the gate: confirms its results, records its outcome in the series, the class of each
 * of its refusals in the journal and a hold for each refusal of unknown origin — in ONE guarded transaction.
 * Either all of it stands afterwards or none of it does. Delivering the same cycle again writes nothing (T5).
 */
export function closeAttempt(store: Store, request: AnyCloseAttemptRequest): OmResult<Sealed<RepeatOutcome>> {
  const prepared = prepareClose(store, request);
  if (!prepared.ok) return prepared;
  const { writes, guards, value } = prepared.value;
  // Nothing to write is a fact, not a failure: the records already hold what was asked for.
  if (writes.length === 0) return delivered(value);
  const written = writeGuarded(store, { unit: UNIT, target: writes[0]!.id, guards, writes: [...writes] });
  if (!written.ok) return written;
  return delivered(value);
}

/**
 * The same change, prepared and not written, for a caller that writes MORE than these records at once — MC2 closing
 * the entry of the model call in the ledger together with the outcome the call produced (T7).
 */
export function prepareCloseAttempt(store: Store, request: AnyCloseAttemptRequest): OmResult<Sealed<RepeatTransition>> {
  const prepared = prepareClose(store, request);
  return prepared.ok ? delivered(prepared.value) : prepared;
}

/**
 * Lifts the hold the request names, on the exact record of the analysis of THAT refusal or of the owner's decision
 * about it — stored already, or written with the lift. The analysis routes the refusal by the class it established.
 * A lift is applied to its own hold and once: the same lift again changes nothing, another ground for a hold lifted
 * already is refused, and a record about another hold lifts nothing (T5). A hold switches nothing but the opening of
 * attempts of its series, and so does its lift (T8).
 */
export function liftOriginHold(store: Store, request: LiftOriginHoldRequest): OmResult<Sealed<Revision<AnyOriginHold>>> {
  const prepared = prepareLift(store, request);
  if (!prepared.ok) return prepared;
  const { writes, guards } = prepared.value.transition;
  if (writes.length === 0) return delivered(prepared.value.current);
  const written = writeGuarded<AnyOriginHold>(store, { unit: UNIT, target: writes[0]!.id, guards, writes: [...writes] });
  if (!written.ok) return written;
  return delivered(written.value[0]!);
}

/** Reads a hold through the same proof; an explicit journal keeps the whole reading on saved historical sources. */
export function readOriginHoldAt(store: Store, project: string, ref: Ref, journalRef?: Ref): OmResult<Sealed<Revision<AnyOriginHold>>> {
  return withHistoricalReads(() => {
    requireStore(store); requireProject(project);
    requireCondition(isRef(ref), "repeat_request_invalid", "A historical hold requires its exact reference");
    const read = readRecord<AnyOriginHold>(store, ref, { unit: UNIT, target: ref.id,
      kind: ORIGIN_HOLD_KIND, idPrefix: originHoldNamespace(project) });
    if (!read.ok) return read;
    const journal = journalRef === undefined ? readJournal(store, { project }) : readJournalAt(store, project, journalRef);
    if (!journal.ok) return refused("hold_invalid", "The hold has no checked journal of its refusal",
      { unit: UNIT, target: ref.id, field: "row", ref }, "producer");
    const broken = checkHold(store, project, read.value as Revision<AnyOriginHold>, journal.value.value as RefusalJournal);
    return broken ?? delivered(read.value);
  });
}

/** The same, prepared and not written, for A6 or H2 writing the ground and lifting on it in one transaction. */
export function prepareLiftOriginHold(store: Store, request: LiftOriginHoldRequest): OmResult<Sealed<HoldTransition>> {
  const prepared = prepareLift(store, request);
  return prepared.ok ? delivered(prepared.value.transition) : prepared;
}

/**
 * The context of what stops one series — its stop without progress, its standing holds, or both — for the reviewer,
 * the owner and whoever takes an analysis alike. It reads and changes nothing; a series where nothing stops the work
 * has no context to give, and says so.
 */
export function stopContext(store: Store, request: AnySeriesRequest): OmResult<Sealed<StopContext>> {
  const read = contextReading(store, request);
  return read.ok ? delivered(read.value.context) : read;
}

/**
 * The same context, with the mutable heads it was read from beside it (ContextReading), for a consumer that goes on to
 * write on it: it guards its transaction with them instead of guessing which records this gate touched.
 */
export function readStopContext(store: Store, request: AnySeriesRequest): OmResult<Sealed<ContextReading>> {
  const read = contextReading(store, request);
  return read.ok ? delivered(read.value) : read;
}

/** Every mutable source is named explicitly; the saved series and journal determine which holds must be present. */
export function readStopContextAt(store: Store, request: { project: string; sources: StopContextSources }): OmResult<Sealed<ContextReading>> {
  const invalid = (field: string): never => { throw new EngineError("repeat_request_invalid", "A historical context needs its complete exact sources",
    { unit: UNIT, target: "stop-context", field }); };
  if (!(store instanceof Store)) invalid("store");
  if (!isPlainObject(request)) invalid("request");
  let project: string;
  try { project = requireProject(request.project); }
  catch (error) { if (error instanceof EngineError && error.code === "repeat_request_invalid") invalid("project"); throw error; }
  const sources = request.sources;
  if (!(isPlainObject(sources) && exactKeys(sources, ["series", "journal", "holds"])
    && isRef(sources.series) && (sources.journal === null || isRef(sources.journal))
    && Array.isArray(sources.holds) && sources.holds.every(isRef))) invalid("sources");
  const fixed = sealed({ series: exactRef(sources.series), journal: sources.journal === null ? null : exactRef(sources.journal),
    holds: sources.holds.map(exactRef) });
  return withHistoricalReads(() => {
    const series = readAnySeriesAt(store, project, fixed.series);
    if (!series.ok) return series;
    const address = seriesAddress(seriesRequestOf(series.value.value));
    const read = contextReadingOf(store, address, series.value as Revision<AnyRepairSeries>, fixed);
    return read.ok ? delivered(read.value) : read;
  });
}

function contextReading(store: Store, request: AnySeriesRequest): OmResult<ContextReading> {
  return withHistoricalReads(() => contextReadingInScope(store, request));
}
function contextReadingInScope(store: Store, request: AnySeriesRequest): OmResult<ContextReading> {
  requireStore(store);
  requireCondition(isPlainObject(request), "repeat_request_invalid", "The context of a stop is asked for through a request object");
  const address = requireAddress(request);
  const series = readAnySeries(store, request);
  if (!series.ok) return series;
  return contextReadingOf(store, address, series.value as Revision<AnyRepairSeries>);
}
function contextReadingOf(store: Store, address: Address, current: Revision<AnyRepairSeries>, sources?: StopContextSources): OmResult<ContextReading> {
  const held = current.value;
  const holds = holdsOf(store, address, held, sources);
  if ("ok" in holds) return holds;
  if (held.stop === null && holds.standing.length === 0) {
    return refused("stop_absent", "Neither a saved stop nor a hold stands in this series, so there is no context of one to assemble",
      { unit: UNIT, target: address.id, field: "stop" }, "producer");
  }
  // holdsOf hands back the heads it read — the journal and every hold of the lineage, lifted or standing — and the
  // series' own head is the other one: a context is only as current as these.
  const reads: Ref[] = [reference(current), ...holds.guards];
  let decided: ReadonlyMap<string, RefusalClassification> = new Map();
  if (rowsOf(held).size > 0) {
    const journal = contextJournal(store, address, sources);
    if (!journal.ok) return unlinked(address, journal.refusal.code, "stop.refusals");
    reads.push(reference(journal.value));
    decided = new Map(journal.value.value.classifications.map(item => [item.row, item as RefusalClassification]));
  }
  return { ok: true, value: { context: contextOf(address, held, holds.standing, decided), reads: uniqueGuards(reads) } };
}

// ---------------------------------------------------------------------------

function prepareOpen(store: Store, request: AnyBeginAttemptRequest):
OmResult<{ readonly transition: AnySeriesTransition; readonly current: Revision<AnyRepairSeries> }> {
  return withHistoricalReads(() => prepareOpenInScope(store, request));
}
function prepareOpenInScope(store: Store, request: AnyBeginAttemptRequest):
OmResult<{ readonly transition: AnySeriesTransition; readonly current: Revision<AnyRepairSeries> }> {
  requireStore(store);
  requireCondition(isPlainObject(request), "repeat_request_invalid", "An attempt is opened at this gate through a request object");
  const address = requireAddress(request);
  const begun = prepareManagedBeginAttempt(store, request);
  const series = readAnySeries(store, requestOf(address));
  if (!series.ok) return begun.ok ? series : begun;
  const current = series.value as Revision<AnyRepairSeries>;
  // T5: an attempt this series already holds is that attempt; a late delivery of its opening lands on nothing.
  if (begun.ok && begun.value.writes.length === 0) return { ok: true, value: { transition: begun.value as AnySeriesTransition, current } };

  // The hold is weighed before the series' own rules: its route is direct, and the ladder does not replace it.
  const holds = holdsOf(store, address, current.value);
  if ("ok" in holds) return holds;
  if (holds.standing.length > 0) {
    const first = holds.standing[0]!;
    return refused("origin_held",
      `${holds.standing.length} refusal(s) of unknown origin hold this series; attempt ${first.attempt} ran into the first, and only the analysis of its origin or the owner's decision lifts it`,
      { unit: UNIT, target: address.id, field: "hold", ref: first.hold }, "owner");
  }
  if (!begun.ok) return begun;
  // What was weighed guards the opening: a hold raised between this check and the write fails the transaction (T7).
  return {
    ok: true,
    value: {
      transition: { writes: begun.value.writes, guards: uniqueGuards([...begun.value.guards, ...holds.guards]), value: begun.value.value as AnyRepairSeries },
      current,
    },
  };
}

function prepareClose(store: Store, request: AnyCloseAttemptRequest): OmResult<RepeatTransition> {
  const address = requireCloseRequest(store, request);
  return withHistoricalReads(() => prepareManagedGateClose(store, request) ?? prepareCloseInScope(store, request, address));
}
/**
 * H1.0d (№1688-8, C43): the standalone finish of an E4 call of a mechanism attempt closes through this same G7
 * transition — the accepted M5 results it derives, the classes of its refusals and the A3 outcome — with the call's
 * diagnostic still pending (`null` once it is saved). An exact repeat therefore writes nothing, however it is entered.
 */
export function prepareFinishClose(store: Store, request: AnyCloseAttemptRequest, pending: JournalWrite | null): OmResult<Sealed<RepeatTransition>> {
  const address = requireCloseRequest(store, request);
  requireCondition(address.owner.kind === "mechanism" && (pending === null || isPlainObject(pending) && isText(pending.id)),
    "repeat_request_invalid", "Only the finish of a mechanism attempt closes through G7 with its pending diagnostic");
  return withHistoricalReads(() => {
    const prepared = prepareCloseInScope(store, request, address, pending);
    return prepared.ok ? delivered(prepared.value) : prepared;
  });
}
function requireCloseRequest(store: Store, request: AnyCloseAttemptRequest): Address {
  requireStore(store);
  requireCondition(isPlainObject(request), "repeat_request_invalid", "A cycle is closed at this gate through a request object");
  requireCondition(Number.isSafeInteger(request.attempt) && request.attempt >= 1,
    "repeat_request_invalid", "A cycle names the attempt it closes by its ordinal");
  // The key set is exact: an outcome that also says what it achieved in words of its own — a key, a verdict — is
  // offering the series a result nobody accepted, and it is refused rather than quietly read or quietly dropped.
  requireCondition(isPlainObject(request.outcome) && exactKeys(request.outcome, GATE_OUTCOME_KEYS),
    "repeat_request_invalid", "An outcome names why the cycle ended, the records that accepted its results, the transitions that cancelled earlier ones and its refusals, and never a result by a key of its own");
  const { accepting, cancelling, refusals: claimed } = request.outcome;
  requireCondition(Array.isArray(accepting) && accepting.every(isRef),
    "repeat_request_invalid", "An outcome names the records that accepted its results by exact references, explicitly none");
  requireCondition(Array.isArray(cancelling) && cancelling.every(isRef),
    "repeat_request_invalid", "An outcome names the transitions that cancelled earlier results by exact references, explicitly none");
  // An absent set is not an empty one: a cycle that ran into no refusal says so.
  requireCondition(Array.isArray(claimed),
    "repeat_request_invalid", "An outcome carries the set of its refusals, explicitly empty when the cycle ran into none");
  for (const item of claimed) {
    requireCondition(isPlainObject(item) && isText(item.row),
      "repeat_request_invalid", "Each refusal of a cycle names the row of the journal it stands for");
  }
  return requireAddress(request);
}
function prepareCloseInScope(store: Store, request: AnyCloseAttemptRequest, address: Address,
  pending: JournalWrite | null = null): OmResult<RepeatTransition> {
  // H1.0d (№1688-8): a finishing E4 call hands its not yet written diagnostic here; its row and its class are then
  // written by ONE batch of the journal together with the close, so the finish and a later direct repeat of G7
  // derive and hold the same classes. Reads see the pending source; only the final batch writes it.
  const source = pending ? { id: pending.id, revision: pending.expected + 1, hash: hashJson(pending.value) } : null;
  const view = pending ? pendingCallStore(store, [pending as Write]) : store;
  const { reason, accepting, cancelling, refusals: claimed } = request.outcome;
  const at = requestOf(address);
  const assessmentGuards: TransactionGuard[] = [];
  // This head is captured before any E1 enumeration. Exact completed repeats never traverse today's ledger.
  const ledgerId = callLedgerId(address.project);
  const capturedLedger = address.owner.kind === "block" ? store.get<CallLedger>(ledgerId) : null;

  // What the cycle achieved and cancelled, as the providers of acceptance confirm it, never as the caller says it.
  let results: ConfirmedResults = { achieved: [], cancelled: [] };
  if (accepting.length + cancelling.length > 0) {
    const standing = readAnySeries(store, at);
    if (!standing.ok) return standing;
    const attempt = [...standing.value.value.inherited, ...standing.value.value.attempts].find(item => item.ordinal === request.attempt);
    // H1.0d: a mechanism is confirmed under its typed owner (the M5 provider), a block under its block.
    const common = { project: address.project, target: address.id,
      attempt: { series: reference(standing.value), ordinal: request.attempt },
      goal: attempt === undefined ? null : attempt.goal as AttemptGoal, accepting, cancelling, refusals: claimed };
    const confirmed = confirmResults(store, address.owner.kind === "mechanism" ? { ...common, owner: address.owner }
      : { ...common, block: address.owner.block });
    if (!confirmed.ok) return confirmed;
    results = confirmed.value as ConfirmedResults;
  }
  // One row is one refusal, and one refusal gets one class. The set is UNORDERED, so it is put in one order before
  // anything is derived from it — the same refusals delivered in another order are the same decisions (T6).
  const wanted = [...new Set(claimed.map(item => item.row))].sort(compare);
  // An address points at the place in the set the CALLER gave, not at the place in the order derived from it.
  const placed = new Map<string, number>();
  claimed.forEach((item, index) => { if (!placed.has(item.row)) placed.set(item.row, index); });
  const routed: RoutedRefusal[] = [];
  const classifications: RefusalClassification[] = [];
  const guards: TransactionGuard[] = [];
  let independentRefusal = false;
  if (results.guards) assessmentGuards.push(...results.guards);
  const rows = new Map<string, JournalRow>();
  let preview: Sealed<{ writes: readonly JournalWrite[]; guards: readonly TransactionGuard[] }> | null = null;
  if (wanted.length > 0 || source) {
    if (source) {
      const staged = prepareJournalBatch(store, { project: address.project, sources: [source], pending: [pending!], classifications: [] });
      if (!staged.ok) return unlinked(address, staged.refusal.code, "outcome.refusals");
      preview = staged.value;
      for (const row of staged.value.value.rows) rows.set(row.id, row as JournalRow);
    } else {
      const journal = readJournal(store, { project: address.project });
      if (!journal.ok) return unlinked(address, journal.refusal.code, "outcome.refusals");
      // The head the classes were derived from guards the transaction as well: no window between reading and writing.
      guards.push(reference(journal.value));
      for (const row of journal.value.value.rows) rows.set(row.id, row as JournalRow);
    }
    for (const named of wanted) {
      const index = placed.get(named)!;
      const row = rows.get(named);
      if (!row) {
        return refused("refusal_unknown", "No refusal stands in the journal of this project under that row",
          { unit: UNIT, target: address.id, field: `outcome.refusals.${index}.row` }, "producer");
      }
      const derived = derive(view, row, address, request.attempt, `outcome.refusals.${index}.origin`);
      if ("ok" in derived) return derived;
      routed.push({ row: row.id, class: derived.class, addressee: derived.addressee, toModel: TO_MODEL[derived.class], basis: derived.basis });
      classifications.push({ row: row.id, class: derived.class, addressee: derived.addressee, basis: derived.basis });
      if (derived.assessment) {
        guards.push(...derived.assessment.guards);
      } else independentRefusal = true;
    }
  }

  // The series decides the verdict, the count, the stop and the rung, from the results as they were confirmed.
  const completion = {
    ...at, attempt: request.attempt,
    ...('terminal' in request && request.terminal !== undefined ? { terminal: request.terminal } : {}),
    outcome: { reason, achieved: results.achieved, cancelled: results.cancelled, refusals: claimed },
  };
  const series = prepareCompleteAttempt(preview ? pendingCallStore(store, preview.writes as Write[]) : store, completion);
  if (!series.ok) return series;
  if (address.owner.kind === "block" && series.value.writes.length > 0) {
    // The first E1 head was captured before the checks above; its guard closes the admission race even when the
    // attempt had no assessor at preparation time. A completed repeat has no new A3 write and needs no current E1.
    assessmentGuards.push(capturedLedger ? reference(capturedLedger) : { id: ledgerId, absent: true });
    // A missing head is lawful only when the common E1 reader proves that no call records exist. A foreign kind
    // is never a reason to skip this check: both are otherwise able to hide an assessed attempt from G7.
    const ledger = readCallLedger(store, address.project);
    if (!ledger.ok) return refused("origin_unreadable", ledger.refusal.message,
      { unit: UNIT, target: address.id, field: "ledger",
        ...(capturedLedger ? { ref: reference(capturedLedger) } : {}) }, "producer");
    if (capturedLedger === null ? ledger.value !== null
      : ledger.value === null || !sameRef(reference(capturedLedger), reference(ledger.value)))
      return refused("input_stale", "The project E1 ledger changed while its closing slice was being checked",
        { unit: UNIT, target: ledgerId, field: "ledger",
          ...(capturedLedger ? { ref: reference(capturedLedger) } : {}) }, "producer");
    const hasAssessment = ledger.value?.value.calls.some(row => row.purpose === "fact-assessment"
      && row.series.id === address.id && row.attempt === request.attempt
      && (isAssessmentCallName(row.name)
        || row.basis !== null && Object.hasOwn(row.basis, "assessment"))) ?? false;
    if (hasAssessment) {
      const standing = readAnySeries(store, at);
      if (!standing.ok) return standing;
      const attempt = [...standing.value.value.inherited, ...standing.value.value.attempts]
        .find(item => item.ordinal === request.attempt);
      if (!attempt) return refused("input_stale", "The assessed attempt changed before its new G7 close",
        { unit: UNIT, target: address.id, field: "attempt", ref: reference(standing.value) }, "producer");
      const exactSeries = reference(standing.value);
      const closure = checkCurrentAssessmentAttemptClosure(store,
        { project: address.project, block: address.owner.block, series: exactSeries,
          attempt: request.attempt, goal: attempt.goal },
        { series: exactSeries, attempt: request.attempt, block: address.owner.block, goal: attempt.goal,
          reason, accepting, cancelling, refusals: claimed });
      if (!closure.ok) return refused("origin_unreadable", closure.refusal.message,
        { unit: UNIT, target: address.id, field: "outcome", ref: exactSeries }, "producer");
      const expectedReason = assessmentAttemptReason(closure.value.accepting, closure.value.negativeResults,
        closure.value.technical, results.achieved.some(item => !item.basis.id.startsWith(
          `${acceptedAnswerNamespace(address.project)}e5:`)) || results.cancelled.length > 0,
        independentRefusal);
      if (reason !== expectedReason) return refused("origin_unreadable",
        "The attempt reason must follow all checked E5 terminals and other confirmed G7 results",
        { unit: UNIT, target: address.id, field: "outcome.reason", ref: exactSeries }, "producer");
      assessmentGuards.push(...closure.value.guards);
    }
  }
  if (address.owner.kind === "mechanism" && series.value.writes.length > 0) {
    // H1.0d (C15): a new close of a mechanism attempt names every accepted M5 result G7 derives for it from its own
    // E1 rows; an empty claim does not skip that check. A completed repeat never consults today's ledger.
    const standing = readAnySeries(store, at);
    if (!standing.ok) return standing;
    const attempt = [...standing.value.value.inherited, ...standing.value.value.attempts].find(item => item.ordinal === request.attempt);
    if (!attempt) return refused("input_stale", "The mechanism attempt changed before its new G7 close",
      { unit: UNIT, target: address.id, field: "attempt", ref: reference(standing.value) }, "producer");
    const own = mechanismAttemptResults(store, { project: address.project, owner: address.owner,
      series: reference(standing.value), attempt: request.attempt, goal: attempt.goal as AttemptGoal, except: null });
    if (!own.ok) return own;
    const missing = own.value.accepting.find(ref => !accepting.some(item => sameRef(item, ref)));
    if (missing) return refused("origin_unreadable", "The close must name every accepted M5 addressing result of this attempt",
      { unit: UNIT, target: address.id, field: "outcome.accepting", ref: missing }, "producer");
    if (results.achieved.length + results.cancelled.length > 0 && reason !== "result")
      return refused("origin_unreadable", "An attempt with confirmed results closes with the result reason",
        { unit: UNIT, target: address.id, field: "outcome.reason" }, "producer");
    assessmentGuards.push(...own.value.guards);
  }
  const writes: GateWrite[] = [...series.value.writes];
  // Guards read through the pending view name revisions this very batch writes; the batch guards their real heads.
  const staged = new Set(preview?.writes.map(write => write.id) ?? []);
  guards.push(...series.value.guards.filter(guard => 'absent' in guard || !staged.has(guard.id)));

  let decided: readonly RefusalClassification[] = [];
  if (source) {
    const journal = prepareJournalBatch(store, { project: address.project, sources: [source], pending: [pending!], classifications });
    if (!journal.ok) return journal;
    writes.push(...journal.value.writes as GateWrite[]);
    assessmentGuards.push(...journal.value.guards);
    decided = journal.value.value.classifications as readonly RefusalClassification[];
  } else if (classifications.length > 0) {
    const journal = prepareClassifyRefusal(store, { project: address.project, classifications });
    if (!journal.ok) return journal;
    writes.push(...journal.value.writes);
    guards.push(...journal.value.guards);
    decided = journal.value.value.classifications as readonly RefusalClassification[];
  }

  // Every refusal of unknown origin raises its hold here, with the outcome it belongs to, not a cycle later.
  const held = series.value.value as AnyRepairSeries;
  const raised: HoldContext[] = [];
  const unknown = routed.filter(item => item.class === "unknown");
  if (unknown.length > 0) {
    const recorded = recordedAt(store, address, series.value.writes, guards);
    for (const item of unknown) {
      const hold = raise(store, address, request.attempt, item, recorded, rows.get(item.row)!.origin);
      if ("ok" in hold) return hold;
      if (hold.write !== null) writes.push(hold.write);
      if (hold.guard !== null) guards.push(hold.guard);
      if (hold.standing !== null) raised.push(hold.standing);
    }
  }

  // A stop is explained with the address and the responsible of every refusal that repeats, and those were decided by
  // earlier cycles when this one ran into none of its own; the head they are read from guards the transaction too.
  if ((held.stop !== null || raised.length > 0) && decided.length === 0 && rowsOf(held).size > 0) {
    const journal = readJournal(store, { project: address.project });
    if (!journal.ok) return unlinked(address, journal.refusal.code, "stop.refusals");
    decided = journal.value.value.classifications as readonly RefusalClassification[];
    guards.push(reference(journal.value));
  }

  const value = reported(address, held, request.attempt, routed, raised, decided);
  return { ok: true, value: { writes, guards: uniqueTransactionGuards([...uniqueGuards(guards), ...assessmentGuards]), value } };
}

/**
 * The exact revision of the series that records this cycle: the one about to be written, whose reference is known
 * before it is written — the next revision of its id, with the hash of its content — or, when the series holds this
 * outcome already, the head it holds it at, which then guards the transaction like anything else that was read.
 */
function recordedAt(store: Store, address: Address, written: readonly { readonly expected: number; readonly value: unknown }[], guards: TransactionGuard[]): Ref {
  const own = written[0];
  if (own !== undefined) return { id: address.id, revision: own.expected + 1, hash: hashJson(own.value) };
  const head = reference(store.get(address.id)!);
  guards.push(head);
  return head;
}

/**
 * The hold of one refusal: written with the outcome, or — when this delivery repeats one that raised it already —
 * found standing at its one address, and taken as it stands, lifted or not.
 */
function raise(
  store: Store, address: Address, attempt: number, item: RoutedRefusal, series: Ref, origin: RefusalOrigin,
): OmResult<never> | { readonly write: GateWrite | null; readonly guard: Ref | null; readonly standing: HoldContext | null } {
  const id = originHoldId(address.project, address.owner, attempt, item.row);
  const value: AnyOriginHold = {
    projectId: address.project, ...ownerFields(address.owner), series, attempt, row: item.row, address: item.addressee, lift: null,
  };
  const found = store.get<AnyOriginHold>(id);
  if (found === null) {
    const hold = { id, revision: 1, hash: hashJson(value) };
    return {
      write: { id, kind: ORIGIN_HOLD_KIND, expected: 0, value },
      guard: null,
      standing: { hold, attempt, row: item.row, address: item.addressee, origin },
    };
  }
  const same = found.kind === ORIGIN_HOLD_KIND && isPlainObject(found.value)
    && found.value.projectId === value.projectId && sameOwner(found.value, value)
    && found.value.attempt === value.attempt && found.value.row === value.row && found.value.address === value.address;
  if (!same) {
    return refused("hold_invalid", "Another record already stands where the hold of this refusal belongs",
      { unit: UNIT, target: id, field: "id", ref: reference(found) }, "producer");
  }
  if (address.owner.kind === "mechanism") {
    const checked = readOriginHoldAt(store, address.project, reference(found));
    if (!checked.ok) return checked;
  }
  return {
    write: null,
    guard: reference(found),
    standing: found.value.lift === null ? { hold: reference(found), attempt, row: item.row, address: item.addressee, origin } : null,
  };
}

// ---------------------------------------------------------------------------
// The class of one refusal.

/**
 * The class of one refusal, from its origin: the stage it arose at, and where the refused subject is found among the
 * exact records the origin names — weighed by the table of decision, never by a first match.
 * Nothing here is read out of the refusal's own words about itself. The gate that wrote it may not declare a class (A2
 * refuses a record that does). Sources must first agree on their saved assembly inputs; the definitions they carry
 * at those exact revisions then determine the class, without trusting their own status or class claims.
 */
const derive = (store: Store, row: JournalRow, address: Address, ordinal: number, path: string): OmResult<never> | Derived => {
  // H1.0c (C21, C22): any one mark of G4b names the check of a managed attempt, which this path has no binding for; a
  // contradiction of marks is not read as another gate either. Never unknown, a hold or a fallback to placeOrigin.
  if (answersRowMarks(address.project, row).any) return refused("origin_unreadable",
    "A G4b observation belongs to the registered check of a managed attempt, never to a refusal of this cycle",
    { unit: UNIT, target: address.id, field: `${path}.completion`, ref: row.source }, "producer");
  // H1.0d (№1688-8, C43): the own diagnostic of an E4 call of a mechanism attempt is classified from its exact E1 and
  // producer stage, as the managed branch does — the class its finish derives, never unknown on a repeat of that outcome.
  if (address.owner.kind === "mechanism" && (row.gate === "E4" || row.source.id.startsWith(`${unitRefusalNamespace(address.project)}e4:`))) {
    const bad = (field: string, message: string): OmResult<never> => refused("origin_unreadable", message,
      { unit: UNIT, target: address.id, field: `${path}.${field}`, ref: row.source }, "producer");
    const source = store.get(row.source.id, row.source.revision);
    const reason = /^model-call:(refused|off-form|interrupted|awaiting-owner)$/.exec(row.origin.stage)?.[1];
    const call = row.origin.sources.find(item => item.role === "call");
    if (row.gate !== "E4" || !row.source.id.startsWith(`${unitRefusalNamespace(address.project)}e4:`) || !source
      || source.kind !== UNIT_REFUSAL_KIND || !sameRef(reference(source), row.source) || !reason || !call)
      return bad("source", "An E4 diagnostic needs its exact source, producer stage and admitted call");
    const admitted = readCall(store, address.project, call.ref);
    if (!admitted.ok || admitted.value.value.series.id !== address.id || admitted.value.value.attempt !== ordinal
      || admitted.value.value.call !== row.origin.subject)
      return bad("call", "An E4 diagnostic belongs to a call admitted for this exact attempt");
    return reason === "refused" ? { class: "proposal", addressee: `node:${row.goal}`, basis: row.origin.sources }
      : { class: "conditions", addressee: `owner:${address.id}`, basis: row.origin.sources };
  }
  // G6.2 (№3869 п.5, №3881): a G5 finding of the group's candidate — the write order of shared files, or a subject no
  // single proposal holds — names no proposal: it is the derivation's and goes to the attempt that assembled the group,
  // never to the model and never to an analysis. A finding of a proposal's own content names that one proposal and is
  // placed below by the one weighing like any other.
  if (row.gate === "G5" && row.origin.stage === "atomicity" && !row.origin.sources.some(source => source.role === "proposal")) {
    // The address is the accepting series its works step named, never the series of whoever closes now (№3885 В2).
    const accepting = row.origin.sources.filter(source => source.role === ACCEPTING_ROLE);
    if (accepting.length !== 1) return refused("origin_unreadable", "A G5 finding of the candidate names the one attempt that assembled it",
      { unit: UNIT, target: address.id, field: `${path}.sources`, ref: row.source }, "producer");
    return { class: "derivation", addressee: `accepting:${accepting[0]!.ref.id}`, basis: row.origin.sources };
  }
  const e5 = row.gate === "E5" || row.origin.stage === "fact-assessment"
    || row.source.id.startsWith(`om-unit-refusal:${address.project}:e5:`)
    || row.origin.sources.some(source => source.role === "assessment");
  if (e5) {
    const bad = (field: string, message: string, ref: Ref = row.source): OmResult<never> => refused("origin_unreadable", message,
      { unit: UNIT, target: address.id, field: `${path}.${field}`, ref }, "producer");
    const proof = readAssessmentRefusalAt(store, address.project, row.source);
    if (!proof.ok) return bad("source", proof.refusal.message);
    if (address.owner.kind !== "block") return bad("owner", "E5 fact assessments belong to block attempts");
    const standing = readAnySeries(store, requestOf(address));
    if (!standing.ok) return bad("series", standing.refusal.message);
    const bound = readAnySeriesAt(store, address.project, proof.value.intent.originalSeries);
    if (!bound.ok) return bad("series", bound.refusal.message, proof.value.intent.originalSeries);
    const attempt = [...standing.value.value.inherited, ...standing.value.value.attempts]
      .find(item => item.ordinal === ordinal);
    if (!attempt || !('block' in bound.value.value) || bound.value.value.block !== address.owner.block
      || bound.value.value.line !== address.line || proof.value.intent.originalSeries.id !== address.id
      || proof.value.intent.block !== address.owner.block || proof.value.consumer !== address.owner.block
      || proof.value.intent.attempt !== ordinal || hashJson(proof.value.intent.goal) !== hashJson(attempt.goal))
      return bad("attempt", "The exact E5 result must belong to this original block, line, ordinal and goal",
        reference(proof.value.result));
    return { class: "proposal", addressee: addressed("proposal", proof.value.target),
      basis: [{ role: "assessment", ref: reference(proof.value.result) }],
      assessment: { intent: proof.value.intent.intent, result: reference(proof.value.result),
        source: reference(proof.value.record), guards: [...proof.value.guards, reference(standing.value)] } };
  }
  return placeOrigin(store, row.origin, {
    project: address.project, target: address.id, owner: address.owner, series: address.id,
    sources: `${path}.sources`, code: "origin_unreadable", route: "producer",
  });
};

/**
 * THE ONE weighing of an origin this gate has, and the only place a class, its addressee and the grounds they stand on
 * are established. Every path to a class of one refusal goes through it, over the records read at their exact
 * references: the ordinary classification of a refusal of a closed cycle, and the lift of a hold on the analysis of one
 * — whose own `class` field is a CLAIM this weighing is compared against and never a finding of its own. A second way
 * of establishing one class is exactly what let a definition lost by the assembly be handed back to the model.
 */
function placeOrigin(store: Store, origin: WeighedOrigin, where: Placing): OmResult<never> | Derived {
  const { stage, subject, sources } = origin;
  // An origin with no source at all says "not established" explicitly, and an unnamed role cannot be weighed as one
  // of this gate's: either way the origin is not placed, and a project question is NOT raised for it.
  if (sources.length === 0) return unplaced(where, []);
  if (!sources.every(source => ORIGIN_ROLES.includes(source.role as OriginRole))) return unplaced(where, []);

  const readings: SourceReading[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const reading = readSource(store, sources[index]!, subject, where, `${where.sources}.${index}`);
    if ("ok" in reading) return reading;
    readings.push(reading);
  }
  const incompatible = compatibleSources(readings, where);
  if (incompatible) return incompatible;
  // T6: the grounds are an UNORDERED set, put in one order before anything is derived from it and before it is
  // compared — the same grounds in another order are the same finding, on either path.
  const basis = sources
    .map(normalizeOriginSource)
    .sort((left, right) => compare(originSourceKey(left), originSourceKey(right)));
  const map = readings.filter(reading => MAP_ROLES.includes(reading.role));

  // A stage this gate does not name has no defined effect; inventing one would be a choice about the product.
  if (!REFUSAL_STAGES.includes(stage as RefusalStage)) return unplaced(where, basis);
  if (stage === "readiness") {
    if (where.owner.kind !== "block") return refused(where.code,
      "Readiness belongs to a block; a mechanism owner cannot stand for that block",
      { unit: UNIT, target: where.target, field: "owner" }, where.route);
    return { class: "readiness", addressee: addressed("readiness", where.owner.block), basis };
  }
  // The conditions of the repository, the environment and the executor come from the feasibility check. A feasibility
  // refusal that names records of the MAP is the other case the rules put on this path — one that turned out to be a
  // defect of the map — and it is placed by its subject like any other.
  if (stage === "feasibility" && map.length === 0) return { class: "conditions", addressee: addressed("conditions", subject), basis };

  const tally = tallyOf(map);
  const admitted = SUBJECT_DECISIONS.filter(decision => decision.sufficient(tally));
  requireCondition(admitted.length <= 1, "repeat_gate_broken", "The table of decision admits one class for a tally at most");
  const decided = admitted[0];
  if (decided === undefined) return unplaced(where, basis);
  // Each admitted class singles out its responsible by construction: one derived that lost it, one base that holds it.
  if (decided.class === "derivation") {
    return { class: "derivation", addressee: addressed("derivation", map.find(reading => reading.role === "derived")!.ref.id), basis };
  }
  if (decided.class === "input") {
    return { class: "input", addressee: addressed("input", map.find(reading => reading.role === "base" && reading.holdsSubject)!.ref.id), basis };
  }
  return { class: "proposal", addressee: addressed("proposal", subject), basis };
}

/** Compare only the source links proved by the observing readers, never heads or matching definitions. */
function compatibleSources(readings: readonly SourceReading[], where: Placing): OmResult<never> | null {
  // Prefer the refused candidate's saved inputs. Without it the observed proposal contexts still constrain the
  // named base and each other; the table below decides whether the sources suffice to establish a class.
  const anchor = readings.find(reading => reading.role === "derived")?.context
    ?? readings.find(reading => reading.context?.kind === "proposal")?.context
    ?? readings.find(reading => reading.context !== null)?.context;
  if (!anchor) return null;
  const frameOf = (context: Sealed<OriginSourceContext>) =>
    context.kind === "proposal" ? context.request.frame : context.request;
  const frameKey = canonical(frameOf(anchor) as Json);
  for (let index = 0; index < readings.length; index += 1) {
    const reading = readings[index]!;
    const context = reading.context;
    if (context === null) continue;
    let field: string | null = null;
    if (canonical(frameOf(context) as Json) !== frameKey) field = "context.frame";
    else if (anchor.kind === "proposal" && context.kind === "proposal") {
      if (context.request.proposals.length !== anchor.request.proposals.length
        || context.request.proposals.some((ref, position) => !sameRef(ref, anchor.request.proposals[position]!)))
        field = "context.proposals";
      else if (reading.role === "proposal" && !anchor.request.proposals.some(ref => sameRef(ref, reading.ref)))
        field = "ref";
    }
    if (field !== null) return refused(where.code, "Origin sources must belong to the same observed assembly",
      { unit: UNIT, target: where.target, field: `${where.sources}.${index}.${field}`, ref: reading.ref }, where.route);
  }
  return null;
}

function tallyOf(map: readonly SourceReading[]): OriginTally {
  const count = (role: MapRole, holding: boolean): number =>
    map.filter(reading => reading.role === role && (!holding || reading.holdsSubject)).length;
  return {
    named: { proposal: count("proposal", false), base: count("base", false), derived: count("derived", false) },
    holding: { proposal: count("proposal", true), base: count("base", true), derived: count("derived", true) },
  };
}

export interface DefinitionRequest { project: string; source: OriginSource }
export interface SourceDefinitions {
  definitions: string[]; references: Ref[]; context: OriginSourceContext;
}

/**
 * Observe historical definitions through the producer; a base additionally requires its proven acceptance.
 * References returned here are historical witnesses, not requirements that their heads remain current.
 */
export function readDefinitions(store: Store, request: DefinitionRequest): OmResult<Sealed<SourceDefinitions>> {
  const invalid = (field: string): never => { throw new EngineError("repeat_request_invalid",
    "A definition reading needs a store, named project and complete source", { unit: UNIT, target: "source", field }); };
  if (!(store instanceof Store)) invalid("store");
  if (!isPlainObject(request)) invalid("request");
  let project: string;
  try { project = requireProject(request.project); }
  catch (error) {
    if (error instanceof EngineError && error.code === "repeat_request_invalid") invalid("project");
    throw error;
  }
  let source: Sealed<OriginSource>;
  try { source = normalizeOriginSource(request.source); }
  catch (error) {
    if (error instanceof EngineError && error.code === "journal_request_invalid") invalid("source");
    throw error;
  }
  const unreadable = (message: string, field: string): OmResult<never> => refused("origin_unreadable", message,
    { unit: UNIT, target: source.ref.id, field, ref: source.ref }, "producer");
  const found = store.get(source.ref.id, source.ref.revision);
  if (!found || found.hash !== source.ref.hash) return unreadable("The source must stand at its exact reference", "ref");
  if (source.role === "proposal" && found.kind === "layer-proposal") {
    if (source.context?.kind !== "proposal") return unreadable("A proposal needs its complete source request", "context");
    const observed = observeProposal(store, { project, proposal: source.ref, request: source.context.request as ProposalRequest });
    return observed.ok ? delivered({ definitions: [...observed.value.definitions], references: [...observed.value.references],
      context: { kind: "proposal", request: observed.value.sources } }) : observed;
  }
  if (source.role === "derived" && found.kind === "frame-candidate") {
    // The candidate owns its request. A supplied context must agree, never replace that historical request.
    const observed = observeCandidate(store, { project, candidate: source.ref });
    if (!observed.ok) return observed;
    if (source.context !== undefined) {
      if (source.context.kind !== "proposal") return unreadable("A candidate context names its saved proposal request", "context");
      let recorded: string;
      try { recorded = originSourceKey({ role: source.role, ref: source.ref,
        context: { kind: "proposal", request: observed.value.sources } }); }
      catch (error) {
        if (error instanceof EngineError && error.code === "journal_request_invalid")
          return unreadable("The candidate has no comparable complete source request", "request");
        throw error;
      }
      if (recorded !== originSourceKey(source)) return unreadable("A candidate context must equal its saved source request", "context");
    }
    return delivered({ definitions: [...observed.value.definitions], references: [...observed.value.references],
      context: { kind: "proposal", request: observed.value.sources } });
  }
  if (source.role !== "base" || !["graph", "graph-layer", "connection-frame"].includes(found.kind))
    return unreadable("This kind of record does not carry definitions in the named role", "kind");
  if (source.context?.kind !== "frame" || source.context.request.project !== project)
    return unreadable("An accepted base needs its own exact frame sources", "context");
  const context = source.context.request as FrameRequest;
  const basis = readFrame(store, context);
  if (!basis.ok) return basis;
  const frame = basis.value;
  let graph = frame.upper;
  if (found.kind === "graph") {
    if (!sameRef(source.ref, context.graph)) return unreadable("The graph is not the graph named by its context", "context.graph");
    if (frame.accepted !== null) graph = { ...projectGraph(frame.accepted.graph as Graph, context.level), version: frame.accepted.graph.version };
  } else if (found.kind === "connection-frame") {
    if (frame.accepted?.frame === null || frame.accepted === null || !sameRef(source.ref, frame.accepted.frame.reference))
      return unreadable("The frame must be the proven accepted frame of this base", "context.frame");
    graph = { ...projectGraph(frame.accepted.graph as Graph, context.level), version: frame.accepted.graph.version };
  } else if (!sameRef(source.ref, frame.upperRef)) {
    if (context.layer === null || frame.accepted === null || !sameRef(source.ref, context.layer))
      return unreadable("The layer must be the proven upper or accepted lower layer", "context.layer");
    graph = { ...projectGraph(frame.accepted.graph as Graph, context.level), version: frame.accepted.graph.version };
  }
  const definitions = definitionIds(graph, "graph", source.ref.id);
  return definitions.ok ? delivered({ definitions: [...definitions.value], references: [...frame.references],
    context: { kind: "frame", request: frame.request } }) : definitions;
}

/** The same observation serves ordinary classification and every reading of a lifted hold. */
function readSource(store: Store, source: OriginSource, subject: string, where: Placing, path: string): OmResult<never> | SourceReading {
  const role = source.role as OriginRole;
  if (role === "environment") {
    const found = store.get(source.ref.id, source.ref.revision);
    if (!found || found.hash !== source.ref.hash) return refused(where.code,
      "An environment source must stand at its exact reference", { unit: UNIT, target: where.target, field: path, ref: source.ref }, where.route);
    if (source.context !== undefined) return refused(where.code,
      "Map assembly context cannot witness an environment source", { unit: UNIT, target: where.target, field: `${path}.context`, ref: source.ref }, where.route);
    return { role, ref: source.ref, holdsSubject: false, context: null };
  }
  const read = readDefinitions(store, { project: where.project, source });
  if (!read.ok) return refused(where.code, read.refusal.message,
    { unit: UNIT, target: where.target, field: `${path}.${read.refusal.at.field ?? "record"}`, ref: source.ref }, where.route);
  return { role, ref: source.ref, holdsSubject: read.value.definitions.includes(subject), context: read.value.context };
}

const unplaced = (where: Placing, basis: readonly OriginSource[]): Derived =>
  ({ class: "unknown", addressee: addressed("unknown", where.series), basis });

const addressed = (item: RefusalClass, target: string): string => `${ADDRESSEE_KINDS[item]}:${target}`;

// ---------------------------------------------------------------------------
// The holds of a series, and their lift.

/**
 * The holds the lineage of a series must have, and which of them still stand.
 * They are derived from the records, not from a list anyone keeps: every attempt of the lineage, every refusal it ran
 * into that the journal classifies as unknown. Each such refusal has its hold at its one address, and a hold is
 * checked against what it says it stands for — the revision of the series, the row of the journal and, once lifted,
 * the record it was lifted on — before it is believed (T3). A hold that should stand and does not is not a lifted one:
 * the series is held until it is raised, which closing that cycle through this gate again does.
 */
function contextJournal(store: Store, address: Address, sources?: StopContextSources): OmResult<Sealed<Revision<RefusalJournal>>> {
  if (sources === undefined) return readJournal(store, { project: address.project });
  if (sources.journal === null) return refused("hold_invalid", "Recorded refusals require their exact historical journal",
    { unit: UNIT, target: address.id, field: "sources.journal" }, "producer");
  return readJournalAt(store, address.project, sources.journal);
}

function holdsOf(store: Store, address: Address, series: AnyRepairSeries, sources?: StopContextSources): OmResult<never> | Holds {
  const rows = rowsOf(series);
  const incomplete = (field: string): OmResult<never> => refused("hold_invalid", "Historical context sources must contain exactly the journal and holds of the saved series",
    { unit: UNIT, target: address.id, field: `sources.${field}` }, "producer");
  if (rows.size === 0) {
    if (sources && sources.journal !== null) return incomplete("journal");
    if (sources && sources.holds.length !== 0) return incomplete("holds");
    return { standing: [], guards: [] };
  }
  const journal = contextJournal(store, address, sources);
  if (!journal.ok) return unlinked(address, journal.refusal.code, "hold");
  const guards: Ref[] = [reference(journal.value)];
  const book = journal.value.value as RefusalJournal;
  const classes = new Map(book.classifications.map(item => [item.row, item]));
  const byId = new Map(book.rows.map(row => [row.id, row]));
  const standing: HoldContext[] = [];
  const named = new Map(sources?.holds.map(ref => [ref.id, ref]) ?? []), used = new Set<string>();
  if (sources && named.size !== sources.holds.length) return incomplete("holds");
  if (sources) for (const row of rows) if (!byId.has(row)) return incomplete("journal");
  for (const attempt of [...series.inherited, ...series.attempts]) {
    if (attempt.outcome === null) continue;
    for (const row of [...new Set(attempt.outcome.refusals.map(item => item.row))].sort(compare)) {
      const decision = classes.get(row);
      if (decision === undefined || decision.class !== "unknown") continue;
      const id = originHoldId(address.project, address.owner, attempt.ordinal, row);
      let found: Revision<AnyOriginHold> | null;
      if (sources) {
        const ref = named.get(id);
        if (!ref) return incomplete("holds");
        const read = readRecord<AnyOriginHold>(store, ref, { unit: UNIT, target: address.id, kind: ORIGIN_HOLD_KIND, id });
        if (!read.ok) return read;
        found = read.value as Revision<AnyOriginHold>; used.add(id);
      } else found = store.get<AnyOriginHold>(id);
      if (found === null) {
        return refused("origin_held",
          `The refusal attempt ${attempt.ordinal} ran into is of unknown origin and no hold of it stands yet: closing that cycle through this gate again raises it`,
          { unit: UNIT, target: address.id, field: "hold" }, "owner");
      }
      const broken = checkHold(store, address.project, found, book);
      if (broken) return broken;
      guards.push(reference(found));
      if (found.value.lift === null) {
        standing.push({ hold: reference(found), attempt: attempt.ordinal, row, address: found.value.address, origin: byId.get(row)!.origin });
      }
    }
  }
  if (sources && used.size !== named.size) return incomplete("holds");
  return { standing, guards };
}

/**
 * A hold, checked against everything it stands on: its shape, the one address its content belongs at, the revision of
 * the series it names (a series of this block that holds that attempt and that refusal), the journal (which classes the
 * refusal as unknown, at this address) and — once lifted — the record it was lifted on, weighed AGAIN by the very
 * function that lifted it. A hold that merely agrees with itself, or a lift written by hand, is refused (T3).
 */
function checkHold(store: Store, project: string, found: Revision<AnyOriginHold>, journal: RefusalJournal): OmResult<never> | null {
  const context = { target: found.id, ref: reference(found) };
  const bad = (message: string, field: string): OmResult<never> =>
    refused("hold_invalid", message, { unit: UNIT, target: context.target, field, ref: context.ref }, "producer");
  if (found.kind !== ORIGIN_HOLD_KIND) return bad(`A ${found.kind} record cannot stand for a hold`, "kind");
  const value = found.value as unknown;
  if (!isPlainObject(value) || !exactKeys(value, Object.hasOwn(value as object, "owner") ? MECHANISM_HOLD_KEYS : HOLD_KEYS)) return bad("A hold carries its series, attempt, row, address and lift, and nothing else", "value");
  const hold = value as AnyOriginHold;
  if (hold.projectId !== project || !validHeldOwner(hold) || !Number.isSafeInteger(hold.attempt) || hold.attempt < 1
    || !isText(hold.row) || !isText(hold.address) || !isRef(hold.series)) {
    return bad("A hold names its project, block, series, attempt, row and address", "value");
  }
  if (found.id !== originHoldId(project, heldOwner(hold), hold.attempt, hold.row)) {
    return bad("A hold does not stand at the address its own content belongs at", "id");
  }
  const owner = heldOwner(hold);
  const series = owner.kind === "mechanism" ? readAnySeriesAt(store, project, hold.series) : null;
  const old = owner.kind === "block" ? store.get(hold.series.id, hold.series.revision) : null;
  const met = series !== null ? series.ok && sameOwner(series.value.value, hold)
    && [...series.value.value.inherited, ...series.value.value.attempts].some(attempt => attempt.ordinal === hold.attempt
      && attempt.outcome?.refusals.some(item => item.row === hold.row))
    : old !== null && old.hash === hold.series.hash && old.kind === REPAIR_SERIES_KIND && owner.kind === "block"
      && recordsRefusal(old.value, project, owner.block, hold.attempt, hold.row);
  if (!met) return bad("The series a hold names does not record that attempt running into that refusal", "series");
  const decision = journal.classifications.find(item => item.row === hold.row);
  if (decision === undefined || decision.class !== "unknown" || decision.addressee !== hold.address) {
    return bad("The journal does not hold that refusal as one of unknown origin at that address", "row");
  }
  if (hold.lift === null) return null;
  const lift = hold.lift as unknown;
  if (!isPlainObject(lift) || !exactKeys(lift, LIFT_KEYS)) return bad("A lift carries its ground, its record and the route it established", "lift");
  if (!LIFT_GROUNDS.includes(hold.lift.ground) || !isRef(hold.lift.record)) return bad("A lift names one of the grounds and the exact record it stands on", "lift");
  const kind = hold.lift.ground === "origin-analysis" ? ORIGIN_ANALYSIS_KIND : ORIGIN_DECISION_KIND;
  const namespace = hold.lift.ground === "origin-analysis" ? originAnalysisNamespace(project) : originDecisionNamespace(project);
  const read = readRecord<Json>(store, hold.lift.record, { unit: UNIT, target: found.id, kind, idPrefix: namespace });
  if (!read.ok) return bad(`The record a lift names is not a ground of this project: ${read.refusal.code}`, "lift.record");
  const row = journal.rows.find(item => item.id === hold.row)!;
  const again = weighLift(store, hold.lift.ground, read.value.value, hold, row, found.id);
  if ("ok" in again) return bad(`The record a lift names does not lift this hold: ${codeOf(again)}`, "lift.record");
  if (hashJson(again) !== hashJson({ class: hold.lift.class, addressee: hold.lift.addressee, basis: hold.lift.basis })) {
    return bad("A lift does not hold the route the record it names establishes", "lift");
  }
  return null;
}

/**
 * Whether a stored revision of a series — read at an exact reference, not as the head A3 checks — is a series of this
 * block that records the attempt running into the refusal. Read field by field, because it is only trusted as far as
 * it is checked here.
 */
function recordsRefusal(value: unknown, project: string, block: string, attempt: number, row: string): boolean {
  if (!isPlainObject(value)) return false;
  const series = value as Record<string, unknown>;
  if (series['projectId'] !== project || series['block'] !== block) return false;
  const inherited = series['inherited'];
  const own = series['attempts'];
  if (!Array.isArray(inherited) || !Array.isArray(own)) return false;
  return [...inherited, ...own].some((item: unknown) => {
    if (!isPlainObject(item) || (item as Record<string, unknown>)['ordinal'] !== attempt) return false;
    const outcome = (item as Record<string, unknown>)['outcome'];
    if (!isPlainObject(outcome)) return false;
    const links = (outcome as Record<string, unknown>)['refusals'];
    return Array.isArray(links) && links.some((link: unknown) => isPlainObject(link) && (link as Record<string, unknown>)['row'] === row);
  });
}

const codeOf = (result: OmResult<never>): string => (result.ok ? "delivered" : result.refusal.code);

function prepareLift(store: Store, request: LiftOriginHoldRequest):
OmResult<{ readonly transition: HoldTransition; readonly current: Revision<AnyOriginHold> }> {
  return withHistoricalReads(() => prepareLiftInScope(store, request));
}
function prepareLiftInScope(store: Store, request: LiftOriginHoldRequest):
OmResult<{ readonly transition: HoldTransition; readonly current: Revision<AnyOriginHold> }> {
  requireStore(store);
  requireCondition(isPlainObject(request), "repeat_request_invalid", "A hold is lifted through a request object");
  const project = requireProject(request.project);
  requireCondition(isRef(request.hold), "repeat_request_invalid", "A lift names the exact standing hold it lifts");
  requireCondition(LIFT_GROUNDS.includes(request.ground), "repeat_request_invalid", "A lift names one of the grounds a hold is lifted on");
  requireCondition(isGroundRecord(request.record), "repeat_request_invalid",
    "A lift carries the record it stands on — stored and named by its exact reference, or written with it, never both and never neither");

  const named = readRecord<AnyOriginHold>(store, request.hold, {
    unit: UNIT, target: request.hold.id, kind: ORIGIN_HOLD_KIND, idPrefix: originHoldNamespace(project),
  });
  if (!named.ok) return named;
  const head = store.get<AnyOriginHold>(request.hold.id)!;
  const journal = readJournal(store, { project });
  if (!journal.ok) {
    return refused("hold_invalid", `This project holds no journal a hold could stand on: ${journal.refusal.code}`,
      { unit: UNIT, target: head.id, field: "row", ref: reference(head) }, "producer");
  }
  const book = journal.value.value as RefusalJournal;
  const broken = checkHold(store, project, head, book);
  if (broken) return broken;
  const hold = head.value;
  const kind = request.ground === "origin-analysis" ? ORIGIN_ANALYSIS_KIND : ORIGIN_DECISION_KIND;
  const namespace = request.ground === "origin-analysis" ? originAnalysisNamespace(project) : originDecisionNamespace(project);
  const ground = locate(store, request.record, kind, namespace, head.id, "record");
  if ("ok" in ground) return ground;

  if (hold.lift !== null) {
    // T5: this hold is lifted already. The same lift again is the same request delivered twice; another ground does
    // not replace the one it was lifted on.
    if (hold.lift.ground === request.ground && sameRef(hold.lift.record, ground.ref)) {
      return { ok: true, value: { transition: { writes: [], guards: [], value: hold }, current: head } };
    }
    return refused("lift_conflict", "This hold was lifted on another ground already, and a later ground does not replace it",
      { unit: UNIT, target: head.id, field: "record", ref: reference(head) }, "owner");
  }
  if (!sameRef(request.hold, reference(head))) {
    return refused("lift_conflict", "A lift names the standing revision of the hold it lifts",
      { unit: UNIT, target: head.id, field: "hold", ref: reference(head) }, "producer");
  }
  const row = book.rows.find(item => item.id === hold.row)!;
  const resolution = weighLift(store, request.ground, ground.value, hold, row, head.id);
  if ("ok" in resolution) return resolution;
  const value: AnyOriginHold = {
    ...plainHold(hold),
    lift: { ground: request.ground, record: exactRef(ground.ref), class: resolution.class, addressee: resolution.addressee, basis: resolution.basis },
  };
  // The hold and the record it is lifted on are one transaction: both stand, or neither does (T7). The hold's own head
  // is the guard; the journal is not — its rows and classifications are never replaced, so nothing weighed here moves.
  return {
    ok: true,
    value: {
      transition: {
        writes: [{ id: head.id, kind: ORIGIN_HOLD_KIND, expected: head.revision, value }, ...(ground.write === null ? [] : [ground.write])],
        guards: [reference(head)],
        value,
      },
      current: head,
    },
  };
}

/**
 * What the record of a ground establishes about THIS hold, whichever way it came.
 * It must be about this hold — this project, block, attempt and journal row — or it lifts nothing: an analysis of
 * another refusal, or one delivered for a hold lifted long since, is refused on that comparison (T5).
 * An analysis may ADD grounds the origin did not name, but it does not say what they mean: its `class` field is a CLAIM,
 * and the class is WEIGHED out of those grounds by placeOrigin — the very function the ordinary classification of a
 * refusal uses — over the subject and the stage of the journalled refusal this hold is about. Grounds that establish
 * another class, or that suffice for none, lift nothing, whatever the record claims about them: a definition the
 * assembly lost goes back to whoever wrote it, and a second way of establishing one class would be the way around that.
 * An owner's decision names what the owner decided, and establishes no class. Nothing a record says of itself —
 * "independent", "approved", "final" — is consulted.
 */
function weighLift(store: Store, ground: LiftGround, value: unknown, hold: AnyOriginHold, row: JournalRow, target: string): OmResult<never> | Resolution {
  const unusable = (message: string, field: string): OmResult<never> =>
    refused("lift_unusable", message, { unit: UNIT, target, field }, ground === "owner-decision" ? "owner" : "producer");
  if (!isPlainObject(value)) return unusable("A ground of a lift is a record about one hold", "record");
  const record = value as Record<string, unknown>;
  if (record['projectId'] !== hold.projectId || !sameOwner(record, hold)) return unusable("This record is about another series owner", "owner" in hold ? "record.owner" : "record.block");
  if (record['attempt'] !== hold.attempt) return unusable("This record is about another attempt", "record.attempt");
  if (record['row'] !== hold.row) return unusable("This record is about another refusal", "record.row");
  if (ground === "owner-decision") {
    if (!isText(record['decided'])) return unusable("A record that says nothing the owner decided is no ground to lift a hold", "record.decided");
    return { class: null, addressee: null, basis: [] };
  }
  const established = record['class'];
  if (!REFUSAL_CLASSES.includes(established as RefusalClass) || established === "unknown") {
    return unusable("An analysis that did not establish a class of this gate's leaves the origin where it was", "record.class");
  }
  const grounds = record['basis'];
  if (!Array.isArray(grounds) || grounds.length === 0) return unusable("An analysis names the exact records it established the class on", "record.basis");
  const basis: OriginSource[] = [];
  for (let index = 0; index < grounds.length; index += 1) {
    let source: Sealed<OriginSource>;
    try { source = normalizeOriginSource(grounds[index]); }
    catch (error) {
      if (error instanceof EngineError && error.code === "journal_request_invalid")
        return unusable("A ground needs its exact reference and complete source context", `record.basis.${index}`);
      throw error;
    }
    if (!ORIGIN_ROLES.includes(source.role as OriginRole))
      return unusable("A ground of an analysis names one of this gate's roles", `record.basis.${index}.role`);
    basis.push(source);
  }
  // ONE mechanism for one class: the grounds of the analysis are weighed by the function that weighs any origin, over
  // the stage and the subject of the refusal this hold is about. The claim is then compared with what was weighed.
  const placed = placeOrigin(store, { stage: row.origin.stage, subject: row.origin.subject, sources: basis }, {
    project: hold.projectId, target, owner: heldOwner(hold), series: hold.series.id, sources: "record.basis", code: "lift_unusable", route: "producer",
  });
  if ("ok" in placed) return placed;
  if (placed.class === "unknown") {
    return unusable("The grounds of an analysis do not suffice to establish a class of this gate's: the origin stays where it was", "record.basis");
  }
  if (placed.class !== established) {
    return unusable(`The grounds of an analysis establish ${placed.class}, not the ${String(established)} it claims: a claim does not replace what they say`, "record.class");
  }
  return placed;
}

// ---------------------------------------------------------------------------
// What the gate reports.

function reported(
  address: Address, series: AnyRepairSeries, attempt: number,
  routed: readonly RoutedRefusal[], raised: readonly HoldContext[], decided: readonly RefusalClassification[],
): RepeatOutcome {
  const closed = [...series.inherited, ...series.attempts].find(item => item.ordinal === attempt) ?? null;
  const holdOf = new Map(raised.map(item => [item.row, item.hold]));
  const refusals: Refusal[] = [];
  for (const item of routed) {
    const code = GATE_REFUSAL_OF[item.class];
    if (code === null) continue;
    // The address of the obstacle carries the exact record the addressee names — for an origin not established, the
    // hold its analysis is to lift — so the responsible is handed the revision that was weighed, not a description.
    const ground = item.class === "unknown" ? holdOf.get(item.row)
      : item.basis.find(source => item.addressee.endsWith(`:${source.ref.id}`))?.ref;
    refusals.push(gateRefusal(code, MESSAGES[code], item.addressee, item.row, ROUTES[item.class], ground));
  }
  if (series.stop !== null) {
    refusals.push(gateRefusal("stopped_without_progress", series.stop.reason, address.id, "stop", "owner", undefined));
  }
  const question = [...new Set(routed.filter(item => item.toModel).map(item => nodeOf(item.addressee)))].sort(compare);
  const stands = series.stop !== null || raised.length > 0;
  return {
    attempt,
    verdict: closed === null ? null : closed.verdict,
    withoutProgress: series.withoutProgress,
    routed,
    question,
    refusals,
    stop: series.stop,
    holds: raised.map(item => item.hold),
    // The rung is named only while a stop stands, and it is the rung the SERIES derived, never one counted here.
    ladder: series.stop === null ? null : series.ladder,
    context: stands ? contextOf(address, series, raised, new Map(decided.map(item => [item.row, item]))) : null,
  };
}

const MESSAGES: Readonly<Record<GateRefusalCode, string>> = Object.freeze({
  stopped_without_progress: "The series stands stopped without progress",
  beyond_block: "This refusal is not fixable by means of the block, and goes to the owner or the environment",
  handed_to_producer: "This refusal was handed to the producer of the data or of the code, and is no question for the model",
  origin_unestablished: "The origin of this refusal was not established: a hold stands until its analysis or the owner's decision lifts it, and no project question is raised",
});

// The node the project question is raised for, taken back out of the addressee it was put into.
const nodeOf = (addressee: string): string => addressee.slice(`${ADDRESSEE_KINDS.proposal}:`.length);

/**
 * A1 builds a refusal inside a result, and this gate reports several beside an applied change rather than instead of
 * it, so each is taken out of the result A1 made it in. The address is A1's copy: what is reported shares no object
 * with what was read (T11).
 */
function gateRefusal(code: GateRefusalCode, message: string, target: string, field: string, route: RefusalRoute, ref: Ref | undefined): Refusal {
  const made = refused(code, message, { unit: UNIT, target, field, ...(ref === undefined ? {} : { ref }) }, route);
  if (made.ok) throw new EngineError("repeat_gate_broken", "A refusal of this gate delivers nothing");
  return made.refusal;
}

// ---------------------------------------------------------------------------
// The context of what stops a series, assembled from the records of the attempts.

const rowsOf = (series: AnyRepairSeries): ReadonlySet<string> => {
  const rows = new Set<string>();
  for (const attempt of [...series.inherited, ...series.attempts]) {
    for (const item of attempt.outcome?.refusals ?? []) rows.add(item.row);
  }
  return rows;
};

function contextOf(
  address: Address, series: AnyRepairSeries, holds: readonly HoldContext[], decided: ReadonlyMap<string, RefusalClassification>,
): StopContext {
  const attempts = new Map([...series.inherited, ...series.attempts].map(item => [item.ordinal, item as Attempt]));
  // The window a stop was counted in, or — when only holds stand — the attempts that raised them.
  const window = series.stop !== null ? series.stop.attempts : [...new Set(holds.map(item => item.attempt))].sort((left, right) => left - right);
  const goals = new Map<string, AttemptGoal>();
  const endings: AttemptEnding[] = [];
  const times = new Map<string, number>();
  for (const ordinal of window) {
    const attempt = attempts.get(ordinal);
    if (!attempt) continue;
    if (!goals.has(attempt.goal.key)) goals.set(attempt.goal.key, copyGoal(attempt.goal));
    if (attempt.outcome !== null) {
      endings.push({ attempt: ordinal, reason: attempt.outcome.reason });
      // One attempt naming a refusal twice ran into it once: what repeats is a refusal met by several ATTEMPTS.
      for (const row of new Set(attempt.outcome.refusals.map(item => item.row))) times.set(row, (times.get(row) ?? 0) + 1);
    }
  }
  // What was accepted for the goals of the window, across the whole lineage, whichever attempt reached it.
  const accepted = new Set<string>();
  for (const attempt of attempts.values()) {
    if (!goals.has(attempt.goal.key) || attempt.outcome === null) continue;
    for (const item of attempt.outcome.achieved) accepted.add(item.key);
  }
  const repeated: StopObstacle[] = [...times.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([row, met]) => {
      const verdict = decided.get(row);
      return {
        row, times: met,
        class: verdict === undefined ? null : (verdict.class as RefusalClass),
        addressee: verdict === undefined ? null : verdict.addressee,
      };
    });
  return {
    series: address.id,
    stop: series.stop,
    holds: [...holds],
    ladder: series.ladder,
    goals: [...goals.values()],
    accepted: [...accepted].sort(compare),
    repeated,
    endings,
    grounds: [...series.continuations],
  };
}

// ---------------------------------------------------------------------------
// Records handed over as grounds, and copies.

/**
 * Settles where the record of a ground comes from — stored, or written with this change — and nothing else; its
 * CONTENT is weighed afterwards by one function whichever way it came. A stored record is read at its exact reference
 * inside this project's namespace. A record written with the change is held to the same address rules before the store
 * is touched, and its exact reference is computed as the store will make it: the first revision of its id, with the
 * hash of its content. An id already standing is not overwritten: holding this very record, it IS this record; holding
 * anything else, it is a revision conflict (T5, T7).
 */
function locate(store: Store, source: GroundRecord, kind: string, namespace: string, target: string, field: string): OmResult<never> | Located {
  if (source.ref !== undefined) {
    const read = readRecord<Json>(store, source.ref, { unit: UNIT, target, kind, idPrefix: namespace });
    if (!read.ok) return read;
    return { ref: reference(read.value), value: read.value.value, write: null };
  }
  const pending = source.pending;
  if (!pending.id.startsWith(namespace)) return asRecord("record_foreign", `A record at ${pending.id} lies outside ${namespace}`, target, `${field}.pending.id`);
  if (pending.kind !== kind) return asRecord("record_foreign", `A ${pending.kind} record cannot stand for a ${kind} record`, target, `${field}.pending.kind`);
  const value = sealed(pending.value);
  const hash = hashJson(value);
  const standing = store.get(pending.id);
  if (standing === null) return { ref: { id: pending.id, revision: 1, hash }, value, write: { id: pending.id, kind, expected: 0, value } };
  if (standing.kind === kind && standing.hash === hash) return { ref: reference(standing), value: standing.value, write: null };
  return asRecord("revision_conflict", `Another record already stands at ${pending.id}, and a record written with this change is the first revision of its id`,
    target, `${field}.pending.id`, reference(standing));
}

// A record handed over to be written is refused with the codes A1 gives a stored record for the same defect.
function asRecord(code: RefsRefusalCode, message: string, target: string, field: string, ref?: Ref): OmResult<never> {
  return refused(code, message, { unit: UNIT, target, field, ref }, "producer");
}

function isGroundRecord(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const source = value as Record<string, unknown>;
  if (exactKeys(source, REF_SOURCE_KEYS)) return isRef(source['ref']);
  if (!exactKeys(source, PENDING_SOURCE_KEYS)) return false;
  const pending = source['pending'];
  if (!isPlainObject(pending) || !exactKeys(pending, PENDING_KEYS)) return false;
  const record = pending as Record<string, unknown>;
  return isText(record['id']) && String(record['id']).length <= MAX_ENTITY_ID && isText(record['kind']) && isJson(record['value']);
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

const unlinked = (address: Address, code: string, field: string): OmResult<never> =>
  refused("refusals_unlinked", `This project holds no journal the refusals of this series could stand in: ${code}`,
    { unit: UNIT, target: address.id, field }, "producer");

const exactRef = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
const sameRef = (left: Ref, right: Ref): boolean => left.id === right.id && left.revision === right.revision && left.hash === right.hash;
const copyGoal = (goal: AttemptGoal): AttemptGoal => ({ key: goal.key, questions: [...goal.questions], result: goal.result });
const plainHold = (hold: AnyOriginHold) => ({
  projectId: hold.projectId, ...ownerFields(heldOwner(hold)), series: exactRef(hold.series), attempt: hold.attempt, row: hold.row, address: hold.address,
});
// Not localeCompare: what a reviewer and the owner are handed must not depend on the machine's locale.
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The guards of a whole transaction. The same record is read on more than one path — the journal by this gate and by
 * the series both — and a guard named twice at DIFFERENT revisions is exactly the window T7 is about, so both are kept
 * and the stale one fails the transaction.
 */
function uniqueGuards(guards: readonly Ref[]): Ref[];
function uniqueGuards(guards: readonly TransactionGuard[]): TransactionGuard[];
function uniqueGuards(guards: readonly TransactionGuard[]): TransactionGuard[] {
  const seen = new Map<string, TransactionGuard>();
  for (const guard of guards) {
    if ('absent' in guard) seen.set(`${guard.id}\0absent`, { id: guard.id, absent: true });
    else seen.set(`${guard.id}\0${guard.revision}\0${guard.hash}`, exactRef(guard));
  }
  return [...seen.values()];
}

// Own keys only, and exactly these: a value parsed from JSON may carry "__proto__" as an own field, and an unexpected
// field is a difference in content, not a detail to ignore.
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  const own = Object.keys(value as object);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value as object, key));
}

function requireStore(store: unknown): asserts store is Store {
  requireCondition(store instanceof Store, "repeat_request_invalid", "A cycle is opened, closed and held at this gate through a store");
}

function requireProject(project: unknown): string {
  requireCondition(typeof project === "string" && project.length > 0, "repeat_request_invalid", "The gate works for a named project");
  // ':' separates namespaces inside an id: a project carrying one would address another project's records.
  requireCondition(!project.includes(":"), "repeat_request_invalid", "A project name carries no ':' namespace separator");
  // The longest id this gate writes is a hold's: its kind, the project and a hash of 64 characters.
  requireCondition(ORIGIN_HOLD_KIND.length + project.length + 2 + 64 <= MAX_ENTITY_ID,
    "repeat_request_invalid", "A project name that overflows the address of a hold cannot be held");
  return project;
}

function requireAddress(request: AnySeriesRequest): Address {
  const project = requireProject(request.project);
  return seriesAddress({ ...request, project });
}

function validOwner(value: unknown): value is SeriesOwner {
  if (!isPlainObject(value)) return false;
  const owner = value as Record<string, unknown>;
  return exactKeys(owner, ["kind", "block"]) && owner.kind === "block" && isText(owner.block)
    || exactKeys(owner, ["kind", "mechanism"]) && owner.kind === "mechanism" && owner.mechanism === "M5:addressing";
}
function validHeldOwner(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const held = value as Record<string, unknown>;
  return Object.hasOwn(held, "owner") ? !Object.hasOwn(held, "block") && validOwner(held.owner) && held.owner.kind === "mechanism"
    : isText(held.block);
}
function heldOwner(value: AnyOriginHold): SeriesOwner {
  return "owner" in value ? value.owner : { kind: "block", block: value.block };
}
function ownerFields(owner: SeriesOwner): { block: string } | { owner: Extract<SeriesOwner, { kind: "mechanism" }> } {
  return owner.kind === "block" ? { block: owner.block } : { owner: { ...owner } };
}
function sameOwner(left: unknown, right: unknown): boolean {
  if (!validHeldOwner(left) || !validHeldOwner(right)) return false;
  return canonical(heldOwner(left as AnyOriginHold)) === canonical(heldOwner(right as AnyOriginHold));
}
function requestOf(address: Address): AnySeriesRequest {
  return { project: address.project, line: address.line, ...ownerFields(address.owner) };
}

import { completionWorkId, completionCloseId, COMPLETION_CLOSE_KIND, COMPLETION_WORK_KIND, ATTEMPT_PROGRESS_CONTRACT,
  readCompletionBinding, readCompletionOwnerAt, prepareManagedCompleteAttempt,
  type CompletionWork, type ManagedClosure, type ClaimedOutcome, type AdministrativeEnd, type AttemptProgress } from './series.js';
import { readCompletionEffectiveAt, readManagedModelDiagnostic, checkManagedModelDiagnostic, checkCompletionLedger, pendingCallStore,
  completionClosedWork, prepareCompletionProducts, readModelCallState, modelCallRecordId, readCompletionAreaInput,
  COMPLETION_CESSATION_KIND, COMPLETION_FINALIZATION_KIND, AREA_INPUT_VARIANT,
  type CompletionCessation, type CompletionFinalization, type CompletionSnapshot } from './model-call.js';
import type { MechanismOwner } from './series.js';
import { prepareJournalBatch, unitRefusalNamespace, UNIT_REFUSAL_KIND, type JournalWrite } from './refusal-journal.js';
import type { Write } from '../storage/store.js';
import { answersProduct, readAnswersGateRefusalAt } from './answers-gate.js';
/**
 * The one close form (owner decision 28.09, №1637): the real pre-close work, the exact additions this close brings into
 * it (explicitly empty for a direct G7), the final journal holding their rows and the classes of this close, the other
 * pre-close sources, and the derived outcome. One derivation reads every close; there is no second version.
 */
export interface CompletionCloseRecord {
  // LP6 (№3325 §4): a block close of the new era is v2 and carries its derived outcome.progress; v1 is read literally.
  contract: 'om-completion-close/v1' | 'om-completion-close/v2'; project: string; binding: Ref; work: Ref; additions: readonly Ref[]; series: Ref;
  ledger: Ref | null; journal: Ref | null; claim: GateOutcome; outcome: ClaimedOutcome; waiting: Ref[];
}
class ManagedCloseFailure extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message); }
}
function managedTake<T>(result: OmResult<T>): T { if (!result.ok) throw new ManagedCloseFailure(result.refusal); return result.value; }
function managedFail(id: string, field: string, message: string, code = 'completion_invalid', ref?: Ref): never {
  const result = refused(code, message, { unit: UNIT, target: id, field, ...(ref ? { ref } : {}) }, 'producer');
  if (!result.ok) throw new ManagedCloseFailure(result.refusal);
  throw new Error('Unreachable');
}
function managedResult<T>(read: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(read()); }
    catch (error) { if (error instanceof ManagedCloseFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function completionClaim(claim: GateOutcome): GateOutcome {
  return { reason: claim.reason,
    accepting: [...new Map(claim.accepting.map(ref => [canonical(ref), ref])).values()].sort((a,b) => canonical(a).localeCompare(canonical(b))),
    cancelling: [...new Map(claim.cancelling.map(ref => [canonical(ref), ref])).values()].sort((a,b) => canonical(a).localeCompare(canonical(b))),
    refusals: [...new Map(claim.refusals.map(row => [row.row, row])).values()].sort((a,b) => a.row.localeCompare(b.row)) };
}
/**
 * H1.0c (№1628 Q1; rows 37, C21, C23, C24): a G4b row is an observation of the check, journal-only or pointing at the
 * ground of an existing producer, and never a counted refusal; one whose marks or typed source do not hold is forged.
 */
function refuseAnswersClaim(store: Store, project: string, row: JournalRow, target: string): never {
  const read = answersRowMarks(project, row).exact ? readAnswersGateRefusalAt(store, project, row.source) : null;
  if (!read?.ok) managedFail(target, 'refusals', `A G4b row needs every mark and its typed source: ${read ? read.refusal.code : 'marks'}`,
    'origin_unreadable', row.source);
  managedFail(target, 'refusals', 'A G4b observation is never a counted refusal: its own producer grounds or its wait stand instead',
    'completion_refusal_uncounted', row.source);
}
/** An applied E4 whose own D3 applied field decisions: the only record that can accept an M5 addressing result. */
function appliedAddressing(store: Store, project: string, ref: Ref): OmResult<boolean> {
  const state = readModelCallState(store, { project, record: ref });
  if (!state.ok) return state;
  const read = state.value;
  return { ok: true, value: read.state === 'applied' && read.outcome.outcome?.kind === 'input-decisions' && read.outcome.diagnostic === null };
}
/**
 * H1.0d (№1688-4, -8; C15, C43): the accepted M5 addressings of one standalone attempt, derived by G7 from the E1 rows
 * of that attempt — never from the claim. The ledger head is read before the rows are enumerated and every E4 head is
 * guarded, so a result applied or changed before the write fails the transaction; a call dispatched and settled in that
 * window moves the guarded ledger. A closed attempt is read from its saved outcome instead: today's ledger is never a
 * condition of a completed repeat. The finishing call itself is `except`: it is never its own ground.
 */
export function mechanismAttemptResults(store: Store, request: { project: string; owner: MechanismOwner; series: Ref; attempt: number;
  goal: AttemptGoal; except: Ref | null }): OmResult<Sealed<{ accepting: Ref[]; results: ConfirmedResults; guards: TransactionGuard[]; unstarted: Ref[] }>> {
  requireStore(store);
  requireCondition(isPlainObject(request) && isText(request.project) && isPlainObject(request.owner) && isRef(request.series)
    && Number.isSafeInteger(request.attempt) && request.attempt > 0 && isPlainObject(request.goal)
    && (request.except === null || isRef(request.except)),
  "repeat_request_invalid", "The accepted results of a mechanism attempt are derived for its exact series, attempt and goal");
  return withHistoricalReads(() => {
    const target = request.series.id, accepting: Ref[] = [], guards: TransactionGuard[] = [], unstarted: Ref[] = [];
    const head = store.get<AnyRepairSeries>(target);
    const saved = head ? [...head.value.inherited, ...head.value.attempts].find(item => item.ordinal === request.attempt) : undefined;
    if (saved?.outcome) {
      for (const item of saved.outcome.achieved) if (!accepting.some(ref => sameRef(ref, item.basis))) accepting.push(item.basis);
    } else {
      // An absent ledger or E4 is a ground too (C15): a first E1, or an E4 created and applied with unknown usage
      // (which settles nothing in the ledger), must fail a close that was derived without it.
      const ledger = store.get<CallLedger>(callLedgerId(request.project));
      guards.push(ledger ? reference(ledger) : { id: callLedgerId(request.project), absent: true });
      for (const row of ledger?.value.calls ?? []) {
        if (row.series.id !== target || row.attempt !== request.attempt || row.purpose !== 'model-design'
          || request.except !== null && sameRef(row.call, request.except)) continue;
        const id = modelCallRecordId(request.project, row.name), e4 = store.get(id);
        if (!e4) { guards.push({ id, absent: true }); unstarted.push(row.call); continue; }
        guards.push(reference(e4));
        const applied = appliedAddressing(store, request.project, reference(e4));
        if (!applied.ok) return refused('origin_unreadable', applied.refusal.message,
          { unit: UNIT, target, field: 'ledger', ref: reference(e4) }, 'producer');
        if (!applied.value) continue;
        // An applied E4 that its provider does not confirm (a decision outside its subset) accepted nothing.
        const own = confirmResults(store, { project: request.project, owner: request.owner, target, goal: request.goal,
          attempt: { series: request.series, ordinal: request.attempt }, accepting: [reference(e4)], cancelling: [] });
        if (own.ok) accepting.push(reference(e4));
      }
    }
    let results: ConfirmedResults = { achieved: [], cancelled: [] };
    if (accepting.length) {
      const confirmed = confirmResults(store, { project: request.project, owner: request.owner, target, goal: request.goal,
        attempt: { series: request.series, ordinal: request.attempt }, accepting, cancelling: [] });
      if (!confirmed.ok) return confirmed;
      results = confirmed.value as ConfirmedResults;
      guards.push(...(results.guards ?? []));
    }
    return delivered({ accepting, results, guards: uniqueTransactionGuards(guards), unstarted });
  });
}
const CLOSURE_SHAPE = 'additions,binding,journal,work';
// LP6: the closure of a block close of the new era names its progress contract; the rest of the shape is the same.
const PROGRESS_CLOSURE_SHAPE = 'additions,binding,journal,progress,work';
const closureShaped = (context: Record<string, unknown>): boolean => Object.keys(context).sort().join(',') === CLOSURE_SHAPE
  || Object.keys(context).sort().join(',') === PROGRESS_CLOSURE_SHAPE && context['progress'] === ATTEMPT_PROGRESS_CONTRACT;
/** Exact registry context for the D5 supplier. It is evidence to rederive, never a completeness flag. */
export function checkManagedCompletionClaims(store: Store, project: string, context: ManagedClosure,
  accepting: readonly Ref[], refusals: readonly ClaimedRefusal[]): OmResult<Sealed<CompletionSnapshot>> {
  requireStore(store); requireProject(project);
  requireCondition(isPlainObject(context) && closureShaped(context as unknown as Record<string, unknown>)
    && isRef(context.binding) && isRef(context.work) && Array.isArray(context.additions) && context.additions.every(isRef)
    && (context.journal === null || isRef(context.journal)),
  "repeat_request_invalid", "A managed closure names its exact binding, work, additions (explicitly none) and final journal");
  requireCondition(Array.isArray(accepting) && accepting.every(isRef) && Array.isArray(refusals)
    && refusals.every(row => isPlainObject(row) && isText(row.row) && isText(row.name) && isText(row.goal)),
  "repeat_request_invalid", "A managed closure is checked against exact accepting references and claimed refusal rows");
  return managedResult(() => {
    const journal = context.journal;
    const snapshot = managedTake(readCompletionEffectiveAt(store, project,
      { work: context.work, additions: [...context.additions], journal }));
    if (!sameRef(reference(snapshot.binding), context.binding) || !snapshot.complete || snapshot.work.value.closed)
      managedFail(context.work.id, 'work', 'The close must use one complete exact pre-close registry', 'completion_incomplete');
    const ordered = (values: readonly Ref[]) => [...values].sort((a,b) => canonical(a).localeCompare(canonical(b)));
    const required = requiredManagedAccepting(store, project, context, snapshot as CompletionSnapshot);
    if (canonical(ordered(accepting.filter(required.e5Of))) !== canonical(ordered(required.e5)))
      managedFail(context.work.id, 'accepting', 'The close must retain every exact supported E5 basis');
    if (canonical(ordered(accepting.filter(required.e4Of))) !== canonical(ordered(required.e4)))
      managedFail(context.work.id, 'accepting', required.block
        ? 'The close must retain every own applied E4 of its registry that filled an input field anew, at its effective revision, and no other'
        : 'The close must retain every applied M5 addressing of its registry, at its effective revision');
    const requiredRows = new Set(snapshot.refusals.map(row => row.row));
    // Rows beyond the required set are looked up in the final journal the closure presents.
    const extra = refusals.filter(item => !requiredRows.has(item.row));
    if (extra.length && journal) {
      const rows = new Map(managedTake(readJournalAt(store, project, journal)).value.rows.map(row => [row.id, row as JournalRow]));
      for (const item of extra) {
        const row = rows.get(item.row);
        if (row && answersRowMarks(project, row).any) refuseAnswersClaim(store, project, row, context.work.id);
      }
    }
    if (snapshot.refusals.some(row => !refusals.some(item => canonical(item) === canonical(row))))
      managedFail(context.work.id, 'refusals', 'The close must retain every semantic, technical and control diagnostic');
    if (refusals.some(row => row.name.startsWith('fact_assessment_') && !requiredRows.has(row.row)))
      managedFail(context.work.id, 'refusals', 'A foreign assessment refusal cannot be added to this complete set');
    return snapshot as CompletionSnapshot;
  });
}
/**
 * The accepting bases the effective registry itself requires: every supported E5 basis and, for M5, every applied
 * addressing at its effective revision (H1.0d №1688-3). One function for the claim check and the claim preparer (H1).
 */
/** LP6: one own applied input decision of a registry — its reading, with or without keys. */
interface RequiredField { ref: Ref; read: Extract<InputFieldResult, { relevant: true }> }
function requiredManagedAccepting(store: Store, project: string, context: ManagedClosure, snapshot: CompletionSnapshot) {
  const e5Of = (ref: Ref) => ref.id.startsWith(`${acceptedAnswerNamespace(project)}e5:`);
  const e4Of = (ref: Ref) => ref.id.startsWith(`model-call:${project}:om:`);
  const binding = snapshot.binding.value, e4: Ref[] = [], noop: Ref[] = [], fields: RequiredField[] = [];
  const latest = new Map<string, Ref>();
  for (const ref of snapshot.products) if (e4Of(ref) && (latest.get(ref.id)?.revision ?? 0) < ref.revision) latest.set(ref.id, ref);
  if (binding.owner.kind === 'mechanism') {
    // H1.0d (№1688-3, C13, C14, C46): every applied M5 addressing of the effective registry — each runtime id at its
    // latest revision — is required before reduction by key; an empty claim does not skip it, and a call outside
    // the registry cannot hide behind an equal key.
    for (const ref of latest.values()) {
      if (!managedTake(appliedAddressing(store, project, ref))) continue;
      const own = confirmResults(store, { project, owner: binding.owner, target: binding.series.id, goal: binding.goal,
        attempt: { series: binding.series, ordinal: binding.attempt }, accepting: [ref], cancelling: [], managedClosure: context });
      if (own.ok) e4.push(ref);
    }
  } else if (context.progress === ATTEMPT_PROGRESS_CONTRACT) {
    // LP6 (№3325 §2 п.5): in the new era every own applied E4 of the effective registry that filled an input field anew
    // is required, each at its latest revision; one that filled nothing anew is the attempt's own no-op answer. A broken
    // or foreign proof of an applied input decision is its addressed refusal, never filtered out; other E4 are no part.
    for (const ref of latest.values()) {
      const read = managedTake(readInputFieldResult(store, ref, { project, block: binding.owner.block, goal: binding.goal,
        attempt: { series: binding.series, ordinal: binding.attempt }, accepting: [ref], managedClosure: context }));
      if (!read.relevant) continue;
      fields.push({ ref, read: read as RequiredField['read'] });
      (read.keys.length ? e4 : noop).push(ref);
    }
  }
  return { e5: [...snapshot.accepting], e4, noop, fields, block: binding.owner.kind === 'block', e5Of, e4Of };
}
/** LP6: one technical end of a composition as the administrative rule reads it, and as the reviewer of a stop is shown it. */
export interface TechnicalEnd { readonly source: Ref; readonly kind: string; readonly detail: string; readonly replacement: Ref | null }
const exactOf = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
const refsSorted = (refs: readonly Ref[]): Ref[] => [...new Map(refs.map(ref => [canonical(ref as unknown as Json), exactOf(ref)])).entries()]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ref]) => ref);
/**
 * The technical ends of one composition, each with whether it is a clean end by the replaced B1 of the attempt's own
 * area: an LP4 cessation by that input (never the end of an application), the area-input check cessation, or the LP5
 * end of the remaining acceptance (never of a confirmation). One reading for the administrative rule and for A6.
 */
function technicalEnds(store: Store, project: string, snapshot: CompletionSnapshot): { area: Ref; ends: (TechnicalEnd & { clean: boolean; group?: Ref })[] } {
  const area = managedTake(readCompletionAreaInput(store, project, reference(snapshot.binding)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields = (value: unknown): Record<string, any> | null => isPlainObject(value) ? value as Record<string, any> : null;
  const replaced = (value: unknown): Ref | null => { const cause = fields(value);
    return cause && cause['kind'] === 'required-record-replaced' && canonical(cause['prerequisite'] as Json) === canonical(area as unknown as Json)
      && isRef(cause['replacement']) ? exactOf(cause['replacement'] as Ref) : null; };
  const named = (value: unknown): string => { const cause = fields(value);
    return !cause ? 'an unnamed cause' : cause['kind'] !== 'required-record-replaced' ? String(cause['kind'])
      : replaced(cause) ? `the replaced B1 of the area (${area.source.id}@${area.source.revision})`
      : `a replaced ${fields(cause['prerequisite'])?.['kind'] ?? 'record'} outside the area's B1`; };
  const ends = snapshot.technical.map(row => {
    const record = store.get<Json>(row.source.id, row.source.revision);
    if (!record || record.hash !== row.source.hash)
      managedFail(row.source.id, 'technical', 'A technical end stands at its exact reference', 'completion_invalid', row.source);
    if (record.kind === COMPLETION_CESSATION_KIND) {
      const value = record.value as unknown as CompletionCessation, replacement = replaced(value.cause);
      return { source: exactOf(row.source), kind: value.disposition === 'check-ceased' ? 'check-cessation' : 'cessation',
        detail: `${value.disposition}${value.remainder === null ? '' : `/${value.remainder}`} by ${named(value.cause)}`, replacement,
        clean: replacement !== null && value.remainder !== 'application' && (value.disposition !== 'check-ceased' || value.variant === AREA_INPUT_VARIANT) };
    }
    if (record.kind === COMPLETION_FINALIZATION_KIND) {
      const value = record.value as unknown as CompletionFinalization, cause = fields(value.cause);
      // G6.2 (return №3899): the end of a remaining acceptance by the saved G5 rejection of its group is clean, like the
      // replaced B1 of its area: it names the rejection, and the end of a sound member is neutral.
      if (cause && cause['kind'] === 'group-rejected' && isRef(cause['rejection'])) {
        const rejection = exactOf(cause['rejection'] as Ref);
        return { source: exactOf(row.source), kind: 'finalization', detail: `end of the remaining ${value.phase} by the group's G5 rejection (${rejection.id})`,
          replacement: rejection, clean: value.phase === 'acceptance', group: rejection };
      }
      const replacement = replaced(value.cause);
      return { source: exactOf(row.source), kind: 'finalization', detail: `end of the remaining ${value.phase} by ${named(value.cause)}`,
        replacement, clean: replacement !== null && value.phase === 'acceptance' };
    }
    return { source: exactOf(row.source), kind: record.kind, detail: `${row.reason} of ${record.kind}`, replacement: null, clean: false };
  });
  return { area: exactOf(area.source), ends };
}
/**
 * LP6 (№3325 §3): the administrative end of a block close, derived from its full proved composition and never claimed.
 * It stands only where the formula gives interrupted, nothing waits for the owner, no own input-field answer of the
 * attempt filled nothing anew, and every technical end is a clean end by the replaced B1 of the attempt's own area. The
 * ends may have met different later revisions of that input.
 */
function administrativeEnd(store: Store, project: string, snapshot: CompletionSnapshot, noop: readonly Ref[]): AdministrativeEnd | null {
  if (noop.length || snapshot.waiting.length || !snapshot.technical.length) return null;
  const { area, ends } = technicalEnds(store, project, snapshot);
  if (!ends.every(end => end.clean)) return null;
  // G6.2 (return №3899): every end by one rejection of its group — the neutral end of a sound member; a mix with other
  // ends has no one administrative reading.
  const groups = [...new Map(ends.filter(end => end.group).map(end => [canonical(end.group as unknown as Json), end.group!])).values()];
  if (groups.length) return groups.length === 1 && ends.every(end => end.group)
    ? { kind: 'group-rejected', rejection: groups[0]!, sources: refsSorted(ends.map(end => end.source)) } : null;
  return { kind: 'area-input-replaced', input: area, replacements: refsSorted(ends.map(end => end.replacement!)),
    sources: refsSorted(ends.map(end => end.source)) };
}
/** LP6 (№3325 §5): one counted attempt of a saved stop's window, as the rules of the new era read its exact close. */
export interface WindowProgressRow {
  ordinal: number; goal: AttemptGoal; close: Ref; result: 'input-field' | 'administrative'; achieved: string[]; sources: Ref[];
}
/** LP6 (№3325 §6): what one attempt of an explained window proves, shown to A6 as facts — never as refusal rows. */
export interface CompletionEvidence {
  readonly ordinal: number; readonly goal: string; readonly reason: CompletionReason; readonly close: Ref | null;
  readonly decisions: readonly { readonly e4: Ref; readonly call: Ref; readonly previous: Ref; readonly input: Ref; readonly filled: readonly FilledField[] }[];
  readonly ends: readonly TechnicalEnd[];
  readonly effect: 'input-field' | 'administrative' | 'failure' | 'standalone';
  readonly results: readonly string[];
  readonly remaining: readonly string[];
}
interface AttemptReading { evidence: CompletionEvidence; goal: AttemptGoal; e4: Ref[]; administrative: AdministrativeEnd | null; unfit: string | null }
/**
 * LP6 (№3325 §5 п.3; return №3371): the real failures a closed attempt still holds beside whatever it achieved — a cancelled
 * result; every effective refusal of its close (one whose chain a dispatched correction replaced, MP2, is owed no more and
 * is no failure); the owner's wait; a technical end of another cause than the replaced B1 of its own area; an own
 * input-field answer that filled nothing anew. One reading for the transition of a saved stop — its producer and its
 * reader — and for the facts A6 is shown: a fresh result beside any of these is no reconciled row.
 */
function attemptFailures(store: Store, project: string, close: Sealed<CompletionCloseRecord>, snapshot: CompletionSnapshot,
  ends: readonly (TechnicalEnd & { clean: boolean })[], noop: readonly Ref[]): string[] {
  const corrected = new Set(snapshot.corrected.map(ref => canonical(exactOf(ref) as unknown as Json)));
  const rows = new Map(close.journal === null ? [] : managedTake(readJournalAt(store, project, close.journal)).value.rows.map(row => [row.id, row]));
  const effective = close.claim.refusals.filter(item => {
    const row = rows.get(item.row);
    return row === undefined || !corrected.has(canonical(exactOf(row.source) as unknown as Json));
  });
  return [
    ...close.outcome.cancelled.map(key => `cancelled result ${key}`),
    ...effective.map(row => `refusal ${row.name} of ${row.goal} (row ${row.row})`),
    ...snapshot.waiting.map(ref => `waiting for the owner on ${ref.id}@${ref.revision}`),
    ...ends.filter(end => !end.clean).map(end => `${end.detail} (${end.source.id}@${end.source.revision})`),
    ...noop.map(ref => `own input-field answer ${ref.id}@${ref.revision} filled no field anew`),
  ];
}
/**
 * LP6: one closed attempt of a window as the new era reads its exact close and composition — never today's heads. The
 * one analysis behind a reconciled stop and behind the facts A6 is shown. `known` is the line's decided fields before
 * the attempt and grows by its keys, so novelty is sequential. `unfit` says why it is no row of a reconciliation.
 */
function readAttempt(store: Store, project: string, series: Sealed<Revision<AnyRepairSeries>>, ref: Ref, ordinal: number, known: Set<string>): AttemptReading {
  const attempt = [...series.value.inherited, ...series.value.attempts].find(item => item.ordinal === ordinal);
  if (!attempt?.outcome) return managedFail(series.id, `attempts.${ordinal}`, 'An attempt of a window is a closed attempt of its series');
  const goal: AttemptGoal = { key: attempt.goal.key, questions: [...attempt.goal.questions], result: attempt.goal.result };
  const reason = attempt.outcome.reason, block = 'block' in series.value;
  const base = { ordinal, goal: goal.key, reason };
  const binding = managedTake(readCompletionBinding(store, project, ref, ordinal));
  if (!binding) return { goal, e4: [], administrative: null, unfit: 'A standalone attempt has no managed close to prove a result of LP6',
    evidence: { ...base, close: null, decisions: [], ends: [], effect: 'standalone', results: [],
      remaining: [`closed without a managed close as ${reason}`] } };
  const id = completionCloseId(project, binding.id), head = store.get(id);
  if (!head) return managedFail(id, 'close', 'A closed managed attempt keeps its exact close proof');
  const close = managedTake(readCompletionCloseAt(store, project, reference(head)));
  const composition = { work: close.work, additions: [...close.additions], journal: close.journal };
  const snapshot = managedTake(readCompletionEffectiveAt(store, project, composition)) as CompletionSnapshot;
  const required = block ? requiredManagedAccepting(store, project, { binding: close.binding, ...composition, progress: ATTEMPT_PROGRESS_CONTRACT }, snapshot)
    : { e4: [] as Ref[], noop: [] as Ref[], fields: [] as RequiredField[] };
  const keys = [...new Set(required.fields.flatMap(row => row.read.keys))].sort();
  const fresh = keys.filter(key => !known.has(key));
  for (const key of keys) known.add(key);
  const ends = snapshot.technical.length ? technicalEnds(store, project, snapshot).ends : [];
  const administrative = block && !keys.length && reason === 'interrupted' ? administrativeEnd(store, project, snapshot, required.noop) : null;
  // Return №3371: what else ended the attempt is weighed BEFORE any fresh result admits it — a fresh field beside a real
  // failure is no reconciled row, whatever the new era would make of the same attempt (G7 of new closes is unchanged).
  const failures = attemptFailures(store, project, close, snapshot, ends, required.noop);
  const remaining = [...failures, ...(keys.length && !fresh.length ? ['a repeat of input-field results the line already holds'] : [])];
  const effect = failures.length ? 'failure' : fresh.length ? 'input-field' : administrative ? 'administrative' : 'failure';
  const unfit = !block ? 'Only a block series has the input-field results and administrative ends of LP6'
    : close.contract !== 'om-completion-close/v1' ? 'A close of the new era was counted by the rules of its own era'
    : close.outcome.cancelled.length ? 'A cancelled result is a conflict of results, not a reconciled attempt'
    : failures.length ? `The attempt still holds real failures beside its results: ${failures.join('; ')}`
    : fresh.length ? null
    : keys.length ? 'A repeat of a known input-field result is no progress'
    : reason !== 'interrupted' ? `An attempt closed as ${reason} is a real failure of its window`
    : administrative ? null : "The interruption is not only the proved replacement of the B1 of the attempt's own area";
  return { goal, e4: refsSorted(required.e4), administrative, unfit, evidence: { ...base, close: exactOf(reference(head)),
    decisions: required.fields.map(row => ({ e4: exactOf(row.ref), call: exactOf(row.read.call), previous: exactOf(row.read.previous),
      input: exactOf(row.read.input), filled: row.read.filled.map(item => ({ ...item })) })),
    ends: ends.map(end => ({ source: end.source, kind: end.kind, detail: end.detail, replacement: end.replacement })),
    effect, results: fresh, remaining } };
}
function windowSeries(store: Store, project: string, request: { series: Ref; ordinals: readonly number[] }) {
  requireStore(store); requireProject(project);
  requireCondition(isPlainObject(request) && isRef(request.series) && Array.isArray(request.ordinals) && request.ordinals.length > 0
    && request.ordinals.every(item => Number.isSafeInteger(item) && item > 0),
  "repeat_request_invalid", "A window is read at its exact series revision and its attempts");
}
/**
 * LP6 (№3325 §5): the one subject derivation of a reconciled stop, for its producer and for every reader. Each counted
 * attempt of the window is read by readAttempt: a fresh input-field result (new against the line's decided fields and
 * the rows before it) or a clean administrative end. Anything else — a real failure, a conflict, a repeat of a known
 * result, a standalone attempt, a close of the new era or another cause — is `progress_unproved`, and the old rules
 * stand. A missing or broken proof is its own addressed refusal, never "unfit".
 */
export function deriveWindowProgress(store: Store, project: string, request: { series: Ref; ordinals: readonly number[] }): OmResult<Sealed<WindowProgressRow[]>> {
  windowSeries(store, project, request);
  return managedResult(() => {
    const series = managedTake(readAnySeriesAt(store, project, request.series));
    const known = new Set(decidedFieldsBefore(series.value, Math.min(...request.ordinals))), rows: WindowProgressRow[] = [];
    for (const ordinal of request.ordinals) {
      const read = readAttempt(store, project, series, request.series, ordinal, known);
      if (read.unfit !== null) managedFail(series.id, `attempts.${ordinal}`, read.unfit, 'progress_unproved');
      rows.push(read.evidence.effect === 'input-field'
        ? { ordinal, goal: read.goal, close: read.evidence.close!, result: 'input-field', achieved: [...read.evidence.results], sources: read.e4 }
        : { ordinal, goal: read.goal, close: read.evidence.close!, result: 'administrative', achieved: [], sources: [...read.administrative!.sources] });
    }
    return rows;
  });
}
/** LP6 (№3325 §6): the facts A6 of the new era is shown about every attempt of the window it explains — the same reading. */
export function deriveCompletionEvidence(store: Store, project: string, request: { series: Ref; ordinals: readonly number[] }): OmResult<Sealed<CompletionEvidence[]>> {
  windowSeries(store, project, request);
  return managedResult(() => {
    const series = managedTake(readAnySeriesAt(store, project, request.series));
    const ordinals = [...new Set(request.ordinals)].sort((a, b) => a - b);
    const known = new Set(decidedFieldsBefore(series.value, ordinals[0]!));
    return ordinals.map(ordinal => readAttempt(store, project, series, request.series, ordinal, known).evidence);
  });
}
/**
 * The single managed outcome table: prove the entire work with its additions, collect source classes, then derive the
 * reason. A saved close (`final`) also shows that its final journal holds exactly the classes derived here; the producer
 * derives them first over the rows alone, before that journal exists.
 */
type EraMarker = { progress?: typeof ATTEMPT_PROGRESS_CONTRACT };
type ManagedOutcomeInput = Omit<CompletionCloseRecord, 'contract' | 'outcome' | 'waiting' | 'claim'> & { claim: Omit<GateOutcome, 'reason'> } & EraMarker;
type ManagedCloseInput = Omit<CompletionCloseRecord, 'contract' | 'outcome' | 'waiting'> & EraMarker;
/** A saved close as the input of its own derivation: its era is the one its record names (LP6, №3325 §4). */
function closeInput(close: Sealed<CompletionCloseRecord> | CompletionCloseRecord): ManagedCloseInput {
  return { project: close.project, binding: close.binding, work: close.work, additions: [...close.additions], series: close.series,
    ledger: close.ledger, journal: close.journal, claim: close.claim as GateOutcome,
    ...(close.contract === 'om-completion-close/v2' ? { progress: ATTEMPT_PROGRESS_CONTRACT } : {}) };
}
function deriveManagedClose(store: Store, input: ManagedCloseInput, final = true) {
  const derived = deriveManagedOutcome(store, input, !final), { reason, confirmed, classifications, journal, series, owner, snapshot } = derived;
  if (reason === null || input.claim.reason !== reason)
    managedFail(owner.series.id, 'reason', 'The reason must follow the full proved composition, without hiding local outcomes', 'completion_reason_invalid');
  if (final) for (const row of classifications) {
    const saved = journal?.value.classifications.find(item => item.row === row.row);
    if (!saved || canonical(saved) !== canonical(row))
      managedFail(input.journal?.id ?? series.id, 'journal', 'The final journal of the close holds exactly the classes the close derives', 'completion_invalid', input.journal ?? undefined);
  }
  const outcome: ClaimedOutcome = { reason, achieved: confirmed.achieved, cancelled: confirmed.cancelled, refusals: input.claim.refusals,
    ...(derived.progress === undefined ? {} : { progress: derived.progress }) };
  const value: CompletionCloseRecord = { contract: derived.progress === undefined ? 'om-completion-close/v1' : 'om-completion-close/v2',
    project: input.project, binding: input.binding,
    work: input.work, additions: [...input.additions], series: input.series, ledger: input.ledger, journal: input.journal,
    claim: completionClaim(input.claim), outcome, waiting: [...snapshot.waiting] };
  return { value, snapshot, routed: derived.routed, classifications, rows: derived.rows, address: derived.address, guards: confirmed.guards ?? [] };
}
/** Everything a managed close derives before its reason is compared: the one formula for the close and the claim preparer (H1). */
function deriveManagedOutcome(store: Store, input: ManagedOutcomeInput, newClaim = false) {
  const closure: ManagedClosure = { binding: input.binding, work: input.work, additions: input.additions, journal: input.journal,
    ...(input.progress === undefined ? {} : { progress: input.progress }) };
  const snapshot = managedTake(checkManagedCompletionClaims(store, input.project, closure, input.claim.accepting, input.claim.refusals));
  const owner = snapshot.binding.value, series = managedTake(readAnySeriesAt(store, input.project, input.series));
  // LP6: only a block gets the new rules of result and neutrality; a mechanism close stays in its own era.
  if (closure.progress !== undefined && owner.owner.kind !== 'block')
    managedFail(series.id, 'progress', 'A mechanism close keeps the rules of its own era; only a block close carries progress');
  const address = seriesAddress(seriesRequestOf(series.value));
  const attempt = series.value.attempts.find(row => row.ordinal === owner.attempt);
  if (series.id !== owner.series.id || !attempt || attempt.outcome !== null || canonical(attempt.goal) !== canonical(owner.goal))
    managedFail(series.id, 'attempt', 'The close retains its exact open original attempt');
  if (input.ledger) managedTake(checkCompletionLedger(store, snapshot as CompletionSnapshot, input.ledger, input.journal));
  else {
    // Null is historical evidence only for a complete never-dispatched composition.
    // Every product is already proved by the work reader; no present-day enumeration is used here.
    // The registered check and its G4b records are non-physical products (№1616 п.3): they need no E1 row. So is the
    // LP5 end of a remaining acceptance or confirmation (return №3294 п.3); a reuse is not: it answers by paid work.
    if (snapshot.products.some(ref => { const record = store.get(ref.id, ref.revision)!;
      return !['question-packet', 'om-completion-packet', 'om-completion-cessation', 'om-completion-finalization'].includes(record.kind)
        && !answersProduct(input.project, ref, record); })
      || !snapshot.cessations.length || snapshot.cessations.some(row => row.value.call !== null
        || row.value.ledger !== null || row.value.physical !== null))
      managedFail(series.id, 'ledger', 'Physical/E1 work cannot omit its exact ledger');
  }
  const journal = input.journal ? managedTake(readJournalAt(store, input.project, input.journal)) : null;
  const rows = new Map(journal?.value.rows.map(row => [row.id, row]) ?? []);
  const routed: RoutedRefusal[] = [], classifications: RefusalClassification[] = [];
  const diagnostics = new Map<string, ReturnType<typeof readManagedModelDiagnostic>>();
  let subject = false;
  for (const claim of input.claim.refusals) {
    const row = rows.get(claim.row);
    if (!row || row.code !== claim.name || row.goal !== claim.goal) managedFail(series.id, 'refusals', 'Every claim needs its exact checked journal row');
    let classified: RefusalClassification;
    // C23: the G4b branch comes first; no G4b row is a subject, whatever gate or stage the rest of it names.
    if (answersRowMarks(input.project, row as JournalRow).any) refuseAnswersClaim(store, input.project, row as JournalRow, series.id);
    if (row.gate === 'E5') {
      const proof = managedTake(readAssessmentRefusalAt(store, input.project, row.source));
      if (proof.intent.originalSeries.id !== owner.series.id || proof.intent.attempt !== owner.attempt
        || canonical(proof.intent.goal) !== canonical(owner.goal) || !snapshot.negative.some(ref => sameRef(ref, reference(proof.result))))
        managedFail(row.id, 'assessment', 'An E5 row must belong to the exact negative subset');
      classified = { row: row.id, class: 'proposal', addressee: `node:${proof.target}`, basis: [{ role: 'assessment', ref: reference(proof.result) }] };
      subject = true;
    } else if (row.gate === 'E4') {
      const key = canonical(row.source);
      if (!diagnostics.has(key)) diagnostics.set(key, newClaim ? checkManagedModelDiagnostic(store, snapshot as CompletionSnapshot, row.source)
        : readManagedModelDiagnostic(store, snapshot.binding, row.source));
      const proof = managedTake(diagnostics.get(key)!);
      const semantic = proof.reason === 'refused';
      subject ||= semantic;
      classified = { row: row.id, class: semantic ? 'proposal' : 'conditions',
        addressee: semantic ? `node:${row.goal}` : `owner:${address.id}`, basis: row.origin.sources };
    } else {
      const proof = derive(store, row as JournalRow, address, owner.attempt, 'outcome.refusals');
      if ('ok' in proof) managedTake(proof);
      const derived = proof as Derived;
      classified = { row: row.id, class: derived.class, addressee: derived.addressee, basis: derived.basis };
      subject = true;
    }
    classifications.push(classified);
    routed.push({ ...classified, toModel: TO_MODEL[classified.class as RefusalClass] } as RoutedRefusal);
  }
  // H1.0d: the provider sees the ORIGINAL open series of the binding, so no provider reads through this close.
  const common = { project: input.project, target: owner.series.id, goal: owner.goal,
    attempt: { series: owner.series, ordinal: owner.attempt }, accepting: input.claim.accepting,
    cancelling: input.claim.cancelling, refusals: input.claim.refusals, managedClosure: closure };
  const confirmed: ConfirmedResults = managedTake(confirmResults(store, owner.owner.kind === 'block'
    ? { ...common, block: owner.owner.block } : { ...common, owner: owner.owner }));
  const reason: CompletionReason | null = confirmed.achieved.length || confirmed.cancelled.length ? 'result'
    : subject ? 'refused' : snapshot.technical.some(row => row.reason === 'interrupted') ? 'interrupted'
    : snapshot.technical.some(row => row.reason === 'off-form') ? 'off-form' : snapshot.waiting.length ? 'awaiting-owner' : null;
  // LP6 (№3325 §3–4): a block close of the new era derives its progress from this same composition, never from a flag.
  const progress: AttemptProgress | undefined = closure.progress === undefined ? undefined : { contract: ATTEMPT_PROGRESS_CONTRACT,
    administrative: reason === 'interrupted' ? administrativeEnd(store, input.project, snapshot as CompletionSnapshot,
      requiredManagedAccepting(store, input.project, closure, snapshot as CompletionSnapshot).noop) : null };
  return { reason, confirmed, snapshot, routed, classifications, rows, address, journal, series, owner, progress };
}
/** NR1 (№3600): a trusted read — the close proof was written once as the single full managed outcome derivation. */
export function readCompletionCloseAt(store: Store, project: string, ref: Ref): OmResult<Sealed<CompletionCloseRecord>> {
  return managedResult(() => historicalRead(store, { reader: 'G7.completion-close', project, ref }, () =>
    managedTake(readRecord<CompletionCloseRecord>(store, ref, { unit: UNIT, target: ref.id,
      kind: COMPLETION_CLOSE_KIND, idPrefix: `${COMPLETION_CLOSE_KIND}:${project}:` })).value,
  () => managedFail(ref.id, 'history', 'A close proof cannot depend on its own closed attempt')));
}
function prepareManagedGateClose(store: Store, request: AnyCloseAttemptRequest): OmResult<Sealed<RepeatTransition>> | null {
  const seriesHead = store.get<AnyRepairSeries>(seriesAddress(request).id);
  if (!seriesHead) return null;
  const selected = readCompletionBinding(store, request.project, reference(seriesHead), request.attempt);
  if (!selected.ok) return selected;
  if (!selected.value) return null;
  return managedResult(() => {
    const binding = selected.value!, id = completionCloseId(request.project, binding.id), old = store.get(id);
    if (old) {
      const close = managedTake(readCompletionCloseAt(store, request.project, reference(old)));
      if (canonical(completionClaim(request.outcome)) !== canonical(close.claim))
        managedFail(id, 'outcome', 'An already completed managed attempt keeps its entire original claim', 'outcome_conflict');
      const series = managedTake(readAnySeriesAt(store, request.project, reference(seriesHead)));
      const attempt = series.value.attempts.find(row => row.ordinal === request.attempt);
      if (!attempt?.outcome) managedFail(id, 'series', 'A saved close proof requires its atomic A3 outcome');
      const derived = deriveManagedClose(store, closeInput(close));
      const journal = close.journal ? managedTake(readJournalAt(store, request.project, close.journal)) : null;
      const decided = [...(journal?.value.classifications ?? []).filter(row => !derived.classifications.some(next => next.row === row.row)),
        ...derived.classifications];
      const raised: HoldContext[] = [];
      for (const row of derived.routed.filter(row => row.class === 'unknown')) {
        const hold = raise(store, derived.address, request.attempt, row, reference(series), derived.rows.get(row.row)!.origin);
        if ('ok' in hold) managedTake(hold);
        const checked = hold as Exclude<typeof hold, OmResult<never>>;
        if (checked.write) managedFail(id, 'hold', 'A completed claim must retain its atomic hold');
        if (checked.standing) raised.push(checked.standing);
      }
      return { writes: [], guards: [], value: reported(seriesAddress(request), series.value as AnyRepairSeries,
        request.attempt, derived.routed, raised, decided) };
    }
    return managedCloseBundle(store, request, closeHeads(store, request, binding, seriesHead), null);
  });
}
/** The mutable heads a managed close stands on, captured before any supplier or product is traversed. */
export interface ManagedCloseHeads {
  binding: Ref; series: Revision<AnyRepairSeries>; work: Revision<CompletionWork>; ledger: Ref | null; products: Ref[]; journal: Ref | null;
}
/**
 * The evaluation half of a linked close (H1.0c, №1616 п.3): its records written before the rows (gate, evaluation,
 * proofs), their guards, the G4b sources and their pending writes, which the journal batch hands back itself, and the
 * exact additions of the work: the evaluation and those sources.
 */
export interface LinkedCloseParts {
  heads: Sealed<ManagedCloseHeads>; writes: readonly Write[]; guards: readonly TransactionGuard[];
  sources: readonly Ref[]; pending: readonly Write[]; additions: readonly Ref[];
}
function closeHeads(store: Store, request: AnyCloseAttemptRequest, binding: Revision<unknown>, seriesHead: Revision<unknown>): ManagedCloseHeads {
  const id = completionCloseId(request.project, binding.id);
  const workHead = store.get<CompletionWork>(completionWorkId(request.project, binding.id));
  const ledgerHead = store.get(callLedgerId(request.project));
  // Capture mutable product cursors before the historical walk. Their exact old
  // revisions remain evidence; moving a cursor during this close must still lose CAS.
  const productHeads = new Map<string, Ref>();
  if (workHead && Array.isArray(workHead.value.products) && Array.isArray(workHead.value.assignments)) {
    for (const ref of [...workHead.value.products, ...workHead.value.assignments]) if (isRef(ref)) {
      const head = store.get(ref.id);
      if (head) productHeads.set(ref.id, reference(head));
    }
  }
  const journalRead = readJournal(store, { project: request.project });
  if (!journalRead.ok && journalRead.refusal.code !== 'journal_missing') managedTake(journalRead);
  const journalHead = journalRead.ok ? journalRead.value : null;
  if (!workHead) managedFail(id, 'work', 'The managed registry is mandatory');
  const ledger = managedTake(readCallLedger(store, request.project));
  if (canonical(ledger ? reference(ledger) : null) !== canonical(ledgerHead ? reference(ledgerHead) : null))
    managedFail(id, 'ledger', 'Managed closure must retain the captured lawful E1 head or proved absence');
  return { binding: reference(binding), series: seriesHead as Revision<AnyRepairSeries>, work: workHead,
    ledger: ledgerHead ? reference(ledgerHead) : null, products: [...productHeads.values()], journal: journalHead ? reference(journalHead) : null };
}
/** The whole shape of a close request, for a caller that names one and must refuse it before any read (lesson 1). */
export function requireCloseRequestShape(store: Store, request: AnyCloseAttemptRequest): void {
  requireCloseRequest(store, request);
}
/** Captures the heads of a managed close for a caller that prepares more records into the same bundle. */
export function captureManagedCloseHeads(store: Store, request: AnyCloseAttemptRequest): OmResult<Sealed<ManagedCloseHeads>> {
  requireCloseRequest(store, request);
  return withHistoricalReads(() => {
    const seriesHead = store.get<AnyRepairSeries>(seriesAddress(request).id);
    const selected = seriesHead ? readCompletionBinding(store, request.project, reference(seriesHead), request.attempt) : null;
    if (selected && !selected.ok) return selected;
    return managedResult(() => {
      if (!seriesHead || !selected?.value) managedFail(seriesAddress(request).id, 'completion', 'A linked close needs a managed attempt', 'completion_required');
      return closeHeads(store, request, selected.value, seriesHead);
    });
  });
}
/** The claim a managed attempt can be closed with, and the heads it stands on (H1 №1737 п.5). */
export interface PreparedManagedClaim { outcome: GateOutcome; guards: TransactionGuard[] }
/**
 * H1 (№1737 п.5–6): the full claim of a managed attempt, derived — never guessed — by the same outcome table as a
 * direct or linked close and its historical reader. The registry names what it requires (every supported E5 basis,
 * every applied M5 addressing, every diagnostic row); the caller adds only the independent results of its own steps
 * (an accepted frame, a gap line) and lawful cancellations, which the providers still confirm. It writes nothing. An
 * unfinished composition keeps its typed incompleteness; a finished one without a proved ground is a pause of its
 * producer or control, never an invented reason.
 */
export function prepareManagedClaim(store: Store, request: AnyCloseAttemptRequest): OmResult<Sealed<PreparedManagedClaim>> {
  requireCloseRequest(store, request);
  return withHistoricalReads(() => {
    const seriesHead = store.get<AnyRepairSeries>(seriesAddress(request).id);
    const selected = seriesHead ? readCompletionBinding(store, request.project, reference(seriesHead), request.attempt) : null;
    if (selected && !selected.ok) return selected;
    return managedResult(() => {
      if (!seriesHead || !selected?.value) managedFail(seriesAddress(request).id, 'completion', 'A derived claim belongs to a managed attempt', 'completion_required');
      const heads = closeHeads(store, request, selected.value, seriesHead);
      // LP6: a block close is of the new era; its claim names every own input-field result the registry requires.
      const era = selected.value.value.owner.kind === 'block' ? { progress: ATTEMPT_PROGRESS_CONTRACT } : {};
      const closure: ManagedClosure = { binding: heads.binding, work: reference(heads.work), additions: [], journal: heads.journal, ...era };
      const snapshot = managedTake(readCompletionEffectiveAt(store, request.project, { work: closure.work, additions: [], journal: closure.journal }));
      if (!snapshot.complete || snapshot.work.value.closed)
        managedFail(closure.work.id, 'work', 'The close must use one complete exact pre-close registry', 'completion_incomplete');
      const required = requiredManagedAccepting(store, request.project, closure, snapshot as CompletionSnapshot);
      const unique = <T>(values: readonly T[], key: (value: T) => string) => [...new Map(values.map(value => [key(value), value])).values()];
      const accepting = unique([...required.e5, ...required.e4, ...request.outcome.accepting], ref => canonical(ref));
      const refusals = unique([...snapshot.refusals, ...request.outcome.refusals], row => row.row);
      const claim = { accepting, cancelling: [...request.outcome.cancelling], refusals };
      const derived = deriveManagedOutcome(store, { project: request.project, binding: heads.binding, work: closure.work, additions: [],
        series: reference(heads.series), ledger: heads.ledger, journal: heads.journal, claim, ...era }, true);
      if (derived.reason === null) managedFail(heads.series.id, 'reason',
        'The composition is complete but no proved ground closes it yet: the pause stands with its producer or control', 'completion_reason_invalid');
      return { outcome: completionClaim({ reason: derived.reason, ...claim }),
        guards: uniqueTransactionGuards([reference(heads.series), reference(heads.work), ...heads.products,
          heads.ledger ?? { id: callLedgerId(request.project), absent: true },
          heads.journal ?? { id: journalId(request.project), absent: true }, ...(derived.confirmed.guards ?? [])]) };
    });
  });
}
/**
 * H1.0c linked close: the evaluation half and the close in ONE bundle over the heads captured before either was
 * prepared. The same producer as a direct G7 (whose additions are empty): rows of the additions, then the classes
 * derived over them, then one final journal, the close citing it, A3, holds and one closed work revision.
 */
export function prepareLinkedClose(store: Store, request: AnyCloseAttemptRequest, linked: LinkedCloseParts): OmResult<Sealed<RepeatTransition>> {
  requireCloseRequest(store, request);
  requireCondition(isPlainObject(linked) && isPlainObject(linked.heads) && isRef(linked.heads.binding) && isRef(linked.heads.series)
    && isRef(linked.heads.work) && [linked.writes, linked.pending].every(list => Array.isArray(list) && list.every(write =>
      isPlainObject(write) && isText(write.id) && isText(write.kind) && Number.isSafeInteger(write.expected)))
    && Array.isArray(linked.guards) && [linked.sources, linked.additions].every(list => Array.isArray(list) && list.every(isRef)),
  "repeat_request_invalid", "A linked close names its captured heads, its pending records and its exact additions");
  return managedResult(() => {
    const heads = linked.heads, selected = managedTake(readCompletionBinding(store, request.project, reference(heads.series), request.attempt));
    if (!selected || !sameRef(reference(selected), heads.binding) || heads.series.id !== seriesAddress(request).id
      || heads.work.id !== completionWorkId(request.project, heads.binding.id))
      managedFail(completionCloseId(request.project, heads.binding.id), 'binding', 'The captured heads belong to the attempt this close names', 'completion_foreign');
    if (store.get(completionCloseId(request.project, linked.heads.binding.id)))
      managedFail(linked.heads.work.id, 'work', 'A closed attempt takes no linked additions; only exact repeats', 'completion_closed');
    return managedCloseBundle(store, request, linked.heads, linked);
  });
}
function managedCloseBundle(store: Store, request: AnyCloseAttemptRequest, heads: Sealed<ManagedCloseHeads>,
  linked: LinkedCloseParts | null): RepeatTransition {
  const project = request.project, id = completionCloseId(project, heads.binding.id), workHead = heads.work;
  const journalGuard = heads.journal ?? { id: journalId(project), absent: true as const };
  const base = linked ? pendingCallStore(store, linked.writes) : store;
  const additions = linked ? [...linked.additions] : [], sources = linked ? [...linked.sources] : [];
  const pending = linked ? [...linked.pending] : [];
  const extra: GateWrite[] = [], extraGuards: TransactionGuard[] = [];
  // Rows of the additions first (in memory only), so the classes are derived over the rows the final journal holds.
  const rows = sources.length ? managedTake(prepareJournalBatch(base, { project, sources, pending, classifications: [] })) : null;
  const rowsView = rows ? pendingCallStore(base, rows.writes as Write[]) : base;
  if (linked) {
    // The general work transition admits the additions (the line admission for a new evaluation, C13); its own work
    // revision is dropped: the close writes the one final revision of the work itself.
    const admitted = managedTake(prepareCompletionProducts(rowsView, heads.binding, additions));
    extra.push(...admitted.writes.filter(write => write.id !== workHead.id));
    extraGuards.push(...linked.guards, ...admitted.guards);
  }
  // LP6 (№3325 §4): every new managed close of a block is of the new era; a mechanism close keeps its own.
  const era = managedTake(readCompletionOwnerAt(base, project, heads.binding)).value.owner.kind === 'block'
    ? { progress: ATTEMPT_PROGRESS_CONTRACT } : {};
  const input = { project, binding: heads.binding, work: reference(workHead), additions, series: reference(heads.series),
    ledger: heads.ledger, claim: completionClaim(request.outcome), ...era };
  const first = deriveManagedClose(rowsView, { ...input, journal: rows ? rows.result : heads.journal }, false);
  // One final A2 write: the rows of the additions and the classes of this close; no intermediate journal revision.
  const batch = sources.length || first.classifications.length ? managedTake(prepareJournalBatch(base,
    { project, sources, pending, classifications: first.classifications })) : null;
  const journal = batch ? batch.result : heads.journal;
  const view = batch ? pendingCallStore(base, batch.writes as Write[]) : base;
  const value: CompletionCloseRecord = { ...first.value, journal };
  const closeWrite = { id, kind: COMPLETION_CLOSE_KIND, expected: 0, value };
  const closeRef = { id, revision: 1, hash: hashJson(value as unknown as Json) };
  // The series reads the close through the full reader, over the final journal of this same view (C67).
  const completed = managedTake(prepareManagedCompleteAttempt(pendingCallStore(view, [closeWrite]), { ...request,
    outcome: value.outcome }, closeRef));
  const writes: GateWrite[] = [...(linked?.writes ?? []), ...extra, closeWrite, ...completed.writes];
  const guards: TransactionGuard[] = [reference(heads.series), reference(workHead),
    heads.ledger ?? { id: callLedgerId(project), absent: true }, ...heads.products, ...completed.guards, ...first.guards, ...extraGuards];
  const decided: readonly RefusalClassification[] = batch ? batch.value.classifications
    : journal ? managedTake(readJournalAt(base, project, journal)).value.classifications : [];
  if (batch) { writes.push(...batch.writes); guards.push(...batch.guards); }
  guards.push(journalGuard);
  const raised: HoldContext[] = [];
  const recorded = { id: heads.series.id, revision: heads.series.revision + 1, hash: hashJson(completed.value) };
  for (const row of first.routed.filter(row => row.class === 'unknown')) {
    const hold = raise(store, first.address, request.attempt, row, recorded, first.rows.get(row.row)!.origin);
    if ('ok' in hold) managedTake(hold);
    const checked = hold as Exclude<typeof hold, OmResult<never>>;
    if (checked.write) writes.push(checked.write);
    if (checked.guard) guards.push(checked.guard);
    if (checked.standing) raised.push(checked.standing);
  }
  writes.push({ id: workHead.id, kind: COMPLETION_WORK_KIND, expected: workHead.revision,
    value: managedTake(completionClosedWork(view, project, workHead, value, closeRef)) });
  if (new Set(writes.map(write => write.id)).size !== writes.length)
    managedFail(id, 'writes', 'One transaction writes one record once', 'revision_conflict');
  // Guards name what stood before the bundle, never a revision the same bundle writes.
  const written = new Set(writes.map(write => `${write.id}@${write.expected + 1}`));
  return { writes, guards: uniqueTransactionGuards(guards.filter(guard => !('revision' in guard) || !written.has(`${guard.id}@${guard.revision}`))),
    value: reported(first.address, completed.value as AnyRepairSeries, request.attempt, first.routed, raised, decided) };
}
