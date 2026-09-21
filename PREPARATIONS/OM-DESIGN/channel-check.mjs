// Сигнализатор канала, механическая часть (без модели). Считает, куда ушла работа с заданной точки: в правила и карточки, в пробный код или в движок.
// Цель и границы канала — WORK-RULES.md. Сигнал — владельцу и в отчёт, а не условие: код выхода всегда 0.
// Запуск из ~/OMG:  node PREPARATIONS/OM-DESIGN/channel-check.mjs <базовый коммит> [<конечный коммит>]
import { execFileSync } from "node:child_process";
// без конечного коммита сравнение идёт с РАБОЧЕЙ ПАПКОЙ: незакоммиченная работа тоже считается (запуск перед коммитом не должен показывать «ноль»)
const [base, head = null] = process.argv.slice(2); if (!base) { console.error("нужен базовый коммит"); process.exit(2); }
const rows = execFileSync("git", ["diff", "--numstat", ...(head ? [`${base}..${head}`] : [base])], { encoding: "utf8", maxBuffer: 1 << 27 }).trim().split("\n").filter(Boolean).map(l => { const [a, d, f] = l.split("\t"); return { n: (+a || 0) + (+d || 0), f }; });
const kind = f => /^src\//.test(f) ? "движок" : /OM-DESIGN\/proto\//.test(f) ? "пробный код" : /level2-rules\.mjs$|WORK-RULES\.md$/.test(f) ? "правила" : /OM-DESIGN\/(seed|apply)-[^/]*\.mjs$/.test(f) ? "карточки"
  : /om-design\.json$|OM-DESIGN\.workflow\.json$|LEVEL2-RULES\.md$/.test(f) ? null : "прочее";      // null — собирается из источника, в счёт не идёт
const sum = {}; for (const r of rows) { const k = kind(r.f); if (k) sum[k] = (sum[k] ?? 0) + r.n; }
const code = sum["пробный код"] ?? 0, text = (sum["правила"] ?? 0) + (sum["карточки"] ?? 0), total = code + text || 1;
console.log(`окно ${base}..${head ?? "рабочая папка"}: правила и карточки ${text} строк (${Math.round(100 * text / total)}%), пробный код ${code} строк (${Math.round(100 * code / total)}%)` + (sum["движок"] ? `, ДВИЖОК ${sum["движок"]} строк` : "") + (sum["прочее"] ? `, прочее ${sum["прочее"]}` : ""));
const signals = []; if (sum["движок"]) signals.push("правка в src/ — в этом задании движок не трогаем");
if (code > text) signals.push("ГРАНИЦА 1: в пробный код ушло больше, чем в правила и карточки — код здесь вспомогательный");
if (text > 0 && code === 0) signals.push("граница 2 (проверь): правила менялись, а проверка прогоном в этом окне не добавлялась — назови, чем правило подтверждено, или что подтверждать нечем");
console.log(signals.length ? signals.map(s => "СИГНАЛ · " + s).join("\n") : "в канале: сигналов нет");
