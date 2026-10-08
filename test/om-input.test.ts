import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest, hashJson, type Json } from "../src/canonical.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { QUESTION_MOMENTS, preparationMomentSchema, featurePreparationMomentSchema } from "../src/discovery/preparation-contracts.js";
import { collectGaps, GAP_MOMENTS, type GapSources } from "../src/om/gaps.js";
import { EngineError } from "../src/errors.js";
import { isRef, reference, type Ref, type StageArtifact } from "../src/pipeline/contracts.js";
import { Store, storeEvents, storeReads, type Revision, type Write } from "../src/storage/store.js";
import { execFileSync } from "node:child_process";
import { removeProofCache } from "../src/storage/schema.js";
import { captureView, pendingOverlay, storeView, transparentTrace } from "../src/storage/store-view.js";
import { RunControlGate, RunControlLost, stopRun } from "../src/om/run-control.js";
import { sealed } from "../src/om/refusal.js";
import { pendingCallStore } from "../src/om/model-call.js";
import { transactionForTests } from "../src/om/atomic-gate.js";
import * as proofs from "../src/history/proofs.js";
import { git, gitBytes, gitCalls } from "../src/runtime/environment.js";
import {
  buildOmInput, gateInput, prepareOmInput, writeOmInput, readOmInput, deriveOmInput, prepareExistingOmInput, prepareReopenOmInput,
  withHistoricalReads, historicalRead, historicalProof, historicalTrace, type HistoricalReadKey,
  INPUT_REFUSAL_CODES, NODES_REQUIRED_SINCE, INPUT_REFRESH_CONFLICT,
  type InputBuildResult, type InputOptions, type InputRequest, type InputStages, type OmInput, type OmInputRecord, type DerivedInputRequest,
} from "../src/om/input.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult, Refusal, Sealed } from "../src/om/refusal.js";
import { createOmFixture, gardenGraph, type OmFixture } from "./om-fixture.js";
import { ProductEngine } from "../src/product/engine.js";
import type { ResearchAssessment } from "../src/discovery/research-model.js";
import type { Source } from "../src/evidence/evidence.js";
import { inputDecisionWrite, writeAddressing, type AddressingRequest, type InputDecisionProposal } from "../src/om/addressing.js";
import { projectGraph } from "../src/graph/project.js";
import type { Graph } from "../src/graph/model.js";
import { preparedFeatures } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { acceptanceBindingId } from "../src/discovery/research-consumer-transition.js";

type Row = Record<string, any>;
const clone = <T>(value: T): T => structuredClone(value);
const fakeHash = "0".repeat(64);
function delivered<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected refusal ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refusal<T>(result: OmResult<T>, code: string): Refusal {
  if (result.ok) assert.fail(`Expected ${code}, got a delivered value`);
  assert.equal(result.refusal.code, code);
  assert.equal(result.refusal.route, "producer");
  assert.ok(result.refusal.at.unit.length > 0);
  assert.ok(result.refusal.at.target.length > 0);
  return result.refusal;
}
function addressedError(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "input_request_invalid");
  const details = error.details as Row;
  assert.ok(typeof details?.target === "string" && details.target.length > 0);
  return true;
}
function request(f: OmFixture): InputRequest {
  return { project: f.project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> };
}
function sources(f: OmFixture): InputStages {
  return Object.fromEntries(UPSTREAM_STAGES.map(stage => {
    const content = f.stages[stage].value.content as Row;
    const ref = content.draft as Ref;
    const draft = f.store.get<DiscoveryDraft>(ref.id, ref.revision)!;
    return [stage, { ref: reference(f.stages[stage]), contractVersion: draft.value.contractVersion ?? null, fields: clone(content.fields) }];
  })) as InputStages;
}
function fields(stages: InputStages, stage: UpstreamStage): Row { return stages[stage].fields; }
function hasCode(result: Sealed<InputBuildResult>, code: string): Refusal {
  assert.equal(result.input, null);
  assert.equal(result.hash, null);
  const found = result.refusals.find(item => item.code === code);
  assert.ok(found, `Missing refusal ${code}: ${result.refusals.map(item => item.code).join(", ")}`);
  assert.equal(found.route, "producer");
  assert.ok(found.at.target.length > 0);
  assert.ok(found.at.field && found.at.field.length > 0);
  assert.ok(found.at.ref);
  assert.equal(gateInput(result as InputBuildResult).passed, false);
  return found;
}
function reviseStage(f: OmFixture, stage: UpstreamStage, change: (value: StageArtifact) => void): Ref {
  const original = f.stages[stage];
  const value = clone(original.value);
  change(value);
  return reference(f.store.write({ id: original.id, kind: original.kind,
    expected: f.store.get(original.id)!.revision, value }));
}
function frozen(value: unknown): boolean {
  return value === null || typeof value !== "object" || Object.isFrozen(value) && Object.values(value).every(frozen);
}

// Rebind exact dependencies so a counterfeit is tested for its semantics, not rejected only for stale hashes.
function rebindDependents(store: Store, substitutions: Map<string, Ref>, changedIds: Set<string>): void {
  const replace = (value: Json): Json => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(replace);
    if (isRef(value)) {
      const changed = substitutions.get(canonical({ id: value.id, revision: value.revision, hash: value.hash }));
      if (changed) return { ...value, ...changed };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
  };
  for (let pass = 0; pass < 30; pass++) {
    let changed = false;
    for (const row of store.list()) {
      if (changedIds.has(row.id)) continue;
      const value = replace(row.value);
      if (canonical(value) === canonical(row.value)) continue;
      const next = store.write({ id: row.id, kind: row.kind, expected: row.revision, value });
      substitutions.set(canonical(reference(row)), reference(next));
      changed = true;
    }
    if (!changed) return;
  }
  assert.fail("Exact reference rebinding failed to reach a fixed point");
}
function currentRequest(f: OmFixture): InputRequest {
  return { project: f.project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.store.get(f.stages[stage].id)!)])) as InputRequest["stages"] };
}

test("M1 derives the five exact accepted garden sources and writes only om-input", async t => {
  const f = await createOmFixture(t);
  const before = f.store.list().map(reference);
  const pure = buildOmInput(sources(f));
  assert.deepEqual(pure.refusals, []);
  assert.deepEqual(gateInput(pure as InputBuildResult), { passed: true, codes: [] });
  assert.ok(pure.input);
  assert.equal(pure.hash, hashJson(pure.input));
  assert.equal(NODES_REQUIRED_SINCE, null);
  assert.deepEqual(pure.input.requirements, [{ id: "garden-R1", section: "garden-concept" }]);
  assert.deepEqual(pure.input.features, [{ index: 0, title: "Deliver result", outcome: "garden-result",
    behaviorIndexes: [0], requirementIds: ["garden-R1"], contracts: ["garden-B1"] }]);
  assert.deepEqual(pure.input.map.nodes, ["garden-consume-block", "garden-later-block", "garden-produce-block", "garden-product", "garden-refusal-block"]);
  for (const stage of UPSTREAM_STAGES) {
    const source: OmInput["sources"][number] = pure.input.sources.find(item => item.stage === stage)!;
    assert.deepEqual({ id: source.id, revision: source.revision, hash: source.hash }, reference(f.stages[stage]));
    assert.equal(source.contractVersion, sources(f)[stage].contractVersion);
  }
  const prepared = delivered(prepareOmInput(f.store, request(f)));
  assert.deepEqual(f.store.list().map(reference), before);
  assert.deepEqual(prepared.record.input, pure.input);
  assert.equal(prepared.record.hash, pure.hash);
  assert.deepEqual(prepared.record.gaps, pure.gaps);
  assert.equal(prepared.writes.length, 1);
  assert.equal(prepared.writes[0]!.id, "om-input:garden");
  const saved = delivered(writeOmInput(f.store, request(f)));
  assert.equal(saved.id, "om-input:garden");
  assert.equal(saved.kind, "om-input");
  assert.equal(saved.hash, hashJson(saved.value));
  assert.deepEqual(saved.value, prepared.record);
  assert.deepEqual(f.store.list().filter(row => row.id !== saved.id).map(reference), before);
  assert.ok(frozen(saved));
  assert.ok(frozen(prepared));
  assert.equal(f.store.get(saved.id)!.revision, 1);
  const repeated = delivered(writeOmInput(f.store, { ...request(f), expected: saved.revision }));
  assert.deepEqual(reference(repeated), reference(saved));
  assert.equal(f.store.get(saved.id)!.revision, 1);
  refusal(writeOmInput(f.store, request(f)), "revision_conflict");
  assert.equal(f.store.get(saved.id)!.revision, 1);
});

test("every G1 refusal has an exact producer address and leaves no om-input", async t => {
  const f = await createOmFixture(t);
  const baseline = sources(f);
  const seen = new Set<string>();
  const cases: [string, (stages: InputStages) => void, InputOptions?][] = [
    ["input_field_missing", s => { delete fields(s, "specification").behaviorContracts; }],
    ["requirement_ref_unresolved", s => { fields(s, "specification").behaviorContracts[0].requirements = ["missing-R1"]; }],
    ["contract_ref_unresolved", s => { fields(s, "features").featurePreparation[0].behaviorContracts = ["missing-B1"]; }],
    ["behavior_index_out_of_range", s => { fields(s, "features").features[0].requirements = [1]; }],
    ["outcome_artifact_unknown", s => { fields(s, "features").features[0].outcome = "missing-artifact"; }],
    ["contract_node_unknown", s => { fields(s, "specification").behaviorContracts[0].nodes = ["missing-node"]; }],
    ["feature_preparation_missing", s => { fields(s, "features").featurePreparation = []; }],
    ["feature_preparation_ambiguous", s => { const preps = fields(s, "features").featurePreparation; preps.push(clone(preps[0])); }],
    ["feature_preparation_foreign", s => { const preps = fields(s, "features").featurePreparation; preps.push({ ...clone(preps[0]), featureTitle: "foreign" }); }],
    ["question_consumer_missing", s => { fields(s, "features").featurePreparation[0].remainingQuestions = [{ question: "Where?", blocksCurrentStage: false, kind: "fact", moment: "om-pass" }]; }],
    ["stage_contract_version_unknown", s => { s.specification.contractVersion = null; }, { nodesRequiredSince: 3 }],
    ["contract_node_unbound", () => {}, { nodesRequiredSince: 3 }],
    ["acceptance_kind_missing", () => {}, { nodesRequiredSince: 3 }],
    ["contract_boundary_prose", () => {}, { nodesRequiredSince: 3 }],
  ];
  for (const [expected, mutate, options] of cases) {
    const stages = clone(baseline);
    mutate(stages);
    seen.add(hasCode(buildOmInput(stages, options), expected).code);
  }
  const draft = reviseStage(f, "features", value => { value.status = "draft"; });
  const bad = request(f); bad.stages.features = draft;
  seen.add(refusal(writeOmInput(f.store, bad), "stage_not_accepted").code);
  assert.equal(f.store.get("om-input:garden"), null);
  assert.deepEqual([...seen].sort(), [...INPUT_REFUSAL_CODES].sort());
});

test("contract era distinguishes legacy addressed gaps from new-era producer refusals", async t => {
  const f = await createOmFixture(t);
  const legacy = sources(f);
  fields(legacy, "specification").behaviorContracts[0].proof = "garden-produce-block appears only in prose";
  const old = buildOmInput(legacy);
  assert.equal(gateInput(old as InputBuildResult).passed, true);
  assert.equal(old.input!.contracts[0]!.nodes, null);
  assert.deepEqual(old.gaps.find(gap => gap.code === "contract_node_unbound")!.consumer,
    { features: [{ feature: 0, title: "Deliver result" }] });
  assert.deepEqual(old.gaps.find(gap => gap.code === "acceptance_kind_missing")!.consumer, { requirement: "garden-R1" });
  assert.ok(old.gaps.some(gap => gap.code === "contract_boundary_prose"));
  for (const value of [[], null, "garden-produce-block", [7]]) {
    const explicit = clone(legacy);
    fields(explicit, "specification").behaviorContracts[0].nodes = value;
    hasCode(buildOmInput(explicit), "contract_node_unbound");
  }
  const modern = clone(legacy);
  const contract = fields(modern, "specification").behaviorContracts[0];
  contract.nodes = ["garden-consume-block", "garden-produce-block"];
  for (const field of ["writer", "authority", "rollback"]) contract.state[field] = "garden-user";
  fields(modern, "concept").conceptSections[0].requirements[0].acceptance = [{ text: "Validated", checkKind: "test" }];
  const modernGood = buildOmInput(modern, { nodesRequiredSince: 3 });
  assert.deepEqual(modernGood.refusals, []);
  assert.deepEqual(modernGood.input!.contracts[0]!.nodes, ["garden-consume-block", "garden-produce-block"]);
  assert.equal(modernGood.input!.criteria[0]!.checkKind, "test");
  for (const checkKind of ["full-run", "environment-observation"]) {
    fields(modern, "concept").conceptSections[0].requirements[0].acceptance[0].checkKind = checkKind;
    assert.equal(buildOmInput(modern, { nodesRequiredSince: 3 }).input!.criteria[0]!.checkKind, checkKind);
  }
  delete contract.nodes;
  hasCode(buildOmInput(modern, { nodesRequiredSince: 3 }), "contract_node_unbound");
  modern.specification.contractVersion = 2;
  assert.deepEqual(buildOmInput(modern, { nodesRequiredSince: 3 }).refusals, []);
  modern.specification.contractVersion = null;
  hasCode(buildOmInput(modern, { nodesRequiredSince: 3 }), "stage_contract_version_unknown");
});

test("feature preparation binds by both title and outcome independently of its array order", async t => {
  const f = await createOmFixture(t);
  const stages = sources(f);
  const featureFields = fields(stages, "features");
  featureFields.features.push({ title: "Deliver data", outcome: "garden-data", requirements: [0] });
  featureFields.featurePreparation.push({ ...clone(featureFields.featurePreparation[0]), featureTitle: "Deliver data", outcome: "garden-data" });
  const expected = buildOmInput(stages);
  assert.deepEqual(expected.refusals, []);
  featureFields.featurePreparation.reverse();
  assert.deepEqual(buildOmInput(stages), expected);
  for (const identity of [{ featureTitle: "Wrong title" }, { outcome: "garden-prep" }]) {
    const changed = clone(stages);
    Object.assign(fields(changed, "features").featurePreparation[0], identity);
    const result = buildOmInput(changed);
    hasCode(result, "feature_preparation_missing");
    hasCode(result, "feature_preparation_foreign");
  }
  const duplicate = clone(stages);
  fields(duplicate, "features").featurePreparation.push(clone(featureFields.featurePreparation[0]));
  hasCode(buildOmInput(duplicate), "feature_preparation_ambiguous");
});

test("questions preserve producer knowledge and consumers while inventory absence is a nonblocking gap", async t => {
  const f = await createOmFixture(t);
  const stages = sources(f);
  const metadata = JSON.parse('{"name":"repository-fact","__proto__":{"source":"producer"}}') as Json;
  fields(stages, "discovery").preparation.unknowns = [{ id: "u1", question: "Which module?", consumer: "garden-produce-block",
    kind: metadata, blocksCurrentStage: false, moment: "om-pass" }];
  const questions = fields(stages, "features").featurePreparation[0].remainingQuestions = [
    { question: "Which design?", consumer: "garden-consume-block", kind: "decision", blocksCurrentStage: false, moment: "om-pass" },
    { question: "Which environment?", consumer: "garden-produce-block", kind: "environment", blocksCurrentStage: false, moment: "task-start" },
  ];
  const result = buildOmInput(stages);
  assert.equal(gateInput(result as InputBuildResult).passed, true);
  const carried = result.input!.questions.find(item => item.question === "Which module?")!;
  assert.equal(carried.consumer, "garden-produce-block");
  assert.deepEqual(carried.kind, metadata);
  assert.deepEqual(carried.source, reference(f.stages.discovery));
  assert.ok(Object.hasOwn(carried.kind as object, "__proto__"));
  assert.equal(Object.getPrototypeOf(carried.kind), Object.prototype);
  assert.equal(result.hash, hashJson(result.input));
  assert.ok(frozen(result));
  (metadata as Row).name = "changed by caller";
  assert.equal((carried.kind as Row).name, "repository-fact");
  assert.equal(({} as Row).source, undefined);
  const inventoryGap = result.gaps.find(gap => gap.code === "inventory_missing")!;
  assert.deepEqual(inventoryGap.consumer, { mechanism: "M6", uses: ["code-answer", "project-question-package"] });
  assert.equal(inventoryGap.target, "repo-inventory");
  assert.equal(inventoryGap.source, null);
  const base = buildOmInput(stages);
  questions.reverse();
  assert.deepEqual(buildOmInput(stages), base);
  const inventory = reference(f.store.write({ id: "repo-inventory:garden", kind: "repo-inventory", expected: 0,
    value: { projectId: "garden", modules: [] } }));
  const present = buildOmInput(stages, { inventory });
  assert.equal(present.gaps.some(gap => gap.code === "inventory_missing"), false);
  assert.deepEqual(present.input!.inventory, inventory);
  const prepared = delivered(prepareOmInput(f.store, { ...request(f), inventory }));
  assert.deepEqual(prepared.record.input.inventory, inventory);
  assert.ok(prepared.guards.some(guard => isRef(guard) && guard.id === inventory.id && guard.hash === inventory.hash));
  delete fields(stages, "discovery").preparation.unknowns[0].consumer;
  hasCode(buildOmInput(stages), "question_consumer_missing");
});

test("exact references and independently checked acceptance reject forged or masquerading saved stages", async t => {
  const f = await createOmFixture(t);
  for (const [change, expected] of [
    [{ id: "stage:other:features" }, "record_foreign"],
    [{ hash: fakeHash }, "record_forged"],
    [{ revision: 999999 }, "record_missing"],
    [{ hash: "invalid" }, "reference_invalid"],
  ] as const) {
    const bad = request(f); bad.stages.features = { ...bad.stages.features, ...change };
    refusal(writeOmInput(f.store, bad), expected);
  }
  for (const mutate of [
    (value: StageArtifact) => { (value.content as Row).fields.features[0].title = "Masquerade"; },
    (value: StageArtifact) => { value.proofs = []; },
    (value: StageArtifact) => { (value.content as Row).draft.revision = 999999; },
    (value: StageArtifact) => { value.projectId = "other"; },
    (value: StageArtifact) => { value.stage = "concept"; },
  ]) {
    const bad = request(f); bad.stages.features = reviseStage(f, "features", mutate);
    refusal(writeOmInput(f.store, bad), "stage_not_accepted");
    assert.equal(f.store.get("om-input:garden"), null);
  }
  const ownDraft = (f.stages.features.value.content as Row).draft as Ref;
  const originalQuestion = f.stages.features.value.proofs.map(ref => f.store.get<Row>(ref.id, ref.revision)!)
    .find(record => record.kind === "question" && record.value.draftId === ownDraft.id)!;
  const openQuestion = f.store.write({ id: originalQuestion.id, kind: originalQuestion.kind,
    expected: f.store.get(originalQuestion.id)!.revision, value: { ...clone(originalQuestion.value), status: "open", answer: null } });
  const unaccepted = request(f);
  unaccepted.stages.features = reviseStage(f, "features", value => {
    value.proofs = value.proofs.map(ref => ref.id === openQuestion.id ? reference(openQuestion) : ref);
  });
  const noAcceptance = refusal(writeOmInput(f.store, unaccepted), "stage_not_accepted");
  assert.equal(noAcceptance.at.field, "questions");
  assert.equal(f.store.get("om-input:garden"), null);
  const before = f.store.list().map(reference);
  const malformed = request(f);
  delete (malformed.stages as Partial<InputRequest["stages"]>).concept;
  refusal(prepareOmInput(f.store, malformed), "reference_invalid");
  assert.deepEqual(f.store.list().map(reference), before);
});

test("historical accepted sources keep their exact input and era after draft, stage and evidence heads change", async t => {
  const f = await createOmFixture(t);
  const original = delivered(prepareOmInput(f.store, request(f)));
  const saved = delivered(writeOmInput(f.store, request(f)));
  const ref = (f.stages.specification.value.content as Row).draft as Ref;
  const draft = f.store.get<DiscoveryDraft>(ref.id, ref.revision)!;
  f.store.write({ id: draft.id, kind: draft.kind, expected: f.store.get(draft.id)!.revision,
    value: { ...clone(draft.value), contractVersion: 999, fields: {} } });
  refusal(prepareOmInput(f.store, { ...request(f), expected: 1 }), "stage_not_accepted");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(saved))).value, original.record);
  reviseStage(f, "specification", value => { value.status = "draft"; });
  refusal(prepareOmInput(f.store, { ...request(f), expected: 1 }), "input_stale");
  const source = f.stages.discovery.value.proofs.map(proof => f.store.get<Row>(proof.id, proof.revision)!)
    .find(proof => proof.kind === "source")!;
  const content = "The new evidence head contains different source material.";
  f.store.write({ id: source.id, kind: source.kind, expected: f.store.get(source.id)!.revision,
    value: { ...clone(source.value), content, sha256: digest(content) } });
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(saved))).value, original.record);
  refusal(writeOmInput(f.store, { ...request(f), expected: 1 }), "input_stale");
  f.reopen();
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(saved))).value, original.record);
  refusal(prepareOmInput(f.store, { ...request(f), expected: 1 }), "input_stale");
  assert.equal(f.store.history(saved.id).length, 1);
});

test("historical input reads reuse the same era schema objects after source movement and Store reopen", async t => {
  const f = await createOmFixture(t, "standard", "input-schema-identities");
  const saved = delivered(writeOmInput(f.store, request(f)));
  const expectedSchemas = UPSTREAM_STAGES.flatMap(stage => {
    const accepted = f.stages[stage];
    const draftRef = (accepted.value.content as Row).draft as Ref;
    const draft = f.store.get<DiscoveryDraft>(draftRef.id, draftRef.revision)!;
    return draft.value.questions.map(id => {
      const proof = accepted.value.proofs.find(ref => ref.id === id)!;
      return canonical(f.store.get<Question>(proof.id, proof.revision)!.value.spec.schema);
    });
  });
  assert.ok(expectedSchemas.length > 0);
  const expectedContents = [...new Set(expectedSchemas)].sort();
  const compile = Ajv.prototype.compile;
  const captured: { validator: Ajv; schema: Parameters<typeof compile>[0] }[] = [];
  Ajv.prototype.compile = function (this: Ajv, ...args: Parameters<typeof compile>) {
    captured.push({ validator: this, schema: args[0] });
    return compile.apply(this, args);
  } as typeof compile;
  try {
    const historical = () => delivered(readOmInput(f.store, f.project, reference(saved)));
    assert.deepEqual(historical(), saved);
    assert.ok(captured.length > 0, "The first historical read must validate saved question schemas");
    // Graph validation also uses Ajv; select the instance that validates the whole historical question contract.
    const validators = [...new Set(captured.map(call => call.validator))].filter(validator => {
      const contents = new Set(captured.filter(call => call.validator === validator).map(call => canonical(call.schema)));
      return contents.size === expectedContents.length && expectedContents.every(content => contents.has(content));
    });
    assert.equal(validators.length, 1, "One validator must check all historical question schemas");
    const questionSchemas = () => captured.filter(call => call.validator === validators[0]).map(({ schema }) => {
      assert.ok(schema !== null && typeof schema === "object");
      return schema;
    });
    assert.deepEqual([...new Set(questionSchemas().map(canonical))].sort(), expectedContents);
    const initialIdentities = new Set(questionSchemas());
    // S1.3 (№2185-4): in the same Store the kept complete proof answers without validating again; whatever validation does
    // run — after a source moved, or cold after a reopen — uses the same schema objects.
    const repeat = (cold: boolean) => {
      captured.length = 0;
      assert.deepEqual(historical(), saved);
      const schemas = questionSchemas();
      if (cold) assert.deepEqual([...new Set(schemas.map(canonical))].sort(), expectedContents);
      else assert.ok(schemas.length === 0 || [...new Set(schemas.map(canonical))].sort().join() === expectedContents.join());
      assert.ok(schemas.every(schema => initialIdentities.has(schema)), "Historical reads must not create fresh schema identities");
      return schemas.length;
    };
    assert.equal(repeat(false), 0, "The kept proof of this Store is not validated again");
    assert.equal(repeat(false), 0);
    const source = f.store.get<Source>(`source:${f.project}:brief`)!;
    const content = `${source.value.content}\n`;
    f.store.write({ id: source.id, kind: source.kind, expected: source.revision,
      value: { ...clone(source.value), content, sha256: digest(content) } });
    repeat(false);
    // PF4 (№3499 rows 29, 40): a reopened Store takes the check this database saved, without validating again; once the
    // saved checks are gone it validates cold, with the same schema objects.
    f.reopen();
    assert.equal(repeat(false), 0, "A reopened Store answers from the saved check");
    f.store.proofCacheClear();
    f.reopen();
    assert.ok(repeat(true) > 0, "Without a saved check a reopened Store validates cold, with the same schema objects");
    assert.equal(f.store.history(saved.id).length, 1);
  } finally {
    Ajv.prototype.compile = compile;
  }
});

test("all read source heads are guarded and a neighbor cannot persist a partial prepared input", async t => {
  const f = await createOmFixture(t);
  const req = request(f);
  const prepared = delivered(prepareOmInput(f.store, req));
  for (const stage of UPSTREAM_STAGES) assert.ok(prepared.guards.some(guard => guard.id === req.stages[stage].id));
  const originalWrite = f.store.writeMany.bind(f.store);
  let injected = false;
  f.store.writeMany = ((writes, guards) => {
    if (!injected && writes.some(write => write.id === "om-input:garden")) {
      injected = true;
      const stage = f.stages.concept;
      originalWrite([{ id: stage.id, kind: stage.kind, expected: f.store.get(stage.id)!.revision, value: stage.value }]);
    }
    return originalWrite(writes, guards);
  }) as Store["writeMany"];
  refusal(writeOmInput(f.store, req), "input_stale");
  f.store.writeMany = originalWrite;
  assert.equal(injected, true);
  assert.equal(f.store.get("om-input:garden"), null);
  refusal(prepareOmInput(f.store, req), "input_stale");
  refusal(writeGuarded(f.store, { unit: "test-neighbor", target: "neighbor:garden",
    writes: [...prepared.writes, { id: "neighbor:garden", kind: "neighbor", expected: 0, value: { inputHash: prepared.record.hash } }], guards: prepared.guards }), "input_stale");
  assert.equal(f.store.get("om-input:garden"), null);
  assert.equal(f.store.get("neighbor:garden"), null);
});


test("a neighbor stores prepared input atomically and readers rederive forged payloads from saved sources", async t => {
  const f = await createOmFixture(t);
  const prepared = delivered(prepareOmInput(f.store, request(f)));
  const writes = delivered(writeGuarded(f.store, { unit: "test-neighbor", target: "neighbor:garden",
    writes: [...prepared.writes, { id: "neighbor:garden", kind: "neighbor", expected: 0, value: { inputHash: prepared.record.hash } }], guards: prepared.guards }));
  assert.deepEqual(writes.map(row => row.id), ["om-input:garden", "neighbor:garden"]);
  const good = delivered(readOmInput(f.store, f.project, reference(writes[0]!)));
  assert.deepEqual(good.value, prepared.record);
  assert.equal(good.hash, hashJson(good.value));
  const counterfeit = clone(good.value) as Row;
  counterfeit.input.features[0].title = "Counterfeit accepted feature";
  counterfeit.hash = hashJson(counterfeit.input);
  const forged = f.store.write({ id: good.id, kind: good.kind, expected: good.revision, value: counterfeit });
  assert.equal(forged.hash, hashJson(forged.value));
  refusal(readOmInput(f.store, f.project, reference(forged)), "record_forged");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(good))), good);
  assert.equal(f.store.get("neighbor:garden")!.revision, 1);
});

test("every exported boundary validates absent or malformed arguments before accessing storage", async t => {
  const f = await createOmFixture(t);
  const valid = sources(f);
  for (const bad of [undefined, null, 7, "invalid/project", []]) {
    assert.throws(() => buildOmInput(bad as unknown as InputStages), addressedError);
    assert.throws(() => gateInput(bad as unknown as InputBuildResult), addressedError);
    assert.throws(() => readOmInput(bad as unknown as Store, f.project, request(f).stages.discovery), addressedError);
    assert.throws(() => readOmInput(f.store, bad as unknown as string, request(f).stages.discovery), addressedError);
    for (const action of [prepareOmInput, writeOmInput]) {
      assert.throws(() => action(f.store, bad as unknown as InputRequest), addressedError);
      assert.throws(() => action(bad as unknown as Store, request(f)), addressedError);
    }
  }
  for (const bad of [null, 7, [], { inventory: 2 }, { nodesRequiredSince: 0 }, { nodesRequiredSince: "3" }]) {
    assert.throws(() => buildOmInput(valid, bad as unknown as InputOptions), addressedError);
  }
  for (const field of ["project", "stages", "expected"] as const) {
    for (const bad of [undefined, null, "", [], -1]) {
      for (const action of [prepareOmInput, writeOmInput]) {
        assert.throws(() => action(f.store, { ...request(f), [field]: bad } as unknown as InputRequest), addressedError);
      }
    }
  }
  for (const stage of UPSTREAM_STAGES) {
    const incomplete = clone(valid);
    delete (incomplete as Partial<InputStages>)[stage];
    const rejected = buildOmInput(incomplete);
    assert.equal(rejected.input, null);
    assert.ok(rejected.refusals.some(item => item.code === "input_field_missing" && item.at.target === `stage:${stage}`));
  }
  for (const stage of ["discovery", "concept", "operation-map", "specification", "features"] as const) {
    const absent = clone(valid); absent[stage].fields = {};
    hasCode(buildOmInput(absent), "input_field_missing");
  }
  assert.equal(f.store.get("om-input:garden"), null);
  assert.throws(() => gateInput({ ...buildOmInput(valid), refusals: undefined } as unknown as InputBuildResult), addressedError);
  const forged = clone(buildOmInput(valid));
  assert.equal(gateInput({ ...forged, hash: fakeHash } as InputBuildResult).passed, false);
  const foreign = f.store.write({ id: "om-input:garden", kind: "foreign-input", expected: 0, value: {} });
  for (const action of [prepareOmInput, writeOmInput])
    refusal<unknown>(action(f.store, { ...request(f), expected: foreign.revision }), "record_foreign");
  assert.deepEqual(reference(f.store.get(foreign.id)!), reference(foreign));
});

test("input policy keeps all five sources when the upstream module array is mutated after import", async t => {
  const f = await createOmFixture(t);
  const stageData = sources(f), req = request(f);
  const expected = buildOmInput(stageData);
  delivered(prepareOmInput(f.store, req));
  const stages = UPSTREAM_STAGES as unknown as UpstreamStage[];
  const before = [...stages];
  try {
    stages.splice(0, stages.length, "features");
    assert.deepEqual(buildOmInput(stageData), expected);
    // Pure policy is isolated; current admission must still follow the real engine when its contract changes.
    refusal(prepareOmInput(f.store, req), "stage_not_accepted");
    const incomplete = clone(stageData);
    delete (incomplete as Partial<InputStages>).discovery;
    const result = buildOmInput(incomplete);
    assert.ok(result.refusals.some(item => item.code === "input_field_missing" && item.at.target === "stage:discovery"));
    const missing = clone(req);
    delete (missing.stages as Partial<InputRequest["stages"]>).discovery;
    refusal(writeOmInput(f.store, missing), "reference_invalid");
    assert.equal(f.store.get("om-input:garden"), null);
  } finally {
    stages.splice(0, stages.length, ...before);
  }
  assert.ok(Object.isFrozen(INPUT_REFUSAL_CODES));
  assert.throws(() => { (INPUT_REFUSAL_CODES as unknown as string[]).push("forged_code"); }, TypeError);
});


test("accepted status and exact references cannot hide a forged map layer obligation", async t => {
  const f = await createOmFixture(t);
  const mapRef = (f.stages["operation-map"].value.content as Row).graph as Ref;
  const original = f.store.get<Row>(mapRef.id, mapRef.revision)!;
  const value = clone(original.value);
  value.obligations.push({ node: "no-such-node", field: "title", valueHash: fakeHash, inputs: [] });
  const forged = f.store.write({ id: original.id, kind: original.kind, expected: f.store.get(original.id)!.revision, value });
  rebindDependents(f.store, new Map([[canonical(reference(original)), reference(forged)]]), new Set([original.id]));
  assert.ok(f.engine.graphs.layerGate(f.project, 1).findings.some(finding => finding.code === "graph_field_unproven"));
  assert.equal(refusal(prepareOmInput(f.store, currentRequest(f)), "stage_not_accepted").at.field, "content.graph.obligations");
  refusal(writeOmInput(f.store, currentRequest(f)), "stage_not_accepted");
  assert.equal(f.store.get("om-input:garden"), null);
});

test("complete exact source closures still refuse behavior with no feature coverage", async t => {
  const f = await createOmFixture(t);
  const stage = f.stages.specification;
  const draftRef = (stage.value.content as Row).draft as Ref;
  const draft = f.store.get<Row>(draftRef.id, draftRef.revision)!;
  const question = stage.value.proofs.map(proof => f.store.get<Row>(proof.id, proof.revision)!)
    .find(proof => proof.kind === "question" && proof.value.spec.field === "behavior")!;
  const answerRef = question.value.answer as Ref;
  const answer = f.store.get<Row>(answerRef.id, answerRef.revision)!;
  const changes = new Map<string, Ref>();
  const update = (row: Revision<unknown>, value: unknown) => {
    const written = f.store.write({ id: row.id, kind: row.kind, expected: f.store.get(row.id)!.revision, value });
    changes.set(canonical(reference(row)), reference(written));
  };
  update(answer, { ...clone(answer.value), value: [...answer.value.value, "Uncovered behavior"] });
  const draftValue = clone(draft.value);
  draftValue.fields.behavior.push("Uncovered behavior");
  update(draft, draftValue);
  const stageValue = clone(stage.value);
  (stageValue.content as Row).fields.behavior.push("Uncovered behavior");
  update(stage, stageValue);
  rebindDependents(f.store, changes, new Set());
  assert.ok(f.engine.pipeline.inspect(f.project, "features").findings.some(finding => finding.code === "requirement_uncovered"));
  assert.equal(refusal(prepareOmInput(f.store, currentRequest(f)), "stage_not_accepted").at.field, "features.requirements");
  refusal(writeOmInput(f.store, currentRequest(f)), "stage_not_accepted");
  assert.equal(f.store.get("om-input:garden"), null);
});

async function assessedInputFixture(t: test.TestContext) {
  const f = await createOmFixture(t);
  const draftRef = (f.stages.features.value.content as Row).draft as Ref;
  const draft = f.store.get<DiscoveryDraft>(draftRef.id, draftRef.revision)!;
  const answered = draft.value.questions.map(id => f.store.get<Question>(id)!)
    .find(question => question.value.spec.field === "features")!;
  const issued = f.engine.discovery.reopen(answered.id, answered.revision);
  const source = f.store.get<Source>("source:garden:brief")!;
  const body: ResearchAssessment = {
    projectId: f.project, question: reference(issued), value: draft.value.fields['features']!,
    observations: [f.engine.discovery.evidence.observe(f.project, reference(source),
      { kind: "text-range", start: 0, end: source.value.content.length })],
    verdict: "supported", reasons: [], researcher: "fixture-researcher", assessor: "fixture-assessor",
    environment: reference(f.engine.environments.get(f.project)),
  };
  const assessment = f.store.write<ResearchAssessment>({ id: `research-assessment:${hashJson(body)}`, kind: "research-assessment", expected: 0, value: body });
  const researched = f.engine.discovery.researched(issued.id, issued.revision, reference(assessment));
  const produced = f.engine.draft(f.project, "features", researched.id, f.stages.features.revision);
  const accepted = f.engine.pipeline.accept(f.project, "features", produced.revision);
  const question = f.store.get<Question>(issued.id)!;
  assert.ok(question.revision > issued.revision);
  assert.equal(question.value.status, "answered");
  const req = currentRequest(f);
  assert.deepEqual(req.stages.features, reference(accepted));
  const inspected = f.engine.pipeline.inspect(f.project, "features");
  assert.equal(inspected.state, "accepted");
  assert.deepEqual(inspected.findings, []);
  const prepared = delivered(prepareOmInput(f.store, req));
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(question))));
  assert.equal(prepared.guards.some(guard => canonical(guard) === canonical(body.question)), false,
    "The issued assessment question is historical; its answered head is the current acceptance dependency");
  const discoveryProofs = f.stages.discovery.value.proofs.map(ref => f.store.get(ref.id, ref.revision)!);
  const dependencies = [
    { label: "source", ref: reference(source) },
    { label: "draft", ref: reference(researched) },
    { label: "question", ref: reference(question) },
    { label: "fact", ref: reference(discoveryProofs.find(row => row.kind === "fact")!) },
    { label: "decision", ref: reference(discoveryProofs.find(row => row.kind === "decision")!) },
    { label: "research-answer", ref: question.value.answer! },
    { label: "assessment", ref: reference(assessment) },
    { label: "graph-layer", ref: reference(f.store.get("graph-layer:garden:1")!) },
    { label: "graph", ref: reference(f.store.get("graph:garden")!) },
  ];
  const coveredKinds = new Set(dependencies.map(dependency => f.store.get(dependency.ref.id)!.kind));
  for (const stage of UPSTREAM_STAGES) {
    const row = f.store.get<StageArtifact>(req.stages[stage].id)!;
    for (const proof of row.value.proofs) {
      assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(proof)), `Acceptance proof guard: ${proof.id}`);
      const record = f.store.get(proof.id, proof.revision)!;
      if (record.kind !== "stage" && !coveredKinds.has(record.kind)) {
        dependencies.push({ label: record.kind, ref: proof });
        coveredKinds.add(record.kind);
      }
    }
  }
  const snapshot = await f.store.snapshot(join(f.root, "accepted-input-template"));
  return { f, req, dependencies, snapshot };
}

function bumpProof(store: Store, ref: Ref, corruptGraph = false): void {
  const head = store.get<Row>(ref.id)!;
  assert.deepEqual(reference(head), ref);
  const value = clone(head.value);
  if (corruptGraph) value.nodes.find((node: Row) => node.kind === "block").title += " changed after acceptance";
  const changed = store.write({ id: head.id, kind: head.kind, expected: head.revision, value });
  assert.equal(changed.revision, ref.revision + 1);
  if (!corruptGraph) assert.equal(changed.hash, ref.hash, "Equal bytes at a new head still invalidate an exact proof");
}

function unchangedStages(store: Store, req: InputRequest): void {
  for (const stage of UPSTREAM_STAGES) assert.deepEqual(reference(store.get(req.stages[stage].id)!), req.stages[stage]);
}

test("current preparation rejects every stale acceptance proof before creating or reusing input", async t => {
  const { f, req, dependencies, snapshot } = await assessedInputFixture(t);
  for (const mode of ["new", "existing"] as const) for (const [index, dependency] of dependencies.entries()) {
    const path = join(f.root, `before-${mode}-${index}.sqlite`);
    copyFileSync(snapshot.path, path);
    const store = new Store(path);
    try {
      const saved = mode === "existing" ? delivered(writeOmInput(store, req)) : null;
      const current = { ...req, expected: saved?.revision ?? 0 };
      const ready = delivered(prepareOmInput(store, current));
      assert.equal(ready.writes.length, mode === "existing" ? 0 : 1, dependency.label);
      assert.equal(ready.existing !== null, mode === "existing", dependency.label);
      bumpProof(store, dependency.ref, dependency.label === "graph");
      unchangedStages(store, req);
      const pipeline = new ProductEngine(store).pipeline;
      assert.equal(pipeline.inspect(f.project, "features").state, "stale", dependency.label);
      if (dependency.label !== "graph") assert.ok(UPSTREAM_STAGES.some(stage => pipeline.inspect(f.project, stage).findings
        .some(finding => finding.code === "proof_stale" && finding.target === dependency.ref.id)), dependency.label);
      const before = store.list().map(reference);
      refusal(prepareOmInput(store, current), "stage_not_accepted");
      refusal(writeOmInput(store, current), "stage_not_accepted");
      const inventory = store.write({ id: "repo-inventory:garden", kind: "repo-inventory", expected: 0,
        value: { projectId: f.project, modules: [] } });
      refusal(writeOmInput(store, { ...current, inventory: reference(inventory) }), "stage_not_accepted");
      assert.deepEqual(store.list().filter(row => row.id !== inventory.id).map(reference), before);
      assert.equal(store.history("om-input:garden").length, mode === "existing" ? 1 : 0, dependency.label);
      if (saved) assert.deepEqual(delivered(readOmInput(store, f.project, reference(saved))), saved);
    } finally {
      store.close();
    }
  }
});

for (const mode of ["new", "existing"] as const) test(`prepared ${mode} input guards every mutable acceptance dependency in a neighbor transaction`, async t => {
  const { f, req, dependencies, snapshot } = await assessedInputFixture(t);
  for (const [index, dependency] of dependencies.entries()) {
    const path = join(f.root, `race-${mode}-${index}.sqlite`);
    copyFileSync(snapshot.path, path);
    const store = new Store(path);
    try {
      const saved = mode === "existing" ? delivered(writeOmInput(store, req)) : null;
      const current = { ...req, expected: saved?.revision ?? 0 };
      const prepared = delivered(prepareOmInput(store, current));
      assert.equal(prepared.writes.length, mode === "existing" ? 0 : 1, dependency.label);
      assert.equal(prepared.existing !== null, mode === "existing", dependency.label);
      if (saved) {
        assert.deepEqual(reference(prepared.existing!), reference(saved));
        assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(saved))));
      }
      assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(dependency.ref)), dependency.label);
      bumpProof(store, dependency.ref);
      unchangedStages(store, req);
      if (dependency.label === "graph") assert.equal(new ProductEngine(store).pipeline.inspect(f.project, "features").state, "accepted",
        "A same-value graph revision is semantically accepted but the already prepared transaction must retain its read head");
      const result = writeGuarded(store, { unit: "input-neighbor", target: "neighbor:garden:a", guards: prepared.guards,
        writes: [...prepared.writes,
          { id: "neighbor:garden:a", kind: "neighbor", expected: 0, value: { inputHash: prepared.record.hash } },
          { id: "neighbor:garden:b", kind: "neighbor", expected: 0, value: { inputHash: prepared.record.hash } }] });
      assert.equal(refusal(result, "input_stale").at.target, dependency.ref.id, dependency.label);
      assert.equal(store.get("neighbor:garden:a"), null);
      assert.equal(store.get("neighbor:garden:b"), null);
      assert.equal(store.history("om-input:garden").length, mode === "existing" ? 1 : 0, dependency.label);
      if (saved) assert.deepEqual(delivered(readOmInput(store, f.project, reference(saved))), saved);
    } finally {
      store.close();
    }
  }
});

test("current acceptance preserves engine exceptions on new and existing input without writing", async t => {
  const f = await createOmFixture(t);
  const graphId = `graph:${f.project}`;
  const originalGet = f.store.get;
  const revisions = () => f.store.list().map(head => ({ head: reference(head), history: f.store.history(head.id).map(reference) }));
  const corruptionDetails = { database: f.database, entity: graphId, reason: "fixture checksum mismatch" };
  const failures = [new TypeError("fixture validator failure"), new EngineError("record_corrupt", "fixture damaged record", corruptionDetails)];
  let combinations = 0;
  for (const mode of ["new", "existing"] as const) {
    const saved = mode === "existing" ? delivered(writeOmInput(f.store, request(f))) : null;
    const req = { ...request(f), expected: saved?.revision ?? 0 };
    const prepared = delivered(prepareOmInput(f.store, req));
    assert.equal(prepared.existing !== null, mode === "existing");
    assert.equal(prepared.writes.length, mode === "existing" ? 0 : 1);
    for (const failure of failures) for (const action of [prepareOmInput, writeOmInput]) {
      const before = revisions();
      const exactError = (error: unknown): boolean => {
        assert.equal(error, failure, `${mode}: the original exception object must reach the caller`);
        if (failure instanceof EngineError) {
          assert.ok(error instanceof EngineError);
          assert.equal(error.code, "record_corrupt");
          assert.equal(error.details, corruptionDetails);
        } else assert.ok(error instanceof TypeError);
        return true;
      };
      f.store.get = function<T = Json>(id: string, revision?: number): Revision<T> | null {
        if (id === graphId && revision === undefined) throw failure;
        return originalGet.call(f.store, id, revision) as Revision<T> | null;
      };
      try {
        assert.throws(() => f.engine.pipeline.inspect(f.project, "features"), exactError);
        assert.deepEqual(revisions(), before);
        assert.throws(() => action(f.store, req), exactError);
        assert.deepEqual(revisions(), before);
      } finally {
        f.store.get = originalGet;
      }
      assert.deepEqual(revisions(), before);
      assert.equal(f.store.history(`om-input:${f.project}`).length, mode === "existing" ? 1 : 0);
      combinations++;
    }
  }
  assert.equal(combinations, 8);

  const ref = reference(f.store.get(graphId)!);
  const address = { unit: "G1", target: graphId, field: "head", ref };
  const stale = new EngineError("input_stale", "fixture acceptance dependency changed", address);
  const before = revisions();
  f.store.get = function<T = Json>(id: string, revision?: number): Revision<T> | null {
    if (id === graphId && revision === undefined) throw stale;
    return originalGet.call(f.store, id, revision) as Revision<T> | null;
  };
  try {
    assert.throws(() => f.engine.pipeline.inspect(f.project, "features"), error => error === stale);
    for (const action of [prepareOmInput, writeOmInput]) {
      const rejected = refusal<unknown>(action(f.store, { ...request(f), expected: 1 }), "input_stale");
      assert.equal(rejected.message, stale.message);
      assert.deepEqual(rejected.at, address);
      assert.deepEqual(revisions(), before);
    }
  } finally {
    f.store.get = originalGet;
  }
  assert.deepEqual(revisions(), before);
});

test("B1 existing-version admission guards current dependencies while historical input remains readable", async t => {
  const f = await createOmFixture(t);
  const saved = delivered(writeOmInput(f.store, request(f)));
  const ref = reference(saved);
  const prepared = delivered(prepareExistingOmInput(f.store, f.project, ref));
  assert.deepEqual(prepared.existing, saved);
  assert.deepEqual(prepared.writes, []);
  const graph = reference(f.store.get(`graph:${f.project}`)!);
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(graph)));
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)));
  bumpProof(f.store, graph);
  refusal(writeGuarded(f.store, { unit: "input-neighbor", target: "neighbor:garden:existing", guards: prepared.guards,
    writes: [{ id: "neighbor:garden:existing", kind: "neighbor", expected: 0, value: { input: ref } }] }), "input_stale");
  assert.equal(f.store.get("neighbor:garden:existing"), null);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), saved);
  const refreshed = delivered(prepareExistingOmInput(f.store, f.project, ref));
  assert.ok(refreshed.guards.some(guard => canonical(guard) === canonical(reference(f.store.get(graph.id)!))));
  const changed = f.store.write({ id: saved.id, kind: saved.kind, expected: saved.revision, value: saved.value });
  refusal(prepareExistingOmInput(f.store, f.project, ref), "input_stale");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), saved);
  assert.deepEqual(delivered(prepareExistingOmInput(f.store, f.project, reference(changed))).existing, changed);
});

test("B1 refuses malformed or cyclic derived input lineage before treating its body as stage output", async t => {
  const f = await createOmFixture(t);
  const saved = delivered(writeOmInput(f.store, request(f)));
  const prior = reference(saved), graph = reference(f.graphRevision);
  const before = f.store.history(saved.id).length;
  const badLineages = [null, {}, { previous: prior, graph },
    { previous: prior, graph, decisions: null },
    { previous: { ...prior, id: "om-input:foreign" }, graph, decisions: [] },
    { previous: { ...prior, revision: 1000 }, graph, decisions: [] }];
  for (const derivation of badLineages) {
    const record = f.store.write({ id: saved.id, kind: saved.kind, expected: f.store.get(saved.id)!.revision,
      value: { ...clone(saved.value), derivation } });
    refusal(readOmInput(f.store, f.project, reference(record)), "record_forged");
    refusal(prepareExistingOmInput(f.store, f.project, reference(record)), "record_forged");
  }
  assert.equal(f.store.history(saved.id).length, before + badLineages.length);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, prior)), saved);
  f.reopen();
  assert.deepEqual(delivered(readOmInput(f.store, f.project, prior)), saved);
  refusal(readOmInput(f.store, f.project, reference(f.store.get(saved.id)!)), "record_forged");
});

test("B1 derived-input request shape is checked before storage reads", async t => {
  const f = await createOmFixture(t);
  const ref = reference(f.graphRevision);
  const valid: DerivedInputRequest = { project: f.project, previous: ref, graph: ref, decisions: [] };
  const cases: unknown[] = [undefined, null, {}, { ...valid, previous: null }, { ...valid, graph: null },
    { ...valid, decisions: undefined }, { ...valid, decisions: null }, { ...valid, decisions: [null] },
    { project: f.project, kind: "fact", previous: ref, answer: null, question: ref },
    { project: f.project, kind: "fact", previous: ref, answer: ref, question: null },
    { project: f.project, kind: "unapproved", previous: ref, answer: ref, question: ref },
    { project: f.project, kind: "reopen-facts", previous: ref, invalidations: [] },
    { project: f.project, kind: "reopen-facts", previous: ref, invalidations: [{ record: ref, sources: [] }] },
    { project: f.project, kind: "reopen-facts", previous: ref,
      invalidations: [{ record: ref, sources: [{ before: ref, after: null }] }] },
    { project: f.project, kind: "reopen-facts", previous: ref,
      invalidations: [{ record: ref, sources: [{ before: ref, after: ref }, { before: ref, after: ref }] }] },
    { project: f.project, kind: "reopen-facts", previous: ref,
      invalidations: [{ record: ref, sources: [{ before: ref, after: ref }] }, { record: ref, sources: [{ before: ref, after: ref }] }] }];
  const originalGet = f.store.get;
  f.store.get = () => { throw new Error("Malformed requests must not reach storage"); };
  try {
    for (const candidate of cases) assert.throws(() => deriveOmInput(f.store, candidate as DerivedInputRequest), addressedError);
  } finally {
    f.store.get = originalGet;
  }
});

test("B1 rederives addressed versions and preserves them through reuse, source history and restart", async t => {
  const f = await createOmFixture(t);
  const base = delivered(writeOmInput(f.store, request(f)));
  const criterion = base.value.input.criteria[0]!;
  assert.equal(criterion.checkKind, null);
  const proposal = f.store.write(inputDecisionWrite({ project: f.project, input: reference(base), graph: reference(f.graphRevision),
    layers: [], decision: { target: criterion.id, field: "checkKind", value: "test" } }));
  const derivation = { project: f.project, previous: reference(base), graph: reference(f.graphRevision), decisions: [reference(proposal)] };
  const body = delivered(deriveOmInput(f.store, derivation));
  assert.equal(body.input.criteria[0]!.checkKind, "test");
  const addressed = f.store.write({ id: base.id, kind: base.kind, expected: base.revision, value: body });
  const ref = reference(addressed);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), addressed);
  for (const prepared of [delivered(prepareExistingOmInput(f.store, f.project, ref)),
    delivered(prepareOmInput(f.store, { ...request(f), expected: addressed.revision }))]) {
    assert.deepEqual(prepared.existing, addressed);
    assert.deepEqual(prepared.writes, []);
    assert.deepEqual(prepared.record, body);
    assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)));
  }
  assert.deepEqual(delivered(writeOmInput(f.store, { ...request(f), expected: addressed.revision })), addressed);
  assert.equal(f.store.history(base.id).length, 2);

  // Historical decisions and their graph must not become permanent head requirements.
  bumpProof(f.store, reference(proposal));
  bumpProof(f.store, reference(f.graphRevision));
  assert.deepEqual(delivered(prepareExistingOmInput(f.store, f.project, ref)).existing, addressed);
  f.reopen();
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), addressed);
  assert.deepEqual(delivered(prepareOmInput(f.store, { ...request(f), expected: addressed.revision })).existing, addressed);
  bumpProof(f.store, reference(f.store.get(`source:${f.project}:brief`)!));
  refusal(prepareExistingOmInput(f.store, f.project, ref), "stage_not_accepted");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), addressed);

  const nextProposal = f.store.write(inputDecisionWrite({ project: f.project, input: ref, graph: reference(f.graphRevision),
    layers: [], decision: { target: body.input.contracts[0]!.id, field: "nodes", value: ["garden-produce-block"] } }));
  const nextBody = delivered(deriveOmInput(f.store, { project: f.project, previous: ref, graph: reference(f.graphRevision),
    decisions: [reference(nextProposal)] }));
  const forged = clone(nextBody) as OmInputRecord;
  forged.input.criteria[0]!.checkKind = "environment-observation";
  forged.hash = hashJson(forged.input);
  const fake = f.store.write({ id: base.id, kind: base.kind, expected: addressed.revision, value: forged });
  refusal(readOmInput(f.store, f.project, reference(fake)), "record_forged");
  refusal(prepareExistingOmInput(f.store, f.project, reference(fake)), "record_forged");
  refusal(prepareOmInput(f.store, { ...request(f), expected: fake.revision }), "record_forged");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), addressed);
  f.reopen();
  refusal(readOmInput(f.store, f.project, reference(fake)), "record_forged");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), addressed);
});

function refreshFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "om-input-refresh-")), path = join(directory, "state.sqlite");
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = "garden", block = "garden-produce-block", { level: _level, ...graph } = projectGraph(gardenGraph(), 1);
  preparedFeatures(new ProductEngine(store), project, graph as Graph, field => {
    const value = preparedField(project, field);
    if (field === "preparation") (value as Row).unknowns = [{ id: "output-format", question: "Which repository output format is supported?",
      consumer: "The producing team", moment: "om-pass", blocksCurrentStage: false, resolution: "Read the repository during OM" }];
    return value;
  });
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as InputRequest['stages'];
  const base = delivered(writeOmInput(store, { project, stages, expected: 0 }));
  const decisions: InputDecisionProposal['decision'][] = [
    { target: base.value.input.questions[0]!.id, field: "address", value: { consumer: block, kind: "repository-fact" } },
    { target: base.value.input.contracts[0]!.id, field: "nodes", value: [block, "garden-consume-block"] },
    { target: base.value.input.contracts[0]!.id, field: "state", value: { writer: block, authority: block, rollback: block } },
    { target: base.value.input.criteria[0]!.id, field: "checkKind", value: "test" },
  ];
  const graphRef = reference(store.get(`graph:${project}`)!);
  const addressedRequest: AddressingRequest = { project, input: reference(base), graph: graphRef,
    decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project, input: reference(base), graph: graphRef, layers: [], decision }) })) };
  const addressed = delivered(writeAddressing(store, addressedRequest));
  return { get store() { return store; }, project, stages, base, addressed, addressedRequest,
    restart() { store.close(); store = new Store(path); } };
}

test("B1 inventory refresh preserves all four accepted D3 decisions through repeated refresh, history and restart", t => {
  const f = refreshFixture(t), original = f.addressed.value;
  const inventory = f.store.write({ id: "repo-inventory:garden", kind: "repo-inventory", expected: 0, value: { projectId: f.project, paths: [] } });
  const firstRequest = { project: f.project, stages: f.stages, expected: f.addressed.revision, inventory: reference(inventory) };
  const prepared = delivered(prepareOmInput(f.store, firstRequest));
  assert.deepEqual(prepared.record.input, { ...original.input, inventory: reference(inventory) });
  assert.deepEqual(prepared.record.gaps, original.gaps.filter(gap => gap.code !== "inventory_missing"));
  assert.deepEqual(prepared.record.derivation, { kind: "refresh", previous: reference(f.addressed), stages: f.stages, inventory: reference(inventory) });
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(f.addressed))));
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(reference(inventory))));
  const first = delivered(writeOmInput(f.store, firstRequest));
  assert.deepEqual(first.value, prepared.record);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(first))), first);
  assert.deepEqual(delivered(writeOmInput(f.store, { ...firstRequest, expected: first.revision })), first);

  const nextInventory = f.store.write({ id: inventory.id, kind: inventory.kind, expected: inventory.revision,
    value: { projectId: f.project, paths: ["src/main.ts"] } });
  const secondRequest = { ...firstRequest, expected: first.revision, inventory: reference(nextInventory) };
  const nextPrepared = delivered(prepareOmInput(f.store, secondRequest));
  assert.ok(nextPrepared.guards.some(guard => canonical(guard) === canonical(reference(nextInventory))));
  assert.ok(!nextPrepared.guards.some(guard => canonical(guard) === canonical(reference(inventory))), "The previous inventory is history, not a current guard");
  const second = delivered(writeOmInput(f.store, secondRequest));
  assert.deepEqual(second.value.input, { ...original.input, inventory: reference(nextInventory) });
  assert.deepEqual(second.value.input.questions, original.input.questions);
  assert.deepEqual(second.value.input.contracts, original.input.contracts);
  assert.deepEqual(second.value.input.criteria, original.input.criteria);
  assert.deepEqual(delivered(prepareExistingOmInput(f.store, f.project, reference(second))).existing, second);
  f.restart();
  for (const revision of [f.base, f.addressed, first, second]) assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(revision))), revision);
  assert.deepEqual(delivered(writeOmInput(f.store, { ...secondRequest, expected: second.revision })), second);
  assert.deepEqual(delivered(writeAddressing(f.store, f.addressedRequest)), f.addressed);
  assert.equal(f.store.history(second.id).length, second.revision);

  const withoutInventory = delivered(writeOmInput(f.store, { project: f.project, stages: f.stages, expected: second.revision, inventory: null }));
  assert.deepEqual(withoutInventory.value.input, original.input);
  assert.deepEqual(withoutInventory.value.gaps, original.gaps);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(withoutInventory))), withoutInventory);
  f.restart();
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(first))), first);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(withoutInventory))), withoutInventory);
});

test("B1 refresh refuses a changed stage basis and counterfeits cannot erase accepted decisions", t => {
  const f = refreshFixture(t);
  const inventory = f.store.write({ id: "repo-inventory:garden", kind: "repo-inventory", expected: 0, value: { projectId: f.project, paths: [] } });
  const request = { project: f.project, stages: f.stages, expected: f.addressed.revision, inventory: reference(inventory) };
  const refreshed = delivered(writeOmInput(f.store, request));
  const features = f.store.get(f.stages.features.id)!;
  const nextFeatures = f.store.write({ id: features.id, kind: features.kind, expected: features.revision, value: features.value });
  const changed = { ...request, stages: { ...f.stages, features: reference(nextFeatures) }, expected: refreshed.revision };
  const before = f.store.list().map(reference);
  refusal(prepareOmInput(f.store, changed), INPUT_REFRESH_CONFLICT);
  refusal(writeOmInput(f.store, changed), INPUT_REFRESH_CONFLICT);
  assert.deepEqual(f.store.list().map(reference), before);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(refreshed))), refreshed);

  const fake = clone(refreshed.value) as OmInputRecord;
  fake.input.questions[0]!.kind = null;
  delete fake.input.questions[0]!.addressedBy;
  fake.hash = hashJson(fake.input);
  const forged = f.store.write({ id: refreshed.id, kind: refreshed.kind, expected: refreshed.revision, value: fake });
  refusal(readOmInput(f.store, f.project, reference(forged)), "record_forged");
  refusal(prepareExistingOmInput(f.store, f.project, reference(forged)), "record_forged");
  f.restart();
  refusal(readOmInput(f.store, f.project, reference(forged)), "record_forged");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(refreshed))), refreshed);
});

test("B1 rejects stripped refresh lineage even when the replacement is a self-consistent stage-only root", t => {
  const f = refreshFixture(t);
  const inventory = f.store.write({ id: "repo-inventory:garden", kind: "repo-inventory", expected: 0, value: { projectId: f.project, paths: [] } });
  const request = { project: f.project, stages: f.stages, expected: f.addressed.revision, inventory: reference(inventory) };
  const refreshed = delivered(writeOmInput(f.store, request));
  const root = clone(f.base.value) as OmInputRecord;
  root.input.inventory = reference(inventory);
  root.hash = hashJson(root.input);
  root.gaps = root.gaps.filter(gap => gap.code !== "inventory_missing");
  assert.equal(Object.hasOwn(root, "derivation"), false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = f.store.get(refreshed.id)!;
    const counterfeit = f.store.write({ id: refreshed.id, kind: refreshed.kind, expected: previous.revision, value: root });
    assert.equal(refusal(readOmInput(f.store, f.project, reference(counterfeit)), "record_forged").at.field, "derivation");
    refusal(prepareExistingOmInput(f.store, f.project, reference(counterfeit)), "record_forged");
    refusal(prepareOmInput(f.store, { ...request, expected: counterfeit.revision }), "record_forged");
    refusal(writeOmInput(f.store, { ...request, expected: counterfeit.revision }), "record_forged");
    assert.equal(f.store.get(refreshed.id)!.revision, counterfeit.revision);
    f.restart();
    refusal(readOmInput(f.store, f.project, reference(counterfeit)), "record_forged");
    assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(refreshed))), refreshed);
  }
});

test("B1 refresh history cannot skip an accepted decision by naming an earlier root", t => {
  const f = refreshFixture(t);
  const inventory = f.store.write({ id: "repo-inventory:garden", kind: "repo-inventory", expected: 0, value: { projectId: f.project, paths: [] } });
  const skipped = clone(f.base.value) as OmInputRecord;
  skipped.input.inventory = reference(inventory);
  skipped.hash = hashJson(skipped.input);
  skipped.gaps = skipped.gaps.filter(gap => gap.code !== "inventory_missing");
  skipped.derivation = { kind: "refresh", previous: reference(f.base), stages: f.stages, inventory: reference(inventory) };
  const forged = f.store.write({ id: f.addressed.id, kind: f.addressed.kind, expected: f.addressed.revision, value: skipped });
  refusal(readOmInput(f.store, f.project, reference(forged)), "record_forged");
  refusal(prepareExistingOmInput(f.store, f.project, reference(forged)), "record_forged");
  refusal(prepareOmInput(f.store, { project: f.project, stages: f.stages, expected: forged.revision, inventory: reference(inventory) }), "record_forged");
  f.restart();
  refusal(readOmInput(f.store, f.project, reference(forged)), "record_forged");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, reference(f.addressed))), f.addressed);
});

test("B1 does not trust fact derivation claims without exact accepted answer sources", t => {
  const f = refreshFixture(t), previous = reference(f.addressed);
  const missingAnswer = { id: "om-answer:garden:missing", revision: 1, hash: fakeHash };
  const missingQuestion = { id: "om-mc1-question:garden:missing", revision: 1, hash: fakeHash };
  const request: DerivedInputRequest = { project: f.project, kind: "fact", previous,
    answer: missingAnswer, question: missingQuestion };
  const before = f.store.list().map(reference);
  refusal(deriveOmInput(f.store, request), "record_missing");
  assert.deepEqual(f.store.list().map(reference), before);

  const fake = clone(f.addressed.value) as OmInputRecord;
  const original = fake.input.questions.shift()!;
  fake.input.facts = [{ question: original, value: "invented", answer: missingAnswer, mc1Question: missingQuestion }];
  fake.hash = hashJson(fake.input);
  fake.derivation = { kind: "fact", previous, answer: missingAnswer, question: missingQuestion };
  const saved = f.store.write({ id: f.addressed.id, kind: f.addressed.kind, expected: f.addressed.revision, value: fake });
  for (const result of [readOmInput(f.store, f.project, reference(saved)), prepareExistingOmInput(f.store, f.project, reference(saved)),
    prepareOmInput(f.store, { project: f.project, stages: f.stages, expected: saved.revision })]) refusal(result as OmResult<unknown>, "record_missing");
  assert.equal(f.store.get(saved.id)!.revision, saved.revision);
  assert.deepEqual(delivered(readOmInput(f.store, f.project, previous)), f.addressed);
  f.restart();
  refusal(readOmInput(f.store, f.project, reference(saved)), "record_missing");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, previous)), f.addressed);
});

test("B1 fact lineage requires both exact producer records and the immediate predecessor", t => {
  for (const variant of ["answer", "question", "previous"]) {
    const f = refreshFixture(t), previous = reference(f.addressed), exact = reference(f.base);
    const lineage = variant === "answer" ? { kind: "fact", previous, answer: null, question: exact }
      : variant === "question" ? { kind: "fact", previous, answer: exact }
        : { kind: "fact", previous: exact, answer: exact, question: exact };
    const body = { ...clone(f.addressed.value), derivation: lineage };
    const head = f.store.get(f.addressed.id)!;
    const saved = f.store.write({ id: head.id, kind: head.kind, expected: head.revision, value: body });
    const result = refusal(readOmInput(f.store, f.project, reference(saved)), "record_forged");
    assert.equal(result.at.field, "derivation");
    f.restart();
    refusal(readOmInput(f.store, f.project, reference(f.store.get(f.addressed.id)!)), "record_forged");
    assert.deepEqual(delivered(readOmInput(f.store, f.project, previous)), f.addressed);
  }
});

test("B1 recovery is a guarded no-op without invalidated facts and still requires current stages", t => {
  const f = refreshFixture(t), ref = reference(f.addressed), before = f.store.list().map(reference);
  const prepared = delivered(prepareReopenOmInput(f.store, { project: f.project, input: ref }));
  assert.deepEqual(prepared.record, f.addressed.value);
  assert.deepEqual(prepared.existing, f.addressed);
  assert.deepEqual(prepared.writes, []);
  assert.ok(prepared.guards.some(guard => canonical(guard) === canonical(ref)));
  assert.deepEqual(f.store.list().map(reference), before);
  f.restart();
  assert.deepEqual(delivered(prepareReopenOmInput(f.store, { project: f.project, input: ref })).existing, f.addressed);
  const proof = reference(f.store.get(`source:${f.project}:brief`)!);
  bumpProof(f.store, proof);
  refusal(prepareReopenOmInput(f.store, { project: f.project, input: ref }), "stage_not_accepted");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), f.addressed);
});

test("B1 cannot use a recovery claim to reopen a question with no applied fact", t => {
  const f = refreshFixture(t), previous = reference(f.addressed);
  const ref = { id: "om-answer:garden:invented", revision: 1, hash: fakeHash };
  const source = { id: "source:garden:invented", revision: 1, hash: fakeHash };
  const derivation = { kind: "reopen-facts" as const, previous,
    invalidations: [{ record: ref, sources: [{ before: source, after: { ...source, revision: 2 } }] }] };
  const before = f.store.list().map(reference);
  refusal(deriveOmInput(f.store, { project: f.project, ...derivation }), "answer_inapplicable");
  assert.deepEqual(f.store.list().map(reference), before);
  const value = { ...clone(f.addressed.value), derivation };
  const counterfeit = f.store.write({ id: f.addressed.id, kind: f.addressed.kind, expected: f.addressed.revision, value });
  refusal(readOmInput(f.store, f.project, reference(counterfeit)), "answer_inapplicable");
  refusal(prepareReopenOmInput(f.store, { project: f.project, input: reference(counterfeit) }), "answer_inapplicable");
  f.restart();
  refusal(readOmInput(f.store, f.project, reference(counterfeit)), "answer_inapplicable");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, previous)), f.addressed);
});

test("B1 recovery request shape is checked before storage access", async t => {
  const f = await createOmFixture(t), original = f.store.get;
  f.store.get = () => { throw new Error("Malformed recovery must not read storage"); };
  try {
    for (const request of [undefined, null, {}, { project: f.project }, { project: f.project, input: null }])
      assert.throws(() => prepareReopenOmInput(f.store, request as Parameters<typeof prepareReopenOmInput>[1]), addressedError);
  } finally { f.store.get = original; }
});

test("B1 historical memo ends with its outer read and never masks later storage failures or counterfeits", t => {
  const f = refreshFixture(t), ref = reference(f.addressed), original = f.store.get;
  let exactReads = 0;
  f.store.get = function<T = Json>(id: string, revision?: number): Revision<T> | null {
    if (id === ref.id && revision === ref.revision) exactReads++;
    return original.call(this, id, revision) as Revision<T> | null;
  };
  try {
    for (let pass = 1; pass <= 2; pass++) {
      assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), f.addressed);
      assert.equal(exactReads, pass, "Each outer historical call must read its exact source again");
    }
    const failure = new EngineError("record_corrupt", "The next independent read must reach storage");
    f.store.get = function<T = Json>(id: string, revision?: number): Revision<T> | null {
      if (id === ref.id && revision === ref.revision) throw failure;
      return original.call(this, id, revision) as Revision<T> | null;
    };
    assert.throws(() => readOmInput(f.store, f.project, ref), error => error === failure);
    f.store.get = original;
    assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), f.addressed, "An exceptional read must discard its context too");
    refusal(readOmInput(f.store, f.project, { ...ref, hash: fakeHash }), "record_forged");
    refusal(readOmInput(f.store, "another-project", ref), "record_foreign");
    assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), f.addressed);
  } finally { f.store.get = original; }
});

test("B1 dependent recovery rejects missing evidence and duplicate causes before storage", async t => {
  const f = await createOmFixture(t), ref = reference(f.graphRevision);
  const invalidations = [{ record: ref, sources: [{ before: ref, after: { ...ref, revision: ref.revision + 1 } }] }];
  const dependency = { record: ref, question: ref, removed: [ref],
    conditions: [{ pointer: "/facts/0/value", before: "JSON", after: { present: false } }] };
  const broken: unknown[] = [undefined, null, [], [{ ...dependency, question: null }],
    [{ ...dependency, removed: [] }], [{ ...dependency, removed: [ref, ref] }], [dependency, dependency],
    [{ ...dependency, conditions: [] }], [{ ...dependency, conditions: [{ pointer: "/facts/0/value", after: { present: false } }] }],
    [{ ...dependency, conditions: [{ pointer: "/facts/0/value", before: "JSON", after: { present: true } }] }],
    [{ ...dependency, conditions: [{ pointer: "/facts/0/value", before: "JSON", after: { present: false, value: null } }] }]];
  const original = f.store.get;
  f.store.get = () => { throw new Error("Malformed dependency causes must not reach storage"); };
  try {
    for (const dependencies of broken) assert.throws(() => deriveOmInput(f.store,
      { project: f.project, kind: "reopen-facts", previous: ref, invalidations, dependencies } as DerivedInputRequest), addressedError);
  } finally { f.store.get = original; }
});

test("B1 saved recovery cannot hide malformed dependent causes as an absent set", t => {
  const f = refreshFixture(t), previous = reference(f.addressed);
  const answer = { id: "om-answer:garden:invented", revision: 1, hash: fakeHash };
  const source = { id: "source:garden:invented", revision: 1, hash: fakeHash };
  const body = { ...clone(f.addressed.value), derivation: { kind: "reopen-facts", previous,
    invalidations: [{ record: answer, sources: [{ before: source, after: { ...source, revision: 2 } }] }],
    dependencies: [{ record: answer, question: answer, removed: [answer],
      conditions: [{ pointer: "/facts/0/value", after: { present: false } }] }] } };
  const saved = f.store.write({ id: f.addressed.id, kind: f.addressed.kind, expected: f.addressed.revision, value: body });
  const result = refusal(readOmInput(f.store, f.project, reference(saved)), "record_forged");
  assert.equal(result.at.field, "derivation.dependencies");
  refusal(prepareReopenOmInput(f.store, { project: f.project, input: reference(saved) }), "record_forged");
  f.restart();
  refusal(readOmInput(f.store, f.project, reference(saved)), "record_forged");
  assert.deepEqual(delivered(readOmInput(f.store, f.project, previous)), f.addressed);
});

function historicalStores(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "om-history-scope-"));
  const first = new Store(join(directory, "first.sqlite")), second = new Store(join(directory, "second.sqlite"));
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  return { first, second };
}

test("historical operation scope joins nested calls and keys proofs by reader, view, project, exact ref and parameters", t => {
  const { first, second } = historicalStores(t), view = new Proxy(first, {}), otherView = new Proxy(first, {});
  const key: HistoricalReadKey = { reader: "scope.proof", project: "garden", ref: { id: "proof:garden", revision: 1, hash: fakeHash } };
  let proofs = 0;
  const cycle = () => { throw new Error("Unexpected history cycle"); };
  const read = (store: Store, requested = key) => historicalRead(store, requested, () => ++proofs, cycle);
  withHistoricalReads(() => {
    assert.equal(read(first), 1);
    assert.equal(withHistoricalReads(() => read(first)), 1, "A nested public operation shares its proven history");
    assert.equal(read(view), 2);
    assert.equal(read(view), 2);
    assert.equal(read(otherView), 3);
    assert.equal(read(second), 4);
    assert.equal(read(first, { ...key, reader: "scope.other" }), 5);
    assert.equal(read(first, { ...key, project: "other-project" }), 6);
    assert.equal(read(first, { ...key, ref: { ...key.ref, id: "proof:other" } }), 7);
    assert.equal(read(first, { ...key, ref: { ...key.ref, revision: 2 } }), 8);
    assert.equal(read(first, { ...key, ref: { ...key.ref, hash: "f".repeat(64) } }), 9);
    assert.equal(read(first, { ...key, parameters: { level: 2, scope: ["a", "b"] } }), 10);
    assert.equal(read(first, { ...key, parameters: { scope: ["a", "b"], level: 2 } }), 10);
    assert.equal(read(first, { ...key, parameters: { level: 3, scope: ["a", "b"] } }), 11);
    assert.equal(read(first, { ...key, parameters: { level: 2, scope: ["b", "a"] } }), 12);
    assert.equal(read(first), 1);
  });
  assert.equal(read(first), 13, "The next standalone operation must prove the exact source again");
  assert.equal(read(first), 14);
});

test("historical scope does not cache refusals or exceptions, detects cycles and releases all outcomes", t => {
  const { first } = historicalStores(t);
  const key: HistoricalReadKey = { reader: "scope.outcome", project: "garden", ref: { id: "proof:garden", revision: 1, hash: fakeHash } };
  type Outcome = { ok: boolean; value: string };
  const cycle = (): Outcome => ({ ok: false, value: "cycle" });
  const failed = (): Outcome => ({ ok: false, value: "unproven" });
  const succeeded = (): Outcome => ({ ok: true, value: "proved" });
  let attempts = 0;
  withHistoricalReads(() => {
    const refusal = () => { attempts++; return failed(); };
    assert.deepEqual(historicalRead(first, key, refusal, cycle, () => true), failed());
    assert.deepEqual(historicalRead(first, key, refusal, cycle, () => true), failed());
    assert.equal(attempts, 2, "An explicit cache predicate cannot turn a refusal into a cached proof");
    const failure = new EngineError("record_corrupt", "Uncaught source failure");
    assert.throws(() => historicalRead(first, key, () => { attempts++; throw failure; }, cycle), error => error === failure);
    assert.deepEqual(historicalRead(first, key, () => { attempts++; return succeeded(); }, cycle), succeeded());
    assert.deepEqual(historicalRead(first, key, () => { throw new Error("Already proved"); }, cycle), succeeded());
    assert.equal(attempts, 4);
  });
  const failure = new Error("Outer operation failed after proving a source");
  assert.throws(() => withHistoricalReads(() => {
    historicalRead(first, key, () => { attempts++; return succeeded(); }, cycle);
    throw failure;
  }), error => error === failure);
  assert.deepEqual(historicalRead(first, key, () => { attempts++; return failed(); }, cycle), failed());
  assert.equal(attempts, 6, "Neither successful scope exit nor exceptional exit retains cached proofs");
  withHistoricalReads(() => {
    assert.deepEqual(historicalRead(first, key,
      () => historicalRead(first, key, () => { throw new Error("A cycle must not execute the recursive reader"); }, cycle), cycle), cycle());
    assert.deepEqual(historicalRead(first, key, succeeded, cycle), succeeded(), "Cycle detection must remove the active entry on unwind");
  });
  assert.throws(() => withHistoricalReads(() => Promise.resolve("unsupported asynchronous operation")), addressedError);
  assert.deepEqual(historicalRead(first, key, failed, cycle), failed(), "Rejected asynchronous scope must be released too");
});

test("B1 shares historical proofs inside an operation while current admission still sees changed heads", t => {
  const f = refreshFixture(t), ref = reference(f.addressed);
  withHistoricalReads(() => {
    assert.deepEqual(delivered(prepareExistingOmInput(f.store, f.project, ref)).existing, f.addressed);
    bumpProof(f.store, reference(f.store.get(`source:${f.project}:brief`)!));
    assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), f.addressed);
    refusal(prepareExistingOmInput(f.store, f.project, ref), "stage_not_accepted");
  });
  assert.deepEqual(delivered(readOmInput(f.store, f.project, ref)), f.addressed);
});

test("S1 cold and cached proofs replay nested dependencies to every transparent collector in order with multiplicity", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'proof:a', kind: 'proof', expected: 0, value: { a: 1 } });
  const b = first.write({ id: 'proof:b', kind: 'proof', expected: 0, value: { b: 2 } });
  const key = { reader: 'S1.outer', project: 'garden', ref: reference(a) };
  const innerKey = { ...key, reader: 'S1.inner' };
  const cycle = (): never => { throw new Error('Unexpected cycle'); };
  let outer = 0, inner = 0;
  const read = (store: Store) => historicalProof(store, key, source => {
    outer++;
    const first = source.get(a.id, a.revision);
    const child = historicalProof(source, innerKey, nested => {
      inner++;
      return [nested.get(b.id, b.revision), nested.get(b.id, b.revision)];
    }, cycle);
    return [first, ...child, source.get(a.id, a.revision)];
  }, cycle);
  withHistoricalReads(() => {
    const value = read(first);
    const left: Ref[] = [], right: Ref[] = [];
    const trace = historicalTrace(historicalTrace(first, ref => left.push(ref)), ref => right.push(ref));
    assert.deepEqual(read(trace), value);
    assert.deepEqual(left, [a, b, b, a].map(reference));
    assert.deepEqual(right, left);
    const warmChild: Ref[] = [];
    historicalProof(historicalTrace(first, ref => warmChild.push(ref)), { ...key, reader: 'S1.parent' }, source => read(source), cycle);
    assert.deepEqual(warmChild, left, 'A nested cached proof replays its own nested proof dependencies too');
    assert.equal(outer, 1); assert.equal(inner, 1);
  });
  // S1.3 (№2185-4): the next operation of the same Store reuses the kept complete proofs and still replays them in full.
  const later: Ref[] = [];
  read(historicalTrace(first, ref => later.push(ref))); assert.equal(outer, 1); assert.equal(inner, 1);
  assert.deepEqual(later, [a, b, b, a].map(reference));
  // PF4 (№3499 rows 28, 29): a new Store instance of the database takes the saved checks and replays the cold stream;
  // without them it starts cold and proves again.
  const reopened = new Store(first.path); t.after(() => reopened.close());
  const restarted: Ref[] = [];
  read(historicalTrace(reopened, ref => restarted.push(ref))); assert.equal(outer, 1); assert.equal(inner, 1, 'A reopened Store takes the saved proofs');
  assert.deepEqual(restarted, [a, b, b, a].map(reference), 'A saved proof replays the full ordered stream');
  reopened.proofCacheClear();
  const cold = new Store(first.path); t.after(() => cold.close());
  read(cold); assert.equal(outer, 2); assert.equal(inner, 2, 'Without saved checks a new Store instance starts cold and proves again');
});

test("S1 deep repeated DAG stays compact without external observers", t => {
  const { first } = historicalStores(t);
  const row = first.write({ id: 'proof:dag', kind: 'proof', expected: 0, value: { value: 1 } });
  const depth = 32, calls = Array<number>(depth + 1).fill(0);
  const cycle = (): never => { throw new Error('Unexpected DAG cycle'); };
  const read = (store: Store, level: number): number => historicalProof(store,
    { reader: 'S1.deep-dag', project: 'garden', ref: reference(row), parameters: { level } }, source => {
      calls[level] = calls[level]! + 1;
      if (level === 0) { assert.deepEqual(source.get(row.id, row.revision), row); return 1; }
      return read(source, level - 1) + read(source, level - 1);
    }, cycle);
  const originalPush = Array.prototype.push;
  // Bound the regression itself: a broken flat journal must fail before allocating billions of
  // repeated events. The synchronous proof has 33 nodes and no external stream to materialize.
  Array.prototype.push = function <T>(this: T[], ...items: T[]): number {
    assert.ok(this.length + items.length <= 4096, 'A small proof DAG must not flatten an unobserved exponential read stream');
    return Reflect.apply(originalPush, this, items) as number;
  };
  try {
    withHistoricalReads(() => {
      assert.equal(read(first, depth), 2 ** depth);
      assert.deepEqual(calls, Array<number>(depth + 1).fill(1));
      assert.equal(read(first, depth), 2 ** depth);
      assert.deepEqual(calls, Array<number>(depth + 1).fill(1), 'The same DAG expands each exact proof once');
    });
    // S1.3 (№2185-4): the next operation of the same Store reuses the kept DAG; PF4 (№3499 row 29): a new Store instance
    // takes the saved DAG — one node per shared proof — and proves it again only without the saved checks.
    assert.equal(read(first, depth), 2 ** depth);
    assert.deepEqual(calls, Array<number>(depth + 1).fill(1), 'The next operation reuses the kept DAG of this Store');
    const reopened = new Store(first.path);
    try {
      assert.equal(read(reopened, depth), 2 ** depth);
      assert.deepEqual(calls, Array<number>(depth + 1).fill(1), 'A new Store instance takes the saved DAG');
      reopened.proofCacheClear();
    } finally { reopened.close(); }
    const cold = new Store(first.path);
    try {
      assert.equal(read(cold, depth), 2 ** depth);
      assert.deepEqual(calls, Array<number>(depth + 1).fill(2), 'Without saved checks a new Store instance proves the DAG again');
    } finally { cold.close(); }
  } finally { Array.prototype.push = originalPush; }
});

test("S1 distinct collectors traverse a deep repeated DAG once and keep unique ref method and head observations", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'proof:distinct-a', kind: 'proof', expected: 0, value: { value: 'a' } });
  const b = first.write({ id: 'proof:distinct-b', kind: 'proof', expected: 0, value: { value: 'b' } });
  type Observation = { ref: Ref; head: boolean; method: 'get' | 'list' | 'history' | 'prefix' };
  const expected: Observation[] = [
    { ref: reference(a), head: false, method: 'get' },
    { ref: reference(a), head: true, method: 'get' },
    { ref: reference(a), head: false, method: 'list' },
    { ref: reference(b), head: false, method: 'list' },
    { ref: reference(a), head: false, method: 'history' },
    { ref: reference(b), head: false, method: 'get' },
  ];
  const depth = 32, calls = Array<number>(depth + 1).fill(0);
  const cycle = (): never => { throw new Error('Unexpected DAG cycle'); };
  const read = (store: Store, level: number): number => historicalProof(store,
    { reader: 'S1.distinct-dag', project: 'garden', ref: reference(a), parameters: { level } }, source => {
      calls[level] = calls[level]! + 1;
      if (level === 0) {
        source.get(a.id, a.revision); source.get(a.id); source.list('proof'); source.history(a.id); source.get(b.id, b.revision);
        return 1;
      }
      return read(source, level - 1) + read(source, level - 1);
    }, cycle);
  const collect = (observations: Observation[]) => historicalTrace(first, (ref, head, method) => {
    assert.ok(observations.length < expected.length, 'A distinct collector cannot receive a duplicate observation');
    observations.push({ ref, head, method });
  }, 'distinct');
  const originalPush = Array.prototype.push;
  Array.prototype.push = function <T>(this: T[], ...items: T[]): number {
    assert.ok(this.length + items.length <= 4096, 'Distinct observation must not flatten the repeated proof DAG');
    return Reflect.apply(originalPush, this, items) as number;
  };
  try {
    withHistoricalReads(() => {
      const cold: Observation[] = [], traced = collect(cold);
      assert.equal(read(traced, depth), 2 ** depth);
      assert.deepEqual(cold, expected);
      assert.deepEqual(calls, Array<number>(depth + 1).fill(1));
      assert.equal(read(traced, depth), 2 ** depth);
      assert.deepEqual(cold, expected, 'The original collector remains a set during cached replay');
      const fresh: Observation[] = [];
      assert.equal(read(collect(fresh), depth), 2 ** depth);
      assert.deepEqual(fresh, expected, 'A newly registered collector receives the full unique dependency set from the cached DAG');
      assert.deepEqual(calls, Array<number>(depth + 1).fill(1));
    });
    // S1.3 (№2185-4): a collector of the next operation gets the full unique set from the DAG this Store kept.
    const next: Observation[] = [];
    assert.equal(read(collect(next), depth), 2 ** depth);
    assert.deepEqual(next, expected);
    assert.deepEqual(calls, Array<number>(depth + 1).fill(1));
  } finally { Array.prototype.push = originalPush; }
});

test("S1 observed repeated DAG preserves complete cold and replayed streams in order with multiplicity", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'proof:dag-a', kind: 'proof', expected: 0, value: { value: 'a' } });
  const b = first.write({ id: 'proof:dag-b', kind: 'proof', expected: 0, value: { value: 'b' } });
  type Observation = { ref: Ref; head: boolean; method: 'get' | 'list' | 'history' | 'prefix' };
  const atA: Observation = { ref: reference(a), head: false, method: 'get' };
  const atHead: Observation = { ref: reference(b), head: true, method: 'get' };
  const atHistory: Observation = { ref: reference(b), head: false, method: 'history' };
  const expected = (level: number): Observation[] => level === 0 ? [atA, atHead, atA]
    : [atA, ...expected(level - 1), atHistory, ...expected(level - 1), atA];
  const depth = 3, calls = Array<number>(depth + 1).fill(0);
  const cycle = (): never => { throw new Error('Unexpected DAG cycle'); };
  const read = (store: Store, level: number): number => historicalProof(store,
    { reader: 'S1.observed-dag', project: 'garden', ref: reference(a), parameters: { level } }, source => {
      calls[level] = calls[level]! + 1;
      source.get(a.id, a.revision);
      let value: number;
      if (level === 0) { source.get(b.id); value = 1; }
      else {
        value = read(source, level - 1);
        source.history(b.id);
        value += read(source, level - 1);
      }
      source.get(a.id, a.revision);
      return value;
    }, cycle);
  const stream = expected(depth);
  withHistoricalReads(() => {
    for (const phase of ['cold', 'cached']) {
      const left: Observation[] = [], right: Observation[] = [];
      const order: (Observation & { observer: 'left' | 'right' })[] = [];
      const traced = historicalTrace(historicalTrace(first, (ref, head, method) => {
        left.push({ ref, head, method }); order.push({ observer: 'left', ref, head, method });
      }), (ref, head, method) => {
        right.push({ ref, head, method }); order.push({ observer: 'right', ref, head, method });
      });
      assert.equal(read(traced, depth), 2 ** depth);
      assert.deepEqual(left, stream, phase + ': every actual observed reference retains its original multiplicity');
      assert.deepEqual(right, stream);
      assert.deepEqual(order, stream.flatMap(observation => [
        { observer: 'left', ...observation }, { observer: 'right', ...observation },
      ]), phase + ': each read reaches nested collectors in the original order');
      assert.deepEqual(calls, Array<number>(depth + 1).fill(1));
    }
  });
});

test("S1 mutable opaque sources invalidate their proof snapshot and never alias the base or another Store", t => {
  const { first, second } = historicalStores(t);
  const original = first.write({ id: 'proof:garden', kind: 'proof', expected: 0, value: { answer: 1 } });
  second.write({ id: original.id, kind: original.kind, expected: 0, value: original.value });
  const key = { reader: 'S1.visible', project: 'garden', ref: reference(original) };
  let hidden = false, changed = false, calls = 0;
  const pending = new Proxy(first, { get(target, member) {
    if (member === 'get') return (id: string, revision?: number) => {
      if (id === original.id) return hidden ? null : changed ? { ...original, value: { answer: 2 } } : original;
      return target.get(id, revision);
    };
    const value: unknown = Reflect.get(target, member, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const read = (store: Store) => historicalProof(store, key, source => { calls++; return source.get(original.id, original.revision); },
    (): never => { throw new Error('Unexpected cycle'); });
  withHistoricalReads(() => {
    assert.deepEqual(read(first), original);
    assert.deepEqual(read(pending), original); assert.equal(calls, 2);
    assert.deepEqual(read(historicalTrace(pending)), original); assert.equal(calls, 2);
    hidden = true; assert.equal(read(pending), null); assert.equal(calls, 3);
    assert.deepEqual(read(first), original); assert.equal(calls, 3);
    hidden = false; changed = true;
    assert.deepEqual(read(pending)?.value, { answer: 2 }); assert.equal(calls, 4, 'A forged unchanged hash does not hide a changed opaque source body');
    assert.deepEqual(read(second), original); assert.equal(calls, 5);
  });
});

test("S1 exact absence and heads are read afresh and transparent cycles release their operation after exceptions", t => {
  const { first } = historicalStores(t);
  const row = first.write({ id: 'proof:garden', kind: 'proof', expected: 0, value: { value: 1 } });
  const key = { reader: 'S1.head', project: 'garden', ref: reference(row) };
  const cycle = () => ({ ok: false as const, reason: 'cycle' });
  let calls = 0;
  const read = () => historicalProof(first, key, source => {
    calls++; return [source.get(row.id), source.get(row.id, 2)];
  }, (): never => { throw new Error('Unexpected cycle'); });
  withHistoricalReads(() => {
    assert.deepEqual(read(), [row, null]);
    const next = first.write({ id: row.id, kind: row.kind, expected: 1, value: { value: 2 } });
    assert.deepEqual(read(), [next, next]); assert.equal(calls, 2);
    assert.deepEqual(historicalProof(first, { ...key, reader: 'S1.cycle' }, source =>
      historicalProof(historicalTrace(source), { ...key, reader: 'S1.cycle' }, () => { throw new Error('Cycle ran'); }, cycle), cycle), cycle());
  });
  const failure = new Error('Scope failed');
  assert.throws(() => withHistoricalReads(() => { read(); throw failure; }), error => error === failure);
  // S1.3 (№2185-4): the kept proof over the unchanged head serves later operations, also after a failed one; a head that
  // moves makes the next operation derive again.
  read(); assert.equal(calls, 2);
  const third = first.write({ id: row.id, kind: row.kind, expected: 2, value: { value: 3 } });
  assert.deepEqual(read(), [third, first.get(row.id, 2)]); assert.equal(calls, 3);
  for (const operation of [
    () => historicalTrace(null as unknown as Store),
    () => historicalTrace(first, 3 as unknown as (ref: Ref) => void),
    () => historicalTrace(first, undefined, 'unknown' as 'ordered'),
    () => historicalTrace(first, undefined, null as unknown as 'ordered'),
    () => historicalProof(first, null as unknown as HistoricalReadKey, () => null, () => null),
    () => historicalProof(first, key, null as unknown as (store: Store) => null, () => null),
  ]) assert.throws(operation, addressedError);
});

test("S1 replay preserves each collector's get-only or complete observation contract", t => {
  const { first } = historicalStores(t);
  const row = first.write({ id: 'proof:selection', kind: 'proof', expected: 0, value: { value: 1 } });
  const key = { reader: 'S1.selection', project: 'garden', ref: reference(row) };
  let calls = 0;
  const read = (store: Store) => historicalProof(store, key, source => {
    calls++; source.get(row.id, row.revision); source.list('proof'); source.history(row.id);
  }, (): never => { throw new Error('Unexpected cycle'); });
  withHistoricalReads(() => {
    for (let repeat = 0; repeat < 2; repeat++) {
      const all: Ref[] = [], gets: Ref[] = [], order: string[] = [];
      const traced = historicalTrace(historicalTrace(first, ref => { all.push(ref); order.push('all'); }), (ref, _head, method) => {
        if (method === 'get') { gets.push(ref); order.push('get'); }
      });
      read(traced);
      assert.deepEqual(gets, [reference(row)]);
      assert.deepEqual(all, [reference(row), reference(row), reference(row)]);
      assert.deepEqual(order, ['all', 'get', 'all', 'all'], 'Replay keeps the inner-to-outer observer order of the actual read');
    }
    assert.equal(calls, 1);
  });
});

test("S1 opaque synthetic reads never become observations of a source collector during replay", t => {
  const { first } = historicalStores(t);
  const row = first.write({ id: 'proof:opaque', kind: 'proof', expected: 0, value: { value: 1 } });
  const key = { reader: 'S1.opaque-parent', project: 'garden', ref: reference(row) };
  const cycle = (): never => { throw new Error('Unexpected cycle'); };
  const read = (store: Store) => historicalProof(store, key, source => {
    source.get(row.id, row.revision);
    const opaque = new Proxy(source, { get(target, member) {
      if (member === 'get') return () => ({ ...row, revision: 2 });
      const value: unknown = Reflect.get(target, member, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    historicalProof(opaque, { ...key, reader: 'S1.opaque-child' }, pending => pending.get(row.id, 2), cycle);
  }, cycle);
  withHistoricalReads(() => {
    const cold: Ref[] = [], warm: Ref[] = [];
    read(historicalTrace(first, ref => cold.push(ref)));
    read(historicalTrace(first, ref => warm.push(ref)));
    assert.deepEqual(cold, [reference(row)]);
    assert.deepEqual(warm, cold, 'Synthetic reads behind an opaque boundary were never read through the source collector');
  });
});

/** Two Store instances — two connections — over one database file. */
function sameFileStores(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "om-history-kept-"));
  const first = new Store(join(directory, "state.sqlite")), second = new Store(join(directory, "state.sqlite"));
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  return { first, second };
}
const noCycle = (): never => { throw new Error('Unexpected cycle'); };

test("S1.3 kept complete proofs serve later operations of one Store and are derived again when a read head, an absent record, a list or a history moves — through this Store or another connection", t => {
  const { first, second } = sameFileStores(t);
  const a = first.write({ id: 'kept:a', kind: 'kept', expected: 0, value: { v: 1 } });
  const key = { reader: 'S1.3.kept', project: 'garden', ref: reference(a) };
  let calls = 0;
  const read = (store: Store) => historicalProof(store, key, source => {
    calls++;
    return { head: source.get(a.id), absent: source.get('kept:absent'), list: source.list('kept').map(reference), history: source.history(a.id).map(reference) };
  }, noCycle);
  const value = read(first); assert.equal(calls, 1);
  assert.deepEqual(read(first), value); assert.equal(calls, 1, 'The next operation reuses the kept proof');
  first.write({ id: 'kept:unrelated', kind: 'other', expected: 0, value: {} });
  assert.deepEqual(read(first), value); assert.equal(calls, 1, 'A write elsewhere is checked, not derived again');
  second.write({ id: 'kept:absent', kind: 'other', expected: 0, value: {} });
  assert.notEqual(read(first).absent, null); assert.equal(calls, 2, 'Absence → presence through another connection');
  second.write({ id: 'kept:b', kind: 'kept', expected: 0, value: {} });
  assert.equal(read(first).list.length, 2); assert.equal(calls, 3, 'A new listed record');
  second.write({ id: a.id, kind: a.kind, expected: 1, value: { v: 2 } });
  const moved = read(first);
  assert.deepEqual([moved.head!.revision, moved.history.length, calls], [2, 2, 4], 'A new head and history');
  assert.deepEqual(read(first), moved); assert.equal(calls, 4);
  // PF4 (№3499 rows 29, 36): another Store instance of the database — a second connection, a reopened one — takes the
  // saved check; without it, it is its own cold source.
  assert.deepEqual(read(second), moved); assert.equal(calls, 4, 'The second Store instance takes the saved check');
  const reopened = new Store(first.path); t.after(() => reopened.close());
  assert.deepEqual(read(reopened), moved); assert.equal(calls, 4, 'A reopened Store takes the saved check');
  reopened.proofCacheClear();
  const cold = new Store(first.path); t.after(() => cold.close());
  assert.deepEqual(read(cold), moved); assert.equal(calls, 5, 'Without a saved check a new Store instance starts cold');
});

test("S1.3 incomplete proofs stay within one operation: an untraced read of a plain Store, a closure read inside a traced proof, and a traced proof nesting one; a complete proof outlives it", t => {
  const { first } = historicalStores(t);
  const row = first.write({ id: 'incomplete:a', kind: 'proof', expected: 0, value: {} });
  const key = { reader: 'S1.3.incomplete', project: 'garden', ref: reference(row) };
  let untraced = 0, closure = 0, outer = 0, clean = 0;
  const plain = () => historicalRead(first, { ...key, reader: 'S1.3.untraced' }, () => { untraced++; return first.get(row.id); }, noCycle);
  const captured = () => historicalProof(first, { ...key, reader: 'S1.3.closure' }, () => { closure++; return first.get(row.id); }, noCycle);
  const nesting = () => historicalProof(first, { ...key, reader: 'S1.3.outer' }, source => { outer++; return [source.get(row.id, 1), plain()]; }, noCycle);
  const complete = () => historicalProof(first, { ...key, reader: 'S1.3.complete' }, source => { clean++; return source.get(row.id, 1); }, noCycle);
  const round = () => withHistoricalReads(() => { plain(); captured(); nesting(); complete(); plain(); nesting(); });
  round(); assert.deepEqual([untraced, closure, outer, clean], [1, 1, 1, 1], 'Inside one operation every proof is derived once');
  round(); assert.deepEqual([untraced, closure, outer, clean], [2, 2, 2, 1], 'Only the complete proof outlives its operation');
  round(); assert.deepEqual([untraced, closure, outer, clean], [3, 3, 3, 1]);
});

test("S1.3 write-only views of one Store share its kept proofs and keep their own write policies; a capture, a subclass and a view whose target read was replaced keep their own area", t => {
  const { first } = historicalStores(t);
  const row = first.write({ id: 'views:a', kind: 'proof', expected: 0, value: { v: 1 } });
  const key = { reader: 'S1.3.views', project: 'garden', ref: reference(row) };
  let runs = 0;
  const prove = (store: Store) => historicalProof(store, key, source => { runs++; return reference(source.get(row.id)!); }, noCycle);
  const refused: Write[][] = [];
  const left = storeView(first, { write: (writes, guards) => first.writeMany(writes, guards) });
  const right = storeView(first, { write: writes => { refused.push(writes); throw new EngineError('policy_refused', 'This view never writes'); } });
  const chain = storeView(left, { write: (writes, guards) => left.writeMany(writes, guards) });
  assert.deepEqual(prove(left), reference(row)); assert.equal(runs, 1);
  assert.deepEqual([prove(right), prove(chain), prove(first)], [reference(row), reference(row), reference(row)]);
  assert.equal(runs, 1, 'One derivation serves the Store and every write-only view built over it');
  assert.throws(() => right.write({ id: row.id, kind: row.kind, expected: 1, value: { v: 2 } }), (error: unknown) => (error as EngineError).code === 'policy_refused');
  assert.deepEqual([refused.length, first.get(row.id)!.revision], [1, 1], 'A refused write of one view reaches its own policy only and publishes nothing');
  assert.deepEqual(prove(chain), reference(row)); assert.equal(runs, 1, 'The shared proof stays current after the refused write');
  const moved = left.write({ id: row.id, kind: row.kind, expected: 1, value: { v: 2 } });
  assert.deepEqual(prove(right), reference(moved)); assert.equal(runs, 2, 'A write through a neighbour view moves the shared proof');
  const capture = captureView(first, {}).view;
  let before = runs;
  prove(capture); prove(capture); assert.equal(runs, before + 2, 'A capture derives in each operation');
  class Subclass extends Store {}
  const subclass = new Subclass(first.path); t.after(() => subclass.close());
  before = runs; prove(subclass); prove(subclass); assert.equal(runs, before + 2, 'A subclass is no proved Store');
  const original = Store.prototype.get;
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) { return original.apply(this, args); } as typeof original;
  try {
    before = runs; prove(left); prove(left);
    assert.equal(runs, before + 2, 'A view whose target read was replaced after it was built is no longer that Store');
  } finally { Store.prototype.get = original; }
  before = runs; prove(left); assert.equal(runs, before, 'With the original read restored the view is that Store again');
});

test("S1.3 observers of any view of the Store receive the full ordered and distinct stream from a proof warmed through the Store or a neighbour; a lower collector and a pending overlay are not merged", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'observed:a', kind: 'proof', expected: 0, value: { v: 'a' } });
  const b = first.write({ id: 'observed:b', kind: 'proof', expected: 0, value: { v: 'b' } });
  const key = { reader: 'S1.3.observed', project: 'garden', ref: reference(a) };
  type Observation = { ref: Ref; head: boolean; method: 'get' | 'list' | 'history' | 'prefix' };
  const expected: Observation[] = [
    { ref: reference(a), head: false, method: 'get' }, { ref: reference(b), head: true, method: 'get' },
    { ref: reference(a), head: false, method: 'history' }, { ref: reference(a), head: false, method: 'get' },
  ];
  let runs = 0;
  const read = (store: Store) => historicalProof(store, key, source => {
    runs++; return [source.get(a.id, a.revision), source.get(b.id), source.history(a.id), source.get(a.id, a.revision)].map(row => canonical(row as Json));
  }, noCycle);
  const policy = { write: (writes: Write[], guards: Parameters<Store['writeMany']>[1]) => first.writeMany(writes, guards) };
  const view = storeView(first, policy), neighbour = storeView(first, policy);
  const observe = (store: Store, sink: Observation[], mode: 'ordered' | 'distinct' = 'ordered') =>
    historicalTrace(store, (ref, head, method) => { sink.push({ ref, head, method }); }, mode);
  read(first); assert.equal(runs, 1);
  const ordered: Observation[] = [], distinct: Observation[] = [], again: Observation[] = [];
  read(observe(view, ordered)); read(observe(neighbour, distinct, 'distinct'));
  withHistoricalReads(() => { read(neighbour); read(observe(view, again)); });
  assert.equal(runs, 1);
  assert.deepEqual(ordered, expected, 'The ordered stream keeps its order and multiplicity');
  assert.deepEqual(distinct, expected.slice(0, 3), 'The distinct set keeps each observation once');
  assert.deepEqual(again, expected);
  const below: Ref[] = [];
  const overCollector = storeView(historicalTrace(first, ref => below.push(ref)), policy);
  read(overCollector); read(overCollector);
  assert.equal(runs, 3, 'A view over a lower collector derives in each operation');
  assert.equal(below.length, 8, 'The lower collector saw every read of both derivations');
  const pending = new Proxy(first, { get(target, member) {
    const value: unknown = Reflect.get(target, member, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  read(pending); read(pending); assert.equal(runs, 5, 'An arbitrary overlay keeps its own per-operation area');
});

test("S1.3 the control of a pass is never cached: a proof warmed through RunControlGate stays a read; after a stop from another Store the next guarded write is refused, while an unguarded write of an admitted call goes on", t => {
  const { first, second } = sameFileStores(t);
  const project = 'garden';
  const row = first.write({ id: 'gate:a', kind: 'proof', expected: 0, value: { v: 1 } });
  const gate = new RunControlGate(first, project), view = gate.view();
  view.write({ id: 'gate:admitted', kind: 'proof', expected: 0, value: { at: 'admission' } });
  let runs = 0;
  const key = { reader: 'S1.3.gate', project, ref: reference(row) };
  const prove = (store: Store) => historicalProof(store, key, source => { runs++; return reference(source.get(row.id)!); }, noCycle);
  assert.deepEqual(prove(view), reference(row)); assert.deepEqual(prove(first), reference(row)); assert.equal(runs, 1);
  const stopped = stopRun(second, { project });
  assert.ok(stopped.ok && stopped.value.stopped);
  assert.deepEqual(prove(view), reference(row)); assert.equal(runs, 1, 'Reading a kept proof through the gate view is no admission');
  assert.throws(() => view.write({ id: 'gate:new', kind: 'proof', expected: 0, value: {} }),
    (error: unknown) => error instanceof RunControlLost && error.refusal.code === 'run_stopped');
  assert.equal(first.get('gate:new'), null, 'The refused guarded write published nothing');
  first.write({ id: 'gate:receipt', kind: 'proof', expected: 0, value: { of: 'gate:admitted' } });
  assert.ok(first.get('gate:receipt'), 'The accounting of an admitted call is written without today\'s control');
});

test("S1.3 kept proofs are bounded, and a kept value is never a shared mutable object: a later operation gets an independent copy, a frozen value is shared as is", t => {
  const { first } = historicalStores(t);
  const row = first.write({ id: 'bounded:a', kind: 'proof', expected: 0, value: { v: 1 } });
  const calls = new Map<number, number>();
  const read = (index: number) => historicalProof(first, { reader: 'S1.3.bounded', project: 'garden', ref: reference(row), parameters: { index } }, source => {
    calls.set(index, (calls.get(index) ?? 0) + 1); return source.get(row.id, 1)!.revision + index;
  }, noCycle);
  for (let index = 0; index <= 600; index++) read(index);
  read(600); assert.equal(calls.get(600), 1, 'The latest proofs stay kept');
  read(0); assert.equal(calls.get(0), 2, 'The oldest proof beyond the bound was dropped and is derived again');
  let mutableRuns = 0, frozenRuns = 0;
  const mutable = () => historicalProof(first, { reader: 'S1.3.mutable', project: 'garden', ref: reference(row) }, source => {
    mutableRuns++; return { rows: [reference(source.get(row.id, 1)!)] };
  }, noCycle);
  const frozen = () => historicalProof(first, { reader: 'S1.3.frozen', project: 'garden', ref: reference(row) }, source => {
    frozenRuns++; return sealed({ rows: [reference(source.get(row.id, 1)!)] });
  }, noCycle);
  const firstValue = mutable();
  firstValue.rows.push({ id: 'changed', revision: 9, hash: 'f'.repeat(64) });
  const secondValue = mutable();
  assert.equal(mutableRuns, 1);
  assert.notEqual(secondValue, firstValue);
  assert.deepEqual(secondValue, { rows: [reference(row)] }, 'A change made by one operation never reaches the next');
  secondValue.rows.length = 0;
  assert.deepEqual(mutable(), { rows: [reference(row)] });
  const shared = frozen();
  assert.equal(frozen(), shared); assert.equal(frozenRuns, 1, 'A frozen value is shared as is');
});

/** A temporary Git repository with one commit. */
function gitRepository(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "om-history-git-")), repository = join(root, "repo");
  mkdirSync(repository); t.after(() => rmSync(root, { recursive: true, force: true }));
  git(repository, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repository, "README.md"), "one\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "one"]);
  return repository;
}

test("S1.3 (№2217 а) every entry into git and gitBytes is counted before it runs — success, a nonzero exit, a failed start — and a proof whose action ran git, even catching its error, is not kept", t => {
  const { first } = historicalStores(t);
  const repository = gitRepository(t), missing = join(repository, "no-such-directory");
  const row = first.write({ id: 'git:a', kind: 'proof', expected: 0, value: {} });
  const cases: [string, () => unknown, boolean][] = [
    ['git success', () => git(repository, ['rev-parse', 'HEAD']), true],
    ['gitBytes success', () => gitBytes(repository, ['rev-parse', 'HEAD']), true],
    ['git nonzero exit', () => git(repository, ['rev-parse', '--verify', 'refs/heads/absent']), false],
    ['gitBytes nonzero exit', () => gitBytes(repository, ['cat-file', '-e', 'f'.repeat(40)]), false],
    ['git failed start', () => git(missing, ['rev-parse', 'HEAD']), false],
    ['gitBytes failed start', () => gitBytes(missing, ['status']), false],
  ];
  for (const [name, call, succeeds] of cases) {
    const before = gitCalls();
    if (succeeds) call(); else assert.throws(call, (error: unknown) => (error as EngineError).code === 'git_failed', name);
    assert.equal(gitCalls(), before + 1, name + ' is counted once');
    let runs = 0;
    const read = () => historicalProof(first, { reader: 'S1.3.git-case', project: 'garden', ref: reference(row), parameters: { name } }, source => {
      runs++;
      try { call(); } catch { /* the action keeps its own answer */ }
      return reference(source.get(row.id, 1)!);
    }, noCycle);
    read(); read();
    assert.equal(runs, 2, name + ': a proof that ran git is derived again in the next operation');
  }
});

test("S1.3 (№2217 б) a proof that runs git is derived in every operation of an unchanged Store: a new commit gives the new result, a vanished repository a refusal, never the saved success", t => {
  const { first } = historicalStores(t);
  const repository = gitRepository(t);
  const row = first.write({ id: 'git:head', kind: 'proof', expected: 0, value: {} });
  let runs = 0;
  const head = () => historicalProof(first, { reader: 'S1.3.git-head', project: 'garden', ref: reference(row) }, source => {
    runs++; source.get(row.id, 1);
    return git(repository, ['rev-parse', 'HEAD']);
  }, noCycle);
  const one = head();
  assert.equal(head(), one); assert.equal(runs, 2, 'Two operations of an unchanged Store derive it twice');
  writeFileSync(join(repository, "README.md"), "two\n");
  git(repository, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-qam", "two"]);
  assert.notEqual(head(), one, 'A new commit gives the new result'); assert.equal(runs, 3);
  rmSync(repository, { recursive: true, force: true });
  assert.throws(head, (error: unknown) => (error as EngineError).code === 'git_failed', 'A vanished repository refuses; no saved success answers');
  assert.equal(runs, 4);
});

test("S1.3 (№2217 в) a child that ran git, warmed inside an operation and taken from its cache by a parent, makes the parent incomplete: in the next operation neither is carried over", t => {
  const { first } = historicalStores(t);
  const repository = gitRepository(t);
  const row = first.write({ id: 'git:nested', kind: 'proof', expected: 0, value: {} });
  const key = { reader: 'S1.3.git-child', project: 'garden', ref: reference(row) };
  let children = 0, parents = 0;
  const child = (store: Store) => historicalProof(store, key, source => { children++; source.get(row.id, 1); return git(repository, ['rev-parse', 'HEAD']); }, noCycle);
  const parent = (store: Store) => historicalProof(store, { ...key, reader: 'S1.3.git-parent' }, source => {
    parents++; return [reference(source.get(row.id, 1)!), child(source)];
  }, noCycle);
  withHistoricalReads(() => {
    child(first);
    const before = gitCalls();
    parent(first);
    assert.equal(gitCalls(), before, 'The parent took the warmed child from the cache: its own count did not move');
    assert.deepEqual([children, parents], [1, 1]);
  });
  parent(first);
  assert.deepEqual([children, parents], [2, 2], 'Neither the child nor the parent was kept as complete');
});

test("S1.3 (№2217 г) a complete Store-only proof is kept, and git calls outside its action — before it, between operations — do not switch the cache off", t => {
  const { first } = historicalStores(t);
  const repository = gitRepository(t);
  const row = first.write({ id: 'git:clean', kind: 'proof', expected: 0, value: {} });
  let runs = 0;
  const read = (store: Store) => historicalProof(store, { reader: 'S1.3.git-clean', project: 'garden', ref: reference(row) }, source => {
    runs++; return reference(source.get(row.id, 1)!);
  }, noCycle);
  withHistoricalReads(() => { git(repository, ['rev-parse', 'HEAD']); read(first); });
  git(repository, ['status', '--porcelain']);
  assert.deepEqual(read(first), reference(row)); assert.equal(runs, 1, 'The Store-only proof was kept across operations');
  git(repository, ['rev-parse', 'HEAD']);
  assert.deepEqual(read(first), reference(row)); assert.equal(runs, 1);
});

test('B1.1 both v4 question producers require explicit moments before normalization and preserve per-source eras', async t => {
  const f = await createOmFixture(t), stages = sources(f);
  const unknown = { id: 'late', question: 'Which environment is needed?', consumer: 'garden-produce-block',
    kind: 'environment-confirmation', blocksCurrentStage: false, resolution: 'Observe the requested moment', moment: 'feasibility' };
  const remaining = { question: 'Which result environment is needed?', consumer: 'garden-consume-block',
    kind: 'environment-confirmation', blocksCurrentStage: false, moment: 'task-result' };
  fields(stages, 'discovery').preparation.unknowns = [unknown];
  fields(stages, 'features').featurePreparation[0].remainingQuestions = [remaining];
  const valid = buildOmInput(stages);
  assert.deepEqual(valid.refusals, []);
  assert.deepEqual(valid.input!.questions.map(q => [q.id, q.moment]), [['feature:0:1', 'task-result'], ['discovery:late', 'feasibility']]);
  assert.equal(valid.hash, hashJson(valid.input));
  for (const origin of ['discovery', 'features'] as const) for (const missing of ['absent', null, undefined, 'R3', 'later', 0]) {
    const changed = clone(stages), raw = origin === 'discovery' ? fields(changed, origin).preparation.unknowns[0]
      : fields(changed, origin).featurePreparation[0].remainingQuestions[0];
    if (missing === 'absent') delete raw.moment; else raw.moment = missing;
    const error = hasCode(buildOmInput(changed), 'input_field_missing');
    assert.ok(error.at.field!.endsWith('.moment')); assert.deepEqual(error.at.ref, stages[origin].ref);
  }
  for (const oldStage of ['discovery', 'features'] as const) {
    const mixed = clone(stages); mixed[oldStage].contractVersion = 3;
    const old = oldStage === 'discovery' ? fields(mixed, oldStage).preparation.unknowns[0]
      : fields(mixed, oldStage).featurePreparation[0].remainingQuestions[0];
    delete old.moment;
    const result = buildOmInput(mixed); assert.deepEqual(result.refusals, []);
    for (const question of result.input!.questions) {
      const oldQuestion = question.source.id === mixed[oldStage].ref.id;
      assert.equal(Object.hasOwn(question, 'moment'), !oldQuestion);
    }
  }
});

test('B1.1 deadline policy survives exported-table mutation across producer B1 and D1', async t => {
  const f = await createOmFixture(t), stages = sources(f);
  fields(stages, 'discovery').preparation.unknowns = [{ id: 'late', question: 'Which environment is required?',
    consumer: 'garden-produce-block', blocksCurrentStage: false, resolution: 'Confirm before feasibility', moment: 'feasibility' }];
  fields(stages, 'features').featurePreparation[0].remainingQuestions = [{ question: 'Which consumer environment is required?',
    consumer: 'garden-consume-block', blocksCurrentStage: false, moment: 'feasibility' }];
  const expected = buildOmInput(stages); assert.deepEqual(expected.refusals, []);
  const gapSource = (moment: string): GapSources => {
    const result = clone(expected) as InputBuildResult;
    for (const question of result.input!.questions) Object.assign(question, { kind: 'environment-confirmation', moment });
    result.hash = hashJson(result.input);
    return { inputResult: result, graph: f.graph, horizon: { nodes: ['garden-produce-block', 'garden-consume-block'] },
      frameGaps: { operations: [], works: [] } };
  };
  const validGaps = gapSource('feasibility'), expectedGaps = collectGaps(validGaps);
  assert.deepEqual(expectedGaps.refusals, []);
  assert.equal(expectedGaps.gaps.filter(gap => gap.code === 'predecessor_question' && gap.moment === 'feasibility').length, 2);
  const producerChecks = (data: InputStages) => {
    // Compile after the mutation attempt, so a prior Ajv cache cannot hide a changed declaration.
    const ajv = new Ajv({ strict: true, allowUnionTypes: true });
    return [ajv.compile(preparationMomentSchema as object)(fields(data, 'discovery').preparation),
      ajv.compile(featurePreparationMomentSchema as object)(fields(data, 'features').featurePreparation)];
  };
  assert.deepEqual(producerChecks(stages), [true, true]);
  const foreign = clone(stages);
  fields(foreign, 'discovery').preparation.unknowns[0].moment = 'later';
  fields(foreign, 'features').featurePreparation[0].remainingQuestions[0].moment = 'later';
  const exported = QUESTION_MOMENTS as unknown as string[], original = [...exported];
  for (const change of [() => exported.splice(exported.indexOf('feasibility'), 1), () => exported.push('later')]) {
    try {
      try { change(); } catch (error) { assert.ok(error instanceof TypeError); }
      assert.deepEqual(buildOmInput(stages), expected);
      hasCode(buildOmInput(foreign), 'input_field_missing');
      assert.deepEqual(collectGaps(validGaps), expectedGaps);
      assert.ok(collectGaps(gapSource('later')).refusals.some(item => item.code === 'gap_moment_unknown'));
      assert.deepEqual(producerChecks(stages), [true, true]);
      assert.deepEqual(producerChecks(foreign), [false, false]);
      assert.deepEqual(GAP_MOMENTS, original);
    } finally {
      if (!Object.isFrozen(exported)) exported.splice(0, exported.length, ...original);
    }
  }
});

// ── D8.4.2 (договор №2230): B1 через общий читатель принятого ответа ──

test("D8.4.2 R13: a stage accepted on a managed answer carries K in its proofs; B1 builds and reads historically on the same trail; a lost K refuses", async t => {
  const f = await createOmFixture(t);
  const draftRef = (f.stages.features.value.content as Row).draft as Ref;
  const draft = f.store.get<DiscoveryDraft>(draftRef.id, draftRef.revision)!;
  const answered = draft.value.questions.map(id => f.store.get<Question>(id)!)
    .find(question => question.value.spec.field === "features")!;
  const issued = f.engine.discovery.reopen(answered.id, answered.revision);
  // The paid runner answers the reopened question with the current field content: a managed acceptance.
  writeFileSync(join(f.root, "features-answer.json"), JSON.stringify(draft.value.fields['features']));
  const adapter = join(f.root, "two-role-adapter.mjs");
  writeFileSync(adapter, `import{readFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
const research=s.role==='assess-answer'?{verdict:'supported',reasons:[]}
 :{action:'answer',question:s.questions[0].id,value:JSON.parse(readFileSync(${JSON.stringify(join(f.root, "features-answer.json"))},'utf8')),citations:[{source:${JSON.stringify(reference(f.store.get("source:garden:brief")!))},selector:{kind:'text-range',start:0,end:12}}]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:5,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.get(f.project);
  f.engine.environments.configure(f.project, { workspace: environment.value.workspace,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 5000 }, environment.revision);
  const run = await f.engine.researcher.run(f.project, draft.id, 1);
  assert.equal(run.value.status, "completed", JSON.stringify(run.value));
  const question = f.store.get<Question>(issued.id)!;
  assert.equal(question.value.status, "answered");
  const answerRef = question.value.answer!;
  assert.ok(answerRef.id.includes(":managed-v1:"), "the answer sits at the managed address");
  const bindingId = acceptanceBindingId(f.project, decodeURIComponent(answerRef.id.split(":managed-v1:")[1]!));
  assert.ok(f.store.get(bindingId), "K is written");
  // Re-accept the features stage: the gate's guards carry K into the stage's proofs.
  const produced = f.engine.draft(f.project, "features", f.store.get(draft.id)!.id, f.stages.features.revision);
  const accepted = f.engine.pipeline.accept(f.project, "features", produced.revision);
  assert.ok(accepted.value.proofs.some(ref => ref.id === bindingId), "K is an immutable basis of the stage's proofs");
  const req = currentRequest(f);
  req.stages.features = reference(accepted);
  const prepared = delivered(prepareOmInput(f.store, req));
  assert.ok(prepared.guards.some(guard => guard.id === bindingId), "the B1 trail keeps the exact K");
  delivered(writeOmInput(f.store, req));
  f.reopen();
  delivered(prepareOmInput(f.store, req));
  // A lost K: B1 refuses instead of silently reading the managed answer.
  const raw = new DatabaseSync(join(f.root, "state.sqlite"));
  try {
    raw.exec("PRAGMA foreign_keys=OFF");
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_delete");
    raw.prepare("DELETE FROM revisions WHERE entity_id=?").run(bindingId);
    raw.prepare("DELETE FROM heads WHERE entity_id=?").run(bindingId);
  } finally { raw.close(); }
  f.reopen();
  const lost = refusal(prepareOmInput(f.store, req), "stage_not_accepted");
  assert.equal(lost.code, "stage_not_accepted");
  assert.ok(lost.message.includes("acceptance"), JSON.stringify(lost));
});

// A reader of the audited list (S1.4, №2410 C1): its cases are told apart by parameters. Any other reader keeps S1.3 (C2).
const LISTED = 'M6.route-result';

test("S1.4 every read of a closure-captured Store is observed at the Store — head and exact get, absence, list with and without kind, an empty list, history, identities in four modes: the proof outlives its operation, and a dependency a second Store creates or changes is derived again, never answered stale", t => {
  const { first, second } = sameFileStores(t);
  const a = first.write({ id: 's14:a', kind: 'k', expected: 0, value: { v: 0 } });
  let n = 0;
  const bump = (id: string, kind = 'k') => { const head = second.get(id); second.write({ id, kind, expected: head?.revision ?? 0, value: { v: ++n } }); };
  const cases: [string, (store: Store) => unknown, () => void][] = [
    ['get head', store => store.get(a.id), () => bump(a.id)],
    ['get absent head', store => store.get('s14:absent'), () => bump('s14:absent')],
    ['get absent revision', store => store.get('s14:later', 1), () => bump('s14:later')],
    ['list of a kind', store => store.list('k2'), () => bump('s14:k2', 'k2')],
    ['list of all', store => store.list(), () => bump('s14:any', 'k4')],
    ['history', store => store.history('s14:h'), () => bump('s14:h')],
    ['identities get', store => store.identities('get', 's14:ig'), () => bump('s14:ig')],
    ['identities list', store => store.identities('list', 'k3'), () => bump('s14:il', 'k3')],
    ['identities history', store => store.identities('history', 's14:ih'), () => bump('s14:ih')],
    ['identities prefix', store => store.identities('prefix', 's14:ip:'), () => bump('s14:ip:x')],
  ];
  for (const [name, read, change] of cases) {
    let runs = 0;
    const prove = () => withHistoricalReads(() => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: name } },
      () => { runs++; return canonical(read(first) as Json); }, noCycle));
    const cold = prove();
    assert.equal(prove(), cold); assert.equal(runs, 1, `${name}: the unchanged observed trail serves the next operation without the body`);
    change();
    assert.notEqual(prove(), cold, `${name}: the dependency a second Store changed is derived again`); assert.equal(runs, 2);
    prove(); assert.equal(runs, 2, `${name}: the new derivation is kept in its turn`);
  }
  // Positive control: a head moved by a second Store does not cancel the proof of an exact revision; a new Store derives.
  let exact = 0;
  const proveExact = (store: Store) => withHistoricalReads(() => historicalRead(store, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: 'exact' } },
    () => { exact++; return canonical(store.get(a.id, 1) as Json); }, noCycle));
  const saved = proveExact(first); bump(a.id);
  assert.equal(proveExact(first), saved); assert.equal(exact, 1, 'A later head leaves the proved exact revision lawful');
  // PF4 (№3499 row 29): another Store instance of the database takes the saved check; without it, it derives.
  assert.equal(proveExact(second), saved); assert.equal(exact, 1, 'Another Store instance takes the saved check');
  second.proofCacheClear();
  const cold = new Store(first.path); t.after(() => cold.close());
  assert.equal(proveExact(cold), saved); assert.equal(exact, 2, 'Without a saved check another Store instance starts cold');
  // Q4: a prefix identity read is a dependency on its literal range only — outside changes keep the proof,
  // a new head inside the range moves its signature and is derived again.
  let prefixRuns = 0;
  const provePrefix = () => withHistoricalReads(() => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: 'prefix-range' } },
    () => { prefixRuns++; return canonical(first.identities('prefix', 's14:po:') as unknown as Json); }, noCycle));
  const ranged = provePrefix();
  bump('s14:outside');
  assert.equal(provePrefix(), ranged); assert.equal(prefixRuns, 1, 'A change outside the prefix range keeps the proof');
  bump('s14:po:new');
  assert.notEqual(provePrefix(), ranged); assert.equal(prefixRuns, 2, 'A new head inside the range is a new dependency');
  // Q4-F4: an EMPTY prefix result is a dependency too — a second Store's write inside the range retires it,
  // exactly as an exact-get of an absent revision does.
  let emptyRuns = 0;
  const proveEmpty = () => withHistoricalReads(() => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: 'prefix-empty' } },
    () => { emptyRuns++; return canonical(first.identities('prefix', 's14:empty:') as unknown as Json); }, noCycle));
  const empty = proveEmpty();
  assert.equal(proveEmpty(), empty); assert.equal(emptyRuns, 1, 'The empty range answer is kept while nothing lands inside');
  bump('s14:empty:appeared');
  assert.notEqual(proveEmpty(), empty); assert.equal(emptyRuns, 2, 'A second Store writing inside the once-empty range retires the saved proof');
});

test("S1.4 nested readers pass their trail and incompleteness up, also from a cache: cold and kept children, git, a foreign Store, a child over a non-proven view and a read that threw keep the parent out; the observer is released after an exception; a trace with the observer counts each read once and replays what the cold run showed", t => {
  const { first, second } = historicalStores(t);
  const a = first.write({ id: 's14n:a', kind: 'k', expected: 0, value: { v: 1 } }), b = first.write({ id: 's14n:b', kind: 'k', expected: 0, value: { v: 2 } });
  second.write({ id: a.id, kind: 'k', expected: 0, value: { foreign: true } });
  const repository = gitRepository(t), counts: Record<string, number> = {};
  const read = (reader: string, action: () => unknown, store: Store = first) => historicalRead(store, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: reader } },
    () => { counts[reader] = (counts[reader] ?? 0) + 1; return canonical(action() as Json); }, noCycle);
  const child = () => read('child', () => first.get(a.id));
  const parents = [
    () => read('parent.cold', () => [child(), first.get(b.id)]),
    () => read('parent.cached', () => [child(), first.get(b.id, 1)]),
    () => read('parent.git', () => [first.get(a.id), gitBytes(repository, ['rev-parse', 'HEAD']).length]),
    () => read('parent.foreign', () => [first.get(a.id), second.get(a.id)]),
    () => read('parent.opaque', () => [first.get(a.id), read('child.opaque', () => first.get(a.id), captureView(first).view)]),
    () => read('parent.threw', () => { assert.throws(() => first.get(Symbol('unbindable') as unknown as string)); /* started, never completed */ return first.get(a.id); }),
  ];
  withHistoricalReads(() => { for (const parent of parents) parent(); });
  withHistoricalReads(() => { for (const parent of parents) parent(); read('parent.late', () => [child(), first.get(b.id)]); });
  withHistoricalReads(() => read('parent.late', () => [child(), first.get(b.id)]));
  assert.deepEqual({ ...counts }, { child: 1, 'parent.cold': 1, 'parent.cached': 1, 'parent.git': 2, 'parent.foreign': 2, 'child.opaque': 2,
    'parent.opaque': 2, 'parent.threw': 2, 'parent.late': 1 }, 'Complete parents, over cold, cached and kept children, are kept; every other one is derived again');
  assert.throws(() => withHistoricalReads(() => read('boom', () => { first.get(a.id); throw new Error('boom'); })), /boom/);
  withHistoricalReads(() => read('after.boom', () => first.get(b.id))); withHistoricalReads(() => read('after.boom', () => first.get(b.id)));
  assert.equal(counts['after.boom'], 1, 'The observer is released after an exception: the next proof is observed and kept');
  const seen: string[][] = [];
  const traced = () => {
    const refs: string[] = [], view = historicalTrace(first, ref => { refs.push(ref.id); });
    const value = withHistoricalReads(() => read('traced', () => [view.get(a.id), first.get(b.id)], view));
    seen.push(refs); return value;
  };
  assert.equal(traced(), traced());
  assert.equal(counts.traced, 1, 'A trace and the Store observer count each read once: the proof is complete and kept');
  assert.deepEqual(seen, [[a.id], [a.id]], 'The replay shows the trace what the cold run showed it; the closure read stays invisible to both');
  // A proof derived through the plain Store is kept for plain callers only: a traced caller of a later operation derives it
  // once through its trace, and that traced proof then replays to the next traced operation what a cold run would show.
  const viaRoot = (store: Store) => read('replay', () => store.get(a.id), store);
  withHistoricalReads(() => viaRoot(first));
  const shown: string[][] = [];
  for (let i = 0; i < 2; i++) {
    const refs: string[] = [], view = historicalTrace(first, ref => { refs.push(ref.id); });
    withHistoricalReads(() => viaRoot(view)); shown.push(refs);
  }
  assert.deepEqual(shown, [[a.id], [a.id]], 'Each traced operation is shown exactly what its cold run would show');
  assert.equal(counts.replay, 2, 'Derived once plain, once traced; the traced proof serves the next traced operation');
  // Ordered and distinct traces: the kept replay equals the cold trail, with its multiplicity in order and once as a set.
  const twiceRead = (store: Store) => read('modes', () => [store.get(a.id), store.get(b.id), store.get(a.id)], store);
  const trails = (mode: 'ordered' | 'distinct') => {
    const refs: string[] = [], view = historicalTrace(first, ref => { refs.push(ref.id); }, mode);
    withHistoricalReads(() => twiceRead(view)); return refs;
  };
  assert.deepEqual([trails('ordered'), trails('ordered'), trails('distinct'), trails('distinct')],
    [[a.id, b.id, a.id], [a.id, b.id, a.id], [a.id, b.id], [a.id, b.id]], 'Cold and kept trails are equal in both modes');
  assert.equal(counts.modes, 1, 'The second, third and fourth traced operations replay the kept traced proof');
  // A closed source in a proof's trail sends the next use to derive again, and that derivation's own error stands.
  const closing = new Store(join(second.path + '.other')); t.after(() => { try { closing.close(); } catch { /* closed */ } });
  closing.write({ id: a.id, kind: 'k', expected: 0, value: { other: true } });
  withHistoricalReads(() => {
    const viaClosing = () => read('closing', () => [first.get(a.id), closing.get(a.id)]);
    viaClosing(); closing.close();
    assert.throws(viaClosing, (error: unknown) => (error as EngineError).code === 'store_busy', 'The derivation again meets the closed Store itself');
  });
  assert.equal(counts.closing, 2);
});

test("S1.4 a pending overlay, a write rolled back or refused by a view policy and an opaque view keep no proof beyond the operation; write-only views share one and keep their own policies; a stop after warm-up still refuses the guarded write", t => {
  const { first, second } = sameFileStores(t);
  const a = first.write({ id: 's14c:a', kind: 'k', expected: 0, value: { v: 1 } });
  let runs = 0;
  const twice = (reader: string, store: Store, action: () => unknown) => {
    const before = runs;
    for (let i = 0; i < 2; i++) withHistoricalReads(() => historicalRead(store, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: reader } },
      () => { runs++; return canonical(action() as Json); }, noCycle));
    return runs - before;
  };
  const pending = pendingCallStore(first, [{ id: 's14c:pending', kind: 'k', expected: 0, value: { v: 1 } }]);
  assert.equal(twice('pending', pending, () => pending.get('s14c:pending')), 2, 'A pending overlay is no proved family of the Store');
  assert.equal(twice('rolled-back', first, () => {
    try { first.write({ id: a.id, kind: 'k', expected: 9, value: {} }); } catch { /* rolled back */ }
    return first.get(a.id);
  }), 2, 'A rolled-back write attempt keeps the proof out');
  const refusing = storeView(first, { write: () => { throw new EngineError('policy_refused', 'This view never writes'); } });
  assert.equal(twice('refused', first, () => {
    try { refusing.write({ id: a.id, kind: 'k', expected: 1, value: {} }); } catch { /* refused by the policy */ }
    return first.get(a.id);
  }), 2, 'A write the policy refused before any Store is still an attempt');
  const opaque = new Proxy(first, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
  assert.equal(twice('opaque', opaque, () => opaque.get(a.id)), 2, 'An opaque view is no proved family');
  const once = runs;
  withHistoricalReads(() => { for (let i = 0; i < 3; i++) historicalRead(opaque, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: 'opaque.once' } },
    () => { runs++; return canonical(opaque.get(a.id) as Json); }, noCycle); });
  assert.equal(runs - once, 1, 'Inside one operation it is still derived once: reads the Store observes behind it do not make it unreplayable');
  assert.equal(first.get(a.id)!.revision, 1, 'Nothing was published');
  const refused: Write[][] = [];
  const left = storeView(first, { write: (writes, guards) => first.writeMany(writes, guards) });
  const right = storeView(first, { write: writes => { refused.push(writes); throw new EngineError('policy_refused', 'This view never writes'); } });
  let views = 0;
  const viaView = (view: Store) => withHistoricalReads(() => historicalRead(view, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: 'views' } },
    () => { views++; return canonical(view.get(a.id) as Json); }, noCycle));
  viaView(left); viaView(right); viaView(left);
  assert.equal(views, 1, 'Write-only views of one Store share its kept untraced proof');
  assert.throws(() => right.write({ id: a.id, kind: 'k', expected: 1, value: {} }), (error: unknown) => (error as EngineError).code === 'policy_refused');
  assert.equal(refused.length, 1, 'The kept proof carries no policy: the refusing view refuses on its own');
  left.write({ id: a.id, kind: 'k', expected: 1, value: { v: 2 } });
  viaView(right); assert.equal(views, 2, 'A write through a neighbour view moves the shared proof');
  const gate = new RunControlGate(first, 'garden'), control = gate.view();
  let gated = 0;
  const viaGate = () => withHistoricalReads(() => historicalRead(control, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { case: 'gate' } },
    () => { gated++; return canonical(control.get(a.id) as Json); }, noCycle));
  viaGate(); viaGate(); assert.equal(gated, 1);
  const stopped = stopRun(second, { project: 'garden' });
  assert.ok(stopped.ok && stopped.value.stopped);
  viaGate(); assert.equal(gated, 1, 'Reading a kept proof through the gate view is no admission');
  assert.throws(() => control.write({ id: 's14c:new', kind: 'k', expected: 0, value: {} }),
    (error: unknown) => error instanceof RunControlLost && error.refusal.code === 'run_stopped');
  assert.equal(first.get('s14c:new'), null, 'The stop is checked after the cache hit: the guarded write published nothing');
});

test("S1.4 (return №1, №2395) a read projection in a closure — a capture's pending row — keeps the proof incomplete: the next operation sees what the projection holds now, flat and nested, also when its child proof is reused inside the parent's operation", t => {
  const { first } = historicalStores(t);
  const anchor = first.write({ id: 's14r:anchor', kind: 'k', expected: 0, value: {} });
  const pending = captureView(first, { rows: new Map() });
  const counts = { child: 0, parent: 0 };
  const key = { reader: LISTED, project: 'garden', ref: reference(anchor), parameters: { case: 'capture' } };
  const child = () => historicalRead(first, key, () => {
    counts.child++; return canonical([first.get(anchor.id, 1), pending.view.get('s14r:candidate')?.value ?? null] as Json);
  }, noCycle);
  const parent = () => historicalRead(first, { ...key, parameters: { case: 'capture.parent' } }, () => { counts.parent++; return [child(), child()].join('|'); }, noCycle);
  const flat = withHistoricalReads(child), nested = withHistoricalReads(parent);
  assert.deepEqual(counts, { child: 2, parent: 1 }, 'Inside one operation the child is derived once and reused by its parent');
  pending.view.write({ id: 's14r:candidate', kind: 'k', expected: 0, value: { pending: true } });
  const flatAfter = withHistoricalReads(child), nestedAfter = withHistoricalReads(parent);
  assert.notEqual(flatAfter, flat); assert.match(flatAfter, /"pending":true/, 'The next operation sees the row the projection holds now');
  assert.notEqual(nestedAfter, nested); assert.match(nestedAfter, /"pending":true/, 'The parent of such a child is no kept proof either');
  assert.deepEqual(counts, { child: 4, parent: 2 }, 'Neither the flat nor the nested proof was kept across operations');
  assert.equal(first.get('s14r:candidate'), null, 'The pending row lives in the projection only');
});

test("S1.4 (return №2, №2410 C1–C3) only a listed reader is kept on what the Store observed; a Transaction preview read from a closure — get, list or history, even while it delegates down — keeps the proof incomplete, flat and as a child warmed before its parent", t => {
  const { first } = historicalStores(t);
  const anchor = first.write({ id: 's14t:anchor', kind: 'k', expected: 0, value: {} });
  const key = (reader: string, kase: string) => ({ reader, project: 'garden', ref: reference(anchor), parameters: { case: kase } });
  const counts: Record<string, number> = {};
  const prove = (reader: string, kase: string, action: () => unknown) => historicalRead(first, key(reader, kase),
    () => { counts[kase] = (counts[kase] ?? 0) + 1; return canonical(action() as Json); }, noCycle);
  // C1/C2: the same body over the plain Store — kept for a listed reader, derived in every operation for any other one.
  for (let i = 0; i < 2; i++) withHistoricalReads(() => { prove(LISTED, 'listed', () => first.get(anchor.id, 1)); prove('S1.4.unlisted', 'unlisted', () => first.get(anchor.id, 1)); });
  assert.deepEqual([counts.listed, counts.unlisted], [1, 2], 'The observer gives completeness to a listed reader only (C1); any other keeps S1.3 (C2)');
  // C3: the preview answers from its pending writes; every read of it is untraced, also while it still delegates down.
  const tx = transactionForTests(first);
  const reads: [string, () => unknown][] = [
    ['get', () => tx.view.get('s14t:candidate')?.value ?? null],
    ['list', () => tx.view.list('k').map(row => row.id)],
    ['history', () => tx.view.history('s14t:candidate').map(row => row.revision)],
  ];
  const child = (name: string, read: () => unknown) => prove(LISTED, `tx.${name}`, () => [first.get(anchor.id, 1), read()]);
  const parent = (name: string, read: () => unknown) => prove(LISTED, `tx.parent.${name}`, () => [child(name, read), first.get(anchor.id, 1)]);
  const before = reads.map(([name, read]) => withHistoricalReads(() => [child(name, read), parent(name, read)]));
  tx.add({ writes: [{ id: 's14t:candidate', kind: 'k', expected: 0, value: { pending: true } }], guards: [] });
  const after = reads.map(([name, read]) => withHistoricalReads(() => [child(name, read), parent(name, read)]));
  reads.forEach(([name], index) => {
    assert.notDeepEqual(after[index], before[index], `${name}: the next operation sees what the preview holds now, flat and nested`);
    assert.deepEqual([counts[`tx.${name}`], counts[`tx.parent.${name}`]], [2, 2], `${name}: neither the child nor its parent was kept`);
  });
  assert.equal(first.get('s14t:candidate'), null, 'The preview never wrote to the Store');
});

test("R5 (№2451-1, -5) the old om/input entries and history/proofs are the same functions over one state: mixed and nested calls share one proof and replay it in full", t => {
  assert.deepEqual([historicalRead, historicalProof, historicalTrace, withHistoricalReads],
    [proofs.historicalRead, proofs.historicalProof, proofs.historicalTrace, proofs.withHistoricalReads]);
  const { first } = historicalStores(t);
  const a = first.write({ id: 'r5:a', kind: 'k', expected: 0, value: {} });
  const key = { reader: 'R5.mixed', project: 'garden', ref: reference(a) };
  let runs = 0;
  const refs: string[] = [], view = historicalTrace(first, ref => { refs.push(ref.id); });
  const prove = (entry: typeof historicalProof) => entry(view, key, source => { runs++; return canonical(source.get(a.id, 1) as Json); }, noCycle);
  withHistoricalReads(() => { prove(proofs.historicalProof); proofs.withHistoricalReads(() => prove(historicalProof)); });
  assert.equal(runs, 1, 'One proof across the old and the new entry, the nested scope sharing the outer one');
  assert.deepEqual(refs, [a.id, a.id], 'The second use replays the whole trail to the trace');
});

test("R5 (№2451-4, -5) an exception releases the operation scope and an async action is the former input_request_invalid at G1/om-input — through either entry", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'r5:b', kind: 'k', expected: 0, value: {} });
  let runs = 0;
  const read = () => historicalRead(first, { reader: 'R5.released', project: 'garden', ref: reference(a) }, () => { runs++; return canonical(first.get(a.id, 1) as Json); }, noCycle);
  assert.throws(() => proofs.withHistoricalReads(() => { read(); throw new Error('boom'); }), /boom/);
  withHistoricalReads(read);
  assert.equal(runs, 2, 'The failed operation left no scope behind: the next one derives on its own');
  for (const scope of [withHistoricalReads, proofs.withHistoricalReads])
    assert.throws(() => scope(() => Promise.resolve(1)), (error: unknown) => error instanceof EngineError && error.code === 'input_request_invalid'
      && error.message === 'OM input needs a well-formed request' && canonical(error.details as Json) === canonical({ unit: 'G1', target: 'om-input', field: 'history.async' }));
});

test("R5 (№2451-3) the recovery's pending view owns its rows and is a trusted snapshot only over a source that is one: over a genuine Store a repeated proof checks no footprint, over an arbitrary Proxy it reads its source again", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'r5:c', kind: 'k', expected: 0, value: { v: 0 } });
  const rows = [{ id: 'r5:pending', kind: 'k', revision: 1, hash: hashJson({ v: 1 }), value: { v: 1 } as Json }];
  const trusted = proofs.pendingSnapshotView(first, rows);
  rows[0]!.value = { v: 2 };
  assert.deepEqual(trusted.get('r5:pending')!.value, { v: 1 }, 'The view owns its rows');
  assert.ok(Object.isFrozen(trusted.get('r5:pending')));
  assert.deepEqual(trusted.get(a.id), first.get(a.id), 'Every other read falls through to the source');
  const proxy = new Proxy(first, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
  const untrusted = proofs.pendingSnapshotView(proxy, rows);
  const original = Store.prototype.get;
  let gets = 0;
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) { gets++; return original.apply(this, args); } as typeof original;
  t.after(() => { Store.prototype.get = original; });
  const repeatReads = (view: Store) => withHistoricalReads(() => {
    const prove = () => historicalProof(view, { reader: 'R5.pending', project: 'garden', ref: reference(a) }, source => canonical(source.get(a.id, 1) as Json), noCycle);
    prove(); const before = gets; prove(); return gets - before;
  });
  assert.equal(repeatReads(trusted), 0, 'An exact read of a trusted snapshot is immutable: nothing to check again');
  assert.ok(repeatReads(untrusted) > 0, 'Over an arbitrary Proxy the snapshot is not trusted: its footprint is read again');
});

test("R5 (return №1, №2471) the recovery's pending view owns a deep frozen copy of its rows: a nested object or array changed through the caller's argument or through a returned row never changes a trusted exact proof", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'r5d:a', kind: 'k', expected: 0, value: {} });
  const value = { nested: { n: 1 }, list: [1, { m: 1 }] };
  const rows = [{ id: 'r5d:pending', kind: 'k', revision: 1, hash: hashJson(value), value: value as unknown as Json }];
  const view = proofs.pendingSnapshotView(first, rows);
  let runs = 0;
  const prove = () => historicalProof(view, { reader: 'R5.deep', project: 'garden', ref: reference(a) },
    source => { runs++; return canonical(source.get('r5d:pending', 1)!.value as Json); }, noCycle);
  withHistoricalReads(() => {
    const cold = prove();
    value.nested.n = 2; (value.list[1] as { m: number }).m = 2; value.list.push(3);
    assert.deepEqual(view.get('r5d:pending', 1)!.value, { nested: { n: 1 }, list: [1, { m: 1 }] }, 'Changing the argument changes nothing the view holds');
    const returned = view.get('r5d:pending', 1)!.value as { nested: { n: number }; list: unknown[] };
    assert.throws(() => { returned.nested.n = 3; }, TypeError);
    assert.throws(() => { returned.list.push(4); }, TypeError);
    assert.equal(prove(), cold); assert.equal(runs, 1, 'The repeat of the exact proof is the same, and still true of the view');
    assert.equal(canonical(view.get('r5d:pending', 1)!.value as Json), cold);
  });
  assert.ok(!Object.isFrozen(value) && !Object.isFrozen(value.nested) && !Object.isFrozen(value.list), "The caller's objects are not frozen in place");
});

// PF1 (№2797): proofs through the pending overlays of the storage helper.
function countingStore(t: TestContext) {
  // Installed before any overlay is built: an overlay binds the reads it finds, and a read replaced later breaks its chain.
  const counts = { runs: 0, gets: 0, identities: 0 };
  const original = { get: Store.prototype.get, identities: Store.prototype.identities };
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original.get>) { counts.gets++; return original.get.apply(this, args); } as typeof original.get;
  Store.prototype.identities = function (this: Store, ...args: Parameters<typeof original.identities>) { counts.identities++; return original.identities.apply(this, args); } as typeof original.identities;
  t.after(() => { Store.prototype.get = original.get; Store.prototype.identities = original.identities; });
  return counts;
}
const pf1Row = (id: string, revision: number, value: Json): Revision<Json> => ({ id, kind: 'k', revision, hash: hashJson(value), value });

test("PF1 (№2797-6 rows 1–3) through a pending overlay over a genuine Store a reused proof reads no pending row, checks a delegated read by the Store's stamp alone, keeps itself over a disjoint write and an unchanged identity, and derives again when a dependency moves or an absent record appears — also when a second Store of the same file writes it", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const second = new Store(first.path); t.after(() => second.close());
  const dep = first.write({ id: 'pf1i:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const overlay = pendingOverlay(first, [pf1Row('pf1i:pending', 1, { p: 1 })]);
  const prove = () => historicalProof(overlay, { reader: 'PF1.rows', project: 'garden', ref: reference(dep) }, source => {
    counts.runs++;
    return canonical([source.get('pf1i:pending')?.value ?? null, source.get(dep.id)?.value ?? null, source.get('pf1i:absent')?.value ?? null] as Json);
  }, noCycle);
  const reuse = () => {
    const before = { ...counts }, value = prove();
    return { value, runs: counts.runs - before.runs, gets: counts.gets - before.gets, identities: counts.identities - before.identities };
  };
  withHistoricalReads(() => {
    const cold = prove();
    assert.deepEqual(reuse(), { value: cold, runs: 0, gets: 0, identities: 0 }, 'Rows 1–2: under an unchanged stamp nothing is read again — neither the pending row nor the base');
    first.write({ id: 'pf1i:other', kind: 'k', expected: 0, value: {} });
    const advanced = proofs.historicalProofCounters().advanced;
    const disjoint = reuse();
    // PF4 (№3499 row 10): the disjoint write is an event of another id — matched against the proof's dependencies, never
    // read as identities; the mark moves past it.
    assert.deepEqual([disjoint.value, disjoint.runs, disjoint.gets, disjoint.identities], [cold, 0, 0, 0],
      'Row 3: a disjoint write is checked by its event alone — no identity, no pending row, nothing derived again');
    assert.ok(proofs.historicalProofCounters().advanced > advanced, 'Row 3: the mark moved past the checked event');
    assert.deepEqual(reuse(), { value: cold, runs: 0, gets: 0, identities: 0 }, 'The checked events keep the new stamp');
    first.write({ id: dep.id, kind: 'k', expected: 1, value: { d: 2 } });
    const moved = reuse();
    assert.equal(moved.runs, 1); assert.match(moved.value, /"d":2/, 'Row 2: a moved head of the base derives again');
    second.write({ id: 'pf1i:absent', kind: 'k', expected: 0, value: { a: 1 } });
    const appeared = reuse();
    assert.equal(appeared.runs, 1); assert.match(appeared.value, /"a":1/, 'Row 2: an absence belongs to the base, and its appearance through a second Store of the file moves the stamp');
  });
});

test("PF1 (№2797-6 rows 4–5) nested overlays answer by layers and both are proved links; an unknown view between them is not bypassed; an overlay owns its rows, so a changed argument changes nothing it proved and a new overlay of the changed rows proves on its own", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const anchor = first.write({ id: 'pf1n:x', kind: 'k', expected: 0, value: { x: 1 } });
  const changing = { x: 3, nested: { n: 1 } };
  const rows = [pf1Row('pf1n:x', 3, changing as unknown as Json)];
  const inner = pendingOverlay(first, [pf1Row('pf1n:x', 2, { x: 2 })]);
  const outer = pendingOverlay(inner, rows);
  const binding = (store: Store) => new Proxy(store, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
  const behindUnknown = pendingOverlay(binding(inner), [pf1Row('pf1n:x', 3, { x: 3, nested: { n: 1 } })]);
  const prove = (view: Store, kase: string) => historicalProof(view, { reader: 'PF1.layers', project: 'garden', ref: reference(anchor), parameters: { case: kase } },
    source => { counts.runs++; return canonical([source.get('pf1n:x'), source.get('pf1n:x', 2), source.get('pf1n:x', 1), source.get('pf1n:y')] as Json); }, noCycle);
  withHistoricalReads(() => {
    const layered = prove(outer, 'outer');
    assert.match(layered, /"x":3.*"x":2.*"x":1/, 'Row 4: the head and X@3 from the outer layer, X@2 from the inner, X@1 from the base');
    const before = { ...counts };
    assert.equal(prove(outer, 'outer'), layered);
    assert.deepEqual([counts.runs - before.runs, counts.gets - before.gets], [0, 0], 'Through two proved layers a reuse reads nothing');
    assert.equal(prove(behindUnknown, 'unknown'), layered, 'An overlay over an unknown view still answers the same rows');
    const unknownBefore = { ...counts };
    prove(behindUnknown, 'unknown');
    assert.ok(counts.gets > unknownBefore.gets, 'Row 4: an unknown view between the layers is not bypassed: its footprint is read again');
    changing.nested.n = 2; (rows[0]!.value as { x: number }).x = 4;
    assert.equal(prove(outer, 'outer'), layered, 'Row 5: the overlay proved its own copy; the changed argument changes nothing it holds');
    assert.throws(() => { (outer.get('pf1n:x')!.value as { nested: { n: number } }).nested.n = 9; }, TypeError);
    const fresh = pendingOverlay(inner, rows), freshBefore = counts.runs;
    const changed = prove(fresh, 'outer');
    assert.equal(counts.runs - freshBefore, 1, 'Row 5: a new overlay of the changed rows inherits no proof of the old one');
    assert.match(changed, /"x":4/); assert.notEqual(changed, layered);
  });
  assert.ok(!Object.isFrozen(changing) && !Object.isFrozen(changing.nested), "The caller's objects are not frozen in place");
});

test("PF1 (№2797-6 row 6) an overlay over a Transaction preview or a capture has no witness beneath its own rows: read from a closure or traced, get, list and history of the next operation see what the preview holds now, flat and as a child warmed before its parent, and neither is kept", t => {
  const { first } = historicalStores(t);
  const anchor = first.write({ id: 'pf1t:anchor', kind: 'k', expected: 0, value: {} });
  const counts: Record<string, number> = {};
  const prove = (kase: string, action: () => unknown) => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(anchor), parameters: { case: kase } },
    () => { counts[kase] = (counts[kase] ?? 0) + 1; return canonical(action() as Json); }, noCycle);
  const tx = transactionForTests(first);
  const capture = captureView(first, { rows: new Map() });
  const overlays = { tx: pendingOverlay(tx.view, [pf1Row('pf1t:own', 1, { own: true })]), capture: pendingOverlay(capture.view, [pf1Row('pf1t:own', 1, { own: true })]) };
  const reads = (view: Store): [string, () => unknown][] => [
    ['get', () => view.get('pf1t:candidate')?.value ?? null],
    ['list', () => view.list('k').map(row => row.id)],
    ['history', () => view.history('pf1t:candidate').map(row => row.revision)],
  ];
  const round = () => Object.fromEntries(Object.entries(overlays).flatMap(([name, view]) => reads(view).map(([method, read]) => {
    const child = () => prove(`${name}.${method}`, () => [first.get(anchor.id, 1), view.get('pf1t:own')?.value ?? null, read()]);
    const parent = () => prove(`${name}.${method}.parent`, () => [child(), first.get(anchor.id, 1)]);
    const traced = historicalProof(view, { reader: 'PF1.traced', project: 'garden', ref: reference(anchor), parameters: { name, method } },
      source => canonical([source.get('pf1t:candidate')?.value ?? null, source.list('k').map(row => row.id), source.history('pf1t:candidate').map(row => row.revision)] as Json), noCycle);
    return [`${name}.${method}`, withHistoricalReads(() => [child(), parent(), traced])];
  })));
  const before = round();
  tx.add({ writes: [{ id: 'pf1t:candidate', kind: 'k', expected: 0, value: { pending: true } }], guards: [] });
  capture.view.write({ id: 'pf1t:candidate', kind: 'k', expected: 0, value: { pending: true } });
  const after = round();
  for (const name of Object.keys(before)) {
    assert.notDeepEqual(after[name], before[name], `${name}: the next operation sees the row the representation holds now — closure child, parent and traced proof`);
    assert.deepEqual([counts[name], counts[`${name}.parent`]], [2, 2], `${name}: neither the child nor its parent was kept`);
  }
  assert.equal(first.get('pf1t:candidate'), null, 'The physical Store never held the row: its stamp could not reveal the change');
  withHistoricalReads(() => {
    const view = overlays.tx, key = { reader: 'PF1.within', project: 'garden', ref: reference(anchor) };
    let runs = 0;
    const within = () => historicalProof(view, key, source => { runs++; return canonical(source.get('pf1t:late')?.value ?? null); }, noCycle);
    within();
    tx.add({ writes: [{ id: 'pf1t:late', kind: 'k', expected: 0, value: { late: true } }], guards: [] });
    assert.match(within(), /"late":true/, 'Inside one operation a read the preview answers is checked in full, never by the Store\'s stamp');
    assert.equal(runs, 2);
  });
});

test("PF1 (№2797-6 row 7) a proof through a pending overlay replays the same stream to ordered and distinct observers, cold and reused, nested observers included; a complete replay neither keeps it beyond its operation nor merges its key with the base's", t => {
  const { first } = historicalStores(t);
  const dep = first.write({ id: 'pf1r:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const overlay = pendingOverlay(first, [pf1Row('pf1r:pending', 1, { p: 1 })]);
  let runs = 0;
  const key = { reader: 'PF1.replay', project: 'garden', ref: reference(dep) };
  const body = (source: Store) => { runs++; return canonical([source.get('pf1r:pending'), source.get(dep.id), source.get(dep.id), source.get(dep.id, 1)] as Json); };
  const streams = (mode: 'ordered' | 'distinct') => {
    const outerSeen: string[] = [], innerSeen: string[] = [];
    const outerTrace = historicalTrace(overlay, (ref, head, method) => outerSeen.push(`${ref.id}@${ref.revision}:${head}:${method}`), mode);
    const innerTrace = historicalTrace(outerTrace, (ref, head, method) => innerSeen.push(`${ref.id}@${ref.revision}:${head}:${method}`), mode);
    return withHistoricalReads(() => {
      historicalProof(innerTrace, key, body, noCycle);
      const cold = [[...outerSeen], [...innerSeen]];
      outerSeen.length = 0; innerSeen.length = 0;
      historicalProof(innerTrace, key, body, noCycle);
      return { cold, reused: [[...outerSeen], [...innerSeen]] };
    });
  };
  const ordered = streams('ordered');
  assert.deepEqual(ordered.cold[0], ['pf1r:pending@1:true:get', 'pf1r:dep@1:true:get', 'pf1r:dep@1:true:get', 'pf1r:dep@1:false:get'],
    'The pending row is observed like any other: reference, head, method, order and multiplicity');
  assert.deepEqual(ordered.reused, ordered.cold, 'A reused proof replays the whole ordered stream to both observers');
  assert.deepEqual(ordered.cold[1], ordered.cold[0], 'The nested observer sees the same stream');
  const distinct = streams('distinct');
  assert.deepEqual(distinct.cold[0], ['pf1r:pending@1:true:get', 'pf1r:dep@1:true:get', 'pf1r:dep@1:false:get'], 'A distinct observer sees each reference once');
  assert.deepEqual(distinct.reused, [[], []], 'and nothing again on a reuse');
  const before = runs;
  withHistoricalReads(() => historicalProof(overlay, key, body, noCycle));
  withHistoricalReads(() => historicalProof(overlay, key, body, noCycle));
  assert.equal(runs - before, 2, 'Every operation derives a proof of the overlay again: no proof of it is kept beyond its operation');
  const base = runs;
  withHistoricalReads(() => { historicalProof(overlay, key, body, noCycle); historicalProof(first, key, body, noCycle); });
  assert.equal(runs - base, 2, 'The overlay and its base keep separate keys');
});

test("PF1 (№2827) a proof through a pending overlay is reused only while its proved chain holds: once the base's get is replaced — an exact read now answering another revision, or the head answering a projected body under the same metadata — the reuse, flat and as the parent of a warmed child, derives again and agrees with the direct read; under the intact chain it reads nothing", t => {
  for (const kind of ['exact', 'head'] as const) {
    const { first } = historicalStores(t);
    const before = first.write({ id: 'pf1c:dep', kind: 'k', expected: 0, value: { value: 'before' } });
    const after = first.write({ id: 'pf1c:dep', kind: 'k', expected: 1, value: { value: 'after' } });
    const overlay = pendingOverlay(first, [pf1Row('pf1c:own', 1, { own: true })]);
    const revision = kind === 'exact' ? 1 : undefined;
    const counts = { child: 0, parent: 0 };
    const child = () => historicalProof(overlay, { reader: 'PF1.chain', project: 'garden', ref: reference(before), parameters: { kind } },
      source => { counts.child++; return (source.get('pf1c:dep', revision)!.value as { value: string }).value; }, noCycle);
    const parent = () => historicalProof(overlay, { reader: 'PF1.chain.parent', project: 'garden', ref: reference(before), parameters: { kind } },
      source => { counts.parent++; return `${child()}|${(source.get('pf1c:own')!.value as { own: boolean }).own}`; }, noCycle);
    withHistoricalReads(() => {
      const warm = parent();
      assert.equal(warm, `${kind === 'exact' ? 'before' : 'after'}|true`);
      assert.deepEqual([parent(), counts.child, counts.parent], [warm, 1, 1], `${kind}: under the intact chain the reuse derives nothing`);
      const original = first.get.bind(first);
      Object.defineProperty(first, 'get', { configurable: true, writable: true, value: (id: string, rev?: number) => id !== 'pf1c:dep' ? original(id, rev)
        : kind === 'exact' ? after : { ...after, value: { value: 'projected' } } });
      try {
        const direct = (overlay.get('pf1c:dep', revision)!.value as { value: string }).value;
        assert.equal(child(), direct, `${kind}: the reused child agrees with what the overlay answers now`);
        assert.equal(parent(), `${direct}|true`, `${kind}: so does its parent, which carries the child's chain`);
        assert.deepEqual(counts, { child: 2, parent: 2 }, `${kind}: both derived again once the chain broke`);
      } finally { delete (first as unknown as { get?: unknown }).get; }
    });
  }
});

test("PF1 (№2827, same class) a trusted recovery snapshot (R5) keeps a reused proof only while its base still reads through the members it was trusted over: a replaced get — another revision for an exact read, or a projected body under the head's metadata — derives again; an untouched base still reads nothing", t => {
  for (const kind of ['exact', 'head'] as const) {
    const { first } = historicalStores(t);
    const before = first.write({ id: 'pf1s:dep', kind: 'k', expected: 0, value: { value: 'before' } });
    const after = first.write({ id: 'pf1s:dep', kind: 'k', expected: 1, value: { value: 'after' } });
    const snapshot = proofs.pendingSnapshotView(first, [pf1Row('pf1s:own', 1, { own: true })]);
    const revision = kind === 'exact' ? 1 : undefined;
    let runs = 0;
    const prove = () => historicalProof(snapshot, { reader: 'PF1.snapshot', project: 'garden', ref: reference(before), parameters: { kind } },
      source => { runs++; return (source.get('pf1s:dep', revision)!.value as { value: string }).value; }, noCycle);
    withHistoricalReads(() => {
      const warm = prove();
      assert.deepEqual([prove(), runs], [warm, 1], `${kind}: an untouched base — the reuse derives nothing`);
      const original = first.get.bind(first);
      Object.defineProperty(first, 'get', { configurable: true, writable: true, value: (id: string, rev?: number) => id !== 'pf1s:dep' ? original(id, rev)
        : kind === 'exact' ? after : { ...after, value: { value: 'projected' } } });
      try {
        const direct = (snapshot.get('pf1s:dep', revision)!.value as { value: string }).value;
        assert.deepEqual([prove(), runs], [direct, 2], `${kind}: the reuse derives again and agrees with what the snapshot answers now`);
      } finally { delete (first as unknown as { get?: unknown }).get; }
    });
  }
});

test("PF1 (№2846 rows 1–3, 5) the read methods a delegated read invoked are part of its proof: replaced after warming through the instance or the prototype — exact read or head with a projected body, through a pending overlay or a recovery snapshot — the child and a parent rooted at the Store over the prewarmed child derive again and agree with the direct read; unchanged methods reuse without a derivation", t => {
  const original = Store.prototype.get;
  for (const representation of ['overlay', 'snapshot'] as const) for (const place of ['instance', 'prototype'] as const) for (const read of ['exact', 'head'] as const) {
    const { first } = historicalStores(t);
    t.after(() => { Store.prototype.get = original; delete (first as unknown as { get?: unknown }).get; });
    const before = first.write({ id: 'pf1m:dep', kind: 'k', expected: 0, value: { v: 'before' } });
    const after = first.write({ id: 'pf1m:dep', kind: 'k', expected: 1, value: { v: 'after' } });
    const own = pf1Row('pf1m:own', 1, { own: true });
    const view = representation === 'overlay' ? pendingOverlay(first, [own]) : proofs.pendingSnapshotView(first, [own]);
    const revision = read === 'exact' ? 1 : undefined;
    const counts = { child: 0, parent: 0 };
    const key = { reader: 'PF1.methods', project: 'garden', ref: reference(before), parameters: { representation, place, read } };
    const child = () => historicalProof(view, key, source => { counts.child++; return (source.get('pf1m:dep', revision)!.value as { v: string }).v; }, noCycle);
    const parent = () => historicalProof(first, { ...key, reader: 'PF1.methods.parent' }, source => { counts.parent++; source.get('pf1m:anchor'); return child(); }, noCycle);
    const label = `${representation}/${place}/${read}`;
    withHistoricalReads(() => {
      const cold = child();
      assert.equal(parent(), cold);
      assert.deepEqual([child(), parent(), counts.child, counts.parent], [cold, cold, 1, 1], `${label}: unchanged methods — the reuse derives nothing (row 1)`);
      const replacement = function (this: Store, id: string, rev?: number) {
        if (this !== first || id !== 'pf1m:dep') return original.call(this, id, rev);
        return read === 'exact' ? after : { ...after, value: { v: 'projected' } };
      } as typeof original;
      if (place === 'instance') Object.defineProperty(first, 'get', { configurable: true, writable: true, value: replacement });
      else Store.prototype.get = replacement;
      const direct = (view.get('pf1m:dep', revision)!.value as { v: string }).v;
      assert.equal(parent(), direct, `${label}: the parent over the prewarmed child sees what is read now (rows 2–3, 5)`);
      assert.deepEqual(counts, { child: 2, parent: 2 }, `${label}: both derived again`);
    });
    Store.prototype.get = original; delete (first as unknown as { get?: unknown }).get;
  }
});

test("PF1 (№2846 rows 1, 6, list/history) list and history a recovery snapshot delegates follow the same rule, and a method replaced and restored to the very same function lets the reuse stand under the same chain and current data", t => {
  const { first } = historicalStores(t);
  const anchor = first.write({ id: 'pf1h:a', kind: 'k', expected: 0, value: { a: 1 } });
  const snapshot = proofs.pendingSnapshotView(first, [pf1Row('pf1h:own', 1, { own: true })]);
  let runs = 0;
  const prove = () => historicalProof(snapshot, { reader: 'PF1.list', project: 'garden', ref: reference(anchor) },
    source => { runs++; return canonical([source.list('k').map(row => row.id), source.history(anchor.id).map(row => row.revision)] as Json); }, noCycle);
  const original = { list: Store.prototype.list, history: Store.prototype.history };
  t.after(() => { Store.prototype.list = original.list; Store.prototype.history = original.history; });
  withHistoricalReads(() => {
    const cold = prove();
    for (const name of ['list', 'history'] as const) {
      const before = runs;
      const replaced = function (this: Store, ...args: unknown[]) { return (original[name] as (...a: unknown[]) => unknown).apply(this, args); };
      (Store.prototype as unknown as Record<string, unknown>)[name] = replaced;
      assert.equal(prove(), cold); assert.equal(runs, before + 1, `${name}: a replaced delegated read derives again`);
      (Store.prototype as unknown as Record<string, unknown>)[name] = original[name];
      assert.equal(prove(), cold); assert.equal(runs, before + 2, `${name}: the proof made under the replacement is again no proof of the restored method`);
      assert.equal(prove(), cold); assert.equal(runs, before + 2, `${name}: under the restored, unchanged method the reuse stands (row 6)`);
    }
    const restored = runs;
    const get = Store.prototype.get;
    Store.prototype.get = function (this: Store, ...args: Parameters<typeof get>) { return get.apply(this, args); } as typeof get;
    Store.prototype.get = get;
    assert.equal(prove(), cold); assert.equal(runs, restored, 'Row 6: the very same function again — the reuse stands');
    first.write({ id: anchor.id, kind: 'k', expected: 1, value: { a: 2 } });
    assert.notEqual(prove(), cold, 'Row 6 is conditional: the data still have to be current, the stamp still checks them');
  });
});

// ---- PF2 (№2905): a proof derived through a pending layer that is its base's serves the base's other layers ----
/** A listed reader's closure over one view: head, exact revision, an absence, a list and a history of the base. */
function pf2Reader(counts: { runs: number }, dep: Revision<Json>, parameters: Json = null) {
  const key = { reader: LISTED, project: 'garden', ref: reference(dep), ...(parameters === null ? {} : { parameters }) };
  return (view: Store) => historicalRead(view, key, () => {
    counts.runs++;
    return { head: view.get(dep.id)?.value ?? null, exact: view.get(dep.id, 1)?.value ?? null, absent: view.get('pf2:absent')?.value ?? null,
      list: view.list('k').map(row => row.id), history: view.history(dep.id).map(row => row.revision) };
  }, noCycle);
}

test("PF2 (№2905 rows 1, 3, 4, 13) a listed reader proved through one layer serves the base's other layers in this and the next operation; a layer whose own row answers the head, or a former absence, derives again and replaces nothing; a row of another revision of the same id does not; every receiver gets its own copy", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const dep = first.write({ id: 'pf2:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const read = pf2Reader(counts, dep);
  const layer = (rows: Revision<Json>[]) => pendingOverlay(first, rows);
  const a = layer([pf1Row('pf2:a', 1, { a: 1 })]), b = layer([pf1Row('pf2:b', 1, { b: 1 })]);
  const head = layer([pf1Row(dep.id, 2, { d: 9 })]), absence = layer([pf1Row('pf2:absent', 1, { x: 1 })]);
  withHistoricalReads(() => {
    const cold = read(a);
    assert.equal(counts.runs, 1);
    assert.deepEqual(read(b), cold); assert.equal(counts.runs, 1, 'Row 1: another layer of the base adopts the proof');
    (read(b) as { list: string[] }).list.push('changed');
    assert.deepEqual(read(a), cold, 'Row 13: a receiver changing its copy changes no one else\'s');
    assert.deepEqual((read(head) as { head: unknown }).head, { d: 9 }); assert.equal(counts.runs, 2, 'Row 3: the receiver\'s own head row derives again');
    assert.deepEqual((read(absence) as { absent: unknown }).absent, { x: 1 }); assert.equal(counts.runs, 3, 'Row 3: so does a row where the proof read an absence');
    assert.deepEqual(read(layer([pf1Row('pf2:c', 1, {})])), cold); assert.equal(counts.runs, 3, 'Row 3: the base proof was replaced by neither');
  });
  withHistoricalReads(() => {
    assert.deepEqual(read(layer([pf1Row('pf2:d', 1, {})])), { head: { d: 1 }, exact: { d: 1 }, absent: null, list: ['pf2:dep'], history: [1] });
    assert.equal(counts.runs, 3, 'Row 1: the next operation adopts it too, while its footprint holds');
  });
  // Row 4: a proof that read only an exact revision, a list and a history is served to a layer holding another revision.
  const exactOnly = { reader: LISTED, project: 'garden', ref: reference(dep), parameters: 'exact' } as HistoricalReadKey;
  const readExact = (view: Store) => historicalRead(view, exactOnly, () => { counts.runs++;
    return { exact: view.get(dep.id, 1)?.value ?? null, list: view.list('k').map(row => row.id), history: view.history(dep.id).map(row => row.revision) }; }, noCycle);
  withHistoricalReads(() => {
    const cold = readExact(a), runs = counts.runs;
    assert.deepEqual(readExact(head), cold); assert.equal(counts.runs, runs, 'Row 4: a row of revision 2 answers no exact read of revision 1, no list and no history');
  });
});

test("PF2 (№2905 rows 2, 5, 11) a proof that read a layer's own row — even with no Store read at all, flat or through a nested layer — stays that layer's; nested layers keep their own answers; a view of unknown origin in the chain, a reader not listed, a write attempt and a value that is not plain data share nothing", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const dep = first.write({ id: 'pf2n:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const own = (view: Store, kase: string, action: () => unknown, reader = LISTED) =>
    historicalRead(view, { reader, project: 'garden', ref: reference(dep), parameters: kase }, () => { counts.runs++; return action(); }, noCycle);
  const a = pendingOverlay(first, [pf1Row('pf2n:a', 1, { a: 1 })]), b = pendingOverlay(first, [pf1Row('pf2n:b', 1, { b: 1 })]);
  withHistoricalReads(() => {
    own(a, 'pending', () => a.get('pf2n:a')?.value ?? null);
    own(b, 'pending', () => b.get('pf2n:a')?.value ?? null);
    assert.equal(counts.runs, 2, 'Row 2: an answer of a layer\'s own row (no Store read) is no proof of the base');
    // Row 5: nested layers — the inner row answers through the outer layer; a proof through the outer one that read only the
    // base serves the inner layer; a nested proof that read the inner layer's row stays its own.
    const inner = pendingOverlay(first, [pf1Row('pf2n:x', 1, { x: 1 })]), outer = pendingOverlay(inner, [pf1Row('pf2n:x', 2, { x: 2 })]);
    const runs = counts.runs;
    own(outer, 'base', () => outer.get(dep.id)?.value ?? null);
    own(inner, 'base', () => inner.get(dep.id)?.value ?? null);
    assert.equal(counts.runs, runs + 1, 'Row 5: the inner layer adopts what the outer one proved of their base');
    assert.deepEqual(own(outer, 'x', () => outer.get('pf2n:x')?.value ?? null), { x: 2 });
    assert.deepEqual(own(inner, 'x', () => inner.get('pf2n:x')?.value ?? null), { x: 1 }, 'Row 5: nested layers are not merged');
    const opaque = new Proxy(first, { get: (target, key) => { const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
    const unknown = pendingOverlay(opaque, [pf1Row('pf2n:u', 1, {})]), before = counts.runs;
    own(unknown, 'base', () => unknown.get(dep.id)?.value ?? null);
    assert.equal(counts.runs, before + 1, 'Row 5: a view of unknown origin in the chain gets nothing through it');
    // Row 11: a reader that is not listed, a write attempt, a value that is not plain data.
    const cases: [string, (view: Store) => unknown, string?][] = [
      ['unlisted', view => view.get(dep.id)?.value ?? null, 'PF2.unlisted'],
      ['write', view => { try { view.write({ id: 'pf2n:w', kind: 'k', expected: 0, value: {} }); } catch { /* refused or written: an attempt */ } return view.get(dep.id)?.value ?? null; }],
      ['instance', view => new Map([['d', view.get(dep.id)?.value ?? null]])],
    ];
    for (const [kase, action, reader] of cases) {
      const from: number = counts.runs;
      own(a, kase, () => action(a), reader); own(b, kase, () => action(b), reader);
      assert.equal(counts.runs, from + 2, `Row 11: ${kase} — nothing is shared`);
    }
  });
});

test("PF2 (№2905 rows 6, 7) a layer over a capture or a Transaction preview proves nothing of a base; read methods replaced after warming end the sharing until the very functions are back, and a replacement before the first derivation is that derivation's", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const dep = first.write({ id: 'pf2m:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const read = pf2Reader(counts, dep, 'methods');
  withHistoricalReads(() => {
    for (const view of [captureView(first, { rows: new Map() }).view, transactionForTests(first).view]) {
      const from: number = counts.runs;
      read(pendingOverlay(view, [pf1Row('pf2m:a', 1, {})])); read(pendingOverlay(view, [pf1Row('pf2m:b', 1, {})]));
      assert.equal(counts.runs, from + 2, 'Row 6: an opaque base is no proved base');
    }
  });
  const list = Store.prototype.list, replaced = function (this: Store, ...args: Parameters<typeof list>) { return list.apply(this, args); } as typeof list;
  withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2m:a', 1, {})])));
  const runs = counts.runs;
  Store.prototype.list = replaced; Store.prototype.list = list;
  withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2m:b', 1, {})])));
  assert.equal(counts.runs, runs, 'Row 7: replaced and restored to the very same function — the proof still serves');
  Store.prototype.list = replaced;
  try {
    withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2m:c', 1, {})])));
    assert.equal(counts.runs, runs + 1, 'Row 7: replaced after warming — the receiver derives again');
  } finally { Store.prototype.list = list; }
  withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2m:d', 1, {})])));
  assert.equal(counts.runs, runs + 2, 'Row 7: what was proved under the replaced function does not stand once it is gone');
});

test("PF2 (№2905 rows 8, 9, 14) a second Store moving a dependency derives again on the next receiver; a disjoint write moves only the stamp and the dependencies are checked as identities; a reopened Store starts cold with the same value", t => {
  const counts = countingStore(t);
  const { first, second } = sameFileStores(t);
  const dep = first.write({ id: 'pf2s:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const read = pf2Reader(counts, dep, 'stores');
  const cold = withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2s:a', 1, {})])));
  second.write({ id: 'pf2s:other', kind: 'other', expected: 0, value: {} });
  const identities = counts.identities, advanced = proofs.historicalProofCounters().advanced;
  assert.deepEqual(withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2s:b', 1, {})]))), cold);
  // PF4 (№3499 row 10): the disjoint write is checked by its event, not by reading identities.
  assert.equal(counts.runs, 1, 'Row 9: a disjoint write — no derivation'); assert.equal(counts.identities, identities, 'Row 9: no identity read');
  assert.ok(proofs.historicalProofCounters().advanced > advanced, 'Row 9: checked by the events after its mark');
  second.write({ id: dep.id, kind: 'k', expected: 1, value: { d: 2 } });
  assert.deepEqual((withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2s:c', 1, {})]))) as { head: unknown }).head, { d: 2 });
  assert.equal(counts.runs, 2, 'Row 8: a moved head derives again');
  const reopened = new Store(first.path); t.after(() => reopened.close());
  assert.deepEqual(withHistoricalReads(() => read(pendingOverlay(reopened, [pf1Row('pf2s:d', 1, {})]))),
    withHistoricalReads(() => read(pendingOverlay(first, [pf1Row('pf2s:e', 1, {})]))));
  assert.equal(counts.runs, 3, 'Row 14: another Store instance of the same file starts cold and proves the same value');
});

test("PF2 (№2905 row 10, №55) nested trusted recovery snapshots repeat get, list and history without a false derivation; a real replacement of the base's read still ends the repeat", t => {
  const { first } = historicalStores(t);
  const dep = first.write({ id: 'pf2r:dep', kind: 'k', expected: 0, value: { d: 1 } });
  for (const method of ['get', 'list', 'history'] as const) {
    let runs = 0;
    const inner = proofs.pendingSnapshotView(first, []), outer = proofs.pendingSnapshotView(inner, []);
    const prove = () => historicalProof(outer, { reader: 'PF2.nested', project: 'garden', ref: reference(dep), parameters: method }, source => {
      runs++;
      return method === 'get' ? source.get(dep.id, 1)?.value ?? null : method === 'list' ? source.list('k').map(row => row.id) : source.history(dep.id).map(row => row.revision);
    }, noCycle);
    withHistoricalReads(() => { prove(); prove(); });
    assert.equal(runs, 1, `№55 ${method}: one derivation through two nested snapshots`);
    const original = Store.prototype[method] as (...args: never[]) => unknown;
    (Store.prototype as unknown as Record<string, unknown>)[method] = function (this: Store, ...args: never[]) { return original.apply(this, args); };
    try { withHistoricalReads(() => { prove(); prove(); }); }
    finally { (Store.prototype as unknown as Record<string, unknown>)[method] = original; }
    assert.equal(runs, 2, `№2846 ${method}: a replaced base read still ends the repeat`);
  }
});

/** PF2 (№2932-2): the stream an observer of a view gets from one call, as `method:id@revision:head`. */
function pf2Stream(view: Store, mode: 'ordered' | 'distinct', call: (view: Store) => unknown): string[] {
  const into: string[] = [];
  call(historicalTrace(view, (ref, isHead, method) => into.push(`${method}:${ref.id}@${ref.revision}:${isHead}`), mode));
  return into;
}
/** The stream of a cold derivation: a new Store instance of the same file shares and keeps nothing yet. */
function pf2ColdStream(path: string, mode: 'ordered' | 'distinct', call: (view: Store) => unknown): string[] {
  const fresh = new Store(path);
  try { return withHistoricalReads(() => pf2Stream(fresh, mode, call)); } finally { fresh.close(); }
}

test("PF2 (№2905 row 12, №2932-2) a receiver adopts a proof under its own identity: observers attached at the adoption, after an unobserved one, under a parent that recorded the adopted proof, and at a parent adopted further get the stream a cold derivation gives, ordered and distinct, first and repeated; a traced receiver adopts only a traced derivation", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const dep = first.write({ id: 'pf2o:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const key = { reader: 'PF2.traced', project: 'garden', ref: reference(dep) };
  const prove = (view: Store) => historicalProof(view, key, source => { counts.runs++; return { head: source.get(dep.id)?.value ?? null, list: source.list('k').map(row => row.id) }; }, noCycle);
  const parentOf = (parameters: string) => (view: Store) => historicalProof(view, { ...key, parameters }, source => { counts.runs++; return { child: prove(source), exact: source.get(dep.id, 1)?.value ?? null }; }, noCycle);
  const parent = parentOf('parent');
  const layer = (name: string) => pendingOverlay(first, [pf1Row(`pf2o:${name}`, 1, {})]);
  const cold = {
    child: { ordered: pf2ColdStream(first.path, 'ordered', prove), distinct: pf2ColdStream(first.path, 'distinct', prove) },
    parent: { ordered: pf2ColdStream(first.path, 'ordered', parent), distinct: pf2ColdStream(first.path, 'distinct', parent) },
  };
  assert.deepEqual(cold.child.ordered, ['get:pf2o:dep@1:true', 'list:pf2o:dep@1:false']);
  assert.deepEqual(cold.parent.ordered, [...cold.child.ordered, 'get:pf2o:dep@1:false']);
  assert.deepEqual(cold.child.distinct, cold.child.ordered); assert.deepEqual(cold.parent.distinct, cold.parent.ordered);
  for (const mode of ['ordered', 'distinct'] as const) withHistoricalReads(() => {
    const value = prove(layer(`a-${mode}`)), runs = counts.runs;
    const observed = layer(`c-${mode}`), later = layer(`b-${mode}`);
    assert.deepEqual(pf2Stream(observed, mode, prove), cold.child[mode], `${mode}: observed at the adoption`);
    assert.deepEqual(pf2Stream(observed, mode, prove), cold.child[mode], `${mode}: and repeated`);
    assert.deepEqual(prove(later), value);
    assert.deepEqual(pf2Stream(later, mode, prove), cold.child[mode], `${mode}: observed after an unobserved adoption (№2932-2)`);
    assert.equal(counts.runs, runs, `${mode}: every receiver adopted`);
    // A parent derived without observers records the adopted child; observed later — and at a layer that adopts the parent.
    const host = layer(`p-${mode}`), next = layer(`q-${mode}`), parent = parentOf(`parent-${mode}`);
    parent(host);
    assert.equal(counts.runs, runs + 1, `${mode}: the parent derived, its child adopted`);
    assert.deepEqual(pf2Stream(host, mode, parent), cold.parent[mode], `${mode}: the parent's adopted child replays its stream`);
    assert.deepEqual(pf2Stream(next, mode, parent), cold.parent[mode], `${mode}: so does the parent adopted further`);
    assert.deepEqual(pf2Stream(next, mode, parent), cold.parent[mode], `${mode}: and repeated`);
    assert.equal(counts.runs, runs + 1, `${mode}: the parent adopted, never derived again`);
  });
  // A traced receiver takes no proof derived untraced; an untraced one takes it.
  const listedKey = { reader: LISTED, project: 'garden', ref: reference(dep), parameters: 'untraced' };
  withHistoricalReads(() => {
    const from = counts.runs;
    const untraced = layer('u');
    historicalRead(untraced, listedKey, () => { counts.runs++; return untraced.get(dep.id)?.value ?? null; }, noCycle);
    historicalProof(layer('v'), listedKey, source => { counts.runs++; return source.get(dep.id)?.value ?? null; }, noCycle);
    assert.equal(counts.runs, from + 2, 'A traced receiver derives what was derived untraced');
    const other = layer('w');
    historicalRead(other, listedKey, () => { counts.runs++; return other.get(dep.id)?.value ?? null; }, noCycle);
    assert.equal(counts.runs, from + 2, 'An untraced receiver adopts');
  });
});

test("PF2 (№2932-1, rows 2, 5) a row an inner layer answers to a proof derived through an outer one is that proof's own — at the head or an exact revision, in this or the next operation, read by the proof itself, by a cold or a warmed child of it, or by a child under a parent derived at the base: no other layer and no base receives it", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const anchor = first.write({ id: 'pf2i:anchor', kind: 'k', expected: 0, value: { v: 1 } });
  const listed = (view: Store, parameters: Json, action: () => unknown) =>
    historicalRead(view, { reader: LISTED, project: 'garden', ref: reference(anchor), parameters }, () => { counts.runs++; return action(); }, noCycle);
  const both = (view: Store, revision?: number) => [view.get(anchor.id, 1)?.value ?? null, view.get('pf2i:own', revision)?.value ?? null];
  const outerOf = (v: number) => pendingOverlay(pendingOverlay(first, [pf1Row('pf2i:own', 1, { v })]), []);
  for (const revision of [undefined, 1]) for (const across of [false, true]) {
    const label = `${revision === undefined ? 'head' : 'exact'}${across ? ', next operation' : ''}`;
    const outer = outerOf(7), receiver = pendingOverlay(first, []);
    const run = (view: Store) => listed(view, { case: 'flat', revision: revision ?? null, across }, () => both(view, revision));
    const from = counts.runs;
    const got = across ? [outer, receiver, first].map(view => withHistoricalReads(() => run(view))) : withHistoricalReads(() => [outer, receiver, first].map(run));
    assert.deepEqual(got, [[{ v: 1 }, { v: 7 }], [{ v: 1 }, null], [{ v: 1 }, null]], `${label}: another layer and the base read their own absence`);
    assert.equal(counts.runs, from + 2, `${label}: the outer proof went to no one; the other layer's went on to the base`);
  }
  for (const warm of [false, true]) {
    const label = warm ? 'warmed child' : 'cold child';
    const outer = outerOf(7), receiver = pendingOverlay(first, []);
    const child = (view: Store) => listed(view, { case: 'child', warm }, () => both(view));
    const parent = (view: Store) => listed(view, { case: 'parent', warm }, () => ({ child: child(view), anchor: view.get(anchor.id)?.value ?? null }));
    withHistoricalReads(() => {
      if (warm) child(outer);
      const from = counts.runs;
      assert.deepEqual(parent(outer), { child: [{ v: 1 }, { v: 7 }], anchor: { v: 1 } });
      assert.deepEqual(parent(receiver), { child: [{ v: 1 }, null], anchor: { v: 1 } }, `${label}: the receiver reads its own absence`);
      assert.deepEqual(parent(first), { child: [{ v: 1 }, null], anchor: { v: 1 } }, `${label}: so does the base`);
      assert.equal(counts.runs, from + (warm ? 3 : 4), `${label}: the parent through the outer layer went to no one`);
    });
  }
  // A parent at the base whose child reads through an outer layer is not the base's: the next operation's other outer
  // layer reads its own row.
  const atBase = (outer: Store) => listed(first, { case: 'base-parent' }, () => ({ child: listed(outer, { case: 'base-child' }, () => both(outer)) }));
  assert.deepEqual(withHistoricalReads(() => atBase(outerOf(7))), { child: [{ v: 1 }, { v: 7 }] });
  assert.deepEqual(withHistoricalReads(() => atBase(outerOf(8))), { child: [{ v: 1 }, { v: 8 }] }, 'The base kept nothing its layer answered');
});

test("PF2 (№2932-3, rows 1, 13) the base itself takes what a layer proved of it, in this and the next operation, and hands it on to another layer; observers of the base get the cold stream; what the base handed its caller, taken from a layer or from its own kept proof, reaches no other view after that caller changed it", t => {
  const counts = countingStore(t);
  const { first } = historicalStores(t);
  const dep = first.write({ id: 'pf2b:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const layer = (name: string) => pendingOverlay(first, [pf1Row(`pf2b:${name}`, 1, {})]);
  for (const across of [false, true]) {
    const label = across ? 'next operation' : 'this operation';
    const read = pf2Reader(counts, dep, { base: across });
    const from = counts.runs, views = [layer(`a-${across}`), first, layer(`b-${across}`)];
    const [cold, atBase, onward] = across ? views.map(view => withHistoricalReads(() => read(view))) : withHistoricalReads(() => views.map(read));
    assert.deepEqual(atBase, cold); assert.deepEqual(onward, cold);
    assert.equal(counts.runs, from + 1, `${label}: layer → base → layer, one derivation`);
  }
  for (const owned of ['layer', 'kept'] as const) {
    const read = pf2Reader(counts, dep, { owned });
    if (owned === 'kept') withHistoricalReads(() => read(first));
    withHistoricalReads(() => {
      if (owned === 'layer') read(layer(`m-${owned}`));
      const handed = read(first) as { list: string[] }, cold = structuredClone(handed);
      handed.list.push('changed');
      assert.deepEqual(read(layer(`n-${owned}`)), cold, `Row 13 (${owned}): the base's caller changed only its own copy`);
    });
  }
  const key = { reader: 'PF2.base-traced', project: 'garden', ref: reference(dep) };
  const prove = (view: Store) => historicalProof(view, key, source => { counts.runs++; return [source.get(dep.id)?.value ?? null, source.history(dep.id).length]; }, noCycle);
  for (const mode of ['ordered', 'distinct'] as const) {
    const cold = pf2ColdStream(first.path, mode, prove);
    assert.deepEqual(cold, ['get:pf2b:dep@1:true', 'history:pf2b:dep@1:false']);
    withHistoricalReads(() => {
      prove(layer(`t-${mode}`));
      const runs = counts.runs;
      assert.deepEqual(pf2Stream(first, mode, prove), cold, `${mode}: the base's observers get the adopted proof's stream`);
      assert.deepEqual(pf2Stream(first, mode, prove), cold, `${mode}: and repeated`);
      assert.equal(counts.runs, runs, `${mode}: the base adopted`);
    });
  }
});

// ---- PF3.1 (№3459): observed historical readers, nested reads inside a traced read, a kept historical refusal ----
// Each test names the rows of outcome table §7 it pins down.
test("PF3.1 rows 2, 5, 6, 9: a reader newly listed as observed keeps its proof across operations until a dependency moves — through an own write or a second Store; a disjoint write keeps it", t => {
  const { first } = historicalStores(t);
  const second = new Store(first.path); t.after(() => second.close());
  const dep = first.write({ id: 'pf31:dep', kind: 'k', expected: 0, value: { d: 1 } });
  let runs = 0;
  const read = () => historicalRead(first, { reader: 'G7.completion-effective', project: 'garden', ref: reference(dep) },
    () => { runs++; return first.get<Json>(dep.id)!.value; }, noCycle);
  assert.deepEqual(withHistoricalReads(read), { d: 1 });
  assert.deepEqual(withHistoricalReads(read), { d: 1 });
  assert.equal(runs, 1, 'Row 2: the complete proof of a listed reader serves the next operation');
  first.write({ id: 'pf31:other', kind: 'k', expected: 0, value: {} });
  assert.deepEqual(withHistoricalReads(read), { d: 1 }); assert.equal(runs, 1, 'Row 9: a disjoint write keeps the proof');
  first.write({ id: dep.id, kind: 'k', expected: 1, value: { d: 2 } });
  assert.deepEqual(withHistoricalReads(read), { d: 2 }); assert.equal(runs, 2, 'Row 5: an own write of the read head derives again');
  second.write({ id: dep.id, kind: 'k', expected: 2, value: { d: 3 } });
  assert.deepEqual(withHistoricalReads(read), { d: 3 }); assert.equal(runs, 3, 'Row 6: a second Store moving it derives again');
  const unlisted = () => historicalRead(first, { reader: 'PF3.1.unlisted', project: 'garden', ref: reference(dep) },
    () => { runs++; return first.get<Json>(dep.id)!.value; }, noCycle);
  withHistoricalReads(unlisted); withHistoricalReads(unlisted);
  assert.equal(runs, 5, 'Row 10: an unlisted reader of a closure-captured Store gains no completeness from the new list');
});

test("PF3.1 rows 16-19, 23: a proof started inside a traced read accounts for its own reads and the read for the rest, once; the parent is complete only with complete children, also from a cache; the read context is released after an exception", t => {
  const { first } = historicalStores(t);
  const x = first.write({ id: 'pf31:x', kind: 'k', expected: 0, value: { x: 1 } });
  const y = first.write({ id: 'pf31:y', kind: 'k', expected: 0, value: { y: 1 } });
  const z = first.write({ id: 'pf31:z', kind: 'k', expected: 0, value: { z: 1 } });
  const counts = { outer: 0, inner: 0, after: 0 };
  let hidden = false, failing = false;
  const child = (reader: string, ref: Ref, tick: () => void) => historicalRead(first, { reader, project: 'garden', ref }, () => {
    tick();
    if (failing) throw new EngineError('record_corrupt', 'injected child failure');
    if (hidden) transactionForTests(first).view.get(ref.id);
    return first.get<Json>(ref.id)!.value;
  }, noCycle);
  // The genuine Store's own read of x starts two children inside the traced read that asked for it: one before its own
  // read and one after it (a prototype member, so the instance stays a genuine Store).
  const original = Store.prototype.get;
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) {
    if (args[0] !== x.id) return original.apply(this, args);
    try { child('G7.completion-effective', reference(y), () => counts.inner++); } catch (error) { if (!(error instanceof EngineError)) throw error; }
    const own = original.apply(this, args);
    child('G7.completion-reuse', reference(z), () => counts.after++);
    return own;
  } as typeof original;
  try {
    const outer = () => historicalProof(first, { reader: 'PF3.1.outer', project: 'garden', ref: reference(x) },
      source => { counts.outer++; return [source.get(y.id)?.value ?? null, source.get(x.id)?.value ?? null, source.get(y.id)?.value ?? null]; }, noCycle);
    for (let operation = 0; operation < 3; operation++) withHistoricalReads(() => { outer(); outer(); });
    assert.deepEqual(counts, { outer: 1, inner: 1, after: 1 },
      'Rows 16-18: the reads before, between and after the children and the children\'s own are covered once — the parent is complete and kept');
    first.write({ id: y.id, kind: 'k', expected: 1, value: { y: 2 } });
    withHistoricalReads(() => { assert.deepEqual(outer()[0], { y: 2 }); outer(); });
    withHistoricalReads(() => outer());
    assert.deepEqual(counts, { outer: 2, inner: 2, after: 1 }, 'Row 17: a moved dependency of one child derives the parent and that child again; the other child is taken from the cache');
    hidden = true;
    first.write({ id: y.id, kind: 'k', expected: 2, value: { y: 3 } });
    withHistoricalReads(() => outer()); withHistoricalReads(() => outer());
    assert.deepEqual(counts, { outer: 4, inner: 4, after: 1 }, 'Row 19: a child reading through a mutable preview is incomplete, and so is its parent in every operation');
    hidden = false; failing = true;
    first.write({ id: y.id, kind: 'k', expected: 3, value: { y: 4 } });
    withHistoricalReads(() => outer()); withHistoricalReads(() => outer());
    assert.deepEqual([counts.outer, counts.inner], [6, 6], 'A child that threw and was caught leaves its parent incomplete');
  } finally { Store.prototype.get = original; }
  // Row 23: after the exceptions nothing of the nested context lingers — a listed proof over the Store is complete and kept.
  failing = false;
  let clean = 0;
  const after = () => historicalRead(first, { reader: 'G7.completion-effective', project: 'garden', ref: reference(x) },
    () => { clean++; return first.get<Json>(x.id)!.value; }, noCycle);
  withHistoricalReads(after); withHistoricalReads(after);
  assert.equal(clean, 1);
});

test("PF3.1 rows 25-28, 30, 32: only the explicit historical refusal read of a listed reader keeps a refusal — complete, untainted and acyclic; an absence it rests on derives again once written; a returned refusal is no shared object", t => {
  const { first } = historicalStores(t);
  const second = new Store(first.path); t.after(() => second.close());
  const anchor = first.write({ id: 'pf31:anchor', kind: 'k', expected: 0, value: {} });
  type Outcome = { ok: true; value: Json } | { ok: false; refusal: { code: string; at: { field: string } } };
  let runs = 0;
  const missing = (): Outcome => ({ ok: false, refusal: { code: 'model_delivery_invalid', at: { field: 'deliveries' } } });
  const derive = (): Outcome => { runs++; first.get(anchor.id); const row = first.get<Json>('pf31:late'); return row ? { ok: true, value: row.value } : missing(); };
  const key = { reader: 'E4.continuation', project: 'garden', ref: reference(anchor) };
  const kept = () => proofs.historicalRefusalRead(first, key, derive, missing);
  // Rows 25, 32: the same refusal at every repeat, in this and the next operation, each an object of its own.
  const refused = withHistoricalReads(() => { const one = kept(); assert.deepEqual(kept(), one); return one; });
  assert.deepEqual(refused, missing()); assert.equal(runs, 1);
  (refused as { refusal: { code: string } }).refusal.code = 'changed by a caller';
  assert.deepEqual(withHistoricalReads(kept), missing()); assert.equal(runs, 1, 'A kept refusal serves the next operation');
  // Row 28: the absence is a dependency — a second Store writing the record derives again, and the refusal becomes a success.
  second.write({ id: 'pf31:late', kind: 'k', expected: 0, value: { late: true } });
  assert.deepEqual(withHistoricalReads(kept), { ok: true, value: { late: true } }); assert.equal(runs, 2);
  // Row 26: an unlisted reader, or a listed one through the ordinary read even with cacheable () => true, keeps no refusal.
  const plainKey = { ...key, parameters: 'plain' };
  const plainRuns = () => { const before = runs; withHistoricalReads(() => { historicalRead(first, plainKey, () => { runs++; first.get(anchor.id); return missing(); }, missing, () => true);
    historicalRead(first, plainKey, () => { runs++; first.get(anchor.id); return missing(); }, missing, () => true); }); return runs - before; };
  assert.equal(plainRuns(), 2);
  const unlisted = () => proofs.historicalRefusalRead(first, { ...key, reader: 'PF3.1.unlisted' }, () => { runs++; return missing(); }, missing);
  const before = runs; withHistoricalReads(() => { unlisted(); unlisted(); }); assert.equal(runs - before, 2);
  // Row 27: tainted by a write attempt, read through a Transaction preview, or with an empty trail across operations.
  const tainted = () => { runs++; first.get(anchor.id); try { first.write({ id: 'pf31:taint', kind: 'k', expected: 9, value: {} }); } catch { /* refused write */ } return missing(); };
  const taintKey = { ...key, ref: reference(anchor), parameters: 'taint' };
  const taintRuns = runs; withHistoricalReads(() => { proofs.historicalRefusalRead(first, taintKey, tainted, missing); proofs.historicalRefusalRead(first, taintKey, tainted, missing); });
  assert.equal(runs - taintRuns, 2, 'A write attempt taints the trail: no refusal is kept even inside the operation');
  const preview = transactionForTests(first).view, previewKey = { ...key, parameters: 'preview' };
  const viaPreview = () => { runs++; preview.get(anchor.id); return missing(); };
  const previewRuns = runs; withHistoricalReads(() => { proofs.historicalRefusalRead(first, previewKey, viaPreview, missing); proofs.historicalRefusalRead(first, previewKey, viaPreview, missing); });
  assert.equal(runs - previewRuns, 2, 'A closure read through a mutable preview keeps the refusal unproved');
  const emptyKey = { ...key, parameters: 'empty' }, empty = () => { runs++; return missing(); };
  const emptyRuns = runs;
  withHistoricalReads(() => { proofs.historicalRefusalRead(first, emptyKey, empty, missing); proofs.historicalRefusalRead(first, emptyKey, empty, missing); });
  withHistoricalReads(() => proofs.historicalRefusalRead(first, emptyKey, empty, missing));
  assert.equal(runs - emptyRuns, 2, 'An empty trail is reused inside its operation, never kept beyond it');
  // Row 30: a cycle answered by onCycle and returned as an ordinary refusal of the same code is never kept.
  const cycleKey = { ...key, parameters: 'cycle' };
  const cyclic = (): Outcome => { runs++; first.get(anchor.id); return proofs.historicalRefusalRead(first, cycleKey, cyclic, missing); };
  const cycleRuns = runs;
  withHistoricalReads(() => { assert.deepEqual(proofs.historicalRefusalRead(first, cycleKey, cyclic, missing), missing());
    proofs.historicalRefusalRead(first, cycleKey, cyclic, missing); });
  assert.equal(runs - cycleRuns, 2, 'The cyclic derivation is derived again, not kept');
  // An exception is no refusal to keep.
  const thrownKey = { ...key, parameters: 'thrown' };
  let throws = 0;
  const failing = (): Outcome => { throws++; first.get(anchor.id); throw new EngineError('record_corrupt', 'injected'); };
  withHistoricalReads(() => { assert.throws(() => proofs.historicalRefusalRead(first, thrownKey, failing, missing));
    assert.throws(() => proofs.historicalRefusalRead(first, thrownKey, failing, missing)); });
  assert.equal(throws, 2);
});

test("PF3.1 return №3473 (rows 16-18, 24): every direct read inside a traced read is a dependency of its own at its place — before, between and after a child — cold and kept, with no child, a cold child or a kept one; ordered observers get the cold stream, distinct ones its set; a moved direct read derives the parent again", t => {
  for (const childMode of ['none', 'cold', 'kept'] as const) for (const mode of ['ordered', 'distinct'] as const) for (const moved of ['y', 'w'] as const) {
    const { first } = historicalStores(t);
    const rows = Object.fromEntries(['x', 'y', 'z', 'w'].map(id => [id, first.write({ id: `ret:${id}`, kind: 'k', expected: 0, value: { id } })])) as Record<string, Revision<Json>>;
    const counts = { outer: 0, inner: 0 };
    let source: Store | undefined;
    const child = (store: Store) => historicalRead(store, { reader: 'G7.completion-effective', project: 'garden', ref: reference(rows['z']!) },
      () => { counts.inner++; return store.get<Json>(rows['z']!.id)!.value; }, noCycle);
    // A child a traced caller may take must have been derived for a traced caller too (S1.4): warm it through a trace.
    if (childMode === 'kept') withHistoricalReads(() => child(historicalTrace(first)));
    const original = Store.prototype.get;
    Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) {
      if (args[0] === rows['x']!.id && source) {
        source.get(rows['y']!.id);
        if (childMode === 'none') source.get(rows['z']!.id); else child(source);
        source.get(rows['w']!.id);
      }
      return original.apply(this, args);
    } as typeof original;
    const streams: string[][] = [];
    try {
      for (let operation = 0; operation < 4; operation++) {
        const seen: string[] = [];
        const traced = historicalTrace(first, ref => seen.push(`${ref.id}@${ref.revision}`), mode);
        withHistoricalReads(() => historicalProof(traced, { reader: 'PF3.1.return', project: 'garden', ref: reference(rows['x']!) },
          s => { counts.outer++; source = s; return s.get<Json>(rows['x']!.id)!.value; }, noCycle));
        streams.push(seen);
        if (operation === 1) { const row = first.get(rows[moved]!.id)!; first.write({ id: row.id, kind: 'k', expected: row.revision, value: { id: moved, moved: true } }); }
      }
    } finally { Store.prototype.get = original; source = undefined; }
    const label = `${childMode}/${mode}/${moved}`;
    const at = (revision: (id: string) => number) => ['y', 'z', 'w', 'x'].map(id => `ret:${id}@${revision(id)}`);
    const cold = at(() => 1), after = at(id => id === moved ? 2 : 1);
    const same = (stream: string[], expected: string[]) => mode === 'ordered' ? assert.deepEqual(stream, expected, label)
      : assert.deepEqual([...stream].sort(), [...new Set(expected)].sort(), label);
    same(streams[0]!, cold);
    same(streams[1]!, cold);
    same(streams[2]!, after);
    same(streams[3]!, after);
    assert.equal(counts.outer, 2, `${label}: kept until a direct read moves, then derived once again`);
    assert.equal(counts.inner, childMode === 'none' ? 0 : 1, `${label}: the unchanged child — cold here or kept from before — is derived once in all`);
  }
});

test("PF4 rows 6, 8: a cycle answered by onCycle and caught by an ancestor leaves the ancestor's trail incomplete — no kept refusal and no kept ancestor; an unlisted reader keeps its former limits", t => {
  const { first } = historicalStores(t);
  const anchor = first.write({ id: 'pf4:anchor', kind: 'k', expected: 0, value: {} });
  type Outcome = { ok: true; value: Json } | { ok: false; refusal: { code: string } };
  const cycled = (): Outcome => ({ ok: false, refusal: { code: 'model_delivery_invalid' } });
  const childKey = { reader: 'E4.continuation', project: 'garden', ref: reference(anchor), parameters: 'pf4-cycle' };
  let children = 0, parents = 0;
  const child = (): Outcome => proofs.historicalRefusalRead(first, childKey, () => { children++; first.get(anchor.id); return child(); }, cycled);
  const parent = () => historicalRead(first, { reader: 'G7.completion-effective', project: 'garden', ref: reference(anchor), parameters: 'pf4-cycle' },
    () => { parents++; first.get(anchor.id); const outcome = child(); return outcome.ok ? 'ok' : outcome.refusal.code; }, noCycle);
  assert.equal(withHistoricalReads(parent), 'model_delivery_invalid');
  assert.equal(withHistoricalReads(parent), 'model_delivery_invalid');
  assert.deepEqual([parents, children], [2, 2], 'Neither the cyclic refusal nor the ancestor that caught it is kept beyond its operation');
  // Row 8: the former limits stand — an unlisted reader keeps no refusal, and the PF3.1 tests of empty trails stay as they are.
  let unlisted = 0;
  const other = () => proofs.historicalRefusalRead(first, { ...childKey, reader: 'PF4.unlisted' }, () => { unlisted++; first.get(anchor.id); return cycled(); }, cycled);
  withHistoricalReads(() => { other(); other(); });
  assert.equal(unlisted, 2);
});

// PF4 part 2 (№3499 §3–5, rows 9–40): events instead of a footprint walk, internal layers, the proof cache.
const pf4Counters = () => proofs.historicalProofCounters();
/** Another process of the same database: a write no observer of this process sees. */
function pf4OtherProcess(path: string, write: Write): void {
  const store = new URL('../src/storage/store.js', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '--no-warnings', '--eval',
    `import { Store } from ${JSON.stringify(store)}; const s = new Store(${JSON.stringify(path)}); s.write(${JSON.stringify(write)}); s.close();`]);
}

test("PF4 rows 9-13, 17, 18: a kept proof is current at one light read of the last event; only events after its mark that touch its dependencies derive it again — an unrelated write of this or a second Store moves the mark, a moved head and a former absence derive, a later head leaves an exact revision lawful; no sequence is frozen for an operation, and a write after the mark — during the derivation in another process, or before the flush — is never skipped", t => {
  const { first, second } = sameFileStores(t);
  const x = first.write({ id: 'pf4:x', kind: 'k', expected: 0, value: { v: 1 } });
  const y = first.write({ id: 'pf4:y', kind: 'k', expected: 0, value: { v: 1 } });
  const runs = { x: 0, y: 0, exact: 0, absent: 0 };
  const prove = (name: keyof typeof runs, read: () => unknown) => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(x), parameters: { pf4: name } },
    () => { runs[name]++; return canonical(read() as Json); }, noCycle);
  const all = () => ({ x: prove('x', () => first.get(x.id)), y: prove('y', () => first.get(y.id)), exact: prove('exact', () => first.get(x.id, 1)),
    absent: prove('absent', () => [first.get('pf4:z'), first.get('pf4:z', 1)]) });
  const cold = withHistoricalReads(all);
  const before = pf4Counters(), reads = storeReads();
  assert.deepEqual(withHistoricalReads(all), cold);
  assert.deepEqual(runs, { x: 1, y: 1, exact: 1, absent: 1 });
  assert.equal(storeReads(), reads, 'Row 9: nothing is read again');
  assert.equal(pf4Counters().unchanged - before.unchanged, 3, 'Row 9: one light check per proof with mutable reads; the exact one has none');
  assert.deepEqual([pf4Counters().ranges, pf4Counters().residualChecks], [before.ranges, before.residualChecks], 'Row 9: no range and no footprint walk');
  first.write({ id: 'pf4:other', kind: 'other', expected: 0, value: {} });
  second.write({ id: 'pf4:other2', kind: 'other', expected: 0, value: {} });
  const unrelated = pf4Counters();
  assert.deepEqual(withHistoricalReads(all), cold);
  assert.deepEqual(runs, { x: 1, y: 1, exact: 1, absent: 1 }, 'Row 10: unrelated writes of this and a second Store derive nothing');
  assert.equal(pf4Counters().advanced - unrelated.advanced, 3, 'Row 10: each mark moved past the checked events');
  const moved = pf4Counters();
  withHistoricalReads(all);
  assert.equal(pf4Counters().ranges, moved.ranges, 'Row 10: after the move the next use reads no range');
  second.write({ id: x.id, kind: 'k', expected: 1, value: { v: 2 } });
  const head = withHistoricalReads(all);
  assert.deepEqual(runs, { x: 2, y: 1, exact: 1, absent: 1 }, 'Rows 11, 12: only the moved head derives again; another id and the exact revision stay');
  assert.notEqual(head.x, cold.x); assert.equal(head.exact, cold.exact);
  second.write({ id: 'pf4:z', kind: 'k', expected: 0, value: { z: 1 } });
  assert.match(withHistoricalReads(all).absent, /"z":1/); assert.equal(runs.absent, 2, 'Row 13: a former absence derives again');
  withHistoricalReads(() => {
    assert.equal(prove('y', () => first.get(y.id)), cold.y); assert.equal(runs.y, 1);
    second.write({ id: y.id, kind: 'k', expected: 1, value: { v: 2 } });
    assert.match(prove('y', () => first.get(y.id)), /"v":2/); assert.equal(runs.y, 2, 'Row 17: the second use in one operation asks the Store afresh');
  });
  let during = 0;
  const proveDuring = () => withHistoricalReads(() => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(x), parameters: { pf4: 'during' } }, () => {
    during++;
    const value = first.get(y.id)!.value;
    if (during === 1) pf4OtherProcess(first.path, { id: y.id, kind: 'k', expected: 2, value: { v: 3 } });
    return canonical(value as Json);
  }, noCycle));
  assert.match(proveDuring(), /"v":2/);
  assert.match(proveDuring(), /"v":3/); assert.equal(during, 2, 'Row 18: a write of another process during the derivation is after the mark');
  let flushed = 0;
  const proveFlushed = () => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(x), parameters: { pf4: 'flush' } },
    () => { flushed++; return canonical(first.get(y.id)!.value as Json); }, noCycle);
  withHistoricalReads(() => { proveFlushed(); second.write({ id: y.id, kind: 'k', expected: 3, value: { v: 4 } }); });
  const restarted = new Store(first.path); t.after(() => restarted.close());
  assert.match(withHistoricalReads(() => historicalRead(restarted, { reader: LISTED, project: 'garden', ref: reference(x), parameters: { pf4: 'flush' } },
    () => { flushed++; return canonical(restarted.get(y.id)!.value as Json); }, noCycle)), /"v":4/);
  assert.equal(flushed, 2, 'Row 18: a write between the derivation and the flush stays after the saved mark');
});

test("PF4 rows 14, 15: a list of a kind — empty or not —, the list of all, a history and a literal prefix are touched only by their own events: %, _ and case are ordinary characters, a Unicode prefix compares by code points, an empty prefix range waits for its first id, and a lone surrogate is decided by any event", t => {
  const { first, second } = sameFileStores(t);
  const a = first.write({ id: 'pf4p:a', kind: 'k', expected: 0, value: {} });
  let n = 0;
  const bump = (id: string, kind = 'k') => { const head = second.get(id); second.write({ id, kind, expected: head?.revision ?? 0, value: { v: ++n } }); };
  const cases: [string, (store: Store) => unknown, () => void, () => void][] = [
    ['empty kind', store => store.list('pf4-empty'), () => bump('pf4p:o1', 'pf4-other'), () => bump('pf4p:e1', 'pf4-empty')],
    ['kind', store => store.list('k'), () => bump('pf4p:o2', 'pf4-other'), () => bump('pf4p:k1')],
    ['all', store => store.list(), () => undefined, () => bump('pf4p:any', 'pf4-any')],
    ['history', store => store.history(a.id), () => bump('pf4p:h-other'), () => bump(a.id)],
    ['prefix %_', store => store.identities('prefix', 'pf4p:%_B'), () => { bump('pf4p:x_B'); bump('pf4p:%_b'); bump('pf4p:%'); bump('pf4p:%xB'); }, () => bump('pf4p:%_Bz')],
    ['prefix unicode', store => store.identities('prefix', 'pf4p:ж\u{1D11E}'), () => { bump('pf4p:ж'); bump('pf4p:ж\u{1D11F}'); bump('pf4p:ж\uFFFF'); bump('pf4p:Ж\u{1D11E}'); }, () => bump('pf4p:ж\u{1D11E}!')],
    ['empty prefix', store => store.identities('prefix', 'pf4p:none:'), () => bump('pf4p:none'), () => bump('pf4p:none:1')],
    ['lone surrogate', store => store.get('pf4p:\uD800'), () => undefined, () => bump('pf4p:unrelated-to-surrogate')],
  ];
  for (const [name, read, unrelated, related] of cases) {
    let runs = 0;
    const prove = () => withHistoricalReads(() => historicalRead(first, { reader: LISTED, project: 'garden', ref: reference(a), parameters: { pf4: name } },
      () => { runs++; return canonical(read(first) as Json); }, noCycle));
    const cold = prove();
    unrelated();
    assert.equal(prove(), cold); assert.equal(runs, 1, `${name}: other events keep the proof`);
    related();
    prove(); assert.equal(runs, 2, `${name}: its own event derives it again`);
    prove(); assert.equal(runs, 2, `${name}: and the new derivation is kept`);
  }
});

const pf4Row = (id: string, revision: number, value: Json): Revision<Json> => ({ id, kind: 'k', revision, hash: hashJson(value), value });
/** A listed reader that builds a layer of `row` over its own Store — internal when `row` is its key's Ref — and reads it
 * through a traced child: the layer's own row, a delegated head, an exact revision and an absence. */
function pf4Layered(store: Store, counts: { parent: number; child: number }, row: Revision<Json>, keyRow: Revision<Json> = row, base: Store = store,
  childRef: Ref = reference(keyRow), name = 'pf4-layer') {
  return historicalRead(store, { reader: LISTED, project: 'garden', ref: reference(keyRow), parameters: name }, () => {
    counts.parent++;
    const layer = proofs.historicalLayer(base, [row]);
    return historicalProof(layer, { reader: 'PF4.child', project: 'garden', ref: childRef }, source => {
      counts.child++;
      return canonical([source.get(row.id)?.value ?? null, source.get('pf4l:mask', 1)?.value ?? null, source.get('pf4l:dep')?.value ?? null,
        source.get('pf4l:absent')?.value ?? null] as Json);
    }, noCycle);
  }, noCycle);
}

test("PF4 rows 21-26: a layer a derivation builds over its own Store from exactly its key's Ref is internal — the result is kept at the Store, its own row masks the base and stays constant, delegated reads are the Store's dependencies; rows outside the key, a layer over another Store or view, and a broken chain at an unchanged sequence keep the former limits; a child that read a layer's own row serves no other layer and is no proof of the bare Store", t => {
  const { first, second } = sameFileStores(t);
  first.write({ id: 'pf4l:mask', kind: 'k', expected: 0, value: { base: 1 } });
  first.write({ id: 'pf4l:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const row = pf4Row('pf4l:mask', 2, { layer: 1 }), counts = { parent: 0, child: 0 };
  const cold = withHistoricalReads(() => pf4Layered(first, counts, row));
  assert.match(cold, /"layer":1/); assert.match(cold, /"base":1/);
  assert.equal(withHistoricalReads(() => pf4Layered(first, counts, row)), cold);
  assert.deepEqual(counts, { parent: 1, child: 1 }, 'Row 21: the composite result is kept at its Store, the layer is not derived again');
  second.write({ id: 'pf4l:mask', kind: 'k', expected: 1, value: { base: 2 } });
  assert.equal(withHistoricalReads(() => pf4Layered(first, counts, row)), cold);
  assert.deepEqual(counts, { parent: 1, child: 1 }, 'Row 25: the head the layer answers itself is constant for it — the base head is no dependency');
  second.write({ id: 'pf4l:dep', kind: 'k', expected: 1, value: { d: 2 } });
  assert.match(withHistoricalReads(() => pf4Layered(first, counts, row)), /"d":2/);
  assert.deepEqual(counts, { parent: 2, child: 2 }, 'Row 25: a delegated head is the Store\'s dependency');
  second.write({ id: 'pf4l:absent', kind: 'k', expected: 0, value: { a: 1 } });
  assert.match(withHistoricalReads(() => pf4Layered(first, counts, row)), /"a":1/);
  assert.deepEqual(counts, { parent: 3, child: 3 }, 'Row 25: a delegated absence is the Store\'s dependency');
  const outside = { parent: 0, child: 0 }, keyRow = pf4Row('pf4l:key', 1, { key: true });
  withHistoricalReads(() => pf4Layered(first, outside, row, keyRow, first, reference(keyRow), 'pf4-outside'));
  withHistoricalReads(() => pf4Layered(first, outside, row, keyRow, first, reference(keyRow), 'pf4-outside'));
  assert.equal(outside.parent, 2, 'Row 22: a row that is not the key\'s Ref grants nothing — derived in every operation');
  const directory = mkdtempSync(join(tmpdir(), 'pf4-other-db-')), other = new Store(join(directory, 'other.sqlite'));
  t.after(() => { other.close(); rmSync(directory, { recursive: true, force: true }); });
  const foreign = { parent: 0, child: 0 };
  withHistoricalReads(() => pf4Layered(first, foreign, row, row, other, reference(row), 'pf4-foreign'));
  withHistoricalReads(() => pf4Layered(first, foreign, row, row, other, reference(row), 'pf4-foreign'));
  assert.equal(foreign.parent, 2, 'Row 23: a layer over another database is no internal layer of this Store');
  const viewed = { parent: 0, child: 0 }, opaque = new Proxy(first, { get(target, key) {
    const member: unknown = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member; } });
  withHistoricalReads(() => pf4Layered(first, viewed, row, row, opaque, reference(row), 'pf4-opaque'));
  withHistoricalReads(() => pf4Layered(first, viewed, row, row, opaque, reference(row), 'pf4-opaque'));
  assert.equal(viewed.parent, 2, 'Row 23: a layer over an unknown Proxy keeps the conservative branch');
  const other1 = pf4Row('pf4l:one', 1, { one: 1 }), other2 = pf4Row('pf4l:two', 1, { two: 2 }), shared = { parent: 0, child: 0 };
  const anchor = first.get('pf4l:dep')!;
  const [left, right] = withHistoricalReads(() => [pf4Layered(first, shared, other1, other1, first, reference(anchor), 'pf4-shared'),
    pf4Layered(first, shared, other2, other2, first, reference(anchor), 'pf4-shared')]);
  assert.notEqual(left, right); assert.deepEqual(shared, { parent: 2, child: 2 }, 'Row 24: a child that read one layer\'s own row serves no other layer');
  let bare = 0;
  const direct = withHistoricalReads(() => historicalProof(first, { reader: 'PF4.child', project: 'garden', ref: reference(anchor) }, source => {
    bare++; return canonical([source.get('pf4l:one')?.value ?? null] as Json); }, noCycle));
  assert.equal(bare, 1, 'Row 24: nor is it a proof of the bare Store'); assert.equal(direct, '[null]');
  const original = Store.prototype.get, sequence = first.lastEvent();
  Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) { return original.apply(this, args); } as typeof original;
  try {
    assert.equal(withHistoricalReads(() => pf4Layered(first, counts, row)), withHistoricalReads(() => pf4Layered(first, counts, row)));
    assert.equal(first.lastEvent(), sequence);
    assert.equal(counts.parent, 4, 'Row 26: a replaced read under the same sequence ends the reuse — the O(1) event check does not bypass the chain');
  } finally { Store.prototype.get = original; }
});

test("PF4 rows 27-30, 40: a saved proof serves a new Store of the database without a derivation — its value, the ordered and distinct streams of its traced replay, the №3473 order of direct reads around a child, and an internal layer rebuilt as internal, so a parent derived over it is kept in its turn; after the restart a related event derives again and an unrelated one does not; opening reads no cache and no events", t => {
  const { first, second } = sameFileStores(t);
  const rows = Object.fromEntries(['x', 'y', 'z', 'w'].map(name => [name, first.write({ id: `pf4r:${name}`, kind: 'k', expected: 0, value: { name } })]));
  first.write({ id: 'pf4l:mask', kind: 'k', expected: 0, value: { base: 1 } });
  first.write({ id: 'pf4l:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const counts = { outer: 0, inner: 0 };
  const child = (source: Store) => historicalProof(source, { reader: 'PF4.restart-child', project: 'garden', ref: reference(rows['z']!) },
    nested => { counts.inner++; return nested.get(rows['z']!.id)!.value; }, noCycle);
  const read = (store: Store) => historicalProof(store, { reader: 'PF4.restart', project: 'garden', ref: reference(rows['x']!) }, source => {
    counts.outer++;
    return [source.get(rows['y']!.id)!.value, child(source), source.get(rows['w']!.id)!.value, source.get(rows['y']!.id)!.value];
  }, noCycle);
  const stream = (store: Store, mode: 'ordered' | 'distinct') => {
    const seen: string[] = [];
    withHistoricalReads(() => read(historicalTrace(store, ref => seen.push(`${ref.id}@${ref.revision}`), mode)));
    return seen;
  };
  const ordered = stream(first, 'ordered'), distinct = stream(first, 'distinct');
  assert.deepEqual(ordered, ['pf4r:y@1', 'pf4r:z@1', 'pf4r:w@1', 'pf4r:y@1']);
  const layered = { parent: 0, child: 0 }, row = pf4Row('pf4l:mask', 2, { layer: 1 });
  const layer = withHistoricalReads(() => pf4Layered(first, layered, row));
  const opened = { events: storeEvents(), proofs: pf4Counters() };
  const restarted = new Store(first.path); t.after(() => restarted.close());
  assert.deepEqual([storeEvents().marks, storeEvents().ranges, storeEvents().cacheReads, pf4Counters().loads],
    [opened.events.marks, opened.events.ranges, opened.events.cacheReads, opened.proofs.loads], 'Row 40: opening reads no cache and no events');
  assert.deepEqual(stream(restarted, 'ordered'), ordered); assert.deepEqual(stream(restarted, 'distinct'), distinct);
  assert.deepEqual(counts, { outer: 1, inner: 1 }, 'Rows 27-29: the saved proof replays the cold stream without a derivation');
  assert.equal(withHistoricalReads(() => pf4Layered(restarted, layered, row)), layer);
  assert.deepEqual(layered, { parent: 1, child: 1 }, 'Row 29: the saved composite result with its internal layer');
  let grand = 0;
  const grandparent = () => withHistoricalReads(() => historicalRead(restarted, { reader: LISTED, project: 'garden', ref: reference(rows['w']!), parameters: 'pf4-grand' },
    () => { grand++; return pf4Layered(restarted, layered, row); }, noCycle));
  assert.equal(grandparent(), layer); assert.equal(grandparent(), layer);
  assert.equal(grand, 1, 'Row 29: the rebuilt layer is internal again — a parent over it is kept');
  second.write({ id: 'pf4r:unrelated', kind: 'k', expected: 0, value: {} });
  assert.deepEqual(stream(restarted, 'ordered'), ordered); assert.equal(grandparent(), layer);
  assert.deepEqual([counts.outer, layered.parent, grand], [1, 1, 1], 'Row 30: an unrelated event after the restart derives nothing');
  second.write({ id: 'pf4l:dep', kind: 'k', expected: 1, value: { d: 2 } });
  second.write({ id: rows['w']!.id, kind: 'k', expected: 1, value: { name: 'w2' } });
  assert.deepEqual(stream(restarted, 'ordered'), ['pf4r:y@1', 'pf4r:z@1', 'pf4r:w@2', 'pf4r:y@1']);
  assert.match(grandparent(), /"d":2/);
  assert.deepEqual([counts.outer, counts.inner, layered.parent, grand], [2, 1, 2, 2], 'Row 30: related events derive exactly the touched proofs');
});

test("PF4 rows 31-33, 36: a saved check answers only its own full key and rules — another project, parameters or Ref, a record moved under another key, an unknown format, a missing node and a value JSON cannot keep are misses with an ordinary derivation; a received value stays the caller's own; two Stores saving the same key leave one whole pair", t => {
  const { first, second } = sameFileStores(t);
  const dep = first.write({ id: 'pf4c:dep', kind: 'k', expected: 0, value: { d: 1 } });
  let runs = 0;
  const prove = (store: Store, key: Partial<HistoricalReadKey> = {}, value: (store: Store) => unknown = source => ({ dep: source.get(dep.id)!.value })) =>
    withHistoricalReads(() => historicalRead(store, { reader: LISTED, project: 'garden', ref: reference(dep), parameters: 'pf4-cache', ...key },
      () => { runs++; return value(store); }, noCycle));
  const fresh = () => { const store = new Store(first.path); t.after(() => store.close()); return store; };
  const saved = prove(first) as { dep: Json };
  saved.dep = 'changed by the caller';
  assert.deepEqual(prove(fresh()), { dep: { d: 1 } }); assert.equal(runs, 1, 'Row 32: the saved value is not the object a caller changed');
  for (const key of [{ project: 'other' }, { parameters: 'pf4-cache-other' }, { ref: { ...reference(dep), hash: hashJson({ d: 0 }) } }]) prove(fresh(), key);
  assert.equal(runs, 4, 'Row 31: another project, parameters or Ref is no hit');
  const raw = new DatabaseSync(first.path); t.after(() => raw.close());
  const exact = (parameters: string) => canonical({ reader: LISTED, project: 'garden', ref: reference(dep), parameters });
  const original = raw.prepare('SELECT body FROM proof_cache WHERE key=?').get(digest(exact('pf4-cache')))!['body'] as string;
  raw.prepare('INSERT OR REPLACE INTO proof_cache(key, written, size, body) VALUES(?, 0, 0, ?)').run(digest(exact('pf4-moved')), original);
  prove(fresh(), { parameters: 'pf4-moved' }); assert.equal(runs, 5, 'Row 31: a record under another key is a miss');
  raw.prepare('UPDATE proof_cache SET body=? WHERE key=?').run(original.replace('"format":"pf4-proof-cache/1"', '"format":"pf4-proof-cache/0"'), digest(exact('pf4-cache')));
  assert.deepEqual(prove(fresh()), { dep: { d: 1 } }); assert.equal(runs, 6, 'Row 33: an unknown format is a miss and an ordinary derivation');
  const node = (JSON.parse(raw.prepare('SELECT body FROM proof_cache WHERE key=?').get(digest(exact('pf4-cache')))!['body'] as string) as { node: string }).node;
  raw.prepare('DELETE FROM proof_nodes WHERE hash=?').run(node);
  prove(fresh()); assert.equal(runs, 7, 'Row 33: a missing node is a miss');
  const lossy = (source: Store) => ({ kept: source.get(dep.id)!.revision, lost: undefined });
  prove(first, { parameters: 'pf4-undefined' }, lossy);
  const unsaved = pf4Counters().unpersistable;
  prove(first, { parameters: 'pf4-undefined-2' }, lossy);
  assert.ok(pf4Counters().unpersistable > unsaved, 'Row 33: a value JSON would change is not saved');
  const reread = prove(fresh(), { parameters: 'pf4-undefined' }, lossy) as Record<string, unknown>;
  assert.ok('lost' in reread); assert.equal(runs, 10, 'Row 33: it is derived again, with its undefined field');
  const frozen = prove(first, { parameters: 'pf4-frozen' }, source => Object.freeze({ list: Object.freeze([source.get(dep.id)!.revision, 2]) }));
  const loaded = prove(fresh(), { parameters: 'pf4-frozen' }, () => { throw new Error('derived again'); }) as { list: number[] };
  assert.deepEqual(loaded, frozen); assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.list), 'Row 32: a frozen value is frozen after loading');
  const plain = prove(fresh(), { parameters: 'pf4-plain' }, source => ({ list: [source.get(dep.id)!.revision] })) as { list: number[] };
  const store = fresh();
  const one = prove(store, { parameters: 'pf4-plain' }, () => { throw new Error('derived again'); }) as { list: number[] };
  one.list.push(2);
  assert.deepEqual(prove(store, { parameters: 'pf4-plain' }, () => { throw new Error('derived again'); }), plain, 'Row 32: each caller gets its own copy');
  const marks = () => (JSON.parse(raw.prepare('SELECT body FROM proof_cache WHERE key=?').get(digest(exact('pf4-pair')))!['body'] as string) as { mark: number; value: Json });
  prove(first, { parameters: 'pf4-pair' });
  const earlier = marks();
  second.write({ id: dep.id, kind: 'k', expected: 1, value: { d: 2 } });
  prove(second, { parameters: 'pf4-pair' });
  const later = marks();
  assert.ok(later.mark > earlier.mark); assert.deepEqual(later.value, { dep: { d: 2 } }, 'Row 36: the later check replaced the whole pair');
  const count = runs;
  assert.deepEqual(prove(fresh(), { parameters: 'pf4-pair' }), { dep: { d: 2 } }); assert.equal(runs, count, 'Row 36: and it is current');
});

test("PF4 rows 34, 35, 38: nothing is saved before the outer boundary; a cache another writer holds is skipped and the work goes on; a too large result is not saved; a restored snapshot carries the checks of its own history only, and a mark from a later history is a miss", async t => {
  const { first } = sameFileStores(t);
  const dep = first.write({ id: 'pf4s:dep', kind: 'k', expected: 0, value: { d: 1 } });
  let runs = 0;
  const prove = (store: Store, parameters: string, value: (store: Store) => unknown = source => source.get(dep.id)!.value) =>
    withHistoricalReads(() => historicalRead(store, { reader: LISTED, project: 'garden', ref: reference(dep), parameters },
      () => { runs++; return value(store); }, noCycle));
  const key = (parameters: string) => digest(canonical({ reader: LISTED, project: 'garden', ref: reference(dep), parameters }));
  withHistoricalReads(() => {
    prove(first, 'pf4-boundary');
    assert.equal(first.proofCacheRead(key('pf4-boundary')), null, 'Row 34: nothing is saved inside the operation');
  });
  assert.notEqual(first.proofCacheRead(key('pf4-boundary')), null, 'Row 34: the pair is saved at the outer boundary');
  const holder = new DatabaseSync(first.path); t.after(() => holder.close());
  holder.exec('BEGIN IMMEDIATE');
  const busy = pf4Counters().flushBusy;
  assert.deepEqual(prove(first, 'pf4-busy'), { d: 1 });
  holder.exec('ROLLBACK');
  assert.ok(pf4Counters().flushBusy > busy, 'Row 35: a held cache is skipped at once'); assert.equal(first.proofCacheRead(key('pf4-busy')), null);
  const big = 'x'.repeat(33 * 1024 * 1024), unsaved = pf4Counters().unpersistable;
  assert.equal((prove(first, 'pf4-big', source => ({ big, dep: source.get(dep.id)!.revision })) as { big: string }).big.length, big.length);
  assert.ok(pf4Counters().unpersistable > unsaved); assert.equal(first.proofCacheRead(key('pf4-big')), null, 'Row 35: a too large result is not saved');
  const backups = mkdtempSync(join(tmpdir(), 'pf4-snapshots-')); t.after(() => rmSync(backups, { recursive: true, force: true }));
  prove(first, 'pf4-branch');
  await first.snapshot(backups);
  first.write({ id: dep.id, kind: 'k', expected: 1, value: { d: 2 } });
  assert.deepEqual(prove(first, 'pf4-branch'), { d: 2 });
  const later = first.proofCacheRead(key('pf4-branch'))!;
  const { restoreSnapshot } = await import('../src/storage/snapshots.js');
  const restoredPath = join(backups, 'restored', 'state.sqlite');
  restoreSnapshot(backups, restoredPath);
  const restored = new Store(restoredPath); t.after(() => restored.close());
  const count = runs;
  assert.deepEqual(prove(restored, 'pf4-branch'), { d: 1 }); assert.equal(runs, count, 'Row 38: the restored history serves its own saved check');
  const raw = new DatabaseSync(restoredPath); t.after(() => raw.close());
  raw.prepare('UPDATE proof_cache SET body=? WHERE key=?').run(later, key('pf4-branch'));
  const again = new Store(restoredPath); t.after(() => again.close());
  assert.deepEqual(prove(again, 'pf4-branch'), { d: 1 }); assert.equal(runs, count + 1, 'Row 38: a check from a later history is a miss');
});

test("PF4 row 40: a database of the former engine (no cache extension) opens without reading any cache or event, derives on demand under its old era and keeps what it derived", t => {
  const directory = mkdtempSync(join(tmpdir(), 'pf4-v1-')), path = join(directory, 'state.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = new Store(path);
  const dep = legacy.write({ id: 'pf4v:dep', kind: 'k', expected: 0, value: { d: 1 } });
  legacy.close();
  removeProofCache(path);
  const before = storeEvents(), loads = pf4Counters().loads;
  const store = new Store(path); t.after(() => store.close());
  assert.deepEqual([storeEvents().marks, storeEvents().ranges, storeEvents().cacheReads, pf4Counters().loads],
    [before.marks, before.ranges, before.cacheReads, loads], 'Opening migrates and reads nothing else');
  let runs = 0;
  const prove = () => withHistoricalReads(() => historicalRead(store, { reader: LISTED, project: 'garden', ref: reference(dep), parameters: 'pf4-v1' },
    () => { runs++; return store.get(dep.id)!.value; }, noCycle));
  assert.deepEqual(prove(), { d: 1 }); assert.deepEqual(prove(), { d: 1 }); assert.equal(runs, 1);
});

test("PF4 row 21 (traced caller): a layer built over a transparent trace of the Store from the key's Ref is internal as well — the result is kept at the Store for traced callers with the cold stream replayed, a delegated read moving derives it again, and it stays in this process", t => {
  const { first, second } = sameFileStores(t);
  first.write({ id: 'pf4t:dep', kind: 'k', expected: 0, value: { d: 1 } });
  const row = pf4Row('pf4t:own', 1, { own: 1 }), counts = { parent: 0, child: 0 };
  const read = (store: Store) => historicalProof(store, { reader: 'PF4.traced-parent', project: 'garden', ref: reference(row) }, source => {
    counts.parent++;
    const layer = proofs.historicalLayer(source, [row]);
    return historicalProof(layer, { reader: 'PF4.traced-child', project: 'garden', ref: reference(row) }, nested => {
      counts.child++;
      return canonical([nested.get(row.id)?.value ?? null, nested.get('pf4t:dep')?.value ?? null] as Json);
    }, noCycle);
  }, noCycle);
  const stream = (store: Store) => {
    const seen: string[] = [];
    const value = withHistoricalReads(() => read(historicalTrace(store, ref => seen.push(`${ref.id}@${ref.revision}`))));
    return { value, seen };
  };
  const cold = stream(first);
  assert.deepEqual(cold.seen, ['pf4t:dep@1']); assert.match(cold.value, /"own":1/);
  assert.deepEqual(stream(first), cold);
  assert.deepEqual(counts, { parent: 1, child: 1 }, 'Kept at the Store and replayed to a new traced caller');
  second.write({ id: 'pf4t:dep', kind: 'k', expected: 1, value: { d: 2 } });
  const moved = stream(first);
  assert.deepEqual(moved.seen, ['pf4t:dep@2']); assert.deepEqual(counts, { parent: 2, child: 2 }, 'A delegated read that moved derives it again');
  const reopened = new Store(first.path); t.after(() => reopened.close());
  assert.deepEqual(stream(reopened), moved); assert.equal(counts.parent, 3, 'A layer over a trace has no description another process could rebuild');
});

test("PF4 return №3541-1 (row 26 at the saved cache): a saved result is taken only by a Store whose reads are the standard ones — a read replaced after saving makes a new Store derive again and see what it reads now, a result derived with replaced reads is not saved, and an unchanged restart is served from the cache", t => {
  const { first } = sameFileStores(t);
  const x = first.write({ id: 'pf4m:x', kind: 'k', expected: 0, value: { v: 1 } });
  first.write({ id: 'pf4m:y', kind: 'k', expected: 0, value: { v: 2 } });
  const row = pf4Row('pf4m:pending', 1, { v: 3 });
  let runs = 0;
  const key = (name: string) => ({ reader: LISTED, project: 'garden', ref: reference(row), parameters: name });
  const prove = (store: Store, name = 'pf4-methods') => withHistoricalReads(() => historicalRead(store, key(name), () => {
    runs++;
    const layer = proofs.historicalLayer(store, [row]);
    return historicalProof(layer, { reader: 'PF4.methods-child', project: 'garden', ref: reference(x) },
      source => canonical([source.get(row.id)!.value, source.get(x.id)!.value] as Json), noCycle);
  }, noCycle));
  const fresh = () => { const store = new Store(first.path); t.after(() => store.close()); return store; };
  const cold = prove(first);
  assert.equal(prove(fresh()), cold); assert.equal(runs, 1, 'An unchanged restart is served from the cache');
  const original = Store.prototype.get;
  Store.prototype.get = function (this: Store, id: string, revision?: number) {
    return original.call(this, id === x.id ? 'pf4m:y' : id, revision);
  } as typeof original;
  try {
    assert.match(prove(fresh()), /"v":2/); assert.equal(runs, 2, 'A new Store with replaced reads derives again and sees what it reads now');
    assert.match(prove(first), /"v":2/); assert.equal(runs, 3, 'The proof kept in memory notices the replacement, as before');
    prove(fresh(), 'pf4-replaced'); assert.equal(runs, 4);
  } finally { Store.prototype.get = original; }
  assert.equal(first.proofCacheRead(digest(canonical(key('pf4-replaced')))), null, 'A result derived with replaced reads is not saved');
  prove(fresh(), 'pf4-replaced'); assert.equal(runs, 5, 'Back on the standard reads it is derived');
  assert.equal(prove(fresh()), cold); assert.equal(runs, 5, 'The result saved under the standard reads serves again');
});

test("PF4 return №3541-2: a result is saved with every node it reaches whatever another Store swept meanwhile — after another Store's eviction by the 512-result bound and after its proofCacheClear, the new record has no dangling link and a new Store takes it without deriving", t => {
  const { first, second } = sameFileStores(t);
  const a = first.write({ id: 'pf4n:a', kind: 'k', expected: 0, value: { a: 1 } });
  const b = first.write({ id: 'pf4n:b', kind: 'k', expected: 0, value: { b: 2 } });
  let computed = 0;
  const proof = (store: Store, row: Revision<Json>, parameters: Json) => withHistoricalReads(() => historicalRead(store,
    { reader: LISTED, project: 'garden', ref: reference(row), parameters }, () => { computed++; return store.get(row.id)!.value; }, noCycle));
  const fresh = () => { const store = new Store(first.path); t.after(() => store.close()); return store; };
  const raw = new DatabaseSync(first.path); t.after(() => raw.close());
  const state = () => ({ roots: Number(raw.prepare('SELECT count(*) AS n FROM proof_cache').get()!['n']),
    dangling: Number(raw.prepare('SELECT count(*) AS n FROM proof_links l LEFT JOIN proof_nodes n ON l.node = n.hash WHERE n.hash IS NULL').get()!['n']) });
  proof(first, a, 'original');
  withHistoricalReads(() => { for (let index = 0; index < 512; index++) proof(second, b, index); });
  assert.equal(first.proofCacheRead(digest(canonical({ reader: LISTED, project: 'garden', ref: reference(a), parameters: 'original' }))), null,
    'The other Store evicted the first result and swept its node');
  proof(first, a, 'after-eviction');
  assert.deepEqual(state(), { roots: 512, dangling: 0 }, 'The new result was written with the node the other Store had swept');
  let count = computed;
  assert.deepEqual(proof(fresh(), a, 'after-eviction'), { a: 1 }); assert.equal(computed, count, 'A new Store takes it without deriving');
  second.proofCacheClear();
  proof(first, a, 'after-clear');
  assert.deepEqual(state(), { roots: 1, dangling: 0 }, 'After another Store emptied the cache as well');
  count = computed;
  assert.deepEqual(proof(fresh(), a, 'after-clear'), { a: 1 }); assert.equal(computed, count);
});

// PF3.3 (№3568): a layer built over the trace of a traced proof — the live path E2.works-proposal-content → readFrameProposals.
const pf33Passing = <T extends object>(target: T): T => new Proxy(target, { get: (object, key) => {
  const member: unknown = Reflect.get(object, key, object); return typeof member === 'function' ? member.bind(object) : member; } });
function pf33Child(layer: Store, counts: { parent: number; child: number }, anchor: Ref, reader = 'PF33.child') {
  return historicalProof(layer, { reader, project: 'garden', ref: anchor }, source => {
    counts.child++;
    return canonical([source.get('pf33:x')?.value ?? null, source.get('pf33:x', 1)?.value ?? null, source.get('pf33:h')?.value ?? null,
      source.get('pf33:dep')?.value ?? null, source.get('pf33:late')?.value ?? null, source.get('pf33:rev', 2)?.value ?? null,
      source.list('k').map(row => row.id), source.history('pf33:x').map(row => row.revision)] as Json);
  }, noCycle);
}
/** A traced parent whose action lays its own rows over the trace it is given — the key's Ref only (internal), or any rows
 * (a plain overlay), or over a view of unknown making — and reads a traced child at that layer. */
function pf33Parent(store: Store, counts: { parent: number; child: number }, anchor: Revision<Json>, kind: 'plain' | 'internal' | 'opaque',
  rows: Revision<Json>[] = [pf4Row('pf33:x', 3, { x: 3 }), pf4Row('pf33:h', 7, { h: 'own' })]) {
  return historicalProof(store, { reader: 'PF33.parent', project: 'garden', ref: reference(anchor), parameters: kind }, source => {
    counts.parent++;
    const layer = kind === 'internal' ? proofs.historicalLayer(source, [anchor]) : pendingOverlay(kind === 'opaque' ? pf33Passing(source) : source, rows);
    return canonical([pf33Child(layer, counts, reference(anchor)), source.get('pf33:dep')?.value ?? null] as Json);
  }, noCycle);
}
function pf33Stores(t: TestContext) {
  const { first, second } = sameFileStores(t);
  const write = (id: string, kind: string, value: Json) => first.write({ id, kind, expected: first.get(id)?.revision ?? 0, value });
  write('pf33:x', 'k', { x: 1 }); write('pf33:x', 'k', { x: 2 }); write('pf33:h', 'other', { h: 'base' });
  write('pf33:rev', 'other', { r: 1 });
  const anchor = write('pf33:dep', 'k', { d: 1 });
  return { first, second, anchor };
}
const pf33Delta = (before: ReturnType<typeof pf4Counters>) => {
  const now = pf4Counters();
  return { residualChecks: now.residualChecks - before.residualChecks, residualEvents: now.residualEvents - before.residualEvents };
};

test("PF3.3 (№3568 rows 1-3, 5, 6, 13, 19, 20, 23): through a layer over its trace a traced proof is reused in its operation by the events of the Store beneath — no residual reread, no read, no event — and derived again exactly when a delegated head, a delegated absence of a head or of a revision moves, through this or a second Store, between two uses of one operation too; an unrelated write and a base head its own row hides derive nothing; a plain overlay keeps its proofs within the operation, an internal layer at its Store as before", t => {
  for (const kind of ['plain', 'internal'] as const) {
    const { first, second, anchor } = pf33Stores(t);
    const counts = { parent: 0, child: 0 }, call = () => pf33Parent(first, counts, anchor, kind);
    const write = (id: string, kindOf: string, value: Json) => second.write({ id, kind: kindOf, expected: second.get(id)?.revision ?? 0, value });
    withHistoricalReads(() => {
      const cold = call();
      assert.match(cold, kind === 'plain' ? /\{\\"x\\":3\}.*\{\\"h\\":\\"own\\"\}/ : /\{\\"x\\":2\}.*\{\\"h\\":\\"base\\"\}/);
      const before = pf4Counters(), reads = storeReads(), sequence = first.lastEvent();
      assert.equal(call(), cold);
      assert.deepEqual([counts, pf33Delta(before), storeReads() - reads, first.lastEvent()], [{ parent: 1, child: 1 }, { residualChecks: 0, residualEvents: 0 }, 0, sequence],
        `${kind}, rows 1, 23: the second use in the operation is checked by the Store's events — no residual reread, no read, no event`);
      write('pf33:dep', 'k', { d: 2 });
      assert.match(call(), /d\\?":2/);
      assert.equal(counts.parent, 2, `${kind}, row 13: a write of a second Store between two uses of one operation is seen by the second`);
    });
    const sequence = first.lastEvent();
    withHistoricalReads(call);
    assert.equal(counts.parent, kind === 'internal' ? 2 : 3, `${kind}, rows 19, 20: kept across operations only from an internal layer (§4 №3499)`);
    assert.equal(first.lastEvent(), sequence, `${kind}, row 23: the check and the save at the operation's boundary add no event`);
    withHistoricalReads(() => {
      call();
      const parents = counts.parent, before = pf4Counters();
      write('pf33:unrelated', 'other', {}); call();
      assert.deepEqual([counts.parent, pf33Delta(before)], [parents, { residualChecks: 0, residualEvents: 0 }], `${kind}, row 6: an unrelated write derives nothing and rereads nothing`);
      write('pf33:h', 'other', { h: 'moved' });
      assert.equal(/moved/.test(call()), kind === 'internal');
      assert.equal(counts.parent, kind === 'internal' ? parents + 1 : parents,
        `${kind}, row 6: a base head the layer's own row hides derives nothing; the internal layer owns only the key's row, so there it is delegated and moved`);
    });
    for (const [id, label] of [['pf33:late', 'an absent head'], ['pf33:rev', 'an absent exact revision']] as const) withHistoricalReads(() => {
      call();
      const parents = counts.parent;
      write(id, 'other', { created: kind });
      assert.match(call(), /created/);
      assert.equal(counts.parent, parents + 1, `${kind}, row 5: ${label} created by a second Store derives again`);
    });
  }
});

test("PF3.3 (№3568 rows 9, 11, 14, 18, 21): a view of unknown making under the layer keeps the residual reread; a read member replaced at the same sequence ends the reuse in memory and nothing over a trace is saved, so a new Store derives again; a write made while the proof is derived — by an observer of its trace — is seen at the next use; one child key over two layers with different own rows, then the bare Store, transfers nothing", t => {
  const { first, second, anchor } = pf33Stores(t);
  const opaque = { parent: 0, child: 0 };
  withHistoricalReads(() => {
    const cold = pf33Parent(first, opaque, anchor, 'opaque'), before = pf4Counters();
    assert.equal(pf33Parent(first, opaque, anchor, 'opaque'), cold);
    assert.ok(pf33Delta(before).residualChecks > 0 && opaque.parent === 1, 'Row 9: the old path — reused by reading again in full');
    // A trace of the factory with no layer above it is admitted nowhere new: its reads keep the old conservative path.
    const bare = transparentTrace(first);
    let derived = 0;
    const read = () => historicalProof(bare, { reader: 'PF33.bare', project: 'garden', ref: reference(anchor) }, source => { derived++; return source.get('pf33:dep')!.value; }, noCycle);
    const value = read(), again = pf4Counters();
    assert.deepEqual(read(), value);
    assert.ok(pf33Delta(again).residualChecks > 0 && derived === 1, 'Row 9: a trace alone is no witness of the Store beneath it');
  });
  for (const kind of ['plain', 'internal'] as const) {
    const counts = { parent: 0, child: 0 }, original = Store.prototype.get;
    withHistoricalReads(() => {
      const cold = pf33Parent(first, counts, anchor, kind), sequence = first.lastEvent();
      Store.prototype.get = function (this: Store, ...args: Parameters<typeof original>) { return original.apply(this, args); } as typeof original;
      try { assert.equal(pf33Parent(first, counts, anchor, kind), cold); } finally { Store.prototype.get = original; }
      assert.deepEqual([counts.parent, first.lastEvent()], [2, sequence], `${kind}, row 11: a replaced read under the same sequence is no reuse`);
    });
    const before = pf4Counters(), fresh = new Store(first.path);
    t.after(() => fresh.close());
    withHistoricalReads(() => pf33Parent(fresh, counts, anchor, kind));
    assert.equal(counts.parent, 3, `${kind}, row 21: a new Store derives again — nothing read through a trace was saved or loaded`);
    assert.equal(pf4Counters().loaded - before.loaded, 0);
  }
  // Row 14: the observer of the parent's trace writes the dependency right after the derivation read it.
  const counts = { parent: 0, child: 0 };
  let seen = 0, wrote = false;
  withHistoricalReads(() => {
    // The child reads the dependency first, the parent last: the write follows the derivation's last read of it.
    const observed = historicalTrace(first, (ref, head, method) => { if (method === 'get' && head && ref.id === 'pf33:dep' && ++seen === 2) { wrote = true; second.write({ id: 'pf33:dep', kind: 'k', expected: ref.revision, value: { d: 'during' } }); } });
    const cold = pf33Parent(observed, counts, anchor, 'plain');
    assert.ok(wrote && !/during/.test(cold), 'The derivation read the value before the write');
    assert.match(pf33Parent(first, counts, anchor, 'plain'), /during/);
    assert.equal(counts.parent, 2, 'Row 14: the mark taken before the read does not skip a write made during the derivation');
  });
  // Row 18: one child key over two layers of different own rows, then the bare Store.
  const shared = { parent: 0, child: 0 }, dep = first.get('pf33:dep')!;
  const [left, right, bare] = withHistoricalReads(() => [
    historicalProof(first, { reader: 'PF33.two', project: 'garden', ref: reference(dep), parameters: 'left' }, source => pf33Child(pendingOverlay(source, [pf4Row('pf33:x', 3, { x: 'left' })]), shared, reference(dep)), noCycle),
    historicalProof(first, { reader: 'PF33.two', project: 'garden', ref: reference(dep), parameters: 'right' }, source => pf33Child(pendingOverlay(source, [pf4Row('pf33:x', 3, { x: 'right' })]), shared, reference(dep)), noCycle),
    pf33Child(first, shared, reference(dep))]);
  assert.ok(/left/.test(left) && /right/.test(right) && !/left|right/.test(bare) && /\{"x":2\}/.test(bare));
  assert.equal(shared.child, 3, 'Row 18: each layer derives its own; the bare Store takes no layer\'s result and no own row becomes its fact');
});

test("PF3.3 (№3568 rows 15, 16): observers of the parent's trace — ordered and distinct, cold, reused, nested, in the next operation and after a write — get the very stream, values and derivations the accepted engine d3ab5fcd gives", t => {
  const { first: store, second } = sameFileStores(t);
  const w = (id: string, expected: number, value: Json) => store.write({ id, kind: 'k', expected, value });
  w('s:x', 0, { x: 1 }); w('s:x', 1, { x: 2 }); const y = w('s:y', 0, { y: 1 }); w('s:o', 0, { o: 1 });
  const row = (id: string, revision: number, value: Json): Revision<Json> => ({ id, kind: 'k', revision, hash: hashJson(value), value });
  const ref = { id: y.id, revision: y.revision, hash: y.hash };
  const counts = { parent: 0, child: 0 };
  const child = (layer: Store) => historicalProof(layer, { reader: 'PF33.child', project: 'garden', ref }, source => {
    counts.child++;
    return canonical([source.get('s:x')?.value ?? null, source.get('s:x', 3)?.value ?? null, source.get('s:x', 1)?.value ?? null, source.get('s:y')?.value ?? null,
      source.get('s:absent') as unknown as Json, source.list('k').map(r => r.id), source.history('s:x').map(r => r.revision), source.get('s:o')?.value ?? null]);
  }, noCycle);
  const parent = (view: Store, name: string, internal: boolean) => historicalProof(view, { reader: 'PF33.parent', project: 'garden', ref, parameters: name }, source => {
    counts.parent++;
    const rows = [row('s:x', 3, { x: 3 }), row('s:o', 2, { o: 'own' })];
    const layer = internal ? proofs.historicalLayer(source, [row(ref.id, ref.revision, { y: 1 })]) : pendingOverlay(source, rows);
    return canonical([child(layer), child(layer), source.get('s:y')?.value ?? null]);
  }, noCycle);
  const out: [string, string, { value: string; into: string[] }][] = [];
  const stream = (mode: 'ordered' | 'distinct', call: (view: Store) => string) => {
    const into: string[] = []; const value = call(historicalTrace(store, (r, head, method) => into.push(`${method}:${r.id}@${r.revision}:${head}`), mode)); return { value, into }; };
  for (const internal of [false, true]) for (const mode of ['ordered', 'distinct'] as const) {
    const name = `${internal ? 'internal' : 'plain'}-${mode}`;
    withHistoricalReads(() => {
      out.push([name, 'cold', stream(mode, v => parent(v, name, internal))]);
      out.push([name, 'reuse', stream(mode, v => parent(v, name, internal))]);
      out.push([name, 'nested', stream(mode, v => historicalProof(v, { reader: 'PF33.grand', project: 'garden', ref, parameters: name }, s => parent(s, name, internal), noCycle))]);
      out.push([name, 'nested-reuse', stream(mode, v => historicalProof(v, { reader: 'PF33.grand', project: 'garden', ref, parameters: name }, s => parent(s, name, internal), noCycle))]);
    });
    withHistoricalReads(() => { out.push([name, 'next-op', stream(mode, v => parent(v, name, internal))]); });
    second.write({ id: 's:y', kind: 'k', expected: store.get('s:y')!.revision, value: { y: name } });
    withHistoricalReads(() => { out.push([name, 'after-write', stream(mode, v => parent(v, name, internal))]); });
  }
  const flat = out.map(([name, call, { value, into }]) => [name, call, value, into]);
  assert.deepEqual(out[0]![2].into, ['get:s:x@1:false', 'get:s:y@1:true', 'list:s:o@1:false', 'list:s:x@2:false', 'list:s:y@1:false', 'history:s:x@1:false', 'history:s:x@2:false',
    'get:s:x@1:false', 'get:s:y@1:true', 'list:s:o@1:false', 'list:s:x@2:false', 'list:s:y@1:false', 'history:s:x@1:false', 'history:s:x@2:false', 'get:s:y@1:true'],
    'The cold ordered stream: what the layer delegates, twice, then the parent\'s own read; no own row and no absence');
  assert.equal(digest(canonical([flat, counts] as unknown as Json)), '15ddb3237bace74d7bf215529db8d31ba176d5f526c75580a05ffb68fc6e8c8f',
    'Every stream, value and derivation count is that of the accepted engine (computed on d3ab5fcd)');
});
