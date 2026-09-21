// Тесты двух долгов OMG-ORDER. Всё во временном Store; настоящая база не читается вовсе.
// Запуск: node --test PREPARATIONS/OM-DESIGN/proto/admission.test.mjs   (нужен собранный dist/)
import test from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Store } from "../../../dist/src/storage/store.js"; import { reference } from "../../../dist/src/pipeline/contracts.js";
import { budgetUsage, budgetSegment } from "../../../dist/src/runtime/research-budget.js";
import * as A from "./admission.mjs";

const P = "proto", H = "horizon-v1";
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "om-adm-")); const store = new Store(join(dir, "s.sqlite")); return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } }; };
const basis = store => [reference(store.get("policy") ?? store.write({ id: "policy", kind: "om-policy", expected: 0, value: { version: 1 } }))];
const cap = (store, tokens, kind = "guaranteed") => ({ kind, tokens, basis: basis(store), explanation: "жёсткий предел вызова, заданный средой" });
const refusal = (fn, code) => assert.throws(fn, e => { assert.equal(e.code, code, `ожидался ${code}, получено ${e.code}: ${e.message}`); return true; });
const left = store => budgetUsage(store, budgetSegment(store, P, H));

test("контрпример ревью: лимит 100, два резерва по 60 — второй не допускается, пока первый не закрыт (вердикт №3 OMG-ORDER, п.1)", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, H, { horizonBudget: 100, blockCap: 100 });
    A.admitCall(store, P, H, { call: "call-1", block: "n-state", series: "s1", estimate: cap(store, 60) });
    refusal(() => A.admitCall(store, P, H, { call: "call-2", block: "n-recovery", series: "s2", estimate: cap(store, 60) }), "call_not_admitted_horizon_budget");
    assert.equal(left(store).reserved, 60); assert.equal(store.get("call-2"), null, "недопущенный вызов не создан и не отправлен"); } finally { done(); } });

test("одновременность: два допуска, посчитанные по одному снимку, не проходят оба — второй пересчитывается и получает отказ", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, H, { horizonBudget: 100, blockCap: 100 }); let raced = false;
    refusal(() => A.admitCall(store, P, H, { call: "slow", block: "n-state", series: "s1", estimate: cap(store, 60) },
      { beforeWrite: () => { if (!raced) { raced = true; A.admitCall(store, P, H, { call: "fast", block: "n-state", series: "s1", estimate: cap(store, 60) }); } } }), "call_not_admitted_horizon_budget");
    assert.ok(store.get("om-admission:fast")); assert.equal(store.get("om-admission:slow"), null); assert.equal(left(store).reserved, 60); } finally { done(); } });

test("потолок блока действует отдельно от бюджета горизонта; чужие средства горизонта его не расширяют", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, H, { horizonBudget: 1000, blockCap: 100 });
    A.admitCall(store, P, H, { call: "b1", block: "n-state", series: "s", estimate: cap(store, 70) });
    refusal(() => A.admitCall(store, P, H, { call: "b2", block: "n-state", series: "s", estimate: cap(store, 40) }), "call_not_admitted_block_cap");
    A.admitCall(store, P, H, { call: "other", block: "n-recovery", series: "s", estimate: cap(store, 40) }); } finally { done(); } });

test("неизвестный расход резерв НЕ освобождает; известный — закрывает; перерасход — типизированный дефект среды", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, H, { horizonBudget: 100, blockCap: 100 });
    A.admitCall(store, P, H, { call: "c1", block: "n-state", series: "s", estimate: cap(store, 60) });
    A.settleCall(store, "c1", null, "failed"); assert.equal(left(store).reserved, 60, "сбой без данных о расходе не обнуляет резерв");
    refusal(() => A.admitCall(store, P, H, { call: "c2", block: "n-state", series: "s", estimate: cap(store, 60) }), "call_not_admitted_horizon_budget");
    A.settleCall(store, "c1", { inputTokens: 30, outputTokens: 10 }); const u = left(store); assert.deepEqual([u.measured, u.reserved], [40, 0]);
    A.admitCall(store, P, H, { call: "c3", block: "n-state", series: "s", estimate: cap(store, 50) });
    assert.equal(A.settleCall(store, "c3", { inputTokens: 50, outputTokens: 9 }).code, "spend_over_reserve");
    assert.deepEqual(A.auditAdmissions(store, P, H, ["c1", "c3"]).map(f => f.code), ["spend_over_reserve"]); } finally { done(); } });

test("адаптер без гарантированного предела не допускается; повторная доставка вызова второй резерв не создаёт", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, H, { horizonBudget: 100, blockCap: 100 });
    refusal(() => A.admitCall(store, P, H, { call: "e1", block: "n-state", series: "s", estimate: cap(store, 10, "estimated") }), "call_cap_unenforceable");
    const a = A.admitCall(store, P, H, { call: "d1", block: "n-state", series: "s", estimate: cap(store, 60) }); const b = A.admitCall(store, P, H, { call: "d1", block: "n-state", series: "s", estimate: cap(store, 60) });
    assert.equal(b.repeated, true); assert.equal(b.admission.hash, a.admission.hash); assert.equal(left(store).reserved, 60);
    assert.deepEqual(A.auditAdmissions(store, P, H, ["d1", "ghost"]).map(f => f.code), ["call_without_admission"]); } finally { done(); } });

test("предохранители нельзя сбросить пересозданием: повторное открытие сегмента — отказ, учёт сохраняется", () => {
  const { store, done } = fresh(); try { A.openFuses(store, P, H, { horizonBudget: 100, blockCap: 100 }); A.admitCall(store, P, H, { call: "k1", block: "n-state", series: "s", estimate: cap(store, 90) });
    assert.throws(() => A.openFuses(store, P, H, { horizonBudget: 1000, blockCap: 1000 })); assert.equal(left(store).reserved, 90); } finally { done(); } });

// ---- переход серий ----
const slices = map => block => map[block];
test("контрпример ревью: блок исчерпал 3/3, исключение ДРУГОГО блока даёт новую версию горизонта — попытки не возвращаются (вердикт №2 OMG-ORDER)", () => {
  const { store, done } = fresh(); try { const s = A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "slice-B", horizonHash: "H1" });
    for (let i = 0; i < 3; i++) A.spendAttempt(store, P, "B", 2); refusal(() => A.spendAttempt(store, P, "B", 2), "repair_attempts_exhausted");
    A.prepareTransition(store, P, "choice-2", "H2", [A.currentSeries(store, P, "B", 2)], slices({ B: "slice-B" }), { seriesAttemptLimit: 3 });
    A.applyTransition(store, P, "choice-2", { passed: true, horizonHash: "H2" }); const now = A.currentSeries(store, P, "B", 2);
    assert.deepEqual([now.value.line, now.value.attemptsUsed, now.value.horizonHash], [1, 3, "H2"]); refusal(() => A.spendAttempt(store, P, "B", 2), "repair_attempts_exhausted"); } finally { done(); } });

test("подготовленный переход не применён: отказ G2 и принятие ДРУГОЙ версии горизонта серии не меняют (вердикт №3 OMG-ORDER, п.2)", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "old", horizonHash: "H1" }); A.spendAttempt(store, P, "B", 2);
    const before = A.currentSeries(store, P, "B", 2).hash;
    A.prepareTransition(store, P, "c2", "H2", [A.currentSeries(store, P, "B", 2)], slices({ B: "new" }), { seriesAttemptLimit: 3 }); assert.equal(A.currentSeries(store, P, "B", 2).hash, before, "подготовка серий не трогает");
    assert.equal(A.applyTransition(store, P, "c2", { passed: false, horizonHash: "H2" }).transition.value.state, "discarded"); assert.equal(A.currentSeries(store, P, "B", 2).hash, before);
    A.prepareTransition(store, P, "c3", "H3", [A.currentSeries(store, P, "B", 2)], slices({ B: "new" }), { seriesAttemptLimit: 3 });
    assert.equal(A.applyTransition(store, P, "c3", { passed: true, horizonHash: "H-other" }).transition.value.state, "discarded"); assert.equal(A.currentSeries(store, P, "B", 2).hash, before); } finally { done(); } });

test("срез изменился: новая работа с основанием, предшественником и ЯВНО выделенным лимитом; применяется однократно", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "old", horizonHash: "H1" }); A.spendAttempt(store, P, "B", 2); A.spendAttempt(store, P, "B", 2);
    const prep = A.prepareTransition(store, P, "c2", "H2", [A.currentSeries(store, P, "B", 2)], slices({ B: "new" }), { seriesAttemptLimit: 3 });
    assert.equal(A.prepareTransition(store, P, "c2", "H2", [], slices({}), { seriesAttemptLimit: 99 }).hash, prep.hash, "повторная доставка выбора возвращает ту же подготовку");
    A.applyTransition(store, P, "c2", { passed: true, horizonHash: "H2" }); const next = A.currentSeries(store, P, "B", 2);
    assert.deepEqual([next.value.line, next.value.attemptsUsed, next.value.attemptLimit, next.value.spentBefore], [2, 0, 3, 2]); assert.ok(next.value.predecessor && next.value.basis);
    assert.equal(A.applyTransition(store, P, "c2", { passed: true, horizonHash: "H2" }).repeated, true); assert.equal(A.currentSeries(store, P, "B", 2).value.line, 2, "повторное применение ничего не выделяет"); } finally { done(); } });

test("серия изменилась между подготовкой и применением — переход не применяется, ничего не записано", () => {
  const { store, done } = fresh(); try { A.openSeries(store, P, { block: "B", level: 2, attemptLimit: 3, sliceHash: "old", horizonHash: "H1" });
    A.prepareTransition(store, P, "c2", "H2", [A.currentSeries(store, P, "B", 2)], slices({ B: "new" }), { seriesAttemptLimit: 3 }); A.spendAttempt(store, P, "B", 2);
    assert.throws(() => A.applyTransition(store, P, "c2", { passed: true, horizonHash: "H2" }), e => ["input_stale", "revision_conflict"].includes(e.code));
    assert.equal(A.currentSeries(store, P, "B", 2).value.line, 1); } finally { done(); } });
