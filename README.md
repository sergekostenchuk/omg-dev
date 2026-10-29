# OMG / TaskPlan Pro

Движок, который проводит программный проект по стадиям с моделью: Discovery (исследование задачи с интернетом и оценкой реализуемости) → концепция → карта операций → спецификация → фичи → OM (операционная карта и исполнение). Содержательную работу делает модель прохода, движок хранит каждое решение как неизменяемую запись с хэшем, проверяет формы ответов, бюджет и целостность истории.

## Карта прохода — последняя версия

**[Открыть карту прохода (HTML)](https://htmlpreview.github.io/?https://github.com/sergekostenchuk/omg-dev/blob/work/first-plan/PREPARATIONS/OMG-MAP-SCHEME/omg-pass-map-2026-10-14.html)** · [файл в репозитории](PREPARATIONS/OMG-MAP-SCHEME/omg-pass-map-2026-10-14.html)

Стадии-карточки раскрываются во внутренние шаги; режим «Пробелы 29-10» показывает найденные на живом проходе и репетициях дефекты Discovery v7 (L1–L46), их статус и способ решения. Исходник карты — `PREPARATIONS/OMG-MAP-SCHEME/omg-pass-map.src.html`, сборка — `node PREPARATIONS/OMG-MAP-SCHEME/build-pass-map.mjs`.

Реестр дефектов: [PREPARATIONS/OM-DESIGN/code/V7-LIVE-REGISTRY.md](PREPARATIONS/OM-DESIGN/code/V7-LIVE-REGISTRY.md).

## Ветки

| Ветка | Что в ней |
|---|---|
| `work/first-plan` | документы подготовки, карта, реестр, план |
| `om/module` | код движка (TypeScript, `src/`, `test/`) — интегрированная база после общего прогона |

## Сборка и тесты (ветка om/module)

```bash
npm install
npm run build
npm run check:backend
```
