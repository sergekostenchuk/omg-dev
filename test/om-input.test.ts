import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, digest, hashJson, type Json } from "../src/canonical.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { isRef, reference, type Ref, type StageArtifact } from "../src/pipeline/contracts.js";
import { Store, type Revision } from "../src/storage/store.js";
import {
  buildOmInput, gateInput, prepareOmInput, writeOmInput, readOmInput, INPUT_REFUSAL_CODES, NODES_REQUIRED_SINCE,
  type InputBuildResult, type InputOptions, type InputRequest, type InputStages, type OmInput,
} from "../src/om/input.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult, Refusal, Sealed } from "../src/om/refusal.js";
import { createOmFixture, type OmFixture } from "./om-fixture.js";
import { ProductEngine } from "../src/product/engine.js";
import type { ResearchAssessment } from "../src/discovery/research-model.js";
import type { Source } from "../src/evidence/evidence.js";

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
    ["question_consumer_missing", s => { fields(s, "features").featurePreparation[0].remainingQuestions = [{ question: "Where?", blocksCurrentStage: false, kind: "fact" }]; }],
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
    kind: metadata, blocksCurrentStage: false }];
  const questions = fields(stages, "features").featurePreparation[0].remainingQuestions = [
    { question: "Which design?", consumer: "garden-consume-block", kind: "decision", blocksCurrentStage: false },
    { question: "Which environment?", consumer: "garden-produce-block", kind: "environment", blocksCurrentStage: false },
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
  assert.ok(prepared.guards.some(guard => guard.id === inventory.id && guard.hash === inventory.hash));
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
    const repeat = () => {
      captured.length = 0;
      assert.deepEqual(historical(), saved);
      const schemas = questionSchemas();
      assert.deepEqual([...new Set(schemas.map(canonical))].sort(), expectedContents);
      assert.ok(schemas.every(schema => initialIdentities.has(schema)), "Historical reads must not create fresh schema identities");
    };
    repeat();
    repeat();
    const source = f.store.get<Source>(`source:${f.project}:brief`)!;
    const content = `${source.value.content}\n`;
    f.store.write({ id: source.id, kind: source.kind, expected: source.revision,
      value: { ...clone(source.value), content, sha256: digest(content) } });
    repeat();
    f.reopen();
    repeat();
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
