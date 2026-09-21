// Исполняемая спецификация уровня 2 · M2 «замкнуть горизонт по зависимостям» (прототип). Чистая функция верхнего слоя и выбора владельца.
// Горизонт — набор блоков без зависимости наружу: каждый производитель, нужный блоку горизонта, либо сам в горизонте, либо уже
// по-настоящему раскрыт (готовая зависимость). Исключённый владельцем блок молча не отбрасывается: нужен — конфликт с путём зависимости.
import { hashJson } from "../../../dist/src/canonical.js";

import { controlPredecessors } from "../../../dist/src/graph/dependencies.js";
import { isRef } from "../../../dist/src/pipeline/contracts.js";

/** available — блоки, чей РЕЗУЛЬТАТ уже доступен: блок → { артефакт: ссылка на квитанцию }. Основание называет КАЖДЫЙ результат блока, нужный горизонту
 *  (вердикт №1 по M7, п.3: «любая квитанция блока» основанием не считается); непокрытый нужный результат — отказ horizon_available_uncovered.
 *  refined — блоки с принятым настоящим раскрытием: раскрытие переиспользуется (M4 заполнит обязательства принятым), но неисполненный
 *  производитель всё равно входит в горизонт — принятие проекта операций не означает, что операции выполнены. */
export function closeHorizon(upper, { choiceVersion, features, excluded = [], refined = new Set(), available = new Map() }) {
  const refusals = []; const blocks = new Map(upper.nodes.filter(n => n.kind === "block").map(n => [n.id, n])); const external = new Set(upper.artifacts.filter(a => a.external).map(a => a.id));
  for (const e of excluded) { if (!blocks.has(e.block)) refusals.push({ code: "horizon_exclusion_unknown", target: e.block });
    if (!String(e.reason ?? "").trim() || !String(e.returnCondition ?? "").trim()) refusals.push({ code: "horizon_exclusion_unjustified", target: e.block }); }
  const proven = isRef;      // действующий строгий контракт ссылки: id, revision > 0, hash из 64 шестнадцатеричных знаков
  for (const [block, basis] of available) if (!blocks.has(block) || !basis || typeof basis !== "object" || !Object.keys(basis).length || !Object.values(basis).every(proven)) refusals.push({ code: "horizon_available_unproven", target: block });
  const out = new Set(excluded.map(e => e.block)); const roots = [];
  for (const f of features) { const producers = [...blocks.values()].filter(b => b.outcome === f.outcome); if (!producers.length) refusals.push({ code: "horizon_feature_unknown", target: f.outcome }); roots.push(...producers.map(b => b.id)); }
  // необходимые предшественники: производители по связям данных (внешний источник реализации производителя не требует) И обязательные
  // управляющие зависимости — действующая семантика controlPredecessors (requires, transfers)
  const needs = id => [...upper.connectors.flatMap(c => c.bindings.filter(b => b.level === 1 && b.anchor == null && b.consumers.some(e => e.node === id) && b.producer.node !== id).map(b => ({ block: b.producer.node, via: c.id, artifact: c.artifact, external: external.has(c.artifact) }))),
    ...controlPredecessors(upper, id).filter(x => blocks.has(x.producer)).map(x => ({ block: x.producer, via: x.id, artifact: blocks.get(x.producer).outcome, external: false }))];
  const horizon = new Map(), boundary = new Map(), conflicts = []; const queue = roots.map(r => ({ block: r, path: [r] }));
  while (queue.length) { const { block, path } = queue.shift();
    if (out.has(block)) { conflicts.push({ code: "horizon_requires_excluded", block, path }); continue; }
    if (horizon.has(block)) continue; horizon.set(block, path);
    for (const p of needs(block)) { if (p.external || horizon.has(p.block)) continue;                               // внешний источник реализации производителя не требует
      // граница пригодна для каркаса, только если у производителя есть И доступный результат, И принятое настоящее раскрытие: иначе M4 не найдёт
      // конкретного подблока-производителя. Доступный, но не раскрытый — добирается в горизонт ради раскрытия (исполнять его не нужно).
      if (available.has(p.block) && refined.has(p.block) && !out.has(p.block)) { boundary.set(p.block, available.get(p.block)); continue; }
      queue.push({ block: p.block, path: [...path, `${p.via}→${p.block}`] }); } }
  // адреса внешних входов — по ОКОНЧАТЕЛЬНОМУ горизонту и всем его привязкам, независимо от порядка обхода и от того, каким путём вошёл источник
  const externalInputs = [...horizon.keys()].flatMap(id => needs(id).filter(p => p.external).map(p => ({ consumer: id, connector: p.via, source: p.block })));
  const covers = (block, artifact) => { const b = available.get(block); return Boolean(b) && Object.hasOwn(b, artifact) && isRef(b[artifact]); };      // только собственное поле основания, не унаследованное
  // покрытие: у блока «результат уже есть» (на границе или внутри горизонта) основание обязано называть каждый артефакт, который берёт у него горизонт
  for (const id of horizon.keys()) for (const p of needs(id)) if (!p.external && p.block !== id && available.has(p.block) && (boundary.has(p.block) || horizon.has(p.block)) && !covers(p.block, p.artifact))
    if (!refusals.some(r => r.code === "horizon_available_uncovered" && r.target === `${p.block}:${p.artifact}`)) refusals.push({ code: "horizon_available_uncovered", target: `${p.block}:${p.artifact}`, via: p.via });
  // исход ВЫБРАННОЙ фичи — тоже требуемый результат: без его основания блок-производитель готовым не объявляется (вердикт №2 по M7, п.3)
  for (const r of roots) { const art = blocks.get(r).outcome; if (available.has(r) && horizon.has(r) && !covers(r, art) && !refusals.some(x => x.code === "horizon_available_uncovered" && x.target === `${r}:${art}`)) refusals.push({ code: "horizon_available_uncovered", target: `${r}:${art}`, via: "feature" }); }
  const nodes = [...horizon.keys()].sort(); const value = { choiceVersion, features: features.map(f => f.outcome).sort(), nodes, refinement: Object.fromEntries(nodes.map(n => [n, refined.has(n) ? "accepted" : "needed"])), // готовность результата — вместе с ТОЧНЫМ основанием: оно входит в хэш горизонта, смена квитанции — другой горизонт (вердикт №3)
    execution: Object.fromEntries(nodes.map(n => [n, available.has(n) ? { state: "available", basis: structuredClone(available.get(n)) } : { state: "needed" }])),
    boundary: [...boundary].map(([block, basis]) => ({ block, basis: structuredClone(basis) })).sort((a, b) => a.block < b.block ? -1 : 1), externalInputs: externalInputs.sort((a, b) => (a.consumer + a.connector < b.consumer + b.connector ? -1 : 1)),
    excluded: [...excluded].map(e => ({ block: e.block, reason: e.reason, returnCondition: e.returnCondition })).sort((a, b) => a.block < b.block ? -1 : 1) };
  return { horizon: { ...value, hash: hashJson(value) }, conflicts, refusals };
}
/** G2. Конфликт исключения и любой отказ — вопрос владельцу: убрать фичу или снять исключение. Повтор той же версии выбора даёт тот же исход. */
export function gateHorizon(r) { const codes = [...new Set([...r.refusals.map(x => x.code), ...r.conflicts.map(x => x.code), ...(r.horizon.nodes.length ? [] : ["horizon_empty"])])].sort(); return { passed: codes.length === 0, codes }; }
