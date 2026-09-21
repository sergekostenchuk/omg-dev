// Пакет задачи воркеру. Запуск из PREPARATIONS/OM-DESIGN:  node code/make-task-packet.mjs <id задачи>  →  code/packets/<id>.md
// Тексты правил и карточек подставляются ДОСЛОВНО из источников (level2-rules.mjs, om-design.json) — не пересказ оркестратора. Задача с полем open не выдаётся, пока оно не снято (ключ --force — только для просмотра).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RULES } from "../level2-rules.mjs";
import { TASKS, COMMON_TESTS } from "./task-plan.mjs";
const [id, flag] = process.argv.slice(2); const t = TASKS.find(x => x.id === id); if (!t) { console.error(`нет задачи ${id}; есть: ${TASKS.map(x => x.id).join(", ")}`); process.exit(2); }
if (t.open && flag !== "--force") { console.error(`задача ${id} не выдаётся: уточнить до выдачи — ${t.open}`); process.exit(1); }
const map = JSON.parse(readFileSync("om-design.json", "utf8")); const node = nid => map.nodes.find(n => n.id === nid);
const name = n => String(n.fields["название"] ?? n.fields["запись"] ?? n.fields["стадия"] ?? n.id); const card = n => `#### ${name(n)}  \`${n.id}\`\n` + Object.entries(n.fields).filter(([k]) => !["название", "запись"].includes(k)).map(([k, v]) => `- **${k}:** ${String(v).replace(/\n+/g, " ⏎ ")}`).join("\n");
const mine = new Set(t.units ?? []); const from = new Map(), to = new Map();
for (const e of map.edges) { if (mine.has(e.to) && !mine.has(e.from)) from.set(e.from, e.kind); if (mine.has(e.from) && !mine.has(e.to)) to.set(e.to, e.kind); }
const line = ([nid, kind]) => { const n = node(nid); return `- ${n ? name(n) : nid} \`${nid}\` · связь ${kind}`; };
const stores = [...new Set([...from.keys(), ...to.keys()])].map(node).filter(n => n && n.type === "store");
const done = (t.after ?? []).map(a => TASKS.find(x => x.id === a)).filter(Boolean);
// карточка задачи по планке ревью (№150): точная база, версия правил, фактический интерфейс сделанных соседей, границы незавершённой интеграции
const WT = "/Users/kostenchuksergey/OMG/.omg/worktrees/om-module";
const base = execFileSync("git", ["-C", WT, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
const rulesVersion = createHash("sha256").update(readFileSync("level2-rules.mjs")).digest("hex").slice(0, 12);
const before = new Set(); const walk = x => { for (const a of TASKS.find(y => y.id === x)?.after ?? []) if (!before.has(a)) { before.add(a); walk(a); } }; walk(t.id);
const iface = [...before].map(a => TASKS.find(x => x.id === a)).filter(Boolean).flatMap(d => d.paths.filter(p => /^src\/om\//.test(p) && existsSync(`${WT}/${p}`))
  .map(p => ({ task: d.id, path: p, exports: readFileSync(`${WT}/${p}`, "utf8").split("\n").filter(l => /^export /.test(l)).map(l => l.replace(/\s*\{\s*$/, "").slice(0, 220)) })));
const pending = [...new Set([...from.keys(), ...to.keys()])].flatMap(u => { const owners = TASKS.filter(x => x.id !== t.id && (x.units ?? []).includes(u)); return owners.length && owners.every(o => !before.has(o.id)) ? [`${node(u) ? name(node(u)) : u} — задачи ${owners.map(o => o.id).join(", ")} ещё не сделаны: работай против формы записи из карточки, а не против кода`] : []; });

const P = [];
P.push(`# Задача ${t.id} · ${t.title}`, "", `**Цель.** ${t.goal}`, "",
  "## Как работать", "",
  "- Ты воркер блока OM движка OMG. Рабочая копия — `/Users/kostenchuksergey/OMG/.omg/worktrees/om-module`, ветка `om/module`. Работай ТОЛЬКО в ней. Основную копию `~/OMG`, базу `.omg/state.sqlite` и `live-source` не трогай и не читай на запись.",
  `- Писать разрешено ТОЛЬКО в эти файлы: ${t.paths.map(p => "`" + p + "`").join(", ")}. Нужен другой файл — остановись и сообщи: это отход от задачи, а не твоё решение.`,
  "- Источник истины — правила ниже. Они приняты ревьюером. Если правило кажется неверным, неполным или противоречит движку — НЕ обходи его кодом: остановись и опиши противоречие с примером. Поведение продукта сам не выбирай.",
  "- Отсутствующая возможность — типизированный отказ с адресом, не заглушка и не значение по умолчанию.",
  "- Код движка, названный «как есть», не правится. Пробный код `PREPARATIONS/OM-DESIGN/proto/` — сценарии и контрпримеры ревью, а не код к переносу: он возвращался ревьюером 15 раз.",
  "- Тесты: `node:test` + `node:assert/strict`, своя временная база на тест (образец — `test/storage.test.ts`), без настоящих вендоров, сети и ключей. `ui/` не трогать. push, слияния, теги — запрещены.",
  "- Стиль движка: ESM, относительные импорты с суффиксом `.js`; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`; файлы в kebab-case, без `index.ts`; типы экспортируются рядом с реализацией; комментарии редкие, на английском, объясняют «почему». Отказ движка — `EngineError(code, message, details)` из `src/errors.ts`. Факты о движке: `PREPARATIONS/OM-DESIGN/code/engine-facts-infra.md` и `engine-facts-reuse.md` — сверяй с кодом перед использованием.",
  "- Проверяй все предусмотренные отказы СВОЕЙ единицы и существенные стыки с соседями, а не внутренние отказы неизменённого движка. Правило отсутствия — для ОБЯЗАТЕЛЬНЫХ данных. Публичной команды у модуля ещё нет (до H2): граница — функции твоей единицы и записи, законно приходящие от соседей.",
  "- Готово, когда: обязательные тесты написаны и зелёные; изменения НЕ закоммичены, а проиндексированы только в разрешённых путях (`git add <пути>`), рабочая копия равна индексу; на этих финальных байтах ОДИН раз запущен `npm run check:backend` и он зелёный целиком (точка отсчёта — 415 тестов). Коммит сделает оркестратор после ревью — ровно этих байтов. Изменил байты после прогона — прогон нужен заново.",
  "- Отчёт верни текстом: база `git rev-parse HEAD`, дерево финальных байтов `git write-tree`, пустой `git diff` (рабочая копия = индекс) и `git diff --cached --stat` на момент прогона; хвост вывода `npm run check:backend` (строки `# tests`, `# pass`, `# fail`); список тестов по каждому обязательному пункту; всё, что пришлось решить самому, и все места, где правило показалось неполным.", "");
P.push("## Карточка задачи", "", `- Точная база: ветка \`om/module\`, коммит \`${base}\`. Версия правил: \`level2-rules.mjs\` sha256 \`${rulesVersion}\`.`, `- Правила: ${t.rules.map(r => "`" + r + "`").join(", ")}`, `- Читает записи: ${t.reads.join("; ")}`, `- Пишет записи: ${t.writes.join("; ")}`, `- Из движка как есть: ${t.reuse.join("; ") || "—"}`,
  ...(t.proto?.length ? [`- Пробный код (сценарии): ${t.proto.join("; ")}`] : []), ...(t.engine ? [`- **Изменение движка:** ${t.engine}`] : []), ...(done.length ? [`- Уже сделано до тебя: ${done.map(d => `${d.id} «${d.title}» (${d.paths.filter(p => /^src\//.test(p)).join(", ")})`).join("; ")}`] : []), "",
  "### Соседи — от кого получаешь и кому отдаёшь (из стрелок карты)", "", "Получаешь от:", ...(from.size ? [...from].map(line) : ["- —"]), "", "Отдаёшь:", ...(to.size ? [...to].map(line) : ["- —"]), "",
  "### Фактический интерфейс уже сделанного (экспорты из рабочей копии на базе выше)", "", ...(iface.length ? iface.flatMap(f => [`- ${f.task} · \`${f.path}\``, ...f.exports.map(e => `  - \`${e}\``)]) : ["- пока ничего: модуль начинается с этой задачи или её предшественники ещё не сданы"]), "",
  "### Границы незавершённой интеграции", "", ...(pending.length ? pending.map(x => `- ${x}`) : ["- нет"]), "",
  "### Обязательные тесты", "", ...COMMON_TESTS.map(x => `- ${x}`), ...t.tests.map(x => `- ${x}`), "");
P.push("## Правила — дословно из принятой карты", ""); for (const rid of t.rules) { const r = RULES.find(x => x.id === rid); P.push(`### ${r.title}  \`${r.id}\``, "", "```text", r.text, "```", ""); }
if (mine.size) { P.push("## Карточки единиц карты — дословно", ""); for (const u of mine) { const n = node(u); if (n) P.push(card(n), ""); } }
if (stores.length) { P.push("## Карточки записей-соседей — дословно", ""); for (const n of stores) if (!mine.has(n.id)) P.push(card(n), ""); }
mkdirSync("code/packets", { recursive: true }); const out = `code/packets/${t.id}.md`; const text = P.join("\n"); writeFileSync(out, text);
console.log(`пакет задачи ${t.id}: ${out} · ${text.length} знаков · правил ${t.rules.length} · единиц ${mine.size} · соседей: от ${from.size}, к ${to.size}`);
