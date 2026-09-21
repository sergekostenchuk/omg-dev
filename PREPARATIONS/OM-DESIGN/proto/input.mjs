// Исполняемая спецификация уровня 2 · M1 «входной контракт OM» (прототип). Чистая функция: пять принятых стадий → один типизированный вход.
// Правило карточки M1: битая ссылка — ОТКАЗ (дефект данных, маршрут к производителю стадии); проза на месте идентификатора —
// адресный ПРОБЕЛ с потребителем, в объект она не превращается и не угадывается. Операций M1 не выдумывает.
import { hashJson } from "../../../dist/src/canonical.js";

const STAGES = ["discovery", "concept", "operation-map", "specification", "features"];
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Версия контракта стадии ТЗ, начиная с которой поле nodes ОБЯЗАТЕЛЬНО. Пока стадия не переведена на новый контракт — null:
 *  записей новой эры не существует. Эру определяет версия контракта ТОЧНОЙ записи (content.draft → contractVersion), а не наличие поля. */
export const NODES_REQUIRED_SINCE = null;

export function buildOmInput(stages, { inventory = null, nodesRequiredSince = NODES_REQUIRED_SINCE } = {}) {
  const refusals = [], gaps = []; const refuse = (code, target, message) => refusals.push({ code, target, message }); const gap = (code, target, consumer, message) => gaps.push({ code, target, consumer, message });
  for (const st of STAGES) if (!stages[st]?.ref || !stages[st]?.fields) refuse("input_field_missing", `stage:${st}`, "Нет принятой записи стадии с точной ссылкой");
  if (refusals.length) return { input: null, hash: null, refusals, gaps };
  const F = Object.fromEntries(STAGES.map(st => [st, stages[st].fields])); const need = (st, key) => { const v = F[st][key]; if (v === undefined || v === null) refuse("input_field_missing", `${st}.${key}`, "Обязательное поле стадии отсутствует"); return v; };
  const sections = need("concept", "conceptSections") ?? [], map = need("operation-map", "mapDesign") ?? { nodes: [], artifacts: [] };
  const behavior = need("specification", "behavior") ?? [], bcs = need("specification", "behaviorContracts") ?? [];
  const feats = need("features", "features") ?? [], preps = need("features", "featurePreparation") ?? [], unknowns = F.discovery.preparation?.unknowns ?? [];
  const requirements = sections.flatMap(s => (s.requirements ?? []).map(r => ({ id: r.id, section: s.id, acceptance: r.acceptance ?? [] }))).sort(byId);
  const reqIds = new Set(requirements.map(r => r.id)), nodeIds = new Set(map.nodes.map(n => n.id)), actorIds = new Set((map.actors ?? []).map(a => a.id)), artIds = new Set(map.artifacts.map(a => a.id)), bcIds = new Set(bcs.map(c => c.id));

  // критерии приёмки: у каждого — требование и ВИД проверки (решение владельца 12.09). Строка без вида — пробел, не догадка.
  const criteria = []; for (const r of requirements) r.acceptance.forEach((a, i) => { const c = typeof a === "string" ? { text: a } : a; const id = `${r.id}#${i + 1}`;
    criteria.push({ id, requirement: r.id, checkKind: c.checkKind ?? null }); if (!["test", "full-run", "environment-observation"].includes(c.checkKind)) gap("acceptance_kind_missing", id, { requirement: r.id }, "У критерия приёмки не назван вид проверки"); });

  // контракты поведения: привязка к блокам ТОЛЬКО по id и «один ко многим» (на omg-live 18 из 20 контрактов проходят через несколько блоков)
  // подготовка сопоставляется с фичей по её ИДЕНТИЧНОСТИ (название + исход), как в действующем preparation-validation.ts:66, а не по месту в массиве
  const prepOf = f => preps.filter(p => p.featureTitle === f.title && p.outcome === f.outcome);
  const usedBy = id => feats.map((f, i) => ({ f, i })).filter(({ f }) => prepOf(f).length === 1 && (prepOf(f)[0].behaviorContracts ?? []).includes(id)).map(({ f, i }) => ({ feature: i, title: String(f.title).slice(0, 80) }));
  const newEra = nodesRequiredSince !== null && Number.isInteger(stages.specification.contractVersion) && stages.specification.contractVersion >= nodesRequiredSince;
  const contracts = bcs.map(c => { for (const r of c.requirements ?? []) if (!reqIds.has(r)) refuse("requirement_ref_unresolved", `${c.id}.requirements`, `Требование ${r} не найдено в концепции`);
    if (!artIds.has(c.outcome)) refuse("outcome_artifact_unknown", `${c.id}.outcome`, `Исход ${c.outcome} не является артефактом карты`);
    // правило эры — по ВЕРСИИ контракта точной записи стадии: в новой эре отсутствующее, пустое или неверное поле nodes — отказ; в прежней — пробел
    let nodes = null; const given = c.nodes !== undefined;
    if (Array.isArray(c.nodes) && c.nodes.length && c.nodes.every(n => typeof n === "string")) { for (const n of c.nodes) if (!nodeIds.has(n)) refuse("contract_node_unknown", `${c.id}.nodes`, `Узел ${n} не найден на карте`); nodes = [...new Set(c.nodes)].sort(); }
    else if (newEra || given) refuse("contract_node_unbound", `${c.id}.nodes`, newEra ? "По версии контракта стадии привязка к блокам обязательна" : "Поле привязки задано, но пусто или не список id");
    else gap("contract_node_unbound", c.id, { features: usedBy(c.id) }, "Контракт не привязан к блокам карты по id; упоминание блока в прозе привязкой не считается");
    const proseFields = ["writer", "authority", "rollback"].filter(k => { const v = c.state?.[k]; return !(typeof v === "string" && (nodeIds.has(v) || actorIds.has(v))); });
    if (proseFields.length) gap("contract_boundary_prose", c.id, { features: usedBy(c.id) }, `Граница записана прозой, а не id узла или участника: ${proseFields.join(", ")}`);
    return { id: c.id, nodes, requirements: [...(c.requirements ?? [])].sort(), outcome: c.outcome, actor: c.actor, success: c.success ?? [], failures: c.failures ?? [], forbiddenEffects: c.forbiddenEffects ?? [],
      state: Object.fromEntries(["durability", "writer", "authority", "rollback", "restart", "replay"].map(k => [k, c.state?.[k] ?? null])), proof: c.proof ?? null }; }).sort(byId);

  // фичи: два разных вида ссылок с одним именем requirements разведены явно
  const features = feats.map((f, i) => { for (const n of f.requirements ?? []) if (!Number.isInteger(n) || n < 0 || n >= behavior.length) refuse("behavior_index_out_of_range", `features[${i}].requirements`, `Индекс поведения ${n} вне 0…${behavior.length - 1}`);
    if (!artIds.has(f.outcome)) refuse("outcome_artifact_unknown", `features[${i}].outcome`, `Исход ${f.outcome} не является артефактом карты`);
    const mine = prepOf(f); if (mine.length !== 1) { refuse(mine.length ? "feature_preparation_ambiguous" : "feature_preparation_missing", `features[${i}]`, `Подготовок для фичи «${String(f.title).slice(0, 60)}»: ${mine.length}, нужна ровно одна`); return null; }
    const p = mine[0];
    for (const id of p.behaviorContracts ?? []) if (!bcIds.has(id)) refuse("contract_ref_unresolved", `featurePreparation[${i}].behaviorContracts`, `Контракт ${id} не найден в ТЗ`);
    for (const r of p.requirements ?? []) if (!reqIds.has(r)) refuse("requirement_ref_unresolved", `featurePreparation[${i}].requirements`, `Требование ${r} не найдено в концепции`);
    return { index: i, title: f.title, outcome: f.outcome, behaviorIndexes: [...(f.requirements ?? [])].sort((a, b) => a - b), requirementIds: [...(p.requirements ?? [])].sort(), contracts: [...(p.behaviorContracts ?? [])].sort() }; }).filter(Boolean);

  // вопросы предшественников: у каждого — потребитель; вопрос без потребителя не создаётся
  const questions = [...unknowns.map(u => ({ id: `discovery:${u.id}`, question: u.question, consumer: u.consumer, blocks: !!u.blocksCurrentStage })),
    ...feats.flatMap((f, i) => prepOf(f).length === 1 ? (prepOf(f)[0].remainingQuestions ?? []).map((q, k) => ({ id: `feature:${i}:${k + 1}`, question: q.question, consumer: q.consumer, blocks: !!q.blocksCurrentStage })) : [])].sort(byId);
  for (const q of questions) if (typeof q.consumer !== "string" || !q.consumer.trim()) refuse("question_consumer_missing", q.id, "У вопроса нет потребителя");
  if (!inventory) gap("inventory_missing", "repo-inventory", { mechanism: "M8 реализуемость горизонта" }, "Инвентарь репозитория кодом не собран (решение 12.09 не реализовано)");

  for (const p of preps) if (!feats.some(f => f.title === p.featureTitle && f.outcome === p.outcome)) refuse("feature_preparation_foreign", String(p.featureTitle).slice(0, 60), "Подготовка не относится ни к одной фиче");
  const input = { sources: STAGES.map(st => ({ stage: st, contractVersion: stages[st].contractVersion ?? null, ...stages[st].ref })), inventory: inventory?.ref ?? null, requirements: requirements.map(r => ({ id: r.id, section: r.section })), criteria, contracts, features, questions,
    map: { nodes: [...nodeIds].sort(), artifacts: [...artIds].sort(), connectors: (map.connectors ?? []).map(c => c.id).sort() } };
  return { input, hash: hashJson(input), refusals, gaps: gaps.sort((a, b) => (a.code + a.target < b.code + b.target ? -1 : 1)) };
}
/** G1. Отказ — только при дефектах данных; адресные пробелы ворота не закрывают: они идут в M5 со своими потребителями. */
export const gateInput = result => ({ passed: result.refusals.length === 0, codes: [...new Set(result.refusals.map(r => r.code))].sort() });
