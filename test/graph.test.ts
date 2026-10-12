import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
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

// ---- S1.5 (№2363): the compilability verdict of a contract schema is remembered by the bytes of the schema ----

type Contract = ReturnType<typeof exampleGraph>["contracts"][number];
/** Counts the Ajv compilations a run performs: the verdict memory is observable only through them. */
function compilations<T>(run: () => T): { result: T; compiled: number } {
  const original = Ajv.prototype.compile; let compiled = 0;
  Ajv.prototype.compile = function (this: Ajv, ...args: unknown[]) { compiled++; return (original as unknown as (...rest: unknown[]) => unknown).apply(this, args); } as unknown as typeof original;
  try { return { result: run(), compiled }; } finally { Ajv.prototype.compile = original; }
}
/** The graph of the fixture with exactly these contracts (its artifact keeps the fixture's own contract). */
function withContracts(contracts: Contract[]) {
  const graph = exampleGraph(); graph.contracts.push(...contracts); return graph;
}
/** What a fresh isolated compilation says about one schema — the independent reference of every verdict below. */
const compilesAlone = (schema: unknown): boolean => { try { new Ajv({ strict: true }).compile(schema as object); return true; } catch { return false; } };
const invalidContracts = (graph: ReturnType<typeof exampleGraph>) => validateGraph(graph).findings.filter(f => f.code === "contract_invalid").map(f => f.target).sort();
/** The findings of validateGraph agree with an independent compilation of every contract, whatever the memory holds. */
function agreesWithIndependentCompilation(graph: ReturnType<typeof exampleGraph>) {
  assert.deepEqual(invalidContracts(graph), graph.contracts.filter(c => !compilesAlone(c.schema)).map(c => c.id).sort());
}
const unique = (tag: string, index: number) => ({ type: "string", description: `s15-${tag}-${index}` });

test("S1.5 №2363 a contract schema is compiled once per distinct schema: equal bytes in another object and under another contract id reuse the verdict, a changed schema and the reverse order compile only what is new, and the findings equal an independent compilation", () => {
  // The fixture's own contract is remembered first, so a filtered standalone run counts the same as a full one.
  invalidContracts(withContracts([]));
  const a = { id: "s15-a", schema: unique("once", 1) }, b = { id: "s15-b", schema: structuredClone(unique("once", 1)) };
  const first = compilations(() => invalidContracts(withContracts([a, b])));
  assert.deepEqual(first.result, []); assert.equal(first.compiled, 1, "Equal bytes in two objects under two ids compile once");
  assert.equal(compilations(() => invalidContracts(withContracts([a, b]))).compiled, 0, "A repeat compiles nothing");
  assert.equal(compilations(() => invalidContracts(withContracts([b, a]))).compiled, 0, "The reverse order compiles nothing");
  const changed = { id: "s15-b", schema: unique("once", 2) };
  assert.equal(compilations(() => invalidContracts(withContracts([a, changed]))).compiled, 1, "A changed schema in the same object compiles again");
  agreesWithIndependentCompilation(withContracts([a, b, changed]));
});

test("S1.5 №2363 every contract is judged alone: equal $id in two schemas is no refusal, a self-contained inner $ref passes, an external $ref fails whatever was compiled before and in either order, and a repeated invalid schema stays invalid under its current id without compiling again", () => {
  const sameId1 = { id: "s15-id-1", schema: { $id: "urn:s15:shared", type: "string", description: "s15-id-1" } };
  const sameId2 = { id: "s15-id-2", schema: { $id: "urn:s15:shared", type: "number", description: "s15-id-2" } };
  const inner = { id: "s15-inner", schema: { $id: "urn:s15:inner", definitions: { s: { type: "string" } }, $ref: "#/definitions/s" } };
  const external = { id: "s15-external", schema: { $ref: "urn:s15:shared" } };
  assert.deepEqual([compilesAlone(sameId1.schema), compilesAlone(sameId2.schema), compilesAlone(inner.schema), compilesAlone(external.schema)], [true, true, true, false]);
  // The fixture's own contract is remembered first, so the count below is exact for these four schemas alone.
  invalidContracts(withContracts([]));
  const forward = compilations(() => invalidContracts(withContracts([sameId1, sameId2, inner, external])));
  assert.deepEqual(forward.result, ["s15-external"], "Only the external reference is refused; the shared $id and the inner $ref pass");
  assert.equal(forward.compiled, 4, "Four distinct schemas, four isolated compilations");
  const backward = compilations(() => invalidContracts(withContracts([external, inner, sameId2, sameId1])));
  assert.deepEqual(backward.result, ["s15-external"], "The reverse order judges the same");
  assert.equal(backward.compiled, 0, "Positive and negative verdicts are both remembered");
  const renamed = compilations(() => invalidContracts(withContracts([{ id: "s15-external-renamed", schema: structuredClone(external.schema) }])));
  assert.deepEqual(renamed.result, ["s15-external-renamed"], "A repeated invalid schema is refused under its current contract id");
  assert.equal(renamed.compiled, 0);
  agreesWithIndependentCompilation(withContracts([external, inner, sameId2, sameId1]));
  // A graph with a contract the memory already holds as invalid keeps the rest of its validation.
  const graph = withContracts([external]);
  const result = validateGraph(graph);
  assert.equal(result.graph, null); assert.ok(result.findings.some(f => f.code === "contract_invalid" && f.target === "s15-external"));
});

test("S1.5 №2363 the verdict memory is bounded: past 512 distinct schemas the least recently used verdict is compiled again, the others are kept", () => {
  // The fixture's own contract is the 512th schema; it is remembered first, so every count below is exact.
  invalidContracts(withContracts([]));
  const many = Array.from({ length: 511 }, (_, index) => ({ id: `s15-many-${index}`, schema: unique("many", index) }));
  const cold = compilations(() => invalidContracts(withContracts(many)));
  assert.deepEqual(cold.result, []); assert.equal(cold.compiled, 511);
  assert.equal(compilations(() => invalidContracts(withContracts(many))).compiled, 0, "512 verdicts are all kept");
  const extra = { id: "s15-extra", schema: unique("extra", 1) };
  assert.equal(compilations(() => invalidContracts(withContracts([extra]))).compiled, 1, "The 513th schema evicts the least recently used one");
  assert.equal(compilations(() => invalidContracts(withContracts([many[0]!]))).compiled, 1, "The evicted (least recently used) verdict is compiled again");
  assert.equal(compilations(() => invalidContracts(withContracts([many[2]!]))).compiled, 0, "A verdict used more recently is still kept");
  assert.equal(compilations(() => invalidContracts(withContracts([extra]))).compiled, 0);
});

// ---- AT1 (№4091 п.4, п.7): a work's impact decisions and the connections its own result needs, as graph form ----
import { enrichedGraph } from "./enriched-graph-fixture.js";
import type { Graph } from "../src/graph/model.js";
const decided = (): Graph => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  const produce = graph.nodes.find(node => node.id === "p-produce-work")!, consume = graph.nodes.find(node => node.id === "p-consume-work")!;
  produce.code.push({ path: "test/cli.test.ts", access: "write", status: "existing" });
  produce.code.push({ path: "src/store.ts", access: "write", status: "planned" });
  produce.impact = [
    { entry: { file: "test/cli.test.ts", case: ["CLI", "persists commands"] }, decision: "update", requirement: "p-R1", expectation: "p-produce-work-test" },
    { entry: { file: "test/cli.test.ts", rest: true }, decision: "keep", requirement: "p-R1" },
    { entry: { files: ["test/server.test.ts", "test/ui.test.ts"] }, decision: "keep", requirement: "p-contract" },
    { entry: { transitive: true }, decision: "keep", requirement: "p-R1" },
  ];
  consume.integrations = [{ entry: "src/store.ts#commit", contract: "p-contract", basis: { predecessor: "p-produce-work" } },
    { entry: "src/cli.ts#main", contract: "p-contract", basis: { existing: "src/cli.ts" } }];
  return graph;
};
const codes = (graph: Graph) => validateGraph(graph).findings.map(finding => finding.code);

test("AT1 П4/П7 a graph of the earlier era is valid as written; decisions tied to a requirement and an update with its write path and test, and connections from existing code or a predecessor, are valid", () => {
  assert.deepEqual(codes(enrichedGraph(exampleGraph("p"), "p")), []);
  const graph = decided();
  assert.deepEqual(codes(graph), []);
  assert.ok(validateGraph(graph).graph, "the new fields are part of the graph handle");
});

test("AT1 П4 every decision is tied: a repeated entry, an unknown requirement, a kept expectation with a new one, an update of the transitive set, without its write path or without this work's test — each refused by its code", () => {
  const cases: [string, (graph: Graph) => void][] = [
    ["impact_entry_duplicate", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact!.push({ entry: { file: "test/server.test.ts" }, decision: "keep", requirement: "p-R1" }); }],
    ["impact_entry_duplicate", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact!.push({ entry: { file: "test/cli.test.ts" }, decision: "keep", requirement: "p-R1" }); }],
    ["impact_rest_invalid", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact!.push({ entry: { file: "test/other.test.ts", rest: true }, decision: "keep", requirement: "p-R1" }); }],
    ["impact_update_invalid", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact![2] = { entry: { files: ["test/server.test.ts"] }, decision: "update", requirement: "p-R1", expectation: "p-produce-work-test" }; }],
    ["impact_requirement_unknown", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact![2]!.requirement = "p-unknown"; }],
    ["impact_keep_invalid", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact![2]!.expectation = "p-produce-work-test"; }],
    ["impact_update_invalid", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact![3] = { entry: { transitive: true }, decision: "update", requirement: "p-R1", expectation: "p-produce-work-test" }; }],
    ["impact_update_unscoped", graph => { const node = graph.nodes.find(item => item.id === "p-produce-work")!; node.code = node.code.filter(ref => ref.path !== "test/cli.test.ts"); }],
    ["impact_update_unexplained", graph => { delete graph.nodes.find(node => node.id === "p-produce-work")!.impact![0]!.expectation; }],
    ["impact_update_unexplained", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.impact![0]!.expectation = "p-consume-work-test"; }],
  ];
  for (const [code, mutate] of cases) { const graph = decided(); mutate(graph); assert.deepEqual(codes(graph), [code], code); }
});

test("AT1 П7 a connection the own result needs rests on existing code or a preceding work: one a later work makes is deferred; an unknown contract or basis is refused", () => {
  const cases: [string, (graph: Graph) => void][] = [
    ["work_integration_deferred", graph => { graph.nodes.find(node => node.id === "p-produce-work")!.integrations = [{ entry: "src/store.ts#commit", contract: "p-contract", basis: { predecessor: "p-consume-work" } }]; }],
    ["integration_contract_unknown", graph => { graph.nodes.find(node => node.id === "p-consume-work")!.integrations![0]!.contract = "p-none"; }],
    ["integration_basis_unknown", graph => { graph.nodes.find(node => node.id === "p-consume-work")!.integrations![0]!.basis = { predecessor: "p-consume-work" }; }],
    ["integration_basis_unknown", graph => { graph.nodes.find(node => node.id === "p-consume-work")!.integrations![0]!.basis = { predecessor: "p-nowhere" }; }],
    ["integration_basis_unknown", graph => { graph.nodes.find(node => node.id === "p-consume-work")!.integrations![1]!.basis = { existing: "../outside.ts" }; }],
    ["integration_basis_unknown", graph => { graph.nodes.find(node => node.id === "p-consume-work")!.integrations![1]!.basis = { existing: "src/other.ts" }; }],
    ["integration_basis_unknown", graph => { const node = graph.nodes.find(item => item.id === "p-produce-work")!; node.code = node.code.filter(ref => ref.path !== "src/store.ts"); }],
  ];
  for (const [code, mutate] of cases) { const graph = decided(); mutate(graph); assert.deepEqual(codes(graph), [code], code); }
  const reading = decided();
  reading.nodes.find(node => node.id === "p-produce-work")!.code.push({ path: "src/store.ts", access: "read", status: "existing" });
  assert.deepEqual(codes(reading), [], "an ordinary read of a file a later work changes is no promised connection");
  for (const shape of [{ entry: { file: "x", extra: 1 }, decision: "keep", requirement: "p-R1" }, { entry: { file: "x" }, decision: "drop", requirement: "p-R1" }]) {
    const graph = decided(); graph.nodes.find(node => node.id === "p-produce-work")!.impact!.push(shape as never);
    assert.equal(validateGraph(graph).graph, null, JSON.stringify(shape));
  }
});
