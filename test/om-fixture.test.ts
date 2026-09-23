import test from "node:test";
import assert from "node:assert/strict";
import { canonical, hashJson } from "../src/canonical.js";
import { nodeSignature, receiptId } from "../src/compiler/model.js";
import { resolveArtifact } from "../src/compiler/inputs.js";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { Executor } from "../src/execution/runner.js";
import { composeLayer, layerDesignOf } from "../src/graph/layer-design.js";
import { L3_ASSEMBLY } from "../src/graph/layer-assembly.js";
import type { Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { validateGraph } from "../src/graph/validate.js";
import { reference, type StageArtifact } from "../src/pipeline/contracts.js";
import { Store } from "../src/storage/store.js";
import { createCrossOmFixture, createOmFixture, gardenGraph, OM_FIXTURE_ERROR } from "./om-fixture.js";

function projection(graph: Graph, level: 1 | 2 | 3): Graph {
  const { level: _level, ...value } = projectGraph(graph, level);
  return value as Graph;
}

function assertComposes(graph: Graph): void {
  const l2 = composeLayer(projection(graph, 1), 2, layerDesignOf(graph, 2));
  assert.equal(canonical(l2), canonical(projection(graph, 2)));
  const l3 = composeLayer(l2, 3, layerDesignOf(graph, 3, L3_ASSEMBLY), L3_ASSEMBLY);
  assert.equal(canonical(l3), canonical(graph));
}

test("the standard garden fixture has accepted stages, derived layers and compiler-valid artifact receipts", async t => {
  const fixture = await createOmFixture(t);
  assert.deepEqual(validateGraph(fixture.graph).findings, []);
  assertComposes(fixture.graph);
  assert.deepEqual(fixture.graph.nodes.reduce<Record<string, number>>((counts, node) => {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1; return counts;
  }, {}), { product: 1, block: 4, operation: 5, work: 5 });
  assert.deepEqual([...fixture.graph.horizon].sort(), ["garden-consume-work", "garden-prep-work", "garden-produce-work"]);
  assert.deepEqual(fixture.graph.artifacts.map(artifact => artifact.id).sort(),
    ["garden-data", "garden-later", "garden-prep", "garden-refusal", "garden-result"]);
  assert.deepEqual(fixture.graph.connectors.map(connector => connector.id).sort(), ["garden-flow", "garden-prep-flow"]);
  for (const [id, parent] of [["w-garden-later-operation", "garden-later-operation"],
    ["w-garden-refusal-operation", "garden-refusal-operation"]] as const) {
    const representative = fixture.graph.nodes.find(node => node.id === id)!;
    assert.deepEqual([representative.kind, representative.parent, fixture.graph.horizon.includes(id)], ["work", parent, false]);
  }
  assert.deepEqual(fixture.graph.anchors, [{ id: "anchor-garden-flow", owner: "garden-produce-work",
    outcome: "garden-data", test: "garden-produce-work-test" }]);
  assert.equal(fixture.graph.connectors.find(connector => connector.id === "garden-flow")!.wakeTest, "garden-produce-work-test");

  for (const [index, stage] of UPSTREAM_STAGES.entries()) {
    const artifact = fixture.stages[stage];
    const inspected = fixture.engine.pipeline.inspect(fixture.project, stage);
    assert.equal(inspected.state, "accepted");
    assert.deepEqual(inspected.findings, []);
    assert.equal(artifact.kind, "stage");
    assert.equal(artifact.value.status, "accepted");
    assert.deepEqual(artifact.value.inputs, index === 0 ? [] : [reference(fixture.stages[UPSTREAM_STAGES[index - 1]!])]);
  }
  for (const level of [1, 2, 3] as const) {
    assert.deepEqual(fixture.engine.graphs.layerGate(fixture.project, level, reference(fixture.layers[level])).findings, []);
    assert.equal(canonical(fixture.layers[level].value.projection), canonical(projectGraph(fixture.graph, level)));
  }
  assert.deepEqual(fixture.graphRevision, fixture.store.get(`graph:${fixture.project}`));
  assert.equal(fixture.plan.value.tasks.length, 3);
  assert.equal(fixture.runs.length, 3);
  assert.ok(fixture.runs.every(run => run.value.state === "committed"));

  const receiptProducers = {
    "garden-data": "garden-produce-work",
    "garden-prep": "garden-prep-work",
    "garden-result": "garden-consume-work",
  } as const;
  assert.deepEqual(Object.keys(fixture.receipts).sort(), Object.keys(receiptProducers).sort());
  for (const [artifactId, producerId] of Object.entries(receiptProducers)) {
    const receipt = fixture.receipts[artifactId]!;
    const artifact = fixture.graph.artifacts.find(item => item.id === artifactId)!;
    const producer = fixture.graph.nodes.find(item => item.id === producerId)!;
    const contract = fixture.graph.contracts.find(item => item.id === artifact.contract)!;
    assert.deepEqual(fixture.store.get(receipt.id), receipt);
    assert.equal(receipt.id, receiptId(fixture.project, artifactId));
    assert.equal(receipt.kind, "artifact");
    assert.equal(receipt.value.projectId, fixture.project);
    assert.equal(receipt.value.artifact, artifactId);
    assert.equal(receipt.value.node, producerId);
    assert.equal(receipt.value.signature, nodeSignature(fixture.graph, producer));
    assert.equal(receipt.value.contractHash, hashJson(contract.schema));
    assert.match(receipt.value.commit, /^[a-f0-9]{40}$/);
    assert.match(receipt.value.tree, /^[a-f0-9]{40}$/);
    assert.deepEqual(receipt.value.value.files.map(file => file.path), producer.code.filter(ref => ref.access === "write").map(ref => ref.path));
    assert.ok(receipt.value.plan && receipt.value.run);
    assert.deepEqual(resolveArtifact(fixture.store, fixture.project, fixture.graph, fixture.repository,
      producer.id, artifact.id), { receipt: reference(receipt), source: null });
  }
  assert.equal(fixture.store.get(receiptId(fixture.project, "garden-later")), null);
  assert.equal(fixture.store.get(receiptId(fixture.project, "garden-refusal")), null);
});

test("the cross-flow fixture preserves each producer and consumer port through all three layers", async t => {
  const fixture = await createCrossOmFixture(t);
  assert.deepEqual(validateGraph(fixture.graph).findings, []);
  assertComposes(fixture.graph);
  const flow = fixture.graph.connectors.find(item => item.id === "garden-flow")!;
  for (const [kind, level] of [["block", 1], ["operation", 2], ["work", 3]] as const) {
    const live = flow.bindings.filter(binding => binding.level === level && binding.anchor === null);
    assert.equal(live.length, 2);
    const primary = live.find(binding => binding.producer.port === "out")!;
    const cross = live.find(binding => binding.producer.port === "out-alt")!;
    assert.equal(primary.producer.node, `garden-produce-${kind}`);
    assert.equal(cross.producer.node, `garden-produce-${kind}`);
    const expectedPrimary = [`garden-consume-${kind}/in`, `garden-consume-${kind}/in-alt`,
      ...(level < 3 ? [`garden-later-${kind}/in`] : [])].sort();
    assert.deepEqual(primary.consumers.map(endpoint => `${endpoint.node}/${endpoint.port}`).sort(), expectedPrimary);
    assert.deepEqual(cross.consumers.map(endpoint => `${endpoint.node}/${endpoint.port}`), [`garden-consume-${kind}/in`]);
  }
  const sleeping = flow.bindings.filter(binding => binding.level === 3 && binding.anchor !== null);
  assert.deepEqual(sleeping.map(binding => [binding.producer.node, binding.producer.port,
    binding.consumers[0]!.node, binding.consumers[0]!.port, binding.anchor]),
  [["garden-produce-work", "out", "w-garden-later-operation", "in", "anchor-garden-flow"]]);
});

test("missing, forged and masquerading fixture inputs are rejected at their exact engine boundaries", async t => {
  const fixture = await createOmFixture(t);
  const invalid = (target: string) => (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, OM_FIXTURE_ERROR);
    assert.deepEqual(error.details, { target });
    return true;
  };
  for (const value of [null, 42, {}, "unknown"]) assert.throws(() => gardenGraph(value as never), invalid("/variant"));
  for (const value of [null, 42, {}, "", "foreign/project"]) assert.throws(() => gardenGraph("standard", value as never), invalid("/project"));
  for (const value of [undefined, null, {}, 42]) await assert.rejects(createOmFixture(value as never), invalid("/t"));
  await assert.rejects(createOmFixture(t, null as never), invalid("/variant"));
  await assert.rejects(createCrossOmFixture(t, null as never), invalid("/project"));
  const malformed = structuredClone(fixture.graph);
  delete (malformed.nodes[0] as Partial<(typeof malformed.nodes)[number]>).title;
  assert.ok(validateGraph(malformed).findings.some(finding => finding.code === "graph_shape" && finding.target === "/nodes/0"));

  const disconnected = structuredClone(fixture.graph);
  const flow = disconnected.connectors.find(item => item.id === "garden-flow")!;
  flow.bindings = flow.bindings.filter(binding => binding.anchor === null);
  flow.wakeTest = null;
  disconnected.anchors = disconnected.anchors.filter(anchor => anchor.id !== "anchor-garden-flow");
  assert.deepEqual(validateGraph(disconnected).findings, []);
  const l2 = projection(disconnected, 2);
  assert.throws(() => composeLayer(l2, 3, layerDesignOf(disconnected, 3, L3_ASSEMBLY), L3_ASSEMBLY),
    error => error instanceof EngineError && error.code === "layer_connector_uncovered");

  const exactLayer = reference(fixture.layers[3]);
  assert.deepEqual(fixture.engine.graphs.layerGate(fixture.project, 3, { ...exactLayer, hash: "0".repeat(64) }).findings.map(item => item.code),
    ["graph_layer_stale"]);

  const features = fixture.stages.features;
  const missingProof = fixture.store.write<StageArtifact>({ id: features.id, kind: features.kind, expected: features.revision,
    value: { ...features.value, status: "accepted", proofs: [{ id: "missing:source", revision: 1, hash: "0".repeat(64) }] } });
  assert.ok(fixture.engine.pipeline.inspect(fixture.project, "features").findings.some(finding => finding.code === "proof_stale" && finding.target === "missing:source"));

  const concept = fixture.stages.concept;
  fixture.store.write<StageArtifact>({ id: concept.id, kind: concept.kind, expected: concept.revision,
    value: { ...concept.value, status: "accepted", inputs: [] } });
  const missingSet = fixture.engine.pipeline.inspect(fixture.project, "concept");
  assert.equal(missingSet.state, "stale");
  assert.ok(missingSet.findings.some(finding => finding.code === "input_set_invalid" && finding.target === concept.id));

  fixture.store.write<StageArtifact>({ id: missingProof.id, kind: missingProof.kind, expected: missingProof.revision,
    value: { ...missingProof.value, projectId: "foreign", status: "accepted" } });
  assert.throws(() => fixture.engine.pipeline.inspect(fixture.project, "features"),
    error => error instanceof EngineError && error.code === "foreign_artifact");
});

test("two fixture calls isolate identical project identities in separate persistent databases", async t => {
  const first = await createOmFixture(t);
  const second = await createOmFixture(t);
  assert.notEqual(first.database, second.database);
  assert.notEqual(first.store.databaseId, second.store.databaseId);
  first.store.write({ id: "fixture-local", kind: "marker", expected: 0, value: { owner: "first" } });
  assert.equal(second.store.get("fixture-local"), null);
  first.reopen();
  assert.deepEqual(first.store.get("fixture-local")?.value, { owner: "first" });
});

test("an interrupted execution cannot return a completed garden fixture", async t => {
  const run = Executor.prototype.run;
  t.mock.method(Executor.prototype, "run", function (this: Executor, ...args: Parameters<Executor["run"]>) {
    return run.call(this, args[0], args[1], args[2], AbortSignal.abort());
  });
  await assert.rejects(createOmFixture(t), error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, OM_FIXTURE_ERROR);
    assert.deepEqual(error.details, { target: "/runs" });
    return true;
  });
});

test("a missing committed receipt rejects fixture creation at the exact record", async t => {
  const run = Executor.prototype.run;
  const get = Store.prototype.get;
  const missing = receiptId("garden", "garden-prep");
  let completed = false;
  t.mock.method(Executor.prototype, "run", async function (this: Executor, ...args: Parameters<Executor["run"]>) {
    const runs = await run.apply(this, args);
    completed = true;
    return runs;
  });
  t.mock.method(Store.prototype, "get", function (this: Store, ...args: Parameters<Store["get"]>) {
    return completed && args[0] === missing ? null : get.apply(this, args);
  });
  await assert.rejects(createOmFixture(t), error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, OM_FIXTURE_ERROR);
    assert.deepEqual(error.details, { target: missing });
    return true;
  });
});
