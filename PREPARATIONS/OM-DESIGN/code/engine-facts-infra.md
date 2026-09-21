<!-- Обзор движка OMG для плана задач блока OM: инфраструктура. Составлен агентом-исследователем (Sonnet) 21.09.2026 по коммиту cbced42, только чтение. Факты проверять по коду перед использованием в задаче. -->

# Обзор репозитория `om-module` (только чтение)

Корень: `/Users/kostenchuksergey/OMG/.omg/worktrees/om-module`. Просмотрены только `src/`, `test/`, `scripts/`, `package.json`, `tsconfig.json`.

## 1. SOURCE LAYOUT (src/)

- `src/adapters/` (4 файла) — интеграция с внешним CLI Codex: оценка стоимости вызова (`estimateCliCall` в `codex-estimate.ts`), разбор токен-статистики (`codexUsage` в `codex-usage.ts`), процесс-адаптер `codex-stdio.ts` (без экспортов, entry-point процесса), учёт происхождения адаптера (`declareAdapterLineage`, `adapterLineage` в `adapter-lineage.ts`).
- `src/compiler/` (8 файлов) — превращает принятый граф (L1-L3) и R3-basis в исполняемый `MachinePlan`: класс `Compiler` (`compiler.ts`, методы `compile/read/gate/publish/context/detail`), модели `model.ts` (`MachinePlan`, `CompiledTask`, `TaskInput`, `WriteGrant`), вывод задач `derive.ts` (`deriveTasks`), контекст для агента `context.ts` (`taskContext`, `selectDetail`), владение записью `ownership.ts` (`writeGrants`), базис `basis.ts` (`requireBasis`), разрешение входов `inputs.ts` (`resolveArtifact`), потребитель плана `consumer.ts` (`consumePlan`).
- `src/discovery/` (46 файлов) — самый крупный модуль: сбор и валидация research-ответов (вопросы/черновики/решения), reader-pilot протокол чтения источников, консолидация заметок, бюджеты и recovery вызовов модели. Главный класс — `Discovery` (`discovery.ts`, методы `forStage/create/gate/decision/fact/reopen`), требования по стадиям — `requirements.ts` (`REQUIREMENTS`, `UPSTREAM_STAGES`, `RESEARCH_CONTRACT_VERSION`).
- `src/evidence/` (1 файл) — источники и наблюдения над ними: класс `Evidence` (`document/file/observe/verify`), `sourceIsCurrent`.
- `src/execution/` (18 файлов) — запуск задач компилированного плана в git worktree: класс `Executor` (`runner.ts`), модели `model.ts` (`TaskRun`, `RunState`, `ExecutionLock`), git-worktree (`worktree.ts`), захват кандидата (`candidate.ts`, `candidate-bytes.ts`), коммит (`commit.ts`), блокировки (`lock.ts`), протокол вызова агента (`protocol.ts`), обязательства задачи (`task-obligations.ts`), recovery (`recovery.ts`), «парковка» дефектных задач (`park.ts`).
- `src/graph/` (30 файлов) — модель продукта (Graph/Node/Connector/…), её валидация, построение и уточнение по уровням L1/L2/L3, R1/R2-исследование, obligation-политики. Главные точки входа: `Refinement` (`refinement.ts`, PHASES/R0..R3), `GraphRepository` (`repository.ts`, save/saveDerived/refine/deriveLayer/gate/layerGate), `validateGraph`/`requireGraph` (`validate.ts`), модель `model.ts` (`Graph`, `Node`, `Connector`, `LEVEL`).
- `src/ownership/` (1 файл) — восстановление «кто последним писал путь» из принятых `TaskRun` через git-предков: класс `Owners` (`owners.ts`, метод `latest`).
- `src/pipeline/` (2 файла) — конечный автомат стадий продукта: `STAGES`, `Stage`, `StageArtifact`, `GateContext/GateResult` (`contracts.ts`), класс `Pipeline` (`pipeline.ts`, `draft/inspect/accept/project`).
- `src/product/` (8 файлов) — командный API верхнего уровня: `ProductEngine` (`engine.ts`), союз команд `ProductCommand`+`parseCommand` (`commands.ts`), чат (`chat.ts`), проведение подготовительных research-раундов (`preparation-run.ts`, `stage-research.ts`, `refinement-research.ts`), ремонт плана (`repairs.ts`, `repair-feedback.ts`).
- `src/runtime/` (9 файлов) — окружения выполнения, процессы, runtime-наблюдения, бюджеты токенов: класс `Environments` (`environment.ts`), `runProcess` (`process.ts`), `observeRuntime`/`recoverRuntimeObservation` (`runtime-observation.ts`), `modelUsage` (`model-usage.ts`), `budgetSegment`/`reserveResearchCall` (`research-budget.ts`), `captureCallRuntime` (`call-runtime.ts`).
- `src/storage/` (3 файла) — единственный слой персистентности поверх SQLite: класс `Store` (`store.ts`), схема (`schema.ts`, `migrate`/`assertSchema`), A/B-снапшоты (`snapshots.ts`, `createSnapshot`/`restoreSnapshot`/`inspectSnapshot`).
- `src/canonical.ts` — каноническая JSON-сериализация и хеширование: `canonical(value)`, `digest`, `hashJson`.
- `src/errors.ts` — единый тип ошибки движка: `EngineError`, `requireCondition`.
- `src/cli.ts` — точка входа CLI (`main`): команды `serve|restore|init|inspect|backup|command`.
- `src/server.ts` — локальный HTTP-сервер (`createProductServer(engine)`), токен-аутентификация, маршруты `/api/*`.

## 2. STORAGE (src/storage)

Класс `Store` (`src/storage/store.ts:20`):
```ts
constructor(path: string)
get databaseId(): string
get<T = Json>(id: string, revision?: number): Revision<T> | null
list<T = Json>(kind?: string): Revision<T>[]
history<T = Json>(id: string): Revision<T>[]
write<T = Json>(input: Write): Revision<T>
writeMany<T = Json>(inputs: Write[], guards: ReadGuard[] = []): Revision<T>[]
async snapshot(directory: string, options: SnapshotOptions = {}): Promise<Snapshot>
close(): void
```
Идентификация записи — тройка `{id, revision, hash}` (`Ref`/`ReadGuard`), где `revision` — целое, инкрементируемое per-`id` (guard за счёт `expected`), `hash = digest(canonical(value))` (SHA-256 от канонической JSON-строки).

Типы (`src/storage/store.ts:9-11`):
```ts
export interface Revision<T = Json> { id: string; kind: string; revision: number; hash: string; value: T }
export interface Write { id: string; kind: string; expected: number; value: unknown }
export interface ReadGuard { id: string; revision: number; hash: string }
```

`get`/`list` — SQL join `revisions` с `heads` (голова = текущая ревизия); `write` — обёртка над `writeMany` для одной записи.

`writeMany(inputs, guards)` — атомарная многозаписевая транзакция (`BEGIN IMMEDIATE`): каждый `input` требует `id`, `kind`, целый `expected >= 0`; id внутри транзакции не повторяются (`duplicate_write`). Сначала проверяются `guards` (posted-read версии произвольных сущностей — если текущая `{revision,hash}` не совпадает с guard, бросается `EngineError("input_stale", …)`). Затем для каждого `input`, если `(current?.revision ?? 0) !== input.expected`, бросается `EngineError("revision_conflict", "Entity changed; reload before writing", { id })`; при смене `kind` — `EngineError("kind_mismatch", …)`. При успехе — `INSERT INTO revisions`, апдейт `heads` (`ON CONFLICT... DO UPDATE`), запись в append-only `events`, `COMMIT`; при любой ошибке — `ROLLBACK`.

Каноническое хеширование — `src/canonical.ts`: `canonical(value)` рекурсивно кодирует JSON (ключи объектов сортируются, запрещены `NaN/Infinity`, разреженные массивы, не-plain-объекты, циклы — всё это `EngineError("invalid_json", …)`); `digest = sha256(hex)`; `hashJson = digest(canonical(value))`.

Тест создаёт временный store так (шаблон `fixture(t)` в `test/storage.test.ts:13-19`, тот же паттерн во всех остальных тестах):
```ts
const root = mkdtempSync(join(tmpdir(), "omg-store-"));
const path = join(root, "live.sqlite");
const store = new Store(path);
t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
```

## 3. ERRORS (src/errors.ts)

```ts
export class EngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: unknown = null)
}
export function requireCondition(condition: unknown, code: string, message: string): asserts condition
```
Единственный класс ошибки во всём движке; код — произвольная строка (`snake_case`), поле `name = "EngineError"`. Типизированный отказ конструируется и сразу бросается через `requireCondition(cond, code, message)` (assertion-функция) либо явным `throw new EngineError(code, message, details)`, когда нужны структурированные `details` (например `graph_missing`, `revision_conflict` с `{id}`, `gate_rejected` со списком findings). Примеры кодов по всей базе: `invalid_json`, `record_corrupt`, `store_busy`, `revision_conflict`, `kind_mismatch`, `input_stale`, `duplicate_write`, `foreign_database`, `unsafe_database_path`, `snapshot_corrupt`, `restore_target_exists`, `command_invalid`, `project_missing`, `predecessor_not_ready`, `gate_rejected`, `stage_not_ready`, `feasibility_not_ready`, `plan_stale`, `ownership_ambiguous`. `cli.ts:33` и `server.ts:66-70` перехватывают `EngineError` и мапят `error.code`/`error.details` в JSON-ответ/stderr.

## 4. COMMAND API (src/product/engine.ts и соседи)

`ProductEngine` (`src/product/engine.ts:45`) — агрегатор всех доменных сервисов (`discovery`, `graphs`, `pipeline`, `environments`, `refinement`, `compiler`, `executor`, `researcher`, `repairs`, `stageResearch`, `refinementResearch`), конструктор:
```ts
constructor(readonly store: Store, private readonly actor = "local-owner")
```
`execute(input: unknown): unknown` (`engine.ts:199`) — единая точка входа: `parseCommand(input)` валидирует по Ajv-схеме и возвращает `ProductCommand`, затем `switch (command.type)` диспетчерит в конкретный метод/сервис (~45 веток case).

Союз команд — `export type ProductCommand = | {type:'…'; …} | …` (`src/product/commands.ts:15-62`), 45 вариантов. Регистрация новой команды: 1) добавить вариант в `ProductCommand` (commands.ts), 2) добавить соответствующий JSON-Schema объект в массив `oneOf` внутри `const schema = { oneOf: [...] }` (commands.ts:78-131) через хелпер `command(type, properties)`, 3) добавить `case "новый-тип": …` в `ProductEngine.execute` (engine.ts:199-289).

`projection(project)` (`engine.ts:166-193`) — read-model проекта: собирает `project`, `stages` (`this.pipeline.project(project)`), `graph`, `mapStatus`, `graphGate`, `drafts`, `questions` (с пересчитанной свежестью через `discovery.gate`), `sources`, `environment`, `phases` (R0..R2, кроме R3), `feasibility`/`feasibilityGate`, `plans`/`currentPlan`/`planGate`, `runs`, `executionRoot`/`executionRunning`, `preparationRun`, `researchRuns`, `chat` — единый снимок состояния для UI/чата.

`accept-stage` (`engine.ts:283-285`):
```ts
case "accept-stage": this.#project(command.project);
  if (["om-g2", "compilation", "execution"].includes(command.stage)) assertPilotBoundary(this.store, command.project, "R3");
  return this.pipeline.accept(command.project, command.stage, command.expected);
```
делегирует в `Pipeline.accept` (см. §5): пересчитывает `inspect`, требует ревизию совпадающую с `expected`, `findings.length === 0` (иначе `gate_rejected`), состояние `draft` (иначе `stage_not_ready`), и пишет `status: "accepted"`, `proofs: guards минус сам артефакт`.

Список стадий определён в `src/pipeline/contracts.ts:4`:
```ts
export const STAGES = ["discovery", "concept", "operation-map", "specification", "features", "om-g2", "compilation", "execution"] as const;
```
REQUIREMENTS по upstream-стадиям — `src/discovery/requirements.ts` (`REQUIREMENTS`, `LEGACY_REQUIREMENTS`, `VERSION2_REQUIREMENTS`); `om-g2` и `compilation` в этот словарь не входят — их содержимое проверяется отдельными ветками `validateStage` в `engine.ts:70-143`. Дословно:

```ts
protected validateStage(stage: Stage, context: GateContext): GateResult {
  const rejected = (code: string, message: string): GateResult => ({ findings: [{ code, target: stage, message }], guards: [] });
  if (stage === "om-g2") {
    const content = context.content as { feasibility?: unknown } | null;
    if (!content || Object.keys(content).join(",") !== "feasibility" || !isRef(content.feasibility)) return rejected("feasibility_missing", "This stage requires a bound R3 result");
    return this.refinement.feasibilityGate(context.projectId, content.feasibility, context.accepted === true);
  }
  if (stage === "compilation") {
    const content = context.content as { plan?: unknown } | null;
    if (!content || Object.keys(content).join(",") !== "plan" || !isRef(content.plan)) return rejected("plan_missing", "Compilation stage requires a generated plan");
    return this.compiler.gate(context.projectId, content.plan, context.accepted === true);
  }
  ...
```
Т.е. `om-g2.content` обязан быть строго `{ feasibility: Ref }` (валидный `Ref` = `{id,revision,hash}` по `isRef`), проверка делегируется `Refinement.feasibilityGate`; `compilation.content` обязан быть строго `{ plan: Ref }`, проверка — `Compiler.gate`. Лишние/отсутствующие ключи → отказ с кодом `feasibility_missing`/`plan_missing`.

## 5. PIPELINE (src/pipeline)

`Pipeline` (`src/pipeline/pipeline.ts:7`), конструктор требует функцию-валидатор на каждую стадию (`stage_contract_missing`, если хоть одной нет):
```ts
constructor(private readonly store: Store, private readonly validators: StageValidators)
draft(projectId: string, stage: Stage, content: Json, expected: number, admissionGuards: Ref[] = []): Revision<StageArtifact>
inspect(projectId: string, stage: Stage): StageProjection
accept(projectId: string, stage: Stage, expected: number): Revision<StageArtifact>
project(projectId: string): StageProjection[]
```
Порядок стадий — линейный массив `STAGES` (contracts.ts:4); `predecessor(stage)` даёт соседа слева. `draft` требует, чтобы предшественник был `accepted` (`predecessor_not_ready`), включает его `reference()` в `inputs: [reference(input)]` и его `guards`/`admissionGuards` в CAS-guard записи. `inspect` пересобирает состояние с нуля из хранилища: проверяет форму артефакта (`artifact_invalid`), сверяет фактический `inputs[0]` со свежей версией предшественника (`input_stale`), проверяет свежесть каждого `proof` из `artifact.value.proofs` (`proof_stale`), и только затем вызывает `validators[stage]({projectId, content, inputs, accepted})`. Итоговое `state` — `missing|draft|blocked|stale|accepted` (accepted/draft с findings → `stale`/`blocked`).

`accept` берёт текущий `inspect`, требует `checked.artifact.revision === expected` (`revision_conflict`), `findings.length === 0` (`gate_rejected`), `state === "draft"` (`stage_not_ready`), и пишет ту же value с `status:"accepted"`. **Proofs** артефакта — это именно набор guard-ссылок, собранных на момент принятия: `proofs: checked.guards.filter(ref => ref.id !== checked.artifact!.id)` (pipeline.ts:91) — т.е. «доказательства» — это версии всех входов/зависимостей, зафиксированные в момент acceptance, используемые при следующем `inspect` для детекции устаревания.

Артефакт стадии (`StageArtifact`, contracts.ts:9-16):
```ts
export interface StageArtifact {
  projectId: string; stage: Stage; status: "draft" | "accepted";
  content: Json; inputs: Ref[]; proofs: Ref[];
}
```
Хранится под ключом `stageId(project, stage) = "stage:${project}:${stage}"`, `kind: "stage"`.

## 6. TEST CONVENTIONS (test/)

Раннер — `node:test` + `node:assert/strict` (`npm test` = `node --test dist/test/*.test.js`, т.е. тесты сначала компилируются `tsc` вместе с `src/` в `dist/`, единый `tsconfig.json`). Файлы стадии — `<domain>.test.ts` (kebab-case, суффикс `.test.ts`), нетестовые помощники — `<domain>-fixture.ts` без суффикса `.test`.

Импорты из `src` — всегда относительные с суффиксом `.js` (`import { Store } from "../src/storage/store.js";`) — ESM/NodeNext требует расширение скомпилированного файла, а не `.ts`.

Помощники/фикстуры в `test/` (файл → экспорт):
- `graph-fixture.ts` → `exampleGraph(prefix?)`
- `enriched-graph-fixture.ts` → `enrichedGraph(source, project, initial?, sections?)`
- `preparation-fixture.ts` → `preparationValue(project)`, `preparedField(project, field)`, `researchInput(...)`
- `layer-design-fixture.ts` → `answerLayerFixture(...)`, `deriveLayerFixture(...)`
- `technical-research-fixture.ts` → `answerTechnicalFixture(...)`
- `synthesis-session-fixture.ts` → `fixture(t, ...)` (async)
- `execution-fixture.ts` → `executionFixture(t, behavior?, refine?)`
- `product-fixture.ts` → `preparedFeatures(engine, project, ...)`, `refinedLayers(engine, project)`

Продуктовый граф/фикстура строится композицией: `exampleGraph()` даёт «сырой» L1-подобный граф, `enrichedGraph()` добавляет обязательные R0-поля, `preparedFeatures()` (product-fixture.ts) прогоняет весь upstream-конвейер стадий (`create-project → source-document → save-graph → prepare/answer/draft/accept` по каждой `UPSTREAM_STAGES`) до состояния `features: accepted`.

Долгоживущее состояние избегается через `mkdtempSync(join(tmpdir(), "omg-…-"))` + `t.after(() => { store.close(); rmSync(root, {recursive:true, force:true}); })` в каждом тесте — своя временная директория и SQLite-файл на тест, гарантированная очистка через `TestContext.after`.

Три показательных файла для подражания:
- **storage-уровень**: `test/storage.test.ts` — эталон паттерна `fixture(t)`, CAS/guards, snapshot A/B-ротации, повреждений и symlink-атак; узкий, без доменной логики.
- **graph-уровень**: `test/graph.test.ts` — чистые unit-тесты над `validateGraph`/`topologicalOrder` через мутации `exampleGraph()`, без Store/Engine — показывает, как тестировать чистую валидацию новой доменной модели.
- **engine/command-уровень**: `test/product.test.ts` — полный end-to-end через `ProductEngine.execute({type:...})` и CLI (`spawnSync` на `dist/src/cli.js`), включая холодное переоткрытие `Store` — эталон для теста нового модуля, подключаемого через команды.

## 7. CODE STYLE FACTS

Модульная система — ESM (`package.json: "type": "module"`), `tsconfig.json: "module": "NodeNext", "moduleResolution": "NodeNext"` ⇒ все относительные импорты обязаны иметь суффикс `.js` (даже указывая на `.ts`-файл), `import type {...}` используется для type-only импортов.

Строгость `tsconfig.json`:
```json
"target": "ES2023", "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
"noFallthroughCasesInSwitch": true, "noUnusedLocals": true, "noUnusedParameters": true, "sourceMap": true, "skipLibCheck": true
```
(`rootDir: "."`, `outDir: "dist"`, `include`: `src/**/*.ts`, `test/**/*.ts`, `ui/**/*.tsx`).

Именование файлов — kebab-case (`obligation-readiness.ts`, `call-runtime.ts`); один домен = один файл, без барреля `index.ts` (в репозитории не найден ни в `src/`, ни в `test/`). Экспорты: классы и интерфейсы/типы — `PascalCase` (`Store`, `Pipeline`, `ProductEngine`, `Revision<T>`, `GateResult`), функции и методы — `camelCase` (`hashJson`, `requireCondition`, `validateGraph`), константы уровня модуля — `UPPER_SNAKE_CASE` для «протокольных» констант (`STAGES`, `RESEARCH_CONTRACT_VERSION`, `REQUIREMENTS`) либо `camelCase` для обычных значений. Публичные типы объявляются прямо рядом с реализацией через `export interface`/`export type` в том же файле (например `export interface Revision<T = Json> {...}` в `store.ts`), отдельных `.d.ts` или type-only модулей нет; при необходимости повторного экспорта используется `export type { X } from "./model.js"` (см. `compiler.ts:20`).

Плотность и язык комментариев — комментарии редкие (≈104 строк на 134 файла), почти все — краткие `//`-заметки на английском, объясняющие «почему», а не «что» (например `pipeline.ts:52-53`: «Execution consumes a sealed compilation version. Its commits must not make historical R3 evidence retroactively invalidate the completed result.»); изредка встречается однострочный JSDoc-блок над классом (`owners.ts:14`: `/** Ownership is a projection of immutable accepted runs, not a second mutable truth. */`). Строки сообщений об ошибках и текст промптов для research/consumer-facing контента — на английском в коде (`errors.ts`-сообщения), кроме доменных промптов для research-контрактов (`requirements.ts`, `preparation-contracts.ts`), которые пишутся на русском (это тексты для LLM-агента, а не комментарии к коду).

JSON-схемы (Ajv) для команд и полей строятся локальными хелперами `object(properties)`, `list(items, min)`, `text`/`texts` в каждом файле, а не общей библиотекой — общего `schema-helpers.ts` не найдено (искал в `src/product/commands.ts`, `src/discovery/preparation-contracts.ts`, `src/discovery/reader-pilot.ts`, `src/graph/schema.ts`).
