// Тесты двух долгов OMG-ORDER. Всё во временном Store; настоящая база не читается вовсе.
// Запуск: node --test PREPARATIONS/OM-DESIGN/proto/admission.test.mjs   (нужен собранный dist/)
import test from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Store } from "../../../dist/src/storage/store.js"; import { reference } from "../../../dist/src/pipeline/contracts.js";
import * as A from "./admission.mjs";

const P = "proto";
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "om-adm-")); const store = new Store(join(dir, "s.sqlite")); return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } }; };
const basis = store => [reference(store.get("policy") ?? store.write({ id: "policy", kind: "om-policy", expected: 0, value: { version: 1 } }))];
const cap = (store, tokens, kind = "guaranteed") => ({ kind, tokens, basis: basis(store), explanation: "жёсткий предел вызова, заданный средой" });
const U = (i, o) => ({ inputTokens: i, outputTokens: o, cachedInputTokens: null, reasoningOutputTokens: null });
let DISPATCH = null;   // точные ссылки на записи адаптера и конфигурации создаёт open() во временном Store
const dispatchOf = store => ({ adapter: reference(store.get("adapter:codex") ?? store.write({ id: "adapter:codex", kind: "adapter", expected: 0, value: { name: "codex", hardTokenCap: true } })), config: reference(store.get("adapter-config:codex") ?? store.write({ id: "adapter-config:codex", kind: "adapter-config", expected: 0, value: { model: "m", effort: "high" } })) });
const open = (store, { budget, blockCap, callCap }) => { DISPATCH = dispatchOf(store); A.openFuses(store, P, { blockCap, callCap: callCap ?? blockCap }); return A.openAllocation(store, P, { limit: budget }, "решение владельца: бюджет горизонта"); };
const call = (store, id, block, tokens, extra = {}) => A.admitCall(store, P, { call: id, block, series: "s1", horizon: "H1", estimate: cap(store, tokens), dispatch: DISPATCH, ...extra });
const refusal = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `ожидался ${code}, получено ${e.code}: ${e.message}`); return true; });
const left = store => A.usageOf(store, P);
const blockRow = (store, block) => left(store).groups[`block:${block}`] ?? { measured: 0, reserved: 0 };

test("контрпример ревью: лимит 100, два резерва по 60 — второй не допускается, пока первый не закрыт", () => {
  const { store, done } = fresh(); try { open(store, { budget: 100, blockCap: 100 }); call(store, "call-1", "n-state", 60);
    refusal(() => call(store, "call-2", "n-recovery", 60), "call_not_admitted_horizon_budget"); assert.equal(left(store).reserved, 60); assert.equal(store.get("call-2"), null, "недопущенный вызов не создан"); } finally { done(); } });

test("одновременность: два допуска по одному снимку не проходят оба — второй пересчитывается и получает отказ", () => {
  const { store, done } = fresh(); try { open(store, { budget: 100, blockCap: 100 }); let raced = false;
    refusal(() => A.admitCall(store, P, { call: "slow", block: "n-state", series: "s1", horizon: "H1", estimate: cap(store, 60), dispatch: DISPATCH },
      { beforeWrite: () => { if (!raced) { raced = true; call(store, "fast", "n-state", 60); } } }), "call_not_admitted_block_cap");
    assert.ok(store.get("om-admission:fast")); assert.equal(store.get("om-admission:slow"), null); assert.equal(left(store).reserved, 60); } finally { done(); } });

test("потолок блока действует отдельно от выделения; предел одного вызова — отдельный предохранитель", () => {
  const { store, done } = fresh(); try { open(store, { budget: 1000, blockCap: 100, callCap: 80 }); call(store, "b1", "n-state", 70);
    refusal(() => call(store, "b2", "n-state", 40), "call_not_admitted_block_cap"); call(store, "other", "n-recovery", 40); refusal(() => call(store, "big", "n-check", 90), "call_not_admitted_call_cap"); } finally { done(); } });

test("смена версии выбора НЕ обнуляет учёт блока и НЕ создаёт нового выделения", () => {
  const { store, done } = fresh(); try { const alloc = open(store, { budget: 1000, blockCap: 100 });
    call(store, "h1-a", "n-state", 40); A.settleCall(store, "h1-a", U(30, 10)); call(store, "h1-b", "n-state", 20);
    refusal(() => call(store, "h2-a", "n-state", 60, { horizon: "H2" }), "call_not_admitted_block_cap"); call(store, "h2-b", "n-state", 40, { horizon: "H2" });
    assert.deepEqual([blockRow(store, "n-state").measured, blockRow(store, "n-state").reserved], [40, 60]); assert.equal(A.activeAllocation(store, P).allocation.id, alloc.id, "выделение то же"); } finally { done(); } });

test("вердикт №2 п.3: бюджет горизонта — это ВЫДЕЛЕНИЕ: новое создаётся только решением владельца с основанием и даёт свой лимит; общий проектный потолок не вводится", () => {
  const { store, done } = fresh(); try { const a1 = open(store, { budget: 100, blockCap: 100 }); call(store, "a1-x", "n-state", 60); call(store, "a1-y", "n-recovery", 40);
    refusal(() => call(store, "a1-z", "n-check", 10), "call_not_admitted_horizon_budget");
    refusal(() => A.openAllocation(store, P, { limit: 100 }, " "), "allocation_invalid"); refusal(() => A.openAllocation(store, P, { limit: "100" }, "основание"), "allocation_invalid");
    const a2 = A.openAllocation(store, P, { limit: 100 }, "решение владельца: бюджет следующего горизонта"); assert.equal(store.get(a1.id).value.state, "closed"); assert.notEqual(a2.id, a1.id);
    const adm = call(store, "a2-x", "n-check", 80); assert.equal(adm.admission.value.allocation.id, a2.id); assert.equal(left(store).reserved, 180, "резервы прежнего выделения остались в общей ведомости");
    A.settleCall(store, "a1-x", U(50, 5)); assert.equal(left(store).groups[A.groupsOf(a1, "n-state").alloc].measured, 55, "вызов прежнего выделения закрывается обычным порядком в СВОЙ учёт");
    refusal(() => call(store, "a2-y", "n-state", 30), "call_not_admitted_horizon_budget"); } finally { done(); } });

test("неизвестный расход резерв НЕ освобождает; известный — закрывает; перерасход виден", () => {
  const { store, done } = fresh(); try { open(store, { budget: 100, blockCap: 100 }); call(store, "c1", "n-state", 60);
    A.settleCall(store, "c1", null, "failed"); assert.equal(left(store).reserved, 60, "сбой без данных о расходе не обнуляет резерв"); refusal(() => call(store, "c2", "n-state", 60), "call_not_admitted_block_cap");
    A.settleCall(store, "c1", U(30, 10)); const u = left(store); assert.deepEqual([u.measured, u.reserved], [40, 0]);
    call(store, "c3", "n-state", 50); assert.equal(A.settleCall(store, "c3", U(50, 9)).code, "spend_over_reserve"); assert.deepEqual(A.auditAdmissions(store, P, ["c1", "c3"]).map(f => f.code), ["spend_over_reserve"]); } finally { done(); } });

test("закрытие однократно — расход нельзя уменьшить повторной доставкой и нельзя записать отрицательным", () => {
  const { store, done } = fresh(); try { open(store, { budget: 100, blockCap: 100 }); call(store, "k", "n-state", 100); A.settleCall(store, "k", U(60, 20));
    refusal(() => A.settleCall(store, "k", U(0, 0)), "settlement_conflict"); assert.equal(left(store).measured, 80); refusal(() => call(store, "k2", "n-state", 100), "call_not_admitted_block_cap");
    assert.equal(A.settleCall(store, "k", U(60, 20)).repeated, true); assert.equal(left(store).measured, 80);
    const { store: s2, done: d2 } = fresh(); try { open(s2, { budget: 100, blockCap: 100 }); call(s2, "neg", "n-state", 50);
      refusal(() => A.settleCall(s2, "neg", U(-10, 0)), "usage_invalid"); refusal(() => A.settleCall(s2, "neg", { inputTokens: 5, outputTokens: 5 }), "usage_invalid"); assert.equal(A.usageOf(s2, P).reserved, 50); } finally { d2(); } } finally { done(); } });

test("аудит вычисляет перерасход из канонического расхода и резерва, а не доверяет статусному полю", () => {
  const { store, done } = fresh(); try { open(store, { budget: 100, blockCap: 100 }); call(store, "w", "n-state", 60); const rec = store.get("w");
    store.write({ id: "w", kind: "model-call", expected: rec.revision, value: { ...rec.value, status: "succeeded", usage: U(60, 10) } });
    assert.deepEqual(A.auditAdmissions(store, P, ["w"]), [{ code: "spend_over_reserve", call: "w", used: 70, reserve: 60 }]); } finally { done(); } });

test("вердикт №2 п.1: неверные значения предохранителей не становятся действующими и ограничений не отключают", () => {
  const { store, done } = fresh(); try { refusal(() => A.openFuses(store, P, { blockCap: "not-a-number", callCap: "not-a-number" }), "fuses_invalid"); refusal(() => A.openFuses(store, P, { blockCap: 0 }), "fuses_invalid"); refusal(() => A.openFuses(store, P, { blockCap: 10, callCap: 20 }), "fuses_invalid");
    open(store, { budget: 100, blockCap: 100 }); for (const patch of [{ blockCap: "not-a-number" }, { callCap: -5 }, { blockCap: 1.5 }, { horizonBudget: "not-a-number" }, { blockCap: null }]) refusal(() => A.raiseFuses(store, P, patch, "основание"), "fuses_invalid");
    assert.equal(store.get("om-fuses:proto").revision, 1, "неверная версия не записана"); call(store, "v1", "n-state", 60); refusal(() => call(store, "v2", "n-recovery", 60), "call_not_admitted_horizon_budget"); } finally { done(); } });

test("вердикт №2 п.2: повтор — тот же вызов с тем же контрактом отправки; другой адаптер, конфигурация или основание оценки — конфликт идентичности", () => {
  const { store, done } = fresh(); try { open(store, { budget: 1000, blockCap: 1000 }); const a = call(store, "d1", "n-state", 10); const b = call(store, "d1", "n-state", 10);
    assert.equal(b.repeated, true); assert.equal(b.admission.hash, a.admission.hash); assert.equal(left(store).reserved, 10);
    const otherAdapter = reference(store.write({ id: "adapter:other", kind: "adapter", expected: 0, value: { name: "other", hardTokenCap: true } })); refusal(() => call(store, "d1", "n-state", 10, { dispatch: { ...DISPATCH, adapter: otherAdapter } }), "call_identity_conflict");
    const cfg = store.get("adapter-config:codex"); const cfg2 = reference(store.write({ id: cfg.id, kind: "adapter-config", expected: cfg.revision, value: { ...cfg.value, effort: "low" } })); refusal(() => call(store, "d1", "n-state", 10, { dispatch: { ...DISPATCH, config: cfg2 } }), "call_identity_conflict");
    const otherBasis = { ...cap(store, 10), basis: [{ id: "policy-b", revision: 1, hash: "b".repeat(64) }] }; refusal(() => call(store, "d1", "n-state", 10, { estimate: otherBasis }), "call_identity_conflict");
    refusal(() => call(store, "d1", "n-recovery", 10), "call_identity_conflict"); refusal(() => call(store, "d1", "n-state", 900), "call_identity_conflict"); assert.equal(left(store).reserved, 10);
    assert.equal(store.get("d1").value.dispatch.adapter.id, "adapter:codex"); refusal(() => call(store, "nodispatch", "n-state", 10, { dispatch: null }), "dispatch_contract_invalid");
    assert.deepEqual(A.auditAdmissions(store, P, ["d1", "ghost"]).map(f => f.code), ["call_without_admission"]); } finally { done(); } });

test("КАЖДЫЙ отказ допуска сохраняется остановкой с причиной, точными версиями лимитов и точкой продолжения", async () => {
  const { hashJson } = await import("../../../dist/src/canonical.js"); const { store, done } = fresh(); try { DISPATCH = dispatchOf(store); const f = A.openFuses(store, P, { blockCap: 100 });
    refusal(() => call(store, "early", "n-state", 10), "allocation_missing"); const alloc = A.openAllocation(store, P, { limit: 100 }, "решение владельца");
    refusal(() => A.admitCall(store, P, { call: "e1", block: "n-state", series: "s", horizon: "H1", estimate: cap(store, 10, "estimated"), dispatch: DISPATCH }), "call_cap_unenforceable");
    call(store, "full", "n-state", 100); refusal(() => call(store, "over", "n-state", 1), "call_not_admitted_block_cap"); refusal(() => call(store, "full", "n-check", 100), "call_identity_conflict");
    const saved = code => store.get(`om-refusal:${hashJson([code === "call_identity_conflict" ? "full" : code === "allocation_missing" ? "early" : code === "call_cap_unenforceable" ? "e1" : "over", code,
      ["call_cap_unenforceable"].includes(code) ? null : reference(f), ["call_cap_unenforceable", "allocation_missing"].includes(code) ? null : reference(alloc)])}`);
    for (const code of ["allocation_missing", "call_cap_unenforceable", "call_not_admitted_block_cap", "call_identity_conflict"]) { const r = saved(code); assert.ok(r, `остановка ${code} сохранена`); assert.ok(r.value.resume && r.value.message); } } finally { done(); } });

test("повышение потолка — новая версия предохранителей по основанию: действует на последующие допуски, учёт не обнуляет", () => {
  const { store, done } = fresh(); try { open(store, { budget: 1000, blockCap: 100 }); call(store, "p1", "n-state", 90); refusal(() => call(store, "p2", "n-state", 50), "call_not_admitted_block_cap");
    refusal(() => A.openFuses(store, P, { blockCap: 1000 }), "fuses_exist"); refusal(() => A.raiseFuses(store, P, { blockCap: 200, callCap: 200 }, ""), "fuses_invalid");
    A.raiseFuses(store, P, { blockCap: 200, callCap: 200 }, "решение владельца: поднять потолок блока"); const adm = call(store, "p2", "n-state", 50);
    assert.equal(adm.admission.value.fuses.revision, 2); assert.equal(store.get("om-admission:p1").value.fuses.revision, 1); assert.equal(blockRow(store, "n-state").reserved, 140); } finally { done(); } });

test("вердикт №3 п.1: смена выделения — одна транзакция; закрытое выделение допусков не выдаёт; повторное открытие работает", () => {
  const { store, done } = fresh(); try { const a1 = open(store, { budget: 100, blockCap: 1000 }); const a2 = A.openAllocation(store, P, { limit: 100 }, "решение владельца №2"); const a3 = A.openAllocation(store, P, { limit: 100 }, "решение владельца №3");
    assert.deepEqual([store.get(a1.id).value.state, store.get(a2.id).value.state, store.get(a3.id).value.state], ["closed", "closed", "active"]); assert.equal(A.activeAllocation(store, P).allocation.id, a3.id);
    const head = store.get("om-allocation-head:proto"); store.write({ id: head.id, kind: "om-allocation-head", expected: head.revision, value: { ...head.value, activeId: a1.id } });      // испорченный указатель на ЗАКРЫТОЕ выделение
    refusal(() => call(store, "stale", "n-state", 10), "allocation_inactive"); assert.equal(store.get("stale"), null); assert.equal(left(store).reserved, 0); } finally { done(); } });

test("вердикт №3 п.2: контракт отправки — точные ссылки на существующие записи; пустые объекты и неразрешимые ссылки — отказ без резерва", () => {
  const { store, done } = fresh(); try { open(store, { budget: 100, blockCap: 100 });
    for (const d of [{ adapter: {}, config: {} }, { adapter: DISPATCH.adapter }, { ...DISPATCH, extra: 1 }, { adapter: { ...DISPATCH.adapter, hash: "xyz" }, config: DISPATCH.config }, { adapter: { ...DISPATCH.adapter, revision: 0 }, config: DISPATCH.config }])
      refusal(() => call(store, "bad", "n-state", 50, { dispatch: d }), "dispatch_contract_invalid");
    refusal(() => call(store, "bad", "n-state", 50, { dispatch: { ...DISPATCH, adapter: { ...DISPATCH.adapter, hash: "0".repeat(64) } } }), "dispatch_contract_unresolved");
    refusal(() => call(store, "bad", "n-state", 50, { dispatch: { ...DISPATCH, config: { id: "adapter-config:нет", revision: 1, hash: "1".repeat(64) } } }), "dispatch_contract_unresolved");
    assert.equal(store.get("bad"), null); assert.equal(left(store).reserved, 0, "ни один резерв не создан"); } finally { done(); } });

test("вердикт №3 п.3: потолок блока СКВОЗНОЙ — новое выделение его не возобновляет; поднять можно только новой версией предохранителей", () => {
  const { store, done } = fresh(); try { open(store, { budget: 1000, blockCap: 100 }); call(store, "b-90", "n-state", 90); A.settleCall(store, "b-90", U(80, 10));
    A.openAllocation(store, P, { limit: 1000 }, "решение владельца: бюджет следующего горизонта"); refusal(() => call(store, "b-again", "n-state", 90), "call_not_admitted_block_cap");
    call(store, "b-small", "n-state", 10); call(store, "fresh-block", "n-recovery", 90); assert.deepEqual([blockRow(store, "n-state").measured, blockRow(store, "n-state").reserved], [90, 10]);
    A.raiseFuses(store, P, { blockCap: 300, callCap: 300 }, "решение владельца: поднять потолок блока"); call(store, "b-after-raise", "n-state", 90); } finally { done(); } });

// ---- переход серий ----
const slices = map => block => map[block];
const prep = (store, choice, hash, map) => A.prepareTransition(store, P, choice, hash, [A.currentSeries(store, P, "B", 2)], slices(map), { seriesAttemptLimit: 3 });
const g2 = (store, choice, hash, passed, t) => ({ project: P, choiceVersion: choice, horizon: reference(A.recordHorizon(store, P, choice, hash, passed)), transition: reference(t) });

test("контрпример ревью: блок исчерпал 3/3, исключение ДРУГОГО блока даёт новую версию горизонта — попытки не возвращаются", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "slice-B", horizonHash: "H1" });
    for (let i = 0; i < 3; i++) A.spendAttempt(store, P, "B", 2); refusal(() => A.spendAttempt(store, P, "B", 2), "repair_attempts_exhausted");
    const t = prep(store, "choice-2", "H2", { B: "slice-B" }); A.applyTransition(store, P, "choice-2", g2(store, "choice-2", "H2", true, t)); const now = A.currentSeries(store, P, "B", 2);
    assert.deepEqual([now.value.line, now.value.attemptsUsed, now.value.horizonHash], [1, 3, "H2"]); refusal(() => A.spendAttempt(store, P, "B", 2), "repair_attempts_exhausted"); } finally { done(); } });

test("подготовленный переход не применён: отказ G2 и принятие горизонта с другим хэшем серии не меняют", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "old", horizonHash: "H1" }); A.spendAttempt(store, P, "B", 2); const before = A.currentSeries(store, P, "B", 2).hash;
    const t2 = prep(store, "c2", "H2", { B: "new" }); assert.equal(A.currentSeries(store, P, "B", 2).hash, before, "подготовка серий не трогает");
    assert.equal(A.applyTransition(store, P, "c2", g2(store, "c2", "H2", false, t2)).transition.value.state, "discarded"); assert.equal(A.currentSeries(store, P, "B", 2).hash, before);
    const t3 = prep(store, "c3", "H3", { B: "new" }); assert.equal(A.applyTransition(store, P, "c3", g2(store, "c3", "H-other", true, t3)).transition.value.state, "discarded"); assert.equal(A.currentSeries(store, P, "B", 2).hash, before); } finally { done(); } });

test("вердикт №1 п.5: исход G2 для одной версии выбора не применяется к другой, даже при одинаковом хэше горизонта", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "old", horizonHash: "H0" }); for (let i = 0; i < 3; i++) A.spendAttempt(store, P, "B", 2);
    const t1 = prep(store, "choice-1", "SAME", { B: "old" }); const r1 = g2(store, "choice-1", "SAME", true, t1); const t2 = prep(store, "choice-2", "SAME", { B: "new" });
    refusal(() => A.applyTransition(store, P, "choice-2", r1), "g2_result_foreign"); refusal(() => A.applyTransition(store, P, "choice-2", { ...r1, choiceVersion: "choice-2" }), "g2_result_foreign");
    refusal(() => A.applyTransition(store, P, "choice-2", { ...r1, choiceVersion: "choice-2", transition: reference(t2) }), "g2_result_foreign");
    assert.deepEqual([A.currentSeries(store, P, "B", 2).value.line, A.currentSeries(store, P, "B", 2).value.attemptsUsed], [1, 3], "линия 2 без исхода G2 для choice-2 не выделена"); } finally { done(); } });

test("срез изменился: новая работа с основанием, предшественником и ЯВНО выделенным лимитом; применяется однократно", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "old", horizonHash: "H1" }); A.spendAttempt(store, P, "B", 2); A.spendAttempt(store, P, "B", 2);
    const t = prep(store, "c2", "H2", { B: "new" }); assert.equal(A.prepareTransition(store, P, "c2", "H2", [], slices({}), { seriesAttemptLimit: 99 }).hash, t.hash, "повторная доставка выбора возвращает ту же подготовку");
    const r = g2(store, "c2", "H2", true, t); A.applyTransition(store, P, "c2", r); const next = A.currentSeries(store, P, "B", 2);
    assert.deepEqual([next.value.line, next.value.attemptsUsed, next.value.attemptLimit, next.value.spentBefore], [2, 0, 3, 2]); assert.ok(next.value.predecessor && next.value.basis);
    assert.equal(A.applyTransition(store, P, "c2", r).repeated, true); assert.equal(A.currentSeries(store, P, "B", 2).value.line, 2, "повторное применение ничего не выделяет"); } finally { done(); } });

test("серия изменилась между подготовкой и применением — переход не применяется, ничего не записано", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "old", horizonHash: "H1" });
    const t = prep(store, "c2", "H2", { B: "new" }); A.spendAttempt(store, P, "B", 2);
    assert.throws(() => A.applyTransition(store, P, "c2", g2(store, "c2", "H2", true, t)), e => ["input_stale", "revision_conflict"].includes(e.code)); assert.equal(A.currentSeries(store, P, "B", 2).value.line, 1); } finally { done(); } });
