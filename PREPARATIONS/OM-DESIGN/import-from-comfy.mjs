// Воркфлоу ComfyUI -> om-design.json с проверкой «хлеба». Источник истины после правок в ComfyUI.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { TYPES, CLS_TO_TYPE } from "./vocab.mjs";
const [wfPath, specPath] = process.argv.slice(2);
const wf = JSON.parse(readFileSync(wfPath, "utf8"));
const prev = existsSync(specPath) ? JSON.parse(readFileSync(specPath, "utf8")) : { version: 1, nodes: [], edges: [], groups: [] };
const byComfyId = new Map(); const nodes = []; const problems = [];
const notes = wf.nodes.filter(n => n.type === "Note" || n.type === "MarkdownNote");
for (const n of wf.nodes) { const type = CLS_TO_TYPE[n.type]; if (!type) { if (n.type !== "Note" && n.type !== "MarkdownNote") problems.push(`чужой узел ${n.type} #${n.id}, пропущен`); continue; }
  const T = TYPES[type]; const fields = Object.fromEntries(T.fields.map((f, i) => [f, String(n.widgets_values?.[i] ?? "")]));
  const id = n.properties?.omd_id || `${type}-${n.id}`; byComfyId.set(n.id, id);
  nodes.push({ id, type, fields, pos: n.pos, size: n.size, group: n.properties?.omd_group || undefined }); }
const edges = [];
for (const l of wf.links ?? []) { const [, s, slot, t, , ltype] = l; const from = byComfyId.get(s), to = byComfyId.get(t); if (!from || !to) continue;
  const src = nodes.find(n => n.id === from); const outName = TYPES[src.type].outputs[slot];
  const kind = src.type === "gate" ? (slot === 1 ? "gate_fail" : "gate_pass") : (ltype === "RECORD" || ["запись", "выход", "ответ"].includes(outName)) ? "record" : "flow";
  edges.push({ from, to, kind }); }
const groups = (wf.groups ?? []).map(g => ({ id: g.title, title: g.title, bounding: g.bounding }));
// ---- проверка хлеба ----
const consumers = new Map(nodes.map(n => [n.id, 0])); for (const e of edges) consumers.set(e.from, (consumers.get(e.from) ?? 0) + 1);
for (const n of nodes) {
  const f = n.fields; const title = f["название"] || f["стадия"] || f["артефакт"] || f["вопрос"] || f["цель"] || f["запись"] || n.id;
  const isTerminalConsumer = n.type === "stage" && edges.some(e => e.to === n.id && nodes.find(x => x.id === e.from)?.type === "output");
  if (!["output", "goal", "owner"].includes(n.type) && !isTerminalConsumer && (consumers.get(n.id) ?? 0) === 0) problems.push(`нет потребителя: ${n.type} «${title.slice(0, 60)}»`);
  if (n.type === "mechanism" && !f["цель"].trim()) problems.push(`механизм без цели: «${title.slice(0, 60)}»`);
  if (n.type === "model") { if (!f["почему невыводимо"].trim()) problems.push(`вызов модели без обоснования: «${title.slice(0, 60)}»`); if (!f["потребитель"].trim()) problems.push(`вызов модели без потребителя: «${title.slice(0, 60)}»`); }
  if (n.type === "gate" && !f["коды отказа"].trim()) problems.push(`ворота без кодов отказа: «${title.slice(0, 60)}»`);
  if (n.type === "owner" && f["статус"].trim() !== "решено") problems.push(`открытое решение владельца: «${f["вопрос"].slice(0, 70)}»`);
}
const changed = { added: nodes.filter(n => !prev.nodes.some(p => p.id === n.id)).map(n => n.id), removed: prev.nodes.filter(p => !nodes.some(n => n.id === p.id)).map(p => p.id),
  edited: nodes.filter(n => { const p = prev.nodes.find(p => p.id === n.id); return p && JSON.stringify(p.fields) !== JSON.stringify(n.fields); }).map(n => n.id) };
writeFileSync(specPath, JSON.stringify({ version: prev.version ?? 1, title: prev.title ?? "Схема блока OM", importedAt: new Date().toISOString(), source: wfPath, nodes, edges, groups, notes }, null, 1));
console.log(`импорт: узлов ${nodes.length}, рёбер ${edges.length}; добавлено ${changed.added.length}, удалено ${changed.removed.length}, изменено ${changed.edited.length}`);
if (changed.added.length) console.log("  добавлено:", changed.added.join(", ")); if (changed.removed.length) console.log("  удалено:", changed.removed.join(", ")); if (changed.edited.length) console.log("  изменено:", changed.edited.join(", "));
console.log(problems.length ? `проверка хлеба: ${problems.length} замечаний\n  - ` + problems.join("\n  - ") : "проверка хлеба: замечаний нет");
