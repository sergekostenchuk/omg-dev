import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { UPSTREAM_STAGES, REQUIREMENTS } from "../src/discovery/requirements.js";
import { preparedField } from "./preparation-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { buildL1, designOf } from "../src/graph/builder.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { StageResearchResult } from "../src/product/stage-research.js";
import { consumerFeedback, rejectResearch, type ConsumerFeedback } from "../src/discovery/consumer-feedback.js";
import { researchGraphContext, researchPrerequisites } from "../src/discovery/research-context.js";
import type { Json } from "../src/canonical.js";

// Controlled process provider proves routing/acceptance, not live model quality.
const ADAPTER = `import {readFileSync,appendFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
appendFileSync(process.argv[3],JSON.stringify({role:c.role,field:c.questions?.[0]?.field,feedback:c.consumerFeedback})+'\\n');
if(process.argv[4]==='fail')process.exit(1);
let research;
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else {const q=c.questions[0],source=c.inventory.sources.find(s=>s.location==='values'),values=JSON.parse(readFileSync(process.argv[2],'utf8'));
 const value=structuredClone(values[q.field]);
 if(q.field==='conceptSections'&&(!c.consumerFeedback.length||process.argv[4]==='stuck'))value[0].requirements[0].outcome='descriptive prose, not an outcome ID';
 if(q.field==='mapDesign'&&!c.consumerFeedback.length) {
   if(process.argv[4]==='drift')value.contracts[0].schema.description='Changed meaning of a stable connector';
   else value.nodes[0].outcome='missing-artifact';
 }
 research={action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'json-pointer',pointer:'/'+q.field}}]};
}console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research}));`;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-stage-research-"));
  const path = join(root, "state.sqlite"); const store = new Store(path); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "adapter.mjs"), ADAPTER);
  function setup(project: string, scenario = "normal") {
    engine.execute({ type: "create-project", project, title: project });
    const fields = Object.fromEntries(UPSTREAM_STAGES.flatMap(stage => REQUIREMENTS[stage].map(spec => [spec.field,
      spec.field === "mapDesign" ? designOf(enrichedGraph(exampleGraph(project), project)) : preparedField(project, spec.field)])));
    const values = join(root, `${project}.json`); writeFileSync(values, JSON.stringify(fields));
    engine.discovery.evidence.document(project, "values", JSON.stringify(fields), "application/json", 0);
    const command = { executable: process.execPath, args: [join(root, "adapter.mjs"), values, join(root, `${project}.calls`), scenario] };
    engine.environments.configure(project, { workspace: root,
      implementer: { actor: "author", model: "fixture", effort: "high", command },
      reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
      fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 4000 }, 0);
  }
  return { root, path, store, engine, setup };
}

test("stage command automatically repairs consumer rejections and accepts all upstream stages for two products", async t => {
  const { engine, store, root, setup } = fixture(t);
  for (const project of ["garden", "invoice"]) {
    setup(project);
    for (const stage of UPSTREAM_STAGES) {
      const draft = engine.prepare(project, stage);
      if (stage === "operation-map") {
        const prior = researchPrerequisites(store, draft.value).find(item => item.stage === "discovery")!;
        assert.ok((prior.fields['preparation'] as { journeys?: unknown }).journeys, "L1 receives accepted scenario obligations without a manually copied source");
      }
      const result = await engine.execute({ type: "research-stage", project, draftId: draft.id, maxTurns: 8 }) as StageResearchResult;
      assert.equal(result.status, "accepted", JSON.stringify(result));
      assert.equal(engine.pipeline.inspect(project, stage).state, "accepted");
      const count = store.list("research-turn").length;
      const again = await engine.stageResearch.run(project, draft.id, 8);
      assert.equal(again.status, "accepted"); assert.equal(store.list("research-turn").length, count);
      assert.equal(again.stage!.revision, result.stage!.revision, "Accepted stage is not republished");
    }
    const feedback = store.list<ConsumerFeedback>("research-feedback").filter(item => item.value.projectId === project);
    assert.equal(feedback.length, 2);
    assert.ok(feedback.some(item => item.value.findings.some(finding => finding.code === "requirement_outcome_missing")));
    assert.ok(feedback.some(item => item.value.findings.some(finding => finding.field === "mapDesign")));
    const concept = store.get<DiscoveryDraft>(feedback.find(item => item.value.findings[0]!.field === "conceptSections")!.value.draft.id)!;
    assert.ok(concept.value.questions.filter(id => store.get<Question>(id)!.value.spec.field !== "conceptSections")
      .every(id => store.get<Question>(id)!.revision === 2), "Unrelated answers were not reopened");
    const calls = readFileSync(join(root, `${project}.calls`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(calls.some(call => call.role === "assess-answer" && call.feedback.length), "Assessor receives the same actual rejection");
    assert.equal(store.list("source").filter(item => (item.value as {projectId:string}).projectId === project).length, 1,
      "Engine diagnostics are not mislabeled owner documents");
  }
});

test("exhausted stage allowance preserves feedback and resumes exact rejected question after reopening SQLite", async t => {
  const { store, path, engine, setup } = fixture(t); setup("p");
  const first = engine.prepare("p", "discovery"); await engine.stageResearch.run("p", first.id, 3);
  const draft = engine.prepare("p", "concept");
  const paused = await engine.stageResearch.run("p", draft.id, 4);
  assert.equal(paused.status, "paused"); assert.ok(paused.feedback);
  assert.equal(engine.pipeline.inspect("p", "concept").state, "blocked");
  const questions = draft.value.questions.map(id => store.get<Question>(id)!);
  assert.deepEqual(questions.filter(q => q.value.status === "open").map(q => q.value.spec.field), ["conceptSections"]);
  const reopened = new Store(path);
  try {
    const next = new ProductEngine(reopened); const result = await next.stageResearch.run("p", draft.id, 1);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.deepEqual(consumerFeedback(reopened, reopened.get<DiscoveryDraft>(draft.id)!.value), []);
  } finally { reopened.close(); }
});

test("stage command rejects missing/foreign inputs and provider failure never accepts or asks the owner", async t => {
  const { engine, store, setup } = fixture(t); setup("p", "fail"); setup("q");
  assert.throws(() => engine.execute({ type: "research-stage", project: "p", maxTurns: 2 }), { code: "command_invalid" });
  const draft = engine.prepare("p", "discovery");
  await assert.rejects(engine.stageResearch.run("q", draft.id, 2), { code: "discovery_foreign" });
  const result = await engine.stageResearch.run("p", draft.id, 2);
  assert.equal(result.status, "paused"); assert.equal(result.stage, null);
  assert.equal(store.list("research-feedback").length, 0);
  assert.equal((store.get(result.research!.id)!.value as {ownerQuestion:unknown}).ownerQuestion, null);
  assert.equal(engine.pipeline.inspect("p", "discovery").state, "missing");
});

test("feedback cannot reopen a foreign field or race a revised proposal", async t => {
  const { engine, store, setup } = fixture(t); setup("p");
  const draft = engine.prepare("p", "discovery"); await engine.researcher.run("p", draft.id, 3);
  const current = store.get<DiscoveryDraft>(draft.id)!;
  const invalid = [{ code: "invalid", target: draft.id, message: "No known field" }];
  assert.throws(() => rejectResearch(store, current, invalid, []), { code: "feedback_target_missing" });
  const findings = [{ ...invalid[0]!, field: "preparation" }];
  const question = current.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === "objective")!;
  engine.discovery.reopen(question.id, question.revision);
  engine.discovery.decision(question.id, question.revision + 1, "owner", "New purpose");
  assert.throws(() => rejectResearch(store, current, findings, []), { code: "input_stale" });
  assert.equal(store.list("research-feedback").length, 0, "Feedback and reopen are one transaction");
  assert.equal(store.get<Question>(current.value.questions.find(id => store.get<Question>(id)!.value.spec.field === "preparation")!)!.value.status, "answered");
});

test("repeated consumer rejection stops at the shared turn budget without accepting the proposal", async t => {
  const { engine, store, setup } = fixture(t); setup("p", "stuck");
  const initial = engine.prepare("p", "discovery"); await engine.stageResearch.run("p", initial.id, 3);
  const draft = engine.prepare("p", "concept");
  const result = await engine.stageResearch.run("p", draft.id, 6);
  assert.equal(result.status, "paused");
  assert.equal((store.get(result.research!.id)!.value as {turns:number}).turns, 6);
  assert.equal(store.list("research-feedback").length, 3);
  assert.equal(engine.pipeline.inspect("p", "concept").state, "blocked");
});

test("a competing stage revision during model work is preserved and cannot be auto-accepted", async t => {
  const { engine, store, setup } = fixture(t); setup("p");
  const draft = engine.prepare("p", "discovery");
  const research = engine.researcher.run.bind(engine.researcher);
  engine.researcher.run = async (...args) => {
    const result = await research(...args);
    engine.draft("p", "discovery", draft.id, 0);
    return result;
  };
  await assert.rejects(engine.stageResearch.run("p", draft.id, 3), { code: "revision_conflict" });
  const artifact = store.get<{status:string}>("stage:p:discovery")!;
  assert.equal(artifact.revision, 1); assert.equal(artifact.value.status, "draft");
  assert.equal(store.list("research-feedback").length, 0);
});

test("existing connector semantic drift is fed back with current L1 for model correction", async t => {
  const { engine, store, setup } = fixture(t); setup("p", "drift");
  for (const stage of ["discovery", "concept"] as const) {
    const draft = engine.prepare("p", stage); assert.equal((await engine.stageResearch.run("p", draft.id, 6)).status, "accepted");
  }
  const draft = engine.prepare("p", "operation-map");
  const graph = buildL1("p:map", "p", designOf(enrichedGraph(exampleGraph("p"), "p")),
    { preparation: preparedField("p", "preparation") }, { conceptSections: preparedField("p", "conceptSections") });
  const original = engine.graphs.save("p", graph, 0, "owner");
  const context = researchGraphContext(store, draft.value)!;
  assert.equal(context.ref.hash, original.hash);
  assert.deepEqual(context.graph.contracts, graph.contracts);
  const result = await engine.stageResearch.run("p", draft.id, 5);
  assert.equal(result.status, "accepted", JSON.stringify(result));
  assert.ok(store.list<ConsumerFeedback>("research-feedback").some(item => item.value.findings.some(finding => finding.code === "graph_semantic_drift")));
  const accepted = store.get<{content:{fields:Record<string,Json>}}>(result.stage!.id)!;
  assert.deepEqual(accepted.value.content.fields['mapDesign'], designOf(graph));
});
