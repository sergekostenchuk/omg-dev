import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, storeBodyCache, storeReads, type Revision } from "../src/storage/store.js";
import { Discovery, DISCOVERY_PREFIX_CLOSURE_CONTRACT, DISCOVERY_PREFIX_CLOSURE_KIND,
  discoveryPrefixClosureId, type DiscoveryDraft, type DiscoveryPrefixClosure, type Question } from "../src/discovery/discovery.js";
import { derivedDraft } from "../src/discovery/derived-draft.js";
import { discoveryAcceptanceActId } from "../src/discovery/v7-contracts.js";
import { NEXT_CONTRACT_ERA } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { reference, type Ref, type StageArtifact } from "../src/pipeline/contracts.js";
import type { Source } from "../src/evidence/evidence.js";
import { hashJson } from "../src/canonical.js";
import { historicalRead, withHistoricalReads } from "../src/history/proofs.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import type { ResearchAnswer, ResearchAssessment, ResearchTurn } from "../src/discovery/research-model.js";
import { ProductEngine } from "../src/product/engine.js";
import { DatabaseSync } from "node:sqlite";
import { canonical } from "../src/canonical.js";
import { acceptanceBindingId, type ResearchAcceptanceBinding } from "../src/discovery/research-consumer-transition.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-prefix-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, discovery: new Discovery(store) };
}
const spec = (field: string, kind: "decision" | "fact" | "design") =>
  ({ field, kind, prompt: `${field}?`, risk: `wrong ${field}`, schema: { type: kind === "fact" ? "integer" : "string" } });
const questionAt = (store: Store, draft: Revision<DiscoveryDraft>, index: number): Revision<Question> =>
  store.get<Question>(draft.value.questions[index]!)!;
const closureAt = (store: Store, draft: Revision<DiscoveryDraft>): Revision<DiscoveryPrefixClosure> | null =>
  store.get<DiscoveryPrefixClosure>(discoveryPrefixClosureId(draft.id, draft.revision));
const reads = (action: () => void): number => { const before = storeReads(); action(); return storeReads() - before; };
const refSet = (refs: readonly Ref[]): string[] => refs.map(ref => `${ref.id}:${ref.revision}:${ref.hash}`).sort();
const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;

test("create writes discovery-prefix-closure/v1 in the same batch; the empty prefix keeps question_unresolved", t => {
  const f = fixture(t);
  const input = reference(f.store.write({ id: "input:garden", kind: "evidence", expected: 0, value: {} }));
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision"), spec("note", "decision")], [input]);
  const record = closureAt(f.store, draft);
  assert.ok(record && record.kind === DISCOVERY_PREFIX_CLOSURE_KIND && record.revision === 1, "the closure record landed with the draft");
  assert.equal(record.value.contract, DISCOVERY_PREFIX_CLOSURE_CONTRACT);
  assert.equal(record.value.projectId, "garden"); assert.equal(record.value.draftId, draft.id);
  assert.deepEqual(record.value.draft, reference(draft));
  assert.deepEqual(record.value.inputs, [input]);
  assert.deepEqual(record.value.questions.map(entry => entry.answer), [null, null], "both fresh questions recorded unanswered");
  assert.deepEqual(record.value.questions.map(entry => entry.question.id), draft.value.questions);
  assert.ok(referenceSites(DISCOVERY_PREFIX_CLOSURE_KIND, record.value).length > 0, "the closure's refs are declared sites");
  const result = f.discovery.gate("garden", reference(draft));
  assert.deepEqual(result.findings.map(finding => finding.code), ["question_unresolved", "question_unresolved"],
    "an empty closed prefix never passes the complete gate");
  const parsed = storeBodyCache().parses;
  const used = reads(() => f.discovery.gate("garden", reference(draft)));
  assert.equal(used, 3, "draft body + closure body + one heads snapshot — never a question body");
  assert.equal(storeBodyCache().parses - parsed, 2, "only the draft and closure bodies are decoded");
});

test("an answered prefix is closed end to end: findings and guards equal the full pass, no question bodies decoded", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision"), spec("count", "fact")]);
  const [goal, count] = draft.value.questions;
  f.discovery.decision(goal!, 1, "owner", "manage a garden");
  const source = f.discovery.evidence.document("garden", "inventory", '{"beds":8}', "application/json", 0);
  const answered = f.discovery.fact(count!, 1, reference(source), { kind: "json-pointer", pointer: "/beds" });
  const record = closureAt(f.store, answered)!;
  const [goalEntry, countEntry] = record.value.questions;
  assert.equal(goalEntry!.answer!.act, null); assert.equal(goalEntry!.answer!.binding, null); assert.equal(goalEntry!.answer!.assessment, null);
  assert.deepEqual(countEntry!.answer!.sources, [reference(source)], "every observation.source head is recorded");
  const result = f.discovery.gate("garden", reference(answered));
  assert.deepEqual(result.findings, []);
  const goalQ = questionAt(f.store, answered, 0), countQ = questionAt(f.store, answered, 1);
  assert.deepEqual(refSet(result.guards),
    refSet([reference(answered), reference(goalQ), goalQ.value.answer!, reference(countQ), countQ.value.answer!, reference(source)]),
    "the closed read surfaces the same guard set the full pass names");
  const parsed = storeBodyCache().parses;
  assert.equal(reads(() => f.discovery.gate("garden", reference(answered))), 3,
    "draft + closure + one snapshot — question and answer bodies stay untouched");
  assert.equal(storeBodyCache().parses - parsed, 2);
});

test("reopen moves only the question head: the same closure key stands, the stale field never stands for an accepted answer", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision")]);
  const answered = f.discovery.decision(draft.value.questions[0]!, 1, "owner", "manage a garden");
  assert.ok(closureAt(f.store, answered));
  const question = questionAt(f.store, answered, 0);
  f.discovery.reopen(question.id, question.revision);
  const result = f.discovery.gate("garden", reference(answered));
  assert.deepEqual(result.findings.map(finding => finding.code), ["question_unresolved"],
    "the head moved: the closed prefix stops and the full pass answers");
  assert.equal(f.discovery.gate("garden", reference(answered)).findings.length, 1);
});

test("a partial prefix keeps question_unresolved on the open questions through the closed read", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision"), spec("note", "decision")]);
  const answered = f.discovery.decision(draft.value.questions[0]!, 1, "owner", "manage a garden");
  assert.equal(answered.value.questions.length, 2);
  const result = f.discovery.gate("garden", reference(answered));
  assert.deepEqual(result.findings.map(finding => finding.code), ["question_unresolved"]);
  assert.equal(result.findings[0]!.target, draft.value.questions[1]);
});

test("a malformed, foreign or damaged closure record is an addressed discovery_prefix_closure_invalid, never a silent pass", t => {
  const f = fixture(t);
  // Revision bodies are immutable once committed, so a damaged record is a body that was written
  // malformed or foreign at the deterministic key — one fresh draft per case.
  const damage = (mutate: (valid: Record<string, unknown>) => unknown, name: string): void => {
    const id = `discovery:garden:damaged:${name}`, q = `question:garden:damaged:${name}`;
    f.store.writeMany([
      { id, kind: "discovery-draft", expected: 0,
        value: { projectId: "garden", createdAt: 1, stage: "discovery", level: "R0", consumer: "concept",
          fields: { goal: null }, questions: [q], inputs: [] } },
      { id: q, kind: "question", expected: 0,
        value: { projectId: "garden", draftId: id, stage: "discovery", level: "R0", consumer: "concept",
          spec: spec("goal", "decision"), beforeHash: hashJson(null), status: "open", answer: null } }]);
    const head = f.store.get<DiscoveryDraft>(id)!;
    const key = discoveryPrefixClosureId(head.id, head.revision);
    const valid: Record<string, unknown> = { contract: DISCOVERY_PREFIX_CLOSURE_CONTRACT, projectId: "garden",
      draftId: id, draft: reference(head), inputs: [], derivations: [],
      questions: [{ question: reference(questionAt(f.store, head, 0)), answer: null }], external: [] };
    f.store.write({ id: key, kind: DISCOVERY_PREFIX_CLOSURE_KIND, expected: 0, value: mutate(valid) });
    const result = f.discovery.gate("garden", reference(head));
    assert.deepEqual(result.findings.map(finding => finding.code), ["discovery_prefix_closure_invalid"], name);
    assert.equal(result.findings[0]!.target, key, name);
  };
  damage(() => ({ contract: "stage-closure/v1", projectId: "garden" }), "foreign-contract");
  damage(valid => ({ ...valid, questions: [] }), "question-mismatch");
  damage(valid => ({ ...valid, questions: [{ question: "not-a-ref", answer: null }] }), "malformed-entry");
  damage(valid => ({ ...valid, projectId: "other" }), "foreign-project");
  damage(valid => ({ ...valid, draft: { id: "discovery:other", revision: 1, hash: "0".repeat(64) } }), "foreign-draft");
});

test("a draft written without a closure takes the full pass; its #answer writes the closure once for the whole prefix", t => {
  const f = fixture(t);
  const id = "discovery:garden:legacy";
  const questions = ["question:garden:l1", "question:garden:l2"];
  const open = (field: string) => ({ projectId: "garden", draftId: id, stage: "discovery", level: "R0", consumer: "concept",
    spec: spec(field, "decision"), beforeHash: hashJson(null), status: "open", answer: null });
  f.store.writeMany([{ id, kind: "discovery-draft", expected: 0,
      value: { projectId: "garden", createdAt: 1, stage: "discovery", level: "R0", consumer: "concept",
        fields: { goal: null, note: null }, questions, inputs: [] } },
    { id: questions[0]!, kind: "question", expected: 0, value: open("goal") },
    { id: questions[1]!, kind: "question", expected: 0, value: open("note") }]);
  const head = f.store.get<DiscoveryDraft>(id)!;
  assert.equal(closureAt(f.store, head), null, "a legacy revision carries no closure");
  const findings = f.discovery.gate("garden", reference(head)).findings;
  assert.deepEqual(findings.map(finding => finding.code), ["question_unresolved", "question_unresolved"], "the full pass answers");
  // #answer on the legacy draft: one full build of the whole prefix by the previous check — the new
  // revision's closure covers every question, not only the one just answered.
  const answered = f.discovery.decision(questions[0]!, 1, "owner", "legacy answer");
  const record = closureAt(f.store, answered)!;
  assert.ok(record, "the acceptance batch wrote the closure of the whole prefix");
  assert.equal(record.value.questions.length, 2);
  assert.ok(record.value.questions[0]!.answer !== null && record.value.questions[1]!.answer === null);
  assert.deepEqual(f.discovery.gate("garden", reference(answered)).findings.map(finding => finding.code), ["question_unresolved"]);
});

test("a draft revision written outside the producer paths carries no closure and takes the full pass", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision")]);
  const answered = f.discovery.decision(draft.value.questions[0]!, 1, "owner", "x");
  const foreign = f.store.write<DiscoveryDraft>({ id: draft.id, kind: "discovery-draft", expected: answered.revision,
    value: { ...answered.value, fields: { goal: "interfered" } } });
  assert.equal(closureAt(f.store, foreign), null, "a revision without the producer writes no closure");
  const result = f.discovery.gate("garden", reference(foreign));
  assert.deepEqual(result.findings.map(finding => finding.code), ["answer_target_mismatch"],
    "the full pass answers verbatim — the interfered field no longer matches its accepted answer");
});

test("a rotted file source misses its declared external check and falls back to the verbatim evidence_stale", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "basis.json"), '{"v":1}');
  const source = f.discovery.evidence.file("garden", "basis", f.root, "basis.json", "application/json", 0);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("count", "fact")]);
  const question = questionAt(f.store, draft, 0);
  const answered = f.discovery.fact(question.id, question.revision, reference(source), { kind: "json-pointer", pointer: "/v" });
  const record = closureAt(f.store, answered)!;
  assert.deepEqual(record.value.external, [{ kind: "source", ref: reference(source) }],
    "the file source is declared as an external check — its bytes live outside the store");
  assert.deepEqual(f.discovery.gate("garden", reference(answered)).findings, []);
  writeFileSync(join(f.root, "basis.json"), '{"v":2}');
  const result = f.discovery.gate("garden", reference(answered));
  assert.ok(result.findings.some(finding => finding.code === "evidence_stale"),
    "the external miss falls back and the full pass names its own finding");
});

test("a moved input head misses the snapshot and the full pass names research_context_stale", t => {
  const f = fixture(t);
  const input = reference(f.store.write({ id: "input:garden", kind: "evidence", expected: 0, value: { n: 1 } }));
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision")], [input]);
  const answered = f.discovery.decision(draft.value.questions[0]!, 1, "owner", "x");
  assert.ok(closureAt(f.store, answered));
  f.store.write({ id: input.id, kind: "evidence", expected: input.revision, value: { n: 2 } });
  const result = f.discovery.gate("garden", reference(answered));
  assert.ok(result.findings.some(finding => finding.code === "research_context_stale" && finding.target === input.id));
});

test("the acceptance batch is atomic: a raced draft refuses before the write and leaves no partial closure", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision")]);
  const raced = f.store.write<DiscoveryDraft>({ id: draft.id, kind: "discovery-draft", expected: draft.revision,
    value: { ...draft.value, fields: { goal: "interfered" } } });
  assert.throws(() => f.discovery.decision(draft.value.questions[0]!, 1, "owner", "x"), code("target_stale"));
  assert.equal(closureAt(f.store, raced), null, "no closure landed next to the raced revision");
  assert.equal(f.discovery.gate("garden", reference(raced)).findings.length, 1, "the raced revision takes the full pass");
});

test("a v7 acceptance records the acceptance act inside the closure; a non-managed research answer records assessment and sources", t => {
  const f = fixture(t);
  const v7 = f.discovery.create("garden", "discovery", "R0", "concept", [spec("note", "decision")], [], NEXT_CONTRACT_ERA);
  const v7Answer = f.discovery.decision(v7.value.questions[0]!, 1, "owner", "text");
  const v7Closure = closureAt(f.store, v7Answer)!;
  const act = v7Closure.value.questions[0]!.answer!.act!;
  assert.equal(act.id, discoveryAcceptanceActId("garden", v7.id, "note", v7Closure.value.questions[0]!.answer!.answer),
    "the closure names the deterministic act record of the acceptance");
  const v5 = f.discovery.create("garden", "discovery", "R0", "concept", [spec("pick", "decision")], [], 5);
  const v5Question = questionAt(f.store, v5, 0);
  const source = f.discovery.evidence.document("garden", "note-doc", "note", "text/plain", 0);
  const observation = f.discovery.evidence.observe("garden", reference(source), { kind: "text-range", start: 0, end: 4 });
  const assessment = f.store.write<ResearchAssessment>({ id: "research-assessment:garden:a", kind: "research-assessment", expected: 0,
    value: { projectId: "garden", question: reference(v5Question), value: "note",
      observations: [observation], verdict: "supported", reasons: ["ok"],
      researcher: "alice", assessor: "bob", environment: reference(source) } });
  const v5Answer = f.discovery.researched(v5Question.id, v5Question.revision, reference(assessment));
  const v5Closure = closureAt(f.store, v5Answer)!;
  const entry = v5Closure.value.questions[0]!.answer!;
  assert.deepEqual(entry.assessment, reference(assessment));
  assert.equal(entry.binding, null); assert.equal(entry.act, null);
  assert.deepEqual(entry.sources, [reference(source)]);
  assert.deepEqual(f.discovery.gate("garden", reference(v5Answer)).findings, []);
  assert.deepEqual(f.discovery.gate("garden", reference(v7Answer)).findings, []);
});

test("the derived draft is closed over its derivation sources; a moved source head falls back to the full pass", t => {
  const f = fixture(t);
  const artifact = f.store.write<StageArtifact>({ id: "stage:garden:discovery", kind: "stage", expected: 0,
    value: { projectId: "garden", stage: "discovery", status: "accepted",
      content: { fields: { title: "Garden" } }, inputs: [], proofs: [] } });
  const derived = derivedDraft(f.store, "garden", "concept", "R1", "operation-map",
    [{ field: "title", source: reference(artifact), path: ["fields", "title"] }], [], 5);
  const record = closureAt(f.store, derived)!;
  assert.deepEqual(record.value.derivations, [reference(artifact)]);
  assert.equal(record.value.questions.length, 0);
  const used = reads(() => assert.deepEqual(f.discovery.gate("garden", reference(derived)).findings, []));
  assert.equal(used, 3, "draft + closure + one snapshot — deriveFields does not rerun while heads stand");
  f.store.write({ id: artifact.id, kind: "stage", expected: artifact.revision,
    value: { ...artifact.value, content: { fields: { title: "Other" } } } });
  assert.ok(f.discovery.gate("garden", reference(derived)).findings.some(finding => finding.code === "derivation_stale"));
});

test("the closed read stays inside the capture: PF4 sees every saved head as an observed read", t => {
  const f = fixture(t);
  const source = f.discovery.evidence.document("garden", "doc", '{"v":3}', "application/json", 0);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision"), spec("count", "fact")]);
  f.discovery.decision(draft.value.questions[0]!, 1, "owner", "x");
  const answered = f.discovery.fact(draft.value.questions[1]!, 1, reference(source), { kind: "json-pointer", pointer: "/v" });
  const outside = reads(() => f.discovery.gate("garden", reference(answered)));
  assert.equal(outside, 3);
  const inside = withHistoricalReads(() => historicalRead(f.store,
    { reader: "M6.route-result", project: "garden", ref: reference(answered) }, () => {
      const before = storeReads();
      const findings = f.discovery.gate("garden", reference(answered)).findings;
      return { findings, used: storeReads() - before };
    }, () => { throw new Error("cycle"); }));
  assert.deepEqual(inside.findings, []);
  assert.ok(inside.used > outside, "inside the capture every saved head is an observable get for the journal");
});

test("ten repeated history reads do not inflate the closed prefix's reads or dependencies", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision")]);
  const answered = f.discovery.decision(draft.value.questions[0]!, 1, "owner", "x");
  for (let index = 0; index < 400; index++)
    f.store.write({ id: `noise:${index}`, kind: "noise", expected: 0, value: { index } });
  const measure = (): number => reads(() => assert.deepEqual(f.discovery.gate("garden", reference(answered)).findings, []));
  const first = measure();
  for (let index = 0; index < 10; index++) assert.equal(measure(), first, "history growth changes nothing");
  assert.equal(first, 3, "draft + closure + one snapshot — the whole accepted prefix costs O(1)");
});

test("an ordinary acceptance verifies only the new answer — the saved prefix is inherited, old bodies unread (№6348 G4a-02)", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept",
    Array.from({ length: 11 }, (_, index) => spec(`q${index}`, "decision")));
  for (let index = 0; index < 10; index++) f.discovery.decision(draft.value.questions[index]!, 1, "owner", `v${index}`);
  const oldBodies = new Set(draft.value.questions.slice(0, 10)
    .map(id => f.store.get<Question>(id)!.value.answer!.id));
  const original = f.store.get.bind(f.store);
  const seen: string[] = [];
  (f.store as { get: typeof f.store.get }).get = ((id: string, revision?: number) => {
    if (oldBodies.has(id)) seen.push(id); return original(id, revision);
  }) as typeof f.store.get;
  let answered: Revision<DiscoveryDraft>;
  try { answered = f.discovery.decision(draft.value.questions[10]!, 1, "owner", "v10"); }
  finally { (f.store as { get: typeof f.store.get }).get = original; }
  assert.equal(seen.length, 0, "the inherited prefix never re-reads an accepted answer or assessment body");
  const record = closureAt(f.store, answered)!;
  assert.equal(record.value.questions.filter(entry => entry.answer !== null).length, 11,
    "the inherited closure still covers the whole prefix — old entries verbatim, the fresh one new");
  assert.deepEqual(f.discovery.gate("garden", reference(answered)).findings, []);
});

// №6403 G4a-03: a replaced answer's external check leaves with it — only checks whose exact Ref
// the resulting entries still use are inherited.
for (const mode of ["file-to-document", "file-to-new-file"])
test(`a replaced fact drops its obsolete external check, the gate stays closed (${mode})`, t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "old.json"), '{"n":1}');
  const old = f.discovery.evidence.file("garden", "old", f.root, "old.json", "application/json", 0);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept",
    [{ field: "n", kind: "fact", prompt: "n?", risk: "wrong", schema: { type: "integer" } }]);
  const first = f.discovery.fact(draft.value.questions[0]!, 1, reference(old), { kind: "json-pointer", pointer: "/n" });
  assert.equal(closureAt(f.store, first)!.value.external.length, 1);
  const open = f.discovery.reopen(draft.value.questions[0]!, 2);
  let source: Revision<Source>;
  if (mode === "file-to-document") source = f.discovery.evidence.document("garden", "old", '{"n":2}', "application/json", 1);
  else { writeFileSync(join(f.root, "new.json"), '{"n":2}');
    source = f.discovery.evidence.file("garden", "new", f.root, "new.json", "application/json", 0); }
  const fresh = f.discovery.fact(open.id, open.revision, reference(source), { kind: "json-pointer", pointer: "/n" });
  const closure = closureAt(f.store, fresh)!;
  assert.deepEqual(closure.value.questions[0]!.answer!.sources, [reference(source)]);
  assert.equal(closure.value.external.length, mode === "file-to-document" ? 0 : 1,
    "the obsolete check leaves with the replaced answer; a new file gets its own");
  rmSync(join(f.root, "old.json"));
  const used = reads(() => {
    const result = f.discovery.gate("garden", reference(fresh));
    assert.deepEqual(result.findings, []);
    assert.ok(result.prefix, "a deleted file the prefix no longer uses cannot force the full pass");
  });
  assert.equal(used, mode === "file-to-document" ? 3 : 4,
    "draft + closure + one snapshot + one external read per live check");
});

test("a file source shared by two accepted answers keeps its check until the last user goes", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "shared.json"), '{"n":1}');
  const shared = f.discovery.evidence.file("garden", "shared", f.root, "shared.json", "application/json", 0);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [
    { field: "a", kind: "fact", prompt: "a?", risk: "wrong", schema: { type: "integer" } },
    { field: "b", kind: "fact", prompt: "b?", risk: "wrong", schema: { type: "integer" } }]);
  f.discovery.fact(draft.value.questions[0]!, 1, reference(shared), { kind: "json-pointer", pointer: "/n" });
  f.discovery.fact(draft.value.questions[1]!, 1, reference(shared), { kind: "json-pointer", pointer: "/n" });
  const open = f.discovery.reopen(draft.value.questions[0]!, 2);
  const doc = f.discovery.evidence.document("garden", "doc", '{"n":7}', "application/json", 0);
  const replaced = f.discovery.fact(open.id, open.revision, reference(doc), { kind: "json-pointer", pointer: "/n" });
  const closure = closureAt(f.store, replaced)!;
  assert.equal(closure.value.external.length, 1, "the other accepted answer still uses the file — its check stays");
  assert.ok(closure.value.external[0]!.kind === "source" && closure.value.external[0]!.ref.id === shared.id);
  rmSync(join(f.root, "shared.json"));
  assert.deepEqual(f.discovery.gate("garden", reference(replaced)).findings.map(finding => finding.code),
    ["evidence_stale"], "a still-used file's own check catches its loss on the fallback");
});

test("ten sequential replacements keep one external check and a constant closed-read budget", t => {
  const f = fixture(t);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept",
    [{ field: "n", kind: "fact", prompt: "n?", risk: "wrong", schema: { type: "integer" } }]);
  let expected = 1; let latest: Revision<DiscoveryDraft> = draft;
  const budgets: number[] = [];
  for (let index = 0; index < 10; index++) {
    writeFileSync(join(f.root, `source-${index}.json`), JSON.stringify({ n: index }));
    const source = f.discovery.evidence.file("garden", `version-${index}`, f.root,
      `source-${index}.json`, "application/json", 0);
    latest = f.discovery.fact(draft.value.questions[0]!, expected, reference(source), { kind: "json-pointer", pointer: "/n" });
    budgets.push(reads(() => assert.deepEqual(f.discovery.gate("garden", reference(latest)).findings, [])));
    if (index < 9) expected = f.discovery.reopen(draft.value.questions[0]!, expected + 1).revision;
  }
  assert.equal(closureAt(f.store, latest)!.value.external.length, 1,
    "only the current file's check survives the replacements");
  assert.ok(budgets.every(used => used === budgets[0]), `the closed read stays flat: ${budgets}`);
  assert.equal(budgets[0], 4, "draft + closure + one snapshot + one external source read");
});

test("GateResult.prefix carries the accepted prefix snapshot only on the checked closed path", t => {
  const f = fixture(t);
  const source = f.discovery.evidence.document("garden", "doc", '{"v":3}', "application/json", 0);
  const draft = f.discovery.create("garden", "discovery", "R0", "concept", [spec("goal", "decision"), spec("note", "fact")]);
  f.discovery.decision(draft.value.questions[0]!, 1, "owner", "keep");
  const answered = f.discovery.fact(draft.value.questions[1]!, 1, reference(source), { kind: "json-pointer", pointer: "/v" });
  const result = f.discovery.gate("garden", reference(answered));
  assert.deepEqual(result.findings, []);
  const prefix = result.prefix!;
  assert.equal(prefix.contract, "discovery-prefix/v1");
  assert.deepEqual(prefix.draft, reference(answered));
  assert.deepEqual(prefix.closure, reference(closureAt(f.store, answered)!));
  assert.equal(prefix.entries.length, 2, "one entry per answered question, in draft order");
  const [goal, note] = prefix.entries;
  assert.deepEqual(goal!.question, reference(questionAt(f.store, answered, 0)));
  assert.equal(goal!.field, "goal"); assert.equal(goal!.status, "answered"); assert.equal(goal!.kind, "decision");
  assert.equal(goal!.value, "keep"); assert.equal(goal!.assessment, null); assert.equal(goal!.observations, 0);
  assert.equal(note!.field, "note"); assert.equal(note!.kind, "fact"); assert.equal(note!.value, 3);
  assert.equal(note!.observations, 1);
  // The full pass — a stale guard, a missing closure, a legacy draft — never surfaces a snapshot.
  f.discovery.reopen(draft.value.questions[0]!, 2);
  assert.equal(f.discovery.gate("garden", reference(answered)).prefix, undefined, "the fallback path has no snapshot");
  const legacy = f.store.write<DiscoveryDraft>({ id: "discovery:garden:legacy-p", kind: "discovery-draft", expected: 0,
    value: { projectId: "garden", createdAt: 1, stage: "discovery", level: "R0", consumer: "concept",
      fields: { goal: null }, questions: [], inputs: [] } });
  assert.equal(f.discovery.gate("garden", reference(legacy)).prefix, undefined, "an unclosed draft has no snapshot");
});

// ── №6284: the managed acceptance is closed on the captured read set of its own K proof ──

function managedFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-prefix-managed-"));
  const database = join(root, "state.sqlite");
  const store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "p", title: "managed closure" });
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
async function produceManaged(f: ReturnType<typeof managedFixture>) {
  const run = await f.engine.researcher.run("p", f.draft.id, 1);
  assert.equal(run.value.status, "completed", JSON.stringify(run.value));
  const turn = f.store.list<ResearchTurn>("research-turn")
    .filter(row => row.id.startsWith("research-turn:v1:")).sort((a, b) => a.value.number - b.value.number)[0]!;
  const binding = f.store.get<ResearchAcceptanceBinding>(acceptanceBindingId("p", turn.id))!;
  const answer = f.store.get<ResearchAnswer>(binding.value.answer.id, binding.value.answer.revision)!;
  return { turn, binding, answer, answerRef: reference(answer) };
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

test("a managed v5/v6 prefix is closed: the fast read costs draft + closure + one snapshot, never a per-row re-proof", async t => {
  const f = managedFixture(t);
  const produced = await produceManaged(f);
  const head = f.store.get<DiscoveryDraft>(produced.binding.value.draftAfter.id)!;
  const record = closureAt(f.store, head);
  assert.ok(record, "the managed acceptance batch wrote the closure in the same batch");
  const entry = record!.value.questions[0]!.answer!;
  assert.ok(entry.managed, "the managed read set is recorded");
  assert.ok(entry.managed!.heads.some(ref => ref.id === produced.binding.id && ref.revision === 1),
    "K revision 1 is a head guard — one snapshot read, no intent chain walk at read time");
  assert.ok(entry.managed!.pinned.some(ref => ref.id === produced.turn.id && ref.revision < f.store.get(produced.turn.id)!.revision),
    "the exact non-head pending revision stays in the saved read manifest — immutable, proven once at write");
  const result = f.engine.discovery.gate("p", reference(head));
  assert.deepEqual(result.findings, []);
  assert.ok(result.guards.some(ref => ref.id === produced.binding.id), "the exact K lands in the gate bases");
  const prefix = result.prefix!;
  assert.equal(prefix.entries.length, 1);
  assert.equal(prefix.entries[0]!.kind, "research-answer");
  assert.deepEqual(prefix.entries[0]!.assessment, entry.assessment);
  const parsed = storeBodyCache().parses;
  const used = reads(() => assert.deepEqual(f.engine.discovery.gate("p", reference(head)).findings, []));
  // №6348 G4a-01: C+ceil(D/chunk) whatever the saved read set's size — the immutable pinned
  // revisions are a recorded proof audited by om-fsck, not re-verified row by row at the gate.
  assert.equal(used, 3, "draft + closure + one heads snapshot — independent of the 30+ pinned exacts");
  assert.equal(storeBodyCache().parses - parsed, 2, "only the draft and closure bodies are decoded");
});

test("a lost or damaged K, B or M misses the managed closure and falls back to the verbatim research refusal", async t => {
  const f = managedFixture(t);
  const produced = await produceManaged(f);
  const head = f.store.get<DiscoveryDraft>(produced.binding.value.draftAfter.id)!;
  const b = `research-assessment-binding:v1:${hashJson({ projectId: "p", turnId: produced.turn.id })}`;
  const m = `assessment-paid-origin:v1:${hashJson({ projectId: "p", turnId: produced.turn.id })}`;
  assert.ok(closureAt(f.store, head));
  for (const id of [produced.binding.id, b, m]) {
    const lostRow = f.store.get(id)!, lost = lostRow.value, kind = lostRow.kind;
    rawDrop(f.database, id);
    const result = f.engine.discovery.gate("p", reference(head));
    assert.ok(result.findings.some(finding => finding.code.startsWith("research_")),
      `${id} lost: the closed read misses and the full pass refuses verbatim`);
    assert.equal(result.prefix, undefined, "a refused prefix surfaces no snapshot");
    const raw = new DatabaseSync(f.database);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
      raw.prepare("INSERT INTO revisions(entity_id, revision, kind, body, sha256) VALUES (?, 1, ?, ?, ?)")
        .run(id, kind, canonical(lost), hashJson(lost));
      raw.prepare("INSERT INTO heads(entity_id, revision) VALUES (?, 1)").run(id);
    } finally { raw.close(); }
    assert.deepEqual(f.engine.discovery.gate("p", reference(head)).findings, [], `${id} restored`);
  }
});
