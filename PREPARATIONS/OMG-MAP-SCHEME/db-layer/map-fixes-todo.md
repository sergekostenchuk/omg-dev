# Расхождения карты с кодом, найденные при сверке слоя «База»

Исправлять в карте только после проверки по коду (как F7.6 / F3.a.8 / F5.3 — исправлены 18.10, коммит 73b5cbe).

## Исполнение (агент run, 18.10)
- Ссылки со смещением: ownership.ts:9 → функция с 10; protocol.ts:186 → planDefectOf с 187; compiler/context.ts:45 — это requireFullCheck, сборка task-context в taskContext (372); runner.ts:560 → прогон проверок 569–572.
- run.f.grant «writer-index → grant»: при исполнении права записи выводит Owners из принятых task-run; writer-index читают проверка актуальности плана и планирование.
- run.s.stop: stop-execution прерывает исполнение только в своём процессе, в базу не пишет; отдельный процесс CLI получит stopped:false; долговременный стоп — om-stop через om-run-control (только для исполнения с допуском владельца).
- #x-records: нет execution-recovery, writer-index, process-stop, om-run-control.

## OM (черновые помощники остановленного агента «OM целиком», 18.10 — проверить по коду)
- om.s.resume → run-driver.ts:14 — там import.
- om.c.accept → run.ts:2180 — там acceptedFrame; completion() на 2273.
- om.s.apply → run-control.ts:289 — комментарий про освобождение исполнителя.
- om.s.stop → series.ts:27 — шапка файла, не порог серии.
- om.s.owner → run.ts:1135 — комментарий к ladder; функция на 1143.
- om.c.compiler → compiler.ts:23 — export type.
- om.l2.c4 → frame-candidate.ts:33 — константа.
- om.m8.repo → environment.ts:79 (uniqueTransactionGuards); inspectRepository на 195.
- om.c.m9 → handoff.ts:88 — readRecord внутри readHandoff; запись M9 на 161.
- om.m8.read → feasibility.ts:336; чтение в sources(), 128–145.
- B1_PRODUCERS / B1_SHARED_ORIGINS (stage-checks.ts) без om-completion-finalization, om-completion-reuse, om-stop-analysis-failure (вероятно безвредно).
- om.l3.g5 → atomic-gate.ts:342 — это proveBindingTransfer.
- om.l3.c5 → atomic-gate.ts:761 — это worksCandidate; приёмка — prepareWorksAcceptance (785).
- om-gap-line:<p>:<id> — не запись, адрес цели (gapLineKey); хранится om-gap-lines:<p>:history.
- om.l3.neighbors описывает neighbors.ts (om-neighbors); «соседи корня» MP2 — model-call.ts:2551, идут в пакет (om.r1.packet).
- Слой: dispatch-adapter → om.s.owner (wake-choice.ts:157) — по смыслу om.l3.cand.
- Слой: читатели model-call-recovery / model-late-receipt на om.r1.store (model-call.ts:3278, :2490) — это восстановление, om.s.recover.
- Слой: запись model-call под om.r1.store → model-call.ts:1918 — аргумент вызова; сама запись model-call.ts:2049.
- Нет узлов на схеме: реестр работы попытки (G7), команды владельца recover-om-capacity и permit-limited-call-retry.
- om.l2.c4: C4 — prepareCandidate (frame-candidate.ts:783), а не константа на 33.
- om.l3.g5: G5 начинается в deriveGate (atomic-gate.ts:610).
- om.c.accept: приёмка компиляции — perform case "compile" (run.ts:617).
- Коды wake_limit_reached и assessor_not_independent объявлены в WAKE_CHOICE_CODES, но не выбрасываются в wake-choice.ts (вывод).
- B1_PRODUCERS без om-wake-intent, om-wake-choice, om-l3-reopen, om-l3-release.
- prepareRebaseFrame и rejectProposals никем не вызываются в src (вывод по поиску).
- Нет узлов: om-regate, om-continue с release.
- om.s.stop: порог серии считает walk (series.ts:1587, вызов в settled — 1789).
- om.s.owner: функция ladder начинается с run.ts:1143.
- Писателя нет в src у om-owner-decision, om-origin-decision, om-input-fix (создают тесты); applySeriesActivation, writeSeriesDiscard, readDiscardedSeriesTransition вызываются только тестами (вывод) — записи om-series-applied/-current/-era/-discarded и series-transition в рабочей базе пусты.
- B1_PRODUCERS / B1_SHARED_ORIGINS без om-series-progress-transition (вывод).
- om.b1.start: startPass run-driver.ts:127, coldStart :176 (на карте 107).
- om.b1.save: writeRunBases run-bases.ts:454 (на карте 423 = chain()); своей записи у узла нет — пишет om-input, om-run, horizon, gap общих производителей.
- om.b1.gaps: управляемые основания — managedStage в run-bases.ts (модуль узла save); в рабочей базе не исполнялся (legacy).
- Сдвиги строк: startRun run.ts:374, buildOmInput input.ts:163, selectMachinePath queue.ts:204.
- om.r0.read: «читает accepted» — #r0Entries проверяет только наличие стадий (r0_inputs_missing); принятость — deriveFields (derivation_stale) в узле draft.
- om.r0.begin: перед работой читает ещё phase-policy и reader-pilot — на карте нет.
- begin-research / finish-research (engine.ts:337–338) не проверяют legacy_route_closed: R0 можно записать после первого OM-ввода (вывод).
- om.r0.finish: ссылка на строку — refinement.ts:102.
