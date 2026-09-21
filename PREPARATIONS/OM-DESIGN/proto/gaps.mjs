// Исполняемая спецификация уровня 2 · M5 «пробелы» (прототип, не продуктовый модуль). Решение владельца 21.09.2026: КАЖДЫЙ пробел заполняется;
// отсрочка — не отбрасывание, а запись с моментом возвращения. Пробелы приходят из трёх мест в разном виде (вход F1.1, каркас операций F4.4,
// каркас работ F7.2) — здесь они становятся одной записью с потребителем в горизонте, видом знания и маршрутом. Модель в M5 не вызывается.
import { hashJson } from "../../../dist/src/canonical.js";
import { KNOWLEDGE_KINDS } from "../../../dist/src/graph/obligation-policy.js";

/** Моменты разрешения новой схемы (взамен R2/R3 старого om-g2): в проходе OM · при проверке реализуемости · на старте задачи · по результату задачи. */
export const MOMENTS = ["om-pass", "feasibility", "task-start", "task-result"];
const MOMENT = { "repository-fact": "om-pass", "design-decision": "om-pass", "owner-decision": "om-pass", "environment-confirmation": "task-start", "post-implementation-proof": "task-result" };
/** Маршрут — по виду знания, механически (M6): проектное решение нельзя объявить фактом репозитория и наоборот. */
export const ROUTES = { "repository-fact": ["code", "research"], "design-decision": ["design"], "owner-decision": ["owner"], "environment-confirmation": ["environment"], "post-implementation-proof": ["task-result"] };
/** Класс пробела по коду источника: поле и вид знания. Неизвестный код — отказ gap_class_unknown, а не пробел «на глаз». */
export const GAP_CLASSES = {
  contract_node_unbound: { field: "nodes", kind: "design-decision" }, contract_boundary_prose: { field: "boundary", kind: "design-decision" },
  acceptance_kind_missing: { field: "checkKind", kind: "design-decision" }, inventory_missing: { field: "inventory", kind: "repository-fact", moment: "feasibility" },
  obligation_open: { field: "fill", kind: "design-decision" },
  // вопрос предшественника: адресованный (id потребителя и вид знания даны производителем) — пробел своего вида; записанный прозой — сначала адресация
  predecessor_question: { field: "answer", kind: null }, question_unaddressed: { field: "address", kind: "design-decision" },
};
export const gapId = (target, field) => hashJson([target, field]);

/** F5.1. Свести пробелы источников к одной записи. Потребитель — БЛОК горизонта: фича → блоки с её исходом; требование → фичи его контрактов;
 *  узел любого уровня → его блок; механизм OM (например, M8) — потребитель-механизм. Нет ни одного потребителя — отказ, в горизонте нет — отсрочка. */
export function collectGaps({ inputResult = null, frameGaps = [], horizon, graph }) {
  const refusals = [], gaps = []; const H = new Set(horizon.nodes); const N = new Map(graph.nodes.map(n => [n.id, n]));
  const blockOf = id => { let n = N.get(id); while (n && n.kind !== "block") n = N.get(n.parent); return n?.id ?? null; };
  const input = inputResult?.input ?? { features: [], contracts: [] }; const byOutcome = o => graph.nodes.filter(n => n.kind === "block" && n.outcome === o).map(n => n.id);
  const featureBlocks = i => byOutcome(input.features.find(f => f.index === i)?.outcome); const reqBlocks = r => input.features.filter(f => (f.requirementIds ?? []).includes(r)).flatMap(f => byOutcome(f.outcome));
  const resolve = c => typeof c === "string" ? [blockOf(c)].filter(Boolean) : Array.isArray(c?.features) ? c.features.flatMap(f => featureBlocks(f.feature)) : c?.requirement !== undefined ? reqBlocks(c.requirement) : [];
  const push = (src, origin) => { const cls = GAP_CLASSES[src.code]; if (!cls) { refusals.push({ code: "gap_class_unknown", target: src.code }); return; }
    const kind = cls.kind ?? src.kind; if (!KNOWLEDGE_KINDS.includes(kind)) { refusals.push({ code: "gap_kind_unknown", target: String(src.target) }); return; }
    const consumers = [...new Set(resolve(src.consumer))].sort(); const mechanism = src.consumer?.mechanism ?? null;
    if (!consumers.length && !mechanism) { refusals.push({ code: "gap_consumer_missing", target: String(src.target) }); return; }
    const moment = cls.moment ?? MOMENT[kind]; const active = mechanism !== null || consumers.some(b => H.has(b));
    gaps.push({ id: gapId(src.target, cls.field), target: src.target, field: cls.field, code: src.code, kind, routes: ROUTES[kind], moment, consumers, ...(mechanism ? { mechanism } : {}), origin,
      blocking: active && moment === "om-pass", ...(src.node ? { node: src.node } : {}), ...(src.neighbors ? { neighbors: src.neighbors } : {}),
      ...(active ? {} : { deferral: { reason: "outside_horizon", until: "horizon-entry", blocks: consumers } }) }); };
  for (const g of inputResult?.gaps ?? []) push(g, "input");
  // ПУТИ: четвёртый источник — вопросы предыдущих стадий. Потребитель прозой узлом не считается: такой вопрос сначала адресуется (проектное решение, проверяемое кодом)
  for (const q of input.questions ?? []) N.has(q.consumer) && KNOWLEDGE_KINDS.includes(q.kind) ? push({ code: "predecessor_question", target: q.id, kind: q.kind, consumer: q.consumer }, "question")
    : push({ code: "question_unaddressed", target: q.id, consumer: { mechanism: "M5: адресация вопроса предшественника" } }, "question");
  for (const g of frameGaps) push({ code: "obligation_open", target: g.target, consumer: g.consumer, node: g.consumer, neighbors: g.neighbors }, "frame");
  return { gaps: gaps.sort((a, b) => (a.id < b.id ? -1 : 1)), refusals };
}

/** F5.2. Линия пробела между проходами: тот же target и field — тот же пробел со счётчиком проходов, а не новый; исчезнувший — закрыт,
 *  вернувшийся — открыт заново с учётом возвращений. Новые revision, время или порядок линию не меняют. */
export function mergeLines(previous, gaps, pass) {
  const lines = new Map(previous.map(l => [l.id, { ...l }])); const now = new Set(gaps.map(g => g.id));
  for (const g of gaps) { const l = lines.get(g.id); const status = g.deferral ? "deferred" : "open";
    lines.set(g.id, l ? { ...l, passes: l.passes + 1, status, lastPass: pass, reopened: l.reopened + (l.status === "closed" ? 1 : 0) } : { id: g.id, target: g.target, field: g.field, firstPass: pass, lastPass: pass, passes: 1, status, reopened: 0 }); }
  for (const l of lines.values()) if (!now.has(l.id) && l.status !== "closed") lines.set(l.id, { ...l, status: "closed", closedPass: pass });
  return [...lines.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** G4. У каждого пробела потребитель в горизонте или отсрочка с моментом; нет дублей; запись не подделана (id, вид, признак «блокирует»). */
export function gateGaps(result, horizon) {
  const H = new Set(horizon.nodes); const f = result.refusals.map(r => ({ code: r.code, target: r.target })); const seen = new Set();
  for (const g of result.gaps) { if (seen.has(g.id)) f.push({ code: "gap_duplicate", target: g.id }); seen.add(g.id);
    if (g.id !== gapId(g.target, g.field)) f.push({ code: "gap_identity_forged", target: g.id });
    if (!KNOWLEDGE_KINDS.includes(g.kind) || !MOMENTS.includes(g.moment)) f.push({ code: "gap_kind_unknown", target: g.id });
    const active = Boolean(g.mechanism) || g.consumers.some(b => H.has(b));
    if (!g.consumers.length && !g.mechanism) f.push({ code: "gap_consumer_missing", target: g.id });
    else if (!active && !g.deferral) f.push({ code: "gap_outside_horizon", target: g.id });
    if (g.deferral && (!g.deferral.until || active)) f.push({ code: "deferral_without_moment", target: g.id });
    if (g.blocking !== (active && g.moment === "om-pass")) f.push({ code: "gap_blocking_forged", target: g.id }); }
  const codes = [...new Set(f.map(x => x.code))].sort(); return { passed: codes.length === 0, codes, findings: f };
}

/** G4b. Готовность ответов: у каждого блокирующего пробела текущей версии входа — ровно один результат маршрутизации законным маршрутом,
 *  с точной ссылкой на ответ или отсрочкой с моментом. Это готовность оснований для сборки, а не принятие слоя. */
export function gateAnswers(gaps, results, inputHash) {
  const f = []; const by = new Map(gaps.map(g => [g.id, g])); const got = new Map();
  for (const r of results) { if (!by.has(r.gap)) { f.push({ code: "answer_gap_unknown", target: r.gap }); continue; } if (got.has(r.gap)) f.push({ code: "answer_duplicate", target: r.gap }); got.set(r.gap, r); }
  for (const g of gaps.filter(g => g.blocking)) { const r = got.get(g.id); if (!r) { f.push({ code: "answer_missing_for_blocking_gap", target: g.id }); continue; }
    if (r.inputHash !== inputHash) f.push({ code: "answer_version_stale", target: g.id });
    if (!g.routes.includes(r.route)) f.push({ code: "answer_route_foreign", target: g.id });
    const ref = r.answerRef; if (r.deferral ? !r.deferral.until : !(ref?.id && Number.isInteger(ref.revision) && ref.hash)) f.push({ code: r.deferral ? "deferral_without_moment" : "route_result_missing", target: g.id }); }
  const codes = [...new Set(f.map(x => x.code))].sort(); return { passed: codes.length === 0, codes, findings: f };
}
