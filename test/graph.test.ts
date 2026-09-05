import test from "node:test";
import assert from "node:assert/strict";
import { exampleGraph } from "./graph-fixture.js";
import { validateGraph } from "../src/graph/validate.js";
import { topologicalOrder } from "../src/graph/topology.js";
import { hashJson } from "../src/canonical.js";

test("the same kernel validates independent product maps and preserves exact identity", () => {
  for (const name of ["garden", "invoice"]) {
    const graph = exampleGraph(name);
    const result = validateGraph(graph);
    assert.deepEqual(result.findings, []); assert.equal(result.hash, hashJson(graph));
  }
});

test("missing fields, foreign ports/tests/contracts and ambiguous producers never receive a handle", () => {
  const mutations = [
    (g: ReturnType<typeof exampleGraph>) => { delete (g as unknown as Record<string, unknown>)['contracts']; },
    (g: ReturnType<typeof exampleGraph>) => { g.connectors[0]!.bindings[2]!.producer.port = "nonexistent"; },
    (g: ReturnType<typeof exampleGraph>) => { g.nodes.at(-1)!.tests = ["foreign-test"]; },
    (g: ReturnType<typeof exampleGraph>) => { g.artifacts[0]!.contract = "foreign-contract"; },
    (g: ReturnType<typeof exampleGraph>) => {
      const second = structuredClone(g.nodes.find(node => node.id === "garden-produce-work")!); second.id = "second-producer";
      g.nodes.push(second);
      g.connectors[0]!.bindings.push({ ...structuredClone(g.connectors[0]!.bindings[2]!), producer: { node: second.id, port: "out" } });
    },
  ];
  for (const mutate of mutations) { const graph = exampleGraph(); mutate(graph); const result = validateGraph(graph); assert.equal(result.graph, null); assert.ok(result.findings.length); }
});

test("three distinct incoming connectors require a complete join at every represented level", () => {
  const graph = exampleGraph();
  for (const suffix of ["two", "three"]) {
    const connector = structuredClone(graph.connectors[0]!); connector.id = `garden-flow-${suffix}`; graph.connectors.push(connector);
    graph.tests[0]!.covers.push(connector.id);
  }
  assert.ok(validateGraph(graph).findings.some(item => item.code === "join_missing"));
  for (const kind of ["block", "operation", "work"]) graph.joins.push({ id: `join-${kind}`, consumer: `garden-consume-${kind}`, connectors: graph.connectors.map(c => c.id) });
  assert.deepEqual(validateGraph(graph).findings, []);
  graph.joins[0]!.connectors.pop();
  assert.ok(validateGraph(graph).findings.some(item => item.code === "join_inputs_invalid"));
});

test("parallel artifact edges do not become a false cycle; actual cycles are refused", () => {
  assert.deepEqual(topologicalOrder(["a", "b"], [["a", "b"], ["a", "b"]]), ["a", "b"]);
  assert.throws(() => topologicalOrder(["a", "b"], [["a", "b"], ["b", "a"]]), /cycle/);
});

test("future consumers require anchors and a real anchor outcome", () => {
  const graph = exampleGraph(); graph.horizon.pop();
  assert.ok(validateGraph(graph).findings.some(item => item.code === "future_dependency_unanchored"));
  graph.connectors[0]!.bindings[2]!.anchor = "wake"; graph.connectors[0]!.wakeTest = graph.tests[0]!.id;
  graph.anchors.push({ id: "wake", owner: "garden-produce-work", outcome: "missing", test: graph.tests[0]!.id });
  assert.ok(validateGraph(graph).findings.some(item => item.code === "anchor_outcome_missing"));
  graph.anchors[0]!.outcome = "garden-data";
  assert.deepEqual(validateGraph(graph).findings, []);
});

test("active work preserves operation boundaries and orders shared writes", () => {
  const graph = exampleGraph();
  graph.nodes.find(node => node.id === "garden-consume-work")!.boundary = {
    ...graph.nodes.find(node => node.id === "garden-consume-work")!.boundary, writer: "someone-else",
  };
  assert.ok(validateGraph(graph).findings.some(f => f.code === "boundary_mismatch"));
  const unordered = exampleGraph(); unordered.connectors = []; unordered.joins = [];
  unordered.artifacts[0]!.terminal = true; unordered.tests.forEach(t => { t.covers = []; });
  unordered.nodes.find(node => node.id === "garden-consume-work")!.code[0]!.path = "produce.txt";
  assert.ok(validateGraph(unordered).findings.some(f => f.code === "write_ownership_overlap"));
});
