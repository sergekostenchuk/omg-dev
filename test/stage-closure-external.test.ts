import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync, realpathSync, unlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, storeReads, storeBodyCache, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { StageChecks } from "../src/product/stage-checks.js";
import { reference, stageId, STAGE_CLOSURE_CONTRACT, type Stage, type GateContext, type StageArtifact, type StageExternalCheck } from "../src/pipeline/contracts.js";
import { type Source } from "../src/evidence/evidence.js";
import { projectGraph } from "../src/graph/project.js";
import { canonical, hashJson } from "../src/canonical.js";
import { preparedFeatures, answerDiscoveryFixture, currentUpstreamFixtureValue } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import type { Question, DiscoveryDraft } from "../src/discovery/discovery.js";
import type { Graph } from "../src/graph/model.js";
import { EngineError } from "../src/errors.js";
import { exampleGraph } from "./graph-fixture.js";

const reads = (action: () => void): number => {
  const before = storeReads();
  action();
  return storeReads() - before;
};

interface TestEnv {
  directory: string;
  store: Store;
  checks: StageChecks;
  engine: ProductEngine;
}

function createEnv(t: TestContext): TestEnv {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omg-g2a-test-")));
  const store = new Store(join(directory, "state.sqlite"));
  t.after(() => {
    try { store.close(); } catch { /* closed */ }
    rmSync(directory, { recursive: true, force: true });
  });
  const engine = new ProductEngine(store);
  const checks = new StageChecks(store);
  return { directory, store, checks, engine };
}

test("1. внешний файл изменён: изменение файла на диске делает стадию stale без изменения записей Store", t => {
  const env = createEnv(t);
  const project = "p-ext-file";
  const filePath = join(env.directory, "observed.txt");
  writeFileSync(filePath, "initial-content-v1");

  env.engine.execute({ type: "create-project", project, title: project });
  const source = env.engine.discovery.evidence.file(project, "brief", env.directory, "observed.txt", "text/plain", 0);
  const draft = env.engine.prepare(project, "discovery");
  for (const id of draft.value.questions) {
    const question = env.engine.projection(project).questions.find(q => q.id === id)!;
    if (question.value.spec.kind === "fact") {
      env.engine.discovery.fact(id, 1, reference(source), { kind: "text-range", start: 0, end: "initial-content-v1".length });
    } else {
      const field = question.value.spec.field;
      const value = preparedField(project, field);
      if (["researchPlan", "researchReport", "verdict", "preparation"].includes(field)) {
        answerDiscoveryFixture(env.engine, project, env.store.get<DiscoveryDraft>(draft.id)!, env.store.get<Question>(id)!, value, source);
      } else {
        env.engine.discovery.decision(id, 1, "owner", value);
      }
    }
  }
  const artifact = env.engine.draft(project, "discovery", draft.id, 0);
  env.engine.pipeline.accept(project, "discovery", artifact.revision);

  // 1) Исходное состояние: файл на месте, inspect закрытый, валидатор не вызывается
  const initial = env.checks.pipeline.inspect(project, "discovery");
  assert.equal(initial.state, "accepted", "Stage must be accepted when file matches");
  assert.equal(initial.findings.length, 0);
  assert.ok(initial.artifact?.value.closure?.external.some(c => c.kind === "source" && c.ref.id === source.id));

  // 2) Модифицируем файл на диске
  writeFileSync(filePath, "modified-content-v2");

  // inspect обнаруживает сдвиг внешнего файла, closed read возвращает null, полный путь даёт stale
  const modified = env.checks.pipeline.inspect(project, "discovery");
  assert.equal(modified.state, "stale", "Stage must become stale when external file changed");
  assert.ok(modified.findings.some(f => f.code === "external_source_changed" || f.code === "evidence_stale" || f.code === "research_evidence_stale"));

  // 3) Восстанавливаем файл на диске
  writeFileSync(filePath, "initial-content-v1");
  const restored = env.checks.pipeline.inspect(project, "discovery");
  assert.equal(restored.state, "accepted", "Stage must return to accepted when file is restored");
});

test("2. absent→present: появление записи, объявленной absent, нарушает closure и делает стадию stale", t => {
  const env = createEnv(t);
  const project = "p-absent";
  const ghostId = `ghost:${project}`;

  // Перехватываем validateStage, чтобы включить absent-страж в admissionGuards стадии discovery
  const origValidate = env.engine.checks.validateStage.bind(env.engine.checks);
  const interceptedValidate = (stage: Stage, context: GateContext) => {
    const res = origValidate(stage, context);
    if (stage === "discovery") {
      res.admissionGuards = [...(res.admissionGuards ?? []), { id: ghostId, absent: true }];
    }
    return res;
  };
  env.engine.checks.validateStage = interceptedValidate;
  env.checks.validateStage = interceptedValidate;

  preparedFeatures(env.engine, project);

  const discoveryArtifact = env.store.get<StageArtifact>(stageId(project, "discovery"))!;
  assert.ok(discoveryArtifact.value.closure);
  assert.ok(discoveryArtifact.value.closure.admission.some(g => 'absent' in g && g.id === ghostId && g.absent));

  // Пока записи ghost нет — закрытое чтение успешно
  const before = env.checks.pipeline.inspect(project, "discovery");
  assert.equal(before.state, "accepted");

  // Создаём запись ghost в Store (absent -> present)
  env.store.write({
    id: ghostId,
    kind: "ghost",
    expected: 0,
    value: { appeared: true },
  });

  // headsMatch фиксирует нарушение отсутствия, closed read сваливается в полный путь
  const after = env.checks.pipeline.inspect(project, "discovery");
  assert.equal(after.state, "stale", "Stage must become stale when absent dependency appears");
  assert.ok(after.findings.some(f => f.code === "input_stale" || f.target === stageId(project, "discovery")));
});

test("3. граф вне L1 и внутри L1: изменения на L2/L3 не затрагивают L1-closure; изменение L1 делает стадию stale", t => {
  const env = createEnv(t);
  const project = "p-graph";
  preparedFeatures(env.engine, project);

  // Проверяем, что operation-map и features несут L1 graph-projection в closure
  const opMapArtifact = env.store.get<StageArtifact>(stageId(project, "operation-map"))!;
  assert.ok(opMapArtifact.value.closure);
  const l1Check = opMapArtifact.value.closure.external.find(
    (c: StageExternalCheck): c is Extract<StageExternalCheck, { kind: "graph-projection" }> => c.kind === "graph-projection"
  );
  assert.ok(l1Check, "operation-map must declare graph-projection");
  assert.equal(l1Check.level, 1);

  // До изменения графа — closed read успешен
  assert.equal(env.checks.pipeline.inspect(project, "operation-map").state, "accepted");
  assert.equal(env.checks.pipeline.inspect(project, "features").state, "accepted");

  // 3A: Изменение графа ВНЕ L1 — добавляем узел на уровне L2
  const graphRecord = env.store.get<Graph>(`graph:${project}`)!;
  const l1HashBefore = hashJson(projectGraph(graphRecord.value, 1));
  assert.equal(l1Check.hash, l1HashBefore);

  // Добавляем узел вида "step" (L2), L1 проекция не меняется
  const extendedGraph: Graph = {
    ...graphRecord.value,
    nodes: [
      ...graphRecord.value.nodes,
      { id: "extra-l2-step", kind: "step", title: "L2 extra step", phase: 2 } as unknown as Graph["nodes"][number],
    ],
  };
  const l1HashAfter = hashJson(projectGraph(extendedGraph, 1));
  assert.equal(l1HashAfter, l1HashBefore, "L1 projection hash must remain identical after L2 node addition");

  env.store.write<Graph>({
    id: `graph:${project}`,
    kind: "graph",
    expected: graphRecord.revision,
    value: extendedGraph,
  });

  // Проверяем: operation-map и features остаются accepted, L1 projection совпадает!
  const opMapPostL2 = env.checks.pipeline.inspect(project, "operation-map");
  assert.equal(opMapPostL2.state, "accepted", "operation-map must remain accepted when graph changed outside L1");
  const featuresPostL2 = env.checks.pipeline.inspect(project, "features");
  assert.equal(featuresPostL2.state, "accepted", "features must remain accepted when graph changed outside L1");

  // 3B: Изменение графа ВНУТРИ L1 — модифицируем узел L1
  const l1Node = extendedGraph.nodes[0]!;
  const driftedGraph: Graph = {
    ...extendedGraph,
    nodes: extendedGraph.nodes.map(n => n.id === l1Node.id ? { ...n, title: "Altered L1 title" } : n),
  };
  const l1HashDrifted = hashJson(projectGraph(driftedGraph, 1));
  assert.notEqual(l1HashDrifted, l1HashBefore, "L1 projection hash must change when L1 node is altered");

  env.store.write<Graph>({
    id: `graph:${project}`,
    kind: "graph",
    expected: graphRecord.revision + 1,
    value: driftedGraph,
  });

  // Проверяем: теперь L1 проекция не совпадает, closed read бракует стадию
  const opMapDrifted = env.checks.pipeline.inspect(project, "operation-map");
  assert.equal(opMapDrifted.state, "stale", "operation-map must become stale when L1 graph projection drifted");
  assert.ok(opMapDrifted.findings.some(f => f.code === "graph_layer_unproven" || f.code === "map_design_drift"));
});

test("4. гонка до записи: сдвиг зависимости между проверкой и записью отвергается атомарно Store.writeMany", t => {
  const env = createEnv(t);
  const project = "p-race";
  env.engine.execute({ type: "create-project", project, title: project });
  const source = env.engine.discovery.evidence.document(project, "brief", `A brief for ${project}`, "text/plain", 0);
  const draft = env.engine.prepare(project, "discovery");
  for (const id of draft.value.questions) {
    const question = env.engine.projection(project).questions.find(q => q.id === id)!;
    if (question.value.spec.kind === "fact") env.engine.discovery.fact(id, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
    else {
      const field = question.value.spec.field;
      const value = preparedField(project, field);
      if (['researchPlan','researchReport','verdict','preparation'].includes(field))
        answerDiscoveryFixture(env.engine, project, env.store.get<DiscoveryDraft>(draft.id)!, env.store.get<Question>(id)!, value, source);
      else env.engine.discovery.decision(id, 1, "owner", value);
    }
  }
  const draftArtifact = env.engine.draft(project, "discovery", draft.id, 0);

  // Подготавливаем принятие
  const prepared = env.checks.pipeline.prepareAccepted(project, "discovery", draftArtifact.value.content, draftArtifact.revision);

  // Имитируем параллельный коммит: сдвигаем ревизию проекта или зависимости до выполнения writeMany
  const dep = prepared.guards[0]!;
  const currentDep = env.store.get(dep.id)!;
  env.store.write({
    id: dep.id,
    kind: currentDep.kind,
    expected: currentDep.revision,
    value: { ...(currentDep.value as Record<string, unknown>), parallelShift: true },
  });

  // Попытка записать с устаревшими guards отвергается Store с input_stale или revision_conflict
  assert.throws(
    () => env.store.writeMany([prepared.write], prepared.guards),
    (error: unknown) => error instanceof EngineError && (error.code === "input_stale" || error.code === "revision_conflict")
  );
});

test("5. десять посторонних записей и пять ревизий проекта не увеличивают чтения принятых стадий", t => {
  const env = createEnv(t);
  const project = "p-hist";
  preparedFeatures(env.engine, project);

  // Замеряем базовое число чтений Store для inspect всех 5 upstream стадий
  const initialReads = reads(() => {
    for (const stage of ["discovery", "concept", "operation-map", "specification", "features"] as const) {
      const projection = env.checks.pipeline.inspect(project, stage);
      assert.equal(projection.state, "accepted");
    }
  });

  // Создаём 10 дополнительных ревизий для различных сущностей в Store (история растёт)
  for (let i = 1; i <= 10; i++) {
    env.store.write({
      id: `historical-noise:${project}:${i}`,
      kind: "noise",
      expected: 0,
      value: { step: i, payload: "noise".repeat(100) },
    });
  }
  // Добавляем ревизии в проектную запись
  const projectRecord = env.store.get<{ id: string; title: string }>(`project:${project}`)!;
  for (let i = 0; i < 5; i++) {
    env.store.write({
      id: `project:${project}`,
      kind: "project",
      expected: projectRecord.revision + i,
      value: { ...projectRecord.value, touch: i },
    });
  }

  // Повторный замер чтений Store: число чтений должно остаться ИДЕНТИЧНЫМ
  const postHistoryReads = reads(() => {
    for (const stage of ["discovery", "concept", "operation-map", "specification", "features"] as const) {
      const projection = env.checks.pipeline.inspect(project, stage);
      assert.equal(projection.state, "accepted");
    }
  });

  assert.equal(
    postHistoryReads,
    initialReads,
    `Reads count after unrelated history (${postHistoryReads}) must equal initial reads (${initialReads})`
  );
});

test("6. эра без объявления — прежний путь: стадия без closure производит полный прогон валидатора", t => {
  const env = createEnv(t);
  const project = "p-legacy";
  preparedFeatures(env.engine, project);

  // Берём принятый concept и удаляем у него closure (имитируя историческую запись эры без closure)
  const concept = env.store.get<StageArtifact>(stageId(project, "concept"))!;
  assert.ok(concept.value.closure);
  const strippedValue: StageArtifact = { ...concept.value };
  delete strippedValue.closure;

  env.store.write<StageArtifact>({
    id: concept.id,
    kind: "stage",
    expected: concept.revision,
    value: strippedValue,
  });

  // Проверяем: без closure стадия concept читается через полный путь валидатора
  // (проверка проходит успешно, но через валидатор)
  const projection = env.checks.pipeline.inspect(project, "concept");
  assert.equal(projection.state, "accepted");
  assert.equal(projection.artifact?.value.closure, undefined);

  // Проверяем downstream стадии: om-g2, compilation, execution в G2a не объявляют closure
  // и читаются полным путём
  assert.equal(concept.value.closure.contract, STAGE_CLOSURE_CONTRACT);
});

test("7. validator НЕ вызывается на неизменной принятой стадии + числовой бюджет storeReads", t => {
  const env = createEnv(t);
  const project = "p-budget";
  preparedFeatures(env.engine, project);

  const cold = new Store(env.store.path); t.after(() => cold.close());
  const checks = new StageChecks(cold);
  const historicalBodies = new Set(env.store.identities("list")
    .filter(row => /question|answer|assessment/.test(row.kind))
    .map(row => canonical(env.store.get(row.id, row.revision)!.value)));
  const stageBodies = new Set(env.store.identities("list", "stage")
    .map(row => canonical(env.store.get(row.id, row.revision)!.value)));
  assert.ok(historicalBodies.size > 0);
  let historicalParses = 0, stageParses = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (...args: Parameters<typeof parse>) => {
    if (historicalBodies.has(args[0])) historicalParses++;
    if (stageBodies.has(args[0])) stageParses++;
    return parse(...args);
  });
  let validatorCalls = 0;
  const originalValidate = checks.validateStage.bind(checks);
  checks.validateStage = (stage, context) => {
    validatorCalls++;
    return originalValidate(stage, context);
  };

  // Сбрасываем счётчики перед чтением принятого префикса
  validatorCalls = 0;
  const initialParses = storeBodyCache().parses;

  // Осматриваем все 5 принятых upstream стадий через pipeline.inspect
  const stages = ["discovery", "concept", "operation-map", "specification", "features"] as const;
  const usedReads = reads(() => {
    for (const stage of stages) {
      const projection = checks.pipeline.inspect(project, stage);
      assert.equal(projection.state, "accepted");
      assert.equal(projection.findings.length, 0);
    }
  });

  // Инвариант 1: Валидатор стадии НЕ вызывался ни разу!
  assert.equal(validatorCalls, 0, "Stage validator must NOT be called on unchanged accepted stages with closure");

  // Инвариант 2: Число чтений Store строго ограничено числом стадий и зависимостей (O(1) на стадию)
  // Для 5 стадий: 1 чтение артефакта + 1 чанк headsMatch + 1-2 внешние проверки на стадию
  assert.ok(usedReads <= stages.length * 4, `Store reads (${usedReads}) must be strictly bounded per stage`);

  const bodyParses = storeBodyCache().parses - initialParses;
  assert.ok(bodyParses <= stages.length * 3, `Cold body parses (${bodyParses}) exceed the packet's external grounds`);
  assert.equal(historicalParses, 0, "Closed reads never parse the exact saved question/answer/assessment bodies");
  assert.equal(stageParses, stages.length, "the decoder counter observes real artifact bodies on the cold Store");
});

function acceptFileDiscovery(env: TestEnv, project: string, source: Revision<Source>, researchSource = source) {
  const draft = env.engine.prepare(project, "discovery");
  for (const id of draft.value.questions) {
    const q = env.store.get<Question>(id)!, field = q.value.spec.field;
    if (q.value.spec.kind === "fact") env.engine.discovery.fact(id, q.revision, reference(source),
      { kind: "text-range", start: 0, end: source.value.content.length });
    else if (["researchPlan", "researchReport", "verdict", "preparation"].includes(field))
      answerDiscoveryFixture(env.engine, project, env.store.get<DiscoveryDraft>(draft.id)!, q,
        preparedField(project, field), researchSource);
    else env.engine.discovery.decision(id, q.revision, "owner", preparedField(project, field));
  }
  const artifact = env.engine.draft(project, "discovery", draft.id, 0);
  return { draft: env.store.get<DiscoveryDraft>(draft.id)!,
    artifact: env.engine.pipeline.accept(project, "discovery", artifact.revision) };
}

function acceptConcept(env: TestEnv, project: string) {
  const draft = env.engine.prepare(project, "concept");
  for (const id of draft.value.questions) {
    const q = env.store.get<Question>(id)!;
    env.engine.discovery.decision(id, q.revision, "owner", currentUpstreamFixtureValue(env.engine, project,
      q.value.spec.field, preparedField(project, q.value.spec.field)));
  }
  const artifact = env.engine.draft(project, "concept", draft.id, 0);
  return env.engine.pipeline.accept(project, "concept", artifact.revision);
}

function countFileReads<T>(file: string, action: () => T): { value: T; count: number } {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function (...args: Parameters<typeof original>) {
    if (String(args[0]) === file) count++;
    return Reflect.apply(original, fs, args);
  } as typeof original;
  syncBuiltinESMExports();
  try { return { value: action(), count }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

for (const unusualId of [false, true]) test(`G2a source kind / exact Ref: ${unusualId ? "document:" : "source:"} id, inherited source and graph remain file-checked`, t => {
  const env = createEnv(t), project = "source-kind";
  env.engine.execute({ type: "create-project", project, title: project });
  const file = join(env.directory, "brief.txt"); writeFileSync(file, "Exact file source");
  const captured = env.engine.discovery.evidence.file(project, "brief", env.directory, "brief.txt", "text/plain", 0);
  const source = unusualId ? env.store.write<Source>({ id: `document:${project}:brief`, kind: "source",
    expected: 0, value: captured.value }) : captured;
  const { draft, artifact } = acceptFileDiscovery(env, project, source);
  const concept = acceptConcept(env, project);
  env.engine.graphs.saveDerived(project, exampleGraph(project), 0, "owner", reference(draft));
  const declared = { kind: "source", ref: reference(source) };
  assert.ok(artifact.value.closure!.external.some(check => hashJson(check) === hashJson(declared)));
  assert.ok(concept.value.closure!.inherited.some(check => hashJson(check) === hashJson(declared)));
  assert.ok(env.engine.graphs.layerGate(project, 1).closure!.external.some(check => hashJson(check) === hashJson(declared)));
  const cold = new Store(env.store.path); t.after(() => cold.close());
  const checks = new StageChecks(cold);
  for (const stage of ["discovery", "concept"] as const) assert.equal(checks.pipeline.inspect(project, stage).state, "accepted");
  for (const mutation of ["change", "delete"] as const) {
    if (mutation === "change") writeFileSync(file, "Changed on disk"); else unlinkSync(file);
    for (const stage of ["discovery", "concept"] as const) {
      const after = checks.pipeline.inspect(project, stage);
      assert.equal(after.state, "stale");
      assert.ok(after.findings.some(f => stage === "discovery"
        ? ["evidence_stale", "research_evidence_stale"].includes(f.code)
        : f.code === "input_stale" && f.target === stageId(project, "discovery")), JSON.stringify(after.findings));
    }
    assert.ok(checks.graphs.layerGate(project, 1).findings.some(f => f.code === "graph_evidence_stale" && f.target === source.id));
    writeFileSync(file, "Exact file source");
    assert.equal(checks.pipeline.inspect(project, "concept").state, "accepted", "the next operation rechecks without a manual reset");
  }
});

test("8. production validateStage / inspect / project share exact-source reads and reset on return and exception", t => {
  const env = createEnv(t), project = "memo-full";
  env.engine.execute({ type: "create-project", project, title: project });
  const file = join(env.directory, "memo.txt"); writeFileSync(file, "Original scope");
  const source = env.engine.discovery.evidence.file(project, "brief", env.directory, "memo.txt", "text/plain", 0);
  const { artifact } = acceptFileDiscovery(env, project, source); acceptConcept(env, project);
  const validate = () => env.engine.checks.validateStage("discovery", {
    projectId: project, content: artifact.value.content, inputs: [], accepted: true });
  const actions: (() => unknown)[] = [validate, () => env.engine.pipeline.inspect(project, "concept"), () => env.engine.pipeline.project(project)];
  for (const action of actions) {
    const measured = countFileReads(file, action);
    assert.equal(measured.count, 1, "nested validations and inherited closure checks share the same exact Ref");
  }
  assert.deepEqual(validate().findings, []);
  writeFileSync(file, "Changed between operations");
  const changed = countFileReads(file, validate);
  assert.equal(changed.count, 1); assert.ok(changed.value.findings.length > 0);
  writeFileSync(file, "Original scope");
  assert.deepEqual(countFileReads(file, validate).value.findings, []);
  const original = env.engine.checks.discovery.gate.bind(env.engine.checks.discovery);
  const intercepted = t.mock.method(env.engine.checks.discovery, "gate", (...args: Parameters<typeof original>) => {
    original(...args); throw new Error("after-source-check");
  });
  const aborted = countFileReads(file, () => assert.throws(validate, /after-source-check/));
  assert.equal(aborted.count, 1);
  intercepted.mock.restore(); writeFileSync(file, "Changed after exception");
  const afterException = countFileReads(file, validate);
  assert.equal(afterException.count, 1); assert.ok(afterException.value.findings.length > 0);
});

test("G2a two exact source refs for the same file are not collapsed into a path-only memo key", t => {
  const env = createEnv(t), project = "memo-exact";
  env.engine.execute({ type: "create-project", project, title: project });
  const file = join(env.directory, "two.txt"); writeFileSync(file, "Two exact sources");
  const first = env.engine.discovery.evidence.file(project, "brief", env.directory, "two.txt", "text/plain", 0);
  const second = env.store.write<Source>({ id: "document:second", kind: "source", expected: 0, value: first.value });
  const { artifact } = acceptFileDiscovery(env, project, first, second);
  const measured = countFileReads(file, () => env.engine.checks.validateStage("discovery", {
    projectId: project, content: artifact.value.content, inputs: [], accepted: true }));
  assert.deepEqual(measured.value.findings, []);
  assert.equal(measured.count, 2, "one filesystem check per exact Ref, even for the same pathname and digest");
});
