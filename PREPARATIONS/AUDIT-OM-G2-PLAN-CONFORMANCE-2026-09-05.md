# Соответствие реализации OM-G2 исходной Operation Map

Дата: 5 сентября 2026.

**Вердикт: частичное соответствие. Полный продуктовый outcome исходной карты не достигнут.** Код ядра, компилятора и нескольких последующих механизмов существует. Найдены воспроизводимые нарушения требований в действующем коде, а также явно незавершённые части B05–B08. Это разные категории: отложенный блок не считается ошибкой уже принятой отдельной задачи.

Нормативная точка сравнения: [исходная карта bootstrap-manual-0.2.0](</Users/kostenchuksergey/TASKPLAN PRO V3/OM-NEW-CONTEXT/Operation-Map-of-NEW-OM.md>). Для разрешённых изменений использована [обновлённая карта в ветке реализации](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/OM-NEW-CONTEXT/Operation-Map-of-NEW-OM.md:478>) и последующие карточки TASK-PLAN.

Основной каталог V3 находится на `codex/v3-execution-core@2c9bfd72` и кода G2 не содержит. Аудировалась более поздняя реализация в `codex/om-g2-resumable-diagnostics-reissue`, commit `1e0b8cc175d646ae2d431c207aed38c632b8d62b`. Для чтения и тестов созданы изолированные копии этого commit в /private/tmp. Рабочий код, планы, Git refs и SQLite пользователя не изменялись.

## Покрытие восьми блоков

| Блок исходной карты | Что существует | Соответствие |
|---|---|---|
| **B01 — ядро графа** | Закрытые versioned schemas, каталог контрактов, canonical codec, hash-bound handle/source set, hierarchy/horizon | В основном реализован; наличие shapes само по себе не доказывает семантическую проверку B02 |
| **B02 — валидатор** | Проверки структуры, refinement, границ AU/WP, расстояния до потребителя и typed diagnostics | **Частично: пропущены обязательные проверки ссылок, единственного producer, join и review vocabulary** |
| **B03 — компилятор/self-host** | Реальная validator → handle → compiler цепочка, точные source bindings, AU/WP, зависимости, test/review manifests и bootstrap replay | **Существенно реализован, но applicability ошибочно осталась bootstrap-константой; найден дефект сортировки dependencies** |
| **B04 — research/refinement/R3** | Typed question/answer/refinement contracts, проверка repository evidence, successor graph, R3 result | **Частично: непроверяемое nonrepository evidence принимается; текущие механизмы содержат привязки к конкретным M11 units** |
| **B05 — execution projection/core adapter** | Scheduler reconciliation adapter, review admission, binary review bridge, immutable component closure | **Частично: отсутствует общая интеграция текущих AU с scheduler/renderer и отдельный маршрут PLAN_DEFECT** |
| **B06 — shadow/full self-host** | Настоящий CLI replay graph/planning/resolved/closure, exact commit/tree, typed failures и контроль побочных эффектов | Реализован для существующего ограниченного контура; его `ready` не доказывает будущий сквозной live execution |
| **B07 — runtime/recovery/anchor pilots** | M11-026: selected execution result → durable implementation terminal → cold read/recovery; M11-027 в работе | **Частично: весь pilot bundle, stable-anchor/reissue и donor snapshot/restore ещё не закрыты** |
| **B08 — era boundary/live cutover** | L1 node, future connector/anchor | **Не реализован как G2 era cutover; остаётся будущим scope** |

Процент готовности не вычислялся: блоки и требования имеют разный объём, а количество файлов или зелёных тестов не является мерой соответствия этой карте.

## Подтверждённые нарушения требований

### 1. [P1] Компилятор освобождает durable units от проверок восстановления

**Требование.** Исходная карта §§14.3–14.4 и §16 разрешает `not_applicable` для restart/cold-read/provider проверок именно двум stateless/offline bootstrap units. Применимость должна выводиться из свойств unit.

**Код.** [execution-graph-g2-v3.mjs:118](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/execution-graph-g2-v3.mjs:118>) всегда возвращает три `not_applicable`, независимо от boundaries. Значения попадают в test requirements и review requirements. [Planning schema:73](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/contracts/planning-execution-graph-g2.v1.schema.json:73>) и [resolved schema:59](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/contracts/resolved-execution-graph-g2.v3.schema.json:59>) разрешают только этот статус.

**Воспроизведение.** Текущие экспортированные validator/compiler получили неизменённые источники завершённого M11-026 commit `12a2065a9313eaa9aea64d19f1310ba8fc2bbc38`. Оба вернули `ok:true`. Для `AU-OMG2-SELECTED-IMPLEMENTATION-TERMINAL-PILOT-001` одновременно выданы:

```text
state_classification: durable
durable_state_ref: STATE-OMG2-IMPLEMENTATION-TERMINAL
durable_cold_read: not_applicable / stateless_offline_no_durable_write
restart_cold: not_applicable / stateless_offline_cli
```

**Последствие.** Машинный контракт тестирования и ревью ложно сообщает, что recovery не требуется. Наличие отдельно написанного recovery-теста не исправляет ошибку самого compiler output.

[Репродуктор через реальные exports](</private/tmp/omg2-audit-compiler-live.mjs>); аргумент запуска — указанный commit.

### 2. [P1] Refinement принимает вымышленное evidence как подтверждённый источник

**Требование.** B04: evidence/provenance, отсутствие вывода предположений как фактов; недостаточные доказательства должны оставаться unresolved.

**Код.** [refinement-g2-v1.mjs:309](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/refinement-g2-v1.mjs:309>) действительно проверяет Git commit/tree/blob/hash для `repository_evidence`. Для остальных source kinds проверяется лишь отсутствие `repository_ref`; доступный источник и соответствие его SHA не проверяются. Далее [применение answer.value](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/refinement-g2-v1.mjs:526>) меняет successor graph.

**Воспроизведение.** На штатной положительной fixture через настоящие `deriveResearchQuestionSetFromRepositoryG2V3` и `compileRefinementFromRepositoryG2V3` созданы вопросы R0, R1 и R3. Во всех трёх случаях передано:

```text
evidence_ref: unresolvable:invented-evidence
sha256: 64 нуля
repository_ref: null
source_kind: owner_decision / accepted_product_decision / runtime_evidence
```

Никакой источник этим значениям не предоставлялся. Каждый вызов вернул `ok:true, status:refined` и изменённый title узла с этим evidence в `applied_refinements`.

**Последствие.** Формально правильный пакет может превратить неподтверждённое значение в результат, помеченный как evidence-backed. Это недостаток проверки происхождения; обход внешней аутентификации этим примером не заявляется.

[Репродуктор](</private/tmp/omg2-audit-refinement-repro.mjs>).

### 3. [P2] V3 validator пропускает несуществующие ссылки активного connector и anchor

**Требование.** B02 и критерии первой AU требуют замкнутых references, реальных code/test bindings активного L3 и корректного anchor outcome.

**Код.** [operation-map-g2-v3.mjs:297](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/operation-map-g2-v3.mjs:297>) проверяет node refs, consumers и sleeping activation, но не разрешает `port_ref`, `code_ref` и `binding.test_contract_refs`. [Проверка anchors:352](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/operation-map-g2-v3.mjs:352>) не проверяет `outcome_ref`.

**Воспроизведение.** По отдельности подменены поля действующего `CONN-OMG2-AFFECTED-PLAN`:

- producer port → `PORT-DOES-NOT-EXIST`;
- producer code → `packages/does-not-exist.mjs`, symbol `fake`;
- binding test contracts → `PTC-DOES-NOT-EXIST`.

Отдельно `ANCHOR-OMG2-SHADOW-RUNTIME.outcome_ref` заменён на `ART-DOES-NOT-EXIST`. Все варианты получили `ok:true` без diagnostics.

**Последствие.** Validated handle не гарантирует существование части связей, которое обещает карта. Это также ослабление относительно [проверок v1](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/operation-map-g2.mjs:276>).

### 4. [P2] Не обеспечен единственный producer

**Требование.** Карта требует sole producer у контракта связи и будущих обязательств.

**Код.** [validateConnectors](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/operation-map-g2-v3.mjs:285>) не запрещает несколько L3 producer bindings одного connector; [v1 такую проверку содержал](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/operation-map-g2.mjs:360>).

**Воспроизведение.** Добавлен второй WP, реализующий тот же `OP-B07-AFFECTED-SELECTION`, и второй immediate L3 binding `CONN-OMG2-AFFECTED-PLAN` с новым producer. Validator вернул `ok:true`.

**Последствие.** Два producer одного результата допускаются без требуемого typed refusal. Проверка равенства boundaries не заменяет проверку единственности producer.

### 5. [P2] Обязательный join при трёх входах не проверяется

**Требование.** Исходная карта §12.5 и `TEST-OMG2-JOIN-CONTRACT`: при трёх прямых load-bearing inputs необходим явный join; правило сохранено в обновлённой карте.

**Код.** [operation-map-g2-v3.mjs:387](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/operation-map-g2-v3.mjs:387>) проверяет уже объявленные joins, но не выводит их обязательность из числа входящих connectors и не сверяет полноту incoming set.

**Воспроизведение.** К `WP-M11-027-ORDERED-EXECUTION` добавлен третий вход `CONN-OMG2-FIRST-LIVE-PILOT-PROOF` помимо двух существующих. Join у WP/AU отсутствует. Получен `ok:true`. Удаление всех join declarations также принимается.

**Последствие.** Компоновка нескольких входов может не иметь обещанного контракта missing/extra/foreign/stale/duplicate input.

**Граница доказательства для пунктов 3–5.** В committed HEAD есть пять несовпадающих evidence SHA, связанных с WIP M11-027. Для изоляции именно семантики validator только эти несовпадения устранены в памяти до фактических committed hashes. Положительный baseline после этого проходит; дальнейшие отрицательные мутации независимы. Tracked files не менялись. Использован реальный экспорт `validateOperationMapFromRepositoryG2V3`, вызываемый CLI.

[Общий репродуктор validator](</private/tmp/omg2-validator-audit.mjs>).

### 6. [P2] Negative contract для смешанного review vocabulary не реализован

**Требование.** `TEST-OMG2-REVIEW-CONTRACT` прямо требует отказа для плоского смешанного enum admission/verdict/finding class.

**Воспроизведение.** В policy catalog задано `[PASS, REQUEST_CHANGES, READY, EVIDENCE_INVALID, CODE_DEFECT, PLAN_DEFECT]` как `review_verdict_vocabulary`; новый catalog SHA корректно связан с graph. Validator возвращает `ok:true`.

**Код.** [operation-map-g2-v3.mjs:139](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/operation-map-g2-v3.mjs:139>) проверяет форму массивов, не разделение словарей. Это подтверждённое нарушение validator contract. Фактический обход runtime review этим примером не доказан. Использована та же изолированная база, что в пунктах 3–5.

### 7. [P2, компонентное доказательство] Два connector между одной парой AU объявляются циклом

**Требование.** B03 должен детерминированно выводить корректные зависимости и порядок. Два разных артефакта от одной AU к другой сами по себе цикла не образуют.

**Код.** [execution-graph-g2-v3.mjs:253](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/execution-graph-g2-v3.mjs:253>) считает indegree по каждому connector, но при decrement использует `sorted()`, удаляющий повторяющихся consumers. Для двух связей AU-P → AU-C счётчик растёт на два, уменьшается на один.

**Результат.** Неизменённая функция на таком DAG возвращает порядок `[AU-P]` и `task_dag_cycle`, вместо `[AU-P, AU-C]`. Аналогичная логика есть в v2.

[Компонентный репродуктор](</private/tmp/omg2-compiler-component-repro.mjs>). Полный CLI пример нового graph для этого пункта не выполнялся; доказательство ограничено алгоритмом, используемым production compiler.

## Недостающее покрытие исходной карты

**B04 ещё не является общим R0–R3 engine для нового продукта.** [Refinement:196](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/refinement-g2-v1.mjs:196>) требует конкретные WP M11-006/M11-007; [planningConsumer:205](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/refinement-g2-v1.mjs:205>) — конкретные AU/task IDs и соседство. [R3 engine:23](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/r3-feasibility-g2.mjs:23>) также привязан к фиксированной feasibility AU, anchors, connectors и тестам. Это рабочая ограниченная вертикаль; общий проход нового Product Concept через заявленный terminal journey ею ещё не обеспечен.

**B05 не подключён как общий источник исполнения scheduler/renderer.** [g2-execution-projection.mjs:26](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/task-scheduler/g2-execution-projection.mjs:26>) фиксирует M11-009, его title/journey/AU. Проекция более поздней текущей AU не обрабатывается общим образом. Прямые вызовы `projectSchedulerExecutionG2V1` найдены в определении, реэкспорте и тестах, но не в production scheduler/web renderer. [Production scheduler](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/task-scheduler/production-scheduler.mjs:8>) продолжает использовать прежнюю compiler projection.

Карточка M11-009 [сама ограничивает scope](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/PREPARATION/TASK-PLAN-V3.md:9483>) read-only reconciliation. Поэтому это незавершённое требование исходной B05, а не автоматически ошибка исполнения этой узкой карточки.

**Нет обещанного маршрута PLAN_DEFECT → forward graph/plan reissue.** Исходная карта §16 различает CODE_DEFECT и PLAN_DEFECT. [Фактическая обработка request_changes](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/runtime-adapter/task-execution-gates.mjs:622>) создаёт successor run той же задачи; [implementation input](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/runtime-adapter/implementation-input-package.mjs:270>) передаёт findings как обычную коррекцию кода. Соответствующие typed discriminators в production-коде отсутствуют. Binary review совместимость сохранена, но требуемая над ней маршрутизация неполна.

**B05 closure/B06 ready имеют более узкий смысл, чем завершённая live OM-G2.** [Closure](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/execution-projection-closure-g2.mjs:285>) соединяет seals и Git blob manifests семи компонентов. [B06](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/plan-compiler/shadow-replay-g2.mjs:220>) воспроизводит этот sealed output. Он не исполняет заодно весь scheduler/reviewer journey. Это соответствует ограниченному scope M11-015, но не заменяет оставшиеся B05/B07/B08 outcomes.

**B07 содержит первый durable-terminal pilot.** Реальный путь выбранного процесса и сохранения результата есть в [implementation-execution-authority.mjs:1463](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/runtime-adapter/implementation-execution-authority.mjs:1463>), append-only SQLite facts — в [execution-store.mjs:151](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/packages/sqlite-state-store/execution-store.mjs:151>). При этом [M11-026 scope](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/PREPARATION/TASK-PLAN-V3.md:11199>) прямо исключает завершение всей цепочки Candidate/FullRun/Review/TaskCommit и donor RecoveryCarrier; Windows pilot также оставлен до B08. Поэтому полный pilot bundle карты ещё отсутствует.

**B08 остаётся будущим блоком.** В [канонической карте](</Users/kostenchuksergey/TASKPLAN PRO V3/worktrees/om-g2-resumable-diagnostics-reissue/OM-NEW-CONTEXT/OPERATION-MAP-G2.json:11268>) у него нет code refs/исполняемой AU. G2 era-boundary schema/writer и цепочка prepared → Git CAS → finalized → current-plan binding не найдены. Существующий общий TaskCommit CAS не выполняет автоматически эту новую G2-boundary функцию.

## Что соответствует плану и не считается отклонением

- Python был предварительным кандидатом. Окончательный Node ESM core в `packages/plan-compiler` явно выбран обновлённым `DEC-RUNTIME-AUTHORITY`.
- Derived node levels и versioned catalog разрешены последующими решениями.
- Исторические v1/bootstrap contracts сохранены; их фиксированные две AU сами по себе не доказывают hardcode в текущем v3 compiler.
- V3 graph locator не является raw-graph bypass: sources читаются из exact parent, проходят validation и связываются с handle.
- Есть настоящие subprocess CLI tests, canonical output, hash/identity checks, counterfactual и masquerade tests. Реализация не сводится к декларациям и фиктивным функциям.
- Отдельные monolith/choke thresholds остаются unresolved даже в обновлённом decision register. Это непокрытая часть B02; отсутствие конкретного порога не выдаётся за самостоятельный доказанный code defect.

## Выполненные проверки и ограничения

Проверялось соответствие требований B01–B08 исходной карте, с прямым чтением callers/consumers, существующих тестов и отрицательными примерами. Код не исправлялся. Полный проектный FullRun и приёмка релиза не выполнялись.

**Первый адресный запуск:** 22 тестовых файла, `tests_failed`; 256 результатов по счётчику runner: 224 passed, 32 failed, 0 skipped; все 22 файла обнаружены, missing = [].

Причины не смешиваются с находками выше:

1. Шесть suites не смогли загрузить `better-sqlite3` в временной копии. Это ограничение аудиторского окружения, а не дефект проекта.
2. Current-source tests встретили пять `source_drift` и связанные вторичные failures. Все пять SHA из graph точно совпадают с незакоммиченными файлами M11-027 в исходном worktree, но не с bytes `1e0b8cc`. Это объясняет несовместимость выданной карты с одним только committed snapshot; случайное повреждение refs не установлено.

[Первый результат и полный лог](</var/folders/1k/sfc7yvss1jq2sl134vfwy0dc0000gn/T/test-operator/2026-09-05T00-39-15-763Z-95043-jBu5cT/result-full.json>).

Для шести не загрузившихся suites подключена уже установленная зависимость из исходного проекта, без установки пакетов. Повтор выбран только для этих шести файлов.

**Повтор шести suites:** `timed_out` через 300 секунд (`process_tree_timeout`). Завершённого набора результатов runner не получил: counts = 0, observedFiles = 0, missing = все шесть выбранных файлов. Это не означает, что внутри них было ноль тестов; их прохождение этим запуском не подтверждено. Повторно полный набор не запускался.

[Результат повторного запуска](</var/folders/1k/sfc7yvss1jq2sl134vfwy0dc0000gn/T/test-operator/2026-09-05T00-44-44-165Z-156-NT7e4i/result-full.json>).

Каталоги полных артефактов: [первый запуск](</var/folders/1k/sfc7yvss1jq2sl134vfwy0dc0000gn/T/test-operator/2026-09-05T00-39-15-763Z-95043-jBu5cT>), [повтор шести suites](</var/folders/1k/sfc7yvss1jq2sl134vfwy0dc0000gn/T/test-operator/2026-09-05T00-44-44-165Z-156-NT7e4i>).

Отрицательные примеры из пунктов 1–6 используют реальные exports неизменённого кода и дают ложное принятие независимо от перечисленных ограничений общего запуска. Для пункта 1 использованы неизменённые источники завершённой M11-026; для пункта 2 — штатная положительная fixture; для пунктов 3–6 — явно описанная корректировка evidence hashes только в памяти. Пункт 7 имеет компонентное доказательство.

**Итоговое различие:** фундамент OM-G2 построен, но заявленные гарантии validator/evidence/derived obligations ещё неполны; общая интеграция и финальный переход на live control plane также не завершены.

