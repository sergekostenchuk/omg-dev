import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { Evidence, type Source } from "../src/evidence/evidence.js";
import type { ResearchAssessment } from "../src/discovery/research-model.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { Store } from "../src/storage/store.js";
import { removeProofCache } from "../src/storage/schema.js";
import type { OmResult } from "../src/om/refusal.js";
import { readLayerBasis, readLayerAcceptance, readUnacceptedLayer, readRebaseBasis, buildRebasedLayer, acceptedCandidateFills, lowerLayerHash, omAcceptedFrame, acceptedLayerProof,
  type LayerBasis, type OmAcceptedFrame, type OmRebasedFrame, type RebasedLayerRequest } from "../src/om/layer-basis.js";
import { prepareHorizon, readHorizon, writeHorizon, type HorizonRecord, type HorizonRequest } from "../src/om/horizon.js";
import { prepareFrame, readFrame, type FrameRequest } from "../src/om/frame-obligations.js";
import { createOmFixture, type FixtureLayer, type OmFixture } from "./om-fixture.js";
import { writeCandidate, gateCandidate, readCandidate as importedReadCandidate, type FrameCandidateRecord, type CandidateGate } from "../src/om/frame-candidate.js";
import type { Revision, Write } from "../src/storage/store.js";
import { prepareSettleCandidate, settleCandidate, type SettleCandidateRequest } from "../src/om/frame-accept.js";
import type { Graph } from "../src/graph/model.js";

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
    horizon, frame: reference(f.store.get(`om-frame:${f.project}:${level}`)!),
    upper: level === 2 ? null : { horizon, frame: reference(f.store.get(`om-frame:${f.project}:2`)!) },
    ...(level === 3 ? { workZoneContract: "accepted-l2-v1" as const } : {}) };
}
async function fixture(t: test.TestContext, fileBrief = false) {
  // The history scenario needs an actual file source in the upstream accepted proof.
  // Only source creation is redirected; all stages and both OM layers use real producers.
  const directory = fileBrief ? mkdtempSync(join(tmpdir(), "omg-layer-file-")) : null;
  if (directory) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const document = Evidence.prototype.document;
  if (directory) Evidence.prototype.document = function(project, id, content, mediaType, expected) {
    if (project === "garden" && id === "brief") {
      writeFileSync(join(directory, "brief.md"), content);
      return this.file(project, id, directory, "brief.md", mediaType, expected);
    }
    return document.call(this, project, id, content, mediaType, expected);
  };
  let f: OmFixture;
  try { f = await createOmFixture(t, "standard", "garden", { mode: "executed" }); }
  finally { Evidence.prototype.document = document; }
  const input = f.store.get("om-input:garden")!;
  const request: HorizonRequest = { project: f.project, input: reference(input), graph: reference(f.graphRevision),
    refinement: reference(f.layers[2]),
    choice: { choiceVersion: "shared-basis", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} };
  const horizon = delivered(writeHorizon(f.store, request));
  return { f, request, horizon };
}

test("the shared acceptance reader validates both OM levels, its complete boundary, and unexpected failures without writes", async t => {
  const { f } = await fixture(t);
  for (const level of levels) {
    const expectedUpper = basisRequest(f, level).upper;
    const request = { project: f.project, level, graph: reference(f.graphRevision), layer: reference(f.layers[level]) };
    const before = revisions(f.store);
    const result = delivered(readLayerAcceptance(f.store, request));
    for (const ref of [request.graph, request.layer, expectedUpper])
      assert.ok(result.references.some(item => canonical(item) === canonical(ref)), ref.id);
    assert.equal(new Set(result.references.map(ref => canonical(ref))).size, result.references.length);
    assert.equal(result.producer, "om");
    assert.deepEqual(result.upper, expectedUpper);
    assert.deepEqual(result.frame, reference(f.store.get(`om-frame:garden:${level}`)!));
    assert.ok(result.currentReferences.some(ref => canonical(ref) === canonical(result.frame)));
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.references));
    assert.deepEqual(revisions(f.store), before);
    for (const bad of [undefined, null, 0, "request", []]) {
      assert.throws(() => readLayerAcceptance(f.store, bad as unknown as LayerBasisRequest), malformed);
      assert.throws(() => readLayerAcceptance(bad as unknown as Store, request), malformed);
    }
    for (const field of ["project", "level", "graph", "layer"] as const) {
      const missing = clone(request) as Partial<typeof request>; delete missing[field];
      assert.throws(() => readLayerAcceptance(f.store, missing as LayerBasisRequest), malformed);
    }
    for (const field of ["graph", "layer"] as const) {
      for (const value of [null, {}, { ...request[field], revision: 0 }, { ...request[field], hash: "bad" }]) {
        const broken = { ...request, [field]: value } as LayerBasisRequest;
        assert.throws(() => readLayerAcceptance(f.store, broken), malformed);
      }
      const missing = clone(request); missing[field].revision += 1000;
      refusedAs(readLayerAcceptance(f.store, missing), "layer_basis_unproven");
      const forged = clone(request); forged[field].hash = "0".repeat(64);
      refusedAs(readLayerAcceptance(f.store, forged), "layer_basis_unproven");
      const foreign = clone(request); foreign[field].id = field === "graph" ? "graph:other" : `graph-layer:other:${level}`;
      refusedAs(readLayerAcceptance(f.store, foreign), "layer_basis_unproven");
    }
    for (const bad of ["", "  "])
      assert.throws(() => readLayerAcceptance(f.store, { ...request, project: bad }), malformed);
    for (const bad of [1, 4, "2"])
      assert.throws(() => readLayerAcceptance(f.store, { ...request, level: bad } as LayerBasisRequest), malformed);
    // NR1 (№3591): the saved layer is read as written; a fault of a record it reads (the graph) reaches the caller, and the
    // producer records named by its proof are not read again.
    for (const target of [request.graph.id]) for (const error of [
      new TypeError("injected shared layer failure"), new EngineError("record_corrupt", "injected shared layer corruption", { target }),
    ]) {
      const get = f.store.get.bind(f.store);
      try {
        f.store.get = ((id: string, revision?: number) => { if (id === target) throw error; return get(id, revision); }) as Store["get"];
        assert.throws(() => readLayerAcceptance(f.store, request), actual => actual === error);
      } finally { f.store.get = get; }
      assert.deepEqual(revisions(f.store), before);
    }
    assert.deepEqual(revisions(f.store), before);
    const upper = f.store.get(expectedUpper.id)!;
    f.store.write({ id: upper.id, kind: upper.kind, expected: upper.revision, value: upper.value });
    const afterAdvance = revisions(f.store);
    assert.deepEqual(delivered(readLayerAcceptance(f.store, request)), result);
    f.reopen();
    assert.deepEqual(delivered(readLayerAcceptance(f.store, request)), result);
    assert.deepEqual(revisions(f.store), afterAdvance);
  }
});

test("an unused exact source in a proof is refused consistently by the shared reader, G2 and both frame paths", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
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

test("all historical layer readers preserve captured OM acceptance after source heads and files change", async t => {
  const { f, horizon } = await fixture(t, true);
  const basisRequests = levels.map(level => basisRequest(f, level));
  const frameRequests = levels.map(level => frameRequest(f, reference(horizon.gate), level));
  const bases = basisRequests.map(request => delivered(readLayerBasis(f.store, request)));
  const frames = frameRequests.map(request => delivered(readFrame(f.store, request)));
  const changedFiles = new Map<string, Buffer>();
  const sources = new Map<string, Ref>();
  try {
    for (const level of levels) {
      const proof = f.layers[level].value.layerProofs!.find(item => item.level === level)!;
      const frame = f.store.get<import('../src/om/layer-basis.js').OmAcceptedFrame>(`om-frame:garden:${level}`)!;
      assert.equal(frame.value.acceptance.producer, "om");
      assert.ok(proof.inputs.some(ref => canonical(ref) === canonical(reference(frame))));
      const candidateRef = frame.value.acceptance.candidate;
      const candidate = delivered(importedReadCandidate(f.store, { project: f.project, candidate: candidateRef }));
      assert.equal(candidate.hash, candidateRef.hash);
      assert.ok(proof.inputs.some(ref => canonical(ref) === canonical(candidateRef)));
    }
    // Accepted upstream observations supply real captured files; the OM layers retain
    // their own candidate/frame proofs when those source heads and files later change.
    for (const assessment of f.store.list<ResearchAssessment>("research-assessment"))
      for (const observation of assessment.value.observations) sources.set(canonical(observation.source), observation.source);
    assert.ok(sources.size > 0);
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
    assert.ok(changedFiles.size > 0, "The accepted upstream proof supplies a real captured file");
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


test("OM acceptance builders preserve exact fill sources, distinguish the own lower part, and validate every boundary", async t => {
  const { f, horizon } = await fixture(t);
  const candidateResult = delivered(writeCandidate(f.store, { frame: frameRequest(f, reference(horizon.gate), 2), proposals: [] }));
  assert.equal(candidateResult.state, "candidate");
  if (candidateResult.state !== "candidate") return;
  const candidate = candidateResult.record as Revision<FrameCandidateRecord>;
  const gate = delivered(gateCandidate(f.store, { project: f.project, candidate: reference(candidate) })) as CandidateGate;
  const graph = { id: candidate.value.base.graph.id, revision: candidate.value.base.graph.revision + 1, hash: candidate.value.graphHash };
  const upper = basisRequest(f, 2).upper, before = revisions(f.store);
  const production = { contract: "om-frame-acceptance/v1" as const, binding: null,
    layer: { id: `graph-layer:${f.project}:2`, revision: 2 } };
  const saved = omAcceptedFrame(candidate, gate, graph, upper, production);
  const frameRef = { id: `om-frame:${f.project}:2`, revision: 1, hash: hashJson(saved) };
  const proof = acceptedLayerProof(candidate, upper, frameRef);
  assert.deepEqual(proof, { level: 2, hash: candidate.value.layerHash,
    inputs: [upper, reference(candidate), frameRef].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) });
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.inputs));
  assert.equal(saved.candidateHash, candidate.value.graphHash);
  assert.deepEqual(saved.acceptance, { producer: "om", candidate: reference(candidate), gate: { name: "G3", ...gate }, graph, upper,
    contract: "om-frame-acceptance/v1", binding: null, layer: { id: `graph-layer:${f.project}:2`, revision: 2 } });
  assert.deepEqual(saved.fills, acceptedCandidateFills(candidate.value.fills));
  assert.deepEqual(saved.fills.map(fill => fill.basis).sort((a, b) => canonical(a).localeCompare(canonical(b))),
    candidate.value.fills.map(fill => fill.basis).sort((a, b) => canonical(a).localeCompare(canonical(b))));
  assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved.fills) && Object.isFrozen(saved.acceptance));
  const changed = clone(f.graph);
  changed.nodes.find(node => node.kind === "operation")!.title += " changed only above works";
  assert.equal(lowerLayerHash(changed, 3), lowerLayerHash(f.graph, 3));
  changed.nodes.find(node => node.kind === "work")!.title += " changed work";
  assert.notEqual(lowerLayerHash(changed, 3), lowerLayerHash(f.graph, 3));
  for (const value of [undefined, null, [], 0, "bad"]) {
    assert.throws(() => omAcceptedFrame(value as unknown as Revision<FrameCandidateRecord>, gate, graph, upper, production), malformed);
    assert.throws(() => omAcceptedFrame(candidate, value as unknown as CandidateGate, graph, upper, production), malformed);
    assert.throws(() => omAcceptedFrame(candidate, gate, value as unknown as Ref, upper, production), malformed);
    assert.throws(() => omAcceptedFrame(candidate, gate, graph, value as unknown as Ref, production), malformed);
    assert.throws(() => acceptedLayerProof(value as unknown as Revision<FrameCandidateRecord>, upper, frameRef), malformed);
    assert.throws(() => acceptedLayerProof(candidate, value as unknown as Ref, frameRef), malformed);
    assert.throws(() => acceptedLayerProof(candidate, upper, value as unknown as Ref), malformed);
    assert.throws(() => lowerLayerHash(value as unknown as Graph, 2), malformed);
    if (!Array.isArray(value)) assert.throws(() => acceptedCandidateFills(value as unknown as FrameCandidateRecord['fills']), malformed);
  }
  assert.throws(() => omAcceptedFrame(candidate, { ...gate, graphHash: "0".repeat(64) }, graph, upper, production), malformed);
  for (const addition of [{ basis: reference(candidate) }, { gate: "G5" }, { worksContract: "works-frame/v1", gate: "G5", basis: reference(candidate), codes: [] }])
    assert.throws(() => omAcceptedFrame(candidate, { ...gate, ...addition }, graph, upper, production), malformed);
  assert.throws(() => omAcceptedFrame(candidate, gate, { ...graph, revision: graph.revision + 1 }, upper, production), malformed);
  assert.throws(() => omAcceptedFrame(candidate, gate, graph, { ...upper, id: "graph-layer:foreign:1" }, production), malformed);
  for (const bad of [undefined, null, {}, { ...production, contract: "foreign/v1" }, { ...production, binding: {} },
    { ...production, binding: { series: upper, ordinal: 1, obligations: ["x"], extra: 1 } },
    { ...production, layer: { id: `graph-layer:foreign:2`, revision: 1 } }, { ...production, layer: { id: `graph-layer:${f.project}:2`, revision: 0 } },
    { contract: production.contract, binding: production.binding }, { ...production, extra: 1 }])
    assert.throws(() => omAcceptedFrame(candidate, gate, graph, upper, bad as Parameters<typeof omAcceptedFrame>[4]), malformed);
  assert.throws(() => acceptedLayerProof(candidate, { ...upper, id: "graph-layer:foreign:1" }, frameRef), malformed);
  assert.throws(() => acceptedLayerProof(candidate, upper, { ...frameRef, id: "om-frame:foreign:2" }), malformed);
  const withoutWorks = { ...candidate.value, level: 3 as const };
  assert.throws(() => acceptedLayerProof({ ...candidate, value: withoutWorks, hash: hashJson(withoutWorks) },
    { ...upper, id: `graph-layer:${f.project}:2` }, { ...frameRef, id: `om-frame:${f.project}:3` }), malformed);
  for (const field of ["obligation", "node", "source", "basis"] as const) {
    const fills = clone(candidate.value.fills); delete (fills[0] as unknown as Record<string, unknown>)[field];
    assert.throws(() => acceptedCandidateFills(fills), malformed);
  }
  assert.deepEqual(revisions(f.store), before);
});

test("the producer selector never turns an invalid OM claim or an accepted native layer into an unavailable source", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const { f } = await fixture(t), request = basisRequest(f, 2), before = revisions(f.store);
  const { upper: _upper, ...automatic } = request;
  assert.deepEqual(delivered(readLayerAcceptance(f.store, automatic)), delivered(readLayerBasis(f.store, request)));
  refusedAs(readUnacceptedLayer(f.store, automatic), "layer_basis_unproven");
  assert.deepEqual(revisions(f.store), before);
  for (const value of [undefined, null, 0, [], "bad"]) {
    assert.throws(() => readLayerAcceptance(f.store, value as unknown as typeof automatic), malformed);
    assert.throws(() => readUnacceptedLayer(f.store, value as unknown as typeof automatic), malformed);
  }
  for (const marker of [null, {}, { producer: "research", frame: request.layer }, { producer: "om" },
    { producer: "om", frame: { id: "om-frame:garden:2", revision: 1, hash: "0".repeat(64) } }]) {
    const layer = f.store.write({ id: request.layer.id, kind: "graph-layer", expected: f.store.get(request.layer.id)!.revision,
      value: { ...f.layers[2].value, acceptance: marker } });
    const changed = { ...request, layer: reference(layer) }, snapshot = revisions(f.store);
    refusedAs(readLayerBasis(f.store, changed), "layer_basis_unproven");
    refusedAs(readLayerAcceptance(f.store, changed), "layer_basis_unproven");
    refusedAs(readUnacceptedLayer(f.store, changed), "layer_basis_unproven");
    assert.deepEqual(revisions(f.store), snapshot);
  }
});


test("the OM historical layer reader rederives its exact accepted candidate and gate and rejects coherent frame forgeries", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  const { f, horizon } = await fixture(t);
  const frameRequestValue = frameRequest(f, reference(horizon.gate), 2);
  const proposal = f.store.write({ id: "om-proposal:garden:basis", kind: "layer-proposal", expected: 0, value: {
    base: { graph: frameRequestValue.graph, frame: null }, level: 2, source: "decision", status: "proposed",
    nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [], anchors: [], joins: [], tests: [],
    edges: [], journeys: [], packets: [], transfers: [], removes: [], replaces: [], redefines: [],
  } });
  const built = delivered(writeCandidate(f.store, { frame: frameRequestValue, proposals: [reference(proposal)] }));
  assert.equal(built.state, "candidate"); if (built.state !== "candidate") return;
  const request: SettleCandidateRequest = { project: f.project, level: 2, candidate: reference(built.record),
    outcome: { gate: "G3", candidate: reference(built.record), graphHash: built.record.value.graphHash, passed: true, codes: [] } };
  const prepared = delivered(prepareSettleCandidate(f.store, request));
  assert.ok(prepared.result.graph && prepared.result.layer && prepared.result.frame);
  const variants: { name: string; change: (frame: OmAcceptedFrame) => void }[] = [
    { name: "gate", change: frame => { frame.acceptance.gate.name = "G5" as "G3"; } },
    { name: "fills", change: frame => { frame.fills.pop(); } },
    { name: "candidateHash", change: frame => { frame.candidateHash = "0".repeat(64); } },
    { name: "producer", change: frame => { delete (frame.acceptance as Partial<OmAcceptedFrame['acceptance']>).producer; } },
    { name: "proposal-transition", change: () => {} },
    { name: "graph", change: frame => { frame.acceptance.graph = frameRequestValue.graph; } },
  ];
  for (const variant of variants) {
    const store = new Store(join(f.root, `forged-${variant.name}.sqlite`));
    try {
      for (const head of f.store.list()) for (const record of f.store.history(head.id))
        store.write({ id: record.id, kind: record.kind, expected: record.revision - 1, value: record.value });
      const writes = clone(prepared.writes) as Write[];
      const frameWrite = writes.find(write => write.kind === "connection-frame")!;
      const frame = frameWrite.value as OmAcceptedFrame; variant.change(frame);
      const oldFrame = reference(prepared.result.frame);
      const changedFrame = { ...oldFrame, hash: hashJson(frame) };
      const layerWrite = writes.find(write => write.kind === "graph-layer")!;
      const layer = layerWrite.value as LayerBasis;
      layer.acceptance!.frame = changedFrame;
      const swap = (ref: Ref) => canonical(ref) === canonical(oldFrame) ? changedFrame : ref;
      const normalize = (refs: Ref[]) => refs.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
      layer.inputs = normalize(layer.inputs.map(swap));
      for (const proof of layer.layerProofs!) proof.inputs = normalize(proof.inputs.map(swap));
      store.writeMany(variant.name === "proposal-transition" ? writes.filter(write => write.kind !== "layer-proposal") : writes);
      const source = { project: f.project, level: 2 as const, graph: reference(store.get(`graph:${f.project}`)!),
        layer: reference(store.get(layerWrite.id)!) };
      const snapshot = revisions(store);
      refusedAs(readLayerAcceptance(store, source), "layer_basis_unproven");
      refusedAs(readLayerBasis(store, { ...source, upper: basisRequest(f, 2).upper }), "layer_basis_unproven");
      refusedAs(readUnacceptedLayer(store, source), "layer_basis_unproven");
      assert.deepEqual(revisions(store), snapshot);
    } finally { store.close(); }
  }
  const settled = delivered(settleCandidate(f.store, request));
  assert.ok(settled.graph && settled.layer && settled.frame);
  const source = { project: f.project, level: 2 as const, graph: reference(settled.graph), layer: reference(settled.layer) };
  const result = delivered(readLayerAcceptance(f.store, source));
  assert.equal(result.producer, "om");
  assert.deepEqual(result.frame, reference(settled.frame));
  assert.deepEqual(result.upper, basisRequest(f, 2).upper);
  assert.ok(result.references.some(ref => canonical(ref) === canonical(reference(proposal))), "The proposed source revision is retained historically");
  assert.ok(result.references.some(ref => canonical(ref) === canonical(built.record.value.base.graph)));
  assert.ok(!result.currentReferences.some(ref => ref.id === proposal.id || ref.id === built.record.value.base.graph.id));
  refusedAs(readUnacceptedLayer(f.store, source), "layer_basis_unproven");
  const proposalHead = f.store.get(proposal.id)!;
  f.store.write({ id: proposalHead.id, kind: proposalHead.kind, expected: proposalHead.revision, value: proposalHead.value });
  const oldGraph = f.store.get(settled.graph.id)!;
  f.store.write({ id: oldGraph.id, kind: oldGraph.kind, expected: oldGraph.revision, value: oldGraph.value });
  const snapshot = revisions(f.store);
  assert.deepEqual(delivered(readLayerAcceptance(f.store, source)), result);
  f.reopen();
  assert.deepEqual(delivered(readLayerAcceptance(f.store, source)), result);
  assert.deepEqual(revisions(f.store), snapshot);
  for (const error of [new TypeError("OM reader failure"), new EngineError("record_corrupt", "OM reader corruption")]) {
    const get = f.store.get.bind(f.store);
    try {
      f.store.get = ((id: string, revision?: number) => { if (id === settled.frame!.id) throw error; return get(id, revision); }) as Store['get'];
      assert.throws(() => readLayerAcceptance(f.store, source), actual => actual === error);
    } finally { f.store.get = get; }
  }
});


async function nativeRebaseFixture(t: test.TestContext, forgedRetired = false) {
  const { f, request: horizonRequest, horizon } = await fixture(t);
  const original = frameRequest(f, reference(horizon.gate), 3);
  const nativeFrame = f.store.get<import('../src/om/layer-basis.js').OmAcceptedFrame>(original.frame!.id)!;
  const frame = forgedRetired ? f.store.write({ id: nativeFrame.id, kind: nativeFrame.kind, expected: nativeFrame.revision,
    value: { ...nativeFrame.value, retired: [nativeFrame.value.fills[0]!], rebase: {} } }) : nativeFrame;
  const from = { ...original, frame: reference(frame) };
  delivered(readFrame(f.store, from));
  const written = delivered(writeCandidate(f.store, { frame: frameRequest(f, reference(horizon.gate), 2), proposals: [] }));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") assert.fail("The native fixture must produce an operation candidate");
  const candidate = reference(written.record);
  const accepted = delivered(settleCandidate(f.store, { project: f.project, level: 2, candidate,
    outcome: { gate: "G3", candidate, graphHash: written.record.value.graphHash, passed: true, codes: [] } }));
  assert.ok(accepted.graph && accepted.layer && accepted.frame);
  const currentHorizon = delivered(writeHorizon(f.store, { ...horizonRequest, graph: reference(accepted.graph), refinement: reference(accepted.layer),
    choice: { ...horizonRequest.choice, choiceVersion: "rebase-retired-injection" } }));
  const to: FrameRequest = { project: f.project, level: 3, graph: reference(accepted.graph), horizon: reference(currentHorizon.gate),
    layer: null, frame: null, upper: { horizon: reference(currentHorizon.gate), frame: reference(accepted.frame) },
    workZoneContract: "accepted-l2-v1" };
  return { f, from, to, accepted };
}

test("a native frame cannot smuggle retired history into an otherwise lawful OM rebase", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const { f, from, to } = await nativeRebaseFixture(t, true);
  // The frame's current correspondence is valid; the forged extra history is not a native producer fact.
  const before = revisions(f.store);
  const refused = refusedAs(readRebaseBasis(f.store, { from, to }), "layer_basis_unproven");
  assert.equal(refused.at.field, "rebase.retired");
  assert.deepEqual(revisions(f.store), before);
});

test("the rebase layer builder rejects forged graph hashes and malformed or noncanonical carried and retired fills", async t => {
  const { f, from, to, accepted } = await nativeRebaseFixture(t);
  const basis = delivered(readRebaseBasis(f.store, { from, to }));
  const frame = clone(basis.frame) as OmRebasedFrame;
  const request: RebasedLayerRequest = { frame,
    reference: { id: from.frame!.id, revision: from.frame!.revision + 1, hash: hashJson(frame) },
    graph: accepted.graph!.value as Graph, upper: accepted.layer as Revision<LayerBasis>,
    previous: f.store.get<LayerBasis>(from.layer!.id, from.layer!.revision)! };
  const before = revisions(f.store), layer = buildRebasedLayer(request);
  assert.equal(layer.layerProofs!.find(proof => proof.level === 3)!.hash, frame.layerHash);
  assert.ok(Object.isFrozen(layer) && Object.isFrozen(layer.layerProofs));
  const rejects = (changed: unknown) => assert.throws(() => buildRebasedLayer({ ...request,
    frame: changed as OmRebasedFrame, reference: { ...request.reference, hash: hashJson(changed) } }), malformed);
  for (const field of ["layerHash", "upperHash", "lowerHash"] as const) rejects({ ...frame, [field]: "0".repeat(64) });
  for (const worksContract of [null, "", "works-frame/v2", "research"])
    rejects({ ...frame, worksContract });
  const { worksContract: _dropped, ...withoutWorksContract } = frame;
  rejects(withoutWorksContract);
  assert.ok(frame.fills.length > 1);
  for (const field of ["fills", "retired"] as const) {
    for (const value of [null, {}, [null], [{ ...frame.fills[0], source: "proposed" }],
      [{ ...frame.fills[0], port: 7 }], [...frame.fills].reverse()]) rejects({ ...frame, [field]: value });
    for (const missing of ["obligation", "node", "source", "basis"] as const) {
      const row = clone(frame.fills[0]) as unknown as Record<string, unknown>;
      delete row[missing]; rejects({ ...frame, [field]: [row] });
    }
    const changed = { ...frame, [field]: clone(frame.fills) };
    assert.deepEqual(buildRebasedLayer({ ...request, frame: changed,
      reference: { ...request.reference, hash: hashJson(changed) } }).projection, layer.projection);
  }
  assert.deepEqual(revisions(f.store), before);
});

test("a claimed G5 work acceptance never falls back to the native or rebase producer", { todo: "NR1 №3646: согласованная перезапись цепочки до новейшей записи — om-fsck её не видит; решение позже" }, async t => {
  const { f, from, to, accepted } = await nativeRebaseFixture(t);
  const basis = delivered(readRebaseBasis(f.store, { from, to }));
  for (const worksContract of [undefined, "works-frame/v2", "works-frame/v1"]) {
    const frame = { ...clone(basis.frame), ...(worksContract === undefined ? {} : { worksContract }), acceptance: {
      producer: "om", candidate: accepted.frame!.value.acceptance.candidate,
      gate: { name: "G5", passed: true, candidate: accepted.frame!.value.acceptance.candidate,
        graphHash: to.graph.hash, findings: [], codes: [] }, graph: to.graph, upper: basis.upper,
    } };
    const frameRow = f.store.write({ id: from.frame!.id, kind: "connection-frame", expected: f.store.get(from.frame!.id)!.revision, value: frame });
    const layer = buildRebasedLayer({ frame: basis.frame as OmRebasedFrame,
      reference: { id: from.frame!.id, revision: from.frame!.revision + 1, hash: hashJson(basis.frame) },
      graph: accepted.graph!.value as Graph, upper: accepted.layer as Revision<LayerBasis>,
      previous: f.store.get<LayerBasis>(from.layer!.id, from.layer!.revision)! });
    const frameRef = reference(frameRow);
    const refs = (items: readonly Ref[]) => items.map(ref => ref.id === frameRef.id ? frameRef : ref)
      .sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
    const layerRow = f.store.write({ id: from.layer!.id, kind: "graph-layer", expected: f.store.get(from.layer!.id)!.revision,
      value: { ...layer, acceptance: { producer: "om", frame: frameRef },
        layerProofs: layer.layerProofs!.map(proof => proof.level === 3
          ? { ...proof, inputs: refs(proof.inputs) } : proof), inputs: refs(layer.inputs) } });
    const before = revisions(f.store);
    const refusal = refusedAs(readLayerAcceptance(f.store, { project: f.project, level: 3, graph: to.graph, layer: reference(layerRow) }), "layer_basis_unproven");
    assert.equal(refusal.at.field, "acceptance.contract");
    assert.deepEqual(revisions(f.store), before);
  }
});

// ── D8.4.2 (договор №2230): proveLayer идёт через общий читатель (ветка gate) — повреждение отвергается ──

test("D8.4.2: a damaged assessment inside the layer's saved proof refuses the historical read, and restoring it reads again", { todo: "NR1 №3591/№3646: записанное читается доверенно; эту порчу базы ловит om-fsck на старте (test/om-fsck.test.ts)" }, async t => {
  const { f } = await fixture(t);
  const request = basisRequest(f, 2);
  const baseline = delivered(readLayerBasis(f.store, request));
  const assessment = baseline.references.find(ref => ref.id.startsWith("research-assessment:"))!;
  const saved = f.store.get<ResearchAssessment>(assessment.id, assessment.revision)!;
  const damaged = { ...saved.value, verdict: "insufficient" as const };
  const raw = new DatabaseSync(join(f.root, "state.sqlite"));
  try {
    raw.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?")
      .run(canonical(damaged), hashJson(damaged), assessment.id, assessment.revision);
  } finally { raw.close(); }
  // PF4 (№3499, №3533): a saved check is trusted after a restart and an in-place change of an immutable revision is no
  // event, so the damage is simulated together with the cache — the history itself is read cold.
  f.store.close(); removeProofCache(join(f.root, "state.sqlite"));
  f.reopen();
  refusedAs(readLayerBasis(f.store, request), "layer_basis_unproven");
  const raw2 = new DatabaseSync(join(f.root, "state.sqlite"));
  try {
    raw2.exec("DROP TRIGGER IF EXISTS revisions_no_update");
    raw2.prepare("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=?")
      .run(canonical(saved.value), hashJson(saved.value), assessment.id, assessment.revision);
  } finally { raw2.close(); }
  f.store.close(); removeProofCache(join(f.root, "state.sqlite"));
  f.reopen();
  assert.deepEqual(delivered(readLayerBasis(f.store, request)).references, baseline.references);
});
