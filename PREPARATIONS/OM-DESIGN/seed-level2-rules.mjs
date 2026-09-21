// Уровень 2 · ПРАВИЛА И ПЕРЕДАЧИ — карточки-заметки на полотне и документ LEVEL2-RULES.md из одного источника (level2-rules.mjs). Идемпотентен.
import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
import { RULES, OWNER_DECISIONS } from "./level2-rules.mjs";
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id); s.notes ??= [];
const NW = 820, GAP = 60, X0 = 10080, Y0 = -80; const wrapped = t => t.split("\n").reduce((a, l) => a + Math.max(1, Math.ceil(l.length / 96)), 0); const heightFor = t => Math.max(420, 110 + 22 * wrapped(t));
const COLS = [["rules-general", "rules-m1m2", "rules-m4"], ["rules-handoff-horizon", "rules-m7", "rules-g8"], ["rules-handoff-gaps", "rules-m5", "rules-appendix"]]; let maxH = 0;
COLS.forEach((col, ci) => { let y = Y0; for (const id of col) { const r = RULES.find(x => x.id === id); if (!r) throw new Error(`нет текста ${id}`); const h = heightFor(r.text);
  let n = s.notes.find(x => x.properties?.omd_note === id || x.title === r.title); if (!n) { n = { id: Math.max(0, ...s.notes.map(x => Number(x.id) || 0)) + 1, type: "Note", flags: {}, order: 0, mode: 0, inputs: [], outputs: [], color: "#2f4a3a", bgcolor: "#26332b" }; s.notes.push(n); }
  Object.assign(n, { title: r.title, pos: [X0 + ci * (NW + GAP), y], size: [NW, h], properties: { ...(n.properties ?? {}), omd_note: id }, widgets_values: [r.text] }); y += h + 90; } maxH = Math.max(maxH, y); });
const GT = "Уровень 2 · ПРАВИЛА И ПЕРЕДАЧИ · предмет ревью"; let g = s.groups.find(x => x.title === GT); if (!g) { g = { id: GT, title: GT }; s.groups.push(g); } g.bounding = [X0 - 40, Y0 - 80, 3 * NW + 2 * GAP + 80, maxH - Y0 + 60];
const G8 = s.nodes.find(n => /^G8/.test(n.fields?.["название"] ?? ""))?.id;
for (const d of OWNER_DECISIONS) { const consumer = by(d.consumer) ? d.consumer : d.id === "d-model-cap" ? G8 : null; if (!consumer) throw new Error(`нет потребителя для ${d.id}`);
  let n = by(d.id); if (!n) { n = { id: d.id, type: "owner", fields: {}, pos: [1680, 900000 + s.nodes.length], size: [W, 0], group: "Решения владельца" }; s.nodes.push(n); }
  n.fields = { ...d.fields }; n.size = [W, heightOf("owner", n.fields)];      // источник истины текста решений — level2-rules.mjs
  if (!s.edges.some(e => e.from === d.id && e.to === consumer)) s.edges.push({ from: d.id, to: consumer, kind: "flow" }); }
const HISTORY = " ИСТОРИЯ — РЕШЕНИЕ ВЛАДЕЛЬЦА 21.09.2026 (вечер): потолки токенов, выделения бюджета и лимит числа попыток как РЕГУЛЯТОР работы отменены («лечить нужно не потолком, а тем, что делает модель и как она это делает»; «если продвигаешься — хоть десять проходов; три раза прошёлся и ноль продвижений — останавливать и звать меня»). Действует карточка правил «Вызовы модели · вопрос по делу, учёт, продвижение и остановка»; из описанного здесь в силе остаются только учёт расхода в одной ведомости, однократное закрытие вызова и переход серий после точного G2.";
for (const id of ["gate-admit", "f8-admit", "st-fuses", "st-allocation", "st-admission"]) { const n = by(id); if (!n) throw new Error(`нет карточки ${id}`); const key = Object.keys(n.fields).find(k => k !== "название" && k !== "запись") ?? Object.keys(n.fields)[0];
  if (!n.fields[key].includes("ИСТОРИЯ — РЕШЕНИЕ ВЛАДЕЛЬЦА 21.09.2026 (вечер)")) { n.fields[key] += HISTORY; n.size = [W, heightOf(n.type, n.fields)]; } }
const PROGRESS = " РЕШЕНИЕ ВЛАДЕЛЬЦА 21.09.2026 (вечер): лимита ЧИСЛА попыток нет — «нужно прийти к результату, а не к процессу». Критерий — продвижение по срезу блока: уменьшилось число незакрытых блокирующих пробелов либо набор отказов ворот стал строгим подмножеством прежнего; «состояние изменилось, но ничего не уменьшилось» продвижением не считается. Есть продвижение — работа продолжается, сколько бы попыток ни было; три попытки ПОДРЯД без продвижения — сохранённая остановка и вызов владельца с объяснением, почему стоим. Слова «лимит серии» выше — история.";
for (const id of ["gate-repeat", "store-repairs"]) { const n = by(id); if (!n) throw new Error(`нет карточки ${id}`); const key = Object.keys(n.fields).find(k => k !== "название" && k !== "запись") ?? Object.keys(n.fields)[0];
  if (!n.fields[key].includes("РЕШЕНИЕ ВЛАДЕЛЬЦА 21.09.2026 (вечер): лимита ЧИСЛА попыток нет")) { n.fields[key] += PROGRESS; n.size = [W, heightOf(n.type, n.fields)]; } }
for (const gid of new Set(s.nodes.map(n => n.group).filter(Boolean))) { const ns = s.nodes.filter(n => n.group === gid).sort((a, b) => a.pos[1] - b.pos[1]); let yy = ns[0].pos[1]; for (const n of ns) { n.pos[1] = yy; yy += n.size[1] + 110; }
  const gg = s.groups.find(x => x.id === gid || String(x.title).startsWith(gid)); if (gg) gg.bounding = [ns[0].pos[0] - 40, ns[0].pos[1] - 80, W + 80, yy - 110 - ns[0].pos[1] + 140]; }
writeFileSync("om-design.json", JSON.stringify(s, null, 1));
const md = ["# Уровень 2 карты OM-DESIGN — правила и передачи (предмет ревью)", "", "Собрано из `level2-rules.mjs` скриптом `seed-level2-rules.mjs`; тот же текст — в карточках группы «Уровень 2 · ПРАВИЛА И ПЕРЕДАЧИ» на полотне. Правится только источник.", "",
  ...RULES.flatMap(r => [`## ${r.title.replace("Уровень 2 · ", "")}`, "", "```text", r.text, "```", ""]), "## Открытые решения владельца, названные этим проходом", "",
  ...OWNER_DECISIONS.flatMap(d => [`- **${d.fields["вопрос"]}** ${d.fields["варианты"]}`, ""]), "- **Потолок расхода блока: сквозной по проекту или заново на каждое выделение?** (карточка `d-blockcap-scope`, открыта ранее)", ""].join("\n");
writeFileSync("LEVEL2-RULES.md", md); console.log(`правила засеяны: заметок ${s.notes.length}, узлов ${s.nodes.length}, связей ${s.edges.length}, групп ${s.groups.length}; документ ${md.length} знаков`);
