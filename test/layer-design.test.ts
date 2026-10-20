import test from "node:test";
import assert from "node:assert/strict";
import type { Graph } from "../src/graph/model.js";
import { composeLayer, layerDesignOf } from "../src/graph/layer-design.js";
import { projectGraph } from "../src/graph/project.js";
import { validateGraph } from "../src/graph/validate.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";

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
