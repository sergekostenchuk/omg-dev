import test from "node:test";
import assert from "node:assert/strict";
import { type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, DISCOVERY_CLAIMS_CONTRACT } from "../src/discovery/v7-contracts.js";
import { type V7AttemptEnd } from "../src/discovery/v7-plan-questions.js";
import { recordV7Attempt } from "../src/discovery/v7-attempts.js";
import { completeResearchAttemptTurn, prepareResearchAttemptCompletion, readResearchAttemptBinding,
  readResearchConsumerIntent, readResearchConsumerTurn, researchConsumerIntentId, prepareResearchConsumerIntent,
  type ResearchConsumerIntent } from "../src/discovery/response-recovery.js";
import { ACTION_RESPONSE_REFUSAL_CODES, attemptEraOf, managedTurnId, projectPaidOwnerReview, projectPaidTurnAdmission, turnQuestionId,
  projectResearchTurnRevision, projectSynthesisHandoffTurn, type ManagedResearchTurn,
  type TurnTransitionProof } from "../src/discovery/research-consumer-transition.js";
import { ATTEMPT_BINDING_CONTRACT, ATTEMPT_BINDING_KIND, V7_PLAN_SUBJECT_CONTRACT, attemptBindingId,
  attemptEndOfAction, callAddressesSubject, planSubjectOf, sameSubject,
  type ResearchAttemptBinding, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import type { ResearchRun } from "../src/discovery/research-model.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { uniqueTransactionGuards } from "../src/runtime/environment.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, rand, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";

// DR3a3-K (codex-omg №7475): the attempt binding of a managed v7 analyst turn.
// The ordinary call path (DR3a3-C) and the runner (DR3a3-R) are not connected
// yet, so these fixtures model them explicitly: the consumer chain is written
// record by record in the producers' saved form, the original turn comes from
// the real projectPaidTurnAdmission, and the model-call carries the plan answer
// C will write. The door, the binding, the completion and every reader are real.

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3a3k-");
type Fixture = ReturnType<typeof fixture>;

const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};
/** The code, the addressed reason and the message of a refusal — a test of
 * absence asserts WHY it refused, not only that some check fired. */
const failure = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    const e = error as EngineError, reason = (e.details as { reason?: unknown } | null)?.reason;
    return `${e.code}${typeof reason === "string" ? `/${reason}` : ""}: ${e.message}`;
  }
  return "no-error";
};
const asJson = <T>(value: T): Json => value as unknown as Json;

/** The real plan acceptance chain (frame and plan through #answer). */
function acceptPlan(f: Fixture, project: string, questions: PlanQuestion[]) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, questions), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
/** The next lawful plan edition: reopen and accept again. */
function acceptNextPlanEdition(f: Fixture, project: string, draft: Revision<DiscoveryDraft>, frameRef: Ref,
  previous: Ref, questions: PlanQuestion[]) {
  const planQ = questionOf(f.store, f.store.get<DiscoveryDraft>(draft.id)!, "plan");
  f.discovery.reopen(planQ.id, planQ.revision);
  const reopened = f.store.get<Question>(planQ.id)!;
  const src = f.discovery.evidence.document(project, `basis-${rand()}`, `Source ${rand()}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!, reopened,
    validPlan(frameRef, questions, 2, previous), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(draft.id)!, plan, planAnswer: plan.value.answer! };
}
function projectRecord(store: Store, project: string): Revision<Record<string, Json>> {
  return store.write({ id: `source:${project}:${rand()}`, kind: "source", expected: 0,
    value: { projectId: project, content: "basis" } });
}
function factClaim(store: Store, project: string, id: string, planAnswer: Ref, planQuestionId: string): Json {
  const src = projectRecord(store, project);
  return { id, kind: "fact", text: `Claim ${id}`, axis: "market",
    planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId }], scope: { variants: "common" },
    basis: { source: { ref: asJson(reference(src)), range: { start: 0, end: 3 }, valueHash: hashJson("v") },
      limit: "snapshot", asOf: "2026-10" } } as unknown as Json;
}
const subjectOf = (planAnswer: Ref, planQuestionId: string): V7PlanSubject =>
  ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId });
const answerAction = (planQuestionId: string, end: V7AttemptEnd): Json =>
  ({ action: "answer", question: planQuestionId, value: asJson(end), citations: [] });
const writeRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });

/** The managed consumer chain C and R will produce, in the producers' saved
 * form: run@1 → intent@1 (prepared, cursor.subject) → the paid model-call
 * bound to it with the plan answer → intent@2 (running) → one application
 * batch: run@2, the original turn O@1 (real producer) and intent@3 (applied). */
function managedChain(f: Fixture, opts: { draft: Revision<DiscoveryDraft>; plan: Revision<Question>;
  subject: V7PlanSubject; action: Json; store?: Store;
  call?: { questionId?: string; planAnswer?: Ref | null };
  /** A producer that wrote another O@1 in the same application batch. */
  forgeTurn?: (turn: ManagedResearchTurn) => Record<string, unknown> }) {
  const store = opts.store ?? f.store, project = opts.draft.value.projectId;
  const runId = `research-run:${project}:${rand()}`;
  const runValue: ResearchRun = { projectId: project, draftId: opts.draft.id, environment: reference(opts.draft),
    status: "running", turns: 0, limit: 5, inputs: [], ownerQuestion: null, error: null, pauseCode: null,
    owner: { pid: 1, started: "fixture" }, requestChars: 0 };
  const run1 = store.write<ResearchRun>({ id: runId, kind: "research-run", expected: 0, value: runValue });
  const key = `v7-attempt-${rand()}`, owner = reference(run1);
  const intent1Value: ResearchConsumerIntent = { contract: "research-consumer-intent/v1", projectId: project,
    kind: "analyst", key, rootKey: key, generation: 0, previous: null, owner,
    draft: reference(opts.draft), question: reference(opts.plan),
    role: { actor: "fixture", model: "fixture", effort: "medium", command: { executable: "fixture", args: [] } },
    dispatch: { projectId: project } as unknown as ResearchConsumerIntent["dispatch"], profile: null,
    cursor: { context: {}, prompt: "Research the plan-question", run: runId, turn: 1, subject: opts.subject },
    basis: [], guards: uniqueTransactionGuards([owner, reference(opts.draft), reference(opts.plan)]),
    state: "prepared", call: null, request: null, archive: null, outputs: null, refusal: null };
  const intentId = researchConsumerIntentId(project, "analyst", key, 0);
  const intent1 = store.write<ResearchConsumerIntent>({ id: intentId, kind: "research-consumer-intent",
    expected: 0, value: intent1Value });
  const callPlanAnswer = opts.call?.planAnswer === undefined ? opts.subject.planAnswer : opts.call.planAnswer;
  const call = store.write({ id: `model-call:consumer:v1:${rand()}`, kind: "model-call", expected: 0,
    value: { projectId: project, draftId: opts.draft.id,
      questionId: opts.call?.questionId ?? opts.subject.planQuestionId,
      ...(callPlanAnswer === null ? {} : { planAnswer: asJson(callPlanAnswer) }),
      purpose: "analyst", requestId: `r-${rand()}`, consumerIntent: asJson(reference(intent1)),
      startedAt: 1, finishedAt: 2, status: "succeeded",
      requested: asJson(intent1Value.role), confirmed: { model: "fixture", effort: "medium", speed: null },
      request: { chars: 10, bytes: 10, hash: hashJson("req") }, response: { chars: 20, bytes: 20 },
      usage: null, usageSource: "unavailable", error: null } as unknown as Record<string, Json> });
  const intent2 = store.write<ResearchConsumerIntent>({ id: intentId, kind: "research-consumer-intent",
    expected: 1, value: { ...intent1Value, state: "running", call: reference(call), request: reference(call),
      archive: reference(call) } });
  const projected = projectPaidTurnAdmission(run1.value, { runId, intent: reference(intent1),
    response: opts.action, question: reference(opts.plan), owner: runValue.owner, limit: 5, context: {},
    subject: opts.subject });
  const runWrite: Write = { id: runId, kind: "research-run", expected: 1, value: projected.run };
  const turnWrite: Write = { id: managedTurnId(runId, 1), kind: "research-turn", expected: 0,
    value: (opts.forgeTurn ? opts.forgeTurn(projected.turn) : projected.turn) as unknown as Record<string, Json> };
  const appliedWrite: Write = { id: intentId, kind: "research-consumer-intent", expected: 2,
    value: { ...intent2.value, state: "applied", outputs: [writeRef(runWrite), writeRef(turnWrite)] } };
  const [, turn] = store.writeMany([runWrite, turnWrite, appliedWrite]);
  return { project, runId, intent1, call, turn: turn as unknown as Revision<ManagedResearchTurn> };
}

/** One v7 project with an accepted plan of two plan-questions on one plan Question. */
function v7Project(f: Fixture, project = `p${rand()}`) {
  const accepted = acceptPlan(f, project, [planQuestion("q-industry", "industry", "blocking"),
    planQuestion("q-market", "market")]);
  return { project, ...accepted };
}
const ends = (f: Fixture, project: string, planAnswer: Ref, planQuestionId: string) => ({
  submitted: (): V7AttemptEnd => ({ type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT,
    value: { claims: [factClaim(f.store, project, `c-${rand()}`, planAnswer, planQuestionId)] } }),
  refused: (): V7AttemptEnd => ({ type: "refused", code: "source_unavailable",
    evidence: [reference(projectRecord(f.store, project))], text: "The named source is not reachable" }),
  impossible: (): V7AttemptEnd => ({ type: "impossible", code: "source_unavailable",
    evidence: [], text: "No lawful source can answer this" }),
});

/** A recorded attempt turn end to end: chain → door → completion. */
function recordedTurn(f: Fixture, v: ReturnType<typeof v7Project>, planQuestionId: string, end: V7AttemptEnd) {
  const subject = subjectOf(v.planAnswer, planQuestionId);
  const chain = managedChain(f, { draft: v.draft, plan: v.plan, subject, action: answerAction(planQuestionId, end) });
  const attempt = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer, planQuestionId,
    call: reference(chain.call), end }).attempt;
  return { subject, chain, attempt };
}

test("DR3a3-K: four ends complete through the attempt binding; readers prove the turn warm and cold; a repeat writes nothing", t => {
  const f = fixture(t), v = v7Project(f), e = ends(f, v.project, v.planAnswer, "q-industry");
  const original = recordedTurn(f, v, "q-industry", e.submitted());
  const done = completeResearchAttemptTurn(f.store, v.project, reference(original.chain.turn), reference(original.attempt));
  assert.equal(done.repeated, false);
  const cases: [string, V7AttemptEnd][] = [["refused", e.refused()], ["impossible", e.impossible()],
    ["duplicate", { type: "duplicate", of: reference(original.attempt) }]];
  const completed = [done];
  for (const [, end] of cases) {
    const r = recordedTurn(f, v, "q-industry", end);
    completed.push(completeResearchAttemptTurn(f.store, v.project, reference(r.chain.turn), reference(r.attempt)));
  }
  for (const [index, result] of completed.entries()) {
    const turn = result.turn.value;
    assert.equal(turn.status, "completed");
    assert.equal(turn.attemptContract, ATTEMPT_BINDING_CONTRACT);
    assert.equal(attemptEraOf(turn), "attempt");
    assert.equal(turn.assessment, null);
    assert.deepEqual((turn.observation as { end: string }).end, ["submitted", "refused", "impossible", "duplicate"][index]);
    assert.deepEqual(turn.attemptBinding, reference(result.binding));
    assert.equal(result.binding.kind, ATTEMPT_BINDING_KIND);
    assert.equal(result.binding.id, attemptBindingId(v.project, result.turn.id));
    // No assessment links, exactly the K fields of an attempt.
    assert.deepEqual(Object.keys(result.binding.value).sort(),
      ["attempt", "contract", "intent", "pending", "planAnswer", "planQuestionId", "projectId", "turn"]);
    readResearchConsumerTurn(f.store, reference(result.turn));
    const cold = f.open();
    readResearchConsumerTurn(cold, reference(result.turn));
    const proven = readResearchAttemptBinding(cold, v.project, result.turn.id)!;
    assert.deepEqual(reference(proven.binding), reference(result.binding));
    // The Question basis and the draft fields are untouched by the attempt path.
    assert.equal(cold.get<Question>(v.plan.id)!.revision, v.plan.revision);
    assert.equal(cold.get<DiscoveryDraft>(v.draft.id)!.revision, v.draft.revision);
  }
  const before = { bindings: f.store.list(ATTEMPT_BINDING_KIND).length, head: f.store.get(done.turn.id)!.revision };
  const warm = completeResearchAttemptTurn(f.store, v.project, reference(original.chain.turn), reference(original.attempt));
  const cold = completeResearchAttemptTurn(f.open(), v.project, reference(original.chain.turn), reference(original.attempt));
  assert.equal(warm.repeated, true);
  assert.equal(cold.repeated, true);
  assert.deepEqual(reference(cold.turn), reference(done.turn));
  assert.deepEqual({ bindings: f.store.list(ATTEMPT_BINDING_KIND).length, head: f.store.get(done.turn.id)!.revision }, before);
  assert.deepEqual(checkStoreIntegrity(f.open()).findings ?? [], []);
});

test("DR3a3-K: the end must derive from the paid payload — another end, another plan-question of the same Question, another plan edition do not match", t => {
  const f = fixture(t), v = v7Project(f);
  const e = ends(f, v.project, v.planAnswer, "q-industry");
  // The paid payload states `refused`; the door recorded `impossible` for the same call.
  const paidEnd = e.refused();
  const subject = subjectOf(v.planAnswer, "q-industry");
  const chain = managedChain(f, { draft: v.draft, plan: v.plan, subject, action: answerAction("q-industry", paidEnd) });
  const other = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer, planQuestionId: "q-industry",
    call: reference(chain.call), end: e.impossible() }).attempt;
  assert.match(failure(() => completeResearchAttemptTurn(f.store, v.project, reference(chain.turn), reference(other))), /^research_attempt_binding_invalid\/attempt-formula: /);
  assert.equal(f.store.list(ATTEMPT_BINDING_KIND).length, 0);
  assert.equal(f.store.get(chain.turn.id)!.revision, 1);
  // One plan Question, two plan-questions: an attempt of q-market never completes the q-industry turn.
  const marketEnd = ends(f, v.project, v.planAnswer, "q-market").refused();
  const market = managedChain(f, { draft: v.draft, plan: v.plan, subject: subjectOf(v.planAnswer, "q-market"),
    action: answerAction("q-market", marketEnd) });
  const marketAttempt = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer,
    planQuestionId: "q-market", call: reference(market.call), end: marketEnd }).attempt;
  assert.match(failure(() => completeResearchAttemptTurn(f.store, v.project, reference(chain.turn),
    reference(marketAttempt))), /^research_attempt_binding_invalid\/attempt-formula: /);
  assert.equal(sameSubject(subject, subjectOf(v.planAnswer, "q-market")), false);
  // The same plan-question id in the next plan edition is another subject.
  const next = acceptNextPlanEdition(f, v.project, v.draft, v.frameRef, v.planAnswer,
    [planQuestion("q-industry", "industry", "blocking"), planQuestion("q-market", "market")]);
  const nextEnd = ends(f, v.project, next.planAnswer, "q-industry").refused();
  const later = managedChain(f, { draft: next.draft, plan: next.plan, subject: subjectOf(next.planAnswer, "q-industry"),
    action: answerAction("q-industry", nextEnd) });
  const laterAttempt = recordV7Attempt(f.store, { project: v.project, planAnswer: next.planAnswer,
    planQuestionId: "q-industry", call: reference(later.call), end: nextEnd }).attempt;
  assert.equal(sameSubject(subject, subjectOf(next.planAnswer, "q-industry")), false);
  assert.match(failure(() => completeResearchAttemptTurn(f.store, v.project, reference(chain.turn),
    reference(laterAttempt))), /^research_attempt_binding_invalid\/attempt-formula: /);
  // The right attempt still completes it after the plan moved on (the record is historical).
  const right = recordV7Attempt(f.store, { project: v.project, planAnswer: next.planAnswer, planQuestionId: "q-industry",
    call: reference(later.call), end: nextEnd }).attempt;
  assert.equal(completeResearchAttemptTurn(f.store, v.project, reference(later.turn), reference(right)).repeated, false);
  assert.equal(f.store.list(ATTEMPT_BINDING_KIND).length, 1);
});

test("DR3a3-K: foreign project, foreign call and a completed revision named as P are typed refusals", t => {
  const f = fixture(t), v = v7Project(f), w = v7Project(f);
  const end = ends(f, v.project, v.planAnswer, "q-industry").refused();
  const chain = managedChain(f, { draft: v.draft, plan: v.plan, subject: subjectOf(v.planAnswer, "q-industry"),
    action: answerAction("q-industry", end) });
  // Another project's attempt with an equal end.
  const foreignEnd = ends(f, w.project, w.planAnswer, "q-industry").refused();
  const foreignChain = managedChain(f, { draft: w.draft, plan: w.plan, subject: subjectOf(w.planAnswer, "q-industry"),
    action: answerAction("q-industry", foreignEnd) });
  const foreign = recordV7Attempt(f.store, { project: w.project, planAnswer: w.planAnswer, planQuestionId: "q-industry",
    call: reference(foreignChain.call), end: foreignEnd }).attempt;
  assert.match(failure(() => completeResearchAttemptTurn(f.store, v.project, reference(chain.turn), reference(foreign))), /^research_attempt_binding_invalid\/attempt-formula: /);
  // The same subject and end, but the call of another intent of this project.
  const twin = managedChain(f, { draft: v.draft, plan: v.plan, subject: subjectOf(v.planAnswer, "q-industry"),
    action: answerAction("q-industry", end) });
  const twinAttempt = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer, planQuestionId: "q-industry",
    call: reference(twin.call), end }).attempt;
  assert.match(failure(() => completeResearchAttemptTurn(f.store, v.project, reference(chain.turn), reference(twinAttempt))), /^research_attempt_binding_invalid\/attempt-formula: /);
  assert.equal(f.store.list(ATTEMPT_BINDING_KIND).length, 0);
  // A binding at its own address naming the completed revision as its P is refused before the recursive read.
  const third = managedChain(f, { draft: v.draft, plan: v.plan, subject: subjectOf(v.planAnswer, "q-industry"),
    action: answerAction("q-industry", end) });
  const thirdAttempt = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer,
    planQuestionId: "q-industry", call: reference(third.call), end }).attempt;
  const prepared = prepareResearchAttemptCompletion(f.store, v.project, reference(third.turn), reference(thirdAttempt));
  const completed = f.store.write({ id: third.turn.id, kind: "research-turn", expected: 1,
    value: prepared.turn as unknown as Record<string, Json> });
  f.store.write({ id: attemptBindingId(v.project, third.turn.id), kind: ATTEMPT_BINDING_KIND, expected: 0,
    value: { ...prepared.binding, pending: reference(completed) } as unknown as Record<string, Json> });
  assert.match(failure(() => readResearchAttemptBinding(f.store, v.project, third.turn.id)),
    /^research_attempt_binding_invalid\/pending-turn: /);
  assert.match(failure(() => readResearchConsumerTurn(f.store, reference(completed))),
    /^research_attempt_binding_invalid\/pending-turn: /);
  // The own attempt of the turn still completes it, and the foreign refusals left nothing behind.
  const own = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer, planQuestionId: "q-industry",
    call: reference(chain.call), end }).attempt;
  const done = completeResearchAttemptTurn(f.store, v.project, reference(chain.turn), reference(own));
  assert.equal(done.repeated, false);
  assert.equal(readResearchAttemptBinding(f.store, v.project, done.turn.id)!.binding.id, done.binding.id);
});

test("DR3a3-K: absence — no subject, no marker, an unknown marker, a damaged subject, no binding link or no binding record are typed refusals", t => {
  const f = fixture(t), v = v7Project(f);
  const subject = subjectOf(v.planAnswer, "q-industry");
  const chainOf = (forgeTurn?: (turn: ManagedResearchTurn) => Record<string, unknown>) => managedChain(f,
    { draft: v.draft, plan: v.plan, subject, ...(forgeTurn ? { forgeTurn } : {}),
      action: answerAction("q-industry", ends(f, v.project, v.planAnswer, "q-industry").refused()) });
  // O@1 of a subject intent written by a producer that dropped or damaged the era: the application batch
  // and the intent's outputs are exact, so only the era check can refuse.
  const strip = ({ attemptContract: _m, subject: _s, ...rest }: ManagedResearchTurn) => rest;
  const cases: [string, (turn: ManagedResearchTurn) => Record<string, unknown>, RegExp][] = [
    ["no marker, no subject", turn => strip(turn), /differs from the subject its producing intent fixed/],
    ["marker without subject", turn => ({ ...strip(turn), attemptContract: ATTEMPT_BINDING_CONTRACT }),
      /unknown attempt contract or lost its attempt subject/],
    ["subject without marker", turn => ({ ...strip(turn), subject }), /unknown attempt contract or lost its attempt subject/],
    ["unknown marker", turn => ({ ...turn, attemptContract: "research-attempt-binding/v0" }),
      /unknown attempt contract or lost its attempt subject/],
    ["damaged subject", turn => ({ ...turn, subject: { ...subject, contract: "v7-plan-subject/v0" } }),
      /damaged attempt subject/],
    ["another plan-question", turn => ({ ...turn, subject: subjectOf(v.planAnswer, "q-market") }),
      /differs from the subject its producing intent fixed/],
  ];
  for (const [name, forge, reason] of cases) {
    const forged = chainOf(forge);
    const result = failure(() => readResearchConsumerTurn(f.store, reference(forged.turn)));
    assert.match(result, /^research_consumer_intent_invalid: /, name);
    assert.match(result, reason, name);
  }
  // The control: the same chain with the producer's own O@1 reads.
  const chain = chainOf();
  readResearchConsumerTurn(f.store, reference(chain.turn));
  // A damaged saved subject on the intent is refused by the intent reader.
  const damagedKey = `damaged-${rand()}`;
  const damagedId = researchConsumerIntentId(v.project, "analyst", damagedKey, 0);
  f.store.write({ id: damagedId, kind: "research-consumer-intent", expected: 0,
    value: { ...chain.intent1.value, key: damagedKey, rootKey: damagedKey,
      cursor: { ...chain.intent1.value.cursor, subject: { ...subject, contract: "v7-plan-subject/v0" } } } as unknown as Record<string, Json> });
  assert.match(failure(() => readResearchConsumerIntent(f.store, reference(f.store.get(damagedId)!))),
    /^research_consumer_intent_invalid: /);
  // A completed attempt turn without its binding link, or naming a binding never written.
  const end = (chain.turn.value.action as { value: V7AttemptEnd }).value;
  const own = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer, planQuestionId: "q-industry",
    call: reference(chain.call), end }).attempt;
  const prepared = prepareResearchAttemptCompletion(f.store, v.project, reference(chain.turn), reference(own));
  const { attemptBinding: _link, ...unlinked } = prepared.turn;
  const noLink = f.open();
  noLink.write({ id: chain.turn.id, kind: "research-turn", expected: 1, value: unlinked as unknown as Record<string, Json> });
  assert.match(failure(() => readResearchConsumerTurn(noLink, reference(noLink.get(chain.turn.id)!))),
    /^research_attempt_binding_invalid\/link: /);
  const g = fixture(t), vg = v7Project(g);
  const eg = ends(g, vg.project, vg.planAnswer, "q-industry").refused();
  const cg = managedChain(g, { draft: vg.draft, plan: vg.plan, subject: subjectOf(vg.planAnswer, "q-industry"),
    action: answerAction("q-industry", eg) });
  const ag = recordV7Attempt(g.store, { project: vg.project, planAnswer: vg.planAnswer, planQuestionId: "q-industry",
    call: reference(cg.call), end: eg }).attempt;
  const pg = prepareResearchAttemptCompletion(g.store, vg.project, reference(cg.turn), reference(ag));
  g.store.write({ id: cg.turn.id, kind: "research-turn", expected: 1, value: pg.turn as unknown as Record<string, Json> });
  assert.match(failure(() => readResearchConsumerTurn(g.store, reference(g.store.get(cg.turn.id)!))),
    /^research_attempt_binding_invalid\/missing: /);
  // No binding at the address is absence (null) for the binding reader itself — never a fall-through for the turn.
  assert.equal(readResearchAttemptBinding(g.store, vg.project, cg.turn.id), null);
});

test("DR3a3-K: one batch — a moved run between proof and write leaves neither half; the retry completes; a concurrent completion is a repeat", t => {
  const f = fixture(t), v = v7Project(f);
  const end = ends(f, v.project, v.planAnswer, "q-industry").refused();
  const chain = managedChain(f, { draft: v.draft, plan: v.plan, subject: subjectOf(v.planAnswer, "q-industry"),
    action: answerAction("q-industry", end) });
  const attempt = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer, planQuestionId: "q-industry",
    call: reference(chain.call), end }).attempt;
  const other = f.open();
  const racy = new Proxy(f.store, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (prop === "writeMany") return (...args: unknown[]) => {
      const run = other.get<ResearchRun>(chain.runId)!;
      other.write({ id: run.id, kind: "research-run", expected: run.revision, value: { ...run.value, requestChars: run.value.requestChars + 1 } });
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } }) as Store;
  assert.throws(() => completeResearchAttemptTurn(racy, v.project, reference(chain.turn), reference(attempt)));
  assert.equal(f.store.list(ATTEMPT_BINDING_KIND).length, 0, "no binding without its turn");
  assert.equal(f.store.get(chain.turn.id)!.revision, 1, "no turn without its binding");
  const done = completeResearchAttemptTurn(f.store, v.project, reference(chain.turn), reference(attempt));
  assert.equal(done.repeated, false);
  // A second Store completing the same pending revision meets the saved completion: a repeat, not a write.
  const second = completeResearchAttemptTurn(f.open(), v.project, reference(chain.turn), reference(attempt));
  assert.equal(second.repeated, true);
  assert.equal(f.store.get(chain.turn.id)!.revision, 2);
});

test("DR3a3-K: the producer fixes the era — a subject answer must state one end of its plan-question; answer_delta, foreign question, citations or a malformed end are payload refusals", () => {
  const subject = subjectOf({ id: "research-answer:p:x", revision: 1, hash: "0".repeat(64) }, "q-industry");
  const run: ResearchRun = { projectId: "p", draftId: "d", environment: { id: "e", revision: 1, hash: "0".repeat(64) },
    status: "running", turns: 0, limit: 5, inputs: [], ownerQuestion: null, error: null, pauseCode: null,
    owner: { pid: 1, started: "x" }, requestChars: 0 };
  const admit = (response: unknown, withSubject = true) => projectPaidTurnAdmission(run, { runId: "research-run:p:1",
    intent: { id: "research-consumer-intent:v1:x", revision: 1, hash: "0".repeat(64) }, response, question: null,
    owner: run.owner, limit: 5, context: {}, ...(withSubject ? { subject } : {}) });
  const refused: V7AttemptEnd = { type: "refused", code: "source_unavailable", evidence: [], text: "No source" };
  const ok = admit(answerAction("q-industry", refused));
  assert.equal(ok.turn.attemptContract, ATTEMPT_BINDING_CONTRACT);
  assert.deepEqual(ok.turn.subject, subject);
  // Control flow keeps its own action: a pause of a subject turn is not an end.
  assert.equal(admit({ action: "pause", reason: "wait" }).turn.attemptContract, ATTEMPT_BINDING_CONTRACT);
  for (const response of [
    answerAction("q-market", refused),
    { ...(answerAction("q-industry", refused) as Record<string, Json>), citations: [{ source: { id: "s", revision: 1, hash: "0".repeat(64) }, selector: { kind: "text-range", start: 0, end: 1 } }] },
    answerAction("q-industry", { ...refused, code: "free text" } as unknown as V7AttemptEnd),
    answerAction("q-industry", { type: "submitted", contract: "discovery-claims/v6", value: { claims: [] } } as unknown as V7AttemptEnd),
    { action: "answer", question: "q-industry", value: "plain text answer", citations: [] },
  ]) {
    const failure = code(() => admit(response));
    assert.equal(failure, "research_response_invalid", JSON.stringify(response));
    assert.ok(ACTION_RESPONSE_REFUSAL_CODES.has(failure), "the payload refusal is a consumer-invalid outcome");
  }
  // Without a subject the producer is unchanged — no era marker, no subject;
  // an uncited answer stays a refusal of the field path.
  const field = admit({ action: "pause", reason: "wait" }, false).turn;
  assert.equal(code(() => admit(answerAction("q-industry", refused), false)), "research_response_invalid");
  assert.equal(Object.hasOwn(field, "attemptContract"), false);
  assert.equal(Object.hasOwn(field, "subject"), false);
  // The synthesis handoff fixes the same immutable subject.
  const handoff = projectSynthesisHandoffTurn({ intent: { id: "i", revision: 1, hash: "0".repeat(64) }, runId: "r",
    number: 1, action: answerAction("q-industry", refused), question: null, subject });
  assert.equal(handoff.attemptContract, ATTEMPT_BINDING_CONTRACT);
  assert.equal(code(() => projectSynthesisHandoffTurn({ intent: { id: "i", revision: 1, hash: "0".repeat(64) }, runId: "r",
    number: 1, action: answerAction("q-market", refused), question: null, subject })), "research_response_invalid");
  // An attempt-era turn never completes as an assessed or accepted answer.
  const proof = { kind: "assessed-answer" } as unknown as TurnTransitionProof;
  assert.equal(code(() => projectResearchTurnRevision(ok.turn, proof)), "research_consumer_intent_invalid");
  assert.equal(code(() => projectResearchTurnRevision(ok.turn,
    { kind: "accepted-answer" } as unknown as TurnTransitionProof)), "research_consumer_intent_invalid");
  assert.equal(code(() => projectResearchTurnRevision(field,
    { kind: "attempt-recorded" } as unknown as TurnTransitionProof)), "research_attempt_binding_invalid");
});

test("DR3a3-K: the subject contract — exact form, call ownership by subject, mapping verbatim, fsck sites of the binding", () => {
  const planAnswer = { id: "research-answer:p:x", revision: 1, hash: "0".repeat(64) };
  const subject = subjectOf(planAnswer, "q-industry");
  assert.deepEqual(planSubjectOf({ subject }), subject);
  assert.equal(planSubjectOf({}), null);
  for (const broken of [{ ...subject, contract: "v7-plan-subject/v0" }, { ...subject, planQuestionId: "" },
    { ...subject, planAnswer: "research-answer:p:x" }, { ...subject, extra: true }, null, "q-industry"])
    assert.equal(code(() => planSubjectOf({ subject: broken })), "research_consumer_intent_invalid");
  const question = { id: "question:plan", revision: 3, hash: "1".repeat(64) };
  assert.equal(callAddressesSubject({ questionId: "q-industry", planAnswer }, question, subject), true);
  assert.equal(callAddressesSubject({ questionId: "q-industry" }, question, subject), false, "the plan answer is mandatory");
  assert.equal(callAddressesSubject({ questionId: "q-industry", planAnswer: { ...planAnswer, revision: 2 } }, question, subject), false);
  assert.equal(callAddressesSubject({ questionId: question.id, planAnswer }, question, subject), false);
  assert.equal(callAddressesSubject({ questionId: question.id }, question, null), true);
  assert.equal(callAddressesSubject({ questionId: question.id, planAnswer }, question, null), false,
    "a field-question call never carries a plan answer");
  const end: V7AttemptEnd = { type: "duplicate", of: { id: "research-attempt:x", revision: 1, hash: "2".repeat(64) } };
  const action = answerAction("q-industry", end);
  assert.equal(attemptEndOfAction(action, subject), (action as { value: unknown }).value, "the end is the payload value verbatim");
  const binding: ResearchAttemptBinding = { contract: ATTEMPT_BINDING_CONTRACT, projectId: "p",
    turn: { id: "research-turn:v1:a", revision: 1, hash: "3".repeat(64) },
    pending: { id: "research-turn:v1:a", revision: 1, hash: "3".repeat(64) },
    intent: { id: "research-consumer-intent:v1:b", revision: 1, hash: "4".repeat(64) },
    planAnswer, planQuestionId: "q-industry",
    attempt: { id: "research-attempt:c", revision: 1, hash: "5".repeat(64) } };
  assert.deepEqual(referenceSites(ATTEMPT_BINDING_KIND, binding).map(site => site.field).sort(),
    ["attempt", "intent", "pending", "planAnswer", "turn"]);
  assert.equal(canonical(asJson(sameSubject(subject, { ...subject }))), "true");
});

test("DR3a3-K: the intent producer proves a declared subject before the intent exists", t => {
  const f = fixture(t), v = v7Project(f);
  const runId = `research-run:${v.project}:${rand()}`;
  const run = f.store.write<ResearchRun>({ id: runId, kind: "research-run", expected: 0,
    value: { projectId: v.project, draftId: v.draft.id, environment: reference(v.draft), status: "running", turns: 0,
      limit: 5, inputs: [], ownerQuestion: null, error: null, pauseCode: null, owner: { pid: 1, started: "x" },
      requestChars: 0 } });
  const frame = questionOf(f.store, v.draft, "frame");
  const input = (subject: unknown, question: Revision<Question> = v.plan) => ({
    projectId: v.project, kind: "analyst" as const, key: `prep-${rand()}`, owner: reference(run),
    draft: reference(v.draft), question: reference(question),
    role: { actor: "fixture", model: "fixture", effort: "medium", command: { executable: "fixture", args: [] } },
    dispatch: { projectId: v.project } as unknown as ResearchConsumerIntent["dispatch"], profile: null,
    cursor: { context: {}, prompt: "p", run: runId, turn: 1, subject } as Record<string, unknown>,
    basis: [], guards: uniqueTransactionGuards([reference(run), reference(v.draft), reference(question)]) });
  const refusal = (subject: unknown, question?: Revision<Question>) => {
    try { prepareResearchConsumerIntent(f.store, input(subject, question) as never); return "prepared"; }
    catch (error) {
      return error instanceof EngineError && error.code === "research_consumer_intent_invalid"
        ? error.message : `other:${error instanceof EngineError ? error.code : String(error)}`;
    }
  };
  for (const [subject, question] of [
    [subjectOf(v.planAnswer, "q-absent"), undefined],
    [subjectOf({ ...v.planAnswer, revision: v.planAnswer.revision + 1 }, "q-industry"), undefined],
    [subjectOf(v.planAnswer, "q-industry"), frame],
    [{ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: v.planAnswer }, undefined],
  ] as [unknown, Revision<Question> | undefined][])
    assert.match(refusal(subject, question), /attempt subject/, JSON.stringify(subject));
  // A lawful subject passes the subject proof (whatever the later admission says).
  assert.doesNotMatch(refusal(subjectOf(v.planAnswer, "q-industry")), /attempt subject/);
});

test("DR3a3-K-01 (codex-omg №7543): the owner review addresses the turn's logical question — both verdicts of v6 and v7, planQuestionId in ownerQuestion, a foreign logical question refused", () => {
  const ref = (id: string): Ref => ({ id, revision: 1, hash: "0".repeat(64) });
  const owner = { pid: process.pid, started: "probe" };
  const question = ref("question:p:concept:plan");
  const run = { projectId: "p", draftId: "draft:p", turns: 0, requestChars: 0 } as unknown as ResearchRun;
  const subject = subjectOf(ref("research-answer:p:plan"), "pq-materials");
  const admit = (v7: boolean, asked: string) => projectPaidTurnAdmission(run, { runId: "research-run:p",
    intent: ref("research-consumer-intent:p"), question, context: {}, owner, limit: 5, ...(v7 ? { subject } : {}),
    response: { action: "need_owner", question: asked, reason: "Missing owner decision", searched: [ref("source:p:evidence")] } });
  for (const v7 of [false, true]) for (const necessary of [false, true]) {
    const id = v7 ? subject.planQuestionId : question.id;
    const admitted = admit(v7, id);
    assert.equal(turnQuestionId(admitted.turn), id);
    const result = projectPaidOwnerReview(admitted.run, admitted.turn, { necessary, reason: "Reviewed" }, owner, 5);
    assert.equal(result.turn.status, "completed", `${v7 ? "v7" : "v6"} necessary=${necessary}`);
    assert.equal(result.run.status, necessary ? "needs_owner" : "running");
    assert.deepEqual(result.run.ownerQuestion, necessary
      ? { question: id, reason: "Reviewed", searched: [ref("source:p:evidence")] } : null);
  }
  // A paid need_owner about another logical question: another plan-question, the physical Question id of the
  // plan field for an attempt, a plan-question id for a field turn.
  for (const [v7, asked] of [[true, "pq-other"], [true, question.id], [false, "pq-materials"]] as [boolean, string][])
    for (const necessary of [false, true])
      assert.equal(code(() => projectPaidOwnerReview(admit(v7, asked).run, admit(v7, asked).turn,
        { necessary, reason: "Reviewed" }, owner, 5)), "escalation_assessment_invalid", `${v7} ${asked} ${necessary}`);
});
