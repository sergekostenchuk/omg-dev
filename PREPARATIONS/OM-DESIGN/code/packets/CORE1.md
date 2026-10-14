# Задача CORE1 · Ядро движка к проду: выделить код и зависимости, нужные продукту; легаси (старый маршрут без OM, совместимость с эрами, которых нет в живых данных, неактивное) удалить вместе с тестами; сборка и полный прогон — только ядро

**Цель.** Один пакет ядра: только модули пути продукта (OM-проход до компилятора и стадии, которые он читает) и их зависимости рантайма; всё остальное удалено из кода и тестов; полный прогон проверяет только ядро; сборка ядра без тестов, ui-исходников и документов — основа для INT1/SEC1 и установки на чистую машину.

## Как работать

- Ты воркер блока OM движка OMG. Рабочая копия — твоя копия, названная в сообщении о выдаче (на точной базе из карточки). Основную копию `~/OMG`, базу `.omg/state.sqlite` и `live-source` не трогай и не читай на запись.
- Писать разрешено ТОЛЬКО в эти файлы: `package.json`, `tsconfig.json`, `scripts/check-backend.mjs`, `test/fixtures/core1-records.ts`, `test/assessment-session-resume.test.ts`, `test/discovery.test.ts`, `test/execution-external-input.test.ts`, `test/om-accepted-answer.test.ts`, `test/om-achievements.test.ts`, `test/om-addressing.test.ts`, `test/om-answers-gate.test.ts`, `test/om-call-record.test.ts`, `test/om-compiler-readers.test.ts`, `test/om-composite-keys.test.ts`, `test/om-feasibility-boundary.test.ts`, `test/om-feasibility-projection.test.ts`, `test/om-feasibility.test.ts`, `test/om-frame-accept.test.ts`, `test/om-frame-candidate.test.ts`, `test/om-gap-lines.test.ts`, `test/om-gaps.test.ts`, `test/om-legacy-operation-lock.test.ts`, `test/om-legacy-route-closure.test.ts`, `test/om-model-call.test.ts`, `test/om-operation-cost.test.ts`, `test/om-probe.test.ts`, `test/om-question-packet.test.ts`, `test/om-refusal-journal.test.ts`, `test/om-repeat-gate.test.ts`, `test/om-result-identity.test.ts`, `test/om-routes.test.ts`, `test/om-run.test.ts`, `test/om-runtime-confirmation.test.ts`, `test/om-series-current.test.ts`, `test/om-series.test.ts`, `test/om-task-context.test.ts`, `test/om-task-neighbors.test.ts`, `test/om-work-zone.test.ts`, `test/preparation.test.ts`, `test/reader-pilot.test.ts`, `test/research-call-resume.test.ts`, `test/runtime-absence-r3.test.ts`, `test/runtime-absence-research.test.ts`, `test/storage.test.ts`, `test/store-view.test.ts`. Нужен другой файл — остановись и сообщи: это отход от задачи, а не твоё решение.
- Источник истины — правила ниже. Они приняты ревьюером. Если правило кажется неверным, неполным или противоречит движку — НЕ обходи его кодом: остановись и опиши противоречие с примером. Поведение продукта сам не выбирай.
- Отсутствующая возможность — типизированный отказ с адресом, не заглушка и не значение по умолчанию.
- Код движка, названный «как есть», не правится. Пробный код `PREPARATIONS/OM-DESIGN/proto/` — сценарии и контрпримеры ревью, а не код к переносу: он возвращался ревьюером 15 раз.
- Тесты: `node:test` + `node:assert/strict`, своя временная база на тест (образец — `test/storage.test.ts`), без настоящих вендоров, сети и ключей. `ui/` не трогать. push, слияния, теги — запрещены.
- Стиль движка: ESM, относительные импорты с суффиксом `.js`; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`; файлы в kebab-case, без `index.ts`; типы экспортируются рядом с реализацией; комментарии редкие, на английском, объясняют «почему». Отказ движка — `EngineError(code, message, details)` из `src/errors.ts`. Факты о движке: `PREPARATIONS/OM-DESIGN/code/engine-facts-infra.md` и `engine-facts-reuse.md` — сверяй с кодом перед использованием.
- Уроки ревью (классы дефектов, за которые код уже возвращали) — `PREPARATIONS/OM-DESIGN/code/LESSONS.md`; номера, относящиеся к задаче, — в карте рисков ниже.
- Проверяй все предусмотренные отказы СВОЕЙ единицы и существенные стыки с соседями, а не внутренние отказы неизменённого движка. Правило отсутствия — для ОБЯЗАТЕЛЬНЫХ данных. Публичной команды у модуля ещё нет (до H2): граница — функции твоей единицы и записи, законно приходящие от соседей.
- Готово, когда: обязательные тесты написаны и зелёные; изменения НЕ закоммичены, а проиндексированы только в разрешённых путях (`git add <пути>`), рабочая копия равна индексу; на этих финальных байтах ОДИН раз запущен `npm run check:backend` и он зелёный целиком; если `om/module` ушёл вперёд — перед прогоном перенеси работу на актуальный `om/module` (этот прогон и есть проверка слияния). Падение известного нестабильного теста вне твоих путей — номер наблюдения в отчёте, повтор полного прогона НЕ нужен. Мутационные проверки не обязательны. Места одного класса в своих путях чинишь сам и перечисляешь в сдаче — отдельного согласования не нужно; выход за пути или смена договора — вопрос до кода. Коммит сделает оркестратор после ревью — ровно этих байтов. Изменил байты после прогона — прогон нужен заново.
- АДРЕСНЫЕ ПРОГОНЫ НАБОРОВ по ходу работы — только через общий лимит машины (решение пользователя 29.09.2026): `python3 ~/.asvp-review/test_slot.py -- node --test dist/test/<набор>.test.js` — на всех воркеров не больше 6 одновременно, у себя не больше 2–3; при занятых местах обёртка сама ждёт. Полный прогон — только `npm run check:backend` (своя очередь), в test_slot его не заворачивать.
- Отчёт верни текстом: база `git rev-parse HEAD`, дерево финальных байтов `git write-tree`, пустой `git diff` (рабочая копия = индекс) и `git diff --cached --stat` на момент прогона; хвост вывода `npm run check:backend` (строки `# tests`, `# pass`, `# fail`); список тестов по каждому обязательному пункту; всё, что пришлось решить самому, и все места, где правило показалось неполным.

## Карта рисков этой задачи — обязательные регрессии

Выведена кодом из путей, чтений и цели задачи. В отчёте по КАЖДОМУ пункту — имя теста, который его закрывает, либо одна фраза, почему класс здесь неприменим.

- **ПРЕЖНИЕ ОЖИДАНИЯ.** В путях есть существующие наборы: `test/assessment-session-resume.test.ts`, `test/discovery.test.ts`, `test/execution-external-input.test.ts`, `test/om-accepted-answer.test.ts`, `test/om-achievements.test.ts`, `test/om-addressing.test.ts`, `test/om-answers-gate.test.ts`, `test/om-call-record.test.ts`, `test/om-compiler-readers.test.ts`, `test/om-composite-keys.test.ts`, `test/om-feasibility-boundary.test.ts`, `test/om-feasibility-projection.test.ts`, `test/om-feasibility.test.ts`, `test/om-frame-accept.test.ts`, `test/om-frame-candidate.test.ts`, `test/om-gap-lines.test.ts`, `test/om-gaps.test.ts`, `test/om-legacy-operation-lock.test.ts`, `test/om-legacy-route-closure.test.ts`, `test/om-model-call.test.ts`, `test/om-operation-cost.test.ts`, `test/om-probe.test.ts`, `test/om-question-packet.test.ts`, `test/om-refusal-journal.test.ts`, `test/om-repeat-gate.test.ts`, `test/om-result-identity.test.ts`, `test/om-routes.test.ts`, `test/om-run.test.ts`, `test/om-runtime-confirmation.test.ts`, `test/om-series-current.test.ts`, `test/om-series.test.ts`, `test/om-task-context.test.ts`, `test/om-task-neighbors.test.ts`, `test/om-work-zone.test.ts`, `test/preparation.test.ts`, `test/reader-pilot.test.ts`, `test/research-call-resume.test.ts`, `test/runtime-absence-r3.test.ts`, `test/runtime-absence-research.test.ts`, `test/storage.test.ts`, `test/store-view.test.ts`. Каждое изменённое или удалённое ожидание — перечислить в отчёте с причиной; ослаблять проверки нельзя.
- **ОКНА И ИСТОРИЯ (уроки 21, 38).** Подготовка ничего не пишет и возвращает записи и охраны; запись — одной охраняемой транзакцией. Охрана захватывается ДО проверки, которую защищает (урок 42). Регрессия: вторым Store меняется КАЖДАЯ охраняемая голова между подготовкой и записью — отказ без частичной записи. Историческое чтение — по точным сохранённым основаниям, без текущих голов; текущий допуск проверяет текущую ЛИНИЮ, а не голову одной записи.
- **ВНЕШНИЙ ИСПОЛНИТЕЛЬ (уроки 39, 40).** Явный автомат состояний; полученный внешний результат сохраняется до применения и независимо от него. Регрессия: остановка после КАЖДОЙ сохраняющей транзакции и потеря процесса → законный исход, без повторного внешнего действия и без удвоения расхода.
- **ЧТЕНИЕ НЕ СЛАБЕЕ ЗАПИСИ (урок 45, решение владельца 26.09.2026).** Обязателен, если задача вводит читателя, потребителя, исторический путь, повтор, возобновление, поставщика или вторую проверку поверх сохранённой записи — своей или другого производителя. Признаки стыка: новый код на записях прежнего производителя; производная запись над источниками (журнал, ведомость, индекс, серия); флаг current/historical или отдельный путь истории/повтора; вторая реализация проверки того же договора; физический или облегчённый читатель либо код отказа как положительное доказательство; ветвь эры по наличию поля; основание из нескольких точных ссылок разных производителей. Каждый такой путь принимает только то, что законный производитель этой эры мог записать: запись заново выводится из её точных источников ТЕМ ЖЕ общим читателем, что у производителя (одна реализация, включая совместность оснований и обязательные поля эры); форма, хэш, Ref, kind, наличие поля, код отказа и местные копии правил доказательством не являются. Регрессия на каждый вид читаемой записи: в отдельном временном Store — изменённая копия настоящей записи с пересчитанным hash/id под точным Ref (подмена содержания; удаление каждого обязательного поля; противоречивое сочетание полей; подлинная часть другого среза) → типизированный отказ ДО записи (без новых ревизий и сдвига голов) и при историческом чтении, в том числе после переоткрытия Store; контроль — законная запись и история прежней эры читаются. Мутация: в общем читателе заменить повторный вывод на успех после сверки хэша с Ref — регрессии обязаны упасть. В отчёте — таблица «запись · производитель · общий ВЫВОД · тест» по ВСЕМ читаемым сохранённым записям: в клетке «общий вывод» — функция, которая ЗАНОВО строит тело записи (включая все производные поля: результат, offset/cursor, счётчики, состояние) из точного исходного состояния и источников и используется И производителем, И историческим читателем; клетка, где указана лишь проверка вида, формы, привязок, hash или Ref, считается НЕЗАПОЛНЕННОЙ (так вернули D8.4, №1235-1: result/offset синтеза проверялись формой). Пустая или незаполненная клетка — сдача не принимается.
- **ФОРМАТЫ СВОИХ ЗАПИСЕЙ OM (решение владельца 28.09.2026, ответ ревьюера №1636).** Пока у блока OM нет живых данных (в настоящих базах записей OM ноль), собственный формат записи OM меняется НА МЕСТЕ: одна действующая схема под одним именем контракта — без второй версии рядом, без веток выпуска и чтения прежней схемы разработки, без тестов «новый код воспроизводит старые байты». Производителя и всех его потребителей в путях задачи меняй согласованно; прежние фикстуры и ожидаемые хэши переводи на действующий производитель с сохранением проверяемого поведения и перечисли в отчёте как изменённые ожидания; потребитель вне путей — вопрос до кода. НЕ относится к: записям общего движка вне OM (исследование, опрос, model-call, runtime — реальные данные в базе); действующим предметным вариантам (пакет works-v1 и om-packet/v3; режим legacy серии до первой активации); неизменяемости сохранённой ревизии (новое состояние — новая ревизия); чтению завершённого по сохранённым ссылкам. Отдельную чистку принятого кода не делай. С первыми живыми данными OM правило для них перестаёт действовать.
- **ПОДДЕЛКА СОБСТВЕННЫХ ЗАПИСЕЙ — НЕ ДЕЛАТЬ, ВСЕ ПУТИ ДВИЖКА (решение владельца 28.09.2026, ответ ревьюера №1661; распространено 13.10.2026, №4516).** Живой прогон ведёт один оператор: отдельные матрицы тестов и проверки против РУЧНОЙ подделки или порчи собственной локальной базы (пересчитанный хэш, подменённое поле своей записи, искусственная classification) не делать. ДЕЛАТЬ: различать подлинный результат одной попытки/владельца/ordinal, предъявленный другой (повторы и перезапуски сами создают соседство похожих записей); проверять недоверенный ответ модели; пользоваться общими читателями и точными связями; историческое чтение — ради продолжения после перезапуска. Если строка договора нужна только против ручной подделки — вопрос до кода, не реализация.
- **ТАБЛИЦА ИСХОДА (урок 46).** Если в договоре есть таблица исхода — по каждой её строке тест с номером строки; своих строк не добавлять.
- **ПУТИ.** Перечисли в отчёте ВСЕ публичные пути к защищаемому действию (прямой вызов, цикл, повтор, восстановление, историческое чтение); общий шаг выполняется на каждом — регрессия на каждый путь.

## Если задачу вернули

- Чинишь КЛАСС, а не воспроизведённый случай. В отчёте круга — опись всех состояний и путей этого класса в твоём коде (воспроизведённый — один из пунктов): для каждого — исход и тест. Именно так закрывались E4 и F3 — но только после третьего возврата.

## Ширина задачи

- Если решению нужно больше путей, чем разрешено, — вопрос до кода и в нём оценка: можно ли вынести стык отдельной задачей. По умолчанию отдельная задача, если путей становится больше шести или затрагивается код движка вне объявленного.

## Карточка задачи

- Точная база: ветка `om/module`, коммит `3cef0e61c339`. Версия правил: `level2-rules.mjs` sha256 `520f1e3c9388`.
- Правила: `rules-general`
- Читает записи: src, test, package.json, tsconfig.json, scripts
- Пишет записи: пакет ядра
- Из движка как есть: опись легаси №3654/№3655 (классы а–д, доля времени прогона, раздел «ядро для поставки»); граф импортов: 187 из 193 модулей достижимы из cli/server — легаси в ветвях и маршрутах, не в файлах
- Уже сделано до тебя: NR «Доверенное чтение: записанное с хэшем читается как есть, проверяется только новое (класс «проверенное чтение», 58 мест)» (src/om/model-call.ts, src/om/repeat-gate.ts, src/om/question-packet.ts, src/om/series.ts, src/om/answers-gate.ts, src/om/input.ts, src/om/frame-obligations.ts, src/om/layer-basis.ts, src/om/gaps.ts, src/om/gap-lines.ts, src/om/routes.ts, src/om/obligations.ts, src/om/refusal-journal.ts, src/om/accepted-answer.ts, src/om/assessment.ts, src/om/atomic-gate.ts, src/om/frame-candidate.ts, src/om/result-identity.ts, src/om/horizon.ts, src/graph/task-obligations.ts, src/storage/store.ts, src/evidence/evidence.ts, src/history/proofs.ts, src/storage/store-view.ts, src/om/refusal.ts); LP8 «Восстановление полученного разбора стопа A6, отвергнутого старым адаптером (серия M5:addressing держит живой проход)» (src/om/stop-analysis.ts, src/om/run.ts, src/om/model-call.ts); D8.3.1 «Поздняя квитанция новой эры оценки: регрессия и шов (дополнение №868-4)» (); D8.4.1 «Общий исторический читатель reader-result у прежних потребителей (урок 45)» (src/discovery/reader-reuse.ts, src/discovery/pilot-context.ts, src/discovery/research-continuation.ts); OWN1 «Режим «обхода»: на вопросы владельца и вопросы без производителя отвечает модель (партия MC2), позднее обязательство назначается блоку-потребителю по умолчанию — проход не встаёт в unable» (src/om/answers-gate.ts, src/om/routes.ts, src/om/addressing.ts, src/om/input.ts, src/om/obligations.ts, src/om/packet-brief.ts, src/om/gaps.ts, src/om/owner-result.ts, src/om/achievements.ts, src/om/run.ts, src/om/answer-form.ts, src/product/commands.ts, src/product/engine.ts); OWN1.1 «Все применимые ответы владельца H2 сохраняются при переходе B1 в режиме обхода (два и больше H2 до старта — ни одного вызова модели)» (src/om/run.ts, src/om/owner-result.ts, src/om/addressing.ts, src/om/answer-form.ts); OBL1 «Точный scope назначенных обязательств в пакете node-expansion: packet-brief не заменяет Ref на savedRecord, контекст несёт {id привязки, obligation, scope:{id,revision,hash}}» (src/om/packet-brief.ts, src/om/question-packet.ts, src/om/answer-form.ts, src/om/model-call.ts); OWN1.2 «Обход: D7 по умолчанию переносит только то, что работа может законно привязать; вопрос среды без H2 с runtimeCheck остаётся открытым вопросом B1 на task-start» (src/om/obligations.ts, src/graph/om-obligation-readers.ts, src/graph/task-obligations.ts, src/om/run.ts); FA1 «Оценка факта E5: форма ответа {verdict, reasons} в подсказке оценщика; попытка, чья проверка не прошла только из-за своих технических оценок E5, закрывается как interrupted — лестница спрашивает заново» (src/om/assessment.ts, src/om/run.ts); G5 «Групповая приёмка работ после смены правила D7: D7 одного точного запроса — один исходный handoff; тест пробуждения спящей связи модель выбирает явно, проверка — при приёме своей работы» (src/om/atomic-gate.ts, src/om/frame-candidate.ts, src/om/works-frame.ts, src/om/packet-brief.ts, src/om/question-packet.ts, src/om/frame-proposals.ts); G5.1 «Дополнение к точной сборке: при отказе групповой приёмки sleeping_wake_test_missing — один адресный вызов выбора теста пробуждения для работы-производителя; содержание работы не меняется» (src/om/run.ts, src/om/model-call.ts, src/om/question-packet.ts, src/om/atomic-gate.ts, src/om/frame-candidate.ts, src/om/call-record.ts, src/om/wake-choice.ts); G6 «Переход «результат попытки → apply → новые работы»: отказ групповой приёмки работ закрывается по сохранённому исходу (без вечного input_stale) и адресуется блоку-производителю; supported-факт своего блока — достигнутый результат, apply к B1 после завершения всей зависшей группы, затем новые работы с ответом в пакете; правило «одна работа — один артефакт» в бриф и в первичный приём; тест FA1 — на итог шлюза» (src/om/run.ts, src/om/atomic-gate.ts, src/om/frame-proposals.ts, src/om/packet-brief.ts, src/om/model-call.ts, src/om/question-packet.ts); G6.2 «Отказ групповой приёмки работ: rejected — только предложения с дефектом собственного содержания; находки владения отвергают кандидат, сборки писателей сохраняются; сохранённый отказ обрабатывается до повторной сборки (без вечного input_stale); строки G5 в закрытии G7 размещаются кодом» (src/om/frame-accept.ts, src/om/repeat-gate.ts, src/om/atomic-gate.ts, src/om/run.ts, src/om/packet-brief.ts, src/om/model-call.ts, src/om/series.ts); G6.1 «Владение общими файлами в группе: однозначные передачи producer_committed достраивает код, неоднозначный порядок записи — узкий выбор модели по механике G5.1» (src/om/atomic-gate.ts, src/om/frame-candidate.ts, src/om/wake-choice.ts, src/om/run.ts); EX1 «Исполнение точного плана через движок: допуск compilation → execution с явным бюджетом, устойчивый учёт и стоп отправок исполнения, сборка рабочей копии до команд задачи, заслон и сторож для исполнения (№67/68/72)» (src/product/engine.ts, src/discovery/phase-policy.ts, src/discovery/reader-pilot.ts, src/execution/runner.ts, src/execution/protocol.ts, src/execution/worktree.ts); EX1.1 «Ограничитель для исполнения (часть D EX1): заслон и сторож считают отправки исполнения теми же идентификаторами и бюджетом; №67 конец отрезка, №68 прогноз по подготовленному запросу и без расхода на восстановлении, №72 застой с последнего снятого стопа; скрипт запуска исполнения» (); EX2 «Исправление исполнения видит, что упало: в запрос исправления — ограниченная выдержка упавших проверок (оба потока, блоки not ok с diff и сводкой, отметка обрезки); узкое техническое восстановление слота исправления, потраченного вслепую; заслон считает бюджет по всем отправкам плана; start-exec и LEGACY-TESTS» (src/execution/runner.ts, src/execution/protocol.ts); EX3 «Лимит исправлений задачи в допуске исполнения: целое 0..3 вместо 0|1; счёт устойчивый, общий предел включает уже использованные» (src/discovery/reader-pilot.ts); EX4 «Исполнение: правило ПУТИ в запросах реализации и исправления (закрыть класс дефекта по всем входам задачи, регрессии на реальные пути, перечень в implementation.text); адресный абсолютный предел исправлений точной задачи плана и единый effectiveLimit во всех ветвях исправления» (src/execution/runner.ts, src/execution/protocol.ts, src/discovery/reader-pilot.ts, src/product/engine.ts); EX5 «Запросы ролей исполнения — пять классов самопроверки (ПУТИ/ОТСУТСТВИЕ/МАСКАРАД/ОКНА/СОСЕДИ): ревью выдаёт все подтверждённые находки за один проход по классам; реализация и исправление проходят классы до ответа; краткая карта рисков по контракту задачи» (src/execution/runner.ts, src/adapters/codex-stdio.ts); EX6 «Уточнение владельца к точной задаче плана в допуске исполнения (taskClarifications): текст передаётся запросам реализации, исправления и ревью как часть контракта задачи; без перекомпиляции плана» (src/discovery/reader-pilot.ts, src/execution/runner.ts); AT1 «Договор готовности работы в L3/G5 и адресные разрывы (AT1+AT2): опись влияния по графу репозитория (входы, потребители, их тесты: keep/update), решения поведения у производителя общего контракта (появление durable-состояния, provider), интерфейсы предшественников; G5 не принимает работу без полной описи; незакрытое условие — адресный разрыв (исследовать / доопределить моделью / вопрос владельцу) со штатным выходом назад к работе» (src/om/impact.ts, src/om/atomic-gate.ts, src/om/packet-brief.ts, src/om/question-packet.ts, src/om/gaps.ts, src/om/gap-lines.ts, src/om/feasibility.ts, src/graph/model.ts, src/graph/schema.ts, src/graph/semantics.ts, src/graph/layer-design.ts, src/compiler/context.ts, src/graph/builder.ts, src/om/answers-gate.ts, src/om/input.ts, src/om/run-bases.ts, src/om/run.ts); AT3a «Исполнение (исправленный AT0): адресная находка плана в ответе ревью и исход реализации contract_unexecutable с проверкой адреса движком; раннее падение полной проверки разбирает существующая роль reviewer, а не прекращает ход до ревью» (src/execution/runner.ts, src/execution/protocol.ts, src/execution/model.ts, src/adapters/codex-stdio.ts); AT3b «Маршрут дефекта плана в OM: один публичный repair-plan с ветвью OM → запись дефекта → пробел D1 над принятым L3 → пакет исправления работы → redefine → G5 → settle → явное возобновление завершённого прохода → M8 → compile» (src/om/plan-defect.ts, src/om/gaps.ts, src/om/run.ts, src/om/question-packet.ts, src/om/packet-brief.ts, src/om/frame-accept.ts, src/om/feasibility.ts, src/compiler/compiler.ts, src/product/repairs.ts); AT4 «Перенос оплаченных кандидатов и расхода между версиями плана: явное соответствие старой и новой задачи (предмет, контракт, область, зависимости), точные ссылки на старый план/попытку/parent/дерево; кандидат — непринятый исходный материал; расход и использованные исправления сохраняются однократно» (src/execution/runner.ts, src/execution/basis.ts, src/discovery/reader-pilot.ts); RL3 «Переоткрытие принятого L3 по двери AT1 явной командой владельца: принятые работы, не проходящие текущий G5, перепроектируются штатным путём (вопросы готовности B1 → модель → G5 → settle), затем M8 → компиляция; L1 и L2 не трогаются» (src/product/commands.ts, src/product/engine.ts, src/om/run.ts, src/om/gaps.ts, src/om/input.ts, src/om/frame-proposals.ts, src/om/frame-accept.ts); PF5 «Экспоненциальный пересчёт цепочки продолжений: deriveContinuation выводит пакет предыдущего звена дважды (derivePacket(prior) и readContinuationEvidence(current) → prepareAnswerForm → prepareQuestionPacket(prior)), рекурсивно по цепочке — 2^глубина; каждое прежнее звено в одной подготовке выводится ровно один раз» (src/om/question-packet.ts, src/om/model-call.ts, src/om/answer-form.ts); RB1 «Бриф переоткрытой работы — каждая обязанность модели со своим материалом в первом запросе (класс 03.10 «собрать и сразу вызвать»): полное текущее определение переоткрытых работ и находки двери по ним, тексты прямых затронутых тестов, раздел «Переоткрытые работы», маркер версии брифа» (src/om/question-packet.ts, src/om/packet-brief.ts); RS1 «Запрос чтения за концом источника усекается по концу с указанием длины, а не отвергает весь ответ модели (наблюдение №57); проверка цитат-доказательств не ослабляется» (src/evidence/evidence.ts, src/discovery/research-continuation.ts, src/discovery/pilot-context.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-sources.ts, src/discovery/research-runner.ts, src/discovery/response-recovery.ts, src/discovery/reader.ts, src/discovery/continuation-packet.ts); RS2 «Рабочая область контекста вопроса выводится одним общим правилом: текущая и историческая свёртка адресных чтений не расходятся; после read_source / read_bundle / checkpoint / answer / answer_delta следующий read_context не теряет checkpointedKeys; сравнение в research-runner остаётся строгим» (src/discovery/context-workspace.ts, src/discovery/research-continuation.ts, src/discovery/research-consumer-transition.ts); RS3 «Отказ провайдера без ответа модели распознаётся по тому, что настоящие адаптеры пишут при сбое (конверт omg-agent/v1 с usage:null без research), и даёт повторяемый исход provider-failed с новой генерацией того же шага; повторный вход после любого сохранённого отказа — восстановление исхода с рабочим выходом, а не конфликт допуска» (src/discovery/response-recovery.ts, src/discovery/research-runner.ts); RS4 «Бриф ранних стадий: каждый объявленный адрес существует в своей точной записи, выбранный вопрос приходит с полным контрактом (schema, risk, proof, obligations, contracts, targets, layerAssembly) в initial и continuation, инструкция роли и фазы не подменяется generic-продолжением» (src/discovery/continuation-packet.ts, src/discovery/working-context.ts, src/discovery/research-protocol.ts, src/discovery/planning-context.ts); RS5 «Хвост RS1: каждый читатель материала, в который может прийти выдача read_source (source-read/v1), проверяет его общим verifyReading; цитаты-доказательства остаются под строгим Evidence.verify» (src/discovery/synthesis-session.ts, src/discovery/saved-synthesis.ts); DS1 «Discovery v5 по назначению стадии: шаг 0 — план исследования от лица роли-эксперта (домен, роли, стартовые вопросы, источники, вопросы реализуемости, результат), затем отчёт исследования с источниками и вердикт go / conditional / no_go / insufficient_evidence; preparation только после принятого go; отрицательный исход — сохранённый результат и остановка до концепции, не цикл исправлений» (src/discovery/preparation-contracts.ts, src/discovery/requirements.ts, src/discovery/discovery-outcome.ts, src/discovery/research-runner.ts, src/product/stage-research.ts, src/product/stage-checks.ts, src/discovery/working-context.ts, src/discovery/research-assessment.ts, src/om/input.ts, src/discovery/research-reuse.ts, src/om/gaps.ts, src/product/commands.ts, src/product/engine.ts, src/discovery/discovery-decision.ts); WB1 «Модель прохода исследует интернет сама: действия web_search и web_fetch в протоколе исследования; движок исполняет их через шлюз (NL99), сохраняет снимок страницы как Source происхождения web и возвращает модели; дальше обычные read_source/read_bundle и строгие citations» (src/discovery/web-research.ts, src/evidence/evidence.ts, src/runtime/environment.ts, src/product/commands.ts, src/discovery/research-model.ts, src/discovery/research-consumer-transition.ts, src/discovery/research-runner.ts, src/discovery/response-recovery.ts, src/discovery/research-sources.ts, src/discovery/research-continuation.ts, src/discovery/pilot-context.ts, src/discovery/reading-plan.ts, src/discovery/planning-context.ts, src/discovery/working-context.ts, src/discovery/continuation-packet.ts, src/graph/research-basis.ts, src/discovery/early-research-outcome.ts); L1A «Материал карты L1: вопросы operation-map получают у автора и оценщика точные preparation.externalSystems принятой Discovery, каталог outcome-id / actor-id / пар requirement→outcome принятой концепции и явно названные правила движка buildL1 (результат Discovery сохраняет свой id как результатный артефакт и в success journey; промежуточные артефакты допустимы; служба ≠ runtime-вход ≠ документальный Source) — через общий researchPrerequisites, без смены FieldSpec v5» (src/discovery/research-context.ts, src/discovery/working-context.ts); DRV1 «Драйвер ранних стадий: соединение существующих производителей — сохранённый однозначный или явно выбранный draft → StageResearch (с build-map и приёмкой) → следующая стадия → после features штатный om-start / coldStart; без нового prepare на повтор, без второго accept; общий стоп на границах новых A/B/C и HTTP; общий maxTurns и отдельный физический maxCalls; исходы различимы машинно» (src/product/early-stage-driver.ts, src/product/commands.ts, src/product/engine.ts, src/product/stage-research.ts, src/discovery/consumer-research.ts, src/discovery/research-runner.ts, src/discovery/research-protocol.ts, src/discovery/web-research.ts, src/om/run-driver.ts, src/om/run-control.ts, src/discovery/invocation-progress.ts); UNK1 «Минимальная дверь неизвестного на ранних стадиях: need_research по текущему вопросу завершает ход с observation.unknown {affects, missing, searched, door} и предметной паузой research_material_missing (не ошибка модели, не отказ шлюза); новый материал позволяет продолжить тот же вопрос; upstream — только по явному структурному адресу стадии/поля; доставка unknowns старшей стадии» (src/discovery/research-model.ts, src/discovery/research-consumer-transition.ts, src/discovery/early-research-outcome.ts, src/discovery/research-runner.ts, src/discovery/response-recovery.ts, src/discovery/research-context.ts); IN1 «Поручение без приписывания модели воли владельца: вход драйвера записывает дословное поручение (Source), brief точным selector, objective — дословной целью владельца или точной копией brief; модельное понимание остаётся design (researchPlan); автор копирования и точный источник различимы; метки окна по kind — НЕ в IN1: UI только с разрешения владельца, переносится в DS1.3» (src/product/early-stage-driver.ts, src/product/commands.ts, src/product/engine.ts)

### Соседи — от кого получаешь и кому отдаёшь (из стрелок карты)

Получаешь от:
- —

Отдаёшь:
- —

### Соседи в коде (файлы прямых предшественников; содержимое — `git show <база>:<путь>`)

- `src/om/model-call.ts`
- `src/om/repeat-gate.ts`
- `src/om/question-packet.ts`
- `src/om/series.ts`
- `src/om/answers-gate.ts`
- `src/om/input.ts`
- `src/om/frame-obligations.ts`
- `src/om/layer-basis.ts`
- `src/om/gaps.ts`
- `src/om/gap-lines.ts`
- `src/om/routes.ts`
- `src/om/obligations.ts`
- `src/om/refusal-journal.ts`
- `src/om/accepted-answer.ts`
- `src/om/assessment.ts`
- `src/om/atomic-gate.ts`
- `src/om/frame-candidate.ts`
- `src/om/result-identity.ts`
- `src/om/horizon.ts`
- `src/graph/task-obligations.ts`
- `src/storage/store.ts`
- `src/evidence/evidence.ts`
- `src/history/proofs.ts`
- `src/storage/store-view.ts`
- `src/om/refusal.ts`
- `src/om/stop-analysis.ts`
- `src/om/run.ts`
- `src/discovery/reader-reuse.ts`
- `src/discovery/pilot-context.ts`
- `src/discovery/research-continuation.ts`
- `src/om/addressing.ts`
- `src/om/packet-brief.ts`
- `src/om/owner-result.ts`
- `src/om/achievements.ts`
- `src/om/answer-form.ts`
- `src/product/commands.ts`
- `src/product/engine.ts`
- `src/graph/om-obligation-readers.ts`
- `src/om/works-frame.ts`
- `src/om/frame-proposals.ts`
- `src/om/call-record.ts`
- `src/om/wake-choice.ts`
- `src/om/frame-accept.ts`
- `src/discovery/phase-policy.ts`
- `src/discovery/reader-pilot.ts`
- `src/execution/runner.ts`
- `src/execution/protocol.ts`
- `src/execution/worktree.ts`
- `src/adapters/codex-stdio.ts`
- `src/om/impact.ts`
- `src/om/feasibility.ts`
- `src/graph/model.ts`
- `src/graph/schema.ts`
- `src/graph/semantics.ts`
- `src/graph/layer-design.ts`
- `src/compiler/context.ts`
- `src/graph/builder.ts`
- `src/om/run-bases.ts`
- `src/execution/model.ts`
- `src/om/plan-defect.ts`
- `src/compiler/compiler.ts`
- `src/product/repairs.ts`
- `src/execution/basis.ts`
- `src/discovery/research-consumer-transition.ts`
- `src/discovery/research-sources.ts`
- `src/discovery/research-runner.ts`
- `src/discovery/response-recovery.ts`
- `src/discovery/reader.ts`
- `src/discovery/continuation-packet.ts`
- `src/discovery/context-workspace.ts`
- `src/discovery/working-context.ts`
- `src/discovery/research-protocol.ts`
- `src/discovery/planning-context.ts`
- `src/discovery/synthesis-session.ts`
- `src/discovery/saved-synthesis.ts`
- `src/discovery/preparation-contracts.ts`
- `src/discovery/requirements.ts`
- `src/discovery/discovery-outcome.ts`
- `src/product/stage-research.ts`
- `src/product/stage-checks.ts`
- `src/discovery/research-assessment.ts`
- `src/discovery/research-reuse.ts`
- `src/discovery/discovery-decision.ts`
- `src/discovery/web-research.ts`
- `src/runtime/environment.ts`
- `src/discovery/research-model.ts`
- `src/discovery/reading-plan.ts`
- `src/graph/research-basis.ts`
- `src/discovery/early-research-outcome.ts`
- `src/discovery/research-context.ts`
- `src/product/early-stage-driver.ts`
- `src/discovery/consumer-research.ts`
- `src/om/run-driver.ts`
- `src/om/run-control.ts`
- `src/discovery/invocation-progress.ts`

### Границы незавершённой интеграции

- нет

### Обязательные тесты

- успех
- КАЖДЫЙ код отказа единицы
- отсутствие обязательного поля, источника или набора → типизированный отказ с адресом (Т4)
- недоверенный вход: ответ модели не по форме или с чужими ссылками, подлинный результат другой попытки/владельца → отказ с адресом (подделку собственной базы не тестировать — решение владельца 28.09, 13.10)
- окно между проверкой и записью: смена охраняемой записи → отказ, а не тихая запись (Т7)
- ЧАСТЬ А (слово пользователя ~22:10 «тест смотрит только актуальную версию»; вопрос Opus-1 №3686, разрешение оркестратора): 41 файл тестов, запускающих старый движок из git, и один модуль образцов test/fixtures/core1-records.ts — формат не в живой базе → сценарий удалить; формат в живой базе → образец из снимка 1554, читает нынешний код; проверки нового не трогать
- ДО КОДА части Б — опись легаси и список удаляемого показать пользователю; удалять после его «да»
- после вырезания: прогон истории на 2352/0531 — те же вызовы и интервалы; сверка записей старым и новым кодом на копии; полный прогон короче
- сборка ядра на чистой машине: клон, установка, запуск команды на новой базе

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
