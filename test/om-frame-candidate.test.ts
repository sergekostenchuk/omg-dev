import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson } from "../src/canonical.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { EngineError } from "../src/errors.js";
import { type Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { validateGraph } from "../src/graph/validate.js";
import { reference, type Finding, type Ref } from "../src/pipeline/contracts.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store } from "../src/storage/store.js";
import { fillObligations, prepareFrame, readFrame, type FrameRead, type FrameRequest, type FrameScope, type ConnectionFrame } from "../src/om/frame-obligations.js";
import { type LayerProposal, type ProposalObservation, type ProposalRequest } from "../src/om/frame-proposals.js";
import { assembleCandidate, observeCandidate, prepareCandidate, writeCandidate, readCandidate, gateCandidate,
  CANDIDATE_REFUSAL_CODES, type FrameCandidateRecord } from "../src/om/frame-candidate.js";
import { writeHorizon } from "../src/om/horizon.js";
import { writeOmInput } from "../src/om/input.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult } from "../src/om/refusal.js";
import { gardenGraph, createOmFixture, type OmFixture } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";
import { answerLayerFixture } from "./layer-design-fixture.js";

const clone = structuredClone;
const fakeRef = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const graphRef = (graph: Graph): Ref => ({ id: "graph:garden", revision: 1, hash: hashJson(graph) });
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function delivered<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refusedAs(result: OmResult<unknown>, code: string) {
  if (result.ok) assert.fail(`Expected ${code}, received success`);
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target.length > 0);
  assert.ok(result.refusal.at.field || result.refusal.at.ref);
  assert.ok(["producer", "gap", "owner", "readiness"].includes(result.refusal.route));
  return result.refusal;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "candidate_request_invalid");
  return true;
}
function projection(graph: Graph, level: 1 | 2): Graph {
  const { level: _level, ...value } = projectGraph(graph, level);
  return value as Graph;
}
function scope(nodes: string[]): FrameScope {
  return { nodes, excluded: [], hash: hashJson({ nodes: [...nodes].sort(), excluded: [] }) };
}
function pureFrame(graph: Graph, accepted = false, selected?: string[]): FrameRead {
  const upper = projection(graph, 1), upperRef = fakeRef("graph-layer:garden:1");
  const horizon = scope(selected ?? upper.nodes.filter(node => node.kind === "block").map(node => node.id));
  const base = accepted ? graph : upper;
  const request: FrameRequest = { project: "garden", level: 2, horizon: fakeRef("om-horizon:garden:choice"),
    graph: graphRef(base), layer: accepted ? fakeRef("graph-layer:garden:2") : null, frame: null, upper: null };
  const acceptedLayer = accepted ? { graph, reference: request.graph, frame: null } : null;
  return { request, upper, upperRef, scope: horizon, accepted: acceptedLayer,
    result: clone(delivered(fillObligations(upper, horizon, acceptedLayer, upperRef, 2))) as FrameRead["result"],
    references: [upperRef, request.graph, request.horizon] };
}
function observe(value: LayerProposal, id = "one"): ProposalObservation {
  return { reference: { id: `om-proposal:garden:${id}`, revision: 1, hash: hashJson(value) }, value };
}
function emptyProposal(frame: FrameRead, id = "empty"): ProposalObservation {
  return observe({ base: { graph: frame.request.graph, frame: frame.request.frame }, level: frame.request.level,
    source: "decision", status: "proposed", nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [],
    joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] }, id);
}
function proposalFor(frame: FrameRead, graph: Graph, id = "one"): ProposalObservation {
  const projected = projectGraph(graph, 2);
  const filled = delivered(fillObligations(frame.upper, frame.scope,
    { graph, reference: graphRef(graph), frame: null }, frame.upperRef, 2));
  const value: LayerProposal = { base: { graph: frame.request.graph, frame: frame.request.frame }, level: 2,
    source: "decision", status: "proposed", nodes: clone(projected.nodes.filter(node => node.kind === "operation")),
    fills: filled.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: clone(projected.connectors.map(connector => ({ ...connector,
      bindings: connector.bindings.filter(binding => binding.level === 2) })).filter(connector => connector.bindings.length > 0)),
    artifacts: clone(projected.artifacts), contracts: clone(projected.contracts), joins: clone(projected.joins),
    tests: clone(projected.tests), edges: clone(projected.edges ?? []), journeys: clone(projected.journeys ?? []),
    packets: clone(projected.packets ?? []), transfers: clone(projected.transfers ?? []), anchors: clone(projected.anchors),
    removes: [], replaces: [], redefines: [] };
  return observe(value, id);
}
function acceptedHorizon(store: Store, refinement: Ref | null) {
  const input = delivered(writeOmInput(store, { project: "garden", expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  return delivered(writeHorizon(store, { project: "garden", input: reference(input), graph: reference(store.get("graph:garden")!),
    refinement, choice: { choiceVersion: "candidate-choice", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
}
function acceptedRequest(f: OmFixture): FrameRequest {
  const horizon = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
  return { project: "garden", level: 2, horizon: reference(horizon.gate), graph: reference(f.graphRevision),
    layer: reference(f.layers[2]), frame: null, upper: null };
}
function put(store: Store, proposal: ProposalObservation): Ref {
  return reference(store.write({ id: proposal.reference.id, kind: "layer-proposal", expected: 0, value: proposal.value }));
}
function firstPass(t: TestContext, variant: "standard" | "cross" = "standard") {
  const root = mkdtempSync(join(tmpdir(), "omg-first-candidate-")), database = join(root, "state.sqlite");
  const store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(variant);
  preparedFeatures(new ProductEngine(store), "garden", projection(graph, 1));
  const horizon = acceptedHorizon(store, null);
  const frameRequest: FrameRequest = { project: "garden", level: 2, horizon: reference(horizon.gate),
    graph: reference(store.get("graph:garden")!), layer: null, frame: null, upper: null };
  const frame = clone(delivered(prepareFrame(store, frameRequest))) as unknown as FrameRead;
  const proposal = proposalFor(frame, graph), proposalRef = put(store, proposal);
  return { root, database, store, graph, frame, proposal, proposalRef,
    request: { frame: frameRequest, proposals: [proposalRef] } satisfies ProposalRequest };
}

test('candidate observation reads a self-consistent failed assembly without accepting its lost definition', t => {
  const f = firstPass(t), peer = put(f.store, emptyProposal(f.frame, 'observation-peer'));
  f.request.proposals.push(peer);
  const written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const value = clone(written.record.value) as FrameCandidateRecord;
  assert.ok(value.graph.artifacts.some(artifact => artifact.id === 'garden-data'));
  value.graph.artifacts = value.graph.artifacts.filter(artifact => artifact.id !== 'garden-data');
  value.graphHash = hashJson(value.graph); value.layerHash = hashJson(projectGraph(value.graph, 2));
  Object.assign(value.graph, { defines: ['phantom-definition'] }); value.graphHash = hashJson(value.graph);
  const id = `om-candidate:garden:${hashJson([value.graphHash, value.base, value.proposals])}`;
  const record = f.store.write({ id, kind: 'frame-candidate', expected: 0, value });
  const request = { project: 'garden', candidate: reference(record) }, before = revisions(f.store);
  const observed = delivered(observeCandidate(f.store, request));
  assert.deepEqual(observed.sources.frame, value.request.frame);
  assert.deepEqual(observed.sources.proposals.map(canonical), value.request.proposals.map(canonical).sort());
  assert.ok(Object.isFrozen(observed.sources)); assert.ok(Object.isFrozen(observed.sources.frame)); assert.ok(Object.isFrozen(observed.sources.proposals));
  assert.deepEqual(observed.record, record); assert.ok(!observed.definitions.includes('garden-data'));
  assert.ok(!observed.definitions.includes('phantom-definition'));
  assert.ok(observed.definitions.includes('garden-produce-operation'));
  for (const ref of [reference(record), f.proposalRef, peer, f.frame.request.graph, f.frame.request.horizon])
    assert.ok(observed.references.some(item => canonical(item) === canonical(ref)));
  for (const strict of [readCandidate, gateCandidate]) refusedAs(strict(f.store, request), 'candidate_graph_mismatch');
  assert.deepEqual(revisions(f.store), before);
  for (const id of [f.proposalRef.id, 'graph:garden', 'source:garden:brief']) {
    const prior = f.store.get(id)!;
    f.store.write({ id, kind: prior.kind, expected: prior.revision, value: prior.value });
  }
  const reopened = new Store(f.database);
  try { assert.deepEqual(delivered(observeCandidate(reopened, request)), observed); }
  finally { reopened.close(); }
});

test('candidate observation refuses unreadable sections, source-link masquerades and invalid boundaries', t => {
  const f = firstPass(t), written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const original = written.record, request = { project: 'garden', candidate: reference(original) };
  for (const bad of [undefined, null, [], {}, { project: 'garden' }, { ...request, candidate: null }])
    assert.throws(() => observeCandidate(f.store, bad as unknown as typeof request), malformed);
  let index = 0;
  const corrupt = (mutate: (value: FrameCandidateRecord) => void, expected: string) => {
    const value = clone(original.value) as FrameCandidateRecord;
    mutate(value);
    value.graphHash = hashJson(value.graph);
    const id = `om-candidate:garden:${hashJson([value.graphHash, value.base, value.proposals])}`;
    const row = f.store.write({ id: id === original.id || f.store.get(id) ? `${id}-${index++}` : id, kind: 'frame-candidate', expected: 0, value });
    const result = observeCandidate(f.store, { project: 'garden', candidate: reference(row) });
    return refusedAs(result, expected);
  };
  for (const part of ['nodes', 'connectors', 'artifacts', 'contracts', 'anchors', 'joins', 'tests', 'actors', 'requirements', 'edges', 'journeys', 'transfers', 'packets']) {
    const refusal = corrupt(value => { delete (value.graph as unknown as Record<string, unknown>)[part]; }, 'proposal_invalid');
    assert.equal(refusal.at.field, part);
  }
  corrupt(value => { delete (value as unknown as Record<string, unknown>).request; }, 'candidate_graph_mismatch');
  corrupt(value => { value.request.frame = { ...value.request.frame, project: 'foreign' }; }, 'candidate_graph_mismatch');
  corrupt(value => { value.base.graph = { ...value.base.graph, revision: value.base.graph.revision + 1 }; }, 'candidate_graph_mismatch');
  corrupt(value => { value.proposals = []; }, 'candidate_graph_mismatch');
  const wrongKind = f.store.write({ id: `${original.id}-wrong-kind`, kind: 'graph', expected: 0, value: original.value });
  const foreign = f.store.write({ id: original.id.replace(':garden:', ':foreign:'), kind: original.kind, expected: 0, value: original.value });
  for (const ref of [reference(wrongKind), reference(foreign), { ...request.candidate, hash: '0'.repeat(64) }, fakeRef('om-candidate:garden:missing')])
    refusedAs(observeCandidate(f.store, { ...request, candidate: ref }), ref.hash === '0'.repeat(64) ? 'record_forged'
      : ref.id.endsWith(':missing') ? 'record_missing' : 'record_foreign');
  const before = revisions(f.store);
  for (const fault of [new TypeError('candidate observation failure'), new EngineError('record_corrupt', 'corrupt source')]) {
    const get = f.store.get.bind(f.store);
    try {
      f.store.get = ((id: string, revision?: number) => { if (id === f.proposalRef.id) throw fault; return get(id, revision); }) as Store['get'];
      assert.throws(() => observeCandidate(f.store, request), error => error === fault);
    } finally { f.store.get = get; }
  }
  assert.deepEqual(revisions(f.store), before);
});

// The expected lower bindings are taken from the graph supplied by the proposal, independently of candidate assembly.
test("candidate assembly preserves separate cross-flows and every consumer, including legal consumer multiplicity", () => {
  const graph = gardenGraph("cross"), frame = pureFrame(graph), proposal = proposalFor(frame, graph);
  const peer = clone(proposal.value.nodes.find(node => node.id === "garden-consume-operation")!);
  peer.id += "-peer"; proposal.value.nodes.push(peer);
  for (const fill of [...proposal.value.fills]) if (fill.node === "garden-consume-operation" && fill.port)
    proposal.value.fills.push({ ...fill, node: peer.id });
  const complete = observe(proposal.value), originalFrame = clone(frame), originalProposal = clone(complete);
  const result = delivered(assembleCandidate(frame, [complete]));
  assert.equal(result.state, "candidate"); if (result.state !== "candidate") return;
  const candidate = result.candidate, flow = candidate.graph.connectors.find(item => item.id === "garden-flow")!;
  const bindings = flow.bindings.filter(binding => binding.level === 2);
  assert.equal(bindings.length, 2);
  const primary = bindings.find(binding => binding.producer.port === "out")!;
  const alternative = bindings.find(binding => binding.producer.port === "out-alt")!;
  assert.deepEqual(primary.consumers.map(endpoint => `${endpoint.node}:${endpoint.port}`).sort(), [
    "garden-consume-operation:in", "garden-consume-operation:in-alt", "garden-consume-operation-peer:in",
    "garden-consume-operation-peer:in-alt", "garden-later-operation:in",
  ].sort());
  assert.deepEqual(alternative.consumers.map(endpoint => `${endpoint.node}:${endpoint.port}`).sort(), [
    "garden-consume-operation:in", "garden-consume-operation-peer:in",
  ].sort());
  assert.deepEqual(projectGraph(candidate.graph as Graph, 1), projectGraph(frame.upper, 1));
  assert.deepEqual(validateGraph(candidate.graph).findings, []);
  assert.equal(candidate.graphHash, hashJson(candidate.graph));
  assert.equal(candidate.layerHash, hashJson(projectGraph(candidate.graph as Graph, 2)));
  assert.deepEqual(candidate.base, { graph: frame.request.graph, frame: null });
  assert.deepEqual(candidate.proposals, [complete.reference]);
  assert.deepEqual(frame, originalFrame); assert.deepEqual(complete, originalProposal);
  assert.ok(Object.isFrozen(candidate) && Object.isFrozen(candidate.graph.nodes) && Object.isFrozen(candidate.fills));
  complete.value.nodes[0]!.title = "caller mutation";
  assert.notEqual(candidate.graph.nodes.find(node => node.id === complete.value.nodes[0]!.id)!.title, "caller mutation");
});

test("accepted complete lower definitions survive and unordered proposal references yield the same candidate", () => {
  const graph = projection(gardenGraph("cross"), 2), frame = pureFrame(graph, true);
  const one = emptyProposal(frame, "one"), two = emptyProposal(frame, "two");
  const forward = delivered(assembleCandidate(frame, [one, two])), reverse = delivered(assembleCandidate(frame, [two, one]));
  assert.deepEqual(reverse, forward);
  assert.equal(forward.state, "candidate"); if (forward.state !== "candidate") return;
  const candidate = forward.candidate;
  for (const field of ["nodes", "artifacts", "contracts", "joins", "tests", "edges", "journeys", "packets", "transfers", "anchors"] as const)
    assert.deepEqual([...candidate.graph[field] ?? []].sort((a, b) => a.id < b.id ? -1 : 1),
      [...graph[field] ?? []].sort((a, b) => a.id < b.id ? -1 : 1), field);
  assert.deepEqual(candidate.graph.connectors.find(item => item.id === "garden-prep-flow"), graph.connectors.find(item => item.id === "garden-prep-flow"));
  assert.ok(candidate.fills.every(fill => fill.source === "accepted"));
  const shifted = clone(frame); shifted.request.graph.revision += 1; shifted.accepted!.reference.revision += 1;
  shifted.result = clone(delivered(fillObligations(shifted.upper, shifted.scope, shifted.accepted, shifted.upperRef, 2))) as FrameRead["result"];
  const next = delivered(assembleCandidate(shifted, []));
  assert.equal(next.state, "candidate"); if (next.state !== "candidate") return;
  assert.equal(next.candidate.graphHash, candidate.graphHash);
  assert.notDeepEqual(next.candidate.base, candidate.base);
});

test("open horizon obligations become addressed gaps; explicit empty proposals are not silently treated as completion", t => {
  const f = firstPass(t), before = revisions(f.store);
  const request = { frame: f.request.frame, proposals: [] };
  const pure = delivered(assembleCandidate(f.frame, []));
  assert.equal(pure.state, "gaps"); if (pure.state !== "gaps") return;
  assert.deepEqual(pure.gaps.map(gap => gap.target).sort(), f.frame.result.open.map(item => item.id).sort());
  assert.ok(pure.gaps.every(gap => gap.field === "fill" && gap.blocking && gap.kind === "design-decision"));
  const prepared = delivered(prepareCandidate(f.store, request)), written = delivered(writeCandidate(f.store, request));
  assert.equal(prepared.state, "gaps"); assert.equal(written.state, "gaps");
  if (prepared.state === "gaps") { assert.deepEqual(prepared.gaps, pure.gaps); assert.deepEqual(prepared.writes, []); }
  assert.deepEqual(revisions(f.store), before);
  assert.equal(f.store.list("frame-candidate").length, 0);
});

test("first L1-only pass saves exactly one immutable candidate without a preliminary frame or accepted graph mutation", t => {
  const f = firstPass(t, "cross"), before = revisions(f.store);
  const prepared = delivered(prepareCandidate(f.store, f.request));
  assert.equal(prepared.state, "candidate"); if (prepared.state !== "candidate") return;
  assert.equal(prepared.existing, null); assert.equal(prepared.writes.length, 1); assert.equal(prepared.expected.frame, 0);
  assert.deepEqual(revisions(f.store), before);
  const written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const record = written.record, candidate = record.value;
  assert.equal(record.kind, "frame-candidate"); assert.equal(record.revision, 1);
  assert.equal(record.hash, hashJson(record.value));
  assert.equal(record.id, `om-candidate:garden:${hashJson([candidate.graphHash, candidate.base, candidate.proposals])}`);
  assert.deepEqual(candidate.request, f.request);
  assert.deepEqual(candidate.base, { graph: f.request.frame.graph, frame: null });
  assert.deepEqual(candidate.proposals, [f.proposalRef]);
  assert.equal(candidate.graphHash, hashJson(candidate.graph));
  assert.deepEqual(validateGraph(candidate.graph).findings, []);
  assert.deepEqual(revisions(f.store).filter(item => item.head.id !== record.id), before);
  assert.equal(f.store.get("om-frame:garden:2"), null);
  assert.equal(f.store.get<LayerProposal>(f.proposalRef.id)!.value.status, "proposed");
  assert.equal(f.store.list("frame-candidate").length, 1);
  assert.deepEqual(delivered(readCandidate(f.store, { project: "garden", candidate: reference(record) })), record);
  assert.deepEqual(delivered(gateCandidate(f.store, { project: "garden", candidate: reference(record) })),
    { passed: true, candidate: reference(record), graphHash: candidate.graphHash, findings: [] });
  const after = revisions(f.store), repeated = delivered(writeCandidate(f.store, f.request));
  assert.deepEqual(repeated, written); assert.deepEqual(revisions(f.store), after);
  const existing = delivered(prepareCandidate(f.store, f.request));
  assert.equal(existing.state, "candidate"); if (existing.state !== "candidate") return;
  assert.deepEqual(existing.existing, record); assert.deepEqual(existing.writes, []);
  assert.ok(existing.guards.some(ref => canonical(ref) === canonical(f.proposalRef)));
  assert.ok(Object.isFrozen(record.value.graph.nodes));
});

test("G3 reads only the candidate record and rejects even an identical adjacent graph", t => {
  const f = firstPass(t), written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const request = { project: "garden", candidate: reference(written.record) }, before = revisions(f.store);
  for (const graph of [clone(written.record.value.graph), gardenGraph(), null, {}, undefined]) {
    refusedAs(gateCandidate(f.store, { ...request, graph }), "candidate_graph_mismatch");
  }
  assert.equal(delivered(gateCandidate(f.store, request)).passed, true);
  assert.deepEqual(revisions(f.store), before);
});

test("a changed graph with recomputed hashes and candidate ID is rejected by rederiving exact source records", t => {
  const f = firstPass(t), written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const value = clone(written.record.value) as FrameCandidateRecord;
  value.graph.nodes.find(node => node.kind === "operation")!.title = "Not in the approved proposal";
  value.graphHash = hashJson(value.graph); value.layerHash = hashJson(projectGraph(value.graph, 2));
  const id = `om-candidate:garden:${hashJson([value.graphHash, value.base, value.proposals])}`;
  const forged = f.store.write({ id, kind: "frame-candidate", expected: 0, value });
  const before = revisions(f.store), request = { project: "garden", candidate: reference(forged) };
  refusedAs(readCandidate(f.store, request), "candidate_graph_mismatch");
  refusedAs(gateCandidate(f.store, request), "candidate_graph_mismatch");
  assert.deepEqual(revisions(f.store), before);
});

test("all current acceptance dependencies guard new and existing candidates against a concurrent neighbor write", async t => {
  const f = firstPass(t), source = reference(f.store.get("source:garden:brief")!);
  for (const existing of [false, true]) {
    if (existing) delivered(writeCandidate(f.store, f.request));
    const prepared = delivered(prepareCandidate(f.store, f.request));
    assert.equal(prepared.state, "candidate"); if (prepared.state !== "candidate") return;
    assert.equal(prepared.writes.length, existing ? 0 : 1);
    const dependencies = [f.request.frame.graph, f.proposalRef, source, reference(f.store.get("graph-layer:garden:2")!)];
    const snapshot = await f.store.snapshot(join(f.root, `candidate-guards-${existing}`));
    for (const [index, dependency] of dependencies.entries()) {
      assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(dependency)), dependency.id);
      const path = join(f.root, `candidate-guard-${existing}-${index}.sqlite`); copyFileSync(snapshot.path, path);
      const store = new Store(path);
      try {
        const old = store.get(dependency.id)!;
        store.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
        const before = revisions(store);
        refusedAs(writeGuarded(store, { unit: "C5", target: "neighbor:garden", guards: prepared.guards,
          writes: [...prepared.writes, { id: "neighbor:garden", kind: "neighbor", expected: 0, value: { candidate: prepared.candidate.graphHash } }] }), "input_stale");
        assert.equal(store.get("neighbor:garden"), null);
        assert.deepEqual(revisions(store), before);
        if (dependency.id !== "graph-layer:garden:2") {
          assert.ok(!prepareCandidate(store, f.request).ok);
          assert.ok(!writeCandidate(store, f.request).ok);
          assert.deepEqual(revisions(store), before);
        }
      } finally { store.close(); }
    }
  }
});

test("historical candidates survive changed heads and reopening while fresh preparation refuses stale sources", t => {
  const f = firstPass(t), written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const request = { project: "garden", candidate: reference(written.record) };
  for (const id of ["source:garden:brief", f.proposalRef.id, f.request.frame.graph.id]) {
    const old = f.store.get(id)!;
    f.store.write({ id, kind: old.kind, expected: old.revision, value: old.value });
  }
  const before = revisions(f.store);
  assert.deepEqual(delivered(readCandidate(f.store, request)), written.record);
  assert.equal(delivered(gateCandidate(f.store, request)).passed, true);
  assert.ok(!prepareCandidate(f.store, f.request).ok);
  assert.ok(!writeCandidate(f.store, f.request).ok);
  assert.deepEqual(revisions(f.store), before);
  const reopened = new Store(f.database);
  try {
    assert.deepEqual(delivered(readCandidate(reopened, request)), written.record);
    assert.equal(delivered(gateCandidate(reopened, request)).passed, true);
    assert.deepEqual(revisions(reopened), before);
  } finally { reopened.close(); }
});

test("current accepted fixtures preserve their exact bases and return accepted fills without rewriting neighbors", async t => {
  const f = await createOmFixture(t, "cross"), frameRequest = acceptedRequest(f), frame = clone(delivered(readFrame(f.store, frameRequest))) as FrameRead;
  const proposal = emptyProposal(frame, "accepted-base"), proposalRef = put(f.store, proposal), request = { frame: frameRequest, proposals: [proposalRef] };
  const before = revisions(f.store), written = delivered(writeCandidate(f.store, request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const value = written.record.value;
  assert.deepEqual(value.base, { graph: frameRequest.graph, frame: null });
  assert.ok(value.fills.every(fill => fill.source === "accepted"));
  assert.deepEqual(projectGraph(value.graph as Graph, 2), projectGraph(f.graph, 2));
  assert.deepEqual(revisions(f.store).filter(item => item.head.id !== written.record.id), before);
  assert.equal(delivered(gateCandidate(f.store, { project: "garden", candidate: reference(written.record) })).passed, true);
});

test("replacement requires explicit redefinition and cannot leave a local connector pointing at a removed node", () => {
  const graph = projection(gardenGraph(), 2), frame = pureFrame(graph, true);
  const proposal = emptyProposal(frame, "replace-prep"), old = "garden-prep-operation", replacement = "garden-prep-operation-new";
  const node = clone(graph.nodes.find(item => item.id === old)!); node.id = replacement;
  proposal.value.nodes = [node]; proposal.value.removes = [old];
  refusedAs(assembleCandidate(frame, [observe(proposal.value)]), "replacement_leaves_dangling");
  const connector = clone(graph.connectors.find(item => item.id === "garden-prep-flow")!);
  connector.bindings[0]!.producer.node = replacement;
  proposal.value.localConnectors = [connector];
  refusedAs(assembleCandidate(frame, [observe(proposal.value)]), "replacement_leaves_dangling");
  proposal.value.redefines = [connector.id];
  const complete = delivered(assembleCandidate(frame, [observe(proposal.value)]));
  assert.equal(complete.state, "candidate"); if (complete.state !== "candidate") return;
  assert.ok(!complete.candidate.graph.nodes.some(item => item.id === old));
  assert.ok(complete.candidate.graph.nodes.some(item => item.id === replacement));
  assert.equal(complete.candidate.graph.connectors.find(item => item.id === connector.id)!.bindings[0]!.producer.node, replacement);
  assert.deepEqual(validateGraph(complete.candidate.graph).findings, []);
});

test("unbound operation input ports are refused and graph semantic findings keep code, target and message", () => {
  const graph = gardenGraph(), frame = pureFrame(graph), initial = proposalFor(frame, graph);
  const unbound = clone(initial.value);
  unbound.nodes.find(node => node.id === "garden-consume-operation")!.ports.push({ id: "missing-input", direction: "in", contract: "garden-contract" });
  const portFailure = refusedAs(assembleCandidate(frame, [observe(unbound)]), "operation_port_unbound");
  assert.match(canonical(portFailure), /garden-consume-operation/);
  const semantic = clone(initial.value);
  semantic.nodes.find(node => node.id === "garden-consume-operation")!.implements = [];
  const result = assembleCandidate(frame, [observe(semantic)]), refusal = refusedAs(result, "graph_invalid");
  const findings = (refusal as typeof refusal & { findings: readonly Finding[] }).findings;
  assert.ok(Array.isArray(findings));
  const finding = findings.find(item => item.code === "node_benefit_unbound");
  assert.ok(finding); assert.equal(finding.target, "garden-consume-operation"); assert.ok(finding.message.length > 0);
  assert.ok(Object.isFrozen(findings) && Object.isFrozen(finding));
});

test("N3 is an explicit unsupported contract on assembly and storage paths, never a partial candidate", t => {
  const f = firstPass(t), level3 = clone(f.frame); level3.request.level = 3;
  refusedAs(assembleCandidate(level3, []), "candidate_level_unsupported");
  const request = { ...f.request, frame: { ...f.request.frame, level: 3 as const, upper: { horizon: f.request.frame.horizon, frame: null } } }, before = revisions(f.store);
  refusedAs(prepareCandidate(f.store, request), "candidate_level_unsupported");
  refusedAs(writeCandidate(f.store, request), "candidate_level_unsupported");
  assert.deepEqual(revisions(f.store), before);
});

test("candidate boundaries distinguish omitted inputs and exact-record masquerades without swallowing store failures", t => {
  const f = firstPass(t), written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const record = written.record, request = { project: "garden", candidate: reference(record) };
  for (const bad of [undefined, null, [], "request", 17]) {
    assert.throws(() => assembleCandidate(bad as unknown as FrameRead, []), malformed);
    if (!Array.isArray(bad)) assert.throws(() => assembleCandidate(f.frame, bad as unknown as ProposalObservation[]), malformed);
    assert.throws(() => prepareCandidate(f.store, bad as unknown as ProposalRequest), malformed);
    assert.throws(() => writeCandidate(f.store, bad as unknown as ProposalRequest), malformed);
    assert.throws(() => readCandidate(f.store, bad as unknown as typeof request), malformed);
    assert.throws(() => gateCandidate(f.store, bad as unknown as typeof request), malformed);
  }
  for (const action of [prepareCandidate, writeCandidate]) {
    assert.throws(() => action(f.store, { frame: f.request.frame } as ProposalRequest), malformed);
    assert.throws(() => action(f.store, { proposals: [] } as unknown as ProposalRequest), malformed);
  }
  const foreign = f.store.write({ id: record.id.replace(":garden:", ":foreign:"), kind: record.kind, expected: 0, value: record.value });
  const wrongKind = f.store.write({ id: `${record.id}-wrong-kind`, kind: "connection-frame", expected: 0, value: record.value });
  const absent = fakeRef("om-candidate:garden:absent"), before = revisions(f.store);
  for (const action of [readCandidate, gateCandidate]) {
    refusedAs(action(f.store, { ...request, candidate: reference(foreign) }), "record_foreign");
    refusedAs(action(f.store, { ...request, candidate: reference(wrongKind) }), "record_foreign");
    refusedAs(action(f.store, { ...request, candidate: { ...request.candidate, hash: "0".repeat(64) } }), "record_forged");
    refusedAs(action(f.store, { ...request, candidate: absent }), "candidate_missing");
  }
  for (const fault of [new TypeError("candidate storage failure"), new EngineError("record_corrupt", "candidate is corrupt")]) {
    const original = f.store.get.bind(f.store);
    try {
      f.store.get = ((id: string, revision?: number) => {
        if (id === f.proposalRef.id || id === record.id) throw fault;
        return original(id, revision);
      }) as Store["get"];
      for (const action of [prepareCandidate, writeCandidate]) assert.throws(() => action(f.store, f.request), error => error === fault);
      for (const action of [readCandidate, gateCandidate]) assert.throws(() => action(f.store, request), error => error === fault);
    } finally { f.store.get = original; }
  }
  assert.deepEqual(revisions(f.store), before);
  assert.ok(Object.isFrozen(CANDIDATE_REFUSAL_CODES));
});


test("three horizon shapes assemble real and identity operations while identities never close a selected block", () => {
  const graph = gardenGraph(), all = graph.nodes.filter(node => node.kind === "block").map(node => node.id);
  for (const selected of [[], ["garden-produce-block", "garden-consume-block"], all]) {
    const frame = pureFrame(graph, false, selected), proposal = proposalFor(frame, graph);
    proposal.value.nodes = proposal.value.nodes.filter(node => selected.includes(node.parent!));
    const included = new Set(proposal.value.nodes.map(node => node.id));
    proposal.value.fills = proposal.value.fills.filter(fill => included.has(fill.node));
    proposal.value.localConnectors = proposal.value.localConnectors.filter(connector =>
      !frame.upper.connectors.some(upper => upper.id === connector.id));
    const result = delivered(assembleCandidate(frame, selected.length ? [observe(proposal.value)] : []));
    assert.equal(result.state, "candidate"); if (result.state !== "candidate") continue;
    assert.deepEqual(validateGraph(result.candidate.graph).findings, []);
    assert.ok(result.candidate.fills.every(fill => fill.source !== "identity" || !selected.includes(
      frame.result.obligations.find(obligation => obligation.id === fill.obligation)!.upper.node)));
    assert.equal(result.candidate.fills.some(fill => fill.source === "identity"), selected.length < all.length);
    assert.deepEqual(projectGraph(result.candidate.graph as Graph, 1), projectGraph(graph, 1));
  }
});

test("unlisted accepted definitions stay unchanged and conflicting explicit definitions are refused", () => {
  const graph = projection(gardenGraph(), 2), frame = pureFrame(graph, true), proposal = emptyProposal(frame);
  const artifact = clone(graph.artifacts.find(item => item.id === "garden-prep")!);
  artifact.purpose = "A different purpose"; proposal.value.artifacts = [artifact];
  const unchanged = delivered(assembleCandidate(frame, [observe(proposal.value)]));
  assert.equal(unchanged.state, "candidate"); if (unchanged.state !== "candidate") return;
  assert.deepEqual(unchanged.candidate.graph.artifacts.find(item => item.id === artifact.id), graph.artifacts.find(item => item.id === artifact.id));
  proposal.value.redefines = [artifact.id];
  const conflicting = clone(proposal.value); conflicting.artifacts[0]!.purpose = "A conflicting purpose";
  const refusal = refusedAs(assembleCandidate(frame, [observe(proposal.value, "one"), observe(conflicting, "two")]), "derived_field_conflict");
  assert.equal(refusal.at.target, artifact.id);
});


test("distinct upper flows cannot alias one lower producer port after proposal content and exact hashes change together", () => {
  const graph = gardenGraph("cross"), frame = pureFrame(graph), proposal = proposalFor(frame, graph);
  proposal.value.nodes.find(node => node.id === "garden-produce-operation")!.ports =
    proposal.value.nodes.find(node => node.id === "garden-produce-operation")!.ports.filter(port => port.id !== "out-alt");
  const alternate = new Set(frame.result.obligations.filter(obligation => obligation.role === "producer" && obligation.upper.port === "out-alt").map(item => item.id));
  for (const fill of proposal.value.fills) if (alternate.has(fill.obligation)) fill.port = "out";
  refusedAs(assembleCandidate(frame, [observe(proposal.value)]), "slot_fill_conflict");
});

test("native endpoint, join and cycle failures preserve nested findings instead of repairing invalid proposals", () => {
  const graph = gardenGraph(), frame = pureFrame(graph), original = proposalFor(frame, graph);
  const endpoint = clone(original.value);
  endpoint.localConnectors.find(connector => connector.id === "garden-prep-flow")!.bindings[0]!.producer.port = "absent";
  const joinMissing = clone(original.value), prep = joinMissing.localConnectors.find(connector => connector.id === "garden-prep-flow")!;
  joinMissing.localConnectors.push({ ...clone(prep), id: "garden-prep-flow-second" }, { ...clone(prep), id: "garden-prep-flow-third" });
  const cycle = clone(original.value);
  cycle.nodes.find(node => node.id === "garden-prep-operation")!.ports.push({ id: "in", direction: "in", contract: "garden-contract" });
  cycle.localConnectors.push({ id: "garden-local-backedge", artifact: "garden-data", returnsTo: "garden-produce-block", wakeTest: null,
    bindings: [{ level: 2, producer: { node: "garden-produce-operation", port: "out" },
      consumers: [{ node: "garden-prep-operation", port: "in" }], anchor: null }] });
  for (const [code, proposal] of [["endpoint_invalid", endpoint], ["join_missing", joinMissing], ["dependency_cycle", cycle]] as const) {
    const refusal = refusedAs(assembleCandidate(frame, [observe(proposal)]), "graph_invalid");
    const findings = (refusal as typeof refusal & { findings: readonly Finding[] }).findings;
    const finding = findings.find(item => item.code === code);
    assert.ok(finding, `${code}: ${canonical(findings)}`);
    assert.ok(finding.target.length > 0 && finding.message.length > 0);
  }
});

test("N2 cannot introduce future work definitions through accepted full-graph descendants", () => {
  const graph = gardenGraph(), frame = pureFrame(graph, true);
  const laterTest = emptyProposal(frame, "future-test"), authored = clone(graph.tests.find(item => item.node === "garden-produce-work")!);
  authored.id = "new-work-test"; laterTest.value.tests = [authored];
  refusedAs(assembleCandidate(frame, [observe(laterTest.value)]), "candidate_level_unsupported");
  const laterConnector = emptyProposal(frame, "future-connector"), connector = clone(graph.connectors.find(item => item.id === "garden-prep-flow")!);
  connector.id = "new-work-connector"; connector.bindings = connector.bindings.filter(binding => binding.level === 3);
  laterConnector.value.localConnectors = [connector];
  refusedAs(assembleCandidate(frame, [observe(laterConnector.value)]), "candidate_level_unsupported");
  const carried = emptyProposal(frame, "carried-work-definition"); carried.value.tests = [clone(graph.tests[0]!)];
  const unchanged = delivered(assembleCandidate(frame, [observe(carried.value)]));
  assert.equal(unchanged.state, "candidate"); if (unchanged.state !== "candidate") return;
  assert.deepEqual(unchanged.candidate.graph.tests, graph.tests);
  assert.deepEqual(unchanged.candidate.graph.nodes.filter(node => node.kind === "work"), graph.nodes.filter(node => node.kind === "work"));
});

test("fills cannot rely on a realizes edge which assembly must preserve as an accepted non-redefined definition", () => {
  const graph = projection(gardenGraph(), 2), frame = pureFrame(graph, true), proposal = emptyProposal(frame, "ignored-realizes");
  const oldNode = graph.nodes.find(node => node.id === "garden-refusal-operation")!;
  const node = { ...clone(oldNode), id: "garden-new-operation", parent: "garden-produce-block" };
  const obligation = frame.result.obligations.find(item => item.kind === "block-outcome" && item.upper.node === "garden-refusal-block")!;
  proposal.value.nodes = [node]; proposal.value.fills = [{ obligation: obligation.id, node: node.id }];
  proposal.value.replaces = [{ obligation: obligation.id, base: { node: oldNode.id, graph: frame.request.graph },
    with: { node: node.id, port: null }, basis: "Explicit replacement supported by a claimed realizes edge" }];
  proposal.value.edges = [{ id: "garden-invalid-transition", relation: "realizes", source: node.id,
    target: "garden-refusal-block", condition: "refines refusal" }];
  refusedAs(assembleCandidate(frame, [observe(proposal.value)]), "frame_record_invalid");
});

test("writeCandidate itself refuses a dependency change injected at its transactional write boundary", async t => {
  const f = firstPass(t), prepared = delivered(prepareCandidate(f.store, f.request));
  assert.equal(prepared.state, "candidate"); if (prepared.state !== "candidate") return;
  const candidateId = prepared.writes[0]!.id, snapshot = await f.store.snapshot(join(f.root, "candidate-write-race"));
  for (const [index, dependency] of [f.proposalRef.id, "source:garden:brief"].entries()) {
    const path = join(f.root, `candidate-write-race-${index}.sqlite`); copyFileSync(snapshot.path, path);
    const store = new Store(path), original = store.writeMany.bind(store), before = revisions(store);
    const old = store.get(dependency)!;
    let injected = false;
    try {
      store.writeMany = ((writes, guards = []) => {
        if (!injected && writes.some(write => write.kind === "frame-candidate")) {
          injected = true;
          original([{ id: old.id, kind: old.kind, expected: old.revision, value: old.value }]);
        }
        return original(writes, guards);
      }) as Store["writeMany"];
      refusedAs(writeCandidate(store, f.request), "input_stale");
      assert.equal(injected, true); assert.equal(store.get(candidateId), null);
      assert.equal(store.list("frame-candidate").length, 0);
      assert.equal(store.get(dependency)!.revision, old.revision + 1);
      assert.deepEqual(revisions(store).filter(item => item.head.id !== dependency), before.filter(item => item.head.id !== dependency));
      assert.equal(store.get<LayerProposal>(f.proposalRef.id)!.value.status, "proposed");
    } finally { store.writeMany = original; store.close(); }
  }
});

test("historical candidate readers reject missing mandatory fields and forged acceptance at a genuine revision-one ID", async t => {
  const f = firstPass(t), prepared = delivered(prepareCandidate(f.store, f.request));
  assert.equal(prepared.state, "candidate"); if (prepared.state !== "candidate") return;
  const candidateId = prepared.writes[0]!.id, snapshot = await f.store.snapshot(join(f.root, "candidate-record-shapes"));
  const fields = ["project", "level", "graphHash", "layerHash", "upperHash", "graph", "fills", "base", "proposals", "request"] as const;
  const mutations: { name: string; change: (value: Record<string, unknown>) => void }[] = fields.map(field => ({
    name: `missing-${field}`, change: value => { delete value[field]; },
  }));
  mutations.push({ name: "forged-accepted-status", change: value => { value["status"] = "accepted"; } });
  for (const [index, mutation] of mutations.entries()) {
    const path = join(f.root, `candidate-record-shape-${index}.sqlite`); copyFileSync(snapshot.path, path);
    const store = new Store(path);
    try {
      const value = clone(prepared.candidate) as unknown as Record<string, unknown>; mutation.change(value);
      const record = store.write({ id: candidateId, kind: "frame-candidate", expected: 0, value });
      assert.equal(record.revision, 1); assert.equal(record.hash, hashJson(value));
      const before = revisions(store), request = { project: "garden", candidate: reference(record) };
      refusedAs(readCandidate(store, request), "candidate_graph_mismatch");
      refusedAs(gateCandidate(store, request), "candidate_graph_mismatch");
      assert.deepEqual(revisions(store), before, mutation.name);
    } finally { store.close(); }
  }
});

test("accepted and rejected proposal status masquerades are refused by current candidate preparation and writing", async t => {
  const f = firstPass(t), snapshot = await f.store.snapshot(join(f.root, "candidate-proposal-status"));
  for (const status of ["accepted", "rejected"] as const) {
    const path = join(f.root, `candidate-proposal-${status}.sqlite`); copyFileSync(snapshot.path, path);
    const store = new Store(path);
    try {
      const row = store.write({ id: f.proposalRef.id, kind: "layer-proposal", expected: f.proposalRef.revision,
        value: { ...clone(f.proposal.value), status } });
      const request = { frame: f.request.frame, proposals: [reference(row)] }, before = revisions(store);
      refusedAs(prepareCandidate(store, request), "proposal_not_proposed");
      refusedAs(writeCandidate(store, request), "proposal_not_proposed");
      assert.equal(store.list("frame-candidate").length, 0);
      assert.deepEqual(revisions(store), before);
    } finally { store.close(); }
  }
});


test("retiring an accepted identity preserves its dependent join until explicitly redefined", () => {
  const garden = gardenGraph(), outside = pureFrame(garden, false, []);
  const first = delivered(assembleCandidate(outside, []));
  assert.equal(first.state, "candidate"); if (first.state !== "candidate") return;
  const graph = clone(first.candidate.graph) as Graph;
  const identity = graph.nodes.find(node => node.kind === "operation" && node.parent === "garden-consume-block")!;
  const join: Graph["joins"][number] = { id: "accepted-identity-join", consumer: identity.id,
    connectors: ["garden-flow"], required: ["garden-flow"], optional: [], condition: "all required",
    failures: { missing: "missing", extra: "extra", foreign: "foreign", stale: "stale", duplicate: "duplicate", returnsTo: "garden-consume-block" } };
  graph.joins.push(join);
  assert.deepEqual(validateGraph(graph).findings, []);
  const frame = pureFrame(graph, true), mapping: ConnectionFrame = { project: "garden", level: 2,
    candidateHash: hashJson(graph), layerHash: hashJson(projectGraph(graph, 2)),
    fills: first.candidate.fills.map(fill => ({ ...fill, source: fill.source === "proposed" ? "accepted" : fill.source })) };
  const frameRef = { id: "om-frame:garden:2", revision: 1, hash: hashJson(mapping) };
  frame.request.frame = frameRef; frame.accepted!.frame = { reference: frameRef, value: mapping };
  frame.result = clone(delivered(fillObligations(frame.upper, frame.scope, frame.accepted, frame.upperRef, 2))) as FrameRead["result"];
  const proposal = proposalFor(frame, garden);
  const refusal = refusedAs(assembleCandidate(frame, [proposal]), "replacement_leaves_dangling");
  assert.match(canonical(refusal), /accepted-identity-join/);
  proposal.value.joins.push({ ...join, consumer: "garden-consume-operation" });
  proposal.value.redefines.push(join.id);
  const replacement = delivered(assembleCandidate(frame, [observe(proposal.value)]));
  assert.equal(replacement.state, "candidate"); if (replacement.state !== "candidate") return;
  assert.equal(replacement.candidate.graph.joins.find(item => item.id === join.id)!.consumer, "garden-consume-operation");
  assert.ok(!replacement.candidate.graph.nodes.some(node => node.id === identity.id));
});

function renameOperationPort(frame: FrameRead, graph: Graph, connectorId: string, includeOtherLevels: boolean, id: string): ProposalObservation {
  const proposal = emptyProposal(frame, id), connector = clone(graph.connectors.find(item => item.id === connectorId)!);
  const binding = connector.bindings.find(item => item.level === 2)!, node = clone(graph.nodes.find(item => item.id === binding.producer.node)!);
  const oldPort = binding.producer.port, renamed = `${oldPort}-renamed`;
  node.ports.find(port => port.id === oldPort)!.id = renamed;
  binding.producer.port = renamed;
  if (!includeOtherLevels) connector.bindings = connector.bindings.filter(item => item.level === 2);
  proposal.value.nodes = [node]; proposal.value.removes = [node.id];
  proposal.value.localConnectors = [connector]; proposal.value.redefines = [connectorId];
  for (const fill of frame.result.fills.filter(item => item.node === node.id)) {
    const port = fill.port === oldPort ? renamed : fill.port;
    proposal.value.fills.push({ obligation: fill.obligation, node: node.id, ...(port === undefined ? {} : { port }) });
    proposal.value.replaces.push({ obligation: fill.obligation, base: { node: node.id, graph: frame.request.graph },
      with: { node: node.id, port: port ?? null }, basis: "Rename the operation port while retaining its accepted work realization" });
  }
  return observe(proposal.value, id);
}
function assertAcceptedWorksUnchanged(before: Graph, after: Graph): void {
  assert.deepEqual(after.nodes.filter(node => node.kind === "work"), before.nodes.filter(node => node.kind === "work"));
  assert.deepEqual(after.horizon, before.horizon);
  assert.deepEqual(after.researchObligations, before.researchObligations);
  for (const part of ["artifacts", "contracts", "anchors", "joins", "tests", "edges", "journeys", "transfers", "packets"] as const)
    assert.deepEqual(after[part], before[part], part);
  assert.deepEqual(after.connectors.map(connector => connector.id).sort(), before.connectors.map(connector => connector.id).sort());
  for (const connector of before.connectors) {
    const actual = after.connectors.find(item => item.id === connector.id)!;
    assert.equal(canonical(actual.bindings.filter(binding => binding.level === 3)),
      canonical(connector.bindings.filter(binding => binding.level === 3)), `${connector.id}: accepted L3 bytes`);
    assert.deepEqual(actual.bindings.filter(binding => binding.level === 1), connector.bindings.filter(binding => binding.level === 1));
    const { bindings: _priorBindings, ...priorDefinition } = connector;
    const { bindings: _nextBindings, ...nextDefinition } = actual;
    assert.deepEqual(nextDefinition, priorDefinition, `${connector.id}: shared definition`);
  }
}

test("accepted L3 survives real L2 port changes in local and inherited connectors with full or L2-only proposals", async t => {
  const f = await createOmFixture(t), frameRequest = acceptedRequest(f), frame = clone(delivered(readFrame(f.store, frameRequest))) as FrameRead;
  for (const connectorId of ["garden-prep-flow", "garden-flow"]) for (const includeOtherLevels of [true, false]) {
    const proposal = renameOperationPort(frame, f.graph, connectorId, includeOtherLevels, `preserve-${connectorId}-${includeOtherLevels}`);
    const proposalRef = put(f.store, proposal), request = { frame: frameRequest, proposals: [proposalRef] }, before = revisions(f.store);
    const prepared = delivered(prepareCandidate(f.store, request));
    assert.equal(prepared.state, "candidate"); if (prepared.state !== "candidate") continue;
    assertAcceptedWorksUnchanged(f.graph, prepared.candidate.graph as Graph);
    assert.deepEqual(revisions(f.store), before);
    const written = delivered(writeCandidate(f.store, request));
    assert.equal(written.state, "candidate"); if (written.state !== "candidate") continue;
    const graph = written.record.value.graph as Graph, actual = graph.connectors.find(item => item.id === connectorId)!;
    assertAcceptedWorksUnchanged(f.graph, graph);
    assert.equal(actual.bindings.find(binding => binding.level === 2)!.producer.port, "out-renamed");
    assert.deepEqual(actual.bindings.map(binding => binding.level).sort(), f.graph.connectors.find(item => item.id === connectorId)!.bindings.map(binding => binding.level).sort());
    assert.deepEqual(validateGraph(graph).findings, []);
    const saved = { project: "garden", candidate: reference(written.record) };
    assert.deepEqual(delivered(readCandidate(f.store, saved)), written.record);
    assert.equal(delivered(gateCandidate(f.store, saved)).passed, true);
    assert.deepEqual(revisions(f.store).filter(item => item.head.id !== written.record.id), before);
    assert.equal(f.store.get<LayerProposal>(proposalRef.id)!.value.status, "proposed");
  }
});

test("explicit changes and partial deletion of accepted L3 bindings are refused through candidate prepare and write", async t => {
  const f = await createOmFixture(t, "cross"), frameRequest = acceptedRequest(f), frame = clone(delivered(readFrame(f.store, frameRequest))) as FrameRead;
  const mutations = [
    { id: "local-work-port", connector: "garden-prep-flow", change: (connector: Graph["connectors"][number]) => {
      connector.bindings.find(binding => binding.level === 3)!.producer.port = "changed-work-port";
    } },
    { id: "inherited-work-port", connector: "garden-flow", change: (connector: Graph["connectors"][number]) => {
      connector.bindings.find(binding => binding.level === 3)!.producer.port = "changed-work-port";
    } },
    { id: "deleted-inherited-work-binding", connector: "garden-flow", change: (connector: Graph["connectors"][number]) => {
      const index = connector.bindings.findIndex(binding => binding.level === 3);
      assert.ok(connector.bindings.filter(binding => binding.level === 3).length > 1);
      connector.bindings.splice(index, 1);
    } },
    { id: "deleted-inherited-work-consumer", connector: "garden-flow", change: (connector: Graph["connectors"][number]) => {
      const binding = connector.bindings.find(item => item.level === 3 && item.consumers.length > 1)!;
      assert.ok(binding); binding.consumers.pop();
    } },
  ];
  for (const mutation of mutations) {
    const proposal = renameOperationPort(frame, f.graph, mutation.connector, true, mutation.id);
    mutation.change(proposal.value.localConnectors[0]!);
    const proposalRef = put(f.store, observe(proposal.value, mutation.id)), request = { frame: frameRequest, proposals: [proposalRef] };
    const before = revisions(f.store);
    for (const action of [prepareCandidate, writeCandidate]) {
      const refusal = refusedAs(action(f.store, request), "candidate_level_unsupported");
      assert.equal(refusal.at.target, mutation.connector);
    }
    assert.deepEqual(revisions(f.store), before);
    assert.equal(f.store.list("frame-candidate").length, 0);
  }
});

test("redefines cannot erase a prior work reference by moving accepted tests or anchors to operations", async t => {
  const f = await createOmFixture(t), frameRequest = acceptedRequest(f), frame = clone(delivered(readFrame(f.store, frameRequest))) as FrameRead;
  const workTest = clone(f.graph.tests.find(item => item.node === "garden-produce-work")!);
  workTest.node = "garden-produce-operation";
  const workAnchor = clone(f.graph.anchors.find(item => item.owner === "garden-produce-work")!);
  workAnchor.owner = "garden-produce-operation";
  for (const part of ["tests", "anchors"] as const) {
    const proposal = emptyProposal(frame, `erase-work-${part}`);
    if (part === "tests") proposal.value.tests = [workTest]; else proposal.value.anchors = [workAnchor];
    const id = part === "tests" ? workTest.id : workAnchor.id;
    proposal.value.redefines = [id];
    const proposalRef = put(f.store, observe(proposal.value, `erase-work-${part}`)), request = { frame: frameRequest, proposals: [proposalRef] };
    const before = revisions(f.store);
    for (const action of [prepareCandidate, writeCandidate]) {
      const refusal = refusedAs(action(f.store, request), "candidate_level_unsupported");
      assert.equal(refusal.at.target, id);
    }
    assert.deepEqual(revisions(f.store), before);
    assert.equal(f.store.list("frame-candidate").length, 0);
  }
});

function acceptResearchedWorks(f: OmFixture, graph: Graph): { graph: Graph; request: FrameRequest; frame: FrameRead } {
  const prior = f.store.get<Graph>("graph:garden")!;
  assert.deepEqual(projectGraph(graph, 2), projectGraph(prior.value, 2));
  assert.deepEqual(validateGraph(graph).findings, []);
  const draft = f.engine.refinement.prepareLayer("garden", 3);
  const answered = answerLayerFixture(f.engine, "garden", draft, 3, graph);
  const built = f.engine.refinement.buildLayer("garden", 3, reference(answered), prior.revision, "fixture-researcher");
  f.engine.refinement.sealLayer("garden", 3, f.store.get("phase:garden:L3")!.revision, reference(built));
  assert.deepEqual(f.engine.refinement.gate("garden", "L3").findings, []);
  const horizon = acceptedHorizon(f.store, reference(f.store.get("phase:garden:L2")!));
  const request: FrameRequest = { project: "garden", level: 2, horizon: reference(horizon.gate), graph: reference(built),
    layer: reference(f.store.get("graph-layer:garden:2")!), frame: null, upper: null };
  return { graph: built.value, request, frame: clone(delivered(readFrame(f.store, request))) as FrameRead };
}

test("a legally researched L3 work-only port contract cannot be redefined by an N2 proposal", async t => {
  const f = await createOmFixture(t), desired = clone(f.graph), contractId = "garden-work-only-contract";
  desired.contracts.push({ id: contractId, schema: { type: "string" } });
  desired.nodes.find(node => node.id === "garden-produce-work")!.ports.push({ id: "aux-work-only", direction: "out", contract: contractId });
  const accepted = acceptResearchedWorks(f, desired);
  assert.ok(!projectGraph(accepted.graph, 2).contracts.some(contract => contract.id === contractId));
  const proposal = emptyProposal(accepted.frame, "work-only-port-contract");
  proposal.value.contracts = [{ id: contractId, schema: { type: "number" } }]; proposal.value.redefines = [contractId];
  const proposalRef = put(f.store, observe(proposal.value, "work-only-port-contract"));
  const request = { frame: accepted.request, proposals: [proposalRef] }, before = revisions(f.store);
  for (const action of [prepareCandidate, writeCandidate]) {
    const refusal = refusedAs(action(f.store, request), "candidate_level_unsupported");
    assert.equal(refusal.at.target, contractId);
  }
  assert.deepEqual(revisions(f.store), before);
  assert.equal(f.store.list("frame-candidate").length, 0);
  assert.deepEqual(f.store.get<Graph>("graph:garden")!.value.contracts.find(item => item.id === contractId)!.schema, { type: "string" });
});

test("L3 outcome and connector dependencies remain protected while unrelated typed L2 additions still pass", async t => {
  const f = await createOmFixture(t), desired = clone(f.graph);
  const outcomeContract = "garden-work-outcome-contract", outcomeArtifact = "garden-work-outcome";
  const flowContract = "garden-work-flow-contract", flowArtifact = "garden-work-flow-artifact";
  desired.contracts.push({ id: outcomeContract, schema: { type: "string" } }, { id: flowContract, schema: { type: "string" } });
  const artifact = clone(desired.artifacts.find(item => item.id === "garden-refusal")!);
  desired.artifacts.push({ ...artifact, id: outcomeArtifact, contract: outcomeContract, purpose: "An outcome belonging only to work" },
    { ...artifact, id: flowArtifact, contract: flowContract, terminal: false, kind: "intermediate", purpose: "An internal work-only flow" });
  const producer = desired.nodes.find(node => node.id === "w-garden-refusal-operation")!;
  const resultWork = clone(desired.nodes.find(node => node.id === "w-garden-refusal-operation")!);
  resultWork.id = "garden-work-only-outcome"; resultWork.parent = producer.parent; resultWork.outcome = outcomeArtifact;
  resultWork.ports = [{ id: "in", direction: "in", contract: flowContract }];
  desired.nodes.push(resultWork);
  producer.ports.push({ id: "work-only-flow", direction: "out", contract: flowContract });
  desired.connectors.push({ id: "garden-work-only-flow", artifact: flowArtifact, returnsTo: "garden-refusal-operation", wakeTest: null,
    bindings: [{ level: 3, producer: { node: producer.id, port: "work-only-flow" },
      consumers: [{ node: resultWork.id, port: "in" }], anchor: null }] });
  const journey = clone(desired.journeys!.find(item => item.terminal === "safe_failure")!);
  desired.journeys!.push({ ...journey, id: "garden-work-only-journey", entry: resultWork.id, path: [resultWork.id], outcome: outcomeArtifact });
  const accepted = acceptResearchedWorks(f, desired);
  assert.ok(!projectGraph(accepted.graph, 2).artifacts.some(item => [outcomeArtifact, flowArtifact].includes(item.id)));
  assert.ok(!accepted.graph.nodes.some(node => node.ports.some(port => port.contract === outcomeContract)), "Outcome contract is reached through its artifact, not a port");
  for (const [part, id] of [["contracts", outcomeContract], ["artifacts", outcomeArtifact], ["artifacts", flowArtifact]] as const) {
    const proposal = emptyProposal(accepted.frame, `closure-${id}`);
    if (part === "contracts") proposal.value.contracts = [{ id, schema: { type: "number" } }];
    else proposal.value.artifacts = [{ ...clone(accepted.graph.artifacts.find(item => item.id === id)!), purpose: "Changed dependent definition" }];
    proposal.value.redefines = [id];
    const proposalRef = put(f.store, observe(proposal.value, `closure-${id}`));
    const request = { frame: accepted.request, proposals: [proposalRef] }, before = revisions(f.store);
    for (const action of [prepareCandidate, writeCandidate]) {
      const refusal = refusedAs(action(f.store, request), "candidate_level_unsupported");
      assert.equal(refusal.at.target, id);
    }
    assert.deepEqual(revisions(f.store), before);
    assert.equal(f.store.list("frame-candidate").length, 0);
  }
  const positive = emptyProposal(accepted.frame, "outside-work-closure"), node = clone(accepted.graph.nodes.find(item => item.id === "garden-prep-operation")!);
  const contractId = "garden-operation-only-contract";
  node.ports.push({ id: "aux-operation-only", direction: "out", contract: contractId });
  positive.value.nodes = [node]; positive.value.removes = [node.id];
  positive.value.contracts = [{ id: contractId, schema: { type: "string", description: "garden-produce-work is descriptive text, not a typed reference" } }];
  const proposalRef = put(f.store, observe(positive.value, "outside-work-closure"));
  const request = { frame: accepted.request, proposals: [proposalRef] }, before = revisions(f.store);
  const prepared = delivered(prepareCandidate(f.store, request));
  assert.equal(prepared.state, "candidate"); if (prepared.state !== "candidate") return;
  assert.deepEqual(revisions(f.store), before);
  const written = delivered(writeCandidate(f.store, request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const graph = written.record.value.graph as Graph;
  assert.ok(projectGraph(graph, 2).contracts.some(item => item.id === contractId));
  assert.deepEqual(graph.nodes.filter(item => item.kind === "work"), accepted.graph.nodes.filter(item => item.kind === "work"));
  assert.deepEqual(graph.contracts.filter(item => item.id !== contractId), accepted.graph.contracts);
  assert.deepEqual(graph.artifacts, accepted.graph.artifacts);
  assert.deepEqual(graph.connectors, accepted.graph.connectors);
  const saved = { project: "garden", candidate: reference(written.record) };
  assert.deepEqual(delivered(readCandidate(f.store, saved)), written.record);
  assert.equal(delivered(gateCandidate(f.store, saved)).passed, true);
  assert.deepEqual(revisions(f.store).filter(item => item.head.id !== written.record.id), before);
});
