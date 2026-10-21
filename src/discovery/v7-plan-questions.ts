import { readSynthesisSessionV3 } from "./synthesis-session.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { EngineError } from "../errors.js";
import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchAnswer, ResearchRun } from "./research-model.js";
import { consumerIntentContext, listResearchConsumerIntents, readResearchConsumerExecution, readResearchConsumerTurn,
  type ResearchConsumerIntent } from "./response-recovery.js";
import { planSubjectOf, type V7PlanSubject } from "./v7-managed-attempt.js";
import { synthesisReservationConsumed, turnAction, type ManagedResearchTurn } from "./research-consumer-transition.js";
import { issuedAnswerSchemaHolds, orderedQuestions, proveIssuedAnswer, readExact,
  savedAcceptanceAct } from "./projection-reader.js";
import { DISCOVERY_ACCEPTANCE_ACT_KIND, DISCOVERY_CLAIMS_CONTRACT, V7_ATTEMPT_CONTRACT,
  V7_ATTEMPT_END_CODES, V7_ATTEMPT_KIND, V7_CONTRACT_ERA, checkV7Claims,
  discoveryAcceptanceActId, provenAcceptance, type DiscoveryAcceptanceAct } from "./v7-contracts.js";

const obj = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// A function declaration — const arrow `never` loses narrowing under this compiler.
function refuse(code: string, field: string, reason: string): never {
  throw new EngineError(code, `[${field}] ${reason}`, { field, reason });
}

/* ---------- plan questions derived from the accepted plan ---------- */

/** One v7 plan-question: its stable id inside an accepted plan edition and
 * the exact Ref of the plan answer carrying it. A plan question is addressed
 * by (accepted plan answer, stable id) — never by today's question head, and
 * it is never a record inside draft.questions. */
export interface V7PlanQuestion {
  planAnswer: Ref;
  planQuestionId: string;
  /** The question element of the accepted plan value (axis, domain, text,
   * class, criterion, requiredDepth, roles, searchPlaces). */
  question: Json;
}

/** The plan-question set of one draft at one exact plan answer — proven by
 * the saved acceptance act of that exact answer plus the full research-answer
 * provenance of the saved answer itself (the same contract every claims
 * consumer applies). The bound question revision is read from the act — never
 * from today's question head — so a draft whose plan moved on still yields
 * its historical editions by their own acts. Refuses: a non-v7 or
 * non-discovery-stage draft, a missing/foreign/substituted plan answer, an
 * answer never accepted as this draft's plan, or an accepted answer whose
 * provenance does not hold up (e.g. malformed observations). */
export function provePlanQuestions(view: Store, draft: Revision<DiscoveryDraft>,
  planAnswer: Ref): V7PlanQuestion[] {
  if (draft.kind !== "discovery-draft" || !obj(draft.value)
    || draft.value.contractVersion !== V7_CONTRACT_ERA || draft.value.stage !== "discovery"
    || !Array.isArray(draft.value.questions))
    refuse("plan_questions_invalid", "draft", "plan questions live on a v7 discovery-stage draft");
  const act = view.get<DiscoveryAcceptanceAct>(
    discoveryAcceptanceActId(draft.value.projectId, draft.id, "plan", planAnswer));
  if (act === null || act.kind !== DISCOVERY_ACCEPTANCE_ACT_KIND || !obj(act.value)
    || !isRef(act.value.questionAfter))
    refuse("plan_questions_invalid", "planAnswer",
      "the ref was never accepted as this draft's plan");
  const question = readExact<Question>(view, act.value.questionAfter);
  if (question === null || question.kind !== "question" || !obj(question.value)
    || question.value.draftId !== draft.id || question.value.spec?.field !== "plan"
    || question.value.projectId !== draft.value.projectId)
    refuse("plan_questions_invalid", "planAnswer",
      "the acceptance act does not bind this draft's plan question");
  const answer = readExact<ResearchAnswer>(view, planAnswer);
  if (answer === null || answer.kind !== "research-answer" || !obj(answer.value)
    || answer.value.projectId !== draft.value.projectId || answer.value.question !== question.id)
    refuse("plan_questions_invalid", "planAnswer",
      "the ref is not this draft's saved plan answer at its exact revision");
  const fieldValue = answer.value.value;
  if (!issuedAnswerSchemaHolds(question, fieldValue))
    refuse("plan_questions_invalid", "planAnswer", "the saved value fails the plan schema");
  if (!savedAcceptanceAct(view, draft, question, "plan", planAnswer, fieldValue))
    refuse("plan_questions_invalid", "planAnswer",
      "the ref was never accepted as this draft's plan");
  // Membership precondition the real producer enforces (question_unbound):
  // the question this act names must belong to the question list of the
  // EXACT draft revisions of this acceptance. Checking draftBefore alone
  // would suffice — savedAcceptanceAct verified draftAfter carries
  // draftBefore's questions over immutably — but both exact revisions are
  // checked here so the ground is explicit, not inferred.
  for (const dRef of [act.value.draftBefore, act.value.draftAfter]) {
    const dRev = isRef(dRef) ? readExact<DiscoveryDraft>(view, dRef) : null;
    if (dRev === null || !obj(dRev.value) || !Array.isArray(dRev.value.questions)
      || !dRev.value.questions.includes(question.id))
      refuse("plan_questions_invalid", "planAnswer",
        "the plan question was never issued by this draft");
  }
  let issued: ReturnType<typeof proveIssuedAnswer>;
  try {
    issued = proveIssuedAnswer(view, draft,
      { question, foreign: false, answered: true, answerRef: planAnswer, field: "plan" },
      answer as unknown as Revision<Record<string, Json>>, { verifyIssuedQuestion: true });
  } catch (error) {
    // A record whose acceptance chain reads to nothing is unproven, not corrupt.
    if (error instanceof EngineError && error.code === "invalid_json")
      refuse("plan_questions_invalid", "planAnswer",
        "the saved plan answer has no readable acceptance chain");
    throw error;
  }
  if (!issued.ok || !provenAcceptance(issued.proof.provenance))
    refuse("plan_questions_invalid", "planAnswer",
      "the saved plan answer has no complete research provenance");
  const plan = fieldValue as Record<string, Json>;
  const questions = plan["questions"] as Json[];
  return questions.map(item => ({ planAnswer,
    planQuestionId: (item as Record<string, Json>)["id"] as string, question: item }));
}

/* ---------- the proven current plan and deterministic selection ---------- */

export interface CurrentPlan {
  draft: Revision<DiscoveryDraft>;
  question: Revision<Question>;
  planAnswer: Ref;
  questions: V7PlanQuestion[];
}

/** The project's current v7 discovery draft with its plan answered at
 * today's head — and that exact answer proven by its saved act. Selection
 * works only on this proven current plan; no caller-supplied plan answer or
 * question state is accepted. Refuses when there is no v7 draft, no plan
 * question, or the plan is not answered and proven. */
export function currentPlan(store: Store, projectId: string): CurrentPlan {
  const drafts = store.list<DiscoveryDraft>("discovery-draft")
    .filter(draft => obj(draft.value) && draft.value.projectId === projectId
      && draft.value.stage === "discovery" && draft.value.contractVersion === V7_CONTRACT_ERA);
  if (drafts.length === 0)
    refuse("plan_questions_invalid", "draft", `project ${projectId} has no v7 discovery draft`);
  // One v7 discovery draft per project is the contract; several candidates are
  // surfaced as ambiguity — never resolved by record order.
  if (drafts.length > 1)
    refuse("plan_questions_invalid", "draft",
      `project ${projectId} has ${drafts.length} v7 discovery drafts — the current one is not singled out`);
  const draft = drafts[0]!;
  const question = orderedQuestions(store, draft.value)
    .find(item => item?.value.spec.field === "plan");
  if (question === undefined || question === null)
    refuse("plan_questions_invalid", "draft", "the current v7 draft names no plan question");
  if (!obj(question.value) || question.value.status !== "answered" || !isRef(question.value.answer))
    refuse("plan_questions_invalid", "plan", "the current draft's plan is not answered yet");
  return { draft, question, planAnswer: question.value.answer,
    questions: provePlanQuestions(store, draft, question.value.answer) };
}

/** The deterministic next plan-question: blocking questions first in plan
 * order, then supporting in plan order — derived from the proven current
 * plan only. In DR3a1 every plan question is open; skipping closed/stalled
 * belongs to the DR3b state machine. */
export function nextPlanQuestion(store: Store, projectId: string): V7PlanQuestion | null {
  const { questions } = currentPlan(store, projectId);
  return questions.find(item => (item.question as Record<string, Json>)["class"] === "blocking")
    ?? questions[0] ?? null;
}

/** One initial traversal, not DR3b question acceptance: every proven end counts. */
export function planAttemptSelection(store: Store, projectId: string): CurrentPlan & {
  attempts: Revision<V7Attempt>[]; next: V7PlanQuestion | null;
} {
  const plan = currentPlan(store, projectId);
  const attempts = store.list<V7Attempt>(V7_ATTEMPT_KIND)
    .filter(record => canonical(record.value?.planAnswer ?? null) === canonical(plan.planAnswer)
      || record.value?.project === projectId && !isRef(record.value.planAnswer))
    .map(record => proveAttemptWithPlan(store, reference(record), plan).attempt);
  const ended = new Set(attempts.map(record => record.value.planQuestionId));
  const open = plan.questions.filter(question => !ended.has(question.planQuestionId));
  return { ...plan, attempts,
    next: open.find(question => (question.question as Record<string, Json>)["class"] === "blocking") ?? open[0] ?? null };
}

/** S6.2: recovery of the connected analyst/planner/owner-review turn branches only. The
 * exact saved position is selected before consulting today's accepted plan.
 * An exact unfilled v3 reservation may account for the last run position;
 * synthesis selection and execution remain with the runner. */
export function selectV7AnalystRecovery(store: Store, projectId: string, draftId: string,
  run: Revision<ResearchRun> | null, reservedSynthesis?: Ref): {
    turns: Revision<ManagedResearchTurn>[]; intents: Revision<ResearchConsumerIntent>[];
    turn: Revision<ManagedResearchTurn> | undefined;
    outstanding: Revision<ResearchConsumerIntent> | undefined;
  } {
  const runId = `research-run:${hashJson([projectId, draftId])}`;
  const invalid = (reason: string): never => refuse("research_consumer_intent_invalid", runId, reason);
  if (run && (run.id !== runId || run.kind !== "research-run" || !obj(run.value)
    || run.value.projectId !== projectId || run.value.draftId !== draftId
    || !Number.isSafeInteger(run.value.turns) || run.value.turns < 0
    || hashJson(run.value) !== run.hash || readExact<ResearchRun>(store, reference(run)) === null))
    invalid("The saved analyst run lost its exact project, draft or position");
  const turns = store.list<ManagedResearchTurn>("research-turn")
    .filter(row => row.value.run === runId)
    .map(row => readResearchConsumerTurn(store, reference(row)) as Revision<ManagedResearchTurn>)
    .sort((a, b) => a.value.number - b.value.number);
  const intents = listResearchConsumerIntents(store, projectId, draftId)
    .filter(row => row.value.cursor.run === runId);
  const pending = turns.filter(row => row.value.status === "pending");
  const unfinished = intents.filter(row => row.value.state === "prepared" || row.value.state === "running");
  if ((turns.length || unfinished.length) && !run) invalid("The unfinished analyst work lost its run");
  const session = reservedSynthesis ? readSynthesisSessionV3(store, reservedSynthesis) : null;
  if (session && (!run || session.value.projectId !== projectId || session.value.binding.draft.id !== draftId
    || session.value.delivery?.run !== runId || session.value.delivery.turn !== run.value.turns
    || run.value.turns !== turns.length + 1 || synthesisReservationConsumed(session.value)
    || pending.length || unfinished.length))
    invalid("The reserved synthesis position conflicts with another run operation");
  if (run && (turns.length !== run.value.turns - (session ? 1 : 0)
    || turns.some((row, index) => row.value.number !== index + 1)))
    invalid("The analyst turns do not prove one complete run position");
  const queued = pending.some(row => isRef(row.value.plannedBy));
  if (queued && (unfinished.length || pending.some(row => !isRef(row.value.plannedBy))
    || new Set(pending.map(row => canonical(row.value.plannedBy))).size !== 1))
    invalid("The saved reader queue conflicts with another run operation");
  if (pending.length > 1 && !queued || unfinished.length > 1)
    invalid("Several incompatible analyst operations claim this run position");
  const turn = pending[0], outstanding = unfinished[0];
  if (turn && !queued && turn.value.number !== run!.value.turns)
    invalid("The unfinished analyst turn is not at its saved run position");
  if (outstanding) {
    const value = outstanding.value;
    if (value.kind !== "analyst" && value.kind !== "reading-planner" && value.kind !== "escalation-assessor")
      refuse("research_v7_mode_unavailable", outstanding.id, "The v7 synthesis consumers are not connected");
    const owner = readExact<ResearchRun>(store, value.owner);
    const position = value.cursor.turn as number;
    const ownerPosition = value.kind === "escalation-assessor" ? position : position - 1;
    const subject = planSubjectOf(value.kind === "escalation-assessor"
      ? consumerIntentContext(store, value, outstanding.id) : value.cursor);
    const draft = readExact<DiscoveryDraft>(store, value.draft);
    const question = readExact<Question>(store, value.question);
    if (!owner || owner.kind !== "research-run" || !obj(owner.value) || owner.id !== runId
      || owner.value.projectId !== projectId || owner.value.draftId !== draftId || hashJson(owner.value) !== owner.hash
      || owner.value.turns !== ownerPosition || run!.value.turns !== ownerPosition
      || value.kind === "reading-planner" && value.cursor.mode !== "planning"
      || !subject || !draft || draft.kind !== "discovery-draft" || draft.id !== draftId
      || !obj(draft.value) || !Array.isArray(draft.value.questions) || draft.value.projectId !== projectId
      || !question || question.kind !== "question" || !obj(question.value)
      || !draft.value.questions.includes(question.id) || question.value.projectId !== projectId || question.value.draftId !== draftId
      || question.value.spec?.field !== "plan" || !isRef(question.value.answer)
      || canonical(question.value.answer) !== canonical(subject.planAnswer)
      || !provePlanQuestions(store, draft, subject.planAnswer).some(item => item.planQuestionId === subject.planQuestionId))
      invalid("The unfinished analyst intent lost its exact owner, subject or run position");
    if (value.state === "running") readResearchConsumerExecution(store, projectId, reference(outstanding));
    if (value.kind === "escalation-assessor" && (!turn || position !== turn.value.number
      || canonical(value.cursor.pendingTurn) !== canonical(reference(turn))
      || canonical(value.question) !== canonical(turn.value.question)
      || canonical(subject) !== canonical(planSubjectOf(turn.value))))
      invalid("The owner review does not own this exact pending analyst turn");
    // An already-paid turn N is older than an admitted next call N+1. Its
    // application precedes even the current-plan admission of that new send.
    if (turn && value.kind !== "escalation-assessor") return { turns, intents, turn, outstanding: undefined };
  }
  return { turns, intents, turn, outstanding };
}

/** A saved owner pause belongs to the paid turn, never to the plan field's answered flag. */
export function planOwnerSubject(store: Store, run: Revision<ResearchRun>): {
  subject: V7PlanSubject; question: Ref;
} {
  const candidates = store.list<ManagedResearchTurn>("research-turn")
    .filter(turn => turn.value.run === run.id && turn.value.number === run.value.turns);
  if (candidates.length !== 1) refuse("research_owner_question_invalid", run.id, "the owner pause lost its unique paid turn");
  const turn = readResearchConsumerTurn(store, reference(candidates[0]!)) as Revision<ManagedResearchTurn>;
  const subject = planSubjectOf(turn.value), action = turnAction(turn.value);
  if (!subject || !isRef(turn.value.question) || turn.value.status !== "completed" || action.action !== "need_owner"
    || run.value.ownerQuestion?.question !== subject.planQuestionId
    || action.question !== subject.planQuestionId
    || !obj(turn.value.observation) || turn.value.observation.necessary !== true
    || run.value.ownerQuestion.reason !== turn.value.observation.reason
    || canonical(run.value.ownerQuestion.searched) !== canonical(action.searched))
    refuse("research_owner_question_invalid", run.id, "the owner pause differs from its paid subject");
  return { subject, question: turn.value.question };
}

/* ---------- the research-attempt record (v7-attempt/v1) ---------- */

/** The terminal state of one attempt. A submitted attempt is itself the
 * claims container of its claims; refused/impossible end with a code of the
 * closed list, evidence refs and a reason text; a duplicate names the exact
 * original submitted attempt of the same plan-question. */
export type V7AttemptEnd =
  | { type: "submitted"; contract: typeof DISCOVERY_CLAIMS_CONTRACT; value: { claims: Json[] } }
  | { type: "refused" | "impossible"; code: string; evidence: Ref[]; text: string }
  | { type: "duplicate"; of: Ref };

export interface V7Attempt {
  contract: typeof V7_ATTEMPT_CONTRACT;
  project: string;
  draft: Ref;
  planAnswer: Ref;
  planQuestionId: string;
  call: Ref;
  end: V7AttemptEnd;
}

/** The logical key of an attempt: the project, the exact accepted plan-question
 * (plan answer + stable id) and the exact Ref of the generating model-call. */
export interface V7AttemptKey {
  project: string;
  planAnswer: Ref;
  planQuestionId: string;
  call: Ref;
}

/** The attempt record id is deterministic from the attempt key (the DR3a
 * packet): the same (project, plan-question, call) always names the same
 * record — the DR3a2 door repeats by this key without rewriting the record,
 * and a different key never collides with it. The id is the fixed prefix
 * plus the key hash — raw identifiers live in the record body, so a lawful
 * long plan-question id can never push the address past the Store limit. */
export function v7AttemptId(key: V7AttemptKey): string {
  return `research-attempt:${hashJson({ project: key.project,
    planAnswer: canonical(key.planAnswer), planQuestionId: key.planQuestionId,
    call: canonical(key.call) })}`;
}

export interface V7AttemptProof {
  attempt: Revision<V7Attempt>;
  draft: Revision<DiscoveryDraft>;
  planQuestion: V7PlanQuestion;
  /** The claims of a submitted end — undefined for every other end. */
  claims?: Json[];
}

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

/** The exact-Ref existence prover for claims and ends: the named record is
 * present at its revision and hash and belongs to this project by the
 * membership field its kind and contract version declare. */
function projectRefOf(view: Store, project: string) {
  return (ref: Ref): boolean => {
    const record = readExact<Record<string, Json>>(view, ref);
    return record !== null && obj(record.value)
      && projectOfRecord(record) === project;
  };
}

/** The attempt reader-demonstrator of DR3a1: a structurally whole attempt —
 * its deterministic id, v7 draft, a plan-question proven inside the accepted
 * plan at the exact plan answer, a model-call of the same project/draft/
 * plan-question, and a consistent end — proven by the saved records alone.
 * The read is historical: a draft reopened or a plan re-edited afterwards
 * changes nothing. What acceptance of an attempt MEANS is not decided yet;
 * this proof is the structural half the DR3b admission will build on. */
export function proveAttempt(view: Store, ref: Ref): V7AttemptProof {
  return proveAttemptWithPlan(view, ref);
}

function proveAttemptWithPlan(view: Store, ref: Ref, plan?: CurrentPlan): V7AttemptProof {
  const attempt = readExact<V7Attempt>(view, ref);
  if (attempt === null || attempt.kind !== V7_ATTEMPT_KIND || attempt.revision !== 1)
    refuse("attempt_invalid", "attempt", "the record is missing, foreign or changed");
  const value = attempt.value;
  if (!obj(value) || value["contract"] !== V7_ATTEMPT_CONTRACT)
    refuse("attempt_invalid", "contract", "the attempt carries the v7-attempt/v1 contract");
  if (!nonempty(value["project"]))
    refuse("attempt_invalid", "project", "an attempt belongs to its project");
  if (!isRef(value["draft"]) || !isRef(value["planAnswer"]) || !nonempty(value["planQuestionId"])
    || !isRef(value["call"]))
    refuse("attempt_invalid", "key", "an attempt names its draft, plan answer, plan question and call");
  const key: V7AttemptKey = { project: value["project"], planAnswer: value["planAnswer"],
    planQuestionId: value["planQuestionId"], call: value["call"] };
  if (attempt.id !== v7AttemptId(key))
    refuse("attempt_invalid", "id", "the record id is not the deterministic id of its key");
  const draft = readExact<DiscoveryDraft>(view, value["draft"]);
  if (draft === null || draft.kind !== "discovery-draft" || !obj(draft.value)
    || draft.value.projectId !== value["project"] || draft.value.contractVersion !== V7_CONTRACT_ERA
    || draft.value.stage !== "discovery")
    refuse("attempt_invalid", "draft", "the attempt's draft is missing, foreign or not a v7 discovery draft");
  const questions = plan && canonical(reference(draft)) === canonical(reference(plan.draft))
    && canonical(value["planAnswer"]) === canonical(plan.planAnswer)
    ? plan.questions : provePlanQuestions(view, draft, value["planAnswer"]);
  const planQuestion = questions
    .find(item => item.planQuestionId === value["planQuestionId"]);
  if (planQuestion === undefined)
    refuse("attempt_invalid", "planQuestionId", "the plan question is not in the proven accepted plan");
  const call = readExact<Record<string, Json>>(view, value["call"]);
  if (call === null || call.kind !== "model-call" || !obj(call.value)
    || call.value["projectId"] !== value["project"]
    || call.value["draftId"] !== draft.id || call.value["questionId"] !== value["planQuestionId"]
    || !isRef(call.value["planAnswer"])
    || canonical(call.value["planAnswer"]) !== canonical(value["planAnswer"]))
    refuse("attempt_invalid", "call",
      "the generating call is missing, foreign, for another plan-question or another plan edition");
  const end = value["end"] as unknown;
  const proof: V7AttemptProof = { attempt, draft, planQuestion };
  const projectRef = projectRefOf(view, value["project"]);
  if (!obj(end) || typeof end["type"] !== "string")
    refuse("attempt_invalid", "end", "an attempt ends submitted, refused, impossible or duplicate");
  switch (end["type"]) {
    case "submitted": {
      if (end["contract"] !== DISCOVERY_CLAIMS_CONTRACT || !obj(end["value"]))
        refuse("attempt_invalid", "end", "a submitted end carries the claims contract and its value");
      checkV7Claims(end["value"]["claims"],
        { project: key.project, planAnswer: key.planAnswer, planQuestionId: key.planQuestionId, projectRef });
      proof.claims = end["value"]["claims"] as Json[];
      break;
    }
    case "refused": case "impossible": {
      if (typeof end["code"] !== "string" || !(V7_ATTEMPT_END_CODES as readonly string[]).includes(end["code"]))
        refuse("attempt_invalid", "end.code", `a ${end["type"]} end needs a code from the closed list`);
      if (!Array.isArray(end["evidence"]) || end["evidence"].some(item => !isRef(item) || !projectRef(item)))
        refuse("attempt_invalid", "end.evidence", "the evidence is a list of exact refs of this project");
      if (!nonempty(end["text"]))
        refuse("attempt_invalid", "end.text", "the end states its reason");
      break;
    }
    case "duplicate": {
      if (!isRef(end["of"])) refuse("attempt_invalid", "end.of", "a duplicate names its original attempt");
      if ((end["of"] as Ref).id === ref.id)
        refuse("attempt_invalid", "end.of", "a duplicate cannot name itself");
      // The original must itself be a proven submitted attempt of the same
      // project, plan edition and plan-question — a fake record or a foreign
      // edition is refused by the same structural contract. Only a submitted
      // end is proven recursively, so the descent always stops at one hop.
      const original = readExact<V7Attempt>(view, end["of"]);
      if (original === null || original.kind !== V7_ATTEMPT_KIND || !obj(original.value)
        || !obj(original.value.end) || original.value.end["type"] !== "submitted")
        refuse("attempt_invalid", "end.of",
          "the original is not a submitted attempt of this plan-question at this plan edition");
      const provenOriginal = proveAttemptWithPlan(view, end["of"], plan);
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
  return proof;
}
