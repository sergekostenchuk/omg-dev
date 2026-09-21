// om-design.json -> воркфлоу ComfyUI. Позиции берутся из схемы; у узлов без позиции считается сетка по группам.
import { readFileSync, writeFileSync } from "node:fs";
import { TYPES, EDGE_KINDS, W, heightOf } from "./vocab.mjs";
import { isDiscussion, withFeed } from "./comfy/om_design/web/feed_render.js";
import { readFeedItems } from "./feed-source.mjs";

const [specPath, outPath, flag] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const RELAYOUT = flag === "--relayout";
for (const n of spec.nodes) if (RELAYOUT || !n.size) n.size = [W, heightOf(n.type, n.fields)];
if (RELAYOUT) { // колонки по группам в порядке появления, стопка по высоте
  const cols = [...new Set(spec.nodes.map(n => n.group ?? ""))]; const y = new Map(cols.map(c => [c, 0]));
  for (const n of spec.nodes) { const c = n.group ?? ""; n.pos = [cols.indexOf(c) * (W + 220), y.get(c)]; y.set(c, y.get(c) + n.size[1] + 110); }
  spec.groups = cols.map(c => { const ns = spec.nodes.filter(n => (n.group ?? "") === c); const x0 = Math.min(...ns.map(n => n.pos[0])), y0 = Math.min(...ns.map(n => n.pos[1])); const y1 = Math.max(...ns.map(n => n.pos[1] + n.size[1]));
    const g = (spec.groups ?? []).find(g => g.id === c); return { id: c, title: g?.title ?? c, bounding: [x0 - 40, y0 - 80, W + 80, y1 - y0 + 140] }; });
  writeFileSync(specPath, JSON.stringify(spec, null, 1)); }
const idOf = new Map(spec.nodes.map((n, i) => [n.id, i + 1]));
const links = []; const inputsOf = new Map(); const outLinks = new Map(); let lid = 0;
for (const e of spec.edges) {
  const s = idOf.get(e.from), t = idOf.get(e.to); if (!s || !t) { console.error("ребро на неизвестный узел", e); continue; }
  const src = spec.nodes.find(n => n.id === e.from); const outs = TYPES[src.type].outputs;
  const slot = e.kind === "gate_fail" ? 1 : e.kind === "flow" && outs.length > 1 && outs[1] === "дальше" ? 1 : 0;
  const n = (inputsOf.get(t) ?? []).length + 1; lid++;
  links.push([lid, s, slot, t, n - 1, EDGE_KINDS[e.kind] ?? "FLOW"]);
  inputsOf.set(t, [...(inputsOf.get(t) ?? []), { name: `in_${n}`, type: "*", link: lid, label: e.label ?? e.kind }]);
  outLinks.set(`${s}:${slot}`, [...(outLinks.get(`${s}:${slot}`) ?? []), lid]);
}
const nodes = spec.nodes.map((n, i) => { const id = i + 1; const T = TYPES[n.type];
  const outputs = T.outputs.map((name, k) => ({ name, type: ["запись", "выход", "ответ", "к потребителю"].includes(name) ? "RECORD" : "FLOW", links: outLinks.get(`${id}:${k}`) ?? [], slot_index: k }));
  const ins = inputsOf.get(id) ?? []; for (let k = ins.length; k < T.nIn; k++) ins.push({ name: `in_${k + 1}`, type: "*", link: null });
  return { id, type: T.cls, pos: n.pos ?? [0, 0], size: n.size ?? T.size, flags: {}, order: i, mode: 0, inputs: ins, outputs, properties: { "Node name for S&R": T.cls, omd_id: n.id, omd_group: n.group ?? "" }, widgets_values: T.fields.map(f => n.fields?.[f] ?? ""), color: T.color, bgcolor: T.color }; });
const groups = (spec.groups ?? []).map(g => ({ title: g.title, bounding: g.bounding, color: "#3f4a5a", font_size: 26, flags: {} }));
// карточка обсуждения = история + лента из журнала ревью (проекция); остальные заметки — как есть
const feed = readFeedItems();
let nextId = nodes.length; for (const note of spec.notes ?? []) { const n = { ...note, id: ++nextId, order: nodes.length, inputs: [], outputs: [] };
  if (isDiscussion(n.title)) { const text = withFeed(n.widgets_values?.[0], feed.items, feed.status); n.widgets_values = [text, ...(n.widgets_values ?? []).slice(1)]; if (n.widgets_values_named) n.widgets_values_named = { ...n.widgets_values_named, text }; }
  nodes.push(n); }
writeFileSync(outPath, JSON.stringify({ id: "om-design", revision: 0, last_node_id: nodes.length, last_link_id: lid, nodes, links, groups, config: {}, extra: { ds: { scale: 0.3, offset: [0, 0] }, omd: { version: spec.version, exported: new Date().toISOString() } }, version: 0.4 }, null, 1));
console.log(`экспорт: узлов ${nodes.length}, связей ${links.length}, групп ${groups.length} -> ${outPath}`);
