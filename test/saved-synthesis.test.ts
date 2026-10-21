import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { reference } from "../src/pipeline/contracts.js";
import { hashJson, type Json } from "../src/canonical.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import type { ModelCall } from "../src/runtime/model-usage.js";
import { pilotEnvironment, type ReaderPilot, type ReaderPilotSettings } from "../src/discovery/reader-pilot.js";
import { configurePhasePolicy } from "../src/discovery/phase-policy.js";
import { configureResearchScope } from "../src/graph/research-scope.js";
import { checkpoint } from "../src/discovery/research-continuation.js";
import {savedSynthesisMaterials} from '../src/discovery/saved-synthesis.js';
import {readPilotContext} from '../src/discovery/pilot-context.js';
import { preparedFeatures } from "./product-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { deriveLayerFixture } from "./layer-design-fixture.js";

// Local protocol fixture: it can only combine the actual supplied saved pieces.
// It never reads a source or manufactures the report independently of them.
const ADAPTER = String.raw`
import {readFileSync,appendFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(0,'utf8')),c=req.subject;
appendFileSync(process.argv[2],JSON.stringify(req)+'\n');
let research;
if(c.role==='assess-answer') research={verdict:'supported',reasons:[]};
else {
 if(c.dispatchMode!=='synthesis') throw Error('Recovery must not call its reader or planner');
 if(process.argv[3]==='need-research') research={action:'need_research',question:c.question.id,missing:['Try to read the source again']};
 else {
  const proposals=c.selectedContext.map(piece=>piece.proposal);
  if(proposals.length!==2||!c.synthesisPage.complete) throw Error('Both saved checkpoints must reach synthesis');
  const base=proposals[0];
  research={...base,value:{...base.value,designs:proposals.flatMap(p=>p.value.designs)}};
 }
}
console.log(JSON.stringify({protocol:req.protocol,requestId:req.requestId,research,
 usage:{inputTokens:100,outputTokens:25,cachedInputTokens:0,reasoningOutputTokens:0}}));
`;

function fixture(t: test.TestContext, scenario = "answer", level: "R1" | "R2" = "R2") {
  const root = mkdtempSync(join(tmpdir(), "omg-saved-synthesis-"));
  const store = new Store(join(root, "state.sqlite")), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const wire = join(root, "wire.ndjson"), adapter = join(root, "adapter.mjs");
  writeFileSync(adapter, ADAPTER);
  writeFileSync(join(root, "README.md"), "Local output has one writer; invalid input produces no output.\n");
  preparedFeatures(engine, "p", enrichedGraph(exampleGraph("p"), "p"));
  const command = { executable: process.execPath, args: [adapter, wire, scenario] };
  engine.environments.configure("p", { workspace: root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 5000 }, 0);
  const r0 = engine.refinement.begin("p", "R0");
  engine.refinement.finishResearch("p", "R0", reference(r0), 0); engine.refinement.sealLayer("p", 1, 0);
  let draft = engine.refinement.begin("p", "R1");
  if (level === "R2") {
    answerTechnicalFixture(engine, "p", draft);
    engine.refinement.finishResearch("p", "R1", reference(store.get<DiscoveryDraft>(draft.id)!), 0);
    deriveLayerFixture(engine, "p", 2); engine.refinement.sealLayer("p", 2, 0);
    configureResearchScope(store, { projectId: "p", layer: reference(store.get("graph-layer:p:2")!),
      r1: reference(store.get("phase:p:R1")!), outcome: "Validated local output", nodes: ["p-produce-operation", "p-consume-operation"],
      boundaries: [], expansions: [], obligations: [], changedPaths: [], uiRequired: false }, 0);
    draft = engine.refinement.begin("p", "R2");
  }
  const question = store.get<Question>(draft.value.questions[0]!)!;
  const source = engine.discovery.evidence.file("p", "saved-evidence", root, "README.md", "text/plain", 0);
  const citations = [{ source: reference(source), selector: { kind: "text-range" as const, start: 0, end: source.value.content.length } }];
  const pieces = ["Publish only a complete validated output", "Reject invalid input without publishing a result"].map((decision, index) =>
    checkpoint(store, draft, question, { action: "checkpoint", question: question.id,
      value: { action: "answer", question: question.id, value: { applicability: "applicable", reason: "A local stateless transformation",
        facts: [], designs: [{ id: `saved-design-${index}`, decision, benefit: "One valid consumer result", consumer: "compilation" }], gaps: [],
        ...(question.value.spec.basisContract === "typed-v1" ? { documents: [] } : {}) }, citations } as unknown as Json,
      citations, unresolved: ["Combine the saved findings"] }));
  const settings: ReaderPilotSettings = { experimental: true, active: true, stopAfter: "L2",
    reader: { actor: "reader", model: "fixture", effort: "high", speed: "inherited", command }, agentCommand: command,
    maxRequestChars: 100_000, maxReadChars: 20_000, maxReplyChars: 10_000,
    maxCalls: 20, maxReportedTokens: 100_000, maxContinuationChars: 100_000,
    planning: { fields: [question.value.spec.field], maxRequestChars: 100_000, maxRounds: 5 } };
  const enable = () => {
    const pilot = engine.execute({ type: "configure-reader-pilot", project: "p", expected: 0, settings }) as Revision<ReaderPilot>;
    if (level === "R2") {
      configurePhasePolicy(store, "p", "compilation", "saved-recovery", 0);
      // Explicit synthetic calibration of this deterministic local adapter only.
      const env = pilotEnvironment(engine.environments.get("p").value, pilot.value);
      for (const [purpose, role] of [["analyst", env.implementer], ["assessor", env.reviewer]] as const) {
        store.write<ModelCall>({ id: `model-call:fixture-${purpose}`, kind: "model-call", expected: 0,
          value: { projectId: "p", draftId: "fixture", purpose, requestId: `fixture-${purpose}`,
            startedAt: 0, finishedAt: 1, status: "succeeded", requested: role,
            confirmed: { model: null, effort: null, speed: null }, request: { chars: 1000, bytes: 1000, hash: hashJson(purpose) },
            response: null, usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 0, reasoningOutputTokens: 0 },
            usageSource: "adapter", error: null } });
      }
    }
  };
  const configure = () => engine.execute({ type: "configure-saved-synthesis", project: "p", question: question.id, expected: 0 });
  const calls = () => existsSync(wire) ? readFileSync(wire, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, store, engine, draft, question, source, pieces, settings, enable, configure, calls };
}

test("saved R2 checkpoints reach an assessed answer through the product command without a reader or planner", async t => {
  const f = fixture(t); f.enable();
  const saved = f.configure() as Revision<{ checkpoints: unknown[] }>;
  assert.deepEqual(saved.value.checkpoints, f.pieces.map(reference).sort((a, b) => a.id.localeCompare(b.id)));
  const sourcesBefore = f.store.list("source").map(reference);
  const run = await f.engine.researcher.run("p", f.draft.id, 1);
  const answered = f.store.get<Question>(f.question.id)!;
  assert.equal(answered.value.status, "answered", JSON.stringify(run.value));
  assert.equal(run.value.turns, 1);
  assert.equal(f.calls().length, 2, "One synthesis and one assessment finish the saved question");
  assert.deepEqual(f.store.list<ModelCall>("model-call").filter(c => c.value.draftId === f.draft.id).map(c => c.value.purpose).sort(), ["analyst", "assessor"]);
  assert.equal(f.calls().filter(c => c.subject.role === "reader" || c.subject.dispatchMode === "planning").length, 0);
  assert.equal(f.store.list("reader-result").length, 0);
  assert.deepEqual(f.store.list("source").map(reference), sourcesBefore, "Recovery does not re-register or re-read sources");
  const report = f.store.get<DiscoveryDraft>(f.draft.id)!.value.fields[f.question.value.spec.field] as { designs: { id: string }[] };
  assert.deepEqual(report.designs.map(design => design.id).sort(), ["saved-design-0", "saved-design-1"]);
});

test("saved-only R2 rejects need_research without buying a reading or accepting a partial answer", async t => {
  const f = fixture(t, "need-research"); f.enable(); f.configure();
  const run = await f.engine.researcher.run("p", f.draft.id, 1);
  assert.equal(run.value.status, "paused"); assert.equal(run.value.pauseCode, "research_saved_only");
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, "open");
  assert.deepEqual(f.store.list<ModelCall>("model-call").filter(c => c.value.draftId === f.draft.id).map(c => c.value.purpose), ["analyst"]);
  assert.equal(f.store.list("reader-result").length, 0);
});

test('saved synthesis exposes direct verified observation addresses and refuses stale/foreign checkpoint reads',t=>{
 const f=fixture(t);f.enable();f.configure();
 const materials=savedSynthesisMaterials(f.store,f.draft,f.question)!;
 const address=materials[0]!.value.evidence[0]!.original;
 const read=readPilotContext(f.store,f.draft,address.record,address.pointer,20000) as any;
 assert.deepEqual(read.value,(f.pieces[0]!.value as any).observations[0]);
 assert.ok(!address.pointer.includes('directReadings'));
 assert.throws(()=>readPilotContext(f.store,f.draft,{...address.record,hash:'0'.repeat(64)},address.pointer,20000));
 assert.throws(()=>readPilotContext(f.store,{...f.draft,value:{...f.draft.value,projectId:'foreign'}},address.record,address.pointer,20000));
 writeFileSync(join(f.root,'README.md'),'Source changed after the paid checkpoint');
 assert.throws(()=>savedSynthesisMaterials(f.store,f.draft,f.question),{code:'synthesis_evidence_stale'});
 assert.throws(()=>readPilotContext(f.store,f.draft,address.record,address.pointer,20000),{code:'research_evidence_stale'});
 assert.equal(f.calls().length,0);
});

for (const pilot of ["absent", "disabled"] as const) test(`saved synthesis refuses an ${pilot} pilot before any model call`, async t => {
  const f = fixture(t, "answer", "R1");
  if (pilot === "disabled") f.engine.execute({ type: "configure-reader-pilot", project: "p", expected: 0,
    settings: { ...f.settings, active: false } });
  f.configure();
  const run = await f.engine.researcher.run("p", f.draft.id, 1);
  assert.equal(run.value.status, "paused"); assert.equal(run.value.pauseCode, "reader_pilot_required");
  assert.equal(f.store.list("model-call").length, 0); assert.equal(f.calls().length, 0);
  assert.equal(f.store.get<Question>(f.question.id)!.value.status, "open");
});

test("saved-synthesis product command rejects missing fields, foreign project/question and concurrent configuration", t => {
  const f = fixture(t, "answer", "R1");
  f.engine.execute({ type: "create-project", project: "other", title: "Other" });
  const command = { type: "configure-saved-synthesis", project: "p", question: f.question.id, expected: 0 };
  for (const key of ["project", "question", "expected"] as const) {
    const missing: Record<string, unknown> = { ...command }; delete missing[key];
    assert.throws(() => f.engine.execute(missing), { code: "command_invalid" });
  }
  assert.throws(() => f.engine.execute({ ...command, project: "missing" }), { code: "project_missing" });
  assert.throws(() => f.engine.execute({ ...command, project: "other" }), { code: "research_question_foreign" });
  assert.throws(() => f.engine.execute({ ...command, question: "missing" }), { code: "research_question_foreign" });
  assert.equal(f.store.list("saved-synthesis").length, 0);
  f.configure();
  assert.throws(() => f.configure(), { code: "revision_conflict" });
  assert.equal(f.store.list("saved-synthesis").length, 1);
});

// DR3a3-S4 (№7690 §3 S4): the v1 saved-only command, its address and reader are a neighbour of the new
// configure-v7-saved-synthesis — they keep their contract, and the new command never reads or writes them.
test("S4 v6 neighbour: the v1 saved-only command and reader keep their contract beside configure-v7-saved-synthesis", t => {
  const f = fixture(t, "answer", "R1");
  const saved = f.configure() as Revision<unknown>;
  assert.equal(saved.id, `saved-synthesis:${f.question.id}`);
  const materials = savedSynthesisMaterials(f.store, f.draft, f.question);
  assert.ok(materials && materials.length > 0);
  for (const subject of [undefined, null, f.question.id,
    { contract: "v7-plan-subject/v1", planAnswer: reference(f.question), planQuestionId: "result" }]) {
    const command: Record<string, unknown> = { type: "configure-v7-saved-synthesis", project: "p", expected: 0 };
    if (subject !== undefined) command.subject = subject;
    assert.throws(() => f.engine.execute(command), { code: "research_plan_subject_invalid" }, JSON.stringify(subject));
  }
  assert.deepEqual(f.store.list("saved-synthesis").map(row => reference(row)), [reference(saved)]);
  assert.deepEqual(savedSynthesisMaterials(f.store, f.draft, f.question), materials);
});
