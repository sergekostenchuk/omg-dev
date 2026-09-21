// Уровень 2 · M1 и M2, редакция 4 — по третьему вердикту Codex (OMG-L2-M1M2, запись №100): основание готовности у блока внутри горизонта.
import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id);
const rep = (id, key, from, to) => { const f = by(id).fields; if (f[key].includes(to)) return; if (!f[key].includes(from)) throw new Error(`не найдено в ${id}.${key}: ${from.slice(0, 60)}`); f[key] = f[key].replace(from, to); by(id).size = [W, heightOf(by(id).type, f)]; };
rep("st-horizon", "что хранит", "execution{блок: available | needed} — доступен ли уже результат блока,", "execution{блок: {state: available, basis} | {state: needed}} — доступен ли уже результат блока; у доступного хранится ТОЧНАЯ ссылка на основание (квитанция: id, revision, hash), она входит в хэш горизонта — смена квитанции даёт другой горизонт, даже если блок внутри горизонта, а не на границе,");
rep("f2-close", "что делает", "блок добирается в горизонт ради раскрытия (refinement needed, execution available)", "блок добирается в горизонт ради раскрытия (refinement needed, execution available с сохранённой точной ссылкой на основание: M7 по ней не выводит повторного исполнения, а при несоответствии основания раскрытому производителю — типизированный отказ; тест)");
for (const gid of new Set(s.nodes.map(n => n.group).filter(Boolean))) { const ns = s.nodes.filter(n => n.group === gid).sort((a, b) => a.pos[1] - b.pos[1]); let yy = ns[0].pos[1]; for (const n of ns) { n.pos[1] = yy; yy += n.size[1] + 110; }
  const g = s.groups.find(g => g.id === gid || String(g.title).startsWith(gid)); if (g) g.bounding = [ns[0].pos[0] - 40, ns[0].pos[1] - 80, W + 80, yy - 110 - ns[0].pos[1] + 140]; }
writeFileSync("om-design.json", JSON.stringify(s, null, 1)); console.log("редакция 4 карточек M1/M2 записана");
