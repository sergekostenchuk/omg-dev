import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hashJson } from "../src/canonical.js";
import { EngineError } from "../src/errors.js";
import { LEVEL, type Graph } from "../src/graph/model.js";
import { projectGraph } from "../src/graph/project.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../src/discovery/requirements.js";
import { ProductEngine } from "../src/product/engine.js";
import { Store } from "../src/storage/store.js";
import { writeOmInput } from "../src/om/input.js";
import { writeHorizon } from "../src/om/horizon.js";
import { writeGuarded } from "../src/om/refs.js";
import type { OmResult, Refusal } from "../src/om/refusal.js";
import { fillObligations, representativeId, readFrame, prepareFrame, WORKS_FRAME_CONTRACT,
  type FrameLevel, type FrameRead, type FrameRequest, type FrameScope,
  type ConnectionFrame } from "../src/om/frame-obligations.js";
import { applyProposals, definitionIds, observeProposal, openObligationsToGaps, readFrameProposals, prepareFrameProposals,
  PROPOSAL_REFUSAL_CODES, type LayerProposal, type ProposalObservation,
  type ProposalRequest, type ProposalResult } from "../src/om/frame-proposals.js";
import { gardenGraph, createOmFixture, type OmFixture } from "./om-fixture.js";
import { preparedFeatures } from "./product-fixture.js";

const clone = structuredClone;
const levels = [2, 3] as const;
const fakeRef = (id: string): Ref => ({ id, revision: 1, hash: hashJson(id) });
const graphRef = (graph: Graph): Ref => ({ id: "graph:garden", revision: 1, hash: hashJson(graph) });
const revisions = (store: Store) => store.list().map(row => ({ head: reference(row), history: store.history(row.id).map(reference) }));
function delivered<T>(result: OmResult<T>): T {
  if (!result.ok) assert.fail(`Unexpected ${result.refusal.code}: ${result.refusal.message}`);
  return result.value;
}
function refusedAs<T>(result: OmResult<T>, code: string) {
  if (result.ok) assert.fail(`Expected ${code}, received success`);
  assert.equal(result.refusal.code, code);
  assert.ok(result.refusal.at.target.length > 0);
  assert.ok(result.refusal.at.field || result.refusal.at.ref);
  assert.ok(["producer", "gap", "owner", "readiness"].includes(result.refusal.route));
  return result.refusal;
}
function malformed(error: unknown): boolean {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, "proposal_request_invalid");
  return true;
}
function upper(graph: Graph, level: FrameLevel): Graph {
  const { level: _level, ...projection } = projectGraph(graph, level === 2 ? 1 : 2);
  return projection as Graph;
}
function scope(nodes: string[]): FrameScope {
  return { nodes, excluded: [], hash: hashJson({ nodes: [...nodes].sort(), excluded: [] }) };
}
function pureFrame(graph: Graph, level: FrameLevel, accepted = false, nodes?: string[]): FrameRead {
  const view = upper(graph, level), upperRef = fakeRef(`graph-layer:garden:${level - 1}`);
  const horizon = scope(nodes ?? view.nodes.filter(node => LEVEL[node.kind] === level - 1).map(node => node.id));
  const base = accepted ? graph : view;
  const request: FrameRequest = { project: "garden", level, horizon: fakeRef("om-horizon:garden:choice"),
    graph: graphRef(base), layer: accepted ? fakeRef(`graph-layer:garden:${level}`) : null, frame: null,
    upper: level === 2 ? null : { horizon: fakeRef("om-horizon:garden:choice"), frame: null } };
  const acceptedLayer = accepted ? { graph, reference: request.graph, frame: null } : null;
  return { request, upper: view, upperRef, scope: horizon, accepted: acceptedLayer,
    result: clone(delivered(fillObligations(view, horizon, acceptedLayer, upperRef, level))) as FrameRead["result"],
    references: [upperRef, request.graph, request.horizon] };
}
function proposalFor(frame: FrameRead, graph: Graph, id = "one"): ProposalObservation {
  const level = frame.request.level;
  const completed = delivered(fillObligations(frame.upper, frame.scope,
    { graph, reference: graphRef(graph), frame: null }, frame.upperRef, level));
  const projected = projectGraph(graph, level);
  const value: LayerProposal = { base: { graph: frame.request.graph, frame: frame.request.frame }, level,
    source: "decision", status: "proposed", nodes: clone(projected.nodes.filter(node => LEVEL[node.kind] === level)),
    fills: completed.fills.map(fill => ({ obligation: fill.obligation, node: fill.node,
      ...(fill.port === undefined ? {} : { port: fill.port }) })),
    localConnectors: clone(projected.connectors.map(connector => ({ ...connector,
      bindings: connector.bindings.filter(binding => binding.level === level) })).filter(connector => connector.bindings.length > 0)),
    artifacts: clone(projected.artifacts), contracts: clone(projected.contracts), joins: clone(projected.joins),
    tests: clone(projected.tests), edges: clone(projected.edges ?? []), journeys: clone(projected.journeys ?? []),
    packets: clone(projected.packets ?? []), transfers: clone(projected.transfers ?? []), anchors: clone(projected.anchors),
    removes: [], replaces: [], redefines: [] };
  if (level === 3) {
    value.worksContract = WORKS_FRAME_CONTRACT;
    for (const node of value.nodes) if (node.ports.length && !node.code.length)
      node.code = [{ path: `${node.id}.ts`, access: "write", status: "planned" }];
    for (const fill of value.fills) if (fill.port !== undefined)
      fill.codeRef = clone(value.nodes.find(node => node.id === fill.node)!.code[0]!);
  }
  return observe(value, id);
}
function observe(value: LayerProposal, id = "one"): ProposalObservation {
  return { reference: { id: `om-proposal:garden:${id}`, revision: 1, hash: hashJson(value) }, value };
}
function emptyProposal(frame: FrameRead, id = "empty"): ProposalObservation {
  return observe({ base: { graph: frame.request.graph, frame: frame.request.frame }, level: frame.request.level,
    ...(frame.request.level === 3 ? { worksContract: WORKS_FRAME_CONTRACT } : {}),
    source: "input", status: "proposed", nodes: [], fills: [], localConnectors: [], artifacts: [], contracts: [],
    joins: [], tests: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] }, id);
}
function acceptedHorizon(store: Store, refinement: Ref | null) {
  const input = delivered(writeOmInput(store, { project: "garden", expected: store.get("om-input:garden")?.revision ?? 0,
    stages: Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:garden:${stage}`)!)])) as Record<UpstreamStage, Ref> }));
  return delivered(writeHorizon(store, { project: "garden", input: reference(input), graph: reference(store.get("graph:garden")!),
    refinement, choice: { choiceVersion: "proposal-choice", features: [{ outcome: "garden-result" }], excluded: [] }, available: {} }));
}
function acceptedRequest(f: OmFixture, horizon: Ref, level: FrameLevel): FrameRequest {
  return { project: f.project, level, horizon, graph: reference(f.graphRevision), layer: reference(f.layers[level]),
    frame: reference(f.store.get(`om-frame:garden:${level}`)!),
    upper: level === 2 ? null : { horizon, frame: reference(f.store.get("om-frame:garden:2")!) } };
}
function put(store: Store, proposal: ProposalObservation): Ref {
  return reference(store.write({ id: proposal.reference.id, kind: "layer-proposal", expected: 0, value: proposal.value }));
}
function observingFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'omg-observed-proposal-')), database = join(root, 'state.sqlite'), store = new Store(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph();
  preparedFeatures(new ProductEngine(store), 'garden', upper(graph, 2));
  const horizon = acceptedHorizon(store, null);
  const request: FrameRequest = { project: 'garden', level: 2, graph: reference(store.get('graph:garden')!),
    horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  const frame = delivered(readFrame(store, request)) as unknown as FrameRead;
  return { store, database, frame, proposal: proposalFor(frame, graph) };
}

test('definition observation reads typed sections and never follows references, text or defines', () => {
  const graph = gardenGraph(), frame = pureFrame(graph, 2), proposal = emptyProposal(frame).value;
  for (const part of ['nodes', 'localConnectors', 'artifacts', 'contracts', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers', 'anchors'] as const)
    (proposal as unknown as Record<string, unknown>)[part] = [{ id: `definition-${part}`, arbitrary: 'definition-from-text' }];
  Object.assign(proposal, { defines: ['phantom'], removes: ['removed-reference'], redefines: ['redefined-reference'],
    fills: [{ node: 'fill-reference', obligation: 'obligation-reference' }] });
  const definitions = delivered(definitionIds(proposal, 'proposal', 'proposal'));
  assert.equal(definitions.length, 11);
  assert.ok(definitions.every(id => id.startsWith('definition-')));
  assert.ok(Object.isFrozen(definitions));
  for (const part of ['nodes', 'artifacts'] as const) {
    for (const invalid of [undefined, null, 'array', [null], [{}], [{ id: 1 }]]) {
      const bad: unknown = { ...proposal, [part]: invalid };
      const refusal: Refusal = refusedAs(definitionIds(bad, 'proposal', 'observed-source'), 'proposal_invalid');
      assert.equal(refusal.at.target, 'observed-source'); assert.ok(refusal.at.field!.startsWith(part));
    }
  }
  const graphDefinitions = delivered(definitionIds({ ...graph, defines: ['phantom'], researchObligations: [{ id: 'binding-reference',
    scope: fakeRef('research-scope:garden:R2'), obligation: 'external-obligation',
    consumers: [{ node: 'consumer-reference', tests: ['test-reference'] }] }] }, 'graph', 'graph'));
  assert.ok(graphDefinitions.includes('garden-data'));
  assert.ok(graphDefinitions.includes('garden-prep-operation'));
  assert.ok(!graphDefinitions.includes('phantom'));
  for (const ref of ['binding-reference', 'external-obligation', 'consumer-reference', 'test-reference', 'out'])
    assert.ok(!graphDefinitions.includes(ref));
  refusedAs(definitionIds({ ...graph, researchObligations: null }, 'graph', 'graph'), 'proposal_invalid');
  for (const part of ['actors', 'requirements', 'edges', 'journeys', 'transfers', 'packets']) {
    const missing = clone(graph) as unknown as Record<string, unknown>; delete missing[part];
    refusedAs(definitionIds(missing, 'graph', 'graph'), 'proposal_invalid');
  }
});

test('proposal observation retains readable semantic defects and terminal statuses on the historical first-pass base', t => {
  const f = observingFixture(t), value = clone(f.proposal.value);
  const peer = put(f.store, emptyProposal(f.frame, 'observation-peer'));
  value.nodes[0]!.outcome = 'absent-outcome';
  Object.assign(value, { defines: ['phantom'], removes: ['remove-only-reference'] });
  const histories = [];
  for (const status of ['proposed', 'accepted', 'rejected'] as const) {
    const record = f.store.write({ id: f.proposal.reference.id, kind: 'layer-proposal', expected: f.store.get(f.proposal.reference.id)?.revision ?? 0,
      value: { ...value, status } });
    const request = { project: 'garden', proposal: reference(record), request: { frame: f.frame.request, proposals: [reference(record), peer] } };
    const before = revisions(f.store), result = delivered(observeProposal(f.store, request));
    assert.deepEqual(result.record, record); assert.equal(hashJson(result.record.value), record.hash);
    assert.deepEqual(result.sources.frame, f.frame.request);
    assert.deepEqual(result.sources.proposals.map(canonical), request.request.proposals.map(canonical).sort());
    assert.ok(Object.isFrozen(result.sources)); assert.ok(Object.isFrozen(result.sources.frame)); assert.ok(Object.isFrozen(result.sources.proposals));
    assert.deepEqual(delivered(observeProposal(f.store, { ...request,
      request: { ...request.request, proposals: [...request.request.proposals].reverse() } })).sources, result.sources);
    assert.ok(result.definitions.includes(value.nodes[0]!.id)); assert.ok(!result.definitions.includes('absent-outcome'));
    assert.ok(!result.definitions.includes('phantom')); assert.ok(!result.definitions.includes('remove-only-reference'));
    for (const ref of [reference(record), peer, f.frame.request.graph, f.frame.request.horizon])
      assert.ok(result.references.some(item => canonical(item) === canonical(ref)));
    if (status !== 'proposed') refusedAs(readFrameProposals(f.store, request.request), 'proposal_not_proposed');
    else assert.equal(readFrameProposals(f.store, request.request).ok, false);
    assert.deepEqual(revisions(f.store), before); histories.push({ request, result });
  }
  for (const id of ['graph:garden', 'source:garden:brief']) {
    const old = f.store.get(id)!;
    f.store.write({ id, kind: old.kind, expected: old.revision, value: old.value });
  }
  const reopened = new Store(f.database);
  try {
    for (const { request, result } of histories) assert.deepEqual(delivered(observeProposal(reopened, request)), result);
  } finally { reopened.close(); }
});

test('proposal observation rejects unreadable sets and foreign context without masking storage exceptions', t => {
  const f = observingFixture(t), proposal = put(f.store, f.proposal);
  const request = { project: 'garden', proposal, request: { frame: f.frame.request, proposals: [proposal] } };
  for (const bad of [undefined, null, [], {}, { project: 'garden', proposal }, { ...request, proposal: null }])
    assert.throws(() => observeProposal(f.store, bad as unknown as typeof request), malformed);
  refusedAs(observeProposal(f.store, { ...request, request: { ...request.request, proposals: [] } }), 'proposal_invalid');
  refusedAs(observeProposal(f.store, { ...request, project: 'foreign' }), 'proposal_invalid');
  let index = 0;
  for (const part of ['nodes', 'localConnectors', 'artifacts', 'contracts', 'joins', 'tests', 'edges', 'journeys', 'packets', 'transfers', 'anchors', 'fills', 'removes', 'redefines', 'replaces']) {
    const value = clone(f.proposal.value) as unknown as Record<string, unknown>; delete value[part];
    const row = f.store.write({ id: `om-proposal:garden:absent-${index++}`, kind: 'layer-proposal', expected: 0, value });
    const ref = reference(row), refusal = refusedAs(observeProposal(f.store, { ...request, proposal: ref,
      request: { ...request.request, proposals: [ref] } }), 'proposal_invalid');
    assert.equal(refusal.at.target, ref.id); assert.equal(refusal.at.field, part);
  }
  const different = f.store.write({ id: 'om-proposal:garden:other-base', kind: 'layer-proposal', expected: 0,
    value: { ...f.proposal.value, base: { ...f.proposal.value.base, graph: { ...f.frame.request.graph, revision: 999 } } } });
  const differentRef = reference(different);
  refusedAs(observeProposal(f.store, { ...request, proposal: differentRef,
    request: { ...request.request, proposals: [differentRef] } }), 'proposal_base_stale');
  for (const ref of [fakeRef('om-proposal:foreign:one'), { ...proposal, hash: '0'.repeat(64) }, fakeRef('om-proposal:garden:absent')])
    refusedAs(observeProposal(f.store, { ...request, proposal: ref, request: { ...request.request, proposals: [ref] } }),
      ref.id.includes(':foreign:') ? 'record_foreign' : ref.id.endsWith(':absent') ? 'record_missing' : 'record_forged');
  const before = revisions(f.store);
  for (const fault of [new TypeError('observation read failure'), new EngineError('record_corrupt', 'source corrupt')]) {
    const original = f.store.get.bind(f.store);
    try {
      f.store.get = ((id: string, revision?: number) => { if (id === proposal.id) throw fault; return original(id, revision); }) as Store['get'];
      assert.throws(() => observeProposal(f.store, request), error => error === fault);
    } finally { f.store.get = original; }
  }
  assert.deepEqual(revisions(f.store), before);
});

test("proposals fill both first layers and preserve every cross-flow consumer, port and complete definition", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross"), frame = pureFrame(graph, level), proposal = proposalFor(frame, graph);
    const original = clone(proposal), result = delivered(applyProposals(frame, [proposal]));
    assert.deepEqual(result.open, []);
    assert.deepEqual(result.obligations, frame.result.obligations);
    assert.equal(result.fills.length, frame.result.obligations.length);
    assert.ok(result.fills.every(fill => fill.source === "proposed"));
    const cross = result.obligations.filter(item => item.connector === "garden-flow");
    assert.equal(cross.length, 6);
    const consumer = `garden-consume-${level === 2 ? "block" : "operation"}`;
    assert.equal(cross.filter(item => item.upper.node === consumer && item.upper.port === "in").length, 2);
    assert.equal(cross.filter(item => item.upper.node === consumer && item.upper.port === "in-alt").length, 1);
    for (const obligation of cross) assert.equal(result.fills.filter(fill => fill.obligation === obligation.id).length, 1);
    assert.deepEqual(result.proposals, [proposal]);
    assert.ok(result.fills.every(fill => canonical(fill.basis) === canonical(proposal.reference)));
    assert.deepEqual(delivered(openObligationsToGaps(frame, result as ProposalResult)), []);
    const reordered = clone(proposal.value);
    for (const field of ["nodes", "fills", "localConnectors", "artifacts", "contracts", "joins", "tests", "edges", "journeys", "packets", "transfers", "anchors"] as const)
      reordered[field].reverse();
    for (const connector of reordered.localConnectors) {
      connector.bindings.reverse(); for (const binding of connector.bindings) binding.consumers.reverse();
    }
    const reorderedResult = delivered(applyProposals(frame, [observe(reordered)]));
    assert.deepEqual(reorderedResult.fills.map(fill => ({ ...fill, basis: proposal.reference })), result.fills);
    assert.deepEqual(reorderedResult.open, result.open);
    assert.deepEqual(reorderedResult.proposals[0]!.value, reordered);
    assert.deepEqual(proposal, original);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.fills) && Object.isFrozen(result.proposals[0]!.value.nodes));
    proposal.value.nodes[0]!.title += " caller mutation";
    assert.deepEqual(result.proposals[0], original);
  }
});

function workProposal() {
  const graph = gardenGraph("cross");
  for (const node of graph.nodes.filter(node => node.kind === "work" && node.ports.length && !node.code.length))
    node.code = [{ path: `${node.id}.ts`, access: "write", status: "planned" }];
  const producer = graph.nodes.find(node => node.id === "garden-produce-work")!;
  producer.code.push({ path: "src/producer.ts", symbol: "produce", access: "write", status: "planned" });
  const frame = pureFrame(graph, 3), proposal = proposalFor(frame, graph).value;
  proposal.worksContract = WORKS_FRAME_CONTRACT;
  for (const fill of proposal.fills) if (fill.port !== undefined)
    fill.codeRef = clone(proposal.nodes.find(node => node.id === fill.node)!.code.at(-1)!);
  return { graph, frame, proposal };
}

test("works-frame proposals retain the exact planned code reference among multiple declared paths", () => {
  const { frame, proposal } = workProposal(), original = clone(proposal);
  const result = delivered(applyProposals(frame, [observe(proposal)]));
  assert.deepEqual(result.open, []);
  for (const fill of result.fills) {
    const source = proposal.fills.find(row => row.obligation === fill.obligation && row.node === fill.node)!;
    assert.deepEqual(fill.codeRef, source.codeRef);
    if (fill.port !== undefined) assert.ok(Object.isFrozen(fill.codeRef));
    else assert.ok(!Object.hasOwn(fill, "codeRef"));
  }
  assert.ok(result.fills.some(fill => fill.codeRef?.path === "src/producer.ts" && fill.codeRef.symbol === "produce"));
  assert.deepEqual(delivered(openObligationsToGaps(frame, result as ProposalResult)), []);
  assert.deepEqual(proposal, original);
});

test("works-frame proposals refuse missing, foreign or inexact code and code on outcome fills", () => {
  for (const mutation of ["missing", "foreign", "symbol", "status", "access", "outcome", "null"] as const) {
    const { frame, proposal } = workProposal();
    const fill = proposal.fills.find(row => row.node === "garden-produce-work" && row.port !== undefined)!;
    if (mutation === "missing") delete fill.codeRef;
    if (mutation === "foreign") fill.codeRef!.path = "foreign.ts";
    if (mutation === "symbol") fill.codeRef!.symbol = "other";
    if (mutation === "status") fill.codeRef!.status = "existing";
    if (mutation === "access") fill.codeRef!.access = "read";
    if (mutation === "outcome") proposal.fills.find(row => row.port === undefined)!.codeRef = clone(fill.codeRef!);
    if (mutation === "null") (fill as unknown as Record<string, unknown>)['codeRef'] = null;
    const refusal = refusedAs(applyProposals(frame, [observe(proposal)]), mutation === "null" ? "proposal_invalid" : "slot_fill_foreign");
    assert.equal(refusal.at.field, mutation === "null" ? "fills" : "codeRef");
  }
});

test("work proposal contracts reject unknown, null and own-undefined markers and are forbidden on L2", () => {
  for (const marker of ["absent", "works-frame/v2", null, undefined]) {
    const { frame, proposal } = workProposal(), observation = observe(proposal);
    if (marker === 'absent') delete observation.value.worksContract;
    else (observation.value as unknown as Record<string, unknown>)['worksContract'] = marker;
    assert.equal(refusedAs(applyProposals(frame, [observation]), "proposal_invalid").at.field, "worksContract");
  }
  const graph = gardenGraph(), frame = pureFrame(graph, 2), proposal = proposalFor(frame, graph).value;
  proposal.worksContract = WORKS_FRAME_CONTRACT;
  assert.equal(refusedAs(applyProposals(frame, [observe(proposal)]), "proposal_invalid").at.field, "worksContract");
});

test("L2 proposal outputs remain unchanged and never acquire work endpoint code references", () => {
  for (const level of [2] as const) {
    const graph = gardenGraph("cross"), frame = pureFrame(graph, level), proposal = proposalFor(frame, graph);
    const first = delivered(applyProposals(frame, [proposal])), before = hashJson(first);
    assert.ok(first.fills.every(fill => !Object.hasOwn(fill, "codeRef")));
    assert.ok(!Object.hasOwn(first.proposals[0]!.value, "worksContract"));
    assert.equal(hashJson(delivered(applyProposals(frame, [clone(proposal)]))), before);
    const unexpected = clone(proposal.value), end = unexpected.fills.find(fill => fill.port !== undefined)!;
    end.codeRef = { path: "uncontracted.ts", access: "write", status: "planned" };
    refusedAs(applyProposals(frame, [observe(unexpected)]), "proposal_invalid");
  }
});

test("explicit empty proposals preserve accepted fills while proposed fills supersede only outside identities", () => {
  for (const level of levels) {
    const graph = gardenGraph(), accepted = pureFrame(graph, level, true);
    const unchanged = delivered(applyProposals(accepted, []));
    assert.deepEqual(unchanged.open, []);
    assert.ok(unchanged.fills.every(fill => fill.source === "accepted"));
    assert.deepEqual(unchanged.fills.map(fill => ({ obligation: fill.obligation, node: fill.node, port: fill.port })),
      accepted.result.fills.map(fill => ({ obligation: fill.obligation, node: fill.node, port: fill.port })));
    const outside = pureFrame(graph, level, false, []), proposal = proposalFor(outside, graph);
    assert.ok(outside.result.fills.every(fill => fill.source === "identity"));
    const replaced = delivered(applyProposals(outside, [proposal]));
    assert.ok(replaced.fills.every(fill => fill.source === "proposed"));
    assert.deepEqual(replaced.open, []);
    assert.deepEqual(replaced.representatives, []);
    assert.deepEqual(delivered(openObligationsToGaps(outside, replaced as ProposalResult)), []);
  }
});

test("proposal boundaries distinguish absent arguments and mandatory content from explicitly empty sets", () => {
  const frame = pureFrame(gardenGraph(), 2), proposal = emptyProposal(frame);
  for (const bad of [undefined, null, 1, "invalid", {}]) {
    assert.throws(() => applyProposals(bad as unknown as FrameRead, []), malformed);
    assert.throws(() => applyProposals(frame, bad as unknown as ProposalObservation[]), malformed);
    assert.throws(() => openObligationsToGaps(frame, bad as unknown as ProposalResult), malformed);
  }
  for (const field of ["base", "level", "source", "status", "nodes", "fills", "localConnectors", "artifacts", "contracts",
    "joins", "tests", "edges", "journeys", "packets", "transfers", "anchors", "removes", "replaces", "redefines"] as const) {
    const value = clone(proposal.value) as Partial<LayerProposal>; delete value[field];
    refusedAs(applyProposals(frame, [observe(value as LayerProposal)]), "proposal_invalid");
  }
  const incomplete = proposalFor(frame, gardenGraph());
  delete (incomplete.value.nodes[0] as Partial<Graph["nodes"][number]>).boundary;
  refusedAs(applyProposals(frame, [observe(incomplete.value)]), "proposal_invalid");
  assert.equal(delivered(applyProposals(frame, [proposal])).open.length, frame.result.open.length);
  const prototype = emptyProposal(frame, "prototype");
  prototype.value.contracts = [{ id: "new-proposal-contract", schema: JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') }];
  const exact = observe(prototype.value, "prototype");
  const snapshot = delivered(applyProposals(frame, [exact]));
  assert.equal(canonical(snapshot.proposals[0]!.value), canonical(exact.value));
  const properties = (snapshot.proposals[0]!.value.contracts[0]!.schema as { properties: Record<string, unknown> }).properties;
  assert.ok(Object.hasOwn(properties, "__proto__"));
  assert.ok(Object.isFrozen(properties["__proto__"]));
});

test("status masquerades, stale exact bases, foreign fills and reserved node names are addressed refusals", () => {
  for (const level of levels) {
    const graph = gardenGraph(), frame = pureFrame(graph, level), original = proposalFor(frame, graph);
    for (const status of ["accepted", "rejected"] as const) {
      const value = clone(original.value); value.status = status;
      refusedAs(applyProposals(frame, [observe(value)]), "proposal_not_proposed");
    }
    for (const field of ["graph", "frame"] as const) {
      const value = clone(original.value); value.base[field] = { ...(value.base[field] ?? fakeRef("om-frame:garden:2")), revision: 99 };
      refusedAs(applyProposals(frame, [observe(value)]), "proposal_base_stale");
    }
    const missing = clone(original.value); missing.fills[0]!.obligation = "missing-obligation";
    refusedAs(applyProposals(frame, [observe(missing)]), "slot_fill_foreign");
    const foreign = clone(original.value); foreign.fills[0]!.node = "node-not-defined-here";
    refusedAs(applyProposals(frame, [observe(foreign)]), "slot_fill_foreign");
    const wrongAncestor = clone(original.value), first = wrongAncestor.fills[0]!;
    const required = frame.result.obligations.find(item => item.id === first.obligation)!;
    const other = wrongAncestor.nodes.find(node => node.parent !== required.upper.node)!;
    first.node = other.id;
    refusedAs(applyProposals(frame, [observe(wrongAncestor)]), "slot_fill_foreign");
    const reserved = clone(original.value); reserved.nodes[0]!.id = representativeId(required.upper.node, level);
    refusedAs(applyProposals(frame, [observe(reserved)]), "proposal_node_reserved");
    const outcome = frame.result.obligations.find(item => item.kind !== "connection-end")!;
    const left = emptyProposal(frame, "left"), right = emptyProposal(frame, "right");
    const node = original.value.nodes.find(item => item.parent === outcome.upper.node && item.outcome === outcome.artifact)!;
    left.value.nodes = [clone(node)]; left.value.fills = [{ obligation: outcome.id, node: node.id }];
    right.value.nodes = [{ ...clone(node), id: `other-${node.id}` }]; right.value.fills = [{ obligation: outcome.id, node: right.value.nodes[0]!.id }];
    refusedAs(applyProposals(frame, [observe(left.value, "left"), observe(right.value, "right")]), "slot_fill_conflict");
    refusedAs(applyProposals(frame, [observe(left.value, "left"), observe(clone(left.value), "same-endpoint")]), "slot_fill_conflict");
    const accepted = pureFrame(graph, level, true);
    refusedAs(applyProposals(accepted, [proposalFor(accepted, graph)]), "slot_fill_conflict");
  }
});

test("gaps name every open obligation in the current zone and only neighbors in its exact flow", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross"), consumer = `garden-consume-${level === 2 ? "block" : "operation"}`;
    const frame = pureFrame(graph, level, false, [consumer, `garden-produce-${level === 2 ? "block" : "operation"}`,
      ...(level === 3 ? ["garden-prep-operation"] : [])]);
    const result = delivered(applyProposals(frame, [])), gaps = delivered(openObligationsToGaps(frame, result as ProposalResult));
    assert.deepEqual(gaps.map(gap => gap.target).sort(), frame.result.open.map(obligation => obligation.id).sort());
    for (const gap of gaps) {
      const obligation = frame.result.obligations.find(item => item.id === gap.target)!;
      assert.equal(obligation.zone, "horizon");
      assert.equal(gap.field, "fill"); assert.equal(gap.kind, "design-decision"); assert.equal(gap.blocking, true);
      assert.equal(gap.consumer, obligation.upper.node);
      assert.equal(gap.question.upper, obligation.upper.node);
      assert.equal(gap.question.level, level); assert.equal(gap.question.artifact, obligation.artifact);
      assert.equal(gap.question.allowNew, true);
      const neighbors = obligation.kind === "connection-end" ? frame.result.obligations.filter(item =>
        item.id !== obligation.id && item.connector === obligation.connector && item.flow === obligation.flow) : [];
      assert.deepEqual(gap.neighbors, neighbors);
      assert.ok(gap.neighbors.every(item => item.id !== gap.target));
      if (obligation.upper.port) assert.equal(gap.question.portContract,
        frame.upper.nodes.find(node => node.id === obligation.upper.node)!.ports.find(port => port.id === obligation.upper.port)!.contract);
      else assert.equal(gap.question.portContract, frame.upper.artifacts.find(item => item.id === obligation.artifact)!.contract);
    }
    const main = gaps.find(gap => gap.neighbors.length === 3)!;
    assert.ok(main, "the multi-consumer flow keeps the other three endpoint addresses");
    assert.ok(frame.result.obligations.some(obligation => obligation.zone === "outside"));
    assert.ok(gaps.every(gap => frame.result.open.some(obligation => obligation.id === gap.target)));
    for (const field of ["obligations", "fills", "open"] as const) {
      const forged = clone(result) as ProposalResult;
      if (!forged[field].length) continue;
      forged[field].pop();
      refusedAs(openObligationsToGaps(frame, forged), "proposal_invalid");
    }
    const proposed = delivered(applyProposals(frame, [proposalFor(frame, graph)]));
    const masquerade = clone(proposed) as ProposalResult; masquerade.fills[0]!.source = "accepted";
    refusedAs(openObligationsToGaps(frame, masquerade), "proposal_invalid");
  }
});

test("replacing one accepted consumer retains every other consumer and every flow at both levels", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross"), oldId = `garden-consume-${level === 2 ? "operation" : "work"}`;
    const old = graph.nodes.find(node => node.id === oldId)!;
    const peer = { ...clone(old), id: `${oldId}-peer`, outcome: "garden-data" };
    graph.nodes.push(peer);
    for (const binding of graph.connectors.find(connector => connector.id === "garden-flow")!.bindings.filter(item => item.level === level)) {
      for (const endpoint of [...binding.consumers].filter(item => item.node === oldId))
        binding.consumers.push({ ...clone(endpoint), node: peer.id });
    }
    const frame = pureFrame(graph, level, true), proposal = emptyProposal(frame, "replacement"), newId = `${oldId}-new`;
    proposal.value.nodes = [{ ...clone(old), id: newId }];
    proposal.value.removes = [oldId];
    const replaced = frame.result.fills.filter(fill => fill.node === oldId);
    proposal.value.fills = replaced.map(fill => ({ obligation: fill.obligation, node: newId,
      ...(fill.port === undefined ? {} : { port: fill.port,
        ...(level === 3 ? { codeRef: clone(proposal.value.nodes[0]!.code[0]!) } : {}) }) }));
    proposal.value.replaces = proposal.value.fills.map(fill => ({ obligation: fill.obligation,
      base: { node: oldId, graph: frame.request.graph }, with: { node: fill.node, port: fill.port ?? null }, basis: "Explicit consumer refinement" }));
    const observed = observe(proposal.value, "replacement"), result = delivered(applyProposals(frame, [observed]));
    assert.deepEqual(result.open, []);
    assert.equal(result.fills.length, frame.result.fills.length);
    assert.ok(!result.fills.some(fill => fill.node === oldId));
    for (const prior of frame.result.fills) {
      const after = result.fills.find(fill => fill.obligation === prior.obligation && fill.node === (prior.node === oldId ? newId : prior.node));
      assert.ok(after, `${level}: ${prior.obligation} retains ${prior.node}`);
      assert.equal(after.port, prior.port);
      assert.equal(after.source, prior.node === oldId ? "proposed" : "accepted");
      assert.deepEqual(after.basis, prior.node === oldId ? observed.reference : prior.basis);
    }
    assert.equal(result.fills.filter(fill => fill.node === peer.id).length, 3);
    const lost = clone(proposal.value); lost.replaces.pop();
    refusedAs(applyProposals(frame, [observe(lost)]), "slot_fill_conflict");
    const stale = clone(proposal.value);
    stale.replaces[0]!.base.graph = { ...stale.replaces[0]!.base.graph, revision: stale.replaces[0]!.base.graph.revision + 1 };
    refusedAs(applyProposals(frame, [observe(stale)]), "proposal_base_stale");
    const staleNode = clone(proposal.value); staleNode.replaces[0]!.base.node = "no-longer-accepted-node";
    refusedAs(applyProposals(frame, [observe(staleNode)]), "proposal_base_stale");
    const rival = clone(proposal.value);
    rival.nodes[0]!.id += "-rival";
    for (const fill of rival.fills) fill.node = rival.nodes[0]!.id;
    for (const replacement of rival.replaces) replacement.with.node = rival.nodes[0]!.id;
    refusedAs(applyProposals(frame, [observed, observe(rival, "rival")]), "slot_fill_conflict");
  }
});

test("consumer multiplicity is legal but a proposal cannot borrow a node defined only by another proposal", () => {
  for (const level of levels) {
    const graph = gardenGraph("cross"), frame = pureFrame(graph, level);
    const obligation = frame.result.obligations.find(item => item.role === "consumer" && item.upper.node.includes("consume"))!;
    const node = graph.nodes.find(item => LEVEL[item.kind] === level && item.parent === obligation.upper.node)!;
    const left = emptyProposal(frame, "a"), right = emptyProposal(frame, "z");
    left.value.nodes = [clone(node)]; left.value.fills = [{ obligation: obligation.id, node: node.id, port: obligation.upper.port!,
      ...(level === 3 ? { codeRef: clone(node.code[0]!) } : {}) }];
    right.value.nodes = [{ ...clone(node), id: `${node.id}-second` }];
    right.value.fills = [{ obligation: obligation.id, node: right.value.nodes[0]!.id, port: obligation.upper.port!,
      ...(level === 3 ? { codeRef: clone(node.code[0]!) } : {}) }];
    const observations = [observe(left.value, "a"), observe(right.value, "z")];
    const result = delivered(applyProposals(frame, observations));
    assert.equal(result.fills.filter(fill => fill.obligation === obligation.id).length, 2);
    assert.ok(!result.open.some(item => item.id === obligation.id));
    assert.deepEqual(delivered(applyProposals(frame, [...observations].reverse())), result);
    assert.deepEqual(result.proposals.map(item => item.reference.id), ["om-proposal:garden:a", "om-proposal:garden:z"]);
    const borrower = clone(right.value); borrower.nodes = []; borrower.fills[0]!.node = node.id;
    refusedAs(applyProposals(frame, [observe(left.value, "a"), observe(borrower, "z")]), "slot_fill_foreign");
    const duplicate = clone(left.value); duplicate.fills.push(clone(duplicate.fills[0]!));
    refusedAs(applyProposals(frame, [observe(duplicate)]), "slot_fill_conflict");
  }
});

test("the first stored assembly returns proposals, gaps and frame-zero CAS without creating a frame or status", t => {
  const root = mkdtempSync(join(tmpdir(), "omg-first-proposals-")), store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = gardenGraph(), view = upper(graph, 2), engine = new ProductEngine(store);
  preparedFeatures(engine, "garden", view);
  const horizon = acceptedHorizon(store, null);
  const request: FrameRequest = { project: "garden", level: 2, horizon: reference(horizon.gate),
    graph: reference(store.get("graph:garden")!), layer: null, frame: null, upper: null };
  const frame = clone(delivered(prepareFrame(store, request))) as unknown as FrameRead;
  const proposal = proposalFor(frame, graph), proposalRef = put(store, proposal), requestWithProposals = { frame: request, proposals: [proposalRef] };
  const before = revisions(store);
  const first = delivered(prepareFrameProposals(store, requestWithProposals));
  const history = delivered(readFrameProposals(store, requestWithProposals));
  assert.equal(first.frame.accepted, null);
  assert.equal(first.expected.frame, 0);
  assert.equal(first.expected.graph, request.graph.revision);
  assert.equal(first.expected.layer, store.get("graph-layer:garden:2")!.revision);
  assert.deepEqual(first.gaps, []); assert.deepEqual(first.result.open, []);
  assert.deepEqual(first.result, history.result);
  assert.deepEqual(first.proposals, first.result.proposals);
  assert.deepEqual(first.proposals[0]!.value, proposal.value);
  assert.ok(first.guards.some(ref => canonical(ref) === canonical(proposalRef)));
  assert.ok(first.references.some(ref => canonical(ref) === canonical(proposalRef)));
  assert.deepEqual(delivered(prepareFrameProposals(store, requestWithProposals)), first);
  assert.equal(store.get<LayerProposal>(proposalRef.id)!.value.status, "proposed");
  assert.equal(store.list("connection-frame").length, 0);
  assert.equal(store.list("candidate").length, 0);
  assert.deepEqual(revisions(store), before);
  const partial = delivered(prepareFrameProposals(store, { frame: request, proposals: [] }));
  assert.equal(partial.gaps.length, frame.result.open.length);
  assert.deepEqual(revisions(store), before);
  const frameValue: ConnectionFrame = { project: "garden", level: 2, candidateHash: hashJson("future-C4-candidate"),
    layerHash: hashJson(projectGraph(graph, 2)), fills: [] };
  store.write({ id: "om-frame:garden:2", kind: "connection-frame", expected: 0, value: frameValue });
  const beforeConflict = revisions(store);
  assert.deepEqual(first.guards.filter(guard => guard.id === "om-frame:garden:2"),
    [{ id: "om-frame:garden:2", absent: true }]);
  const refused = writeGuarded(store, { unit: "C5-neighbor", target: "candidate:garden", guards: first.guards,
    writes: [{ id: "candidate:garden", kind: "candidate", expected: 0, value: { proposals: first.proposals } },
      { id: "om-frame:garden:2", kind: "connection-frame", expected: first.expected.frame, value: frameValue },
      { id: proposalRef.id, kind: "layer-proposal", expected: proposalRef.revision, value: { ...proposal.value, status: "accepted" } }] });
  assert.equal(refused.ok, false);
  if (refused.ok) assert.fail("The concurrent frame must invalidate its absence guard");
  assert.equal(refused.refusal.code, "input_stale");
  assert.equal(refused.refusal.at.target, "om-frame:garden:2");
  assert.equal(refused.refusal.route, "producer");
  assert.equal(store.get("candidate:garden"), null);
  assert.equal(store.get<LayerProposal>(proposalRef.id)!.value.status, "proposed");
  assert.deepEqual(revisions(store), beforeConflict);
});

test("stored current preparation rejects proposal head drift while exact history and complete snapshots survive reopen", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const requests: ProposalRequest[] = [];
  const histories = [];
  for (const level of levels) {
    const request = acceptedRequest(f, reference(horizon.gate), level), frame = clone(delivered(readFrame(f.store, request))) as FrameRead;
    const proposal = emptyProposal(frame, `stored-${level}`), proposalRef = put(f.store, proposal);
    const full = { frame: request, proposals: [proposalRef] };
    requests.push(full);
    const before = revisions(f.store), current = delivered(prepareFrameProposals(f.store, full)), historical = delivered(readFrameProposals(f.store, full));
    histories.push(historical);
    assert.deepEqual(current.result, historical.result);
    assert.deepEqual(current.gaps, []);
    assert.deepEqual(current.result.fills, frame.result.fills);
    assert.deepEqual(current.proposals[0]!.reference, proposalRef);
    assert.deepEqual(revisions(f.store), before);
    const rejected = { ...proposal.value, status: "rejected" as const };
    const next = f.store.write({ id: proposalRef.id, kind: "layer-proposal", expected: proposalRef.revision, value: rejected });
    const after = revisions(f.store);
    refusedAs(prepareFrameProposals(f.store, full), "input_stale");
    refusedAs(readFrameProposals(f.store, { frame: request, proposals: [reference(next)] }), "proposal_not_proposed");
    assert.deepEqual(delivered(readFrameProposals(f.store, full)), historical);
    assert.deepEqual(revisions(f.store), after);
  }
  const source = f.store.get("source:garden:brief")!;
  f.store.write({ id: source.id, kind: source.kind, expected: source.revision, value: source.value });
  const graph = f.store.get("graph:garden")!;
  f.store.write({ id: graph.id, kind: graph.kind, expected: graph.revision, value: graph.value });
  const before = revisions(f.store);
  for (const [index, request] of requests.entries()) assert.deepEqual(delivered(readFrameProposals(f.store, request)), histories[index]);
  assert.deepEqual(revisions(f.store), before);
  f.reopen();
  for (const [index, request] of requests.entries()) assert.deepEqual(delivered(readFrameProposals(f.store, request)), histories[index]);
  assert.deepEqual(revisions(f.store), before);
});

test("proposal preparation passes complete guards to one neighbor transaction with no partial candidate or statuses", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const request = acceptedRequest(f, reference(horizon.gate), 2), frame = clone(delivered(readFrame(f.store, request))) as FrameRead;
  const proposal = emptyProposal(frame, "guarded"), proposalRef = put(f.store, proposal), complete = { frame: request, proposals: [proposalRef] };
  const prepared = delivered(prepareFrameProposals(f.store, complete));
  const snapshot = await f.store.snapshot(join(f.root, "proposal-guards-snapshot"));
  const dependencies = [proposalRef, request.graph, request.layer!, reference(f.store.get("source:garden:brief")!)];
  for (const [index, dependency] of dependencies.entries()) {
    const path = join(f.root, `proposal-guard-${index}.sqlite`); copyFileSync(snapshot.path, path);
    const store = new Store(path);
    try {
      const old = store.get(dependency.id)!;
      store.write({ id: old.id, kind: old.kind, expected: old.revision, value: old.value });
      const before = revisions(store);
      refusedAs(writeGuarded(store, { unit: "C5-neighbor", target: "candidate:garden", guards: prepared.guards,
        writes: [{ id: "candidate:garden", kind: "candidate", expected: 0, value: { proposals: prepared.proposals } },
          { id: proposalRef.id, kind: "layer-proposal", expected: store.get(proposalRef.id)!.revision,
            value: { ...proposal.value, status: "accepted" } },
          { id: "candidate-status:garden", kind: "candidate-status", expected: 0, value: { accepted: true } }] }), "input_stale");
      assert.equal(store.get("candidate:garden"), null);
      assert.equal(store.get("candidate-status:garden"), null);
      assert.equal(store.get<LayerProposal>(proposalRef.id)!.value.status, "proposed");
      assert.deepEqual(revisions(store), before);
      assert.ok(prepared.guards.some(ref => canonical(ref) === canonical(dependency)), dependency.id);
    } finally { store.close(); }
  }
});

test("stored proposals reject foreign, forged, absent and malformed records and preserve unexpected store failures", async t => {
  const f = await createOmFixture(t, "standard", "garden", { mode: "executed" }), horizon = acceptedHorizon(f.store, reference(f.layers[2]));
  const frameRequest = acceptedRequest(f, reference(horizon.gate), 2), frame = clone(delivered(readFrame(f.store, frameRequest))) as FrameRead;
  const proposal = emptyProposal(frame), proposalRef = put(f.store, proposal), request = { frame: frameRequest, proposals: [proposalRef] };
  const malformedValue = clone(proposal.value) as Partial<LayerProposal>; delete malformedValue.joins;
  const malformedRow = f.store.write({ id: "om-proposal:garden:missing-joins", kind: "layer-proposal", expected: 0, value: malformedValue });
  const wrongKind = f.store.write({ id: "om-proposal:garden:wrong-kind", kind: "not-a-proposal", expected: 0, value: proposal.value });
  const before = revisions(f.store);
  for (const action of [readFrameProposals, prepareFrameProposals]) {
    for (const bad of [undefined, null, [], "request"])
      assert.throws(() => action(f.store, bad as unknown as ProposalRequest), malformed);
    assert.throws(() => action(f.store, { frame: frameRequest } as ProposalRequest), malformed);
    assert.throws(() => action(f.store, { proposals: [] } as unknown as ProposalRequest), malformed);
    refusedAs(action(f.store, { ...request, proposals: [fakeRef("om-proposal:foreign:one")] }), "record_foreign");
    refusedAs(action(f.store, { ...request, proposals: [{ ...proposalRef, hash: "0".repeat(64) }] }), "record_forged");
    refusedAs(action(f.store, { ...request, proposals: [fakeRef("om-proposal:garden:absent")] }), "record_missing");
    refusedAs(action(f.store, { ...request, proposals: [reference(wrongKind)] }), "record_foreign");
    refusedAs(action(f.store, { ...request, proposals: [reference(malformedRow)] }), "proposal_invalid");
    for (const fault of [new TypeError("proposal-store-fault"), new EngineError("record_corrupt", "broken proposal row", { proposal: proposalRef.id })]) {
      const original = f.store.get.bind(f.store);
      try {
        f.store.get = ((id: string, revision?: number) => {
          if (id === proposalRef.id) throw fault;
          return original(id, revision);
        }) as Store["get"];
        assert.throws(() => action(f.store, request), error => error === fault);
      } finally { f.store.get = original; }
    }
  }
  assert.deepEqual(revisions(f.store), before);
  assert.deepEqual([...PROPOSAL_REFUSAL_CODES].sort(), ["proposal_request_invalid", "proposal_invalid", "proposal_not_proposed",
    "proposal_base_stale", "slot_fill_foreign", "slot_fill_conflict", "proposal_node_reserved", "input_stale"].sort());
});

test("unaccepted lower nodes hidden in the upper input cannot supply a proposal and scope hashes are mandatory", () => {
  for (const level of levels) {
    const graph = gardenGraph(), frame = pureFrame(graph, level);
    frame.upper = clone(graph);
    frame.request.graph = graphRef(frame.upper);
    frame.result = clone(delivered(fillObligations(frame.upper, frame.scope, null, frame.upperRef, level))) as FrameRead["result"];
    const outcome = frame.result.obligations.find(item => item.upper.node === `garden-consume-${level === 2 ? "block" : "operation"}` && item.kind !== "connection-end")!;
    const hidden = graph.nodes.find(node => LEVEL[node.kind] === level && node.parent === outcome.upper.node && node.outcome === outcome.artifact)!;
    const proposal = emptyProposal(frame, "hidden");
    proposal.value.fills = [{ obligation: outcome.id, node: hidden.id }];
    assert.ok(frame.upper.nodes.some(node => node.id === hidden.id));
    assert.equal(frame.accepted, null);
    refusedAs(applyProposals(frame, [observe(proposal.value, "hidden")]), "slot_fill_foreign");
    const omittedAcceptance = clone(frame);
    omittedAcceptance.request.layer = fakeRef(`graph-layer:garden:${level}`);
    refusedAs(applyProposals(omittedAcceptance, []), "proposal_invalid");
    for (const bad of [undefined, "", "not-a-hash", 42]) {
      const malformedFrame = clone(frame);
      (malformedFrame.scope as unknown as Record<string, unknown>).hash = bad;
      assert.throws(() => applyProposals(malformedFrame, []), malformed);
    }
  }
});

test("gap questions include introduced eligible nodes and exclude explicitly removed internal accepted nodes", () => {
  for (const level of levels) {
    const graph = gardenGraph(), frame = pureFrame(graph, level), upperConsumer = `garden-consume-${level === 2 ? "block" : "operation"}`;
    const node = graph.nodes.find(item => LEVEL[item.kind] === level && item.parent === upperConsumer)!;
    const outcome = frame.result.obligations.find(item => item.upper.node === upperConsumer && item.kind !== "connection-end")!;
    const proposal = emptyProposal(frame, "outcome-only");
    proposal.value.nodes = [clone(node)]; proposal.value.fills = [{ obligation: outcome.id, node: node.id }];
    const result = delivered(applyProposals(frame, [observe(proposal.value, "outcome-only")]));
    const gaps = delivered(openObligationsToGaps(frame, result as ProposalResult));
    assert.ok(!gaps.some(gap => gap.target === outcome.id));
    const connectionGap = gaps.find(gap => gap.consumer === upperConsumer && gap.question.role === "consumer")!;
    assert.ok(connectionGap);
    assert.deepEqual(connectionGap.question.existing, [node.id]);
    assert.equal(connectionGap.question.port, "in");
    assert.equal(connectionGap.question.portContract, "garden-contract");
    assert.equal(connectionGap.question.role, "consumer");
    for (const gap of gaps) {
      const obligation = frame.result.obligations.find(item => item.id === gap.target)!;
      assert.equal(gap.question.role, obligation.role ?? "producer");
      assert.equal(gap.question.port, obligation.upper.port ?? null);
    }
    const partial = clone(graph), internal = { ...clone(node), id: `${node.id}-unused`, outcome: "garden-data" };
    partial.nodes.push(internal);
    const connector = partial.connectors.find(item => item.id === "garden-flow")!;
    connector.bindings = connector.bindings.filter(binding => binding.level !== level);
    const accepted = pureFrame(partial, level, true);
    assert.ok(!accepted.result.fills.some(fill => fill.node === internal.id));
    const before = delivered(openObligationsToGaps(accepted, delivered(applyProposals(accepted, [])) as ProposalResult));
    const consumerGap = before.find(gap => gap.consumer === upperConsumer && gap.question.role === "consumer")!;
    assert.ok(consumerGap.question.existing.includes(internal.id));
    const removal = emptyProposal(accepted, "remove-internal"); removal.value.removes = [internal.id];
    const removed = delivered(applyProposals(accepted, [observe(removal.value, "remove-internal")]));
    assert.deepEqual(removed.fills, accepted.result.fills);
    const after = delivered(openObligationsToGaps(accepted, removed as ProposalResult));
    assert.ok(after.some(gap => gap.target === consumerGap.target));
    assert.ok(after.every(gap => !gap.question.existing.includes(internal.id)));
    assert.ok(after.find(gap => gap.target === consumerGap.target)!.question.existing.includes(node.id));
  }
});

test("pure proposal APIs cannot authorize partial acceptance with caller-supplied rebase or open markers", () => {
  for (const level of levels) {
    const graph = gardenGraph(), frame = pureFrame(graph, level, true);
    const missing = frame.result.obligations.find(item => item.zone === "horizon" && item.kind !== "connection-end")!;
    const fills = frame.result.fills.filter(fill => fill.obligation !== missing.id);
    const value = { project: "garden", level, candidateHash: hashJson(graph), layerHash: hashJson(projectGraph(graph, level)), fills,
      rebase: { state: "accepted", graph: frame.request.graph, upper: frame.upperRef, open: [missing.id] } };
    const ref = { id: `om-frame:garden:${level}`, revision: 1, hash: hashJson(value) };
    frame.request.frame = ref;
    frame.accepted!.frame = { reference: ref, value };
    frame.result.fills = fills.map(fill => ({ ...fill, basis: ref }));
    frame.result.open = [missing];
    refusedAs(applyProposals(frame, []), "frame_record_invalid");
    refusedAs(openObligationsToGaps(frame, { ...frame.result, proposals: [] }), "frame_record_invalid");
    const claimed = pureFrame(graph, level, true);
    claimed.result.fills = fills;
    claimed.result.open = [missing];
    Object.assign(claimed, { verified: true, acceptance: { state: "accepted", open: [missing.id] } });
    refusedAs(applyProposals(claimed, []), "proposal_invalid");
    refusedAs(openObligationsToGaps(claimed, { ...claimed.result, proposals: [] }), "proposal_invalid");
  }
});
