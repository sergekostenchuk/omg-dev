import type { Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef } from "../pipeline/contracts.js";
import type { Revision, Store, TransactionGuard, Write } from "../storage/store.js";
import { transactionGuardsCurrent, uniqueTransactionGuards } from "../runtime/environment.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Sealed } from "./refusal.js";

// Every refusal this unit can produce. The list is the checklist its test walks, so a new code cannot arrive untested.
export const REFS_REFUSAL_CODES = Object.freeze([
  "reference_invalid", "record_missing", "record_foreign", "record_forged",
  "writes_missing", "input_stale", "revision_conflict",
] as const);
export type RefsRefusalCode = typeof REFS_REFUSAL_CODES[number];

interface RecordAddressee {
  readonly unit: string;
  readonly target: string;
  readonly kind: string;
}

/**
 * T1/T4: the address of what a unit reads is known to it, so naming it is mandatory and singular — either the exact
 * id, or, when the tail of the id is computed, a prefix such as "layer-proposal:alpha:". A prefix MUST end with the
 * ':' namespace separator: without it a prefix for project "alpha" would also admit project "alphabet".
 * Naming neither address or both is a defect of the calling code, not a permissive default.
 */
export type RecordRequest =
  | (RecordAddressee & { readonly id: string; readonly idPrefix?: undefined })
  | (RecordAddressee & { readonly idPrefix: string; readonly id?: undefined });

type ExpectedAddress = { readonly exact: string } | { readonly prefix: string };

export interface GuardedWrite {
  readonly unit: string;
  readonly target: string;
  readonly writes: readonly Write[];
  readonly guards: readonly TransactionGuard[];
}

/**
 * Reads one record by its exact {id, revision, hash} reference.
 * The reference proves WHICH record was read; it does not prove that the record was accepted. The body is never
 * consulted, so a record declaring itself accepted gains nothing by saying so, and a twin holding identical content
 * under another address has an identical hash (T3). The ground of acceptance and its link to the outcome of a gate
 * are the calling unit's to establish; this function is not that check.
 */
export function readRecord<T = Json>(store: Store, reference: unknown, request: RecordRequest): OmResult<Sealed<Revision<T>>> {
  requireCondition(isPlainObject(request), "read_request_invalid", "A read is asked for by a request object");
  requireCondition(isText(request.unit) && isText(request.target) && isText(request.kind),
    "read_request_invalid", "A read names the reading unit, its target and the record kind");
  const expected = expectedAddress(request);
  const unit = request.unit;
  const target = request.id ?? request.target;
  if (!isRef(reference)) {
    return refused("reference_invalid", "A record is read by an exact {id, revision, hash} reference",
      { unit, target, field: referenceField(reference) }, "producer");
  }
  // The address is checked before the store is touched, so a foreign record is never read at all.
  if ("exact" in expected ? reference.id !== expected.exact : !reference.id.startsWith(expected.prefix)) {
    return refused("record_foreign",
      "exact" in expected
        ? `A reference to ${reference.id} cannot stand for ${expected.exact}`
        : `A reference to ${reference.id} lies outside ${expected.prefix}`,
      { unit, target, field: "id", ref: reference }, "producer");
  }
  const found = store.get<T>(reference.id, reference.revision);
  if (!found) {
    return refused("record_missing", "No record exists at this exact reference",
      { unit, target, ref: reference }, "producer");
  }
  if (found.kind !== request.kind) {
    return refused("record_foreign", `A ${found.kind} record cannot stand for a ${request.kind} record`,
      { unit, target, field: "kind", ref: reference }, "producer");
  }
  if (found.hash !== reference.hash) {
    return refused("record_forged", "The referenced revision holds different content than the reference claims",
      { unit, target, field: "hash", ref: reference }, "producer");
  }
  return delivered(found);
}

/**
 * Writes one transaction guarded by exact references or record absence.
 * The guards are checked by the store inside the same transaction, so there is no window between check and write (T7);
 * its input_stale and revision_conflict become addressed refusals instead of an exception without an address.
 */
export function writeGuarded<T = Json>(store: Store, request: GuardedWrite): OmResult<Sealed<Revision<T>[]>> {
  requireCondition(isPlainObject(request), "write_request_invalid", "A guarded transaction is asked for by a request object");
  requireCondition(isText(request.unit) && isText(request.target),
    "write_request_invalid", "A guarded transaction names the writing unit and its target");
  // An absent set and an explicitly empty one are different cases: an absent one is a defect of the calling code,
  // an explicitly empty writes is refused below, and an absent guards is never read as "depends on nothing".
  requireCondition(Array.isArray(request.writes), "write_request_invalid", "A guarded transaction carries a set of writes");
  requireCondition(Array.isArray(request.guards), "write_request_invalid", "A guarded transaction carries a set of guards");
  const unit = request.unit;
  if (request.writes.length === 0) {
    // A guarded transaction that writes nothing is a check standing alone, which is the window T7 forbids.
    return refused("writes_missing", "A guarded transaction writes at least one record",
      { unit, target: request.target, field: "writes" }, "producer");
  }
  for (const write of request.writes) requireWriteShape(write);
  const subject = request.writes[0]!.id;
  for (const guard of request.guards) {
    if (isPlainObject(guard) && "absent" in guard) {
      try { uniqueTransactionGuards([guard]); }
      catch (error) {
        if (!(error instanceof EngineError) || error.code !== "invalid_guard") throw error;
        return refused("reference_invalid", "An absent guard needs an ID and only absent: true",
          { unit, target: subject, field: isText(guard.id) ? "absent" : "id" }, "producer");
      }
    } else if (!isRef(guard)) {
      return refused("reference_invalid", "A guard is an exact {id, revision, hash} reference",
        { unit, target: subject, field: referenceField(guard) }, "producer");
    }
  }
  const guards = uniqueTransactionGuards(request.guards);
  try {
    return delivered(store.writeMany<T>([...request.writes], guards));
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    if (error.code === "input_stale") {
      const stale = staleGuard(store, guards);
      return refused("input_stale", "A guarded input changed before this transaction could commit",
        { unit, target: stale?.id ?? subject, ref: stale && !("absent" in stale) ? stale : undefined }, "producer");
    }
    if (error.code === "revision_conflict") {
      return refused("revision_conflict", "The written record is no longer at the expected revision",
        { unit, target: conflictingId(error.details) ?? subject, field: "expected" }, "producer");
    }
    throw error;
  }
}

function expectedAddress(request: RecordRequest): ExpectedAddress {
  const exact = request.id;
  const prefix = request.idPrefix;
  requireCondition((exact === undefined) !== (prefix === undefined),
    "read_request_invalid", "A read names exactly one of the expected id and the expected id prefix");
  if (exact !== undefined) {
    requireCondition(isText(exact), "read_request_invalid", "An expected id is a non-empty string");
    return { exact };
  }
  requireCondition(prefix !== undefined && isText(prefix) && prefix.length > 1 && prefix.endsWith(":"),
    "read_request_invalid", "An expected id prefix ends with the ':' namespace separator");
  return { prefix };
}

function requireWriteShape(write: Write): void {
  requireCondition(isPlainObject(write), "write_request_invalid", "Each write is an object");
  requireCondition(isText(write.id) && isText(write.kind), "write_request_invalid", "Each write names a non-empty id and kind");
  requireCondition(Number.isSafeInteger(write.expected) && write.expected >= 0,
    "write_request_invalid", "Each write declares an integer expected revision of at least zero");
  // undefined is not a JSON value, so a value that is present but undefined is an absent value.
  requireCondition("value" in write && write.value !== undefined,
    "write_request_invalid", "Each write carries a value, explicitly empty when there is nothing to record");
}

function referenceField(value: unknown): string {
  if (!value || typeof value !== "object") return "reference";
  const ref = value as Record<string, unknown>;
  if (typeof ref['id'] !== "string" || ref['id'].length === 0) return "id";
  if (!Number.isSafeInteger(ref['revision']) || Number(ref['revision']) <= 0) return "revision";
  if (typeof ref['hash'] !== "string" || !/^[a-f0-9]{64}$/.test(ref['hash'])) return "hash";
  return "reference";
}

// Revisions only grow and never change, so a guard that failed inside the transaction still fails here. The store
// refuses without naming the input, so the address is the first stale guard found in the normalized sequence the
// transaction itself checked — deterministic for a given observed state, and not a witness of the exact cause
// inside the transaction: between the rollback and this rescan another store may have moved a further input.
function staleGuard(store: Store, guards: readonly TransactionGuard[]): TransactionGuard | null {
  for (const guard of guards) {
    if (!transactionGuardsCurrent(store, [guard])) return guard;
  }
  return null;
}

function conflictingId(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const id = (details as Record<string, unknown>)['id'];
  return typeof id === "string" && id.length > 0 ? id : null;
}
