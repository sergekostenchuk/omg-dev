import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
import { base, scenario, tableBase, tableScenario } from "./policy-weights.mjs";
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id);
const all = Object.fromEntries(base.map(r => [r.id, 1])); const one = { "n-spec": 1 };
const hzSet = new Set(["n-intake", "n-state", "n-control", "n-research", "n-refine", "n-compile", "n-schedule", "n-implement", "n-check", "n-review", "n-publish", "n-recovery"]); const hz = { "n-refine": 3, "n-compile": 2, "n-implement": 2, "n-state": 1, "n-recovery": 1 };
const text = `ВЕС БЛОКОВ omg-live r2 · политика v1 · расчёт policy-weights.mjs
Пробелов валидатора нет: валидатор пробелов (M5) ещё не написан, число пробелов — допущение сценариев, а не измерение. Проценты структурного веса не показываются: бюджет считается только при пробелах.

1. БАЗОВЫЕ ВЕСА (признаки 1–3, без пробелов; реальная передача у всех 1)
${tableBase()}

2. СЦЕНАРИИ (признак 4 входит в вес; бюджет горизонта 20 000 000, потолок блока 1 500 000, доля среди блоков с пробелами)

${tableScenario("A · один пробел у n-spec · правило v1 (порог ½ max)", scenario(one))}

${tableScenario("A' · то же · правило v1.1 (абсолютный порог: базовый вес ≥ 3)", scenario(one, null, "v1.1"))}

${tableScenario("B · по одному пробелу у всех 25 · v1", scenario(all))}

${tableScenario("B' · v1.1", scenario(all, null, "v1.1"))}

${tableScenario("C · горизонт 12 блоков, пробелы у 5 · v1", scenario(hz, hzSet))}

${tableScenario("C' · v1.1", scenario(hz, hzSet, "v1.1"))}

Вывод: относительный порог v1 делает передачу зависимой от того, у кого ещё есть пробелы (A: единственный пробел даёт тройку; B: 14 троек). Абсолютный порог по базовому весу (v1.1) даёт устойчивый набор из 8 блоков третьей передачи, пробелы решают только «нужно ли исследование» и долю бюджета. В сценарии C потолок 1 500 000 срабатывает у всех пяти: при малом числе блоков с пробелами бюджет определяет потолок, а не доля.`;
const note = s.notes.find(n => (n.title || "").startsWith("OM · Вес блоков")); note.widgets_values[0] = text; note.size = [760, 2600];
const disc = s.notes.find(n => (n.title || "").includes("Обсуждение")); const ctx = s.notes.find(n => (n.title || "").includes("Контекст"));
const ng = s.groups.find(g => String(g.title).startsWith("Контекст")); if (ng) ng.bounding[3] = Math.max(ng.bounding[3], note.pos[1] + note.size[1] + 160 + 60, disc.pos[1] + disc.size[1] + 160 + 60);
// предложение v1.1 — решение владельца
if (!by("d-gear-rule-v11")) { const ns = s.nodes.filter(n => n.group === "Решения владельца"); const y = Math.max(...ns.map(n => n.pos[1] + n.size[1])) + 110;
  const fields = { "вопрос": "Правило передачи v1.1: абсолютный порог по базовому весу вместо относительного «половина максимума»?", "варианты": "v1 (сейчас): передача 3, если вес с пробелами ≥ ½ максимума среди блоков горизонта. Дефект: единственный пробел у n-spec даёт тройку; пробелы у всех дают 14 троек из 25.\nv1.1 (предложение): передача 1 без пробелов; иначе 3, если базовый вес (признаки 1–3) ≥ 3, и 2, если ниже. Пробелы решают только «нужно ли исследование» и долю бюджета (признак 4 в весе остаётся). На omg-live тройку получают устойчиво 8 блоков: state, implement, publish, recovery, control, integrate, backup, progress. Порог 3 — стартовая настройка политики.", "решение": "", "статус": "открыто" };
  s.nodes.push({ id: "d-gear-rule-v11", type: "owner", fields, pos: [ns[0].pos[0], y], size: [W, heightOf("owner", fields)], group: "Решения владельца" });
  const g = s.groups.find(g => String(g.title).startsWith("Решения владельца")); const all2 = s.nodes.filter(n => n.group === "Решения владельца"); const y1 = Math.max(...all2.map(n => n.pos[1] + n.size[1])); g.bounding = [ns[0].pos[0] - 40, Math.min(...all2.map(n => n.pos[1])) - 80, W + 80, y1 - Math.min(...all2.map(n => n.pos[1])) + 140]; }
const reply = `
──────────
[12.09.2026 · Claude Code]
По таблице весов: замечания верны, все четыре. Столбец «передача при пробелах» был посчитан по весу без пробелов при относительном пороге — это ошибка расчёта, не формулы. Переделано: карточка «Вес блоков» теперь показывает отдельно базовые веса (признаки 1–3) и сценарии с конкретными наборами пробелов (A: один пробел у n-spec; B: по одному у всех; C: горизонт из 12 блоков с пробелами у 5), с весом, передачей, попытками и бюджетом при 20 000 000 и потолке 1 500 000. Проценты структурного веса убраны. Допущение «пробелов 0» названо допущением: M5 не написан.
Сценарии показали дефект правила v1: A даёт тройку единственному блоку, B — 14 троек. Предложил владельцу v1.1: порог абсолютный по базовому весу (≥ 3 → тройка), пробелы решают только нужность исследования и долю бюджета; на omg-live это устойчивые 8 блоков. Карточка решения открыта. Расчёт воспроизводим: PREPARATIONS/OM-DESIGN/policy-weights.mjs, результаты в policy-v1-weights.json.
`;
if (!disc.widgets_values[0].includes("По таблице весов: замечания верны")) disc.widgets_values[0] = disc.widgets_values[0].trimEnd() + "\n" + reply;
writeFileSync("om-design.json", JSON.stringify(s, null, 1)); console.log("таблицы и предложение v1.1 записаны");
