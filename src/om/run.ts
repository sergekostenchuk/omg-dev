import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { delivered, isPlainObject, isText, localErrors, localRefusals, sealed, transfer, transferError, transferring, type OmResult,
  type Refusal, type Sealed, type SourceCode, type SourceCodes } from "./refusal.js";
import { readRecord as readRecordOf, writeGuarded as writeGuardedOf, type GuardedWrite, type RecordRequest } from "./refs.js";
import { prepareRoutes as prepareRoutesOf, readRoutes as readRoutesOf, writeRoutes as writeRoutesOf, type RouteBatch, type RoutesRecord, type RoutesRequest } from "./routes.js";
import { readQuestionQueue as readQuestionQueueOf } from "./queue.js";
import { readHorizon as readHorizonOf } from "./horizon.js";
import { prepareRunBases as prepareRunBasesOf, readRunStandingGuards as readRunStandingGuardsOf, writeRunBases as writeRunBasesOf, RUN_BASES_HEAD_STAGES, type RunBases } from "./run-bases.js";
import { readOmInput as readOmInputOf, readinessPending as readinessPendingOf, writeReadinessInput as writeReadinessInputOf, type OmInputRecord } from "./input.js";
import { readAcceptedAnswer as readAcceptedAnswerOf } from "./accepted-answer.js";
import { writeApplyAnswer as writeApplyAnswerOf, writeOwnerDecision as writeOwnerDecisionOf } from "./addressing.js";
import { ownerAnswersHeld, type OwnerAnswer } from "./owner-result.js";
import { openSeries as openSeriesOf, readAnySeriesAt as readAnySeriesAtOf, readCompletionBinding as readCompletionBindingOf, completionRootAssignments, completionWorkId, completionCloseId, prepareSeriesLineAdmission as prepareSeriesLineAdmissionOf,
  resumeSeries as resumeSeriesOf, reconcileSeries as reconcileSeriesOf, prepareReconcileSeries as prepareReconcileSeriesOf, seriesAddress, seriesRequestOf,
  type AnyRepairSeries, type AttemptGoal, type CompletionAssignment, type CompletionOwner, type CompletionWork, type SeriesOwner } from "./series.js";
import { closeAttempt as closeAttemptOf, openAttempt as openAttemptOf, prepareManagedClaim as prepareManagedClaimOf, readCompletionCloseAt as readCompletionCloseAtOf, readStopContext as readStopContextOf } from "./repeat-gate.js";
import { prepareStopAnalysis as prepareStopAnalysisOf, readStopAnalysis as readStopAnalysisOf, runStopAnalysis as runStopAnalysisOf, type StopAnalysisRequest,
  readRecoveredStopAnalysis, stopAnalysisRecoverable, writeStopAnalysisRecovery as writeStopAnalysisRecoveryOf, type AnalysisRecord } from "./stop-analysis.js";
import { ceasedCycleGround as ceasedCycleGroundOf, modelCallRecordId, modelCycleId, prepareCompletionCause as prepareCompletionCauseOf, readCompletionWorkAt as readCompletionWorkAtOf, readManagedModelDiagnostic as readManagedModelDiagnosticOf, readModelCycle as readModelCycleOf, readPartAssembly as readPartAssemblyOf, recoverOmModelCall, runModelCycle as runModelCycleOf,
  writeCompletionCessation as writeCompletionCessationOf, readAreaReplacement as readAreaReplacementOf,
  prepareCompletionFinalization as prepareCompletionFinalizationOf, writeCompletionFinalization as writeCompletionFinalizationOf,
  prepareCompletionReuse as prepareCompletionReuseOf, writeCompletionReuse as writeCompletionReuseOf, readReuseResult as readReuseResultOf,
  readCompletionAcceptance as readCompletionAcceptanceOf, readConfirmationGround as readConfirmationGroundOf,
  COMPLETION_FINALIZATION_KIND, COMPLETION_REUSE_KIND, type CompletionSnapshot, type FinalizationPhase } from "./model-call.js";
import { readQuestionPacket as readQuestionPacketOf, writeQuestionPacket as writeQuestionPacketOf } from "./question-packet.js";
import { assessFact as assessFactOf, readAssessmentIntentAt as readAssessmentIntentAtOf, ASSESSMENT_RESULT_KIND, type AssessmentResultRecord } from "./assessment.js";
import { NO_PRODUCER_EMISSIONS, prepareAnswersGate as prepareAnswersGateOf, prepareAnswersGateTrace as prepareAnswersGateTraceOf, readAnswersEvaluationAt as readAnswersEvaluationAtOf, readAnswersGate as readAnswersGateOf, readAnswersGateTrace as readAnswersGateTraceOf, readRouteProducers as readRouteProducersOf,
  writeAnswersCheckCessation as writeAnswersCheckCessationOf, writeAnswersEvaluation as writeAnswersEvaluationOf, writeAnswersRegistration as writeAnswersRegistrationOf, type AnswerRouteResult, type AnswersGateRequest, type RouteProducers,
  type UnservedQuestion } from "./answers-gate.js";
import { gateCandidate as gateCandidateOf, prepareCandidate as prepareCandidateOf, writeCandidate as writeCandidateOf, type CandidateRequest } from "./frame-candidate.js";
import { prepareSettleCandidate as prepareSettleCandidateOf, readWorkRejection as readWorkRejectionOf, readWorkRejectionAt as readWorkRejectionAtOf,
  type SettleCandidateRequest } from "./frame-accept.js";
import { readJournalAt as readJournalAtOf } from "./refusal-journal.js";
import { readAcceptedFrameLayer as readAcceptedFrameLayerOf, type FrameAttemptBinding } from "./layer-basis.js";
import type { AcceptedFrameRequest } from "./frame-accept.js";
import { prepareWorksAcceptance as prepareWorksAcceptanceOf, prepareWorksSources as prepareWorksSourcesOf, producerProposal as producerProposalOf,
  readAtomicGate as readAtomicGateOf, readWorksAcceptance as readWorksAcceptanceOf,
  type WorkProposalSource, type WorksAcceptanceRequest } from "./atomic-gate.js";
import { runWakeChoice as runWakeChoiceOf, wakeStanding as wakeStandingOf, type WakeChoiceRequest, type WriteOrderRequest } from "./wake-choice.js";
import { gapLineExpectedResult, gapLineKey, gapLinesId, writeGapLines as writeGapLinesOf, type GapLinesRecord } from "./gap-lines.js";
import { prepareOmObligations as prepareOmObligationsOf, writeOmObligations as writeOmObligationsOf } from "./obligations.js";
import { prepareFeasibility as prepareFeasibilityOf, readFeasibility as readFeasibilityOf, writeFeasibility as writeFeasibilityOf, type OmFeasibility } from "./feasibility.js";
import { writeHandoff as writeHandoffOf } from "./handoff.js";
import { stageId } from "../pipeline/contracts.js";
import { StageChecks } from "../product/stage-checks.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import { readGaps as readGapsOf, type GapReadRequest } from "./gaps.js";
import { readFrameProposals as readFrameProposalsOf } from "./frame-proposals.js";
import type { Graph } from "../graph/model.js";
import { RefinementRelations } from "../graph/relations.js";
import type { DispatchContract } from "./call-record.js";
import { RunControlGate, RunControlLost, type RunControlHold } from "./run-control.js";

/**
 * H1 — the pass of the OM block (№1427 as amended by №1452 and №1737).
 *
 * The pass links the units into one way M1 → M9 and owns only ITS choice: which action comes next, which request it
 * was, where the pass waits and why. Every product — an opened or closed attempt, a packet, a call, an assessment, a
 * check — is made by its common producer, and every outcome of an attempt goes through G7. The chosen action is saved
 * with its exact request BEFORE its producer runs (the identity survives a crash; two stores cannot choose two names for
 * one step), and a repeat finds the product again by that request: every producer used here returns the saved product
 * for an exact repeat. The pass never counts attempts and never derives a reason. Its bases — B1, the horizon of its
 * launch intent, D1, D5, M6 and the C1 queue — are built by the common machine producer of H1.1 (run-bases.ts) in a
 * saved step of the pass itself; nobody outside the pass chooses a horizon or an order (№1844, №1852).
 */
export const RUN_KIND = "om-run";
export const RUN_CONTRACT = "om-run/v1";
export const RUN_CODES = Object.freeze(["run_request_invalid", "run_record_invalid", "run_outcome_unknown", "run_intent_conflict",
  "horizon_empty"] as const);
export type RunCode = typeof RUN_CODES[number];
/**
 * Q2b (№2518): every refusal code the pass creates itself, from the actual places of issue; RUN_CODES above stays exported
 * as it is (it also names the pass's exception code). The exceptions have their own set.
 */
export const RUN_LOCAL_CODES = Object.freeze(["run_record_invalid", "run_outcome_unknown", "run_intent_conflict", "horizon_empty",
  "record_missing", "candidate_gaps", "answers_not_passed"] as const);
export type RunLocalCode = typeof RUN_LOCAL_CODES[number];
export const RUN_ERROR_CODES = Object.freeze(["run_request_invalid"] as const);
export type RunErrorCode = typeof RUN_ERROR_CODES[number];
/**
 * The units whose refusals the pass hands on: the producers of its steps and the readers of its choice, each through its
 * reader bound below; the compiler's stage check and the recovery of a model call (their exceptions, through
 * transferError); and the pass's lost control.
 */
export type RunSource = "refs" | "routes" | "queue" | "horizon" | "run-bases" | "input" | "accepted-answer" | "addressing" | "series"
  | "repeat-gate" | "stop-analysis" | "model-call" | "question-packet" | "assessment" | "answers-gate" | "frame-candidate"
  | "frame-accept" | "layer-basis" | "atomic-gate" | "gap-lines" | "obligations" | "feasibility" | "handoff" | "gaps"
  | "stage-checks" | "run-control" | "frame-proposals" | "wake-choice" | "refusal-journal";
export type RunResultCode = RunLocalCode | SourceCodes<RunSource>;
export type RunResult<T> = OmResult<T, RunResultCode>;

const prepareRoutes = transferring("routes", prepareRoutesOf);
const readRoutes = transferring("routes", readRoutesOf);
const writeRoutes = transferring("routes", writeRoutesOf);
const readQuestionQueue = transferring("queue", readQuestionQueueOf);
const readHorizon = transferring("horizon", readHorizonOf);
/** LP8.1: set only while an unable pass weighs its grounds again (selectNext is synchronous). */
let reweighing = false;
const prepareRunBases = transferring("run-bases", (store: Store, request: { project: string }, options: { completion?: boolean } = {}) =>
  prepareRunBasesOf(store, request, reweighing ? { ...options, reweigh: true } : options));
const readRunStandingGuards = transferring("run-bases", readRunStandingGuardsOf);
const writeRunBases = transferring("run-bases", writeRunBasesOf);
const readOmInput = transferring("input", readOmInputOf);
const readinessPending = transferring("input", readinessPendingOf);
const writeReadinessInput = transferring("input", writeReadinessInputOf);
const readAcceptedAnswer = transferring("accepted-answer", readAcceptedAnswerOf);
const writeApplyAnswer = transferring("addressing", writeApplyAnswerOf);
const writeOwnerDecision = transferring("addressing", writeOwnerDecisionOf);
const openSeries = transferring("series", openSeriesOf);
const readAnySeriesAt = transferring("series", readAnySeriesAtOf);
const readCompletionBinding = transferring("series", readCompletionBindingOf);
const prepareSeriesLineAdmission = transferring("series", prepareSeriesLineAdmissionOf);
const resumeSeries = transferring("series", resumeSeriesOf);
const reconcileSeries = transferring("series", reconcileSeriesOf);
const prepareReconcileSeries = transferring("series", prepareReconcileSeriesOf);
const closeAttempt = transferring("repeat-gate", closeAttemptOf);
const openAttempt = transferring("repeat-gate", openAttemptOf);
const prepareManagedClaim = transferring("repeat-gate", prepareManagedClaimOf);
const readCompletionCloseAt = transferring("repeat-gate", readCompletionCloseAtOf);
const readStopContext = transferring("repeat-gate", readStopContextOf);
const prepareStopAnalysis = transferring("stop-analysis", prepareStopAnalysisOf);
const readStopAnalysis = transferring("stop-analysis", readStopAnalysisOf);
const writeStopAnalysisRecovery = transferring("stop-analysis", writeStopAnalysisRecoveryOf);
const prepareCompletionCause = transferring("model-call", prepareCompletionCauseOf);
const ceasedCycleGround = transferring("model-call", ceasedCycleGroundOf);
const readCompletionWorkAt = transferring("model-call", readCompletionWorkAtOf);
const readManagedModelDiagnostic = transferring("model-call", readManagedModelDiagnosticOf);
const readModelCycle = transferring("model-call", readModelCycleOf);
const readPartAssembly = transferring("model-call", readPartAssemblyOf);
const writeCompletionCessation = transferring("model-call", writeCompletionCessationOf);
const readAreaReplacement = transferring("model-call", readAreaReplacementOf);
const prepareCompletionFinalization = transferring("model-call", prepareCompletionFinalizationOf);
const writeCompletionFinalization = transferring("model-call", writeCompletionFinalizationOf);
const prepareCompletionReuse = transferring("model-call", prepareCompletionReuseOf);
const writeCompletionReuse = transferring("model-call", writeCompletionReuseOf);
const readReuseResult = transferring("model-call", readReuseResultOf);
const readConfirmationGround = transferring("model-call", readConfirmationGroundOf);
const readCompletionAcceptance = transferring("model-call", readCompletionAcceptanceOf);
const writeQuestionPacket = transferring("question-packet", writeQuestionPacketOf);
const readQuestionPacket = transferring("question-packet", readQuestionPacketOf);
const readAssessmentIntentAt = transferring("assessment", readAssessmentIntentAtOf);
const prepareAnswersGate = transferring("answers-gate", prepareAnswersGateOf);
const prepareAnswersGateTrace = transferring("answers-gate", prepareAnswersGateTraceOf);
const readAnswersEvaluationAt = transferring("answers-gate", readAnswersEvaluationAtOf);
const readAnswersGate = transferring("answers-gate", readAnswersGateOf);
const readAnswersGateTrace = transferring("answers-gate", readAnswersGateTraceOf);
const readRouteProducers = transferring("answers-gate", readRouteProducersOf);
const writeAnswersCheckCessation = transferring("answers-gate", writeAnswersCheckCessationOf);
const writeAnswersEvaluation = transferring("answers-gate", writeAnswersEvaluationOf);
const writeAnswersRegistration = transferring("answers-gate", writeAnswersRegistrationOf);
const gateCandidate = transferring("frame-candidate", gateCandidateOf);
const prepareCandidate = transferring("frame-candidate", prepareCandidateOf);
const writeCandidate = transferring("frame-candidate", writeCandidateOf);
const prepareSettleCandidate = transferring("frame-accept", prepareSettleCandidateOf);
const readWorkRejection = transferring("frame-accept", readWorkRejectionOf);
const readWorkRejectionAt = transferring("frame-accept", readWorkRejectionAtOf);
const readJournalAt = transferring("refusal-journal", readJournalAtOf);
const readAtomicGate = transferring("atomic-gate", readAtomicGateOf);
const readWorksAcceptance = transferring("atomic-gate", readWorksAcceptanceOf);
const readAcceptedFrameLayer = transferring("layer-basis", readAcceptedFrameLayerOf);
const prepareWorksAcceptance = transferring("atomic-gate", prepareWorksAcceptanceOf);
const prepareWorksSources = transferring("atomic-gate", prepareWorksSourcesOf);
const producerProposal = transferring("atomic-gate", producerProposalOf);
const wakeStanding = transferring("wake-choice", wakeStandingOf);
const runWakeChoice = (...args: Parameters<typeof runWakeChoiceOf>) => runWakeChoiceOf(...args).then(value => transfer("wake-choice", value));
const writeGapLines = transferring("gap-lines", writeGapLinesOf);
const prepareOmObligations = transferring("obligations", prepareOmObligationsOf);
const writeOmObligations = transferring("obligations", writeOmObligationsOf);
const prepareFeasibility = transferring("feasibility", prepareFeasibilityOf);
const readFeasibility = transferring("feasibility", readFeasibilityOf);
const writeFeasibility = transferring("feasibility", writeFeasibilityOf);
const writeHandoff = transferring("handoff", writeHandoffOf);
const readGaps = transferring("gaps", readGapsOf);
const readFrameProposals = transferring("frame-proposals", readFrameProposalsOf);
const runStopAnalysis = async (...args: Parameters<typeof runStopAnalysisOf>) => transfer("stop-analysis", await runStopAnalysisOf(...args));
const runModelCycle = async (...args: Parameters<typeof runModelCycleOf>) => transfer("model-call", await runModelCycleOf(...args));
const assessFact = async (...args: Parameters<typeof assessFactOf>) => transfer("assessment", await assessFactOf(...args));
const readRecord = <T = Json>(store: Store, reference: unknown, request: RecordRequest) => transfer("refs", readRecordOf<T>(store, reference, request));
const writeGuarded = <T = Json>(store: Store, request: GuardedWrite) => transfer("refs", writeGuardedOf<T>(store, request));
const UNIT = "H1";
const refuse = localRefusals(RUN_LOCAL_CODES);
// Annotated explicitly: only a declared `never` (or `asserts`) makes a bare call end the control flow for tsc.
const raise: (code: RunErrorCode, message: string, details?: unknown) => never = localErrors(RUN_ERROR_CODES);
const check: (condition: unknown, code: RunErrorCode, message: string) => asserts condition = (condition, code, message) => {
  if (!condition) raise(code, message);
};
export const runId = (project: string): string => `${RUN_KIND}:${project}`;

export type { RunBases } from "./run-bases.js";
/** A pass is advanced by its project and the technical dispatch contract; its bases are the pass's own (H1.1). */
export interface RunRequest { readonly project: string; readonly dispatch: DispatchContract }
/** The launch intent of a pass (№1852): the exact outcomes it works toward, fixed when the pass is first written. */
export interface RunIntent { readonly outcomes: readonly string[] }

export const RUN_ACTIONS = Object.freeze(["open-series", "open", "register", "lines", "obligations", "packet", "cycle", "assess",
  "candidate", "routes", "evaluate", "accept", "works", "confirm", "cease", "cease-check", "close", "analyze", "resume", "feasibility",
  "handoff", "compile", "bases", "apply", "finalize", "reuse", "reconcile", "recover-analysis", "wake", "readiness"] as const);
export type RunAction = typeof RUN_ACTIONS[number];
/** A chosen action: the exact request of its producer and the attempt it serves, if any. */
export interface RunStep { readonly action: RunAction; readonly request: Json; readonly series: string | null; readonly attempt: number | null }
/** An addressed wait: what is missing, whose it is, and the exact records it stands on. */
export interface RunWait { readonly code: string; readonly message: string; readonly target: string; readonly field: string; readonly basis: readonly Ref[] }
/**
 * The kinds of ground a pass ends on without a result (№1908, №1995): what proved that no lawful continuation is left.
 * A kind names the ground; the code beside it is the one the source gave — or the state's own name where the source is a
 * state, not a refusal — and the two never stand for each other.
 */
export const RUN_REASON_KINDS = Object.freeze(["stop-second-rung", "stop-analysis-failed", "hold-analysis-failed", "hold-origin-unestablished",
  "analysis-unavailable", "owner-control", "frame-need-owner", "late-obligation", "unsupported-question"] as const);
export type RunReasonKind = typeof RUN_REASON_KINDS[number];
/** A ground of the terminal outcome: an addressed wait that will not resolve by itself, with the kind of the ground. */
export interface RunReason extends RunWait { readonly kind: RunReasonKind }
export type RunState =
  | { readonly phase: "ready" }
  | { readonly phase: "step"; readonly step: RunStep }
  | { readonly phase: "waiting"; readonly wait: RunWait }
  /** The proved end of the pass: its accepted M8, M9 stage and compilation stage (row 27). */
  | { readonly phase: "complete"; readonly proof: readonly Ref[] }
  /** The proved end of the pass without a result: no lawful step is left and these grounds stand (№1908 п.1). Not a wait. */
  | { readonly phase: "unable"; readonly reasons: readonly RunReason[] }
  /**
   * LP8.1 (№3670): an end without a result whose grounds the current rules no longer prove final — the exact unable
   * revision and its grounds, and the new ground found instead (the next step, a wait or the proved completion). The
   * pass goes on from here as from "ready".
   */
  | { readonly phase: "reopened"; readonly from: Ref; readonly reasons: readonly RunReason[]; readonly ground: RunReopenGround };
/** What the current rules found in place of the end: exactly one of a next step, an addressed wait or the completion proof. */
export type RunReopenGround = { readonly step: RunStep } | { readonly wait: RunWait } | { readonly complete: readonly Ref[] };
export interface RunRecord {
  readonly contract: typeof RUN_CONTRACT; readonly project: string;
  /** The exact B1 the pass began from; new B1 revisions never rewrite it (№1737 п.1). */
  readonly input: Ref;
  /** The launch intent, unchanged for the whole history of the pass (№1852 п.1). */
  readonly intent: RunIntent;
  readonly state: RunState;
  /**
   * The previous performed action, the exact products its producer returned, or the refusal it gave. A refused step
   * stays saved: choosing the same request again repeats it by that saved request without a new choice.
   */
  readonly last: { readonly step: RunStep; readonly products: readonly Ref[]; readonly refusal: RunWait | null } | null;
}
export interface RunAdvance { readonly record: Revision<RunRecord>; readonly performed: RunStep | null; readonly products: readonly Ref[] }

class RunFailure extends Error { constructor(readonly refusal: Refusal<RunResultCode>) { super(refusal.message); } }
function fail(code: RunLocalCode, target: string, field: string, message: string, ref?: Ref, route: "producer" | "owner" = "producer"): never {
  const result = refuse(code, message, { unit: UNIT, target, field, ...(ref ? { ref } : {}) }, route);
  if (!result.ok) throw new RunFailure(result.refusal);
  throw new Error("Unreachable");
}
function take<T>(result: OmResult<T, RunResultCode>): T { if (!result.ok) throw new RunFailure(result.refusal); return result.value; }
async function run<T>(action: () => T | Promise<T>): Promise<RunResult<Sealed<T>>> {
  try { return delivered(await action()); }
  catch (error) {
    if (error instanceof RunFailure) return { ok: false, refusal: error.refusal };
    // A lost control is the typed control outcome of this entry (H1.3), never a wait of the pass.
    if (error instanceof RunControlLost) return transfer("run-control", { ok: false as const, refusal: error.refusal });
    throw error;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const object = (value: unknown): value is Record<string, any> => isPlainObject(value);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const sameRef = (left: Ref, right: Ref): boolean => left.id === right.id && left.revision === right.revision && left.hash === right.hash;
const refOf = (record: { id: string; revision: number; hash: string }): Ref => ({ id: record.id, revision: record.revision, hash: record.hash });

function requireRequest(store: unknown, request: unknown): asserts request is RunRequest {
  check(store instanceof Store, "run_request_invalid", "A pass runs through a store");
  check(object(request) && isText(request.project)
    && object(request.dispatch) && isRef(request.dispatch.adapter) && isRef(request.dispatch.config) && Object.keys(request.dispatch).length === 2
    && Object.keys(request).length === 2,
  "run_request_invalid", "A pass names its project and its dispatch contract; its bases are its own");
}
/** An intent is a nonempty set of outcome identifiers, sorted by code units without repeats (№1852 п.1). */
function normalizedOutcomes(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || !value.every(isText)) return null;
  return [...new Set(value as string[])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

/** The saved pass, checked as a whole; a missing or malformed required field is an integrity refusal, never guessed. */
export function readRun(store: Store, request: { project: string }): RunResult<Sealed<Revision<RunRecord>> | null> {
  check(store instanceof Store && object(request) && isText(request.project) && Object.keys(request).length === 1,
    "run_request_invalid", "A pass is read by its project");
  const head = store.get(runId(request.project));
  if (!head) return delivered(null);
  const read = readRecord<RunRecord>(store, reference(head), { unit: UNIT, target: head.id, kind: RUN_KIND, id: runId(request.project) });
  if (!read.ok) return read;
  const value = read.value.value as unknown;
  if (!checkRecord(value, request.project)) return refuse("run_record_invalid", "The pass record lost a required field or holds a foreign one",
    { unit: UNIT, target: head.id, field: "record", ref: reference(head) }, "producer");
  return delivered(read.value as Revision<RunRecord>);
}
function checkRecord(value: unknown, project: string): value is RunRecord {
  if (!object(value) || value.contract !== RUN_CONTRACT || value.project !== project || !isRef(value.input)) return false;
  const keys = ["contract", "project", "input", "intent", "state", "last"];
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  const outcomes = object(value.intent) && Object.keys(value.intent).length === 1 ? normalizedOutcomes(value.intent.outcomes) : null;
  if (!outcomes || !same(outcomes, value.intent.outcomes)) return false;
  const state = value.state;
  if (!object(state)) return false;
  if (state.phase === "ready") { if (Object.keys(state).length !== 1) return false; }
  else if (state.phase === "step") { if (!checkStep(state.step)) return false; }
  else if (state.phase === "waiting") { if (!checkWait(state.wait) || Object.keys(state).length !== 2) return false; }
  else if (state.phase === "complete") { if (!Array.isArray(state.proof) || state.proof.length !== 3 || !state.proof.every(isRef) || Object.keys(state).length !== 2) return false; }
  else if (state.phase === "unable") { if (!checkReasons(state.reasons) || Object.keys(state).length !== 2) return false; }
  else if (state.phase === "reopened") {
    if (Object.keys(state).length !== 4 || !isRef(state.from) || !checkReasons(state.reasons) || !checkReopenGround(state.ground)) return false;
  }
  else return false;
  const last = value.last;
  return last === null || object(last) && Object.keys(last).length === 3 && checkStep(last.step) && Array.isArray(last.products)
    && last.products.every(isRef) && (last.refusal === null ? last.products.length > 0 : checkWait(last.refusal) && last.products.length === 0);
}
function checkReopenGround(ground: unknown): ground is RunReopenGround {
  if (!object(ground) || Object.keys(ground).length !== 1) return false;
  if (Object.hasOwn(ground, "step")) return checkStep(ground.step);
  if (Object.hasOwn(ground, "wait")) return checkWait(ground.wait);
  return Object.hasOwn(ground, "complete") && Array.isArray(ground.complete) && ground.complete.length === 3 && ground.complete.every(isRef);
}
function checkWait(wait: unknown): wait is RunWait {
  return object(wait) && Object.keys(wait).length === 5 && ["code", "message", "target", "field"].every(key => isText(wait[key]))
    && Array.isArray(wait.basis) && wait.basis.every(isRef);
}
/** A nonempty list in the canonical order without a repeat: one meaning, one row, whatever order the grounds were met in. */
function checkReasons(reasons: unknown): reasons is RunReason[] {
  if (!Array.isArray(reasons) || reasons.length === 0 || !reasons.every(checkReason)) return false;
  const keys = (reasons as RunReason[]).map(reasonKey);
  return keys.every((key, index) => index === 0 || keys[index - 1]! < key);
}
function checkReason(reason: unknown): reason is RunReason {
  return object(reason) && Object.keys(reason).length === 6 && (RUN_REASON_KINDS as readonly string[]).includes(reason.kind as string)
    && ["code", "message", "target", "field"].every(key => isText(reason[key])) && Array.isArray(reason.basis) && reason.basis.every(isRef)
    && same(reason.basis, uniqueRefs(reason.basis));
}
/** The meaning of a ground: its kind, its address, the code the source gave and the exact records it stands on. */
const reasonKey = (reason: RunReason): string => canonical([reason.kind, reason.target, reason.field, reason.code, reason.basis] as unknown as Json);
function reasonOf(kind: RunReasonKind, code: string, target: string, field: string, message: string, basis: readonly Ref[]): RunReason {
  return { kind, code, message, target, field, basis: uniqueRefs(basis) };
}
/** The grounds in their canonical order without a repeat; the order they were met in decides nothing. */
function canonicalReasons(reasons: readonly RunReason[]): RunReason[] {
  return [...new Map(reasons.map(item => [reasonKey(item), item])).entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, item]) => item);
}
function checkStep(step: unknown): step is RunStep {
  return object(step) && (RUN_ACTIONS as readonly string[]).includes(step.action as string) && object(step.request)
    && (step.series === null || isText(step.series)) && (step.attempt === null || Number.isSafeInteger(step.attempt) && (step.attempt as number) > 0)
    && Object.keys(step).length === 4;
}

/**
 * Begins the one pass of the project at `om-run:<project>` from its exact current B1, or returns the pass that already
 * exists: a repeated start reads the saved pass first and never derives a new address from today's B1 (№1737 п.1).
 * The first creation is `expected: 0`, so a race has one winner.
 */
/**
 * The one pass of a project and its launch intent (№1852 п.1–2). An existing pass is read first: no intent continues
 * it, an equal one (in any order, with repeats) is the same pass without a write, another one is run_intent_conflict —
 * also after complete. A first pass fixes the named outcomes, or every outcome of its exact B1, as a concrete set; an
 * outcome B1 does not accept is run_outcome_unknown, and nothing is written for such an intent.
 */
export function startRun(store: Store, request: { project: string; outcomes?: readonly string[] }, control?: RunControlHold): RunResult<Sealed<Revision<RunRecord>>> {
  check(store instanceof Store && object(request) && isText(request.project)
    && Object.keys(request).every(key => key === "project" || key === "outcomes")
    && (request.outcomes === undefined || normalizedOutcomes(request.outcomes) !== null),
  "run_request_invalid", "A pass is started by its project and, optionally, a nonempty set of intended outcomes");
  check(control === undefined || object(control), "run_request_invalid", "A control hold is an object");
  const project = request.project, named = request.outcomes === undefined ? null : normalizedOutcomes(request.outcomes)!;
  const existing = (): Revision<RunRecord> | null => {
    const saved = take(readRun(store, { project })) as Revision<RunRecord> | null;
    if (saved && named && !same(named, saved.value.intent.outcomes))
      fail("run_intent_conflict", saved.id, "intent.outcomes", "This pass works toward another intent; a pass never changes its intent", reference(saved));
    return saved;
  };
  try {
    // H1.3 (№1991 п.5): a stop is weighed first; a stopped project starts nothing and records no intent.
    const gate = new RunControlGate(store, project, control);
    gate.admit();
    const saved = existing();
    if (saved) return delivered(saved);
    const head = store.get(`om-input:${project}`);
    if (!head) fail("record_missing", runId(project), "input", "A pass begins from the exact first B1 of the project");
    const input = take(readOmInput(store, project, reference(head))) as Revision<OmInputRecord>;
    const accepted = normalizedOutcomes(input.value.input.features.map(feature => feature.outcome));
    if (!accepted) fail("horizon_empty", input.id, "features", "The accepted input names no outcome a pass could work toward", reference(input));
    const outcomes = named ?? accepted;
    const unknown = outcomes.find(outcome => !accepted.includes(outcome));
    if (unknown !== undefined) fail("run_outcome_unknown", input.id, "outcomes", `The accepted input has no feature with the outcome ${unknown}`, reference(input));
    const value: RunRecord = { contract: RUN_CONTRACT, project, input: reference(input), intent: { outcomes }, state: { phase: "ready" }, last: null };
    const written = writeGuarded<RunRecord>(gate.view(), { unit: UNIT, target: runId(project),
      writes: [{ id: runId(project), kind: RUN_KIND, expected: 0, value: value as unknown as Json }], guards: [reference(input)] });
    if (written.ok) return delivered(written.value[0]! as Revision<RunRecord>);
    // Two stores: the winner's pass is read again; an equal intent converges to it, another one conflicts.
    const raced = existing();
    return raced ? delivered(raced) : written;
  } catch (error) {
    if (error instanceof RunFailure) return { ok: false, refusal: error.refusal };
    if (error instanceof RunControlLost) return transfer("run-control", { ok: false as const, refusal: error.refusal });
    throw error;
  }
}

/**
 * One transition of the pass. A saved step is performed (or found again) by its producer; otherwise the next action is
 * chosen, saved, and left for the next call. A wait that still stands is returned without a write.
 *
 * H1.3: every entry weighs the pass's control first. A stopped pass begins no step and no dispatch; each new step and
 * each new record of its work carries the admitted control in its final transaction, and a physical step gets the same
 * hold for its claim and transfer while its paid results pass by their exact links. A holder never takes a newer head.
 */
export async function advanceRun(store: Store, request: RunRequest, control?: RunControlHold): Promise<RunResult<Sealed<RunAdvance>>> {
  requireRequest(store, request);
  check(control === undefined || object(control), "run_request_invalid", "A control hold is an object");
  return run(async () => {
    const saved = take(readRun(store, { project: request.project }));
    if (!saved) fail("record_missing", runId(request.project), "run", "The pass must be started before it advances");
    const head = saved as unknown as Revision<RunRecord>, state = head.value.state;
    // A completed pass returns its proved completion before any environment, base or payment is looked at; it never starts
    // a second pass by itself (№1737 п.1, №1995 п.11).
    if (state.phase === "complete") return { record: head, performed: null, products: [] };
    const gate = new RunControlGate(store, request.project, control), hold = gate.admit().hold, guarded = gate.view();
    // LP8.1 (№3670): an unable pass weighs its grounds again by the current rules at every entry (they may have been proved
    // final by rules since changed — a failed review LP8 now recovers). Still final: the saved end stands and nothing is
    // written. Otherwise one transition reopens it — the exact unable revision, its grounds and the new ground — and the
    // pass goes on from there by its ordinary choice.
    if (state.phase === "unable") {
      const again = reweigh(store, request, head);
      if ("unable" in again) return { record: head, performed: null, products: [] };
      const ground: RunReopenGround = "step" in again ? { step: again.step } : "complete" in again ? { complete: again.complete } : { wait: again.wait };
      return transition(guarded, head, { phase: "reopened", from: reference(head), reasons: state.reasons, ground }, head.value.last, null, []);
    }
    // LP3 (№2817-4, №2870): a saved cycle of a packet E2's reader proves to be a step of a cycle (a continuation or a later
    // part, chosen by the order of the products) and that was never cycled is not performed: the pass chooses again by an
    // ordinary new transition, and its history and the saved records stay as they are. A cycle of it that was performed is
    // found again by its own request; a packet whose place is not proved is performed as saved and keeps its refusal.
    // LP4 (№2887): so is a saved cycle never performed whose root's remaining work is proved ceased by a step of its own.
    if (state.phase === "step" && (misplacedCycle(store, state.step) || ceasedCycle(store, state.step)))
      return transition(guarded, head, { phase: "ready" }, head.value.last, null, []);
    if (state.phase === "step") return settle(guarded, head, state.step, await perform(guarded, store, hold, request, state.step));
    const history = historyOf(store, head), performed = history.performed;
    let next = selectNext(store, request, history);
    if ("complete" in next) return transition(guarded, head, { phase: "complete", proof: next.complete }, head.value.last, null, []);
    if ("unable" in next) return transition(guarded, head, { phase: "unable", reasons: next.unable }, head.value.last, null, [], next.guards);
    // A choice identical to a request already performed with a product would repeat it without effect: the pass stands
    // on that product and waits for its producer or a changed basis instead of looping on it. OWN1.2 (№3806): D7 is
    // chosen only when its own preparation would write (worksLedger), so its product is not found again even when the same
    // request was performed — a ledger derived by an older rule (a default it no longer carries) is that changed basis.
    const done = "step" in next && next.step.action !== "obligations" ? performed(next.step.action, next.step.request) : null;
    if (done && "step" in next) next = wait("step_without_effect", next.step.series ?? runId(request.project), next.step.action,
      "This exact request was performed and its product is found again; its producer or a changed basis decides the next action", done);
    if ("step" in next) {
      const last = head.value.last;
      // The same request that was refused is already saved: it is repeated by that request, and a refusal that still
      // stands is returned without a write.
      if (last?.refusal && same(last.step, next.step)) {
        const outcome = await perform(guarded, store, hold, request, next.step);
        if ("wait" in outcome && state.phase === "waiting" && same(state.wait, outcome.wait)) return { record: head, performed: null, products: [] };
        return settle(guarded, head, next.step, outcome);
      }
      return transition(guarded, head, { phase: "step", step: next.step }, head.value.last, null, []);
    }
    if (state.phase === "waiting" && same(state.wait, next.wait))
      return { record: head, performed: null, products: [] };
    return transition(guarded, head, { phase: "waiting", wait: next.wait }, head.value.last, null, []);
  });
}
/** LP8.1 (№3670): the choice an unable pass would make today — reads only, its bases read as a live pass reads them. */
function reweigh(store: Store, request: RunRequest, head: Revision<RunRecord>): Next {
  reweighing = true;
  try { return selectNext(store, request, historyOf(store, head)); } finally { reweighing = false; }
}
/**
 * LP8.1 (№3670): whether the next transition of this unable pass reopens it — the same weighing, without a write, so a
 * start or continue of a pass whose grounds still stand takes no execution and writes nothing. A refusal met on the way
 * is the refusal of that transition; here it leaves the pass as it stands.
 */
export function unableReopens(store: Store, request: RunRequest): boolean {
  requireRequest(store, request);
  try {
    const saved = take(readRun(store, { project: request.project })) as Revision<RunRecord> | null;
    return saved !== null && saved.value.state.phase === "unable" && !("unable" in reweigh(store, request, saved));
  } catch (error) { if (error instanceof RunFailure) return false; throw error; }
}
function settle(store: Store, head: Revision<RunRecord>, step: RunStep, outcome: Performed): RunAdvance {
  if ("wait" in outcome) return transition(store, head, { phase: "waiting", wait: outcome.wait }, { step, products: [], refusal: outcome.wait }, step, []);
  return transition(store, head, { phase: "ready" }, { step, products: outcome.products, refusal: null }, step, outcome.products);
}
function transition(store: Store, head: Revision<RunRecord>, state: RunState, last: RunRecord["last"], performed: RunStep | null,
  products: readonly Ref[], guards: readonly TransactionGuard[] = []): RunAdvance {
  const value: RunRecord = { ...head.value, state, last };
  const written = take(writeGuarded<RunRecord>(store, { unit: UNIT, target: head.id,
    writes: [{ id: head.id, kind: RUN_KIND, expected: head.revision, value: value as unknown as Json }], guards }));
  return { record: written[0]! as Revision<RunRecord>, performed, products };
}

// ---- Performing a saved step: the producer finds or makes its product by the saved request. ----

type Performed = { products: Ref[] } | { wait: RunWait };
/**
 * `store` carries the admitted control into every write of the producer; a physical producer gets the plain `raw`
 * store and the hold instead, since its receipt and the application of its paid result are not today's new work.
 */
async function perform(store: Store, raw: Store, hold: RunControlHold, request: RunRequest, step: RunStep): Promise<Performed> {
  const project = request.project, body = step.request as Record<string, unknown>;
  const outcome = await (async (): Promise<RunResult<Ref[]>> => {
    switch (step.action) {
      case "open-series": return mapped(openSeries(store, body as never), record => [refOf(record)]);
      case "open": return mapped(openAttempt(store, body as never), record => [refOf(record)]);
      case "register": return mapped(writeAnswersRegistration(store, body as never), record => [refOf(record)]);
      case "packet": return mapped(writeQuestionPacket(store, body as never), prepared => [refOf(prepared.record)]);
      case "cycle": return mapped(await recovering(raw, project, () => runModelCycle(raw, body as never, undefined, hold)), cycle => [refOf(cycle.record)]);
      case "assess": return mapped(await recovering(raw, project, () => assessFact(raw, body as never, undefined, hold)), terminal => [refOf(terminal)]);
      case "routes": return mapped(writeRoutes(store, body as never), record => [refOf(record)]);
      case "lines": case "confirm": return mapped(writeGapLines(store, body as never), record => [refOf(record)]);
      case "obligations": return mapped(writeOmObligations(store, body as never), written => [refOf(written.producer), refOf(written.record)]);
      case "candidate": {
        const written = writeCandidate(store, body as never);
        if (!written.ok) return written;
        return written.value.state === "candidate" ? { ok: true, value: [refOf(written.value.record)] }
          : refuse("candidate_gaps", "The assembled proposals leave open obligations; the candidate is not formed", { unit: UNIT, target: project, field: "candidate" }, "producer");
      }
      case "accept": return acceptFrame(store, project, body as unknown as AcceptRequest);
      case "works": return acceptWorks(store, body as unknown as WorksRequest);
      case "feasibility": return mapped(writeFeasibility(store, body as never), record => [refOf(record)]);
      case "handoff": return mapped(writeHandoff(store, body as never), record => [refOf(record)]);
      case "compile": {
        try { new StageChecks(store).compile(project); }
        catch (error) {
          if (!(error instanceof EngineError)) throw error;
          return transferError("stage-checks", error, { unit: UNIT, target: stageId(project, "compilation"), field: "compile" }, "producer");
        }
        const stage = store.get(stageId(project, "compilation"));
        return stage ? { ok: true, value: [reference(stage)] } : refuse("record_missing", "The compiler accepted no compilation stage",
          { unit: UNIT, target: stageId(project, "compilation"), field: "compile" }, "producer");
      }
      case "evaluate": return mapped(writeAnswersEvaluation(store, body as never), written => [refOf(written.evaluation)]);
      case "analyze": return mapped(await recovering(raw, project, () => runStopAnalysis(raw, body as never, undefined, hold)), record => [refOf(record)]);
      case "wake": return mapped(await recovering(raw, project, () => runWakeChoice(raw, (body as { wake: WakeChoiceRequest }).wake,
        (body as { ordinal: number }).ordinal, undefined, hold)),
        choice => [refOf(choice)]);
      // LP8 (№3622): the one acceptance of a saved reviewer answer the old adapter wrapper refused — no model is called.
      case "recover-analysis": return mapped(writeStopAnalysisRecovery(store, body as never), record => [refOf(record)]);
      case "cease": return mapped(writeCompletionCessation(store, body as never), record => [refOf(record)]);
      case "cease-check": return mapped(writeAnswersCheckCessation(store, body as never), record => [refOf(record)]);
      case "finalize": return mapped(writeCompletionFinalization(store, body as never), record => [refOf(record)]);
      case "reuse": return mapped(writeCompletionReuse(store, body as never), record => [refOf(record)]);
      case "resume": return mapped(resumeSeries(store, body as never), record => [refOf(record)]);
      // LP6: the series revision and the exact transition record of the reconciled stop.
      case "reconcile": return mapped(reconcileSeries(store, body as never), record => [refOf(record),
        ...("block" in record.value ? (record.value.reconciliations ?? []).filter(item => item.after === body['stop']).map(item => refOf(item.transition)) : [])]);
      case "bases": {
        const build = body as unknown as BasesStep;
        return mapped(writeRunBases(store, { project }, { guards: build.guards, open: build.open, completion: build.completion }),
          built => [built.input, built.bases.horizon, built.bases.routes, built.bases.queue]);
      }
      // OWN1 (№3719 P2-1): an owner's proved answer of a question the bypass routes to the model is applied as its decision.
      case "apply": return mapped(Object.hasOwn(body as object, "owners") ? writeOwnerDecision(store, body as never)
        : writeApplyAnswer(store, body as never), record => [refOf(record)]);
      // AT1 door (№4105 п.5): the readiness questions of a saved G5 rejection become questions of B1.
      case "readiness": return mapped(writeReadinessInput(store, body as never), record => [refOf(record)]);
      case "close": {
        const closed = closeAttempt(store, body as never);
        if (!closed.ok) return closed;
        const head = store.get(seriesAddress(body as never).id);
        return { ok: true, value: head ? [reference(head)] : [] };
      }
    }
  })();
  if (outcome.ok) return { products: [...outcome.value] };
  return { wait: waitOf(outcome.refusal, project) };
}
/**
 * A physical step whose claim has no saved receipt: the common recovery proves the loss of its owner and provider
 * (a live or unobservable executor keeps holding the dispatch — its typed refusal is the wait), and the producer then
 * goes on with the same saved request, reading the recovered call instead of sending again.
 */
async function recovering<T, Code extends string>(store: Store, project: string, produce: () => Promise<OmResult<T, Code>>):
  Promise<OmResult<T, Code | SourceCode<"model-call">>> {
  const first = await produce();
  if (first.ok || first.refusal.code !== "model_call_in_progress") return first;
  const head = store.get(first.refusal.at.target);
  if (!head) return first;
  try { recoverOmModelCall(store, project, reference(head)); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return transferError("model-call", error, { unit: UNIT, target: head.id, field: "recovery", ref: reference(head) }, "producer");
  }
  return produce();
}
function mapped<T, U, Code extends string>(result: OmResult<T, Code>, map: (value: T) => U): OmResult<U, Code> {
  return result.ok ? { ok: true, value: map(result.value) } : result;
}
function waitOf(refusal: Refusal, project: string): RunWait {
  return { code: refusal.code, message: refusal.message, target: refusal.at.target || project, field: refusal.at.field || "producer",
    basis: refusal.at.ref ? [refusal.at.ref] : [] };
}
/**
 * What a wait means to the end of the pass (№1995 п.8): `defer` — something may still change or finish (a physical call, a
 * standalone attempt, bases, an environment that is not ready); `dependent` — it waits for a partner group and cannot
 * end before that group does; `neutral` — it proves nothing and forbids nothing. A refusal of a producer always defers.
 */
type WaitRole = "defer" | "dependent" | "neutral";
type Held = { wait: RunWait; role?: WaitRole };
function wait(code: string, target: string, field: string, message: string, basis: readonly Ref[] = [], role: WaitRole = "defer"): Held {
  return { wait: { code, message, target, field, basis: [...basis] }, role };
}

// ---- Choosing the next action. Reads only; the choice is written before any producer runs. ----

type Next = { step: RunStep } | Held | { complete: Ref[] } | { unable: RunReason[]; guards: TransactionGuard[] };
/** The products this pass already received for an exact saved request, found in its own history; null if never performed. */
type Performed_ = (action: RunAction, request: unknown) => Ref[] | null;
/**
 * The pass's own history: the products it received for an exact saved request, and the exact request it saved for a
 * step of the same identity (a cycle of one packet, an assessment of one fact), so an interrupted physical step goes on
 * with that request — never a new cycle, intent or name (№1427 строки 4, 9; №1737 O9).
 */
interface RunHistory { performed: Performed_; saved(action: RunAction, match: (request: Record<string, unknown>) => boolean): Json | null }
function historyOf(store: Store, head: Revision<RunRecord>): RunHistory {
  let rows: Revision<RunRecord>[] | null = null;
  const all = () => [...(rows ??= store.history(head.id) as Revision<RunRecord>[])].reverse();
  return {
    performed: (action, request) => {
      const wanted = sealed(request);
      for (const row of all()) {
        const last = row.value.last;
        if (last && last.refusal === null && last.step.action === action && same(last.step.request, wanted)) return [...last.products];
      }
      return null;
    },
    saved: (action, match) => {
      for (const row of all()) for (const step of [row.value.state.phase === "step" ? row.value.state.step : null, row.value.last?.step ?? null])
        if (step && step.action === action && match(step.request as Record<string, unknown>)) return step.request;
      return null;
    },
  };
}
const M5_OWNER: SeriesOwner = Object.freeze({ kind: "mechanism", mechanism: "M5:addressing" }) as SeriesOwner;
type Choice = { step: RunStep } | Held;
const step = (action: RunAction, request: unknown, series: string | null = null, attempt: number | null = null): { step: RunStep } =>
  ({ step: { action, request: sealed(request) as unknown as Json, series, attempt } });

interface Bases { routes: Revision<RoutesRecord>; order: readonly string[]; input: Ref; refs: RunBases }
/**
 * The saved build of the pass's bases: the exact roots its need was read on (for its identity), the attempt heads it
 * was decided on (its guards) and the attempts it lets stay open — none for new work, the frame group after C5.
 */
interface BasesStep { project: string; basis: Ref[]; guards: Ref[]; open: string[]; completion: boolean }
/**
 * What one choice of the next action learned: the heads it stands on and the grounds it proved final. A pass ends
 * without a result only from these (№1995 п.3, п.8); a wait is never classified into an end by its code.
 */
interface Trail { readonly guards: Map<string, TransactionGuard>; readonly finals: RunReason[] }
const newTrail = (): Trail => ({ guards: new Map(), finals: [] });
function stand(trail: Trail, heads: readonly (TransactionGuard | Ref | null)[]): void {
  for (const head of heads) if (head) trail.guards.set(canonical(head as unknown as Json), head as TransactionGuard);
}
/** The ground of the end, if no lawful step is left and nothing may still change or finish: proved grounds, and no deferring wait. */
function endOf(trail: Trail, waits: readonly Held[]): Next | null {
  if (!trail.finals.length || waits.some(item => (item.role ?? "defer") === "defer")) return null;
  return { unable: canonicalReasons(trail.finals), guards: [...trail.guards.values()] };
}
/**
 * The next action. An owner that waits keeps its own addressed wait and never stops an independent owner whose own
 * admission holds (row 3, К1): the pass goes on in M3 order and, if nothing is admissible, stands on the first wait — or,
 * when no step is left, nothing may still change and a ground is proved that no automatic continuation lifts, ends
 * without a result (№1908, №1995).
 */
function selectNext(store: Store, request: RunRequest, history: RunHistory): Next {
  const project = request.project, waits: Held[] = [], open: Ref[] = [], trail = newTrail();
  // What an end without a result stands on is taken BEFORE the reading it protects: a head that moves after this point
  // makes the write fail instead of letting a stale end pass (урок 42).
  stand(trail, [...take(readRunStandingGuards(store, project)) as TransactionGuard[], ...rootGuards(store, project)]);
  // 1. An open attempt of any series — on any line, a superseded one included (№1737 п.10, C57) — is continued first,
  // on its own saved plan and before any new B1 is looked at (№1737 п.2, п.8): its results stay results of the B1 it
  // began from. A second attempt of that series never runs beside it.
  for (const series of projectSeries(store, project, true)) {
    const running = [...series.value.attempts].find(attempt => attempt.outcome === null);
    if (!running) continue;
    open.push(reference(series));
    const next = continueAttempt(store, request, series, running.ordinal, history, trail);
    if ("step" in next) return next;
    waits.push(next);
  }
  const bases = machineBases(store, request, open);
  if ("step" in bases) return bases;
  if ("wait" in bases) {
    // The wait for the open attempts to end stands — unless the attempts open are themselves proved final: bases would
    // then wait for a group that cannot end, and that group's ground is the reason, not the builder's refusal (№1995 п.8).
    const end = bases.role === "dependent" ? endOf(trail, waits) : null;
    return end ?? waits[0] ?? bases;
  }
  stand(trail, [bases.input, bases.refs.horizon, bases.refs.queue, bases.refs.routes]);
  // №1860 п.5 (C38): an accepted answer M6 already routes as answered is applied to B1 when no attempt works on the
  // B1 it would replace; the new B1 then gets its own bases in the next step.
  // G6 (В2, №3869): a group whose works acceptance waits only for the answers of its own blocking questions gets them
  // applied while its attempts are the only ones open; LP5 ends its remainder on the replaced B1, and new work opens only
  // once the whole group has ended — the answers still held are applied first.
  const transition = waits.find(held => held.wait.code === "group_transition");
  if (!open.length || transition && open.every(ref => transition.wait.basis.some(basis => basis.id === ref.id))) {
    const applied = applyStep(store, project, bases);
    if (applied) return applied;
  }
  // 2. New work: the project mechanism M5:addressing first (№1737 п.2), then blocks strictly in M3 order.
  const m5 = bases.routes.value.batches.filter(isM5Batch).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const owners: [Owner, RouteBatch[]][] = m5.length ? [[{ owner: M5_OWNER }, [m5[0]!]]] : [];
  // A batch whose questions no answer producer serves is not paid for (H1.5, №2166): it is no part of any new plan, its
  // questions stay open at their exact address, and when nothing else is left the common G4b below names them. The one
  // reading of the route that says so is taken once per choice and only when a block has a batch to weigh.
  let unserved: ReadonlySet<string> | null = null, owned: ReadonlySet<string> | null = null;
  // OWN1 (№3719 P2-1): a batch whose every question the owner has answered by H2 is never sent to the model; the
  // answer is applied as the decision as soon as no attempt works on the current B1 (applyStep).
  const served = (batch: RouteBatch): boolean => !(unserved ??= new Set(take(readRouteProducers(store, { project, routes: bases.refs.routes }))
    .batches.filter(row => row.unserved.length).map(row => row.batch))).has(batch.id)
    && !batch.items.every(item => (owned ??= ownerAnswersBypassed(store, project, bases).answered).has(item.target));
  for (const block of bases.order) {
    const batches = bases.routes.value.batches.filter(batch => !isM5Batch(batch) && batch.items.every(item => item.consumers.includes(block))
      && !(batch.task === "node-expansion" && batch.level === 2 && batch.node !== block)).filter(served)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (batches.length) owners.push([{ block }, batches]);
  }
  for (const [owner, batches] of owners) {
    const next = newWork(store, request, bases, owner, batches, history, trail);
    if (next && "step" in next) return next;
    if (next) waits.push(next);
  }
  idleBarriers(store, request, bases, owners.map(([owner]) => owner), history, trail);
  // Before run_idle or any subject wait: no attempt is left to have asked, so the common G4b names what nobody can answer.
  if (!waits.some(item => (item.role ?? "defer") === "defer") && !store.get(`om-frame:${project}:3`))
    trail.finals.push(...unansweredQuestions(store, project, bases));
  const end = endOf(trail, waits);
  if (end) return end;
  if (waits.length) return trail.finals.length ? waits.find(item => (item.role ?? "defer") === "defer") ?? waits[0]! : waits[0]!;
  const done = completion(store, request);
  if (done) return done;
  return wait("run_idle", runId(project), "bases", "No admissible new work remains on these exact bases; the pass waits for their next lawful revision",
    [bases.input, bases.refs.horizon, bases.refs.queue, bases.refs.routes], "neutral");
}
const isM5Batch = (batch: RouteBatch): boolean => batch.model === "MC2" && batch.task === "input-field"
  && batch.items.length > 0 && batch.items.every(item => item.field === "address" && item.consumers.length === 0);

/**
 * The bases of new work are the machine bases of today's B1 (H1.1): the issue of the launch intent, the M3 queue over
 * it and the M6 routes over the same input and horizon, each current. After a new B1 (from D3 of M5 or an applied fact)
 * or a new accepted layer the pass builds them in its own saved step — only when no open attempt still works on the
 * old heads (№1860 п.5); it never carries an earlier issue over to a new input (№1737 п.8).
 */
function machineBases(store: Store, request: RunRequest, open: readonly Ref[]): Bases | Choice {
  const project = request.project, checked = prepareRunBases(store, { project });
  if (!checked.ok) return { wait: waitOf(checked.refusal, project) };
  if (checked.value.state === "missing") {
    // №1860 п.5: new heads of B1, D1, M6 or C1 would take the current area from attempts still working on it. The
    // common B3 of the same issue — a missing participant registered while the first one waits for the common frame —
    // is admitted meanwhile: B3 itself refuses a new local subject beside a running attempt (№1937-1).
    if (open.length && (RUN_BASES_HEAD_STAGES as readonly string[]).includes(checked.value.stage))
      return wait("bases_after_work", open[0]!.id, "attempts",
        `The next bases (${checked.value.stage}) wait until the open attempts finish on their current bases`, [...open], "dependent");
    return basesStep(store, project, [], false);
  }
  const built = checked.value.built;
  const routes = readRoutes(store, { project, record: built.bases.routes });
  if (!routes.ok) return { wait: waitOf(routes.refusal, project) };
  const queue = readQuestionQueue(store, { project, queue: built.bases.queue, routes: built.bases.routes });
  if (!queue.ok) return { wait: waitOf(queue.refusal, project) };
  return { routes: routes.value.record as unknown as Revision<RoutesRecord>, order: queue.value.order.map(row => row.block),
    input: built.input, refs: built.bases as RunBases };
}
/**
 * The saved build of the bases. Its identity is every root the machine derivation reads — B1, the stages and
 * inventory, the graph, the accepted frames and the research L2 — so a changed world is a new step, never a repeat
 * without effect; the heads of the attempts it was decided on guard its writes (№1860 п.5).
 */
const rootIds = (project: string): string[] => [`om-input:${project}`, `graph:${project}`, `om-frame:${project}:2`, `om-frame:${project}:3`,
  `phase:${project}:L2`, `repo-inventory:${project}`, ...["discovery", "concept", "operation-map", "specification", "features"].map(stage => `stage:${project}:${stage}`)];
/** The roots the machine bases derive from, each at its head or — where the choice depends on its absence — as absent. */
function rootGuards(store: Store, project: string): TransactionGuard[] {
  return rootIds(project).map(id => { const head = store.get(id); return head ? reference(head) : { id, absent: true as const }; });
}
function basesStep(store: Store, project: string, open: string[], completion: boolean, series: string | null = null, attempt: number | null = null): { step: RunStep } {
  const basis = rootIds(project).flatMap(id => { const head = store.get(id); return head ? [reference(head)] : []; });
  const guards = projectSeries(store, project, true).map(row => reference(row));
  const build: BasesStep = { project, basis, guards, open: [...open].sort(), completion };
  return step("bases", build, series, attempt);
}
/** The first answered fact of the current M6 whose question B1 still holds open: its accepted answer and MC1 question. */
function applyStep(store: Store, project: string, bases: Bases): Choice | null {
  const input = store.get<OmInputRecord>(`om-input:${project}`)!;
  const held = new Set(input.value.input.questions.map(question => question.id));
  const answered = bases.routes.value.routes.filter(route => route.state === "answered" && route.answer && route.field === "answer" && held.has(route.target))
    .sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
  for (const route of answered) {
    const answer = readAcceptedAnswer(store, { project, record: route.answer! });
    if (!answer.ok) return { wait: waitOf(answer.refusal, project) };
    return step("apply", { project, input: reference(input), answer: route.answer, question: reference(answer.value.question) });
  }
  // OWN1 (№3719 P2-1, OWN1.1 №3722): the owner's answer is above the model's — every question the bypass routes to the
  // model that the owner has answered by H2 is decided by that answer, all of them in one B1 transition, before any new
  // work could send one to the model; an answer given on earlier bases still holds while its very question is open.
  const owners = ownerAnswersBypassed(store, project, bases).applicable;
  if (owners.length) return step("apply", { project, input: reference(input), graph: bases.routes.value.request.gaps.sources.graph,
    owners: owners.map(owner => ({ target: owner.target, owner: owner.result, value: owner.value })) });
  return null;
}
const OWNER_READERS = { routes: readRoutesOf, input: readOmInputOf };
/** The owner's proved H2 answers of the open questions the current M6 routes to the model in the bypass (design, owner-decision). */
function ownerAnswersBypassed(store: Store, project: string, bases: Bases): { applicable: OwnerAnswer[]; answered: Set<string> } {
  const bypassed = new Set(bases.routes.value.routes.filter(route => route.route === "design" && route.kind === "owner-decision"
    && route.field === "answer").map(route => route.target));
  const input = store.get<OmInputRecord>(`om-input:${project}`)!.value.input;
  const found = ownerAnswersHeld(store, project, input.questions as never, OWNER_READERS);
  return { applicable: found.applicable.filter(owner => bypassed.has(owner.target)),
    answered: new Set([...found.answered].filter(target => bypassed.has(target))) };
}

/** Every current line of the project (or every line), blocks and the mechanism; each series is read through its common reader. */
function projectSeries(store: Store, project: string, all = false): Sealed<Revision<AnyRepairSeries>>[] {
  const heads = store.list<AnyRepairSeries>("repair-series").filter(row => row.id.startsWith(`repair-series:${project}:`))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const current = all ? heads : heads.filter(row => !heads.some(other => other.id !== row.id && isSuccessorOf(other, row)));
  return current.map(row => take(readAnySeriesAt(store, project, reference(row))));
}
function isSuccessorOf(candidate: Revision<AnyRepairSeries>, of: Revision<AnyRepairSeries>): boolean {
  return candidate.value.predecessor !== null && candidate.value.predecessor.id === of.id;
}

interface Owner { readonly block?: string; readonly owner?: SeriesOwner }
function ownerRequest(project: string, owner: Owner, line: number): Record<string, unknown> {
  return owner.owner ? { project, owner: owner.owner, line } : { project, block: owner.block!, line };
}
/**
 * The goal of new work is named before it starts, from the whole selected M6 batches (completionPlanSources): the
 * canonical question set and the one expected result. Its key is a stable function of the typed owner, the result and
 * those questions — no revision, call, ordinal or time — so repeating a goal is recognized by same(goal) (№1737 п.11).
 */
function goalOf(project: string, owner: Owner, batches: readonly RouteBatch[]): AttemptGoal {
  const questions = [...new Set(batches.flatMap(batch => batch.items.map(item => gapLineKey(project, item.target, item.field))))].sort();
  const result = gapLineExpectedResult(project, batches[0]!.items[0]!.target, batches[0]!.items[0]!.field);
  const typed = owner.owner ?? { kind: "block", block: owner.block! };
  return { key: `om-goal:${hashJson({ owner: typed, result, questions } as unknown as Json)}`, questions, result };
}

function newWork(store: Store, request: RunRequest, bases: Bases, owner: Owner, batches: readonly RouteBatch[], history: RunHistory,
  trail: Trail): Choice | null {
  const project = request.project;
  const address = seriesAddress(ownerRequest(project, owner, 1) as never);
  const first = store.get<AnyRepairSeries>(address.id);
  const scope = bases.routes.value.request.gaps as unknown as GapReadRequest;
  if (!first) return step("open-series", owner.owner
    ? { ...ownerRequest(project, owner, 1), scope, predecessor: null, basis: null }
    : { ...ownerRequest(project, owner, 1), slice: `om-run:${hashJson(owner.block!)}`, predecessor: null, basis: null }, address.id);
  // New work goes to the proven current line (row 22); its stop, holds and open attempt stand on that line.
  const series = projectSeries(store, project).find(row => sameOwner(row.value, owner));
  if (!series) fail("record_missing", address.id, "line", "A registered series keeps one current line");
  if (series.value.attempts.some(attempt => attempt.outcome === null)) return null;
  const barrier = ladder(store, request, series, history, trail);
  if (barrier && ("step" in barrier || "wait" in barrier)) return barrier;
  // What the owner still owes — a closed attempt that ended waiting for it — is proved by the close of that very attempt
  // and matched to the questions of today's batches by their stable addresses, never by the key of a goal (№1995 п.5).
  const keys = new Set(batches.flatMap(batch => batch.items.map(item => gapLineKey(project, item.target, item.field))));
  const owed = owedBy(store, project, series, keys);
  if (barrier) { trail.finals.push(...barrier.final, ...owed.flatMap(row => row.reasons)); return null; }
  // The current line admission of B3 (rows 1, 22, 24): an unactivated root, an excluded or a superseded line starts no work.
  if (owner.block) {
    const admission = prepareSeriesLineAdmission(store, project, reference(series));
    if (!admission.ok) return { wait: waitOf(admission.refusal, project) };
  }
  // A batch that holds a question still owed is not paid again whatever the batches around it are; a batch that does not
  // is independent work and goes on. The content of a batch is never divided (№1995 п.5).
  const held = new Set(owed.flatMap(row => row.questions.filter(question => keys.has(question))));
  const free = batches.filter(batch => !batch.items.some(item => held.has(gapLineKey(project, item.target, item.field))));
  if (!free.length) { trail.finals.push(...owed.flatMap(row => row.reasons)); return null; }
  const goal = goalOf(project, owner, free);
  const attempts = [...series.value.inherited, ...series.value.attempts];
  const last = attempts.at(-1);
  // A goal already achieved is done: on these exact routes nothing remains, and a new routes Ref alone never pays for
  // the same goal again (№1860 п.5, C52) — its results are delivered first; a gap it still does not close waits,
  // addressed to that result, instead of a new ordinal.
  if (last && same(last.goal, goal) && last.outcome?.reason === "result") return samePlan(store, project, series, last.ordinal, bases) ? null
    : wait("goal_achieved", series.id, "goal", "This goal was achieved on earlier routes; its gaps remain open on the current ones without a proved new subject",
      [reference(series), bases.refs.routes], "neutral");
  const ordinal = (attempts.at(-1)?.ordinal ?? 0) + 1;
  const plan = { routes: bases.refs.routes, batches: free.map(batch => batch.id).sort() };
  return step("open", { ...ownerRequest(project, owner, series.value.line), attempt: ordinal, goal,
    ...(owner.owner ? { admission: { gaps: scope, routes: bases.refs.routes, batch: free[0]!.id } } : {}), completion: plan },
  series.id, ordinal);
}

const sameOwner = (series: AnyRepairSeries, owner: Owner): boolean =>
  owner.block !== undefined ? "block" in series && series.block === owner.block : "owner" in series && same(series.owner, owner.owner);
/** Whether the attempt of this line was worked on exactly these routes; a standalone attempt names none. */
function samePlan(store: Store, project: string, series: Revision<AnyRepairSeries>, ordinal: number, bases: Bases): boolean {
  if (!series.value.attempts.some(attempt => attempt.ordinal === ordinal)) return true;
  const binding = take(readCompletionBinding(store, project, reference(series), ordinal));
  return binding === null || sameRef(binding.value.plan.routes, reference(bases.routes));
}
/** The series that made an attempt itself: this one, or the predecessor that carried it before the line moved on (№1995 п.5). */
function originOf(store: Store, project: string, series: Sealed<Revision<AnyRepairSeries>>, ordinal: number): Ref {
  let at = series as Revision<AnyRepairSeries>;
  while (!at.value.attempts.some(row => row.ordinal === ordinal)) {
    if (at.value.predecessor === null) return reference(series);
    at = take(readAnySeriesAt(store, project, at.value.predecessor)) as Revision<AnyRepairSeries>;
  }
  return reference(at);
}
/** A closed attempt that ended waiting for the owner: the questions it was asked, and the grounds its own close proves. */
interface Owed { readonly questions: readonly string[]; readonly reasons: RunReason[] }
/**
 * Every closed attempt of the line that ended waiting for the owner and asked a question still open today (`keys`): a
 * managed close keeps its waiting sources at any reason of the attempt, a standalone one is read by its reason. The
 * attempt keeps its true origin — an inherited one is read at the series that made it — and its number is part of the
 * address (№1995 п.5). The message is the saved diagnostic of E4, never a text made up here.
 */
function owedBy(store: Store, project: string, series: Sealed<Revision<AnyRepairSeries>>, keys: ReadonlySet<string>): Owed[] {
  const owed: Owed[] = [];
  for (const attempt of [...series.value.inherited, ...series.value.attempts]) {
    if (attempt.outcome === null || !attempt.goal.questions.some(question => keys.has(question))) continue;
    const origin = originOf(store, project, series, attempt.ordinal), field = `attempt.${attempt.ordinal}`;
    const binding = take(readCompletionBinding(store, project, origin, attempt.ordinal));
    if (binding) {
      const record = store.get(completionCloseId(project, binding.id));
      if (!record) fail("record_missing", completionCloseId(project, binding.id), "close", "A closed managed attempt keeps its close record");
      const close = take(readCompletionCloseAt(store, project, reference(record)));
      if (!close.waiting.length) continue;
      owed.push({ questions: attempt.goal.questions, reasons: close.waiting.map(diagnostic => {
        const checked = take(readManagedModelDiagnostic(store, binding as never, diagnostic));
        return reasonOf("owner-control", checked.request.code, series.id, field, checked.request.message, [reference(series), reference(record), diagnostic]);
      }) });
    } else if (attempt.outcome.reason === "awaiting-owner")
      owed.push({ questions: attempt.goal.questions, reasons: [reasonOf("owner-control", "awaiting_owner", series.id, field,
        `Attempt ${attempt.ordinal} of this line ended waiting for the owner; the earlier mode saved no diagnostic of the decision it needs`, [origin])] });
  }
  return owed;
}
/**
 * The ladder after a stop and the origin holds, read by A3/A4 and answered by their own producers (rows 17–21). The
 * origin route goes first, and each ground lifts only its own barrier: A6 on the exact hold may lift it; on a first-rung
 * stop A6 reviews the exact stop-context — decided grounds `resumeSeries`, undecided escalates it (A6 itself). A6 is
 * asked for a possible continuation, never to fill a list: once a ground no automatic step lifts is proved — a standing
 * hold, a failed review, the second rung — the rest of the line is not paid for (№1995 п.4). What is proved is a ground of
 * the end of the pass; a stop not yet reviewed is not (R1). H1 never makes the owner's decision.
 */
type Barrier = { step: RunStep } | Held | { final: RunReason[] } | null;
function ladder(store: Store, request: RunRequest, series: Sealed<Revision<AnyRepairSeries>>, history: RunHistory, trail: Trail): Barrier {
  const project = request.project, performed = history.performed;
  const read = readStopContext(store, seriesRequestOf(series.value));
  // A refusal to read the ground is a typed refusal of the pass, never a wait and never a ground of its end (№1995 п.6);
  // only the plain absence of a stop is no ground at all.
  if (!read.ok) {
    if (read.refusal.code === "stop_absent") return null;
    throw new RunFailure(read.refusal);
  }
  const context = read.value.context;
  stand(trail, read.value.reads as Ref[]);
  // LP8 (№3622): a failed review read with its recovery — the saved recovered review, the recovery step for an answer the
  // old adapter wrapper refused, or the failure as it stands.
  const analysisOf = (ref: Ref, attempt: number | null): { record: Sealed<Revision<AnalysisRecord>> } | { step: RunStep } => {
    const record = take(readStopAnalysis(store, { project, record: ref })) as Sealed<Revision<AnalysisRecord>>;
    if (record.value.state !== "failed") return { record };
    const recovered = readRecoveredStopAnalysis(store, project, ref);
    if (recovered) return { record: recovered };
    if (stopAnalysisRecoverable(store, project, ref)) return step("recover-analysis", { project, failure: ref }, series.id, attempt);
    return { record };
  };
  // №1814: the A6 of one exact ground goes on with the request this pass saved for it — its original dispatch — and
  // finds its result by that request; only a ground never analysed gets the current dispatch. A6 names a hold by the
  // hold itself, and a stop by its origin series and stop attempt, never by the series revision or the dispatch.
  for (const hold of [...context.holds].sort((a, b) => a.hold.id < b.hold.id ? -1 : a.hold.id > b.hold.id ? 1 : 0)) {
    const saved = history.saved("analyze", row => same(row.hold, hold.hold));
    const analysis = saved ?? { project, series: reference(series), hold: hold.hold, dispatch: request.dispatch };
    const done = performed("analyze", analysis);
    if (!done) return (saved ? unavailable(store, series, analysis as unknown as StopAnalysisRequest) : null) ?? step("analyze", analysis, series.id, hold.attempt);
    const reviewed = analysisOf(done[0]!, hold.attempt);
    if ("step" in reviewed) return reviewed;
    const record = reviewed.record;
    if (record.value.state === "failed") return { final: [reasonOf("hold-analysis-failed", "analysis_failed", hold.hold.id, "hold",
      "The independent review of this hold ended without a result of its own; nothing automatic lifts the hold", [hold.hold, done[0]!])] };
    if (record.value.state === "origin-unestablished") return { final: [reasonOf("hold-origin-unestablished", "origin_hold", hold.hold.id, "hold",
      "The origin of this refusal is not established; the hold stands until its own lawful lift", [hold.hold, done[0]!])] };
    // The record and the standing hold disagree: nothing is proved, the pass reads them again.
    return wait("origin_hold", hold.hold.id, "hold", "The review of this hold is saved, but the hold still stands; the pass reads them again", [hold.hold, done[0]!]);
  }
  const stop = context.stop;
  if (!stop) return null;
  // LP6 (№3325 §5): a block stop whose whole counted window the new era proves false is lifted by its own transition
  // first — before the second rung and before A6 is asked or paid for. A window with a real failure keeps the old rules
  // below; a missing or broken proof is a typed refusal of the pass, never a ground to pay for A6.
  if ("block" in series.value) {
    const reconcile = { ...seriesRequestOf(series.value), stop: stop.attempt };
    const fit = prepareReconcileSeries(store, reconcile as never);
    if (fit.ok) { if (fit.value.writes.length) return step("reconcile", reconcile, series.id, null); }
    else if (fit.refusal.code !== "progress_unproved") throw new RunFailure(fit.refusal);
  }
  if (context.ladder.rung >= 2) {
    const escalation = series.value.escalations.find(item => item.after === stop.attempt);
    return { final: [reasonOf("stop-second-rung", "owner_decision", series.id, "stop",
      `The stop after attempt ${stop.attempt} stands on the second rung: only a decision on it continues the series, and this pass makes none`,
      [reference(series), ...(escalation ? [escalation.review] : [])])] };
  }
  const saved = history.saved("analyze", row => row.hold === null && sameStop(store, project, series, stop.attempt, row.series));
  const analysis = saved ?? { project, series: reference(series), hold: null, dispatch: request.dispatch };
  const done = performed("analyze", analysis);
  if (!done) return (saved ? unavailable(store, series, analysis as unknown as StopAnalysisRequest) : null) ?? step("analyze", analysis, series.id, stop.attempt);
  const reviewed = analysisOf(done[0]!, stop.attempt);
  if ("step" in reviewed) return reviewed;
  const record = reviewed.record;
  if (record.value.state === "decided") return step("resume", { ...seriesRequestOf(series.value), stop: stop.attempt, ground: "review-record",
    text: `The independent review of this stop decided: ${record.value.change?.text ?? record.value.cause?.text ?? "an addressed change"}`,
    review: { ref: reference(record) } }, series.id, null);
  if (record.value.state === "failed") return { final: [reasonOf("stop-analysis-failed", "analysis_failed", series.id, "stop",
    `The independent review of the stop after attempt ${stop.attempt} ended without a result of its own; nothing automatic continues the series`,
    [reference(series), done[0]!])] };
  // An undecided review escalates the stop atomically with its own record, so the next reading is on the second rung.
  return wait("owner_decision", series.id, "stop", "The review of this stop is saved undecided but the stop is not on the second rung; the pass reads them again",
    [reference(series), done[0]!]);
}
/**
 * A6 for a saved request cannot even be prepared, and this is the same request for the same barrier: the environment has
 * no independent reviewer or the complete reviewer request exceeds the technical capacity. That is not a failed review —
 * no analysis and no transport exist — but nothing automatic lifts it, and a changed dispatch would be another
 * identity of the review (№1995 п.7). Any other refusal of the preparation is not a ground.
 */
function unavailable(store: Store, series: Sealed<Revision<AnyRepairSeries>>, request: StopAnalysisRequest): Barrier {
  const prepared = prepareStopAnalysis(store, request);
  if (prepared.ok || !["assessor_not_independent", "context_too_large"].includes(prepared.refusal.code)) return null;
  const refusal = prepared.refusal;
  return { final: [reasonOf("analysis-unavailable", refusal.code, refusal.at.target, refusal.at.field ?? "request", refusal.message,
    [reference(series), ...(request.hold ? [request.hold] : []), request.dispatch.adapter, request.dispatch.config, ...(refusal.at.ref ? [refusal.at.ref] : [])])] };
}
/**
 * A line of this pass's own horizon that the batches do not reach today keeps the barrier it stands on: an absent batch
 * does not erase a stop or a hold (№1995 п.8, C31). Only a line that belongs to the saved intent counts: its block is a
 * node of the horizon the intent derived and B3 still admits the line. The finished history of any other block — one
 * the intent never asked for — is another subject's and stops nothing, however legacy its line is (№2045-1). The
 * mechanism M5 has no such line: it asks the questions of today's batches and nothing else, so without a batch nothing
 * is left for it to ask. Only what is already proved counts; nothing is paid for an owner that has no work.
 */
function idleBarriers(store: Store, request: RunRequest, bases: Bases, owners: readonly Owner[], history: RunHistory, trail: Trail): void {
  const project = request.project;
  // The horizon is read once, and only when a line without a batch is met.
  let nodes: ReadonlySet<string> | null = null;
  const inside = (block: string): boolean =>
    (nodes ??= new Set(take(readHorizon(store, project, bases.refs.horizon)).horizon.value.result.horizon.nodes)).has(block);
  for (const series of projectSeries(store, project)) {
    if (!("block" in series.value)) continue;
    const block = series.value.block;
    if (owners.some(item => item.block === block) || series.value.attempts.some(attempt => attempt.outcome === null)) continue;
    if (!inside(block) || !prepareSeriesLineAdmission(store, project, reference(series)).ok) continue;
    const barrier = ladder(store, request, series, history, trail);
    if (barrier && "final" in barrier) trail.finals.push(...barrier.final);
  }
}
/**
 * Whether a saved A6 request names this exact stop, as A6 itself names it: its series is this line or a predecessor
 * that carried the same stop, and at the saved revision that series stood on the same stop attempt. An earlier stop of
 * the line, resumed since, is another ground.
 */
function sameStop(store: Store, project: string, series: Revision<AnyRepairSeries>, attempt: number, saved: unknown): boolean {
  if (!isRef(saved)) return false;
  const lineage = new Set([series.id]);
  for (let at = series.value.predecessor; at !== null;) {
    const previous = readAnySeriesAt(store, project, at);
    if (!previous.ok || previous.value.value.stop?.attempt !== attempt) break;
    lineage.add(at.id); at = previous.value.value.predecessor;
  }
  if (!lineage.has(saved.id)) return false;
  const read = readAnySeriesAt(store, project, saved);
  return read.ok && read.value.value.stop?.attempt === attempt;
}

/**
 * MP2 (№2968 §2): the order of still unstarted node-expansion roots — producer before consumer by the direct flows of the
 * expanded level in the exact upper graph of their frame: strongly connected components in the topological order of their
 * condensation, the ready component with the least node id first, inside it by node id, one node's batches by batch and
 * then assignment id. Sleeping flows, other levels and self-references set no order; every binding and consumer counts.
 */
export function rankExpansions(items: readonly { id: string; node: string; batch: string; level: 2 | 3 }[],
  upperOf: (level: 2 | 3) => Graph): string[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const nodes = [...new Set(items.map(item => item.node))].sort(compare);
  const succ = new Map(nodes.map(node => [node, new Set<string>()]));
  for (const level of [...new Set(items.map(item => item.level))].sort()) {
    for (const connector of upperOf(level).connectors) for (const binding of connector.bindings) {
      if (binding.anchor !== null || binding.level !== level - 1 || !succ.has(binding.producer.node)) continue;
      for (const consumer of binding.consumers)
        if (consumer.node !== binding.producer.node && succ.has(consumer.node)) succ.get(binding.producer.node)!.add(consumer.node);
    }
  }
  // Tarjan's components, then Kahn over the condensation with the least member id among the ready components.
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
  const component = new Map<string, number>(), members: string[][] = [];
  let counter = 0;
  const connect = (node: string): void => {
    index.set(node, counter); low.set(node, counter++); stack.push(node); on.add(node);
    for (const next of [...succ.get(node)!].sort(compare)) {
      if (!index.has(next)) { connect(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); }
      else if (on.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) !== index.get(node)) return;
    const own: string[] = [];
    for (let member = stack.pop()!; ; member = stack.pop()!) { on.delete(member); component.set(member, members.length); own.push(member); if (member === node) break; }
    members.push(own.sort(compare));
  };
  for (const node of nodes) if (!index.has(node)) connect(node);
  const indegree = members.map(() => 0), after = members.map(() => new Set<number>());
  for (const [node, next] of succ) for (const to of next) {
    const from = component.get(node)!, into = component.get(to)!;
    if (from !== into && !after[from]!.has(into)) { after[from]!.add(into); indegree[into]!++; }
  }
  const order: string[] = [], ready = members.map((_, at) => at).filter(at => indegree[at] === 0);
  while (ready.length) {
    ready.sort((a, b) => compare(members[a]![0]!, members[b]![0]!));
    const at = ready.shift()!;
    order.push(...members[at]!);
    for (const into of after[at]!) if (--indegree[into]! === 0) ready.push(into);
  }
  const rank = new Map(order.map((node, at) => [node, at]));
  return [...items].sort((a, b) => rank.get(a.node)! - rank.get(b.node)! || compare(a.batch, b.batch) || compare(a.id, b.id)).map(item => item.id);
}
/**
 * The attempt's leaves in the order they are worked: every leaf that is not an unstarted node-expansion root keeps its place
 * in front — a saved step or begun physical work is never overtaken by a rank — and the unstarted roots follow by their rank.
 */
function flowOrder(store: Store, scope: GapReadRequest, batches: readonly RouteBatch[], leaves: Revision<unknown>[],
  started: (root: Ref) => boolean): Revision<unknown>[] {
  const ranked = leaves.flatMap(row => {
    const value = row.value as CompletionAssignment;
    const batch = value.kind === "root" ? batches.find(item => item.id === value.batch) : undefined;
    return batch?.task === "node-expansion" && typeof batch.node === "string" && batch.level !== null && !started(reference(row))
      ? [{ id: row.id, node: batch.node, batch: batch.id, level: batch.level }] : [];
  });
  if (!ranked.length) return leaves;
  // Begun work goes first even beside a single unstarted root; only two or more need the rank of their frame.
  const upper = new Map<2 | 3, Graph>();
  const order = ranked.length < 2 ? ranked.map(item => item.id) : rankExpansions(ranked, level => {
    if (!upper.has(level)) upper.set(level, (take(readFrameProposals(store, (level === 2 ? scope.sources.operations : scope.sources.works) as never)) as unknown as
      { frame: { upper: Graph } }).frame.upper);
    return upper.get(level)!;
  });
  const byId = new Map(leaves.map(row => [row.id, row]));
  return [...leaves.filter(row => !ranked.some(item => item.id === row.id)), ...order.map(id => byId.get(id)!)];
}
/**
 * The open attempt continues by its registry. A standalone attempt (no binding) is never adopted: the pass waits for
 * its own E4/E5/G7 way (№1737 п.3). For a managed one the next unfinished assignment is chosen from the work itself,
 * never from today's E1 ledger (C23); a complete work is checked (block G4b) and closed through G7 with its derived claim.
 */
function continueAttempt(store: Store, request: RunRequest, series: Sealed<Revision<AnyRepairSeries>>, ordinal: number, history: RunHistory,
  trail: Trail): Choice {
  const project = request.project;
  const binding = take(readCompletionBinding(store, project, reference(series), ordinal));
  if (!binding) return wait("standalone_attempt", series.id, "attempt",
    "A standalone attempt of the earlier mode continues by its own E4/E5/G7 way; the pass does not adopt it", [reference(series)]);
  const workHead = store.get<CompletionWork>(completionWorkId(project, binding.id));
  if (!workHead) fail("record_missing", completionWorkId(project, binding.id), "work", "A managed attempt keeps its registry");
  // The registry of open work is a head an end without a result depends on (№1995 п.3).
  stand(trail, [reference(workHead)]);
  const work = take(readCompletionWorkAt(store, project, reference(workHead))) as CompletionSnapshot;
  const address = { ...ownerRequest(project, "block" in series.value ? { block: series.value.block } : { owner: M5_OWNER }, series.value.line), attempt: ordinal };
  const block = "block" in series.value;
  // STALE-8 / №1737 п.4: the block check is registered right after opening, before any packet, call or close.
  if (block && work.answers === null) return step("register", { project, binding: reference(binding) }, series.id, ordinal);
  const plan = take(readRoutes(store, { project, record: binding.value.plan.routes })).record as unknown as Revision<RoutesRecord>;
  const scope = plan.value.request.gaps as unknown as GapReadRequest;
  const resolved = new Set(work.resolved.map(ref => canonical(ref)));
  const parentOf = new Map(work.assignments.map(row => [row.id, (row.value as CompletionAssignment).parent?.id ?? null]));
  const resolvedIds = new Set(work.assignments.filter(row => resolved.has(canonical(reference(row)))).map(row => row.id));
  // LP3 (№2817-2/-4): a part or continuation — a step of its root's own cycle — below a root that cycle already ended
  // (blocked, no progress, invalid parts or reads) is no work of the pass: its root is resolved, and the attempt goes on to
  // its close. A fact below an answered root is its own work (E5) and stays open until assessed.
  const underResolved = (row: Revision<unknown>): boolean => {
    const kind = (row.value as CompletionAssignment).kind;
    if (kind !== "part" && kind !== "continuation") return false;
    for (let at = parentOf.get(row.id) ?? null; at !== null; at = parentOf.get(at) ?? null) if (resolvedIds.has(at)) return true;
    return false;
  };
  const open = work.assignments.filter(row => !resolved.has(canonical(reference(row))) && !underResolved(row));
  // An ancestor is resolved by its descendants (the facts of a root's part, the parts of a plan): only open assignments
  // that are no ancestor of another open one are worked, whatever the order of the registry.
  const parents = new Set<string>();
  for (const row of open) for (let at = parentOf.get(row.id) ?? null; at !== null && !parents.has(at); at = parentOf.get(at) ?? null) parents.add(at);
  const byId = new Map(work.assignments.map(row => [row.id, row as Revision<CompletionAssignment>]));
  // A cycle of a packet goes on with the exact request this pass saved for it (the same cycle identity even after an
  // environment change); only a packet never cycled gets the current dispatch.
  const cycleOf = (packet: Ref): Choice => step("cycle", history.saved("cycle", row => same(row.packet, packet))
    ?? { project, packet, dispatch: request.dispatch, role: "implementer" }, series.id, ordinal);
  // H1.5 (№2166, №2221): the batches of the saved plan are judged by the one common reading of the attempt's exact routes
  // and their complete D1 — never by the code of a saved wait. It is read once per continuation, only when a root is met.
  let producers: Sealed<RouteProducers> | null = null;
  const unservedOf = (batch: string): readonly UnservedQuestion[] =>
    (producers ??= take(readRouteProducers(store, { project, routes: binding.value.plan.routes }))).batches.find(row => row.batch === batch)?.unserved ?? [];
  // Physical work of a packet: the E4 call of its exact request (claimed, received, applied or refused) or a cycle of it
  // among the attempt's products. It is E4's to finish, account and recover; the pass never cuts it short.
  const physicalWork = (packet: Ref): boolean => {
    const saved = store.get<{ packet?: { requestId?: unknown } }>(packet.id, packet.revision);
    const requestId = saved?.value.packet?.requestId;
    if (typeof requestId === "string" && requestId.length > 0 && store.get(modelCallRecordId(project, requestId))) return true;
    return work.products.some(product => {
      const row = store.get<{ request?: { packet?: Ref } }>(product.id, product.revision);
      return row?.kind === "om-model-cycle" && isRef(row.value.request?.packet) && sameRef(row.value.request.packet, packet);
    });
  };
  const explained = new Set<string>();
  const started = (root: Ref): boolean => work.products.some(product => {
    const record = store.get<{ root?: Ref; packet?: Ref }>(product.id, product.revision);
    return record?.kind === "om-completion-packet" && isRef(record.value.root) && sameRef(record.value.root, root) && isRef(record.value.packet);
  });
  for (const assignment of flowOrder(store, scope, plan.value.batches, open.filter(row => !parents.has(row.id)), started)) {
    const value = assignment.value as CompletionAssignment;
    // Row 6, №1737 п.9: an unfinished assignment whose required condition lawfully changed is ended by the common H1.0b
    // producer with its proved cause; a live or unknown claim stays that producer's refusal and so an addressed wait.
    const cause = prepareCompletionCause(store, project, reference(assignment));
    if (!cause.ok) return { wait: waitOf(cause.refusal, project) };
    if (cause.value.cause) return step("cease", { project, binding: reference(binding), assignment: reference(assignment) }, series.id, ordinal);
    if (value.kind === "root") {
      const found = completionPacketOf(store, project, work, reference(assignment));
      if ("wait" in found) return found;
      const packet = found.packet;
      // H1.5 (№2221): a root whose batch holds a question no answer producer serves is not sent: E4 would refuse it and
      // the pass would stand on that refusal for ever. Its blocking questions are grounds of the end of the pass (R13),
      // standing on the exact routes and D1 records that prove them; the attempt's other assignments and the other
      // series get their turn, and when nothing is left the pass ends. The saved plan and packet stay as they are: no
      // G7 outcome is invented for the assignment. A packet whose physical work already began goes on by E4's own way.
      const unserved = unservedOf(value.batch);
      if (unserved.length && !(packet && physicalWork(packet))) {
        stand(trail, [binding.value.plan.routes, ...unserved.map(question => question.gap)]);
        trail.finals.push(...unserved.filter(question => question.blocking).map(question => reasonOf("unsupported-question",
          question.producer.code, question.target, question.producer.field, question.producer.message, [question.gap])));
        explained.add(assignment.id); continue;
      }
      if (!packet) {
        // A works root (L3 node expansion) is asked with the D7 ledger of its exact D1 scope and D2 lines (F5).
        const batch = plan.value.batches.find(row => row.id === value.batch);
        const ledger = batch?.task === "node-expansion" && batch.level === 3 ? worksLedger(store, project, scope) : null;
        if (ledger && !("works" in ledger)) {
          if ("step" in ledger) return { step: { ...ledger.step, series: series.id, attempt: ordinal } };
          // A root the D7 cannot assign is a proved ground: the attempt's other assignments still get their turn.
          if (ledger.final) { trail.finals.push(ledger.final); explained.add(assignment.id); continue; }
          return ledger;
        }
        // LP5 (№3278 §3, T1): a paid complete assembly of an earlier attempt of this line, ended by the replaced B1 of its
        // area, answers this unstarted root again when it fits it today — no new E1, call or expense.
        if (ledger) {
          const reuse = { project, binding: reference(binding), root: reference(assignment), works: ledger.works };
          const found = prepareCompletionReuse(store, reuse);
          if (!found.ok) return { wait: waitOf(found.refusal, project) };
          if (found.value.record) return step("reuse", reuse, series.id, ordinal);
        }
        return step("packet", { project, routes: binding.value.plan.routes, batch: value.batch, environment: request.dispatch.config,
          attempt: { series: binding.value.series, ordinal }, previous: [], ...(ledger ? { works: ledger.works } : {}) }, series.id, ordinal);
      }
      return cycleOf(packet);
    }
    // A part or continuation is a step of its root's cycle: the same saved cycle goes on with its chosen parts
    // (№1766 п.1), never a new cycle beside it.
    if (value.kind === "part" || value.kind === "continuation") {
      let root: Revision<CompletionAssignment> | undefined = assignment as Revision<CompletionAssignment>;
      while (root && root.value.parent) root = byId.get(root.value.parent.id);
      const found = root && root.value.kind === "root" ? completionPacketOf(store, project, work, reference(root)) : null;
      if (found && "wait" in found) return found;
      if (found?.packet) return cycleOf(found.packet);
      continue;
    }
    if (value.kind === "fact" && value.question) {
      const fact = { modelCall: value.source, questionId: value.question };
      const saved = history.saved("assess", row => same(row.modelCall, fact.modelCall) && row.questionId === fact.questionId);
      return step("assess", saved ?? { project, ...fact, dispatch: request.dispatch }, series.id, ordinal);
    }
  }
  // What is unfinished only because of a proved ground is that ground's, not a wait of its own (№1995 п.8).
  if (open.length) return wait("work_pending", workHead.id, "assignments",
    "A registered assignment is unfinished and no action of this pass can finish it now", open.map(row => reference(row)),
    explained.size && open.every(row => explained.has(row.id)) ? "dependent" : "defer");
  const batches = plan.value.batches.filter(row => binding.value.plan.batches.includes(row.id));
  const expansion = (level: 2 | 3) => batches.some(row => row.task === "node-expansion" && row.level === level);
  const level: 2 | 3 | null = !block ? null : expansion(2) ? 2 : expansion(3) ? 3 : null;
  // №1749: the attempts of one D1 scope give the full G4b their results; the attempts that expand the same frame form
  // one group with one common acceptance. Ownership stays with each attempt: its assemblies, its binding, its D2.
  const members = block ? scopeAttempts(store, project, scope) : [];
  const group = level ? members.filter(row => row.open && row.level === level) : [];
  // Row 25: for N2 the common candidate of the group and a successful common G3 come BEFORE the positive G4b; for N3 the
  // complete assemblies are enough, without a premature G5.
  let candidate: { ref: Ref; graphHash: string } | null = null;
  // An acceptance already made for this attempt's own results is found first: after C5 the old frame request is history.
  // LP5 (return №3294 п.2): one derivation with the end of a remaining acceptance — the own assemblies and reuses.
  const made = level ? take(readCompletionAcceptance(store, project, work, level)) : null;
  // №1770 п.2: an own root of this level that ended without assembly makes the attempt negative. It needs no candidate,
  // passed G4b or C5: its check is evaluated on the full G4b and the attempt closes through the common G7, whatever the
  // neighbours of the frame still do; its other own assignments must still be complete (above).
  const levelBatches = new Set(batches.filter(row => row.task === "node-expansion" && row.level === level).map(row => row.id));
  const negative = !!level && !made && negativesOf(store, project, work).some(row => levelBatches.has(row.batch));
  // LP5 (№3278 §2): once the B1 of this attempt's own area is replaced, its remaining non-physical work ends by its own
  // product — the registered check by check-ceased, a complete check's common acceptance by a finalization — and the
  // attempt goes to its common close, never back into a check, a candidate or a frame wait of the ended phase. On the
  // same B1 a moved D1/M6 keeps every earlier rule (row 1).
  const replaced = block ? take(readAreaReplacement(store, project, reference(binding))) : null;
  const ended = !!work.answers?.ceased || work.products.some(ref => store.get(ref.id, ref.revision)?.kind === COMPLETION_FINALIZATION_KIND);
  if (replaced && work.answers && !ended) {
    if (!work.answers.complete) {
      const ceased = prepareCompletionCause(store, project, work.answers.assignment);
      if (!ceased.ok) return { wait: waitOf(ceased.refusal, project) };
      if (ceased.value.cause) return step("cease-check", { project, binding: reference(binding) }, series.id, ordinal);
    } else if (level && !negative && !made) return finalizeStep(store, project, binding, "acceptance", series.id, ordinal);
  }
  // G6.2 (№3888, №3891): a saved G5 rejection of this D1 group that rejected proposals ends the whole original group — the
  // members closed since included. Every member, the accepting one included, ends its remaining acceptance by that
  // rejection and keeps its paid assemblies for reuse; a member whose own result it rejected also closes on its own rows
  // (below), so only the rejected root is new work.
  if (!ended && !replaced && level === 3 && !made && !negative && work.answers?.complete) {
    // The producer of the end decides who belongs to the group it rejected; a later attempt on the same D1 goes on.
    const rejection = groupRejectionOf(store, project, members);
    const readiness = rejection ? groupReadiness(store, project, rejection, group, series.id, ordinal) : null;
    if (readiness) return readiness;
    const request = rejection ? { project, binding: reference(binding), phase: "acceptance" as const, rejection } : null;
    if (request && prepareCompletionFinalization(store, request).ok) return step("finalize", request, series.id, ordinal);
  }
  if (!ended && level === 2 && !made && !negative) {
    const operations = scope.sources.operations as unknown as { frame: CandidateRequest["frame"]; proposals: Ref[] };
    const proposals = uniqueRefs([...operations.proposals, ...group.flatMap(row => row.assemblies.filter(item => item.level === 2).map(item => item.proposal))]);
    const candidateRequest: CandidateRequest = { frame: operations.frame, proposals };
    const prepared = prepareCandidate(store, candidateRequest);
    if (!prepared.ok) return { wait: waitOf(prepared.refusal, project) };
    // Another block of this frame has not assembled its part yet: this attempt stays open and the pass goes on in M3.
    if (prepared.value.state === "gaps") return wait("frame_participants", series.id, "candidate",
      "The common operations frame still has open obligations of other blocks; this attempt waits for their work", group.map(row => reference(row.series)), "dependent");
    if (!prepared.value.existing) return step("candidate", candidateRequest, series.id, ordinal);
    const gate = gateCandidate(store, { project, candidate: reference(prepared.value.existing) });
    if (!gate.ok) return { wait: waitOf(gate.refusal, project) };
    candidate = { ref: reference(prepared.value.existing), graphHash: gate.value.graphHash };
  }
  if (!ended && block && work.answers && !work.answers.complete) {
    // The registered check ends by its own H1.0b door when its block line admission lawfully changed (№1616 п.1).
    const ceased = prepareCompletionCause(store, project, work.answers.assignment);
    if (!ceased.ok) return { wait: waitOf(ceased.refusal, project) };
    if (ceased.value.cause) return step("cease-check", { project, binding: reference(binding) }, series.id, ordinal);
    // G4b checks the whole CURRENT M6 of the attempt's own scope (row 25): an accepted answer can make the saved route
    // historical, and its successor is prepared explicitly by M6 itself before the check.
    const current = currentRoutes(store, project, binding.value.plan.routes);
    if ("wait" in current) return current;
    if ("successor" in current) return step("routes", current.successor, series.id, ordinal);
    const evaluation = { project, binding: reference(binding), deliver: "all",
      request: answersRequest(store, project, current.routes, members, { series: series.id, ordinal }, candidate?.ref ?? null) };
    // This very check was evaluated already, so evaluating it again changes nothing and would starve every other owner of the
    // pass: what its full G4b proved is read instead (№1995 п.9, №2045-2). A question no producer of this product answers
    // is a final ground; the attempt stays open — no close, C5 or D2 is invented — and the pass goes on with whatever else
    // it can do. A failed check without such a ground keeps its old choice.
    const evaluated = history.performed("evaluate", evaluation);
    if (evaluated) {
      const read = passedGate(store, project, evaluated[0]!);
      const grounds = read.passed ? [] : provenQuestions(store, project, read.gate, { binding, products: work.products });
      if (grounds.length) {
        trail.finals.push(...grounds);
        return wait("check_unanswerable", series.id, "answers",
          "The full G4b of this attempt's check names a question no producer of this product answers; the attempt stays open", [evaluated[0]!], "dependent");
      }
    }
    return step("evaluate", evaluation, series.id, ordinal);
  }
  const accepting: Ref[] = [];
  // FA1 (№3816, №3817): a complete check that failed on a technical E5 terminal of this attempt's own fact can never pass —
  // E5 assesses a fact once and no neighbour's work changes that terminal. The attempt closes through the common G7 like a
  // negative one, its outcome derived by the close, and the next attempt asks the fact again.
  const technical = !ended && !!level && !negative && !made && technicalAssessmentFailure(store, project, work);
  // G6.2 (№3869 п.1, п.5): an own assembly whose proposal a saved G5 rejection of the group rejected — a defect of its own
  // content — closes this attempt through the common G7 with exactly the rows that name it; the next attempt of the block
  // makes a new assembly, and the other members keep theirs.
  const rejected = level === 3 && !negative && !made && !technical ? ownRejectedRows(store, project, work) : [];
  if (!ended && level && !negative && !technical && !rejected.length) {
    // D2 lines are named by the D1 gap ids of the attempt's own node obligations at this level.
    const goalLines = [...new Set(batches.filter(row => row.task === "node-expansion" && row.level === level)
      .flatMap(row => row.items.map(item => item.gap)))].sort();
    const accepted = made;
    if (!accepted) {
      // One C5 for the group, after every member's registered check is complete, by the attempt whose CURRENT check
      // passed; it binds only its own goal's obligations (№1737 п.12, №1749 п.3).
      const pending = group.filter(row => !row.work.answers?.complete);
      if (pending.length) return wait("frame_checks", series.id, "answers",
        "The common acceptance waits for the registered checks of every attempt of this frame", pending.map(row => reference(row.series)), "dependent");
      const checked = work.answers?.evaluation ? passedGate(store, project, work.answers.evaluation) : null;
      if (checked && !checked.passed) trail.finals.push(...provenQuestions(store, project, checked.gate, { binding, products: work.products }));
      if (!checked?.passed) return wait("frame_gate", series.id, "answers",
        "The full G4b of this attempt's check did not pass; the common acceptance belongs to an attempt whose check passed", group.map(row => reference(row.series)), "dependent");
      // №1749 п.4: the ordinary D2 snapshot of the original D1, where the gaps still stand, precedes the acceptance.
      if (!linesOf(store, project, scope)) return linesStep(store, project, scope, series.id, ordinal);
      const bound: FrameAttemptBinding = { series: reference(series), ordinal, obligations: obligationsOf(batches, level) };
      if (level === 2) return step("accept", { gate: checked.request, settle: { project, level: 2, candidate: candidate!.ref,
        outcome: { gate: "G3", candidate: candidate!.ref, graphHash: candidate!.graphHash, passed: true, codes: [] }, binding: bound } }, series.id, ordinal);
      // G6 (В2, №3869): an accepted answer of a question that blocks this group's own works and that B1 still holds keeps
      // their D1 open, so no G5 can pass on the old B1: neither the works step nor a wake choice for an assembly the
      // transition replaces is paid. The machine choice applies the answer once only this group is open; LP5 then ends it.
      const results = group.flatMap(row => row.assemblies.filter(item => item.level === 3).map(item => ({ kind: item.kind, record: item.record })));
      // G6.2 (№3869 п.5): the saved outcome of this attempt's own works step comes first — a refused candidate is never
      // assembled again from the same results.
      const refused = refusedWorks(store, project, history, bound, results, series.id);
      if (refused) return refused;
      const transition = groupTransition(store, project, (checked.request as { routes: Ref }).routes, group);
      if (transition) return transition;
      const sources = prepareWorksSources(store, { project, results });
      if (!sources.ok) {
        // G5.1 (№3847): a sleeping flow whose producer work, answered before the wake-test era, has several covering tests
        // and named none asks that one choice, paid by this accepting attempt; the works step then takes it.
        const wake = sources.refusal.code === "sleeping_wake_test_missing"
          ? wakeStep(store, project, results, sources.refusal, { series: reference(series), attempt: ordinal }, request.dispatch, series.id)
          // G6.1 (№3857 п.4, №3891): a shared file several write orders of which are lawful asks that choice, paid by this
          // accepting attempt, by the same mechanism; the works step then takes it.
          : sources.refusal.code === "write_order_choice_missing"
            ? orderStep(store, project, results, sources.refusal, { series: reference(series), attempt: ordinal }, request.dispatch, series.id) : null;
        return wake ?? { wait: waitOf(sources.refusal, project) };
      }
      return step("works", { gate: checked.request, works: { project, environment: request.dispatch.config, sources: [...sources.value.sources],
        results, binding: bound } }, series.id, ordinal);
    }
    // The coordinator keeps its own accepting C5; every attempt of the group proves its goal through its own D2 event.
    if (accepted.binding?.series.id === series.id && accepted.binding.ordinal === ordinal) accepting.push(accepted.frame);
    const confirmed = confirmationOf(store, project, series.id, ordinal);
    if (!confirmed) {
      // The current D1 over the exact accepted frame is the machine D1 of the project (№1860 п.5, C84): after the
      // common C5 its new horizon and D1 serve the D2 events of this group, though its attempts are still open; any
      // other attempt still working on the old heads finishes first. The old scope stays the history of the goal.
      // Bases that complete this accepted group: its B3 of the new slices comes only after its own D2 and G7 (№1860 п.8).
      // LP5 (№3278 §2, rows 9–10; return №3294 п.1): with the B1 of its area replaced, the accepted goal whose accepted frame
      // or graph is superseded can no longer be confirmed by D2 — only the remainder of its confirmation ends, proved by
      // the derivation of its producer and reader. While both stand, D2 stays the one way, on whatever B1.
      if (replaced && take(readConfirmationGround(store, project, accepted.acceptance, level)).ground)
        return finalizeStep(store, project, binding, "confirmation", series.id, ordinal);
      const checkedBases = prepareRunBases(store, { project }, { completion: true });
      if (!checkedBases.ok) return { wait: waitOf(checkedBases.refusal, project) };
      if (checkedBases.value.state === "missing") {
        const others = projectSeries(store, project, true).filter(row => row.value.attempts.some(attempt => attempt.outcome === null)
          && !group.some(member => member.series.id === row.id));
        if (others.length) return wait("bases_after_work", others[0]!.id, "attempts",
          "The D2 bases over the accepted frame wait until the other open attempts finish on their current bases", others.map(row => reference(row)), "dependent");
        return basesStep(store, project, group.map(member => member.series.id), true, series.id, ordinal);
      }
      const current = ownersScope(store, project, checkedBases.value.built.bases.routes, accepted.acceptance, level);
      if (!current) return wait("d2_bases", series.id, "gaps",
        "The machine D1 of this project does not stand on the accepted frame of this goal", [accepted.frame, checkedBases.value.built.bases.routes]);
      const latest = store.get<GapLinesRecord>(gapLinesId(project))!;
      return step("confirm", { project, previous: reference(latest), pass: latest.value.request.pass + 1, gaps: current,
        closures: goalLines.map(id => ({ id, reason: "filled", basis: accepted.acceptance.frame, acceptance: accepted.acceptance,
          attempt: { series: reference(series), attempt: ordinal } })) }, series.id, ordinal);
    }
    accepting.push(confirmed);
  }
  const claim = prepareManagedClaim(store, { ...address, outcome: { reason: "result", accepting, cancelling: [], refusals: rejected } } as never);
  if (!claim.ok) return { wait: waitOf(claim.refusal, project) };
  return step("close", { ...address, outcome: claim.value.outcome }, series.id, ordinal);
}
/**
 * G6.2 (№3891): the saved G5 rejection of this D1 group that rejected proposals — read from the rejected proposals of its
 * members, open or closed, by the rejection's own reader. The group never shrinks to whoever is open now.
 */
function groupRejectionOf(store: Store, project: string, members: readonly Member[]): Ref | null {
  const found = new Map<string, Ref>();
  for (const member of members) for (const assembly of member.assemblies.filter(item => item.level === 3)) {
    const head = store.get<{ status?: string; verdict?: { contract?: string; candidate?: Ref; gate?: Ref } }>(assembly.proposal.id);
    const verdict = head?.value.verdict;
    if (!head || head.value.status !== "rejected" || verdict?.contract !== "om-work-rejection/v1" || !verdict.candidate || !verdict.gate) continue;
    const rejection = take(readWorkRejection(store, { project, candidate: verdict.candidate, gate: verdict.gate }));
    if (rejection.proposals.length) found.set(rejection.record.id, rejection.record);
  }
  return [...found.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0] ?? null;
}
/**
 * AT1 door (№4105 п.5): a group whose saved G5 rejection names transitions B1 neither asks nor has answered asks them
 * before it ends and before its blocks send any new work — under the rule of an answer's application (G6 В2): the B1
 * transition is written once only this group's attempts are open, else the group waits for the others. LP5 then ends the
 * group on the replaced B1; a repeat finds the questions asked and goes on.
 */
function groupReadiness(store: Store, project: string, rejection: Ref, group: readonly Member[], series: string, ordinal: number): Choice | null {
  const read = take(readWorkRejectionAt(store, { project, record: rejection })).record;
  const gate = store.get<{ gate: Ref }>(read.id, read.revision)!.value.gate;
  if (!take(readinessPending(store, project, gate))) return null;
  const others = projectSeries(store, project, true).filter(row => row.value.attempts.some(attempt => attempt.outcome === null)
    && !group.some(member => member.series.id === row.id));
  if (others.length) return wait("group_readiness", series, "readiness",
    "The group's works were refused for transitions nobody has resolved; B1 asks them once the other open attempts finish",
    uniqueRefs([gate, ...others.map(row => reference(row))]), "dependent");
  return step("readiness", { project, input: reference(store.get<OmInputRecord>(`om-input:${project}`)!), gate }, series, ordinal);
}
/**
 * G6.2 (№3869 п.1, п.5): the rows of the saved G5 rejection that name this attempt's own assemblies — each its proposal,
 * rejected for a defect of its own content. They are read through the rejection's own reader, never guessed from heads.
 */
function ownRejectedRows(store: Store, project: string, work: CompletionSnapshot): { row: string; name: string; goal: string }[] {
  const rows = new Map<string, { row: string; name: string; goal: string }>();
  for (const assembly of assembliesOf(store, project, work).filter(item => item.level === 3)) {
    const head = store.get<{ status?: string; verdict?: { contract?: string; candidate?: Ref; gate?: Ref } }>(assembly.proposal.id);
    const verdict = head?.value.verdict;
    if (!head || head.revision === assembly.proposal.revision || head.value.status !== "rejected" || verdict?.contract !== "om-work-rejection/v1"
      || !verdict.candidate || !verdict.gate) continue;
    const rejection = take(readWorkRejection(store, { project, candidate: verdict.candidate, gate: verdict.gate }));
    if (!rejection.proposals.some(ref => same(ref, reference(head)))) continue;
    for (const row of take(readJournalAt(store, project, rejection.journal)).value.rows)
      if (same(row.source, rejection.diagnostic) && row.origin.sources.some(source => source.role === "proposal" && same(source.ref, assembly.proposal)))
        rows.set(row.id, { row: row.id, name: row.code, goal: row.goal });
  }
  return [...rows.values()].sort((a, b) => a.row < b.row ? -1 : a.row > b.row ? 1 : 0);
}
/**
 * G6.2 (№3869 п.5, №3891): the saved refusal of this accepting attempt's own works step that rejected no proposal — its
 * findings are the candidate's own (the write order of shared files is G6.1's step). While the group's results are those
 * of the refused candidate, the acceptance waits at that address; new results make a new candidate. A refusal that
 * rejected proposals ends the whole group instead (groupRejectionOf).
 */
function refusedWorks(store: Store, project: string, history: RunHistory, bound: FrameAttemptBinding, results: readonly WorkProposalSource[],
  series: string): Held | null {
  const saved = history.saved("works", request => same((request.works as { binding?: unknown } | undefined)?.binding ?? null, bound));
  const products = saved ? history.performed("works", saved as Record<string, unknown>) : null;
  if (!products?.length) return null;
  const acceptance = take(readWorksAcceptance(store, { project, record: products[0]! }));
  const gate = take(readAtomicGate(store, { project, record: acceptance.value.gate })).value.result;
  if (gate.passed) return null;
  const set = (rows: readonly unknown[]) => rows.map(row => canonical(row as Json)).sort();
  // Each finding keeps its own code and subject: the write order of shared files is G6.1's, any other is the candidate's own.
  if (same(set(acceptance.value.request.results), set(results))) return wait("works_rejected", series, "works",
    `The group's works candidate was refused for findings of the candidate itself, its results unchanged: ${gate.findings
      .map(finding => `${finding.code} ${finding.target}`).join("; ")}`, [products[0]!], "dependent");
  return null;
}
/**
 * G6 (В2, №3869): the wait of a group whose works acceptance stands on accepted answers of its own blocking questions not
 * yet applied to B1 — a question whose consumer this group's works refine (or that refines them), answered in the current
 * M6 of the attempt's plan, still held by B1. Its basis names those answers and every series of the group.
 */
function groupTransition(store: Store, project: string, routesRef: Ref, group: readonly Member[]): Held | null {
  const routes = take(readRoutes(store, { project, record: routesRef })).record.value as unknown as RoutesRecord;
  const held = new Set(store.get<OmInputRecord>(`om-input:${project}`)!.value.input.questions.map(question => question.id));
  const answered = routes.routes.filter(route => route.state === "answered" && route.answer && route.field === "answer" && held.has(route.target));
  if (!answered.length) return null;
  const graph = take(readRecord<Graph>(store, routes.request.gaps.sources.graph, { unit: UNIT, target: routes.request.gaps.sources.graph.id,
    id: `graph:${project}`, kind: "graph" })).value;
  const relations = new RefinementRelations(graph as Graph), nodes = group.flatMap(row => row.batches
    .filter(batch => batch.task === "node-expansion" && batch.level === 3 && batch.node).map(batch => batch.node!));
  const blocking = answered.filter(route => route.consumers.some(consumer => nodes.some(node => node === consumer
    || relations.refines(node, consumer) || relations.refines(consumer, node))));
  if (!blocking.length) return null;
  return wait("group_transition", group[0]!.series.id, "answers",
    "The group's works acceptance waits for the accepted answers of its own blocking questions to be applied to B1",
    uniqueRefs([...blocking.map(route => route.answer!), ...group.map(row => reference(row.series))]), "dependent");
}
/**
 * G5.1: the wake step of the refused producer end — its proposal among this group's sources, while its choice is still
 * open and one more intent is lawful. The step names the ordinal it asks, so a failed first intent is a new request.
 */
function wakeStep(store: Store, project: string, results: WorkProposalSource[], refusal: Refusal, accepting: { series: Ref; attempt: number },
  dispatch: RunRequest["dispatch"], series: string): Choice | null {
  const work = refusal.at.field, connector = refusal.at.target;
  if (!work) return null;
  const proposal = take(producerProposal(store, project, results, work));
  if (!proposal) return null;
  const wake: WakeChoiceRequest = { project, proposal, work, connector, accepting, dispatch };
  const standing = take(wakeStanding(store, wake));
  return standing.next === null ? null : step("wake", { wake, ordinal: standing.next }, series, accepting.attempt);
}
/**
 * G6.1: the write-order step of the refused shared file — the exact proposals of the group's candidate and the file its
 * refusal names, while that choice is open and one more intent is lawful.
 */
function orderStep(store: Store, project: string, results: WorkProposalSource[], refusal: Refusal, accepting: { series: Ref; attempt: number },
  dispatch: RunRequest["dispatch"], series: string): Choice | null {
  const sources = ((refusal as Refusal & { findings?: { code: string; message: string }[] }).findings ?? []).find(row => row.code === "write_order_sources");
  if (!sources) return null;
  const order: WriteOrderRequest = { task: "write-order", project, proposals: JSON.parse(sources.message) as Ref[], path: refusal.at.target,
    results, accepting, dispatch };
  const standing = take(wakeStanding(store, order));
  return standing.next === null ? null : step("wake", { wake: order, ordinal: standing.next }, series, accepting.attempt);
}
/** LP5: the end of a remaining acceptance or confirmation by its common producer; an addressed refusal stays the wait. */
function finalizeStep(store: Store, project: string, binding: Sealed<Revision<CompletionOwner>>, phase: FinalizationPhase, series: string,
  ordinal: number): Choice {
  const request = { project, binding: reference(binding), phase };
  const prepared = prepareCompletionFinalization(store, request);
  if (!prepared.ok) return { wait: waitOf(prepared.refusal, project) };
  return step("finalize", request, series, ordinal);
}
/**
 * LP3 (№2817-4): the packet a root's cycle starts with — by its links, never by the order of the products: the one
 * materialized packet of the root that continues no earlier call and follows no earlier part. Its continuations and later
 * parts carry the same root and are steps of that cycle. A packet whose place is not proved, and two starts, are the
 * pass's addressed wait on that refusal, never a second dispatch and never a new packet (№2870).
 */
function completionPacketOf(store: Store, project: string, work: CompletionSnapshot, root: Ref): { packet: Ref | null } | Held {
  const packets: Ref[] = [];
  for (const product of work.products) {
    const record = store.get<{ root?: Ref; packet?: Ref }>(product.id, product.revision);
    if (record?.kind === "om-completion-packet" && record.value.root && sameRef(record.value.root, root) && record.value.packet) packets.push(record.value.packet);
  }
  const start = cycleStartOf(store, project, packets);
  return start.ok ? { packet: start.value } : { wait: waitOf(start.refusal, project) };
}
/** LP3 (№2876): the codes a cycle start is refused with — its own, or E2's reader's, marked with its source (Q2b). */
export type CycleStartCode = RunLocalCode | SourceCode<"question-packet">;
/**
 * LP3: the one packet among a root's materialized packets that starts its cycle, whatever their order; two are a refusal,
 * and so is the first packet (in the order of its exact reference) whose place E2's reader refuses (№2870).
 */
export function cycleStartOf(store: Store, project: string, packets: readonly Ref[]): OmResult<Ref | null, CycleStartCode> {
  const starts: Ref[] = [], seen = new Set<string>();
  for (const packet of [...packets].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0)) {
    if (seen.has(canonical(packet))) continue;
    seen.add(canonical(packet));
    const place = packetPlace(store, project, packet);
    if (!place.ok) return place;
    if (place.value === "start") starts.push(packet);
  }
  if (starts.length > 1) return refuse("run_record_invalid", "A root's cycle starts with exactly one packet",
    { unit: UNIT, target: starts[1]!.id, field: "packet", ref: starts[1]! }, "producer");
  return { ok: true, value: starts[0] ?? null };
}
/**
 * LP3 (№2870): a packet's place in its cycle, proved by its complete checked record — E2's own reader, the one E4
 * dispatches by: the start of a cycle, or a proved step of one (a continuation of an earlier call or a later part). Any
 * refusal of that reader — a missing, foreign or malformed record, an exact reference that does not match, links that do
 * not follow from their sources — is neither and stands as it is.
 */
function packetPlace(store: Store, project: string, packet: Ref): OmResult<"start" | "step", SourceCode<"question-packet">> {
  const read = readQuestionPacket(store, { project, record: packet });
  if (!read.ok) return read;
  const request = read.value.value.request;
  return { ok: true, value: !request.continuation && !request.correction && request.previous.length === 0 ? "start" : "step" };
}
/**
 * A saved cycle that is no work of the pass: never performed (no cycle of its exact request) and started with a packet
 * proved to be a step of a cycle. Whatever is not so proved — the start of a cycle, or any refusal of reading the packet —
 * is performed as saved, and its producer gives its own result or refusal (№2870).
 */
function misplacedCycle(store: Store, step: RunStep): boolean {
  if (step.action !== "cycle") return false;
  const request = step.request as { project?: unknown; packet?: unknown };
  if (typeof request.project !== "string" || !isRef(request.packet) || store.get(modelCycleId(step.request as never))) return false;
  const place = packetPlace(store, request.project, request.packet);
  return place.ok && place.value === "step";
}
/**
 * LP4 (№2887, №2902): a saved cycle never performed (no cycle of its exact request) whose root — the root of its packet's
 * batch in its exact attempt — is proved to have that cycle forbidden by a ceased step of its own: E4 refuses the cycle by
 * that cessation, and the choice ends the remaining work by its producer instead, by whichever cause comes first (a direct
 * cause of the root keeps its priority there). A packet that cannot be read, an attempt or root not found, a refused proof
 * or no such proof keeps the saved step, performed as it is.
 */
function ceasedCycle(store: Store, step: RunStep): boolean {
  if (step.action !== "cycle") return false;
  const request = step.request as { project?: unknown; packet?: unknown };
  if (typeof request.project !== "string" || !isRef(request.packet) || store.get(modelCycleId(step.request as never))) return false;
  const packet = readQuestionPacket(store, { project: request.project, record: request.packet });
  const attempt = packet.ok ? packet.value.value.request.attempt : null, batch = packet.ok ? packet.value.value.request.batch : null;
  if (!attempt || !batch) return false;
  const binding = readCompletionBinding(store, request.project, attempt.series, attempt.ordinal);
  const root = binding.ok && binding.value ? completionRootAssignments(binding.value).find(row => row.value.batch === batch) : undefined;
  if (!root) return false;
  const ground = ceasedCycleGround(store, request.project, reference(root));
  return ground.ok && ground.value !== null;
}
/**
 * The current M6 of a saved route's own D1 scope, tasks and catalog: the route itself while M6 still derives it, or its
 * explicit successor. An existing successor is followed; a missing one is the next step of the pass. Only the M6
 * producer decides currency (its own `route_stale`); any other refusal stands as it is.
 */
function currentRoutes(store: Store, project: string, saved: Ref): { routes: Ref } | { successor: RoutesRequest } | { wait: RunWait } {
  for (let at = saved; ;) {
    const record = take(readRoutes(store, { project, record: at })).record as unknown as Revision<RoutesRecord>;
    const request = routesRequest(record.value, record.value.request.previous);
    const prepared = prepareRoutes(store, request);
    if (prepared.ok) return { routes: at };
    if (prepared.refusal.code !== "route_stale") return { wait: waitOf(prepared.refusal, project) };
    const successor = routesRequest(record.value, at);
    const next = take(prepareRoutes(store, successor)).record;
    const written = store.get(next.id);
    if (!written) return { successor };
    at = reference(written);
  }
}
function routesRequest(record: RoutesRecord, previous: Ref | null): RoutesRequest {
  const saved = record.request;
  return { project: record.project, gaps: saved.gaps, tasks: saved.tasks.map(task => ({ record: task })) as RoutesRequest["tasks"],
    catalog: { paths: [...saved.catalog.paths], records: [...saved.catalog.records] }, previous };
}
/**
 * The G4b request of a block attempt: the whole D1 of its own scope and the current M6 of it (never another M6, №1737
 * п.9), with the fitting results of every attempt of that scope (№1749 п.1): this attempt's own E5 terminals (a supported
 * one by its accepted D5, a negative or technical one by the terminal itself) and assemblies, the results of the other
 * open attempts, and the accepted results of closed ones. One result per gap; the owner of each result stays its attempt.
 */
function answersRequest(store: Store, project: string, routes: Ref, members: readonly Member[], own: { series: string; ordinal: number },
  candidate: Ref | null) {
  const saved = take(readRoutes(store, { project, record: routes })).record as unknown as Revision<RoutesRecord>;
  const gaps = saved.value.request.gaps as unknown as GapReadRequest;
  const records = take(readGaps(store, gaps)).records, results: AnswerRouteResult[] = [], seen = new Set<string>();
  const mine = (row: Member) => row.series.id === own.series && row.ordinal === own.ordinal;
  const ordered = [...members.filter(mine), ...members.filter(row => !mine(row) && row.open), ...members.filter(row => !mine(row) && !row.open)];
  for (const member of ordered) {
    for (const product of member.work.products) {
      const terminal = store.get<AssessmentResultRecord>(product.id, product.revision);
      if (terminal?.kind !== ASSESSMENT_RESULT_KIND || (!member.open && !terminal.value.accepted)) continue;
      // The question of the E5 intent names its gap by target and field; the result belongs to that gap of this exact D1.
      const question = take(readAssessmentIntentAt(store, project, terminal.value.intent)).question;
      const gap = records.find(row => row.value.gap.target === question.target && row.value.gap.field === question.field);
      if (!gap) fail("record_missing", question.target, question.field, "An E5 terminal of this scope answers a gap of the checked D1", product);
      if (seen.has(gap.id)) continue;
      seen.add(gap.id);
      results.push({ gap: reference(gap), result: terminal.value.accepted ?? product, candidate: null });
    }
    if (!member.open) continue;
    // A fact gap whose MC1 call gave no fact candidates (off-form, awaiting-owner) is answered by that exact call: G4b
    // reads its own E4 technical or control outcome (H1.0c), never a missing answer.
    for (const batch of member.batches.filter(row => row.model === "MC1"))
      for (const item of batch.items as unknown as readonly (RouteBatch["items"][number] & { record: Ref })[]) {
        if (seen.has(item.record.id)) continue;
        const call = member.work.products.filter(ref => {
          const row = store.get<{ draftId?: string }>(ref.id, ref.revision);
          const packet = row?.kind === "model-call" && row.value.draftId ? store.get<{ request?: { batch?: string } }>(row.value.draftId) : null;
          return packet?.value.request?.batch === batch.id;
        }).sort((a, b) => b.revision - a.revision)[0];
        if (!call) continue;
        seen.add(item.record.id);
        results.push({ gap: item.record, result: call, candidate: null });
      }
    // Each node obligation of an MC2 batch is answered by the assembly that fills it; N2 names the common candidate.
    for (const batch of member.batches.filter(row => row.task === "node-expansion"))
      for (const item of batch.items as unknown as readonly (RouteBatch["items"][number] & { record: Ref })[]) {
        if (seen.has(item.record.id)) continue;
        const assembly = member.assemblies.find(row => row.level === batch.level && row.fills.includes(item.target));
        // A root that ended without assembly answers its gaps by its exact completed cycle (№1770 п.1).
        const negative = assembly ? null : member.negatives.find(row => row.batch === batch.id);
        if (!assembly && !negative) continue;
        seen.add(item.record.id);
        results.push(assembly ? { gap: item.record, result: assembly.record, candidate: batch.level === 2 ? candidate : null }
          : { gap: item.record, result: negative!.record, candidate: null });
      }
  }
  results.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  return { project, gaps, routes, results };
}

/**
 * The assemblies of the attempt's MC2 roots, with the level of their node proposal — and the LP5 reuses that answer a root
 * of this attempt by an earlier paid assembly: the reuse itself is the result, never the old assembly (№3278 §3).
 */
function assembliesOf(store: Store, project: string, work: CompletionSnapshot): { kind: "assembly" | "reuse"; record: Ref; proposal: Ref; level: 2 | 3; fills: string[] }[] {
  const rows: { kind: "assembly" | "reuse"; record: Ref; proposal: Ref; level: 2 | 3; fills: string[] }[] = [];
  for (const product of work.products) {
    const kind = store.get(product.id, product.revision)?.kind;
    if (kind !== "om-part-assembly" && kind !== COMPLETION_REUSE_KIND) continue;
    const read = kind === "om-part-assembly" ? take(readPartAssembly(store, { project, record: product })) : take(readReuseResult(store, { project, record: product }));
    const proposal = read.proposal as unknown as Revision<{ level: 2 | 3; fills: { obligation: string }[] }>;
    rows.push({ kind: kind === "om-part-assembly" ? "assembly" : "reuse", record: product, proposal: reference(proposal), level: proposal.value.level,
      fills: proposal.value.fills.map(fill => fill.obligation) });
  }
  return rows;
}
/** The gate of the latest evaluation of this check and its exact request: whether G4b passed there. */
/**
 * FA1: the full G4b of this attempt's complete check names one of its own E5 terminals that is technical — the assessor's
 * answer off-form or its call interrupted — and the attempt has no cause of its own besides: no semantic E5 verdict
 * (insufficient, conflicting) and no counted refusal. Such a cause is a lawful negative result, never a technical failure;
 * an attempt holding one keeps every earlier rule, and a mixed one is not paid again (return №3833).
 */
function technicalAssessmentFailure(store: Store, project: string, work: CompletionSnapshot): boolean {
  if (!work.answers?.complete || !work.answers.evaluation || work.negative.length || work.refusals.length) return false;
  const checked = passedGate(store, project, work.answers.evaluation);
  if (checked.passed) return false;
  const own = work.technical.map(row => row.source).filter(ref => {
    const terminal = store.get<AssessmentResultRecord>(ref.id, ref.revision);
    return terminal?.kind === ASSESSMENT_RESULT_KIND && (terminal.value.verdict === "off-form" || terminal.value.verdict === "interrupted");
  });
  return own.length > 0 && take(readAnswersGate(store, { project, record: checked.gate })).value.result.findings
    .some(finding => !!finding.at?.ref && own.some(ref => same(finding.at.ref, ref)));
}
function passedGate(store: Store, project: string, evaluation: Ref): { passed: boolean; request: AnswersGateRequest; gate: Ref } {
  const read = take(readAnswersEvaluationAt(store, project, evaluation));
  const ref = (read.record.value as unknown as { gate: Ref }).gate;
  const gate = take(readAnswersGate(store, { project, record: ref }));
  return { passed: gate.value.result.passed, request: gate.value.request as unknown as AnswersGateRequest, gate: ref };
}
/**
 * The grounds a full G4b proves for a question this product cannot answer (№1995 п.9), read from the gate's own trace and
 * never from the code of a wait: an MC1 answer of this very attempt that asked the owner (`mc1-technical`, outcome
 * awaiting-owner, its call among the attempt's products — with the diagnostic E4 saved), or a blocking gap of the owner or
 * of a kind that has no answer producer (`owner-*`, `unsupported-*`). A gap of a question anyone else may still answer
 * (`blocking-absent`) is no ground. `own` is the attempt whose calls may be named; without it only the gap grounds count.
 */
function provenQuestions(store: Store, project: string, gate: Ref, own: { binding: unknown; products: readonly Ref[] } | null): RunReason[] {
  const reasons: RunReason[] = [];
  for (const entry of take(readAnswersGateTrace(store, { project, record: gate })).trace) reasons.push(...groundOf(store, entry, gate, own));
  return reasons;
}
function groundOf(store: Store, entry: { finding: Refusal; cause: { emission: string; gap: Ref | null; sources: readonly { role: string; ref: Ref }[];
  detail: { outcome?: string | null } } }, gate: Ref | null, own: { binding: unknown; products: readonly Ref[] } | null): RunReason[] {
  const cause = entry.cause, gap = cause.gap ? [cause.gap] : [];
  if (cause.emission === "mc1-technical" && cause.detail.outcome === "awaiting-owner") {
    const call = cause.sources.find(source => source.role === "model-call")?.ref, diagnostic = cause.sources.find(source => source.role === "diagnostic")?.ref;
    if (!own || !call || !diagnostic || !own.products.some(product => sameRef(product, call))) return [];
    const checked = take(readManagedModelDiagnostic(store, own.binding as never, diagnostic));
    return [reasonOf("frame-need-owner", checked.request.code, entry.finding.at.target, "answer", checked.request.message,
      [...(gate ? [gate] : []), call, diagnostic, ...gap])];
  }
  if (!(NO_PRODUCER_EMISSIONS as readonly string[]).includes(cause.emission)) return [];
  return [reasonOf("unsupported-question", entry.finding.code, entry.finding.at.target, entry.finding.at.field ?? "answer", entry.finding.message, gap)];
}
/**
 * The blocking gaps of today's D1 for which no answer producer exists, when no attempt is open to have asked: the common
 * G4b over the machine bases without any result names them (`owner-absent`, `unsupported-absent`). A refusal of that
 * preparation is no ground — the pass then keeps its ordinary wait (№1995 п.9).
 */
function unansweredQuestions(store: Store, project: string, bases: Bases): RunReason[] {
  const gaps = bases.routes.value.request.gaps as unknown as GapReadRequest;
  const prepared = prepareAnswersGateTrace(store, { project, gaps, routes: bases.refs.routes, results: [] });
  if (!prepared.ok) return [];
  return prepared.value.trace.filter(entry => NO_PRODUCER_EMISSIONS.includes(entry.cause.emission))
    .flatMap(entry => groundOf(store, entry as never, null, null));
}
/** The obligations the attempt declared at a level: the items of its node-expansion batches (goal questions `fill`). */
function obligationsOf(batches: readonly RouteBatch[], level: 2 | 3): string[] {
  return [...new Set(batches.filter(batch => batch.task === "node-expansion" && batch.level === level).flatMap(batch => batch.items.map(item => item.target)))].sort();
}
/**
 * The D7 ledger a works packet is asked with: the D2 lines of the exact D1 scope (a new pass if the latest lines are of
 * another scope) and the D7 derived from them. The owner's gap assignments are not invented: without them D7 refuses,
 * and the refusal is the addressed wait.
 */
function worksLedger(store: Store, project: string, scope: GapReadRequest):
{ step: RunStep } | { wait: RunWait; final?: RunReason } | { works: { producer: Ref; ledger: Ref } } {
  // D7 is admitted on the CURRENT line history: its head when that head is of this exact scope, otherwise a new pass of
  // the scope. An older revision of the same scope is history, never the basis of a new step (it would stand stale forever).
  const lines = currentLinesOf(store, project, scope);
  if (!lines) return linesStep(store, project, scope, null, null);
  const obligations = { project, gaps: scope, lines, assignments: [] };
  const prepared = prepareOmObligations(store, obligations);
  if (!prepared.ok) {
    const proof = prepared.refusal.code === "obligation_assignment_unresolved" ? lateGap(store, scope, prepared.refusal, lines) : null;
    return { wait: waitOf(prepared.refusal, project), ...(proof ? { final: proof } : {}) };
  }
  if (prepared.value.writes.length) return step("obligations", obligations) as { step: RunStep };
  return { works: { producer: refOf(prepared.value.producer), ledger: refOf(prepared.value.record) } };
}

/**
 * A late gap of the exact D1 scope that D7 refuses to assign (№1995 п.9): the refusal alone proves nothing — the gap it
 * names must be a gap of this scope whose moment is not the pass itself. No assignment is invented for it. The Refs are
 * the D1 record of the gap and the D2 lines the ledger was derived on, so the same gap reads as one ground.
 */
function lateGap(store: Store, scope: GapReadRequest, refusal: Refusal, lines: Ref): RunReason | null {
  const read = readGaps(store, scope);
  if (!read.ok) return null;
  const row = read.value.records.find(item => item.value.gap.target === refusal.at.target && item.value.gap.field === refusal.at.field
    && item.value.gap.moment !== "om-pass");
  return row ? reasonOf("late-obligation", refusal.code, refusal.at.target, refusal.at.field ?? "assignment", refusal.message, [reference(row), lines]) : null;
}

// ---- M7: the frame transitions of a block attempt (rows 7, 25; №1737 п.12). ----

/** The G4b admission and the frame acceptance it admits, saved together before either is written. */
interface AcceptRequest { gate: AnswersGateRequest; settle: SettleCandidateRequest }
interface WorksRequest { gate: AnswersGateRequest; works: WorksAcceptanceRequest }
/**
 * Passed G4b admits the next M7 transition: the CURRENT G4b (never the old passed of a restart) and the acceptance are
 * prepared by their producers and written in one guarded transaction. An acceptance already made for this candidate and
 * binding is found again, never made twice.
 */
function acceptFrame(store: Store, project: string, request: AcceptRequest): RunResult<Ref[]> {
  const found = acceptedFrame(store, project, request.settle.level, request.settle.candidate, request.settle.binding ?? null);
  if (found) return { ok: true, value: [found.frame] };
  const admitted = prepareAnswersGate(store, request.gate);
  if (!admitted.ok) return admitted;
  if (!admitted.value.record.value.result.passed) return refuse("answers_not_passed", "The current G4b does not pass; no M7 transition is admitted",
    { unit: UNIT, target: admitted.value.record.id, field: "result", ref: refOf(admitted.value.record) }, "producer");
  const settled = prepareSettleCandidate(store, request.settle);
  if (!settled.ok) return settled;
  const written = writeGuarded(store, { unit: UNIT, target: `om-frame:${project}:${request.settle.level}`,
    writes: [...admitted.value.writes, ...settled.value.writes], guards: uniqueTransactionGuards([...admitted.value.guards, ...settled.value.guards]) });
  if (!written.ok) return written;
  const frame = written.value.find(row => row.id === `om-frame:${project}:${request.settle.level}`);
  return frame ? { ok: true, value: [refOf(frame)] } : refuse("record_missing", "The acceptance wrote no frame", { unit: UNIT, target: project, field: "frame" }, "producer");
}
/** L3: the current G4b with the one works acceptance of C4/F7/G5/C5 (atomic-gate), in one guarded transaction. */
function acceptWorks(store: Store, request: WorksRequest): RunResult<Ref[]> {
  const prepared = prepareWorksAcceptance(store, request.works);
  if (!prepared.ok) return prepared;
  const product = (): Ref[] => [prepared.value.acceptance ? refOf(prepared.value.acceptance.frame as Revision<unknown>) : refOf(prepared.value.record)];
  if (!prepared.value.writes.length) return { ok: true, value: product() };
  const admitted = prepareAnswersGate(store, request.gate);
  if (!admitted.ok) return admitted;
  if (!admitted.value.record.value.result.passed) return refuse("answers_not_passed", "The current G4b does not pass; no M7 transition is admitted",
    { unit: UNIT, target: admitted.value.record.id, field: "result", ref: refOf(admitted.value.record) }, "producer");
  const written = writeGuarded(store, { unit: UNIT, target: prepared.value.record.id,
    writes: [...admitted.value.writes, ...prepared.value.writes], guards: uniqueTransactionGuards([...admitted.value.guards, ...prepared.value.guards]) });
  if (!written.ok) return written;
  return { ok: true, value: product() };
}
/** One common acceptance of a frame: its accepted frame revision, the exact accepted request and the binding it carries. */
interface Accepted { frame: Ref; acceptance: AcceptedFrameRequest; binding: FrameAttemptBinding | null }
/** The accepted frame revision of this exact candidate (and binding, if named), if C5 already made it. */
function acceptedFrame(store: Store, project: string, level: 2 | 3, candidate: Ref, binding: FrameAttemptBinding | null): Accepted | null {
  for (const row of store.history(`om-frame:${project}:${level}`)) {
    const acceptance = (row.value as { acceptance?: { candidate?: Ref; binding?: FrameAttemptBinding | null } }).acceptance;
    if (acceptance?.candidate && same(acceptance.candidate, candidate)
      && (binding === null || acceptance.binding && acceptance.binding.series.id === binding.series.id && acceptance.binding.ordinal === binding.ordinal)) {
      const read = take(readAcceptedFrameLayer(store, { project, level, frame: reference(row) }));
      return { frame: reference(row), binding: acceptance.binding ?? null, acceptance: { project, level,
        graph: reference(read.graph), layer: reference(read.layer), frame: reference(read.frame) } };
    }
  }
  return null;
}
/** The D2 snapshot over exactly this D1 scope, wherever it stands in the D2 history. */
const sortedRefs = (refs: readonly Ref[]) => [...refs].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const ofScope = (row: Revision<GapLinesRecord>, scope: GapReadRequest): boolean =>
  same(row.value.request.gaps.sources, scope.sources) && same(sortedRefs(row.value.request.gaps.records), sortedRefs(scope.records));
/** Whether a D2 snapshot of this exact scope was ever written: a fact of the history, not a basis for new work. */
function linesOf(store: Store, project: string, scope: GapReadRequest): Ref | null {
  for (const row of store.history<GapLinesRecord>(gapLinesId(project))) if (ofScope(row, scope)) return reference(row);
  return null;
}
/** The current line history when its head is of this exact scope; the basis a new D7 admission may stand on. */
function currentLinesOf(store: Store, project: string, scope: GapReadRequest): Ref | null {
  const head = store.get<GapLinesRecord>(gapLinesId(project));
  return head && ofScope(head, scope) ? reference(head) : null;
}
function linesStep(store: Store, project: string, scope: GapReadRequest, series: string | null, attempt: number | null): { step: RunStep } {
  const latest = store.get<GapLinesRecord>(gapLinesId(project));
  return step("lines", { project, previous: latest ? reference(latest) : null, pass: (latest?.value.request.pass ?? 0) + 1,
    gaps: scope, closures: [] }, series, attempt);
}
/** The D2 event that confirmed the goal of this exact attempt (№1749 п.4–6). */
function confirmationOf(store: Store, project: string, series: string, ordinal: number): Ref | null {
  for (const row of store.history<GapLinesRecord>(gapLinesId(project)))
    if (row.value.request.closures.some(item => item.attempt?.series.id === series && item.attempt.attempt === ordinal)) return reference(row);
  return null;
}
/** The current machine D1 (of the named routes) when its frame at this level is exactly this acceptance. */
function ownersScope(store: Store, project: string, routes: Ref, acceptance: AcceptedFrameRequest, level: 2 | 3): GapReadRequest | null {
  const read = readRoutes(store, { project, record: routes });
  if (!read.ok) return null;
  const gaps = (read.value.record.value as unknown as RoutesRecord).request.gaps as unknown as GapReadRequest;
  const source = (level === 2 ? gaps.sources.operations : gaps.sources.works) as unknown as { frame?: { graph: Ref; layer: Ref | null; frame: Ref | null } };
  const frame = source.frame;
  return frame && frame.layer && frame.frame && same(frame.graph, acceptance.graph) && same(frame.layer, acceptance.layer)
    && same(frame.frame, acceptance.frame) && same(gaps.sources.graph, acceptance.graph) ? gaps : null;
}
/** The current D1 request with the exact accepted frame at its level: the same input, horizon and other sources. */
const uniqueRefs = (refs: readonly Ref[]): Ref[] => refs.filter((ref, index, all) => all.findIndex(other => same(other, ref)) === index)
  .sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
interface Member { series: Sealed<Revision<AnyRepairSeries>>; ordinal: number; open: boolean; work: CompletionSnapshot; batches: RouteBatch[];
  level: 2 | 3 | null; assemblies: ReturnType<typeof assembliesOf>; negatives: Negative[] }
/** A completed MC2 root cycle without assembly: its exact cycle and the batch of its root packet (№1770 ось A). */
interface Negative { record: Ref; batch: string }
function negativesOf(store: Store, project: string, work: CompletionSnapshot): Negative[] {
  const rows: Negative[] = [];
  for (const product of work.products) {
    if (store.get(product.id, product.revision)?.kind !== "om-model-cycle") continue;
    const cycle = take(readModelCycle(store, { project, record: product })).record.value;
    if (cycle.terminal === "assembled" || cycle.diagnostic === null) continue;
    const packet = store.get<{ request: { batch: string | null } }>(cycle.request.packet.id, cycle.request.packet.revision);
    if (packet?.value.request.batch) rows.push({ record: product, batch: packet.value.request.batch });
  }
  return rows;
}
/** Every managed block attempt of the current lines planned on exactly this D1 scope, open or closed, read by its readers. */
function scopeAttempts(store: Store, project: string, scope: GapReadRequest): Member[] {
  const members: Member[] = [];
  for (const line of projectSeries(store, project)) {
    if (!("block" in line.value)) continue;
    for (const attempt of line.value.attempts) {
      const binding = take(readCompletionBinding(store, project, reference(line), attempt.ordinal));
      if (!binding) continue;
      const plan = take(readRoutes(store, { project, record: binding.value.plan.routes })).record as unknown as Revision<RoutesRecord>;
      if (!same(plan.value.request.gaps, scope)) continue;
      const head = store.get<CompletionWork>(completionWorkId(project, binding.id));
      if (!head) fail("record_missing", completionWorkId(project, binding.id), "work", "A managed attempt keeps its registry");
      const work = take(readCompletionWorkAt(store, project, reference(head))) as CompletionSnapshot;
      const batches = plan.value.batches.filter(row => binding.value.plan.batches.includes(row.id));
      const expands = (level: 2 | 3) => batches.some(row => row.task === "node-expansion" && row.level === level);
      members.push({ series: line, ordinal: attempt.ordinal, open: attempt.outcome === null, work, batches,
        level: expands(2) ? 2 : expands(3) ? 3 : null, assemblies: assembliesOf(store, project, work),
        negatives: negativesOf(store, project, work) });
    }
  }
  return members;
}

// ---- The end of the pass: M8 → M9 → the existing compiler (row 27; №1737 п.13–14). ----

/**
 * The pass ends only on accepted subject products: the accepted works frame, a ready M8 for it, the M9 stage for that
 * M8 and the compilation of the existing compiler. A saved M8 ready=false is the addressed wait with its findings and is
 * not repeated; a pilot boundary or missing protections stay addressed waits of the next action.
 */
function completion(store: Store, request: RunRequest): Next | { complete: Ref[] } | null {
  const project = request.project, works = store.get(`om-frame:${project}:3`);
  if (!works) return null;
  const layer = take(readAcceptedFrameLayer(store, { project, level: 3, frame: reference(works) }));
  const accepted = { graph: reference(layer.graph), layer: reference(layer.layer), frame: reference(layer.frame) };
  const saved = store.get<OmFeasibility>(`om-feasibility:${project}`);
  const check = { project, ...accepted, environment: request.dispatch.config, expected: saved?.revision ?? 0 };
  if (!saved) return step("feasibility", check);
  // №1737 п.14, №1766 п.2: the saved M8 is read historically; whether it still stands is today's common M8
  // admission over the current repository and environment. An unchanged check writes nothing and its saved finding
  // stands; a changed basis (the findings fixed, or new ones) is a new M8 step on the saved revision.
  const admission = prepareFeasibility(store, check);
  if (!admission.ok) return { wait: waitOf(admission.refusal, project) };
  if (admission.value.writes.length) return step("feasibility", check);
  const m8 = take(readFeasibility(store, { project, record: reference(saved) }));
  if (!m8.value.ready) return wait("feasibility_not_ready", m8.id, "ready",
    `M8 found the horizon not feasible: ${m8.value.findings.map(item => item.code).join(", ")}; the door is fixing these grounds`, [reference(m8)]);
  const stage = store.get<{ status: string; content: { feasibility?: Ref } }>(stageId(project, "om-g2"));
  const handed = stage && stage.value.status === "accepted" && stage.value.content.feasibility && same(stage.value.content.feasibility, reference(m8)) ? stage : null;
  if (!handed) return step("handoff", { project, feasibility: reference(m8), expected: stage?.revision ?? 0 });
  const compiled = store.get<{ status: string; content: { plan?: Ref } }>(stageId(project, "compilation"));
  const plan = compiled?.value.content.plan ? store.get<{ feasibility?: Ref }>(compiled.value.content.plan.id, compiled.value.content.plan.revision) : null;
  if (!compiled || compiled.value.status !== "accepted" || !plan?.value.feasibility || !same(plan.value.feasibility, reference(m8)))
    return step("compile", { project, feasibility: reference(m8), handoff: reference(handed) });
  return { complete: [reference(m8), reference(handed), reference(compiled)] };
}

export function isRunCode(code: string): code is RunCode { return (RUN_CODES as readonly string[]).includes(code); }
