// Исполняемая спецификация двух долгов OMG-ORDER (вердикт №3): G8 «Допуск вызова» и применение перехода серий после G2.
// Учёт резервов НЕ переписан: настоящие configureBudgetSegment, budgetSegment, budgetUsage, reserveResearchCall из dist/
// (решение владельца 12.09: готовые блоки копированием). Отображение: сегмент = горизонт, группа = блок,
// ownerGroupCeiling = blockCap, оценка вызова = callCap. Хранилище — настоящий Store.
import { configureBudgetSegment, budgetSegment, budgetUsage, reserveResearchCall } from "../../../dist/src/runtime/research-budget.js";
import { reference } from "../../../dist/src/pipeline/contracts.js";
import { hashJson } from "../../../dist/src/canonical.js";

export class Refusal extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
const refuse = (code, message) => { throw new Refusal(code, message); };
const plain = v => JSON.parse(JSON.stringify(v));
const CODES = { budget_segment_exhausted: "call_not_admitted_horizon_budget", budget_owner_group_limit: "call_not_admitted_block_cap", budget_question_limit: "call_not_admitted_block_cap" };

/** Предохранители горизонта: сегмент нельзя сбросить пересозданием (это свойство готового кода). */
export const openFuses = (store, project, horizonKey, { horizonBudget, blockCap }) => configureBudgetSegment(store, project, horizonKey, horizonBudget, blockCap, blockCap);

/** G8. До отправки: действующая версия предохранителей, расход + ВСЕ действующие резервы + новый резерв, запись допуска — одной транзакцией. */
export function admitCall(store, project, horizonKey, { call, block, series, estimate }, hooks = {}) {
  if (estimate?.kind !== "guaranteed") refuse("call_cap_unenforceable", "Адаптер не гарантирует верхнюю границу вызова: оценка — не предел");
  for (let attempt = 0; attempt < 3; attempt++) {
    const done = store.get(`om-admission:${call}`); if (done) return { admission: done, repeated: true };      // повторная доставка второй резерв не создаёт
    const segment = budgetSegment(store, project, horizonKey); const before = budgetUsage(store, segment);
    let reserve; try { reserve = reserveResearchCall(store, segment, call, [block], estimate); } catch (e) { if (CODES[e.code]) refuse(CODES[e.code], e.message); throw e; }
    const row = before.groups[block] ?? { measured: 0, reserved: 0 };
    const writes = [...reserve.writes,
      { id: call, kind: "model-call", expected: 0, value: { projectId: project, purpose: "om-call", status: "running", usage: null, budget: { segment: reference(segment), groups: [block], estimate } } },
      { id: `om-admission:${call}`, kind: "call-admission", expected: 0, value: plain({ call, block, series, fuses: reference(segment), reserve: estimate.tokens,
        before: { horizon: { measured: before.measured, reserved: before.reserved }, block: row }, result: "admitted" }) }];
    hooks.beforeWrite?.();
    try { const out = store.writeMany(writes, reserve.guards); return { admission: out[out.length - 1], repeated: false }; }
    catch (e) { if (!["revision_conflict", "input_stale"].includes(e.code)) throw e; }                           // кто-то зарезервировал раньше — пересчитать заново
  }
  refuse("admission_contention", "Допуск не удалось зафиксировать за три попытки");
}

/** После вызова: фактический расход закрывает резерв. Неизвестный расход резерв НЕ освобождает. Перерасход — типизированный дефект среды. */
export function settleCall(store, call, usage, status = "succeeded") {
  const rec = store.get(call); const adm = store.get(`om-admission:${call}`);
  store.write({ id: call, kind: "model-call", expected: rec.revision, value: { ...rec.value, status, usage } });
  const used = usage ? usage.inputTokens + usage.outputTokens : null;
  if (used !== null && used > adm.value.reserve) { store.write({ id: adm.id, kind: "call-admission", expected: adm.revision, value: { ...adm.value, result: "spend_over_reserve", used } }); return { code: "spend_over_reserve", used }; }
  return { code: null, used };
}

/** Механическая проверка критерия успеха 5: у каждого платного вызова есть допуск, сделанный до отправки; расход не выше резерва. */
export function auditAdmissions(store, project, horizonKey, callIds) {
  const usage = budgetUsage(store, budgetSegment(store, project, horizonKey)); const reserved = new Set((usage.ledger?.value.assignments ?? []).map(a => a.call)); const findings = [];
  for (const id of callIds) { const adm = store.get(`om-admission:${id}`);
    if (!adm || !reserved.has(id)) findings.push({ code: "call_without_admission", call: id });
    else if (adm.value.result === "spend_over_reserve") findings.push({ code: "spend_over_reserve", call: id }); }
  return findings;
}

// ---------------- переход серий при смене горизонта ----------------
const seriesId = (project, block, level, line) => `om-series:${hashJson([project, block, level, line])}`;
const transitionId = (project, choiceVersion) => `om-series-transition:${hashJson([project, choiceVersion])}`;
export const openSeries = (store, project, { block, level, line = 1, attemptLimit, sliceHash, horizonHash }) =>
  store.write({ id: seriesId(project, block, level, line), kind: "repair-series", expected: 0, value: { project, block, level, line, attemptsUsed: 0, attemptLimit, sliceHash, horizonHash, predecessor: null, state: "open" } });
export function spendAttempt(store, project, block, level, line = 1) { const s = store.get(seriesId(project, block, level, line));
  if (s.value.attemptsUsed >= s.value.attemptLimit) refuse("repair_attempts_exhausted", `Серия ${block}/${level} исчерпана`);
  return store.write({ id: s.id, kind: "repair-series", expected: s.revision, value: { ...s.value, attemptsUsed: s.value.attemptsUsed + 1 } }); }

/** M2 ГОТОВИТ переход: чистое решение по каждой серии. Ничего в сериях не меняет. Повторная доставка той же версии выбора — та же запись. */
export function prepareTransition(store, project, choiceVersion, horizonHash, seriesList, sliceHashOf, policy) {
  const id = transitionId(project, choiceVersion); const had = store.get(id); if (had) return had;
  const decisions = seriesList.map(s => { const after = sliceHashOf(s.value.block);
    return after === s.value.sliceHash ? { series: reference(s), decision: "continue", sliceHashBefore: s.value.sliceHash, sliceHashAfter: after }
      : { series: reference(s), decision: "new-work", sliceHashBefore: s.value.sliceHash, sliceHashAfter: after, basis: `срез блока ${s.value.block} изменился`, newLimit: policy.seriesAttemptLimit }; });
  return store.write({ id, kind: "series-transition", expected: 0, value: { project, choiceVersion, horizonHash, state: "prepared", decisions } });
}

/** ПРИМЕНЕНИЕ — только для принятой G2 точной версии горизонта, атомарно и однократно. Отказ G2 прежний учёт не меняет. */
export function applyTransition(store, project, choiceVersion, g2) {
  const t = store.get(transitionId(project, choiceVersion)); if (!t) refuse("transition_missing", "Переход для этой версии выбора не подготовлен");
  if (t.value.state !== "prepared") return { transition: t, repeated: true };                                  // уже применён или отброшен — повтор ничего не выделяет
  if (!g2.passed || g2.horizonHash !== t.value.horizonHash) return { transition: store.write({ id: t.id, kind: "series-transition", expected: t.revision, value: { ...t.value, state: "discarded", reason: g2.passed ? "G2 принял другую версию горизонта" : "отказ G2" } }), repeated: false };
  const writes = [{ id: t.id, kind: "series-transition", expected: t.revision, value: { ...t.value, state: "applied" } }]; const guards = [reference(t)];
  for (const d of t.value.decisions) { const s = store.get(d.series.id); guards.push(d.series);                   // серия не должна была измениться с момента подготовки
    if (d.decision === "continue") { writes.push({ id: s.id, kind: "repair-series", expected: s.revision, value: { ...s.value, horizonHash: t.value.horizonHash } }); continue; }
    writes.push({ id: s.id, kind: "repair-series", expected: s.revision, value: { ...s.value, state: "superseded" } });
    writes.push({ id: seriesId(project, s.value.block, s.value.level, s.value.line + 1), kind: "repair-series", expected: 0,
      value: { project, block: s.value.block, level: s.value.level, line: s.value.line + 1, attemptsUsed: 0, attemptLimit: d.newLimit, sliceHash: d.sliceHashAfter, horizonHash: t.value.horizonHash,
        predecessor: d.series, spentBefore: s.value.attemptsUsed, basis: d.basis, state: "open" } }); }
  return { transition: store.writeMany(writes, guards)[0], repeated: false };
}
export const currentSeries = (store, project, block, level) => { for (let line = 50; line >= 1; line--) { const s = store.get(seriesId(project, block, level, line)); if (s) return s; } return null; };
