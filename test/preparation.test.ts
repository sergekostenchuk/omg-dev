import { discoveryContext } from '../src/discovery/discovery-outcome.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Revision } from "../src/storage/store.js";
import { ProductEngine, type StageContent } from "../src/product/engine.js";
import { LEGACY_REQUIREMENTS, RESEARCH_CONTRACT_VERSION, VERSION3_REQUIREMENTS } from "../src/discovery/requirements.js";
import { JOURNEY_VARIANTS, QUESTION_MOMENTS, QUESTION_MOMENT_CONTRACT_VERSION } from "../src/discovery/preparation-contracts.js";
import { reference, stageId, type StageArtifact } from "../src/pipeline/contracts.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { canonical, type Json } from "../src/canonical.js";
import { preparedField, preparationValue as basePreparationValue, boundDiscoveryValue } from "./preparation-fixture.js";
import { preparedFeatures, answerDiscoveryFixture } from "./product-fixture.js";

function preparationValue(engine: ProductEngine, draft: Revision<DiscoveryDraft>): Json {
  const current = engine.store.get<DiscoveryDraft>(draft.id)!;
  const question = current.value.questions.map(id => engine.store.get<Question>(id)!).find(q => q.value.spec.field === 'preparation')!;
  return boundDiscoveryValue('preparation', basePreparationValue('p'), discoveryContext(engine.store, current, question).context);
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-preparation-")); const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "p", title: "Local transformer" });
  const source = engine.discovery.evidence.document("p", "brief", "Create a standalone local CLI transformer with validation.", "text/plain", 0);
  const draft = engine.prepare("p", "discovery");
  engine.discovery.fact(draft.value.questions[0]!, 1, reference(source), { kind: "text-range", start: 0, end: source.value.content.length });
  engine.discovery.decision(draft.value.questions[1]!, 1, "owner", "Return a validated local result");
  for (const id of draft.value.questions) {
    const question=store.get<Question>(id)!;
    if (['researchPlan','researchReport','verdict'].includes(question.value.spec.field))
      answerDiscoveryFixture(engine,'p',store.get<DiscoveryDraft>(draft.id)!,question,preparedField('p',question.value.spec.field),source);
  }
  const preparation=draft.value.questions.find(id=>store.get<Question>(id)!.value.spec.field==='preparation')!;
  return { engine, store, draft, source, root, preparation };
}

test("new initial research requires every scenario category and refuses unresolved essential inputs", t => {
  const { engine, draft, store, preparation } = fixture(t);
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  const stage = engine.draft("p", "discovery", draft.id, 0);
  assert.throws(() => engine.pipeline.accept("p", "discovery", stage.revision), /validation refused/);
  const value = preparationValue(engine, draft) as Record<string, Json>;
  const journeys = value['journeys'] as Record<string, Json>;
  assert.equal(Object.keys(journeys).length, JOURNEY_VARIANTS.length);
  delete journeys['crash_recovery'];
  assert.throws(() => engine.discovery.decision(preparation, 1, "owner", value), /field contract/);
  const blocked = preparationValue(engine, draft) as Record<string, Json>;
  blocked['unknowns'] = [{ id: "essential", question: "Which input must be transformed?", consumer: "concept", blocksCurrentStage: true, resolution: "Unavailable", moment: "om-pass" }];
  engine.discovery.decision(preparation, 1, "owner", blocked);
  const next = engine.draft("p", "discovery", draft.id, stage.revision);
  assert.ok(engine.pipeline.inspect("p", "discovery").findings.some(item => item.code === "preparation_unresolved"));
  assert.throws(() => engine.pipeline.accept("p", "discovery", next.revision), /validation refused/);
  const question = engine.discovery.reopen(preparation, store.get(preparation)!.revision);
  engine.discovery.decision(question.id, question.revision, "owner", preparationValue(engine, draft));
  const fixed = engine.draft("p", "discovery", draft.id, next.revision);
  engine.pipeline.accept("p", "discovery", fixed.revision);
  assert.equal(engine.pipeline.inspect("p", "discovery").state, "accepted");
});

test("a complete-looking preparation cannot bind a scenario to a foreign beneficiary", t => {
  const { engine, draft, preparation } = fixture(t);
  const value = preparationValue(engine, draft) as any;
  value.outcomes[0].beneficiary = "unknown-person";
  engine.discovery.decision(preparation, 1, "owner", value);
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

for (const stage of ["discovery", "features"] as const) test(`B1.1 v4 ${stage} questions require an explicit legal moment before any answer write`, t => {
  const root = mkdtempSync(join(tmpdir(), "omg-moment-schema-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), project = "p";
  preparedFeatures(engine, project);
  const savedStage = store.get<StageArtifact>(stageId(project, stage))!;
  const draft = store.get<DiscoveryDraft>((savedStage.value.content as unknown as StageContent).draft.id)!;
  assert.equal(draft.value.contractVersion, RESEARCH_CONTRACT_VERSION);
  assert.equal(QUESTION_MOMENT_CONTRACT_VERSION,4, "Question moment semantics retain their version");
  const field = stage === "discovery" ? "preparation" : "featurePreparation";
  const id = draft.value.questions.find(id => store.get<Question>(id)!.value.spec.field === field)!;
  let question = engine.discovery.reopen(id, store.get(id)!.revision);
  function valueWithQuestion(moment: unknown, present = true): Json {
    const question = { ...(stage === "discovery" ? { id: "retained", resolution: "Resolve at the declared moment" } : {}),
      question: "Which environment condition must hold?", consumer: "p-produce-block", blocksCurrentStage: false,
      ...(present ? { moment } : {}) };
    const value = (stage === "discovery" ? preparationValue(engine, draft) : preparedField(project, field)) as any;
    if (stage === "discovery") value.unknowns = [question];
    else value[0].remainingQuestions = [question];
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
  const artifact = engine.draft(project, stage, draft.id, savedStage.revision);
  assert.equal(engine.pipeline.inspect(project, stage).state, "draft");
  assert.equal(engine.pipeline.accept(project, stage, artifact.revision).value.status, "accepted");
});

test("B1.1 v4 stage research uses the declared question schema and the ordinary consumer gate", async t => {
  const { engine, store, draft, root, preparation } = fixture(t);
  const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("p", { workspace: root,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: command, timeoutMs: 4000 }, 0);
  const value = preparationValue(engine, draft) as Record<string, Json>;
  value.unknowns = [{ id: "retained", question: "Which environment condition must hold?", consumer: "concept",
    blocksCurrentStage: false, resolution: "Confirm before feasibility", moment: "feasibility" }];
  engine.discovery.decision(preparation, 1, "owner", value);
  // All research answers are already present; the real research-stage path still applies its consumer gate.
  const result = await engine.stageResearch.run("p", draft.id, 1);
  assert.equal(result.status, "accepted", JSON.stringify(result));
  assert.equal(store.list("model-call").length, 0);
  assert.equal(engine.pipeline.inspect("p", "discovery").state, "accepted");
  assert.deepEqual((store.get<StageArtifact>(stageId("p", "discovery"))!.value.content as unknown as StageContent).fields.preparation, value);
});

test("B1.1 current producer does not resume unaccepted version 3 work", async t => {
  const { engine, store } = fixture(t);
  const old = engine.discovery.create("p", "discovery", "R0", "concept", VERSION3_REQUIREMENTS.discovery, [], 3);
  const before = canonical(store.list().flatMap(row => store.history(row.id)));
  await assert.rejects(engine.stageResearch.run("p", old.id, 1), { code: "research_contract_upgrade_required" });
  assert.throws(() => engine.draft("p", "discovery", old.id, 0), { code: "research_contract_upgrade_required" });
  assert.equal(canonical(store.list().flatMap(row => store.history(row.id))), before);
});
