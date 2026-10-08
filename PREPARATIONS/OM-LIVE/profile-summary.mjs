#!/usr/bin/env node
// Сводка профилей процессора движка: node profile-summary.mjs <папка с *.cpuprofile> [--top 40] [--focus <функция>]
// Складывает все окна: включённое время по функциям движка (dist/src), собственное время, частые цепочки вызовов движка.
// --focus <имя>: только выборки, в стеке которых есть эта функция, — кто её вызывает и что внутри.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const TOP = Number(opt.top ?? 40), FOCUS = opt.focus ?? null;
const engineFrame = f => /\/dist\/src\//.test(f.url || "");
const key = f => `${f.functionName || "(anon)"} ${(f.url || "").replace(/^.*\/dist\//, "").replace(/^file:\/\//, "")}:${f.lineNumber + 1}`;

const incl = new Map(), self = new Map(), stacks = new Map(), callers = new Map();
let total = 0, us = 0, files = 0;
for (const name of readdirSync(dir).filter(f => f.endsWith(".cpuprofile")).sort()) {
  const p = JSON.parse(readFileSync(join(dir, name), "utf8")); files++;
  const nodes = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  us += p.endTime - p.startTime;
  for (const s of p.samples) {
    const chain = [];
    for (let id = s; id !== undefined; id = parent.get(id)) { const n = nodes.get(id); if (n && n.callFrame.functionName !== "(root)") chain.push(n.callFrame); }
    if (FOCUS && !chain.some(f => f.functionName === FOCUS)) continue;
    total++;
    const leaf = chain[0]; if (leaf) self.set(key(leaf), (self.get(key(leaf)) ?? 0) + 1);
    const seen = new Set(), path = [];
    for (const f of chain) {
      if (!engineFrame(f)) continue;
      const k = key(f); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + 1); }
      if (path.at(-1) !== f.functionName) path.push(f.functionName || "(anon)");
    }
    const sk = path.slice(0, 14).join(" ← "); stacks.set(sk, (stacks.get(sk) ?? 0) + 1);
    if (FOCUS) { const i = chain.findIndex(f => f.functionName === FOCUS); const up = chain.slice(i + 1).filter(engineFrame).slice(0, 4).map(f => f.functionName).join(" ← "); callers.set(up, (callers.get(up) ?? 0) + 1); }
  }
}
const pct = v => `${(v / total * 100).toFixed(1).padStart(5)}%`;
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${pct(v)}  ${k}`);
console.log(`окон ${files}, ${(us / 1e6 / 60).toFixed(1)} мин записи, выборок ${total}${FOCUS ? ` (только со стеком ${FOCUS})` : ""}`);
console.log("\n== Включённое время по функциям движка ==\n" + top(incl, TOP).join("\n"));
console.log("\n== Собственное время ==\n" + top(self, 15).join("\n"));
console.log("\n== Частые цепочки движка (лист ← корень) ==\n" + top(stacks, 12).join("\n"));
if (FOCUS) console.log(`\n== Кто вызывает ${FOCUS} ==\n` + top(callers, 12).join("\n"));
