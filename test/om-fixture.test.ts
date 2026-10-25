import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
import { delivered, refused, type OmResult } from "../src/om/refusal.js";
import { readAcceptedFrame } from "../src/om/frame-accept.js";
import { flowKey, representativeId, workAnchorId } from "../src/om/frame-obligations.js";
import type { OmAcceptedFrame, LayerBasis } from "../src/om/layer-basis.js";
import { readHandoff } from "../src/om/handoff.js";
import type { OmFeasibility } from "../src/om/feasibility.js";
import { withHistoricalUpstream } from "./product-fixture.js";
import type { OmPreparedFixture } from "./om-fixture.js";
import { Store } from "../src/storage/store.js";
import { createCrossOmFixture, createOmFixture, gardenGraph, OM_FIXTURE_ERROR, refusedWith, thrownWith } from "./om-fixture.js";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");

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

function sleepingGardenAnchor(graph: Graph): string {
  const connector = graph.connectors.find(item => item.id === "garden-flow")!;
  const upper = connector.bindings.find(binding => binding.level === 2 && binding.anchor === null && binding.producer.port === "out");
  assert.ok(upper);
  return workAnchorId(connector.id, flowKey(upper), { node: "garden-produce-work", port: "out" });
}

test("the standard garden fixture has accepted stages, derived layers and compiler-valid artifact receipts", async t => {
  const fixture = await createOmFixture(t, "standard", "garden", { mode: "executed" });
  assert.deepEqual(validateGraph(fixture.graph).findings, []);
  assertComposes(fixture.graph);
  assert.deepEqual(fixture.graph.nodes.reduce<Record<string, number>>((counts, node) => {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1; return counts;
  }, {}), { product: 1, block: 4, operation: 5, work: 5 });
  assert.deepEqual([...fixture.graph.horizon].sort(), ["garden-consume-work", "garden-prep-work", "garden-produce-work"]);
  assert.deepEqual(fixture.graph.artifacts.map(artifact => artifact.id).sort(),
    ["garden-data", "garden-later", "garden-prep", "garden-refusal", "garden-result"]);
  assert.deepEqual(fixture.graph.connectors.map(connector => connector.id).sort(), ["garden-flow", "garden-prep-flow"]);
  for (const parent of ["garden-later-operation", "garden-refusal-operation"]) {
    const id = representativeId(parent, 3);
    const representative = fixture.graph.nodes.find(node => node.id === id)!;
    assert.deepEqual([representative.kind, representative.parent, fixture.graph.horizon.includes(id)], ["work", parent, false]);
  }
  assert.deepEqual(fixture.graph.anchors, [{ id: sleepingGardenAnchor(fixture.graph), owner: "garden-produce-work",
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
  const fixture = await createCrossOmFixture(t, "garden", { mode: "executed" });
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
  [["garden-produce-work", "out", representativeId("garden-later-operation", 3), "in", sleepingGardenAnchor(fixture.graph)]]);
});

test("missing, forged and masquerading fixture inputs are rejected at their exact engine boundaries", async t => {
  const fixture = await createOmFixture(t, "standard", "garden", { mode: "executed" });
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
  disconnected.anchors = disconnected.anchors.filter(anchor => anchor.id !== sleepingGardenAnchor(fixture.graph));
  assert.equal(disconnected.anchors.length, 0);
  assert.deepEqual(validateGraph(disconnected).findings, []);
  const l2 = projection(disconnected, 2);
  assert.throws(() => composeLayer(l2, 3, layerDesignOf(disconnected, 3, L3_ASSEMBLY), L3_ASSEMBLY),
    error => error instanceof EngineError && error.code === "layer_connector_uncovered");

  const exactLayer = reference(fixture.layers[3]);
  assert.deepEqual(fixture.engine.graphs.layerGate(fixture.project, 3, { ...exactLayer, hash: "0".repeat(64) }).findings.map(item => item.code),
    ["graph_layer_stale"]);

  // A new acceptance validates inputs; reading a committed stage does not revalidate its body.
  const concept = fixture.stages.concept;
  const conceptDraft = fixture.engine.pipeline.draft(fixture.project, "concept", concept.value.content, concept.revision);
  const missingInputs = fixture.store.write<StageArtifact>({ id: conceptDraft.id, kind: conceptDraft.kind, expected: conceptDraft.revision,
    value: { ...conceptDraft.value, inputs: [] } });
  const missingSet = fixture.engine.pipeline.inspect(fixture.project, "concept");
  assert.equal(missingSet.state, "blocked");
  assert.ok(missingSet.findings.some(finding => finding.code === "input_set_invalid" && finding.target === concept.id));
  const beforeAcceptance = fixture.store.list();
  assert.throws(() => fixture.engine.pipeline.accept(fixture.project, "concept", missingInputs.revision),
    error => error instanceof EngineError && error.code === "gate_rejected" && Array.isArray(error.details)
      && error.details.some(finding => finding.code === "input_set_invalid" && finding.target === concept.id));
  assert.deepEqual(fixture.store.get(concept.id), missingInputs);
  assert.deepEqual(fixture.store.list(), beforeAcceptance, "Refused acceptance must not write a new record or revision");

  const features = fixture.stages.features;
  const missingProof = fixture.store.write<StageArtifact>({ id: features.id, kind: features.kind, expected: features.revision,
    value: { ...features.value, status: "accepted", proofs: [{ id: "missing:source", revision: 1, hash: "0".repeat(64) }] } });
  const missingProofInspect = fixture.engine.pipeline.inspect(fixture.project, "features");
  assert.equal(missingProofInspect.state, "stale");
  assert.ok(missingProofInspect.findings.some(finding => finding.code === "stage_closure_invalid" && finding.target === features.id));

  fixture.store.write<StageArtifact>({ id: missingProof.id, kind: missingProof.kind, expected: missingProof.revision,
    value: { ...missingProof.value, projectId: "foreign", status: "accepted" } });
  assert.throws(() => fixture.engine.pipeline.inspect(fixture.project, "features"),
    error => error instanceof EngineError && error.code === "foreign_artifact");
});

test("two fixture calls isolate identical project identities in separate persistent databases", async t => {
  const first = await createOmFixture(t, "standard", "garden", { mode: "executed" });
  const second = await createOmFixture(t, "standard", "garden", { mode: "executed" });
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
  await assert.rejects(createOmFixture(t, "standard", "garden", { mode: "executed" }), error => {
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
  await assert.rejects(createOmFixture(t, "standard", "garden", { mode: "executed" }), error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, OM_FIXTURE_ERROR);
    assert.deepEqual(error.details, { target: missing });
    return true;
  });
});


function assertCurrentStages(fixture: OmPreparedFixture): void {
  for (const [index, stage] of UPSTREAM_STAGES.entries()) {
    const artifact = fixture.stages[stage];
    assert.equal(artifact.value.status, "accepted");
    assert.equal(fixture.engine.pipeline.inspect(fixture.project, stage).state, "accepted");
    assert.deepEqual(artifact.value.inputs, index === 0 ? [] : [reference(fixture.stages[UPSTREAM_STAGES[index - 1]!])]);
  }
  assert.equal(fixture.store.list().some(row => row.id.startsWith("phase:")), false);
  assert.equal(fixture.store.get(`feasibility:${fixture.project}`), null);
}

function assertNativeAcceptance(fixture: OmPreparedFixture, level: 2 | 3): void {
  const layer = fixture.store.get<LayerBasis>(`graph-layer:${fixture.project}:${level}`)!;
  const frame = fixture.store.get<OmAcceptedFrame>(`om-frame:${fixture.project}:${level}`)!;
  assert.ok(layer && frame);
  assert.equal(layer.value.acceptance?.producer, "om");
  assert.equal(readAcceptedFrame(fixture.store, { project: fixture.project, level,
    graph: frame.value.acceptance.graph, layer: reference(layer), frame: reference(frame) }).ok, true);
}

test("LG01a stages uses current producers even inside an inherited historical scope", async t => {
  for (const variant of ["standard", "cross"] as const) {
    const fixture = await withHistoricalUpstream("must-never-load-this-era", () => variant === "cross"
      ? createCrossOmFixture(t, "sprout", { mode: "stages" })
      : createOmFixture(t, variant, "sprout", { mode: "stages" }));
    assertCurrentStages(fixture);
    for (const id of ["om-input:sprout", "om-frame:sprout:2", "om-frame:sprout:3", "om-feasibility:sprout", "stage:sprout:om-g2", "stage:sprout:compilation"])
      assert.equal(fixture.store.get(id), null, id);
    for (const level of [1, 2, 3] as const)
      assert.deepEqual(fixture.layers[level].value.projection, projectGraph(fixture.graph, level));
    assert.equal("plan" in fixture, false);
    assert.equal("runs" in fixture, false);
    const before = fixture.store.list();
    fixture.reopen();
    assert.deepEqual(fixture.store.list(), before);
    assert.equal(fixture.engine.store, fixture.store);
  }
});

test("LG01a n2 accepts the operations frame through G3 for standard and cross gardens", async t => {
  for (const variant of ["standard", "cross"] as const) {
    const fixture = variant === "cross" ? await createCrossOmFixture(t, "sprout", { mode: "n2" })
      : await createOmFixture(t, variant, "sprout", { mode: "n2" });
    assertCurrentStages(fixture);
    assertNativeAcceptance(fixture, 2);
    assert.equal(fixture.store.get("om-frame:sprout:3"), null);
    assert.equal(fixture.store.get("om-feasibility:sprout"), null);
    assert.equal(fixture.store.get("stage:sprout:om-g2"), null);
    assert.equal("plan" in fixture, false);
    const flow = fixture.graph.connectors.find(connector => connector.id === "sprout-flow")!;
    assert.equal(flow.bindings.filter(binding => binding.level === 2).length, variant === "cross" ? 2 : 1);
    assert.deepEqual(validateGraph(fixture.graph).findings, []);
  }
});

test("LG01a executed uses accepted L3 and M8 M9 with real committed runs and receipts", async t => {
  for (const variant of ["standard", "cross"] as const) {
    const fixture = variant === "cross" ? await createCrossOmFixture(t, "sprout", { mode: "executed" })
      : await createOmFixture(t, variant, "sprout", { mode: "executed" });
    assertCurrentStages(fixture);
    assertNativeAcceptance(fixture, 3);
    const m8 = fixture.store.get<OmFeasibility>("om-feasibility:sprout")!;
    assert.equal(m8.value.producer.contract, "om-m8/v2");
    assert.equal(m8.value.ready, true);
    const m9 = fixture.store.get<StageArtifact>("stage:sprout:om-g2")!;
    assert.equal(m9.value.status, "accepted");
    assert.deepEqual((m9.value.content as { feasibility: unknown }).feasibility, reference(m8));
    assert.equal(readHandoff(fixture.store, { project: fixture.project, record: reference(m9) }).ok, true);
    const compilation = fixture.store.get<StageArtifact>("stage:sprout:compilation")!;
    assert.equal(compilation.value.status, "accepted");
    assert.deepEqual((compilation.value.content as { plan: unknown }).plan, reference(fixture.plan));
    assert.equal(fixture.plan.value.feasibility.id, m8.id);
    assert.equal(fixture.engine.checks.omProject(fixture.project), true);
    assert.ok(fixture.plan.value.tasks.length > 0);
    assert.equal(fixture.runs.length, fixture.plan.value.tasks.length);
    assert.ok(fixture.runs.every(run => run.value.state === "committed"));
    for (const [artifactId, receipt] of Object.entries(fixture.receipts)) {
      const producer = fixture.graph.nodes.find(node => node.id === receipt.value.node)!;
      assert.deepEqual(receipt.value.plan, reference(fixture.plan));
      assert.ok(fixture.runs.some(run => canonical(reference(run)) === canonical(receipt.value.run)));
      assert.equal(receipt.value.signature, nodeSignature(fixture.graph, producer));
      assert.deepEqual(resolveArtifact(fixture.store, fixture.project, fixture.graph, fixture.repository, producer.id, artifactId),
        { receipt: reference(receipt), source: null });
    }
    const flow = fixture.graph.connectors.find(connector => connector.id === "sprout-flow")!;
    assert.equal(flow.bindings.filter(binding => binding.level === 3 && binding.anchor === null).length, variant === "cross" ? 2 : 1);
  }
});

test("LG01a missing and masquerading modes fail before creating a fixture", async t => {
  for (const options of [null, {}, { mode: null }, { mode: "unknown" }, 1, [], "", "must-never-load-this-era", "stages", "n2", "executed"]) {
    const invalid = (error: unknown) => error instanceof EngineError && error.code === OM_FIXTURE_ERROR
      && canonical(error.details) === canonical({ target: "/mode" });
    await assert.rejects(createOmFixture(t, "standard", "garden", options as never), invalid);
    await assert.rejects(createCrossOmFixture(t, "garden", options as never), invalid);
  }
});

// Q2.1: a check of a refusal names its code. The two helpers below are the only way the OM suites check one, so these
// tests pin what they accept and what they refuse to accept.
const probeAt = { unit: "T", target: "probe" };
const refusal = (code = "probe_code"): OmResult<never> => refused(code, "A probe refusal", probeAt, "producer");
const failsCheck = (action: () => unknown, message: RegExp, label = "the check"): void => {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError, `${label}: expected an AssertionError, received ${String(error)}`);
    assert.match(error.message, message, label);
    return true;
  });
};
const badExpectations: unknown[] = ["", [], [""], ["probe_code", ""], undefined, null, 7];

test("refusedWith accepts the named code or a code of the named list and returns the original refusal", () => {
  const result = refusal();
  if (result.ok) assert.fail("A probe refusal was built");
  assert.equal(refusedWith(result, "probe_code"), result.refusal);
  assert.equal(refusedWith(result, ["other_code", "probe_code"]), result.refusal);
  assert.equal(refusedWith(result, ["probe_code"]), result.refusal);
});

test("refusedWith fails on another code, a code outside the list, an unexpected success and a refusal without address or reason", () => {
  failsCheck(() => refusedWith(refusal(), "other_code"), /Expected other_code, received probe_code/);
  failsCheck(() => refusedWith(refusal(), ["first_code", "second_code"]), /Expected first_code \| second_code, received probe_code/);
  failsCheck(() => refusedWith(delivered(1), "probe_code"), /received success/);
  const refusalOf = (target: string, message: string) => ({ ok: false as const,
    refusal: { code: "probe_code", message, at: { unit: "T", target }, route: "producer" as const } });
  failsCheck(() => refusedWith(refusalOf("", "A probe refusal"), "probe_code"), /A refusal is addressed/);
  failsCheck(() => refusedWith(refusalOf("probe", ""), "probe_code"), /A refusal says why/);
});

test("refusedWith fails when the expected code is missing, empty or not a code, whatever the refusal says", () => {
  for (const bad of badExpectations) failsCheck(() => refusedWith(refusal(), bad as string), /names its expected code/);
  // A check without its second argument does not compile; at runtime it fails like any missing code.
  failsCheck(() => {
    // @ts-expect-error the code of a refusal check is required
    refusedWith(refusal());
  }, /names its expected code/);
});

test("thrownWith accepts the named code or a code of the named list and returns the thrown EngineError", () => {
  const thrown = new EngineError("probe_code", "A probe exception", { target: "probe" });
  assert.equal(thrownWith(() => { throw thrown; }, "probe_code"), thrown);
  assert.equal(thrownWith(() => { throw thrown; }, ["other_code", "probe_code"]), thrown);
});

test("thrownWith keeps the channels apart: a returned refusal, a plain return, another code and a foreign exception fail", () => {
  const throwing = (error: unknown) => () => { throw error; };
  failsCheck(() => thrownWith(() => refusal(), "probe_code"), /to be thrown, the call returned/);
  failsCheck(() => thrownWith(() => delivered(1), "probe_code"), /to be thrown, the call returned/);
  failsCheck(() => thrownWith(throwing(new EngineError("probe_code", "A probe exception")), "other_code"), /Expected other_code, received probe_code/);
  failsCheck(() => thrownWith(throwing(new EngineError("probe_code", "A probe exception")), ["first_code", "second_code"]),
    /Expected first_code \| second_code, received probe_code/);
  failsCheck(() => thrownWith(throwing(new TypeError("not an engine error")), "probe_code"), /Expected an EngineError probe_code/);
  // The helper's own failure is never taken for the expected exception: an AssertionError raised inside the call fails the check.
  failsCheck(() => thrownWith(() => assert.fail("raised inside the call"), "probe_code"), /Expected an EngineError probe_code/);
  for (const bad of badExpectations) failsCheck(() => thrownWith(throwing(new EngineError("probe_code", "A probe exception")), bad as string), /names its expected code/);
});

const soundRefusal = { code: "probe_code", message: "A probe refusal", at: probeAt, route: "producer" as const };
const asResult = (value: unknown): OmResult<unknown> => value as OmResult<unknown>;

test("refusedWith takes only the literal ok: false for a refusal: a missing, null, zero or otherwise falsy discriminator fails", () => {
  const legal = { ok: false as const, refusal: soundRefusal };
  assert.equal(refusedWith(legal, "probe_code"), soundRefusal);
  for (const [label, envelope] of [
    ["missing ok", { refusal: soundRefusal }], ["ok: null", { ok: null, refusal: soundRefusal }], ["ok: 0", { ok: 0, refusal: soundRefusal }],
    ["ok: undefined", { ok: undefined, refusal: soundRefusal }], ["ok: empty string", { ok: "", refusal: soundRefusal }],
    ["ok: NaN", { ok: Number.NaN, refusal: soundRefusal }], ["ok: the string false", { ok: "false", refusal: soundRefusal }],
    ["ok: 1", { ok: 1, refusal: soundRefusal }], ["ok: an object", { ok: {}, refusal: soundRefusal }],
  ] as const) failsCheck(() => refusedWith(asResult(envelope), "probe_code"), /received a result whose ok is/, label);
  // `true` is the unexpected success even when a refusal body rides along.
  failsCheck(() => refusedWith(asResult({ ok: true, refusal: soundRefusal }), "probe_code"), /received success/, "ok: true");
});

test("refusedWith fails, never throws a bare TypeError, on a negative result with a damaged refusal and on a value that is no result", () => {
  const body = (over: Record<string, unknown>) => ({ ok: false, refusal: { ...soundRefusal, ...over } });
  for (const [label, envelope, pattern] of [
    ["refusal missing", { ok: false }, /without a refusal/], ["refusal null", { ok: false, refusal: null }, /without a refusal/],
    ["refusal a string", { ok: false, refusal: "probe_code" }, /without a refusal/],
    ["code missing", body({ code: undefined }), /Expected probe_code, received undefined/], ["code a number", body({ code: 7 }), /Expected probe_code, received 7/],
    ["address missing", body({ at: undefined }), /A refusal is addressed/], ["address null", body({ at: null }), /A refusal is addressed/],
    ["target a number", body({ at: { unit: "T", target: 1 } }), /A refusal is addressed/], ["target an object", body({ at: { unit: "T", target: {} } }), /A refusal is addressed/],
    ["target true", body({ at: { unit: "T", target: true } }), /A refusal is addressed/],
    ["message a number", body({ message: 1 }), /A refusal says why/], ["message true", body({ message: true }), /A refusal says why/],
    ["message an object", body({ message: {} }), /A refusal says why/],
  ] as const) failsCheck(() => refusedWith(asResult(envelope), "probe_code"), pattern, label);
  for (const [label, nothing] of [["null", null], ["undefined", undefined], ["a string", "refusal"], ["a number", 7]] as const)
    failsCheck(() => refusedWith(asResult(nothing), "probe_code"), /Expected a refusal probe_code, received/, label);
});

test("thrownWith takes only a real EngineError with a string code: a lookalike, a foreign Error and a non-error value fail", () => {
  const throwing = (error: unknown) => () => { throw error; };
  for (const [label, thrown] of [
    ["a plain object with the code", { code: "probe_code", message: "A probe exception" }],
    ["an Error carrying the code", Object.assign(new Error("A probe exception"), { code: "probe_code" })],
    ["a string", "probe_code"], ["a number", 7], ["null", null], ["undefined", undefined], ["a null-prototype object", Object.create(null)],
  ] as const) failsCheck(() => thrownWith(throwing(thrown), "probe_code"), /Expected an EngineError probe_code/, label);
  // An EngineError whose code is not a string cannot match the named codes, whatever it coerces to.
  failsCheck(() => thrownWith(throwing(new EngineError(7 as unknown as string, "A probe exception")), "probe_code"), /Expected probe_code, received 7/, "a numeric code");
});

// The agreed refusal helpers may not let the code be omitted: no `?`, no default value, no `undefined` in its type and no
// rest list, on any helper that takes an OmResult, a `ReturnType<...>` result or an action function (`=>`). Plain `code?`
// fields of test data are none of this check's business; the scan covers the known helper files below, not every helper ever.
const REFUSAL_HELPER_FILES = ["om-fixture.ts", "om-fixture.test.ts", "om-series-current.test.ts", "om-queue.test.ts",
  "om-series-transition-prepared.test.ts", "om-stop-analysis.test.ts", "om-frame-accept.test.ts",
  "om-accepted-answer.test.ts", "om-addressing.test.ts", "om-assessment.test.ts", "om-deliveries.test.ts",
  "om-gap-lines.test.ts", "om-obligations.test.ts", "om-work-zone.test.ts", "om-works-frame.test.ts"];

function optionalCodeHelpers(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true);
  const found: string[] = [];
  const walk = (node: import("typescript").Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      const takesResult = node.parameters.some(parameter => parameter.type !== undefined && /\bOmResult\b|\bReturnType\s*<|=>/.test(parameter.type.getText(sf)));
      if (takesResult) for (const parameter of node.parameters) {
        if (!/code/i.test(parameter.name.getText(sf))) continue;
        const omittable = parameter.questionToken !== undefined || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined
          || (parameter.type !== undefined && /\bundefined\b/.test(parameter.type.getText(sf)));
        if (omittable) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${parameter.getText(sf)}`);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

test("the check against an omittable code sees every way to omit it and leaves other optional codes alone", () => {
  for (const [label, source] of [
    ["optional", "function rejected(result: OmResult<unknown>, code?: string) {}"],
    ["default", "const denied = (result: OmResult<unknown>, code = '') => {};"],
    ["undefined in the type", "function refusal(result: OmResult<unknown>, code: string | undefined) {}"],
    ["rest list", "function failed(result: OmResult<unknown>, ...codes: string[]) {}"],
    ["optional list", "function refusedAs(value: OmResult<T>, expectedCodes?: readonly string[]) {}"],
    ["ReturnType result", "function unchangedRefusal(value: ReturnType<typeof merge>, before: unknown[], code?: string) {}"],
    ["action function", "function rejected(action: () => OmResult<unknown>, code?: string) {}"],
  ] as const) assert.equal(optionalCodeHelpers("probe.ts", source).length, 1, label);
  assert.deepEqual(optionalCodeHelpers("probe.ts", [
    "function refusedWith(result: OmResult<unknown>, code: string | readonly string[]) {}",
    "function carried(result: ReturnType<typeof build>, code: string) {}",
    "function named(fn: () => void, label?: string) {}",
    "function other(value: unknown, code?: string) {}",
    "interface Row { code?: string }",
    "const row: { code?: string } = {};"].join("\n")), []);
});

test("no refusal helper of the Q2.1 and Q2.2 suites lets the expected code be omitted", () => {
  const offenders = REFUSAL_HELPER_FILES.flatMap(file =>
    optionalCodeHelpers(file, readFileSync(new URL(`../../test/${file}`, import.meta.url), "utf8")));
  assert.deepEqual(offenders, []);
});
