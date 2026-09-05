import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { STAGES, type StageValidators, type StageValidator, reference } from "../src/pipeline/contracts.js";
import { EngineError } from "../src/errors.js";

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
