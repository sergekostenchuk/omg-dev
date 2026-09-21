// Сигнализатор канала, механическая часть (без модели). Цель и границы канала — WORK-RULES.md. Сигнал — владельцу и в отчёт, а не условие: код выхода всегда 0.
// Два режима:
//   фаза правил (карта):  node PREPARATIONS/OM-DESIGN/channel-check.mjs <базовый коммит> [<конечный коммит>]
//   фаза кода (задача):   node PREPARATIONS/OM-DESIGN/channel-check.mjs --code --allow <путь,путь,…> <базовый коммит> [<конечный коммит>]
//                          запускать ИЗ рабочей копии модуля; --allow — разрешённые пути записи из карточки задачи (файл или каталог со слэшем на конце)
import { execFileSync } from "node:child_process";
const argv = process.argv.slice(2); const CODE = argv.includes("--code"); const ai = argv.indexOf("--allow"); const allow = ai >= 0 ? String(argv[ai + 1] ?? "").split(",").map(s => s.trim()).filter(Boolean) : [];
const rest = argv.filter((a, i) => a !== "--code" && a !== "--allow" && !(ai >= 0 && i === ai + 1));
// без конечного коммита сравнение идёт с РАБОЧЕЙ ПАПКОЙ: незакоммиченная работа тоже считается (запуск перед коммитом не должен показывать «ноль»)
const [base, head = null] = rest; if (!base) { console.error("нужен базовый коммит"); process.exit(2); }
const rows = execFileSync("git", ["diff", "--numstat", ...(head ? [`${base}..${head}`] : [base])], { encoding: "utf8", maxBuffer: 1 << 27 }).trim().split("\n").filter(Boolean).map(l => { const [a, d, f] = l.split("\t"); return { n: (+a || 0) + (+d || 0), f }; });
const window = `окно ${base}..${head ?? "рабочая папка"}`; const signals = [];

if (CODE) {
  if (!allow.length) { console.error("в режиме --code нужен --allow с путями из карточки задачи"); process.exit(2); }
  const inside = f => allow.some(p => p.endsWith("/") ? f.startsWith(p) : f === p); const isTest = f => /^test\//.test(f) || /\.test\.[cm]?[tj]s$/.test(f);
  let code = 0, tests = 0; const outside = [];
  for (const r of rows) { if (!inside(r.f)) { outside.push(r); continue; } if (isTest(r.f)) tests += r.n; else code += r.n; }
  console.log(`${window}: в путях задачи — код ${code} строк, тесты ${tests} строк; вне путей задачи — файлов ${outside.length}`);
  for (const r of outside) signals.push(`правка ВНЕ путей задачи: ${r.f} (${r.n} строк)` + (/^ui\//.test(r.f) ? " — UI не трогаем" : /level2-rules\.mjs$/.test(r.f) ? " — правила меняются через карту и ревью" : /^src\//.test(r.f) ? " — код движка, в задаче не объявлен" : ""));
  if (code > 0 && tests === 0) signals.push("ГРАНИЦА 2: код прибавился, а тестов в этом окне нет — работа без проверки");
} else {
  const kind = f => /^src\//.test(f) ? "движок" : /OM-DESIGN\/proto\//.test(f) ? "пробный код" : /level2-rules\.mjs$|WORK-RULES\.md$/.test(f) ? "правила" : /OM-DESIGN\/(seed|apply|clean)-[^/]*\.mjs$/.test(f) ? "карточки"
    : /om-design\.json$|OM-DESIGN\.workflow\.json$|LEVEL2-RULES\.md$/.test(f) ? null : "прочее";      // null — собирается из источника, в счёт не идёт
  const sum = {}; for (const r of rows) { const k = kind(r.f); if (k) sum[k] = (sum[k] ?? 0) + r.n; }
  const code = sum["пробный код"] ?? 0, text = (sum["правила"] ?? 0) + (sum["карточки"] ?? 0), total = code + text || 1;
  console.log(`${window}: правила и карточки ${text} строк (${Math.round(100 * text / total)}%), пробный код ${code} строк (${Math.round(100 * code / total)}%)` + (sum["движок"] ? `, ДВИЖОК ${sum["движок"]} строк` : "") + (sum["прочее"] ? `, прочее ${sum["прочее"]}` : ""));
  if (sum["движок"]) signals.push("правка в src/ в основной копии — код блока OM пишется в рабочей копии модуля, по задаче");
  if (code > text) signals.push("ГРАНИЦА 1: в пробный код ушло больше, чем в правила и карточки — код здесь вспомогательный");
  if (text > 0 && code === 0) signals.push("граница 2 (проверь): правила менялись, а проверка прогоном в этом окне не добавлялась — назови, чем правило подтверждено, или что подтверждать нечем");
}
console.log(signals.length ? signals.map(s => "СИГНАЛ · " + s).join("\n") : "в канале: сигналов нет");
