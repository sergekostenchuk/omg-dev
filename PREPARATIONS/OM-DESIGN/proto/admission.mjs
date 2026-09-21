// Исполняемая спецификация двух долгов OMG-ORDER (вердикт №3): G8 «Допуск вызова» и применение перехода серий после G2.
// Учёт резервов НЕ переписан: настоящие configureBudgetSegment, budgetSegment, budgetUsage, reserveResearchCall из dist/
// (решение владельца 12.09: готовые блоки копированием). Отображение: сегмент = горизонт, группа = блок,
// ownerGroupCeiling = blockCap, оценка вызова = callCap. Хранилище — настоящий Store.
import { configureBudgetSegment, budgetSegment, budgetUsage, reserveResearchCall } from "../../../dist/src/runtime/research-budget.js";
import { tokenUsage } from "../../../dist/src/runtime/model-usage.js";
import { reference } from "../../../dist/src/pipeline/contracts.js";
import { hashJson } from "../../../dist/src/canonical.js";

export class Refusal extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
const refuse = (code, message) => { throw new Refusal(code, message); };
const plain = v => JSON.parse(JSON.stringify(v));
const CODES = { budget_segment_exhausted: "call_not_admitted_horizon_budget", budget_owner_group_limit: "call_not_admitted_block_cap", budget_question_limit: "call_not_admitted_block_cap" };

const LINE = "om-budget-line";                 // ОДНА ведомость на проект: учёт блока переживает смену версии горизонта и предохранителей
const TECH = 9_000_000_000_000;                // технический предел готового сегмента; действующие лимиты — в записи предохранителей
const fusesId = project => `om-fuses:${project}`;

/** Предохранители — версии одной записи. Новая версия (решение владельца) действует на последующие допуски; учёт при этом НЕ обнуляется. */
export function openFuses(store, project, { horizonBudget, blockCap, callCap = blockCap }, basis = "начальная политика") {
  if (!budgetSegmentOrNull(store, project)) configureBudgetSegment(store, project, LINE, TECH, TECH);
  const had = store.get(fusesId(project)); if (had) refuse("fuses_exist", "Предохранители уже открыты: менять их можно только новой версией (raiseFuses)");
  return store.write({ id: fusesId(project), kind: "om-fuses", expected: 0, value: { project, horizonBudget, blockCap, callCap, basis } });
}
export function raiseFuses(store, project, patch, basis) { const f = store.get(fusesId(project)); if (!basis?.trim()) refuse("fuses_basis_missing", "Новая версия предохранителей требует основания (решение владельца)");
  return store.write({ id: f.id, kind: "om-fuses", expected: f.revision, value: { ...f.value, ...patch, basis } }); }
const budgetSegmentOrNull = (store, project) => { try { return budgetSegment(store, project, LINE); } catch { return null; } };
export const usageOf = (store, project) => budgetUsage(store, budgetSegment(store, project, LINE));
const contextOf = ({ project, block, series, horizon, estimate }) => hashJson([project, block, series, horizon, estimate.kind, estimate.tokens]);

/** Сохранённая остановка: отказ допуска пишется в журнал с причиной, точной версией предохранителей и точкой продолжения. */
function stop(store, code, message, ctx, fuses) { const id = `om-refusal:${hashJson([ctx.call, code, fuses ? reference(fuses) : null])}`;
  if (!store.get(id)) store.write({ id, kind: "om-refusal", expected: 0, value: plain({ code, message, call: ctx.call, block: ctx.block, series: ctx.series, horizon: ctx.horizon,
    fuses: fuses ? reference(fuses) : null, resume: "новая версия предохранителей либо закрытие действующих резервов" }) });
  refuse(code, message); }

/** G8. До отправки: действующая версия предохранителей, расход + ВСЕ действующие резервы + новый резерв — по блоку и по линии, одной транзакцией. */
export function admitCall(store, project, { call, block, series, horizon, estimate }, hooks = {}) {
  const ctx = { project, call, block, series, horizon, estimate };
  if (estimate?.kind !== "guaranteed") stop(store, "call_cap_unenforceable", "Адаптер не гарантирует верхнюю границу вызова: оценка — не предел", ctx, store.get(fusesId(project)));
  for (let attempt = 0; attempt < 3; attempt++) {
    const done = store.get(`om-admission:${call}`);
    if (done) { if (done.value.context !== contextOf(ctx)) refuse("call_identity_conflict", `Вызов ${call} уже допущен в другом контексте: совпадение имени не доказывает повтор`); return { admission: done, repeated: true }; }
    const fuses = store.get(fusesId(project)); if (!fuses) refuse("fuses_missing", "Предохранители проекта не открыты");
    if (estimate.tokens > fuses.value.callCap) stop(store, "call_not_admitted_call_cap", `Предел вызова ${estimate.tokens} выше допустимого ${fuses.value.callCap}`, ctx, fuses);
    const segment = budgetSegment(store, project, LINE); const before = budgetUsage(store, segment); const row = before.groups[block] ?? { measured: 0, reserved: 0 };
    if (row.measured + row.reserved + estimate.tokens > fuses.value.blockCap) stop(store, "call_not_admitted_block_cap", `Блок ${block}: расход ${row.measured} + резервы ${row.reserved} + новый ${estimate.tokens} > ${fuses.value.blockCap}`, ctx, fuses);
    if (before.measured + before.reserved + estimate.tokens > fuses.value.horizonBudget) stop(store, "call_not_admitted_horizon_budget", `Линия: расход ${before.measured} + резервы ${before.reserved} + новый ${estimate.tokens} > ${fuses.value.horizonBudget}`, ctx, fuses);
    const reserve = reserveResearchCall(store, segment, call, [block], estimate);                                   // готовая ведомость: одна запись с проверкой ревизии
    const writes = [...reserve.writes,
      { id: call, kind: "model-call", expected: 0, value: { projectId: project, purpose: "om-call", status: "running", usage: null, budget: { segment: reference(segment), groups: [block], estimate } } },
      { id: `om-admission:${call}`, kind: "call-admission", expected: 0, value: plain({ call, project, block, series, horizon, context: contextOf(ctx), fuses: reference(fuses), reserve: estimate.tokens,
        before: { line: { measured: before.measured, reserved: before.reserved }, block: row } }) }];
    hooks.beforeWrite?.();
    try { const out = store.writeMany(writes, [...reserve.guards, reference(fuses)]); return { admission: out[out.length - 1], repeated: false }; }
    catch (e) { if (!["revision_conflict", "input_stale"].includes(e.code)) throw e; }                           // ведомость или предохранители сменились — пересчитать заново
  }
  refuse("admission_contention", "Допуск не удалось зафиксировать за три попытки");
}

/** Закрытие вызова — ОДНОКРАТНОЕ и одной транзакцией. Счётчики проверяет готовый tokenUsage. Неизвестный расход резерв не освобождает;
 *  тот же окончательный результат возвращает прежний исход; противоречащий — отказ, расход молча не переписывается. */
export function settleCall(store, call, usageInput, status = "succeeded") {
  const usage = tokenUsage(usageInput); const rec = store.get(call); const adm = store.get(`om-admission:${call}`);
  if (!rec || !adm) refuse("call_without_admission", `У вызова ${call} нет допуска`);
  const spent = u => u ? u.inputTokens + u.outputTokens : null;
  if (rec.value.usage) { if (usage && hashJson(usage) === hashJson(rec.value.usage)) return { code: spent(usage) > adm.value.reserve ? "spend_over_reserve" : null, used: spent(usage), repeated: true };
    refuse("settlement_conflict", `Расход вызова ${call} уже зафиксирован (${spent(rec.value.usage)}); другой результат его не переписывает`); }
  store.writeMany([{ id: call, kind: "model-call", expected: rec.revision, value: { ...rec.value, status, usage } }], [reference(adm)]);
  return { code: usage && spent(usage) > adm.value.reserve ? "spend_over_reserve" : null, used: spent(usage), repeated: false };
}

/** Критерий успеха 5 — из КАНОНИЧЕСКИХ данных: запись вызова, ведомость, допуск. Статусным полям аудит не доверяет. */
export function auditAdmissions(store, project, callIds) {
  const reserved = new Set((usageOf(store, project).ledger?.value.assignments ?? []).map(a => a.call)); const findings = [];
  for (const id of callIds) { const adm = store.get(`om-admission:${id}`); const rec = store.get(id);
    if (!adm || !reserved.has(id)) { findings.push({ code: "call_without_admission", call: id }); continue; }
    const used = rec?.value.usage ? rec.value.usage.inputTokens + rec.value.usage.outputTokens : null;
    if (used !== null && used > adm.value.reserve) findings.push({ code: "spend_over_reserve", call: id, used, reserve: adm.value.reserve }); }
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

/** Запись принятого G2 горизонта — то, на что ссылается исход ворот. */
export const horizonId = (project, choiceVersion) => `om-horizon:${hashJson([project, choiceVersion])}`;
export const recordHorizon = (store, project, choiceVersion, horizonHash, passed) => store.write({ id: horizonId(project, choiceVersion), kind: "om-horizon", expected: 0, value: { project, choiceVersion, horizonHash, state: passed ? "accepted" : "refused" } });

/** ПРИМЕНЕНИЕ — только для принятой G2 точной версии: исход привязан к проекту, версии выбора, записи горизонта и подготовленному переходу.
 *  Одинаковый хэш горизонта у другой версии выбора основанием не является. Отказ G2 прежний учёт не меняет. */
export function applyTransition(store, project, choiceVersion, g2) {
  const t = store.get(transitionId(project, choiceVersion)); if (!t) refuse("transition_missing", "Переход для этой версии выбора не подготовлен");
  if (t.value.state !== "prepared") return { transition: t, repeated: true };                                  // уже применён или отброшен — повтор ничего не выделяет
  const hz = g2.horizon ? store.get(g2.horizon.id, g2.horizon.revision) : null;
  if (g2.project !== project || g2.choiceVersion !== choiceVersion || !hz || hz.hash !== g2.horizon.hash || hz.id !== horizonId(project, choiceVersion)
    || hashJson(g2.transition ?? null) !== hashJson(reference(t))) refuse("g2_result_foreign", "Исход G2 выдан не на эту версию выбора, не на эту запись горизонта или не на этот подготовленный переход");
  if (hz.value.state !== "accepted" || hz.value.horizonHash !== t.value.horizonHash) return { transition: store.write({ id: t.id, kind: "series-transition", expected: t.revision, value: { ...t.value, state: "discarded", reason: hz.value.state === "accepted" ? "принят горизонт с другим хэшем" : "отказ G2" } }), repeated: false };
  const writes = [{ id: t.id, kind: "series-transition", expected: t.revision, value: { ...t.value, state: "applied", horizon: reference(hz) } }]; const guards = [reference(t), reference(hz)];
  for (const d of t.value.decisions) { const s = store.get(d.series.id); guards.push(d.series);                   // серия не должна была измениться с момента подготовки
    if (d.decision === "continue") { writes.push({ id: s.id, kind: "repair-series", expected: s.revision, value: { ...s.value, horizonHash: t.value.horizonHash } }); continue; }
    writes.push({ id: s.id, kind: "repair-series", expected: s.revision, value: { ...s.value, state: "superseded" } });
    writes.push({ id: seriesId(project, s.value.block, s.value.level, s.value.line + 1), kind: "repair-series", expected: 0,
      value: { project, block: s.value.block, level: s.value.level, line: s.value.line + 1, attemptsUsed: 0, attemptLimit: d.newLimit, sliceHash: d.sliceHashAfter, horizonHash: t.value.horizonHash,
        predecessor: d.series, spentBefore: s.value.attemptsUsed, basis: d.basis, state: "open" } }); }
  return { transition: store.writeMany(writes, guards)[0], repeated: false };
}
export const currentSeries = (store, project, block, level) => { for (let line = 50; line >= 1; line--) { const s = store.get(seriesId(project, block, level, line)); if (s) return s; } return null; };
