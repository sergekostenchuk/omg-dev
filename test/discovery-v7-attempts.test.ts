import test from "node:test";
import assert from "node:assert/strict";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, DISCOVERY_CLAIMS_CONTRACT } from "../src/discovery/v7-contracts.js";
import { proveAttempt, v7AttemptId, type V7AttemptEnd } from "../src/discovery/v7-plan-questions.js";
import { recordV7Attempt, type V7AttemptRequest } from "../src/discovery/v7-attempts.js";
import { resolveClaimAddress, proveClaimAddress } from "../src/discovery/claim-address.js";
import { EngineError } from "../src/errors.js";
import { hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, rand, validFrame, planQuestion, validPlan, questionOf, type PlanQuestion } from "./discovery-v7-fixture.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr3a2-");

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
 * discovery-acceptance-act пишет производитель, не модель. */
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

/** Запись model-call обычного пути — форма, которую диспетчеризация
 * исследования сохраняет до двери попытки (DR3a3 подключит её к раннеру). */
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

function writeProjectRecord(store: Store, project: string, kind = "source"): Revision<Record<string, Json>> {
  return store.write({ id: `${kind}:${project}:${rand()}`, kind, expected: 0,
    value: { projectId: project, content: "basis" } });
}

const submittedEnd = (claims: Json[]): V7AttemptEnd =>
  ({ type: "submitted", contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } });

/** Валидный fact-claim договора discovery-claims/v7. */
function factClaim(store: Store, project: string, id: string, planAnswer: Ref,
  planQuestionId: string): Json {
  const src = writeProjectRecord(store, project);
  return { id, kind: "fact", text: `Claim ${id}`, axis: "market",
    planQuestions: [{ planAnswer: asJson(planAnswer), planQuestionId }],
    scope: { variants: "common" },
    basis: { source: { ref: asJson(reference(src)), range: { start: 0, end: 3 },
      valueHash: hashJson("v") }, limit: "snapshot", asOf: "2026-10" } } as unknown as Json;
}

/** Дверной запрос с валидным ключом: вызов, привязанный к проекту, драфту,
 * план-вопросу и точной редакции плана. */
function doorRequest(store: Store, draft: Revision<DiscoveryDraft>, planAnswer: Ref,
  planQuestionId: string, end: V7AttemptEnd): V7AttemptRequest {
  const call = writeCall(store, { projectId: draft.value.projectId, draftId: draft.id,
    questionId: planQuestionId, planAnswer });
  return { project: draft.value.projectId, planAnswer, planQuestionId,
    call: reference(call), end };
}

/** Store, у которого перед каждой дверной пачкой вспрыгивает гонка: метод
 * writeMany сначала выполняет inject() (через ДРУГОЙ Store того же файла),
 * затем делегирует — окно «доказательство→запись» проигрывается честно. */
function racyStore(store: Store, inject: () => void): Store {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "writeMany")
        return (...args: unknown[]) => { inject(); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
}

test("DR3a2: дверь пишет submitted — читатель доказывает, resolve работает, prove → claim_attempt_not_accepted", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p1",
    [planQuestion("q-blk", "rules", "blocking"), planQuestion("q-sup", "market")]);
  const draftHead = store.get<DiscoveryDraft>(draft.id)!.revision;
  const questionHead = store.get<Question>(questionOf(store, draft, "plan").id)!.revision;
  const request = doorRequest(store, draft, planAnswer, "q-blk",
    submittedEnd([factClaim(store, "p1", "c-1", planAnswer, "q-blk")]));
  const outcome = recordV7Attempt(store, request);
  assert.equal(outcome.repeated, false);
  assert.equal(outcome.attempt.revision, 1);
  assert.equal(outcome.attempt.id, v7AttemptId({ project: "p1", planAnswer,
    planQuestionId: "q-blk", call: request.call }));
  // Читатель DR3a1 принимает запись двери — ровно та форма.
  const proven = proveAttempt(store, reference(outcome.attempt));
  assert.equal(proven.planQuestion.planQuestionId, "q-blk");
  assert.equal(proven.claims!.length, 1);
  // Структурный маршрут claims разрешается, принятие — нет (DR3b).
  const address = { project: "p1", container: reference(outcome.attempt),
    containerKind: "research-attempt", pointer: "/claims/0", claimId: "c-1" };
  const resolved = resolveClaimAddress(store, address);
  assert.equal((resolved.claim as Record<string, Json>)["text"], "Claim c-1");
  thrown(() => proveClaimAddress(store, address), "claim_attempt_not_accepted");
  // Дверь не трогает draft.fields, Question и #answer: головы не сдвинулись.
  assert.equal(store.get<DiscoveryDraft>(draft.id)!.revision, draftHead);
  assert.equal(store.get<Question>(questionOf(store, draft, "plan").id)!.revision, questionHead);
  // Запись двери чиста в fsck — все её ссылки существуют.
  const report = checkStoreIntegrity(store);
  assert.equal(report.findings.filter(f => f.id === outcome.attempt.id).length, 0,
    JSON.stringify(report.findings, null, 2));
});

test("DR3a2: два результата одного план-вопроса — две попытки от разных вызовов", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p2",
    [planQuestion("q-1", "market")]);
  const first = recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    submittedEnd([factClaim(store, "p2", "c-a", planAnswer, "q-1")])));
  const second = recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    submittedEnd([factClaim(store, "p2", "c-b", planAnswer, "q-1")])));
  assert.notEqual(first.attempt.id, second.attempt.id);
  assert.equal(proveAttempt(store, reference(first.attempt)).claims!.length, 1);
  assert.equal(proveAttempt(store, reference(second.attempt)).claims!.length, 1);
});

test("DR3a2: повтор того же ключа и тела — прежняя exact запись без записи, тёплый и холодный", t => {
  const { store, engine, discovery, path } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p3",
    [planQuestion("q-1", "market")]);
  const request = doorRequest(store, draft, planAnswer, "q-1",
    submittedEnd([factClaim(store, "p3", "c-1", planAnswer, "q-1")]));
  const first = recordV7Attempt(store, request);
  const again = recordV7Attempt(store, request);
  assert.equal(again.repeated, true);
  assert.deepEqual(reference(again.attempt), reference(first.attempt));
  assert.equal(store.history(first.attempt.id).length, 1);
  // Холодный повтор: новый Store того же файла — та же запись, без записи.
  const cold = new Store(path);
  try {
    const coldAgain = recordV7Attempt(cold, request);
    assert.equal(coldAgain.repeated, true);
    assert.deepEqual(reference(coldAgain.attempt), reference(first.attempt));
    assert.equal(cold.history(first.attempt.id).length, 1);
  } finally { cold.close(); }
});

test("DR3a2: тот же ключ с другим телом — attempt_conflict, ничего не записано", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p4",
    [planQuestion("q-1", "market")]);
  const request = doorRequest(store, draft, planAnswer, "q-1",
    submittedEnd([factClaim(store, "p4", "c-1", planAnswer, "q-1")]));
  const first = recordV7Attempt(store, request);
  thrown(() => recordV7Attempt(store, { ...request,
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "no data" } }),
    "attempt_conflict");
  assert.equal(store.history(first.attempt.id).length, 1);
});

test("DR3a2: новая попытка — только на текущей редакции; холодный повтор после смены плана — прежняя запись", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer, frameRef } = acceptPlan(store, engine, discovery, "p5",
    [planQuestion("q-1", "market"), planQuestion("q-2", "money")]);
  const request = doorRequest(store, draft, planAnswer, "q-1",
    submittedEnd([factClaim(store, "p5", "c-1", planAnswer, "q-1")]));
  const first = recordV7Attempt(store, request);
  // План сдвинулся: принята вторая редакция — старый ключ это всё ещё его запись.
  const planAnswer2 = acceptNextPlanEdition(store, engine, discovery, "p5", draft, frameRef,
    planAnswer, [planQuestion("q-1", "market"), planQuestion("q-3", "money")]);
  const cold = recordV7Attempt(store, request);
  assert.equal(cold.repeated, true);
  assert.deepEqual(reference(cold.attempt), reference(first.attempt));
  assert.equal(store.history(first.attempt.id).length, 1);
  // Новая попытка на старой редакции — отказ: guard текущего плана только для новой.
  const staleCall = writeCall(store, { projectId: "p5", draftId: draft.id,
    questionId: "q-1", planAnswer });
  thrown(() => recordV7Attempt(store, { project: "p5", planAnswer, planQuestionId: "q-1",
    call: reference(staleCall),
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "x" } }),
    "attempt_invalid", "current accepted plan");
  // Историческая запись и её claims читаются после смены плана.
  const proven = proveAttempt(store, reference(first.attempt));
  assert.equal(proven.claims!.length, 1);
  const resolved = resolveClaimAddress(store, { project: "p5", container: reference(first.attempt),
    containerKind: "research-attempt", pointer: "/claims/0", claimId: "c-1" });
  assert.equal((resolved.claim as Record<string, Json>)["id"], "c-1");
  // Новая попытка на текущей редакции — законна.
  const fresh = recordV7Attempt(store, doorRequest(store, store.get<DiscoveryDraft>(draft.id)!,
    planAnswer2, "q-3", submittedEnd([factClaim(store, "p5", "c-3", planAnswer2, "q-3")])));
  assert.equal(fresh.repeated, false);
  assert.equal(proveAttempt(store, reference(fresh.attempt)).planQuestion.planQuestionId, "q-3");
});

test("DR3a2: отсутствие и подмена акта плана — новая попытка отказана без fallback", t => {
  const { store, engine, discovery } = fixture(t);
  // План не отвечен вовсе — нет доказанного текущего плана.
  const empty = createPartialV7Draft(discovery, "p6a", "concept");
  const callA = writeCall(store, { projectId: "p6a", draftId: empty.id,
    questionId: "q-1", planAnswer: { id: "research-answer:p6a:none", revision: 1, hash: "0".repeat(64) } });
  thrown(() => recordV7Attempt(store, { project: "p6a",
    planAnswer: { id: "research-answer:p6a:none", revision: 1, hash: "0".repeat(64) },
    planQuestionId: "q-1", call: reference(callA),
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "x" } }),
    "plan_questions_invalid");
  // Подмена: голова вопроса отвечена forged-ответом без акта принятия.
  const { draft } = acceptPlan(store, engine, discovery, "p6b", [planQuestion("q-1", "market")]);
  const planQ = questionOf(store, draft, "plan");
  const head = store.get<Question>(planQ.id)!;
  const forged = store.write({ id: `research-answer:p6b:forge-${rand()}`, kind: "research-answer",
    expected: 0, value: { projectId: "p6b", question: planQ.id,
      assessment: { id: "research-assessment:none", revision: 1, hash: "0".repeat(64) },
      value: validPlan(store.get<Question>(questionOf(store, draft, "frame").id)!.value.answer!,
        [planQuestion("q-x", "market")]) } });
  store.write({ id: planQ.id, kind: "question", expected: head.revision,
    value: { ...head.value, answer: asJson(reference(forged)) } });
  const callB = writeCall(store, { projectId: "p6b", draftId: draft.id, questionId: "q-x",
    planAnswer: reference(forged) });
  thrown(() => recordV7Attempt(store, { project: "p6b", planAnswer: reference(forged),
    planQuestionId: "q-x", call: reference(callB),
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "x" } }),
    "plan_questions_invalid");
});

test("DR3a2: чужой план-вопрос, чужой проект и чужой вызов — отказ до записи", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p7",
    [planQuestion("q-1", "market")]);
  const goodCall = writeCall(store, { projectId: "p7", draftId: draft.id,
    questionId: "q-1", planAnswer });
  // План-вопрос не из принятого плана.
  thrown(() => recordV7Attempt(store, { project: "p7", planAnswer, planQuestionId: "q-foreign",
    call: reference(goodCall),
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "x" } }),
    "attempt_invalid", "planQuestionId");
  // Проект без v7-драфта — доказанного текущего плана нет.
  thrown(() => recordV7Attempt(store, { project: "p-void", planAnswer, planQuestionId: "q-1",
    call: reference(goodCall),
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "x" } }),
    "plan_questions_invalid");
  // Вызов другого план-вопроса (его questionId не совпадает).
  const otherCall = writeCall(store, { projectId: "p7", draftId: draft.id,
    questionId: "q-other", planAnswer });
  thrown(() => recordV7Attempt(store, { project: "p7", planAnswer, planQuestionId: "q-1",
    call: reference(otherCall),
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "x" } }),
    "attempt_invalid", "call");
  // Вызов чужого проекта.
  const foreign = acceptPlan(store, engine, discovery, "p7f", [planQuestion("q-1", "market")]);
  const foreignCall = writeCall(store, { projectId: "p7f", draftId: foreign.draft.id,
    questionId: "q-1", planAnswer: foreign.planAnswer });
  thrown(() => recordV7Attempt(store, { project: "p7", planAnswer, planQuestionId: "q-1",
    call: reference(foreignCall),
    end: { type: "refused", code: "source_unavailable", evidence: [], text: "x" } }),
    "attempt_invalid", "call");
});

test("DR3a2: четыре конца настоящей дверью — refused, impossible, duplicate, проверки концов", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer, frameRef } = acceptPlan(store, engine, discovery, "p8",
    [planQuestion("q-1", "market"), planQuestion("q-2", "money")]);
  // refused с project-owned evidence.
  const evidence = writeProjectRecord(store, "p8", "report");
  const refused = recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    { type: "refused", code: "source_unavailable", evidence: [reference(evidence)], text: "source gone" }));
  assert.equal(proveAttempt(store, reference(refused.attempt)).claims, undefined);
  // impossible.
  const impossible = recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-2",
    { type: "impossible", code: "outside_plan_scope", evidence: [], text: "no basis exists" }));
  assert.equal(proveAttempt(store, reference(impossible.attempt)).claims, undefined);
  // Незаконные концы отказаны до записи.
  thrown(() => recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    { type: "refused", code: "made_up_code", evidence: [], text: "x" } as V7AttemptEnd)),
    "attempt_invalid", "end.code");
  const foreignEvidence = writeProjectRecord(store, "p-other", "report");
  thrown(() => recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    { type: "refused", code: "source_unavailable", evidence: [reference(foreignEvidence)], text: "x" })),
    "attempt_invalid", "end.evidence");
  // duplicate: оригинал submitted того же план-вопроса и проекта.
  const original = recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    submittedEnd([factClaim(store, "p8", "c-1", planAnswer, "q-1")])));
  const duplicate = recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    { type: "duplicate", of: reference(original.attempt) }));
  assert.equal(proveAttempt(store, reference(duplicate.attempt)).claims, undefined);
  // Self-link отказан: адрес будущей записи не может быть её оригиналом.
  const selfCall = writeCall(store, { projectId: "p8", draftId: draft.id,
    questionId: "q-1", planAnswer });
  const selfId = v7AttemptId({ project: "p8", planAnswer, planQuestionId: "q-1",
    call: reference(selfCall) });
  thrown(() => recordV7Attempt(store, { project: "p8", planAnswer, planQuestionId: "q-1",
    call: reference(selfCall),
    end: { type: "duplicate", of: { id: selfId, revision: 1, hash: "0".repeat(64) } } }),
    "attempt_invalid", "itself");
  // Оригинал чужой редакции плана — отказ.
  const planB = acceptNextPlanEdition(store, engine, discovery, "p8", draft, frameRef,
    planAnswer, [planQuestion("q-1", "market"), planQuestion("q-9", "money")]);
  thrown(() => recordV7Attempt(store, doorRequest(store, store.get<DiscoveryDraft>(draft.id)!,
    planB, "q-1", { type: "duplicate", of: reference(original.attempt) })),
    "attempt_invalid", "end.of");
});

test("DR3a2: атомарность — план сдвинулся между доказательством и записью: конфликт, ничего не сохранено", t => {
  const { store, engine, discovery, path } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p9",
    [planQuestion("q-1", "market")]);
  const request = doorRequest(store, draft, planAnswer, "q-1",
    { type: "refused", code: "source_unavailable", evidence: [], text: "gone" });
  const attemptId = v7AttemptId(request);
  // Гонка: между доказательством текущего плана и пачкой вопрос plan переоткрыт.
  const second = new Store(path);
  try {
    const planQ = questionOf(store, draft, "plan");
    const racy = racyStore(store, () => {
      const q = second.get<Question>(planQ.id)!;
      second.write({ id: q.id, kind: "question", expected: q.revision,
        value: { ...q.value, status: "open", answer: null } });
    });
    thrown(() => recordV7Attempt(racy, request), "input_stale");
  } finally { second.close(); }
  // Пачка откатилась целиком: записи попытки нет, побочных записей нет.
  assert.equal(store.get(attemptId), null);
});

test("DR3a2: гонки двух Store — одинаковый повтор делит запись, разные концы дают attempt_conflict", t => {
  const { store, engine, discovery, path } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p10",
    [planQuestion("q-1", "market")]);
  const end = submittedEnd([factClaim(store, "p10", "c-1", planAnswer, "q-1")]);
  const request = doorRequest(store, draft, planAnswer, "q-1", end);
  const ahead = new Store(path);
  try {
    // Сторона B читает «записи нет», затем сторона A пишет ту же попытку
    // настоящей дверью, затем пачка B идёт в Store — revision_conflict → повтор.
    const racy = racyStore(store, () => {
      recordV7Attempt(ahead, request);
    });
    const outcome = recordV7Attempt(racy, request);
    assert.equal(outcome.repeated, true);
    assert.equal(store.history(outcome.attempt.id).length, 1);
    // Разные концы одного ключа: одна запись, вторая сторона — attempt_conflict.
    const other = doorRequest(store, draft, planAnswer, "q-1",
      { type: "refused", code: "source_unavailable", evidence: [], text: "x" });
    const racyB = racyStore(store, () => {
      recordV7Attempt(ahead, { ...other,
        end: submittedEnd([factClaim(store, "p10", "c-9", planAnswer, "q-1")]) });
    });
    thrown(() => recordV7Attempt(racyB, other), "attempt_conflict");
    assert.equal(store.history(v7AttemptId(other)).length, 1);
  } finally { ahead.close(); }
});

test("DR3a2: повреждённая запись на адресе ключа — отказ читателя, без fallback", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p11",
    [planQuestion("q-1", "market")]);
  const request = doorRequest(store, draft, planAnswer, "q-1",
    { type: "refused", code: "source_unavailable", evidence: [], text: "x" });
  // Запись на детерминированном адресе: ключ и конец совпадают с запросом,
  // но draft указывает на чужой драфт — повтор проходит сравнение тела и
  // отказан прувером, не «исправлен» перезаписью.
  const foreign = acceptPlan(store, engine, discovery, "p11f", [planQuestion("q-f", "market")]);
  const id = v7AttemptId(request);
  const end = request.end;
  store.write({ id, kind: "research-attempt", expected: 0,
    value: { contract: "v7-attempt/v1", project: request.project, planAnswer: request.planAnswer,
      planQuestionId: request.planQuestionId, call: request.call,
      draft: reference(foreign.draft), end: asJson(end) } });
  thrown(() => recordV7Attempt(store, request), "attempt_invalid");
});

test("DR3a2: оценка и принятие попытки — не путь двери: prove по маршруту попытки всегда отказан", t => {
  const { store, engine, discovery } = fixture(t);
  const { draft, planAnswer } = acceptPlan(store, engine, discovery, "p12",
    [planQuestion("q-1", "market")]);
  const outcome = recordV7Attempt(store, doorRequest(store, draft, planAnswer, "q-1",
    submittedEnd([factClaim(store, "p12", "c-1", planAnswer, "q-1")])));
  // Полевой маршрут DR2 не принимает контейнер попытки, маршрут попытки не
  // принимает полевой контейнер — повреждение формы без fallback.
  const asAnswer = { project: "p12", container: reference(outcome.attempt),
    containerKind: "research-answer", pointer: "/claims/0", claimId: "c-1" };
  thrown(() => resolveClaimAddress(store, asAnswer), "claim_address_invalid");
  // Попытка, записанная дверью, неизменяема: вторая ревизия того же id —
  // revision_conflict Store, не перезапись.
  thrown(() => store.write({ id: outcome.attempt.id, kind: "research-attempt",
    expected: 0, value: outcome.attempt.value }), "revision_conflict");
});
