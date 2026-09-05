import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine, type StageContent } from "../src/product/engine.js";
import { LEGACY_REQUIREMENTS, RESEARCH_CONTRACT_VERSION } from "../src/discovery/requirements.js";
import { JOURNEY_VARIANTS } from "../src/discovery/preparation-contracts.js";
import { reference, stageId, type StageArtifact } from "../src/pipeline/contracts.js";
import type { DiscoveryDraft } from "../src/discovery/discovery.js";
import type { Json } from "../src/canonical.js";
import { preparedField, preparationValue } from "./preparation-fixture.js";
import { preparedFeatures } from "./product-fixture.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-preparation-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "p", title: "Local transformer" });
  const source = engine.discovery.evidence.document("p", "brief", "Create a standalone local CLI transformer with validation.", "text/plain", 0);
  const draft = engine.prepare("p", "discovery");
  engine.discovery.fact(draft.value.questions[0]!, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
  engine.discovery.decision(draft.value.questions[1]!, 1, "owner", "Return a validated local result");
  return { engine, store, draft, source };
}

test("new initial research requires every scenario category and refuses unresolved essential inputs", t => {
  const { engine, draft, store } = fixture(t);
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  const stage = engine.draft("p", "discovery", draft.id, 0);
  assert.throws(() => engine.pipeline.accept("p", "discovery", stage.revision), /validation refused/);
  const value = preparationValue("p") as Record<string, Json>;
  const journeys = value['journeys'] as Record<string, Json>;
  assert.equal(Object.keys(journeys).length, JOURNEY_VARIANTS.length);
  delete journeys['crash_recovery'];
  assert.throws(() => engine.discovery.decision(draft.value.questions[2]!, 1, "owner", value), /field contract/);
  const blocked = preparationValue("p") as Record<string, Json>;
  blocked['unknowns'] = [{ id: "essential", question: "Which input must be transformed?", consumer: "concept", blocksCurrentStage: true, resolution: "Unavailable" }];
  engine.discovery.decision(draft.value.questions[2]!, 1, "owner", blocked);
  const next = engine.draft("p", "discovery", draft.id, stage.revision);
  assert.ok(engine.pipeline.inspect("p", "discovery").findings.some(item => item.code === "preparation_unresolved"));
  assert.throws(() => engine.pipeline.accept("p", "discovery", next.revision), /validation refused/);
  const question = engine.discovery.reopen(draft.value.questions[2]!, store.get(draft.value.questions[2]!)!.revision);
  engine.discovery.decision(question.id, question.revision, "owner", preparationValue("p"));
  const fixed = engine.draft("p", "discovery", draft.id, next.revision);
  engine.pipeline.accept("p", "discovery", fixed.revision);
  assert.equal(engine.pipeline.inspect("p", "discovery").state, "accepted");
});

test("a complete-looking preparation cannot bind a scenario to a foreign beneficiary", t => {
  const { engine, draft } = fixture(t);
  const value = preparationValue("p") as any;
  value.outcomes[0].beneficiary = "unknown-person";
  engine.discovery.decision(draft.value.questions[2]!, 1, "owner", value);
  const stage = engine.draft("p", "discovery", draft.id, 0);
  assert.ok(engine.pipeline.inspect("p", "discovery").findings.some(item => item.code === "beneficiary_missing"));
  assert.throws(() => engine.pipeline.accept("p", "discovery", stage.revision), /validation refused/);
});

test("legacy accepted research keeps its era, while a new result cannot use the legacy contract", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-era-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); engine.execute({ type: "create-project", project: "legacy", title: "Legacy" });
  const source = engine.discovery.evidence.document("legacy", "brief", "Existing accepted request", "text/plain", 0);
  const old = engine.discovery.create("legacy", "discovery", "R0", "concept", LEGACY_REQUIREMENTS.discovery);
  engine.discovery.fact(old.value.questions[0]!, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
  engine.discovery.decision(old.value.questions[1]!, 1, "owner", "Original outcome");
  const record = store.get<DiscoveryDraft>(old.id)!;
  const content = { draft: reference(record), fields: record.value.fields, graph: null } as unknown as Json;
  // Simulate a canonical accepted record written by the previous contract version.
  const historical = store.write<StageArtifact>({ id: stageId("legacy", "discovery"), kind: "stage", expected: 0,
    value: { projectId: "legacy", stage: "discovery", status: "accepted", content, inputs: [], proofs: [] } });
  assert.equal(engine.pipeline.inspect("legacy", "discovery").state, "accepted");
  assert.throws(() => engine.draft("legacy", "discovery", old.id, historical.revision), /enriched research/);
  assert.deepEqual(store.get(historical.id), historical);
  const draft = engine.prepare("legacy", "discovery");
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
});

test("a feature cannot claim an unrelated specification contract even when its old outcome binding is correct", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-feature-contract-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store); preparedFeatures(engine, "p");
  const current = store.get<StageArtifact>(stageId("p", "features"))!;
  const content = current.value.content as unknown as StageContent;
  const draft = store.get<DiscoveryDraft>(content.draft.id)!;
  const id = draft.value.questions.find(id => store.get<{ spec: { field: string } }>(id)!.value.spec.field === "featurePreparation")!;
  const question = engine.discovery.reopen(id, store.get(id)!.revision);
  const details = preparedField("p", "featurePreparation") as any[];
  details[0].behaviorContracts = ["not-a-real-contract"];
  engine.discovery.decision(question.id, question.revision, "owner", details);
  const changed = engine.draft("p", "features", draft.id, current.revision);
  assert.ok(engine.pipeline.inspect("p", "features").findings.some(item => item.code === "feature_contract_foreign"));
  assert.throws(() => engine.pipeline.accept("p", "features", changed.revision), /validation refused/);
});

test("a feature cannot replace the outcome's beneficiary with another declared actor", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-feature-beneficiary-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  preparedFeatures(engine, "p", undefined, field => {
    const value = preparedField("p", field) as any;
    if (field === "preparation") {
      value.actors.push({ id: "p-admin", role: "Operator", benefit: "Support the user", channels: ["CLI"] });
      value.journeys.success.scenarios.push({ ...value.journeys.success.scenarios[0], actor: "p-admin" });
    }
    return value;
  });
  const stage = store.get<StageArtifact>(stageId("p", "features"))!;
  const draft = store.get<DiscoveryDraft>((stage.value.content as unknown as StageContent).draft.id)!;
  const id = draft.value.questions.find(id => store.get<{ spec: { field: string } }>(id)!.value.spec.field === "featurePreparation")!;
  const question = engine.discovery.reopen(id, store.get(id)!.revision);
  const details = preparedField("p", "featurePreparation") as any[];
  details[0].beneficiary = "p-admin";
  engine.discovery.decision(id, question.revision, "owner", details);
  const updated = engine.draft("p", "features", draft.id, stage.revision);
  assert.ok(engine.pipeline.inspect("p", "features").findings.some(item => item.code === "feature_beneficiary_foreign"));
  assert.throws(() => engine.pipeline.accept("p", "features", updated.revision), /validation refused/);
});
