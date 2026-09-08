import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { reference } from "../src/pipeline/contracts.js";
import type { Graph } from "../src/graph/model.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { Revision } from "../src/storage/store.js";
import { composeLayer, layerDesignOf } from "../src/graph/layer-design.js";
import { projectGraph } from "../src/graph/project.js";
import { validateGraph } from "../src/graph/validate.js";
import { researchGraphContext } from "../src/discovery/research-context.js";
import { preparedFeatures } from "./product-fixture.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { answerLayerFixture } from "./layer-design-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { pilotContext } from '../src/discovery/pilot-context.js';

function fixture(t: test.TestContext, project: string) {
  const root = mkdtempSync(join(tmpdir(), "omg-layers-")); const workspace = join(root, "repo"); mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "A new local transformation product");
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const full = enrichedGraph(exampleGraph(project), project);
  preparedFeatures(engine, project, full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save(project, initial, store.get(`graph:${project}`)!.revision, "fixture");
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure(project, { workspace, implementer: { actor: "worker", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 1000 }, 0);
  const r0 = engine.refinement.begin(project, "R0");
  engine.refinement.finishResearch(project, "R0", reference(r0), 0); engine.refinement.sealLayer(project, 1, 0);
  return { store, engine, full };
}
function finish(engine: ProductEngine, project: string, level: "R1" | "R2") {
  const draft = engine.refinement.begin(project, level);
  answerTechnicalFixture(engine, project, draft);
  return engine.refinement.finishResearch(project, level, reference(engine.store.get(draft.id)!), 0);
}

test("two products build L2 then L3 through commands from assessed designs, preserving the same map and accepted upper layers", t => {
  for (const project of ["garden", "archive"]) {
    const { engine, store, full } = fixture(t, project);
    const initial = store.get<Graph>(`graph:${project}`)!;
    for (const level of [2, 3] as const) {
      finish(engine, project, level === 2 ? "R1" : "R2");
      const upper = store.get(`graph-layer:${project}:${level - 1}`)!;
      const draft = engine.execute({ type: "prepare-layer", project, level }) as Revision<DiscoveryDraft>;
      const context = researchGraphContext(store, draft.value)!;
      assert.equal(context.level, level - 1); assert.equal(context.research.length, 1);
      if (level === 3) {
        assert.ok('relationContext' in context && context.relationContext);
        assert.ok(context.relationContext.connectors.every(item => item.kind === 'connector'));
        assert.deepEqual(pilotContext(store, draft, store.get<Question>(draft.value.questions[0]!)!).map.relationContext, context.relationContext);
      }
      assert.ok(Object.hasOwn(context.research[0]!.fields, level === 2 ? "runtime" : "contractsAndConsumers"));
      const answered = answerLayerFixture(engine, project, draft, level, full);
      const graph = store.get<Graph>(`graph:${project}`)!;
      const built = engine.execute({ type: "build-layer", project, level, draft: reference(answered), expected: graph.revision }) as Revision<Graph>;
      assert.equal(built.value.id, initial.value.id);
      assert.equal(store.get(upper.id)!.hash, upper.hash, "Building a layer must not invalidate accepted upper research");
      assert.ok(built.value.nodes.some(node => node.kind === (level === 2 ? "operation" : "work")));
      if (level === 2) assert.ok(built.value.nodes.every(node => node.kind !== "work"));
      assert.deepEqual(engine.graphs.gate(project).findings, []);
      assert.deepEqual(engine.refinement.buildLayer(project, level, reference(answered), built.revision, "local-owner"), built);
      engine.refinement.sealLayer(project, level, 0);
    }
    assert.deepEqual(store.get<Graph>(initial.id, initial.revision)!.value, initial.value);
    assert.deepEqual(engine.refinement.gate(project, "L3").findings, []);
  }
});

test("manual graph saves and manual layer answers cannot bypass researched construction", t => {
  const { engine, store, full } = fixture(t, "p"); finish(engine, "p", "R1");
  engine.graphs.save("p", full, store.get("graph:p")!.revision, "owner");
  assert.throws(() => engine.refinement.sealLayer("p", 2, 0), /Build this layer/);
  const draft = engine.refinement.prepareLayer("p", 2);
  const answered = engine.discovery.decision(draft.value.questions[0]!, 1, "owner", layerDesignOf(full, 2));
  assert.throws(() => engine.refinement.buildLayer("p", 2, reference(answered), store.get("graph:p")!.revision, "owner"), /assessed model research/);
  assert.throws(() => engine.execute({ type: "build-layer", project: "p", level: 2, expected: 1 }), /Missing, extra/);
});

test("layer construction rejects stale research and graph versions, and later manual mutation invalidates its evidence", t => {
  const { engine, store, full } = fixture(t, "p"); const research = finish(engine, "p", "R1");
  const draft = engine.refinement.prepareLayer("p", 2);
  const answered = answerLayerFixture(engine, "p", draft, 2, full);
  const current = store.get<Graph>("graph:p")!;
  assert.throws(() => engine.refinement.buildLayer("p", 2, reference(answered), current.revision - 1, "owner"), /Graph changed/);
  const built = engine.refinement.buildLayer("p", 2, reference(answered), current.revision, "owner");
  const changed = structuredClone(built.value); changed.nodes.find(node => node.kind === "operation")!.benefit = "A different unresearched benefit";
  engine.graphs.save("p", changed, built.revision, "owner");
  assert.ok(engine.graphs.layerGate("p", 2).findings.some(item => item.code === "graph_layer_unproven"));
  assert.throws(() => engine.refinement.sealLayer("p", 2, 0), /missing or stale/);
  store.write({ id: research.id, kind: research.kind, expected: research.revision, value: research.value });
  assert.throws(() => engine.refinement.buildLayer("p", 2, reference(answered), store.get("graph:p")!.revision, "owner"), /current refinement prerequisites/);
});

test("layer designs preserve upper semantics and cannot omit a block result or the next layer", () => {
  const full = enrichedGraph(exampleGraph("p"), "p");
  const { level: _level, ...base } = projectGraph(full, 1);
  assert.throws(() => composeLayer(base as Graph, 2, null), /design is required/);
  const missing = layerDesignOf(full, 2) as any;
  missing.nodes = missing.nodes.filter((node: any) => node.id !== "p-refusal-operation");
  assert.throws(() => composeLayer(base as Graph, 2, missing), /does not realize/);
  const changed = layerDesignOf(full, 2) as any;
  changed.nodes.find((node: any) => node.kind === "block").purpose = "Changed upper purpose";
  assert.throws(() => composeLayer(base as Graph, 2, changed), /silently rewrite/);
  const identity = layerDesignOf(full, 2) as any; identity.id = "another-map";
  assert.throws(() => composeLayer(base as Graph, 2, identity), /inherited/);
  const empty = layerDesignOf(full, 2) as any; empty.nodes = empty.nodes.filter((node: any) => node.kind !== "operation");
  empty.connectors.forEach((connector: any) => { connector.bindings = connector.bindings.filter((binding: any) => binding.level === 1); });
  assert.throws(() => composeLayer(base as Graph, 2, empty), /must contain L2/);
});

test("a new internal connector can start at L2 inside one block but cannot disguise a cross-block connection", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  const producer = graph.nodes.find(node => node.id === "p-produce-operation")!;
  const consumer = { ...structuredClone(producer), id: "p-inner-operation", ports: [{ id: "in", direction: "in" as const, contract: "p-contract" }] };
  graph.nodes.push(consumer);
  graph.artifacts.push({ ...structuredClone(graph.artifacts[0]!), id: "p-inner-data" });
  graph.connectors.push({ id: "p-inner-flow", artifact: "p-inner-data", returnsTo: producer.id, wakeTest: null,
    bindings: [{ level: 2, producer: { node: producer.id, port: "out" }, consumers: [{ node: consumer.id, port: "in" }], anchor: null }] });
  assert.deepEqual(validateGraph(graph).findings, []);
  const { level: _level, ...upper } = projectGraph(graph, 1);
  assert.doesNotThrow(() => composeLayer(upper as Graph, 2, layerDesignOf(graph, 2)));
  consumer.parent = "p-consume-block";
  assert.ok(validateGraph(graph).findings.some(item => item.code === "refinement_gap"));
});

test("L3 preserves L2 dependencies for active consumers, including a single work unit realizing both roles", () => {
  const full = enrichedGraph(exampleGraph("p"), "p");
  const { level: _level, ...base } = projectGraph(full, 2);
  const missing = layerDesignOf(full, 3) as any;
  missing.connectors[0].bindings = missing.connectors[0].bindings.filter((binding: any) => binding.level !== 3);
  assert.throws(() => composeLayer(base as Graph, 3, missing), /L3 loses a producer or consumer/);

  const merged = structuredClone(full);
  const producer = merged.nodes.find(node => node.id === "p-produce-work")!;
  const consumer = merged.nodes.find(node => node.id === "p-consume-work")!;
  producer.ports.push(...consumer.ports); producer.outcome = consumer.outcome;
  merged.nodes = merged.nodes.filter(node => node.id !== consumer.id);
  merged.tests = merged.tests.filter(test => test.node !== consumer.id);
  merged.horizon = [producer.id];
  merged.edges!.push({ id: "merged-consumer", relation: "realizes", source: producer.id, target: consumer.parent!, condition: "The same atomic implementation supplies both operation roles" });
  merged.connectors[0]!.bindings[2]!.consumers = [{ node: producer.id, port: "in", codeRef: producer.code[0]! }];
  assert.doesNotThrow(() => composeLayer(base as Graph, 3, layerDesignOf(merged, 3)));

  const unbound = structuredClone(merged);
  producer.ports.push({ id: "unbound-input", direction: "in", contract: "p-contract" });
  assert.throws(() => composeLayer(base as Graph, 3, layerDesignOf(merged, 3)), /active input.*no producer binding/);
  assert.doesNotThrow(() => composeLayer(base as Graph, 3, layerDesignOf(unbound, 3)));
});
