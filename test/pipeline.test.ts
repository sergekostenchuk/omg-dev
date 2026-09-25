import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type TransactionGuard } from "../src/storage/store.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { STAGES, type StageArtifact, type StageValidators, type StageValidator, reference } from "../src/pipeline/contracts.js";
import { EngineError } from "../src/errors.js";
import { canonical, digest } from "../src/canonical.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;
const titleContract: StageValidator = ({ content }) => ({ findings:
  typeof content === "object" && content !== null && "title" in content && typeof content.title === "string" && content.title.trim()
    ? [] : [{ code: "title_missing", target: "title", message: "A nonempty title is required" }], guards: [] });
const contracts: StageValidators = { discovery: titleContract, concept: titleContract,
  "operation-map": titleContract, specification: titleContract, features: titleContract,
  "om-g2": titleContract, compilation: titleContract, execution: titleContract };

test("stage gates bind actual predecessor revisions; absence and invalid content refuse transition", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-pipeline-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const pipeline = new Pipeline(store, contracts);
  assert.throws(() => new Pipeline(store, {} as StageValidators), code("stage_contract_missing"));
  assert.throws(() => pipeline.draft("garden", "concept", { title: "Garden" }, 0), code("predecessor_not_ready"));
  const empty = pipeline.draft("garden", "discovery", {}, 0);
  assert.throws(() => pipeline.accept("garden", "discovery", empty.revision), code("gate_rejected"));
  const good = pipeline.draft("garden", "discovery", { title: "Garden" }, empty.revision);
  const discovery = pipeline.accept("garden", "discovery", good.revision);
  const concept = pipeline.draft("garden", "concept", { title: "Garden concept" }, 0);
  assert.deepEqual(concept.value.inputs, [reference(discovery)]);
  pipeline.accept("garden", "concept", concept.revision);
  assert.equal(pipeline.inspect("garden", "concept").state, "accepted");
  assert.equal(pipeline.inspect("another-product", "concept").state, "missing");
});

test("editing the earliest input invalidates downstream projections without rewriting accepted history", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-revisions-")); const path = join(root, "state.sqlite");
  const store = new Store(path); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const pipeline = new Pipeline(store, contracts);
  for (const stage of STAGES) { const draft = pipeline.draft("project", stage, { title: stage }, 0); pipeline.accept("project", stage, draft.revision); }
  const before = store.get("stage:project:execution")!;
  pipeline.draft("project", "discovery", { title: "changed problem" }, 2);
  assert.equal(pipeline.inspect("project", "execution").state, "stale");
  assert.deepEqual(store.get(before.id, before.revision), before);
  assert.equal(store.get(before.id)!.revision, before.revision);
  const reopened = new Store(path);
  try { assert.equal(new Pipeline(reopened, contracts).inspect("project", "execution").state, "stale"); } finally { reopened.close(); }
});

test("source guards and CAS stop a check-then-write race with another connection", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-cas-")); const path = join(root, "state.sqlite");
  const store = new Store(path); const other = new Store(path);
  t.after(() => { other.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = store.write({ id: "source", kind: "source", expected: 0, value: { version: 1 } });
  other.write({ id: "source", kind: "source", expected: 1, value: { version: 2 } });
  assert.throws(() => store.writeMany([{ id: "derived", kind: "derived", expected: 0, value: {} }], [reference(source)]), code("input_stale"));
  assert.equal(store.get("derived"), null);
});

test("accepted preparation is pure, preserves guard channels and persists a first accepted revision after restart", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-prepare-accepted-")); const path = join(root, "state.sqlite");
  const store = new Store(path); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const proof = reference(store.write({ id: "proof", kind: "evidence", expected: 0, value: {} }));
  const admission = reference(store.write({ id: "admission", kind: "evidence", expected: 0, value: {} }));
  const extra = reference(store.write({ id: "extra", kind: "evidence", expected: 0, value: {} }));
  const validationAbsence: TransactionGuard = { id: "validation-absent", absent: true };
  const extraAbsence: TransactionGuard = { id: "extra-absent", absent: true };
  const acceptedFlags: (boolean | undefined)[] = [];
  const validator: StageValidator = ({ accepted, inputs }) => {
    acceptedFlags.push(accepted); assert.deepEqual(inputs, []);
    return { findings: [], guards: [proof, proof], admissionGuards: [admission, validationAbsence] };
  };
  const pipeline = new Pipeline(store, { ...contracts, discovery: validator });
  const before = store.list(), content = { title: "First accepted stage" };
  const prepared = pipeline.prepareAccepted("project", "discovery", content, 0, [extra, extraAbsence, extra]);
  assert.deepEqual(store.list(), before);
  assert.deepEqual(acceptedFlags, [false]);
  assert.deepEqual(prepared.write, { id: "stage:project:discovery", kind: "stage", expected: 0,
    value: { projectId: "project", stage: "discovery", status: "accepted", content, inputs: [], proofs: [proof] } });
  assert.deepEqual(new Set(prepared.guards), new Set([admission, extra, extraAbsence, proof, validationAbsence]));
  assert.equal(prepared.guards.some(guard => guard.id === prepared.write.id), false);
  content.title = "Caller changed its input";
  const saved = store.writeMany<StageArtifact>([prepared.write,
    { id: "neighbor", kind: "neighbor", expected: 0, value: {} }], prepared.guards)[0]!;
  assert.equal(saved.revision, 1); assert.equal(saved.value.status, "accepted");
  assert.deepEqual(saved.value.content, { title: "First accepted stage" });
  assert.equal(store.history(saved.id).length, 1);
  store.close();
  const reopened = new Store(path);
  try {
    const projection = new Pipeline(reopened, { ...contracts, discovery: validator }).inspect("project", "discovery");
    assert.equal(projection.state, "accepted"); assert.deepEqual(projection.artifact, saved);
    assert.ok(reopened.get("neighbor")); assert.deepEqual(acceptedFlags, [false, true]);
  } finally { reopened.close(); }
});

test("prepared and legacy two-step acceptance share predecessor inputs, proof bytes and completed repeats", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-prepare-legacy-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const evidence = reference(store.write({ id: "evidence", kind: "evidence", expected: 0, value: {} }));
  const extra = reference(store.write({ id: "extra", kind: "evidence", expected: 0, value: {} }));
  const negative: TransactionGuard = { id: "no-revocation", absent: true };
  const validator: StageValidator = () => ({ findings: [], guards: [evidence], admissionGuards: [negative] });
  const pipeline = new Pipeline(store, { ...contracts, discovery: validator, concept: validator });
  const discoveryDraft = pipeline.draft("project", "discovery", { title: "Discovery" }, 0);
  const discovery = pipeline.accept("project", "discovery", discoveryDraft.revision);
  const content = { title: "Concept" }, before = store.list();
  const prepared = pipeline.prepareAccepted("project", "concept", content, 0, [extra]);
  assert.deepEqual(store.list(), before);
  assert.deepEqual(prepared.write.value.inputs, [reference(discovery)]);
  assert.deepEqual(prepared.write.value.proofs, [evidence, reference(discovery)]);
  assert.ok(prepared.guards.some(guard => 'absent' in guard && guard.id === negative.id));
  assert.ok(prepared.guards.some(guard => guard.id === extra.id));
  const draft = pipeline.draft("project", "concept", content, 0, [extra]);
  const accepted = pipeline.accept("project", "concept", draft.revision, [extra]);
  assert.deepEqual(accepted.value, prepared.write.value);
  assert.equal(accepted.hash, digest(canonical(prepared.write.value)));
  assert.equal(store.history(accepted.id).length, 2);
  assert.deepEqual(pipeline.accept("project", "concept", accepted.revision), accepted);
  assert.equal(store.history(accepted.id).length, 2);
});

test("new accepted content cannot use historical validation or an existing accepted shortcut", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-prepare-fresh-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const initial = new Pipeline(store, contracts).prepareAccepted("project", "discovery", { title: "Accepted" }, 0);
  const accepted = store.writeMany<StageArtifact>([initial.write], initial.guards)[0]!;
  const calls: (boolean | undefined)[] = [];
  const validator: StageValidator = ({ accepted }) => {
    calls.push(accepted);
    return { findings: accepted ? [] : [{ code: "fresh_admission_required", target: "content", message: "Fresh admission is refused" }], guards: [] };
  };
  const pipeline = new Pipeline(store, { ...contracts, discovery: validator });
  assert.deepEqual(pipeline.accept("project", "discovery", accepted.revision), accepted);
  const before = store.list();
  assert.throws(() => pipeline.prepareAccepted("project", "discovery", { title: "New content" }, accepted.revision), code("gate_rejected"));
  assert.throws(() => pipeline.prepareAccepted("another", "discovery", { title: "First content" }, 0), code("gate_rejected"));
  assert.deepEqual(calls, [true, false, false]); assert.deepEqual(store.list(), before);
  assert.equal(store.history(accepted.id).length, 1);
});

test("prepared acceptance refuses missing, draft and stale predecessors or invalid fresh content without writes", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-prepare-refusal-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = store.write({ id: "source", kind: "source", expected: 0, value: {} });
  const validator: StageValidator = context => ({ ...titleContract(context), guards: [reference(source)] });
  const pipeline = new Pipeline(store, { ...contracts, discovery: validator });
  const refuses = (action: () => unknown, expected: string) => {
    const before = store.list(); assert.throws(action, code(expected)); assert.deepEqual(store.list(), before);
  };
  refuses(() => pipeline.prepareAccepted("project", "concept", { title: "Concept" }, 0), "predecessor_not_ready");
  refuses(() => pipeline.prepareAccepted("project", "discovery", {}, 0), "gate_rejected");
  const draft = pipeline.draft("project", "discovery", { title: "Discovery" }, 0);
  refuses(() => pipeline.prepareAccepted("project", "concept", { title: "Concept" }, 0), "predecessor_not_ready");
  pipeline.accept("project", "discovery", draft.revision);
  store.write({ id: source.id, kind: source.kind, expected: source.revision, value: { changed: true } });
  refuses(() => pipeline.prepareAccepted("project", "concept", { title: "Concept" }, 0), "predecessor_not_ready");
  const absent: TransactionGuard = { id: source.id, absent: true };
  const blocked = new Pipeline(store, { ...contracts, discovery: () => ({ findings: [], guards: [], admissionGuards: [absent] }) });
  refuses(() => blocked.prepareAccepted("another", "discovery", { title: "Discovery" }, 0), "gate_rejected");
  assert.equal(store.get("stage:project:concept"), null);
  assert.equal(store.get("stage:another:discovery"), null);
});

for (const race of ["stage", "predecessor", "positive", "negative", "admission-positive", "extra-positive", "extra-negative", "inherited-negative"] as const) {
  test(`prepared acceptance and its neighbor roll back atomically after a second Store changes ${race}`, t => {
    const root = mkdtempSync(join(tmpdir(), "omg-prepare-race-")); const path = join(root, "state.sqlite");
    const store = new Store(path), other = new Store(path);
    t.after(() => { other.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
    const source = store.write({ id: "source", kind: "source", expected: 0, value: { version: 1 } });
    const admission = store.write({ id: "admission", kind: "source", expected: 0, value: { version: 1 } });
    const extra = store.write({ id: "extra", kind: "source", expected: 0, value: { version: 1 } });
    const pipeline = new Pipeline(store, { ...contracts,
      discovery: () => ({ findings: [], guards: [], admissionGuards: [{ id: "inherited-negative", absent: true }] }),
      concept: () => ({ findings: [], guards: [reference(source)], admissionGuards: [reference(admission), { id: "negative", absent: true }] }),
    });
    const initial = pipeline.prepareAccepted("project", "discovery", { title: "Discovery" }, 0);
    const prior = store.writeMany<StageArtifact>([initial.write], initial.guards)[0]!;
    const prepared = pipeline.prepareAccepted("project", "concept", { title: "Concept" }, 0,
      [reference(extra), { id: "extra-negative", absent: true }]);
    if (race === "stage") other.write({ ...prepared.write, value: { ...prepared.write.value, content: { title: "Other stage" } } });
    else if (race === "predecessor") other.write({ id: prior.id, kind: prior.kind, expected: prior.revision,
      value: { ...prior.value, content: { title: "Other predecessor" } } });
    else if (race === "positive" || race === "admission-positive" || race === "extra-positive") {
      const changed = race === "positive" ? source : race === "admission-positive" ? admission : extra;
      other.write({ id: changed.id, kind: changed.kind, expected: changed.revision, value: { version: 2 } });
    } else other.write({ id: race, kind: "revocation", expected: 0, value: {} });
    const before = store.list(), stageBefore = store.history(prepared.write.id);
    assert.throws(() => store.writeMany([
      { id: "neighbor", kind: "neighbor", expected: 0, value: {} }, prepared.write,
    ], prepared.guards), code(race === "stage" ? "revision_conflict" : "input_stale"));
    assert.equal(store.get("neighbor"), null);
    assert.deepEqual(store.history(prepared.write.id), stageBefore); assert.deepEqual(store.list(), before);
  });
}

test("prepared acceptance preserves the supplied CAS for existing stages", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-prepare-cas-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const pipeline = new Pipeline(store, contracts), draft = pipeline.draft("project", "discovery", { title: "Draft" }, 0);
  const prepared = pipeline.prepareAccepted("project", "discovery", { title: "Replacement" }, draft.revision);
  assert.equal(prepared.write.expected, draft.revision); assert.deepEqual(store.get(draft.id), draft);
  const saved = store.writeMany<StageArtifact>([prepared.write], prepared.guards)[0]!;
  assert.equal(saved.revision, draft.revision + 1); assert.equal(saved.value.status, "accepted");
  const stale = pipeline.prepareAccepted("project", "discovery", { title: "Stale expected" }, draft.revision);
  assert.equal(stale.write.expected, draft.revision);
  assert.throws(() => store.writeMany([stale.write], stale.guards), code("revision_conflict"));
  assert.deepEqual(store.get(saved.id), saved);
});

test("missing and malformed preparation arguments fail with typed refusals and no writes", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-prepare-invalid-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const pipeline = new Pipeline(store, contracts);
  const invoke = (...args: unknown[]) => Reflect.apply(pipeline.prepareAccepted, pipeline, args);
  for (const project of [undefined, null, 1, {}, "", "../project", Symbol("project")])
    assert.throws(() => invoke(project, "discovery", {}, 0), code("invalid_project"));
  for (const stage of [undefined, null, {}, "other", Symbol("stage")])
    assert.throws(() => invoke("project", stage, {}, 0), code("unknown_stage"));
  for (const expected of [undefined, null, "0", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => invoke("project", "discovery", { title: "Title" }, expected), code("invalid_write"));
  const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
  for (const content of [undefined, { title: undefined }, Number.NaN, 1n, new Date(), cyclic, Array(1)])
    assert.throws(() => invoke("project", "discovery", content, 0), code("invalid_json"));
  for (const guards of [null, {}, "guards", [null], [undefined], Array(1), [{ id: "x", absent: false }],
    [{ id: "x", absent: true, revision: 1 }], [{ id: "x", revision: 1, hash: "forged" }]])
    assert.throws(() => invoke("project", "discovery", { title: "Title" }, 0, guards), code("invalid_guard"));
  assert.deepEqual(store.list(), []);
});
