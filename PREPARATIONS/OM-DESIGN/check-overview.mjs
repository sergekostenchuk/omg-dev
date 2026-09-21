// Проверялка обзора. РИСК: в действующем тексте карты остаётся отменённое понятие (потолок, резерв, предохранитель, лимит попыток, передачи, допуск G8, пересчёт веса от отказов),
// и исполнитель кода примет его за правило. Ожидаемый результат: ноль находок. Отменённое понятие допустимо только в предложении, которое его прямо отрицает или отменяет,
// в словах владельца (текст в кавычках «…» не проверяется) и в карточке открытого решения об аварийном выключателе. Заметки «История» и «Обсуждение» (журнал реплик) не проверяются — они не действуют как правило.
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.argv[2] ?? "om-design.json", "utf8")); const found = [];
const TERMS = [/предохранител/i, /лимит/i, /резерв(?!уар|ирован)/i, /потол[о]?к/i, /call-admission/i, /допуск[а-я]* G8|запис[а-я]* допуска/i, /пересч[её]т[а-я]* веса/i, /бюджет/i, /коробк|передач[а-я]* [123]\b|порог[а-я]* передач/i, /(om|st)-fuses|(om|st)-allocation/i, /ревью уровня 1/i];
const NEG = /(^|[^а-яё])(нет([^а-яё]|$)|не требуется|не явля|не влия|не обрыва|не завис|не меня|не ввод|не выда|не экономи|а не |больше не|вместо|отмен|снят|устарел|истори|без предела)/i;
const LEGIT = /недельн|аварийн|budget-ledger|spendReport|research-budget/i; // аварийный выключатель недельного бюджета владельца и имя готовой записи движка
const check = (where, text) => { for (const sent of String(text).replace(/«[^»]*»/g, "«…»").split(/(?<=[.;!?])\s+|\n/)) for (const t of TERMS) if (t.test(sent) && !NEG.test(sent) && !LEGIT.test(sent)) { found.push(`[${where}] ${sent.trim().slice(0, 220)}`); break; } };
for (const n of s.nodes) for (const [k, v] of Object.entries(n.fields ?? {})) { if (n.type === "owner" && k === "вопрос") continue; check(`${n.id} · ${k}`, v); }
for (const n of s.notes ?? []) { if (n.properties?.omd_note === "history" || /^OM · Обсуждение/.test(n.title ?? "")) continue; check(`заметка «${String(n.title).slice(0, 48)}»`, n.widgets_values?.[0] ?? ""); }

// точные требования вердикта №144
const f = (id, k) => s.nodes.find(n => n.id === id)?.fields?.[k] ?? ""; const ctx = (s.notes ?? []).find(n => /^OM · Контекст/.test(n.title ?? ""))?.widgets_values?.[0] ?? "";
const must = [[/call-record/.test(f("store-records", "что хранит")), "store-records называет call-record"], [!/call-admission/.test(JSON.stringify(s.nodes)), "имени call-admission нет нигде в карточках"],
  [/G7/.test(f("store-refusals", "что хранит")) && /НЕ меняют/.test(f("store-refusals", "что хранит")), "журнал отказов называет потребителей и не меняет вес"],
  [/Главное правило/.test(ctx) && /продвижени/.test(ctx) && !/Предохранители остаются|единый лимит попыток|Стоп по бюджету/.test(ctx), "контекст — действующее содержание"],
  [ctx.includes(f("goal-om", "цель")) && ctx.includes(f("goal-om", "критерии успеха")), "раздел цели в контексте дословно равен карточке цели"],
  [(s.notes ?? []).some(n => n.properties?.omd_note === "history" && /ПРЕЖНИЕ ФОРМУЛИРОВКИ/.test(n.widgets_values?.[0] ?? "")), "прежние формулировки лежат в истории"]];
for (const [ok, name] of must) if (!ok) found.push(`[требование] не выполнено: ${name}`);

// связи без концов и наезды карточек
const ids = new Set(s.nodes.map(n => n.id)); s.edges.forEach((e, i) => { if (!ids.has(e.from) || !ids.has(e.to)) found.push(`[связь №${i}] конец не существует: ${e.from} → ${e.to}`); });
const boxes = [...s.nodes.map(n => ({ t: n.id, p: n.pos, z: n.size })), ...(s.notes ?? []).map(n => ({ t: String(n.title).slice(0, 40), p: n.pos, z: n.size }))].filter(b => b.p && b.z);
for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.p[0] < b.p[0] + b.z[0] && b.p[0] < a.p[0] + a.z[0] && a.p[1] < b.p[1] + b.z[1] && b.p[1] < a.p[1] + a.z[1]) found.push(`[наезд] ${a.t} × ${b.t}`); }

if (found.length) { console.log(found.join("\n")); console.log(`\nПРОВЕРКА ОБЗОРА: находок ${found.length}`); process.exit(1); }
console.log(`ПРОВЕРКА ОБЗОРА: находок 0 (карточек ${s.nodes.length}, заметок ${(s.notes ?? []).length}, связей ${s.edges.length})`);
