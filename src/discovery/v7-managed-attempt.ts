import { canonical, hashJson, type Json } from "../canonical.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import { EngineError } from "../errors.js";
import { DISCOVERY_CLAIMS_CONTRACT, V7_ATTEMPT_END_CODES } from "./v7-contracts.js";
import type { V7AttemptEnd } from "./v7-plan-questions.js";

/* DR3a3-K (codex-omg №7475): the managed-attempt contract of the v7 analyst path.
 *
 * A v7 attempt is research on one plan-question of one accepted plan edition.
 * Its consumer intent keeps the exact Ref of the real `plan` field Question as
 * its basis (intent.question) and names the subject of the attempt separately
 * in the typed, mandatory cursor.subject — the exact plan answer and the
 * stable plan-question id. One Question never means one plan-question: every
 * comparison of logical steps, every call-ownership check and the immutable
 * fields of the turn carry the subject. The turn producer fixes the attempt
 * era on O@1 (attemptContract, parallel to acceptanceContract) together with
 * the same subject; such a turn completes from its paid answer only through
 * the attempt binding written atomically with the completed turn. */

export const V7_PLAN_SUBJECT_CONTRACT = "v7-plan-subject/v1" as const;
export const ATTEMPT_BINDING_CONTRACT = "research-attempt-binding/v1" as const;
export const ATTEMPT_BINDING_KIND = "research-attempt-binding" as const;

/** The subject of one v7 attempt: fixed before dispatch, immutable afterwards. */
export interface V7PlanSubject {
  contract: typeof V7_PLAN_SUBJECT_CONTRACT;
  planAnswer: Ref;
  planQuestionId: string;
}
const SUBJECT_FIELDS = ["contract", "planAnswer", "planQuestionId"] as const;

/** The managed observation of one recorded attempt: the exact original turn
 * (O@1), the pending revision it completed (P), the producing intent (I@1),
 * the subject and the proven attempt. No assessment links: an attempt is not
 * an accepted answer, and its acceptance belongs to DR3b. The record never
 * references the completed turn; the completed turn references it. */
export interface ResearchAttemptBinding {
  contract: typeof ATTEMPT_BINDING_CONTRACT;
  projectId: string;
  turn: Ref;
  pending: Ref;
  intent: Ref;
  planAnswer: Ref;
  planQuestionId: string;
  attempt: Ref;
}
export const ATTEMPT_BINDING_FIELDS = ["contract", "projectId", "turn", "pending", "intent",
  "planAnswer", "planQuestionId", "attempt"] as const;
export const attemptBindingId = (projectId: string, turnId: string) =>
  `research-attempt-binding:v1:${hashJson({ projectId, turnId })}`;

const obj = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** The subject a saved consumer cursor declares: null when the cursor names
 * none (the field-question path), the exact typed subject otherwise. A
 * present but damaged, incomplete or unknown-contract subject is refused —
 * never read as "no subject". */
export function planSubjectOf(cursor: unknown): V7PlanSubject | null {
  if (!obj(cursor) || !Object.hasOwn(cursor, "subject")) return null;
  const subject = cursor["subject"];
  if (!obj(subject) || !exactKeys(subject, SUBJECT_FIELDS) || subject["contract"] !== V7_PLAN_SUBJECT_CONTRACT
    || !isRef(subject["planAnswer"]) || !nonempty(subject["planQuestionId"]))
    throw new EngineError("research_consumer_intent_invalid",
      "The attempt subject names the v7-plan-subject/v1 contract, an exact plan answer and a plan-question id",
      { reason: "subject" });
  return { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: subject["planAnswer"],
    planQuestionId: subject["planQuestionId"] };
}

/** Two cursors name the same subject: both none, or the same exact plan
 * answer and plan-question id. One Question at two plan-questions, or one
 * plan-question id in two plan editions, are different subjects. */
export function sameSubject(a: V7PlanSubject | null, b: V7PlanSubject | null): boolean {
  return canonical(a as unknown as Json) === canonical(b as unknown as Json);
}

/** The question id a paid action and a paid call address: the plan-question
 * id for an attempt subject, the Question record id otherwise. */
export function addressedQuestionId(question: Ref, subject: V7PlanSubject | null): string {
  return subject ? subject.planQuestionId : question.id;
}

/** DR3a3-S1 (решение 5): the one address of the paid-step dispatch counter.
 * A subject step serialises on its project+subject (the scope C writes); a
 * field question keeps its Question-id counter unchanged. Producers and
 * recovery readers derive the counter only through this formula. */
export function questionDispatchId(projectId: string, questionId: string, subject: V7PlanSubject | null): string {
  return `question-dispatch:${hashJson(subject ? [projectId, subject] as unknown as Json : questionId)}`;
}

/** Call ownership by subject: an attempt's call names the plan-question id
 * and the exact plan answer; a field-question call names the Question record
 * id and carries no plan answer. Matching the id alone is not enough. */
export function callAddressesSubject(call: Record<string, unknown>, question: Ref,
  subject: V7PlanSubject | null): boolean {
  if (!subject) return call["questionId"] === question.id && !Object.hasOwn(call, "planAnswer");
  return call["questionId"] === subject.planQuestionId && isRef(call["planAnswer"])
    && canonical(call["planAnswer"] as unknown as Json) === canonical(subject.planAnswer as unknown as Json);
}

/** The end a paid answer states for its attempt — the single mapping shared
 * by the turn producer and the attempt binding. The existing ResearchAction
 * envelope carries it: {action:"answer", question: planQuestionId,
 * value: <one of the four DR3a2 ends verbatim>, citations: []}. The bases of a
 * claim live inside the end; free text is never turned into a refusal code,
 * and answer_delta is not an attempt end. Deeper checks of the end (claims,
 * evidence existence, a duplicate's original) belong to the DR3a2 door. */
export function attemptEndOfAction(action: unknown, subject: V7PlanSubject): V7AttemptEnd {
  const invalid = (reason: string): never => {
    throw new EngineError("research_response_invalid",
      `[${subject.planQuestionId}] The paid answer is not an end of this plan-question's attempt: ${reason}`,
      { planQuestionId: subject.planQuestionId, reason });
  };
  if (!obj(action) || action["action"] !== "answer") invalid("action");
  const answer = action as Record<string, unknown>;
  if (!exactKeys(answer, ["action", "question", "value", "citations"])) invalid("envelope");
  if (answer["question"] !== subject.planQuestionId) invalid("question");
  if (!Array.isArray(answer["citations"]) || answer["citations"].length !== 0) invalid("citations");
  const end = answer["value"];
  if (!obj(end)) invalid("end");
  const value = end as Record<string, unknown>;
  switch (value["type"]) {
    case "submitted":
      if (!exactKeys(value, ["type", "contract", "value"]) || value["contract"] !== DISCOVERY_CLAIMS_CONTRACT
        || !obj(value["value"]) || !exactKeys(value["value"], ["claims"])
        || !Array.isArray((value["value"] as Record<string, unknown>)["claims"])) invalid("end.submitted");
      break;
    case "refused": case "impossible":
      if (!exactKeys(value, ["type", "code", "evidence", "text"]) || typeof value["code"] !== "string"
        || !(V7_ATTEMPT_END_CODES as readonly string[]).includes(value["code"])
        || !Array.isArray(value["evidence"]) || !value["evidence"].every(isRef) || !nonempty(value["text"]))
        invalid(`end.${value["type"]}`);
      break;
    case "duplicate":
      if (!exactKeys(value, ["type", "of"]) || !isRef(value["of"])) invalid("end.duplicate");
      break;
    default:
      invalid("end.type");
  }
  return end as unknown as V7AttemptEnd;
}
