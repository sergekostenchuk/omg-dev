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
import { Store, type Revision, type Write } from "../src/storage/store.js";
import { captureView, storeView } from "../src/storage/store-view.js";
import { RunControlGate, RunControlLost, stopRun } from "../src/om/run-control.js";
import { sealed } from "../src/om/refusal.js";
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
    f.reopen();
    assert.ok(repeat(true) > 0, "A reopened Store validates cold, with the same schema objects");
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
  const reopened = new Store(first.path); t.after(() => reopened.close());
  read(reopened); assert.equal(outer, 2); assert.equal(inner, 2, 'A new Store instance starts cold and proves again');
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
    // S1.3 (№2185-4): the next operation of the same Store reuses the kept DAG; a new Store instance proves it again.
    assert.equal(read(first, depth), 2 ** depth);
    assert.deepEqual(calls, Array<number>(depth + 1).fill(1), 'The next operation reuses the kept DAG of this Store');
    const reopened = new Store(first.path);
    try {
      assert.equal(read(reopened, depth), 2 ** depth);
      assert.deepEqual(calls, Array<number>(depth + 1).fill(2), 'A new Store instance proves the DAG again');
    } finally { reopened.close(); }
  } finally { Array.prototype.push = originalPush; }
});

test("S1 distinct collectors traverse a deep repeated DAG once and keep unique ref method and head observations", t => {
  const { first } = historicalStores(t);
  const a = first.write({ id: 'proof:distinct-a', kind: 'proof', expected: 0, value: { value: 'a' } });
  const b = first.write({ id: 'proof:distinct-b', kind: 'proof', expected: 0, value: { value: 'b' } });
  type Observation = { ref: Ref; head: boolean; method: 'get' | 'list' | 'history' };
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
  type Observation = { ref: Ref; head: boolean; method: 'get' | 'list' | 'history' };
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
  assert.deepEqual(read(second), moved); assert.equal(calls, 5, 'The second Store instance is its own cold source');
  const reopened = new Store(first.path); t.after(() => reopened.close());
  assert.deepEqual(read(reopened), moved); assert.equal(calls, 6, 'A reopened Store starts cold');
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
  type Observation = { ref: Ref; head: boolean; method: 'get' | 'list' | 'history' };
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
