// Исполняемая спецификация уровня 2 · M5 «пробелы» (прототип, не продуктовый модуль). Решение владельца 21.09.2026: КАЖДЫЙ пробел заполняется;
// отсрочка — не отбрасывание, а запись с условием возвращения. Пробелы приходят из четырёх мест в разном виде (вход F1.1, каркас операций F4.4,
// каркас работ F7.2, вопросы предыдущих стадий) — здесь они становятся одной записью с потребителем в горизонте, видом знания и маршрутом.
// Модель в M5 не вызывается. Редакция 2 (вердикт Codex №1 по M5): ворота НЕ доверяют присланной записи пробела — набор выводится заново из
// источников и сверяется (как пакеты соседей в G5); отсрочку блокирующего пробела результат маршрута дать не может; линия закрывается только с основанием.
import { hashJson } from "../../../dist/src/canonical.js";
import { KNOWLEDGE_KINDS } from "../../../dist/src/graph/obligation-policy.js";
import { isRef } from "../../../dist/src/pipeline/contracts.js";

/** Политика НЕИЗМЕНЯЕМА, выдаваемые записи — копии: проверяемая запись не может изменить доверенную таблицу (вердикт №2 по M5, п.1). */
const deepFreeze = v => { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; };

/** Моменты разрешения новой схемы (взамен R2/R3 старого om-g2): в проходе OM · при проверке реализуемости · на старте задачи · по результату задачи. */
export const MOMENTS = deepFreeze(["om-pass", "feasibility", "task-start", "task-result"]);
const MOMENT = deepFreeze({ "repository-fact": "om-pass", "design-decision": "om-pass", "owner-decision": "om-pass", "environment-confirmation": "task-start", "post-implementation-proof": "task-result" });
/** Маршрут — по виду знания, механически (M6): проектное решение нельзя объявить фактом репозитория и наоборот. */
export const ROUTES = deepFreeze({ "repository-fact": ["code", "research"], "design-decision": ["design"], "owner-decision": ["owner"], "environment-confirmation": ["environment"], "post-implementation-proof": ["task-result"] });
/** Класс пробела по коду источника: поле и вид знания. Неизвестный код — отказ gap_class_unknown, а не пробел «на глаз». */
export const GAP_CLASSES = deepFreeze({
  contract_node_unbound: { field: "nodes", kind: "design-decision" }, contract_boundary_prose: { field: "boundary", kind: "design-decision" },
  acceptance_kind_missing: { field: "checkKind", kind: "design-decision" }, inventory_missing: { field: "inventory", kind: "repository-fact", moment: "feasibility" },
  obligation_open: { field: "fill", kind: "design-decision" },
  // вопрос предшественника: адресованный (id потребителя и вид знания даны производителем или принятым решением об адресации) — пробел своего вида; записанный прозой — сначала адресация
  predecessor_question: { field: "answer", kind: null }, question_unaddressed: { field: "address", kind: "design-decision" },
});
export const gapId = (target, field) => hashJson([target, field]);

/** F5.1. Свести пробелы источников к одной записи. Потребитель — БЛОК горизонта: фича → блоки с её исходом; требование → фичи, которые его несут;
 *  узел любого уровня → его блок; механизм OM (например, M8) — потребитель-механизм. Нет ни одного потребителя — отказ, в горизонте нет — отсрочка.
 *  Несколько источников на одно поле одной цели: одинаковая классификация — одна запись с объединёнными потребителями и происхождением;
 *  противоречащая — отказ gap_class_conflict (первый источник молча не выигрывает). */
export function collectGaps({ inputResult, frameGaps, horizon, graph } = {}) {
  // ОТСУТСТВИЕ: каждый источник приходит ЯВНО — значений по умолчанию нет (вердикт №3 по M5, п.1). Нет поля — отказ gap_source_missing, а не «пробелов нет»;
  // явный пустой список — полученный пустой результат источника
  const missing = !Array.isArray(horizon?.nodes) ? "horizon" : !Array.isArray(graph?.nodes) ? "graph" : !Array.isArray(frameGaps) ? "frameGaps"
    : !inputResult || !Array.isArray(inputResult.gaps) || !inputResult.input ? "inputResult" : !Array.isArray(inputResult.input.questions) || !Array.isArray(inputResult.input.features) ? "inputResult.input" : null;
  if (missing) return { gaps: [], refusals: [{ code: "gap_source_missing", target: missing }] };
  const refusals = [], found = new Map(); const H = new Set(horizon.nodes); const N = new Map(graph.nodes.map(n => [n.id, n]));
  const blockOf = id => { let n = N.get(id); while (n && n.kind !== "block") n = N.get(n.parent); return n?.id ?? null; };
  const input = inputResult.input; const byOutcome = o => graph.nodes.filter(n => n.kind === "block" && n.outcome === o).map(n => n.id);
  const featureBlocks = i => byOutcome(input.features.find(f => f.index === i)?.outcome); const reqBlocks = r => input.features.filter(f => (f.requirementIds ?? []).includes(r)).flatMap(f => byOutcome(f.outcome));
  const resolve = c => typeof c === "string" ? [blockOf(c)].filter(Boolean) : Array.isArray(c?.features) ? c.features.flatMap(f => featureBlocks(f.feature)) : c?.requirement !== undefined ? reqBlocks(c.requirement) : [];
  const push = (src, origin) => { const cls = Object.hasOwn(GAP_CLASSES, String(src.code)) ? GAP_CLASSES[src.code] : null; if (!cls) { refusals.push({ code: "gap_class_unknown", target: src.code }); return; }
    const kind = cls.kind ?? src.kind; if (!KNOWLEDGE_KINDS.includes(kind)) { refusals.push({ code: "gap_kind_unknown", target: String(src.target) }); return; }
    const consumers = [...new Set(resolve(src.consumer))].sort(); const mechanism = src.consumer?.mechanism ?? null;
    if (!consumers.length && !mechanism) { refusals.push({ code: "gap_consumer_missing", target: String(src.target) }); return; }
    const id = gapId(src.target, cls.field); const prior = found.get(id);
    if (prior) { if (prior.code !== src.code || prior.kind !== kind || (prior.mechanism ?? null) !== mechanism) { refusals.push({ code: "gap_class_conflict", target: id }); return; }
      prior.consumers = [...new Set([...prior.consumers, ...consumers])].sort(); prior.origins = [...new Set([...prior.origins, origin])].sort(); return; }
    found.set(id, { id, target: src.target, field: cls.field, code: src.code, kind, routes: [...ROUTES[kind]], moment: cls.moment ?? MOMENT[kind], consumers, ...(mechanism ? { mechanism } : {}), origins: [origin],
      ...(src.node ? { node: src.node } : {}), ...(src.neighbors ? { neighbors: structuredClone(src.neighbors) } : {}), ...(src.addressedBy ? { addressedBy: structuredClone(src.addressedBy) } : {}) }); };
  for (const g of inputResult.gaps) push(g, "input");
  // ПУТИ: четвёртый источник — вопросы предыдущих стадий. Потребитель прозой узлом не считается: такой вопрос сначала адресуется (проектное решение, проверяемое кодом)
  for (const q of input.questions) N.has(q.consumer) && KNOWLEDGE_KINDS.includes(q.kind) ? push({ code: "predecessor_question", target: q.id, kind: q.kind, consumer: q.consumer, addressedBy: q.addressedBy }, "question")
    : push({ code: "question_unaddressed", target: q.id, consumer: { mechanism: "M5: адресация вопроса предшественника" } }, "question");
  for (const g of frameGaps) push({ code: "obligation_open", target: g.target, consumer: g.consumer, node: g.consumer, neighbors: g.neighbors }, "frame");
  const gaps = [...found.values()].map(g => { const active = Boolean(g.mechanism) || g.consumers.some(b => H.has(b));
    return { ...g, blocking: active && g.moment === "om-pass", ...(active ? {} : { deferral: { reason: "outside_horizon", until: "horizon-entry", blocks: [...g.consumers] } }) }; });
  return { gaps: gaps.sort((a, b) => (a.id < b.id ? -1 : 1)), refusals };
}

/** F5.3. Применить принятые решения об адресации вопросов: вопрос получает потребителя-узел и вид знания и в следующем проходе становится
 *  обязательством СВОЕГО вида (поле answer). Решение «кому задать вопрос» ответом на вопрос не является. Код проверяет решение, а не верит ему. */
export function applyAddressing(inputResult, decisions, graph) {
  const refusals = []; const N = new Set(graph.nodes.map(n => n.id)); const by = new Map(); const known = new Set((inputResult.input.questions ?? []).map(q => q.id));
  if (!Array.isArray(decisions)) return { result: inputResult, refusals: [{ code: "addressing_invalid", target: "decisions" }] };
  const state = new Map((inputResult.input.questions ?? []).map(q => [q.id, q])); const addressed = q => N.has(q.consumer) && KNOWLEDGE_KINDS.includes(q.kind);
  for (const d of decisions) { const q = state.get(d?.question);
    if (!q || !known.has(d.question) || by.has(d.question) || !N.has(d.consumer) || !KNOWLEDGE_KINDS.includes(d.kind) || !isRef(d.basis)) { refusals.push({ code: "addressing_invalid", target: String(d?.question) }); continue; }
    // переход только из состояния «не адресован»: адресация заполняет НЕДОСТАЮЩИЙ адрес и не переписывает ни сведения производителя, ни принятую адресацию
    // каждое УЖЕ ИЗВЕСТНОЕ поле сохраняется независимо от полноты остальных (вердикт №3 по M5, п.2): нет потребителя — не повод менять вид знания, и наоборот
    if (!q.addressedBy && ((KNOWLEDGE_KINDS.includes(q.kind) && d.kind !== q.kind) || (N.has(q.consumer) && d.consumer !== q.consumer))) { refusals.push({ code: "addressing_overrides_producer", target: q.id }); continue; }
    if (addressed(q)) { if (!q.addressedBy) refusals.push({ code: "addressing_overrides_producer", target: q.id });
      else if (q.consumer !== d.consumer || q.kind !== d.kind || hashJson(q.addressedBy) !== hashJson(d.basis)) refusals.push({ code: "addressing_conflict", target: q.id }); continue; }      // то же решение повторно — без изменений
    by.set(d.question, d); }
  if (!by.size) return { result: inputResult, refusals };
  const questions = (inputResult.input.questions ?? []).map(q => (by.has(q.id) ? { ...q, prose: q.consumer, consumer: by.get(q.id).consumer, kind: by.get(q.id).kind, addressedBy: structuredClone(by.get(q.id).basis) } : q));
  const input = { ...inputResult.input, questions }; return { result: { ...inputResult, input, hash: hashJson(input) }, refusals };
}

/** F5.2. Линия пробела между проходами: тот же target и field — тот же пробел. Закрытие — ТОЛЬКО с основанием перехода: filled (подтверждённое
 *  заполнение) или cancelled (обоснованная отмена требования), со строгой ссылкой. Пробел, которого просто нет в текущем наборе (блок вышел из
 *  горизонта, каркас отдаёт только свою зону), — отложен с пометкой «вне области проверки», а не закрыт. Фиксация прохода идемпотентна: повтор
 *  того же номера прохода счётчик не меняет. Счётчик проходов — не счётчик попыток серии G7: тот ведётся отдельно (admission.mjs). */
export function mergeLines(previous, gaps, pass, closures = []) {
  // statePass — последний проход, обработавший СОСТОЯНИЕ линии (появление, отсрочка, закрытие); lastPass — последнее появление пробела. Запоздавший проход
  // сверяется со statePass: более позднее закрытие или отсрочка им не отменяются (вердикт №3 по M5, п.3)
  if (!Number.isSafeInteger(pass) || pass < 1 || previous.some(l => (l.statePass ?? l.lastPass) > pass)) return { lines: previous, refusals: [{ code: "pass_out_of_order", target: String(pass) }] };
  const lines = new Map(previous.map(l => [l.id, { ...l }])); const now = new Set(gaps.map(g => g.id)); const refusals = []; const close = new Map();
  for (const c of closures) { if (!lines.has(c.id) || now.has(c.id) || !["filled", "cancelled"].includes(c.reason) || !isRef(c.basis) || close.has(c.id)) { refusals.push({ code: "closure_invalid", target: String(c.id) }); continue; } close.set(c.id, c); }
  for (const g of gaps) { const l = lines.get(g.id); const status = g.deferral ? "deferred" : "open"; const { scope, closedPass, closedBy, basis, ...rest } = l ?? {};
    lines.set(g.id, l ? { ...rest, passes: l.passes + (l.lastPass === pass ? 0 : 1), status, lastPass: pass, statePass: pass, reopened: l.reopened + (l.status === "closed" ? 1 : 0) } : { id: g.id, target: g.target, field: g.field, firstPass: pass, lastPass: pass, statePass: pass, passes: 1, status, reopened: 0 }); }
  for (const l of [...lines.values()]) { if (now.has(l.id)) continue; if (l.status === "closed") { lines.set(l.id, { ...l, statePass: pass }); continue; } const c = close.get(l.id);
    lines.set(l.id, c ? { ...l, status: "closed", closedPass: pass, closedBy: c.reason, basis: structuredClone(c.basis), statePass: pass } : { ...l, status: "deferred", scope: "absent", statePass: pass }); }
  return { lines: [...lines.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), refusals };
}

/** Сверка присланного набора с выведенным заново из источников: запись пробела сама правил своей проверки не задаёт. */
function derive(sources, claimed = null) {
  const fresh = collectGaps(sources); const f = fresh.refusals.map(r => ({ code: r.code, target: r.target })); if (claimed === null) return { fresh, findings: f };      // G4b: только вывод, сверять нечего
  const want = new Map(fresh.gaps.map(g => [g.id, hashJson(g)])); const seen = new Set();
  for (const g of claimed) { if (seen.has(g.id)) { f.push({ code: "gap_duplicate", target: g.id }); continue; } seen.add(g.id);
    if (!want.has(g.id)) f.push({ code: "gap_foreign", target: String(g.id) }); else if (want.get(g.id) !== hashJson(g)) f.push({ code: "gap_record_forged", target: g.id }); }
  for (const id of want.keys()) if (!seen.has(id)) f.push({ code: "gap_missing", target: id });
  return { fresh, findings: f };
}

/** G4. Присланный набор пробелов равен выведенному заново из источников (подделка id, вида, момента, маршрутов, признака «блокирует», отсрочки,
 *  пропуск и лишний пробел видны); у каждого пробела потребитель в горизонте, механизм или отсрочка с условием возвращения. */
export function gateGaps(result, sources) {
  // ОТСУТСТВИЕ: нет присланного набора или списка отказов — типизированный отказ; эталон сам с собой не сверяется (вердикт №2 по M5, п.3)
  if (!Array.isArray(result?.gaps) || !Array.isArray(result?.refusals) || result.gaps.some(g => !g || typeof g !== "object")) return { passed: false, codes: ["gap_set_missing"], findings: [{ code: "gap_set_missing", target: "gaps" }] };
  const { fresh, findings: f } = derive(sources, result.gaps); const H = new Set(sources?.horizon?.nodes ?? []);
  for (const r of result.refusals) if (!f.some(x => x.code === r.code && x.target === r.target)) f.push({ code: r.code, target: r.target });
  for (const g of fresh.gaps) { const active = Boolean(g.mechanism) || g.consumers.some(b => H.has(b)); if (!active && !g.deferral?.until) f.push({ code: "gap_outside_horizon", target: g.id }); }
  const codes = [...new Set(f.map(x => x.code))].sort(); return { passed: codes.length === 0, codes, findings: f };
}

/** G4b. Готовность ответов. Пробелы берутся НЕ у вызывающего, а выводятся из источников. У каждого блокирующего пробела текущей версии входа — ровно
 *  один результат законным маршрутом со строгой ссылкой на ответ. Отложить блокирующий пробел результат маршрута не может: нужное текущей сборке
 *  переносится только принятым правилом — сменой горизонта (её считает F5.1), а не строкой результата. Проход G4b — готовность оснований, не принятие слоя. */
export function gateAnswers(sources, results) {
  if (!Array.isArray(results) || results.some(r => !r || typeof r !== "object")) return { passed: false, codes: ["answers_missing"], findings: [{ code: "answers_missing", target: "results" }] };
  const { fresh, findings: f } = derive(sources); const inputHash = sources.inputResult?.hash ?? null; const by = new Map(fresh.gaps.map(g => [g.id, g])); const got = new Map();
  for (const r of results) { if (!by.has(r.gap)) { f.push({ code: "answer_gap_unknown", target: String(r.gap) }); continue; } if (got.has(r.gap)) f.push({ code: "answer_duplicate", target: r.gap }); got.set(r.gap, r); }
  for (const g of fresh.gaps.filter(g => g.blocking)) { const r = got.get(g.id); if (!r) { f.push({ code: "answer_missing_for_blocking_gap", target: g.id }); continue; }
    if (r.deferral !== undefined) { f.push({ code: "deferral_not_permitted", target: g.id }); continue; }
    if (r.inputHash !== inputHash) f.push({ code: "answer_version_stale", target: g.id });
    if (!g.routes.includes(r.route)) f.push({ code: "answer_route_foreign", target: g.id });
    if (!isRef(r.answerRef)) f.push({ code: "route_result_missing", target: g.id }); }
  const codes = [...new Set(f.map(x => x.code))].sort(); return { passed: codes.length === 0, codes, findings: f };
}
