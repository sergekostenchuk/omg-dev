import test from "node:test";
import assert from "node:assert/strict";
import { executionFixture } from "./execution-fixture.js";
import { reference } from "../src/pipeline/contracts.js";
import { receiptId, type ArtifactReceipt } from "../src/compiler/model.js";
import { Owners } from "../src/ownership/owners.js";
import { currentBasis } from "../src/execution/basis.js";
import type { ExecutionRoot } from "../src/runtime/environment.js";
import { deriveTasks } from "../src/compiler/derive.js";
import { writeGrants } from "../src/compiler/ownership.js";
import { hashJson } from "../src/canonical.js";
import { requireGraph, validateGraph } from "../src/graph/validate.js";
import { exampleGraph } from "./graph-fixture.js";
import { projectGraph } from "../src/graph/project.js";
import { preparedField } from "./preparation-fixture.js";
import { acceptNativeWorks } from "./om-fixture.js";
import { writeHorizon } from "../src/om/horizon.js";
import { prepareFrame, type FrameRequest } from "../src/om/frame-obligations.js";
import type { LayerProposal } from "../src/om/frame-proposals.js";
import type { OmResult } from "../src/om/refusal.js";
import type { Node, Graph } from "../src/graph/model.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";

const take = <T>(result: OmResult<T>): T => { assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.refusal)); return result.value; };

test("native accepted writers authorize exact transfers and retain their artifact heads across restart", async t => {
  const f = executionFixture(t, "normal", { route: "om", valueFor(field) {
    const value = preparedField("p", field);
    const upgrade = <T>(item: T): T => JSON.parse(JSON.stringify(item).replaceAll("p-result", "p-upgraded-result")
      .replaceAll("p-R1", "p-R2").replaceAll("p-B1", "p-B2").replaceAll("Deliver result", "Upgrade accepted output"));
    if (field === "preparation") {
      const preparation = value as { outcomes: unknown[] }; preparation.outcomes.push(upgrade(preparation.outcomes[0]));
    } else if (field === "conceptSections") {
      const sections = value as { requirements: unknown[] }[]; sections[0]!.requirements.push(upgrade(sections[0]!.requirements[0]));
    } else if (field === "operationRequirements") {
      const model = value as { outcomes: unknown[]; conceptCoverage: unknown[] };
      model.outcomes.push(upgrade(model.outcomes[0])); model.conceptCoverage.push(upgrade(model.conceptCoverage[0]));
    } else if (field === "features") (value as unknown[]).push({ title: "Upgrade accepted output", outcome: "p-upgraded-result", requirements: [0] });
    else if (field === "featurePreparation" || field === "behaviorContracts") (value as unknown[]).push(upgrade((value as unknown[])[0]));
    return value;
  }, native: { addresses: [
    { target: "p-B2", field: "nodes", value: ["p-upgrade-produce-block", "p-upgrade-consume-block"] },
    { target: "p-B2", field: "state", value: { writer: "p-upgrade-produce-block", authority: "p-upgrade-consume-block", rollback: "p-upgrade-consume-block" } },
    { target: "p-R2#1", field: "checkKind", value: "test" },
  ] }, graph(graph) {
    graph.requirements!.push({ ...structuredClone(graph.requirements![0]!), id: "p-R2", outcome: "p-upgraded-result" });
    graph.artifacts.push({ ...structuredClone(graph.artifacts.find(item => item.id === "p-result")!), id: "p-upgraded-result" });
    for (const name of ["produce", "consume"]) {
      const block = structuredClone(graph.nodes.find(node => node.id === `p-${name}-block`)!);
      block.id = `p-upgrade-${name}-block`; block.title = `Upgrade ${name}`; block.ports = []; block.implements = ["p-R2"];
      if (name === "consume") block.outcome = "p-upgraded-result";
      graph.nodes.push(block);
      const operation = structuredClone(graph.nodes.find(node => node.id === `p-${name}-operation`)!);
      operation.id = `p-upgrade-${name}-operation`; operation.parent = block.id; operation.ports = []; operation.implements = ["p-R2"];
      operation.outcome = block.outcome; graph.nodes.push(operation);
    }
    graph.edges!.push({ id: "upgrade-baseline", relation: "requires", source: "p-upgrade-produce-block", target: "p-produce-block",
      condition: "Upgrade uses the already committed baseline" });
    graph.edges!.push({ id: "upgrade-order", relation: "requires", source: "p-upgrade-consume-block", target: "p-upgrade-produce-block",
      condition: "Consume the upgraded output" });
    graph.edges!.push({ id: "upgrade-success", relation: "on_success", source: "p-upgrade-produce-block", target: "p-upgrade-consume-block",
      condition: "The new producer delivered its checked output" });
    const journey = structuredClone(graph.journeys!.find(item => item.terminal === "success")!);
    graph.journeys!.push({ ...journey, id: "p-upgrade-journey", entry: "p-upgrade-produce-block",
      path: ["p-upgrade-produce-block", "p-upgrade-consume-block"], outcome: "p-upgraded-result" });
    const { level: _level, ...upper } = projectGraph(graph, 1);
    assert.deepEqual(validateGraph(upper as Graph).findings, []);
  } });
  const original = await f.engine.executor.run("p", reference(f.plan), f.options);
  const oldData = f.store.get<ArtifactReceipt>(receiptId("p", "p-data"))!;
  const graph = structuredClone(f.plan.value.graphSnapshot);
  const successors = ["produce", "consume"].map(name => {
    const old = graph.nodes.find(node => node.id === `p-${name}-work`)!;
    const node = structuredClone(old); node.id = `p-upgrade-${name}`; node.parent = `p-upgrade-${name}-operation`; node.implements = ["p-R2"];
    if (name === "consume") node.outcome = "p-upgraded-result";
    node.ports = [];
    node.title = name === "produce" ? "Upgrade producer safety" : "Upgrade consumer safety";
    node.code = node.code.map(ref => ({ ...ref, status: "existing" }));
    const check = structuredClone(graph.tests.find(test => test.node === old.id)!);
    check.id = `${node.id}-test`; check.node = node.id; check.contract!.entrypoint.status = "existing";
    check.covers = []; check.contract!.counterfactuals = [];
    check.command = { executable: process.execPath, args: ["check.mjs", `overflow-${name}`] };
    node.tests = [check.id]; graph.nodes.push(node); graph.tests.push(check);
    graph.transfers!.push({ id: `transfer-${name}`, path: node.code[0]!.path, from: old.id, to: node.id, condition: "producer_committed" });
    return node;
  });
  // The original works stay outside this new horizon; their exact artifacts and writer receipts remain inputs.
  const store = f.store, available = { "p-produce-block": { "p-data": reference(oldData) } };
  const proposal = (request: FrameRequest, nodes: Node[]): LayerProposal => {
    const frame = take(prepareFrame(store, request));
    const fills = frame.result.obligations.filter(item => item.zone === "horizon").map(item => {
      const node = nodes.find(node => node.parent === item.upper.node)!; assert.ok(node, item.upper.node);
      return { obligation: item.id, node: node.id, ...(item.kind === "connection-end" ? { port: item.upper.port!,
        codeRef: node.code[0]! } : {}) };
    });
    return { base: { graph: request.graph, frame: request.frame }, level: 3, worksContract: "works-frame/v1", source: "decision", status: "proposed", nodes, fills,
      localConnectors: [], artifacts: [], contracts: [], joins: [], journeys: [], packets: [], anchors: [],
      tests: graph.tests.filter(proof => nodes.some(node => node.id === proof.node)),
      transfers: graph.transfers!.filter(transfer => nodes.some(node => node.id === transfer.to)),
      edges: [{ id: "use-previous-data", relation: "requires", source: "p-upgrade-produce", target: "p-produce-work",
        condition: "Consume the exact committed baseline before replacing its artifact" },
        { id: "upgrade-work-order", relation: "requires", source: "p-upgrade-consume", target: "p-upgrade-produce", condition: "Use the upgraded producer" }],
      removes: [], replaces: [], redefines: [] };
  };
  const accepted = { graph: store.get<Graph>("graph:p")!, layer: store.get("graph-layer:p:2")!, frame: store.get("om-frame:p:2")! };
  const graphRef = reference(accepted.graph);
  const horizon3 = take(writeHorizon(store, { project: "p", input: reference(store.get("om-input:p")!), graph: graphRef,
    refinement: reference(accepted.layer), available, choice: { choiceVersion: "upgrade-works", features: [{ outcome: "p-upgraded-result" }], excluded: [] } }));
  const frame3: FrameRequest = { project: "p", level: 3, graph: graphRef, horizon: reference(horizon3.gate),
    layer: reference(store.get("graph-layer:p:3")!), frame: reference(store.get("om-frame:p:3")!),
    upper: { frame: reference(accepted.frame), horizon: reference(horizon3.gate) } };
  const p3 = store.write({ id: "om-proposal:p:upgrade-works", kind: "layer-proposal", expected: 0, value: proposal(frame3, successors) });
  acceptNativeWorks(f.engine, "p", { frame: { project: "p", level: 2, upper: null, graph: graphRef, horizon: frame3.horizon,
    layer: reference(accepted.layer), frame: reference(accepted.frame) }, proposals: [] }, { frame: frame3, proposals: [reference(p3)] });
  const plan = f.engine.compiler.compile("p");
  const compiled = f.engine.compiler.publish("p", reference(plan), store.get("stage:p:compilation")!.revision);
  f.engine.pipeline.accept("p", "compilation", compiled.revision);
  assert.deepEqual(plan.value.tasks.map(task => task.ownership![0]!.receipt), original.map(reference));
  assert.deepEqual(plan.value.tasks[0]!.inputs.find(input => input.receipt?.id === oldData.id)!.receipt, reference(oldData));
  assert.deepEqual(plan.value.guards.find(ref => ref.id === oldData.id), reference(oldData));
  assert.ok(plan.value.tasks.every(task => task.inputs.every(input => !input.connector.startsWith("transfer-"))));
  const results = await f.engine.executor.run("p", reference(plan), f.options);
  assert.deepEqual(results.map(run => run.value.state), ["committed", "committed"], JSON.stringify(results.map(run => run.value.error)));
  const currentData = store.get<ArtifactReceipt>(oldData.id)!;
  assert.notEqual(currentData.hash, oldData.hash); assert.equal(currentData.value.node, successors[0]!.id);
  assert.equal(store.get(oldData.id, oldData.revision)!.hash, oldData.hash);
  assert.deepEqual(results[0]!.value.inputs.find(input => input.id === oldData.id), reference(oldData));
  const root = store.get<ExecutionRoot>("execution-root:p")!.value;
  assert.equal(new Owners(store, "p", { root: root.path, head: root.head }).latest("produce.mjs")!.node, successors[0]!.id);
  currentBasis(store, plan, root);
  const calls = f.calls().length;
  f.reopen(); await f.engine.executor.run("p", reference(plan), f.options);
  assert.equal(f.calls().length, calls);
  assert.deepEqual(f.engine.compiler.read(plan.id), plan);
  f.store.write({ id: currentData.id, kind: currentData.kind, expected: currentData.revision, value: { ...currentData.value, plan: reference(f.plan) } });
  assert.throws(() => currentBasis(f.store, plan, root), { code: "plan_stale", message: `A sealed plan input changed: ${oldData.id}` });
  const otherArtifact = f.store.get<ArtifactReceipt>(receiptId("p", "p-upgraded-result"))!;
  f.store.write({ id: currentData.id, kind: currentData.kind, expected: currentData.revision + 1, value: otherArtifact.value });
  assert.throws(() => currentBasis(f.store, plan, root), { code: "plan_stale", message: `A sealed plan input changed: ${oldData.id}` }, "A valid result cannot masquerade under another artifact head");

});

test("write ownership needs the actual accepted predecessor and cannot be stolen by dropping the old node", async t => {
  const f = executionFixture(t, "normal", { route: "om" }); const runs = await f.engine.executor.run("p", reference(f.plan), f.options);
  const root = f.store.get<ExecutionRoot>("execution-root:p")!.value;
  const owners = new Owners(f.store, "p", { root: root.path, head: root.head });
  const graph = structuredClone(f.plan.value.graphSnapshot);
  const old = graph.nodes.find(node => node.id === "p-produce-work")!;
  const next = { ...structuredClone(old), id: "new-writer" };
  graph.nodes.push(next); graph.transfers!.push({ id: "handoff", from: old.id, to: next.id, path: "produce.mjs", condition: "producer_committed" });
  assert.equal(writeGrants(graph, next, new Map([[next.id, "next"]]), path => owners.latest(path))[0]!.receipt!.hash, runs[0]!.hash);
  graph.transfers = []; graph.nodes = graph.nodes.filter(node => node.id !== old.id);
  assert.throws(() => writeGrants(graph, next, new Map([[next.id, "next"]]), path => owners.latest(path)), /explicit transfer/);
  const accepted = runs[0]!;
  f.store.write({ id: accepted.id, kind: accepted.kind, expected: accepted.revision, value: { ...accepted.value, checks: [] } });
  assert.throws(() => new Owners(f.store, "p", { root: root.path, head: root.head }).latest("produce.mjs"), /configured check set/);
});

test("the version-one compiler retains its original transfer representation", () => {
  const source = exampleGraph("p");
  source.nodes.find(node => node.id === "p-consume-work")!.code[0]!.path = "produce.txt";
  const graph = enrichedGraph(source, "p");
  graph.transfers!.push({ id: "transfer", path: "produce.txt", from: "p-produce-work", to: "p-consume-work", condition: "producer_committed" });
  requireGraph(graph);
  const old = deriveTasks("p", hashJson(graph), graph, () => ({ receipt: null, source: null }));
  assert.equal(old.tasks[0]!.ownership, undefined); assert.ok(old.tasks[1]!.inputs.some(input => input.connector === "transfer"));
  const current = deriveTasks("p", hashJson(graph), graph, () => ({ receipt: null, source: null }), { version: 2, owner: () => null });
  assert.equal(current.tasks[1]!.inputs.length, 1); assert.equal(current.tasks[1]!.ownership![0]!.producerTask, current.tasks[0]!.id);
});
