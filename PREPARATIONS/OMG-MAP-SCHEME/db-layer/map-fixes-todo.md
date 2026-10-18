# Расхождения карты с кодом, найденные при сверке слоя «База» (MAPFIX1)

Сверено с кодом на базе **4b56e8045c38533424712968bc54a514be63f4a0** (om/module).
Все 55 наблюдений верифицированы по коду, привязаны к узлам/связям схемы и разделам легенды.
Пункты слоя «База» (структура видов записей и связи в db-layer.json) переведены в статус «отложено до TRACE1» согласно обязательным поправкам ревьюера №5888.

---

## 1. Исполнение (агент run)

1. **Ссылки со смещением в блоке «Исполнение»**
   - **Наблюдение**: ownership.ts:9 → функция с 10; protocol.ts:186 → planDefectOf с 187; compiler/context.ts:45 — это requireFullCheck, сборка task-context в taskContext (372); runner.ts:560 → прогон проверок 569–572.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `run.phase.inputs`, `run.phase.checks`, `run.t.inputs`, `run.t.ctx`, `run.k.exec`, `run.r.v2`, таблица контекста в легенде (строка 1283).
   - **Код 4b56e80**: `src/execution/ownership.ts:10` (`executionOwnership`), `src/execution/protocol.ts:187` (`planDefectOf`), `src/compiler/context.ts:45` (`requireFullCheck`) и `:372` (`taskContext`), `src/execution/runner.ts:569–572` (цикл прогона проверок).
   - **Обоснование**: координаты ссылок в карточках действий и таблице легенды приведены в соответствие с кодом.

2. **run.f.grant «writer-index → grant»**
   - **Наблюдение**: при исполнении права записи выводит Owners из принятых task-run; writer-index читают проверка актуальности плана и планирование.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `run.f.grant`
   - **Код 4b56e80**: `src/execution/ownership.ts:10` (`executionOwnership`), `src/compiler/compiler.ts:18`, `src/compiler/basis.ts:32`.
   - **Обоснование**: входы узла и описание обновлены: права записи выводятся из принятых `task-run` (Owners), а `writer-index` читается при проверке актуальности плана и компиляции.

3. **run.s.stop (межпроцессный стоп)**
   - **Наблюдение**: stop-execution прерывает исполнение только в своём процессе, в базу не пишет; отдельный процесс CLI получит stopped:false; долговременный стоп — om-stop через om-run-control (только для исполнения с допуском владельца).
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `run.s.stop`
   - **Код 4b56e80**: `src/execution/runner.ts:653`, `src/product/engine.ts:301` (`stopExecution`).
   - **Обоснование**: в карточке действия зафиксировано, что `stop-execution` абортирует только локальный `AbortController`, а долговременная остановка производится через `om-stop` / `om-run-control` с допуском владельца.

4. **Пропуски в таблице #x-records**
   - **Наблюдение**: нет execution-recovery, writer-index, process-stop, om-run-control.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: таблица `#x-records` в легенде (строки 1684–1694).
   - **Код 4b56e80**: `src/execution/runner.ts:151` (`execution-recovery`), `src/ownership/writer-index.ts:10` (`writer-index:<hash>`), `src/runtime/process-identity.ts:124, :168` (`process-stop:<id>:<revision>`), `src/product/engine.ts:333` (`om-run-control:<p>`).
   - **Обоснование**: таблица `#x-records` содержит все 4 вида записей с точными контрактами, шаблонами адресов и назначениями:
     - `execution-recovery:<sendId-suffix>` / `execution-recovery:<p>:<planHash>:<task>:<attempt>:implement:<ord>`: техническое восстановление слота коррекции (`runner.ts:151`), потраченного старым производителем без передачи диагностик проваленной проверки (содержит точные plan/send/basis и номер check; адрес получается заменой префикса `execution-send:` на `execution-recovery:`). Восстановление коммитов — отдельный путь `recoverCommits`.
     - `writer-index:<hash>`: индекс владельцев пути (`writer-index.ts:10`: project, path, writers, previous, root, origin; хэш `{project,path}` используется в адресе).
     - `process-stop:<id>:<revision>`: свидетельство/диагностика остановки конкретной попытки (`process-identity.ts:124, :168`), в том числе когда остановка не доказана; не является командой остановки или само по себе доказательством завершения.
     - `om-run-control:<p>`: долговременное управление остановкой и возобновлением прохода (om-stop / om-run-control с допуском владельца).

---

## 2. OM (агент OM-G2)

5. **om.s.resume**
   - **Наблюдение**: om.s.resume → run-driver.ts:14 — там import.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `om.s.resume`
   - **Код 4b56e80**: `src/om/run-driver.ts:191` (`continuePass`); на строке 14 — директива import.
   - **Обоснование**: узел связан с `run-driver.ts:191 (continuePass)` — обычное продолжение существующего прохода с сохранённым intent; никогда не создаёт проход и не снимает stop (в отличие от `resumeStoppedPass:243`).

6. **om.c.accept**
   - **Наблюдение**: om.c.accept → run.ts:2180 — там acceptedFrame; completion() на 2273.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `om.c.accept`
   - **Код 4b56e80**: `src/om/run.ts:617` (case 'compile'), `src/om/run.ts:2273` (`completion`).
   - **Обоснование**: карточка действия отражает приёмку компиляции на строке 617 и завершение прохода `completion()` на 2273; строка `run.ts:2180` (`acceptedFrame`) исключена, так как относится к поиску принятого frame для C5, а не приёмке компиляции.

7. **om.s.apply**
   - **Наблюдение**: om.s.apply → run-control.ts:289 — комментарий про освобождение исполнителя.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `om.s.apply`
   - **Код 4b56e80**: `src/om/run-driver.ts:243` (`resumeStoppedPass`), `src/om/run-control.ts:378` (`resumeStoppedRun`); на строке 289 — комментарий к снятию стопа.
   - **Обоснование**: карточка действия ссылается на `run-driver.ts:243 (resumeStoppedPass)` и `run-control.ts:378 (resumeStoppedRun)` — команда `om-continue { resumeStop: token }` снимает названный stop при доказанном завершении прежнего исполнителя, восстанавливает физические вызовы через common recovery и выходит к `continuePass` (`om.s.resume`).

8. **om.s.stop**
   - **Наблюдение**: om.s.stop → series.ts:27 — шапка файла, не порог серии.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `om.s.stop`
   - **Код 4b56e80**: `src/om/series.ts:1587` (`walk`), `src/om/series.ts:1789` (`settled`); на строке 27 — импорты и шапка файла.
   - **Обоснование**: ссылка обновлена на `series.ts:1587 (walk), :1789 (settled)`.

9. **om.s.owner**
   - **Наблюдение**: om.s.owner → run.ts:1135 — комментарий к ladder; функция на 1143.
   - **Статус**: исправлено на карте
   - **Узел / Раздел схемы**: `om.s.owner`
   - **Код 4b56e80**: `src/om/run.ts:1143` (`ladder`), `src/om/capacity-delivery.ts:316` (`recover-om-capacity`), `src/om/capacity-delivery.ts:420` (`permit-limited-call-retry`), `src/product/engine.ts:338` и `src/om/run.ts:518` (`om-regate`).
   - **Обоснование**: карточка действия ссылается на `run.ts:1143 (лестница разбора ladder)`. Описаны команды владельца `recover-om-capacity (:316)` и `permit-limited-call-retry (:420)` с их входами и результатами, а также `om-regate (engine.ts:338, run.ts:518)` — переоткрытие принятого L3. Реестр работы попытки G7 перенесён в `om.s.close`.

10. **om.c.compiler**
    - **Наблюдение**: om.c.compiler → compiler.ts:23 — export type.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.c.compiler`
    - **Код 4b56e80**: `src/compiler/compiler.ts:28` (метод `Compiler.compile`); на строке 23 — `export type CompilerOptions`, на 25 — объявление класса.
    - **Обоснование**: карточка действия ссылается на точное начало метода компиляции: `compiler.ts:28 (Compiler.compile)`.

11. **om.l2.c4**
    - **Наблюдение**: om.l2.c4 → frame-candidate.ts:33 — константа.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l2.c4`
    - **Код 4b56e80**: `src/om/frame-candidate.ts:783` (`prepareCandidate`); на строке 33 — константа `WRITE_ORDER_REFUSAL_CODES`.
    - **Обоснование**: ссылка обновлена на `prepareCandidate (frame-candidate.ts:783)`.

12. **om.m8.repo**
    - **Наблюдение**: om.m8.repo → environment.ts:79 (uniqueTransactionGuards); inspectRepository на 195.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.m8.repo`
    - **Код 4b56e80**: `src/runtime/environment.ts:195` (`inspectRepository`); на строке 79 — `uniqueTransactionGuards`.
    - **Обоснование**: ссылка обновлена на `inspectRepository (environment.ts:195)`.

13. **om.c.m9**
    - **Наблюдение**: om.c.m9 → handoff.ts:88 — readRecord внутри readHandoff; запись M9 на 161.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.c.m9`
    - **Код 4b56e80**: `src/om/handoff.ts:161` (`writeGuarded<StageArtifact>`), `:88` (`readRecord` внутри `readHandoff`).
    - **Обоснование**: карточка действия ссылается на `handoff.ts:88 (readRecord), :161 (writeHandoff)`.

14. **om.m8.read**
    - **Наблюдение**: om.m8.read → feasibility.ts:336; чтение в sources(), 128–145.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.m8.read`
    - **Код 4b56e80**: `src/om/feasibility.ts:128–145` (`sources`), `:336` (`prepareFeasibility`).
    - **Обоснование**: ссылка обновлена на `feasibility.ts:128–145 (sources), :336`.

15. **B1_PRODUCERS / B1_SHARED_ORIGINS без completion и stop failure**
    - **Наблюдение**: B1_PRODUCERS / B1_SHARED_ORIGINS (stage-checks.ts) без om-completion-finalization, om-completion-reuse, om-stop-analysis-failure (вероятно безвредно).
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: раздел «База» / `src/product/stage-checks.ts`
    - **Код 4b56e80**: `src/product/stage-checks.ts:47–57` (`B1_PRODUCERS`), `:95–118` (`B1_SHARED_ORIGINS`).
    - **Обоснование**: указанные записи не принадлежат пространству B1-источников, формируются отдельными модулями и их отсутствие в `B1_PRODUCERS` штатно и безвредно.

16. **om.l3.g5**
    - **Наблюдение**: om.l3.g5 → atomic-gate.ts:342 — это proveBindingTransfer.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l3.g5`
    - **Код 4b56e80**: `src/om/atomic-gate.ts:610` (`deriveGate`), `:342` (`proveBindingTransfer`).
    - **Обоснование**: ссылка обновлена на `atomic-gate.ts:610 (deriveGate)`.

17. **om.l3.c5**
    - **Наблюдение**: om.l3.c5 → atomic-gate.ts:761 — это worksCandidate; приёмка — prepareWorksAcceptance (785).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l3.c5`
    - **Код 4b56e80**: `src/om/atomic-gate.ts:785` (`prepareWorksAcceptance`), `:761` (`worksCandidate`).
    - **Обоснование**: ссылка обновлена на `atomic-gate.ts:785 (prepareWorksAcceptance)`.

18. **om-gap-line:<p>:<id>**
    - **Наблюдение**: om-gap-line:<p>:<id> — не запись, адрес цели (gapLineKey); хранится om-gap-lines:<p>:history.
    - **Статус**: отложено до TRACE1
    - **Узел / Раздел схемы**: слой «База» (`db-layer.json`)
    - **Код 4b56e80**: `src/om/gaps.ts:139` (`gapLineKey`), `src/om/gaps.ts:153` (`om-gap-lines:<p>:history`).
    - **Обоснование**: относится к составу видов записей в `db-layer.json`. Изменения `db-layer.json` отложены до завершения задачи TRACE1 (поправка №5888).

19. **om.l3.neighbors**
    - **Наблюдение**: om.l3.neighbors описывает neighbors.ts (om-neighbors); «соседи корня» MP2 — model-call.ts:2551, идут в пакет (om.r1.packet).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l3.neighbors`
    - **Код 4b56e80**: `src/om/neighbors.ts:16` (`om-neighbors`), `src/om/model-call.ts:2551` (`prepareNeighborRootPartitions`).
    - **Обоснование**: в карточке действия разграничены `om-neighbors` (соседи кандидата) и `MP2` (соседи корня, передаваемые в пакет вопроса `om.r1.packet`).

20. **Слой: dispatch-adapter → om.s.owner**
    - **Наблюдение**: Слой: dispatch-adapter → om.s.owner (wake-choice.ts:157) — по смыслу om.l3.cand.
    - **Статус**: отложено до TRACE1
    - **Узел / Раздел схемы**: слой «База» (`db-layer.json`)
    - **Код 4b56e80**: `src/om/wake-choice.ts:157`.
    - **Обоснование**: привязка связей слоя базы относится к `db-layer.json`, отложена до TRACE1.

21. **Слой: читатели model-call-recovery / model-late-receipt**
    - **Наблюдение**: Слой: читатели model-call-recovery / model-late-receipt на om.r1.store (model-call.ts:3278, :2490) — это восстановление, om.s.recover.
    - **Статус**: отложено до TRACE1
    - **Узел / Раздел схемы**: слой «База» (`db-layer.json`)
    - **Код 4b56e80**: `src/om/model-call.ts:2490`, `:3278`.
    - **Обоснование**: перепривязка читателей записей слоя базы относится к `db-layer.json`, отложена до TRACE1.

22. **Слой: запись model-call под om.r1.store**
    - **Наблюдение**: Слой: запись model-call под om.r1.store → model-call.ts:1918 — аргумент вызова; сама запись model-call.ts:2049.
    - **Статус**: отложено до TRACE1
    - **Узел / Раздел схемы**: слой «База» (`db-layer.json`)
    - **Код 4b56e80**: `src/om/model-call.ts:1918`, `:2049`.
    - **Обоснование**: строка записи вида `model-call` в слое базы относится к `db-layer.json`, отложена до TRACE1.

23. **Отсутствующие узлы на схеме: G7, recover-om-capacity, permit-limited-call-retry**
    - **Наблюдение**: Нет узлов на схеме: реестр работы попытки (G7), команды владельца recover-om-capacity и permit-limited-call-retry.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.s.close` (G7), `om.s.owner` (команды), подблок S
    - **Код 4b56e80**: `src/om/capacity-delivery.ts:316` (`recover-om-capacity`), `:352`, `:420` (`permit-limited-call-retry`), `src/om/run.ts:1143` (лестница разбора ladder), G7 в `src/om/run.ts:653` → `src/om/repeat-gate.ts:481` (`closeAttempt`), `repeat-gate.ts:2225` (`prepareManagedGateClose`), `model-call.ts:2774` (`readCompletionWorkAt`).
    - **Обоснование**: разделены ответственности: реестр работы попытки G7 привязан к закрытию попытки `om.s.close` («G7 — закрытие попытки: run.ts:653 → repeat-gate.ts:481 closeAttempt; управляемый путь — prepareManagedGateClose:2225. Реестр работы и его продукты читаются через model-call.ts:2774 readCompletionWorkAt. Закрытие выводит принятые результаты, классы отказов и исход A3»). Команды владельца описаны в карточке `om.s.owner`: `recover-om-capacity` (для blocked-пакета строит пригодный преемник; если преемник остаётся blocked — needs_owner без записи восстановления, :352) и `permit-limited-call-retry` (:420, вход {project, call: Ref}, разрешает повтор при process_output_limit).

24. **om.l2.c4: C4 — prepareCandidate**
    - **Наблюдение**: om.l2.c4: C4 — prepareCandidate (frame-candidate.ts:783), а не константа на 33.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l2.c4` (дублирует п. 11)
    - **Код 4b56e80**: `src/om/frame-candidate.ts:783`.
    - **Обоснование**: закрыто в п. 11, карточка содержит `prepareCandidate (frame-candidate.ts:783)`.

25. **om.l3.g5: G5 начинается в deriveGate**
    - **Наблюдение**: om.l3.g5: G5 начинается в deriveGate (atomic-gate.ts:610).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l3.g5` (дублирует п. 16)
    - **Код 4b56e80**: `src/om/atomic-gate.ts:610`.
    - **Обоснование**: закрыто в п. 16, карточка содержит `atomic-gate.ts:610 (deriveGate)`.

26. **om.c.accept: приёмка компиляции**
    - **Наблюдение**: om.c.accept: приёмка компиляции — perform case "compile" (run.ts:617).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.c.accept` (уточняет п. 6)
    - **Код 4b56e80**: `src/om/run.ts:617` (case 'compile'), `src/om/run.ts:2273` (`completion`).
    - **Обоснование**: закрыто в п. 6, карточка содержит `run.ts:617 (compile), :2273 (completion)`. Поиск принятого кадра C5 (`acceptedFrame:2180`) исключён из приёмки компиляции.

27. **Коды wake_limit_reached и assessor_not_independent**
    - **Наблюдение**: Коды wake_limit_reached и assessor_not_independent объявлены в WAKE_CHOICE_CODES, но не выбрасываются в wake-choice.ts (вывод).
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: `src/om/wake-choice.ts`
    - **Код 4b56e80**: `src/om/wake-choice.ts:31`.
    - **Обоснование**: константы объявлены в `WAKE_CHOICE_CODES` для полноты контракта перечисления, но не используются для выброса ошибок в `wake-choice.ts`.

28. **B1_PRODUCERS без wake и release**
    - **Наблюдение**: B1_PRODUCERS без om-wake-intent, om-wake-choice, om-l3-reopen, om-l3-release.
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: `src/product/stage-checks.ts:47–57`
    - **Код 4b56e80**: `src/product/stage-checks.ts:47–57`.
    - **Обоснование**: указанные записи не принадлежат B1-набору и обрабатываются движком через специализированные guards и provenance.

29. **prepareRebaseFrame и rejectProposals**
    - **Наблюдение**: prepareRebaseFrame и rejectProposals никем не вызываются в src (вывод по поиску).
    - **Статус**: частично не подтвердилось (prepareRebaseFrame вызывается в src); частично подтвердилось (rejectProposals — экспортированный API с вызовами в тестах)
    - **Узел / Раздел схемы**: `src/om/frame-accept.ts`
    - **Код 4b56e80**: `src/om/frame-accept.ts:581` (внутри `rebaseFrame` вызывается `prepareRebaseFrame`); `src/om/frame-accept.ts:488` (`rejectProposals` — экспортированная функция, вызываемая в `test/om-frame-accept.test.ts:48, 89`).
    - **Обоснование**: `prepareRebaseFrame` активно вызывается в `src/om/frame-accept.ts:581`; `rejectProposals` является частью публичного API модуля, покрытой адресными тестами.

30. **Отсутствующие узлы: om-regate, om-continue с release**
    - **Наблюдение**: Нет узлов: om-regate, om-continue с release.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.s.release`, `om.s.owner`, `om.s.apply`, `om.s.resume`, подблок S
    - **Код 4b56e80**: `src/product/engine.ts:315–328` (`om-continue`), `:338` (`om-regate`), `src/om/run.ts:518` (`regateRun`), `src/om/run.ts:1045, 1066, 1081` (`RegateRelease`, `releaseRegateWait`, `om-l3-release`), `src/om/run-driver.ts:191` (`continuePass`), `:243` (`resumeStoppedPass`).
    - **Обоснование**: на схеме присутствует выделенный узел `om.s.release` («Снять regate-wait», `om-l3-release`, `run.ts:1066`), допускающий ожидание `regate_owner_policy` (относящееся к policy-вопросам точного reopening, `run.ts:1035`), привязывающий запись к reopening и run и разрешающий продолжение по OWN1. В подблоке S убрана обязательная цепочка `apply → release → resume`: ветви `apply → resume` (снят stop через `resumeStoppedPass:243`) и `release → resume` (снят regate-wait через `releaseRegateWait:1066`) выходят независимо в `continuePass:191`, совместный путь показан условной связью `apply → release` (оба параметра). Команда владельца `om-regate` (`engine.ts:338` → `run.ts:518 regateRun`: проверяет принятый L3 — при отсутствии findings возвращает passed без reopening, `run.ts:544`; при findings переоткрывает L3 с фиксацией `om-l3-reopen`) отражена в действиях узла `om.s.owner` со связью `om-continue с release` к `release`.

31. **om.s.stop: порог серии**
    - **Наблюдение**: om.s.stop: порог серии считает walk (series.ts:1587, вызов в settled — 1789).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.s.stop` (дублирует п. 8)
    - **Код 4b56e80**: `src/om/series.ts:1587`, `:1789`.
    - **Обоснование**: закрыто в п. 8, карточка содержит `series.ts:1587 (walk), :1789 (settled)`.

32. **om.s.owner: функция ladder**
    - **Наблюдение**: om.s.owner: функция ladder начинается с run.ts:1143.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.s.owner` (дублирует п. 9)
    - **Код 4b56e80**: `src/om/run.ts:1143`.
    - **Обоснование**: закрыто в п. 9, карточка содержит `run.ts:1143 — лестница разбора`.

33. **Записи решений владельца и серии, создаваемые тестами**
    - **Наблюдение**: Писателя нет в src у om-owner-decision, om-origin-decision, om-input-fix (создают тесты); applySeriesActivation, writeSeriesDiscard, readDiscardedSeriesTransition вызываются только тестами (вывод) — записи om-series-applied/-current/-era/-discarded и series-transition в рабочей базе пусты.
    - **Статус**: частично не подтвердилось (писатель переданных оснований в src есть); частично подтвердилось (внешнее создание вызывается тестами)
    - **Узел / Раздел схемы**: `src/om/series.ts`, `src/om/repeat-gate.ts`, `test/om-series.test.ts`
    - **Код 4b56e80**: `src/om/series.ts:1310` (подготовка записи pending-основания), `:739` (применение транзакции пачки); `src/om/repeat-gate.ts:1622` (подготовка записи), `:513` (применение пачки); `src/om/series.ts:2540`, `:2548`.
    - **Обоснование**: утверждение об отсутствии писателя в src опровергнуто кодом: писатель переданного основания существует (`series.ts:1310, :739`, `repeat-gate.ts:1622, :513`), транзакция атомарно сохраняет переданное pending-основание вместе с переходом серии. Однако продуктовая команда, формирующая его первичное содержание извне, в проверенном пути не установлена (формируется в тестах `test/om-series.test.ts`). Схема не требует фиктивных продуктовых узлов для этих записей.

34. **B1_PRODUCERS без om-series-progress-transition**
    - **Наблюдение**: B1_PRODUCERS / B1_SHARED_ORIGINS без om-series-progress-transition (вывод).
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: `src/product/stage-checks.ts:47–57`
    - **Код 4b56e80**: `src/product/stage-checks.ts:47–57`.
    - **Обоснование**: `om-series-progress-transition` не входит в замкнутый перечень `B1_PRODUCERS`, что соответствует его назначению (переход прогресса серии).

35. **om.b1.start**
    - **Наблюдение**: om.b1.start: startPass run-driver.ts:127, coldStart :176 (на карте 107).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.b1.start`
    - **Код 4b56e80**: `src/om/run-driver.ts:127` (`startPass`), `:176` (`coldStart`).
    - **Обоснование**: карточка действия содержит `Первый запуск — coldStart (run-driver.ts:176), запуск прохода — startPass (run-driver.ts:127)`.

36. **om.b1.save**
    - **Наблюдение**: om.b1.save: writeRunBases run-bases.ts:454 (на карте 423 = chain()); своей записи у узла нет — пишет om-input, om-run, horizon, gap общих производителей.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.b1.save`
    - **Код 4b56e80**: `src/om/run-bases.ts:454` (`writeRunBases`); на строке 423 — внутренний метод `chain()`.
    - **Обоснование**: карточка действия содержит `run-bases.ts:454 writeRunBases`.

37. **om.b1.gaps**
    - **Наблюдение**: om.b1.gaps: управляемые основания — managedStage в run-bases.ts (модуль узла save); в рабочей базе не исполнялся (legacy).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.b1.gaps`
    - **Код 4b56e80**: `src/om/run-bases.ts:444` (`managedStage`).
    - **Обоснование**: в карточке действия зафиксировано: `M6 (run-bases.ts:444 managedStage)`.

38. **Сдвиги строк в блоке B1**
    - **Наблюдение**: Сдвиги строк: startRun run.ts:374, buildOmInput input.ts:163, selectMachinePath queue.ts:204.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.b1.rec`, `om.b1.input`, `om.b1.horizon`, таблица `#nd-handoff`
    - **Код 4b56e80**: `src/om/run.ts:374` (`startRun`), `src/om/input.ts:165` (`buildOmInput`), `src/om/queue.ts:204` (`selectMachinePath`).
    - **Обоснование**: карточки `om.b1.rec`, `om.b1.input`, `om.b1.horizon` и таблица `#nd-handoff` содержат точные координаты: `run.ts:374`, `om/input.ts:165` (исправлено с устаревших `:163` и `:160`), `queue.ts:204`.

39. **om.r0.read**
    - **Наблюдение**: om.r0.read: «читает accepted» — #r0Entries проверяет только наличие стадий (r0_inputs_missing); принятость — deriveFields (derivation_stale) в узле draft.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.r0.read`
    - **Код 4b56e80**: `src/graph/refinement.ts:64, :66` (`#r0Entries`, отказ `r0_inputs_missing`).
    - **Обоснование**: карточка действия уточнена: `refinement.ts:64` получает heads и проверяет присутствие (`r0_inputs_missing`, `:66`); проверка производных оснований не приписывается проверке наличия входов и относится к дальнейшему шагу в `draft`.

40. **om.r0.begin**
    - **Наблюдение**: om.r0.begin: перед работой читает ещё phase-policy и reader-pilot — на карте нет.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.r0.begin`
    - **Код 4b56e80**: `src/graph/refinement.ts:92` (`begin`), `:93` (`assertPilotBoundary`).
    - **Обоснование**: карточка действия и краткое описание обновлены: `begin-research R0 (refinement.ts:92), assertPilotBoundary (refinement.ts:93: читает phase-policy и reader-pilot)`.

41. **begin-research / finish-research и legacy_route_closed**
    - **Наблюдение**: begin-research / finish-research (engine.ts:337–338) не проверяют legacy_route_closed: R0 можно записать после первого OM-ввода (вывод).
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: `src/product/engine.ts:339–340`
    - **Код 4b56e80**: `src/product/engine.ts:339–340`, `src/graph/refinement.ts`.
    - **Обоснование**: команды маршрута R0 вызывают `this.refinement.begin` и `finishResearch` без проверки флага закрытия прежнего маршрута, что является известным свойством совместимости старых фаз.

42. **om.r0.finish**
    - **Наблюдение**: om.r0.finish: ссылка на строку — refinement.ts:102.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.r0.finish`
    - **Код 4b56e80**: `src/graph/refinement.ts:104` (`finishResearch`); на строке 102 — объявление типа.
    - **Обоснование**: ссылка обновлена на `finishResearch (refinement.ts:104)`.

43. **om.l1.om**
    - **Наблюдение**: om.l1.om: horizon.ts:328 → чтение L1 в deriveHorizon (horizon.ts:341, 349–355); 328 — readRefinement (старый L2).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l1.om`
    - **Код 4b56e80**: `src/om/horizon.ts:341`, `349–355` (`deriveHorizon`); на строке 328 — `readRefinement`.
    - **Обоснование**: ссылка обновлена на `horizon.ts:341, 349–355 (deriveHorizon)`.

44. **om.l1.model**
    - **Наблюдение**: om.l1.model: три вопроса — journey, operationRequirements, mapDesign.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l1.model`
    - **Код 4b56e80**: `src/product/stage-summary.ts:40–43` (`journey`, `operationRequirements`, `mapDesign`).
    - **Обоснование**: заголовок и карточка узла обновлены: `journey · opRequirements · mapDesign`, 3 вопроса модели.

45. **om.l1.gate**
    - **Наблюдение**: om.l1.gate: validateStage (stage-checks.ts:275–281, 338–349).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.l1.gate`
    - **Код 4b56e80**: `src/product/stage-checks.ts:275–279`, `337–345` (`validateStage` для стадии `operation-map`).
    - **Обоснование**: ссылка обновлена на `stage-checks.ts:275–279, 337–345 (validateStage)`.

46. **om.l1 (старый seal-layer)**
    - **Наблюдение**: om.l1 (старый seal-layer): sealLayer требует принятую features (refinement.ts:45, features_not_ready) и границу phase-policy/reader-pilot.
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: описание стадии `om.l1` («Старый путь»)
    - **Код 4b56e80**: `src/graph/refinement.ts:48` (`features_not_ready`), `:137` (`assertPilotBoundary`).
    - **Обоснование**: в описании «Старый путь» зафиксировано: `refinement.ts:48 features_not_ready, :137 assertPilotBoundary`.

47. **Слой: in.d.d1**
    - **Наблюдение**: Слой: in.d.d1 → early-stage-driver.ts:498 подписано #entryFailure, а строка в #currentStage.
    - **Статус**: отложено до TRACE1
    - **Узел / Раздел схемы**: слой «База» (`db-layer.json`)
    - **Код 4b56e80**: `src/discovery/early-stage-driver.ts:498`.
    - **Обоснование**: сопоставление связей кода в `db-layer.json` отложено до выполнения задачи TRACE1.

48. **Команды управления графом (save-graph, refine-graph, set-map-status)**
    - **Наблюдение**: Нет узлов: save-graph, refine-graph, set-map-status.
    - **Статус**: нужно решение о показе служебных входов
    - **Узел / Раздел схемы**: стадия `om.l1` / `src/product/engine.ts`
    - **Код 4b56e80**: `src/product/engine.ts:371` (`save-graph`), `src/product/engine.ts:391` (`refine-graph`), `src/product/engine.ts:281` (`set-map-status`).
    - **Обоснование**: подтверждено наличие реальных команд движка по прямому управлению графом (`engine.ts:371, :391`) и сохранению статуса карты (`engine.ts:281`). На продуктовой карте построение графа отражено узлами `om.l1.build` и `om.l1.graph`; отображение служебных/сервисных входов вынесено на решение оркестратора/архитектора.

49. **om.r1 (транзакции отказа E5 и журнала)**
    - **Наблюдение**: om.r1 (Devin, 18.10, ревью Codex-omg): источник отказа и строка журнала в сохранённом пути E5 пишутся двумя сделками (assessment.ts:746–747, затем recordRefusal на :1178), не одной; работа завершения входит в транзакцию результата только при наличии связывания попытки (assessment.ts:656 пустая пачка).
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.r1.e5`
    - **Код 4b56e80**: `src/om/assessment.ts:742–747` (`writeAssessmentRefusal`), `:1175–1178` (`recordRefusal`), `:633–640` (`writeGuarded`), `:652–673` (`prepareManagedAssessmentProducts`).
    - **Обоснование**: карточка `om.r1.e5` обновлена с точным различением путей: в сохранённом пути E5 источник отказа и строка журнала сохраняются отдельными сделками (`assessment.ts:742–747, :1175–1178`); при управляемом применении и наличии связывания попытки результат, продукты отказа/журнала и работа завершения входят в общую пачку (`:633–640, :652–673`); без связывания эта дополнительная пачка не создаётся (на `:656` пустая пачка). Проектный ответ идёт в свою проверку.

50. **layer-proposal в слое базы**
    - **Наблюдение**: layer-proposal: писатель om.r1.store — question-packet.ts:2205 (partSource) и :2268 (preparePartResult), применяет applyReceivedModelCall (model-call.ts:1773); читатель om.r1.store — checkedPart (question-packet.ts:2218).
    - **Статус**: отложено до TRACE1
    - **Узел / Раздел схемы**: слой «База» (`db-layer.json`)
    - **Код 4b56e80**: `src/om/question-packet.ts:2205, :2218, :2268`, `src/om/model-call.ts:1773`.
    - **Обоснование**: разметка писателей и читателей вида `layer-proposal` относится к `db-layer.json`, отложена до TRACE1.

51. **om-completion-close, om-completion-finalization, reuse**
    - **Наблюдение**: om-completion-close пишет closeAttempt (run.ts:653 → repeat-gate.ts managedCloseBundle) — по разметке это om.s.close; om-completion-finalization/-reuse пишут writeCompletionFinalization/writeCompletionReuse (model-call.ts:4123/4449, run.ts finalize/reuse) — om.l3.form.
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: `om.s.close`, `om.l3.form`
    - **Код 4b56e80**: `src/om/run.ts:653` (`closeAttempt`), `src/om/model-call.ts:4123, :4449`.
    - **Обоснование**: соответствие подтверждено кодом; карточки `om.s.close` и `om.l3.form` содержат подтверждённые функции и модули.

52. **om.l2: чтение головы в StageChecks.omProject и тестовый писатель om-series-discarded**
    - **Наблюдение**: om.l2 (Devin, 18.10): читатели om.c.accept у B1-видов — реальное чтение головы в StageChecks.omProject (stage-checks.ts:443; история :448), не проверка префикса в b1Address; om-answers-evaluation: доставка доказательств/журнала только при deliver=all и непустых группах (answers-gate.ts:1378); om-series-discarded: писатель существует (prepareSeriesDiscard series.ts:2540, writeSeriesDiscard :2548), но вызывается только тестами — уточнение к строке выше про «писателя нет».
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: `src/product/stage-checks.ts:443`, `src/om/answers-gate.ts:1378`, `src/om/series.ts:2540, :2548`
    - **Код 4b56e80**: `src/product/stage-checks.ts:443`, `src/om/answers-gate.ts:1378`, `src/om/series.ts:2540, :2548`.
    - **Обоснование**: уточнение принято и верифицировано по коду; схема не требует изменений.

53. **om.r2: проверка ref.id в inputs, research-scope и D7**
    - **Наблюдение**: om.r2 (Devin, 18.10, ревью Codex-omg): obligations.ts:545 — не чтение записи phase, а проверка ref.id в аргументе inputs (obligation_era_conflict); research-scope: configureResearchScope вызывается из expandResearchScope (research-scope.ts:103); om-owner-gap-assignment — продюсер только D7, сохраняет pending-запись извне; аутентификация H2 из комментария :166 в пути не реализована.
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: `src/om/obligations.ts:545`, `src/om/research-scope.ts:103`, `src/om/obligations.ts:363` (D7)
    - **Код 4b56e80**: `src/om/obligations.ts:545`, `src/om/research-scope.ts:103`.
    - **Обоснование**: подтверждено анализом реализации; карточки узлов D7 и R2 соответствуют коду.

54. **om-l3-release и om-l3-reopen**
    - **Наблюдение**: om.l3 (Devin, 18.10): читатель om.b1.gaps у om-l3-reopen — реальное чтение через request.works на gaps.ts:431 (не :415 — там выбор функции); om-l3-release СУЩЕСТВУЕТ: контракт и читатель run.ts:1045, писатель releaseRegateWait :1081, regatePolicyWait :1040 — карточку и связи включить в подблок S (пометка «вывод» при привязке к om.s.resume); ранее неверно «вида нет».
    - **Статус**: исправлено на карте
    - **Узел / Раздел схемы**: `om.s.release`, `om.s`, подблок S
    - **Код 4b56e80**: `src/om/run.ts:1045` (`RegateRelease`), `src/om/run.ts:1066, 1081` (`releaseRegateWait`), `src/om/gaps.ts:431`.
    - **Обоснование**: узел `om.s.release` («Снять regate-wait», `om-l3-release`) отражает `run.ts:1066` (`releaseRegateWait`): команда `om-continue { release: "regate_owner_policy" }` допускает только ожидание `regate_owner_policy`, привязывает запись `om-l3-release` (`:1045, :1081`) к точному reopening и run и разрешает продолжение по OWN1. В подблоке S ветви `apply → resume` (снят stop) и `release → resume` (снят regate-wait) разведены независимыми выходами к `continuePass`, с условной совместной ветвью `apply → release` при двух параметрах.

55. **Раздел Discovery и ветви OM**
    - **Наблюдение**: Раздел Discovery (Devin, 18.10, ревью Codex-omg №5808): штатный Researcher для Discovery не выбирает OM pilot/planning/synthesis-ветви; общие функции и архивные форматы записей не доказывают их исполнения в этой стадии.
    - **Статус**: подтвердилось по коду / не требует правок схемы
    - **Узел / Раздел схемы**: стадия Discovery
    - **Код 4b56e80**: `src/discovery/researcher.ts`, `src/discovery/research-runner.ts`, ревью Codex-omg №5808.
    - **Обоснование**: штатный Researcher стадии Discovery изолирован от OM-ветвей pilot/planning/synthesis, что зафиксировано в архитектуре стадии и не требует корректировки схемы.
