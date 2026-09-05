import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import type { Graph } from "../src/graph/model.js";
import type { Question, DiscoveryDraft } from "../src/discovery/discovery.js";
import { reference } from "../src/pipeline/contracts.js";
import { validateGraph } from "../src/graph/validate.js";
import { buildL1, designOf } from "../src/graph/builder.js";
import { deriveTasks } from "../src/compiler/derive.js";
import { nodeSignature } from "../src/compiler/model.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { preparedField, preparationValue } from "./preparation-fixture.js";
import type { Json } from "../src/canonical.js";
import { deferredGap } from "../src/graph/research-contracts.js";

function mapInput(engine: ProductEngine, project: string, graph: Graph) {
  engine.execute({ type: "create-project", project, title: project });
  const source = engine.discovery.evidence.document(project, "brief", `Create ${project} as a validated local transformation.`, "text/plain", 0);
  let current!: Revision<DiscoveryDraft>;
  for (const stage of ["discovery", "concept", "operation-map"] as const) {
    current = engine.prepare(project, stage);
    for (const id of current.value.questions) {
      const question = engine.store.get<Question>(id)!;
      if (question.value.spec.kind === "fact") engine.discovery.fact(id, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
      else engine.discovery.decision(id, 1, "owner", question.value.spec.field === "mapDesign" ? designOf(graph) as unknown as Json : preparedField(project, question.value.spec.field));
    }
    if (stage !== "operation-map") {
      const artifact = engine.draft(project, stage, current.id, 0); engine.pipeline.accept(project, stage, artifact.revision);
    }
  }
  return current;
}

test("build-map materializes researched branching topology and inherited meaning for two products", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-map-design-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  for (const project of ["garden", "invoice"]) {
    const template = enrichedGraph(exampleGraph(project), project);
    const draft = mapInput(engine, project, template);
    assert.equal(store.get(`graph:${project}`), null, "No manually stored graph is needed before construction");
    const graph = engine.execute({ type: "build-map", project, draftId: draft.id, expected: 0 }) as Revision<Graph>;
    assert.equal(graph.value.version, 2);
    assert.equal(graph.value.contracts.some(contract => contract.id === "change-manifest"), false);
    assert.ok(graph.value.edges!.some(edge => edge.relation === "on_failure"));
    assert.ok(graph.value.journeys!.some(journey => journey.terminal === "safe_failure"));
    assert.ok(graph.value.nodes.every(node => ["product", "block"].includes(node.kind) && node.code.length === 0));
    assert.deepEqual(engine.execute({ type: "build-map", project, draftId: draft.id, expected: graph.revision }), graph);
    const artifact = engine.draft(project, "operation-map", draft.id, 0); engine.pipeline.accept(project, "operation-map", artifact.revision);
    const history = store.get(graph.id, graph.revision);
    const edited = structuredClone(graph.value); edited.edges![0]!.condition = "Reject every input";
    engine.graphs.save(project, edited, graph.revision, "owner");
    assert.ok(engine.graphs.gate(project).findings.some(finding => finding.code === "graph_layer_unproven"));
    assert.deepEqual(store.get(graph.id, graph.revision), history);
  }
});

test("enriched graph refuses missing semantics, disconnected failure paths and unrelated product entrypoints", () => {
  const base = enrichedGraph(exampleGraph("p"), "p"); assert.deepEqual(validateGraph(base).findings, []);
  const noBenefit = structuredClone(base); delete noBenefit.nodes[1]!.benefit;
  assert.ok(validateGraph(noBenefit).findings.some(item => item.code === "graph_shape"));
  const noFailure = structuredClone(base); noFailure.edges = [];
  assert.ok(validateGraph(noFailure).findings.some(item => item.code === "journey_disconnected"));
  const wrongTest = structuredClone(base); wrongTest.tests[0]!.contract!.entrypoint.path = "unrelated.ts";
  assert.ok(validateGraph(wrongTest).findings.some(item => item.code === "test_entrypoint_unbound"));
  const rootJourney = structuredClone(base); rootJourney.journeys![0]!.entry = rootJourney.nodes[0]!.id; rootJourney.journeys![0]!.path = [rootJourney.nodes[0]!.id];
  assert.ok(validateGraph(rootJourney).findings.some(item => item.code === "journey_abstract_entry"));
  const falseEndpoint = structuredClone(base); falseEndpoint.connectors[0]!.bindings[2]!.producer.codeRef!.path = "unrelated.ts";
  assert.ok(validateGraph(falseEndpoint).findings.some(item => item.code === "endpoint_code_foreign"));
});

test("required-work edges join artifact dependencies and a work packet does not become a separate task", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  graph.edges!.push({ id: "explicit-prerequisite", relation: "requires", source: "p-consume-work", target: "p-produce-work", condition: "Consume only the producer's accepted result" });
  graph.packets!.push({ id: "implementation-slice", unit: "p-produce-work", purpose: "Write the producer implementation", writePaths: ["produce.txt"] });
  assert.deepEqual(validateGraph(graph).findings, []);
  const plan = deriveTasks("p", "graph-hash", graph, () => { throw new Error("No external input expected"); });
  assert.equal(plan.tasks.length, 2); assert.equal(plan.tasks[0]!.packets?.length, 1);
  assert.equal(plan.tasks[1]!.inputs.some(input => input.connector === "explicit-prerequisite"), true);
  assert.equal(plan.tasks[1]!.requirements?.[0]?.id, "p-R1");
  graph.edges!.push({ id: "reverse-prerequisite", relation: "requires", source: "p-produce-work", target: "p-consume-work", condition: "Contradictory cycle" });
  assert.ok(validateGraph(graph).findings.some(item => item.code === "control_dependency_cycle"));
});

test("write ownership requires an explicit transfer and cannot fork to two simultaneous writers", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  graph.nodes.find(node => node.id === "p-consume-work")!.code[0]!.path = "produce.txt";
  graph.connectors[0]!.bindings[2]!.consumers[0]!.codeRef!.path = "produce.txt";
  graph.tests.find(test => test.node === "p-consume-work")!.contract!.entrypoint.path = "produce.txt";
  assert.ok(validateGraph(graph).findings.some(item => item.code === "ownership_transfer_missing"));
  graph.transfers!.push({ id: "handoff", path: "produce.txt", from: "p-produce-work", to: "p-consume-work", condition: "producer_committed" });
  assert.deepEqual(validateGraph(graph).findings, []);
  graph.transfers!.push({ id: "second-handoff", path: "produce.txt", from: "p-produce-work", to: "p-consume-work", condition: "producer_committed" });
  assert.ok(validateGraph(graph).findings.some(item => item.code === "ownership_transfer_missing"));
});

test("changed requirement or control meaning invalidates a prior node signature", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p"); const node = graph.nodes.find(node => node.id === "p-produce-work")!;
  const original = nodeSignature(graph, node);
  graph.requirements![0]!.statement = "A newly required behavior";
  assert.notEqual(nodeSignature(graph, node), original);
  const changed = nodeSignature(graph, node); graph.edges![0]!.condition = "Another failure condition";
  assert.notEqual(nodeSignature(graph, node), changed);
});

test("stable connector IDs cannot silently acquire a different artifact contract", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-map-continuity-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); const graph = enrichedGraph(exampleGraph("p"), "p");
  engine.graphs.save("p", graph, 0, "owner");
  const changed = structuredClone(graph); changed.contracts[0]!.schema = { type: "number" };
  assert.throws(() => engine.graphs.save("p", changed, 1, "owner"), /connector_identity_fork/);
});

test("a terminal producer cannot change recipient by selecting another outcome's requirement", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  graph.actors!.push({ id: "admin", role: "Operator", channels: ["CLI"] });
  graph.requirements!.push({ id: "admin-requirement", section: "admin-section", outcome: "p-refusal", beneficiary: "admin", statement: "Inspect rejected operations" });
  for (const refusal of graph.nodes.filter(node => node.outcome === "p-refusal")) {
    refusal.beneficiary = "admin"; refusal.implements = ["admin-requirement"];
  }
  const refusal = graph.nodes.find(node => node.id === "p-refusal-block")!;
  graph.journeys!.push({ id: "admin-journey", actor: "admin", variant: "operator_admin", entry: refusal.id, path: [refusal.id], outcome: "p-refusal", terminal: "safe_failure" });
  assert.deepEqual(validateGraph(graph).findings, []);
  const output = graph.nodes.find(node => node.id === "p-consume-block")!;
  output.beneficiary = "admin"; output.implements = ["admin-requirement"];
  assert.ok(validateGraph(graph).findings.some(item => item.code === "node_beneficiary_foreign" && item.target === output.id));
});

test("a safe refusal cannot stand in for the accepted success journey", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  const success = graph.journeys!.find(journey => journey.variant === "success")!;
  success.terminal = "safe_failure"; success.outcome = "p-refusal"; success.path = ["p-produce-block", "p-refusal-block"];
  assert.deepEqual(validateGraph(graph).findings, [], "The raw topology is valid; accepted scenario coverage is the builder's obligation");
  assert.throws(() => buildL1("p-map", "p", designOf(graph), { preparation: preparationValue("p") },
    { conceptSections: preparedField("p", "conceptSections") }), /Missing success journey/);
});

test("an atomic unit can realize another role only with matching responsibility boundaries", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  graph.edges!.push({ id: "shared-realization", relation: "realizes", source: "p-produce-work", target: "p-consume-operation", condition: "One implementation supplies both roles" });
  assert.deepEqual(validateGraph(graph).findings, []);
  const target = graph.nodes.find(node => node.id === "p-consume-operation")!;
  target.boundary = { ...target.boundary, writer: "another-writer" };
  assert.ok(validateGraph(graph).findings.some(item => item.code === "realization_boundary_conflict"));
});

test("an active unit makes the gaps of its explicitly realized role current", () => {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  const future = structuredClone(graph.nodes.find(node => node.id === "p-consume-work")!);
  future.id = "future-consumer"; future.code = [{ path: "future.txt", access: "write", status: "planned" }]; future.tests = [];
  graph.nodes.push(future); graph.horizon = ["p-consume-work"];
  const binding = graph.connectors[0]!.bindings[2]!;
  binding.consumers = [{ node: future.id, port: "in", codeRef: future.code[0]! }]; binding.anchor = "future-anchor";
  graph.connectors[0]!.wakeTest = graph.tests[0]!.id;
  graph.anchors.push({ id: "future-anchor", owner: "p-produce-operation", outcome: "p-data", test: graph.tests[0]!.id });
  graph.edges!.push({ id: "realized-producer", relation: "realizes", source: "p-consume-work", target: "p-produce-operation", condition: "Implement the producer role in the active unit" });
  assert.deepEqual(validateGraph(graph).findings, []);
  const gap = { id: "producer-contract", target: "p-produce-operation", field: "ports", consumer: future.id,
    question: "Which producer contract is required?", requiredFor: "next" as const };
  assert.equal(deferredGap(graph, gap), false);
  graph.edges = graph.edges!.filter(edge => edge.id !== "realized-producer");
  assert.equal(deferredGap(graph, gap), true, "Without realization the producer role is outside the active unit");
});
