import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { git } from "../src/runtime/environment.js";
import { reference } from "../src/pipeline/contracts.js";
import { canonical, digest, hashJson } from "../src/canonical.js";
import { taskContext, boundedContext, selectDetail, type ContextText } from "../src/compiler/context.js";
import type { MachinePlan } from "../src/compiler/model.js";
import { deriveTasks } from "../src/compiler/derive.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { prepareOmFixtureStages, prepareNativeLayers } from "./om-fixture.js";

const FULL_CHECK = { executable: "npm", args: ["run", "check"] };

function packetPlan(): Revision<MachinePlan> {
  const graph = enrichedGraph(exampleGraph("p"), "p");
  const tasks = deriveTasks("p", hashJson(graph), graph, () => { throw new Error("Unexpected external input"); }).tasks;
  const ref = { id: "fixture", revision: 1, hash: "0".repeat(64) };
  const body: MachinePlan = { version: 1, projectId: "p", graph: ref, environment: ref, stage: ref, feasibility: ref, guards: [],
    base: { root: "/fixture", head: "a".repeat(40), tree: "b".repeat(40), files: [] }, tasks, graphSnapshot: graph, hash: "fixture" };
  return { id: "plan:p:fixture", kind: "plan", revision: 1, hash: hashJson(body), value: body, createdAt: 0 } as Revision<MachinePlan>;
}

test("the implementation context contains exact task criteria and schemas without growing with unrelated map data", () => {
  const plan = packetPlan(), task = plan.value.tasks[0]!;
  const before = taskContext(plan, FULL_CHECK, task.id, 100_000);
  const content = JSON.parse(before.text);
  assert.deepEqual(content.scope.boundary, task.boundary);
  assert.deepEqual(content.scope.code, plan.value.graphSnapshot.nodes.find(node => node.id === task.node)!.code);
  assert.deepEqual(content.criteria.tests, task.tests);
  assert.deepEqual(content.criteria.fullCheck, FULL_CHECK);
  assert.deepEqual(content.requirements, task.requirements);
  assert.ok(content.criteria.tests[0].contract.counterfactuals.length);
  assert.ok(content.correction.some((node: { id: string }) => node.id === "p-refusal-block"));
  assert.equal(content.connections[0].bindings.length, 1, "Upper-level copies do not belong in each implementation brief");
  assert.equal(content.contracts.length, 1);
  assert.equal(content.artifacts.some((artifact: { id: string }) => artifact.id === "p-result"), false);
  assert.equal(content.binding.base.commit, plan.value.base.head);
  assert.equal(content.details.command, "task-detail");
  for (let index = 0; index < 200; index++) plan.value.graphSnapshot.contracts.push({ id: `unrelated-${index}`, schema: { type: "string", description: "unrelated research ".repeat(500) } });
  assert.deepEqual(taskContext(plan, FULL_CHECK, task.id, 100_000), before);
  assert.ok(canonical(plan.value).length > before.chars * 50);
});

test("context budgets never silently truncate obligations and metrics count the exact serialized bytes", () => {
  const plan = packetPlan(), task = plan.value.tasks[0]!;
  const full = taskContext(plan, FULL_CHECK, task.id, 100_000);
  assert.equal(full.chars, full.text.length); assert.equal(full.utf8Bytes, Buffer.byteLength(full.text)); assert.equal(full.hash, digest(full.text));
  assert.deepEqual(taskContext(plan, FULL_CHECK, task.id, full.chars), full);
  assert.throws(() => taskContext(plan, FULL_CHECK, task.id, full.chars - 1), (error: any) => error.code === "context_budget_exceeded" && error.details.requiredChars === full.chars);
  assert.throws(() => taskContext(plan, FULL_CHECK, task.id, 0), /positive configured/);
  assert.throws(() => taskContext(plan, FULL_CHECK, "foreign-task", 100_000), /does not belong/);
  const unicode = boundedContext({ text: "Пользователь получает результат" }, 1000);
  assert.ok(unicode.utf8Bytes > unicode.chars);
});

test("detail selection is explicit, rejects missing fields and prototype masquerades, and supports bounded source excerpts", () => {
  const source = { fields: { "contract/name": "префикс: результат" }, rows: [{ value: 4 }] };
  const selector = { id: "source", pointer: "/fields/contract~1name", start: 9, end: 18 };
  assert.equal(selectDetail(source, selector), "результат");
  assert.equal(selectDetail(source, { ...selector, pointer: "/rows/0/value", start: null, end: null }), 4);
  for (const pointer of ["/fields/missing", "/__proto__/constructor", "/rows/01/value", "/rows/length"])
    assert.throws(() => selectDetail(source, { ...selector, pointer, start: null, end: null }), /field is missing/);
  assert.throws(() => selectDetail(source, { ...selector, pointer: "/fields/contract~2name" }), /Invalid JSON pointer escape/);
  assert.throws(() => selectDetail(source, { ...selector, start: null }), /valid offsets/);
});

test("the product API returns compact context and exact detailed evidence, and refuses foreign or manually altered plans", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-context-")), workspace = join(root, "repo"); mkdirSync(workspace);
  git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "Context test input repository");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const desired = enrichedGraph(exampleGraph("p"), "p");
  prepareOmFixtureStages(engine, "p", desired);
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("p", { workspace, implementer: { actor: "worker", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 1000, requestCapacityChars: 100_000 }, 0);
  prepareNativeLayers(engine, "p", desired, "executed", { decidePolicies: true });
  const plan = engine.compiler.compile("p"), task = plan.value.tasks[1]!.id;
  // The plan stands on the current producers: no research phase, no feasibility of the old route, the real OM feasibility and the accepted L3.
  assert.deepEqual(store.list("phase"), []);
  assert.equal(store.get("feasibility:p"), null);
  assert.deepEqual(plan.value.feasibility, reference(store.get("om-feasibility:p")!));
  assert.equal(store.get<{ acceptance?: { producer?: string } }>("graph-layer:p:3")!.value.acceptance?.producer, "om");
  const request = { type: "task-context", project: "p", plan: reference(plan), task, maxChars: 100_000 };
  const context = engine.execute(request) as ContextText;
  const payload = JSON.parse(context.text);
  assert.deepEqual(payload.criteria.fullCheck, command);
  assert.deepEqual(payload.inputs, plan.value.tasks[1]!.inputs);
  assert.ok(payload.inputs[0].producerTask, "An unexecuted predecessor is a required task, never a fabricated accepted receipt");
  const detail = { type: "task-detail", project: "p", plan: reference(plan), task, kind: "graph", maxChars: 100_000,
    selector: { id: "p-contract", pointer: "/schema", start: null, end: null } };
  assert.deepEqual(JSON.parse((engine.execute(detail) as ContextText).text).value, { type: "string" });
  const index = JSON.parse((engine.execute({ ...detail, kind: "evidence-index", selector: { id: "", pointer: "", start: null, end: null } }) as ContextText).text);
  const source = index.value.find((item: { ref: { id: string } }) => item.ref.id === "source:p:brief");
  assert.ok(source);
  const excerpt = JSON.parse((engine.execute({ ...detail, kind: "evidence", selector: { id: source.ref.id, pointer: "/content", start: 0, end: 5 } }) as ContextText).text);
  assert.equal(excerpt.value, "A bri"); assert.deepEqual(excerpt.binding.source, source.ref);
  assert.throws(() => engine.execute({ ...request, maxChars: 0 }), /Missing, extra/);
  assert.throws(() => engine.execute({ ...request, task: "foreign" }), /does not belong/);
  assert.throws(() => engine.execute({ ...request, plan: { ...reference(plan), hash: "0".repeat(64) } }), /current exact plan/);
  assert.throws(() => engine.execute({ ...detail, kind: "evidence", selector: { ...detail.selector, id: "source:other:brief" } }), /exact input/);
  const changed = structuredClone(plan.value); changed.tasks[1]!.writePaths.push("forged.txt");
  const { hash: _hash, ...body } = changed; changed.hash = hashJson(body);
  const forged = store.write({ id: plan.id, kind: plan.kind, expected: plan.revision, value: changed });
  assert.throws(() => engine.execute({ ...request, plan: reference(forged) }), /Tasks must be derived/);
});
