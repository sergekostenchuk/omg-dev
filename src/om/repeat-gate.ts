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
  normalizeOriginSource, originSourceKey, prepareClassifyRefusal, readJournal, readJournalAt, journalId,
  type JournalRow, type OriginSource, type OriginSourceContext, type RefusalClassification, type RefusalJournal, type RefusalOrigin,
} from "./refusal-journal.js";
import {
  prepareManagedBeginAttempt, prepareCompleteAttempt, readAnySeries, readAnySeriesAt, seriesAddress, seriesRequestOf, REPAIR_SERIES_KIND,
  type Attempt, type AttemptGoal, type AttemptVerdict, type BeginAttemptRequest, type ClaimedRefusal,
  type CompletionReason, type Continuation, type GroundRecord, type RepairSeries,
  type SeriesLadder, type SeriesRequest, type SeriesStop, type SeriesTransition,
  type SeriesOwner, type MechanismSeriesRequest, type MechanismBeginAttemptRequest,
  type MechanismRepairSeries, type AnyRepairSeries, type AnySeriesRequest, type AnySeriesTransition,
} from "./series.js";
import { withHistoricalReads, historicalRead } from "./input.js";
import { confirmResults, type ConfirmedResults } from "./achievements.js";
import { projectGraph } from "../graph/project.js";
import type { Graph } from "../graph/model.js";
import { readFrame, type FrameRequest } from "./frame-obligations.js";
import { definitionIds, observeProposal, type ProposalRequest } from "./frame-proposals.js";
import { observeCandidate } from "./frame-candidate.js";
import { assessmentAttemptReason, checkCurrentAssessmentAttemptClosure, isAssessmentCallName,
  readAssessmentRefusalAt } from "./assessment.js";
import { acceptedAnswerNamespace } from "./accepted-answer.js";
import { callLedgerId, readCallLedger, type CallLedger } from "./call-record.js";

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
function prepareCloseInScope(store: Store, request: AnyCloseAttemptRequest, address: Address): OmResult<RepeatTransition> {
  const { reason, accepting, cancelling, refusals: claimed } = request.outcome;
  const at = requestOf(address);
  const assessmentGuards: TransactionGuard[] = [];
  // This head is captured before any E1 enumeration. Exact completed repeats never traverse today's ledger.
  const ledgerId = callLedgerId(address.project);
  const capturedLedger = address.owner.kind === "block" ? store.get<CallLedger>(ledgerId) : null;

  // What the cycle achieved and cancelled, as the providers of acceptance confirm it, never as the caller says it.
  let results: ConfirmedResults = { achieved: [], cancelled: [] };
  if (accepting.length + cancelling.length > 0) {
    if (address.owner.kind === "mechanism") return refused(accepting.length ? "acceptance_unconfirmed" : "cancellation_unconfirmed",
      "No acceptance provider confirms a mechanism addressing result yet",
      { unit: UNIT, target: address.id, field: accepting.length ? "outcome.accepting" : "outcome.cancelling" }, "producer");
    const standing = readAnySeries(store, at);
    if (!standing.ok) return standing;
    const attempt = [...standing.value.value.inherited, ...standing.value.value.attempts].find(item => item.ordinal === request.attempt);
    const confirmed = confirmResults(store, {
      project: address.project, block: address.owner.block, target: address.id,
      attempt: { series: reference(standing.value), ordinal: request.attempt },
      goal: attempt === undefined ? null : attempt.goal as AttemptGoal, accepting, cancelling, refusals: claimed,
    });
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
  const guards: Ref[] = [];
  let independentRefusal = false;
  if (results.guards) assessmentGuards.push(...results.guards);
  const rows = new Map<string, JournalRow>();
  if (wanted.length > 0) {
    const journal = readJournal(store, { project: address.project });
    if (!journal.ok) return unlinked(address, journal.refusal.code, "outcome.refusals");
    // The head the classes were derived from guards the transaction as well: no window between reading and writing.
    guards.push(reference(journal.value));
    for (const row of journal.value.value.rows) rows.set(row.id, row as JournalRow);
    for (const named of wanted) {
      const index = placed.get(named)!;
      const row = rows.get(named);
      if (!row) {
        return refused("refusal_unknown", "No refusal stands in the journal of this project under that row",
          { unit: UNIT, target: address.id, field: `outcome.refusals.${index}.row` }, "producer");
      }
      const derived = derive(store, row, address, request.attempt, `outcome.refusals.${index}.origin`);
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
  const series = prepareCompleteAttempt(store, completion);
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
  const writes: GateWrite[] = [...series.value.writes];
  guards.push(...series.value.guards);

  let decided: readonly RefusalClassification[] = [];
  if (classifications.length > 0) {
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
function recordedAt(store: Store, address: Address, written: readonly { readonly expected: number; readonly value: unknown }[], guards: Ref[]): Ref {
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
function uniqueGuards(guards: readonly Ref[]): Ref[] {
  const seen = new Map<string, Ref>();
  for (const guard of guards) seen.set(`${guard.id}\0${guard.revision}\0${guard.hash}`, exactRef(guard));
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

import { completionWorkId, completionCloseId, COMPLETION_CLOSE_KIND, COMPLETION_WORK_KIND,
  readCompletionBinding, prepareManagedCompleteAttempt,
  type CompletionWork, type ManagedClosure, type ClaimedOutcome } from './series.js';
import { readCompletionWorkAt, readManagedModelDiagnostic, checkCompletionLedger, pendingCallStore,
  type CompletionSnapshot } from './model-call.js';
export interface CompletionCloseRecord {
  contract: 'om-completion-close/v1'; project: string; binding: Ref; work: Ref; series: Ref;
  ledger: Ref | null; journal: Ref | null; claim: GateOutcome; outcome: ClaimedOutcome; waiting: Ref[];
}
class ManagedCloseFailure extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message); }
}
function managedTake<T>(result: OmResult<T>): T { if (!result.ok) throw new ManagedCloseFailure(result.refusal); return result.value; }
function managedFail(id: string, field: string, message: string, code = 'completion_invalid'): never {
  const result = refused(code, message, { unit: UNIT, target: id, field }, 'producer');
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
/** Exact registry context for the D5 supplier. It is evidence to rederive, never a completeness flag. */
export function checkManagedCompletionClaims(store: Store, project: string, context: ManagedClosure,
  accepting: readonly Ref[], refusals: readonly ClaimedRefusal[]): OmResult<Sealed<CompletionSnapshot>> {
  return managedResult(() => {
    const snapshot = managedTake(readCompletionWorkAt(store, project, context.work));
    if (!sameRef(reference(snapshot.binding), context.binding) || !snapshot.complete || snapshot.work.value.closed)
      managedFail(context.work.id, 'work', 'The close must use one complete exact pre-close registry', 'completion_incomplete');
    const e5 = (ref: Ref) => ref.id.startsWith(`${acceptedAnswerNamespace(project)}e5:`);
    const ordered = (values: readonly Ref[]) => [...values].sort((a,b) => canonical(a).localeCompare(canonical(b)));
    if (canonical(ordered(accepting.filter(e5))) !== canonical(ordered(snapshot.accepting)))
      managedFail(context.work.id, 'accepting', 'The close must retain every exact supported E5 basis');
    const required = new Set(snapshot.refusals.map(row => row.row));
    if (snapshot.refusals.some(row => !refusals.some(item => canonical(item) === canonical(row))))
      managedFail(context.work.id, 'refusals', 'The close must retain every semantic, technical and control diagnostic');
    if (refusals.some(row => row.name.startsWith('fact_assessment_') && !required.has(row.row)))
      managedFail(context.work.id, 'refusals', 'A foreign assessment refusal cannot be added to this complete set');
    return snapshot as CompletionSnapshot;
  });
}
/** The single managed outcome table: prove the entire work, collect source classes, then derive the reason. */
function deriveManagedClose(store: Store, input: Omit<CompletionCloseRecord, 'contract' | 'outcome' | 'waiting'>) {
  const snapshot = managedTake(checkManagedCompletionClaims(store, input.project,
    { binding: input.binding, work: input.work }, input.claim.accepting, input.claim.refusals));
  const owner = snapshot.binding.value, series = managedTake(readAnySeriesAt(store, input.project, input.series));
  const address = seriesAddress(seriesRequestOf(series.value));
  const attempt = series.value.attempts.find(row => row.ordinal === owner.attempt);
  if (series.id !== owner.series.id || !attempt || attempt.outcome !== null || canonical(attempt.goal) !== canonical(owner.goal))
    managedFail(series.id, 'attempt', 'The close retains its exact open original attempt');
  if (input.ledger) managedTake(checkCompletionLedger(store, snapshot as CompletionSnapshot, input.ledger, input.journal));
  else {
    // Null is historical evidence only for a complete never-dispatched composition.
    // Every product is already proved by the work reader; no present-day enumeration is used here.
    if (snapshot.products.some(ref => !['question-packet', 'om-completion-packet', 'om-completion-cessation'].includes(store.get(ref.id, ref.revision)!.kind))
      || !snapshot.cessations.length || snapshot.cessations.some(row => row.value.call !== null
        || row.value.ledger !== null || row.value.physical !== null))
      managedFail(series.id, 'ledger', 'Physical/E1 work cannot omit its exact ledger');
  }
  const journal = input.journal ? managedTake(readJournalAt(store, input.project, input.journal)) : null;
  const rows = new Map(journal?.value.rows.map(row => [row.id, row]) ?? []);
  const routed: RoutedRefusal[] = [], classifications: RefusalClassification[] = [];
  let subject = false;
  for (const claim of input.claim.refusals) {
    const row = rows.get(claim.row);
    if (!row || row.code !== claim.name || row.goal !== claim.goal) managedFail(series.id, 'refusals', 'Every claim needs its exact checked journal row');
    let classified: RefusalClassification;
    if (row.gate === 'E5') {
      const proof = managedTake(readAssessmentRefusalAt(store, input.project, row.source));
      if (proof.intent.originalSeries.id !== owner.series.id || proof.intent.attempt !== owner.attempt
        || canonical(proof.intent.goal) !== canonical(owner.goal) || !snapshot.negative.some(ref => sameRef(ref, reference(proof.result))))
        managedFail(row.id, 'assessment', 'An E5 row must belong to the exact negative subset');
      classified = { row: row.id, class: 'proposal', addressee: `node:${proof.target}`, basis: [{ role: 'assessment', ref: reference(proof.result) }] };
      subject = true;
    } else if (row.gate === 'E4') {
      const proof = managedTake(readManagedModelDiagnostic(store, snapshot.binding, row.source));
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
  let confirmed: ConfirmedResults = { achieved: [], cancelled: [] };
  if (owner.owner.kind === 'block') confirmed = managedTake(confirmResults(store, {
    project: input.project, target: owner.series.id, block: owner.owner.block, goal: owner.goal,
    attempt: { series: owner.series, ordinal: owner.attempt }, accepting: input.claim.accepting,
    cancelling: input.claim.cancelling, refusals: input.claim.refusals, managedClosure: { binding: input.binding, work: input.work },
  }));
  else if (input.claim.accepting.length || input.claim.cancelling.length)
    managedFail(owner.series.id, 'accepting', 'No mechanism acceptance provider is registered yet', 'acceptance_unconfirmed');
  const reason: CompletionReason | null = confirmed.achieved.length || confirmed.cancelled.length ? 'result'
    : subject ? 'refused' : snapshot.technical.some(row => row.reason === 'interrupted') ? 'interrupted'
    : snapshot.technical.some(row => row.reason === 'off-form') ? 'off-form' : snapshot.waiting.length ? 'awaiting-owner' : null;
  if (reason === null || input.claim.reason !== reason)
    managedFail(owner.series.id, 'reason', 'The reason must follow the full proved composition, without hiding local outcomes', 'completion_reason_invalid');
  const outcome: ClaimedOutcome = { reason, achieved: confirmed.achieved, cancelled: confirmed.cancelled, refusals: input.claim.refusals };
  const value: CompletionCloseRecord = { contract: 'om-completion-close/v1', ...input,
    claim: completionClaim(input.claim), outcome, waiting: [...snapshot.waiting] };
  return { value, snapshot, routed, classifications, rows, address, guards: confirmed.guards ?? [] };
}
export function readCompletionCloseAt(store: Store, project: string, ref: Ref): OmResult<Sealed<CompletionCloseRecord>> {
  return managedResult(() => historicalRead(store, { reader: 'G7.completion-close', project, ref }, () => {
    const record = managedTake(readRecord<CompletionCloseRecord>(store, ref, { unit: UNIT, target: ref.id,
      kind: COMPLETION_CLOSE_KIND, idPrefix: `${COMPLETION_CLOSE_KIND}:${project}:` }));
    const value = record.value;
    if (!isPlainObject(value) || value.contract !== 'om-completion-close/v1' || value.project !== project
      || !isRef(value.binding) || !isRef(value.work) || !isRef(value.series) || !isPlainObject(value.claim)
      || !Array.isArray(value.claim.accepting) || !value.claim.accepting.every(isRef)
      || !Array.isArray(value.claim.cancelling) || !value.claim.cancelling.every(isRef)
      || !Array.isArray(value.claim.refusals) || !value.claim.refusals.every(row => isPlainObject(row)
        && isText(row.row) && isText(row.name) && isText(row.goal))
      || !['result', 'refused', 'off-form', 'interrupted', 'awaiting-owner'].includes(value.claim.reason)
      || ![value.ledger, value.journal].every(item => item === null || isRef(item)))
      managedFail(ref.id, 'record', 'The immutable close proof retains all exact pre-close sources');
    const derived = deriveManagedClose(store, { project, binding: value.binding, work: value.work,
      series: value.series, ledger: value.ledger, journal: value.journal, claim: value.claim });
    if (record.revision !== 1 || record.id !== completionCloseId(project, value.binding.id) || canonical(value) !== canonical(derived.value))
      managedFail(ref.id, 'record', 'The close proof must equal the single full managed outcome derivation');
    return derived.value;
  }, () => managedFail(ref.id, 'history', 'A close proof cannot depend on its own closed attempt')));
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
      const derived = deriveManagedClose(store, close);
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
    // Capture every mutable head before traversing any supplier or product.
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
    const derived = deriveManagedClose(store, { project: request.project, binding: reference(binding), work: reference(workHead),
      series: reference(seriesHead), ledger: ledgerHead ? reference(ledgerHead) : null, journal: journalHead ? reference(journalHead) : null,
      claim: completionClaim(request.outcome) });
    const closeWrite = { id, kind: COMPLETION_CLOSE_KIND, expected: 0, value: derived.value };
    const closeRef = { id, revision: 1, hash: hashJson(derived.value) };
    const view = pendingCallStore(store, [closeWrite]);
    const completed = managedTake(prepareManagedCompleteAttempt(view, { ...request,
      outcome: derived.value.outcome }, closeRef));
    const writes: GateWrite[] = [closeWrite, ...completed.writes];
    const guards: TransactionGuard[] = [reference(seriesHead), reference(workHead),
      ledgerHead ? reference(ledgerHead) : { id: callLedgerId(request.project), absent: true },
      ...productHeads.values(), ...completed.guards, ...derived.guards];
    let decided: readonly RefusalClassification[] = [];
    if (derived.classifications.length) {
      const classified = managedTake(prepareClassifyRefusal(store, { project: request.project, classifications: derived.classifications }));
      writes.push(...classified.writes); guards.push(...classified.guards); decided = classified.value.classifications;
    }
    guards.push(journalHead ? reference(journalHead) : { id: journalId(request.project), absent: true });
    const raised: HoldContext[] = [];
    const recorded = { id: seriesHead.id, revision: seriesHead.revision + 1, hash: hashJson(completed.value) };
    for (const row of derived.routed.filter(row => row.class === 'unknown')) {
      const hold = raise(store, derived.address, request.attempt, row, recorded, derived.rows.get(row.row)!.origin);
      if ('ok' in hold) managedTake(hold);
      const checked = hold as Exclude<typeof hold, OmResult<never>>;
      if (checked.write) writes.push(checked.write);
      if (checked.guard) guards.push(checked.guard);
      if (checked.standing) raised.push(checked.standing);
    }
    writes.push({ id: workHead.id, kind: COMPLETION_WORK_KIND, expected: workHead.revision,
      value: { ...workHead.value, previous: reference(workHead), closed: closeRef } satisfies CompletionWork });
    return { writes, guards: uniqueTransactionGuards(guards),
      value: reported(derived.address, completed.value as AnyRepairSeries, request.attempt, derived.routed, raised, decided) };
  });
}
