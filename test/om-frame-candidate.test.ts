import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  CANDIDATE_REFUSAL_CODES, type FrameCandidateRecord, type CandidateRequest, JOIN_ASSEMBLY } from "../src/om/frame-candidate.js";
import { writeHorizon } from "../src/om/horizon.js";
import { historicalTrace, withHistoricalReads, writeOmInput } from "../src/om/input.js";
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

test("C4 historical scope replays complete dependencies while candidate admission remains current", t => {
  const f = firstPass(t), written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const request = { project: "garden", candidate: reference(written.record) };
  const first: Ref[] = [], second: Ref[] = [];
  const firstView = historicalTrace(f.store, (ref, head) => { if (!head) first.push(ref); });
  const secondView = historicalTrace(f.store, (ref, head) => { if (!head) second.push(ref); });
  withHistoricalReads(() => {
    assert.deepEqual(delivered(readCandidate(firstView, request)), written.record);
    assert.deepEqual(delivered(readCandidate(secondView, request)), written.record);
    assert.ok(first.some(ref => canonical(ref) === canonical(f.proposalRef)));
    assert.deepEqual(second, first, "The cached rederivation must replay its exact proposal and frame dependencies");
    assert.equal(delivered(gateCandidate(f.store, request)).passed, true);
    const proposal = f.store.get(f.proposalRef.id)!;
    f.store.write({ id: proposal.id, kind: proposal.kind, expected: proposal.revision, value: proposal.value });
    const before = revisions(f.store);
    refusedAs(prepareCandidate(f.store, f.request), "input_stale");
    refusedAs(writeCandidate(f.store, f.request), "input_stale");
    assert.deepEqual(delivered(readCandidate(f.store, request)), written.record);
    assert.deepEqual(revisions(f.store), before);
  });
});

test("C4 historical proofs remain local to their Store and are discarded after an interrupted operation", t => {
  const f = firstPass(t), written = delivered(writeCandidate(f.store, f.request));
  assert.equal(written.state, "candidate"); if (written.state !== "candidate") return;
  const request = { project: "garden", candidate: reference(written.record) };
  const isolated = new Store(join(f.root, "isolated.sqlite"));
  t.after(() => isolated.close());
  isolated.write({ id: written.record.id, kind: written.record.kind, expected: 0, value: written.record.value });
  const interrupted = new Error("operation interrupted after historical proof");
  assert.throws(() => withHistoricalReads(() => {
    assert.deepEqual(delivered(readCandidate(f.store, request)), written.record);
    refusedAs(readCandidate(isolated, request), "record_missing");
    throw interrupted;
  }), error => error === interrupted);
  const get = f.store.get.bind(f.store), unavailable = new Error("exact proposal source unavailable");
  f.store.get = <T>(id: string, revision?: number) => {
    if (id === f.proposalRef.id && revision === f.proposalRef.revision) throw unavailable;
    return get<T>(id, revision);
  };
  try {
    assert.throws(() => readCandidate(f.store, request), error => error === unavailable,
      "A completed proof from the interrupted operation must not hide a new source failure");
  } finally { f.store.get = get; }
  assert.deepEqual(delivered(readCandidate(f.store, request)), written.record);
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

test("N3 without its works contract is refused on assembly and storage paths, never a partial candidate", t => {
  const f = firstPass(t), level3 = clone(f.frame); level3.request.level = 3;
  refusedAs(assembleCandidate(level3, []), "works_contract_invalid");
  const request = { ...f.request, frame: { ...f.request.frame, level: 3 as const, upper: { horizon: f.request.frame.horizon, frame: null } } }, before = revisions(f.store);
  refusedAs(prepareCandidate(f.store, request), "works_contract_invalid");
  refusedAs(writeCandidate(f.store, request), "works_contract_invalid");
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

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Write } from '../src/storage/store.js';
import { settleCandidate, readAcceptedFrame, rebaseFrame } from '../src/om/frame-accept.js';
import { writeGaps, type GapRequest } from '../src/om/gaps.js';
import { writeGapLines } from '../src/om/gap-lines.js';
import { writeOmObligations } from '../src/om/obligations.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { prepareWorksFrame, writeWorksFrame, readWorksFrame } from '../src/om/works-frame.js';
import { preparedField } from './preparation-fixture.js';
import { Evidence } from '../src/evidence/evidence.js';
import { writeNeighbors } from '../src/om/neighbors.js';
import { writeAtomicGate, readAtomicGate } from '../src/om/atomic-gate.js';
import { readFrameProposals } from '../src/om/frame-proposals.js';

function fjPut(store: Store, id: string, proposal: LayerProposal) { return reference(store.write({ id: `om-proposal:garden:${id}`, kind: 'layer-proposal', expected: 0, value: proposal })); }
function fjProposalFor(frame: FrameRead, graph: Graph): LayerProposal {
  if (frame.request.level === 3) {
    graph = clone(graph);
    for (const part of ['nodes', 'artifacts', 'contracts', 'anchors', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers'] as const) {
      const upper = frame.upper[part] ?? [], ids = new Set(upper.map(item => item.id));
      Object.assign(graph, { [part]: [...clone(upper), ...(graph[part] ?? []).filter(item => !ids.has(item.id))] });
    }
    graph.connectors = frame.upper.connectors.map(upper => {
      const desired = graph.connectors.find(connector => connector.id === upper.id)!;
      return { ...clone(upper), wakeTest: upper.wakeTest ?? desired.wakeTest,
        bindings: [...clone(upper.bindings), ...desired.bindings.filter(binding => binding.level === 3)] };
    });
  }
  const level = frame.request.level, projected = projectGraph(graph, level);
  const mapped = delivered(fillObligations(frame.upper, frame.scope, { graph,
    reference: { ...frame.request.graph, hash: hashJson(graph) }, frame: null }, frame.upperRef, level));
  const nodes = projected.nodes.filter(node => node.kind === (level === 2 ? 'operation' : 'work')
    && (level === 2 || frame.scope.nodes.includes(node.parent!)));
  const selected = new Set(nodes.map(node => node.id));
  return { base: { graph: frame.request.graph, frame: frame.request.frame }, level,
    ...(level === 3 ? { worksContract: 'works-frame/v1' as const } : {}), source: 'decision', status: 'proposed', nodes,
    fills: mapped.fills.filter(fill => selected.has(fill.node)).map(fill => {
      const obligation = mapped.obligations.find(item => item.id === fill.obligation)!;
      const node = nodes.find(item => item.id === fill.node)!;
      const codeRef = level === 3 && obligation.kind === 'connection-end'
        ? node.code[obligation.upper.port === 'out-alt' ? 1 : 0]! : undefined;
      return { obligation: fill.obligation, node: fill.node, ...(fill.port === undefined ? {} : { port: fill.port }),
        ...(codeRef ? { codeRef: clone(codeRef) } : {}) };
    }),
    localConnectors: level === 3 ? [] : projected.connectors.map(connector => ({ ...connector,
      bindings: connector.bindings.filter(binding => binding.level === level) })).filter(connector => connector.bindings.length),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins,
    tests: projected.tests.filter(item => level === 2 || selected.has(item.node)),
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [],
    anchors: level === 2 ? projected.anchors : [], removes: [], replaces: [], redefines: [] };
}

/** First L3 is genuinely absent: only the native C4/G3/C5 transition accepts L2. */
function fjFirstWorks(t: TestContext, externalIdentity = false) {
  const root = mkdtempSync(join(tmpdir(), 'omg-first-works-')), database = join(root, 'state.sqlite');
  const store = new Store(database), engine = new ProductEngine(store), desired = gardenGraph('cross');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  if (externalIdentity) {
    desired.artifacts.find(item => item.id === 'garden-data')!.external = true;
    desired.joins.push({ id: 'fj-upper-designed', consumer: 'garden-later-operation', connectors: ['garden-flow'],
      condition: 'Upper operation waits for its explicit input', required: ['garden-flow'], optional: [],
      failures: { missing: 'missing', extra: 'extra', foreign: 'foreign', stale: 'stale', duplicate: 'duplicate', returnsTo: 'garden-refusal-operation' } });
  }
  const produce = desired.nodes.find(node => node.id === 'garden-produce-work')!;
  produce.code.push({ path: 'src/garden-alternative.ts', access: 'read', status: 'planned', symbol: 'deliverAlternative' });
  const { level: _level, ...l1 } = projectGraph(desired, 1);
  preparedFeatures(engine, 'garden', l1 as Graph, field => preparedField('garden', field));
  let input = delivered(writeOmInput(store, { project: 'garden', expected: 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  const initial = delivered(writeHorizon(store, { project: 'garden', input: reference(input), graph: reference(store.get('graph:garden')!),
    refinement: null, available: {}, choice: { choiceVersion: 'first-works-upper', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame2: FrameRequest = { project: 'garden', level: 2, graph: reference(store.get('graph:garden')!),
    horizon: reference(initial.gate), layer: null, frame: null, upper: null };
  const proposal2Value = fjProposalFor(clone(delivered(prepareFrame(store, frame2))) as unknown as FrameRead, desired);
  const proposal2 = fjPut(store, 'first-works-upper', proposal2Value);
  const candidate2 = delivered(writeCandidate(store, { frame: frame2, proposals: [proposal2] }));
  assert.equal(candidate2.state, 'candidate'); if (candidate2.state !== 'candidate') throw new Error('L2 candidate missing');
  const candidateRef = reference(candidate2.record);
  const accepted = delivered(settleCandidate(store, { project: 'garden', level: 2, candidate: candidateRef,
    outcome: { gate: 'G3', candidate: candidateRef, graphHash: candidate2.record.value.graphHash, passed: true, codes: [] } }));
  const graph = reference(accepted.graph!), layer2 = reference(accepted.layer!), upperFrame = reference(accepted.frame!);
  if (externalIdentity) {
    const decisions: import('../src/om/addressing.js').InputDecisionProposal['decision'][] = [
      { target: 'garden-B1', field: 'nodes', value: ['garden-produce-block', 'garden-consume-block'] },
      { target: 'garden-B1', field: 'state', value: { writer: 'garden-produce-block', authority: 'garden-consume-block', rollback: 'garden-consume-block' } },
      { target: 'garden-R1#1', field: 'checkKind', value: 'test' },
    ];
    input = delivered(writeAddressing(store, { project: 'garden', input: reference(input), graph,
      decisions: decisions.map(decision => ({ pending: inputDecisionWrite({ project: 'garden', input: reference(input), graph, layers: [], decision }) as Write })) }));
  }
  const horizon = delivered(writeHorizon(store, { project: 'garden', input: reference(input), graph, refinement: layer2,
    available: {}, choice: { choiceVersion: 'first-real-works', features: [{ outcome: 'garden-result' }], excluded: [] } }));
  const frame: FrameRequest = { project: 'garden', level: 3, graph, horizon: reference(horizon.gate), layer: null, frame: null,
    upper: { horizon: reference(horizon.gate), frame: upperFrame } };
  const read = clone(delivered(prepareFrame(store, frame))) as unknown as FrameRead;
  const proposal = fjProposalFor(read, desired), proposalRef = fjPut(store, 'first-real-works', proposal);
  const works: ProposalRequest = { frame: read.request, proposals: [proposalRef] };
  const gaps = delivered(writeGaps(store, { project: 'garden', input: reference(input), graph, horizon: frame.horizon,
    operations: { frame: { ...frame2, graph, horizon: frame.horizon, layer: layer2, frame: upperFrame }, proposals: [] }, works }));
  const gapRead = { sources: clone(gaps.sources) as GapRequest, records: gaps.records.map(reference) };
  const lines = delivered(writeGapLines(store, { project: 'garden', previous: null, pass: 1, gaps: gapRead, closures: [] }));
  const ledger = delivered(writeOmObligations(store, { project: 'garden', gaps: gapRead, lines: reference(lines), assignments: [] }));
  assert.deepEqual(ledger.handoff.obligations, []);
  const request: CandidateRequest = { ...works, works: { contract: 'works-frame/v1', producer: reference(ledger.producer), ledger: reference(ledger.record), bindings: [] } };
  return { root, database, store, desired, read, proposal, proposalRef, request, ledger, lines, gaps, graph, layer2, upperFrame };
}

test('FJ1 rows 12/14/15: pure C4, works wrappers, reopen, exact repeat, absent slots and invalid eras', t => {
  const f = fjFirstWorks(t);
  const pure = delivered(assembleCandidate(f.read, [{ reference: f.proposalRef, value: f.proposal }], f.request.works));
  assert.equal(pure.state, 'candidate'); if (pure.state !== 'candidate') return;
  assert.equal(pure.candidate.joinAssembly, JOIN_ASSEMBLY);
  const prepared = delivered(prepareWorksFrame(f.store, f.request));
  assert.equal(prepared.state, 'candidate'); if (prepared.state !== 'candidate') return;
  assert.equal(prepared.candidate.request.joinAssembly, JOIN_ASSEMBLY);
  const { request: _request, ...content } = prepared.candidate;
  assert.deepEqual(content, pure.candidate);
  const written = delivered(writeWorksFrame(f.store, f.request));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const before = revisions(f.store), ref = reference(written.record), reopened = new Store(f.database);
  try {
    assert.deepEqual(delivered(readWorksFrame(reopened, { project: 'garden', candidate: ref })), written.record);
    assert.deepEqual(delivered(observeCandidate(reopened, { project: 'garden', candidate: ref })).record, written.record);
    for (const request of [f.request, clone(written.record.value.request) as CandidateRequest]) {
      const repeat = delivered(prepareCandidate(reopened, request));
      assert.equal(repeat.state, 'candidate'); if (repeat.state !== 'candidate') continue;
      assert.deepEqual(repeat.writes, []); assert.deepEqual(reference(repeat.existing!), ref);
      assert.ok(repeat.guards.some(item => canonical(item) === canonical(f.request.frame.graph)));
      assert.deepEqual(delivered(writeCandidate(reopened, request)), written);
    }
    assert.deepEqual(revisions(reopened), before);
  } finally { reopened.close(); }
  const open = delivered(assembleCandidate(f.read, [], f.request.works));
  assert.equal(open.state, 'gaps');
  for (const value of ['unknown', null, undefined]) assert.throws(() => prepareCandidate(f.store,
    { ...f.request, joinAssembly: value } as unknown as CandidateRequest), malformed);
  const l2 = firstPass(t);
  assert.throws(() => prepareCandidate(l2.store, { ...l2.request, joinAssembly: JOIN_ASSEMBLY }), malformed);
});

function fjDirectCase(seed: ReturnType<typeof fjFirstWorks>, inputs: number, sleeping: number, designed = false) {
  const frame = clone(seed.read), proposal = clone(seed.proposal);
  const consumer = 'garden-later-operation', supplier = 'garden-outside-supplier';
  const sourceNode = clone(frame.upper.nodes.find(node => node.id === 'garden-produce-operation')!);
  sourceNode.id = supplier; sourceNode.ports = sourceNode.ports.filter(port => port.direction === 'out');
  frame.upper.nodes.push(sourceNode);
  const template = frame.upper.connectors.find(connector => connector.id === 'garden-flow')!;
  const ids: string[] = [];
  for (let index = 0; index < inputs; index++) {
    const id = `fj-input-${index}`, connector = clone(template); connector.id = id;
    connector.bindings = [{ level: 2, producer: { node: index < sleeping ? 'garden-produce-operation' : supplier, port: 'out' },
      consumers: [{ node: consumer, port: 'in' }], anchor: null }];
    frame.upper.connectors.push(connector); ids.push(id);
    if (index < sleeping) for (const check of proposal.tests.filter(check => check.node === 'garden-produce-work')) check.covers.push(id);
  }
  const failures = { missing: 'missing', extra: 'extra', foreign: 'foreign', stale: 'stale', duplicate: 'duplicate', returnsTo: consumer };
  frame.upper.joins.push({ id: 'fj-upper-join', consumer, connectors: ['garden-flow', ...ids], failures,
    ...(designed ? { condition: 'opaque upper condition', required: ['garden-flow', ...ids], optional: [] } : {}) });
  frame.result = clone(delivered(fillObligations(frame.upper, frame.scope, null, frame.upperRef, 3))) as FrameRead['result'];
  // The new upper deliveries are outside-only consumer obligations; supply the active producer endpoints explicitly.
  for (const obligation of frame.result.open.filter(item => ids.includes(item.connector ?? '') && item.role === 'producer'))
    proposal.fills.push({ obligation: obligation.id, node: 'garden-produce-work', port: 'out',
      codeRef: clone(proposal.nodes.find(node => node.id === 'garden-produce-work')!.code[0]!) });
  return { frame, proposal: observe(proposal, 'fj'), ids };
}

test('FJ1 rows 1/2/3/4/5/6: C2/C3 representatives reach native graph validation across the six observed input reductions', t => {
  const seed = fjFirstWorks(t);
  // Six reductions in the method incident: 3→2, 5→3, 5→4, 3→1, 3→1, 4→3.
  for (const [count, sleeping] of [[2, 0], [4, 1], [4, 0], [2, 1], [2, 1], [3, 0], [0, 0], [1, 0], [3, 3]]) {
    for (const designed of [false, true]) {
      const f = fjDirectCase(seed, count!, sleeping!, designed), before = clone(f);
      const result = assembleCandidate(f.frame, [f.proposal], seed.request.works);
      if (result.ok) {
        assert.equal(result.value.state, 'candidate'); if (result.value.state !== 'candidate') throw new Error('Unexpected gaps');
        const graph = result.value.candidate.graph as Graph;
        assert.deepEqual(validateGraph(graph).findings, []);
        const identity = graph.nodes.find(node => node.parent === 'garden-later-operation')!;
        const join = graph.joins.find(item => item.consumer === identity.id);
        assert.deepEqual(join?.connectors ?? [], f.ids.slice(sleeping).sort());
        if (join) assert.ok(!('condition' in join) && !('required' in join) && !('optional' in join));
      } else {
        assert.equal(result.refusal.code, 'graph_invalid', canonical(result));
        assert.ok(result.refusal.findings?.length);
        assert.ok(!result.refusal.findings!.some(item => item.code.startsWith('join_')), canonical(result));
      }
      assert.deepEqual(f, before, 'Assembly leaves upper joins, fills and paid proposals intact');
    }
  }
  for (const count of [2, 3]) {
    const f = fjDirectCase(seed, count, 0); f.frame.upper.joins = [];
    for (const binding of f.frame.upper.connectors.find(item => item.id === 'garden-flow')!.bindings)
      binding.consumers = binding.consumers.filter(consumer => consumer.node !== 'garden-later-operation');
    f.frame.result = clone(delivered(fillObligations(f.frame.upper, f.frame.scope, null, f.frame.upperRef, 3))) as FrameRead['result'];
    const result = assembleCandidate(f.frame, [f.proposal], seed.request.works);
    if (count === 3) refusedAs(result, 'layer_join_design_required');
    else if (!result.ok) { assert.equal(result.refusal.code, 'graph_invalid'); assert.ok(!result.refusal.findings!.some(item => item.code.startsWith('join_'))); }
    else assert.equal(result.value.state, 'candidate');
  }
});

test('FJ1 row 11: a model-authored join cannot claim the proven representative exception', t => {
  const seed = fjFirstWorks(t), f = fjDirectCase(seed, 2, 0);
  const identity = f.frame.result.representatives.find(node => node.parent === 'garden-later-operation')!;
  f.proposal.value.joins.push({ ...clone(f.frame.upper.joins.at(-1)!), id: 'model-identity-join', consumer: identity.id });
  f.proposal = observe(f.proposal.value, 'fj');
  refusedAs(assembleCandidate(f.frame, [f.proposal], seed.request.works), 'derived_field_conflict');
  f.proposal.value.nodes.push(clone(identity));
  refusedAs(assembleCandidate(f.frame, [observe(f.proposal.value, 'fj')], seed.request.works), 'proposal_node_reserved');
});

test('FJ1 rows 2/6/14: a complete legal C4 fixture succeeds with an unimplemented direct join', t => {
  const f = fjFirstWorks(t, true), written = delivered(writeWorksFrame(f.store, f.request));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const graph = written.record.value.graph;
  assert.deepEqual(validateGraph(graph as Graph).findings, []);
  const identity = graph.nodes.find(node => node.parent === 'garden-later-operation')!;
  const join = graph.joins.find(item => item.consumer === identity.id)!;
  assert.ok(join); assert.deepEqual(join.connectors, ['garden-flow']);
  for (const key of ['condition', 'required', 'optional']) assert.equal(Object.hasOwn(join, key), false);
  assert.deepEqual(join.failures, f.read.upper.joins.find(item => item.id === 'fj-upper-designed')!.failures);
  assert.deepEqual(projectGraph(graph as Graph, 2), projectGraph(f.read.upper, 2));
});

test('FJ1 row 14: source advancement between prepare and write publishes no candidate', t => {
  const f = fjFirstWorks(t), prepared = delivered(prepareWorksFrame(f.store, f.request));
  assert.equal(prepared.state, 'candidate'); if (prepared.state !== 'candidate') return;
  const row = f.store.get(f.proposalRef.id)!;
  f.store.write({ id: row.id, kind: row.kind, expected: row.revision, value: row.value });
  const before = revisions(f.store);
  refusedAs(writeGuarded(f.store, { unit: 'F4.5', target: 'fj-candidate', writes: prepared.writes, guards: prepared.guards }), 'input_stale');
  assert.deepEqual(revisions(f.store), before);
});

test('FJ1 row 15: read and observation refuse unknown and inconsistent saved eras at the read boundary without database mutation', t => {
  const f = fjFirstWorks(t), written = delivered(writeWorksFrame(f.store, f.request));
  assert.equal(written.state, 'candidate'); if (written.state !== 'candidate') return;
  const before = revisions(f.store);
  const { joinAssembly: _era, ...unmarked } = clone(written.record.value);
  const values = [
    { ...clone(written.record.value), joinAssembly: 'future' },
    { ...clone(written.record.value), request: { ...clone(written.record.value.request), joinAssembly: 'future' } },
    unmarked,
    { ...clone(written.record.value), level: 2 },
  ];
  for (const value of values) {
    const row = { ...written.record, value, hash: hashJson(value) };
    const view = new Proxy(f.store, { get(target, key) {
      if (key === 'get') return (id: string, revision?: number) => id === row.id && (revision === undefined || revision === row.revision)
        ? row : target.get(id, revision);
      const item: unknown = Reflect.get(target, key, target); return typeof item === 'function' ? item.bind(target) : item;
    } });
    for (const reader of [readCandidate, observeCandidate]) {
      const refusal = refusedAs(reader(view, { project: 'garden', candidate: reference(row) }), 'candidate_graph_mismatch');
      assert.equal(refusal.at.field, 'joinAssembly');
    }
  }
  assert.deepEqual(revisions(f.store), before);
});

function fjProduceHistory(directory: string) {
  const f = fjFirstWorks({ after() {} } as unknown as TestContext, true);
  const takeCandidate = delivered(writeWorksFrame(f.store, f.request));
  assert.equal(takeCandidate.state, 'candidate'); if (takeCandidate.state !== 'candidate') throw new Error('Missing candidate');
  const candidate = takeCandidate.record, ref = reference(candidate), project = 'garden';
  const neighbors = delivered(writeNeighbors(f.store, { project, candidate: ref }));
  const command = { executable: process.execPath, args: ['--version'] };
  const environment = new ProductEngine(f.store).environments.configure(project, { workspace: f.root,
    implementer: { actor: 'fj', model: 'fixture', effort: 'high', command }, reviewer: { actor: 'fj-review', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000, requestCapacityChars: 200_000 }, 0);
  writeFileSync(join(f.root, 'input.txt'), 'captured external input');
  const source = new Evidence(f.store).file(project, 'garden-data', f.root, 'input.txt', 'text/plain', 0);
  const gate = delivered(writeAtomicGate(f.store, { project, candidate: ref, neighbors: reference(neighbors),
    environment: reference(environment), gaps: clone(f.ledger.record.value.request.gaps) as import('../src/om/gaps.js').GapReadRequest,
    results: [], sources: [reference(source)] }));
  assert.equal(gate.value.result.passed, true, canonical(gate.value.result.findings));
  const settlement = { project, level: 3 as const, candidate: ref,
    outcome: { ...clone(gate.value.result), codes: [...gate.value.result.codes], basis: reference(gate) } };
  const frameBytes = canonical(delivered(readFrame(f.store, f.request.frame)));
  const proposalsBytes = canonical(delivered(readFrameProposals(f.store, f.request)));
  f.store.close();
  const pending = join(directory, 'pending.sqlite'); copyFileSync(f.database, pending);
  const store = new Store(f.database);
  const settled = delivered(settleCandidate(store, settlement));
  assert.ok(settled.graph && settled.frame && settled.layer);
  const event = { project, level: 3 as const, graph: reference(settled.graph), layer: reference(settled.layer), frame: reference(settled.frame) };
  const acceptedBytes = canonical(delivered(readAcceptedFrame(store, event)));
  const input = f.gaps.sources.input;
  const choice = { choiceVersion: 'fj-after-work', features: [{ outcome: 'garden-result' }], excluded: [] };
  const horizon = delivered(writeHorizon(store, { project, input, graph: event.graph, refinement: f.layer2, available: {}, choice }));
  const from: FrameRequest = { ...f.request.frame, graph: event.graph, horizon: reference(horizon.gate), layer: event.layer, frame: event.frame,
    upper: { horizon: reference(horizon.gate), frame: f.upperFrame } };
  const nextUpper = delivered(writeCandidate(store, { frame: { project, level: 2, graph: event.graph,
    horizon: from.horizon, layer: f.layer2, frame: f.upperFrame, upper: null }, proposals: [] }));
  assert.equal(nextUpper.state, 'candidate'); if (nextUpper.state !== 'candidate') throw new Error('Missing next upper');
  const upperRef = reference(nextUpper.record), upper = delivered(settleCandidate(store, { project, level: 2, candidate: upperRef,
    outcome: { gate: 'G3', candidate: upperRef, graphHash: nextUpper.record.value.graphHash, passed: true, codes: [] } }));
  const nextHorizon = delivered(writeHorizon(store, { project, input, graph: reference(upper.graph!), refinement: reference(upper.layer!),
    available: {}, choice: { ...choice, choiceVersion: 'fj-rebase' } }));
  const to: FrameRequest = { project, level: 3, graph: reference(upper.graph!), horizon: reference(nextHorizon.gate), layer: null, frame: null,
    upper: { horizon: reference(nextHorizon.gate), frame: reference(upper.frame!) } };
  const request = { from, to }, moved = delivered(rebaseFrame(store, request));
  const rebased = delivered(readFrame(store, { ...to, layer: reference(moved.layer), frame: reference(moved.frame) }));
  store.close();
  const unjoined = fjFirstWorks({ after() {} } as unknown as TestContext);
  const plain = delivered(writeWorksFrame(unjoined.store, unjoined.request));
  assert.equal(plain.state, 'candidate'); if (plain.state !== 'candidate') throw new Error('Missing plain candidate');
  unjoined.store.close();
  return { root: f.root, database: f.database, pending, candidate, settlement, frameBytes, proposalsBytes, event, acceptedBytes,
    rebase: request, moved, rebased, plain: { root: unjoined.root, database: unjoined.database, candidate: plain.record } };
}

function fjAcceptedRead(prior: FrameRead, candidate: import('../src/om/frame-candidate.js').FrameCandidate): FrameRead {
  const frame = clone(prior), graph = clone(candidate.graph);
  const mapping: ConnectionFrame = { project: 'garden', level: 3, worksContract: 'works-frame/v1', candidateHash: hashJson(graph),
    layerHash: hashJson(projectGraph(graph, 3)), fills: candidate.fills.map(fill => ({ ...fill, source: fill.source === 'proposed' ? 'accepted' as const : fill.source })) };
  // Canonical ordering uses code-point order, independent of the host locale.
  mapping.fills.sort((left, right) => canonical(left) < canonical(right) ? -1 : canonical(left) > canonical(right) ? 1 : 0);
  const frameRef = { id: 'om-frame:garden:3', revision: frame.request.frame!.revision + 1, hash: hashJson(mapping) };
  frame.request.graph = { ...frame.request.graph, revision: frame.request.graph.revision + 1, hash: hashJson(graph) };
  frame.request.frame = frameRef;
  frame.accepted = { graph, reference: frame.request.graph, frame: { reference: frameRef, value: mapping } };
  frame.result = clone(delivered(fillObligations(frame.upper, frame.scope, frame.accepted, frame.upperRef, 3))) as FrameRead['result'];
  return frame;
}
function fjEnterOperations(prior: FrameRead, operations: string[]) {
  const frame = clone(prior), desired = gardenGraph('cross');
  frame.scope = scope([...new Set([...frame.scope.nodes, ...operations])].sort());
  frame.result = clone(delivered(fillObligations(frame.upper, frame.scope, frame.accepted, frame.upperRef, 3))) as FrameRead['result'];
  const proposal = emptyProposal(frame, 'fj-enter').value; proposal.worksContract = 'works-frame/v1';
  for (const operation of operations) {
    const node = clone(desired.nodes.find(item => item.kind === 'work' && item.parent === operation)!);
    if (!node.code.length) {
      node.id = `${operation}-real-work`; node.code = [{ path: `${node.id}.ts`, access: 'write', status: 'planned' }];
      const check = clone(desired.tests.find(item => item.node === 'garden-consume-work')!);
      check.id = `${node.id}-test`; check.node = node.id; check.contract!.entrypoint.path = node.code[0]!.path;
      node.tests = [check.id]; proposal.tests.push(check);
    } else proposal.tests.push(...clone(desired.tests.filter(item => item.node === node.id)));
    proposal.nodes.push(node);
    for (const obligation of frame.result.open.filter(item => item.upper.node === operation))
      proposal.fills.push({ obligation: obligation.id, node: node.id, ...(obligation.upper.port ? { port: obligation.upper.port, codeRef: clone(node.code[0]!) } : {}) });
  }
  return { frame, proposal: observe(proposal, 'fj-enter') };
}

test('FJ1 rows 4/9/10/13: b595c7b produces accepted and pending legacy C4, designed identity joins and rebase in a separate process', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omg-fj1-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url)), repositoryUrl = pathToFileURL(repository).href;
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
  const ts = (await import('typescript')).default;
  const original = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('fixture.js', original, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  // Reuse only fixture declarations; every engine source in the child comes from the immutable Git revision.
  const fixture = parsed.statements.filter(statement => ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement))
    .map(statement => {
      let text = statement.getText(parsed);
      if (ts.isImportDeclaration(statement)) text = text.replace(/,\s*JOIN_ASSEMBLY\b/g, '')
        .replace(/from (["'])(\.[^"']+)\1/, (_whole, _quote, relative: string) => `from ${JSON.stringify(new URL(relative, import.meta.url).href)}`);
      return text;
    }).join('\n') + '\nexport { fjProduceHistory };\n';
  const fixtureFile = join(root, 'fixture.mjs'); writeFileSync(fixtureFile, fixture);
  const loader = join(root, 'loader.mjs');
  writeFileSync(loader, `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(typescript)};
const root = ${JSON.stringify(repositoryUrl)}, prefix = new URL('dist/', root).href;
export async function load(url, context, next) {
  if (url.startsWith(prefix) && url.endsWith('.js')) {
    const relative = url.slice(prefix.length).replace(/\\.js$/, '.ts');
    const source = execFileSync('git', ['show', 'b595c7b5fc4cc3360d8395dcf1b7ce1aa11feb3c:' + relative], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 20000000 });
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText };
  }
  return next(url, context);
}`);
  const metadata = join(root, 'history.json');
  const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`;
  execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`, '--input-type=module', '--eval',
    `import {writeFileSync} from 'node:fs'; import {fjProduceHistory} from ${JSON.stringify(pathToFileURL(fixtureFile).href)}; writeFileSync(${JSON.stringify(metadata)}, JSON.stringify(fjProduceHistory(${JSON.stringify(root)})));`],
  { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const history = JSON.parse(readFileSync(metadata, 'utf8')) as ReturnType<typeof fjProduceHistory>;
  t.after(() => { rmSync(history.root, { recursive: true, force: true }); rmSync(history.plain.root, { recursive: true, force: true }); });
  assert.equal(Object.hasOwn(history.candidate.value, 'joinAssembly'), false);
  assert.ok(history.candidate.value.graph.joins.some(item => item.consumer.startsWith('om-identity:') && item.condition));
  for (const database of [history.pending, history.database]) {
    const store = new Store(database);
    try {
      const before = revisions(store), ref = reference(history.candidate);
      const savedRequest = clone(history.candidate.value.request) as CandidateRequest;
      assert.equal(delivered(readAtomicGate(store, { project: 'garden', record: history.settlement.outcome.basis })).value.result.passed, true);
      assert.deepEqual(delivered(readCandidate(store, { project: 'garden', candidate: ref })), history.candidate);
      assert.deepEqual(delivered(observeCandidate(store, { project: 'garden', candidate: ref })).record, history.candidate);
      assert.equal(canonical(delivered(readFrame(store, history.candidate.value.request.frame))), history.frameBytes);
      assert.equal(canonical(delivered(readFrameProposals(store, savedRequest))), history.proposalsBytes);
      assert.deepEqual(revisions(store), before);
      if (database === history.pending) {
        const repeated = delivered(prepareCandidate(store, savedRequest));
        assert.equal(repeated.state, 'candidate'); if (repeated.state !== 'candidate') throw new Error('Missing legacy repeat');
        assert.deepEqual(repeated.writes, []); assert.deepEqual(repeated.existing, history.candidate);
        assert.deepEqual(delivered(writeCandidate(store, savedRequest)), { state: 'candidate', record: history.candidate });
        assert.deepEqual(revisions(store), before);
        const accepted = delivered(settleCandidate(store, history.settlement));
        assert.equal(accepted.state, 'accepted');
        assert.deepEqual(accepted.graph!.value, history.candidate.value.graph);
      } else {
        assert.equal(canonical(delivered(readAcceptedFrame(store, history.event))), history.acceptedBytes);
        assert.deepEqual(delivered(rebaseFrame(store, history.rebase)).frame, history.moved.frame);
        assert.deepEqual(delivered(readFrame(store, history.rebased.request)), history.rebased);
        refusedAs(prepareCandidate(store, savedRequest), 'input_stale');
        const prior = clone(delivered(readFrame(store, history.rebase.from))) as FrameRead;
        const assembled = delivered(assembleCandidate(prior, [], savedRequest.works));
        assert.equal(assembled.state, 'candidate'); if (assembled.state !== 'candidate') throw new Error('Missing carried candidate');
        const carried = assembled.candidate as import('../src/om/frame-candidate.js').FrameCandidate;
        const identity = carried.graph.nodes.find(node => node.parent === 'garden-later-operation')!;
        const mechanical = carried.graph.joins.find(item => item.consumer === identity.id)!;
        assert.ok(mechanical); assert.equal(mechanical.condition, undefined, 'row 9: the accepted legacy join is recomputed');
        // A real producer can enter only after the upper project makes this artifact internally produced.
        const productionBase = clone(prior), production = clone(carried);
        productionBase.scope = scope([...new Set([...prior.scope.nodes, 'garden-produce-operation', 'garden-prep-operation'])].sort());
        productionBase.upper.artifacts.find(item => item.id === 'garden-data')!.external = false;
        production.graph.artifacts.find(item => item.id === 'garden-data')!.external = false;
        const active = fjEnterOperations(fjAcceptedRead(productionBase, production), ['garden-produce-operation', 'garden-prep-operation']);
        const sleepingResult = assembleCandidate(active.frame, [active.proposal], savedRequest.works);
        assert.ok(sleepingResult.ok, canonical(sleepingResult));
        const sleeping = delivered(sleepingResult);
        assert.equal(sleeping.state, 'candidate'); if (sleeping.state !== 'candidate') throw new Error('Missing sleeping candidate');
        assert.ok(!sleeping.candidate.graph.joins.some(item => item.consumer === identity.id), 'rows 4/9: all incoming deliveries sleep');
        assert.ok(sleeping.candidate.graph.connectors.some(item => item.bindings.some(binding => binding.level === 3 && binding.anchor
          && binding.consumers.some(endpoint => endpoint.node === identity.id))));
        const again = fjAcceptedRead(active.frame, sleeping.candidate as import('../src/om/frame-candidate.js').FrameCandidate);
        again.scope = clone(prior.scope);
        again.result = clone(delivered(fillObligations(again.upper, again.scope, again.accepted, again.upperRef, 3))) as FrameRead['result'];
        const awakeResult = assembleCandidate(again, [], savedRequest.works); assert.ok(awakeResult.ok, canonical(awakeResult));
        const awake = delivered(awakeResult);
        assert.equal(awake.state, 'candidate'); if (awake.state !== 'candidate') throw new Error('Missing awake candidate');
        assert.deepEqual(awake.candidate.graph.joins.find(item => item.consumer === identity.id), mechanical, 'row 4: a later new assembly restores direct inputs');
        const entered = fjEnterOperations(prior, ['garden-later-operation']);
        const realResult = assembleCandidate(entered.frame, [entered.proposal], savedRequest.works); assert.ok(realResult.ok, canonical(realResult));
        const real = delivered(realResult);
        assert.equal(real.state, 'candidate'); if (real.state !== 'candidate') throw new Error('Missing real replacement');
        assert.ok(!real.candidate.graph.nodes.some(node => node.id === identity.id));
        assert.ok(!real.candidate.graph.joins.some(join => join.consumer === identity.id), 'row 10: the obsolete mechanical definition is removed');
        for (const conflict of ['content', 'duplicate'] as const) {
          const changed = clone(carried);
          if (conflict === 'content') changed.graph.joins.find(join => join.id === mechanical.id)!.condition = 'authored content at the same address';
          else changed.graph.joins.push({ ...mechanical, id: 'authored-other-join', condition: 'authored', required: [...mechanical.connectors], optional: [] });
          const bad = fjAcceptedRead(prior, changed);
          const failure = refusedAs(assembleCandidate(bad, [], savedRequest.works), conflict === 'content' ? 'derived_field_conflict' : 'graph_invalid');
          if (conflict === 'duplicate') assert.equal((failure as typeof failure & { findings: Finding[] }).findings[0]!.code, 'join_duplicate');
        }
      }
    } finally { store.close(); }
  }
  const plain = new Store(history.plain.database);
  try {
    const old = history.plain.candidate, request = clone(old.value.request) as CandidateRequest;
    const next = delivered(writeCandidate(plain, { ...request, joinAssembly: JOIN_ASSEMBLY }));
    assert.equal(next.state, 'candidate'); if (next.state !== 'candidate') return;
    assert.equal(next.record.value.graphHash, old.value.graphHash); assert.notEqual(next.record.id, old.id);
    assert.deepEqual(delivered(writeCandidate(plain, request)), { state: 'candidate', record: old });
  } finally { plain.close(); }
});
