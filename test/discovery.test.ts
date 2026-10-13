import { replaceFoundationCopies } from '../src/discovery/continuation-packet.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Discovery } from "../src/discovery/discovery.js";
import { reference, STAGES, type Ref, type StageValidators, type StageValidator } from "../src/pipeline/contracts.js";
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

// ── D8.4.2 (договор №2230): общий исторический читатель принятого research-ответа ──

import { ProductEngine } from "../src/product/engine.js";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonical, hashJson } from "../src/canonical.js";
import type { Write } from "../src/storage/store.js";
import type { ResearchAnswer, ResearchAssessment, ResearchTurn } from "../src/discovery/research-model.js";
import { acceptanceBindingId, managedAnswerId, managedAnswerTurn,
  type ResearchAcceptanceBinding } from "../src/discovery/research-consumer-transition.js";
import { readAcceptedResearchAnswer, type Question } from "../src/discovery/discovery.js";
import { readResearchAcceptanceBinding, readResearchConsumerTurn } from "../src/discovery/response-recovery.js";
import { reuseResearch } from "../src/discovery/research-reuse.js";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/** A real managed acceptance through the paid runner: scripted adapter answers the draft's
 * question, the assessor supports, Discovery writes the answer at its managed address with K. */
function managedAnswerFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-d842-"));
  const database = join(root, "state.sqlite");
  const store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "p", title: "D8.4.2 acceptance" });
  const source = engine.discovery.evidence.document("p", "proof", "Grounded local condition", "text/plain", 0);
  const adapter = join(root, "adapter.mjs");
  writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:s.questions[0].id,value:{ok:true},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:24}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  engine.environments.configure("p", { workspace: root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 5000 }, 0);
  const draft = engine.discovery.create("p", "discovery", "R0", "compilation",
    [{ field: "result", kind: "design", prompt: "Resolve result", risk: "Missing source", schema: { type: "object" } }]);
  return { root, database, store, engine, source, draft };
}
type ManagedFixture = ReturnType<typeof managedAnswerFixture>;
async function produceManaged(f: ManagedFixture) {
  const run = await f.engine.researcher.run("p", f.draft.id, 1);
  assert.equal(run.value.status, "completed", JSON.stringify(run.value));
  const turn = f.store.list<ResearchTurn>("research-turn")
    .filter(row => row.id.startsWith("research-turn:v1:")).sort((a, b) => a.value.number - b.value.number)[0]!;
  const binding = f.store.get<ResearchAcceptanceBinding>(acceptanceBindingId("p", turn.id))!;
  const answer = f.store.get<ResearchAnswer>(binding.value.answer.id, binding.value.answer.revision)!;
  return { turn, binding, answer,
    answerRef: reference(answer), assessmentRef: binding.value.assessment, bindingRef: reference(binding) };
}
function rawWrite(database: string, id: string, revision: number, value: unknown): void {
  const raw = new DatabaseSync(database);
  try {
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?")
      .run(canonical(value), hashJson(value), id, revision);
  } finally { raw.close(); }
}
function rawDrop(database: string, id: string): void {
  const raw = new DatabaseSync(database);
  try {
    raw.exec("PRAGMA foreign_keys=OFF");
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_delete");
    raw.prepare("DELETE FROM revisions WHERE entity_id=?").run(id);
    raw.prepare("DELETE FROM heads WHERE entity_id=?").run(id);
  } finally { raw.close(); }
}
const bindingInvalid = code("research_acceptance_binding_invalid");

test("D8.4.2 R1 R9: a managed answer is proven by its own K and reads the same after a Store reopen; a legacy UUID answer keeps its contract", async t => {
  const f = managedAnswerFixture(t);
  const produced = await produceManaged(f);
  assert.equal(produced.answer.id, managedAnswerId("p", produced.turn.id), "the answer sits at its turn's managed address");
  const proven = readAcceptedResearchAnswer(f.store, "p", produced.answerRef);
  assert.equal(proven.binding?.id, produced.binding.id);
  assert.equal(proven.assessment?.id, produced.assessmentRef.id);
  // Consumers of the same acceptance: observations and gate.
  assert.ok(f.engine.discovery.observations(produced.binding.value.questionBefore.id).length > 0);
  assert.deepEqual(f.engine.discovery.gate("p", reference(f.store.get(produced.binding.value.draftAfter.id)!)).findings, []);
  assert.ok(f.engine.discovery.gate("p", reference(f.store.get(produced.binding.value.draftAfter.id)!)).guards
    .some(ref => ref.id === produced.binding.id), "gate carries the exact K among its bases");
  f.store.close();
  const reopened = new Store(f.database);
  t.after(() => reopened.close());
  const again = readAcceptedResearchAnswer(reopened, "p", produced.answerRef);
  assert.equal(again.binding?.id, produced.binding.id, "the provenance survives a reopen");
  // R9: a legacy standalone answer (no managed context) reads by its own contract, without K.
  const legacy = fixture(t);
  const legacyDraft = legacy.discovery.create("p", "discovery", "R0", "concept",
    [{ field: "result", kind: "design", prompt: "R", risk: "r", schema: { type: "object" } }]);
  const legacyQuestion = legacy.store.get(legacyDraft.value.questions[0]!)!;
  const legacyBody = { projectId: "p", question: reference(legacyQuestion), value: { ok: true },
    observations: [legacy.discovery.evidence.observe("p",
      reference(legacy.discovery.evidence.document("p", "src", "the evidence", "text/plain", 0)),
      { kind: "text-range" as const, start: 0, end: 12 })],
    verdict: "supported" as const, reasons: [], researcher: "a", assessor: "b",
    environment: reference(legacy.store.write({ id: "environment:p", kind: "environment", expected: 0,
      value: { projectId: "p" } })) };
  const assessment = legacy.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(legacyBody)}`, kind: "research-assessment", expected: 0, value: legacyBody });
  legacy.discovery.researched(legacyQuestion.id, legacyQuestion.revision, reference(assessment));
  const legacyAnswer = legacy.store.get<ResearchAnswer>(legacy.store.get<Question>(legacyQuestion.id)!.value.answer!.id)!;
  assert.ok(legacyAnswer.id.startsWith(`research-answer:p:`) && !legacyAnswer.id.includes("managed-"));
  const legacyRead = readAcceptedResearchAnswer(legacy.store, "p", reference(legacyAnswer));
  assert.equal(legacyRead.binding, null, "a legacy answer is never attributed a managed K");
  assert.equal(legacyRead.assessment?.id, assessment.id);
});

test("D8.4.2 R2: the K-written/T-pending window reads the made acceptance historically, without a completed turn or another acceptance", async t => {
  const f = managedAnswerFixture(t);
  // Crash right after the atomic acceptance write: K exists, the turn is never completed. A plain
  // (crash-class) error is paused by the runner — the run does not lose the made acceptance.
  const original = f.store.writeMany.bind(f.store);
  let crashed = false;
  f.store.writeMany = ((writes: Write[], guards: never) => {
    const rows = original(writes, guards);
    if (!crashed && writes.some(write => write.kind === "research-acceptance-binding")) {
      crashed = true;
      throw new Error("fixture crash after the durable acceptance write");
    }
    return rows;
  }) as typeof f.store.writeMany;
  const run = await f.engine.researcher.run("p", f.draft.id, 1);
  assert.ok(crashed, "the hook fired at the acceptance write");
  assert.equal(run.value.status, "paused", "the crash pauses the run mid-window");
  f.store.writeMany = original;
  const turn = f.store.list<ResearchTurn>("research-turn").filter(row => row.id.startsWith("research-turn:v1:"))[0]!;
  assert.equal(f.store.get<ResearchTurn>(turn.id)!.value.status, "pending", "the turn was never completed");
  const binding = f.store.get<ResearchAcceptanceBinding>(acceptanceBindingId("p", turn.id))!;
  const answer = f.store.get<ResearchAnswer>(binding.value.answer.id)!;
  const proven = readAcceptedResearchAnswer(f.store, "p", reference(answer));
  assert.equal(proven.binding?.id, binding.id, "the acceptance is readable in the K→T window");
  assert.equal(readResearchAcceptanceBinding(f.store, "p", turn.id)?.binding.id, binding.id);
});

test("D8.4.2 R3 R12: only the K of the turn named by the answer address proves it; a foreign link refuses; reads are stable across stores", async t => {
  const f = managedAnswerFixture(t);
  const produced = await produceManaged(f);
  // A same-value answer at another (legacy) address exists lawfully elsewhere.
  const stray = f.store.write<ResearchAnswer>({ id: `research-answer:p:${hashJson(["stray", produced.answer.id])}`,
    kind: "research-answer", expected: 0, value: produced.answer.value });
  rawWrite(f.database, produced.binding.id, 1, { ...produced.binding.value, answer: reference(stray) });
  assert.throws(() => readAcceptedResearchAnswer(f.store, "p", produced.answerRef), bindingInvalid,
    "a K naming another answer does not prove this one");
  rawWrite(f.database, produced.binding.id, 1, produced.binding.value);
  assert.equal(readAcceptedResearchAnswer(f.store, "p", produced.answerRef).binding?.id, produced.binding.id);
  const other = new Store(f.database);
  t.after(() => other.close());
  assert.equal(readAcceptedResearchAnswer(other, "p", produced.answerRef).assessment?.id, produced.assessmentRef.id);
});

test("D8.4.2 R4: a substituted assessment (verdict/value/observations/actors, recomputed hash) is refused by the common derivation before use", async t => {
  const f = managedAnswerFixture(t);
  const produced = await produceManaged(f);
  const assessment = f.store.get<ResearchAssessment>(produced.assessmentRef.id)!;
  for (const damage of [
    { verdict: "insufficient" as const },
    { value: { ok: false } },
    { observations: [] },
    { assessor: assessment.value.researcher },
  ]) {
    rawWrite(f.database, assessment.id, 1, { ...assessment.value, ...damage });
    assert.throws(() => readAcceptedResearchAnswer(f.store, "p", produced.answerRef),
      (error: unknown) => error instanceof EngineError && error.code.startsWith("research_"));
    assert.ok(f.engine.discovery.gate("p", reference(f.store.get(produced.binding.value.draftAfter.id)!)).findings
      .some(finding => finding.code.startsWith("research_")), `gate refuses the damage: ${JSON.stringify(damage)}`);
    rawWrite(f.database, assessment.id, 1, assessment.value);
  }
});

test("D8.4.2 R5: a lost or damaged K, B or M is an addressed refusal without fallback, cold and hot", async t => {
  const f = managedAnswerFixture(t);
  const produced = await produceManaged(f);
  const b = `research-assessment-binding:v1:${hashJson({ projectId: "p", turnId: produced.turn.id })}`;
  const m = `assessment-paid-origin:v1:${hashJson({ projectId: "p", turnId: produced.turn.id })}`;
  for (const id of [produced.binding.id, b, m]) {
    const lostRow = f.store.get(id)!, lost = lostRow.value, kind = lostRow.kind;
    rawDrop(f.database, id);
    assert.throws(() => readAcceptedResearchAnswer(f.store, "p", produced.answerRef),
      (error: unknown) => error instanceof EngineError && error.code.startsWith("research_"), `${id} lost`);
    const cold = new Store(f.database);
    t.after(() => cold.close());
    assert.throws(() => readAcceptedResearchAnswer(cold, "p", produced.answerRef),
      (error: unknown) => error instanceof EngineError && error.code.startsWith("research_"), `${id} lost (cold)`);
    const head = f.store.get(produced.binding.value.draftAfter.id)!;
    assert.ok(f.engine.discovery.gate("p", reference(head)).findings.some(finding => finding.code.startsWith("research_")));
    // Restore the exact record (same bytes) for the next variant.
    const raw = new DatabaseSync(f.database);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
      raw.prepare("INSERT INTO revisions(entity_id, revision, kind, body, sha256) VALUES (?, 1, ?, ?, ?)")
        .run(id, kind, canonical(lost), hashJson(lost));
      raw.prepare("INSERT INTO heads(entity_id, revision) VALUES (?, 1)").run(id);
    } finally { raw.close(); }
    assert.equal(readAcceptedResearchAnswer(f.store, "p", produced.answerRef).binding?.id, produced.binding.id);
  }
});

test("D8.4.2 R6: the managed address is recognized only in its exact form", async t => {
  const f = managedAnswerFixture(t);
  const produced = await produceManaged(f);
  const turnId = produced.turn.id;
  assert.equal(managedAnswerTurn(managedAnswerId("p", turnId), "p"), turnId);
  assert.throws(() => managedAnswerTurn(produced.answer.id, "other-project"), bindingInvalid, "another project's managed address is a refusal, not another era (№2276-4)");
  const legacy = `research-answer:p:6f2e9d1c-0000-4000-8000-000000000000`;
  assert.equal(managedAnswerTurn(legacy, "p"), null, "a UUID address stays legacy");
  assert.throws(() => managedAnswerTurn(`research-answer:p:managed-v2:${turnId}`, "p"), bindingInvalid, "unknown reserved version");
  assert.throws(() => managedAnswerTurn("research-answer:p:managed-v1:", "p"), bindingInvalid, "empty turn");
  // A record at a managed address whose turn has no K is refused, not scanned.
  const forged = f.store.write<ResearchAnswer>({ id: managedAnswerId("p", `research-turn:v1:${hashJson(["never", 99])}`),
    kind: "research-answer", expected: 0, value: produced.answer.value });
  assert.throws(() => readAcceptedResearchAnswer(f.store, "p", reference(forged)), bindingInvalid);
});

test("D8.4.2 R7: after acceptance, moved Source/environment heads keep the made acceptance historical; today's gate gives its own stale finding", async t => {
  const f = managedAnswerFixture(t);
  const produced = await produceManaged(f);
  const draftAfter = f.store.get(produced.binding.value.draftAfter.id)!;
  // Move the exact evidence source: today's gate refuses new work on it; the made acceptance stays proven.
  f.engine.discovery.evidence.document("p", "proof", "Grounded local condition — extended", "text/plain",
    f.source.revision);
  const proven = readAcceptedResearchAnswer(f.store, "p", produced.answerRef);
  assert.equal(proven.binding?.id, produced.binding.id, "history does not depend on today's heads");
  const findings = f.engine.discovery.gate("p", reference(draftAfter)).findings;
  assert.ok(findings.some(finding => finding.code === "research_evidence_stale"),
    "the current admission refuses on today's moved source");
});

test("D8.4.2 R10 R11: reuse of a managed source is proven before the rebound; a damaged source or a reusedFrom cycle refuses", async t => {
  const f = managedAnswerFixture(t);
  const produced = await produceManaged(f);
  // Lawful reuse of the managed answer into a fresh equal draft.
  const second = f.engine.discovery.create("p", "discovery", "R0", "compilation",
    [{ field: "result", kind: "design", prompt: "Resolve result", risk: "Missing source", schema: { type: "object" } }]);
  const reused = reuseResearch(f.store, f.engine.discovery, second, reference(f.store.get("environment:p")!));
  assert.equal(reused, 1, "the proven managed source is reused");
  const rebound = f.store.list<ResearchAssessment>("research-assessment")
    .find(row => row.value.reusedFrom?.id === produced.assessmentRef.id)!;
  assert.ok(rebound.value.reusedFrom, "the rebound names its source");
  const answered = f.store.get<Question>(second.value.questions[0]!)!;
  // №2276-4: the address parser answers only for research-answer addresses (an assessment id is a typed refusal);
  // the rebound's own answer sits at a legacy address — it is not a managed record and inherits no B/M/K.
  assert.throws(() => managedAnswerTurn(rebound.id, "p"), bindingInvalid, "an assessment id is not a research-answer address");
  assert.equal(managedAnswerTurn(answered.value.answer!.id, "p"), null, "the rebound is not a managed record and inherits no B/M/K");
  assert.equal(answered.value.status, "answered");
  const reboundAnswer = f.store.get<ResearchAnswer>(answered.value.answer!.id)!;
  assert.ok(!reboundAnswer.id.includes("managed-"), "the reuse acceptance is the standalone legacy route");
  assert.equal(readAcceptedResearchAnswer(f.store, "p", reference(reboundAnswer)).binding, null);
  // A source whose accepted-answer chain was damaged refuses before any rebound is written.
  const damaged = managedAnswerFixture(t);
  const produced2 = await produceManaged(damaged);
  rawWrite(damaged.database, produced2.answer.id, 1, { ...produced2.answer.value, value: { ok: false } });
  const second2 = damaged.engine.discovery.create("p", "discovery", "R0", "compilation",
    [{ field: "result", kind: "design", prompt: "Resolve result", risk: "Missing source", schema: { type: "object" } }]);
  assert.throws(() => reuseResearch(damaged.store, damaged.engine.discovery, second2, reference(damaged.store.get("environment:p")!)),
    (error: unknown) => error instanceof EngineError && error.code.startsWith("research_"), "a damaged source answer refuses");
  assert.equal(damaged.store.list<ResearchAssessment>("research-assessment").filter(row => row.value.reusedFrom).length, 0, "no rebound was written");
  // Restore the answer; then the lost K refuses the reuse just the same.
  rawWrite(damaged.database, produced2.answer.id, 1, produced2.answer.value);
  rawDrop(damaged.database, produced2.binding.id);
  const second3 = damaged.engine.discovery.create("p", "discovery", "R0", "compilation",
    [{ field: "result", kind: "design", prompt: "Resolve result", risk: "Missing source", schema: { type: "object" } }]);
  assert.throws(() => reuseResearch(damaged.store, damaged.engine.discovery, second3, reference(damaged.store.get("environment:p")!)),
    bindingInvalid, "a lost K refuses the reuse");
  // A cyclic reusedFrom chain refuses: a legacy standalone source whose chain closes.
  const legacyDraft = damaged.engine.discovery.create("p", "discovery", "R0", "concept",
    [{ field: "result", kind: "design", prompt: "Resolve result", risk: "Missing source", schema: { type: "object" } }]);
  const legacyQuestion = damaged.store.get<Question>(legacyDraft.value.questions[0]!)!;
  const legacyBody = { projectId: "p", question: reference(legacyQuestion), value: { ok: true },
    observations: [damaged.engine.discovery.evidence.observe("p", reference(damaged.source), { kind: "text-range" as const, start: 0, end: 24 })],
    verdict: "supported" as const, reasons: [], researcher: "a", assessor: "b",
    environment: reference(damaged.store.get("environment:p")!) };
  const linkB = `research-assessment:${hashJson(["cycle-b"])}`;
  damaged.store.write<ResearchAssessment>({ id: linkB, kind: "research-assessment", expected: 0, value: legacyBody });
  const linkA = `research-assessment:${hashJson(["cycle-a"])}`;
  damaged.store.write<ResearchAssessment>({ id: linkA, kind: "research-assessment", expected: 0,
    value: { ...legacyBody, reusedFrom: reference(damaged.store.get<ResearchAssessment>(linkB)!) } });
  damaged.engine.discovery.researched(legacyQuestion.id, legacyQuestion.revision,
    reference(damaged.store.get<ResearchAssessment>(linkA)!));
  rawWrite(damaged.database, linkB, 1, { ...legacyBody, reusedFrom: reference(damaged.store.get<ResearchAssessment>(linkA)!) });
  const fourth = damaged.engine.discovery.create("p", "discovery", "R0", "concept",
    [{ field: "result", kind: "design", prompt: "Resolve result", risk: "Missing source", schema: { type: "object" } }]);
  assert.throws(() => reuseResearch(damaged.store, damaged.engine.discovery, fourth, reference(damaged.store.get("environment:p")!)),
    code("research_reuse_source_invalid"), "a cyclic or lost source chain refuses");
});

// ── D8.4.2 круг 2 (вердикт №2276): четыре класса — эра, адрес, цепочка rebound, managed-слой ──

const PREDECESSOR_LOADER = String.raw`
import ts from TYPESCRIPT;
import { execFileSync } from 'node:child_process';
let root, repository, baseline;
export function initialize(data) { root = data.root; repository = data.repository; baseline = data.baseline; }
export async function load(url, context, nextLoad) {
  if (url.startsWith(root) && url.endsWith('.js')) {
    const path = decodeURIComponent(url.slice(root.length)).replace(/\.js$/, '.ts');
    const body = execFileSync('git', ['show', baseline + ':' + path], { cwd: repository, encoding: 'utf8', maxBuffer: 10_000_000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(body,
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return nextLoad(url, context);
}
`;
const PREDECESSOR_SCENARIO = String.raw`
import { register } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config = CONFIG;
register(config.loader, { data: { root: config.dist, repository: config.repository, baseline: config.baseline } });
const { Store } = await import(config.dist + 'src/storage/store.js');
const { ProductEngine } = await import(config.dist + 'src/product/engine.js');
const root = join(config.directory, 'predecessor'); mkdirSync(root, { recursive: true });
const database = join(root, 'state.sqlite');
const store = new Store(database), engine = new ProductEngine(store);
engine.execute({ type: 'create-project', project: 'p', title: 'Predecessor producer' });
const source = engine.discovery.evidence.document('p', 'proof', 'Grounded local condition', 'text/plain', 0);
const sourceRef = { id: source.id, revision: source.revision, hash: source.hash };
const adapter = join(root, 'adapter.mjs');
writeFileSync(adapter, "import{readFileSync}from'node:fs';\nconst r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;\n"
  + "const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}:{action:'answer',question:s.questions[0].id,value:{ok:true},citations:[{source:"
  + JSON.stringify(sourceRef) + ",selector:{kind:'text-range',start:0,end:24}}]};\n"
  + "console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));\n");
const command = { executable: process.execPath, args: [adapter] };
engine.environments.configure('p', { workspace: root, implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
  reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 5000 }, 0);
const draft = engine.discovery.create('p', 'discovery', 'R0', 'compilation',
  [{ field: 'result', kind: 'design', prompt: 'Resolve result', risk: 'Missing source', schema: { type: 'object' } }]);
const run = await engine.researcher.run('p', draft.id, 1);
const turn = store.list('research-turn')[0];
console.log(JSON.stringify({ database, draft: draft.id, status: run.value.status, calls: store.list('model-call').length,
  turn: { id: turn.id, revision: turn.revision, hash: turn.hash } }));
store.close();
`;

test("D8.4.2-2 P2-1 (№2276-1): a K of the accepted D8.4e producer (c60be08, UUID answer) keeps its full contract; the new producer alone writes the managed address", async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "omg-d842-predecessor-")));
  const stores: Store[] = [];
  t.after(() => { for (const db of stores) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const loaderFile = join(directory, "predecessor-loader.mjs"), script = join(directory, "predecessor.mjs");
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  const dist = pathToFileURL(fileURLToPath(new URL("../", import.meta.url))).href;
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  writeFileSync(loaderFile, PREDECESSOR_LOADER.replace("TYPESCRIPT", JSON.stringify(typescript)));
  writeFileSync(script, PREDECESSOR_SCENARIO.replace("CONFIG", JSON.stringify({ directory, repository, dist,
    loader: pathToFileURL(loaderFile).href, baseline: "c60be084c9f002762e4784e12b6914d7ff770c76" })));
  const output = execFileSync(process.execPath, [script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n").at(-1)!;
  const produced = JSON.parse(output) as { database: string; draft: string; status: string; calls: number; turn: Ref };
  assert.equal(produced.status, "completed", output);
  const db = new Store(produced.database); stores.push(db);
  const proven = readResearchAcceptanceBinding(db, "p", produced.turn.id);
  assert.ok(proven, "the previous era's K proves under the previous full contract");
  assert.equal(readResearchConsumerTurn(db, produced.turn).value.status, "completed");
  const answerRef = proven.binding.value.answer;
  assert.equal(managedAnswerTurn(answerRef.id, "p"), null, "the previous producer's answer is a UUID address");
  assert.notEqual(answerRef.id, managedAnswerId("p", produced.turn.id));
  const read = readAcceptedResearchAnswer(db, "p", answerRef);
  assert.equal(read.binding, null, "consumers read the previous era by its own contract, without attributing K");
  assert.equal(read.assessment?.id, proven.binding.value.assessment.id);
  const question = db.get<Question>(proven.binding.value.questionBefore.id)!;
  assert.ok(new Discovery(db).observations(question.id).length > 0);
  assert.deepEqual(new ProductEngine(db).discovery.gate("p", reference(db.get(proven.binding.value.draftAfter.id)!)).findings, []);
  assert.equal(db.list("model-call").length, produced.calls);
  // The same K with its answer moved to a managed address of ANOTHER turn is refused by the shared projection.
  const forgedId = managedAnswerId("p", `research-turn:v1:${hashJson(["other", 1])}`);
  const forgedAnswer = db.write<ResearchAnswer>({ id: forgedId, kind: "research-answer", expected: 0,
    value: db.get<ResearchAnswer>(answerRef.id, answerRef.revision)!.value });
  rawWrite(produced.database, proven.binding.id, 1, { ...proven.binding.value, answer: reference(forgedAnswer) });
  const cold = new Store(produced.database); stores.push(cold);
  assert.throws(() => readResearchAcceptanceBinding(cold, "p", produced.turn.id), bindingInvalid);
  rawWrite(produced.database, proven.binding.id, 1, proven.binding.value);
  // The current producer writes the managed address and its K names it exactly.
  const f = managedAnswerFixture(t), current = await produceManaged(f);
  assert.equal(current.answer.id, managedAnswerId("p", current.turn.id));
});

test("D8.4.2-2 P2-4 (№2276-4): the managed address is parsed strictly — another project, an unknown version, a broken or non-canonical encoding, a non-turn tail are addressed refusals; a foreign or malformed record never downgrades to the previous era", async t => {
  const turnId = `research-turn:v1:${hashJson(["address", 1])}`;
  assert.equal(managedAnswerTurn(managedAnswerId("p", turnId), "p"), turnId);
  assert.equal(managedAnswerTurn("research-answer:p:6f2e9d1c-0000-4000-8000-000000000000", "p"), null, "a UUID address of this project is the previous era");
  const reason = (id: string, expected: string) => assert.throws(() => managedAnswerTurn(id, "p"),
    (error: unknown) => error instanceof EngineError && error.code === "research_acceptance_binding_invalid"
      && (error.details as { reason?: string })?.reason === expected, `${id} → ${expected}`);
  reason(managedAnswerId("other-project", turnId), "address-project");
  reason("research-answer:other-project:6f2e9d1c-0000-4000-8000-000000000000", "address-project");
  reason("research-answer:p:", "address-project");
  reason("research-answer:p:managed-v2:" + encodeURIComponent(turnId), "address-version");
  reason("research-answer:p:managed-v1", "address-version");
  reason("research-answer:p:managed-v1:", "address-turn");
  reason("research-answer:p:managed-v1:%", "address-encoding");
  reason("research-answer:p:managed-v1:" + turnId, "address-encoding");
  reason("research-answer:p:managed-v1:" + encodeURIComponent("not-a-turn"), "address-turn");
  reason("research-assessment:p:managed-v1:" + encodeURIComponent(turnId), "address-form");
  // Probe №2276 (463): a copy of this project's body at another project's managed address — after the loss of K —
  // is a refusal for the reader and a finding for the gate, never a legacy read.
  const f = managedAnswerFixture(t), p = await produceManaged(f);
  const foreign = f.store.write<ResearchAnswer>({ id: managedAnswerId("other-project", p.turn.id), kind: "research-answer", expected: 0, value: p.answer.value });
  const q = f.store.get<Question>(p.binding.value.questionBefore.id)!;
  f.store.write({ id: q.id, kind: q.kind, expected: q.revision, value: { ...q.value, answer: reference(foreign) } });
  rawDrop(f.database, p.binding.id);
  assert.throws(() => readAcceptedResearchAnswer(f.store, "p", reference(foreign)), bindingInvalid);
  assert.ok(f.engine.discovery.gate("p", reference(f.store.get(f.draft.id)!)).findings.some(item => item.code === "research_acceptance_binding_invalid"));
  // Probe №2276 (476): a malformed managed record at the public reader is a typed refusal, not a URIError.
  const malformed = f.store.write<ResearchAnswer>({ id: "research-answer:p:managed-v1:%", kind: "research-answer", expected: 0, value: p.answer.value });
  assert.throws(() => readAcceptedResearchAnswer(f.store, "p", reference(malformed)), bindingInvalid);
});

test("D8.4.2-2 P2-3 (№2276-3): a rebound proves its source chain to the end — the lost K of a managed source refuses the history, observations, gate and the next reuse; a source that is not the accepted assessment of its question refuses", async t => {
  const f = managedAnswerFixture(t), p = await produceManaged(f);
  const make = () => f.engine.discovery.create("p", "discovery", "R0", "compilation",
    [{ field: "result", kind: "design", prompt: "Resolve result", risk: "Missing source", schema: { type: "object" } }]);
  const second = make();
  assert.equal(reuseResearch(f.store, f.engine.discovery, second, reference(f.store.get("environment:p")!)), 1);
  const bq = f.store.get<Question>(second.value.questions[0]!)!, ba = f.store.get<ResearchAnswer>(bq.value.answer!.id)!;
  const chained = readAcceptedResearchAnswer(f.store, "p", reference(ba));
  assert.equal(chained.binding, null, "a rebound is a standalone acceptance without a K of its own");
  assert.equal(chained.assessment?.value.reusedFrom?.id, p.assessmentRef.id);
  // The managed source's question is reopened and its K is lost: the rebound's chain no longer derives.
  f.engine.discovery.reopen(p.binding.value.questionBefore.id, f.store.get<Question>(p.binding.value.questionBefore.id)!.revision);
  rawDrop(f.database, p.binding.id);
  assert.throws(() => readAcceptedResearchAnswer(f.store, "p", reference(ba)), bindingInvalid, "history: the source K is mandatory");
  assert.throws(() => f.engine.discovery.observations(bq.id), bindingInvalid, "observations prove the rebound source");
  const gate = f.engine.discovery.gate("p", reference(f.store.get(second.id)!));
  assert.ok(gate.findings.some(item => item.code === "research_acceptance_binding_invalid"), JSON.stringify(gate.findings));
  const before = f.store.list("research-assessment").length;
  assert.throws(() => reuseResearch(f.store, f.engine.discovery, make(), reference(f.store.get("environment:p")!)), bindingInvalid,
    "another reuse must not launder the lost source");
  assert.equal(f.store.list("research-assessment").length, before, "no new rebound");
  // A source that was never the accepted assessment of its exact question revision: the rebound formula holds, the
  // acceptance of the source does not.
  const legacy = fixture(t);
  const draftA = legacy.discovery.create("p", "discovery", "R0", "concept",
    [{ field: "result", kind: "design", prompt: "R", risk: "r", schema: { type: "object" } }]);
  const questionA = legacy.store.get<Question>(draftA.value.questions[0]!)!;
  const environment = legacy.store.write({ id: "environment:p", kind: "environment", expected: 0, value: { projectId: "p" } });
  const evidence = legacy.discovery.evidence.observe("p",
    reference(legacy.discovery.evidence.document("p", "src", "the evidence", "text/plain", 0)), { kind: "text-range" as const, start: 0, end: 12 });
  const body = (reasons: string[]) => ({ projectId: "p", question: reference(questionA), value: { ok: true }, observations: [evidence],
    verdict: "supported" as const, reasons, researcher: "a", assessor: "b", environment: reference(environment) });
  const acceptedBody = body([]), strayBody = body(["another assessor run"]);
  const acceptedAssessment = legacy.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(acceptedBody)}`, kind: "research-assessment", expected: 0, value: acceptedBody });
  const strayAssessment = legacy.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(strayBody)}`, kind: "research-assessment", expected: 0, value: strayBody });
  legacy.discovery.researched(questionA.id, questionA.revision, reference(acceptedAssessment));
  const draftB = legacy.discovery.create("p", "discovery", "R0", "concept",
    [{ field: "result", kind: "design", prompt: "R", risk: "r", schema: { type: "object" } }]);
  const questionB = legacy.store.get<Question>(draftB.value.questions[0]!)!;
  const reboundBody = { ...strayBody, question: reference(questionB), reusedFrom: reference(strayAssessment) };
  const rebound = legacy.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(reboundBody)}`, kind: "research-assessment", expected: 0, value: reboundBody });
  legacy.discovery.researched(questionB.id, questionB.revision, reference(rebound));
  const answerB = legacy.store.get<Question>(questionB.id)!.value.answer!;
  assert.throws(() => readAcceptedResearchAnswer(legacy.store, "p", answerB),
    (error: unknown) => error instanceof EngineError && error.code === "research_reuse_source_invalid"
      && (error.details as { reason?: string })?.reason === "source-assessment");
  assert.throws(() => legacy.discovery.observations(questionB.id), code("research_reuse_source_invalid"));
  // The lawful chain of the same shape reads: a rebound of the accepted assessment.
  const lawfulBody = { ...acceptedBody, question: reference(legacy.store.get<Question>(questionB.id)!), reusedFrom: reference(acceptedAssessment) };
  const lawfulRebound = legacy.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(lawfulBody)}`, kind: "research-assessment", expected: 0, value: lawfulBody });
  const reopened = legacy.discovery.reopen(questionB.id, legacy.store.get<Question>(questionB.id)!.revision);
  const lawful = { ...lawfulBody, question: reference(reopened) };
  const lawfulAssessment = legacy.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(lawful)}`, kind: "research-assessment", expected: 0, value: lawful });
  void lawfulRebound;
  legacy.discovery.researched(reopened.id, reopened.revision, reference(lawfulAssessment));
  const proven = readAcceptedResearchAnswer(legacy.store, "p", legacy.store.get<Question>(questionB.id)!.value.answer!);
  assert.equal(proven.assessment?.id, lawfulAssessment.id);
});



test('RS1 source reads clip requests and report addressed outside, while citations remain strict', t => {
  const { discovery } = fixture(t), evidence = discovery.evidence;
  const source = evidence.document('p', 'hx1', 'x'.repeat(137), 'text/plain', 0), ref = reference(source);
  for (const [start, end, outcome, served] of [
    [0, 200, 'clipped', { start: 0, end: 137 }], [2, 10, 'complete', { start: 2, end: 10 }],
    [137, 200, 'outside', null], [200, 300, 'outside', null],
  ] as const) {
    const result = evidence.readSource('p', ref, { start, end });
    assert.deepEqual([result.outcome, result.served, result.length, result.requested], [outcome, served, 137, { start, end }]);
    assert.equal(evidence.verifyReading(result), true);
    assert.equal(evidence.verifyReading({ ...result, length: 200 }), false);
    assert.equal(evidence.verifyReading({ ...result, value: 'invented' }), false);
    assert.equal(evidence.verifyReading({ ...result, contract: 'unknown' }), false);
    assert.equal(evidence.verifyReading({ ...result, served: undefined }), false);
    if (served) assert.equal(evidence.verify({ projectId: 'p', source: ref, selector: { kind: 'text-range', ...served }, value: result.value }), true);
  }
  assert.throws(() => evidence.observe('p', ref, { kind: 'text-range', start: 0, end: 200 }), code('selector_invalid'));
  for (const requested of [undefined as never, { start: -1, end: 10 }, { start: 2, end: 1 }, { start: 0, end: 0 }, { start: 0.5, end: 1 }])
    assert.throws(() => evidence.readSource('p', ref, requested), code('selector_invalid'));
  const empty = evidence.document('p', 'empty', '', 'text/plain', 0);
  assert.equal(evidence.readSource('p', reference(empty), { start: 0, end: 10 }).outcome, 'outside');
  assert.throws(() => evidence.readSource('foreign', ref, { start: 0, end: 1 }), code('source_missing'));
  evidence.document('p', 'hx1', 'changed', 'text/plain', 1);
  assert.throws(() => evidence.readSource('p', ref, { start: 0, end: 200 }), code('source_stale'));
});


test('RS1 continuation preserves both legacy observations and new read bytes equal to serialized foundation', t => {
  const { store, discovery } = fixture(t);
  const foundation = { long: 'foundation-data'.repeat(200) }, text = JSON.stringify(foundation);
  const source = discovery.evidence.document('p', 'foundation', text, 'text/plain', 0), ref = reference(source);
  const old = discovery.evidence.observe('p', ref, { kind: 'text-range', start: 0, end: text.length });
  const current = discovery.evidence.readSource('p', ref, { start: 0, end: text.length + 100 });
  for (const reading of [old, current]) assert.deepEqual(
    replaceFoundationCopies({ reading }, { core: foundation }, ref, store), { reading });
});
