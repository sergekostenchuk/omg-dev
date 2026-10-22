import test from "node:test";
import assert from "node:assert/strict";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_ATTEMPT_KIND,
  V7_ATTEMPT_CONTRACT, DISCOVERY_CLAIMS_CONTRACT } from "../src/discovery/v7-contracts.js";
import { provePlanQuestions, currentPlan, nextPlanQuestion, proveAttempt, v7AttemptId,
  type V7Attempt, type V7AttemptEnd } from "../src/discovery/v7-plan-questions.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import type { ResearchAnswer } from "../src/discovery/research-model.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, rand, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3a1-pq-");

const thrown = (fn: () => unknown, code: string, includes?: string) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    assert.equal((error as EngineError).code, code, (error as EngineError).message);
    if (includes) assert.ok((error as EngineError).message.includes(includes), (error as EngineError).message);
    return error as EngineError;
  }
  assert.fail(`expected ${code}`);
};

const asJson = <T>(value: T): Json => value as unknown as Json;

/** Настоящая цепочка принятия плана: рамка и план приняты через #answer —
 * discovery-acceptance-act пишется производителем, не моделью. Возвращает
 * головной драфт и точный Ref принятого ответа плана. */
function acceptPlan(store: Store, engine: ProductEngine, discovery: Discovery, project: string,
  questions: PlanQuestion[], draft?: Revision<DiscoveryDraft>):
  { draft: Revision<DiscoveryDraft>; planAnswer: Ref; frameRef: Ref } {
  const base = draft ?? createPartialV7Draft(discovery, project, "concept");
  const src = discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(store, base, "frame");
  answerDiscoveryFixture(engine, project, base, frame, validFrame(), src);
  const frameRef = store.get<Question>(frame.id)!.value.answer!;
  const plan = questionOf(store, base, "plan");
  answerDiscoveryFixture(engine, project, base, plan, validPlan(frameRef, questions), src);
  const planAnswer = store.get<Question>(plan.id)!.value.answer!;
  return { draft: store.get<DiscoveryDraft>(base.id)!, planAnswer, frameRef };
}

/** Вторая редакция плана — законный reopen и принятие следующей редакции. */
function acceptNextPlanEdition(store: Store, engine: ProductEngine, discovery: Discovery,
  project: string, draft: Revision<DiscoveryDraft>, frameRef: Ref, previous: Ref,
  questions: PlanQuestion[]): Ref {
  const plan = questionOf(store, store.get<DiscoveryDraft>(draft.id)!, "plan");
  discovery.reopen(plan.id, plan.revision);
  const reopened = store.get<Question>(plan.id)!;
  const src = discovery.evidence.document(project, `basis-${rand()}`, `Source ${rand()}`, "text/plain", 0);
  answerDiscoveryFixture(engine, project, store.get<DiscoveryDraft>(draft.id)!, reopened,
    validPlan(frameRef, questions, 2, previous), src);
  return store.get<Question>(plan.id)!.value.answer!;
}

/** Моделируемая запись model-call — форма физического вызова, который
 * обычная диспетчеризация исследования пишет до двери попытки: привязка к
 * проекту, драфту, стабильному id план-вопроса и точной принятой редакции
 * плана (planAnswer), под которой вызов был назначен. */
function writeCall(store: Store, opts: { projectId: string; draftId: string;
  questionId: string; planAnswer: Ref }): Revision<Record<string, Json>> {
  return store.write({ id: `model-call:${opts.projectId}:${opts.questionId}:${rand()}`,
    kind: "model-call", expected: 0,
    value: { projectId: opts.projectId, draftId: opts.draftId, questionId: opts.questionId,
      planAnswer: asJson(opts.planAnswer), purpose: "research", requestId: `r-${rand()}`,
      startedAt: 1, finishedAt: 2, status: "succeeded",
      requested: { actor: "fixture", model: "fixture", effort: "medium",
        command: { executable: "fixture", args: [] } },
      confirmed: { model: "fixture", effort: "medium", speed: null },
      request: { chars: 10, bytes: 10, hash: hashJson("req") },
      response: { chars: 20, bytes: 20 },
      usage: null, usageSource: "unavailable", error: null } });
}

/** Моделируемая запись попытки — форма v7-attempt/v1, которую DR3a2-дверь
 * будет писать атомарно; id детерминирован от ключа. */
function writeAttempt(store: Store, opts: { project: string; draft: Ref; planAnswer: Ref;
  planQuestionId: string; call: Ref; end: V7AttemptEnd; id?: string }): Revision<V7Attempt> {
  const key = { project: opts.project, planAnswer: opts.planAnswer,
    planQuestionId: opts.planQuestionId, call: opts.call };
  const value: V7Attempt = { contract: V7_ATTEMPT_CONTRACT, ...key, draft: opts.draft, end: opts.end };
  return store.write<V7Attempt>({ id: opts.id ?? v7AttemptId(key), kind: V7_ATTEMPT_KIND,
    expected: 0, value });
}

function writeProjectRecord(store: Store, project: string, kind = "source"): Revision<Record<string, Json>> {
  return store.write({ id: `${kind}:${project}:${rand()}`, kind, expected: 0,
    value: { projectId: project, content: "basis" } });
}

const submittedEnd = (claims: Json[]): V7AttemptEnd =>
  ({ type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } });

/** Валидный fact-claim модельной формы discovery-claims/v7. */
function factClaim(store: Store, project: string, id: string, planAnswer: Ref,
  planQuestionId: string, overrides: Record<string, Json> = {}): Json {
  const src = writeProjectRecord(store, project);
  return { id, kind: "fact", text: `Claim ${id}`, axis: "market",
    planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId }],
    scope: { variants: "common" },
    basis: { source: { ref: asJson(reference(src)), range: { start: 0, end: 3 },
      valueHash: hashJson("v") }, limit: "snapshot", asOf: "2026-10" },
    ...overrides } as unknown as Json;
}

test("DR3a1: план-вопросы выводятся из принятого плана — акт по точному Ref, не голова", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p1",
    [planQuestion("q-blk", "rules", "blocking"), planQuestion("q-sup", "market")]);
  const set = provePlanQuestions(store, draft, planAnswer);
  assert.deepEqual(set.map(item => item.planQuestionId), ["q-blk", "q-sup"]);
  for (const item of set) assert.deepEqual(item.planAnswer, planAnswer);
  // Точная ревизия: другая ревизия или хеш — отказ.
  thrown(() => provePlanQuestions(store, draft, { id: planAnswer.id, revision: 99, hash: planAnswer.hash }),
    "plan_questions_invalid");
  thrown(() => provePlanQuestions(store, draft, { id: planAnswer.id, revision: planAnswer.revision,
    hash: "0".repeat(64) }), "plan_questions_invalid");
  // Подмена: запись ответа на план есть, акта принятия нет — отказ без fallback.
  const planQuestion_ = questionOf(store, draft, "plan");
  const forged = store.write<ResearchAnswer>({ id: `research-answer:p1:forge-${rand()}`,
    kind: "research-answer", expected: 0,
    value: { projectId: "p1", question: planQuestion_.id,
      assessment: { id: "research-assessment:none", revision: 1, hash: "0".repeat(64) },
      value: validPlan(store.get<Question>(questionOf(store, draft, "frame").id)!.value.answer!,
        [planQuestion("q-x", "market")]) } as unknown as ResearchAnswer });
  thrown(() => provePlanQuestions(store, draft, reference(forged)),
    "plan_questions_invalid", "never accepted");
  // Чужой драфт: принятый план другого проекта не раскрывается для этого драфта.
  const foreign = acceptPlan(store, engine, discovery, "p-foreign", [planQuestion("q-f", "market")]);
  thrown(() => provePlanQuestions(store, draft, foreign.planAnswer), "plan_questions_invalid");
  thrown(() => provePlanQuestions(store, foreign.draft, planAnswer), "plan_questions_invalid");
});

test("DR3a1: текущий план — только доказанный; отбор детерминирован (блокирующие, порядок плана)", t => {
  const { store, engine, discovery } = fixture(t);
  // Нет драфта v7 — отказ.
  thrown(() => currentPlan(store, "ghost"), "plan_questions_invalid");
  // План ещё не отвечен — отказ, вызывающий не может подменить состояние.
  const pending = createPartialV7Draft(discovery, "p2", "concept");
  thrown(() => currentPlan(store, "p2"), "plan_questions_invalid", "not answered");
  // Принятый план на том же драфте: блокирующие раньше — в порядке плана, затем supporting.
  acceptPlan(store, engine, discovery, "p2",
    [planQuestion("q-sup1", "market"), planQuestion("q-blk", "rules", "blocking"),
      planQuestion("q-sup2", "people"), planQuestion("q-blk2", "feasibility", "blocking")], pending);
  const current = currentPlan(store, "p2");
  assert.deepEqual(current.questions.map(item => item.planQuestionId),
    ["q-sup1", "q-blk", "q-sup2", "q-blk2"]);
  const next = nextPlanQuestion(store, "p2");
  assert.equal(next!.planQuestionId, "q-blk");
  // Повтор — тот же результат (детерминированность).
  assert.equal(nextPlanQuestion(store, "p2")!.planQuestionId, "q-blk");
  // План без блокирующих — первый по порядку плана.
  acceptPlan(store, engine, discovery, "p2b",
    [planQuestion("q-a", "market"), planQuestion("q-b", "people")]);
  assert.equal(nextPlanQuestion(store, "p2b")!.planQuestionId, "q-a");
  // Два v7-драфта проекта — неоднозначность отказана, не угадана по записи.
  createPartialV7Draft(discovery, "p2c", "concept");
  createPartialV7Draft(discovery, "p2c", "concept");
  thrown(() => currentPlan(store, "p2c"), "plan_questions_invalid", "not singled out");
});

test("DR3a1: вторая редакция плана — текущий план едет по новой редакции, историческая — по своему акту", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer, frameRef } = acceptPlan(store, engine, discovery, "p3",
    [planQuestion("q-v1", "market")]);
  const plan2 = acceptNextPlanEdition(store, engine, discovery, "p3", draft, frameRef, planAnswer,
    [planQuestion("q-v2", "rules", "blocking")]);
  // Текущий план — вторая редакция.
  const current = currentPlan(store, "p3");
  assert.deepEqual(current.planAnswer, plan2);
  assert.equal(nextPlanQuestion(store, "p3")!.planQuestionId, "q-v2");
  // Историческая редакция читается по своему сохранённому акту.
  const historical = provePlanQuestions(store, store.get<DiscoveryDraft>(draft.id)!, planAnswer);
  assert.deepEqual(historical.map(item => item.planQuestionId), ["q-v1"]);
});

test("DR3a1: четыре конца попытки — submitted/refused/impossible/duplicate", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p5",
    [planQuestion("q-blk", "rules", "blocking")]);
  const callFor = () => reference(writeCall(store,
    { projectId: "p5", draftId: draft.id, questionId: "q-blk", planAnswer }));
  const base = { project: "p5", draft: reference(draft), planAnswer, planQuestionId: "q-blk" };
  // submitted — попытка сама контейнер своих claims
  const sub = writeAttempt(store, { ...base, call: callFor(),
    end: submittedEnd([factClaim(store, "p5", "c-1", planAnswer, "q-blk")]) });
  const proof = proveAttempt(store, reference(sub));
  assert.equal(proof.claims!.length, 1);
  assert.equal(proof.planQuestion.planQuestionId, "q-blk");
  assert.equal(proof.draft.id, draft.id);
  // refused — код из закрытого списка, свидетельства — exact Ref проекта
  const evidence = writeProjectRecord(store, "p5");
  const refused = writeAttempt(store, { ...base, call: callFor(),
    end: { type: "refused", code: "outside_plan_scope", evidence: [reference(evidence)],
      text: "out of scope" } });
  assert.equal(proveAttempt(store, reference(refused)).claims, undefined);
  // impossible
  const impossible = writeAttempt(store, { ...base, call: callFor(),
    end: { type: "impossible", code: "source_unavailable", evidence: [], text: "no sources" } });
  assert.equal(proveAttempt(store, reference(impossible)).claims, undefined);
  // duplicate — of указывает на submitted-попытку того же план-вопроса
  const duplicate = writeAttempt(store, { ...base, call: callFor(),
    end: { type: "duplicate", of: reference(sub) } });
  assert.equal(proveAttempt(store, reference(duplicate)).claims, undefined);
});

test("DR3a1: концы — отказы формы (код, self-dup, чужой оригинал, висячее свидетельство)", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p6",
    [planQuestion("q-blk", "rules", "blocking"), planQuestion("q-other", "market")]);
  const callFor = (q: string) => reference(writeCall(store,
    { projectId: "p6", draftId: draft.id, questionId: q, planAnswer }));
  const base = { project: "p6", draft: reference(draft), planAnswer, planQuestionId: "q-blk" };
  const sub = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: submittedEnd([factClaim(store, "p6", "c-1", planAnswer, "q-blk")]) });
  // код вне закрытого списка
  const badCode = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: { type: "refused", code: "custom_reason", evidence: [], text: "x" } });
  thrown(() => proveAttempt(store, reference(badCode)), "attempt_invalid", "closed list");
  // пустой текст причины
  const noText = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: { type: "impossible", code: "source_unavailable", evidence: [], text: "" } });
  thrown(() => proveAttempt(store, reference(noText)), "attempt_invalid", "reason");
  // висячее свидетельство
  const danglingEvidence = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: { type: "refused", code: "outside_plan_scope",
      evidence: [{ id: "source:p6:ghost", revision: 1, hash: "0".repeat(64) }], text: "x" } });
  thrown(() => proveAttempt(store, reference(danglingEvidence)), "attempt_invalid", "evidence");
  // duplicate на самого себя — self-id в of отказывает на единственной ревизии
  const selfCall = callFor("q-blk");
  const selfId = v7AttemptId({ project: "p6", planAnswer, planQuestionId: "q-blk", call: selfCall });
  const selfDup = writeAttempt(store, { ...base, call: selfCall,
    end: { type: "duplicate", of: { id: selfId, revision: 1, hash: "0".repeat(64) } } });
  thrown(() => proveAttempt(store, reference(selfDup)), "attempt_invalid", "itself");
  // duplicate на не-submitted попытку того же вопроса
  const refusedOriginal = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: { type: "refused", code: "outside_plan_scope", evidence: [], text: "x" } });
  const dupOfRefused = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: { type: "duplicate", of: reference(refusedOriginal) } });
  thrown(() => proveAttempt(store, reference(dupOfRefused)), "attempt_invalid", "submitted");
  // duplicate на попытку другого план-вопроса
  const otherCall = writeCall(store, { projectId: "p6", draftId: draft.id, questionId: "q-other", planAnswer });
  const otherAttempt = writeAttempt(store, { project: "p6", draft: reference(draft), planAnswer,
    planQuestionId: "q-other", call: reference(otherCall),
    end: submittedEnd([factClaim(store, "p6", "c-9", planAnswer, "q-other")]) });
  const dupForeign = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: { type: "duplicate", of: reference(otherAttempt) } });
  thrown(() => proveAttempt(store, reference(dupForeign)), "attempt_invalid", "this plan-question");
  // duplicate на отсутствующую запись
  const dupMissing = writeAttempt(store, { ...base, call: callFor("q-blk"),
    end: { type: "duplicate", of: { id: "research-attempt:p6:ghost", revision: 1, hash: "0".repeat(64) } } });
  thrown(() => proveAttempt(store, reference(dupMissing)), "attempt_invalid");
  assert.ok(sub.id.length > 0);
});

test("DR3a1: ключ и происхождение попытки — отказы", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p7",
    [planQuestion("q-blk", "rules", "blocking"), planQuestion("q-other", "market")]);
  const callFor = (q: string) => reference(writeCall(store,
    { projectId: "p7", draftId: draft.id, questionId: q, planAnswer }));
  const base = { project: "p7", draft: reference(draft), planAnswer, planQuestionId: "q-blk" };
  const end = () => submittedEnd([factClaim(store, "p7", `c-${rand()}`, planAnswer, "q-blk")]);
  // id не детерминирован от ключа
  const badId = writeAttempt(store, { ...base, call: callFor("q-blk"), end: end(),
    id: `research-attempt:p7:arbitrary-${rand()}` });
  thrown(() => proveAttempt(store, reference(badId)), "attempt_invalid", "deterministic");
  // вызов другого план-вопроса
  const wrongCall = writeAttempt(store, { ...base, call: callFor("q-other"), end: end() });
  thrown(() => proveAttempt(store, reference(wrongCall)), "attempt_invalid", "plan-question");
  // вызов отсутствует
  const ghostCall = writeAttempt(store, { ...base, end: end(),
    call: { id: "model-call:p7:ghost", revision: 1, hash: "0".repeat(64) } });
  thrown(() => proveAttempt(store, reference(ghostCall)), "attempt_invalid", "call");
  // вызов чужого проекта
  const foreignCall = writeCall(store, { projectId: "other", draftId: draft.id, questionId: "q-blk", planAnswer });
  const foreignCallAttempt = writeAttempt(store, { ...base, call: reference(foreignCall), end: end() });
  thrown(() => proveAttempt(store, reference(foreignCallAttempt)), "attempt_invalid", "call");
  // план-вопрос вне принятого плана
  const ghostQuestion = writeAttempt(store, { project: "p7", draft: reference(draft), planAnswer,
    planQuestionId: "q-ghost", call: callFor("q-ghost"), end: end() });
  thrown(() => proveAttempt(store, reference(ghostQuestion)), "attempt_invalid", "accepted plan");
  // чужой проект в теле попытки
  const foreignProject = writeAttempt(store, { project: "other", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk", call: callFor("q-blk"), end: end() });
  thrown(() => proveAttempt(store, reference(foreignProject)), "attempt_invalid");
  // непринятый planAnswer — подмена записью без акта
  const planQ = questionOf(store, draft, "plan");
  const forged = store.write<ResearchAnswer>({ id: `research-answer:p7:forge-${rand()}`,
    kind: "research-answer", expected: 0,
    value: { projectId: "p7", question: planQ.id,
      assessment: { id: "research-assessment:none", revision: 1, hash: "0".repeat(64) },
      value: validPlan(store.get<Question>(questionOf(store, draft, "frame").id)!.value.answer!,
        [planQuestion("q-blk", "rules", "blocking")]) } as unknown as ResearchAnswer });
  const forgedPlan = writeAttempt(store, { project: "p7", draft: reference(draft),
    planAnswer: reference(forged), planQuestionId: "q-blk", call: callFor("q-blk"), end: end() });
  thrown(() => proveAttempt(store, reference(forgedPlan)), "plan_questions_invalid");
  // запись не того вида — отказ
  const wrongKind = store.write({ id: `research-answer:p7:fake-attempt-${rand()}`,
    kind: "research-answer", expected: 0, value: forged.value });
  thrown(() => proveAttempt(store, reference(wrongKind)), "attempt_invalid");
  // отсутствующая/изменённая запись
  thrown(() => proveAttempt(store, { id: "research-attempt:p7:none", revision: 1, hash: "0".repeat(64) }),
    "attempt_invalid");
});

test("DR3a1: claims-форма попытки — дискриминация по виду, уникальность, свой план-вопрос", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p8",
    [planQuestion("q-blk", "rules", "blocking")]);
  const callFor = () => reference(writeCall(store,
    { projectId: "p8", draftId: draft.id, questionId: "q-blk", planAnswer }));
  const base = { project: "p8", draft: reference(draft), planAnswer, planQuestionId: "q-blk" };
  const attemptWith = (claims: Json[]) => proveAttempt(store, reference(
    writeAttempt(store, { ...base, call: callFor(), end: submittedEnd(claims) })));
  // пустая коллекция — свой код
  thrown(() => attemptWith([]), "attempt_claims_empty");
  // дубль id
  thrown(() => attemptWith([factClaim(store, "p8", "c-1", planAnswer, "q-blk"),
    factClaim(store, "p8", "c-1", planAnswer, "q-blk")]), "attempt_invalid", "not unique");
  // лишнее поле
  thrown(() => attemptWith([factClaim(store, "p8", "c-1", planAnswer, "q-blk",
    { extra: "x" as unknown as Json })]), "attempt_invalid", "contracted fields");
  // ось вне 12
  thrown(() => attemptWith([factClaim(store, "p8", "c-1", planAnswer, "q-blk",
    { axis: "other" as unknown as Json })]), "attempt_invalid", "12 axes");
  // claims без план-вопроса попытки
  thrown(() => attemptWith([factClaim(store, "p8", "c-1", planAnswer, "q-blk",
    { planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-ghost" }] as unknown as Json })]),
    "attempt_invalid", "own plan-question");
  // basis не по виду: fact без source
  thrown(() => attemptWith([factClaim(store, "p8", "c-1", planAnswer, "q-blk",
    { basis: { howToVerify: "x" } as unknown as Json })]), "attempt_invalid", "basis");
  // fact: диапазон не 0<=start<end
  const badRange = factClaim(store, "p8", "c-1", planAnswer, "q-blk") as unknown as Record<string, Json>;
  const badRangeBasis = badRange["basis"] as Record<string, Json>;
  const badRangeSource = badRangeBasis["source"] as Record<string, Json>;
  badRangeBasis["source"] = { ref: badRangeSource["ref"], range: { start: 3, end: 3 },
    valueHash: badRangeSource["valueHash"] } as unknown as Json;
  thrown(() => attemptWith([badRange as unknown as Json]), "attempt_invalid", "range");
  // unknown: moment вне перечня
  const unknownClaim = { id: "c-u", kind: "unknown", text: "u", axis: "market",
    planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
    scope: { variants: "common" },
    basis: { origin: "wide-pass", unknownId: "u-1", question: "what?", affects: ["cost"],
      consumer: "owner", blocksCurrentStage: false, moment: "later", closeCriterion: "answered" } } as unknown as Json;
  thrown(() => attemptWith([unknownClaim]), "attempt_invalid", "moment");
  // owner-decision: висячий authority
  const danglingAuthority = { id: "c-d", kind: "owner-decision", text: "d", axis: "rules",
    planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
    scope: { variants: "common" },
    basis: { authority: { id: "owner-session:p8:ghost", revision: 1, hash: "0".repeat(64) } } } as unknown as Json;
  thrown(() => attemptWith([danglingAuthority]), "attempt_invalid", "authority");
  // inference: висячий контейнер
  const danglingFrom = { id: "c-i", kind: "inference", text: "i", axis: "market",
    planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
    scope: { variants: "common" },
    basis: { from: [{ project: "p8", container: { id: "research-answer:p8:ghost", revision: 1,
      hash: "0".repeat(64) }, containerKind: "research-answer", pointer: "/claims/0", claimId: "x" }],
      reasoning: "follows" } } as unknown as Json;
  thrown(() => attemptWith([danglingFrom]), "attempt_invalid", "container");
  // inference: контейнер существует (planAnswer — запись проекта) — формально цело
  const fromExisting = { ...danglingFrom as Record<string, Json>,
    basis: { from: [{ project: "p8", container: asJson(planAnswer), containerKind: "research-answer",
      pointer: "/claims/0", claimId: "x" }], reasoning: "follows" } } as unknown as Json;
  assert.equal(attemptWith([fromExisting]).claims!.length, 1);
});

test("DR3a1: два результата одного план-вопроса — две попытки; ключ идемпотентен", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p9",
    [planQuestion("q-blk", "rules", "blocking")]);
  const call1 = writeCall(store, { projectId: "p9", draftId: draft.id, questionId: "q-blk", planAnswer });
  const call2 = writeCall(store, { projectId: "p9", draftId: draft.id, questionId: "q-blk", planAnswer });
  const base = { project: "p9", draft: reference(draft), planAnswer, planQuestionId: "q-blk" };
  const a1 = writeAttempt(store, { ...base, call: reference(call1),
    end: submittedEnd([factClaim(store, "p9", "c-1", planAnswer, "q-blk")]) });
  const a2 = writeAttempt(store, { ...base, call: reference(call2),
    end: submittedEnd([factClaim(store, "p9", "c-2", planAnswer, "q-blk")]) });
  assert.notEqual(a1.id, a2.id);
  assert.equal(proveAttempt(store, reference(a1)).claims!.length, 1);
  assert.equal(proveAttempt(store, reference(a2)).claims!.length, 1);
  // Тот же ключ — тот же id: повтор без новой записи (конфликт пачки невозможен по ключу).
  const key = { project: "p9", planAnswer, planQuestionId: "q-blk", call: reference(call1) };
  assert.equal(v7AttemptId(key), a1.id);
  thrown(() => writeAttempt(store, { ...base, call: reference(call1),
    end: submittedEnd([factClaim(store, "p9", "c-3", planAnswer, "q-blk")]) }), "revision_conflict");
});

test("DR3a1: историческая попытка — после reopen и новой редакции плана читается по сохранённым Ref", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer, frameRef } = acceptPlan(store, engine, discovery, "p10",
    [planQuestion("q-v1", "rules", "blocking")]);
  const call = writeCall(store, { projectId: "p10", draftId: draft.id, questionId: "q-v1", planAnswer });
  const attempt = writeAttempt(store, { project: "p10", draft: reference(draft), planAnswer,
    planQuestionId: "q-v1", call: reference(call),
    end: submittedEnd([factClaim(store, "p10", "c-1", planAnswer, "q-v1")]) });
  // Новая редакция плана — попытка первой редакции доказывается по своим Ref.
  acceptNextPlanEdition(store, engine, discovery, "p10", draft, frameRef, planAnswer,
    [planQuestion("q-v2", "market")]);
  const proof = proveAttempt(store, reference(attempt));
  assert.equal(proof.planQuestion.planQuestionId, "q-v1");
  assert.equal(proof.claims!.length, 1);
  // Текущий план — уже вторая редакция (проверка, что чтение действительно историческое).
  assert.equal(nextPlanQuestion(store, "p10")!.planQuestionId, "q-v2");
});

test("DR3a1: повреждённая попытка — отказ без fallback", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p11",
    [planQuestion("q-blk", "rules", "blocking")]);
  const call = writeCall(store, { projectId: "p11", draftId: draft.id, questionId: "q-blk", planAnswer });
  const good = writeAttempt(store, { project: "p11", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk", call: reference(call),
    end: submittedEnd([factClaim(store, "p11", "c-1", planAnswer, "q-blk")]) });
  // Вторая ревизия того же ключа — попытка неизменяема, изменённое тело не читается.
  const tampered = store.write<V7Attempt>({ id: good.id, kind: V7_ATTEMPT_KIND, expected: 1,
    value: { ...good.value, contract: "other-contract/v9" as typeof V7_ATTEMPT_CONTRACT } });
  thrown(() => proveAttempt(store, reference(tampered)), "attempt_invalid", "changed");
  // Подмена договора на единственной ревизии — отказ по договору.
  const call2 = writeCall(store, { projectId: "p11", draftId: draft.id, questionId: "q-blk", planAnswer });
  const key2 = { project: "p11", planAnswer, planQuestionId: "q-blk", call: reference(call2) };
  const wrongContract = store.write({ id: v7AttemptId(key2), kind: V7_ATTEMPT_KIND, expected: 0,
    value: { ...good.value, ...key2, contract: "other-contract/v9" } });
  thrown(() => proveAttempt(store, reference(wrongContract)), "attempt_invalid", "contract");
  // end не submitted — структурно цел, claims нет.
  const refused = writeAttempt(store, { project: "p11", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk", call: reference(writeCall(store,
      { projectId: "p11", draftId: draft.id, questionId: "q-blk", planAnswer })),
    end: { type: "refused", code: "outside_plan_scope", evidence: [], text: "x" } });
  assert.equal(proveAttempt(store, reference(refused)).claims, undefined);
});

test("DR3a1: обход ссылок попытки — draft/planAnswer/call/end.of/end.evidence и вложенные claims", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p12",
    [planQuestion("q-blk", "rules", "blocking")]);
  const call = writeCall(store, { projectId: "p12", draftId: draft.id, questionId: "q-blk", planAnswer });
  const container = writeProjectRecord(store, "p12", "research-answer");
  const variant = writeProjectRecord(store, "p12", "variant-record");
  const session = writeProjectRecord(store, "p12", "owner-session");
  const address = (claimId: string) => ({ project: "p12", container: asJson(reference(container)),
    containerKind: "research-answer", pointer: "/claims/0", claimId });
  const src = writeProjectRecord(store, "p12");
  const claims: Json[] = [
    { id: "c-1", kind: "fact", text: "f", axis: "market",
      planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
      scope: { variants: [asJson(reference(variant))] },
      basis: { source: { ref: asJson(reference(src)), range: { start: 0, end: 3 },
        valueHash: hashJson("v") }, limit: "x", asOf: "2026-10" },
      contradicts: [asJson(address("x"))], supersedes: asJson(address("y")) },
    { id: "c-2", kind: "inference", text: "i", axis: "market",
      planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
      scope: { variants: "common" },
      basis: { from: [asJson(address("z"))], reasoning: "r" } },
    { id: "c-3", kind: "owner-decision", text: "d", axis: "rules",
      planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
      scope: { variants: "common" },
      basis: { authority: asJson(reference(session)) } },
  ];
  const attempt = writeAttempt(store, { project: "p12", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk", call: reference(call), end: submittedEnd(claims) });
  const sites = referenceSites("research-attempt", attempt.value);
  const fields = sites.map(site => site.field).sort();
  assert.deepEqual(fields, [
    "call", "draft",
    "end.value.claims[0].basis.source.ref",
    "end.value.claims[0].contradicts[0].container",
    "end.value.claims[0].planQuestions[0].planAnswer",
    "end.value.claims[0].scope.variants[0]",
    "end.value.claims[0].supersedes.container",
    "end.value.claims[1].basis.from[0].container",
    "end.value.claims[1].planQuestions[0].planAnswer",
    "end.value.claims[2].basis.authority",
    "end.value.claims[2].planQuestions[0].planAnswer",
    "planAnswer",
  ]);
  // Согласованная запись чиста; висячий ref в claims — находка fsck.
  let report = checkStoreIntegrity(store);
  assert.equal(report.findings.filter(f => f.id === attempt.id).length, 0,
    JSON.stringify(report.findings, null, 2));
  const dangling = writeAttempt(store, { project: "p12", draft: reference(draft), planAnswer,
    planQuestionId: "q-blk",
    call: reference(writeCall(store, { projectId: "p12", draftId: draft.id, questionId: "q-blk", planAnswer })),
    end: submittedEnd([{ id: "c-x", kind: "fact", text: "x", axis: "market",
      planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
      scope: { variants: "common" },
      basis: { source: { ref: { id: "source:p12:ghost", revision: 1, hash: "0".repeat(64) },
        range: { start: 0, end: 1 }, valueHash: hashJson("v") }, limit: "x", asOf: "2026-10" } } as Json]) });
  report = checkStoreIntegrity(store);
  const flagged = report.findings.filter(f => f.id === dangling.id
    && f.field === "end.value.claims[0].basis.source.ref");
  assert.equal(flagged.length, 1, JSON.stringify(report.findings, null, 2));
});


/* ---------- возврат 1: пробы ревьюера ---------- */

import { DISCOVERY_ACCEPTANCE_ACT_CONTRACT, DISCOVERY_ACCEPTANCE_ACT_KIND,
  discoveryAcceptanceActId, V7_CONTRACT_ERA } from "../src/discovery/v7-contracts.js";
import type { ResearchAssessment } from "../src/discovery/research-model.js";

/** Моделируемая согласованная история принятия плана — те же формы ревизий,
 * что пишет #answer производителя: issued→answered вопрос, драфт с полем,
 * поддержанная оценка и неизменяемый акт принятия. Параметры ломают ровно
 * одну грань: наблюдения оценки или стадию драфта. */
function writePlanAcceptance(store: Store, opts: { project: string; stage?: string;
  questions: PlanQuestion[]; observations?: Json[]; onDraft?: Revision<DiscoveryDraft> }):
  { draft: Revision<DiscoveryDraft>; question: Revision<Question>; planAnswer: Ref } {
  const project = opts.project;
  const spec = { field: "plan", kind: "research-answer", prompt: "plan", risk: "plan",
    schema: { type: "object" } as unknown as Json, proof: "assessment" };
  const planValue = { edition: 1, frame: null, previous: null,
    questions: opts.questions } as unknown as Json;
  const stage = opts.stage ?? "discovery";
  let draftBefore: Revision<DiscoveryDraft>;
  let draftId: string;
  let questionId: string;
  let beforeHash: string;
  if (opts.onDraft) {
    // Второе принятие на том же драфте — намеренно ОТКРЕПЛЁННОЕ: новый вопрос
    // имеет тот же draftId и spec.field='plan', но никогда не входит в
    // draft.questions (нарушение question_unbound — предусловие производителя).
    draftBefore = store.get<DiscoveryDraft>(opts.onDraft.id)!;
    draftId = draftBefore.id;
    questionId = `question:${project}:${rand()}`;
    beforeHash = hashJson(draftBefore.value.fields["plan"] ?? null);
  } else {
    draftId = `discovery-draft:${project}:${rand()}`;
    questionId = `question:${project}:${rand()}`;
    draftBefore = store.write<DiscoveryDraft>({ id: draftId, kind: "discovery-draft",
      expected: 0, value: { projectId: project, createdAt: 1, stage, level: "R0",
        consumer: "fixture", fields: { plan: null }, questions: [questionId], inputs: [],
        contractVersion: V7_CONTRACT_ERA } });
    beforeHash = hashJson(null);
  }
  const questionBefore = store.write<Question>({ id: questionId, kind: "question", expected: 0,
    value: { projectId: project, draftId, stage, level: "R0", consumer: "fixture",
      spec, beforeHash, status: "open", answer: null } });
  const src = store.write({ id: `source:${project}:${rand()}`, kind: "source", expected: 0,
    value: { projectId: project, content: "basis" } });
  const env = store.write({ id: `environment:${project}:${rand()}`, kind: "environment",
    expected: 0, value: { state: "ready" } });
  const observations: Json[] = opts.observations ?? [{ projectId: project,
    source: asJson(reference(src)), selector: { kind: "text-range", start: 0, end: 5 },
    value: "basis" } as Json];
  const assessment = store.write<ResearchAssessment>({
    id: `research-assessment:${project}:${rand()}`, kind: "research-assessment", expected: 0,
    value: { projectId: project, question: reference(questionBefore), value: planValue,
      observations, verdict: "supported", reasons: [], researcher: "r", assessor: "a",
      environment: reference(env) } as unknown as ResearchAssessment });
  const answer = store.write<ResearchAnswer>({ id: `research-answer:${project}:${rand()}`,
    kind: "research-answer", expected: 0,
    value: { projectId: project, question: questionId, assessment: asJson(reference(assessment)),
      value: planValue } as unknown as ResearchAnswer });
  const questionAfter = store.write<Question>({ id: questionId, kind: "question",
    expected: questionBefore.revision,
    value: { ...questionBefore.value, status: "answered", answer: reference(answer) } });
  // draftAfter сохраняет список questions как в draftBefore — при onDraft новый
  // вопрос НЕ добавляется в список (именно это нарушение ловит membership-проверка).
  const draftAfter = store.write<DiscoveryDraft>({ id: draftId, kind: "discovery-draft",
    expected: draftBefore.revision,
    value: { ...draftBefore.value, fields: { ...draftBefore.value.fields, plan: planValue } } });
  const act = { contract: DISCOVERY_ACCEPTANCE_ACT_CONTRACT, projectId: project, draftId,
    field: "plan", draftBefore: reference(draftBefore), draftAfter: reference(draftAfter),
    questionBefore: reference(questionBefore), questionAfter: reference(questionAfter),
    answer: reference(answer), assessment: reference(assessment) };
  store.write({ id: discoveryAcceptanceActId(project, draftId, "plan", reference(answer)),
    kind: DISCOVERY_ACCEPTANCE_ACT_KIND, expected: 0, value: act });
  return { draft: draftAfter, question: questionAfter, planAnswer: reference(answer) };
}

test("DR3a1-01: принятый план — полное происхождение оценки и стадия discovery", t => {
  const { store } = fixture(t);
  // Согласованная модельная цепочка — читается.
  const good = writePlanAcceptance(store, { project: "m1",
    questions: [planQuestion("q-1", "rules", "blocking")] });
  const set = provePlanQuestions(store, good.draft, good.planAnswer);
  assert.equal(set.length, 1);
  assert.equal(set[0]!.planQuestionId, "q-1");
  // Пустые наблюдения оценки — принятого плана нет (та же проверка, что у полевого маршрута).
  const shallow = writePlanAcceptance(store, { project: "m2", observations: [{} as Json],
    questions: [planQuestion("q-1", "rules")] });
  thrown(() => provePlanQuestions(store, shallow.draft, shallow.planAnswer),
    "plan_questions_invalid", "provenance");
  // Драфт стадии concept — чужой для DR3a1 этап даже при согласованном принятии.
  const concept = writePlanAcceptance(store, { project: "m3", stage: "concept",
    questions: [planQuestion("q-1", "rules")] });
  thrown(() => proveAttempt(store, reference(writeAttempt(store, {
    project: "m3", draft: reference(concept.draft), planAnswer: concept.planAnswer,
    planQuestionId: "q-1",
    call: reference(writeCall(store, { projectId: "m3", draftId: concept.draft.id,
      questionId: "q-1", planAnswer: concept.planAnswer })),
    end: { type: "impossible", code: "source_unavailable", evidence: [], text: "x" } }))),
    "attempt_invalid", "discovery");
  thrown(() => provePlanQuestions(store, concept.draft, concept.planAnswer),
    "plan_questions_invalid", "discovery");
});

test("DR3a1-02a: вызов привязан к точной редакции плана — старая редакция и отсутствие привязки отказывают", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer, frameRef } = acceptPlan(store, engine, discovery, "m4",
    [planQuestion("q-shared", "rules", "blocking")]);
  const plan2 = acceptNextPlanEdition(store, engine, discovery, "m4", draft, frameRef, planAnswer,
    [planQuestion("q-shared", "rules", "blocking")]);
  const base = { project: "m4", draft: reference(store.get<DiscoveryDraft>(draft.id)!),
    planAnswer: plan2, planQuestionId: "q-shared" };
  // Вызов, записанный под первой редакцией, — не источник попытки второй.
  const oldCall = writeCall(store, { projectId: "m4", draftId: draft.id,
    questionId: "q-shared", planAnswer });
  thrown(() => proveAttempt(store, reference(writeAttempt(store, { ...base,
    call: reference(oldCall), end: { type: "impossible", code: "source_unavailable",
      evidence: [], text: "x" } }))), "attempt_invalid", "plan edition");
  // Вызов без привязки к редакции — не сохранённое основание.
  const unbound = store.write({ id: `model-call:m4:unbound:${rand()}`, kind: "model-call",
    expected: 0, value: { projectId: "m4", draftId: draft.id, questionId: "q-shared",
      purpose: "research", requestId: "r", startedAt: 1, finishedAt: 2, status: "succeeded" } });
  thrown(() => proveAttempt(store, reference(writeAttempt(store, { ...base,
    call: reference(unbound), end: { type: "impossible", code: "source_unavailable",
      evidence: [], text: "x" } }))), "attempt_invalid", "plan edition");
  // Вызов второй редакции — принимается.
  const newCall = writeCall(store, { projectId: "m4", draftId: draft.id,
    questionId: "q-shared", planAnswer: plan2 });
  const attempt = writeAttempt(store, { ...base, call: reference(newCall),
    end: { type: "impossible", code: "source_unavailable", evidence: [], text: "x" } });
  assert.equal(proveAttempt(store, reference(attempt)).planQuestion.planQuestionId, "q-shared");
});

test("DR3a1-02b: duplicate.of — чужая редакция и фиктивная запись отказывают", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer, frameRef } = acceptPlan(store, engine, discovery, "m5",
    [planQuestion("q-shared", "rules", "blocking")]);
  // Оригинал — законная submitted-попытка первой редакции.
  const call1 = writeCall(store, { projectId: "m5", draftId: draft.id,
    questionId: "q-shared", planAnswer });
  const original = writeAttempt(store, { project: "m5", draft: reference(draft),
    planAnswer, planQuestionId: "q-shared", call: reference(call1),
    end: submittedEnd([factClaim(store, "m5", "c-1", planAnswer, "q-shared")]) });
  const plan2 = acceptNextPlanEdition(store, engine, discovery, "m5", draft, frameRef, planAnswer,
    [planQuestion("q-shared", "rules", "blocking")]);
  const draftHead = reference(store.get<DiscoveryDraft>(draft.id)!);
  const call2 = writeCall(store, { projectId: "m5", draftId: draft.id,
    questionId: "q-shared", planAnswer: plan2 });
  // duplicate второй редакции на оригинал первой — чужая редакция отказывает.
  const dupForeign = writeAttempt(store, { project: "m5", draft: draftHead,
    planAnswer: plan2, planQuestionId: "q-shared", call: reference(call2),
    end: { type: "duplicate", of: reference(original) } });
  thrown(() => proveAttempt(store, reference(dupForeign)), "attempt_invalid", "edition");
  // Фиктивная запись того же kind без договора/ключа/связей — не оригинал.
  const fake = store.write({ id: `research-attempt:m5:fake:${rand()}`, kind: "research-attempt",
    expected: 0, value: { project: "m5", planQuestionId: "q-shared",
      end: { type: "submitted" } } });
  const dupFake = writeAttempt(store, { project: "m5", draft: draftHead,
    planAnswer: plan2, planQuestionId: "q-shared",
    call: reference(writeCall(store, { projectId: "m5", draftId: draft.id,
      questionId: "q-shared", planAnswer: plan2 })),
    end: { type: "duplicate", of: reference(fake) } });
  thrown(() => proveAttempt(store, reference(dupFake)), "attempt_invalid");
  // Законный duplicate второй редакции на submitted-оригинал второй — читается.
  const call2b = writeCall(store, { projectId: "m5", draftId: draft.id,
    questionId: "q-shared", planAnswer: plan2 });
  const original2 = writeAttempt(store, { project: "m5", draft: draftHead,
    planAnswer: plan2, planQuestionId: "q-shared", call: reference(call2b),
    end: submittedEnd([factClaim(store, "m5", "c-2", plan2, "q-shared")]) });
  const call2c = writeCall(store, { projectId: "m5", draftId: draft.id,
    questionId: "q-shared", planAnswer: plan2 });
  const dupOk = writeAttempt(store, { project: "m5", draft: draftHead,
    planAnswer: plan2, planQuestionId: "q-shared", call: reference(call2c),
    end: { type: "duplicate", of: reference(original2) } });
  assert.equal(proveAttempt(store, reference(dupOk)).claims, undefined);
});

test("DR3a1-02c: принадлежность проекту — по договору вида записи, без fallback", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "m6",
    [planQuestion("q-blk", "rules", "blocking")]);
  const call = writeCall(store, { projectId: "m6", draftId: draft.id,
    questionId: "q-blk", planAnswer });
  // Запись source с projectId чужого проекта и запасным project нужного — не свидетельство.
  const foreign = store.write({ id: `source:m6:foreign:${rand()}`, kind: "source", expected: 0,
    value: { projectId: "other", project: "m6", content: "x" } });
  const refused = writeAttempt(store, { project: "m6", draft: reference(draft),
    planAnswer, planQuestionId: "q-blk", call: reference(call),
    end: { type: "refused", code: "outside_plan_scope", evidence: [reference(foreign)],
      text: "x" } });
  thrown(() => proveAttempt(store, reference(refused)), "attempt_invalid", "evidence");
  // То же в основании claim — fact.source того же обмана.
  const call2 = writeCall(store, { projectId: "m6", draftId: draft.id,
    questionId: "q-blk", planAnswer });
  const attempt = writeAttempt(store, { project: "m6", draft: reference(draft),
    planAnswer, planQuestionId: "q-blk", call: reference(call2),
    end: submittedEnd([{ id: "c-1", kind: "fact", text: "x", axis: "market",
      planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
      scope: { variants: "common" },
      basis: { source: { ref: asJson(reference(foreign)), range: { start: 0, end: 3 },
        valueHash: hashJson("v") }, limit: "x", asOf: "2026-10" } } as Json]) });
  thrown(() => proveAttempt(store, reference(attempt)), "attempt_invalid");
});

test("DR3a1-04: длинный id план-вопроса — адрес попытки в пределах Store", t => {
  const { store, engine, discovery } = fixture(t);
  const longId = `q-${"x".repeat(156)}`; // 158 символов — законный непустой id
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "m7",
    [planQuestion(longId, "rules", "blocking")]);
  const call = writeCall(store, { projectId: "m7", draftId: draft.id,
    questionId: longId, planAnswer });
  const attempt = writeAttempt(store, { project: "m7", draft: reference(draft),
    planAnswer, planQuestionId: longId, call: reference(call),
    end: submittedEnd([factClaim(store, "m7", "c-1", planAnswer, longId)]) });
  assert.ok(attempt.id.length <= 200, `attempt id ${attempt.id.length} chars`);
  assert.equal(proveAttempt(store, reference(attempt)).planQuestion.planQuestionId, longId);
  // Другой ключ при том же длинном id вопроса — другой адрес.
  const call2 = writeCall(store, { projectId: "m7", draftId: draft.id,
    questionId: longId, planAnswer });
  assert.notEqual(v7AttemptId({ project: "m7", planAnswer, planQuestionId: longId,
    call: reference(call2) }), attempt.id);
});

test("DR3a1-local: range факта — закрытая форма start/end", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "m8",
    [planQuestion("q-blk", "rules", "blocking")]);
  const claim = factClaim(store, "m8", "c-1", planAnswer, "q-blk",
    { basis: { source: { ref: asJson(reference(writeProjectRecord(store, "m8"))),
        range: { start: 0, end: 3, extra: "outside" }, valueHash: hashJson("v") },
        limit: "x", asOf: "2026-10" } });
  const attempt = writeAttempt(store, { project: "m8", draft: reference(draft),
    planAnswer, planQuestionId: "q-blk",
    call: reference(writeCall(store, { projectId: "m8", draftId: draft.id,
      questionId: "q-blk", planAnswer })),
    end: submittedEnd([claim]) });
  thrown(() => proveAttempt(store, reference(attempt)), "attempt_invalid");
});

test("DR3a1-01b: откреплённый вопрос — согласованный акт, но вопрос не из draft.questions", t => {
  const { store } = fixture(t);
  const base = writePlanAcceptance(store, { project: "m9",
    questions: [planQuestion("q-1", "rules", "blocking")] });
  // Второе «принятие» на том же драфте: акт согласован во всём, кроме одного —
  // его вопрос никогда не выдавался этим драфтом (question_unbound).
  const detached = writePlanAcceptance(store, { project: "m9",
    questions: [planQuestion("q-2", "market")], onDraft: base.draft });
  const head = store.get<DiscoveryDraft>(detached.draft.id)!;
  thrown(() => provePlanQuestions(store, head, detached.planAnswer),
    "plan_questions_invalid", "never issued");
  // Законная первая редакция по-прежнему читается с той же головы драфта.
  const set = provePlanQuestions(store, head, base.planAnswer);
  assert.equal(set[0]!.planQuestionId, "q-1");
});

test("DR3a1-02d: owner-записи — проект по версии договора (v1 project, v2/v3 scope.project)", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "ma",
    [planQuestion("q-blk", "rules", "blocking")]);
  const callFor = () => reference(writeCall(store,
    { projectId: "ma", draftId: draft.id, questionId: "q-blk", planAnswer }));
  const grant = (contract: string, value: Record<string, Json>) => store.write({
    id: `owner-session-grant:ma:${rand()}`, kind: "owner-session-grant",
    expected: 0, value: { contract, ...value } });
  // Законный v1 grant — проект в value.project.
  const v1 = grant("owner-session-grant/v1", { id: "g1", database: "d",
    project: "ma", action: "a", method: "m", issuedAt: 1, expiresAt: 9, proof: "p" });
  // Законный v3 grant — проект в scope.project (форма project-mode приглашения).
  const v3 = grant("owner-session-grant/v3", { id: "g3", database: "d",
    action: "a", method: "m", issuedAt: 1, expiresAt: 9, proof: "p",
    scope: { project: "ma", mode: "questions", previous: null } });
  // Чужой v3 grant, замаскированный запасным полем project.
  const v3masked = grant("owner-session-grant/v3", { id: "g3b", database: "d",
    action: "a", method: "m", issuedAt: 1, expiresAt: 9, proof: "p",
    scope: { project: "other", mode: "questions", previous: null },
    project: "ma" });
  // Повреждённая owner-запись — неизвестная версия договора; fallback к
  // запасным полям закрыт, принадлежность не доказана.
  const damaged = grant("owner-session-grant/v9", { id: "g4", database: "d",
    project: "ma", scope: { project: "ma" } });
  const attemptWith = (authRef: Ref) => proveAttempt(store, reference(
    writeAttempt(store, { project: "ma", draft: reference(draft), planAnswer,
      planQuestionId: "q-blk", call: callFor(),
      end: submittedEnd([{ id: `c-${rand()}`, kind: "owner-decision", text: "d",
        axis: "rules",
        planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId: "q-blk" }],
        scope: { variants: "common" },
        basis: { authority: asJson(authRef) } } as Json]) })));
  assert.equal(attemptWith(reference(v1)).claims!.length, 1);
  assert.equal(attemptWith(reference(v3)).claims!.length, 1);
  thrown(() => attemptWith(reference(v3masked)), "attempt_invalid");
  thrown(() => attemptWith(reference(damaged)), "attempt_invalid");
});
