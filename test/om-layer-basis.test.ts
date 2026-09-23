import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import type { Source } from "../src/evidence/evidence.js";
import type { ResearchAnswer, ResearchAssessment } from "../src/discovery/research-model.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import type { OmResult } from "../src/om/refusal.js";
import { writeOmInput } from "../src/om/input.js";
import { readLayerBasis, readLayerEnvelope, type LayerBasis, type LayerEnvelopeRequest } from "../src/om/layer-basis.js";
import { prepareHorizon, readHorizon, writeHorizon, type HorizonRecord, type HorizonRequest } from "../src/om/horizon.js";
import { prepareFrame, readFrame, type FrameRequest } from "../src/om/frame-obligations.js";
import { createOmFixture, type FixtureLayer, type OmFixture } from "./om-fixture.js";
import { exampleGraph } from "./graph-fixture.js";

type LayerBasisRequest = Parameters<typeof readLayerBasis>[1];
const levels = [2, 3] as const;
const clone = structuredClone;
function delivered<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected ${result.refusal.code} at ${canonical(result.refusal.at)}: ${result.refusal.message}`);
  return result.value;
}
function refusedAs<T>(result: OmResult<T>, code: string) {
  if (result.ok) assert.fail(`Expected ${code}, got success`);
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target.length > 0);
  assert.ok(result.refusal.at.field || result.refusal.at.ref);
  assert.ok(["producer", "gap", "owner", "readiness"].includes(result.refusal.route));
  return result.refusal;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "layer_basis_request_invalid");
  assert.equal(typeof (error.details as { target?: unknown }).target, "string");
  return true;
}
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function basisRequest(f: OmFixture, level: 2 | 3): LayerBasisRequest {
  const proof = f.layers[level].value.layerProofs!.find(item => item.level === level)!;
  const upper = proof.inputs.find(ref => ref.id === `graph-layer:${f.project}:${level - 1}`);
  assert.ok(upper);
  return { project: f.project, level, graph: reference(f.graphRevision), layer: reference(f.layers[level]), upper };
}
function frameRequest(f: OmFixture, horizon: Ref, level: 2 | 3): FrameRequest {
  return { project: f.project, level, graph: reference(f.graphRevision), layer: reference(f.layers[level]),
    horizon, frame: null, upper: level === 2 ? null : { horizon, frame: null } };
}
async function fixture(t: test.TestContext) {
  const f = await createOmFixture(t);
  const input = delivered(writeOmInput(f.store, { project: f.project, expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(f.stages[stage])])) as Record<UpstreamStage, Ref> }));
  const request: HorizonRequest = { project: f.project, input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(f.store.get("phase:garden:L2")!),
    choice: { choiceVersion: "shared-basis", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} };
  const horizon = delivered(writeHorizon(f.store, request));
  return { f, request, horizon };
}

test("the shared layer reader validates both native levels, its complete boundary, and unexpected failures without writes", async t => {
  const { f } = await fixture(t);
  for (const level of levels) {
    const request = basisRequest(f, level), before = revisions(f.store);
    const result = delivered(readLayerBasis(f.store, request));
    for (const ref of [request.graph, request.layer, request.upper])
      assert.ok(result.references.some(item => canonical(item) === canonical(ref)), ref.id);
    assert.equal(new Set(result.references.map(ref => canonical(ref))).size, result.references.length);
    assert.ok(result.references.some(ref => ref.id.startsWith("research-assessment:")));
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.references));
    assert.deepEqual(revisions(f.store), before);
    for (const bad of [undefined, null, 0, "request", []]) {
      assert.throws(() => readLayerBasis(f.store, bad as unknown as LayerBasisRequest), malformed);
      assert.throws(() => readLayerBasis(bad as unknown as Store, request), malformed);
    }
    for (const field of ["project", "level", "graph", "layer", "upper"] as const) {
      const missing = clone(request) as Partial<LayerBasisRequest>; delete missing[field];
      assert.throws(() => readLayerBasis(f.store, missing as LayerBasisRequest), malformed);
    }
    for (const field of ["graph", "layer", "upper"] as const) {
      for (const value of [null, {}, { ...request[field], revision: 0 }, { ...request[field], hash: "bad" }]) {
        const broken = { ...request, [field]: value } as LayerBasisRequest;
        assert.throws(() => readLayerBasis(f.store, broken), malformed);
      }
      const missing = clone(request); missing[field].revision += 1000;
      refusedAs(readLayerBasis(f.store, missing), "layer_basis_unproven");
      const forged = clone(request); forged[field].hash = "0".repeat(64);
      refusedAs(readLayerBasis(f.store, forged), "layer_basis_unproven");
      const foreign = clone(request); foreign[field].id = field === "graph" ? "graph:other" : `graph-layer:other:${level}`;
      refusedAs(readLayerBasis(f.store, foreign), "layer_basis_unproven");
    }
    for (const bad of ["", "  "])
      assert.throws(() => readLayerBasis(f.store, { ...request, project: bad }), malformed);
    for (const bad of [1, 4, "2"])
      assert.throws(() => readLayerBasis(f.store, { ...request, level: bad } as LayerBasisRequest), malformed);
    const assessment = result.references.find(ref => ref.id.startsWith("research-assessment:"))!;
    for (const target of [request.graph.id, assessment.id]) for (const error of [
      new TypeError("injected shared layer failure"), new EngineError("record_corrupt", "injected shared layer corruption", { target }),
    ]) {
      const get = f.store.get.bind(f.store);
      try {
        f.store.get = ((id: string, revision?: number) => { if (id === target) throw error; return get(id, revision); }) as Store["get"];
        assert.throws(() => readLayerBasis(f.store, request), actual => actual === error);
      } finally { f.store.get = get; }
      assert.deepEqual(revisions(f.store), before);
    }
    assert.deepEqual(revisions(f.store), before);
  }
});

test("the legacy envelope accepts native v1 refinement without an own proof while retaining evidence integrity", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-legacy-layer-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store);
  engine.execute({ type: "create-project", project: "legacy", title: "Legacy" });
  const initial = engine.graphs.save("legacy", exampleGraph("legacy"), 0, "owner");
  const draft = engine.discovery.create("legacy", "om-g2", "R1", "legacy-produce-operation", [{
    field: "title", kind: "decision", prompt: "Choose the operation title", risk: "A title must name its operation", schema: { type: "string" },
  }]);
  const answered = engine.discovery.decision(draft.value.questions[0]!, 1, "owner", "Accepted legacy producer");
  const graph = engine.graphs.refine("legacy", initial.revision, reference(answered), "owner");
  const layer = store.get<LayerBasis>("graph-layer:legacy:2")!;
  assert.equal(graph.value.version, 1);
  assert.equal(layer.value.layerProofs, undefined);
  assert.equal(layer.value.obligations.length, 1);
  assert.ok(layer.value.inputs.length > 0);
  const request: LayerEnvelopeRequest = { project: "legacy", level: 2, graph: reference(graph), layer: reference(layer) };
  const before = revisions(store), saved = delivered(readLayerEnvelope(store, request));
  assert.deepEqual(saved.graph, graph);
  assert.deepEqual(saved.layer, layer);
  assert.deepEqual(revisions(store), before);
  assert.throws(() => readLayerEnvelope(store, undefined as unknown as LayerEnvelopeRequest), malformed);
  const incorrectRef = { ...request, layer: { ...request.layer, hash: "0".repeat(64) } };
  refusedAs(readLayerEnvelope(store, incorrectRef), "layer_basis_unproven");
  const variants: { field: string; change: (value: LayerBasis) => void }[] = [
    { field: "inputs", change: value => { value.inputs = []; } },
    { field: "obligations", change: value => { value.obligations[0]!.valueHash = "0".repeat(64); } },
    { field: "layerProofs", change: value => { value.layerProofs = [{ level: 2, hash: "0".repeat(64), inputs: [] }]; } },
  ];
  for (const variant of variants) {
    const value = clone(layer.value); variant.change(value);
    const changed = store.write({ id: layer.id, kind: layer.kind, expected: store.get(layer.id)!.revision, value });
    const beforeRead = revisions(store);
    const refusal = refusedAs(readLayerEnvelope(store, { ...request, layer: reference(changed) }), "layer_basis_unproven");
    assert.equal(refusal.at.field, variant.field);
    assert.deepEqual(delivered(readLayerEnvelope(store, request)), saved);
    assert.deepEqual(revisions(store), beforeRead);
  }
  for (const error of [new TypeError("legacy envelope failure"), new EngineError("record_corrupt", "legacy corruption", { target: graph.id })]) {
    const get = store.get.bind(store), beforeRead = revisions(store);
    try {
      store.get = ((id: string, revision?: number) => { if (id === graph.id) throw error; return get(id, revision); }) as Store["get"];
      assert.throws(() => readLayerEnvelope(store, request), actual => actual === error);
    } finally { store.get = get; }
    assert.deepEqual(revisions(store), beforeRead);
  }
});

test("an unused exact source in a proof is refused consistently by the shared reader, G2 and both frame paths", async t => {
  const { f, request, horizon } = await fixture(t);
  const validBasis = basisRequest(f, 2), validFrame = frameRequest(f, reference(horizon.gate), 2);
  const priorFrame = delivered(readFrame(f.store, validFrame));
  const layer = f.store.get<FixtureLayer>(validBasis.layer.id)!;
  const value = clone(layer.value), proof = value.layerProofs!.find(item => item.level === 2)!;
  const unused = f.store.list<Source>("source").find(record => !proof.inputs.some(ref => ref.id === record.id));
  assert.ok(unused);
  assert.ok(!value.inputs.some(ref => canonical(ref) === canonical(reference(unused))));
  proof.inputs.push(reference(unused)); value.inputs.push(reference(unused));
  const alteredLayer = f.store.write({ id: layer.id, kind: layer.kind, expected: layer.revision, value });
  const phase = f.store.get<{ layer: Ref; inputs: Ref[] }>(request.refinement!.id)!;
  const changedPhase = f.store.write({ id: phase.id, kind: phase.kind, expected: phase.revision,
    value: { ...phase.value, layer: reference(alteredLayer),
      inputs: phase.value.inputs.map(ref => canonical(ref) === canonical(reference(layer)) ? reference(alteredLayer) : ref) } });
  const alteredBasis: LayerBasisRequest = { ...validBasis, layer: reference(alteredLayer) };
  const alteredFrame: FrameRequest = { ...validFrame, layer: reference(alteredLayer) };
  const changedRequest: HorizonRequest = { ...request, refinement: reference(changedPhase),
    choice: { ...request.choice, choiceVersion: "unused-proof-input" } };
  const before = revisions(f.store);
  const shared = refusedAs(readLayerBasis(f.store, alteredBasis), "layer_basis_unproven");
  const horizonPreparation = refusedAs(prepareHorizon(f.store, changedRequest), "horizon_refinement_unproven");
  const horizonWriting = refusedAs(writeHorizon(f.store, changedRequest), "horizon_refinement_unproven");
  assert.deepEqual(delivered(readHorizon(f.store, f.project, reference(horizon.gate))), horizon);
  const frameReading = refusedAs(readFrame(f.store, alteredFrame), "frame_basis_unproven");
  const framePreparation = refusedAs(prepareFrame(f.store, alteredFrame), "frame_basis_unproven");
  for (const refusal of [shared, horizonPreparation, horizonWriting, frameReading, framePreparation]) {
    assert.equal(refusal.at.target, alteredLayer.id);
    assert.equal(refusal.message, shared.message);
  }
  for (const refusal of [shared, frameReading, framePreparation]) assert.equal(refusal.at.field, "research.inputs");
  for (const refusal of [horizonPreparation, horizonWriting]) assert.equal(refusal.at.field, "layerProofs.research.inputs");
  assert.deepEqual(revisions(f.store), before);
  assert.deepEqual(delivered(readFrame(f.store, validFrame)), priorFrame);

  const forged = clone(horizon.horizon.value) as HorizonRecord;
  forged.request = changedRequest; forged.result.horizon.choiceVersion = changedRequest.choice.choiceVersion;
  const { hash: _hash, ...payload } = forged.result.horizon;
  forged.result.horizon.hash = hashJson(payload);
  const counterfeitHorizon = f.store.write({ id: `horizon:garden:${changedRequest.choice.choiceVersion}`, kind: "horizon", expected: 0, value: forged });
  const counterfeitGate = f.store.write({ id: `om-horizon:garden:${changedRequest.choice.choiceVersion}`, kind: "om-horizon", expected: 0,
    value: { ...horizon.gate.value, choiceVersion: changedRequest.choice.choiceVersion,
      horizon: reference(counterfeitHorizon), horizonHash: forged.result.horizon.hash } });
  const beforeRead = revisions(f.store);
  const horizonReading = refusedAs(readHorizon(f.store, f.project, reference(counterfeitGate)), "horizon_refinement_unproven");
  assert.equal(horizonReading.at.target, alteredLayer.id);
  assert.equal(horizonReading.at.field, "layerProofs.research.inputs");
  assert.equal(horizonReading.message, shared.message);
  assert.deepEqual(revisions(f.store), beforeRead);
  f.reopen();
  refusedAs(readHorizon(f.store, f.project, reference(counterfeitGate)), "horizon_refinement_unproven");
  refusedAs(readLayerBasis(f.store, alteredBasis), "layer_basis_unproven");
  assert.deepEqual(delivered(readHorizon(f.store, f.project, reference(horizon.gate))), horizon);
  assert.deepEqual(delivered(readFrame(f.store, validFrame)), priorFrame);
  assert.deepEqual(revisions(f.store), beforeRead);
});

test("all historical layer readers preserve captured research after source heads and files change", async t => {
  const { f, horizon } = await fixture(t);
  const basisRequests = levels.map(level => basisRequest(f, level));
  const frameRequests = levels.map(level => frameRequest(f, reference(horizon.gate), level));
  const bases = basisRequests.map(request => delivered(readLayerBasis(f.store, request)));
  const frames = frameRequests.map(request => delivered(readFrame(f.store, request)));
  const changedFiles = new Map<string, Buffer>();
  const sources = new Map<string, Ref>();
  try {
    for (const level of levels) {
      const proof = f.layers[level].value.layerProofs!.find(item => item.level === level)!;
      const product = f.graph.nodes.find(node => node.kind === "product")!;
      const drafts = proof.inputs.map(ref => f.store.get<DiscoveryDraft>(ref.id, ref.revision)!)
        .filter(record => record.kind === "discovery-draft" && record.value.stage === "om-g2"
          && record.value.level === `R${level - 1}` && record.value.consumer === product.id);
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0]!.value.questions.length, 1);
      const questionRefs = proof.inputs.filter(ref => ref.id === drafts[0]!.value.questions[0]);
      assert.equal(questionRefs.length, 1);
      const questionRef = questionRefs[0]!, question = f.store.get<Question>(questionRef.id, questionRef.revision)!;
      assert.equal(question.hash, questionRef.hash);
      assert.equal(question.value.status, "answered");
      assert.equal(question.value.spec.field, "layerDesign");
      assert.ok(question.value.answer);
      const answer = f.store.get<ResearchAnswer>(question.value.answer.id, question.value.answer.revision)!;
      assert.equal(answer.kind, "research-answer");
      assert.equal(answer.hash, question.value.answer.hash);
      assert.ok(proof.inputs.some(ref => canonical(ref) === canonical(reference(answer))));
      const assessment = f.store.get<ResearchAssessment>(answer.value.assessment.id, answer.value.assessment.revision)!;
      assert.equal(assessment.kind, "research-assessment");
      assert.equal(assessment.hash, answer.value.assessment.hash);
      assert.ok(proof.inputs.some(ref => canonical(ref) === canonical(reference(assessment))));
      assert.ok(assessment.value.observations.length > 0);
      for (const observation of assessment.value.observations) {
        assert.ok(proof.inputs.some(ref => canonical(ref) === canonical(observation.source)));
        sources.set(canonical(observation.source), observation.source);
      }
      // Native layer designs cite owner documents; inherited research supplies the captured file evidence.
      for (const ref of proof.inputs) {
        const record = f.store.get<ResearchAssessment>(ref.id, ref.revision)!;
        if (record.kind !== "research-assessment") continue;
        for (const observation of record.value.observations) if (proof.inputs.some(input => canonical(input) === canonical(observation.source)))
          sources.set(canonical(observation.source), observation.source);
      }
    }
    for (const sourceRef of sources.values()) {
      const source = f.store.get<Source>(sourceRef.id, sourceRef.revision)!;
      assert.equal(source.kind, "source");
      assert.equal(source.hash, sourceRef.hash);
      if (source.value.origin.kind === "file") {
        const path = source.value.origin.location;
        if (!changedFiles.has(path)) changedFiles.set(path, readFileSync(path));
        writeFileSync(path, Buffer.concat([changedFiles.get(path)!, Buffer.from("\nChanged after saved research\n")]));
      }
      f.store.write({ id: source.id, kind: source.kind, expected: f.store.get(source.id)!.revision, value: source.value });
    }
    assert.ok(changedFiles.size > 0, "The native L3 fixture supplies a real captured file");
    const before = revisions(f.store);
    for (const reopen of [false, true]) {
      if (reopen) f.reopen();
      assert.deepEqual(basisRequests.map(request => delivered(readLayerBasis(f.store, request))), bases);
      assert.deepEqual(frameRequests.map(request => delivered(readFrame(f.store, request))), frames);
      assert.deepEqual(delivered(readHorizon(f.store, f.project, reference(horizon.gate))), horizon);
      assert.deepEqual(revisions(f.store), before);
    }
  } finally { for (const [path, bytes] of changedFiles) writeFileSync(path, bytes); }
});
