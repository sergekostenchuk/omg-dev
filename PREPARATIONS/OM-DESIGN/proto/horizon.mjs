// Исполняемая спецификация уровня 2 · M2 «замкнуть горизонт по зависимостям» (прототип). Чистая функция верхнего слоя и выбора владельца.
// Горизонт — набор блоков без зависимости наружу: каждый производитель, нужный блоку горизонта, либо сам в горизонте, либо уже
// по-настоящему раскрыт (готовая зависимость). Исключённый владельцем блок молча не отбрасывается: нужен — конфликт с путём зависимости.
import { hashJson } from "../../../dist/src/canonical.js";

import { controlPredecessors } from "../../../dist/src/graph/dependencies.js";

/** available — блоки, чей РЕЗУЛЬТАТ уже доступен, с подтверждённым основанием (квитанция артефакта): только они останавливают замыкание.
 *  refined — блоки с принятым настоящим раскрытием: раскрытие переиспользуется (M4 заполнит обязательства принятым), но неисполненный
 *  производитель всё равно входит в горизонт — принятие проекта операций не означает, что операции выполнены. */
export function closeHorizon(upper, { choiceVersion, features, excluded = [], refined = new Set(), available = new Map() }) {
  const refusals = []; const blocks = new Map(upper.nodes.filter(n => n.kind === "block").map(n => [n.id, n])); const external = new Set(upper.artifacts.filter(a => a.external).map(a => a.id));
  for (const e of excluded) { if (!blocks.has(e.block)) refusals.push({ code: "horizon_exclusion_unknown", target: e.block });
    if (!String(e.reason ?? "").trim() || !String(e.returnCondition ?? "").trim()) refusals.push({ code: "horizon_exclusion_unjustified", target: e.block }); }
  for (const [block, basis] of available) if (!blocks.has(block) || !basis?.id || !basis?.hash) refusals.push({ code: "horizon_available_unproven", target: block });
  const out = new Set(excluded.map(e => e.block)); const roots = [];
  for (const f of features) { const producers = [...blocks.values()].filter(b => b.outcome === f.outcome); if (!producers.length) refusals.push({ code: "horizon_feature_unknown", target: f.outcome }); roots.push(...producers.map(b => b.id)); }
  // необходимые предшественники: производители по связям данных (внешний источник реализации производителя не требует) И обязательные
  // управляющие зависимости — действующая семантика controlPredecessors (requires, transfers)
  const externalInputs = [];
  const needs = id => [...upper.connectors.flatMap(c => c.bindings.filter(b => b.level === 1 && b.anchor == null && b.consumers.some(e => e.node === id) && b.producer.node !== id).map(b => ({ block: b.producer.node, via: c.id, external: external.has(c.artifact) }))),
    ...controlPredecessors(upper, id).filter(x => blocks.has(x.producer)).map(x => ({ block: x.producer, via: x.id, external: false }))];
  const horizon = new Map(), boundary = new Map(), conflicts = []; const queue = roots.map(r => ({ block: r, path: [r] }));
  while (queue.length) { const { block, path } = queue.shift();
    if (out.has(block)) { conflicts.push({ code: "horizon_requires_excluded", block, path }); continue; }
    if (horizon.has(block)) continue; horizon.set(block, path);
    for (const p of needs(block)) { if (horizon.has(p.block)) continue;
      if (p.external) { externalInputs.push({ consumer: block, connector: p.via, source: p.block }); continue; }     // адрес связи потребителя сохраняется, внутренний производитель не требуется
      if (available.has(p.block) && !out.has(p.block)) { boundary.set(p.block, available.get(p.block)); continue; }  // результат уже есть — подтверждённая граница
      queue.push({ block: p.block, path: [...path, `${p.via}→${p.block}`] }); } }
  const nodes = [...horizon.keys()].sort(); const value = { choiceVersion, features: features.map(f => f.outcome).sort(), nodes, refinement: Object.fromEntries(nodes.map(n => [n, refined.has(n) ? "accepted" : "needed"])),
    boundary: [...boundary].map(([block, basis]) => ({ block, basis })).sort((a, b) => a.block < b.block ? -1 : 1), externalInputs: externalInputs.sort((a, b) => (a.consumer + a.connector < b.consumer + b.connector ? -1 : 1)),
    excluded: [...excluded].map(e => ({ block: e.block, reason: e.reason, returnCondition: e.returnCondition })).sort((a, b) => a.block < b.block ? -1 : 1) };
  return { horizon: { ...value, hash: hashJson(value) }, conflicts, refusals };
}
/** G2. Конфликт исключения и любой отказ — вопрос владельцу: убрать фичу или снять исключение. Повтор той же версии выбора даёт тот же исход. */
export function gateHorizon(r) { const codes = [...new Set([...r.refusals.map(x => x.code), ...r.conflicts.map(x => x.code), ...(r.horizon.nodes.length ? [] : ["horizon_empty"])])].sort(); return { passed: codes.length === 0, codes }; }
