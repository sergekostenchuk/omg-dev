# Задача DR2 · Поля v7 D1–D2 (рамка, план) с проверками кода в настоящем приёме ответа, тестовая фабрика частичного черновика, ClaimAddress (resolve и доказательство принятия раздельно), договор обхода discovery-claims/v7 в reference-sites

**Цель.** Текст задачи с обязательными поправками №5953 и уточнением №5955 — /Users/kostenchuksergey/.asvp-review/POOL-181026-C.md (согласован Codex-omg №5955, 9/10).

## Как работать

- Ты воркер блока OM движка OMG. Рабочая копия — твоя копия, названная в сообщении о выдаче (на точной базе из карточки). Основную копию `~/OMG`, базу `.omg/state.sqlite` и `live-source` не трогай и не читай на запись.
- Писать разрешено ТОЛЬКО в эти файлы: `src/discovery/v7-contracts.ts`, `src/discovery/claim-address.ts`, `src/discovery/requirements.ts`, `src/discovery/discovery.ts`, `src/storage/reference-sites.ts`, `test/discovery-v7-frame-plan.test.ts`, `test/claim-address.test.ts`. Нужен другой файл — остановись и сообщи: это отход от задачи, а не твоё решение.
- Источник истины — правила ниже. Они приняты ревьюером. Если правило кажется неверным, неполным или противоречит движку — НЕ обходи его кодом: остановись и опиши противоречие с примером. Поведение продукта сам не выбирай.
- Отсутствующая возможность — типизированный отказ с адресом, не заглушка и не значение по умолчанию.
- Код движка, названный «как есть», не правится. Пробный код `PREPARATIONS/OM-DESIGN/proto/` — сценарии и контрпримеры ревью, а не код к переносу: он возвращался ревьюером 15 раз.
- Тесты: `node:test` + `node:assert/strict`, своя временная база на тест (образец — `test/storage.test.ts`), без настоящих вендоров, сети и ключей. `ui/` не трогать. push, слияния, теги — запрещены.
- Стиль движка: ESM, относительные импорты с суффиксом `.js`; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`; файлы в kebab-case, без `index.ts`; типы экспортируются рядом с реализацией; комментарии редкие, на английском, объясняют «почему». Отказ движка — `EngineError(code, message, details)` из `src/errors.ts`. Факты о движке: `PREPARATIONS/OM-DESIGN/code/engine-facts-infra.md` и `engine-facts-reuse.md` — сверяй с кодом перед использованием.
- Уроки ревью (классы дефектов, за которые код уже возвращали) — `PREPARATIONS/OM-DESIGN/code/LESSONS.md`; номера, относящиеся к задаче, — в карте рисков ниже.
- Проверяй все предусмотренные отказы СВОЕЙ единицы и существенные стыки с соседями, а не внутренние отказы неизменённого движка. Правило отсутствия — для ОБЯЗАТЕЛЬНЫХ данных. Публичной команды у модуля ещё нет (до H2): граница — функции твоей единицы и записи, законно приходящие от соседей.
- Готово, когда: обязательные тесты написаны и зелёные; изменения НЕ закоммичены, а проиндексированы только в разрешённых путях (`git add <пути>`), рабочая копия равна индексу; на этих финальных байтах зелёные адресные наборы — свои и задетых потребителей из пакета. Полный `npm run check:backend` по отдельной задаче НЕ запускай: он один на группу задач и его запускает оркестратор на собранных байтах группы (решение владельца 18.10.2026); падение в нём оркестратор вернёт задаче-виновнице. Мутационные проверки не обязательны. Места одного класса в своих путях чинишь сам и перечисляешь в сдаче — отдельного согласования не нужно; выход за пути или смена договора — вопрос до кода. Коммит сделает оркестратор после ревью — ровно этих байтов. Изменил байты после адресных прогонов — повтори затронутые наборы.
- АДРЕСНЫЕ ПРОГОНЫ НАБОРОВ по ходу работы — только через общий лимит машины (решение пользователя 29.09.2026): `python3 ~/.asvp-review/test_slot.py -- node --test dist/test/<набор>.test.js` — на всех воркеров не больше 6 одновременно, у себя не больше 2–3; при занятых местах обёртка сама ждёт. Полный прогон группы запускает оркестратор (`npm run check:backend`, своя очередь); исполнитель его не запускает.
- Отчёт верни текстом: база `git rev-parse HEAD`, дерево финальных байтов `git write-tree`, пустой `git diff` (рабочая копия = индекс) и `git diff --cached --stat`; итоги адресных наборов по каждому файлу (`# tests`, `# pass`, `# fail`); список тестов по каждому обязательному пункту; всё, что пришлось решить самому, и все места, где правило показалось неполным.

## Карта рисков этой задачи — обязательные регрессии

Выведена кодом из путей, чтений и цели задачи. В отчёте по КАЖДОМУ пункту — имя теста, который его закрывает, либо одна фраза, почему класс здесь неприменим.

- **ЭРА ВЫВОДА (урок 41; слово владельца «тест смотрит только актуальную версию», 13.10.2026).** Ты меняешь файлы, которые уже выводят или проверяют сохранённые записи: `src/discovery/requirements.ts`, `src/discovery/discovery.ts`, `src/storage/reference-sites.ts`. Регрессия — ТОЛЬКО для форматов, которые есть в живых базах (omg-live): образец записи из снимка живой базы читает новый код с тем же результатом. Старый движок из Git для этого НЕ запускать; формата нет в живых базах — регрессию эры не делать, строкой в отчёте. Если вывод меняется — маркер договора в новых записях, история по правилу своей эры, без перебора. Если это только выделение общего механизма — докажи неизменность вывода прежними тестами без правки их ожиданий.
- **ОКНА И ИСТОРИЯ (уроки 21, 38).** Подготовка ничего не пишет и возвращает записи и охраны; запись — одной охраняемой транзакцией. Охрана захватывается ДО проверки, которую защищает (урок 42). Регрессия: вторым Store меняется КАЖДАЯ охраняемая голова между подготовкой и записью — отказ без частичной записи. Историческое чтение — по точным сохранённым основаниям, без текущих голов; текущий допуск проверяет текущую ЛИНИЮ, а не голову одной записи.
- **ИДЕНТИЧНОСТЬ И КРАТНОСТЬ (урок 33).** Регрессия с двумя потоками / потребителями / назначениями одного объекта: ничего не смешивается и не перемножается; удаление одинаковых строк — не исправление.
- **ЧТЕНИЕ НЕ СЛАБЕЕ ЗАПИСИ (урок 45, решение владельца 26.09.2026).** Обязателен, если задача вводит читателя, потребителя, исторический путь, повтор, возобновление, поставщика или вторую проверку поверх сохранённой записи — своей или другого производителя. Признаки стыка: новый код на записях прежнего производителя; производная запись над источниками (журнал, ведомость, индекс, серия); флаг current/historical или отдельный путь истории/повтора; вторая реализация проверки того же договора; физический или облегчённый читатель либо код отказа как положительное доказательство; ветвь эры по наличию поля; основание из нескольких точных ссылок разных производителей. Каждый такой путь принимает только то, что законный производитель этой эры мог записать: запись заново выводится из её точных источников ТЕМ ЖЕ общим читателем, что у производителя (одна реализация, включая совместность оснований и обязательные поля эры); форма, хэш, Ref, kind, наличие поля, код отказа и местные копии правил доказательством не являются. Регрессия на каждый вид читаемой записи: в отдельном временном Store — изменённая копия настоящей записи с пересчитанным hash/id под точным Ref (подмена содержания; удаление каждого обязательного поля; противоречивое сочетание полей; подлинная часть другого среза) → типизированный отказ ДО записи (без новых ревизий и сдвига голов) и при историческом чтении, в том числе после переоткрытия Store; контроль — законная запись и история прежней эры читаются. Мутация: в общем читателе заменить повторный вывод на успех после сверки хэша с Ref — регрессии обязаны упасть. В отчёте — таблица «запись · производитель · общий ВЫВОД · тест» по ВСЕМ читаемым сохранённым записям: в клетке «общий вывод» — функция, которая ЗАНОВО строит тело записи (включая все производные поля: результат, offset/cursor, счётчики, состояние) из точного исходного состояния и источников и используется И производителем, И историческим читателем; клетка, где указана лишь проверка вида, формы, привязок, hash или Ref, считается НЕЗАПОЛНЕННОЙ (так вернули D8.4, №1235-1: result/offset синтеза проверялись формой). Пустая или незаполненная клетка — сдача не принимается.
- **ПОДДЕЛКА СОБСТВЕННЫХ ЗАПИСЕЙ — НЕ ДЕЛАТЬ, ВСЕ ПУТИ ДВИЖКА (решение владельца 28.09.2026, ответ ревьюера №1661; распространено 13.10.2026, №4516).** Живой прогон ведёт один оператор: отдельные матрицы тестов и проверки против РУЧНОЙ подделки или порчи собственной локальной базы (пересчитанный хэш, подменённое поле своей записи, искусственная classification) не делать. ДЕЛАТЬ: различать подлинный результат одной попытки/владельца/ordinal, предъявленный другой (повторы и перезапуски сами создают соседство похожих записей); проверять недоверенный ответ модели; пользоваться общими читателями и точными связями; историческое чтение — ради продолжения после перезапуска. Если строка договора нужна только против ручной подделки — вопрос до кода, не реализация.
- **ТАБЛИЦА ИСХОДА (урок 46).** Если в договоре есть таблица исхода — по каждой её строке тест с номером строки; своих строк не добавлять.
- **ПУТИ.** Перечисли в отчёте ВСЕ публичные пути к защищаемому действию (прямой вызов, цикл, повтор, восстановление, историческое чтение); общий шаг выполняется на каждом — регрессия на каждый путь.

## Если задачу вернули

- Чинишь КЛАСС, а не воспроизведённый случай. В отчёте круга — опись всех состояний и путей этого класса в твоём коде (воспроизведённый — один из пунктов): для каждого — исход и тест. Именно так закрывались E4 и F3 — но только после третьего возврата.

## Ширина задачи

- Если решению нужно больше путей, чем разрешено, — вопрос до кода и в нём оценка: можно ли вынести стык отдельной задачей. По умолчанию отдельная задача, если путей становится больше шести или затрагивается код движка вне объявленного.

## Карточка задачи

- Точная база: ветка `om/module`, коммит `4b56e8045c38`. Версия правил: `level2-rules.mjs` sha256 `520f1e3c9388`.
- Правила: `rules-general`
- Читает записи: discovery-draft, question, research-answer — исторические формы
- Пишет записи: поля v7 D1–D2 (за выключенным производством); договор обхода discovery-claims/v7
- Из движка как есть: Discovery.#answer — discovery.ts:108–109; producerRequirements / ProducerPolicy — DR1b; reference-sites.ts:126, :229 — обход ответов
- Уже сделано до тебя: DR1a «Режим проекта (вопросы / обход): доверенная запись project-mode/v1 через отдельную ветвь полномочия владельца; отсутствие записи — project_mode_unset, не bypass; идемпотентность, атомарность, чтение точного Ref» (src/product/project-mode.ts, src/product/owner-authority.ts, src/cli.ts, src/storage/reference-sites.ts)

### Соседи — от кого получаешь и кому отдаёшь (из стрелок карты)

Получаешь от:
- —

Отдаёшь:
- —

### Соседи в коде (файлы прямых предшественников; содержимое — `git show <база>:<путь>`)

- `src/product/project-mode.ts`
- `src/product/owner-authority.ts`
- `src/cli.ts`
- `src/storage/reference-sites.ts`

### Границы незавершённой интеграции

- нет

### Обязательные тесты

- успех
- КАЖДЫЙ код отказа единицы
- отсутствие обязательного поля, источника или набора → типизированный отказ с адресом (Т4)
- недоверенный вход: ответ модели не по форме или с чужими ссылками, подлинный результат другой попытки/владельца → отказ с адресом (подделку собственной базы не тестировать — решение владельца 28.09, 13.10)
- окно между проверкой и записью: смена охраняемой записи → отказ, а не тихая запись (Т7)
- каждое правило рамки и плана — отказ с кодом через настоящий приём ответа
- устойчивость id плана относительно точной предыдущей редакции
- политика {discovery:7} при частичной таблице — not_ready; тестовая фабрика создаёт черновик D1–D2; v6 и соседние стадии без изменений
- ClaimAddress: верный, чужой/несуществующий Ref, непринятый контейнер, чужой проект, неверный kind, подмена pointer/claimId, дубль id, историческое чтение
- reference-sites: маркер только в корне тела; маркер в payload не переключает; старые ответы — прежний обход; fsck на фикстуре

## Задетые записи и читатели (слой «База»)

### `discovery-draft` — указан явно
Читателей: 108. Файлы кода (стадии карты): `src/discovery/consumer-feedback.ts` (feat, spec); `src/discovery/consumer-research.ts` (con, disc, feat, map, spec); `src/discovery/continuation-packet.ts` (disc, in); `src/discovery/derived-draft.ts` (om); `src/discovery/discovery-decision.ts` (disc); `src/discovery/discovery.ts` (con, disc, feat, map, om, spec); `src/discovery/reader.ts` (om); `src/discovery/reading-plan.ts` (om); `src/discovery/research-assessment.ts` (disc, feat, map, om, spec); `src/discovery/research-consumer-transition.ts` (feat, spec); `src/discovery/research-context.ts` (map, om); `src/discovery/research-protocol.ts` (disc, in); `src/discovery/research-runner.ts` (disc, feat, in, map, om, spec); `src/discovery/response-recovery.ts` (con, disc, in, om); `src/discovery/saved-synthesis.ts` (om); `src/discovery/stage-neighbors.ts` (feat, map, om, spec); `src/discovery/working-context.ts` (disc, in); `src/graph/obligation-handoff.ts` (om); `src/graph/refinement.ts` (om); `src/graph/repository.ts` (map, om); `src/graph/research-evidence.ts` (om); `src/om/accepted-answer.ts` (om); `src/om/horizon.ts` (om); `src/om/input.ts` (feat, om, spec); `src/pipeline/pipeline.ts` (feat, spec); `src/product/early-stage-driver.ts` (in); `src/product/engine.ts` (con, disc, feat, in, map, om, spec); `src/product/refinement-research.ts` (om); `src/product/repair-feedback.ts` (run); `src/product/repairs.ts` (run); `src/product/stage-checks.ts` (con, disc, feat, map, om, spec); `src/product/stage-research.ts` (con, feat, in, map, spec); `src/product/stage-summary.ts` (con, disc, feat, map, spec); `src/runtime/research-budget.ts` (om)

### `question` — указан явно
Читателей: 87. Файлы кода (стадии карты): `src/discovery/assessment-session.ts` (disc); `src/discovery/consumer-feedback.ts` (con, disc, feat, in, map, spec); `src/discovery/continuation-packet.ts` (disc, in); `src/discovery/discovery-decision.ts` (disc); `src/discovery/discovery-outcome.ts` (disc); `src/discovery/discovery.ts` (con, disc, feat, map, om, spec); `src/discovery/reader.ts` (om); `src/discovery/reading-plan.ts` (om); `src/discovery/research-assessment.ts` (disc); `src/discovery/research-consumer-transition.ts` (om); `src/discovery/research-context.ts` (feat, map); `src/discovery/research-history.ts` (in); `src/discovery/research-limits.ts` (disc); `src/discovery/research-protocol.ts` (disc); `src/discovery/research-runner.ts` (con, disc, feat, in, map, om, spec); `src/discovery/response-recovery.ts` (con, disc, om); `src/discovery/saved-synthesis.ts` (om); `src/discovery/stage-neighbors.ts` (feat, map, om, spec); `src/discovery/working-context.ts` (disc, in); `src/graph/repository.ts` (map, om); `src/graph/research-evidence.ts` (om); `src/om/accepted-answer.ts` (om); `src/om/input.ts` (feat, om, spec); `src/om/question-packet.ts` (om); `src/pipeline/pipeline.ts` (feat, spec); `src/product/early-stage-driver.ts` (in); `src/product/engine.ts` (feat, in, map, om); `src/product/repair-feedback.ts` (run); `src/product/repairs.ts` (run); `src/product/stage-checks.ts` (con, feat, map, om, spec); `src/product/stage-summary.ts` (con, disc, feat, map, spec); `src/runtime/research-budget.ts` (om)

### `research-answer` — указан явно
Читателей: 45. Файлы кода (стадии карты): `src/discovery/discovery-outcome.ts` (disc); `src/discovery/discovery.ts` (con, disc, feat, map, om, spec); `src/discovery/research-context.ts` (feat, map); `src/discovery/research-continuation.ts` (disc); `src/discovery/research-history.ts` (in); `src/discovery/research-reuse.ts` (disc); `src/discovery/research-runner.ts` (disc); `src/discovery/response-recovery.ts` (disc); `src/discovery/stage-neighbors.ts` (disc, feat, in, map, om, spec); `src/graph/repository.ts` (map, om); `src/graph/research-evidence.ts` (om); `src/om/accepted-answer.ts` (om); `src/om/input.ts` (feat, om, spec); `src/pipeline/pipeline.ts` (feat, spec); `src/product/engine.ts` (feat); `src/product/stage-summary.ts` (disc, feat, map, spec)

### Тесты, покрывающие читателей

- `test/adapter-lineage.test.ts` — импортирует src/product/engine.ts
- `test/assessment-read-era.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/discovery.ts, src/discovery/response-recovery.ts, src/product/engine.ts
- `test/assessment-session-resume.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/consumer-feedback.ts, src/discovery/discovery.ts, src/discovery/reader.ts, src/discovery/research-assessment.ts, src/discovery/research-context.ts, src/discovery/research-protocol.ts, src/discovery/response-recovery.ts, src/discovery/stage-neighbors.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/basis-inheritance.test.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/research-context.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/call-runtime.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-protocol.ts, src/product/engine.ts
- `test/compiler.test.ts` — импортирует src/product/engine.ts
- `test/concept-basis-application.test.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/conclusion-consolidation.test.ts` — импортирует src/discovery/continuation-packet.ts, src/discovery/discovery.ts, src/discovery/research-protocol.ts
- `test/context-recovery.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-limits.ts, src/product/engine.ts
- `test/context-workspace.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-continuation.ts
- `test/context.test.ts` — импортирует src/product/engine.ts
- `test/continuation-packet.test.ts` — импортирует src/discovery/continuation-packet.ts, src/discovery/discovery.ts, src/discovery/research-protocol.ts, src/discovery/working-context.ts
- `test/direct-assessment-acceptance.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/research-reuse.ts, src/product/engine.ts
- `test/discipline-limits.test.ts` — импортирует src/discovery/research-protocol.ts, src/discovery/working-context.ts
- `test/discovery-decision.test.ts` — импортирует src/discovery/discovery-decision.ts, src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/discovery/research-protocol.ts, src/product/engine.ts
- `test/discovery-v6-era.test.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/om/input.ts, src/product/early-stage-driver.ts, src/product/engine.ts, src/product/stage-checks.ts, src/product/stage-summary.ts
- `test/discovery.test.ts` — импортирует src/discovery/continuation-packet.ts, src/discovery/discovery.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-reuse.ts, src/discovery/response-recovery.ts, src/graph/repository.ts, src/pipeline/pipeline.ts, src/product/engine.ts
- `test/ds12-v6-release.test.ts` — импортирует src/discovery/discovery-decision.ts, src/product/engine.ts
- `test/early-research-outcome.test.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts
- `test/early-stage-briefs.test.ts` — импортирует src/discovery/continuation-packet.ts, src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/discovery/reader.ts, src/discovery/research-context.ts, src/discovery/research-protocol.ts, src/discovery/response-recovery.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/early-stage-driver.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/discovery.ts, src/product/early-stage-driver.ts, src/product/engine.ts
- `test/early-unknown.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-context.ts, src/discovery/response-recovery.ts, src/product/engine.ts
- `test/environment-readiness.test.ts` — импортирует src/product/engine.ts
- `test/execution-external-input.test.ts` — импортирует src/product/engine.ts
- `test/execution-fixture.ts` — импортирует src/product/engine.ts
- `test/execution.test.ts` — импортирует src/product/engine.ts
- `test/fixtures/omg-live-graph-r2.json` — импортирует src/discovery/discovery.ts, src/discovery/research-runner.ts, src/graph/repository.ts, src/product/engine.ts
- `test/layer-design-fixture.ts` — импортирует src/discovery/discovery.ts, src/product/engine.ts
- `test/layer-design.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-context.ts, src/product/engine.ts
- `test/map-design.test.ts` — импортирует src/discovery/discovery.ts, src/product/engine.ts
- `test/model-usage.test.ts` — импортирует src/discovery/research-protocol.ts
- `test/obligation-application.test.ts` — импортирует src/discovery/research-protocol.ts, src/product/engine.ts
- `test/obligation-evidence.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/working-context.ts, src/graph/research-evidence.ts, src/product/engine.ts
- `test/obligation-policy.test.ts` — импортирует src/discovery/discovery.ts, src/graph/research-evidence.ts
- `test/obligation-readiness.test.ts` — импортирует src/graph/obligation-handoff.ts, src/graph/refinement.ts, src/product/engine.ts
- `test/om-accepted-answer.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/research-consumer-transition.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-achievements.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-adapter-fixture.mjs` — импортирует src/product/engine.ts
- `test/om-addressing.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-answer-form.test.ts` — импортирует src/discovery/working-context.ts, src/graph/obligation-handoff.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-answers-gate.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-assessment.test.ts` — импортирует src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-atomic-gate.test.ts` — импортирует src/graph/obligation-handoff.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-call-record.test.ts` — импортирует src/discovery/discovery.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-capacity-delivery.test.ts` — импортирует src/om/question-packet.ts, src/product/engine.ts
- `test/om-commands.test.ts` — импортирует src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-compiler-readers.test.ts` — импортирует src/graph/obligation-handoff.ts
- `test/om-composite-keys.test.ts` — импортирует src/om/horizon.ts
- `test/om-deliveries.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-dispatch.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-feasibility-boundary.test.ts` — импортирует src/graph/refinement.ts, src/om/input.ts, src/product/engine.ts
- `test/om-feasibility-projection.test.ts` — импортирует src/graph/refinement.ts, src/om/input.ts, src/product/engine.ts
- `test/om-feasibility.test.ts` — импортирует src/graph/refinement.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-fixture.ts` — импортирует src/product/engine.ts
- `test/om-frame-accept.test.ts` — импортирует src/discovery/discovery.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-frame-candidate.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-frame-obligations.test.ts` — импортирует src/discovery/discovery.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-frame-proposals.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-fsck.test.ts` — импортирует src/discovery/working-context.ts, src/product/engine.ts
- `test/om-gap-lines.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-gaps.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-handoff.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-horizon.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts
- `test/om-impact-flow.test.ts` — импортирует src/om/input.ts, src/product/engine.ts
- `test/om-impact.test.ts` — импортирует src/product/engine.ts
- `test/om-input.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-consumer-transition.ts, src/om/input.ts, src/product/engine.ts
- `test/om-layer-basis.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/discovery.ts, src/discovery/research-consumer-transition.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-legacy-operation-lock.test.ts` — импортирует src/om/input.ts, src/product/engine.ts
- `test/om-legacy-route-closure.test.ts` — импортирует src/om/input.ts, src/product/engine.ts
- `test/om-model-call.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-neighbors.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-obligations.test.ts` — импортирует src/graph/obligation-handoff.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-operation-cost.test.ts` — импортирует src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-owner-result.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-packet-brief.test.ts` — импортирует src/om/question-packet.ts
- `test/om-probe.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-question-packet.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-queue.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-refusal-codes.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/pipeline/pipeline.ts
- `test/om-refusal-journal.test.ts` — импортирует src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-repeat-gate.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-result-identity.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-routes.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-run-bases.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-run-control.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-run-driver.test.ts` — импортирует src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-run.test.ts` — импортирует src/discovery/research-assessment.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-runtime-confirmation.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-series-current.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-series-transition-prepared.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-series.test.ts` — импортирует src/discovery/discovery.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-spend-report.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/om-stop-analysis.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-stop-report.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-task-context.test.ts` — импортирует src/product/engine.ts
- `test/om-task-neighbors.test.ts` — импортирует src/product/engine.ts
- `test/om-work-zone.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/om-works-frame.test.ts` — импортирует src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/operation-map-material.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-context.ts, src/discovery/research-protocol.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/owner-authority.test.ts` — импортирует src/product/engine.ts
- `test/pipeline.test.ts` — импортирует src/pipeline/pipeline.ts
- `test/preparation-run.test.ts` — импортирует src/discovery/discovery.ts, src/product/engine.ts
- `test/preparation.test.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/product/engine.ts
- `test/prior-evidence-summary.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/reader.ts, src/discovery/research-protocol.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/product-fixture.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/product/engine.ts
- `test/product.test.ts` — импортирует src/discovery/discovery.ts, src/product/engine.ts
- `test/reader-pilot.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/consumer-research.ts, src/discovery/discovery.ts, src/discovery/reader.ts, src/discovery/reading-plan.ts, src/discovery/research-assessment.ts, src/discovery/research-continuation.ts, src/discovery/research-protocol.ts, src/discovery/response-recovery.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/reader-preservation.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/reader.ts, src/discovery/research-limits.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/reading-plan-recovery.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/reading-plan.ts, src/discovery/research-limits.ts, src/product/engine.ts
- `test/refinement-research.test.ts` — импортирует src/discovery/consumer-feedback.ts, src/discovery/consumer-research.ts, src/discovery/discovery.ts, src/product/engine.ts
- `test/refinement.test.ts` — импортирует src/graph/refinement.ts, src/product/engine.ts
- `test/repair.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-context.ts, src/product/repairs.ts
- `test/request-transport-limit.test.ts` — импортирует src/discovery/research-protocol.ts
- `test/research-basis.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/working-context.ts, src/graph/research-evidence.ts, src/product/engine.ts
- `test/research-budget.test.ts` — импортирует src/runtime/research-budget.ts
- `test/research-call-resume.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/consumer-research.ts, src/discovery/discovery.ts, src/discovery/reader.ts, src/discovery/research-assessment.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-limits.ts, src/discovery/response-recovery.ts, src/discovery/stage-neighbors.ts, src/graph/research-evidence.ts, src/product/engine.ts, src/runtime/research-budget.ts
- `test/research-capacity.test.ts` — импортирует src/discovery/reader.ts, src/discovery/research-protocol.ts, src/discovery/response-recovery.ts, src/product/early-stage-driver.ts, src/product/engine.ts
- `test/research-delivery.test.ts` — импортирует src/discovery/continuation-packet.ts, src/discovery/discovery.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-continuation.ts, src/discovery/research-limits.ts, src/discovery/response-recovery.ts, src/discovery/working-context.ts
- `test/research-packet.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-history.ts, src/product/engine.ts
- `test/research-preview.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-protocol.ts, src/product/engine.ts
- `test/research-scope.test.ts` — импортирует src/discovery/discovery.ts, src/graph/research-evidence.ts
- `test/research-session-audit.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/discovery.ts, src/discovery/research-protocol.ts, src/product/engine.ts
- `test/research-trial.test.ts` — импортирует src/product/engine.ts, src/runtime/research-budget.ts
- `test/research.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/reader.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-continuation.ts, src/discovery/response-recovery.ts, src/discovery/working-context.ts, src/product/engine.ts
- `test/response-recovery.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/discovery.ts, src/discovery/research-limits.ts, src/discovery/research-protocol.ts, src/discovery/response-recovery.ts, src/product/engine.ts
- `test/role-mode.test.ts` — импортирует src/discovery/research-protocol.ts
- `test/runtime-absence-r3.test.ts` — импортирует src/graph/obligation-handoff.ts, src/graph/refinement.ts, src/om/horizon.ts, src/om/input.ts, src/pipeline/pipeline.ts, src/product/engine.ts
- `test/runtime-absence-research.test.ts` — импортирует src/discovery/assessment-session.ts, src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/response-recovery.ts, src/graph/obligation-handoff.ts, src/graph/research-evidence.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/runtime-checks.test.ts` — импортирует src/discovery/research-protocol.ts, src/product/engine.ts
- `test/runtime-observation.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/research-protocol.ts, src/graph/research-evidence.ts, src/om/horizon.ts, src/om/input.ts, src/product/engine.ts
- `test/saved-synthesis.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-continuation.ts, src/discovery/saved-synthesis.ts, src/product/engine.ts, src/runtime/research-budget.ts
- `test/server.test.ts` — импортирует src/product/engine.ts
- `test/spec-basis-application.test.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/research-context.ts, src/discovery/working-context.ts, src/product/engine.ts, src/product/stage-checks.ts
- `test/stage-checks.test.ts` — импортирует src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/graph/refinement.ts, src/product/engine.ts, src/product/stage-checks.ts
- `test/stage-neighbors.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/response-recovery.ts, src/discovery/stage-neighbors.ts, src/product/engine.ts
- `test/stage-research.test.ts` — импортирует src/discovery/consumer-feedback.ts, src/discovery/discovery-decision.ts, src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/discovery/research-context.ts, src/discovery/response-recovery.ts, src/om/input.ts, src/product/engine.ts, src/product/stage-research.ts
- `test/stage-summary.test.ts` — импортирует src/discovery/discovery-decision.ts, src/discovery/discovery-outcome.ts, src/discovery/discovery.ts, src/product/engine.ts, src/product/stage-summary.ts
- `test/storage.test.ts` — импортирует src/om/input.ts
- `test/store-view.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts
- `test/synthesis-finalization.test.ts` — импортирует src/discovery/continuation-packet.ts, src/discovery/discovery.ts, src/discovery/research-continuation.ts, src/discovery/research-limits.ts, src/discovery/research-protocol.ts, src/product/engine.ts
- `test/synthesis-session-fixture.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-limits.ts, src/discovery/research-protocol.ts, src/product/engine.ts
- `test/task-obligations.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-assessment.ts, src/graph/obligation-handoff.ts, src/product/engine.ts
- `test/technical-research-fixture.ts` — импортирует src/discovery/discovery.ts, src/product/engine.ts
- `test/technical-research.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-context.ts, src/discovery/research-reuse.ts, src/product/engine.ts
- `test/ui.test.ts` — импортирует src/discovery/discovery.ts, src/product/engine.ts
- `test/web-research.test.ts` — импортирует src/discovery/discovery.ts, src/discovery/research-consumer-transition.ts, src/discovery/response-recovery.ts, src/discovery/working-context.ts, src/product/engine.ts, src/product/stage-research.ts
- `test/web-source-consumers.test.ts` — импортирует src/discovery/discovery.ts, src/om/accepted-answer.ts, src/om/horizon.ts, src/om/input.ts, src/om/question-packet.ts, src/product/engine.ts

Связей «не проверено» среди читателей: 49. Список — подсказка для прохода «СОСЕДИ», не доказательство; групповой полный прогон обязателен.

## Дефекты — на карту и сразу на класс

- Найденный дефект (свой, ревьюера, прохода) отмечается на карте прохода: строка в узле схемы и в слое «База», не только в отчёте.
- Сразу проверяется класс: где ещё в коде то же устройство (те же записи, тот же паттерн чтения/записи, та же ветка эры) — список мест в сдаче. Чинится класс, а не один найденный случай; заплатка под конкретный прогон — возврат.

## Правила — дословно из принятой карты

### Уровень 2 · Правила · Общие требования и как это читать  `rules-general`

```text
КАК ЧИТАТЬ (слова владельца 21.09.2026: «это план-схема будущего кода — нужны правила и места, которые обязательно учесть»; способ ревью согласован с Codex, журнал №116–117)
ПОРЯДОК ЧТЕНИЯ КАРТЫ (ревью готовности, запись журнала №142): последние решения владельца → принятые правила и передачи (эта группа, LEVEL2-RULES.md) → обзор уровней 0–1; карточки функций и папка proto/ — приложение. Старый обзор отменённое правило не возвращает.
Предмет ревью уровня 2 — карточки этой группы: общие требования, две передачи между единицами и правила пяти единиц. Карточки функций (F1.1 … F7.4) и папка proto/ — ПРИЛОЖЕНИЕ: они показывают, что правило сходится с действующим кодом движка. Исправность чернового кода условием принятия схемы не является.
«Принять схему» = существенные решения определены; соседние единицы согласованы; тому, кто будет писать модуль, не придётся самому выбирать поведение продукта. Это не обещание отсутствия ошибок в будущем коде.
Блокирует: конкретное противоречие, недостающее решение или путь без определённого поведения — с примером. Если для устранения примера надо менять правило, состав данных или договорённость между единицами — это замечание к схеме. Если правило уже запрещает такое поведение, а черновик его нарушает — это замечание к черновику, схему оно не возвращает.

ОБЩИЕ ТРЕБОВАНИЯ — каждое с местами, где обязано действовать

Т0 · ГЛАВНОЕ ПРАВИЛО (слова владельца 21.09.2026: «каждый твой шаг должен вести тебя к цели, а цель эту нужно изначально определить»). Цель определена заранее и записана. Работу — и модели внутри OM, и исполнителей, которые OM строят, — регулирует ПРОДВИЖЕНИЕ К ЦЕЛИ, а не формальные лимиты: число попыток, потолки токенов и бюджеты сами по себе ничего не останавливают и не урезают. Есть продвижение — работа продолжается; нет продвижения — остановка и ЛЕСТНИЦА ПОСЛЕ ОСТАНОВКИ (решение владельца 21.09.2026, ночь): сначала причина хождения по кругу разбирается с независимым ревьюером и вырабатывается изменение — после него снова до трёх попыток; не помогло и это — вызов владельца с объяснением, почему стоим. «Нет продвижения» понимается по правилу ЗАВЕРШЁННЫХ ПОПЫТОК (правила вызовов модели): остановка — после третьей подряд завершённой попытки без продвижения, а не после первого промежуточного шага без результата. Отмена потолков не отменяет остальных требований к корректности данных, допустимости действий и проверке результата.
  Места: вызовы модели MC1 и MC2 и серии исправлений; ворота повтора G7; правила работы исполнителей (WORK-RULES.md).

Т1. Принятое читается из записи, а не угадывается заново. Где записи нет — вывод по действующим отношениям движка; неоднозначность — типизированный отказ, «первый подходящий» не выбирается.
  Места: соответствие «обязательство → конец связи» в каркасах операций и работ; адрес соседа в пакете задачи; основание готовности блока (M2 → M7); адресация вопроса (M5).

Т2. Отношения между узлами — действующая семантика движка, а не приближение. Уточнение = вложенность ИЛИ явное «реализует» (RefinementRelations). Необходимые предшественники = связи данных + requires + передачи владения (controlPredecessors). Годность квитанции — формула компилятора. Владение путём — правила writeGrants.
  Места: замыкание горизонта; принадлежность заполнения верхнему узлу; зона работ; план исполнения; адрес соседа; сверка доставки.

Т3. Производная запись проверяется повторным выводом из зафиксированных источников, а не по собственным полям.
  Места: набор пробелов (G4, G4b); пакеты соседей (G5); кандидат слоя — принимается только граф из записи кандидата (G3, G5).

Т4. Отсутствие — типизированный отказ с адресом. Нет обязательного источника, поля или набора — отказ; значений по умолчанию у обязательного нет; «пусто» передаётся явно.
  Места: вход M1 (правило эры: в записи прежней эры отсутствие структурированного поля — адресный пробел, в новой — отказ производителю стадии); готовность блока в горизонте; источники M5; аргументы всех ворот.

Т5. Переход состояния проверяет, из какого состояния идёт. Повтор того же — без изменений; противоречащее — отказ; запоздавшее не отменяет более позднего.
  Места: принятие кандидата; переход каркаса на новую базу; адресация вопроса; закрытие линии пробела; переход серий; закрытие вызова модели; учёт исхода попытки.

Т6. Порядок записей ничего не решает, кратность доезжает до потребителя.
  Места: несколько привязок одной связи (потоки); несколько потребителей; работа, уточняющая несколько операций; адреса внешних входов; ровно один пакет на работу.

Т7. Проверка и запись — одна транзакция с охраной по точным ссылкам; окна между «проверил» и «записал» нет.
  Места: учёт вызова в ведомости (запись и однократное закрытие); принятие кандидата (граф + каркас + статусы предложений); переход серий; переход каркаса на новую базу.

Т8. Отказ адресный и с маршрутом: что именно, у какого узла, кому возвращается — производителю данных, в пробел M5, владельцу, на пересмотр готовности в M2. Сам отказ ничего не переключает: не разрешает повторное исполнение, не меняет готовность, не открывает новую попытку. Обратные пути идут через G7.

Т9. Каждый пробел заполняется (решение владельца 21.09.2026). Отложенное не теряется и не закрывается без основания; нужное текущей сборке не переносится строкой результата; вес блока — только очередь.
  Места: отсрочка и линии в M5; G4b; M3.

Т10. Продуктовый выбор в коде не делается. Если для исправления надо выбрать СМЫСЛ ограничения (что считать продвижением, что считать несоразмерным расходом, замена адресации, аварийная защита бюджета) — это карточка решения владельца; до решения действует названное осторожное умолчание.

Т11. Политика неизменяема, выданное — копия. Таблицы правил не меняются во время работы; запись, отданная потребителю, не делит изменяемых объектов ни с политикой, ни с источником, из которого ворота выводят эталон. Это требование к модулю; решений схемы оно не меняет.
```
