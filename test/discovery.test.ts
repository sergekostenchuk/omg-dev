import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Discovery } from "../src/discovery/discovery.js";
import { reference, STAGES, type StageValidators, type StageValidator } from "../src/pipeline/contracts.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { EngineError } from "../src/errors.js";
import type { Json } from "../src/canonical.js";
import { exampleGraph } from "./graph-fixture.js";
import { GraphRepository } from "../src/graph/repository.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-discovery-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, discovery: new Discovery(store) };
}

test("facts require actual versioned source bytes; owner choices cannot masquerade as facts", t => {
  const { discovery, store } = fixture(t);
  const draft = discovery.create("garden", "discovery", "R0", "concept", [
    { field: "goal", kind: "decision", prompt: "What should the product achieve?", risk: "wrong goal", schema: { type: "string" } },
    { field: "count", kind: "fact", prompt: "How many beds are recorded?", risk: "invented count", schema: { type: "integer" } },
  ]);
  const [goal, count] = draft.value.questions;
  assert.throws(() => discovery.decision(count!, 1, "owner", 8), code("fact_requires_evidence"));
  assert.throws(() => discovery.fact(count!, 1, { id: "invented", revision: 1, hash: "0".repeat(64) }, { kind: "json-pointer", pointer: "/beds" }), code("source_missing"));
  assert.equal(store.get(count!)!.revision, 1);
  discovery.decision(goal!, 1, "owner", "Manage a garden");
  const source = discovery.evidence.document("garden", "inventory", '{"beds":8}', "application/json", 0);
  const current = discovery.fact(count!, 1, reference(source), { kind: "json-pointer", pointer: "/beds" });
  assert.deepEqual(current.value.fields, { count: 8, goal: "Manage a garden" });
  assert.deepEqual(discovery.gate("garden", reference(current)).findings, []);
  discovery.evidence.document("garden", "inventory", '{"beds":12}', "application/json", 1);
  assert.ok(discovery.gate("garden", reference(current)).findings.some(f => f.code === "evidence_stale"));
  assert.deepEqual(store.get(source.id, 1), source);
});

test("one connected SQLite→discovery→stage path becomes stale when its evidence changes", t => {
  const { discovery, store } = fixture(t);
  const initial = discovery.create("invoice", "discovery", "R1", "concept", [
    { field: "currency", kind: "fact", prompt: "Which currency is configured?", risk: "wrong currency", schema: { type: "string" } },
  ]);
  const source = discovery.evidence.document("invoice", "config", '{"currency":"EUR"}', "application/json", 0);
  const answered = discovery.fact(initial.value.questions[0]!, 1, reference(source), { kind: "json-pointer", pointer: "/currency" });
  const validate: StageValidator = ({ projectId, content }) => discovery.gate(projectId, content as unknown as ReturnType<typeof reference>);
  const validators = Object.fromEntries(STAGES.map(stage => [stage, validate])) as unknown as StageValidators;
  const pipeline = new Pipeline(store, validators);
  const artifact = pipeline.draft("invoice", "discovery", reference(answered) as unknown as Json, 0);
  pipeline.accept("invoice", "discovery", artifact.revision);
  const concept = pipeline.draft("invoice", "concept", reference(answered) as unknown as Json, 0);
  pipeline.accept("invoice", "concept", concept.revision);
  assert.equal(pipeline.inspect("invoice", "concept").state, "accepted");
  discovery.evidence.document("invoice", "config", '{"currency":"USD"}', "application/json", 1);
  assert.equal(pipeline.inspect("invoice", "discovery").state, "stale");
  assert.equal(pipeline.inspect("invoice", "concept").state, "stale");
});

test("research remains unresolved without evidence; reissue retains old answers and scopes levels", t => {
  const { discovery, store } = fixture(t);
  for (const level of ["R0", "R1", "R2", "R3"] as const) {
    const draft = discovery.create("product", "om-g2", level, "compilation", [{ field: "title", kind: "decision", prompt: "Choose title", risk: "wrong target", schema: { type: "string" } }]);
    const id = draft.value.questions[0]!;
    discovery.unresolved(id, 1);
    assert.ok(discovery.gate("product", reference(draft)).findings.length);
    const answered = discovery.decision(id, 2, "owner", `${level} first`);
    const oldAnswer = store.get(id)!;
    const reopened = discovery.reopen(id, 3);
    const changed = discovery.decision(id, reopened.revision, "owner", `${level} revised`);
    assert.equal(changed.value.level, level); assert.equal(changed.value.fields['title'], `${level} revised`);
    assert.deepEqual(store.get(id, 3), oldAnswer);
    assert.equal(store.get(answered.id, answered.revision)!.value !== null, true);
  }
});

test("discovery updates the same graph node in SQLite and its source change invalidates the new graph", t => {
  const { discovery, store } = fixture(t); const graphs = new GraphRepository(store, discovery);
  const initial = graphs.save("garden", exampleGraph(), 0, "owner");
  const originalL1 = store.get("graph-layer:garden:1")!;
  const draft = discovery.create("garden", "om-g2", "R2", "garden-produce-work", [
    { field: "title", kind: "fact", prompt: "Read the operation name from the source", risk: "unbound source", schema: { type: "string" } },
  ]);
  assert.throws(() => graphs.refine("garden", 1, reference(draft), "owner"), code("research_unresolved"));
  const source = discovery.evidence.document("garden", "operations", '{"title":"Prepare beds"}', "application/json", 0);
  const answered = discovery.fact(draft.value.questions[0]!, 1, reference(source), { kind: "json-pointer", pointer: "/title" });
  const refined = graphs.refine("garden", 1, reference(answered), "owner");
  assert.equal(refined.value.nodes.find(node => node.id === "garden-produce-work")!.title, "Prepare beds");
  assert.deepEqual(store.get(initial.id, initial.revision), initial);
  assert.deepEqual(store.get(originalL1.id), originalL1);
  assert.deepEqual(graphs.layerGate("garden", 1, reference(originalL1)).findings, []);
  assert.deepEqual(graphs.gate("garden").findings, []);
  discovery.evidence.document("garden", "operations", '{"title":"Prepare new beds"}', "application/json", 1);
  assert.ok(graphs.gate("garden").findings.some(f => f.code === "graph_evidence_stale"));
  graphs.save("garden", refined.value, refined.revision, "owner");
  assert.ok(graphs.gate("garden").findings.some(f => f.code === "graph_evidence_stale"));
});

test("two stale graph fields can be corrected one at a time without erasing the other obligation", t => {
  const { discovery, store } = fixture(t);
  const graphs = new GraphRepository(store, discovery); graphs.save("garden", exampleGraph(), 0, "owner");
  let source = discovery.evidence.document("garden", "names", '{"produce":"Prepare beds","consume":"Plant beds"}', "application/json", 0);
  let revision = 1;
  const refine = (name: "produce" | "consume") => {
    const draft = discovery.create("garden", "om-g2", "R2", `garden-${name}-work`, [
      { field: "title", kind: "fact", prompt: "Read operation title", risk: "wrong title", schema: { type: "string" } },
    ]);
    const answered = discovery.fact(draft.value.questions[0]!, 1, reference(source), { kind: "json-pointer", pointer: `/${name}` });
    revision = graphs.refine("garden", revision, reference(answered), "owner").revision;
  };
  refine("produce"); refine("consume");
  source = discovery.evidence.document("garden", "names", '{"produce":"Prepare new beds","consume":"Plant new beds"}', "application/json", 1);
  refine("produce");
  assert.ok(graphs.gate("garden").findings.some(f => f.code === "graph_evidence_stale"));
  refine("consume");
  assert.deepEqual(graphs.gate("garden").findings, []);
  const graph = store.get<ReturnType<typeof exampleGraph>>("graph:garden")!;
  graph.value.nodes.find(node => node.id === "garden-produce-work")!.title = "Unproven edit";
  graphs.save("garden", graph.value, graph.revision, "owner");
  assert.ok(graphs.gate("garden").findings.some(f => f.code === "graph_field_unproven"));
});

test("missing research and selector fields produce typed refusal", t => {
  const { discovery, store } = fixture(t);
  const source = discovery.evidence.document("p", "source", '{"value":"x"}', "application/json", 0);
  assert.throws(() => discovery.evidence.observe("p", reference(source), { kind: "json-pointer" } as never), code("selector_invalid"));
  assert.throws(() => discovery.create("p", "concept", "R0", "concept", undefined as never), code("question_unbound"));
  assert.throws(() => discovery.create("p", "concept", "R0", "concept", [{ field: "title", kind: "decision", schema: {} } as never]), code("question_invalid"));
  assert.throws(() => new GraphRepository(store, discovery).save("p", exampleGraph(), 0, undefined as never), code("actor_missing"));
});
