import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { tokenUsage, type TokenUsage } from "../runtime/model-usage.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Sealed } from "./refusal.js";
import { readStopContext, readOriginHoldAt } from "./repeat-gate.js";
import { writeGuarded } from "./refs.js";
import { withHistoricalReads } from "./input.js";
import {
  prepareSeriesLineAdmission, readMechanismAdmission, readMechanismAnalysisAdmission, seriesRequestOf,
  type AttemptGoal, type MechanismAdmission, type SeriesOwner,
} from "./series.js";

/** G8's durable boundary: admission and accounting exist before a paid dispatch can start. */
const UNIT = "gate-admit";

export const CALL_RECORD_KIND = "call-record";
export const CALL_LEDGER_KIND = "om-call-ledger";
export const CALL_SETTLEMENT_STATUSES = Object.freeze(["succeeded", "failed"] as const);
export type CallSettlementStatus = typeof CALL_SETTLEMENT_STATUSES[number];
export type CallStatus = "open" | CallSettlementStatus;
export const CALL_PURPOSES = Object.freeze([
  "model-research", "model-design", "stop-analysis", "origin-analysis",
] as const);
export type CallPurpose = typeof CALL_PURPOSES[number];

// Every refusal introduced by this unit. Refusals from writeGuarded (input_stale and revision_conflict) retain A1's
// codes because callers already handle that shared transaction contract.
export const CALL_RECORD_CODES = Object.freeze([
  "call_request_invalid", "call_question_missing", "call_question_invalid",
  "call_goal_missing", "call_goal_invalid", "call_goal_conflict", "call_series_unresolved",
  "call_purpose_invalid", "call_basis_invalid", "call_basis_unresolved",
  "dispatch_contract_invalid", "dispatch_contract_unresolved", "packet_invalid",
  "call_identity_conflict", "call_record_invalid", "ledger_invalid", "call_unresolved",
  "settlement_status_invalid", "settlement_conflict", "usage_invalid",
] as const);
export type CallRecordCode = typeof CALL_RECORD_CODES[number];

/** One concrete question address. Repeating an id for two consumers keeps two rows (T6). */
export interface AddressedGap {
  readonly id: string;
  readonly goal: string;
  readonly field: string;
  readonly consumer: string;
}

/** The exact adapter and configuration a later dispatch must use. */
export type MechanismCallOwner = Extract<SeriesOwner, { kind: "mechanism" }>;

export interface MechanismAddressedGap extends Omit<AddressedGap, "consumer"> {
  readonly consumer: MechanismCallOwner;
}

export interface DispatchContract {
  readonly adapter: Ref;
  readonly config: Ref;
}

export interface PacketFingerprint {
  readonly hash: string;
  readonly chars: number;
  readonly bytes: number;
}

export interface SeriesStopBasis {
  readonly kind: "series-stop";
  readonly series: Ref;
  readonly attempt: number;
}

export interface OriginHoldBasis {
  readonly kind: "origin-hold";
  readonly hold: Ref;
}

export type CallBasis = SeriesStopBasis | OriginHoldBasis;

export interface RecordCallRequest {
  readonly call: string;
  readonly purpose: CallPurpose;
  readonly basis: CallBasis | null;
  readonly block: string;
  readonly gaps: readonly AddressedGap[];
  readonly series: Ref;
  readonly attempt: number;
  readonly goal: AttemptGoal;
  readonly dispatch: DispatchContract;
  /** The complete packet E2 built. E1 stores its canonical fingerprint, never a caller-supplied digest. */
  readonly packet: Json;
}

export interface MechanismRecordCallRequest extends Omit<RecordCallRequest, "block" | "gaps"> {
  readonly block?: never;
  readonly owner: MechanismCallOwner;
  readonly admission: Sealed<MechanismAdmission>;
  readonly gaps: readonly MechanismAddressedGap[];
}
export type AnyRecordCallRequest = RecordCallRequest | MechanismRecordCallRequest;

export interface CallRecord {
  readonly call: string;
  readonly purpose: CallPurpose;
  readonly basis: CallBasis | null;
  readonly projectId: string;
  readonly block: string;
  readonly gaps: readonly AddressedGap[];
  readonly series: Ref;
  readonly attempt: number;
  readonly goal: AttemptGoal;
  readonly dispatch: DispatchContract;
  readonly packet: PacketFingerprint;
  readonly openedAt: number;
  readonly status: CallStatus;
  readonly usage: TokenUsage | null;
  readonly settledAt: number | null;
}

export interface MechanismCallRecord extends Omit<CallRecord, "block" | "gaps"> {
  readonly block?: never;
  readonly owner: MechanismCallOwner;
  readonly admission: Sealed<MechanismAdmission>;
  readonly gaps: readonly MechanismAddressedGap[];
}
export type AnyCallRecord = CallRecord | MechanismCallRecord;
type AnyAddressedGap = Omit<AddressedGap, "consumer"> & { readonly consumer: string | MechanismCallOwner };

/** A report row copies the address and outcome needed by E6, while its exact call ref remains the single source. */
export interface CallLedgerEntry {
  readonly call: Ref;
  readonly name: string;
  readonly purpose: CallPurpose;
  readonly basis: CallBasis | null;
  readonly block: string;
  readonly gaps: readonly AddressedGap[];
  readonly series: Ref;
  readonly attempt: number;
  readonly goal: AttemptGoal;
  readonly status: CallStatus;
  readonly usage: TokenUsage | null;
  readonly openedAt: number;
  readonly settledAt: number | null;
}

export interface MechanismCallLedgerEntry extends Omit<CallLedgerEntry, "block" | "gaps"> {
  readonly block?: never;
  readonly owner: MechanismCallOwner;
  readonly admission: Sealed<MechanismAdmission>;
  readonly gaps: readonly MechanismAddressedGap[];
}
export type AnyCallLedgerEntry = CallLedgerEntry | MechanismCallLedgerEntry;

export interface CallLedger {
  readonly projectId: string;
  readonly calls: readonly AnyCallLedgerEntry[];
}

export interface RecordedCall<T extends AnyCallRecord = AnyCallRecord> {
  readonly call: Revision<T>;
  readonly ledger: Revision<CallLedger>;
  readonly repeated: boolean;
}

export interface SettledCall extends RecordedCall {
  readonly settled: boolean;
}

const REQUEST_KEYS = Object.freeze(["attempt", "basis", "block", "call", "dispatch", "gaps", "goal", "packet", "purpose", "series"] as const);
const MECHANISM_REQUEST_KEYS = [...REQUEST_KEYS.filter(key => key !== "block"), "owner", "admission"];
const GAP_KEYS = Object.freeze(["consumer", "field", "goal", "id"] as const);
const GOAL_KEYS = Object.freeze(["key", "questions", "result"] as const);
const DISPATCH_KEYS = Object.freeze(["adapter", "config"] as const);
const REF_KEYS = Object.freeze(["hash", "id", "revision"] as const);
const FINGERPRINT_KEYS = Object.freeze(["bytes", "chars", "hash"] as const);
const STOP_BASIS_KEYS = Object.freeze(["attempt", "kind", "series"] as const);
const HOLD_BASIS_KEYS = Object.freeze(["hold", "kind"] as const);
const CALL_KEYS = Object.freeze([
  "attempt", "basis", "block", "call", "dispatch", "gaps", "goal", "openedAt", "packet", "projectId",
  "purpose", "series", "settledAt", "status", "usage",
] as const);
const LEDGER_KEYS = Object.freeze(["calls", "projectId"] as const);
const LEDGER_ENTRY_KEYS = Object.freeze([
  "attempt", "basis", "block", "call", "gaps", "goal", "name", "openedAt", "purpose", "series", "settledAt", "status", "usage",
] as const);
const mechanismKeys = (keys: readonly string[]): readonly string[] => [...keys.filter(key => key !== "block"), "owner", "admission"];
const MECHANISM_CALL_KEYS = mechanismKeys(CALL_KEYS);
const MECHANISM_LEDGER_ENTRY_KEYS = mechanismKeys(LEDGER_ENTRY_KEYS);

type CheckedRequest = (Omit<RecordCallRequest, "packet"> | Omit<MechanismRecordCallRequest, "packet">) & {
  readonly packet: PacketFingerprint;
};

interface CheckedLedger {
  readonly record: Revision<CallLedger>;
  readonly guards: readonly Ref[];
}

export function callRecordId(project: string, call: string): string {
  requireCondition(validProject(project) && isText(call), "call_request_invalid", "A call id needs a project and a non-empty call name");
  return `${callRecordNamespace(project)}${hashJson(call)}`;
}

function callRecordNamespace(project: string): string {
  return `${CALL_RECORD_KIND}:${project}:`;
}

export function callLedgerId(project: string): string {
  requireCondition(validProject(project), "call_request_invalid", "A call ledger belongs to one named project");
  return `${CALL_LEDGER_KIND}:${project}`;
}

/** Reads one exact historical call revision without admitting a dispatch or consulting later source heads. */
export interface CallHistory { readonly journal: Ref }
export function readCall(store: Store, project: string, ref: Ref, history?: CallHistory): OmResult<Sealed<Revision<AnyCallRecord>>> {
  requireCondition(history === undefined || (isPlainObject(history) && exactKeys(history, ['journal']) && isRef(history.journal)),
    'call_request_invalid', 'Historical call context needs its exact journal');
  return withHistoricalReads(() => readCallInScope(store, project, ref, history));
}
function readCallInScope(store: Store, project: string, ref: Ref, history?: CallHistory): OmResult<Sealed<Revision<AnyCallRecord>>> {
  requireCondition(store instanceof Store, "call_request_invalid", "A call is read through a store");
  if (!validProject(project)) return problem("call_request_invalid", "A call belongs to one named project without a namespace separator", "call", "project");
  if (!exactReference(ref)) return problem("call_unresolved", "A call is read by an exact reference", targetOf(ref), "call");
  const namespace = callRecordNamespace(project);
  if (!ref.id.startsWith(namespace) || !/^[a-f0-9]{64}$/.test(ref.id.slice(namespace.length))) {
    return problem("call_unresolved", "The call reference belongs to this project's call namespace", ref.id, "call", "producer", ref);
  }
  const record = store.get<AnyCallRecord>(ref.id, ref.revision);
  if (!record || record.id !== ref.id || record.revision !== ref.revision || record.hash !== ref.hash || record.kind !== CALL_RECORD_KIND) {
    return problem("call_unresolved", "No call record stands at this exact reference", ref.id, "call", "producer", ref);
  }
  return checkedCall(store, record, project, ref.id, history);
}

/**
 * Authorizes a NEW process launch using the same purpose-specific admission as recordCall. The transport includes
 * these guards in its launch transaction; saved-response replay and settlement use historical readCall instead.
 */
export function prepareCallDispatch(
  store: Store, project: string, callRef: Ref,
): OmResult<Sealed<{ readonly call: Revision<AnyCallRecord>; readonly guards: readonly Ref[] }>> {
  return withHistoricalReads(() => {
    const read = readCallInScope(store, project, callRef);
    if (!read.ok) return read;
    const head = store.get(callRef.id);
    if (read.value.value.status !== "open" || !head || !sameRef(reference(head), callRef))
      return problem("call_unresolved", "A new dispatch requires the exact open call head", callRef.id, "call", "producer", callRef);
    const dispatch = resolveDispatch(store, read.value.value.dispatch, callRef.id);
    if (!dispatch.ok) return dispatch;
    const series = resolveSeries(store, project, read.value.value, callRef.id);
    if (!series.ok) return series;
    return delivered({ call: read.value, guards: uniqueRefs([callRef, ...dispatch.value, ...series.value]) });
  });
}

/**
 * Records the call and its project-ledger row in one guarded transaction before dispatch.
 * The running series, adapter and configuration are all guarded heads: a change in the read/write window admits
 * nothing. A late repeat finds the already admitted identity and never re-validates it against later heads (T5).
 */
export function recordCall(store: Store, project: string, request: RecordCallRequest, extraGuards?: readonly TransactionGuard[]): OmResult<Sealed<RecordedCall<CallRecord>>>;
export function recordCall(store: Store, project: string, request: MechanismRecordCallRequest, extraGuards?: readonly TransactionGuard[]): OmResult<Sealed<RecordedCall<MechanismCallRecord>>>;
export function recordCall(store: Store, project: string, request: AnyRecordCallRequest, extraGuards?: readonly TransactionGuard[]): OmResult<Sealed<RecordedCall>>;
export function recordCall(store: Store, project: string, request: AnyRecordCallRequest,
  extraGuards: readonly TransactionGuard[] = []): OmResult<Sealed<RecordedCall>> {
  return withHistoricalReads(() => recordCallInScope(store, project, request, extraGuards));
}
function recordCallInScope(store: Store, project: string, request: AnyRecordCallRequest,
  extraGuards: readonly TransactionGuard[]): OmResult<Sealed<RecordedCall>> {
  requireCondition(store instanceof Store, "call_request_invalid", "A call is recorded through a store");
  if (!validProject(project)) return problem("call_request_invalid", "A call belongs to one named project without a namespace separator", String(project), "project");
  extraGuards = uniqueTransactionGuards(extraGuards);
  const checked = checkRequest(project, request);
  if (!checked.ok) return checked;

  const id = callRecordId(project, checked.value.call);
  const standing = store.get<AnyCallRecord>(id);
  if (standing) {
    const valid = checkedCall(store, standing, project, id);
    if (!valid.ok) return valid;
    if (hashJson(identityOf(valid.value.value)) !== hashJson(identityFrom(project, checked.value))) {
      return problem("call_identity_conflict", "This call name already belongs to different content or a different exact source",
        id, "call", "producer", reference(valid.value));
    }
    const ledger = checkedLedger(store, project);
    if (!ledger.ok) return ledger;
    if (ledger.value === null || !ledger.value.record.value.calls.some(row => sameRef(row.call, reference(valid.value)))) {
      return problem("ledger_invalid", "An admitted call has no matching row in the project's one ledger", callLedgerId(project), "calls");
    }
    return delivered({ call: valid.value, ledger: ledger.value.record, repeated: true });
  }

  const dispatch = resolveDispatch(store, checked.value.dispatch, id);
  if (!dispatch.ok) return dispatch;
  const series = resolveSeries(store, project, checked.value, id);
  if (!series.ok) return series;
  const ledger = checkedLedger(store, project);
  if (!ledger.ok) return ledger;

  const openedAt = Date.now();
  const value: AnyCallRecord = {
    call: checked.value.call, purpose: checked.value.purpose, basis: copyBasis(checked.value.basis),
    projectId: project, ...ownerFields(checked.value),
    gaps: checked.value.gaps, series: exactRef(checked.value.series), attempt: checked.value.attempt,
    goal: copyGoal(checked.value.goal), dispatch: copyDispatch(checked.value.dispatch), packet: { ...checked.value.packet },
    openedAt, status: "open", usage: null, settledAt: null,
  } as AnyCallRecord;
  const pending: Ref = { id, revision: 1, hash: hashJson(value) };
  const row = rowOf(pending, value);
  const ledgerValue: CallLedger = {
    projectId: project,
    calls: orderedRows([...(ledger.value?.record.value.calls ?? []), row]),
  };
  const ledgerGuards = (ledger.value?.guards ?? []) as unknown as readonly Ref[];
  const dispatchGuards = dispatch.value as unknown as readonly Ref[];
  const seriesGuards = series.value as unknown as readonly Ref[];
  const written = writeGuarded(store, {
    unit: UNIT, target: id,
    writes: [
      { id, kind: CALL_RECORD_KIND, expected: 0, value },
      { id: callLedgerId(project), kind: CALL_LEDGER_KIND, expected: ledger.value?.record.revision ?? 0, value: ledgerValue },
    ],
    guards: uniqueTransactionGuards([
      checked.value.series, checked.value.dispatch.adapter, checked.value.dispatch.config,
      ...ledgerGuards, ...dispatchGuards, ...seriesGuards, ...extraGuards,
    ]),
  });
  if (!written.ok) return written;
  const call = written.value.find(record => record.id === id);
  const savedLedger = written.value.find(record => record.id === callLedgerId(project));
  requireCondition(call !== undefined && savedLedger !== undefined, "call_write_invalid", "The atomic call transaction returned both records it wrote");
  return delivered({
    call: call as unknown as Revision<AnyCallRecord>,
    ledger: savedLedger as unknown as Revision<CallLedger>, repeated: false,
  });
}

/**
 * Closes one admitted call once. Unknown usage is an explicit no-op that leaves it open; a known usage and status move
 * the call and its ledger row together. No total is compared with a budget or used to interrupt an answer.
 */
export function settleCall(
  store: Store, call: Ref, usageInput: TokenUsage | null, status: CallSettlementStatus,
): OmResult<Sealed<SettledCall>> {
  return withHistoricalReads(() => settleCallInScope(store, call, usageInput, status));
}
function settleCallInScope(
  store: Store, call: Ref, usageInput: TokenUsage | null, status: CallSettlementStatus,
): OmResult<Sealed<SettledCall>> {
  requireCondition(store instanceof Store, "settlement_request_invalid", "A call is settled through a store");
  if (!exactReference(call)) return problem("call_unresolved", "A settlement names the call by an exact reference", targetOf(call), "call");
  if (!CALL_SETTLEMENT_STATUSES.includes(status)) {
    return problem("settlement_status_invalid", "A settlement records whether the provider succeeded or failed", call.id, "status");
  }
  if (usageInput === undefined) {
    return problem("usage_invalid", "Unknown usage is explicit null; an absent usage is not an unknown one", call.id, "usage");
  }
  const usage = checkedUsage(usageInput, call.id);
  if (!usage.ok) return usage;

  const named = store.get<AnyCallRecord>(call.id, call.revision);
  if (!named || named.hash !== call.hash || named.kind !== CALL_RECORD_KIND) {
    return problem("call_unresolved", "No call record stands at the exact reference being settled", call.id, "call", "producer", call);
  }
  const current = store.get<AnyCallRecord>(call.id);
  if (!current || current.kind !== CALL_RECORD_KIND) {
    return problem("call_unresolved", "The admitted call has no current call-record head", call.id, "call", "producer", call);
  }
  const body = isPlainObject(current.value)
    ? current.value as unknown as Record<string, unknown>
    : null;
  if (body === null || !validProject(body['projectId'])) {
    return problem("call_record_invalid", "The stored call record names the project it belongs to", call.id,
      "projectId", "producer", reference(current));
  }
  const valid = checkedCall(store, current, body['projectId'], call.id);
  if (!valid.ok) return valid;
  const namedValid = checkedCall(store, named, valid.value.value.projectId, call.id);
  if (!namedValid.ok) return namedValid;
  const ledger = checkedLedger(store, valid.value.value.projectId);
  if (!ledger.ok) return ledger;
  if (ledger.value === null) return problem("ledger_invalid", "The admitted call has no project ledger", callLedgerId(valid.value.value.projectId), "ledger");
  const position = ledger.value.record.value.calls.findIndex(row => row.call.id === call.id);
  if (position < 0 || !sameRef(ledger.value.record.value.calls[position]!.call, reference(valid.value))) {
    return problem("ledger_invalid", "The current call head and its ledger row do not name each other", ledger.value.record.id, "calls");
  }

  if (valid.value.value.status !== "open") {
    if (usage.value !== null && status === valid.value.value.status && hashJson(usage.value) === hashJson(valid.value.value.usage)) {
      return delivered({ call: valid.value, ledger: ledger.value.record, repeated: true, settled: true });
    }
    return problem("settlement_conflict", "A settled call keeps its first actual usage and status", call.id, "usage", "producer", reference(valid.value));
  }
  if (usage.value === null) {
    return delivered({ call: valid.value, ledger: ledger.value.record, repeated: false, settled: false });
  }

  const settledAt = Math.max(Date.now(), valid.value.value.openedAt);
  const value: AnyCallRecord = { ...valid.value.value, status, usage: usage.value, settledAt };
  const nextRef: Ref = { id: valid.value.id, revision: valid.value.revision + 1, hash: hashJson(value) };
  const calls = ledger.value.record.value.calls.map((row, index) => index === position ? rowOf(nextRef, value) : row);
  const ledgerValue: CallLedger = { projectId: valid.value.value.projectId, calls: orderedRows(calls) };
  const written = writeGuarded(store, {
    unit: UNIT, target: call.id,
    writes: [
      { id: valid.value.id, kind: CALL_RECORD_KIND, expected: valid.value.revision, value },
      { id: ledger.value.record.id, kind: CALL_LEDGER_KIND, expected: ledger.value.record.revision, value: ledgerValue },
    ],
    guards: uniqueRefs([reference(valid.value), ...ledger.value.guards]),
  });
  if (!written.ok) return written;
  const savedCall = written.value.find(record => record.id === valid.value.id);
  const savedLedger = written.value.find(record => record.id === ledger.value!.record.id);
  requireCondition(savedCall !== undefined && savedLedger !== undefined, "call_write_invalid", "The atomic settlement returned both records it wrote");
  return delivered({
    call: savedCall as unknown as Revision<AnyCallRecord>,
    ledger: savedLedger as unknown as Revision<CallLedger>, repeated: false, settled: true,
  });
}

function checkRequest(project: string, value: unknown): OmResult<Sealed<CheckedRequest>> {
  if (!isPlainObject(value) || !exactKeys(value as object, "owner" in (value as object) ? MECHANISM_REQUEST_KEYS : REQUEST_KEYS)) {
    return problem("call_request_invalid", "A call request carries exactly its identity, question, series, dispatch and packet", project, "request");
  }
  const request = value as Record<string, unknown>;
  if (!isText(request['call'])) return problem("call_request_invalid", "A call has a non-empty lasting name", project, "call");
  const target = callRecordId(project, request['call'] as string);
  if (!CALL_PURPOSES.includes(request['purpose'] as CallPurpose)) {
    return problem("call_purpose_invalid", "A call names one map purpose before dispatch", target, "purpose", "gap");
  }
  const purpose = request['purpose'] as CallPurpose;
  const basis = checkBasis(request['basis'], purpose, target);
  if (!basis.ok) return basis;
  const mechanism = "owner" in request;
  if (mechanism ? !validMechanismFields(request) : !isText(request['block']))
    return problem("call_request_invalid", "A call names its typed owner and exact admission basis", target, mechanism ? "owner" : "block");
  const gaps = checkGaps(request['gaps'], target, mechanism);
  if (!gaps.ok) return gaps;
  const goal = checkGoal(request['goal'], target);
  if (!goal.ok) return goal;
  if (!exactReference(request['series'])) return problem("call_series_unresolved", "A call names the exact series revision whose attempt it serves", target, "series");
  if (!Number.isSafeInteger(request['attempt']) || Number(request['attempt']) < 1) {
    return problem("call_series_unresolved", "A call names a positive attempt ordinal", target, "attempt");
  }
  const dispatch = checkDispatch(request['dispatch'], target);
  if (!dispatch.ok) return dispatch;
  if (request['packet'] === undefined) return problem("packet_invalid", "A complete packet is explicit, even when empty", target, "packet");
  let text: string;
  try { text = canonical(request['packet']); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return problem("packet_invalid", "A packet is finite acyclic JSON that can be fingerprinted exactly", target, "packet");
  }
  const packet: PacketFingerprint = { hash: hashJson(request['packet']), chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
  return delivered({
    call: request['call'] as string, purpose, basis: basis.value,
    ...ownerFields(request as unknown as CheckedRequest), gaps: gaps.value,
    series: exactRef(request['series'] as Ref), attempt: request['attempt'] as number,
    goal: goal.value, dispatch: dispatch.value, packet,
  } as CheckedRequest);
}

function checkBasis(value: unknown, purpose: CallPurpose, target: string): OmResult<Sealed<CallBasis | null>> {
  if (value === null) {
    if (purpose === "model-research" || purpose === "model-design") return delivered(null);
    return problem("call_basis_invalid", "An analysis call names the saved stop or origin hold it analyses", target, "basis", "gap");
  }
  if (!isPlainObject(value)) {
    return problem("call_basis_invalid", "A call basis is null or one exact saved ground", target, "basis", "gap");
  }
  const basis = value as Record<string, unknown>;
  if (basis['kind'] === "series-stop" && exactKeys(basis, STOP_BASIS_KEYS)
    && exactReference(basis['series']) && Number.isSafeInteger(basis['attempt']) && Number(basis['attempt']) >= 1) {
    if (purpose !== "stop-analysis") {
      return problem("call_basis_invalid", "Only a stop-analysis call can stand on a saved series stop", target, "basis", "gap");
    }
    return delivered({ kind: "series-stop", series: exactRef(basis['series'] as Ref), attempt: Number(basis['attempt']) });
  }
  if (basis['kind'] === "origin-hold" && exactKeys(basis, HOLD_BASIS_KEYS) && exactReference(basis['hold'])) {
    if (purpose !== "origin-analysis") {
      return problem("call_basis_invalid", "Only an origin-analysis call can stand on an origin hold", target, "basis", "gap");
    }
    return delivered({ kind: "origin-hold", hold: exactRef(basis['hold'] as Ref) });
  }
  return problem("call_basis_invalid", "A call basis exactly names its saved stop or origin hold", target, "basis", "gap");
}

function checkGaps(value: unknown, target: string, mechanism = false): OmResult<Sealed<readonly AnyAddressedGap[]>> {
  if (!Array.isArray(value)) return problem("call_question_missing", "A call explicitly names its addressed questions", target, "gaps", "gap");
  if (value.length === 0) return problem("call_question_missing", "A paid call has at least one addressed question", target, "gaps", "gap");
  const gaps: AnyAddressedGap[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const gap = value[index];
    if (!isPlainObject(gap) || !exactKeys(gap, GAP_KEYS)) {
      return problem("call_question_invalid", "Each addressed question carries one gap id, goal, field and consumer", target, `gaps.${index}`, "gap");
    }
    const row = gap as Record<string, unknown>;
    for (const field of GAP_KEYS) {
      if (field === "consumer" && mechanism ? !validMechanismOwner(row[field]) : !isText(row[field])) return problem("call_question_invalid", "A question address has no empty part", target, `gaps.${index}.${field}`, "gap");
    }
    gaps.push({ id: row['id'] as string, goal: row['goal'] as string, field: row['field'] as string, consumer: row['consumer'] as string | MechanismCallOwner });
  }
  return delivered(orderedGaps(gaps));
}

function checkGoal(value: unknown, target: string): OmResult<Sealed<AttemptGoal>> {
  if (value === undefined || value === null) return problem("call_goal_missing", "A call names the attempt goal before dispatch", target, "goal", "gap");
  if (!isPlainObject(value) || !exactKeys(value, GOAL_KEYS)) {
    return problem("call_goal_invalid", "An attempt goal carries a key, its questions and a checkable result", target, "goal", "gap");
  }
  const goal = value as Record<string, unknown>;
  if (!isText(goal['key']) || !isText(goal['result']) || !Array.isArray(goal['questions'])
    || goal['questions'].length === 0 || !goal['questions'].every(isText)) {
    return problem("call_goal_invalid", "An attempt goal names a non-empty key, question set and checkable result", target, "goal", "gap");
  }
  return delivered(copyGoal(goal as unknown as AttemptGoal));
}

function checkDispatch(value: unknown, target: string): OmResult<Sealed<DispatchContract>> {
  if (!isPlainObject(value) || !exactKeys(value as object, DISPATCH_KEYS)) {
    return problem("dispatch_contract_invalid", "Dispatch is exactly {adapter, config}", target, "dispatch");
  }
  const dispatch = value as Record<string, unknown>;
  if (!exactReference(dispatch['adapter'])) {
    return problem("dispatch_contract_invalid", "The adapter is named by an exact {id, revision, hash} reference", target, "dispatch.adapter");
  }
  if (!exactReference(dispatch['config'])) {
    return problem("dispatch_contract_invalid", "The configuration is named by an exact {id, revision, hash} reference", target, "dispatch.config");
  }
  return delivered({ adapter: exactRef(dispatch['adapter'] as Ref), config: exactRef(dispatch['config'] as Ref) });
}

function resolveDispatch(store: Store, dispatch: DispatchContract, target: string): OmResult<Sealed<readonly Ref[]>> {
  for (const [field, ref] of [["adapter", dispatch.adapter], ["config", dispatch.config]] as const) {
    const found = store.get(ref.id, ref.revision);
    if (!found || found.hash !== ref.hash) {
      return problem("dispatch_contract_unresolved", `No record stands at the exact ${field} reference`, target,
        `dispatch.${field}`, "producer", ref);
    }
    // A contract used for a new dispatch names the current configured bytes. The exact guard closes a later race.
    const head = store.get(ref.id);
    if (!head || head.revision !== ref.revision || head.hash !== ref.hash) {
      return problem("dispatch_contract_unresolved", `The exact ${field} reference is no longer the configured head`, target,
        `dispatch.${field}`, "producer", ref);
    }
  }
  return delivered([exactRef(dispatch.adapter), exactRef(dispatch.config)]);
}

function resolveSeries(store: Store, project: string, request: CheckedRequest, target: string): OmResult<Sealed<readonly Ref[]>> {
  if ("owner" in request) return resolveMechanismSeries(store, project, request, target, true);
  const admission = prepareSeriesLineAdmission(store, project, request.series);
  if (!admission.ok || "owner" in admission.value.series.value || admission.value.series.value.block !== request.block) {
    return problem("call_series_unresolved", "The call requires its exact valid current series on this project's current block line",
      target, "series", "producer", request.series);
  }
  const read = admission.value.series;
  const guards = admission.value.guards;
  const line = read.value.line;
  const attempt = [...read.value.inherited, ...read.value.attempts].find(item => item.ordinal === request.attempt);
  if (request.purpose === "model-research" || request.purpose === "model-design") {
    if (!attempt || attempt.outcome !== null) {
      return problem("call_series_unresolved", "An ordinary model call belongs to an attempt that is currently running",
        target, "attempt", "producer", request.series);
    }
    if (hashJson(copyGoal(attempt.goal)) !== hashJson(request.goal)) {
      return problem("call_goal_conflict", "The call goal is not the goal recorded before this attempt began", target, "goal", "gap", request.series);
    }
    return delivered(guards);
  }
  if (!attempt || attempt.outcome === null) {
    return problem("call_basis_unresolved", "An analysis call belongs to a completed attempt at its saved ground",
      target, "attempt", "producer", request.series);
  }
  if (request.purpose === "stop-analysis") {
    const basis = request.basis as SeriesStopBasis;
    const stop = read.value.stop;
    if (!sameRef(basis.series, request.series) || basis.attempt !== request.attempt || stop === null
      || stop.attempt !== request.attempt || !stop.attempts.includes(request.attempt)
      || !read.value.ladder.grounds.includes("review-record")) {
      return problem("call_basis_unresolved", "The call names its current saved stop on the rung that admits a review",
        target, "basis", "producer", basis.series);
    }
    return delivered(guards);
  }
  const basis = request.basis as OriginHoldBasis;
  const context = readStopContext(store, { project, block: request.block, line });
  if (!context.ok) {
    return problem("call_basis_unresolved", "The call names a standing origin hold in this series",
      target, "basis", "producer", basis.hold);
  }
  const standing = context.value.context.holds.find(item => sameRef(item.hold, basis.hold));
  if (!standing || standing.attempt !== request.attempt) {
    return problem("call_basis_unresolved", "The call names its exact current origin hold and the attempt that raised it",
      target, "basis", "producer", basis.hold);
  }
  return delivered(uniqueRefs([...guards, ...context.value.reads]));
}

/** The admission proof is common A3 work; E1 only binds its own dispatch address and purpose to it. */
function resolveMechanismSeries(
  store: Store, project: string, request: Omit<MechanismRecordCallRequest, "packet"> | MechanismCallRecord,
  target: string, current: boolean, history?: CallHistory,
): OmResult<Sealed<readonly Ref[]>> {
  if (current) {
    const head = store.get(request.series.id);
    if (!head || !sameRef(reference(head), request.series))
      return problem("call_series_unresolved", "New dispatch requires the current owner series head", target, "series", "producer", request.series);
  }
  const ordinary = request.purpose === "model-research" || request.purpose === "model-design";
  const readAdmission = ordinary ? readMechanismAdmission : readMechanismAnalysisAdmission;
  let read: ReturnType<typeof readMechanismAdmission>;
  try {
    read = readAdmission(store, {
      project, series: request.series, attempt: request.attempt, admission: JSON.parse(canonical(request.admission)) as MechanismAdmission, current,
    });
  } catch (error) {
    if (error instanceof EngineError && error.code === "series_request_invalid")
      return problem("call_series_unresolved", "The saved mechanism admission has malformed source addresses", target, "admission", "producer", request.series);
    throw error;
  }
  if (!read.ok || hashJson(read.value.owner) !== hashJson(request.owner))
    return problem("call_series_unresolved", "The call's mechanism owner and exact task must be proved by its series", target, "admission", "producer", request.series);
  const series = read.value.series.value;
  const attempt = [...series.inherited, ...series.attempts].find(item => item.ordinal === request.attempt);
  const guards = current ? [request.series, ...read.value.guards] as unknown as readonly Ref[] : [];
  if (ordinary) {
    if (request.purpose !== "model-design")
      return problem("call_purpose_invalid", "M5:addressing admits its MC2 design task", target, "purpose", "gap", request.series);
    if (!attempt || attempt.outcome !== null || series.stop !== null)
      return problem("call_series_unresolved", "A design call belongs to the running mechanism attempt", target, "attempt", "producer", request.series);
    if (hashJson(copyGoal(attempt.goal)) !== hashJson(request.goal))
      return problem("call_goal_conflict", "The call uses the full goal recorded for this mechanism attempt", target, "goal", "gap", request.series);
    const gaps = orderedGaps(read.value.gaps.map(gap => ({ id: gap.id, goal: gap.target, field: gap.field, consumer: request.owner })));
    if (hashJson(gaps) !== hashJson(request.gaps))
      return problem("call_question_invalid", "The call addresses every member of the proved mechanism batch exactly once", target, "gaps", "gap", request.series);
    return delivered(uniqueRefs(guards));
  }
  if (!attempt || attempt.outcome === null)
    return problem("call_basis_unresolved", "An analysis call refers to a completed mechanism attempt", target, "attempt", "producer", request.series);
  if (request.purpose === "stop-analysis") {
    const basis = request.basis as SeriesStopBasis, stop = series.stop;
    if (!sameRef(basis.series, request.series) || basis.attempt !== request.attempt || stop === null
      || stop.attempt !== request.attempt || !stop.attempts.includes(request.attempt)
      || !series.ladder.grounds.includes("review-record"))
      return problem("call_basis_unresolved", "A mechanism stop analysis names the saved stop and its review rung", target, "basis", "producer", basis.series);
    return delivered(uniqueRefs(guards));
  }
  const basis = request.basis as OriginHoldBasis;
  const hold = readOriginHoldAt(store, project, basis.hold, history?.journal);
  if (!hold.ok || !("owner" in hold.value.value) || hashJson(hold.value.value.owner) !== hashJson(request.owner)
    || hold.value.value.attempt !== request.attempt || hold.value.value.lift !== null
    || !attempt.outcome.refusals.some(refusal => refusal.row === hold.value.value.row))
    return problem("call_basis_unresolved", "The exact saved hold must belong to this mechanism attempt", target, "basis", "producer", basis.hold);
  // Lifting today's hold does not change the exact open revision which admitted this call.
  if (!current) return delivered([]);
  const context = readStopContext(store, seriesRequestOf(JSON.parse(canonical(series))));
  if (!context.ok || !context.value.context.holds.some(item => sameRef(item.hold, basis.hold) && item.attempt === request.attempt))
    return problem("call_basis_unresolved", "A mechanism origin analysis names its current owner hold", target, "basis", "producer", basis.hold);
  return delivered(uniqueRefs([...guards, ...context.value.reads]));
}

function validMechanismOwner(value: unknown): value is MechanismCallOwner {
  return isPlainObject(value) && exactKeys(value as object, ["kind", "mechanism"])
    && (value as Record<string, unknown>).kind === "mechanism" && (value as Record<string, unknown>).mechanism === "M5:addressing";
}
function validMechanismFields(value: object): boolean {
  const row = value as Record<string, unknown>, admission = row['admission'] as Record<string, unknown>;
  return validMechanismOwner(row['owner']) && isPlainObject(admission)
    && exactKeys(admission, ["gaps", "routes", "batch"]) && isPlainObject(admission.gaps)
    && exactKeys(admission.gaps as object, ["sources", "records"]) && isPlainObject((admission.gaps as Record<string, unknown>).sources)
    && Array.isArray((admission.gaps as Record<string, unknown>).records) && ((admission.gaps as Record<string, unknown>).records as unknown[]).every(exactReference)
    && exactReference(admission.routes) && isText(admission.batch);
}
function ownerFields(value: CheckedRequest | AnyCallRecord): { block: string } | { owner: MechanismCallOwner; admission: MechanismAdmission } {
  return "owner" in value ? { owner: { ...value.owner }, admission: JSON.parse(canonical(value.admission)) as MechanismAdmission }
    : { block: value.block };
}

function checkedLedger(store: Store, project: string): OmResult<Sealed<CheckedLedger | null>> {
  const id = callLedgerId(project);
  const calls = store.list<AnyCallRecord>(CALL_RECORD_KIND)
    .filter(call => call.id.startsWith(callRecordNamespace(project)));
  const sources: Revision<AnyCallRecord>[] = [];
  for (const call of calls) {
    const valid = checkedCall(store, call, project, call.id);
    if (!valid.ok) return valid;
    sources.push(valid.value);
  }
  const record = store.get<CallLedger>(id);
  if (!record) {
    if (sources.length > 0) {
      return problem("ledger_invalid", "Every saved call has a row in the project's one ledger", id, "calls");
    }
    return delivered(null);
  }
  if (record.kind !== CALL_LEDGER_KIND || !isPlainObject(record.value) || !exactKeys(record.value, LEDGER_KEYS)
    || record.value.projectId !== project || !Array.isArray(record.value.calls)) {
    return problem("ledger_invalid", "The project's ledger carries only its project and call rows", id, "ledger", "producer", reference(record));
  }
  const expected = orderedRows(sources.map(call => rowOf(reference(call), call.value)));
  if (record.value.calls.length !== expected.length) {
    return problem("ledger_invalid", "The ledger has one row for every call record in the project's namespace",
      id, "calls", "producer", reference(record));
  }
  for (let index = 0; index < expected.length; index += 1) {
    const row = record.value.calls[index];
    if (!validLedgerRow(row) || hashJson(row) !== hashJson(expected[index])) {
      return problem("ledger_invalid", "A ledger row is derived from the call record it names",
        id, `calls.${index}`, "producer", reference(record));
    }
  }
  return delivered({ record, guards: uniqueRefs([reference(record), ...sources.map(reference)]) });
}

function checkedCall(
  store: Store, record: Revision<AnyCallRecord>, project: string, target: string, history?: CallHistory,
): OmResult<Sealed<Revision<AnyCallRecord>>> {
  if (!validCallShape(record, project)) {
    return problem("call_record_invalid", "The stored call record is not one this unit writes", target, "record", "producer", reference(record));
  }
  if ("owner" in record.value) {
    const owner = resolveMechanismSeries(store, project, record.value, target, false, history);
    if (!owner.ok) return problem("call_record_invalid", "The saved mechanism admission does not follow from its exact series and task", target, "admission", "producer", reference(record));
  }
  if (record.revision === 1 && record.value.status === "open") return delivered(record);
  if (record.revision === 2 && record.value.status !== "open") {
    const admitted = store.get<AnyCallRecord>(record.id, 1);
    if (admitted && validCallShape(admitted, project) && admitted.value.status === "open"
      && admitted.value.openedAt === record.value.openedAt
      && hashJson(identityOf(admitted.value)) === hashJson(identityOf(record.value))) {
      return delivered(record);
    }
  }
  return problem("call_record_invalid", "A call has one admission revision and at most one settlement revision",
    target, "revision", "producer", reference(record));
}

function validCallShape(record: Revision<AnyCallRecord>, project: string): boolean {
  const value = record.value;
  if (record.kind !== CALL_RECORD_KIND || !isPlainObject(value) || !exactKeys(value, "owner" in value ? MECHANISM_CALL_KEYS : CALL_KEYS)
    || !validProject(value.projectId) || value.projectId !== project || !isText(value.call)
    || !CALL_PURPOSES.includes(value.purpose) || !validBasis(value.basis, value.purpose) || ("owner" in value ? !validMechanismFields(value) : !isText(value.block))
    || record.id !== callRecordId(project, value.call) || !validGaps(value.gaps, "owner" in value)
    || !validGoal(value.goal) || hashJson(copyGoal(value.goal)) !== hashJson(value.goal)
    || !exactReference(value.series) || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !validDispatch(value.dispatch) || !validFingerprint(value.packet)
    || !Number.isSafeInteger(value.openedAt) || value.openedAt < 0
    || !["open", ...CALL_SETTLEMENT_STATUSES].includes(value.status)) {
    return false;
  }
  const validOpen = value.status === "open" && value.usage === null && value.settledAt === null;
  const validClosed = value.status !== "open" && validUsage(value.usage)
    && Number.isSafeInteger(value.settledAt) && value.settledAt! >= value.openedAt;
  return validOpen || validClosed;
}

function checkedUsage(value: unknown, target: string): OmResult<Sealed<TokenUsage | null>> {
  try {
    const usage = tokenUsage(value);
    return delivered(usage === null ? null : copyUsage(usage));
  } catch (error) {
    if (error instanceof EngineError && error.code === "usage_invalid") {
      return problem("usage_invalid", error.message, target, "usage");
    }
    throw error;
  }
}

function identityFrom(project: string, request: CheckedRequest): Omit<AnyCallRecord, "openedAt" | "status" | "usage" | "settledAt" | "gaps"> & { gaps: readonly AnyAddressedGap[] } {
  return {
    call: request.call, purpose: request.purpose, basis: copyBasis(request.basis), projectId: project,
    ...ownerFields(request), gaps: request.gaps,
    series: exactRef(request.series), attempt: request.attempt, goal: copyGoal(request.goal),
    dispatch: copyDispatch(request.dispatch), packet: { ...request.packet },
  };
}

function identityOf(value: AnyCallRecord): Omit<AnyCallRecord, "openedAt" | "status" | "usage" | "settledAt" | "gaps"> & { gaps: readonly AnyAddressedGap[] } {
  return {
    call: value.call, purpose: value.purpose, basis: copyBasis(value.basis), projectId: value.projectId,
    ...ownerFields(value), gaps: orderedGaps(value.gaps),
    series: exactRef(value.series), attempt: value.attempt, goal: copyGoal(value.goal),
    dispatch: copyDispatch(value.dispatch), packet: { ...value.packet },
  };
}

function rowOf(call: Ref, value: AnyCallRecord): AnyCallLedgerEntry {
  return {
    call: exactRef(call), name: value.call, purpose: value.purpose, basis: copyBasis(value.basis), ...ownerFields(value),
    gaps: orderedGaps(value.gaps), series: exactRef(value.series), attempt: value.attempt, goal: copyGoal(value.goal),
    status: value.status, usage: value.usage === null ? null : copyUsage(value.usage),
    openedAt: value.openedAt, settledAt: value.settledAt,
  } as AnyCallLedgerEntry;
}

const copyUsage = (usage: TokenUsage): TokenUsage => ({
  inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
  cachedInputTokens: usage.cachedInputTokens, reasoningOutputTokens: usage.reasoningOutputTokens,
});

const copyGoal = (goal: AttemptGoal): AttemptGoal => ({
  key: goal.key, questions: [...goal.questions].sort(compareText), result: goal.result,
});

const copyDispatch = (dispatch: DispatchContract): DispatchContract => ({
  adapter: exactRef(dispatch.adapter), config: exactRef(dispatch.config),
});

const copyBasis = (basis: CallBasis | null): CallBasis | null => basis === null ? null
  : basis.kind === "series-stop"
    ? { kind: basis.kind, series: exactRef(basis.series), attempt: basis.attempt }
    : { kind: basis.kind, hold: exactRef(basis.hold) };

const exactRef = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });

const orderedGaps = (gaps: readonly AnyAddressedGap[]): AnyAddressedGap[] => [...gaps]
  .map(gap => ({ id: gap.id, goal: gap.goal, field: gap.field, consumer: typeof gap.consumer === "string" ? gap.consumer : { ...gap.consumer } }))
  .sort((left, right) => compareText(canonical(left), canonical(right)));

const orderedRows = (rows: readonly AnyCallLedgerEntry[]): AnyCallLedgerEntry[] => [...rows].sort((left, right) => compareText(left.call.id, right.call.id));

function validGaps(value: unknown, mechanism = false): value is readonly AnyAddressedGap[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every(gap => isPlainObject(gap) && exactKeys(gap, GAP_KEYS) && GAP_KEYS.every(key => key === "consumer" && mechanism ? validMechanismOwner(gap[key]) : isText(gap[key])))) return false;
  return hashJson(orderedGaps(value as AnyAddressedGap[])) === hashJson(value);
}

function validGoal(value: unknown): value is AttemptGoal {
  if (!isPlainObject(value)) return false;
  const goal = value as Record<string, unknown>;
  return exactKeys(goal, GOAL_KEYS) && isText(goal['key']) && isText(goal['result'])
    && Array.isArray(goal['questions']) && goal['questions'].length > 0 && goal['questions'].every(isText);
}

function validDispatch(value: unknown): value is DispatchContract {
  if (!isPlainObject(value)) return false;
  const dispatch = value as Record<string, unknown>;
  return exactKeys(dispatch, DISPATCH_KEYS)
    && exactReference(dispatch['adapter']) && exactReference(dispatch['config']);
}

function validBasis(value: unknown, purpose: CallPurpose): value is CallBasis | null {
  if (value === null) return purpose === "model-research" || purpose === "model-design";
  if (!isPlainObject(value)) return false;
  const basis = value as Record<string, unknown>;
  if (purpose === "stop-analysis") {
    return basis['kind'] === "series-stop" && exactKeys(basis, STOP_BASIS_KEYS)
      && exactReference(basis['series']) && Number.isSafeInteger(basis['attempt']) && Number(basis['attempt']) >= 1;
  }
  if (purpose === "origin-analysis") {
    return basis['kind'] === "origin-hold" && exactKeys(basis, HOLD_BASIS_KEYS) && exactReference(basis['hold']);
  }
  return false;
}

function validFingerprint(value: unknown): value is PacketFingerprint {
  if (!isPlainObject(value)) return false;
  const packet = value as Record<string, unknown>;
  return exactKeys(packet, FINGERPRINT_KEYS)
    && typeof packet['hash'] === "string" && /^[a-f0-9]{64}$/.test(packet['hash'])
    && Number.isSafeInteger(packet['chars']) && Number(packet['chars']) >= 0
    && Number.isSafeInteger(packet['bytes']) && Number(packet['bytes']) >= Number(packet['chars']);
}

function validLedgerRow(value: unknown): value is AnyCallLedgerEntry {
  if (!isPlainObject(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, "owner" in row ? MECHANISM_LEDGER_ENTRY_KEYS : LEDGER_ENTRY_KEYS) || !exactReference(row['call'])
    || !isText(row['name']) || !CALL_PURPOSES.includes(row['purpose'] as CallPurpose)
    || !validBasis(row['basis'], row['purpose'] as CallPurpose) || ("owner" in row ? !validMechanismFields(row) : !isText(row['block'])) || !validGaps(row['gaps'], "owner" in row)
    || !exactReference(row['series']) || !Number.isSafeInteger(row['attempt']) || Number(row['attempt']) < 1
    || !validGoal(row['goal']) || hashJson(copyGoal(row['goal'])) !== hashJson(row['goal'])
    || !["open", ...CALL_SETTLEMENT_STATUSES].includes(row['status'] as CallStatus)
    || !Number.isSafeInteger(row['openedAt']) || Number(row['openedAt']) < 0) return false;
  const open = row['status'] === "open" && row['usage'] === null && row['settledAt'] === null;
  const closed = row['status'] !== "open" && validUsage(row['usage'])
    && Number.isSafeInteger(row['settledAt']) && Number(row['settledAt']) >= Number(row['openedAt']);
  return open || closed;
}

function validUsage(value: unknown): value is TokenUsage {
  if (value === null || value === undefined) return false;
  try { return tokenUsage(value) !== null; }
  catch (error) {
    if (error instanceof EngineError && error.code === "usage_invalid") return false;
    throw error;
  }
}

function exactReference(value: unknown): value is Ref {
  return isPlainObject(value) && exactKeys(value as object, REF_KEYS) && isRef(value);
}

function validProject(value: unknown): value is string {
  if (!isText(value) || (value as string).includes(":")) return false;
  const project = value as string;
  return project.length + CALL_LEDGER_KIND.length + 1 <= 200
    && callRecordNamespace(project).length + 64 <= 200;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameRef(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.revision === right.revision && left.hash === right.hash;
}

function uniqueRefs(values: readonly Ref[]): Ref[] {
  const refs = new Map<string, Ref>();
  for (const ref of values) refs.set(`${ref.id}\0${ref.revision}\0${ref.hash}`, exactRef(ref));
  return [...refs.values()].sort((left, right) => compareText(`${left.id}\0${left.revision}`, `${right.id}\0${right.revision}`));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetOf(value: unknown): string {
  const record = isPlainObject(value) ? value as Record<string, unknown> : null;
  return record && isText(record['id']) ? record['id'] as string : "call";
}

function problem(
  code: CallRecordCode, message: string, target: string, field: string,
  route: "producer" | "gap" | "owner" | "readiness" = "producer", ref?: Ref,
): OmResult<never> {
  return refused(code, message, { unit: UNIT, target, field, ref }, route);
}
