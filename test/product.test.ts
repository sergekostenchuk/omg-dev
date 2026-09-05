import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import type { DiscoveryDraft } from "../src/discovery/discovery.js";
import { reference } from "../src/pipeline/contracts.js";
import { exampleGraph } from "./graph-fixture.js";

test("the real product command path carries two independent products from brief to traceable features and cold reopen", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-product-")); const path = join(root, "state.sqlite"); const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  for (const project of ["garden", "invoice"]) {
    engine.execute({ type: "create-project", project, title: project });
    const source = engine.execute({ type: "source-document", project, id: "brief", text: `A brief for ${project}`, media: "text/plain", expected: 0 }) as Revision;
    const graph = exampleGraph(project); graph.horizon = [];
    engine.execute({ type: "save-graph", project, graph, expected: 0 });
    for (const stage of UPSTREAM_STAGES) {
      const draft = engine.execute({ type: "prepare-stage", project, stage }) as Revision<DiscoveryDraft>;
      for (const id of draft.value.questions) {
        const question = engine.projection(project).questions.find(q => q.id === id)!;
        if (question.value.spec.kind === "fact") engine.execute({ type: "answer-fact", question: id, expected: 1,
          source: reference(source), selector: { kind: "text-range", start: 0, end: `A brief for ${project}`.length } });
        else {
          const field = question.value.spec.field;
          const value = field === "features" ? [{ title: "Deliver result", outcome: `${project}-result`, requirements: [0] }]
            : ["acceptance", "journey", "behavior", "constraints"].includes(field) ? [`${field} for ${project}`] : `${field} for ${project}`;
          engine.execute({ type: "answer-decision", question: id, expected: 1, value });
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
  const artifact = engine.draft("demo", "discovery", initial.id, 0);
  engine.pipeline.accept("demo", "discovery", artifact.revision);
  assert.throws(() => engine.draft("demo", "concept", initial.id, 0), /Research must belong/);
  const concept = engine.prepare("demo", "concept");
  engine.discovery.evidence.document("demo", "brief", "new brief", "text/plain", 1);
  assert.ok(engine.discovery.gate("demo", reference(concept)).findings.some(f => f.code === "research_context_stale"));
});
