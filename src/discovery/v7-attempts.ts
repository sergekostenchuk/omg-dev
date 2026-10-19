import { canonical, type Json } from "../canonical.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { EngineError } from "../errors.js";
import type { Store, Revision, TransactionGuard } from "../storage/store.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import { readExact } from "./projection-reader.js";
import { DISCOVERY_CLAIMS_CONTRACT, V7_ATTEMPT_CONTRACT, V7_ATTEMPT_END_CODES,
  V7_ATTEMPT_KIND, checkV7Claims } from "./v7-contracts.js";
import { currentPlan, proveAttempt, v7AttemptId, type V7Attempt, type V7AttemptEnd,
  type V7AttemptKey } from "./v7-plan-questions.js";

const obj = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// A function declaration — const arrow `never` loses narrowing under this compiler.
function refuse(code: string, field: string, reason: string): never {
  throw new EngineError(code, `[${field}] ${reason}`, { field, reason });
}

/** What the ordinary research path hands to the attempt door: the project,
 * the accepted plan-answer edition the generating call was assigned under,
 * the stable plan-question id inside that edition, the exact Ref of the
 * model-call record that produced the outcome, and the outcome itself. */
export interface V7AttemptRequest {
  project: string;
  planAnswer: Ref;
  planQuestionId: string;
  call: Ref;
  end: V7AttemptEnd;
}

export interface V7AttemptOutcome {
  attempt: Revision<V7Attempt>;
  /** true when the same key and end were already saved — the previous exact
   * record is returned and nothing is written. */
  repeated: boolean;
}

/* ---------- project membership — the reader's contract, kept verbatim ---------- */

/** Record kinds whose project membership lives in `value.project` at every
 * contract version; every other kind is a member by `value.projectId`. */
const PROJECT_VALUE_KINDS = new Set<string>(["project-mode", V7_ATTEMPT_KIND]);

/** Owner grant/session kinds put the project in `value.project` at contract
 * v1 but nest it under `value.scope.project` from v2 on. The contract string
 * alone picks the shape — an unknown or damaged contract refuses membership
 * instead of falling back to a spare field that could mask foreign
 * ownership. */
const OWNER_SCOPED_KINDS = new Set<string>(["owner-session-grant", "owner-session"]);

function projectOfRecord(record: Revision<Record<string, Json>>): unknown {
  const value = record.value;
  if (OWNER_SCOPED_KINDS.has(record.kind)) {
    const contract = value["contract"];
    if (contract === `${record.kind}/v1`) return value["project"];
    if (contract === `${record.kind}/v2` || contract === `${record.kind}/v3`) {
      const scope = value["scope"];
      return obj(scope) ? scope["project"] : undefined;
    }
    return undefined;
  }
  return value[PROJECT_VALUE_KINDS.has(record.kind) ? "project" : "projectId"];
}

/** The exact-Ref existence prover the door passes to checkV7Claims — the
 * same membership rule the attempt reader applies after the write. */
function projectRefOf(store: Store, project: string) {
  return (ref: Ref): boolean => {
    const record = readExact<Record<string, Json>>(store, ref);
    return record !== null && obj(record.value)
      && projectOfRecord(record) === project;
  };
}

/* ---------- the request shape ---------- */

function attemptKey(request: V7AttemptRequest): V7AttemptKey {
  if (!obj(request) || !nonempty(request["project"]) || !isRef(request["planAnswer"])
    || !nonempty(request["planQuestionId"]) || !isRef(request["call"]))
    refuse("attempt_invalid", "key", "an attempt request names its project, plan answer, plan question and call");
  return { project: request["project"], planAnswer: request["planAnswer"],
    planQuestionId: request["planQuestionId"], call: request["call"] };
}

/** The generating record of the ordinary path is the model-call the research
 * dispatch saved for this plan-question: exact, project-bound, bound to this
 * draft and plan-question and assigned under this exact plan edition — the
 * same origin the attempt reader proves. */
function checkCall(store: Store, key: V7AttemptKey, draftId: string): void {
  const call = readExact<Record<string, Json>>(store, key.call);
  if (call === null || call.kind !== "model-call" || !obj(call.value)
    || call.value["projectId"] !== key.project || call.value["draftId"] !== draftId
    || call.value["questionId"] !== key.planQuestionId || !isRef(call.value["planAnswer"])
    || canonical(call.value["planAnswer"]) !== canonical(key.planAnswer))
    refuse("attempt_invalid", "call",
      "the generating call is missing, foreign, for another plan-question or another plan edition");
}

/* ---------- the end — the same contract the reader proves ---------- */

function checkEnd(store: Store, key: V7AttemptKey, id: string, value: V7AttemptEnd): void {
  const projectRef = projectRefOf(store, key.project);
  const end = value as unknown as Record<string, Json>;
  if (!obj(end) || typeof end["type"] !== "string")
    refuse("attempt_invalid", "end", "an attempt ends submitted, refused, impossible or duplicate");
  switch (end["type"]) {
    case "submitted": {
      if (end["contract"] !== DISCOVERY_CLAIMS_CONTRACT || !obj(end["value"]))
        refuse("attempt_invalid", "end", "a submitted end carries the claims contract and its value");
      checkV7Claims((end["value"] as Record<string, Json>)["claims"],
        { project: key.project, planAnswer: key.planAnswer, planQuestionId: key.planQuestionId, projectRef });
      break;
    }
    case "refused": case "impossible": {
      if (typeof end["code"] !== "string" || !(V7_ATTEMPT_END_CODES as readonly string[]).includes(end["code"]))
        refuse("attempt_invalid", "end.code", `a ${String(end["type"])} end needs a code from the closed list`);
      if (!Array.isArray(end["evidence"]) || end["evidence"].some(item => !isRef(item) || !projectRef(item)))
        refuse("attempt_invalid", "end.evidence", "the evidence is a list of exact refs of this project");
      if (!nonempty(end["text"]))
        refuse("attempt_invalid", "end.text", "the end states its reason");
      break;
    }
    case "duplicate": {
      if (!isRef(end["of"])) refuse("attempt_invalid", "end.of", "a duplicate names its original attempt");
      if ((end["of"] as Ref).id === id)
        refuse("attempt_invalid", "end.of", "a duplicate cannot name itself");
      // The original must be a proven submitted attempt of the same project,
      // plan edition and plan-question — the reader applies the same rule, so
      // a foreign original refuses here exactly as it would refuse the record.
      const original = readExact<V7Attempt>(store, end["of"] as Ref);
      if (original === null || original.kind !== V7_ATTEMPT_KIND || !obj(original.value)
        || !obj(original.value.end) || original.value.end["type"] !== "submitted")
        refuse("attempt_invalid", "end.of",
          "the original is not a submitted attempt of this plan-question at this plan edition");
      const provenOriginal = proveAttempt(store, end["of"] as Ref);
      const originalValue = provenOriginal.attempt.value;
      if (originalValue.project !== key.project || originalValue.planQuestionId !== key.planQuestionId
        || canonical(originalValue.planAnswer) !== canonical(key.planAnswer)
        || provenOriginal.claims === undefined)
        refuse("attempt_invalid", "end.of",
          "the original is not a submitted attempt of this plan-question at this plan edition");
      break;
    }
    default:
      refuse("attempt_invalid", "end.type", "the end is submitted, refused, impossible or duplicate");
  }
}

/* ---------- the door ---------- */

/** The previous exact record of this attempt key: the same end returns it
 * without a write — after a reopen, a new plan edition or a cold reopen of
 * the Store alike, because the proof reads only saved revisions. A different
 * end of the same key, or a saved record the reader cannot prove, refuses;
 * a repeat never writes and never re-asks the current plan. */
function repeat(store: Store, key: V7AttemptKey, existing: Revision<V7Attempt>,
  endCanon: string): V7AttemptOutcome {
  const value = existing.value;
  if (!obj(value) || value["project"] !== key.project
    || !isRef(value["planAnswer"]) || canonical(value["planAnswer"]) !== canonical(key.planAnswer)
    || value["planQuestionId"] !== key.planQuestionId
    || !isRef(value["call"]) || canonical(value["call"]) !== canonical(key.call))
    refuse("attempt_conflict", "key", "the attempt address names a different attempt key");
  if (value["end"] === undefined || canonical(value["end"]) !== endCanon)
    refuse("attempt_conflict", "end", "the same attempt key was already recorded with a different end");
  proveAttempt(store, reference(existing));
  return { attempt: existing, repeated: true };
}

/** The DR3a2 attempt door of the ordinary path: the terminal outcome of one
 * generating model-call on one plan-question of the current accepted plan is
 * recorded immutably under the deterministic key id, in one batch guarded by
 * the plan question's saved head (and by the exact original for a duplicate)
 * — a moved plan between the check and the write abandons the whole batch,
 * so a refusal or a conflict leaves nothing behind. The door writes exactly
 * the form the DR3a1 reader proves and verifies that by proving the written
 * record itself; it touches neither draft fields nor question fields. */
export function recordV7Attempt(store: Store, request: V7AttemptRequest): V7AttemptOutcome {
  const key = attemptKey(request);
  let endCanon: string;
  try { endCanon = canonical(request.end); }
  catch { refuse("attempt_invalid", "end", "the end is not storable JSON"); }
  const id = v7AttemptId(key);
  const existing = store.get<V7Attempt>(id);
  if (existing !== null) return repeat(store, key, existing, endCanon);
  const current = currentPlan(store, key.project);
  if (canonical(current.planAnswer) !== canonical(key.planAnswer))
    refuse("attempt_invalid", "planAnswer",
      "a new attempt is admitted only on the current accepted plan edition");
  if (!current.questions.some(item => item.planQuestionId === key.planQuestionId))
    refuse("attempt_invalid", "planQuestionId", "the plan question is not in the current accepted plan");
  checkCall(store, key, current.draft.id);
  checkEnd(store, key, id, request.end);
  const value: V7Attempt = { contract: V7_ATTEMPT_CONTRACT, ...key,
    draft: reference(current.draft), end: request.end };
  const guards: TransactionGuard[] = [reference(current.question)];
  const endRecord = request.end as unknown as Record<string, Json>;
  if (endRecord["type"] === "duplicate") guards.push(endRecord["of"] as unknown as Ref);
  try {
    const written = store.writeMany<V7Attempt>([{ id, kind: V7_ATTEMPT_KIND, expected: 0, value }],
      uniqueTransactionGuards(guards))[0]!;
    proveAttempt(store, reference(written));
    return { attempt: written, repeated: false };
  } catch (error) {
    // A concurrent door landed this key between the read and the batch: the
    // conflict is answered by the repeat rule — the same end returns that
    // record, a different end is refused attempt_conflict. A stale guard
    // (the plan question moved) propagates with nothing written.
    if (error instanceof EngineError && error.code === "revision_conflict") {
      const landed = store.get<V7Attempt>(id);
      if (landed !== null) return repeat(store, key, landed, endCanon);
    }
    throw error;
  }
}
