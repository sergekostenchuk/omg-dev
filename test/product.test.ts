import { answerDiscoveryFixture, preparedFeatures, withHistoricalUpstream } from './product-fixture.js';
import type { Json } from '../src/canonical.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { reference } from "../src/pipeline/contracts.js";
import { exampleGraph } from "./graph-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { designOf } from "../src/graph/builder.js";

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
          const value = field === "mapDesign" ? designOf(graph) : preparedField(project, field);
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


test('DS1 explicit historical upstream uses its Git producer and leaves current fixtures on v5', t => {
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
  assert.equal(version('current'), 5);
  for (const project of ['era', 'current']) for (const stage of UPSTREAM_STAGES)
    assert.equal(engine.pipeline.inspect(project, stage).state, 'accepted');
});
