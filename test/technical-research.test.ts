import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { preparedFeatures } from "./product-fixture.js";
import { answerTechnicalFixture } from "./technical-research-fixture.js";
import { reference } from "../src/pipeline/contracts.js";
import { git } from "../src/runtime/environment.js";
import type { DiscoveryDraft } from "../src/discovery/discovery.js";
import { TECHNICAL_RESEARCH, deferredGap, refinementQuestions } from "../src/graph/research-contracts.js";
import type { Json } from "../src/canonical.js";
import { exampleGraph } from "./graph-fixture.js";
import { reuseResearch } from "../src/discovery/research-reuse.js";
import { researchGraphContext } from "../src/discovery/research-context.js";

function fixture(t: test.TestContext, graph = exampleGraph("p")) {
  const root = mkdtempSync(join(tmpdir(), "omg-technical-")), workspace = join(root, "repo"); mkdirSync(workspace);
  git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "A new local stateless CLI transformation product.\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(join(root, "state.sqlite")); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, "p", graph);
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("p", { workspace, implementer: { actor: "worker", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 1000 }, 0);
  return { engine, store, workspace };
}
function finishR0(engine: ProductEngine) {
  const draft = engine.refinement.begin("p", "R0");
  engine.refinement.finishResearch("p", "R0", reference(draft), 0); engine.refinement.sealLayer("p", 1, 0);
  return draft;
}

test("R0 derives accepted roles, outcomes and journeys without questions or model calls and cannot be manually altered", t => {
  const { engine, store } = fixture(t);
  const before = store.list("question").length;
  const r0 = engine.refinement.begin("p", "R0");
  assert.equal(r0.value.questions.length, 0); assert.equal(store.list("question").length, before);
  assert.deepEqual(engine.refinement.begin("p", "R0"), r0);
  const completed = engine.refinement.finishResearch("p", "R0", reference(r0), 0);
  assert.deepEqual(engine.refinement.finishResearch("p", "R0", reference(r0), completed.revision), completed,
    "Reusing the same accepted research must not invalidate downstream phases with a new version");
  assert.ok(Array.isArray(r0.value.fields['actors']));
  assert.ok(Object.hasOwn(r0.value.fields['journeys'] as object, "crash_recovery"));
  const forged = store.write<DiscoveryDraft>({ id: r0.id, kind: r0.kind, expected: r0.revision,
    value: { ...r0.value, fields: { ...r0.value.fields, outcomes: [] } } });
  assert.ok(engine.discovery.gate("p", reference(forged)).findings.some(item => item.code === "derivation_conflict"));
  assert.throws(() => engine.refinement.finishResearch("p", "R0", reference(forged), 0), /unresolved or stale/);
});

test("R1 opens all technical domains and copied README bytes or manual ready declarations cannot close them", t => {
  const { engine, store, workspace } = fixture(t); finishR0(engine);
  const r1 = engine.refinement.begin("p", "R1");
  assert.equal(r1.value.questions.length, 9);
  const source = engine.discovery.evidence.file("p", "context", workspace, "README.md", "text/plain", 0);
  assert.throws(() => engine.discovery.fact(r1.value.questions[0]!, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length }), /preference requires/);
  for (const id of r1.value.questions) engine.discovery.decision(id, 1, "owner", {
    applicability: "applicable", reason: "An existing document was read", facts: [{ id: "read", claim: "Documentation exists", path: "README.md" }],
    designs: [], gaps: [],
  });
  assert.throws(() => engine.refinement.finishResearch("p", "R1", reference(store.get(r1.id)!), 0), /research_assessment_required/);
});

test("R1 forwards addressable next-level gaps to R2 and R2 cannot leave them unresolved", t => {
  const { engine, store } = fixture(t); finishR0(engine);
  const r1 = engine.refinement.begin("p", "R1");
  const gap = { id: "input-gap", target: "p-consume-operation", field: "ports", question: "Which validated input does the consumer require?",
    consumer: "p-consume-work", requiredFor: "next" as const };
  answerTechnicalFixture(engine, "p", r1, (field, report) => field === "integrations" ? { ...report, gaps: [gap] } : report);
  engine.refinement.finishResearch("p", "R1", reference(store.get(r1.id)!), 0); engine.refinement.sealLayer("p", 2, 0);
  const r2 = engine.refinement.begin("p", "R2");
  assert.equal(r2.value.questions.length, TECHNICAL_RESEARCH.R2.length + 1);
  const inherited = r2.value.questions.map(id => store.get<{ spec: { field: string; prompt: string } }>(id)!.value.spec).find(spec => spec.field.startsWith("gap_"))!;
  assert.match(inherited.prompt, /p-consume-operation\/ports/);
  answerTechnicalFixture(engine, "p", r2, (field, report) => field.startsWith("gap_") ? { ...report, gaps: [gap] } : report);
  assert.throws(() => engine.refinement.finishResearch("p", "R2", reference(store.get(r2.id)!), 0), /research_gap_unresolved/);
});

test("technical research cannot claim a nonexistent factual code path even with an accepted model assessment", t => {
  const { engine, store } = fixture(t); finishR0(engine);
  const r1 = engine.refinement.begin("p", "R1");
  answerTechnicalFixture(engine, "p", r1, (field, report) => field === "runtime" ? { ...report,
    facts: [{ id: "fake-path", claim: "This implementation exists", path: "not-created.ts" }] } : report);
  assert.throws(() => engine.refinement.finishResearch("p", "R1", reference(store.get(r1.id)!), 0), /repository_evidence_required/);
});

test("a version-one R0 declaration does not admit a new refinement sequence", t => {
  const { engine } = fixture(t);
  const old = engine.discovery.create("p", "om-g2", "R0", "compilation", [{ field: "rolesAndOutcome", kind: "decision",
    prompt: "Describe roles", risk: "Unknown roles", schema: { type: "string" } }]);
  const answer = engine.discovery.decision(old.value.questions[0]!, 1, "owner", "Roles are ready" as Json);
  assert.throws(() => engine.refinement.finishResearch("p", "R0", reference(answer), 0), /enriched contract/);
});

test("future gaps stay deferred only behind a complete sleeping connector and outside the current horizon", () => {
  const graph = exampleGraph("p"); graph.horizon = [];
  graph.anchors.push({ id: "future-input", owner: "p-produce-work", outcome: "p-data", test: graph.tests[0]!.id });
  graph.connectors[0]!.bindings[2]!.anchor = "future-input";
  graph.connectors[0]!.wakeTest = graph.tests[0]!.id;
  const gap = { id: "future", target: "p-produce-work", field: "code", question: "Which future code provides the output?",
    consumer: "p-consume-work", requiredFor: "next" as const };
  assert.equal(deferredGap(graph, gap), true);
  graph.horizon = ["p-consume-work"];
  assert.equal(deferredGap(graph, gap), false, "A current consumer cannot wait on unspecified future code");
  graph.horizon = []; graph.connectors[0]!.wakeTest = null;
  assert.equal(deferredGap(graph, gap), false, "A label alone cannot defer an obligation");
});

test("one field question preserves all distinct consumer obligations and has stable ordering", () => {
  const first = { id: "g1", target: "p-produce-block", field: "ports", question: "Which schema does consumer A require?", consumer: "p-consume-work", requiredFor: "next" as const };
  const second = { ...first, id: "g2", question: "Which version does consumer B require?", consumer: "p-consume-operation" };
  const forward = refinementQuestions("R2", [first, second]);
  assert.deepEqual(forward, refinementQuestions("R2", [second, first]));
  assert.equal(forward.length, TECHNICAL_RESEARCH.R2.length + 1);
  const question = forward.at(-1)!;
  assert.equal(question.targets?.length, 2);
  assert.match(question.prompt, /consumer A/); assert.match(question.prompt, /consumer B/);
});

test("activating a previously sleeping horizon gap invalidates R2 before L3 can be sealed", t => {
  const graph = exampleGraph("p"); graph.horizon = [];
  graph.anchors.push({ id: "future-input", owner: "p-produce-work", outcome: "p-data", test: graph.tests[0]!.id });
  graph.connectors[0]!.bindings[2]!.anchor = "future-input";
  graph.connectors[0]!.wakeTest = graph.tests[0]!.id;
  const { engine, store } = fixture(t, graph); finishR0(engine);
  const gap = { id: "future", target: "p-produce-block", field: "ports", question: "Which future input contract is required?",
    consumer: "p-consume-block", requiredFor: "next" as const };
  const r1 = engine.refinement.begin("p", "R1");
  answerTechnicalFixture(engine, "p", r1, (field, report) => field === "integrations" ? { ...report, gaps: [gap] } : report);
  engine.refinement.finishResearch("p", "R1", reference(store.get(r1.id)!), 0); engine.refinement.sealLayer("p", 2, 0);
  const r2 = engine.refinement.begin("p", "R2");
  assert.equal(r2.value.questions.length, TECHNICAL_RESEARCH.R2.length);
  answerTechnicalFixture(engine, "p", r2);
  const phase = engine.refinement.finishResearch("p", "R2", reference(store.get(r2.id)!), 0);
  assert.deepEqual(engine.refinement.gate("p", "R2").findings, []);
  const active = structuredClone(graph); active.horizon = ["p-produce-work", "p-consume-work"];
  engine.graphs.save("p", active, store.get("graph:p")!.revision, "owner");
  assert.ok(engine.refinement.gate("p", "R2").findings.some(item => item.code === "research_horizon_changed"));
  assert.throws(() => engine.refinement.sealLayer("p", 3, 0), /preceding refinement phase/);
  const refreshed = engine.refinement.begin("p", "R2");
  assert.equal(refreshed.value.questions.length, TECHNICAL_RESEARCH.R2.length + 1);
  answerTechnicalFixture(engine, "p", refreshed);
  engine.refinement.finishResearch("p", "R2", reference(store.get(refreshed.id)!), phase.revision);
  assert.deepEqual(engine.refinement.gate("p", "R2").findings, []);
  engine.refinement.sealLayer("p", 3, 0);
});

test("a deferred gap first found by R2 is re-researched when its consumer enters the horizon", t => {
  const graph = exampleGraph("p"); graph.horizon = [];
  graph.anchors.push({ id: "future-input", owner: "p-produce-work", outcome: "p-data", test: graph.tests[0]!.id });
  graph.connectors[0]!.bindings[2]!.anchor = "future-input"; graph.connectors[0]!.wakeTest = graph.tests[0]!.id;
  const { engine, store } = fixture(t, graph); finishR0(engine);
  const r1 = engine.refinement.begin("p", "R1"); answerTechnicalFixture(engine, "p", r1);
  engine.refinement.finishResearch("p", "R1", reference(store.get(r1.id)!), 0); engine.refinement.sealLayer("p", 2, 0);
  const gap = { id: "r2-future", target: "p-produce-block", field: "ports", question: "Which future input contract is required?",
    consumer: "p-consume-block", requiredFor: "next" as const };
  const r2 = engine.refinement.begin("p", "R2");
  answerTechnicalFixture(engine, "p", r2, (field, report) => field === "connectivityAndProof" ? { ...report, gaps: [gap] } : report);
  const phase = engine.refinement.finishResearch("p", "R2", reference(store.get(r2.id)!), 0);
  assert.deepEqual(engine.refinement.gate("p", "R2").findings, []);
  const active = structuredClone(graph); active.horizon = ["p-produce-work", "p-consume-work"];
  engine.graphs.save("p", active, store.get("graph:p")!.revision, "owner");
  assert.ok(engine.refinement.gate("p", "R2").findings.some(item => item.target === "r2-future"));
  assert.throws(() => engine.refinement.sealLayer("p", 3, 0), /preceding refinement phase/);
  const next = engine.refinement.begin("p", "R2");
  assert.equal(researchGraphContext(store, next.value)?.openGaps[0]?.deferred, false);
  const reused = reuseResearch(store, engine.discovery, next, reference(engine.environments.get("p")));
  assert.equal(reused, 3, "The three resolved reports can be reused; the report with the unresolved gap cannot");
  assert.ok(engine.discovery.gate("p", reference(store.get(next.id)!)).findings.length);
  answerTechnicalFixture(engine, "p", next);
  engine.refinement.finishResearch("p", "R2", reference(store.get(next.id)!), phase.revision);
  assert.deepEqual(engine.refinement.gate("p", "R2").findings, []);
  engine.refinement.sealLayer("p", 3, 0);
});
