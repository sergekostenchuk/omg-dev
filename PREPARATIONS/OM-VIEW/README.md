# OM-VIEW — выгрузка карты OMG для просмотрщика (этап 1)

Просмотрщик живёт в Owner Workbench (`~/ASVP/UI/asvh-workbench`, ветка `om-map`, раздел `src/sections/om-map/`).
Здесь — только выгрузка данных из копии живой базы и снимки экрана.

## Обновить данные

```bash
cd ~/OMG/PREPARATIONS/OM-VIEW
# 1. копия живой базы — единственный разрешённый способ (mode=ro + .backup)
sqlite3 "file:$HOME/OMG/.omg/state.sqlite?mode=ro" ".backup './state-copy.sqlite'"
# 2. выгрузка → data/map.json (node ≥ 22.5, node:sqlite; живую базу скрипт открывать отказывается)
node export-map.mjs
# 3. положить в Workbench (статический источник просмотрщика)
cp data/map.json ~/ASVP/UI/asvh-workbench/public/om-map/map.json
```

## Открыть карту

```bash
cd ~/ASVP/UI/asvh-workbench && git checkout om-map && npm run dev
```

Браузер: `http://localhost:3000/#/om-map` (или пункт «Карта OM» в левой панели). Electron: `npm run electron:dev`.

## Что в map.json

`meta` (источник, счётчики, замечание о времени), `graphs.r1/r2` (узлы с портами, рёбра, connectors, контракты-описания,
требования, тесты, артефакты, маршруты), `ladder` (9 ступеней со статусами и расходом), `stages`, `phases`, `scope` (R2:
узлы, границы, обязательства, прогоны), `budgets`, `policy`, `spend` (по уровням/назначению/модели/черновику + все вызовы
с sequence начала/конца), `drafts`, `runs`, `questions` (с целями-узлами), `nodeAnnotations` (map-status, роль в R2,
обязательства, вопросы), `events` (лента 1..N: вид, сущность, ревизия, время, точность; паузы > 1 ч; якоря), `milestones`,
`om` (легенда слоя OM; записей 0).

Время в базе — UTC (epoch ms); просмотрщик показывает по Москве. Время не-якорных событий восстановлено интерполяцией
между якорями (`model-call.startedAt/finishedAt`, `discovery-draft.createdAt` rev1) и помечено «≈».

## Файлы

- `export-map.mjs` — выгрузка (только чтение копии).
- `data/map.json` — результат (~675 КБ).
- `state-copy.sqlite` — копия базы (не коммитить; ~180 МБ).
- `screenshots/` — снимки экрана просмотрщика.
