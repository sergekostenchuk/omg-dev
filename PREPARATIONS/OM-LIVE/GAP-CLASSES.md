# GAP-CLASSES — классы блокирующих пробелов omg-live (для решения «поштучно vs системно»)

Код om/module = e9ddb03. Данные: снимок `/tmp/omg-dryrun/state-after-stage2.sqlite` (D1 прохода: 192 пробела, 56 блокирующих — совпало с описью №2375), свежая копия `/tmp/omg-gaps-kimi/state-copy.sqlite`. Горизонт первого прохода = 6 блоков: `n-control, n-intake, n-research, n-results, n-runtime, n-state` (запись `horizon:omg-live:820359ba…`).

Правила из кода: blocking ⇔ (потребитель-блок в горизонте ИЛИ mechanism) И moment=om-pass (gaps.ts:223,228). Маршрут design-decision → `design` (gaps.ts:24). Партия: design-decision кроме obligation_open → MC2 `input-field`; obligation_open → MC2 `node-expansion` (routes.ts:167–182). Производитель ответа — единая точка `answerProducerOf` (answers-gate.ts:146–152): нет производителя только у kind=owner-decision (нет H2-производителя) и у predecessor_question с kind ∈ {design-decision, environment-confirmation, post-implementation-proof} (`route_result_unsupported`). Партия с необслуженным вопросом **не допускается** к платной попытке: H1 её не выбирает, E4 отказывает в отправке (answers-gate.ts:777–786).

## 1. Таблица классов (56 блокирующих; вне горизонта — неблокирующие того же класса)

| класс | всего / блок. | в горизонте | вне | партия M6 | производитель (H1.5) | чем закрывается |
|---|---|---|---|---|---|---|
| obligation_open | 30 / 30 | 30 (все 6 блоков, узлы o-*) | 0 | MC2 node-expansion, 9 партий (по узлу, все level 3) | есть — расширение узла (answers-gate.ts:136–137) | (а) вызов модели в проходе: L3-расширение узла пишет содержимое слоя |
| acceptance_kind_missing | 111 / 12 | 12 (n-research) | 99 | MC2 input-field, поле `checkKind` (12 эл.) | есть — M5-адресация полей (addressing.ts:130–135) | (а) вызов модели; решение фиксируется в om-input и переживает refresh (input.ts:548–558,945) |
| question_unaddressed | 10 / 10 | 10 (по mechanism M5:addressing, не по блокам) | 0 | MC2 input-field, поле `address` (10 эл.) | есть — M5-адресация (addressing.ts:93–110) | (а) M5 в проходе присваивает узел-потребителя И kind; дальше по kind — см. §2.2 |
| contract_boundary_prose | 20 / 2 | 2 (n-research) | 18 | MC2 input-field, поле `state` (2 эл.) | есть — M5-адресация поля state (addressing.ts:119–129) | (а) вызов модели |
| contract_node_unbound | 20 / 2 | 2 (n-research) | 18 | MC2 input-field, поле `nodes` (2 эл.) | есть — M5-адресация поля nodes (addressing.ts:111–118) | (а) вызов модели |

Итого по маршрутам: design 191 (deferred 135 + pending 56), code 1 (inventory_missing, неблокирующий) — из записи `om-routes:omg-live:144cd55b…` (4 input-field партии = 26 элементов: address 10, checkKind 12, nodes 2, state 2; 9 node-expansion партий = 30).

**Все 56 блокирующих имеют производителя** и закрываются механизмом прохода (а). Новых производителей на этом снимке — 0.

## 2. Проверка догадок оркестратора

### 2.1 «30 obligation_open закрывает L3 node-expansion» — ВЕРНО
Все 30 с node o-* уровня 3 (routes record: 9 партий node-expansion, все level 3); потребитель каждого — блок горизонта. Производитель свой, вызов модели в проходе. (gaps.ts:286–291, routes.ts:173–182.)

### 2.2 «10 question_unaddressed — M5, затем MC1 или решение» — ВЕРНО с важным уточнением
M5-адресация присваивает и потребителя-узел, и kind (addressing.ts:19,93–96). После неё пробел становится `predecessor_question` (поле answer, gaps.ts:279–284), и дальше решает kind:
- `repository-fact` → партия MC1 `fact`, производитель есть (routes.ts:168–169) — закрывается в проходе;
- `design-decision` → **производителя НЕТ** в текущем контракте (answers-gate.ts:147–151, `route_result_unsupported`): H1 партию не выберет, E4 не отправит — вопрос останется открытым до конца прохода;
- `owner-decision` → производителя нет (`owner_result_unavailable`, ждёт отдельный H2-производитель, которого нет).

То есть «решение» — не ветка внутри прохода, а отсутствие двери: либо M5 присваивает repository-fact (и вопрос отвечаем машинно), либо нужен НОВЫЙ производитель (кандидаты: машинное решение в пределах L0/L1 — D6.1; H2 owner-result производитель), либо решение владельца вне прохода. По формулировкам (опись №2375): ~6 из 10 читаются как факты репозитория (live-state, full-check-contract, live-environment, storage-details, existing-coordinator, continuation-contract), ~4 как решения (retention, feature:14:1, 17:1, 18:1). Присвоение kind — акт M5, не наше суждение.

### 2.3 «12 acceptance_kind_missing и 4 contract_* — проблема формата старых записей (P2/P3)» — НЕ ТАК (поправка по коду)
По происхождению — да: все 16 испускаются только для записей СТАРОЙ эры; в новой эре это жёсткие отказы, а не пробелы (input.ts:188–189 checkKind, 211–212 nodes, 220–221 state; порог эры — NODES_REQUIRED_SINCE, input.ts:152–157). Но вывод «значит, чинить форматом (P2/P3)» для прохода **неверен**: у прохода есть полный производитель этих полей — M5-адресация полей `checkKind`/`nodes`/`state` (addressing.ts:20,111–135; `checkKind` не может быть заменён — только заполнен, :134). Решение записывается в om-input и переживает refresh (input.ts:548–558 «must not erase accepted decisions»). P2/P3 (новая эра записи концепции/ТЗ) остаётся системной гигиеной данных — после неё эти пробелы не возникают вовсе, — но блокером прохода они не являются.

## 3. Итог одной строкой

**56/56 блокирующих закрываются механизмом прохода: 46 (30 node-expansion + 16 поля nodes/state/checkKind) — напрямую вызовами модели; 10 — M5-адресацией, после которой часть уйдёт в MC1 (производитель есть), а часть (design-decision/owner-decision) упрётся в отсутствие производителя (route_result_unsupported / owner_result_unavailable) — там нужен 1–2 новых производителя (D6.1-машинное решение L0/L1 и/или H2 owner-result) либо решение владельца; решений человека по снимку не требуется.**

Первый проход блокируют все 56 (все в горизонте: 30 через блоки-потребители, 16 через n-research, 10 через mechanism). Из них «26 уточнений» — 4 input-field партии M5 (address 10, checkKind 12, nodes 2, state 2): все обслужены производителями, новых дверей не нужно. Рисковая точка первого прохода — не эти 26, а судьба 10 вопросов ПОСЛЕ адресации (какой kind присвоит M5) и цена повторов (×2,2–2,5 на попытку — №2291).

*Прочее:* фактов репозитория 1 (inventory_missing, неблокирует; P1 Fable закрывает его отдельно). Модели не вызывались; живые база и live-source не тронуты (обращения — только ro-копии).
