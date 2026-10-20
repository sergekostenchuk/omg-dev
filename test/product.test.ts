import { answerDiscoveryFixture, currentUpstreamFixtureValue, preparedFeatures, withHistoricalUpstream } from './product-fixture.js';
import type { Json } from '../src/canonical.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { RESEARCH_CONTRACT_VERSION, UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { reference } from "../src/pipeline/contracts.js";
import { exampleGraph } from "./graph-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { designOf } from "../src/graph/builder.js";
import { createProductServer } from "../src/server.js";
import type { Environment } from "../src/runtime/environment.js";

test("the real product command path carries two independent products from brief to traceable features and cold reopen", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-product-")); const path = join(root, "state.sqlite"); const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  for (const project of ["garden", "invoice"]) {
    engine.execute({ type: "create-project", project, title: project });
    const source = engine.execute({ type: "source-document", project, id: "brief", text: `A brief for ${project}`, media: "text/plain", expected: 0 }) as Revision;
    const graph = enrichedGraph(exampleGraph(project), project); graph.horizon = [];
    engine.execute({ type: "save-graph", project, graph, expected: 0 });
    for (const stage of UPSTREAM_STAGES) {
      const draft = engine.execute({ type: "prepare-stage", project, stage }) as Revision<DiscoveryDraft>;
      for (const id of draft.value.questions) {
        const question = engine.projection(project).questions.find(q => q.id === id)!;
        if (question.value.spec.kind === "fact") engine.execute({ type: "answer-fact", question: id, expected: 1,
          source: reference(source), selector: { kind: "text-range", start: 0, end: `A brief for ${project}`.length } });
        else {
          const field = question.value.spec.field;
          const value = currentUpstreamFixtureValue(engine, project, field,
            field === "mapDesign" ? designOf(graph) as Json : preparedField(project, field));
          if (stage === 'discovery' && ['researchPlan','researchReport','verdict','preparation'].includes(field))
            answerDiscoveryFixture(engine,project,store.get<DiscoveryDraft>(draft.id)!,store.get<Question>(id)!,value as Json,source as Revision<{content:string}>);
          else engine.execute({ type: "answer-decision", question: id, expected: 1, value });
        }
      }
      const artifact = engine.execute({ type: "draft-stage", project, stage, draftId: draft.id, expected: 0 }) as Revision;
      engine.execute({ type: "accept-stage", project, stage, expected: artifact.revision });
    }
    assert.equal(engine.pipeline.inspect(project, "features").state, "accepted");
    const guards = engine.pipeline.inspect(project, "features").guards;
    assert.equal(guards.length, new Set(guards.map(item => `${item.id}:${item.revision}:${item.hash}`)).size);
    assert.match(engine.exportStage(project, "features"), /requirements/);
  }
  const reopened = new Store(path);
  try { assert.equal(new ProductEngine(reopened).projection("invoice").stages.find(s => s.stage === "features")!.state, "accepted"); }
  finally { reopened.close(); }
  engine.execute({ type: "source-document", project: "garden", id: "brief", text: "Revised garden", media: "text/plain", expected: 1 });
  assert.equal(engine.pipeline.inspect("garden", "features").state, "stale");
  assert.equal(engine.pipeline.inspect("invoice", "features").state, "accepted");
});

test("CLI command interface persists commands, rejects extra authority fields and returns a cold projection", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-cli-")); const path = join(root, "state.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = new URL("../src/cli.js", import.meta.url);
  const call = (input: unknown) => spawnSync(process.execPath, [cli.pathname, "command", path], { input: JSON.stringify(input), encoding: "utf8", timeout: 10_000 });
  assert.equal(call({ type: "create-project", project: "demo", title: "Demo" }).status, 0);
  const bad = call({ type: "create-project", project: "foreign", title: "Wrong", accepted: true });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /command_invalid/);
  const view = call({ type: "project", project: "demo" }); assert.equal(view.status, 0);
  assert.equal(JSON.parse(view.stdout).project.value.title, "Demo");
});

test("unrelated research cannot approve a stage and research retains the input version it actually used", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-context-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "demo", title: "Demo" });
  const source = engine.execute({ type: "source-document", project: "demo", id: "brief", text: "brief", media: "text/plain", expected: 0 }) as Revision;
  const initial = engine.prepare("demo", "discovery");
  engine.discovery.fact(initial.value.questions[0]!, 1, reference(source), { kind: "text-range", start: 0, end: 5 });
  engine.discovery.decision(initial.value.questions[1]!, 1, "owner", "Outcome");
  for (const id of initial.value.questions.slice(2)) {
    const question=store.get<Question>(id)!;
    answerDiscoveryFixture(engine,'demo',store.get<DiscoveryDraft>(initial.id)!,question,preparedField('demo',question.value.spec.field),source as Revision<{content:string}>);
  }
  const artifact = engine.draft("demo", "discovery", initial.id, 0);
  engine.pipeline.accept("demo", "discovery", artifact.revision);
  assert.throws(() => engine.draft("demo", "concept", initial.id, 0), /Research must belong/);
  const concept = engine.prepare("demo", "concept");
  engine.discovery.evidence.document("demo", "brief", "new brief", "text/plain", 1);
  assert.ok(engine.discovery.gate("demo", reference(concept)).findings.some(f => f.code === "research_context_stale"));
});

// S1.5 (№2363): the projection is no function of the Store alone — the files behind its sources and the executor's
// memory speak at every call, so nothing of it may be remembered by the Store's change stamp.
test("S1.5 №2363 the projection follows the files behind its sources at an unchanged Store stamp — a changed, a removed and a restored file — and reads executionRunning from the executor each time", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-s15-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "p", title: "Probe" });
  const file = join(root, "brief.txt"); writeFileSync(file, "old brief");
  const source = engine.discovery.evidence.file("p", "brief", root, "brief.txt", "text/plain", 0);
  const draft = engine.prepare("p", "discovery"), question = draft.value.questions[0]!;
  engine.discovery.fact(question, 1, reference(source), { kind: "text-range", start: 0, end: 9 });
  const assessment = () => engine.projection("p").questions.find(row => row.id === question)!.assessment;
  const stamp = store.changeStamp();
  assert.equal(assessment().state, "answered");
  writeFileSync(file, "new brief");
  const changed = assessment();
  assert.equal(store.changeStamp(), stamp, "No record changed: a projection remembered by the stamp would have kept the stale answer");
  assert.equal(changed.state, "stale"); assert.ok(changed.findings.some(finding => finding.code === "evidence_stale"));
  rmSync(file);
  const removed = assessment();
  assert.equal(removed.state, "stale"); assert.ok(removed.findings.length, "A removed file is no current evidence either");
  writeFileSync(file, "old brief");
  assert.equal(assessment().state, "answered", "The restored file makes the same answer current again");
  assert.equal(store.changeStamp(), stamp);
  // executionRunning comes from the executor's memory, never from a record.
  assert.equal(engine.projection("p").executionRunning, false);
  const executor = engine.executor, original = executor.isRunning;
  executor.isRunning = () => true;
  try { assert.equal(engine.projection("p").executionRunning, true); } finally { executor.isRunning = original; }
  assert.equal(engine.projection("p").executionRunning, false);
  assert.equal(store.changeStamp(), stamp);
});


test('DS1 explicit historical upstream uses its Git producer and leaves current fixtures on the current contract', t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-ds1-fixture-era-'));
  const store = new Store(join(root, 'state.sqlite')), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const commit = 'e9c1ca5c41fb80508559aeab41da8f3da7422953';
  const version = (project: string) => {
    const stage = store.get<{content: {draft: {id:string;revision:number}}}>(`stage:${project}:discovery`)!;
    const draft = stage.value.content.draft;
    return store.get<DiscoveryDraft>(draft.id, draft.revision)!.value.contractVersion;
  };
  withHistoricalUpstream(commit, () => preparedFeatures(engine, 'era'));
  assert.equal(version('era'), 4);
  preparedFeatures(engine, 'current');
  assert.equal(version('current'), RESEARCH_CONTRACT_VERSION);
  for (const project of ['era', 'current']) for (const stage of UPSTREAM_STAGES)
    assert.equal(engine.pipeline.inspect(project, stage).state, 'accepted');
});


function lg30Commands(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-lg30-")), path = join(root, "state.sqlite"), store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  const project = engine.execute({ type: "create-project", project: "p", title: "Current commands" }) as Revision;
  const command = { executable: process.execPath, args: ["--version"] };
  const environment: Omit<Environment, "projectId"> = { workspace: root, timeoutMs: 1000, requestCapacityChars: 100000,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command };
  const configure = (expected: number, web: unknown) => ({ type: "configure", project: "p", expected,
    environment: web === undefined ? environment : { ...environment, webResearch: web } });
  return { path, store, engine, project, configure };
}

const lg30Web = { enabled: true, gatewayUrl: "http://127.0.0.1:18890", timeoutMs: 1000,
  budgetContract: "web-budget/v2", limits: { materialChars: 2000000, responseBytes: 100000 } };

test("LG30-A retired R2 policy, trial and web-v1 commands are refused by engine, CLI and HTTP without writes", async t => {
  const f = lg30Commands(t);
  f.engine.execute(f.configure(0, lg30Web));
  const server = createProductServer(f.engine);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/command`;
  const before = f.store.list().flatMap(record => f.store.history(record.id));
  const ref = reference(f.project);
  // These are command-shaped inputs, not fabricated scope/policy records in storage.
  const commands = [
    { type: "apply-obligation-policy", project: "p", scope: ref, policy: { version: 1, sourceScope: ref, assignments: [] } },
    { type: "allocate-research-trial", project: "p", key: "new-trial", previousPolicy: ref, limit: 10, blockLimit: 5 },
    f.configure(1, { enabled: true, gatewayUrl: lg30Web.gatewayUrl, timeoutMs: 1000,
      limits: { httpAttempts: 1, pages: 1, receivedChars: 1000, responseBytes: 100000 } }),
  ];
  try {
    for (const input of commands) {
      assert.throws(() => f.engine.execute(input), { code: "command_invalid" }, input.type);
      const cli = spawnSync(process.execPath, [new URL("../src/cli.js", import.meta.url).pathname, "command", f.path],
        { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 });
      assert.equal(cli.status, 1, cli.stderr); assert.equal(JSON.parse(cli.stderr.split("\n").find(line => line.startsWith("{"))!).error, "command_invalid");
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json",
        "X-OMG-Token": server.accessToken }, body: JSON.stringify(input) });
      assert.equal(response.status, 400); assert.equal((await response.json() as { error: string }).error, "command_invalid");
      assert.deepEqual(f.store.list().flatMap(record => f.store.history(record.id)), before, input.type);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("LG30-A configure preserves absent web settings and exact v2 settings; missing or disguised contracts never write", t => {
  const f = lg30Commands(t);
  const plain = f.engine.execute(f.configure(0, undefined)) as Revision<Environment>;
  assert.equal(Object.hasOwn(plain.value, "webResearch"), false);
  const current = f.engine.execute(f.configure(1, lg30Web)) as Revision<Environment>;
  assert.deepEqual(current.value.webResearch, lg30Web);
  const { budgetContract: _contract, ...missingContract } = lg30Web;
  for (const web of [null, {}, missingContract, { ...lg30Web, budgetContract: "web-budget/v1" },
    { ...lg30Web, limits: { ...lg30Web.limits, pages: 1 } }, { ...lg30Web, limits: { responseBytes: 100000 } },
    { ...lg30Web, limits: { materialChars: 2000001, responseBytes: 100000 } }]) {
    assert.throws(() => f.engine.execute(f.configure(2, web)), { code: "command_invalid" });
    assert.deepEqual(f.store.history(current.id), [plain, current]);
  }
  const disabled = { ...lg30Web, enabled: false };
  const saved = f.engine.execute(f.configure(2, disabled)) as Revision<Environment>;
  assert.deepEqual(saved.value.webResearch, disabled);
  const cold = new Store(f.path);
  try { assert.deepEqual(cold.history(current.id), [plain, current, saved]); } finally { cold.close(); }
});
