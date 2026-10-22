import test from "node:test";
import assert from "node:assert/strict";
import { type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, DISCOVERY_CLAIMS_CONTRACT } from "../src/discovery/v7-contracts.js";
import type { V7AttemptEnd } from "../src/discovery/v7-plan-questions.js";
import { recordV7Attempt } from "../src/discovery/v7-attempts.js";
import { completeResearchAttemptTurn, researchConsumerIntentId,
  type ResearchConsumerIntent } from "../src/discovery/response-recovery.js";
import { managedTurnId, projectPaidTurnAdmission, type ManagedResearchTurn } from "../src/discovery/research-consumer-transition.js";
import { V7_PLAN_SUBJECT_CONTRACT, attemptBindingId, type V7PlanSubject } from "../src/discovery/v7-managed-attempt.js";
import { DISCOVERY_ASSESSMENT_CONTRACT, V7_PROGRESS_BASELINE_CONTRACT, type DiscoveryAttemptsAssessment,
  type ResearchRun, type V7AttemptPacket, type V7Novelty, type V7ProgressBaseline } from "../src/discovery/research-model.js";
import { DISCOVERY_ASSESSMENT_KIND, V7_PROGRESS_STATE_KIND, attemptAccountKey, baselineGuards, checkDiscoveryAssessmentForm,
  checkProgressBaseline, claimContentKey, constraintContentKey, normalizeClaimText, progressEventKey, projectAttemptPacket,
  proveAttemptPacket, transitionContentKey, v7ProgressStateId,
  type V7AssessmentSubject } from "../src/discovery/v7-attempt-assessment.js";
import { resolveClaimAddress, type ClaimAddress, type ResolvedClaim } from "../src/discovery/claim-address.js";
import { projectWebSource, type Source } from "../src/evidence/evidence.js";
import { answerDiscoveryCondition } from "../src/discovery/discovery-decision.js";
import { discoveryDecisionId, type DiscoveryConditionDecisionV2 } from "../src/discovery/discovery-outcome.js";
import { DiscoveryChoiceSessions, issueDiscoveryChoiceInvitation } from "../src/product/owner-authority.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { uniqueTransactionGuards } from "../src/runtime/environment.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { discoveryFixture, rand, validFrame, planQuestion, validPlan, questionOf } from "./discovery-v7-fixture.js";

// DR3b-M (codex-omg №7546 §1, the M slice): the packet, baseline, assessment form, novelty and content keys of a v7
// attempts assessment. Attempts are real: the plan is accepted through the real chain, every attempt passes the
// DR3a2 door and is completed through its real K. The ordinary call path (DR3a3-C) and the runner (DR3a3-R) are not
// connected yet, so — as in the K tests — the managed consumer chain is written in the producers' saved form, with
// several turns of ONE research run, the way the runner numbers them. The paid assessment (DR3b-A) and its
// application (DR3b-P) do not exist yet: the forms below are checked structurally and never stand for them.

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3bm-");
type Fixture = ReturnType<typeof fixture>;

/** The code and the addressed field (or reason) of a refusal — a test asserts WHY it refused. */
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    const e = error as EngineError, details = e.details as { field?: unknown; reason?: unknown } | null;
    const at = typeof details?.field === "string" ? details.field : typeof details?.reason === "string" ? details.reason : "";
    return `${e.code} ${at}`.trim();
  }
  return "no-error";
};
const asJson = <T>(value: T): Json => value as unknown as Json;
const exact = (record: Revision<unknown>): Ref => ({ id: record.id, revision: record.revision, hash: record.hash });

const PLAN = [planQuestion("q-industry", "industry", "blocking"), planQuestion("q-market", "market")];
/** The real plan acceptance chain (frame and plan through #answer). */
function v7Project(f: Fixture, project = `p${rand()}`) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, PLAN), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { project, draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef,
    frame: f.store.get<Question>(frame.id)!, runId: `research-run:${project}:${rand()}` };
}
type V7Project = ReturnType<typeof v7Project>;
/** The next lawful plan edition: reopen and accept again. */
function acceptNextPlanEdition(f: Fixture, v: V7Project) {
  const planQ = questionOf(f.store, f.store.get<DiscoveryDraft>(v.draft.id)!, "plan");
  f.discovery.reopen(planQ.id, planQ.revision);
  const reopened = f.store.get<Question>(planQ.id)!;
  const src = f.discovery.evidence.document(v.project, `basis-${rand()}`, `Source ${rand()}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, v.project, f.store.get<DiscoveryDraft>(v.draft.id)!, reopened,
    validPlan(v.frameRef, PLAN, 2, v.planAnswer), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { ...v, draft: f.store.get<DiscoveryDraft>(v.draft.id)!, plan, planAnswer: plan.value.answer! };
}

/* ---------- materials ---------- */

const PAGE = "Steel rebar prices rose by 12 percent in Q3 across the region.";
/** One capture of a web page as the gateway saves it: a new snapshot id per capture, the same material. */
function webSource(f: Fixture, project: string, content = PAGE): Revision<Source> {
  const capture = exact(f.store.write({ id: `web-capture:${rand()}`, kind: "fixture-capture", expected: 0,
    value: { projectId: project, nonce: rand() } }));
  const projected = projectWebSource(project, capture, { requestedUrl: "https://example.org/rebar",
    finalUrl: "https://example.org/rebar", fetchedAt: `2026-10-${10 + Math.floor(Math.random() * 9)}T00:00:00Z`,
    status: 200, text: content, extraction: "readability", truncated: false });
  return f.store.write<Source>({ id: projected.id, kind: "source", expected: 0, value: projected.value });
}
const planLink = (v: V7Project, planQuestionId: string) => [{ planAnswer: asJson(v.planAnswer), planQuestionId }];
function factClaim(v: V7Project, source: Revision<Source>, opts: { id?: string; start?: number; end?: number;
  valueHash?: string; planQuestionId?: string } = {}): Json {
  const start = opts.start ?? 0, end = opts.end ?? 16;
  return { id: opts.id ?? `fact-${rand()}`, kind: "fact", text: `Rebar ${rand()}`, axis: "market",
    planQuestions: planLink(v, opts.planQuestionId ?? "q-industry"), scope: { variants: "common" },
    basis: { source: { ref: asJson(exact(source)), range: { start, end },
      valueHash: opts.valueHash ?? hashJson(source.value.content.slice(start, end)) },
      limit: "snapshot", asOf: "2026-10" } } as unknown as Json;
}
function hypothesisClaim(v: V7Project, text: string, howToVerify: string, id = `hyp-${rand()}`): Json {
  return { id, kind: "hypothesis", text, axis: "market", planQuestions: planLink(v, "q-industry"),
    scope: { variants: "common" }, basis: { howToVerify } } as unknown as Json;
}
function unknownClaim(v: V7Project, opts: { affects: string[]; unknownId: string; origin: string; moment?: string }): Json {
  return { id: `unk-${rand()}`, kind: "unknown", text: "Supplier lead time", axis: "market",
    planQuestions: planLink(v, "q-industry"), scope: { variants: "common" },
    basis: { origin: opts.origin, unknownId: opts.unknownId, question: "What is the lead time?", affects: opts.affects,
      consumer: "procurement", blocksCurrentStage: false, moment: opts.moment ?? "feasibility",
      closeCriterion: "A named supplier quote" } } as unknown as Json;
}
function inferenceClaim(v: V7Project, text: string, from: ClaimAddress[]): Json {
  return { id: `inf-${rand()}`, kind: "inference", text, axis: "market", planQuestions: planLink(v, "q-industry"),
    scope: { variants: "common" }, basis: { from: asJson(from), reasoning: "Follows from the premises" } } as unknown as Json;
}
function ownerClaim(v: V7Project, authority: Ref, text = "The owner accepted the local scope"): Json {
  return { id: `own-${rand()}`, kind: "owner-decision", text, axis: "market", planQuestions: planLink(v, "q-industry"),
    scope: { variants: "common" }, basis: { authority: asJson(authority) } } as unknown as Json;
}
const submitted = (...claims: Json[]): V7AttemptEnd => ({ type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT,
  value: { claims } });
function refused(f: Fixture, project: string, text = "The named source is not reachable",
  evidence?: Ref[]): V7AttemptEnd {
  return { type: "refused", code: "source_unavailable", text,
    evidence: evidence ?? [exact(f.discovery.evidence.document(project, `ev-${rand()}`, "No answer", "text/plain", 0))] };
}
const impossible = (): V7AttemptEnd => ({ type: "impossible", code: "outside_plan_scope", evidence: [],
  text: "Outside the plan scope" });

/* ---------- the managed chain of one research run ---------- */

const subjectOf = (planAnswer: Ref, planQuestionId: string): V7PlanSubject =>
  ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer, planQuestionId });
const writeRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });

/** One turn of a research run in the producers' saved form: intent@1 with cursor.subject → the paid model-call with
 * the plan answer → intent@2 running → one application batch (run, the real O@1, intent@3 applied). Turns of one
 * run are numbered run.turns + 1, as the runner does. */
function managedTurn(f: Fixture, v: V7Project, planQuestionId: string, end: V7AttemptEnd, runId = v.runId) {
  const store = f.store, project = v.project, subject = subjectOf(v.planAnswer, planQuestionId);
  let run = store.get<ResearchRun>(runId);
  if (run === null) run = store.write<ResearchRun>({ id: runId, kind: "research-run", expected: 0, value: {
    projectId: project, draftId: v.draft.id, environment: reference(v.draft), status: "running", turns: 0, limit: 50,
    inputs: [], ownerQuestion: null, error: null, pauseCode: null, owner: { pid: 1, started: "fixture" }, requestChars: 0 } });
  const number = run.value.turns + 1, key = `v7-attempt-${rand()}`, owner = reference(run);
  const intentValue: ResearchConsumerIntent = { contract: "research-consumer-intent/v1", projectId: project,
    kind: "analyst", key, rootKey: key, generation: 0, previous: null, owner,
    draft: reference(v.draft), question: reference(v.plan),
    role: { actor: "fixture", model: "fixture", effort: "medium", command: { executable: "fixture", args: [] } },
    dispatch: { projectId: project } as unknown as ResearchConsumerIntent["dispatch"], profile: null,
    cursor: { context: {}, prompt: "Research the plan-question", run: runId, turn: number, subject },
    basis: [], guards: uniqueTransactionGuards([owner, reference(v.draft), reference(v.plan)]),
    state: "prepared", call: null, request: null, archive: null, outputs: null, refusal: null };
  const intentId = researchConsumerIntentId(project, "analyst", key, 0);
  const intent1 = store.write<ResearchConsumerIntent>({ id: intentId, kind: "research-consumer-intent", expected: 0,
    value: intentValue });
  const call = store.write({ id: `model-call:consumer:v1:${rand()}`, kind: "model-call", expected: 0,
    value: { projectId: project, draftId: v.draft.id, questionId: planQuestionId, planAnswer: asJson(v.planAnswer),
      purpose: "analyst", requestId: `r-${rand()}`, consumerIntent: asJson(reference(intent1)),
      startedAt: 1, finishedAt: 2, status: "succeeded", requested: asJson(intentValue.role),
      confirmed: { model: "fixture", effort: "medium", speed: null },
      request: { chars: 10, bytes: 10, hash: hashJson("req") }, response: { chars: 20, bytes: 20 },
      usage: null, usageSource: "unavailable", error: null } as unknown as Record<string, Json> });
  const intent2 = store.write<ResearchConsumerIntent>({ id: intentId, kind: "research-consumer-intent", expected: 1,
    value: { ...intentValue, state: "running", call: reference(call), request: reference(call), archive: reference(call) } });
  const projected = projectPaidTurnAdmission(run.value, { runId, intent: reference(intent1),
    response: { action: "answer", question: planQuestionId, value: asJson(end), citations: [] },
    question: reference(v.plan), owner: run.value.owner, limit: 50, context: {}, subject });
  const runWrite: Write = { id: runId, kind: "research-run", expected: run.revision, value: projected.run };
  const turnWrite: Write = { id: managedTurnId(runId, number), kind: "research-turn", expected: 0, value: projected.turn };
  const appliedWrite: Write = { id: intentId, kind: "research-consumer-intent", expected: 2,
    value: { ...intent2.value, state: "applied", outputs: [writeRef(runWrite), writeRef(turnWrite)] } };
  const [, turn] = store.writeMany([runWrite, turnWrite, appliedWrite]);
  return { call, turn: turn as unknown as Revision<ManagedResearchTurn>, number };
}
/** A complete managed attempt: turn → DR3a2 door → K completion. */
function attempt(f: Fixture, v: V7Project, end: V7AttemptEnd, planQuestionId = "q-industry", runId = v.runId) {
  const chain = managedTurn(f, v, planQuestionId, end, runId);
  const recorded = recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer, planQuestionId,
    call: reference(chain.call), end }).attempt;
  const done = completeResearchAttemptTurn(f.store, v.project, reference(chain.turn), reference(recorded));
  return { attempt: exact(recorded), binding: exact(done.binding), turn: chain.turn, number: chain.number, end };
}
type Attempt = ReturnType<typeof attempt>;
const entry = (a: Attempt) => ({ attempt: a.attempt, binding: a.binding });
const subject = (v: V7Project, planQuestionId = "q-industry"): V7AssessmentSubject =>
  ({ project: v.project, planAnswer: v.planAnswer, planQuestionId });
const address = (v: V7Project, a: Attempt, index: number): ClaimAddress => ({ project: v.project, container: a.attempt,
  containerKind: "research-attempt", pointer: `/claims/${index}`,
  claimId: ((a.end as { value: { claims: Json[] } }).value.claims[index] as Record<string, Json>)["id"] as string });
const absentBaseline = (v: V7Project, materials: ClaimAddress[] = [], planQuestionId = "q-industry"): V7ProgressBaseline =>
  ({ contract: V7_PROGRESS_BASELINE_CONTRACT, state: { kind: "absent", id: v7ProgressStateId(subject(v, planQuestionId)) },
    materials });
const row = (a: Attempt, reason = "Assessed") => ({ attempt: a.attempt, reason });
const claimRow = (claim: ClaimAddress, reason = "Assessed") => ({ claim, reason });

/* ---------- 1. the packet ---------- */

test("DR3b-M packet: proven order by the K original turn whatever the input order; the saved order must be the proven one; duplicates, another plan-question of the same Question, another edition, another Question, another run and an empty packet are refused", t => {
  const f = fixture(t), v = v7Project(f);
  const a1 = attempt(f, v, refused(f, v.project));
  const a2 = attempt(f, v, submitted(factClaim(v, webSource(f, v.project))));
  const a3 = attempt(f, v, impossible());
  const market = attempt(f, v, submitted(factClaim(v, webSource(f, v.project), { planQuestionId: "q-market" })), "q-market");
  const otherRun = attempt(f, v, refused(f, v.project), "q-industry", `research-run:${v.project}:${rand()}`);
  assert.deepEqual([a1.number, a2.number, a3.number], [1, 2, 3]);
  const s = subject(v);
  const p1 = projectAttemptPacket(f.store, { ...s, entries: [entry(a3), entry(a1), entry(a2)] });
  const p2 = projectAttemptPacket(f.store, { ...s, entries: [entry(a2), entry(a3), entry(a1)] });
  assert.deepEqual(p1, p2, "a permutation of the input never changes the packet");
  assert.deepEqual(p1.entries, [entry(a1), entry(a2), entry(a3)]);
  assert.deepEqual(p1.question, reference(v.plan), "the real Question basis of the producing intents");
  const proven = proveAttemptPacket(f.open(), p1);
  assert.deepEqual(proven.entries.map(item => item.number), [1, 2, 3]);
  assert.equal(proven.run, v.runId);
  assert.equal((proven.planQuestion.question as Record<string, Json>)["class"], "blocking");
  const cases: [string, unknown, string][] = [
    ["reordered", { ...p1, entries: [p1.entries[1], p1.entries[0], p1.entries[2]] }, "packet.order"],
    ["duplicate entry", { ...p1, entries: [entry(a1), entry(a1)] }, "packet.entries"],
    ["another plan-question of the same Question", { ...p1, entries: [entry(a1), entry(market)] }, "packet.entries.1.attempt"],
    ["another run", { ...p1, entries: [entry(a1), entry(otherRun)] }, "packet.run"],
    ["another Question basis", { ...p1, question: reference(v.frame) }, "packet.question"],
    ["empty", { ...p1, entries: [] }, "packet.entries"],
    ["null", null, "packet"],
    ["unknown contract", { ...p1, contract: "v7-attempt-packet/v0" }, "packet"],
    ["extra field", { ...p1, note: "x" }, "packet"],
  ];
  for (const [name, packet, field] of cases)
    assert.equal(refusal(() => proveAttemptPacket(f.store, packet)), `discovery_assessment_subject_invalid ${field}`, name);
  // The same plan-question id in the next plan edition is another subject.
  const next = acceptNextPlanEdition(f, v);
  const later = attempt(f, next, refused(f, v.project));
  assert.equal(refusal(() => proveAttemptPacket(f.store, { ...p1, entries: [entry(later)] })),
    "discovery_assessment_subject_invalid packet.entries.0.attempt");
  assert.equal(refusal(() => projectAttemptPacket(f.store, { ...subject(next), entries: [entry(a1)] })),
    "discovery_assessment_subject_invalid packet.entries.0.attempt");
  // The edition-1 packet still proves after the plan moved on (historical read).
  proveAttemptPacket(f.store, p1);
});

test("DR3b-M packet: only a managed attempt with its proven K enters — a door-only attempt, another attempt's K, a changed K Ref; attempt refusals keep their own code", t => {
  const f = fixture(t), v = v7Project(f);
  const a1 = attempt(f, v, refused(f, v.project)), a2 = attempt(f, v, impossible());
  // A paid turn whose attempt the door recorded, but whose turn never completed through K.
  const end = refused(f, v.project);
  const chain = managedTurn(f, v, "q-industry", end);
  const doorOnly = exact(recordV7Attempt(f.store, { project: v.project, planAnswer: v.planAnswer,
    planQuestionId: "q-industry", call: reference(chain.call), end }).attempt);
  const guessed = { id: attemptBindingId(v.project, chain.turn.id), revision: 1, hash: "0".repeat(64) };
  const s = subject(v);
  for (const [name, entries, expected] of [
    ["door-only attempt", [{ attempt: doorOnly, binding: guessed }], "discovery_assessment_subject_invalid packet.entries.0.binding"],
    ["door-only attempt with another turn's K", [{ attempt: doorOnly, binding: a1.binding }], "discovery_assessment_subject_invalid packet.entries.0.binding"],
    ["K of another attempt", [{ attempt: a1.attempt, binding: a2.binding }], "discovery_assessment_subject_invalid packet.entries.0.binding"],
    ["changed K Ref", [{ attempt: a1.attempt, binding: { ...a1.binding, hash: "1".repeat(64) } }], "discovery_assessment_subject_invalid packet.entries.0.binding"],
    ["no K field", [{ attempt: a1.attempt }], "discovery_assessment_subject_invalid packet.entries.0"],
    ["changed attempt Ref", [{ attempt: { ...a1.attempt, hash: "2".repeat(64) }, binding: a1.binding }], "attempt_invalid attempt"],
  ] as [string, never[], string][])
    assert.equal(refusal(() => projectAttemptPacket(f.store, { ...s, entries })), expected, name);
  // Completing the turn through its own K admits the attempt.
  const done = completeResearchAttemptTurn(f.store, v.project, reference(chain.turn), doorOnly);
  assert.deepEqual(projectAttemptPacket(f.store, { ...s, entries: [{ attempt: doorOnly, binding: exact(done.binding) }, entry(a1)] })
    .entries.map(item => item.attempt), [a1.attempt, doorOnly]);
});

/* ---------- 2. the baseline ---------- */

test("DR3b-M baseline: this plan-question's own state or its explicit absence; another question's state, a missing state, foreign, duplicated or unresolvable materials are refused; guards follow the state", t => {
  const f = fixture(t), v = v7Project(f), w = v7Project(f);
  const own = attempt(f, v, submitted(factClaim(v, webSource(f, v.project))));
  const foreign = attempt(f, w, submitted(factClaim(w, webSource(f, w.project))));
  const s = subject(v), material = address(v, own, 0);
  const absent = absentBaseline(v, [material]);
  assert.deepEqual(checkProgressBaseline(f.store, absent, s), absent);
  assert.deepEqual(baselineGuards(absent), [{ id: v7ProgressStateId(s), absent: true }]);
  const stateRecord = f.store.write({ id: v7ProgressStateId(s), kind: V7_PROGRESS_STATE_KIND, expected: 0,
    value: { contract: "fixture", projectId: v.project } });
  const present: V7ProgressBaseline = { ...absent, state: { kind: "state", ref: exact(stateRecord) } };
  assert.deepEqual(checkProgressBaseline(f.store, present, s), present);
  assert.deepEqual(baselineGuards(present), [exact(stateRecord)]);
  const other = v7ProgressStateId(subject(v, "q-market"));
  assert.notEqual(other, v7ProgressStateId(s), "two plan-questions of one Question have two states");
  for (const [name, baseline, expected] of [
    ["null", null, "discovery_assessment_subject_invalid baseline"],
    ["another question's absent state", { ...absent, state: { kind: "absent", id: other } }, "discovery_assessment_subject_invalid baseline.state"],
    ["missing state record", { ...absent, state: { kind: "state", ref: { ...exact(stateRecord), hash: "3".repeat(64) } } }, "discovery_assessment_subject_invalid baseline.state"],
    ["unknown state kind", { ...absent, state: { kind: "latest" } }, "discovery_assessment_subject_invalid baseline.state"],
    ["foreign material", { ...absent, materials: [address(w, foreign, 0)] }, "discovery_assessment_subject_invalid baseline.materials.0"],
    ["duplicated material", { ...absent, materials: [material, material] }, "discovery_assessment_subject_invalid baseline.materials.1"],
    ["unresolvable material", { ...absent, materials: [{ ...material, pointer: "/claims/9" }] }, "claim_address_invalid pointer"],
    ["no materials list", { contract: V7_PROGRESS_BASELINE_CONTRACT, state: absent.state }, "discovery_assessment_subject_invalid baseline"],
  ] as [string, unknown, string][])
    assert.equal(refusal(() => checkProgressBaseline(f.store, baseline, s)), expected, name);
});

/* ---------- 3. the assessment form and novelty ---------- */

function assessmentOf(packet: V7AttemptPacket, baseline: V7ProgressBaseline, novelty: V7Novelty,
  over: Partial<DiscoveryAttemptsAssessment> = {}): DiscoveryAttemptsAssessment {
  const session = { id: `assessment-session:${rand()}`, revision: 2, hash: hashJson("session") };
  return { contract: DISCOVERY_ASSESSMENT_CONTRACT, projectId: packet.project, subject: { kind: "attempts", packet },
    baseline, session, application: { id: `assessment-application:${rand()}`, revision: 1, hash: hashJson("app") },
    assessor: "reviewer", environment: { id: `environment:${packet.project}`, revision: 1, hash: hashJson("env") },
    verdict: "supported", reasons: ["The packet was assessed against the plan criterion"], return: null, novelty, ...over };
}

/** a1 refused with evidence · a2 submitted (fact, hypothesis) · a3 submitted (fact of the same page) · a4 impossible. */
function novelPacket(f: Fixture) {
  const v = v7Project(f);
  const a1 = attempt(f, v, refused(f, v.project));
  const a2 = attempt(f, v, submitted(factClaim(v, webSource(f, v.project)), hypothesisClaim(v, "Prices rise", "Ask two suppliers")));
  const a3 = attempt(f, v, submitted(factClaim(v, webSource(f, v.project))));
  const a4 = attempt(f, v, impossible());
  const packet = projectAttemptPacket(f.store, { ...subject(v), entries: [entry(a1), entry(a2), entry(a3), entry(a4)] });
  const c = { a2f: address(v, a2, 0), a2h: address(v, a2, 1), a3f: address(v, a3, 0) };
  const novelty: V7Novelty = {
    attempts: [row(a1), row(a2), row(a3), row(a4)],
    accepted: [claimRow(c.a2f), claimRow(c.a2h), claimRow(c.a3f)], rejected: [],
    newContent: [claimRow(c.a2f), claimRow(c.a2h)], duplicates: [{ claim: c.a3f, of: c.a2f, reason: "Same page" }],
    noProgress: [row(a1), row(a3), row(a4)], transition: null };
  return { v, a1, a2, a3, a4, packet, c, novelty, baseline: absentBaseline(v) };
}

test("DR3b-M assessment form: absent, null or foreign subject, packet, baseline and novelty are addressed refusals; only the attempts subject is admitted; the old ResearchAssessment shape is not this form", t => {
  const f = fixture(t), n = novelPacket(f), w = v7Project(f);
  const wa = attempt(f, w, refused(f, w.project));
  const foreignPacket = projectAttemptPacket(f.store, { ...subject(w), entries: [entry(wa)] });
  const valid = assessmentOf(n.packet, n.baseline, n.novelty);
  const checked = checkDiscoveryAssessmentForm(f.open(), valid);
  assert.deepEqual(checked.packet.entries.map(item => item.number), [1, 2, 3, 4]);
  const { novelty: _n, ...noNovelty } = valid;
  const { attempts: _a, ...partialNovelty } = n.novelty;
  for (const [name, value, expected] of [
    ["null", null, "discovery_assessment_subject_invalid assessment"],
    ["old ResearchAssessment shape", { projectId: n.v.project, question: reference(n.v.plan), value: {}, observations: [],
      verdict: "supported", reasons: [], researcher: "a", assessor: "b", environment: valid.environment },
      "discovery_assessment_subject_invalid contract"],
    ["dossier subject", { ...valid, subject: { kind: "dossier", packet: n.packet } }, "discovery_assessment_subject_invalid subject.kind"],
    ["no subject", { ...valid, subject: null }, "discovery_assessment_subject_invalid subject"],
    ["null packet", { ...valid, subject: { kind: "attempts", packet: null } }, "discovery_assessment_subject_invalid subject.packet"],
    ["packet of another project", { ...valid, subject: { kind: "attempts", packet: foreignPacket } },
      "discovery_assessment_subject_invalid subject.packet.project"],
    ["null baseline", { ...valid, baseline: null }, "discovery_assessment_subject_invalid baseline"],
    ["baseline of another question", { ...valid, baseline: absentBaseline(n.v, [], "q-market") },
      "discovery_assessment_subject_invalid baseline.state"],
    ["no session", { ...valid, session: null }, "discovery_assessment_subject_invalid session"],
    ["extra field", { ...valid, accepted: true }, "discovery_assessment_subject_invalid assessment"],
    ["no novelty field", noNovelty, "discovery_assessment_subject_invalid assessment"],
    ["null novelty", { ...valid, novelty: null }, "discovery_novelty_invalid novelty"],
    ["partial novelty", { ...valid, novelty: partialNovelty }, "discovery_novelty_invalid novelty"],
    ["unknown verdict", { ...valid, verdict: "insufficient" }, "discovery_novelty_invalid verdict"],
    ["no reasons", { ...valid, reasons: [] }, "discovery_novelty_invalid reasons"],
  ] as [string, unknown, string][])
    assert.equal(refusal(() => checkDiscoveryAssessmentForm(f.store, value)), expected, name);
});

test("DR3b-M novelty: the classification is complete and consistent — every attempt one row, every claim accepted or rejected, every accepted claim new or an earlier duplicate, noProgress exactly the attempts without a new basis; return and transitions keep their contracts", t => {
  const f = fixture(t), n = novelPacket(f), { a1, a2, a3, a4, c } = n;
  const outsider = attempt(f, n.v, submitted(factClaim(n.v, webSource(f, n.v.project))));
  const check = (novelty: Partial<V7Novelty>, over: Partial<DiscoveryAttemptsAssessment> = {}) =>
    refusal(() => checkDiscoveryAssessmentForm(f.store, assessmentOf(n.packet, n.baseline, { ...n.novelty, ...novelty }, over)));
  assert.equal(check({}), "no-error");
  const bad = "discovery_novelty_invalid";
  for (const [name, novelty, expected] of [
    ["a missing attempt row", { attempts: [row(a1), row(a2), row(a3)] }, `${bad} novelty.attempts`],
    ["an attempt row twice", { attempts: [row(a1), row(a2), row(a3), row(a4), row(a4)] }, `${bad} novelty.attempts.4`],
    ["an attempt outside the packet", { attempts: [row(a1), row(a2), row(a3), row(outsider)] }, `${bad} novelty.attempts.3`],
    ["a claim neither accepted nor rejected", { accepted: [claimRow(c.a2f), claimRow(c.a3f)], newContent: [claimRow(c.a2f)] },
      `${bad} novelty.accepted`],
    ["a claim both accepted and rejected", { rejected: [claimRow(c.a2h)] }, `${bad} novelty.accepted`],
    ["a claim outside the packet", { rejected: [claimRow(address(n.v, outsider, 0))] }, `${bad} novelty.rejected.0`],
    ["an accepted claim neither new nor a duplicate", { newContent: [claimRow(c.a2f)] }, `${bad} novelty.newContent`],
    ["a rejected claim classified as new", { accepted: [claimRow(c.a2f), claimRow(c.a3f)], rejected: [claimRow(c.a2h)] },
      `${bad} novelty.newContent`],
    ["a duplicate of a later claim", { newContent: [claimRow(c.a2h), claimRow(c.a3f)],
      duplicates: [{ claim: c.a2f, of: c.a3f, reason: "x" }], noProgress: [row(a1), row(a4)] }, `${bad} novelty.duplicates.0.of`],
    ["a duplicate of itself", { duplicates: [{ claim: c.a3f, of: c.a3f, reason: "x" }] }, `${bad} novelty.duplicates.0.of`],
    ["a duplicate of a rejected claim", { accepted: [claimRow(c.a2h), claimRow(c.a3f)], rejected: [claimRow(c.a2f)],
      newContent: [claimRow(c.a2h)] }, `${bad} novelty.duplicates.0.of`],
    ["noProgress misses an attempt", { noProgress: [row(a1), row(a4)] }, `${bad} novelty.noProgress`],
    ["noProgress names a progressing attempt", { noProgress: [row(a1), row(a2), row(a3), row(a4)] }, `${bad} novelty.noProgress`],
    ["a reasonless row", { attempts: [row(a1), row(a2), row(a3), { attempt: a4.attempt, reason: " " }] }, `${bad} novelty.attempts.3`],
  ] as [string, Partial<V7Novelty>, string][])
    assert.equal(check(novelty), expected, name);
  // A duplicate of a baseline material is lawful.
  const prior = attempt(f, n.v, submitted(factClaim(n.v, webSource(f, n.v.project))));
  const withMaterial = { ...n.baseline, materials: [address(n.v, prior, 0)] };
  assert.equal(refusal(() => checkDiscoveryAssessmentForm(f.store, assessmentOf(n.packet, withMaterial, { ...n.novelty,
    newContent: [claimRow(c.a2h)], duplicates: [{ claim: c.a2f, of: address(n.v, prior, 0), reason: "Known" },
      { claim: c.a3f, of: address(n.v, prior, 0), reason: "Known" }], noProgress: [row(a1), row(a3), row(a4)] }))), "no-error");
  // Return: nothing accepted, every attempt without progress, a target inside the packet, no transition.
  const back: Partial<V7Novelty> = { accepted: [], rejected: [claimRow(c.a2f), claimRow(c.a2h), claimRow(c.a3f)],
    newContent: [], duplicates: [], noProgress: [row(a1), row(a2), row(a3), row(a4)] };
  const returned = { verdict: "return" as const, return: { target: { attempt: a2.attempt }, reason: "Name the source page" } };
  assert.equal(check(back, returned), "no-error");
  assert.equal(check({ ...back, rejected: [claimRow(c.a2h), claimRow(c.a3f)], accepted: [claimRow(c.a2f)],
    newContent: [claimRow(c.a2f)], noProgress: [row(a1), row(a3), row(a4)] }, returned), `${bad} novelty.accepted`);
  assert.equal(check(back, { ...returned, return: { target: { attempt: outsider.attempt }, reason: "x" } }), `${bad} return.target`);
  assert.equal(check(back, { verdict: "return", return: null }), `${bad} return`);
  assert.equal(check({}, { return: returned.return }), `${bad} return`);
  assert.equal(check({ ...back, transition: { outcome: "open", bases: [{ claim: c.a2f }], reason: "x" } }, returned),
    `${bad} novelty.transition`);
  // Transitions: closing states sufficiency against the plan's own criterion and depth; an unknown of the blocking
  // q-industry states its consequence and next action; a proven constraint grounds only an unknown.
  const plan = PLAN[0]!;
  const closed = { outcome: "closed" as const, bases: [{ claim: c.a2f }], reason: "Criterion met",
    sufficiency: { criterion: plan.criterion, requiredDepth: plan.requiredDepth, reason: "The named basis answers it" } };
  assert.equal(check({ transition: closed }), "no-error");
  const { sufficiency: _s, ...noSufficiency } = closed;
  assert.equal(check({ transition: noSufficiency }), `${bad} novelty.transition.sufficiency`);
  assert.equal(check({ transition: { ...closed, sufficiency: { ...closed.sufficiency, criterion: "Any basis" } } }),
    `${bad} novelty.transition.sufficiency`);
  const unknown = { outcome: "unknown" as const, bases: [{ constraint: a1.attempt }], reason: "Proven constraint",
    consequence: "Feasibility stays open", nextAction: "Ask the owner for a source" };
  assert.equal(check({ transition: unknown, noProgress: [row(a3), row(a4)] }), "no-error",
    "a proven new constraint is the new basis of its attempt");
  assert.equal(check({ transition: unknown }), `${bad} novelty.noProgress`);
  const { consequence: _c, ...noConsequence } = unknown;
  assert.equal(check({ transition: noConsequence, noProgress: [row(a3), row(a4)] }), `${bad} novelty.transition.consequence`);
  assert.equal(check({ transition: { ...unknown, bases: [{ constraint: a4.attempt }] } }), `${bad} novelty.transition.bases.0`,
    "an empty-evidence constraint proves nothing new");
  assert.equal(check({ transition: { outcome: "open", bases: [{ constraint: a1.attempt }], reason: "x" },
    noProgress: [row(a3), row(a4)] }), `${bad} novelty.transition.bases.0`);
  assert.equal(check({ transition: { outcome: "open", bases: [{ claim: address(n.v, outsider, 0) }], reason: "x" } }),
    `${bad} novelty.transition.bases.0`);
  assert.equal(check({ transition: { outcome: "open", bases: [], reason: "x" } }), `${bad} novelty.transition.bases`);
  assert.equal(check({ transition: { outcome: "open", bases: [{ claim: c.a2f }], reason: "x", consequence: "y" } }),
    `${bad} novelty.transition.consequence`);
});

/* ---------- 4. the content keys ---------- */

test("DR3b-M content key: a fact is its Source identity, range and checked valueHash — a new capture id or fetch time of the same page is the same key; a wrong range or valueHash and a non-Source basis are refused", t => {
  const f = fixture(t), v = v7Project(f);
  const first = webSource(f, v.project), second = webSource(f, v.project);
  assert.notEqual(first.id, second.id, "two captures are two snapshot records");
  const a = attempt(f, v, submitted(factClaim(v, first), factClaim(v, first, { start: 17, end: 28 }),
    factClaim(v, first, { valueHash: hashJson("forged") }), factClaim(v, first, { start: 0, end: PAGE.length + 5 })));
  const b = attempt(f, v, submitted(factClaim(v, second)));
  const key = (target: Attempt, index: number) => claimContentKey(f.store, address(v, target, index));
  assert.equal(key(a, 0), key(b, 0), "the same material under a new capture id is the same content");
  assert.notEqual(key(a, 0), key(a, 1), "another range is another content");
  assert.equal(refusal(() => key(a, 2)), "discovery_novelty_invalid fact.valueHash");
  assert.equal(refusal(() => key(a, 3)), "discovery_novelty_invalid fact.range");
  const other = webSource(f, v.project, `${PAGE} Updated.`);
  const c = attempt(f, v, submitted(factClaim(v, other)));
  assert.notEqual(key(c, 0), key(a, 0), "another saved content is another Source identity");
  const pseudo = f.store.write({ id: `source:${v.project}:${rand()}`, kind: "source", expected: 0,
    value: { projectId: v.project, content: "basis" } });
  const d = attempt(f, v, submitted({ ...(factClaim(v, first) as Record<string, Json>),
    basis: { source: { ref: asJson(exact(pseudo)), range: { start: 0, end: 3 }, valueHash: hashJson("bas") },
      limit: "snapshot", asOf: "2026-10" } } as unknown as Json));
  assert.equal(refusal(() => key(d, 0)), "discovery_novelty_invalid fact.source");
  // The key is versioned content, not an id: the event and the account keys keep their own subjects.
  const s = subject(v), k = key(a, 0);
  assert.equal(progressEventKey(s, k), progressEventKey({ ...s }, k));
  assert.notEqual(progressEventKey(s, k), progressEventKey(subject(v, "q-market"), k));
  assert.notEqual(attemptAccountKey(s, a.attempt), attemptAccountKey(s, b.attempt), "two attempts are two accounts");
  assert.notEqual(attemptAccountKey(s, a.attempt), attemptAccountKey(subject(v, "q-market"), a.attempt));
});

test("DR3b-M content key: hypothesis and unknown are their normalized content — NFC, line ends and outer spaces do not matter, case does; affects is a set; unknownId and origin are not content", t => {
  const f = fixture(t), v = v7Project(f);
  const a = attempt(f, v, submitted(
    hypothesisClaim(v, "  Prices rise\r\nin Q4  ", "Ask two suppliers\r"),
    hypothesisClaim(v, "Prices rise\nin Q4", "Ask two suppliers"),
    hypothesisClaim(v, "prices rise\nin Q4", "Ask two suppliers"),
    unknownClaim(v, { affects: ["cost", "schedule"], unknownId: "u-1", origin: "analyst" }),
    unknownClaim(v, { affects: ["schedule", "cost", "cost"], unknownId: "u-2", origin: "reviewer" }),
    unknownClaim(v, { affects: ["cost", "schedule"], unknownId: "u-1", origin: "analyst", moment: "task-start" }),
    hypothesisClaim(v, "Café supply", "Visit"), hypothesisClaim(v, "Café supply", "Visit")));
  const key = (index: number) => claimContentKey(f.store, address(v, a, index));
  assert.equal(normalizeClaimText(" a\r\nb\rc "), "a\nb\nc");
  assert.equal(key(0), key(1));
  assert.notEqual(key(1), key(2), "case is content");
  assert.equal(key(3), key(4));
  assert.notEqual(key(3), key(5), "the moment is content");
  assert.equal(key(6), key(7), "NFC");
});

test("DR3b-M content key: an inference is its normalized text and the sorted keys of its proven accepted premises — unaccepted premises keep their refusal, cycles are refused", t => {
  const f = fixture(t), v = v7Project(f);
  const premises = attempt(f, v, submitted(factClaim(v, webSource(f, v.project)),
    factClaim(v, webSource(f, v.project), { start: 17, end: 28 })));
  const p0 = address(v, premises, 0), p1 = address(v, premises, 1);
  const copy = attempt(f, v, submitted(factClaim(v, webSource(f, v.project))));
  const a = attempt(f, v, submitted(inferenceClaim(v, "Prices rise", [p0, p1]), inferenceClaim(v, " Prices rise ", [p1, p0]),
    inferenceClaim(v, "Prices rise", [p0]), inferenceClaim(v, "Prices rise", [address(v, copy, 0), p1])));
  // The attempt path is accepted only by the DR3b-P application: until then a premise of an attempt refuses with
  // its own code — and an injected acceptance stands for that application here.
  assert.equal(refusal(() => claimContentKey(f.store, address(v, a, 0))), "claim_attempt_not_accepted");
  const accepted = new Set([p0, p1, address(v, copy, 0)].map(item => canonical(item)));
  const premise = (item: ClaimAddress) => {
    if (!accepted.has(canonical(item))) throw new EngineError("claim_attempt_not_accepted", "fixture: not accepted");
  };
  const key = (index: number) => claimContentKey(f.store, address(v, a, index), { premise });
  assert.equal(key(0), key(1), "premise order and outer spaces are not content");
  assert.notEqual(key(0), key(2), "another premise set is another content");
  assert.equal(key(0), key(3), "a premise of the same material in another container is the same premise");
  accepted.delete(canonical(p1));
  assert.equal(refusal(() => key(0)), "claim_attempt_not_accepted");
  // Exact Refs make a real cycle unconstructible (a hash fixpoint); the guard is proven at the resolver seam.
  const x: ClaimAddress = { ...p0, claimId: "x" }, y: ClaimAddress = { ...p0, claimId: "y" };
  const resolve = (item: ClaimAddress): ResolvedClaim => ({ container: undefined as never,
    claim: { id: item.claimId, kind: "inference", text: item.claimId,
      basis: { from: [asJson(item.claimId === "x" ? y : x)], reasoning: "loop" } } as unknown as Json });
  assert.equal(refusal(() => claimContentKey(f.store, x, { premise: () => {}, resolve })),
    "discovery_novelty_invalid inference.from");
});

/** A real v2 Discovery choice of the local owner authority in this project (the discovery-decision fixture path). */
function ownerAct(f: Fixture, project: string) {
  f.engine.execute({ type: "create-project", project, title: "Owner act" });
  const source = f.engine.discovery.evidence.document(project, "request", "Owner act fixture", "text/plain", 0);
  const draft = f.engine.prepare(project, "discovery");
  for (const id of draft.value.questions) {
    const q = f.store.get<Question>(id)!, field = q.value.spec.field;
    if (field === "preparation") break;
    if (q.value.spec.kind === "fact") f.engine.discovery.fact(q.id, q.revision, reference(source),
      { kind: "text-range", start: 0, end: source.value.content.length });
    else if (["researchPlan", "researchReport", "verdict"].includes(field)) {
      const value = preparedField(project, field) as Record<string, Json>;
      if (field === "verdict") Object.assign(value, { outcome: "conditional", conditions: [{ id: "scope", kind: "owner_choice",
        condition: "Choose scope", criterion: "Explicit owner choice", options: [
          { optionId: "accept", label: "Accept", consequences: ["Reassess"], choice: "accept" },
          { optionId: "decline", label: "Decline", consequences: ["Reassess"], choice: "decline" }] }] });
      answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!, q, value, source);
    } else f.engine.discovery.decision(q.id, q.revision, "local-owner", preparedField(project, field));
  }
  const question = (field: string) => draft.value.questions.map(id => f.store.get<Question>(id)!)
    .find(q => q.value.spec.field === field)!;
  const verdict = question("verdict").value.answer!, reportRef = question("researchReport").value.answer!;
  const scoped = { project, draft: draft.id, verdictRef: verdict, reportRef, conditionId: "scope", optionId: "accept" };
  const sessions = new DiscoveryChoiceSessions(f.store);
  const issued = issueDiscoveryChoiceInvitation(f.store, scoped);
  assert.ok(issued.ok);
  const exchanged = sessions.exchange({ project, invitation: issued.value.invitation });
  assert.ok(exchanged.ok);
  const decision = answerDiscoveryCondition(f.store, scoped, sessions.authority(exchanged.value.bearer)!).decision as
    Revision<DiscoveryConditionDecisionV2>;
  sessions.revoke(exchanged.value.bearer);
  return { decision, draft, verdict, reportRef };
}

test("DR3b-M content key: an owner-decision needs a performed owner act — a grant, a session, a historical caller choice or any other record is not one; the key is the normalized text and the act scope", t => {
  const f = fixture(t), project = `p${rand()}`;
  const act = ownerAct(f, project);
  const v = v7Project(f, project);
  const session = f.store.get<{ grant: Ref }>(act.decision.value.session.id, act.decision.value.session.revision)!;
  const v1 = f.store.write({ id: discoveryDecisionId(project, act.draft.id, act.verdict, "legacy"),
    kind: "discovery-condition-decision", expected: 0, value: { contract: "discovery-condition-decision/v1",
      projectId: project, draftId: act.draft.id, verdictRef: asJson(act.verdict), conditionId: "legacy", optionId: "accept",
      actor: "owner" } });
  const other = webSource(f, project);
  const a = attempt(f, v, submitted(ownerClaim(v, exact(act.decision)), ownerClaim(v, exact(act.decision), "  The owner accepted the local scope\r\n"),
    ownerClaim(v, exact(act.decision), "Another wording of the decision"), ownerClaim(v, session.value.grant),
    ownerClaim(v, exact(session)), ownerClaim(v, exact(v1)), ownerClaim(v, exact(other))));
  const key = (index: number) => claimContentKey(f.store, address(v, a, index));
  assert.equal(key(0), key(1));
  assert.notEqual(key(0), key(2), "the decision content is part of the key");
  for (const index of [3, 4, 5, 6])
    assert.equal(refusal(() => key(index)), "discovery_novelty_invalid owner-decision.authority", `authority ${index}`);
});

test("DR3b-M content key: a constraint is its code and the proven content of its evidence — never the attempt id or text; empty evidence proves nothing new; a transition needs a new basis and sorts its bases", t => {
  const f = fixture(t), v = v7Project(f);
  const evidence = webSource(f, v.project), recapture = webSource(f, v.project);
  const a = attempt(f, v, refused(f, v.project, "The supplier page is gone", [exact(evidence)]));
  const b = attempt(f, v, refused(f, v.project, "Renamed: the page vanished", [exact(recapture)]));
  const c = attempt(f, v, refused(f, v.project, "The supplier page is gone"));
  const d = attempt(f, v, impossible());
  const fact = attempt(f, v, submitted(factClaim(v, webSource(f, v.project))));
  assert.equal(constraintContentKey(f.store, a.attempt), constraintContentKey(f.store, b.attempt),
    "a renamed refusal over the same material is not new");
  assert.notEqual(constraintContentKey(f.store, a.attempt), constraintContentKey(f.store, c.attempt));
  assert.equal(refusal(() => constraintContentKey(f.store, d.attempt)), "discovery_novelty_invalid constraint.evidence");
  assert.equal(refusal(() => constraintContentKey(f.store, fact.attempt)), "discovery_novelty_invalid constraint");
  const k1 = constraintContentKey(f.store, a.attempt), k2 = claimContentKey(f.store, address(v, fact, 0));
  assert.equal(transitionContentKey("open", "unknown", [k1, k2]), transitionContentKey("open", "unknown", [k2, k1, k1]));
  assert.notEqual(transitionContentKey("open", "unknown", [k1]), transitionContentKey(null, "unknown", [k1]));
  assert.equal(refusal(() => transitionContentKey("open", "closed", [])), "discovery_novelty_invalid transition.bases");
});

test("DR3b-M-01 (codex-omg №7589): constraint evidence is keyed only by an explicit semantic projector — service fields of an unsupported kind never make a new key, the kind is refused with its address; a recaptured Source is the same content", t => {
  const f = fixture(t), v = v7Project(f);
  const first = attempt(f, v, submitted(factClaim(v, webSource(f, v.project))));
  const call = f.store.get<Record<string, Json>>((f.store.get<{ call: Ref }>(first.attempt.id)!.value.call).id)!;
  const audit = (startedAt: number) => exact(f.store.write({ id: `model-call:probe:${startedAt}:${rand()}`, kind: "model-call",
    expected: 0, value: { ...call.value, startedAt } }));
  const a = attempt(f, v, refused(f, v.project, "same source unavailable", [audit(100)]));
  const b = attempt(f, v, refused(f, v.project, "same source unavailable", [audit(200)]));
  assert.equal(refusal(() => constraintContentKey(f.store, a.attempt)), "discovery_novelty_invalid constraint.evidence.0");
  assert.equal(refusal(() => constraintContentKey(f.store, b.attempt)), "discovery_novelty_invalid constraint.evidence.0");
  // Kinds named like inherited Object members have no own projector either (№7601).
  for (const kind of ["toString", "valueOf", "constructor", "__proto__", "hasOwnProperty"]) {
    const evidence = f.store.write({ id: `probe-evidence:${kind}:${rand()}`, kind, expected: 0,
      value: { projectId: v.project, content: "same" } });
    const probe = attempt(f, v, refused(f, v.project, "unavailable", [exact(evidence)]));
    assert.equal(refusal(() => constraintContentKey(f.store, probe.attempt)), "discovery_novelty_invalid constraint.evidence.0", kind);
  }
  const page = webSource(f, v.project), recapture = webSource(f, v.project);
  const c = attempt(f, v, refused(f, v.project, "The page is gone", [exact(page)]));
  const d = attempt(f, v, refused(f, v.project, "Gone again", [exact(recapture)]));
  assert.equal(constraintContentKey(f.store, c.attempt), constraintContentKey(f.store, d.attempt));
  // The form refuses a transition whose constraint basis has no computable content.
  const packet = projectAttemptPacket(f.store, { ...subject(v), entries: [entry(a)] });
  const novelty: V7Novelty = { attempts: [row(a)], accepted: [], rejected: [], newContent: [], duplicates: [], noProgress: [],
    transition: { outcome: "unknown", bases: [{ constraint: a.attempt }], reason: "x", consequence: "y", nextAction: "z" } };
  assert.equal(refusal(() => checkDiscoveryAssessmentForm(f.store, assessmentOf(packet, absentBaseline(v), novelty))),
    "discovery_novelty_invalid constraint.evidence.0");
});

/** A counting resolver over synthetic claims: the derivation must touch each distinct claim once. */
function syntheticGraph(project: string, edges: Record<string, string[]>) {
  const addr = (name: string): ClaimAddress => ({ project, container: { id: `a-${name}`, revision: 1, hash: "0".repeat(64) },
    containerKind: "research-attempt", pointer: "/claims/0", claimId: name });
  const counts = { resolves: 0, acceptances: 0 };
  const resolve = (item: ClaimAddress): ResolvedClaim => {
    counts.resolves += 1;
    const from = edges[item.claimId]!;
    return { container: undefined as never, claim: (from.length === 0
      ? { id: item.claimId, kind: "hypothesis", text: item.claimId, basis: { howToVerify: "check" } }
      : { id: item.claimId, kind: "inference", text: item.claimId,
        basis: { from: from.map(name => asJson(addr(name))), reasoning: "r" } }) as unknown as Json };
  };
  return { addr, counts, resolve, premise: () => { counts.acceptances += 1; } };
}

test("DR3b-M-02 (codex-omg №7589): a shared accepted premise is resolved, accepted and keyed once per calculation — a chain of double references and diamonds stay linear; cycles and unaccepted premises keep their refusal", t => {
  // A chain where every inference names its predecessor twice (2^n paths, n+1 claims).
  const depth = 10, chain: Record<string, string[]> = { c0: [] };
  for (let i = 1; i <= depth; i += 1) chain[`c${i}`] = [`c${i - 1}`, `c${i - 1}`];
  const g = syntheticGraph("p", chain);
  claimContentKey({} as Store, g.addr(`c${depth}`), { premise: g.premise, resolve: g.resolve });
  assert.deepEqual(g.counts, { resolves: depth + 1, acceptances: depth });
  // Diamonds over a shared subgraph: top → (left, right) → (d1, d2) → base.
  const diamond = syntheticGraph("p", { top: ["left", "right"], left: ["d1", "d2"], right: ["d2", "d1"],
    d1: ["base"], d2: ["base", "base"], base: [] });
  const key = claimContentKey({} as Store, diamond.addr("top"), { premise: diamond.premise, resolve: diamond.resolve });
  assert.deepEqual(diamond.counts, { resolves: 6, acceptances: 5 });
  const again = syntheticGraph("p", { top: ["right", "left"], left: ["d1", "d2"], right: ["d2", "d1"],
    d1: ["base"], d2: ["base", "base"], base: [] });
  assert.equal(claimContentKey({} as Store, again.addr("top"), { premise: again.premise, resolve: again.resolve }), key,
    "the order of shared references is not content");
  // A cycle through a shared node is still a cycle.
  const cyclic = syntheticGraph("p", { top: ["a", "b"], a: ["c"], b: ["c"], c: ["a"] });
  assert.equal(refusal(() => claimContentKey({} as Store, cyclic.addr("top"), { premise: cyclic.premise, resolve: cyclic.resolve })),
    "discovery_novelty_invalid inference.from");
  // The persisted graph: real attempts through the door and K, the real resolver counted.
  const f = fixture(t), v = v7Project(f), persisted = 7;
  let a = attempt(f, v, submitted(hypothesisClaim(v, "h0", "verify"))), current = address(v, a, 0);
  for (let i = 1; i <= persisted; i += 1) {
    a = attempt(f, v, submitted(inferenceClaim(v, `inference ${i}`, [current, current])));
    current = address(v, a, 0);
  }
  let resolves = 0, acceptances = 0;
  claimContentKey(f.store, current, { premise: () => { acceptances += 1; },
    resolve: item => { resolves += 1; return resolveClaimAddress(f.store, item); } });
  assert.deepEqual({ resolves, acceptances }, { resolves: persisted + 1, acceptances: persisted });
  // An unaccepted shared premise refuses once with its own code.
  assert.equal(refusal(() => claimContentKey(f.store, current)), "claim_attempt_not_accepted");
});

/* ---------- 5. fsck sites ---------- */

test("DR3b-M reference sites: an attempts assessment names exactly its packet, baseline, paid records, return target and every classified container; texts are not references; fsck reads a saved form", t => {
  const f = fixture(t), n = novelPacket(f);
  const value = assessmentOf(n.packet, { ...n.baseline, materials: [n.c.a2f] }, { ...n.novelty,
    transition: { outcome: "unknown", bases: [{ constraint: n.a1.attempt }, { claim: n.c.a2h }], reason: "x",
      consequence: "y", nextAction: "z" }, noProgress: [row(n.a3), row(n.a4)] });
  const fields = referenceSites(DISCOVERY_ASSESSMENT_KIND, value).map(site => site.field).sort();
  const expected = ["application", "environment", "session", "subject.packet.planAnswer", "subject.packet.question",
    ...[0, 1, 2, 3].flatMap(i => [`subject.packet.entries[${i}].attempt`, `subject.packet.entries[${i}].binding`]),
    "baseline.materials[0].container",
    ...[0, 1, 2, 3].map(i => `novelty.attempts[${i}].attempt`),
    ...[0, 1, 2].map(i => `novelty.accepted[${i}].claim.container`),
    ...[0, 1].map(i => `novelty.newContent[${i}].claim.container`),
    "novelty.duplicates[0].claim.container", "novelty.duplicates[0].of.container",
    "novelty.noProgress[0].attempt", "novelty.noProgress[1].attempt",
    "novelty.transition.bases[0].constraint", "novelty.transition.bases[1].claim.container"].sort();
  assert.deepEqual(fields, expected);
  const back = assessmentOf(n.packet, n.baseline, { ...n.novelty, accepted: [], rejected: [], newContent: [],
    duplicates: [], noProgress: [] }, { verdict: "return", return: { target: { claim: n.c.a2f }, reason: "x" } });
  assert.ok(referenceSites(DISCOVERY_ASSESSMENT_KIND, back).some(site => site.field === "return.target.claim.container"));
  // A saved form with its real attempts, K and materials passes fsck (the paid session/application are DR3b-A's
  // records; here they point at saved stand-ins so fsck can traverse every declared site).
  const stand = (id: string) => exact(f.store.write({ id, kind: "fixture-record", expected: 0, value: { projectId: n.v.project } }));
  const saved = { ...value, session: stand(`fixture:${rand()}`), application: stand(`fixture:${rand()}`),
    environment: stand(`fixture:${rand()}`) };
  checkDiscoveryAssessmentForm(f.store, saved);
  f.store.write({ id: `${DISCOVERY_ASSESSMENT_KIND}:${rand()}`, kind: DISCOVERY_ASSESSMENT_KIND, expected: 0,
    value: saved as unknown as Record<string, Json> });
  assert.deepEqual(checkStoreIntegrity(f.open()).findings ?? [], []);
});
