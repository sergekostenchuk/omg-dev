# Расхождения карты с кодом, найденные при сверке слоя «База»

Исправлять в карте только после проверки по коду (как F7.6 / F3.a.8 / F5.3 — исправлены 18.10, коммит 73b5cbe).

## Исполнение (агент run, 18.10)
- Ссылки со смещением: ownership.ts:9 → функция с 10; protocol.ts:186 → planDefectOf с 187; compiler/context.ts:45 — это requireFullCheck, сборка task-context в taskContext (372); runner.ts:560 → прогон проверок 569–572.
- run.f.grant «writer-index → grant»: при исполнении права записи выводит Owners из принятых task-run; writer-index читают проверка актуальности плана и планирование.
- run.s.stop: stop-execution прерывает исполнение только в своём процессе, в базу не пишет; отдельный процесс CLI получит stopped:false; долговременный стоп — om-stop через om-run-control (только для исполнения с допуском владельца).
- #x-records: нет execution-recovery, writer-index, process-stop, om-run-control.
