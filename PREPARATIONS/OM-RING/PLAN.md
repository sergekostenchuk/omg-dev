# PLAN — разрыв кольца импортов (наблюдение №32), om/module = a574007

Анализ статических импортов `src/**/*.ts` (181 файл) по AST TypeScript; инструмент `/tmp/omg-ring/imports-analysis.mjs`, данные `/tmp/omg-ring/analysis.json`. «Загрузочный» граф — рёбра хотя бы с одной value-привязкой (без `import/export type`); полный — все рёбра. SCC — компонента сильной связности (Тарьян).

## 1. Крупнейшая SCC в каждом графе

| граф | размер | состав по каталогам |
|---|---|---|
| загрузочный | **84** | om 38, discovery 19, execution 9, graph 8, product 3, compiler 3, runtime 2, ownership 2 |
| полный | **133** | om 40, discovery 38, graph 19, execution 13, product 7, compiler 7, runtime 5, ownership 2, adapters 2 |

(№32 говорил о 76 — на a574007 уже 84; type-рёбра утаскивают ещё 49 файлов.)

## 2. Обратные рёбра (не-om → om) внутри SCC: 22, минимальный набор = все 22

Каждое ребро лежит на цикле (проверено обходом без ребра). Жадный покомпонентный перебор: **удаление любого одного ребра не уменьшает SCC (84→84)** — кольцо 22-кратно избыточно, точечного разрыва нет, резать надо все 22. После среза всех 22 остаются внутрислоевые кольца: **om 29** (своё), **discovery+graph 14**, ownership+execution 3, om 2 — отдельная меньшая работа.

Сверка со списком №32: `graph/obligation-handoff.ts` ✓, `graph/refinement.ts` ✓, `graph/task-obligations.ts` ✓, `runtime/runtime-observation.ts` ✓ — подтверждены. `execution/task-obligations.ts` ✗ — om **не** импортирует (импортирует `graph/task-obligations.ts`, транзитивное участие); вместо него — `execution/basis.ts`. Пропущено в №32: весь compiler-кластер (11 рёбер, из них 8 в одном `compiler/context.ts`), product/engine (5 рёбер), `graph/runtime-evidence.ts`.

## 3. Рёбра: содержимое и способ разрыва

Все 22 ребра везут **живые функции** (не типы) — поэтому «только type-импорт» сам по себе не закрывает ни одно ребро; он остаётся для типов после переноса функций.

| # | ребро | :строка | импортируется | способ |
|---|---|---|---|---|
| 1 | compiler/basis.ts → om/feasibility.ts | :8 | readFeasibility (ф), OmFeasibility (тип) | перенос читателя вниз (R3) |
| 2 | compiler/compiler.ts → om/feasibility.ts | :19 | readFeasibility (ф), OmFeasibility (тип) | R3 |
| 3 | compiler/compiler.ts → om/input.ts | :20 | historicalTrace (ф), withHistoricalReads (ф) | явный контекст операции (R5) |
| 4 | compiler/context.ts → om/neighbors.ts | :11 | neighborsOf, readNeighbors (ф), Neighbor* (типы) | DI/регистрация фасада (R4) |
| 5 | compiler/context.ts → om/feasibility.ts | :12 | readFeasibility (ф) | R3 |
| 6 | compiler/context.ts → om/atomic-gate.ts | :13 | readAtomicGate (ф) | R4 |
| 7 | compiler/context.ts → om/frame-accept.ts | :14 | readAcceptedFrame (ф) | R4 |
| 8 | compiler/context.ts → om/frame-obligations.ts | :15 | readFrame (ф), FrameRequest (тип) | R4 |
| 9 | compiler/context.ts → om/deliveries.ts | :16 | readDeliveries (ф), DeliveryOwnershipBasis (тип) | R4 |
| 10 | compiler/context.ts → om/works-frame.ts | :17 | readWorksFrame (ф) | R4 |
| 11 | compiler/context.ts → om/input.ts | :18 | historicalTrace, withHistoricalReads (ф) | R5 |
| 12 | execution/basis.ts → om/feasibility.ts | :13 | readFeasibility (ф) | R3 |
| 13 | graph/obligation-handoff.ts → om/obligations.ts | :8 | readOmObligationHandoff (ф), OmObligationHandoff (тип) | DI/регистрация (R1) |
| 14 | graph/refinement.ts → om/feasibility.ts | :24 | gateFeasibility (ф) | R3 |
| 15 | graph/runtime-evidence.ts → om/obligations.ts | :16 | readOmObligationLedger (ф) | R1 |
| 16 | graph/task-obligations.ts → om/input.ts | :7 | historicalRead (ф) | R5 |
| 17 | product/engine.ts → om/model-call.ts | :2 | recoverOmModelCall (ф) | односторонне после R2 |
| 18 | product/engine.ts → om/input.ts | :3 | readOmInput (ф) | R5 (либо отпадает с R2) |
| 19 | product/engine.ts → om/run-driver.ts | :5 | startPass, continuePass, stopPass, resumeStoppedPass, readPass (ф) | односторонне после R2 |
| 20 | product/engine.ts → om/spend-report.ts | :6 | spendReport (ф) | односторонне после R2 |
| 21 | product/engine.ts → om/feasibility.ts | :9 | prepareFeasibility, readFeasibility (ф), OmFeasibility (тип) | R3 (либо отпадает с R2) |
| 22 | runtime/runtime-observation.ts → om/obligations.ts | :20 | readOmObligationLedger (ф) | R1 |

Встречная сторона колец (чем om держит их сам): om/feasibility.ts:2–3 → compiler/derive.ts, compiler/inputs.ts; om/atomic-gate.ts → compiler/context.ts (`preplanTaskContext`), compiler/derive.ts, inputs.ts; om/deliveries.ts → compiler/{inputs,model,ownership}; om/{input,frame-obligations,horizon,run}.ts → **product/engine.ts (класс ProductEngine!)**: input.ts:511 `pipeline.inspect(…, "features")`, frame-obligations.ts:863,896 gate-проверки, horizon.ts:406, run.ts:346 `compile(project)`. om/input.ts → discovery/{requirements,preparation-contracts,preparation-validation,discovery}.ts.

**historicalViews** (om/input.ts:601): модульный `let historicalViews: WeakMap<Store, HistoricalView> | null` — глобальное состояние операции, читаемое в :675,695,784–795. Способ из задания — явный контекст операции: объект контекста создаётся операцией (владельцем `withHistoricalReads`) и протягивается параметром; модульное состояние исчезает, тип контекста может жить ниже (storage/store-view). **Это территория S1.4 — только после неё.**

## 4. Задачи (порядок = накопленный эффект, замерено на графе)

| задача | пути (рёбра/файлы) | эффект (SCC) | содержание |
|---|---|---|---|
| **R1** | 3 ребра / 4 файла | 84→83 | Читатели obligations (readOmObligationHandoff, readOmObligationLedger) — регистрация: слот в новом нижнем модуле (уровень graph), om/obligations.ts регистрирует при загрузке; graph/obligation-handoff, graph/runtime-evidence, runtime/runtime-observation зовут через слот. Доказательный прогон паттерна (он же — домашний, см. риски) |
| **R2** | 5 рёбер / 6 файлов | 83→**75** (−8 om: весь run-driver кластер) | Вынос проверок стадий из ProductEngine: новый нижний модуль (уровень pipeline) с inspect/compile-возможностями; om/{input,frame-obligations,horizon,run}.ts зовут его вместо `new ProductEngine`; ProductEngine делегирует ему. om→product рёбра исчезают, 5 рёбер engine становятся односторонними (product сверху) |
| **R3** | 6 рёбер / 7 файлов | 75→73 | Читатели feasibility (readFeasibility, gateFeasibility + форма OmFeasibility) в нижний общий модуль уровня graph (тип Feasibility уже там — graph/refinement.ts); prepareFeasibility остаётся в om; потребители compiler/{basis,compiler,context}, execution/basis, graph/refinement читают снизу |
| **R4** | 6 рёбер / 2 файла | 73→73 | Читатели контекста compiler/context.ts (neighborsOf/readNeighbors, readAtomicGate, readAcceptedFrame, readFrame, readDeliveries, readWorksFrame) — единый регистрируемый фасад, потребитель один; om регистрирует при загрузке |
| **R5** | 4 ребра / 5 файлов | 73→**29** (обвал: остаётся внутреннее om-кольцо) | historicalViews → явный контекст операции (om/input.ts, om/model-call.ts по замыканию); тип контекста вниз, compiler/{compiler,context}, graph/task-obligations, product/engine получают экземпляр параметром. **Только после S1.4** |

Порядок обоснование: ни один шаг до последнего не обваливает кольцо (избыточность 22), поэтому критерий «первая = наибольшее уменьшение» выполняется так: из незаблокированных задач наибольшее уменьшение даёт **R2** (−9 файлов, целый кластер драйвера); R1 идёт перед ней как самый дешёвый проверяльщик паттерна (3 ребра, малый радиус) — если считать строго по уменьшению, R1 и R2 можно поменять местами без зависимостей между ними. R5 — самый большой эффект (−44), но заблокирован S1.4 → последний. После R5 остаётся внутреннее кольцо om 29 + discovery/graph 14 + ownership/execution 3 — кандидат на отдельный план (внутрислоевые кольца, №32 их не охватывал).

## 5. Риски

- **Порядок загрузки (TDZ)** — живой прецедент: om/refusal-journal.ts:256 `answersSourceReader` + :271 комментарий S1.1 (№1773): цикл `input → product/engine → model-call → answers-gate → refusal-journal` доходил до неинициализированного слота; лечение — регистрация без вызова при загрузке и **отказ при пустом слоте** (никогда не пропускать по форме). Все регистрационные задачи (R1, R4) обязаны повторить оба предохранителя: регистрант не вызывается при загрузке; пустой слот = типизированный отказ. Дым-тест порядка: холодный старт драйвера (om-start на копии) после каждой задачи.
- **Каскад переноса**: транзитивное замыкание по модулям om = весь каталог (33–42 файла) — переносить «файл» нельзя, только функции с их реальным срезом (R3); оценка среза — первый шаг R3, если срез тянет input.ts → переформатировать в регистрацию.
- **Регистрационный конфликт**: слот — один регистрант (journal_reader_conflict уже задан как образец), повторная регистрация = ошибка, не замена.

## 6. Пересечения с идущими задачами (идут первыми)

- **S1.4** (src/om/input.ts, src/storage/store.ts, store-view.ts, test/om-input.test.ts, test/storage.test.ts) — прямой конфликт с **R5** (input.ts, historicalViews). R5 стартует только после вливания S1.4. Остальные R1–R4 файлы S1.4 не пересекают (проверено по списку путей).
- **D8.4.1** (discovery/reader-reuse.ts, pilot-context.ts, research-continuation.ts) — пересечений с путями R1–R5 нет (кольцо в discovery не заходит; om→discovery рёбра односторонние и не трогаются).
- **S1.2** (test/om-run.test.ts) — **R2** задевает om/run.ts (`compile` выносится) и product/engine.ts; тесты run-driver поверхности: test/om-run.test.ts, om-run-driver.test.ts, om-run-control.test.ts. R2 после S1.2 либо сдача R2 включает обновление этих ожиданий.

Зависимости: R1 ∥ R2 (независимы); R3 ∥ R4 (независимы, после R2 не обязательно); R5 — после S1.4, желательно после R2 (engine уже односторонний).

## 7. Прочее

- Динамические импорты в src (3): discovery/reader.ts:880 → research-protocol.ts; discovery/response-recovery.ts:2613–2614 → synthesis-session.ts, assessment-session.ts — в кольце не участвуют, при разрывах учесть (порядок загрузки).
- Рёбра в om вне SCC (не мешают, контроль после работ): compiler/context → om/{refusal,refs}, execution/runner → om/capacity, product/engine → om/{dispatch,refusal,refs}.
- Проверка результата после каждой задачи: `/tmp/omg-ring/imports-analysis.mjs` (SCC-размер и список обратных рёбер должны монотонно уменьшаться; критерий приёмки всей работы — загрузочная SCC = 29 внутренних om + отсутствие обратных рёбер).
