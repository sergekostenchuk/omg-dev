# RUNBOOK первого ЖИВОГО прохода omg-live (рубеж OM)

Для оператора. Проход **платный** (реальные вызовы модели gpt-6-astra) — запускать **только по прямому слову пользователя**.
Код продукта не меняется. Живая база `~/OMG/.omg/state.sqlite` — только командами продукта из этого файла; прямых правок, копий ради правки, сторонних скриптов против неё — нет.

Код прохода: **om/module = 23108da** (02.10.2026: ee2bf80 + Q2, Q2b, Q3, Q4, R3+R4, R44, Q2.1, Q2.2, T48, AD1 — адаптер devin-stdio). Проверено сухим прогоном этих же команд на копии базы с заглушкой (раздел 8): на a574007, ee2bf80 и 23108da. Если перед запуском om/module ушёл дальше — запускать на 23108da либо сначала повторить сухую проверку (≈3–8 мин) на новой голове.

## 0. Точка запуска (один раз)

Драйвер (процесс `om-start` и команд чтения) должен быть сборкой рубежа. Каталог — новый, не трогаем чужие worktree:

```bash
git -C ~/OMG worktree add --detach ~/OMG/.omg/runner-live 23108da
ln -s ~/OMG/node_modules ~/OMG/.omg/runner-live/node_modules
cd ~/OMG/.omg/runner-live && npm run build
```

Переменные для всех команд ниже (в каждом новом терминале повторить):

```bash
RUN=$HOME/OMG/.omg/runner-live
DB=$HOME/OMG/.omg/state.sqlite
omcmd() { printf '%s' "$1" | node "$RUN/dist/src/cli.js" command "$DB"; }
```

Каждая команда печатает один JSON — это ответ продукта. Ниже у каждой команды указан ожидаемый ответ.

## (а) Проверка среды и ролей адаптеров — только чтение

```bash
omcmd '{"type":"project","project":"omg-live"}' | jq '.environment'
ls -la ~/OMG/.omg/live-source/dist/src/adapters/codex-stdio.js ~/OMG/.omg/live-source/scripts/check-backend.mjs
```

Ожидаемый ответ (ключевые поля; revision может отличаться):

```json
{"id":"environment:omg-live","kind":"environment","revision":1,"value":{
 "implementer":{"actor":"omg-author","command":{"executable":"…/node","args":["…/OMG/.omg/live-source/dist/src/adapters/codex-stdio.js"]},"model":"gpt-6-astra","effort":"high"},
 "reviewer":{"actor":"omg-independent-reviewer","command":{ …то же… }},
 "timeoutMs":600000,"workspace":"/Users/kostenchuksergey/OMG/.omg/live-source",
 "fullCheck":{"executable":"…/node","args":["scripts/check-backend.mjs"]}}}
```

Контроль: обе роли — `codex-stdio.js` по **новому** пути `~/OMG/.omg/live-source/...`, модель `gpt-6-astra`. Оба файла из второй команды существуют. Если путь адаптера старый (`~/OMG/live-source/...`) — СТОП, к оркестратору, проход не начинать.

## (б) configure — ёмкость запроса ≈ 300 000 знаков

Меняется только `requestCapacityChars`; все прочие поля среды (роли, модель, workspace, fullCheck) переносятся как есть, а служебное `projectId` из хранимой записи отбрасывается (схема команды его не принимает — иначе `command_invalid`). `workspace` менять нельзя — смена пути старит принятую фазу L2.

```bash
ENV=$(omcmd '{"type":"project","project":"omg-live"}' | jq -c '.environment')
jq -cn --argjson env "$ENV" '{type:"configure",project:"omg-live",expected:$env.revision,
  environment:(($env.value | del(.projectId)) + {requestCapacityChars:300000})}' | node "$RUN/dist/src/cli.js" command "$DB" | jq '{id,revision,capacity:.value.requestCapacityChars}'
```

Ожидаемый ответ: `{"id":"environment:omg-live","revision":<старое+1>,"capacity":300000}`.
Если `ok:false` / ошибка `stale_revision` — перечитать `ENV` и повторить (кто-то уже конфигурировал).

## (в) configure-om-dispatch — протокол codex-stdio

```bash
omcmd '{"type":"configure-om-dispatch","project":"omg-live","protocol":"codex-stdio"}' | jq '{adapter:.dispatch.adapter.id, configRev:.dispatch.config.revision}'
```

Ожидаемый ответ: `{"adapter":"adapter:omg-live:codex-stdio","configRev":<revision из шага (б)>}`.
Это настройка, не доказательство: законно до и после B1.

## (г) om-start — старт прохода (платно, по слову пользователя)

Только с outcomes `["autonomous-knowledge"]`. Процесс занят весь проход (часы). Запуск — в отдельном терминале под `caffeinate` (не даёт уснуть ноутбуку), итог пишется в журнал:

```bash
caffeinate -i nohup bash -c 'printf "%s" "{\"type\":\"om-start\",\"project\":\"omg-live\",\"outcomes\":[\"autonomous-knowledge\"]}" | node "$RUN/dist/src/cli.js" command "$DB"' > ~/OMG/.omg/live-pass.log 2>&1 &
echo $!   # pid исполнителя — записать
```

Ожидаемое: молчание процесса = норма, проход идёт. Первая отправка модели — через ~2–3 мин (на копиях 116–170 с; по загруженной машине до ~6 мин). Итоговый JSON в `live-pass.log` появится только в конце: `{"ok":true,"value":{"end":"complete|unable|stopped",...}}` или отказ `{"ok":false,"refusal":{...}}`. Не запускать второй om-start, пока жив первый (один исполнитель).

## (д) Наблюдение за ходом — из второго терминала

```bash
omcmd '{"type":"om-state","project":"omg-live"}' | jq '{phase:.value.run.value.state.phase, step:.value.run.value.state.step.action, series:.value.run.value.state.step.series, attempt:.value.run.value.state.step.attempt, lastStep:.value.run.value.last.step.action, lastRefusal:.value.run.value.last.refusal, stopped:.value.control.stopped, finished:.value.control.finished, pending:[.value.control.pending[].code]}'
omcmd '{"type":"om-spend","project":"omg-live"}' | jq '{totals:.value.totals, byPurpose:.value.byPurpose, findings:[.value.findings[].code]}'
```

Ожидаемое: см. раздел «Что видно в om-state». `om-spend` считает вызовы моделей и токены (расход). Опрос — не чаще раза в 5 с.

Продолжение остановленного прохода (после (е) и ухода исполнителя):

```bash
TOKEN=$(omcmd '{"type":"om-state","project":"omg-live"}' | jq -r '.value.control.control.value.stop.token')
caffeinate -i nohup bash -c 'printf "%s" "{\"type\":\"om-continue\",\"project\":\"omg-live\",\"resumeStop\":\"'"$TOKEN"'\"}" | node "$RUN/dist/src/cli.js" command "$DB"' >> ~/OMG/.omg/live-pass.log 2>&1 &
```

Ожидаемое: если старый исполнитель доказанно ушёл — проход продолжается (control.execution = новый pid); если ещё жив — ответ `ok:false, refusal.code=run_stop_unfinished` (ждать и проверять `finished:true`).

## (е) om-stop — срочная остановка

```bash
omcmd '{"type":"om-stop","project":"omg-live"}' | jq '{stopped:.value.stopped, pending:[.value.pending[].code]}'
```

Ожидаемый ответ: `{"stopped":true,"pending":["run_stop_unfinished",...]}` — стоп сохранён сразу; текущий вызов модели доиграет или будет восстановлен. Процесс om-start завершается с `end:"stopped"`, `refusal.code:"run_stopped"` — это норма, не дефект. Проверка конца: `om-state` → `stopped:true`, `finished:true`, `pending:[]`. Возобновление — команда из (д) с `resumeStop`.

## (ж) Что НЕ делать во время прохода

- **reader-pilot не деактивировать** (команду `configure-reader-pilot` не трогать).
- **UI не открывать.** Если очень нужно — опрос проекции не чаще раза в 5 с (наблюдение №37: опрос 1,2 с разгонял проекцию до 3,7 с).
- **git в `~/OMG/.omg/live-source` не запускать** — даже `status` (переписывает stat-кэш индекса).
- Не писать в `~/OMG/.omg/state.sqlite` ничем, кроме команд продукта; копия — только `sqlite3 "file:…?mode=ro" ".backup …"`.
- Не запускать полный прогон тестов против живой базы; тяжёлые прогоны — только через `test_slot.py` на копии.
- Не менять `workspace`, роли, модель, `timeoutMs` в среде.

## Что видно в om-state во время прохода (эталон с сухих проверок)

Лента шагов (`state.step.action` сменяет `last.step.action`): старт → `open-series` → `open` → `packet` → `cycle` (вызов модели) → `close` → следующая попытка/серия.

| Ориентир | Эталон на копии (a574007/fb51a59; ee2bf80 — где указано) |
|---|---|
| bases → готовность | ~1 с |
| open-series / open / packet | 5 с / 11 с / 21–32 с |
| **первая отправка модели** | **~116–170 с от старта на a574007; 61 с на ee2bf80** (до ~6 мин на загруженной машине) |
| пересборка оснований / выбор после неё (ee2bf80) | ~45 с / ~45 с — самый дорогой шаг машинерии; до первого платного шага нового блока ~4,5 мин |
| машинерия всего прохода (6 блоков, ee2bf80) | ~30–40 мин сверх времени модели (замер Devin №2529) |
| cycle попытки 1 / 2 / 3 одной серии | 59 / 128 / 326 с на a574007; **50 / 78 / 104 с на ee2bf80** (рост ×1,3; без времени модели) |
| A6 (stop-analysis) после 3-й попытки | ~113 с на a574007; **выбор 6 с + исполнение 1 с на ee2bf80**; пакет ~91 тыс. знаков |
| Память процесса om-start | ee2bf80: серия M5 + A6 — пик RSS ~0,53 ГБ; ответ M5 + пересборка оснований + выбор — **пик RSS 1,71 ГБ / footprint 2,72 ГБ** (удержание доказательств S1.3, предел 512 записей; машина 36 ГБ) |
| Размеры пакетов | вопросы 11–13 тыс., максимум 91 тыс. — ёмкость 300 000 вмещает всё |

После A6 проход НЕ становится unable сам — открывает следующую серию. Это ожидаемо.

## Признаки, что надо остановить (om-stop + доклад оркестратору)

- **Любой отказ** в `lastRefusal` или итоге процесса (`ok:false`), кроме `run_stopped` после собственного om-stop: `frame_basis_unproven`, `route_result_unsupported`, `request_capacity`, отказы dispatch и пр.
- **Процесс om-start умер** без итогового JSON — смотреть `live-pass.log`, не перезапускать до разбора.
- **cycle дольше 15 мин** без смены шага сверх времени вызова модели (на ee2bf80 без модели максимум ~2 мин; таймаут вызова модели 10 мин отдельно).
- **RSS процесса om-start > 4 ГБ**, или RSS растёт от блока к блоку без плато (сухой пик на ee2bf80 — 1,71 ГБ при пересборке оснований; прежний порог 1,5 ГБ был выставлен по пику 0,55 ГБ старого кода и остановил бы проход без причины).
- **3+ повторов по одной точке** (одна серия, одинаковый отказ/переспрос) — стоп-правило каскадов.
- Вызов модели молчит > 10 мин — сработает `timeoutMs:600000`, проход сделает повтор сам; руками не трогать, смотреть `om-spend`.

## 8. Сухая проверка этого RUNBOOK (уже пройдена)

Эти же команды (единственная замена — в (б) роли указывают на `stub-adapter.mjs` вместо `codex-stdio.js`) прогнаны на свежей копии базы (ro `.backup`) 01.10.2026 на a574007, скрипт `/tmp/omg-runbook-kimi-run/dry-runbook.sh`, итог **DRY CHECK PASSED** за 446 с:

| Шаг | Ответ на копии |
|---|---|
| (а) | роли `codex-stdio.js` по новому пути, модель `gpt-6-astra`, workspace `~/OMG/.omg/live-source` |
| (б) | `revision:2`, `requestCapacityChars:300000`, `stubOnly=true` (схема требует `del(.projectId)` — учтено в команде) |
| (в) | `adapter:omg-live:codex-stdio` привязан к среде revision 2 |
| (г) | первая отправка удержана заглушкой через **116 с**, пакет 11 189 зн. |
| (д) | om-state: `phase:step, step:cycle, series M5:addressing, attempt 1, lastStep packet, lastRefusal null`; om-spend: `calls:1`, `call_not_settled` (норма для удержанного вызова) |
| (е) | om-stop → `stopped:true`; процесс om-start завершился за 40 с: `end:stopped`, `run_stopped`; контроль: `finished:true, pending:[]` |
| resume | om-continue с `resumeStop=<token>` → проход пошёл снова (новый удержанный вызов через 183 с); повторный om-stop → `end:stopped` |

Предохранители: платных вызовов 0 (оба вызова — заглушка, удержаны); `find ~/OMG/.omg/live-source -newer marker` = 0; живая база не тронута (работа на копии). Артефакты: `/tmp/omg-runbook-kimi-run/` (живёт до перезагрузки).

### Повтор сухой проверки на ee2bf80 (01.10.2026, Devin, канал №2507)

Тот же скрипт (копия с заменой только путей драйвера на ee2bf80), свежая ro-копия базы, под `run_lock`: **PASSED за 187 с**. Ответы (а)–(д), финал остановки, resume и повторный om-stop — дословно как на a574007. Время: первая удержанная отправка 116 → **61 с**, остановка om-start после om-stop 40 → **20 с**, следующий удержанный вызов после resume 183 → **64 с**. Пик RSS драйвера (time -l на om-continue) ≈ **0,46 ГБ**. Единственное расхождение ответа: `pending` в ответе om-stop — `["run_stop_unfinished"]` вместо двух (до остановки на обеих версиях два записи из истории живой базы; после выхода исполнителя control на обеих `pending:[]`). Предохранители: платных вызовов 0, `live-source -newer marker` = 0. Артефакты: `/tmp/omg-runbook-recheck/`.

### Повтор сухой проверки на 23108da (02.10.2026, Antigravity, канал №2703)

Тот же скрипт (копия с заменой путей драйвера на 23108da), свежая ro-копия базы, под `run_lock`: **PASSED за 187 с**. Ответы (а)–(д), финал остановки, resume и повторный om-stop — дословно как на ee2bf80. Первая удержанная отправка — **60 с**, пакет 11 189 знаков; остановка om-start после om-stop — 20 с; следующий удержанный вызов после resume — 64 с; пик RSS — 0,43 ГБ (om-continue), 0,38 ГБ (om-start). `pending` в ответе om-stop — два `run_stop_unfinished` (на ee2bf80 было один; число зависит от момента), после выхода исполнителя control на обеих — `pending:[]`. Платных вызовов 0, `live-source -newer marker` = 0. Артефакты: `/tmp/omg-runbook-ag/`.

Для прохода на SWE-2 (после AD1): в шаге (б) роли `command.args[0]` → `~/OMG/.omg/runner-live/dist/src/adapters/devin-stdio.js`, `model: "swe-2-high"`, `effort: "high"`; в шаге (в) `protocol: "devin-stdio"`. Ожидаемые ограничения: защищённые исследования с бюджетным сегментом → `budget_estimate_missing` до отправки (Devin не отдаёт расход); проверка изоляции для Devin → `sandbox_provider_unsupported`. Сначала — пробный проход на копии базы.
