// Политика веса v1 (стартовые настройки, решение владельца 12.09.2026): расчёт на omg-live r2, запись в карточки и таблица на полотне.
import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
const g = JSON.parse(readFileSync(process.argv[2], "utf8"));
const blocks = g.nodes.filter(n => n.kind === "block"); const ids = new Set(blocks.map(b => b.id));
const path = new Set(g.journeys.find(j => j.id === "jy-owner-success").path);
// признак 1: уникальные зависимые блоки = потребители исхода (L1) ∪ источники входящих переходов (успех, отказ, возврат)
const dep = Object.fromEntries(blocks.map(b => [b.id, new Set()]));
for (const c of g.connectors) for (const b of c.bindings) if (b.level === 1 && dep[b.producer.node]) for (const x of b.consumers) if (x.node !== b.producer.node && ids.has(x.node)) dep[b.producer.node].add(x.node);
for (const e of g.edges) if (dep[e.target] && ids.has(e.source) && e.source !== e.target) dep[e.target].add(e.source);
const writerFor = {}, rollbackFor = {}; for (const b of blocks) { writerFor[b.boundary.writer] = (writerFor[b.boundary.writer] || 0) + 1; rollbackFor[b.boundary.rollback] = (rollbackFor[b.boundary.rollback] || 0) + 1; }
const durable = new Set(["durable_source", "immutable", "durable_draft"]); const art = Object.fromEntries(g.artifacts.map(a => [a.id, a]));
const maxD = Math.max(...blocks.map(b => dep[b.id].size));
const rows = blocks.map(b => { const D = dep[b.id].size / maxD; const P = path.has(b.id) ? 1 : 0;
  const S = (writerFor[b.id] || rollbackFor[b.id] || (durable.has(art[b.outcome]?.durability) && b.boundary.writer === b.id)) ? 1 : 0; const G = 0;
  const w = 2 * D + 2 * P + 3 * S + 1 * G; return { id: b.id, title: b.title, deps: dep[b.id].size, P, S, G, w: +w.toFixed(2) }; });
const wmax = Math.max(...rows.map(r => r.w)); const sum = rows.reduce((s, r) => s + r.w, 0);
for (const r of rows) { r.gear = r.G === 0 ? 1 : r.w < 0.5 * wmax ? 2 : 3; r.gearIfGaps = r.w < 0.5 * wmax ? 2 : 3; r.share = +(100 * r.w / sum).toFixed(1); r.attempts = r.gearIfGaps; }
rows.sort((a, b) => b.w - a.w);
writeFileSync("policy-v1-weights.json", JSON.stringify({ policy: "v1", basis: "graph:omg-live r2", computedAt: new Date().toISOString(), wmax, sum: +sum.toFixed(2), rows }, null, 1));
const table = ["блок · зависимых · путь · сост · вес · доля · передача при пробелах", ...rows.map(r => `${r.id.padEnd(18)} ${String(r.deps).padStart(2)}  ${r.P}  ${r.S}  ${String(r.w).padStart(5)}  ${String(r.share).padStart(4)}%  ${r.gearIfGaps}  · ${r.title.slice(0, 44)}`)].join("\n");
console.log(table); console.log(`\nwmax ${wmax} · сумма ${sum.toFixed(2)} · передача 3 при пробелах: ${rows.filter(r => r.gearIfGaps === 3).length} из 25`);
// ---- карточки ----
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id);
const set = (id, patch) => { const n = by(id); Object.assign(n.fields, patch); n.size = [W, heightOf(n.type, n.fields)]; };
const policy = `ПОЛИТИКА ВЕСА v1 — стартовые настройки, принято 12.09.2026. Коэффициенты и лимиты — версия политики, не константы; версия пишется в запись block-weight.
Признаки: 1) уникальные зависимые блоки = потребители исхода ∪ источники входящих переходов по успеху, отказу и возврату (считаются блоки, не стрелки), нормировано к максимуму в горизонте; 2) блок на пути владельца к результату; 3) блок — писатель или откат для других блоков, либо сам пишет долговременный исход; 4) пробелы валидатора, нормировано.
Вес = 2·(1) + 2·(2) + 3·(3) + 1·(4).
Передача: 1 — нет пробелов (модель не нужна, вес задаёт строгость ревью и лимит попыток); 2 — пробелы есть и вес ниже половины максимума в горизонте; 3 — иначе.
Единица: входные + выходные токены по журналу model-call, кэш по факту адаптера. Бюджет горизонта = бюджет этапа (20 000 000). Доля блока = вес / сумма весов блоков с пробелами; блокам без пробелов бюджет исследования не выделяется. Потолок блока 1 500 000 (переопределяет владелец). Пола нет: если доля меньше стоимости одного вызова, блок сразу получает сохранённую остановку «бюджет мал» → отсрочка или владелец.
Ограничение стоимости следующего вызова: перед вызовом оценка запроса плюс максимальный ответ по профилю ≤ остаток блока, иначе вызов не делается, остановка «budget_exhausted» с точкой продолжения.
Распределение остатка: по завершении или остановке блока неизрасходованная доля возвращается в пул горизонта и делится по весу между блоками, у которых ещё есть открытые пробелы и не исчерпан лимит попыток; потолок блока при этом не превышается; остаток пула по завершении горизонта не переносится автоматически, его судьбу решает владелец.
Лимит попыток серии исправлений по передаче: 1 → 1, 2 → 2, 3 → 3; общий для проходов с моделью и без.
Расчёт на omg-live r2 — карточка «Вес блоков omg-live, политика v1» рядом.`;
set("d-weight-formula", { "решение": policy, "статус": "решено" });
set("mech-weight", { "что делает": `Для каждого блока горизонта: вес по политике v1 (четыре признака: уникальные зависимые блоки, путь к результату, состояние и полномочия, пробелы валидатора) → передача 1/2/3 и доля бюджета горизонта среди блоков с пробелами; потолок 1 500 000, пола нет; перед каждым вызовом ограничение стоимости следующего вызова против остатка блока; остаток завершённых блоков перераспределяется по весу между открытыми. Лимит попыток серии = передача. Версия политики и переопределение владельца — в записи. Пересчёт после M5 не обнуляет потраченное.\nПереиспользуется: учёт model-call и pilotDispatch как заготовки (pilotDispatch ограничивает пилот, не долю блока). Формулы веса и передач в коде нет — новое.`, "выход": "block-weight {weight, gear, budgetShare, cap, attemptLimit, policyVersion, override?}" });
// таблица на полотне
const note = s.notes.find(n => (n.title || "") === "OM · Вес блоков omg-live, политика v1");
const d = by("d-weight-formula"); const text = `ВЕС БЛОКОВ omg-live r2 · политика v1 · пробелов валидатора пока 0, поэтому реальная передача у всех 1; столбец «передача» — при появлении пробелов.\n\n${table}\n\nwmax ${wmax} · сумма ${sum.toFixed(2)} · доля считается среди блоков с пробелами; здесь показана доля среди всех 25 для сравнения.`;
if (note) { note.widgets_values[0] = text; } else s.notes.push({ id: 0, type: "Note", title: "OM · Вес блоков omg-live, политика v1", pos: [d.pos[0] + W + 120, d.pos[1]], size: [760, 780], flags: {}, order: 0, mode: 0, inputs: [], outputs: [], properties: {}, widgets_values: [text], color: "#3f4a5a", bgcolor: "#2a2d33" });
writeFileSync("om-design.json", JSON.stringify(s, null, 1)); console.log("\nкарточки записаны; таблица в policy-v1-weights.json и на полотне");
