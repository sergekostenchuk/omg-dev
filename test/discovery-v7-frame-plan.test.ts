import { fixturePlanCoverage } from "./discovery-v7-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_AXES, V7_REQUIREMENTS, V7_STAGE_TOKEN_CEILING,
  DISCOVERY_ACCEPTANCE_ACT_KIND, DISCOVERY_ACCEPTANCE_ACT_CONTRACT,
  discoveryAcceptanceActId, type DiscoveryAcceptanceAct } from "../src/discovery/v7-contracts.js";
import { NEXT_CONTRACT_ERA, producerRequirements, REQUIREMENTS, RESEARCH_CONTRACT_VERSION } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson, type Json } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store, type Revision } from "../src/storage/store.js";
import type { ResearchAnswer, ResearchAssessment } from "../src/discovery/research-model.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { storeView } from "../src/storage/store-view.js";
import { managedAnswerId, acceptanceBindingId, managedTurnId } from "../src/discovery/research-consumer-transition.js";
import { savedAcceptanceAct } from "../src/discovery/projection-reader.js";
import { discoveryFixture, questionOf } from "./discovery-v7-fixture.js";

const fixture = (t: { after(fn: () => void): void }) => discoveryFixture(t, "omg-dr2-v7-");

function source(discovery: Discovery, project: string) {
  return discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
}

const thrown = (fn: () => unknown, code: string, includes?: string) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    assert.equal((error as EngineError).code, code, (error as EngineError).message);
    if (includes) assert.ok((error as EngineError).message.includes(includes), (error as EngineError).message);
    return error as EngineError;
  }
  assert.fail(`expected ${code}`);
};

const allAxes = (depth: string, reason?: string) => Object.fromEntries(
  V7_AXES.map(axis => [axis, reason === undefined ? { depth } : { depth, reason }]));

function validFrame(overrides: Record<string, Json> = {}): Json {
  return { productType: "internal", scale: "30 users across 10 sites",
    industries: ["construction"], domains: ["materials supply", "equipment accounting"],
    axes: allAxes("deep"),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 },
    ...overrides };
}

type PlanQuestion = { id: string; axis: string; domain: string; text: string; class: string;
  criterion: string; requiredDepth: string; roles: string[]; searchPlaces: string[];
  classRevision?: { from: string; basis: string } };

function planQuestion(id: string, axis: string, cls = "supporting"): PlanQuestion {
  return { id, axis, domain: "construction", text: `What covers ${id}?`,
    class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
    roles: ["domain expert"], searchPlaces: ["domain documents"] };
}

function validPlan(frameRef: Ref, questions: PlanQuestion[], edition = 1, previous: Ref | null = null): Json {
  // These acceptance/edition tests retain their full twelve-axis frame.
  const complete = [...questions, ...V7_AXES.filter(axis => !questions.some(q => q.axis === axis))
    .map(axis => planQuestion(`coverage-${axis}`, axis, ['rules', 'feasibility'].includes(axis) ? 'blocking' : 'supporting'))];
  return { edition, frame: frameRef, previous, questions: complete, coverage: fixturePlanCoverage(complete) } as unknown as Json;
}

test("DR2: фабрика создаёт частичный черновик v7 с полями D1–D2", t => {
  const { store, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p1", "concept");
  assert.equal(draft.value.contractVersion, NEXT_CONTRACT_ERA);
  assert.equal(draft.value.stage, "discovery");
  assert.deepEqual(Object.keys(draft.value.fields).sort(), ["brief", "frame", "objective", "plan"]);
  assert.equal(draft.value.questions.length, 4);
  const specs = draft.value.questions.map(id => store.get<Question>(id)!.value.spec);
  assert.equal(canonical(specs), canonical([...V7_REQUIREMENTS.fields.discovery!]));
  assert.equal(V7_REQUIREMENTS.complete["discovery"], false);
});

test("DR2: политика {discovery:7} при частичной таблице — not_ready; выключенный путь — v6", t => {
  const { discovery } = fixture(t);
  const policy = { discovery: NEXT_CONTRACT_ERA };
  thrown(() => producerRequirements("discovery", policy), "discovery_v7_producer_not_ready");
  thrown(() => discovery.forStage("on", "discovery", "concept", [], policy), "discovery_v7_producer_not_ready");
  const v6 = discovery.forStage("off", "discovery", "concept");
  assert.equal(v6.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  // Соседняя стадия не читает политику discovery — как прежде.
  assert.equal(discovery.forStage("off", "concept", "operation-map", [], policy).value.contractVersion,
    RESEARCH_CONTRACT_VERSION);
  assert.equal(producerRequirements("discovery"), REQUIREMENTS.discovery);
});

test("DR2: форма v7 с оценкой — decision для frame/plan отказан заранее", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p-form", "concept");
  const frame = questionOf(store, draft, "frame"), plan = questionOf(store, draft, "plan");
  for (const q of [frame, plan])
    thrown(() => engine.discovery.decision(q.id, q.revision, "owner", validFrame()),
      "research_assessment_required");
  // Вопросы остаются открытыми — законный путь принятия только researched.
  for (const q of [frame, plan])
    assert.equal(store.get<Question>(q.id)!.value.status, "open");
});

test("DR2: рамка принимается через настоящий приём — поле frame заполнено", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p2", "concept");
  const source_ = source(discovery, "p2");
  const frame = questionOf(store, draft, "frame");
  const after = answerDiscoveryFixture(engine, "p2", draft, frame, validFrame(), source_);
  const saved = store.get<Question>(frame.id)!;
  assert.equal(saved.value.status, "answered");
  assert.equal(store.get(after.id)!.kind, "discovery-draft");
  assert.equal(canonical(store.get<DiscoveryDraft>(draft.id)!.value.fields["frame"]), canonical(validFrame()));
  assert.equal(store.get(saved.value.answer!.id)!.kind, "research-answer");
});

test("DR2: правила рамки — отказы с кодом через настоящий приём", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p3", "concept");
  const source_ = source(discovery, "p3");
  const frame = questionOf(store, draft, "frame");
  const attempt = (value: Json) => answerDiscoveryFixture(engine, "p3", draft, frame, value, source_);

  // Нет оси — отказ схемы.
  const axesNoRisks = allAxes("deep") as Record<string, Json>;
  delete axesNoRisks["risks"];
  thrown(() => attempt(validFrame({ axes: axesNoRisks as Json })), "answer_invalid");
  // Неприменимо без причины — отказ.
  const inapplicable = allAxes("deep");
  inapplicable["language"] = { depth: "inapplicable" };
  thrown(() => attempt(validFrame({ axes: inapplicable as Json })), "answer_invalid", "reason");
  // Потолок бюджета — исходный предел стадии.
  thrown(() => attempt(validFrame({ budget: { ceiling: 19_999_999, axisHints: {}, completionReserve: 0 } })),
    "answer_invalid");
  // Подсказки — только по 12 осям.
  thrown(() => attempt(validFrame({
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { other: 1 } as Json, completionReserve: 0 } })),
    "answer_invalid");
  // Отрицательный резерв — отказ.
  thrown(() => attempt(validFrame({
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: {}, completionReserve: -1 } })), "answer_invalid");
  // Не объект вообще — отказ схемы.
  thrown(() => attempt("a frame"), "answer_invalid");
  // Неприменимо С причиной — принимается.
  const legal = allAxes("deep");
  legal["language"] = { depth: "inapplicable", reason: "The brief is a single-language internal tool" };
  attempt(validFrame({ axes: legal as Json }));
  assert.equal(store.get<Question>(frame.id)!.value.status, "answered");
  assert.ok(store.get<DiscoveryDraft>(draft.id)!.value.fields["frame"] !== null);
});

test("DR2: план без принятой рамки — адресный отказ", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p4", "concept");
  const source_ = source(discovery, "p4");
  const plan = questionOf(store, draft, "plan");
  const fakeRef: Ref = { id: "research-answer:p4:none", revision: 1, hash: "0".repeat(64) };
  // Рамка ещё не принята — поле frame пусто.
  thrown(() => answerDiscoveryFixture(engine, "p4", draft, plan,
    validPlan(fakeRef, [planQuestion("q1", "market")]), source_), "answer_invalid", "frame");
});

test("DR2: правила плана — каждое правило, отказ с кодом", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p5", "concept");
  const source_ = source(discovery, "p5");
  const frame = questionOf(store, draft, "frame");
  answerDiscoveryFixture(engine, "p5", draft, frame, validFrame(), source_);
  const frameRef = store.get<Question>(frame.id)!.value.answer!;
  const plan = questionOf(store, draft, "plan");
  const attempt = (value: Json) => answerDiscoveryFixture(engine, "p5", draft, plan, value, source_);

  // Дубль id внутри плана.
  thrown(() => attempt(validPlan(frameRef, [planQuestion("q1", "market"), planQuestion("q1", "people")])),
    "answer_invalid", "duplicated");
  // Вопрос без класса / критерия / глубины — схема.
  const noClass = planQuestion("q2", "market") as unknown as Record<string, Json>;
  delete noClass["class"];
  thrown(() => attempt(validPlan(frameRef, [noClass] as unknown as PlanQuestion[])), "answer_invalid");
  const noCriterion = planQuestion("q3", "market") as unknown as Record<string, Json>;
  delete noCriterion["criterion"];
  thrown(() => attempt(validPlan(frameRef, [noCriterion] as unknown as PlanQuestion[])), "answer_invalid");
  const noDepth = planQuestion("q4", "market") as unknown as Record<string, Json>;
  delete noDepth["requiredDepth"];
  thrown(() => attempt(validPlan(frameRef, [noDepth] as unknown as PlanQuestion[])), "answer_invalid");
  // Ось вне двенадцати — схема.
  thrown(() => attempt(validPlan(frameRef, [planQuestion("q5", "twilight")])), "answer_invalid");
  // Новый вопрос по rules/feasibility не blocking — отказ.
  thrown(() => attempt(validPlan(frameRef, [planQuestion("q6", "rules", "supporting")])),
    "answer_invalid", "blocking");
  thrown(() => attempt(validPlan(frameRef, [planQuestion("q7", "feasibility", "supporting")])),
    "answer_invalid", "blocking");
  // previous на первой редакции — только null.
  thrown(() => attempt(validPlan(frameRef, [planQuestion("q8", "market")], 1, frameRef)),
    "answer_invalid", "previous");
  // edition первой редакции — ровно 1.
  thrown(() => attempt(validPlan(frameRef, [planQuestion("q9", "market")], 2, null)),
    "answer_invalid", "edition");
  // frame — чужой Ref: несуществующая запись.
  thrown(() => attempt(validPlan({ id: "research-answer:p5:none", revision: 1, hash: "0".repeat(64) },
    [planQuestion("qa", "market")])), "research_acceptance_binding_invalid");
  // frame — Ref не на принятый ответ рамки (на сам вопрос).
  thrown(() => attempt(validPlan(reference(store.get<Question>(frame.id)!), [planQuestion("qb", "market")])),
    "research_acceptance_binding_invalid");
  // Корректный план — принят.
  attempt(validPlan(frameRef, [planQuestion("qc", "rules", "blocking"), planQuestion("qd", "market")]));
  assert.equal(store.get<Question>(plan.id)!.value.status, "answered");
});

test("DR2: основания плана — точная принадлежность, не равный JSON", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p7", "concept");
  const source_ = source(discovery, "p7");
  const frame = questionOf(store, draft, "frame");
  answerDiscoveryFixture(engine, "p7", draft, frame, validFrame(), source_);
  const frameRef = store.get<Question>(frame.id)!.value.answer!;
  const plan = questionOf(store, draft, "plan");
  const attempt = (value: Json) => answerDiscoveryFixture(engine, "p7", draft, plan, value, source_);

  // Проба ревьюера: искусственный research-answer своего проекта с тем же JSON
  // рамки, отсутствующей оценкой и отсутствующим вопросом.
  const fake = store.write<ResearchAnswer>({ id: "research-answer:p7:fake-frame", kind: "research-answer",
    expected: 0, value: { projectId: "p7", question: "question:p7:ghost",
      assessment: { id: "research-assessment:p7:none", revision: 1, hash: "0".repeat(64) },
      value: validFrame() } });
  thrown(() => attempt(validPlan(reference(fake), [planQuestion("qf", "market")])),
    "answer_invalid", "frame");

  // Проба ревьюера: действительно принятая рамка ДРУГОГО draft того же проекта.
  const otherDraft = createPartialV7Draft(discovery, "p7", "concept");
  const otherFrame = questionOf(store, otherDraft, "frame");
  answerDiscoveryFixture(engine, "p7", otherDraft, otherFrame, validFrame(), source_);
  const otherFrameRef = store.get<Question>(otherFrame.id)!.value.answer!;
  thrown(() => attempt(validPlan(otherFrameRef, [planQuestion("qg", "market")])),
    "answer_invalid", "frame");

  // Первая редакция плана принята.
  attempt(validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), planQuestion("q-market", "market")]));
  const firstPlanRef = store.get<Question>(plan.id)!.value.answer!;
  const reopened = engine.discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);

  // Проба ревьюера: previous на искусственный ответ с тем же JSON первой редакции.
  const priorValue = store.get<DiscoveryDraft>(draft.id)!.value.fields["plan"]!;
  const fakePrior = store.write<ResearchAnswer>({ id: "research-answer:p7:fake-plan", kind: "research-answer",
    expected: 0, value: { projectId: "p7", question: "question:p7:ghost2",
      assessment: { id: "research-assessment:p7:none2", revision: 1, hash: "0".repeat(64) },
      value: priorValue } });
  thrown(() => answerDiscoveryFixture(engine, "p7", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), planQuestion("q-market", "market")],
      2, reference(fakePrior)), source_), "answer_invalid", "previous");
  // Законная вторая редакция по точной принятой первой — принимается.
  answerDiscoveryFixture(engine, "p7", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), planQuestion("q-market", "market")],
      2, firstPlanRef), source_);
  assert.equal(store.get<Question>(plan.id)!.value.status, "answered");
});

test("DR2: устойчивость id в обе стороны — переименование и смена предмета отказывают", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p8", "concept");
  const source_ = source(discovery, "p8");
  const frame = questionOf(store, draft, "frame");
  answerDiscoveryFixture(engine, "p8", draft, frame, validFrame(), source_);
  const frameRef = store.get<Question>(frame.id)!.value.answer!;
  const plan = questionOf(store, draft, "plan");
  answerDiscoveryFixture(engine, "p8", draft, plan,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), planQuestion("q-market", "market")]), source_);
  const firstPlanRef = store.get<Question>(plan.id)!.value.answer!;

  // Проба ревьюера: полностью неизменный вопрос получает новый id — отказ.
  const reopened = engine.discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);
  const renamed: PlanQuestion = { ...planQuestion("q-market-renamed", "market"),
    text: planQuestion("q-market", "market").text, criterion: planQuestion("q-market", "market").criterion };
  thrown(() => answerDiscoveryFixture(engine, "p8", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), renamed], 2, firstPlanRef), source_),
    "answer_invalid", "q-market");

  // Проба ревьюера: supporting-вопрос market переносится в rules под прежним id без основания.
  const moved = { ...planQuestion("q-market", "market"), axis: "rules" };
  thrown(() => answerDiscoveryFixture(engine, "p8", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), moved], 2, firstPlanRef), source_),
    "answer_invalid", "axis");

  // Смена домена / критерия под прежним id — тоже другой вопрос.
  const newDomain = { ...planQuestion("q-market", "market"), domain: "retail" };
  thrown(() => answerDiscoveryFixture(engine, "p8", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), newDomain], 2, firstPlanRef), source_),
    "answer_invalid", "domain");
  const newCriterion = { ...planQuestion("q-market", "market"), criterion: "Another acceptance criterion" };
  thrown(() => answerDiscoveryFixture(engine, "p8", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), newCriterion], 2, firstPlanRef), source_),
    "answer_invalid", "criterion");

  // Roles/search places can change; weakening a deep axis to brief now refuses.
  const tightened = { ...planQuestion("q-market", "market"), requiredDepth: "deep",
    roles: ["buyer", "regional lawyer"], searchPlaces: ["analogues", "competitor docs"] };
  thrown(() => answerDiscoveryFixture(engine, "p8", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), { ...tightened, requiredDepth: "brief" }], 2, firstPlanRef), source_),
    "answer_invalid", "depth");
  answerDiscoveryFixture(engine, "p8", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), tightened], 2, firstPlanRef), source_);
  assert.equal(store.get<Question>(plan.id)!.value.status, "answered");
});

test("DR2: редакции плана — прежние правила сохранены", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p6", "concept");
  const source_ = source(discovery, "p6");
  const frame = questionOf(store, draft, "frame");
  answerDiscoveryFixture(engine, "p6", draft, frame, validFrame(), source_);
  const frameRef = store.get<Question>(frame.id)!.value.answer!;
  const plan = questionOf(store, draft, "plan");

  answerDiscoveryFixture(engine, "p6", draft, plan,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), planQuestion("q-market", "market")]), source_);
  const firstPlanRef = store.get<Question>(plan.id)!.value.answer!;

  // Вторая редакция: previous — exact Ref первой, id устойчивы, новый вопрос — новый id.
  let reopened = engine.discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);
  answerDiscoveryFixture(engine, "p6", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), planQuestion("q-market", "market"),
      planQuestion("q-data", "data", "supporting")], 2, firstPlanRef), source_);
  const secondPlanRef = store.get<Question>(plan.id)!.value.answer!;

  // Переименование существующего вопроса — отказ.
  reopened = engine.discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);
  const renamed = planQuestion("q-rules", "rules", "blocking");
  renamed.text = "A different wording for q-rules";
  thrown(() => answerDiscoveryFixture(engine, "p6", draft, reopened,
    validPlan(frameRef, [renamed, planQuestion("q-market", "market"), planQuestion("q-data", "data")],
      3, secondPlanRef), source_), "answer_invalid", "q-rules");
  assert.equal(store.get<Question>(plan.id)!.value.status, "open");

  // Пересмотр класса без сохранённого основания — отказ.
  const demoted = planQuestion("q-rules", "rules", "supporting");
  thrown(() => answerDiscoveryFixture(engine, "p6", draft, reopened,
    validPlan(frameRef, [demoted, planQuestion("q-market", "market"), planQuestion("q-data", "data")],
      3, secondPlanRef), source_), "answer_invalid", "classRevision");

  // Пересмотр класса с основанием — принят; дальше класс держится.
  const revised = { ...planQuestion("q-rules", "rules", "supporting"),
    classRevision: { from: "blocking", basis: "assessor re-scoped the axis after the frame review" } };
  answerDiscoveryFixture(engine, "p6", draft, reopened,
    validPlan(frameRef, [revised, planQuestion("q-market", "market"), planQuestion("q-data", "data")],
      3, secondPlanRef), source_);
  const thirdPlanRef = store.get<Question>(plan.id)!.value.answer!;

  // Четвёртая редакция: supporting по rules держится — пересмотр уже принят.
  reopened = engine.discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);
  answerDiscoveryFixture(engine, "p6", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "supporting"), planQuestion("q-market", "market"),
      planQuestion("q-data", "data")], 4, thirdPlanRef), source_);
  const fourthPlanRef = store.get<Question>(plan.id)!.value.answer!;

  // previous на чужой ответ (рамку) — отказ.
  reopened = engine.discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);
  thrown(() => answerDiscoveryFixture(engine, "p6", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "supporting"), planQuestion("q-market", "market"),
      planQuestion("q-data", "data")], 5, frameRef), source_), "answer_invalid", "previous");

  // Пропущенная редакция — отказ.
  thrown(() => answerDiscoveryFixture(engine, "p6", draft, reopened,
    validPlan(frameRef, [planQuestion("q-rules", "rules", "supporting"), planQuestion("q-market", "market"),
      planQuestion("q-data", "data")], 9, fourthPlanRef), source_), "answer_invalid", "edition");
});

test("DR2: копия принятого ответа не принята — frame и previous по сохранённому акту", t => {
  const { store, engine, discovery } = fixture(t);
  const draft = createPartialV7Draft(discovery, "p-copy", "concept");
  const source_ = source(discovery, "p-copy");
  const frame = questionOf(store, draft, "frame");
  answerDiscoveryFixture(engine, "p-copy", draft, frame, validFrame(), source_);
  const frameRef = store.get<Question>(frame.id)!.value.answer!;
  const plan = questionOf(store, draft, "plan");
  const attempt = (value: Json, q: Revision<Question> = plan) =>
    answerDiscoveryFixture(engine, "p-copy", draft, q, value, source_);

  // Проба ревьюера 1: точная копия принятого ответа рамки под другим id — та
  // же законная оценка внутри, но вопрос продолжает ссылаться на исходный
  // ответ: акта принятия копии не было.
  const frameAnswer = store.get<ResearchAnswer>(frameRef.id, frameRef.revision)!;
  const frameCopy = store.write<ResearchAnswer>({ id: "research-answer:p-copy:frame-copy",
    kind: "research-answer", expected: 0, value: { ...frameAnswer.value } });
  thrown(() => attempt(validPlan(reference(frameCopy), [planQuestion("qa", "market")])),
    "answer_invalid", "frame");

  // Первая редакция плана принята законно.
  attempt(validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"), planQuestion("q-market", "market")]));
  const firstPlanRef = store.get<Question>(plan.id)!.value.answer!;

  // Проба ревьюера 2: копия принятой первой редакции под другим id как previous.
  const firstAnswer = store.get<ResearchAnswer>(firstPlanRef.id, firstPlanRef.revision)!;
  const planCopy = store.write<ResearchAnswer>({ id: "research-answer:p-copy:plan-copy",
    kind: "research-answer", expected: 0, value: { ...firstAnswer.value } });
  const reopened = engine.discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);
  thrown(() => attempt(validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"),
    planQuestion("q-market", "market")], 2, reference(planCopy)), reopened),
    "answer_invalid", "previous");

  // Законная вторая редакция по сохранённому акту первой — принимается.
  attempt(validPlan(frameRef, [planQuestion("q-rules", "rules", "blocking"),
    planQuestion("q-market", "market")], 2, firstPlanRef), reopened);
  assert.equal(store.get<Question>(plan.id)!.value.status, "answered");
});

test("DR2: контрпримеры связности акта принятия — отказ plan writer", t => {
  // Контрпример 1 ревьюера: stale assessment + synthetic acceptance passed to real plan writer
  {
    const { store, engine, discovery } = fixture(t);
    const draft = createPartialV7Draft(discovery, "p-stale", "concept");
    const src = source(discovery, "p-stale");
    const frame = questionOf(store, draft, "frame");
    const plan = questionOf(store, draft, "plan");
    answerDiscoveryFixture(engine, "p-stale", draft, frame, validFrame(), src);
    const frameRef = store.get<Question>(frame.id)!.value.answer!;
    const a = store.get<ResearchAnswer>(frameRef.id, frameRef.revision)!;
    const q = discovery.reopen(frame.id, store.get<Question>(frame.id)!.revision);
    const d = store.get<DiscoveryDraft>(draft.id)!;
    const copy = store.write<ResearchAnswer>({ id: "research-answer:p-stale:stale-copy",
      kind: a.kind, expected: 0, value: a.value });
    store.writeMany([
      { id: d.id, kind: d.kind, expected: d.revision, value: { ...d.value, fields: { ...d.value.fields, frame: a.value.value } } },
      { id: q.id, kind: q.kind, expected: q.revision, value: { ...q.value, status: "answered", answer: reference(copy) } }
    ]);
    thrown(() => answerDiscoveryFixture(engine, "p-stale", draft, plan,
      validPlan(reference(copy), [planQuestion("q-market", "market")]), src),
      "answer_invalid", "frame");
  }

  // Контрпример 2 ревьюера: question-only act borrows draft field from earlier answer
  {
    const { store, engine, discovery } = fixture(t);
    const draft = createPartialV7Draft(discovery, "p-borrow", "concept");
    const src = source(discovery, "p-borrow");
    const frame = questionOf(store, draft, "frame");
    const plan = questionOf(store, draft, "plan");
    answerDiscoveryFixture(engine, "p-borrow", draft, frame, validFrame(), src);
    const frameRef = store.get<Question>(frame.id)!.value.answer!;
    const a = store.get<ResearchAnswer>(frameRef.id, frameRef.revision)!;
    const oldAssessment = store.get<ResearchAssessment>(a.value.assessment.id)!;
    const q = discovery.reopen(frame.id, store.get<Question>(frame.id)!.revision);
    const assessment = store.write<ResearchAssessment>({ id: "research-assessment:p-borrow:fresh",
      kind: oldAssessment.kind, expected: 0, value: { ...oldAssessment.value, question: reference(q) } });
    const copy = store.write<ResearchAnswer>({ id: "research-answer:p-borrow:question-only",
      kind: a.kind, expected: 0, value: { ...a.value, assessment: reference(assessment) } });
    // draft НЕ перезаписывается!
    store.write<Question>({ id: q.id, kind: q.kind, expected: q.revision,
      value: { ...q.value, status: "answered", answer: reference(copy) } });
    thrown(() => answerDiscoveryFixture(engine, "p-borrow", draft, plan,
      validPlan(reference(copy), [planQuestion("q-market", "market")]), src),
      "answer_invalid", "frame");
  }

  // Положительная проба ревьюера: настоящее старое принятие после reopen и нового принятия
  {
    const { store, engine, discovery } = fixture(t);
    const draft = createPartialV7Draft(discovery, "p-real", "concept");
    const src = source(discovery, "p-real");
    const frame = questionOf(store, draft, "frame");
    const plan = questionOf(store, draft, "plan");
    answerDiscoveryFixture(engine, "p-real", draft, frame, validFrame(), src);
    const frameRef = store.get<Question>(frame.id)!.value.answer!;

    const q = discovery.reopen(frame.id, store.get<Question>(frame.id)!.revision);
    // План может быть отвечен со старой законно принятой рамкой и после reopen:
    answerDiscoveryFixture(engine, "p-real", draft, plan,
      validPlan(frameRef, [planQuestion("q-market", "market")]), src);
    assert.equal(store.get<Question>(plan.id)!.value.status, "answered");

    // Новое законное принятие рамки:
    answerDiscoveryFixture(engine, "p-real", draft, q,
      validFrame({ scale: "60 users across 20 sites" }), src);
    const head = store.get<Question>(q.id)!;
    const freshRef = head.value.answer!;

    // Reopen плана и ответ с новой законной рамкой:
    const firstPlanRef = store.get<Question>(plan.id)!.value.answer!;
    const planReopened = discovery.reopen(plan.id, store.get<Question>(plan.id)!.revision);
    answerDiscoveryFixture(engine, "p-real", draft, planReopened,
      validPlan(freshRef, [planQuestion("q-market", "market")], 2, firstPlanRef), src);
    assert.equal(store.get<Question>(plan.id)!.value.status, "answered");
  }

  // Контрпример ревьюера №5993: повторное законное принятие того же V, затем поддельный 3-й ответ без draft
  {
    const { store, engine, discovery } = fixture(t);
    const draft = createPartialV7Draft(discovery, "p-repeat", "concept");
    const src = source(discovery, "p-repeat");
    const frame = questionOf(store, draft, "frame");
    const plan = questionOf(store, draft, "plan");
    answerDiscoveryFixture(engine, "p-repeat", draft, frame, validFrame(), src);

    let q = discovery.reopen(frame.id, store.get<Question>(frame.id)!.revision);
    answerDiscoveryFixture(engine, "p-repeat", draft, q, validFrame(), src);
    const acceptedQ = store.get<Question>(frame.id)!;
    const a = store.get<ResearchAnswer>(acceptedQ.value.answer!.id, acceptedQ.value.answer!.revision)!;
    const oldAssessment = store.get<ResearchAssessment>(a.value.assessment.id)!;

    q = discovery.reopen(frame.id, acceptedQ.revision);
    const assessment = store.write<ResearchAssessment>({ id: "research-assessment:p-repeat:third",
      kind: oldAssessment.kind, expected: 0, value: { ...oldAssessment.value, question: reference(q) } });
    const copy = store.write<ResearchAnswer>({ id: "research-answer:p-repeat:third-copy",
      kind: a.kind, expected: 0, value: { ...a.value, assessment: reference(assessment) } });
    store.write<Question>({ id: q.id, kind: q.kind, expected: q.revision,
      value: { ...q.value, status: "answered", answer: reference(copy) } });

    thrown(() => answerDiscoveryFixture(engine, "p-repeat", draft, plan,
      validPlan(reference(copy), [planQuestion("q-market", "market")]), src),
      "answer_invalid", "frame");
  }

  // Пробы ревьюера №6004: повторное принятие другого поля (objective), подделка frame без перехода draft, чтение через Store view
  {
    const acceptObjective = (f: { store: Store; draft: Revision<DiscoveryDraft>; discovery: Discovery }) => {
      let q = questionOf(f.store, f.draft, "objective");
      f.discovery.decision(q.id, q.revision, "owner", "Chosen goal");
      q = f.discovery.reopen(q.id, f.store.get<Question>(q.id)!.revision);
      f.discovery.decision(q.id, q.revision, "owner", "Chosen goal");
    };

    // 1) Положительная проба: дважды законно принятый objective с тем же текстом до первого frame
    {
      const f = fixture(t);
      const draft = createPartialV7Draft(f.discovery, "p-obj-repeat", "concept");
      const src = source(f.discovery, "p-obj-repeat");
      const frame = questionOf(f.store, draft, "frame");
      const plan = questionOf(f.store, draft, "plan");
      acceptObjective({ store: f.store, draft, discovery: f.discovery });
      answerDiscoveryFixture(f.engine, "p-obj-repeat", draft, frame, validFrame(), src);
      const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
      answerDiscoveryFixture(f.engine, "p-obj-repeat", draft, plan,
        validPlan(frameRef, [planQuestion("q-market", "market")]), src);
      assert.equal(f.store.get<Question>(plan.id)!.value.status, "answered");
    }

    // 2) Отрицательная проба: вопрос answered с новым ответом V, но без собственного перехода draft
    {
      const f = fixture(t);
      const draft = createPartialV7Draft(f.discovery, "p-obj-borrow", "concept");
      const src = source(f.discovery, "p-obj-borrow");
      const frame = questionOf(f.store, draft, "frame");
      const plan = questionOf(f.store, draft, "plan");
      answerDiscoveryFixture(f.engine, "p-obj-borrow", draft, frame, validFrame(), src);
      const acceptedQ = f.store.get<Question>(frame.id)!;
      const a = f.store.get<ResearchAnswer>(acceptedQ.value.answer!.id, acceptedQ.value.answer!.revision)!;
      const oldAssessment = f.store.get<ResearchAssessment>(a.value.assessment.id)!;
      const q = f.discovery.reopen(frame.id, acceptedQ.revision);
      acceptObjective({ store: f.store, draft, discovery: f.discovery });
      const assessment = f.store.write<ResearchAssessment>({ id: "research-assessment:p-obj-borrow:forged",
        kind: oldAssessment.kind, expected: 0, value: { ...oldAssessment.value, question: reference(q) } });
      const copy = f.store.write<ResearchAnswer>({ id: "research-answer:p-obj-borrow:forged",
        kind: a.kind, expected: 0, value: { ...a.value, assessment: reference(assessment) } });
      f.store.write<Question>({ id: q.id, kind: q.kind, expected: q.revision,
        value: { ...q.value, status: "answered", answer: reference(copy) } });
      thrown(() => answerDiscoveryFixture(f.engine, "p-obj-borrow", draft, plan,
        validPlan(reference(copy), [planQuestion("q-market", "market")]), src),
        "answer_invalid", "frame");
    }

    // 3) Положительная проба: штатный приём плана через write-only Store view
    {
      const f = fixture(t);
      const draft = createPartialV7Draft(f.discovery, "p-view", "concept");
      const src = source(f.discovery, "p-view");
      const frame = questionOf(f.store, draft, "frame");
      const plan = questionOf(f.store, draft, "plan");
      answerDiscoveryFixture(f.engine, "p-view", draft, frame, validFrame(), src);
      const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
      const view = storeView(f.store, { write: (writes, guards) => f.store.writeMany(writes, guards) });
      const engine = new ProductEngine(view);
      answerDiscoveryFixture(engine, "p-view", draft, plan,
        validPlan(frameRef, [planQuestion("q-market", "market")]), src);
      assert.equal(f.store.get<Question>(plan.id)!.value.status, "answered");
    }
  }
});

test("DR2: договор акта принятия — fact/decision, повреждения/отсутствие акта, атомарный откат пачки", t => {
  // 1) fact и decision создают запись discovery-acceptance-act с assessment=null и binding=null
  {
    const f = fixture(t);
    const draft = createPartialV7Draft(f.discovery, "p-act", "concept");
    const src = source(f.discovery, "p-act");
    const qBrief = questionOf(f.store, draft, "brief");
    f.discovery.fact(qBrief.id, qBrief.revision, reference(src), { kind: "text-range", start: 0, end: 5 });
    const briefAnsRef = f.store.get<Question>(qBrief.id)!.value.answer!;
    const briefActId = discoveryAcceptanceActId("p-act", draft.id, "brief", briefAnsRef);
    const briefAct = f.store.get<DiscoveryAcceptanceAct>(briefActId, 1);
    assert.ok(briefAct, "brief act exists");
    assert.equal(briefAct.kind, DISCOVERY_ACCEPTANCE_ACT_KIND);
    assert.equal(briefAct.value.contract, DISCOVERY_ACCEPTANCE_ACT_CONTRACT);
    assert.equal(briefAct.value.assessment, null);
    assert.equal(briefAct.value.binding, null);

    const qObj = questionOf(f.store, draft, "objective");
    f.discovery.decision(qObj.id, qObj.revision, "owner", "Chosen goal");
    const objAnsRef = f.store.get<Question>(qObj.id)!.value.answer!;
    const objActId = discoveryAcceptanceActId("p-act", draft.id, "objective", objAnsRef);
    const objAct = f.store.get<DiscoveryAcceptanceAct>(objActId, 1);
    assert.ok(objAct, "objective act exists");
    assert.equal(objAct.value.assessment, null);
    assert.equal(objAct.value.binding, null);

    // Researched frame создает акт с assessment !== null
    const qFrame = questionOf(f.store, draft, "frame");
    answerDiscoveryFixture(f.engine, "p-act", draft, qFrame, validFrame(), src);
    const frameAnsRef = f.store.get<Question>(qFrame.id)!.value.answer!;
    const frameActId = discoveryAcceptanceActId("p-act", draft.id, "frame", frameAnsRef);
    const frameAct = f.store.get<DiscoveryAcceptanceAct>(frameActId, 1);
    assert.ok(frameAct, "frame act exists");
    assert.notEqual(frameAct.value.assessment, null);
  }

  // 2) Повреждённый или поддельный акт — отказ приёма плана
  {
    const fBad = fixture(t);
    const dBad = createPartialV7Draft(fBad.discovery, "p-bad", "concept");
    const sBad = source(fBad.discovery, "p-bad");
    const qFrameBad = questionOf(fBad.store, dBad, "frame");
    const qPlanBad = questionOf(fBad.store, dBad, "plan");
    answerDiscoveryFixture(fBad.engine, "p-bad", dBad, qFrameBad, validFrame(), sBad);
    const fRefBad = fBad.store.get<Question>(qFrameBad.id)!.value.answer!;
    const actIdBad = discoveryAcceptanceActId("p-bad", dBad.id, "frame", fRefBad);
    const goodAct = fBad.store.get<DiscoveryAcceptanceAct>(actIdBad, 1)!;

    // (a) Поддельный ответ без акта — отказ приёма плана
    const forgedAns = fBad.store.write<ResearchAnswer>({
      id: "research-answer:p-bad:forged-no-act",
      kind: "research-answer",
      expected: 0,
      value: { ...fBad.store.get<ResearchAnswer>(fRefBad.id, fRefBad.revision)!.value }
    });
    thrown(() => answerDiscoveryFixture(fBad.engine, "p-bad", dBad, qPlanBad,
      validPlan(reference(forgedAns), [planQuestion("q-market", "market")]), sBad),
      "answer_invalid", "frame");

    // (b) Акт повреждён на ревизии 1 (чужой проект) — savedAcceptanceAct возвращает false
    const actDamagedId = discoveryAcceptanceActId("p-bad", dBad.id, "frame", reference(forgedAns));
    fBad.store.write<DiscoveryAcceptanceAct>({
      id: actDamagedId,
      kind: DISCOVERY_ACCEPTANCE_ACT_KIND,
      expected: 0,
      value: { ...goodAct.value, answer: reference(forgedAns), projectId: "other" }
    });
    const hold = savedAcceptanceAct(fBad.store, fBad.store.get(dBad.id)!, fBad.store.get(qFrameBad.id)!,
      "frame", reference(forgedAns), validFrame());
    assert.equal(hold, false);

    // (c) — отдельным тестом ниже: точная история answered -> answered без reopen
  }

  // 3) Атомарный откат всей пачки: конфликт ВНУТРИ подготовленной пачки (лишняя запись с неверной ревизией
  //    внедряется в тот же writeMany, что пишет draft/answer/question/акт) — ничего из пачки не сохраняется.
  {
    const fConflict = fixture(t);
    const dConflict = createPartialV7Draft(fConflict.discovery, "p-conflict", "concept");
    const sConflict = source(fConflict.discovery, "p-conflict");
    const qFrameC = questionOf(fConflict.store, dConflict, "frame");
    const answersBefore = fConflict.store.list("research-answer").length;
    const draftBefore = fConflict.store.get<DiscoveryDraft>(dConflict.id)!;
    const original = fConflict.store.writeMany.bind(fConflict.store);
    let injected = 0;
    (fConflict.store as unknown as { writeMany: typeof original }).writeMany = ((inputs, guards) => {
      if (inputs.some(w => w.kind === DISCOVERY_ACCEPTANCE_ACT_KIND)) {
        injected++;
        return original([...inputs, { id: "probe:p-conflict:batch-conflict", kind: "probe", expected: 7, value: {} }], guards);
      }
      return original(inputs, guards);
    }) as typeof original;
    thrown(() => answerDiscoveryFixture(fConflict.engine, "p-conflict", dConflict, qFrameC, validFrame(), sConflict),
      "revision_conflict");
    (fConflict.store as unknown as { writeMany: typeof original }).writeMany = original;
    assert.equal(injected, 1, "конфликт внедрён ровно в пачку принятия");
    assert.equal(fConflict.store.list(DISCOVERY_ACCEPTANCE_ACT_KIND).length, 0, "акт не записан");
    assert.equal(fConflict.store.get<Question>(qFrameC.id)!.value.status, "open", "вопрос не изменён");
    assert.equal(fConflict.store.get<Question>(qFrameC.id)!.revision, qFrameC.revision);
    const draftAfter = fConflict.store.get<DiscoveryDraft>(dConflict.id)!;
    assert.equal(draftAfter.revision, draftBefore.revision, "draft не изменён");
    assert.equal(draftAfter.hash, draftBefore.hash);
    assert.equal(fConflict.store.list("research-answer").length, answersBefore, "ответ пачки не сохранён");
  }

  // 4) Managed-ответ: акт несёт binding, связывающий exact ссылки; повреждение binding отвергается
  {
    const fManaged = fixture(t);
    const dManaged = createPartialV7Draft(fManaged.discovery, "p-managed", "concept");
    const sManaged = source(fManaged.discovery, "p-managed");
    const qFrameM = questionOf(fManaged.store, dManaged, "frame");
    answerDiscoveryFixture(fManaged.engine, "p-managed", dManaged, qFrameM, validFrame(), sManaged);
    const frameAnsRef = fManaged.store.get<Question>(qFrameM.id)!.value.answer!;
    const actIdM = discoveryAcceptanceActId("p-managed", dManaged.id, "frame", frameAnsRef);
    const ordinaryAct = fManaged.store.get<DiscoveryAcceptanceAct>(actIdM, 1)!;
    // Обычный (не managed) акт не должен нести binding
    assert.equal(ordinaryAct.value.binding, null);

    // Моделируем managed-ответ: адрес несёт managedAnswerId
    const turnId = managedTurnId("run-simulated", 1);
    const mAnswerId = managedAnswerId("p-managed", turnId);
    const dManaged2 = createPartialV7Draft(fManaged.discovery, "p-managed", "concept");
    const qFrameM2 = questionOf(fManaged.store, dManaged2, "frame");

    const assessment = fManaged.store.write<ResearchAssessment>({
      id: "research-assessment:p-managed:fresh",
      kind: "research-assessment",
      expected: 0,
      value: { ...fManaged.store.get<ResearchAssessment>(ordinaryAct.value.assessment!.id)!.value,
        question: reference(qFrameM2) }
    });

    const mAns = fManaged.store.write<ResearchAnswer>({
      id: mAnswerId, kind: "research-answer", expected: 0,
      value: { ...fManaged.store.get<ResearchAnswer>(frameAnsRef.id, frameAnsRef.revision)!.value,
        question: qFrameM2.id, assessment: reference(assessment) }
    });
    const mRef = reference(mAns);
    const bId = acceptanceBindingId("p-managed", turnId);

    const dAfterM = { ...dManaged2.value, fields: { ...dManaged2.value.fields, frame: validFrame() } };
    const qAfterM = { ...qFrameM2.value, status: "answered" as const, answer: mRef };
    const dAfterRec = fManaged.store.write({ id: dManaged2.id, kind: "discovery-draft", expected: 1, value: dAfterM });
    const qAfterRec = fManaged.store.write({ id: qFrameM2.id, kind: "question", expected: 1, value: qAfterM });
    const dAfterRef = reference(dAfterRec);
    const qAfterRef = reference(qAfterRec);

    const bindingVal = {
      contract: "research-acceptance-binding/v1",
      projectId: "p-managed",
      turn: { id: turnId, revision: 1, hash: "0".repeat(64) },
      pending: { id: turnId, revision: 2, hash: "0".repeat(64) },
      intent: { id: "intent-1", revision: 1, hash: "0".repeat(64) },
      draftBefore: reference(dManaged2),
      draftAfter: dAfterRef,
      questionBefore: reference(qFrameM2),
      questionAfter: qAfterRef,
      answer: mRef,
      assessment: reference(assessment),
      assessmentProof: { id: "proof-1", revision: 1, hash: "0".repeat(64) },
      action: { action: "answer", question: qFrameM2.id },
    };
    const bRec = fManaged.store.write({ id: bId, kind: "research-acceptance-binding", expected: 0, value: bindingVal });
    const mActId = discoveryAcceptanceActId("p-managed", dManaged2.id, "frame", mRef);
    fManaged.store.write<DiscoveryAcceptanceAct>({
      id: mActId, kind: DISCOVERY_ACCEPTANCE_ACT_KIND, expected: 0,
      value: { contract: DISCOVERY_ACCEPTANCE_ACT_CONTRACT, projectId: "p-managed", draftId: dManaged2.id,
        field: "frame", draftBefore: reference(dManaged2), draftAfter: dAfterRef,
        questionBefore: reference(qFrameM2), questionAfter: qAfterRef,
        answer: mRef, assessment: reference(assessment), binding: reference(bRec) }
    });
    // Проверяем, что savedAcceptanceAct одобряет корректный managed акт
    const validHold = savedAcceptanceAct(fManaged.store, fManaged.store.get(dManaged2.id)!, fManaged.store.get(qFrameM2.id)!,
      "frame", mRef, validFrame());
    assert.equal(validHold, true);

    // Повреждение binding (например, несовпадение draftAfter) приводит к отказу
    const dManaged3 = createPartialV7Draft(fManaged.discovery, "p-managed", "concept");
    const qFrameM3 = questionOf(fManaged.store, dManaged3, "frame");
    const mActIdBad = discoveryAcceptanceActId("p-managed", dManaged3.id, "frame", mRef);
    fManaged.store.write<DiscoveryAcceptanceAct>({
      id: mActIdBad, kind: DISCOVERY_ACCEPTANCE_ACT_KIND, expected: 0,
      value: { contract: DISCOVERY_ACCEPTANCE_ACT_CONTRACT, projectId: "p-managed", draftId: dManaged3.id,
        field: "frame", draftBefore: reference(dManaged3), draftAfter: dAfterRef,
        questionBefore: reference(qFrameM3), questionAfter: qAfterRef,
        answer: mRef, assessment: reference(assessment), binding: { id: bId, revision: 1, hash: "f".repeat(64) } }
    });
    const brokenHold = savedAcceptanceAct(fManaged.store, fManaged.store.get(dManaged3.id)!, fManaged.store.get(qFrameM3.id)!,
      "frame", mRef, validFrame());
    assert.equal(brokenHold, false);
  }
});

test("DR2: акт с переходом answered → answered без reopen отвергается обоими потребителями", t => {
  const f = fixture(t);
  const draft = createPartialV7Draft(f.discovery, "p", "concept"), src = source(f.discovery, "p");
  const frame = questionOf(f.store, draft, "frame"), plan = questionOf(f.store, draft, "plan");
  answerDiscoveryFixture(f.engine, "p", draft, frame, validFrame(), src);
  const reopened = f.discovery.reopen(frame.id, f.store.get<Question>(frame.id)!.revision);
  answerDiscoveryFixture(f.engine, "p", draft, reopened, validFrame(), src);
  const q = f.store.get<Question>(frame.id)!, d = f.store.get<DiscoveryDraft>(draft.id)!;
  assert.equal(q.value.status, "answered");
  const a = f.store.get<ResearchAnswer>(q.value.answer!.id)!, r = f.store.get<ResearchAssessment>(a.value.assessment!.id)!;
  const assessment = f.store.write<ResearchAssessment>({ id: "research-assessment:p:no-reopen", kind: r.kind, expected: 0,
    value: { ...r.value, question: reference(q) } });
  // Публичный производитель такой переход запрещает.
  thrown(() => f.discovery.researched(q.id, q.revision, reference(assessment)), "question_already_answered");
  // Изолированная подделка истории (fault-injection): та же форма акта, но questionBefore уже answered.
  const copied = f.store.write<ResearchAnswer>({ id: "research-answer:p:no-reopen", kind: a.kind, expected: 0,
    value: { ...a.value, assessment: reference(assessment) } });
  const answer = reference(copied);
  const dValue = { ...d.value, fields: { ...d.value.fields, frame: copied.value.value } };
  const qValue = { ...q.value, status: "answered" as const, answer };
  const act = { contract: DISCOVERY_ACCEPTANCE_ACT_CONTRACT, projectId: "p", draftId: d.id, field: "frame",
    draftBefore: reference(d), draftAfter: { id: d.id, revision: d.revision + 1, hash: hashJson(dValue) },
    questionBefore: reference(q), questionAfter: { id: q.id, revision: q.revision + 1, hash: hashJson(qValue) },
    answer, assessment: reference(assessment), binding: null };
  f.store.writeMany([
    { id: d.id, kind: d.kind, expected: d.revision, value: dValue },
    { id: q.id, kind: q.kind, expected: q.revision, value: qValue },
    { id: discoveryAcceptanceActId("p", d.id, "frame", answer), kind: DISCOVERY_ACCEPTANCE_ACT_KIND, expected: 0, value: act },
  ]);
  assert.equal(savedAcceptanceAct(f.store, f.store.get(d.id)!, f.store.get(q.id)!, "frame", answer, copied.value.value), false);
  thrown(() => answerDiscoveryFixture(f.engine, "p", draft, plan, validPlan(answer, [planQuestion("q-market", "market")]), src),
    "answer_invalid", "frame");
});

test("DR2: законное принятие из unresolved читается — рамка поддерживает план", t => {
  const f = fixture(t);
  const d = createPartialV7Draft(f.discovery, "p", "concept"), src = source(f.discovery, "p");
  const fq = questionOf(f.store, d, "frame"), pq = questionOf(f.store, d, "plan");
  f.discovery.unresolved(fq.id, fq.revision);
  const before = f.store.get<Question>(fq.id)!;
  assert.equal(before.value.status, "unresolved");
  answerDiscoveryFixture(f.engine, "p", d, before, validFrame(), src);
  const after = f.store.get<Question>(fq.id)!, ref = after.value.answer!;
  assert.ok(f.store.get(discoveryAcceptanceActId("p", d.id, "frame", ref)), "акт записан");
  assert.equal(savedAcceptanceAct(f.store, f.store.get(d.id)!, after, "frame", ref, validFrame()), true);
  answerDiscoveryFixture(f.engine, "p", d, pq, validPlan(ref, [planQuestion("q-market", "market")]), src);
  assert.equal(f.store.get<Question>(pq.id)!.value.status, "answered");
});

test("DR2: законное принятие плана из unresolved поддерживает следующую редакцию", t => {
  const f = fixture(t);
  const d = createPartialV7Draft(f.discovery, "p", "concept"), src = source(f.discovery, "p");
  const fq = questionOf(f.store, d, "frame"), pq = questionOf(f.store, d, "plan");
  answerDiscoveryFixture(f.engine, "p", d, fq, validFrame(), src);
  const frameRef = f.store.get<Question>(fq.id)!.value.answer!;
  f.discovery.unresolved(pq.id, pq.revision);
  const before = f.store.get<Question>(pq.id)!, questions = [planQuestion("q-market", "market")];
  answerDiscoveryFixture(f.engine, "p", d, before, validPlan(frameRef, questions), src);
  const previous = f.store.get<Question>(pq.id)!.value.answer!;
  const reopened = f.discovery.reopen(pq.id, f.store.get<Question>(pq.id)!.revision);
  answerDiscoveryFixture(f.engine, "p", d, reopened, validPlan(frameRef, questions, 2, previous), src);
  assert.equal((f.store.get<DiscoveryDraft>(d.id)!.value.fields.plan as { edition: number }).edition, 2);
});
