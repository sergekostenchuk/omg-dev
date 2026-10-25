import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UPSTREAM_STAGES } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { reference, stageId, type StageArtifact } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store } from "../src/storage/store.js";
import { preparedField } from "./preparation-fixture.js";
import { preparedFeatures, withHistoricalUpstream } from "./product-fixture.js";

const PROJECT = "garden";
const SCOPE = "must-never-load-this-era";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function openEngine(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-product-fixture-"));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, engine: new ProductEngine(store) };
}

/** The real field values of the fixture, recording every request for one. */
function askedValues() {
  const asked: string[] = [];
  return { asked, valueFor: (field: string) => { asked.push(field); return preparedField(PROJECT, field); } };
}

function assertEraRefused(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof EngineError, "The refusal is the typed engine error");
    assert.equal(error.code, "product_fixture_era_unsupported");
    assert.deepEqual(error.details, { target: "/era" });
    return true;
  });
}

/** What a refusal must leave exactly as it found it: every record and the whole event sequence. */
function stateOf(store: Store) {
  return { records: store.list(), events: store.lastEvent() };
}

const RANDOM = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/g;
/** Kind, identity and revision of every record with its random parts (uuids and the hashes made of them) removed,
 * so that two independent runs can be compared. */
function shapeOf(store: Store): string[] {
  return store.list().map(row => `${row.kind} ${row.id.replace(RANDOM, "<random>")} r${row.revision}`).sort();
}

function assertCurrentStages(engine: ProductEngine, store: Store): void {
  for (const [index, stage] of UPSTREAM_STAGES.entries()) {
    const artifact = store.get<StageArtifact>(stageId(PROJECT, stage));
    assert.ok(artifact, `${stage} is written`);
    assert.equal(artifact.value.status, "accepted", stage);
    assert.equal(engine.pipeline.inspect(PROJECT, stage).state, "accepted", stage);
    const previous = index === 0 ? null : store.get<StageArtifact>(stageId(PROJECT, UPSTREAM_STAGES[index - 1]!))!;
    assert.deepEqual(artifact.value.inputs, previous ? [reference(previous)] : [], stage);
  }
}

test("PF1 an explicit non-empty era is refused by the exact typed error before any record is written or any value is asked for", t => {
  const { store, engine } = openEngine(t), { asked, valueFor } = askedValues();
  const before = stateOf(store);
  for (const era of [COMMIT, SCOPE]) {
    assertEraRefused(() => preparedFeatures(engine, PROJECT, undefined, valueFor, era));
    assert.deepEqual(asked, [], `${era} asks for no value`);
    assert.deepEqual(stateOf(store), before, `${era} writes nothing`);
  }
  assert.equal(store.get(stageId(PROJECT, "discovery")), null);
});

test("PF2 a non-empty era inherited from the scope is refused the same way when the call states none, also when it passes undefined", t => {
  const { store, engine } = openEngine(t), { asked, valueFor } = askedValues();
  const before = stateOf(store);
  withHistoricalUpstream(SCOPE, () => {
    assertEraRefused(() => preparedFeatures(engine, PROJECT, undefined, valueFor));
    assertEraRefused(() => preparedFeatures(engine, PROJECT, undefined, valueFor, undefined));
  });
  assert.deepEqual(asked, []);
  assert.deepEqual(stateOf(store), before);
});

test("PF3 a call without any era builds the current accepted stages from the real engine", t => {
  const { store, engine } = openEngine(t), { asked, valueFor } = askedValues();
  preparedFeatures(engine, PROJECT, undefined, valueFor);
  assert.ok(asked.length > 0, "The fixture asked for its field values");
  assertCurrentStages(engine, store);
});

test("PF4 an explicit empty era inside the scope builds the same current stages as a call outside any scope", t => {
  const plain = openEngine(t), scoped = openEngine(t);
  preparedFeatures(plain.engine, PROJECT);
  withHistoricalUpstream(SCOPE, () => preparedFeatures(scoped.engine, PROJECT, undefined, undefined, ""));
  assertCurrentStages(scoped.engine, scoped.store);
  assert.deepEqual(shapeOf(scoped.store), shapeOf(plain.store));
});
