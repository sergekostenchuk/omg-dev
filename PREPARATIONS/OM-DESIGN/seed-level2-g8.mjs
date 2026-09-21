// Уровень 2 · G8 и переход серий — два долга OMG-ORDER (вердикт №3). Карточки описывают исполняемую спецификацию proto/admission.mjs
// (10 тестов на настоящих Store и research-budget из dist/, 9 намеренных поломок пойманы). Идемпотентен.
import { readFileSync, writeFileSync } from "node:fs";
import { W, heightOf } from "./vocab.mjs";
const s = JSON.parse(readFileSync("om-design.json", "utf8")); const by = id => s.nodes.find(n => n.id === id);
const G = "Уровень 2 · G8 и переход серий"; const X = 6720; let y = -80; const SPEC = " Исполняемая спецификация: proto/admission.mjs; тесты proto/admission.test.mjs.";
const add = (id, type, fields) => { let n = by(id); if (!n) { n = { id, type, fields, pos: [X, y], size: [W, 0], group: G }; s.nodes.push(n); } n.fields = fields; n.size = [W, heightOf(type, fields)]; n.pos = [X, y]; y += n.size[1] + 110; };
const edge = (from, to, kind) => { if (!s.edges.some(e => e.from === from && e.to === to && e.kind === kind)) s.edges.push({ from, to, kind }); };
const rep = (id, key, from, to) => { const f = by(id).fields; if (f[key].includes(to.slice(0, 40))) return; if (!f[key].includes(from)) throw new Error(`не найдено в ${id}: ${from.slice(0, 50)}`); f[key] = f[key].replace(from, to); by(id).size = [W, heightOf(by(id).type, f)]; };

add("st-ledger", "store", { "запись": "предохранители и ведомость резервов (research-budget, research-budget-ledger — готовые записи)",
  "что хранит": "Берётся КОПИРОВАНИЕМ готового блока src/runtime/research-budget.ts (решение владельца 12.09), не сочиняется заново. Сегмент { projectId, key, limit, initialGroupLimit, ownerGroupCeiling } = предохранители горизонта: key — версия выбора горизонта, limit — бюджет горизонта, ownerGroupCeiling — потолок блока; сегмент нельзя сбросить пересозданием. Ведомость — ОДНА запись { assignments[{ call, groups[блок], estimate{kind, tokens, basis, explanation} }] } с проверкой ревизии: это и делает проверку «расход + все действующие резервы + новый резерв» атомарной. Резерв вызова с неизвестным расходом остаётся в учёте (в готовом коде: «Unknown usage never means a zero reserve»). Не копируются части про вопросы старого R2 (assertQuestionBudget, рабочие повышения с «оптимизациями»)." + SPEC });
add("st-admission", "store", { "запись": "call-admission (допуск вызова)",
  "что хранит": "{ call, block, series, fuses — точная ссылка версии предохранителей, reserve, before{ horizon{measured, reserved}, block{measured, reserved} }, result: admitted | spend_over_reserve, used? }. Пишется одной транзакцией с ведомостью и записью model-call ДО отправки вызова: вызова без допуска не бывает. Отказ допуска записи не создаёт и вызов не создаёт — он идёт в журнал отказов с кодом. По этим записям критерий успеха 5 проверяется механически (F8.3)." + SPEC });
add("f8-admit", "mechanism", { "название": "F8.1 · admitCall — допуск до отправки",
  "цель": "Ни один платный вызов не уходит без проверки действующего лимита и резерва; одновременные вызовы не проходят оба сверх лимита.",
  "что делает": "admitCall(project, horizonKey, { call, block, series, estimate }). 1) Оценка обязана быть guaranteed: адаптер без гарантированной верхней границы получает call_cap_unenforceable (нынешний codex-stdio.ts предела не передаёт — это требуемая возможность адаптера на входе G8). 2) Допуск этого call уже есть — возвращается он же: повторная доставка второй резерв не создаёт. 3) Готовый reserveResearchCall проверяет measured + reserved + estimate ≤ лимита горизонта и потолка блока; отказы отображаются в call_not_admitted_horizon_budget и call_not_admitted_block_cap. 4) Один store.writeMany: ведомость, model-call, call-admission — с охраной, которую вернул резерв. Конфликт ревизии ведомости (кто-то зарезервировал раньше) — пересчёт заново, до трёх раз, затем admission_contention. Тесты: лимит 100 и два резерва по 60 — второй не допускается; гонка двух допусков по одному снимку — второй пересчитан и отклонён; потолок блока не расширяется средствами горизонта; сегмент не сбрасывается пересозданием.",
  "вход": "fuses из block-weight (M3); версия выбора горизонта; оценка вызова от адаптера; серия исправлений",
  "выход": "call-admission либо типизированный отказ",
  "ворота": "G8 «Ворота допуска вызова»" });
add("f8-settle", "mechanism", { "название": "F8.2 · settleCall — закрыть резерв расходом",
  "цель": "Резерв закрывается только известным расходом; перерасход виден как дефект среды, а не растворяется в учёте.",
  "что делает": "settleCall(call, usage, status). Пишет фактический расход в model-call: с этого момента готовый budgetUsage считает его измеренным, а не резервом. Расход неизвестен (сбой, обрыв) — резерв НЕ освобождается. Расход выше резерва — допуск получает result spend_over_reserve и used: типизированный дефект среды, маршрут к производителю адаптера. Тест: сбой без данных оставляет резерв 60 и следующий вызов не допускается; после расхода 40 — measured 40, reserved 0; расход 59 при резерве 50 — spend_over_reserve.",
  "вход": "call; usage {inputTokens, outputTokens} | неизвестен",
  "выход": "обновлённый учёт; при перерасходе — дефект",
  "ворота": "—" });
add("f8-audit", "mechanism", { "название": "F8.3 · auditAdmissions — проверка критерия успеха 5",
  "цель": "Критерий «у каждого платного вызова есть допуск, сделанный до отправки; расход не выше резерва» проверяется кодом, а не чтением.",
  "что делает": "auditAdmissions(project, horizonKey, calls) → findings[]: call_without_admission — у вызова нет записи допуска или резерва в ведомости; spend_over_reserve — расход превысил резерв. Пустой список — критерий 5 выполнен. Тесты: вызов без допуска и перерасход находятся.",
  "вход": "model-call[] горизонта; call-admission[]; ведомость",
  "выход": "findings[] → критерий успеха 5 цели блока",
  "ворота": "—" });
add("st-transition", "store", { "запись": "series-transition (переход серий)",
  "что хранит": "{ project, choiceVersion, horizonHash, state: prepared | applied | discarded, reason?, decisions[{ series — точная ссылка, decision: continue | new-work, sliceHashBefore, sliceHashAfter, basis?, newLimit? }] }. Имя = хэш(project, версия выбора владельца): повторная доставка того же выбора возвращает ту же запись. Подготовленный переход в сериях НИЧЕГО не меняет." + SPEC });
add("f2-prepare", "mechanism", { "название": "F2.1 · prepareTransition — подготовить переход",
  "цель": "Решение по каждой серии принято заранее и записано, но учёт не тронут, пока горизонт не принят.",
  "что делает": "prepareTransition(project, choiceVersion, horizonHash, series[], sliceHashOf, policy). Чистое решение по каждой серии: срез блока (блок, его замыкание зависимостей в горизонте, его основания) не изменился → continue; изменился → new-work с основанием и явно названным newLimit из политики. Запись state prepared. Отсутствие серии под новой версией не означает нулевого расхода. Тест: повторная подготовка той же версии выбора возвращает ту же запись.",
  "вход": "кандидат горизонта от M2; серии исправлений; политика (seriesAttemptLimit)",
  "выход": "series-transition, state prepared",
  "ворота": "G2 «Ворота горизонта»" });
add("f2-apply", "mechanism", { "название": "F2.2 · applyTransition — применить после G2",
  "цель": "Горизонт с конфликтом исключения не меняет действующие серии; переход применяется атомарно и однократно.",
  "что делает": "applyTransition(project, choiceVersion, исход G2 {passed, horizonHash}). Отказ G2 либо принята ДРУГАЯ версия горизонта → state discarded с причиной, серии не тронуты. Проход G2 для точной версии → один store.writeMany с охраной на подготовленную запись и на точные ревизии серий: continue — серия продолжается, attemptsUsed сохраняется; new-work — прежняя серия superseded, преемник (линия + 1) с predecessor, spentBefore, basis и выделенным лимитом. Серия изменилась после подготовки — транзакция не применяется целиком. Повторное применение — ничего не выделяет. Тесты: блок исчерпал 3/3, исключение ДРУГОГО блока даёт H2 — остаётся 3/3 и остановка; отказ G2 и чужая версия — серии не меняются; новая работа — линия 2, 0/3, spentBefore 2; однократность; гонка с изменением серии.",
  "вход": "series-transition (prepared); исход G2",
  "выход": "серии исправлений (новые ревизии) либо discarded",
  "ворота": "—" });

edge("mech-weight", "f8-admit", "record"); edge("st-ledger", "f8-admit", "record"); edge("f8-admit", "st-ledger", "record"); edge("f8-admit", "st-admission", "record"); edge("f8-admit", "gate-admit", "flow");
edge("model-research", "f8-settle", "record"); edge("model-design", "f8-settle", "record"); edge("f8-settle", "st-admission", "record"); edge("st-admission", "f8-audit", "record"); edge("f8-audit", "goal-om", "record");
edge("mech-horizon", "f2-prepare", "flow"); edge("f2-prepare", "st-transition", "record"); edge("st-transition", "f2-apply", "record"); edge("gate-horizon", "f2-apply", "gate_pass"); edge("gate-horizon", "f2-apply", "gate_fail"); edge("f2-apply", "store-repairs", "record");

rep("gate-admit", "что проверяет", "и пропускают, только если расход блока + резерв ≤ blockCap и расход горизонта + резерв ≤ бюджета горизонта.", "и пропускают, только если фактический расход + ВСЕ действующие резервы других вызовов + новый резерв ≤ потолка блока и бюджета горизонта; проверка и запись атомарны (одна ведомость с проверкой ревизии — готовый код research-budget.ts); резерв вызова с неизвестным расходом не считается нулевым. Раскрытие — «Уровень 2 · G8 и переход серий».");
rep("mech-horizon", "что делает", "Новая версия горизонта порождает запись перехода серий (series-transition): что продолжается, что становится новой работой.", "Новая версия горизонта ГОТОВИТ запись перехода серий (series-transition, state prepared): что продолжается, что становится новой работой. Применяется она отдельно и только после прохода G2 для этой точной версии (уровень 2 · F2.2); отказ G2 прежний учёт не меняет.");
for (const gid of new Set(s.nodes.map(n => n.group).filter(Boolean))) { const ns = s.nodes.filter(n => n.group === gid).sort((a, b) => a.pos[1] - b.pos[1]); let yy = ns[0].pos[1]; for (const n of ns) { n.pos[1] = yy; yy += n.size[1] + 110; }
  let g = s.groups.find(g => g.id === gid || String(g.title).startsWith(gid)); if (!g) { g = { id: gid, title: gid }; s.groups.push(g); } g.bounding = [ns[0].pos[0] - 40, ns[0].pos[1] - 80, W + 80, yy - 110 - ns[0].pos[1] + 140]; }
writeFileSync("om-design.json", JSON.stringify(s, null, 1)); console.log(`единица 2 засеяна: узлов ${s.nodes.length}, связей ${s.edges.length}, групп ${s.groups.length}`);
