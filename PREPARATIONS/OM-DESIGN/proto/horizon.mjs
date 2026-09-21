// Исполняемая спецификация уровня 2 · M2 «замкнуть горизонт по зависимостям» (прототип). Чистая функция верхнего слоя и выбора владельца.
// Горизонт — набор блоков без зависимости наружу: каждый производитель, нужный блоку горизонта, либо сам в горизонте, либо уже
// по-настоящему раскрыт (готовая зависимость). Исключённый владельцем блок молча не отбрасывается: нужен — конфликт с путём зависимости.
import { hashJson } from "../../../dist/src/canonical.js";

export function closeHorizon(upper, { choiceVersion, features, excluded = [], refined = new Set() }) {
  const refusals = []; const blocks = new Map(upper.nodes.filter(n => n.kind === "block").map(n => [n.id, n])); const external = new Set(upper.artifacts.filter(a => a.external).map(a => a.id));
  for (const e of excluded) { if (!blocks.has(e.block)) refusals.push({ code: "horizon_exclusion_unknown", target: e.block });
    if (!String(e.reason ?? "").trim() || !String(e.returnCondition ?? "").trim()) refusals.push({ code: "horizon_exclusion_unjustified", target: e.block }); }
  const out = new Set(excluded.map(e => e.block)); const roots = [];
  for (const f of features) { const producers = [...blocks.values()].filter(b => b.outcome === f.outcome); if (!producers.length) refusals.push({ code: "horizon_feature_unknown", target: f.outcome }); roots.push(...producers.map(b => b.id)); }
  // от потребителя к производителю по связям уровня блоков; внешний артефакт производителя на карте не требует
  const producersOf = id => upper.connectors.filter(c => !external.has(c.artifact)).flatMap(c => c.bindings.filter(b => b.level === 1 && b.consumers.some(e => e.node === id)).map(b => ({ block: b.producer.node, connector: c.id })));
  const horizon = new Map(), boundary = new Set(), conflicts = []; const queue = roots.map(r => ({ block: r, path: [r] }));
  while (queue.length) { const { block, path } = queue.shift();
    if (out.has(block)) { conflicts.push({ code: "horizon_requires_excluded", block, path }); continue; }
    if (horizon.has(block)) continue; horizon.set(block, path);
    for (const p of producersOf(block)) { if (p.block === block || horizon.has(p.block)) continue;
      if (refined.has(p.block) && !out.has(p.block)) { boundary.add(p.block); continue; }               // готовая зависимость: переносится принятым раскрытием, в горизонт не добирается
      queue.push({ block: p.block, path: [...path, `${p.connector}→${p.block}`] }); } }
  const nodes = [...horizon.keys()].sort(); const value = { choiceVersion, features: features.map(f => f.outcome).sort(), nodes, boundary: [...boundary].sort(),
    excluded: [...excluded].map(e => ({ block: e.block, reason: e.reason, returnCondition: e.returnCondition })).sort((a, b) => a.block < b.block ? -1 : 1) };
  return { horizon: { ...value, hash: hashJson(value) }, conflicts, refusals };
}
/** G2. Конфликт исключения и любой отказ — вопрос владельцу: убрать фичу или снять исключение. Повтор той же версии выбора даёт тот же исход. */
export function gateHorizon(r) { const codes = [...new Set([...r.refusals.map(x => x.code), ...r.conflicts.map(x => x.code), ...(r.horizon.nodes.length ? [] : ["horizon_empty"])])].sort(); return { passed: codes.length === 0, codes }; }
