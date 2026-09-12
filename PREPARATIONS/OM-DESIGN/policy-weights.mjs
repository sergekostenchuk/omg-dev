// Расчёт политики веса: базовые веса (признаки 1–3) и сценарии с конкретными наборами пробелов (признак 4).
// Использование: node policy-weights.mjs <graph.json> [--json out]
import { readFileSync, writeFileSync } from "node:fs";
const g = JSON.parse(readFileSync(process.argv[2], "utf8")); const outJson = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const blocks = g.nodes.filter(n => n.kind === "block"); const ids = new Set(blocks.map(b => b.id));
const path = new Set(g.journeys.find(j => j.id === "jy-owner-success").path);
const dep = Object.fromEntries(blocks.map(b => [b.id, new Set()]));
for (const c of g.connectors) for (const b of c.bindings) if (b.level === 1 && dep[b.producer.node]) for (const x of b.consumers) if (x.node !== b.producer.node && ids.has(x.node)) dep[b.producer.node].add(x.node);
for (const e of g.edges) if (dep[e.target] && ids.has(e.source) && e.source !== e.target) dep[e.target].add(e.source);
const writerFor = {}, rollbackFor = {}; for (const b of blocks) { writerFor[b.boundary.writer] = (writerFor[b.boundary.writer] || 0) + 1; rollbackFor[b.boundary.rollback] = (rollbackFor[b.boundary.rollback] || 0) + 1; }
const durable = new Set(["durable_source", "immutable", "durable_draft"]); const art = Object.fromEntries(g.artifacts.map(a => [a.id, a]));
const maxD = Math.max(...blocks.map(b => dep[b.id].size));
export const base = blocks.map(b => ({ id: b.id, title: b.title, D: dep[b.id].size, Dn: dep[b.id].size / maxD, P: path.has(b.id) ? 1 : 0,
  S: (writerFor[b.id] || rollbackFor[b.id] || (durable.has(art[b.outcome]?.durability) && b.boundary.writer === b.id)) ? 1 : 0 }));
for (const r of base) r.wBase = +(2 * r.Dn + 2 * r.P + 3 * r.S).toFixed(2);
// сценарий: gaps = {blockId: число пробелов}; horizon = набор блоков горизонта (по умолчанию все)
export function scenario(gaps, horizon = null, rule = "v1", H = 20_000_000, CAP = 1_500_000) {
  const inH = r => !horizon || horizon.has(r.id); const rows = base.filter(inH).map(r => ({ ...r, gaps: gaps[r.id] || 0 }));
  const maxG = Math.max(1, ...rows.map(r => r.gaps)); for (const r of rows) r.w = +(r.wBase + 1 * r.gaps / maxG).toFixed(2);
  const wmax = Math.max(...rows.map(r => r.w));
  for (const r of rows) { if (r.gaps === 0) r.gear = 1; else if (rule === "v1") r.gear = r.w < 0.5 * wmax ? 2 : 3; else r.gear = r.wBase < 3 ? 2 : 3; }
  const withGaps = rows.filter(r => r.gaps > 0); const sumW = withGaps.reduce((s, r) => s + r.w, 0);
  for (const r of rows) { r.share = r.gaps > 0 ? r.w / sumW : 0; r.budget = r.gaps > 0 ? Math.min(CAP, Math.round(r.share * H)) : 0; r.attempts = r.gear; }
  return { rows, wmax, gear3: rows.filter(r => r.gear === 3).length, gear2: rows.filter(r => r.gear === 2).length };
}
const fmt = n => n.toLocaleString("ru-RU");
export function tableBase() { return ["блок · зависимых · путь · сост · базовый вес", ...[...base].sort((a, b) => b.wBase - a.wBase).map(r => `${r.id.padEnd(18)} ${String(r.D).padStart(2)}  ${r.P}  ${r.S}  ${String(r.wBase).padStart(5)}  · ${r.title.slice(0, 44)}`)].join("\n"); }
export function tableScenario(name, sc) { const rows = [...sc.rows].filter(r => r.gaps > 0).sort((a, b) => b.w - a.w); return [`${name}: тройка у ${sc.gear3}, двойка у ${sc.gear2}, остальные передача 1`, "блок · пробелов · вес · передача · попыток · бюджет", ...rows.map(r => `${r.id.padEnd(18)} ${String(r.gaps).padStart(2)}  ${String(r.w).padStart(5)}  ${r.gear}  ${r.attempts}  ${fmt(r.budget).padStart(10)}`)].join("\n"); }
if (import.meta.url === `file://${process.argv[1]}`) {
  const all = Object.fromEntries(base.map(r => [r.id, 1])); const one = { "n-spec": 1 };
  const horizonBlocks = new Set(["n-intake", "n-state", "n-control", "n-research", "n-refine", "n-compile", "n-schedule", "n-implement", "n-check", "n-review", "n-publish", "n-recovery"]);
  const hz = { "n-refine": 3, "n-compile": 2, "n-implement": 2, "n-state": 1, "n-recovery": 1 };
  const out = { base: tableBase(),
    "A · один пробел у n-spec, правило v1": tableScenario("A", scenario(one)), "A' · то же, правило v1.1 (абсолютный порог)": tableScenario("A'", scenario(one, null, "v1.1")),
    "B · по одному пробелу у всех, v1": tableScenario("B", scenario(all)), "B' · v1.1": tableScenario("B'", scenario(all, null, "v1.1")),
    "C · горизонт 12 блоков, пробелы у 5, v1": tableScenario("C", scenario(hz, horizonBlocks)), "C' · v1.1": tableScenario("C'", scenario(hz, horizonBlocks, "v1.1")) };
  for (const [k, v] of Object.entries(out)) console.log(`=== ${k} ===\n${v}\n`);
  if (outJson) writeFileSync(outJson, JSON.stringify({ policy: "v1", basis: "graph:omg-live r2", base, scenarios: { A: scenario(one), B: scenario(all), C: scenario(hz, horizonBlocks), "A_v1.1": scenario(one, null, "v1.1"), "B_v1.1": scenario(all, null, "v1.1"), "C_v1.1": scenario(hz, horizonBlocks, "v1.1") } }, null, 1));
}
