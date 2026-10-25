import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ProductEngine, type StageContent } from "../src/product/engine.js";
import { RESEARCH_CONTRACT_VERSION } from "../src/discovery/requirements.js";
import { QUESTION_MOMENTS, QUESTION_MOMENT_CONTRACT_VERSION } from "../src/discovery/preparation-contracts.js";
import { stageId, type StageArtifact } from "../src/pipeline/contracts.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { canonical, type Json } from "../src/canonical.js";
import { preparedField } from "./preparation-fixture.js";
import { preparedFeatures } from "./product-fixture.js";

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

test("B1.1 v4 features questions require an explicit legal moment before any answer write", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-moment-schema-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), project = "p";
  preparedFeatures(engine, project);
  const savedStage = store.get<StageArtifact>(stageId(project, "features"))!;
  const draft = store.get<DiscoveryDraft>((savedStage.value.content as unknown as StageContent).draft.id)!;
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  assert.equal(QUESTION_MOMENT_CONTRACT_VERSION,4, "Question moment semantics retain their version");
  const field = "featurePreparation";
  const id = draft.value.questions.find(id => store.get<Question>(id)!.value.spec.field === field)!;
  let question = engine.discovery.reopen(id, store.get(id)!.revision);
  function valueWithQuestion(moment: unknown, present = true): Json {
    const question = { question: "Which environment condition must hold?", consumer: "p-produce-block", blocksCurrentStage: false,
      ...(present ? { moment } : {}) };
    const value = preparedField(project, field) as any;
    value[0].remainingQuestions = [question];
    return value as Json;
  }
  const before = canonical(store.list().flatMap(row => store.history(row.id)));
  for (const [present, value] of [[false, undefined], [true, undefined], [true, null], [true, "R3"], [true, "later"], [true, 4]] as const) {
    assert.throws(() => engine.discovery.decision(id, question.revision, "owner", valueWithQuestion(value, present)), { code: "answer_invalid" });
    assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
  }
  for (const moment of QUESTION_MOMENTS) {
    const value = valueWithQuestion(moment);
    const answered = engine.discovery.decision(id, question.revision, "owner", value);
    assert.deepEqual(answered.value.fields[field], value);
    if (moment !== QUESTION_MOMENTS.at(-1)) question = engine.discovery.reopen(id, store.get(id)!.revision);
  }
  const artifact = engine.draft(project, "features", draft.id, savedStage.revision);
  assert.equal(engine.pipeline.inspect(project, "features").state, "draft");
  assert.equal(engine.pipeline.accept(project, "features", artifact.revision).value.status, "accepted");
});
