import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision, type Write, type ReadGuard } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { preparedFeatures } from "./product-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { projectGraph } from "../src/graph/project.js";
import { layerDesignOf } from "../src/graph/layer-design.js";
import { L3_ASSEMBLY } from "../src/graph/layer-assembly.js";
import { reference } from "../src/pipeline/contracts.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { ConsumerResult } from "../src/discovery/consumer-research.js";
import type { ResearchTurn } from "../src/discovery/research-model.js";
import type { ConsumerFeedback } from "../src/discovery/consumer-feedback.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";

// Process fixture intentionally over-approves one wrong fact/upper-layer change.
// These tests prove deterministic consumer correction, not model quality.
const ADAPTER = `import {readFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(0,'utf8')),c=request.subject;
if(!c.inventory)c.inventory={sources:c.originals?.sources??[]};
let research;
if(process.argv[3]==='fail')process.exit(1);
if(c.role==='assess-answer')research={verdict:'supported',reasons:[]};
else {
 const q=c.questions.find(q=>!['runtime','contractsAndConsumers'].includes(q.field))??c.questions[0],source=c.inventory.sources.find(s=>s.kind==='file'),feedback=c.consumerFeedback.some(f=>f.findings.some(x=>x.field===q.field))||c.history.some(t=>t.error&&t.action?.question===q.id)||(c.corrections??[]).some(t=>t.error&&t.question===q.id);
 let value;
 if(q.field==='layerDesign') {
  value=JSON.parse(readFileSync(process.argv[2],'utf8'))[c.level==='R1'?'2':'3'];
  if(!feedback)value.nodes.find(n=>n.kind==='block').purpose='Unresearched replacement of accepted upper meaning';
 } else value={applicability:'applicable',reason:'The fixture product has a local runtime',
   facts:[{id:q.field+'-fact',claim:'Baseline runtime documentation exists',...(q.basisContract==='typed-v1'
    ?{evidence:{kind:'repository-file',citation:!feedback&&q.field==='contractsAndConsumers'?99:0}}
    :{path:!feedback&&['runtime','contractsAndConsumers'].includes(q.field)?'absent.ts':'README.md'})}],
   designs:[{id:q.field+'-design',decision:'Keep the transformation stateless and scoped to its output',benefit:'The consumer receives one validated result',consumer:'compilation'}],gaps:[],
   ...(q.basisContract==='typed-v1'?{documents:[]}:{})};
 research={action:'answer',question:q.id,value,citations:[{source:source.ref,selector:{kind:'text-range',start:0,end:source.length}}]};
}console.log(JSON.stringify({protocol:request.protocol,requestId:request.requestId,research}));`;

function fixture(t: test.TestContext, project: string, scenario = "normal") {
  const root = mkdtempSync(join(tmpdir(), "omg-refinement-loop-")), workspace = join(root, "repo"); mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "A local stateless transformation runtime is planned.\n");
  writeFileSync(join(workspace, "adapter.mjs"), ADAPTER);
  const path = join(root, "state.sqlite"); const store = new Store(path), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const full = enrichedGraph(exampleGraph(project), project);
  preparedFeatures(engine, project, full);
  const { level: _level, ...initial } = projectGraph(full, 1);
  engine.graphs.save(project, initial, store.get(`graph:${project}`)!.revision, "fixture");
  const values = join(workspace, "designs.json");
  writeFileSync(values, JSON.stringify({ 2: layerDesignOf(full, 2), 3: layerDesignOf(full, 3, L3_ASSEMBLY) }));
  const command = { executable: process.execPath, args: [join(workspace, "adapter.mjs"), values, scenario] };
  engine.environments.configure(project, { workspace, implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 4000 }, 0);
  engine.discovery.evidence.file(project, "runtime", workspace, "README.md", "text/plain", 0);
  const r0 = engine.refinement.begin(project, "R0"); engine.refinement.finishResearch(project, "R0", reference(r0), 0);
  engine.refinement.sealLayer(project, 1, 0);
  return { engine, store, root, path };
}

test("R1/R2 and L2/L3 consumers autonomously correct only rejected fields for two products", async t => {
  for (const project of ["garden", "archive"]) {
    const { engine, store } = fixture(t, project);
    for (const phase of ["R1", "L2", "R2", "L3"] as const) {
      const draft = phase === "R1" || phase === "R2" ? engine.refinement.begin(project, phase)
        : engine.refinement.prepareLayer(project, phase === "L2" ? 2 : 3);
      const prior = store.get(`phase:${project}:${phase}`);
      assert.equal(prior, null);
      const result = await engine.execute({ type: "research-phase", project, phase, draftId: draft.id, maxTurns: 12 }) as ConsumerResult;
      assert.equal(result.status, "accepted", JSON.stringify(result));
      assert.deepEqual(engine.refinement.gate(project, phase).findings, []);
      const feedback = store.list<ConsumerFeedback>("research-feedback").filter(item => item.value.draft.id === draft.id);
      const early = store.list<ResearchTurn>("research-turn").filter(turn => turn.value.run === result.research?.id && turn.value.error);
      if (phase === "L2") {
        assert.equal(feedback.length, 1);
        assert.ok(feedback[0]!.value.findings.some(finding => finding.code === "upper_layer_drift"));
      } else {
        assert.equal(feedback.length, 0, "Invalid facts and typed L3 structural defects must be refused before paid assessment and final consumption");
        assert.ok(early.some(turn => JSON.stringify(turn.value.observation).includes(
          phase === "L3" ? "upper_layer_drift" : phase === "R2" ? "research_basis_invalid" : "repository_evidence_required")));
      }
      const affected = new Set(phase === "L2" ? feedback[0]!.value.questions.map(ref => ref.id) : early.map(turn => turn.value.question?.id ?? (turn.value.action as {question:string}).question));
      assert.equal(affected.size, 1);
      assert.ok(draft.value.questions.filter(id => !affected.has(id)).every(id => store.get<Question>(id)!.revision === 2));
      const turns = store.list("research-turn").length;
      const repeated = await engine.refinementResearch.run(project, phase, draft.id, 12);
      assert.equal(repeated.status, "accepted"); assert.deepEqual(repeated.artifact, result.artifact);
      assert.equal(store.list("research-turn").length, turns, "An already accepted phase needs no new model calls");
    }
  }
});

test("R1 early proposal feedback survives a cold database reopen and uses only the remaining question", async t => {
  const { engine, store, path } = fixture(t, "p");
  const draft = engine.refinement.begin("p", "R1");
  const first = await engine.refinementResearch.run("p", "R1", draft.id, 9);
  assert.equal(first.status, "paused"); assert.equal(first.feedback, null);
  assert.ok(store.list<ResearchTurn>("research-turn").some(turn => JSON.stringify(turn.value.observation).includes("repository_evidence_required")));
  assert.equal(store.get("phase:p:R1"), null, "A supported model assessment cannot publish an invalid factual claim");
  assert.deepEqual(draft.value.questions.filter(id => store.get<Question>(id)!.value.status === "open")
    .map(id => store.get<Question>(id)!.value.spec.field), ["evidenceAndTests"]);
  const before = store.list("research-turn").length; store.close();
  const reopened = new Store(path);
  try {
    const next = new ProductEngine(reopened); const result = await next.refinementResearch.run("p", "R1", draft.id, 1);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal(reopened.list("research-turn").length, before + 1);
  } finally { reopened.close(); }
});

test("refinement command refuses wrong phase/draft, missing arguments, and technical provider failure", async t => {
  const { engine, store } = fixture(t, "p", "fail"); const draft = engine.refinement.begin("p", "R1");
  assert.throws(() => engine.execute({ type: "research-phase", project: "p", draftId: draft.id, maxTurns: 2 }), { code: "command_invalid" });
  await assert.rejects(engine.refinementResearch.run("other", "R1", draft.id, 2), { code: "research_foreign" });
  await assert.rejects(engine.refinementResearch.run("p", "L2", draft.id, 2), { code: "research_foreign" });
  await assert.rejects(engine.refinementResearch.run("p", "R2", draft.id, 2), { code: "research_foreign" });
  const result = await engine.refinementResearch.run("p", "R1", draft.id, 2);
  assert.equal(result.status, "paused"); assert.equal(store.get("phase:p:R1"), null);
  assert.equal((store.get(result.research!.id)!.value as {ownerQuestion:unknown}).ownerQuestion, null);
});

test("a competing phase acceptance during model work is never overwritten", async t => {
  const { engine, store } = fixture(t, "p"); const draft = engine.refinement.begin("p", "R1");
  const paused = await engine.refinementResearch.run("p", "R1", draft.id, 9); assert.equal(paused.status, "paused");
  const run = engine.researcher.run.bind(engine.researcher);
  engine.researcher.run = async (...args) => {
    const result = await run(...args);
    engine.refinement.finishResearch("p", "R1", reference(store.get<DiscoveryDraft>(draft.id)!), 0);
    return result;
  };
  await assert.rejects(engine.refinementResearch.run("p", "R1", draft.id, 1), { code: "revision_conflict" });
  assert.equal(store.get("phase:p:R1")!.revision, 1);
});

test("layer acceptance binds the exact constructed graph across the build-to-seal window", async t => {
  const { engine, store } = fixture(t, "p"); const r1 = engine.refinement.begin("p", "R1");
  assert.equal((await engine.refinementResearch.run("p", "R1", r1.id, 10)).status, "accepted");
  const draft = engine.refinement.prepareLayer("p", 2);
  const build = engine.refinement.buildLayer.bind(engine.refinement);
  engine.refinement.buildLayer = (...args) => {
    const built = build(...args);
    engine.graphs.save("p", built.value, built.revision, "competing-writer");
    return built;
  };
  await assert.rejects(engine.refinementResearch.run("p", "L2", draft.id, 3), { code: "graph_stale" });
  assert.equal(store.get("phase:p:L2"), null);
});

test("a retry cannot adopt a competing phase accepted after early proposal feedback", async t => {
  const { engine, store } = fixture(t, "p");
  const draft = engine.refinement.begin("p", "R1"), other = engine.refinement.begin("p", "R1");
  const write = store.writeMany.bind(store); let pending = true;
  store.writeMany = function<T>(inputs: Write[], guards?: ReadGuard[]): Revision<T>[] {
    const records = write<T>(inputs, guards);
    if (pending && inputs.some(input => input.kind === "research-turn" && Boolean((input.value as ResearchTurn).error))) {
      pending = false;
      answerTechnicalFixture(engine, "p", other);
      engine.refinement.finishResearch("p", "R1", reference(store.get<DiscoveryDraft>(other.id)!), 0);
    }
    return records;
  };
  await assert.rejects(engine.refinementResearch.run("p", "R1", draft.id, 12), { code: "revision_conflict" });
  assert.equal(store.get<{draft:{id:string}}>("phase:p:R1")!.value.draft.id, other.id);
  assert.equal(store.history("phase:p:R1").length, 1);
});
