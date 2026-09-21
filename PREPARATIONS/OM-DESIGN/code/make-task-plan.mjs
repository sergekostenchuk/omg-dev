// Сборка и проверка плана задач блока OM. Запуск из PREPARATIONS/OM-DESIGN:  node code/make-task-plan.mjs
// РИСКИ, которые закрывают проверки: единица карты не попала ни в одну задачу; задача ссылается на несуществующее правило или карточку; цикл зависимостей;
// один файл пишут две задачи, не упорядоченные между собой (два писателя одного пути); задача без цели, путей, тестов. Любая находка — код выхода 1, документ не пишется.
import { readFileSync, writeFileSync } from "node:fs";
import { RULES } from "../level2-rules.mjs";
import { SLICES, TASKS, COMMON_TESTS, MILESTONE } from "./task-plan.mjs";
const map = JSON.parse(readFileSync("om-design.json", "utf8")); const found = []; const ruleIds = new Set(RULES.map(r => r.id)); const nodeIds = new Set(map.nodes.map(n => n.id)); const byId = new Map(TASKS.map(t => [t.id, t]));
const nodeName = id => { const n = map.nodes.find(x => x.id === id); return n ? String(n.fields["название"] ?? n.fields["запись"] ?? n.fields["стадия"] ?? n.id).split(" — ")[0] : id; };

if (byId.size !== TASKS.length) found.push("повторяющийся id задачи");
for (const t of TASKS) {
  if (!SLICES.some(s => s.id === t.slice)) found.push(`${t.id}: нет среза ${t.slice}`);
  for (const k of ["title", "goal"]) if (!String(t[k] ?? "").trim()) found.push(`${t.id}: пустое поле ${k}`);
  for (const k of ["rules", "paths", "tests"]) if (!Array.isArray(t[k]) || !t[k].length) found.push(`${t.id}: пустой список ${k}`);
  for (const r of t.rules ?? []) if (!ruleIds.has(r)) found.push(`${t.id}: нет правила ${r}`);
  for (const u of t.units ?? []) if (!nodeIds.has(u)) found.push(`${t.id}: нет карточки ${u} на карте`);
  for (const a of t.after ?? []) if (!byId.has(a)) found.push(`${t.id}: зависимость от несуществующей задачи ${a}`);
  if (!(t.paths ?? []).some(p => /^test\//.test(p))) found.push(`${t.id}: среди путей нет файла тестов`);
  for (const p of t.paths ?? []) if (/[*?]|\/$/.test(p)) found.push(`${t.id}: путь «${p}» — каталог или шаблон; нужны точные пути файлов`);
  for (const p of t.paths ?? []) if (/^ui\//.test(p)) found.push(`${t.id}: путь в ui/ — UI не трогаем`);
}
// покрытие карты: каждая единица и запись уровня 1–2 должна быть в units хотя бы одной задачи
const covered = new Set(TASKS.flatMap(t => t.units ?? [])); const mustCover = map.nodes.filter(n => ["mechanism", "gate", "model", "store"].includes(n.type)).map(n => n.id);
for (const id of mustCover) if (!covered.has(id)) found.push(`карта: «${nodeName(id)}» (${id}) не попала ни в одну задачу`);
// каждое правило уровня 2 (кроме приложения) названо хотя бы одной задачей
const usedRules = new Set(TASKS.flatMap(t => t.rules)); for (const r of RULES) if (r.id !== "rules-appendix" && !usedRules.has(r.id)) found.push(`правило ${r.id} не названо ни одной задачей`);
// зависимости: цикл и порядок
const order = []; const state = new Map(); const visit = (id, trail) => { if (state.get(id) === 2) return; if (state.get(id) === 1) { found.push(`цикл зависимостей: ${[...trail, id].join(" → ")}`); return; } state.set(id, 1); for (const a of byId.get(id)?.after ?? []) if (byId.has(a)) visit(a, [...trail, id]); state.set(id, 2); order.push(id); };
for (const t of TASKS) visit(t.id, []);
const before = new Map(); const closure = id => { if (before.has(id)) return before.get(id); const s = new Set(); before.set(id, s); for (const a of byId.get(id)?.after ?? []) if (byId.has(a)) { s.add(a); for (const x of closure(a)) s.add(x); } return s; };
// один писатель пути либо упорядоченная цепочка
const writers = new Map(); for (const t of TASKS) for (const p of t.paths ?? []) writers.set(p, [...(writers.get(p) ?? []), t.id]);
for (const [p, ids] of writers) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!closure(ids[i]).has(ids[j]) && !closure(ids[j]).has(ids[i])) found.push(`путь ${p} пишут ${ids[i]} и ${ids[j]}, не упорядоченные между собой`);

if (found.length) { console.log(found.join("\n")); console.log(`\nПЛАН ЗАДАЧ: находок ${found.length} — документ не записан`); process.exit(1); }

const neighbours = t => { const mine = new Set(t.units ?? []); const from = new Set(), to = new Set(); for (const e of map.edges) { if (mine.has(e.to) && !mine.has(e.from)) from.add(nodeName(e.from)); if (mine.has(e.from) && !mine.has(e.to)) to.add(nodeName(e.to)); } return { from: [...from], to: [...to] }; };
const L = []; L.push("# План задач блока OM", "", "Собран из `code/task-plan.mjs` скриптом `code/make-task-plan.mjs`; правится только источник. Основание — принятая карта (вердикт ревьюера №146): `LEVEL2-RULES.md`, карточки единиц и стрелки `om-design.json`.", "",
  "**Как идёт работа.** Оркестратор выдаёт задачу воркеру (новый воркер на каждую задачу, рабочая копия `~/OMG/.omg/worktrees/om-module`, ветка `om/module`); пакет задачи собирает `code/make-task-packet.mjs` — тексты правил подставляются дословно. Сданное проходит проверку оркестратора (пять проходов, `npm run check:backend` на финальных байтах, сигнализатор `channel-check.mjs --code`), затем одно независимое ревью. Подпись владельца — один раз, под этим планом.", "",
  `**Обязательные тесты каждой задачи:** ${COMMON_TESTS.join("; ")}.`, "", `Задач: ${TASKS.length}. Порядок выдачи (по зависимостям): ${order.join(" → ")}.`, "");
for (const s of SLICES) { const ts = TASKS.filter(t => t.slice === s.id); L.push(`## Срез ${s.id} · ${s.title}`, "", `${s.why} Задач: ${ts.length}.`, "");
  for (const t of ts) { const n = neighbours(t); L.push(`### ${t.id} · ${t.title}`, "", `**Цель.** ${t.goal}`, "", `- Правила: ${t.rules.map(r => "`" + r + "`").join(", ")}`, `- Единицы карты: ${(t.units ?? []).map(nodeName).join("; ") || "—"}`,
    `- Получает от: ${n.from.join("; ") || "—"}`, `- Отдаёт: ${n.to.join("; ") || "—"}`, `- Читает записи: ${t.reads.join("; ")}`, `- Пишет записи: ${t.writes.join("; ")}`, `- Разрешённые пути: ${t.paths.map(p => "`" + p + "`").join(", ")}`,
    `- Из движка как есть: ${t.reuse.join("; ") || "—"}`, ...(t.proto?.length ? [`- Пробный код (сценарии, не код к переносу): ${t.proto.join("; ")}`] : []), `- После: ${(t.after ?? []).join(", ") || "—"}`,
    ...(t.engine ? [`- **Изменение движка:** ${t.engine}`] : []), ...(t.open ? [`- **Уточнить до выдачи:** ${t.open}`] : []), "- Тесты сверх обязательных:", ...t.tests.map(x => `  - ${x}`), ""); } }
L.push(`## ${MILESTONE.title}`, "", MILESTONE.how, "", `После: ${MILESTONE.after.join(", ")}.`, "");
writeFileSync("code/TASK-PLAN.md", L.join("\n")); const eng = TASKS.filter(t => t.engine).map(t => t.id), open = TASKS.filter(t => t.open).map(t => t.id);
console.log(`ПЛАН ЗАДАЧ: находок 0 · задач ${TASKS.length} в ${SLICES.length} срезах · единиц карты покрыто ${mustCover.length} из ${mustCover.length} · правил названо ${usedRules.size} · с изменением движка: ${eng.join(", ")} · уточнить до выдачи: ${open.join(", ")}`);
