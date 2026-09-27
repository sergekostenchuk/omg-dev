// Сборка и проверка плана задач блока OM. Запуск из PREPARATIONS/OM-DESIGN:  node code/make-task-plan.mjs
// РИСКИ, которые закрывают проверки: единица карты не попала ни в одну задачу; задача ссылается на несуществующее правило или карточку; цикл зависимостей;
// один файл пишут две задачи, не упорядоченные между собой (два писателя одного пути); задача без цели, путей, тестов. Любая находка — код выхода 1, документ не пишется.
import { readFileSync, writeFileSync } from "node:fs";
import { RULES } from "../level2-rules.mjs";
import { SLICES, TASKS, COMMON_TESTS, MILESTONE } from "./task-plan.mjs";
const map = JSON.parse(readFileSync("om-design.json", "utf8")); const found = []; const ruleIds = new Set(RULES.map(r => r.id)); const nodeIds = new Set(map.nodes.map(n => n.id)); const byId = new Map(TASKS.map(t => [t.id, t]));
const FROZEN_IDS = new Set("A1 A2 A3 A3.1 A3.2 A3.3 A4 A5 A6 B0 B1 B1.1 B2 B3.0a B3.0b B3 P1 P2 P3 C1 C2 C3 C4 C5 C5.1a C5.1b C5.2 D1 D2 D3 D4 D5 D3.1 D6 D7 D8.0 D8 D8.1 D8.3 D8.4a D8.4b D8.4c D8.4d D8.4e D8.3.1 D8.4.1 D8.4.2 D8.5 D8.2 V1 E1 E2 V3 E3 E4 E5.0 E5 E6 F1 F2 E2.1 F3 F4 V2 F5 S1 G1 G1.1 G1.2 G1.3 G1.4 G2 G3 H1.0a H1.0b H1.0c H1.0d H1 Q1 Q2 Q3 Q2.1 Q4 Q5 E5.1 H2.0 H2".split(" "));
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
  // UI не трогаем; исключение — только по явному разрешению владельца, записанному в задаче полем uiAllowed (основание)
  for (const p of t.paths ?? []) if (/^ui\//.test(p) && !(typeof t.uiAllowed === "string" && t.uiAllowed.trim())) found.push(`${t.id}: путь в ui/ — UI не трогаем (исключение — поле uiAllowed с разрешением владельца)`);
  // РИСК «план растёт быстрее кода» (решение владельца 27.09.2026: код прежде всего, план заморожен на 87 задачах): новая задача — только с доказательством
  // в поле admission: воспроизведённый законными вызовами сбой (проба/лог), который блокирует живой прогон и не укладывается в существующую задачу
  if (!FROZEN_IDS.has(t.id) && !(typeof t.admission === "string" && t.admission.trim())) found.push(`${t.id}: новая задача вне замороженного плана — нужно поле admission с доказательством (воспроизведённый сбой, блокирует прогон, не укладывается в существующую задачу)`);
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
  "**Как идёт работа.** Оркестратор выдаёт задачу воркеру (новый воркер на каждую задачу, рабочая копия `~/OMG/.omg/worktrees/om-module`, ветка `om/module`); пакет задачи собирает `code/make-task-packet.mjs` — тексты правил подставляются дословно. Сдача — по правилу владельца: воркер доводит задачу до финальных байтов и ОДИН раз прогоняет на них `npm run check:backend`; оркестратор проверяет сданное (пять проходов, сигнализатор `channel-check.mjs --code`, что прогон относится к тем же байтам) и этот прогон не повторяет; затем одно независимое ревью; после «принять» — автоматический коммит ровно этих байтов. Подпись владельца под этим планом — начальное разрешение на всю работу по нему, а не ворота каждой задачи.", "",
  `**Обязательные тесты каждой задачи:** ${COMMON_TESTS.join("; ")}.`, "", `Задач: ${TASKS.length}. Порядок выдачи (по зависимостям): ${order.join(" → ")}.`, "");
for (const s of SLICES) { const ts = TASKS.filter(t => t.slice === s.id); L.push(`## Срез ${s.id} · ${s.title}`, "", `${s.why} Задач: ${ts.length}.`, "");
  for (const t of ts) { const n = neighbours(t); L.push(`### ${t.id} · ${t.title}`, "", `**Цель.** ${t.goal}`, "", `- Правила: ${t.rules.map(r => "`" + r + "`").join(", ")}`, `- Единицы карты: ${(t.units ?? []).map(nodeName).join("; ") || "—"}`,
    `- Получает от: ${n.from.join("; ") || "—"}`, `- Отдаёт: ${n.to.join("; ") || "—"}`, `- Читает записи: ${t.reads.join("; ")}`, `- Пишет записи: ${t.writes.join("; ")}`, `- Разрешённые пути: ${t.paths.map(p => "`" + p + "`").join(", ")}`,
    `- Из движка как есть: ${t.reuse.join("; ") || "—"}`, ...(t.proto?.length ? [`- Пробный код (сценарии, не код к переносу): ${t.proto.join("; ")}`] : []), `- После: ${(t.after ?? []).join(", ") || "—"}`,
    ...(t.engine ? [`- **Изменение движка:** ${t.engine}`] : []), ...(t.open ? [`- **Уточнить до выдачи:** ${t.open}`] : []), "- Тесты сверх обязательных:", ...t.tests.map(x => `  - ${x}`), ""); } }
L.push(`## ${MILESTONE.title}`, "", MILESTONE.how, "", `После: ${MILESTONE.after.join(", ")}.`, "");
writeFileSync("code/TASK-PLAN.md", L.join("\n")); const wide = TASKS.filter(t => t.paths.length > 6).map(t => `${t.id}(${t.paths.length})`); if (wide.length) console.log(`широкие задачи (> 6 путей, по умолчанию стык — отдельной задачей): ${wide.join(", ")}`); const eng = TASKS.filter(t => t.engine).map(t => t.id), open = TASKS.filter(t => t.open).map(t => t.id);
console.log(`ПЛАН ЗАДАЧ: находок 0 · задач ${TASKS.length} в ${SLICES.length} срезах · единиц карты покрыто ${mustCover.length} из ${mustCover.length} · правил названо ${usedRules.size} · с изменением движка: ${eng.join(", ")} · уточнить до выдачи: ${open.join(", ")}`);
