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
const call = (store, id, block, tokens, extra = {}) => A.admitCall(store, P, { call: id, block, series: "s1", horizon: "H1", estimate: cap(store, tokens), ...extra });
const refusal = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `ожидался ${code}, получено ${e.code}: ${e.message}`); return true; });
const left = store => A.usageOf(store, P);

test("контрпример ревью: лимит 100, два резерва по 60 — второй не допускается, пока первый не закрыт", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 100, blockCap: 100 }); call(store, "call-1", "n-state", 60);
    refusal(() => call(store, "call-2", "n-recovery", 60), "call_not_admitted_horizon_budget"); assert.equal(left(store).reserved, 60); assert.equal(store.get("call-2"), null, "недопущенный вызов не создан"); } finally { done(); } });

test("одновременность: два допуска по одному снимку не проходят оба — второй пересчитывается и получает отказ", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 100, blockCap: 100 }); let raced = false;
    refusal(() => A.admitCall(store, P, { call: "slow", block: "n-state", series: "s1", horizon: "H1", estimate: cap(store, 60) },
      { beforeWrite: () => { if (!raced) { raced = true; call(store, "fast", "n-state", 60); } } }), "call_not_admitted_block_cap");
    assert.ok(store.get("om-admission:fast")); assert.equal(store.get("om-admission:slow"), null); assert.equal(left(store).reserved, 60); } finally { done(); } });

test("потолок блока действует отдельно от бюджета линии; предел одного вызова — отдельный предохранитель", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 1000, blockCap: 100, callCap: 80 }); call(store, "b1", "n-state", 70);
    refusal(() => call(store, "b2", "n-state", 40), "call_not_admitted_block_cap"); call(store, "other", "n-recovery", 40); refusal(() => call(store, "big", "n-check", 90), "call_not_admitted_call_cap"); } finally { done(); } });

test("вердикт №1 п.1: новая версия горизонта НЕ обнуляет учёт блока — расход и резервы прежней версии считаются", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 1000, blockCap: 100 });
    call(store, "h1-a", "n-state", 40); A.settleCall(store, "h1-a", U(30, 10)); call(store, "h1-b", "n-state", 20);                 // H1: потрачено 40, зарезервировано 20
    refusal(() => call(store, "h2-a", "n-state", 60, { horizon: "H2" }), "call_not_admitted_block_cap");                            // H2: тот же блок — 40 + 20 + 60 > 100
    call(store, "h2-b", "n-state", 40, { horizon: "H2" }); const row = left(store).groups["n-state"]; assert.deepEqual([row.measured, row.reserved], [40, 60]); } finally { done(); } });

test("неизвестный расход резерв НЕ освобождает; известный — закрывает; перерасход виден", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 100, blockCap: 100 }); call(store, "c1", "n-state", 60);
    A.settleCall(store, "c1", null, "failed"); assert.equal(left(store).reserved, 60, "сбой без данных о расходе не обнуляет резерв"); refusal(() => call(store, "c2", "n-state", 60), "call_not_admitted_block_cap");
    A.settleCall(store, "c1", U(30, 10)); const u = left(store); assert.deepEqual([u.measured, u.reserved], [40, 0]);
    call(store, "c3", "n-state", 50); assert.equal(A.settleCall(store, "c3", U(50, 9)).code, "spend_over_reserve"); assert.deepEqual(A.auditAdmissions(store, P, ["c1", "c3"]).map(f => f.code), ["spend_over_reserve"]); } finally { done(); } });

test("вердикт №1 п.2: закрытие однократно — расход нельзя уменьшить повторной доставкой и нельзя записать отрицательным", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 100, blockCap: 100 }); call(store, "k", "n-state", 100); A.settleCall(store, "k", U(60, 20));
    refusal(() => A.settleCall(store, "k", U(0, 0)), "settlement_conflict"); assert.equal(left(store).measured, 80); refusal(() => call(store, "k2", "n-state", 100), "call_not_admitted_block_cap");
    assert.equal(A.settleCall(store, "k", U(60, 20)).repeated, true, "тот же результат возвращает прежний исход"); assert.equal(left(store).measured, 80);
    const { store: s2, done: d2 } = fresh(); try { A.openFuses(s2, P, { horizonBudget: 100, blockCap: 100 }); call(s2, "neg", "n-state", 50);
      refusal(() => A.settleCall(s2, "neg", U(-10, 0)), "usage_invalid"); refusal(() => A.settleCall(s2, "neg", { inputTokens: 5, outputTokens: 5 }), "usage_invalid"); assert.equal(A.usageOf(s2, P).reserved, 50); } finally { d2(); } } finally { done(); } });

test("вердикт №1 п.3: аудит вычисляет перерасход из канонического расхода и резерва, а не доверяет статусному полю", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 100, blockCap: 100 }); call(store, "w", "n-state", 60); const rec = store.get("w");
    store.write({ id: "w", kind: "model-call", expected: rec.revision, value: { ...rec.value, status: "succeeded", usage: U(60, 10) } });     // расход записан в обход закрытия, отметки о перерасходе нет нигде
    assert.deepEqual(A.auditAdmissions(store, P, ["w"]), [{ code: "spend_over_reserve", call: "w", used: 70, reserve: 60 }]); } finally { done(); } });

test("вердикт №1 п.4: повтор — это тот же вызов в том же контексте; то же имя в другом контексте — отказ без нового резерва", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 1000, blockCap: 1000 }); const a = call(store, "d1", "n-state", 10); const b = call(store, "d1", "n-state", 10);
    assert.equal(b.repeated, true); assert.equal(b.admission.hash, a.admission.hash); assert.equal(left(store).reserved, 10);
    refusal(() => call(store, "d1", "n-recovery", 10), "call_identity_conflict"); refusal(() => call(store, "d1", "n-state", 900), "call_identity_conflict");
    refusal(() => A.admitCall(store, P, { call: "d1", block: "n-state", series: "другая", horizon: "H1", estimate: cap(store, 10) }), "call_identity_conflict"); assert.equal(left(store).reserved, 10);
    assert.deepEqual(A.auditAdmissions(store, P, ["d1", "ghost"]).map(f => f.code), ["call_without_admission"]); } finally { done(); } });

test("адаптер без гарантированного предела не допускается; отказ сохраняется остановкой с точной версией предохранителей", async () => {
  const { store, done } = fresh(); try { const f = A.openFuses(store, P, { horizonBudget: 100, blockCap: 100 });
    refusal(() => A.admitCall(store, P, { call: "e1", block: "n-state", series: "s", horizon: "H1", estimate: cap(store, 10, "estimated") }), "call_cap_unenforceable");
    call(store, "full", "n-state", 100); refusal(() => call(store, "over", "n-state", 1), "call_not_admitted_block_cap");
    const stops = store.get(`om-refusal:${(await import("../../../dist/src/canonical.js")).hashJson(["over", "call_not_admitted_block_cap", reference(f)])}`); assert.ok(stops && stops.value.resume && stops.value.fuses.revision === 1); } finally { done(); } });

test("повышение лимита — новая версия предохранителей по основанию: действует на последующие допуски, учёт не обнуляет", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, { horizonBudget: 100, blockCap: 100 }); call(store, "p1", "n-state", 90); refusal(() => call(store, "p2", "n-state", 50), "call_not_admitted_block_cap");
    refusal(() => A.openFuses(store, P, { horizonBudget: 1000, blockCap: 1000 }), "fuses_exist"); refusal(() => A.raiseFuses(store, P, { blockCap: 200, horizonBudget: 200 }, ""), "fuses_basis_missing");
    A.raiseFuses(store, P, { blockCap: 200, horizonBudget: 200 }, "решение владельца: поднять потолок блока"); const adm = call(store, "p2", "n-state", 50);
    assert.equal(adm.admission.value.fuses.revision, 2); assert.equal(store.get("om-admission:p1").value.fuses.revision, 1); assert.equal(left(store).reserved, 140); } finally { done(); } });

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
